import { eq, sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { enrollments, myWordsDays } from '../../src/db/schema';

/** Phase 73. An enrollment's My words days, oldest first. */
export async function readMyWordsDays(db: Db, enrollmentId: string) {
  return db.select().from(myWordsDays).where(eq(myWordsDays.enrollmentId, enrollmentId)).orderBy(myWordsDays.day);
}

/** Phase 73. The stored My words goal (null the default, 0 off). */
export async function storeMyWordsGoal(db: Db, enrollmentId: string, stored: number | null): Promise<void> {
  await db.update(enrollments).set({ myWordsGoal: stored }).where(eq(enrollments.id, enrollmentId));
}

/** Phase 73. A session made a tester's question-types session. */
export async function markQuestionTypes(db: Db, sessionId: string): Promise<void> {
  await db.execute(sql`update sessions set kind = 'question_types' where id = ${sessionId}`);
}

/** Phase 73. The goal as stored (null the default, 0 off). */
export async function readStoredMyWordsGoal(db: Db, enrollmentId: string): Promise<number | null> {
  const [row] = await db.select({ goal: enrollments.myWordsGoal }).from(enrollments).where(eq(enrollments.id, enrollmentId));
  return row.goal;
}
