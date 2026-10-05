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
import { EnrollmentNotFound, InvalidCursor, InvalidVocabularyEntry, LexemeNotFound } from '../errors';
import type { Logger } from '../logger';
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
      enrollmentId: string,
      entries: VocabularyEntryInput[],
    ): Promise<SaveVocabularyResponse> => {
      const asked = firstPerSense(entries);
      await transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
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
        await repos.vocabulary.insertEntries({ enrollmentId, entries: saveable });
      });
      logger.info({ event: 'vocabulary_saved', enrollment_id: enrollmentId, entry_count: asked.length });
      return { saved_sense_ids: asked.map((entry) => entry.sense_id) };
    },

    unsave: async (enrollmentId: string, senseId: string): Promise<void> => {
      await transaction(async (repos) => {
        await enrollmentOrThrow(repos, enrollmentId);
        await repos.vocabulary.deleteEntry({ enrollmentId, senseId });
      });
      logger.info({ event: 'vocabulary_unsaved', enrollment_id: enrollmentId });
    },

    /**
     * Keyset pagination. One extra row is read to learn whether a next page
     * exists; the cursor is the last row KEPT — from the page rows, never from
     * the assembled items, which may be one short (assemblePage's comment). A
     * cursor issued under another sort is refused: it names a position in a
     * different order.
     */
    listWords: async (enrollmentId: string, query: VocabularyPageQuery): Promise<VocabularyPage> => {
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const sort = query.sort ?? 'newest';
      const level = query.level ?? null;
      const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
      if (query.cursor !== undefined && (!after || after.sort !== sort)) throw new InvalidCursor();

      return transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const read = await repos.vocabulary.findWordsPage({
          enrollmentId,
          limit: limit + 1,
          after,
          sort,
          level,
          live: LIVE_DIMENSIONS,
        });
        const rows = read.slice(0, limit);
        const summaries = await repos.vocabulary.findWordSummaries({
          enrollmentId,
          lexemeIds: rows.map((row) => row.lexemeId),
          sourceLanguage: enrolled.source_language,
        });
        return {
          items: assemblePage(rows, summaries),
          next_cursor: read.length > limit ? encodeCursor(cursorAfter(sort, rows[rows.length - 1])) : null,
        };
      });
    },

    wordDetail: (enrollmentId: string, lexemeId: string): Promise<VocabularyWordDetail> =>
      transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const lexeme = await repos.vocabulary.findLexeme(lexemeId);
        if (!lexeme || lexeme.languageCode !== enrolled.target_language) {
          throw new LexemeNotFound(lexemeId);
        }
        const renderings = await repos.vocabulary.findLexemeRenderings({
          lexemeId,
          userLanguageCode: enrolled.source_language,
        });
        const saved = await repos.vocabulary.findSavedInLexeme({ enrollmentId, lexemeId });
        const progress = await repos.progress.findRows({
          enrollmentId,
          senseIds: saved.map((entry) => entry.senseId),
          savedBy: null,
        });
        return buildWordDetail(lexeme, renderings, saved, progress);
      }),
  };
}

export type VocabularyService = ReturnType<typeof createVocabularyService>;
