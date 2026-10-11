import { FSRS6_DEFAULT, retrievability, type Dimension } from '@lang-tutor/core/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { createDb } from '../../../apps/server/src/db/client';
import { glossMemory, glossProgress } from '../../../apps/server/src/db/schema';
import { E2E_DATABASE_URL } from '../../globalSetup';

// Phase 35 (spec §6, e2e). A session no longer gives position N a fixed type:
// the words are chosen by what the learner remembers (D5) and each card by its
// chance of success (D6). A spec that needs a card type writes the memory that
// makes it come out, here, straight into this lane's e2e database.
//
// R is the chance of recall today: R(t, S) = (1 + F·t/S)^(−w20), so R is 0.9
// exactly when t = S. The bands that steer a card (chooseConstants.ts):
//   R ≤ R_TARGET (0.9)             the word is due, on its weakest dimension
//   memory and R ≥ RUNG_R (0.75)   recall (rung 2), else recognition (rung 1);
//                                  phase 37 (D2): the level no longer decides
// and within a rung the type whose p = g + (1 − g)·R^e is nearest 0.85, with
// g = 0.25 for a four-option card and e = 0.5 at rung 1, 1 at rung 2. A second
// list session the same day also brings back, as recall cards, the words the
// first met or missed (phase 37 D1); a spec that needs a card should not count
// on a second session.

/** One memory row to write, for the saved gloss whose key (its Hebrew meaning)
 *  is `gloss`. `daysAgo` is how long before today it was last reviewed, and
 *  `level` is written to the gloss's gloss_progress row for the same dimension. */
export type MemorySeed = {
  gloss: string;
  dimension: Dimension;
  stability: number;
  daysAgo: number;
  level: number;
  difficulty?: number;
};

/** Today as the server reads a learner's day: the real UTC date (spec D10). */
const today = (): string => new Date().toISOString().slice(0, 10);

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** The R a seed gives today, as the server's word choice computes it. */
export function seededR(seed: Pick<MemorySeed, 'stability' | 'daysAgo'>): number {
  const day = today();
  return retrievability(
    { stability: seed.stability, difficulty: 5, lastDay: daysBefore(day, seed.daysAgo), reps: 1, lapses: 0, params: FSRS6_DEFAULT.id },
    day,
  );
}

/**
 * Writes `seeds` for `username`'s saved glosses. Every gloss a seed names first
 * loses the memory rows it had, so its memory is exactly what the spec says,
 * whatever an earlier session wrote; a gloss no seed names is left alone. Each
 * seed also sets its dimension's level, and leaves that row's step and mistake
 * days alone (null on a fresh save), so the level rule may step it today.
 */
export async function seedMemory(username: string, seeds: MemorySeed[]): Promise<void> {
  const handle = createDb(E2E_DATABASE_URL, { max: 1, onError: () => {} });
  try {
    const saved = await handle.db.execute<{ enrollment_id: string; gloss_id: string; key: string }>(sql`
      select v.enrollment_id, v.gloss_id, g.key
      from vocabulary_entries v
      join enrollments e on e.id = v.enrollment_id
      join users u on u.id = e.user_id
      join dict_glosses g on g.id = v.gloss_id
      where u.username = ${username}
    `);
    const glossOf = (key: string) => {
      const found = saved.rows.filter((row) => row.key === key);
      if (found.length !== 1) throw new Error(`${username} has ${found.length} saved glosses with the key ${key}`);
      return found[0];
    };
    const day = today();
    await handle.db.transaction(async (tx) => {
      const named = [...new Set(seeds.map((seed) => glossOf(seed.gloss)))];
      for (const enrollmentId of new Set(named.map((row) => row.enrollment_id))) {
        const glossIds = named.filter((row) => row.enrollment_id === enrollmentId).map((row) => row.gloss_id);
        await tx.delete(glossMemory).where(and(eq(glossMemory.enrollmentId, enrollmentId), inArray(glossMemory.glossId, glossIds)));
      }
      for (const seed of seeds) {
        const { enrollment_id: enrollmentId, gloss_id: glossId } = glossOf(seed.gloss);
        await tx.insert(glossMemory).values({
          enrollmentId,
          glossId,
          dimension: seed.dimension,
          stability: seed.stability,
          difficulty: seed.difficulty ?? 5,
          lastDay: daysBefore(day, seed.daysAgo),
          reps: 1,
          lapses: 0,
          params: FSRS6_DEFAULT.id,
        });
        await tx
          .update(glossProgress)
          .set({ level: seed.level })
          .where(
            and(
              eq(glossProgress.enrollmentId, enrollmentId),
              eq(glossProgress.glossId, glossId),
              eq(glossProgress.dimension, seed.dimension),
            ),
          );
      }
    });
  } finally {
    await handle.close();
  }
}
