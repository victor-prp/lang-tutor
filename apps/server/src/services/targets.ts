import type {
  AddTargetWordsRequest,
  ChangeTargetDateRequest,
  CreateTargetRequest,
  Enrollment,
  Target,
  TargetList,
} from '@lang-tutor/core/api';

import { daysBetween } from '../domain/progress';
import { targetDay } from '../domain/targetDay';
import { activeOn, openOn } from '../domain/targets';
import { canRaiseToday, readinessSummary, todaySummary } from '../domain/targetSummary';
import { InvalidTarget, TargetClosed, TargetNotFound } from '../errors';
import type { Logger } from '../logger';
import type { TargetRow } from '../repo/targets';
import { authorizeEnrollment } from './access';
import { learnerDay, learnerDays } from './learnerDay';
import { enrollmentReads, readTargetDay, readTodayBudget } from './targetDayRead';
import { logImportSaved, saveImportsInTx, type ImportSaved } from './photoImports';
import { lockPaths, logTargetRetired, requestStocks, restockAfterTargetChange, retireStocks } from './stock';
import type { Repos, Transaction } from './transaction';
import { lastAnswerDay, skipOpenSession } from './sessionEnd';
import { saveEntriesInTx } from './vocabulary';

/** A target with its words, in the order they were added. */
type TargetWithWords = TargetRow & { glossIds: readonly string[] };

/** What a create or an add brings: photo imports, one per photo, and typed words. */
type WordsInput = Pick<CreateTargetRequest, 'photo_import_ids' | 'entries'>;

/** What saving them did: the words' gloss ids, each photo import saved, to be logged once the
 *  transaction commits, and the photos not read (ruling R-D9). */
type SavedWords = { glossIds: string[]; imports: ImportSaved[]; unreadPhotos: number };

