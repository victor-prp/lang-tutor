import { sql } from 'drizzle-orm';

import type { Db } from './client';
import { seedContent } from './seed';

/**
 * Clears the dictionary and the quiz, then replays the recording.
 *
 * This exists because `persistEntries` is first-writer-wins: running the seed
 * against a database that already holds a fixture writes nothing, so a
 * re-recorded content.generated.ts would silently never reach it. This is what
 * makes re-recording a supported operation rather than an improvised
 * `docker compose down -v`.
 *
 * **It drops looked-up words too**, not only recorded ones — the design
 * deliberately cannot tell them apart, which is precisely what let the `source`
 * column and everything built on it be deleted. The loss is provider calls
 * rather than data, since the dictionary is a cache; the other cost is
 * play-test session history.
 *
 * CASCADE from vocab_terms reaches term_variants, vocab_term_senses,
 * term_sense_translations, questions, session_questions and answers. `sessions`
 * is named explicitly because nothing references it, so nothing would cascade
 * to it, and a session whose questions had vanished would be broken rather than
 * absent. `users` is untouched.
 *
 * The statement is written here and again in migration 0003 rather than shared
 * from one place: that migration is frozen history, this command is live.
 */
export async function reseedContent(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE vocab_terms, sessions CASCADE`);
  await seedContent(db);
}
