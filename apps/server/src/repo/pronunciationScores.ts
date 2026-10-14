import { and, eq, or } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { pronunciationScores } from '../db/schema';

/** Phase 50 (spec D3). A pair as stored, `a < b` by code point. */
export type PronunciationScore = { a: string; b: string; score: number };

export function createPronunciationRepo(tx: Tx) {
  return {
    /** The stored scores of `pairs` in `language`; a pair never scored is absent. */
    find: async (language: string, pairs: readonly { a: string; b: string }[]): Promise<PronunciationScore[]> => {
      if (pairs.length === 0) return [];
      return tx
        .select({ a: pronunciationScores.formA, b: pronunciationScores.formB, score: pronunciationScores.score })
        .from(pronunciationScores)
        .where(
          and(
            eq(pronunciationScores.languageCode, language),
            or(...pairs.map((pair) => and(eq(pronunciationScores.formA, pair.a), eq(pronunciationScores.formB, pair.b)))),
          ),
        );
    },
    /** Writes each score unless its pair already has one: the first stands. */
    insert: async (language: string, rows: readonly PronunciationScore[]): Promise<void> => {
      if (rows.length === 0) return;
      await tx
        .insert(pronunciationScores)
        .values(rows.map((row) => ({ languageCode: language, formA: row.a, formB: row.b, score: row.score })))
        .onConflictDoNothing();
    },
  };
}

export type PronunciationRepo = ReturnType<typeof createPronunciationRepo>;
