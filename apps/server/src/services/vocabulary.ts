import type {
  Enrollment,
  SaveVocabularyResponse,
  VocabularyEntryInput,
  VocabularyPage,
  VocabularyPageQuery,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';
import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';

import {
  assemblePage,
  buildWordDetail,
  cursorAfter,
  decodeCursor,
  encodeCursor,
  firstPerSense,
} from '../domain/vocabulary';
import { EnrollmentNotFound, InvalidCursor, InvalidVocabularyEntry, WordNotFound } from '../errors';
import type { Logger } from '../logger';
import { authorize, authorizeEnrollment } from './access';
import type { Repos, Transaction } from './transaction';

const DEFAULT_PAGE_SIZE = 50;

async function enrollmentOrThrow(repos: Repos, enrollmentId: string): Promise<Enrollment> {
  const enrolled = await repos.enrollment.findById(enrollmentId);
  if (!enrolled) throw new EnrollmentNotFound(enrollmentId);
  return enrolled;
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
}: {
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    /**
     * All-or-nothing: every item is checked before anything is written, and the
     * throw rolls the transaction back. A sense already saved is not an error —
     * the insert's DO NOTHING keeps its first form — so a repeat answers 200
     * with the same ids.
     */
    save: async (
      actorUserId: string,
      enrollmentId: string,
      entries: VocabularyEntryInput[],
    ): Promise<SaveVocabularyResponse> => {
      const asked = firstPerSense(entries);
      let by: 'owner' | 'grantee' = 'owner';
      await transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        by = await authorize(repos, logger, { actorUserId, enrollment: enrolled, permission: 'vocabulary.add' });
        const saveable = await repos.vocabulary.findSaveable({
          entries: asked.map((entry) => ({ senseId: entry.sense_id, variantId: entry.variant_id })),
          targetLanguage: enrolled.target_language,
          sourceLanguage: enrolled.source_language,
        });
        const passed = new Set(saveable.map((row) => `${row.senseId} ${row.variantId}`));
        const refused = asked.find((entry) => !passed.has(`${entry.sense_id} ${entry.variant_id}`));
        if (refused) {
          // The 400 body is fixed; the sense that caused it is only in the log.
          // Logged before the throw, inside the transaction, so it is recorded
          // even though the rollback follows. Logger has no warn level, so this
          // is an info event like every other.
          logger.info({
            event: 'vocabulary_entry_refused',
            enrollment_id: enrollmentId,
            sense_id: refused.sense_id,
            variant_id: refused.variant_id,
          });
          throw new InvalidVocabularyEntry(refused.sense_id);
        }
        await repos.vocabulary.insertEntries({ enrollmentId, addedByUserId: actorUserId, entries: saveable });
      });
      logger.info({ event: 'vocabulary_saved', enrollment_id: enrollmentId, entry_count: asked.length, by });
      return { saved_sense_ids: asked.map((entry) => entry.sense_id) };
    },

    unsave: async (actorUserId: string, enrollmentId: string, senseId: string): Promise<void> => {
      await transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        await authorize(repos, logger, { actorUserId, enrollment: enrolled, permission: 'vocabulary.remove' });
        await repos.vocabulary.deleteEntry({ enrollmentId, senseId });
      });
      logger.info({ event: 'vocabulary_unsaved', enrollment_id: enrollmentId });
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
          senseIds: saved.map((entry) => entry.senseId),
          savedBy: null,
        });
        return buildWordDetail(lemma, lexemes, renderings, saved, progress);
      }),
  };
}

export type VocabularyService = ReturnType<typeof createVocabularyService>;
