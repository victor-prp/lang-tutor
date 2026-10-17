import { sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';

/** Phase 61. One enrollment's sessions as a question-types test reads them, oldest first. */
export async function readSessionRows(
  db: Db,
  enrollmentId: string,
): Promise<{ id: string; status: string; kind: string; chosen_on: string | null }[]> {
  const rows = await db.execute<{ id: string; status: string; kind: string; chosen_on: string | null }>(
    sql`select id, status, kind, chosen_on from sessions where enrollment_id = ${enrollmentId} order by created_at`,
  );
  return rows.rows;
}

/** Phase 61. A session started, as its start call or first answer would leave it. */
export async function markStarted(db: Db, sessionId: string): Promise<void> {
  await db.execute(sql`update sessions set started_at = now() where id = ${sessionId}`);
}

/** Phase 61. A ready session made the enrollment's seeded first one. */
export async function markSeed(db: Db, sessionId: string): Promise<void> {
  await db.execute(sql`update sessions set source = 'seed' where id = ${sessionId}`);
}

/** Phase 61 (final review). A session the enrollment had and is done with: past the seed. */
export async function seedPastSession(db: Db, userId: string, enrollmentId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`insert into sessions (user_id, enrollment_id, status, source, created_at)
        values (${userId}, ${enrollmentId}, 'skipped', 'seed', now() - interval '1 day') returning id`,
  );
  return rows.rows[0].id;
}
