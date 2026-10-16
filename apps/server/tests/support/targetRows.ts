import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { sessions, targetEvents } from '../../src/db/schema';
import type { TargetSplit } from '../../src/domain/targetSession';
import type { TargetKind } from '../../src/domain/targets';
import { createTargetRepo } from '../../src/repo/targets';
import { withTx } from './withTx';

/**
 * Phase 53. Targets for a test, and reads of what sessions recorded for them. tests/support/
 * is the test composition root, so a service test reaches these tables only through here.
 */

/** A target of `enrollmentId` holding `glossIds`, written through the repository with none of
 *  the targets service's rules: a test about sessions sets one up directly. Answers its id. */
export function seedTarget(
  db: Db,
  input: { enrollmentId: string; kind: TargetKind; dueOn: string; glossIds: string[] },
): Promise<string> {
  return withTx(db, async (tx) => {
    const targets = createTargetRepo(tx);
    const { id } = await targets.insertTarget({ enrollmentId: input.enrollmentId, kind: input.kind, dueOn: input.dueOn });
    await targets.addWords(id, input.glossIds);
    return id;
  });
}

/** The split a session was chosen with (spec D8), one row per target it served. */
export function readSessionSplit(db: Db, sessionId: string): Promise<TargetSplit[]> {
  return withTx(db, (tx) => createTargetRepo(tx).findSessionSplit(sessionId));
}

/** A target's log (spec D8), oldest first. */
export function readTargetEvents(db: Db, targetId: string) {
  return db
    .select({
      kind: targetEvents.kind,
      before: targetEvents.before,
      after: targetEvents.after,
      actorUserId: targetEvents.actorUserId,
      sessionId: targetEvents.sessionId,
    })
    .from(targetEvents)
    .where(eq(targetEvents.targetId, targetId))
    .orderBy(asc(targetEvents.createdAt), asc(targetEvents.id));
}

/** Spec D12. What became of a stock: its status, the day it counted for (none for one
 *  retired) and the learner day its words were chosen on. */
export async function readStockRow(db: Db, sessionId: string) {
  const [row] = await db
    .select({ status: sessions.status, practiceDay: sessions.practiceDay, chosenOn: sessions.chosenOn })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row;
}

/** Phase 57 (spec D3). A target's skills, by gloss and dimension. */
export async function readTargetSkills(db: Db, targetId: string) {
  const rows = await db.execute<{ glossId: string; dimension: string; halves: number; sessionId: string | null; day: string | null }>(sql`
    select gloss_id as "glossId", dimension, halves, session_id::text as "sessionId", day::text as day
    from target_skills where target_id = ${targetId}
    order by gloss_id, dimension`);
  return rows.rows;
}

/** Phase 57 (spec D3). A target's skill events, without their ids and times, which a rebuild
 *  writes anew: by the session's day, then session, gloss and dimension, at most one each. */
export async function readTargetSkillEvents(db: Db, targetId: string) {
  const rows = await db.execute<{ glossId: string; dimension: string; sessionId: string; before: number; after: number; why: string }>(sql`
    select e.gloss_id as "glossId", e.dimension, e.session_id::text as "sessionId", e.before, e.after, e.why
    from target_skill_events e
    left join sessions s on s.id = e.session_id
    where e.target_id = ${targetId}
    order by s.practice_day, e.session_id, e.gloss_id, e.dimension`);
  return rows.rows;
}

/** Phase 57 (spec D6). Each of a target's words and the learner day it was started, or null. */
export async function readStartedOn(db: Db, targetId: string): Promise<Record<string, string | null>> {
  const rows = await db.execute<{ gloss_id: string; started_on: string | null }>(sql`
    select gloss_id, started_on::text as started_on from target_words where target_id = ${targetId} order by gloss_id`);
  return Object.fromEntries(rows.rows.map((row) => [row.gloss_id, row.started_on]));
}

/** Phase 57. Ends a target early, at the database's now, as the targets service's end would. */
export async function endTargetNow(db: Db, targetId: string): Promise<void> {
  await db.execute(sql`update targets set ended_at = now() where id = ${targetId}`);
}

/** Phase 57. Junk in every target's skills, log and started days, for a test that proves a
 *  rebuild replaces them: every value at the top with no session, an extra skill per word,
 *  a log line no session wrote, and every word started long ago. */
export async function spoilTargetSkills(db: Db): Promise<void> {
  await db.execute(sql`update target_skills set halves = 20, session_id = null, day = null`);
  await db.execute(sql`
    insert into target_skills (target_id, gloss_id, dimension, halves)
    select target_id, gloss_id, 'spoken_productive', 20 from target_words
    on conflict do nothing`);
  await db.execute(sql`
    insert into target_skill_events (target_id, gloss_id, dimension, session_id, before, after, why)
    select target_id, gloss_id, 'spoken_productive', gen_random_uuid(), 0, 20, 'recall' from target_words`);
  await db.execute(sql`update target_words set started_on = '2000-01-01'`);
}
