import { and, eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { myWordsDays } from '../db/schema';

/** Phase 73 (spec D2). One My words day of one enrollment: the goal in force when it was last
 *  written (null for off) and what the day's counted sessions hold. */
export type MyWordsDayRow = {
  enrollmentId: string;
  day: string;
  goal: number | null;
  sessionsDone: number;
  newWords: number;
  movedUp: number;
  lastSessionId: string | null;
};

/**
 * my_words_days: rewritten whole from the day's sessions each time one completes or the goal
 * changes, so a write is idempotent and the last writer holds the day as it then stood.
 */
export function createMyWordsDayRepo(tx: Tx) {
  return {
    find: async (enrollmentId: string, day: string): Promise<MyWordsDayRow | undefined> => {
      const [row] = await tx
        .select({
          enrollmentId: myWordsDays.enrollmentId,
          day: myWordsDays.day,
          goal: myWordsDays.goal,
          sessionsDone: myWordsDays.sessionsDone,
          newWords: myWordsDays.newWords,
          movedUp: myWordsDays.movedUp,
          lastSessionId: myWordsDays.lastSessionId,
        })
        .from(myWordsDays)
        .where(and(eq(myWordsDays.enrollmentId, enrollmentId), eq(myWordsDays.day, day)));
      return row;
    },

    upsert: async (row: MyWordsDayRow): Promise<void> => {
      await tx
        .insert(myWordsDays)
        .values(row)
        .onConflictDoUpdate({ target: [myWordsDays.enrollmentId, myWordsDays.day], set: { goal: row.goal, sessionsDone: row.sessionsDone, newWords: row.newWords, movedUp: row.movedUp, lastSessionId: row.lastSessionId, updatedAt: new Date() } });
    },
  };
}

export type MyWordsDayRepo = ReturnType<typeof createMyWordsDayRepo>;
