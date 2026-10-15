import type {
  AddTargetWordsRequest,
  ChangeTargetDateRequest,
  CreateTargetRequest,
  Enrollment,
  Target,
  TargetList,
} from '@lang-tutor/core/api';
import { speakable, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { liveDimensions } from '../domain/choose';
import { daysBetween } from '../domain/progress';
import { readinessOf, recallOnDue } from '../domain/targets';
import { InvalidTarget, TargetClosed, TargetNotFound } from '../errors';
import type { Logger } from '../logger';
import type { TargetRow } from '../repo/targets';
import { authorizeEnrollment } from './access';
import { learnerDay } from './learnerDay';
import { logImportSaved, saveImportsInTx, type ImportSaved } from './photoImports';
import { requestStock } from './stock';
import type { Repos, Transaction } from './transaction';
import { saveEntriesInTx } from './vocabulary';

/** A target with its words, in the order they were added. */
type TargetWithWords = TargetRow & { glossIds: readonly string[] };

/** What a create or an add brings: photo imports, one per photo, and typed words. */
type WordsInput = Pick<CreateTargetRequest, 'photo_import_ids' | 'entries'>;

/** What saving them did: the words' gloss ids, each photo import saved, to be logged once the
 *  transaction commits, and the photos not read (ruling R-D9). */
type SavedWords = { glossIds: string[]; imports: ImportSaved[]; unreadPhotos: number };

/** Spec D1. Active while its date is still to come and it was not ended early. */
const isActive = (target: TargetRow, today: string): boolean => target.endedAt === null && today < target.dueOn;

/**
 * Phase 53 (spec D1, D2, D4, D8, D10–D12). A learner's targets: a kind, a due date and
 * saved words that sessions serve until the date. Each use case is the list owner's alone
 * (`targets.manage`, in no role) and one transaction (ADR 0001 R8).
 *
 * A change to targets changes what the next session should hold, so each one, in its own
 * transaction, retires the unstarted list stock and asks the stock job for the next (ruling
 * R-D12b). It takes the enrollment's next-session lock first, before it locks a target or a
 * photo import: a stock being written holds that lock and references the active targets'
 * rows, so taking a target's row first could deadlock against it. One that changes nothing
 * (a word the target holds already, or does not hold, the date it has, an end of an ended
 * target) records nothing and keeps the stock.
 *
 * The learner's today is learnerDay's (ADR 0013): a due date must come after it, and a target
 * is active, so open to change, until it does.
 */
export function createTargetService({
  transaction,
  logger,
  now,
  stockSaveDelaySeconds,
}: {
  transaction: Transaction;
  logger: Logger;
  now: () => number;
  /** Phase 43 (ruling R3). How long a save's request for a stock waits. */
  stockSaveDelaySeconds: number;
}) {
  /** Spec D2. A target is addressed by its own id; its list decides who may act. */
  async function authorizeTarget(repos: Repos, actorUserId: string, targetId: string) {
    const found = await repos.target.findTarget(targetId);
    if (!found) throw new TargetNotFound(targetId);
    const enrolled = await authorizeEnrollment(repos, logger, {
      actorUserId,
      enrollmentId: found.enrollmentId,
      permission: 'targets.manage',
    });
    return { found, enrolled };
  }

  /**
   * A change to one target: authorized, then the next-session lock, then the target's row,
   * locked and read again, which is the row the change goes by, and whether it is active on
   * the learner's today. Each change says what a closed target gets (TargetClosed, or for
   * an end of an ended one, nothing).
   */
  async function lockTarget(repos: Repos, actorUserId: string, targetId: string) {
    const { enrolled } = await authorizeTarget(repos, actorUserId, targetId);
    await repos.session.lockNextSession(enrolled.id);
    const target = await repos.target.findTargetForUpdate(targetId);
    if (!target) throw new TargetNotFound(targetId);
    const today = await learnerDay(repos, enrolled.user_id, now());
    return { enrolled, target, today, active: isActive(target, today) };
  }

  /**
   * Ruling R-D12b. The stock a change leaves: the unstarted list stock, which was chosen
   * without the change, retired (a seed, or a session already started, never is), and the
   * next asked of the stock job. The caller holds lockNextSession. Answers the id of the
   * stock retired, or null.
   */
  async function restock(repos: Repos, enrollmentId: string): Promise<string | null> {
    const { stock } = await repos.session.findOpen(enrollmentId);
    const retired = stock?.source === 'list' && (await repos.session.retireStock(stock.id)) ? stock.id : null;
    await requestStock(repos, { enrollment_id: enrollmentId, reason: 'target' });
    return retired;
  }

  /** Once the change committed: the stock it retired, as phase 53's retirements are logged. */
  function logRetired(enrollmentId: string, sessionId: string | null): void {
    if (sessionId !== null) {
      logger.info({ event: 'session_retired', enrollment_id: enrollmentId, session_id: sessionId, reason: 'target_changed' });
    }
  }

  /**
   * Spec D10, D11, ruling R-D9. The words a create or an add brings, saved in its
   * transaction as their own saves would save them: the photo imports' rows, then the typed
   * words. Their gloss ids, resolved through merges, the photos' first, each once; and what
   * the photos' saves log (final review I3).
   */
  async function saveWords(repos: Repos, enrolled: Enrollment, actorUserId: string, input: WordsInput): Promise<SavedWords> {
    const photos = await saveImportsInTx(repos, logger, {
      enrolled,
      actorUserId,
      importIds: input.photo_import_ids,
      now: now(),
      stockSaveDelaySeconds,
    });
    const typed = await saveEntriesInTx(repos, logger, { enrolled, actorUserId, entries: input.entries, stockSaveDelaySeconds });
    return { glossIds: [...new Set([...photos.glossIds, ...typed])], imports: photos.imports, unreadPhotos: photos.failedPhotos };
  }

  /** Final review I3. Once the change committed: each photo import it saved, as the import's
   *  own save logs it (phase 26 D14), naming the target. */
  function logImportsSaved(saved: SavedWords, targetId: string): void {
    for (const imported of saved.imports) logImportSaved(logger, imported, { target_id: targetId });
  }

  /**
   * Spec D4, D11, rulings R-D4, R-D11. Targets as the learner reads them on `today`: each
   * word with the form it was saved from, its key, and its readiness for the target's date —
   * its recall then in its weakest skill live in the enrollment's newest session (both
   * spoken ones off when there is none), speaking skipped for a word that cannot be said,
   * read against the kind's bars. A target's words are saved ones (unsaving takes a word out
   * of every target), so a word the list does not hold is not shown.
   */
  async function view(repos: Repos, enrolled: Enrollment, today: string, targets: readonly TargetWithWords[]): Promise<Target[]> {
    if (targets.length === 0) return [];
    const saved = new Map((await repos.vocabulary.listSavedGlosses(enrolled.id)).map((gloss) => [gloss.glossId, gloss]));
    const devices = (await repos.session.findNewestDevices(enrolled.id)) ?? { listening: false, speaking: false };
    const live = liveDimensions(devices.listening, devices.speaking);
    const memory = await repos.memory.findRows({
      enrollmentId: enrolled.id,
      glossIds: [...new Set(targets.flatMap((target) => target.glossIds))],
    });
    const rowsOf = new Map<string, { dimension: Dimension; state: MemoryState }[]>();
    for (const row of memory) rowsOf.set(row.glossId, [...(rowsOf.get(row.glossId) ?? []), row]);

    return targets.map((target) => {
      const words = target.glossIds.flatMap((glossId) => {
        const gloss = saved.get(glossId);
        if (!gloss) return [];
        const recall = recallOnDue(rowsOf.get(glossId) ?? [], live, speakable(gloss.form), target.dueOn);
        return [{ gloss_id: glossId, form: gloss.form, meaning: gloss.key, readiness: readinessOf(target.kind, recall) }];
      });
      return {
        id: target.id,
        kind: target.kind,
        due_on: target.dueOn,
        days_left: daysBetween(today, target.dueOn),
        word_count: words.length,
        ready_count: words.filter((word) => word.readiness === 'ready').length,
        words,
      };
    });
  }

  /** One target as view reads it, its words as they are now in this transaction. */
  async function viewOne(repos: Repos, enrolled: Enrollment, today: string, target: TargetRow): Promise<Target> {
    const [read] = await view(repos, enrolled, today, [{ ...target, glossIds: await repos.target.listWordIds(target.id) }]);
    return read;
  }

  return {
    /** The active targets, nearest date first, and the learner's today. */
    list: (actorUserId: string, enrollmentId: string): Promise<TargetList> =>
      transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'targets.manage' });
        const today = await learnerDay(repos, enrolled.user_id, now());
        const targets = await view(repos, enrolled, today, await repos.target.listActive(enrolled.id, today));
        return {
          today,
          targets: targets.map(({ id, kind, due_on, days_left, word_count, ready_count }) => ({
            id,
            kind,
            due_on,
            days_left,
            word_count,
            ready_count,
          })),
        };
      }),

    /** Any of the learner's targets, an ended or past one too: its screen. */
    getTarget: (actorUserId: string, targetId: string): Promise<Target> =>
      transaction(async (repos) => {
        const { found, enrolled } = await authorizeTarget(repos, actorUserId, targetId);
        return viewOne(repos, enrolled, await learnerDay(repos, enrolled.user_id, now()), found);
      }),

    /**
     * Spec D10 (Done), rulings R-D9, R-D10. One transaction: the photos' rows and the typed
     * words saved, the target made with them, and its log's first line. A due date on or
     * before today is refused before anything is saved; a target with no word, once the
     * saves are done, rolls them back.
     */
    create: async (actorUserId: string, enrollmentId: string, request: CreateTargetRequest): Promise<Target> => {
      const created = await transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'targets.manage' });
        const today = await learnerDay(repos, enrolled.user_id, now());
        if (request.due_on <= today) throw new InvalidTarget('due_date');
        await repos.session.lockNextSession(enrolled.id);
        const saved = await saveWords(repos, enrolled, actorUserId, request);
        const { glossIds } = saved;
        if (glossIds.length === 0) throw new InvalidTarget('no_words');
        const row = await repos.target.insertTarget({ enrollmentId: enrolled.id, kind: request.kind, dueOn: request.due_on });
        await repos.target.addWords(row.id, glossIds);
        await repos.target.insertEvent({
          targetId: row.id,
          kind: 'created',
          before: null,
          after: { kind: request.kind, due_on: request.due_on, gloss_ids: glossIds },
          actorUserId,
          sessionId: null,
        });
        const retired = await restock(repos, enrolled.id);
        return { target: await viewOne(repos, enrolled, today, row), wordCount: glossIds.length, retired, saved };
      });
      logImportsSaved(created.saved, created.target.id);
      logger.info({
        event: 'target_created',
        enrollment_id: enrollmentId,
        target_id: created.target.id,
        kind: created.target.kind,
        word_count: created.wordCount,
        unread_photo_count: created.saved.unreadPhotos,
      });
      logRetired(enrollmentId, created.retired);
      return created.target;
    },

    /**
     * Spec D11. The photos' rows and the typed words saved, and those the target does not
     * hold yet joined to it, in one transaction. A word it holds already stays where it is.
     */
    addWords: async (actorUserId: string, targetId: string, request: AddTargetWordsRequest): Promise<Target> => {
      const changed = await transaction(async (repos) => {
        const { enrolled, target, today, active } = await lockTarget(repos, actorUserId, targetId);
        if (!active) throw new TargetClosed(targetId);
        const saved = await saveWords(repos, enrolled, actorUserId, request);
        const added = await repos.target.addWords(target.id, saved.glossIds);
        let retired: string | null = null;
        if (added.length > 0) {
          await repos.target.insertEvent({
            targetId: target.id,
            kind: 'words_added',
            before: null,
            after: { gloss_ids: added },
            actorUserId,
            sessionId: null,
          });
          retired = await restock(repos, enrolled.id);
        }
        return { target: await viewOne(repos, enrolled, today, target), enrollmentId: enrolled.id, added, retired, saved };
      });
      logImportsSaved(changed.saved, targetId);
      if (changed.added.length > 0) {
        logger.info({
          event: 'target_changed',
          target_id: targetId,
          change: 'words_added',
          count: changed.added.length,
          unread_photo_count: changed.saved.unreadPhotos,
        });
      }
      logRetired(changed.enrollmentId, changed.retired);
      return changed.target;
    },

    /** Spec D1, D11. Out of the target, still saved. Idempotent: a word it does not hold
     *  changes nothing. Removing every word leaves an empty target (ruling R-D10). */
    removeWord: async (actorUserId: string, targetId: string, glossId: string): Promise<void> => {
      const changed = await transaction(async (repos) => {
        const { enrolled, target, active } = await lockTarget(repos, actorUserId, targetId);
        if (!active) throw new TargetClosed(targetId);
        if (!(await repos.target.removeWord(target.id, glossId))) return null;
        await repos.target.insertEvent({
          targetId: target.id,
          kind: 'words_removed',
          before: { gloss_ids: [glossId] },
          after: { reason: 'removed' },
          actorUserId,
          sessionId: null,
        });
        return { enrollmentId: enrolled.id, retired: await restock(repos, enrolled.id) };
      });
      if (changed === null) return;
      logger.info({ event: 'target_changed', target_id: targetId, change: 'words_removed', count: 1 });
      logRetired(changed.enrollmentId, changed.retired);
    },

    /** Spec D1. To any day after today; the date it has already changes nothing. */
    changeDate: async (actorUserId: string, targetId: string, request: ChangeTargetDateRequest): Promise<Target> => {
      const changed = await transaction(async (repos) => {
        const { enrolled, target, today, active } = await lockTarget(repos, actorUserId, targetId);
        if (!active) throw new TargetClosed(targetId);
        if (request.due_on <= today) throw new InvalidTarget('due_date');
        if (request.due_on === target.dueOn) return { target: await viewOne(repos, enrolled, today, target), change: null };
        await repos.target.setDueOn(target.id, request.due_on);
        await repos.target.insertEvent({
          targetId: target.id,
          kind: 'date_changed',
          before: { due_on: target.dueOn },
          after: { due_on: request.due_on },
          actorUserId,
          sessionId: null,
        });
        const retired = await restock(repos, enrolled.id);
        const moved = { ...target, dueOn: request.due_on };
        return { target: await viewOne(repos, enrolled, today, moved), change: { enrollmentId: enrolled.id, retired } };
      });
      if (changed.change !== null) {
        logger.info({ event: 'target_changed', target_id: targetId, change: 'date_changed' });
        logRetired(changed.change.enrollmentId, changed.change.retired);
      }
      return changed.target;
    },

    /** Spec D1, D8. Ended now, before its date. Idempotent on a target ended already; one
     *  whose date has come ended on it, so it is closed. */
    end: async (actorUserId: string, targetId: string): Promise<void> => {
      const ended = await transaction(async (repos) => {
        const { enrolled, target, active } = await lockTarget(repos, actorUserId, targetId);
        if (target.endedAt !== null) return null;
        if (!active) throw new TargetClosed(targetId);
        if (!(await repos.target.end(target.id, new Date(now())))) return null;
        await repos.target.insertEvent({
          targetId: target.id,
          kind: 'ended_early',
          before: null,
          after: { due_on: target.dueOn },
          actorUserId,
          sessionId: null,
        });
        return { enrollmentId: enrolled.id, retired: await restock(repos, enrolled.id) };
      });
      if (ended === null) return;
      logger.info({ event: 'target_ended', target_id: targetId, how: 'early' });
      logRetired(ended.enrollmentId, ended.retired);
    },
  };
}

export type TargetService = ReturnType<typeof createTargetService>;
