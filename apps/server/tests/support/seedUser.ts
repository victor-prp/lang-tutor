import { eq } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { enrollments, sessions, users } from '../../src/db/schema';

/** The id seedUser gives its learner's English enrollment. */
export function enrollmentOf(userId: string): string {
  return `e_${userId}`;
}

/**
 * Inserts a fully-formed user under an id the caller chooses — and, from phase
 * 16, that user's English enrollment under `enrollmentOf(id)`, because a
 * learner with no enrollment can start nothing and every test about sessions
 * would otherwise say so first.
 *
 * The id default only fires when the column is omitted, so a test can keep
 * using a readable 'u1' instead of threading a generated UUID through every
 * assertion. Registration through the service is covered by its own tests;
 * this exists so tests *about sessions* can have a user without saying so
 * five times.
 */
export async function seedUser(db: Db, id: string): Promise<void> {
  await db
    .insert(users)
    .values({ id, username: id, displayName: `test ${id}`, age: 30, nativeLanguage: 'he' })
    .onConflictDoNothing();
  await seedEnrollment(db, { id: enrollmentOf(id), userId: id, targetLanguage: 'en' });
}

/** A Hebrew-explained enrollment under an id the caller chooses. */
export async function seedEnrollment(
  db: Db,
  input: { id: string; userId: string; targetLanguage: string },
): Promise<void> {
  await db
    .insert(enrollments)
    .values({
      id: input.id,
      userId: input.userId,
      sourceLanguage: 'he',
      targetLanguage: input.targetLanguage,
    })
    .onConflictDoNothing();
}

/**
 * A learner as phase 8 onboarded them before phase 16: English-native, learning
 * Hebrew, so their enrollment is English-explained — a pair the seed holds no
 * questions for. Route tests may not reach the database themselves (ADR 0001),
 * which is why this lives here.
 */
export async function seedLegacyLearner(db: Db): Promise<{ enrollmentId: string }> {
  await db
    .insert(users)
    .values({ id: 'u_legacy', username: 'u_legacy', displayName: 'legacy', age: 40, nativeLanguage: 'en' })
    .onConflictDoNothing();
  await db
    .insert(enrollments)
    .values({ id: 'e_legacy', userId: 'u_legacy', sourceLanguage: 'en', targetLanguage: 'he' })
    .onConflictDoNothing();
  return { enrollmentId: 'e_legacy' };
}

/**
 * The enrollment a session row is attributed to, read straight from
 * `sessions.enrollment_id` — nothing on the wire echoes it. Here for the same
 * reason as seedLegacyLearner: route tests may not reach the database
 * themselves (ADR 0001).
 */
export async function enrollmentOfSession(db: Db, sessionId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ enrollmentId: sessions.enrollmentId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row?.enrollmentId;
}