/**
 * Phase 53 (spec D1, D2, D4, D8, D10–D12). A learner's targets: a kind, a due date and
 * saved words that sessions serve until the date. Each use case is the list owner's alone
 * (`targets.manage`, in no role) and one transaction (ADR 0001 R8).
 *
 * A change to targets changes what the next session should hold, so each one, in its own
 * transaction, retires the unstarted list stock of the target's path and of the main path,
 * whose words change with it, and asks the stock job for the next of each (ruling R-D12b;
 * phase 57, spec D2). It takes those paths' next-session locks first (lockPaths), before it
 * locks a target or a photo import: a stock being written holds its path's lock and
 * references the targets' rows, so taking a target's row first could deadlock against it.
 * One that changes nothing (a word the target holds already, or does not hold, the date it
 * has, an end of an ended target) records nothing and keeps the stocks.
 *
 * The learner's today is learnerDay's (ADR 0013): a due date must come after it. A target is
 * active through its due date (phase 57, spec D10: listed, and its path on home), and open to
 * change until the date comes.
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
   * A change to one target: authorized, then the next-session locks of the main path and the
   * target's (lockPaths), then the target's row, locked and read again, which is the row the
   * change goes by, and whether it is open to change on the learner's today (before its
   * date). Each change says what a closed target gets (TargetClosed, or for an end of an
   * ended one, nothing).
   */
  async function lockTarget(repos: Repos, actorUserId: string, targetId: string) {
    const { enrolled } = await authorizeTarget(repos, actorUserId, targetId);
    await lockPaths(repos, enrolled.id, [targetId]);
    const target = await repos.target.findTargetForUpdate(targetId);
    if (!target) throw new TargetNotFound(targetId);
    const today = await learnerDay(repos, enrolled.user_id, now());
    return { enrolled, target, today, open: openOn(target, today) };
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
   * Phase 57 (spec D9, D10, D13, rulings T6-a, T6-b). Targets as the learner reads them on
   * `today`: each word with the form it was saved from, as written (final review M3), its key,
   * and its day (the day's state of it, what it owes); and the target's own day (today's work)
   * and its path's session as the home read gives it (started, else stock, else a failed newest).
   * The day is readTargetDay's, the one the target's path plans by. A target's words are saved
   * ones (unsaving takes a word out of every target), so a word the list does not hold is not
   * shown.
   *
   * Phase 65 (spec D1, D4, D7, D9, D10). Readiness is the expected grade on the date
   * (readinessSummary): each word's counted skills among its live ones (readTargetDay's, so
   * speaking is dropped for a word that cannot be said or a device that does not record), each
   * from the target's readiness row, else the word's main memory (R1); at the start of today,
   * each skill's first line today; the words at 90 or more; and whether more practice adds
   * little. Today is a budget (todaySummary): the one stored for today, else none yet with the
   * offer as readTodayBudget would set it now; the path's sessions completed today, by their
   * practice_day (ADR 0013); its state from the plan's and the budget. The plan's own state is
   * unchanged: the picker reads it.
   *
   * Final review I4, the list's cost. The offer plays the picker forward only while the plan owes
   * work: on any other day the play is empty, so the offer is the sessions already done, which is
   * what readTodayBudget would answer. Its count of them is the day's sessions done, not read
   * again. The reads that are the enrollment's (enrollmentReads) are made once for all targets.
   */
  async function view(repos: Repos, enrolled: Enrollment, today: string, targets: readonly TargetWithWords[]): Promise<Target[]> {
    if (targets.length === 0) return [];
    const glossIds = [...new Set(targets.flatMap((target) => target.glossIds))];
    const saved = await repos.vocabulary.findSavedWords({ enrollmentId: enrolled.id, glossIds });
    const savedOf = new Map(saved.map((word) => [word.glossId, word]));
    const devices = (await repos.session.findNewestDevices(enrolled.id)) ?? { listening: false, speaking: false };
    const shared = enrollmentReads(repos, enrolled, devices, today);
    // Phase 65 (spec D1, R1). Readiness reads the targets' own rows, else the words' main memory.
    const readinessRows = await repos.targetReadiness.findRows(targets.map((target) => target.id), glossIds);
    const memory = await repos.memory.findRows({ enrollmentId: enrolled.id, glossIds });

    const out: Target[] = [];
    for (const target of targets) {
      const read = await readTargetDay(repos, enrolled, target, devices, today, saved, shared.answersOn);
      // Phase 64 (spec D5). The day it was made, for home's fuse; read on its own when no
      // saved word is left and so no target day was read.
      const createdOn = read?.createdOn ?? (await learnerDays(repos, enrolled.user_id, [target.createdAt.getTime()]))[0];
      const day =
        read?.day ??
        targetDay({ today, createdOn: today, dueOn: target.dueOn, kind: target.kind, words: [], starts: [], askedToday: [], answeredToday: false });
      const dayOf = new Map(day.words.map((word) => [word.glossId, word]));
      const liveOf = new Map((read?.dayInput.words ?? []).map((word) => [word.glossId, word.live]));
      const shown = target.glossIds.filter((glossId) => savedOf.has(glossId) && dayOf.has(glossId));
      const readiness = readinessSummary({
        kind: target.kind,
        dueOn: target.dueOn,
        today,
        words: shown.map((glossId) => ({ glossId, live: liveOf.get(glossId) ?? [] })),
        rows: readinessRows.filter((row) => row.targetId === target.id),
        memory,
        firstToday: await repos.targetReadiness.findFirstEventsOn(target.id, today),
      });
      const words = shown.map((glossId, i) => {
        const gloss = savedOf.get(glossId)!;
        const word = dayOf.get(glossId)!;
        return {
          gloss_id: glossId,
          form: gloss.form,
          meaning: gloss.key,
          readiness_pct: readiness.words[i].readinessPct,
          today: word.state,
          owed: word.owed,
          starts_in: word.startsIn,
          skills: readiness.words[i].skills,
        };
      });
      const budget = (await repos.targetBudgets.find(target.id, today)) ?? null;
      // readTodayBudget answers null for a target not active today or with no saved word.
      const offered = budget === null && read !== null && activeOn(target, today);
      const played = offered && day.state === 'owed' ? await readTodayBudget(repos, enrolled, target, devices, today, shared) : null;
      const sessionsDone = played?.doneBefore ?? (await repos.session.countCompletedOn(enrolled.id, target.id, today));
      const todays = todaySummary({
        plan: day.state,
        daysLeft: day.daysLeft,
        budget,
        offer: offered ? (played ?? { sessions: sessionsDone, cards: 0 }) : null,
        sessionsDone,
      });
      const { started, stock } = await repos.session.findOpen(enrolled.id, target.id);
      const latest = started || stock ? undefined : await repos.session.findLatest(enrolled.id, target.id);
      const current = started ?? stock ?? (latest?.status === 'failed' ? latest : null);
      out.push({
        id: target.id,
        kind: target.kind,
        due_on: target.dueOn,
        created_on: createdOn,
        days_left: daysBetween(today, target.dueOn),
        word_count: words.length,
        ready_count: readiness.readyCount,
        readiness_pct: readiness.readinessPct,
        readiness_start_pct: readiness.readinessStartPct,
        // Phase 67b (spec D6): the app asks before practice more only when one more session today
        // cannot raise the card; an unmet word needs the day's room for new words.
        practice_more_little: !canRaiseToday({
          daysLeft: daysBetween(today, target.dueOn),
          newRoom: Math.max(0, (await shared.dayCap()) - (await shared.introduced()).length),
          words: shown.map((glossId, i) => {
            const word = dayOf.get(glossId)!;
            return {
              readinessPct: readiness.words[i].readinessPct,
              met: word.state !== 'later' && !word.toStart,
              weakestOpenToday: readiness.words[i].weakestOpenToday,
            };
          }),
        }),
        today: {
          state: todays.state,
          done: day.done,
          planned: day.planned,
          extra: day.extra,
          next_practice_in: day.nextPracticeIn,
          sessions_budget: todays.sessionsBudget,
          sessions_offer: todays.sessionsOffer,
          sessions_done: todays.sessionsDone,
          ended_early: todays.endedEarly,
          minutes: todays.minutes,
        },
        session: current
          ? {
              session_id: current.id,
              status: current.status,
              source: current.source,
              answered: current.answered,
              total: current.total,
              // Final review N1: a session left before any answer is started with none.
              started: current === started,
            }
          : null,
        words,
      });
    }
    return out;
  }

  /** One target as view reads it, its words as they are now in this transaction. */
  async function viewOne(repos: Repos, enrolled: Enrollment, today: string, target: TargetRow): Promise<Target> {
    const [read] = await view(repos, enrolled, today, [{ ...target, glossIds: await repos.target.listWordIds(target.id) }]);
    return read;
  }

  return {
    /** The active targets (phase 57: through their due date), nearest date first, and the
     *  learner's today. */
    list: (actorUserId: string, enrollmentId: string): Promise<TargetList> =>
      transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'targets.manage' });
        const today = await learnerDay(repos, enrolled.user_id, now());
        const targets = await view(repos, enrolled, today, await repos.target.listActive(enrolled.id, today));
        return {
          today,
          targets: targets.map(({ words, ...summary }) => summary),
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
        // The new target's path has no stock to race until this commits: the main path's lock.
        await lockPaths(repos, enrolled.id, []);
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
        const retired = await restockAfterTargetChange(repos, enrolled.id, [row.id]);
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
      logTargetRetired(logger, enrollmentId, created.retired);
      return created.target;
    },

    /**
     * Spec D11. The photos' rows and the typed words saved, and those the target does not
     * hold yet joined to it, in one transaction. A word it holds already stays where it is.
     */
    addWords: async (actorUserId: string, targetId: string, request: AddTargetWordsRequest): Promise<Target> => {
      const changed = await transaction(async (repos) => {
        const { enrolled, target, today, open } = await lockTarget(repos, actorUserId, targetId);
        if (!open) throw new TargetClosed(targetId);
        const saved = await saveWords(repos, enrolled, actorUserId, request);
        const added = await repos.target.addWords(target.id, saved.glossIds);
        let retired: string[] = [];
        if (added.length > 0) {
          await repos.target.insertEvent({
            targetId: target.id,
            kind: 'words_added',
            before: null,
            after: { gloss_ids: added },
            actorUserId,
            sessionId: null,
          });
          retired = await restockAfterTargetChange(repos, enrolled.id, [target.id]);
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
      logTargetRetired(logger, changed.enrollmentId, changed.retired);
      return changed.target;
    },

    /** Spec D1, D11. Out of the target, still saved. Idempotent: a word it does not hold
     *  changes nothing. Removing every word leaves an empty target (ruling R-D10). Phase 57
     *  (ruling T4-k, ADR 0014 R4): the word's target skills go with it, so the removal waits
     *  for a session end that would write them (the progress lock), taken once the stocks are
     *  retired (a skip of the stock holds its row, then that lock) and before the next stocks
     *  are asked for (a session end holds that lock, then enqueues its path's stock). */
    removeWord: async (actorUserId: string, targetId: string, glossId: string): Promise<void> => {
      const changed = await transaction(async (repos) => {
        const { enrolled, target, open } = await lockTarget(repos, actorUserId, targetId);
        if (!open) throw new TargetClosed(targetId);
        // Under the target's lock and its paths', its words cannot change before the removal.
        if (!(await repos.target.listWordIds(target.id)).includes(glossId)) return null;
        const retired = await retireStocks(repos, enrolled.id, [target.id]);
        await repos.progress.lockEnrollment(enrolled.id);
        await repos.target.removeWord(target.id, glossId);
        await repos.target.insertEvent({
          targetId: target.id,
          kind: 'words_removed',
          before: { gloss_ids: [glossId] },
          after: { reason: 'removed' },
          actorUserId,
          sessionId: null,
        });
        await requestStocks(repos, enrolled.id, [target.id]);
        return { enrollmentId: enrolled.id, retired };
      });
      if (changed === null) return;
      logger.info({ event: 'target_changed', target_id: targetId, change: 'words_removed', count: 1 });
      logTargetRetired(logger, changed.enrollmentId, changed.retired);
    },

    /** Spec D1. To any day after today; the date it has already changes nothing. */
    changeDate: async (actorUserId: string, targetId: string, request: ChangeTargetDateRequest): Promise<Target> => {
      const changed = await transaction(async (repos) => {
        const { enrolled, target, today, open } = await lockTarget(repos, actorUserId, targetId);
        if (!open) throw new TargetClosed(targetId);
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
        const retired = await restockAfterTargetChange(repos, enrolled.id, [target.id]);
        const moved = { ...target, dueOn: request.due_on };
        return { target: await viewOne(repos, enrolled, today, moved), change: { enrollmentId: enrolled.id, retired } };
      });
      if (changed.change !== null) {
        logger.info({ event: 'target_changed', target_id: targetId, change: 'date_changed' });
        logTargetRetired(logger, changed.change.enrollmentId, changed.change.retired);
      }
      return changed.target;
    },

    /** Spec D1, D8. Ended now, before its date. Idempotent on a target ended already; one
     *  whose date has come is closed to change (phase 57, spec D10: it is active through the
     *  date and ends by itself the day after). Final review I1: its path's started session, which
     *  nothing could resume or skip once the path is closed, is skipped in the same transaction,
     *  its answers counted once as a skip's; so, as a removal does (ADR 0014 R4), the stocks are
     *  retired and that session's row changed before the progress lock, and the next stocks are
     *  asked for after it. */
    end: async (actorUserId: string, targetId: string): Promise<void> => {
      const ended = await transaction(async (repos) => {
        const { enrolled, target, today, open } = await lockTarget(repos, actorUserId, targetId);
        if (target.endedAt !== null) return null;
        if (!open) throw new TargetClosed(targetId);
        if (!(await repos.target.end(target.id, new Date(now())))) return null;
        await repos.target.insertEvent({
          targetId: target.id,
          kind: 'ended_early',
          before: null,
          after: { due_on: target.dueOn },
          actorUserId,
          sessionId: null,
        });
        const retired = await retireStocks(repos, enrolled.id, [target.id]);
        const { started } = await repos.session.findOpen(enrolled.id, target.id);
        const day = started ? await lastAnswerDay(repos, enrolled.user_id, started.id, today) : today;
        const skipped = started && (await skipOpenSession(repos, started.id, enrolled.id, day)) ? started.id : null;
        await requestStocks(repos, enrolled.id, [target.id]);
        return { enrollmentId: enrolled.id, retired, skipped };
      });
      if (ended === null) return;
      logger.info({ event: 'target_ended', target_id: targetId, how: 'early' });
      if (ended.skipped) logger.info({ event: 'session_skipped', session_id: ended.skipped, reason: 'target_ended' });
      logTargetRetired(logger, ended.enrollmentId, ended.retired);
    },
  };
}

export type TargetService = ReturnType<typeof createTargetService>;
