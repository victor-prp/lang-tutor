import type { Db } from '../../src/db/client';
import { users } from '../../src/db/schema';

/**
 * Inserts a fully-formed user under an id the caller chooses.
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
    .values({
      id,
      username: id,
      displayName: `test ${id}`,
      age: 30,
      nativeLanguage: 'he',
      targetLanguage: 'en',
    })
    .onConflictDoNothing();
}
