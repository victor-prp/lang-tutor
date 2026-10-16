import type {
  Enrollment,
  RemoveVocabularyLevelResponse,
  SaveVocabularyResponse,
  VocabularyEntryInput,
  VocabularyPage,
  VocabularyPageQuery,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';
import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';

import { RENDER_LEMMA } from '../domain/jobs';
import {
  assemblePage,
  buildWordDetail,
  cursorAfter,
  decodeCursor,
  encodeCursor,
  firstPerGloss,
} from '../domain/vocabulary';
import { EnrollmentNotFound, GlossLanguageMismatch, InvalidCursor, InvalidVocabularyEntry, WordNotFound } from '../errors';
import type { Logger } from '../logger';
import { authorize, authorizeEnrollment } from './access';
import { learnerDay } from './learnerDay';
import { lockPaths, logTargetRetired, requestStockAfterSave, requestStocks, retireStocks } from './stock';
import type { Repos, Transaction } from './transaction';

const DEFAULT_PAGE_SIZE = 50;

async function enrollmentOrThrow(repos: Repos, enrollmentId: string): Promise<Enrollment> {
  const enrolled = await repos.enrollment.findById(enrollmentId);
  if (!enrolled) throw new EnrollmentNotFound(enrollmentId);
  return enrolled;
}

/**
 * A typed save's checks and writes, inside a transaction the caller opened and
 * authorized: all-or-nothing, so every entry is checked before anything is
 * written and a throw rolls the caller's transaction back. A gloss already
 * saved is not an error (the insert's DO NOTHING keeps its first form).
 * Answers the saved gloss ids, resolved through merges, in the order asked,
 * each once; nothing is read or written for no entries.
 *
 * Phase 53 (spec D10, D11). Extracted from save, so a target's typed words are
 * saved exactly as the list saves them, in the target's own transaction.
 */
export async function saveEntriesInTx(
  repos: Repos,
  logger: Logger,
  input: {
    enrolled: Enrollment;
    actorUserId: string;
    entries: readonly VocabularyEntryInput[];
    stockSaveDelaySeconds: number;
  },
): Promise<string[]> {
  const { enrolled, actorUserId } = input;
  const asked = firstPerGloss(input.entries);
  if (asked.length === 0) return [];
  // Phase 31 (spec D14). Share-lock and resolve before anything is checked or
  // written: a merge of these glosses runs wholly before this or wholly after.
  const resolved = await repos.gloss.resolveGlosses(asked.map((entry) => entry.gloss_id));
  const foreign = asked.find((entry) => {
    const gloss = resolved.get(entry.gloss_id);
    return gloss !== undefined && gloss.userLanguageCode !== enrolled.source_language;
  });
  if (foreign) {
    logger.info({ event: 'vocabulary_entry_refused', enrollment_id: enrolled.id, gloss_id: foreign.gloss_id, reason: 'language' });
    throw new GlossLanguageMismatch(foreign.gloss_id);
  }
  const toSave = firstPerGloss(
    asked.map((entry) => ({ gloss_id: resolved.get(entry.gloss_id)?.id ?? entry.gloss_id, variant_id: entry.variant_id })),
  );
  const saveable = await repos.vocabulary.findSaveable({
    entries: toSave.map((entry) => ({ glossId: entry.gloss_id, variantId: entry.variant_id })),
    targetLanguage: enrolled.target_language,
    sourceLanguage: enrolled.source_language,
  });
  const passed = new Set(saveable.map((row) => `${row.glossId} ${row.variantId}`));
  const refused = toSave.find((entry) => !passed.has(`${entry.gloss_id} ${entry.variant_id}`));
  if (refused) {
    // The 400 body is fixed; the gloss that caused it is only in the log.
    // Logged before the throw, inside the transaction, so it is recorded
    // even though the rollback follows. Logger has no warn level, so this
    // is an info event like every other.
    logger.info({
      event: 'vocabulary_entry_refused',
      enrollment_id: enrolled.id,
      gloss_id: refused.gloss_id,
      variant_id: refused.variant_id,
    });
    throw new InvalidVocabularyEntry(refused.gloss_id);
  }
  await repos.vocabulary.insertEntries({ enrollmentId: enrolled.id, addedByUserId: actorUserId, entries: saveable });
  // Phase 31 (spec D12). A word whose lemma form this language has not
  // rendered gets it rendered in the background, once (plan item 3).
  const claimed = await repos.dict.claimLemmaRenders(
    saveable.map((row) => ({ lexemeId: row.lexemeId, userLanguageCode: enrolled.source_language })),
  );
  for (const pair of claimed) {
    await repos.jobs.enqueue(RENDER_LEMMA, { lexeme_id: pair.lexemeId, user_language_code: pair.userLanguageCode });
  }
  // Phase 43 (spec D3). A list with no session in stock gets one, once the
  // burst of saves this may be the first of has landed (ruling R3).
  await requestStockAfterSave(repos, enrolled.id, input.stockSaveDelaySeconds);
  return toSave.map((entry) => entry.gloss_id);
}

/**
 * An enrollment's word list. One transaction per use case (ADR 0001 R8); the
 * enrollment check shares it, because an entry for an enrollment that does not
 * exist is wrong, and so is a page read against one.
 *
 * Phase 28: both writes name an actor and pass ADR 0008's check first.
 * Phase 29 (spec D13): so do both reads, which are the owner's alone.
 */
export function createVocabularyService({
  transaction,
  logger,
  now,
  stockSaveDelaySeconds,
}: {
  transaction: Transaction;
  logger: Logger;
  /** Phase 57. The clock an unsave reads the learner's today by: which targets are active. */
  now: () => number;
  /** Phase 43 (ruling R3). How long a save's request for a stock waits. */
  stockSaveDelaySeconds: number;
}) {
  return {
    /**
     * All-or-nothing: every item is checked before anything is written, and the
     * throw rolls the transaction back. A gloss already saved is not an error —
     * the insert's DO NOTHING keeps its first form — so a repeat answers 200
     * with the same ids.
     */
    save: async (
      actorUserId: string,
      enrollmentId: string,
      entries: VocabularyEntryInput[],
    ): Promise<SaveVocabularyResponse> => {
      const asked = firstPerGloss(entries);
      let by: 'owner' | 'grantee' = 'owner';
      await transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        by = await authorize(repos, logger, { actorUserId, enrollment: enrolled, permission: 'vocabulary.add' });
        await saveEntriesInTx(repos, logger, { enrolled, actorUserId, entries, stockSaveDelaySeconds });
      });
      logger.info({ event: 'vocabulary_saved', enrollment_id: enrollmentId, entry_count: asked.length, by });
      return { saved_gloss_ids: asked.map((entry) => entry.gloss_id) };
    },

    unsave: async (actorUserId: string, enrollmentId: string, glossId: string): Promise<void> => {
      const retired = await transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        await authorize(repos, logger, { actorUserId, enrollment: enrolled, permission: 'vocabulary.remove' });
        // Phase 53 (ruling R-D12b, final review M2). An unsave may change a target, so it takes
        // the next-session locks first, as every change to a target does: a stock being written
        // holds its path's and reads the targets' words. The main path's first, then, once the
        // gloss is resolved, the paths of the active targets holding it (phase 57, ADR 0014:
        // lockPaths' order), which no change can add to while the main path's is held.
        await repos.session.lockNextSession(enrollmentId, null);
        // Phase 31 (spec D14). A card on screen since before a merge names the
        // forwarded id: share-lock, resolve, and delete the survivor's entry.
        const resolved = await repos.gloss.resolveGlosses([glossId]);
        const survivor = resolved.get(glossId)?.id ?? glossId;
        const today = await learnerDay(repos, enrolled.user_id, now());
        const active = new Set((await repos.target.listActive(enrollmentId, today)).map((target) => target.id));
        const holding = (await repos.target.listHolding(enrollmentId, survivor)).filter((targetId) => active.has(targetId));
        await lockPaths(repos, enrollmentId, holding);
        // Spec D12: a word removed is a change to its active targets, so the stocks chosen with
        // it go, its targets' and the main path's: retired before the progress lock, since a
        // skip of a stock holds its row, then that lock (ADR 0014 R4).
        const retired = holding.length > 0 ? await retireStocks(repos, enrollmentId, holding) : [];
        // Phase 57 (ruling T4-k). The word's memory, levels and target skills go with it: a
        // session end that would write them runs wholly before this or reads it gone.
        await repos.progress.lockEnrollment(enrollmentId);
        await repos.vocabulary.deleteEntry({ enrollmentId, glossId: survivor });
        // Phase 53 (spec D1). A target's words are saved ones: an unsaved word
        // leaves every target that held it, each with a line in its log.
        const changed = await repos.target.removeGlossFromTargets(enrollmentId, survivor);
        for (const targetId of changed) {
          await repos.target.insertEvent({
            targetId,
            kind: 'words_removed',
            before: { gloss_ids: [survivor] },
            after: { reason: 'unsaved' },
            actorUserId,
            sessionId: null,
          });
        }
        // And the next stocks asked for only after the progress lock: a session end holds it,
        // then enqueues its path's stock under the same singleton key (ADR 0014 R4).
        if (holding.length > 0) await requestStocks(repos, enrollmentId, holding);
        return retired;
      });
      logger.info({ event: 'vocabulary_unsaved', enrollment_id: enrollmentId });
      logTargetRetired(logger, enrollmentId, retired);
    },

    /**
     * Phase 58 (spec D1–D3). Every word whose badge is `level` leaves the list, every
     * saved sense of it, in one transaction: unsave once for the batch. One lock, one
     * words_removed line per target changed, one restock. Nothing at the level is a
     * 200 with zeros, so a retry after a lost answer is safe.
     *
     * Final review I1: unlike a single unsave, it restocks whenever anything went, a
     * target or not. The removal is a reset, and a list stock chosen from the removed
     * words would otherwise serve them as the next session.
     */
    removeLevel: async (
      actorUserId: string,
      enrollmentId: string,
      level: number,
    ): Promise<RemoveVocabularyLevelResponse> => {
      const { removed, retired } = await transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        await authorize(repos, logger, { actorUserId, enrollment: enrolled, permission: 'vocabulary.remove' });
        // As unsave: a change to a target takes the next-session lock first.
        await repos.session.lockNextSession(enrollmentId);
        const atLevel = await repos.vocabulary.findGlossIdsAtLevel({ enrollmentId, level, live: LIVE_DIMENSIONS });
        if (atLevel.length === 0) return { removed: { removed_words: 0, removed_glosses: 0 }, retired: null };
        // Phase 31 (spec D14). Share-lock and resolve: a merge that forwarded one of
        // these meanwhile stays inside its lexeme, so its survivor is the same word's.
        const resolved = await repos.gloss.resolveGlosses(atLevel.map((row) => row.glossId));
        const survivors = [...new Set(atLevel.map((row) => resolved.get(row.glossId)?.id ?? row.glossId))];
        await repos.vocabulary.deleteEntries({ enrollmentId, glossIds: survivors });
        const lost = await repos.target.removeGlossesFromTargets(enrollmentId, survivors);
        for (const [targetId, glossIds] of lost) {
          await repos.target.insertEvent({
            targetId,
            kind: 'words_removed',
            before: { gloss_ids: glossIds },
            after: { reason: 'unsaved' },
            actorUserId,
            sessionId: null,
          });
        }
        return {
          removed: { removed_words: new Set(atLevel.map((row) => row.lemma)).size, removed_glosses: survivors.length },
          retired: await restockAfterTargetChange(repos, enrollmentId, 'words_removed'),
        };
      });
      logger.info({
        event: 'vocabulary_level_removed',
        enrollment_id: enrollmentId,
        level,
        word_count: removed.removed_words,
        gloss_count: removed.removed_glosses,
      });
      logTargetRetired(logger, enrollmentId, retired, 'words_removed');
      return removed;
    },

    /**
     * Keyset pagination. One extra row is read to learn whether a next page
     * exists; the cursor is the last row KEPT — from the page rows, never from
     * the assembled items, which may be one short (assemblePage's comment).
     */
    listWords: async (
      actorUserId: string,
      enrollmentId: string,
      query: VocabularyPageQuery,
    ): Promise<VocabularyPage> => {
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const level = query.level ?? null;
      const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
      if (query.cursor !== undefined && !after) throw new InvalidCursor();

      return transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, {
          actorUserId,
          enrollmentId,
          permission: 'vocabulary.read',
        });
        const read = await repos.vocabulary.findWordsPage({
          enrollmentId,
          limit: limit + 1,
          after,
          level,
          live: LIVE_DIMENSIONS,
        });
        const rows = read.slice(0, limit);
        const summaries = await repos.vocabulary.findWordSummaries({
          enrollmentId,
          lemmas: rows.map((row) => row.lemma),
          targetLanguage: enrolled.target_language,
          sourceLanguage: enrolled.source_language,
          ownerUserId: enrolled.user_id,
        });
        return {
          items: assemblePage(rows, summaries),
          next_cursor: read.length > limit ? encodeCursor(cursorAfter(rows[rows.length - 1])) : null,
        };
      });
    },

    /** Every lexeme with this lemma in the target language is one word. None is a
     *  404; a word with nothing saved is a 200 with no level. */
    wordDetail: (actorUserId: string, enrollmentId: string, lemma: string): Promise<VocabularyWordDetail> =>
      transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, {
          actorUserId,
          enrollmentId,
          permission: 'vocabulary.read',
        });
        const lexemes = await repos.vocabulary.findLemmaLexemes({
          languageCode: enrolled.target_language,
          lemma,
        });
        if (lexemes.length === 0) throw new WordNotFound(lemma);
        const renderings = await repos.vocabulary.findLemmaRenderings({
          languageCode: enrolled.target_language,
          lemma,
          userLanguageCode: enrolled.source_language,
        });
        const saved = await repos.vocabulary.findSavedInLemma({
          enrollmentId,
          lemma,
          ownerUserId: enrolled.user_id,
        });
        const progress = await repos.progress.findRows({
          enrollmentId,
          glossIds: saved.map((entry) => entry.glossId),
          savedBy: null,
        });
        return buildWordDetail(lemma, lexemes, renderings, saved, progress);
      }),
  };
}

export type VocabularyService = ReturnType<typeof createVocabularyService>;
