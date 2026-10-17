import { eq } from 'drizzle-orm';

import { createBots } from '../../src/db/bots';
import type { Db } from '../../src/db/client';
import { authUsers, enrollments, sessions, users } from '../../src/db/schema';

/** Phase 29. A profile needs a sign-in identity with the same id (spec D9). */
export async function seedIdentity(db: Db, id: string): Promise<void> {
  await db
    .insert(authUsers)
    .values({ id, name: `test ${id}`, email: `${id}@test.invalid` })
    .onConflictDoNothing();
}

/** Phase 61 (spec D1). Makes a profile a tester, or not, as db:tester would. */
export async function setTester(db: Db, id: string, on = true): Promise<void> {
  await db.update(users).set({ tester: on }).where(eq(users.id, id));
}

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
  await seedIdentity(db, id);
  await db
    .insert(users)
    .values({ id, username: id, displayName: `test ${id}`, age: 30, nativeLanguage: 'he' })
    .onConflictDoNothing();
  await seedEnrollment(db, { id: enrollmentOf(id), userId: id, targetLanguage: 'en' });
}

/**
 * Phase 52 (final review I2). A profile with no enrollment, as a tutor who only teaches
 * has one: seedUser without the course. `seedEnrollment` gives it one later.
 */
export async function seedUserWithoutEnrollment(db: Db, id: string): Promise<void> {
  await seedIdentity(db, id);
  await db
    .insert(users)
    .values({ id, username: id, displayName: `test ${id}`, age: 30, nativeLanguage: 'he' })
    .onConflictDoNothing();
}

/** Phase 35 (spec D11). Turns a seeded learner into a bot on `botDay`. */
export async function makeBot(db: Db, id: string, botDay: string): Promise<void> {
  await db.update(users).set({ kind: 'bot', botDay }).where(eq(users.id, id));
}

/** Phase 35 (spec D11). A bot as `npm run db:bots:create` makes one. */
export async function seedBot(db: Db, name: string, day: string): Promise<void> {
  await createBots(db, { names: [name], day });
}

/** Phase 52 (spec D1). Puts a seeded learner in a time zone, as the app's PUT /api/me/time-zone does. */
export async function setTimeZone(db: Db, id: string, timeZone: string): Promise<void> {
  await db.update(users).set({ timeZone }).where(eq(users.id, id));
}

/** Phase 52. The time zone a profile is stored with. */
export async function timeZoneOf(db: Db, id: string): Promise<string> {
  const [row] = await db.select({ timeZone: users.timeZone }).from(users).where(eq(users.id, id));
  if (!row) throw new Error(`no profile ${id}`);
  return row.timeZone;
}

/** Phase 35. The day a profile is on: null for a learner. */
export async function botDayOf(db: Db, username: string): Promise<string | null> {
  const [row] = await db.select({ day: users.botDay }).from(users).where(eq(users.username, username));
  if (!row) throw new Error(`no profile ${username}`);
  return row.day;
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
  await seedIdentity(db, 'u_legacy');
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
