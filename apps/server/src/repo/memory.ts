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
