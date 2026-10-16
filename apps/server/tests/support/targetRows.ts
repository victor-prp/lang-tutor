import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { sessions, sessionTargets, targetEvents } from '../../src/db/schema';
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

/** Phase 57 (spec D2, D9). What each target path's stock recorded of its target's day, one row
 *  per target (a target path's stock records its own only), without the phase 53 columns. */
export function readSessionTargets(db: Db, sessionId: string) {
  return db
    .select({
      targetId: sessionTargets.targetId,
      daysLeft: sessionTargets.daysLeft,
      capHalves: sessionTargets.capHalves,
      readinessPct: sessionTargets.readinessPct,
      readyCount: sessionTargets.readyCount,
      wordCount: sessionTargets.wordCount,
      fsrsReadyCount: sessionTargets.fsrsReadyCount,
      owedGlossIds: sessionTargets.owedGlossIds,
      wish: sessionTargets.wish,
      slots: sessionTargets.slots,
      picked: sessionTargets.picked,
      reason: sessionTargets.reason,
    })
    .from(sessionTargets)
    .where(eq(sessionTargets.sessionId, sessionId))
    .orderBy(asc(sessionTargets.targetId));
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
 *  retired), the learner day its words were chosen on and (phase 57) its path. */
export async function readStockRow(db: Db, sessionId: string) {
  const [row] = await db
    .select({ status: sessions.status, practiceDay: sessions.practiceDay, chosenOn: sessions.chosenOn, targetId: sessions.targetId })
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

/** Final review T4. A target's skill events in the order of their time, each with its time as
 *  Postgres prints it and whether that is its session's last answer, compared in SQL. */
export async function readTargetSkillEventTimes(db: Db, targetId: string) {
  const rows = await db.execute<{ sessionId: string; glossId: string; dimension: string; createdAt: string; atLastAnswer: boolean }>(sql`
    select e.session_id::text as "sessionId", e.gloss_id as "glossId", e.dimension, e.created_at::text as "createdAt",
           e.created_at = (select max(a.answered_at) from answers a where a.session_id = e.session_id) as "atLastAnswer"
    from target_skill_events e
    where e.target_id = ${targetId}
    order by e.created_at, e.gloss_id, e.dimension`);
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

/** Phase 57 (spec D3, D6). A target word as sessions would have left it: started on `startedOn`
 *  with these skill values in half-points, written directly. */
export async function setTargetWord(
  db: Db,
  input: { targetId: string; glossId: string; startedOn: string; halves: Partial<Record<string, number>> },
): Promise<void> {
  await db.execute(sql`update target_words set started_on = ${input.startedOn}::date where target_id = ${input.targetId} and gloss_id = ${input.glossId}`);
  for (const [dimension, halves] of Object.entries(input.halves)) {
    await db.execute(sql`
      insert into target_skills (target_id, gloss_id, dimension, halves) values (${input.targetId}, ${input.glossId}, ${dimension}, ${halves!})
      on conflict (target_id, gloss_id, dimension) do update set halves = excluded.halves`);
  }
}
