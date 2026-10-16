import type { Dimension } from '@lang-tutor/core/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { glossMemory } from '../db/schema';
import type { MemoryRow } from '../domain/memoryUpdate';

/**
 * Phase 35 (spec D4, D8). gloss_memory: the hidden FSRS state per enrollment,
 * gloss and dimension. A row exists only for a saved gloss (its foreign key is
 * the vocabulary entry) and only once that dimension has been answered.
 */
export function createMemoryRepo(tx: Tx) {
  const asRow = (row: typeof glossMemory.$inferSelect): MemoryRow => ({
    glossId: row.glossId,
    dimension: row.dimension as Dimension,
    state: {
      stability: row.stability,
      difficulty: row.difficulty,
      lastDay: row.lastDay,
      reps: row.reps,
      lapses: row.lapses,
      params: row.params,
    },
    reachedOn: row.reachedOn,
  });

  return {
    /** Phase 57 (spec D11). Every row of the enrollment: its saved glosses' memory, which home
     *  counts the words due from without reading the saved list. */
    findEnrollmentRows: async (enrollmentId: string): Promise<MemoryRow[]> => {
      const rows = await tx
        .select()
        .from(glossMemory)
        .where(eq(glossMemory.enrollmentId, enrollmentId))
        .orderBy(glossMemory.glossId, glossMemory.dimension);
      return rows.map(asRow);
    },

    findRows: async (input: { enrollmentId: string; glossIds: string[] }): Promise<MemoryRow[]> => {
      if (input.glossIds.length === 0) return [];
      const rows = await tx
        .select()
        .from(glossMemory)
        .where(and(eq(glossMemory.enrollmentId, input.enrollmentId), inArray(glossMemory.glossId, input.glossIds)))
        .orderBy(glossMemory.glossId, glossMemory.dimension);
      return rows.map((row) => ({
        glossId: row.glossId,
        dimension: row.dimension as Dimension,
        state: {
          stability: row.stability,
          difficulty: row.difficulty,
          lastDay: row.lastDay,
          reps: row.reps,
          lapses: row.lapses,
          params: row.params,
        },
        reachedOn: row.reachedOn,
      }));
    },

    /** Phase 59 (spec D1). The list's practised words (a gloss with a memory row),
     *  as a translation sentence may use them: the saved form and the gloss's
     *  meaning, the most recently reviewed first, at most `limit`. */
    findPractisedWords: async (input: {
      enrollmentId: string;
      limit: number;
    }): Promise<{ glossId: string; word: string; meaning: string }[]> => {
      const rows = await tx.execute<{ gloss_id: string; word: string; meaning: string }>(sql`
        SELECT ve.gloss_id, v.form AS word, g.key AS meaning
        FROM vocabulary_entries ve
        JOIN dict_variants v ON v.id = ve.variant_id
        JOIN dict_glosses g  ON g.id = ve.gloss_id
        JOIN (SELECT gloss_id, max(last_day) AS last_day
              FROM gloss_memory
              WHERE enrollment_id = ${input.enrollmentId}
              GROUP BY gloss_id) m ON m.gloss_id = ve.gloss_id
        WHERE ve.enrollment_id = ${input.enrollmentId}
        ORDER BY m.last_day DESC, ve.gloss_id
        LIMIT ${input.limit}`);
      return rows.rows.map((row) => ({ glossId: row.gloss_id, word: row.word, meaning: row.meaning }));
    },

    upsertRows: async (input: { enrollmentId: string; rows: MemoryRow[] }): Promise<void> => {
      if (input.rows.length === 0) return;
      await tx
        .insert(glossMemory)
        .values(
          input.rows.map((row) => ({
            enrollmentId: input.enrollmentId,
            glossId: row.glossId,
            dimension: row.dimension,
            ...row.state,
            reachedOn: row.reachedOn,
          })),
        )
        .onConflictDoUpdate({
          target: [glossMemory.enrollmentId, glossMemory.glossId, glossMemory.dimension],
          set: {
            stability: sql`excluded.stability`,
            difficulty: sql`excluded.difficulty`,
            lastDay: sql`excluded.last_day`,
            reps: sql`excluded.reps`,
            lapses: sql`excluded.lapses`,
            params: sql`excluded.params`,
            reachedOn: sql`excluded.reached_on`,
          },
        });
    },

    /** Recompute only: every memory row, before the replay rebuilds them. */
    deleteAll: async (): Promise<void> => {
      await tx.delete(glossMemory);
    },
  };
}

export type MemoryRepo = ReturnType<typeof createMemoryRepo>;
