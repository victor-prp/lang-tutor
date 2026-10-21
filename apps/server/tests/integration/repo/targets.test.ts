import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql, type SQL } from 'drizzle-orm';

import type { TargetKind } from '../../../src/domain/targets';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createTargetRepo, type SessionTargetRow, type TargetEventInput, type TargetRepo } from '../../../src/repo/targets';
import { CHOSEN_ON, NO_DEVICES } from '../../support/questions';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

// Phase 53 (spec D1, D8). The four tables and the repository over them. The rules a
// service applies — who may act, what an active target allows — are not here: each
// method does one step and reports what it did.

let t: TestDb;
/** Five glosses of one lexeme, saved by u_1. A target does not need a word to be saved
 *  (the service keeps that true), but this is the shape it is used in. */
let glossIds: string[];

const E1 = enrollmentOf('u_1');
const E2 = enrollmentOf('u_2');

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
  ({ glossIds } = await seedSavedSenses(t.db, {
    enrollmentId: E1,
    lemma: 'quokka',
    translations: ['קוקה', 'וומבט', 'טפיר', 'אוצלוט', 'לימור'],
  }));
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(run: (r: TargetRepo) => Promise<T>) => withTx(t.db, (tx) => run(createTargetRepo(tx)));

const make = (over: Partial<{ enrollmentId: string; kind: TargetKind; dueOn: string }> = {}) =>
  repo((r) => r.insertTarget({ enrollmentId: E1, kind: 'exam', dueOn: '2026-10-20', ...over }));

/** An unstarted list session in stock for u_1's or u_2's main path, or (phase 57) a target's (the
 *  unique index allows one per path). */
const stock = (userId: 'u_1' | 'u_2' = 'u_1', path: string | null = null) =>
  withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession(userId, enrollmentOf(userId), NO_DEVICES, CHOSEN_ON, path));

const count = async (query: SQL) => (await t.db.execute<{ n: number }>(query)).rows[0].n;

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

/** Phase 57 (spec D2, D9). What a target path's stock records of its target's day. */
const pathRow = (targetId: string, over: Partial<SessionTargetRow> = {}): SessionTargetRow => ({
  targetId,
  daysLeft: 5,
  capHalves: 7,
  readinessPct: 18,
  readyCount: 1,
  wordCount: 8,
  fsrsReadyCount: 2,
  owedGlossIds: ['g_a', 'g_b'],
  pastBudget: false,
  stepDowns: [],
  ...over,
});

describe('the tables', () => {
  it('refuses a kind that is neither homework nor exam', async () => {
    await expect(make({ kind: 'quiz' as TargetKind })).rejects.toEqual(violating('targets_kind_known'));
  });

  it('refuses a target for an enrollment that does not exist', async () => {
    await expect(make({ enrollmentId: 'e_nobody' })).rejects.toEqual(violating('targets_enrollment_fk'));
  });

  it('refuses a word that is no gloss', async () => {
    const target = await make();
    await expect(repo((r) => r.addWords(target.id, ['no-such-gloss']))).rejects.toEqual(violating('target_words_gloss_fk'));
  });

  it('refuses a gloss twice in one target, by the key', async () => {
    const target = await make();
    await repo((r) => r.addWords(target.id, [glossIds[0]]));
    await expect(
      t.db.execute(sql`insert into target_words (target_id, gloss_id) values (${target.id}, ${glossIds[0]})`),
    ).rejects.toEqual(violating('target_words_pkey'));
  });

  it('lets one gloss be in two targets', async () => {
    const [a, b] = [await make(), await make({ kind: 'homework' })];
    await repo((r) => r.addWords(a.id, [glossIds[0]]));
    await repo((r) => r.addWords(b.id, [glossIds[0]]));
    expect(await count(sql`select count(*)::int as n from target_words where gloss_id = ${glossIds[0]}`)).toBe(2);
  });

  it('refuses an event kind it does not know', async () => {
    const target = await make();
    const event = { targetId: target.id, before: null, after: null, actorUserId: null, sessionId: null };
    await expect(repo((r) => r.insertEvent({ ...event, kind: 'moved' as TargetEventInput['kind'] }))).rejects.toEqual(
      violating('target_events_kind_known'),
    );
  });

  it("refuses a target path's row for a session or a target that is not there, and a target twice in one session", async () => {
    const target = await make();
    const sessionId = await stock('u_1', target.id);
    await expect(repo((r) => r.insertSessionTarget('00000000-0000-0000-0000-000000000000', pathRow(target.id)))).rejects.toEqual(
      violating('session_targets_session_fk'),
    );
    await expect(repo((r) => r.insertSessionTarget(sessionId, pathRow('00000000-0000-0000-0000-000000000000')))).rejects.toEqual(
      violating('session_targets_target_fk'),
    );
    await repo((r) => r.insertSessionTarget(sessionId, pathRow(target.id)));
    await expect(repo((r) => r.insertSessionTarget(sessionId, pathRow(target.id)))).rejects.toEqual(violating('session_targets_pkey'));
  });

  it("takes a target's words, log and its sessions' rows with it, once none of its sessions is left", async () => {
    const target = await make();
    const sessionId = await stock('u_1', target.id);
    await repo((r) => r.addWords(target.id, glossIds));
    await repo((r) => r.insertEvent({ targetId: target.id, kind: 'created', before: null, after: null, actorUserId: 'u_1', sessionId: null }));
    await repo((r) => r.insertSessionTarget(sessionId, pathRow(target.id)));
    // Phase 57 (ADR 0014): a session holds its path's target (sessions_target_fk, no action).
    await expect(t.db.execute(sql`delete from targets where id = ${target.id}`)).rejects.toEqual(violating('sessions_target_fk'));

    await t.db.execute(sql`delete from sessions where id = ${sessionId}`);
    await t.db.execute(sql`delete from targets where id = ${target.id}`);

    expect(await count(sql`select count(*)::int as n from target_words`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from target_events`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from session_targets`)).toBe(0);
  });

  it("takes a session's row with it, and leaves the target", async () => {
    const target = await make();
    const sessionId = await stock('u_1', target.id);
    await repo((r) => r.insertSessionTarget(sessionId, pathRow(target.id)));

    await t.db.execute(sql`delete from sessions where id = ${sessionId}`);

    expect(await count(sql`select count(*)::int as n from session_targets`)).toBe(0);
    expect(await repo((r) => r.findTarget(target.id))).not.toBeNull();
  });
});

describe('insertTarget, findTarget and findTargetForUpdate', () => {
  it('stores a target active and unended, and reads it back', async () => {
    const target = await make({ kind: 'homework', dueOn: '2026-11-02' });
    const stored = { id: expect.any(String), enrollmentId: E1, kind: 'homework', dueOn: '2026-11-02', createdAt: expect.any(Date), endedAt: null };
    expect(target).toEqual(stored);
    expect(await repo((r) => r.findTarget(target.id))).toEqual(target);
    expect(await repo((r) => r.findTargetForUpdate(target.id))).toEqual(target);
  });

  it('answers null, never a 22P02, for an id that is not a uuid or names nothing', async () => {
    expect(await repo((r) => r.findTarget('nope'))).toBeNull();
    expect(await repo((r) => r.findTargetForUpdate('nope'))).toBeNull();
    expect(await repo((r) => r.findTarget('00000000-0000-0000-0000-000000000000'))).toBeNull();
    expect(await repo((r) => r.findTargetForUpdate('00000000-0000-0000-0000-000000000000'))).toBeNull();
  });

  it('reads an ended target and a past one too: it is the service that decides what they allow', async () => {
    const target = await make({ dueOn: '2026-10-01' });
    await repo((r) => r.end(target.id, new Date('2026-10-02T08:00:00Z')));
    expect(await repo((r) => r.findTarget(target.id))).toMatchObject({ id: target.id, dueOn: '2026-10-01' });
  });
});

describe('listActive', () => {
  const TODAY = '2026-10-14';

  it('lists what is due today or later and not ended, nearest date first and then by id, with the words in the order added', async () => {
    const far = await make({ kind: 'exam', dueOn: '2026-10-30' });
    const tomorrowA = await make({ kind: 'homework', dueOn: '2026-10-15' });
    const tomorrowB = await make({ kind: 'exam', dueOn: '2026-10-15' });
    const dueToday = await make({ dueOn: TODAY });
    const past = await make({ dueOn: '2026-10-01' });
    const ended = await make({ dueOn: '2026-10-25' });
    const theirs = await make({ enrollmentId: E2, dueOn: '2026-10-20' });
    await repo((r) => r.end(ended.id, new Date('2026-10-12T10:00:00Z')));
    await repo((r) => r.addWords(far.id, [glossIds[2], glossIds[0], glossIds[1]]));
    await repo((r) => r.addWords(tomorrowA.id, [glossIds[1]]));
    for (const target of [dueToday, past, ended, theirs]) await repo((r) => r.addWords(target.id, [glossIds[3]]));

    const active = await repo((r) => r.listActive(E1, TODAY));

    expect(active.map((row) => row.id)).toEqual([dueToday.id, ...byId([tomorrowA, tomorrowB]).map((row) => row.id), far.id]);
    expect(active.find((row) => row.id === dueToday.id)).toEqual({ ...dueToday, glossIds: [glossIds[3]] });
    expect(active.find((row) => row.id === far.id)).toEqual({ ...far, glossIds: [glossIds[2], glossIds[0], glossIds[1]] });
    expect(active.find((row) => row.id === tomorrowA.id)).toEqual({ ...tomorrowA, glossIds: [glossIds[1]] });
    expect(active.find((row) => row.id === tomorrowB.id)).toEqual({ ...tomorrowB, glossIds: [] });
  });

  it('counts a target as active through the day it is due (phase 57, spec D10)', async () => {
    const target = await make({ dueOn: '2026-10-15' });
    expect((await repo((r) => r.listActive(E1, '2026-10-14'))).map((row) => row.id)).toEqual([target.id]);
    expect((await repo((r) => r.listActive(E1, '2026-10-15'))).map((row) => row.id)).toEqual([target.id]);
    expect(await repo((r) => r.listActive(E1, '2026-10-16'))).toEqual([]);
  });

  it('lists nothing for an enrollment without a target', async () => {
    await make({ enrollmentId: E2 });
    expect(await repo((r) => r.listActive(E1, TODAY))).toEqual([]);
  });
});

describe('words', () => {
  it('adds the glosses a target does not hold and answers only those, in the order given', async () => {
    const target = await make();
    const [g0, g1, g2] = glossIds;

    expect(await repo((r) => r.addWords(target.id, [g1, g0]))).toEqual([g1, g0]);
    // g0 and g1 are held, g2 is new and counted once despite being asked twice.
    expect(await repo((r) => r.addWords(target.id, [g0, g2, g2, g1]))).toEqual([g2]);
    expect(await repo((r) => r.addWords(target.id, [g1]))).toEqual([]);
    expect(await repo((r) => r.addWords(target.id, []))).toEqual([]);
    // As added: a held word keeps its place, and a batch keeps the order it was given in.
    expect(await repo((r) => r.listWordIds(target.id))).toEqual([g1, g0, g2]);
  });

  it('lists the words of one target and no other', async () => {
    const [a, b] = [await make(), await make()];
    await repo((r) => r.addWords(a.id, [glossIds[0], glossIds[1]]));
    await repo((r) => r.addWords(b.id, [glossIds[2]]));
    expect(await repo((r) => r.listWordIds(a.id))).toEqual([glossIds[0], glossIds[1]]);
    expect(await repo((r) => r.listWordIds(b.id))).toEqual([glossIds[2]]);
    expect(await repo((r) => r.listWordIds('00000000-0000-0000-0000-000000000000'))).toEqual([]);
  });

  it('removes a word once, and answers whether it held it', async () => {
    const [a, b] = [await make(), await make()];
    await repo((r) => r.addWords(a.id, [glossIds[0], glossIds[1]]));
    await repo((r) => r.addWords(b.id, [glossIds[0]]));

    expect(await repo((r) => r.removeWord(a.id, glossIds[0]))).toBe(true);
    expect(await repo((r) => r.removeWord(a.id, glossIds[0]))).toBe(false);
    expect(await repo((r) => r.removeWord(a.id, glossIds[3]))).toBe(false);
    expect(await repo((r) => r.listWordIds(a.id))).toEqual([glossIds[1]]);
    expect(await repo((r) => r.listWordIds(b.id))).toEqual([glossIds[0]]);
  });

  it('takes a gloss out of every target of the enrollment, an ended or past one too, and answers which it left', async () => {
    const [g0, g1] = glossIds;
    const active = await make({ dueOn: '2026-10-20' });
    const later = await make({ kind: 'homework', dueOn: '2026-10-25' });
    const past = await make({ dueOn: '2026-10-05' });
    const ended = await make();
    const holdsOther = await make();
    const theirs = await make({ enrollmentId: E2 });
    await repo((r) => r.end(ended.id, new Date('2026-10-12T10:00:00Z')));
    for (const target of [active, later, past, ended, theirs]) await repo((r) => r.addWords(target.id, [g0]));
    await repo((r) => r.addWords(active.id, [g1]));
    await repo((r) => r.addWords(holdsOther.id, [g1]));

    const left = await repo((r) => r.removeGlossFromTargets(E1, g0));

    expect(left).toEqual([active.id, later.id, past.id, ended.id].sort());
    expect(await repo((r) => r.listWordIds(active.id))).toEqual([g1]);
    expect(await repo((r) => r.listWordIds(later.id))).toEqual([]);
    expect(await repo((r) => r.listWordIds(holdsOther.id))).toEqual([g1]);
    // Another enrollment's target keeps it: this one's learner unsaved it, not theirs.
    expect(await repo((r) => r.listWordIds(theirs.id))).toEqual([g0]);
    expect(await repo((r) => r.removeGlossFromTargets(E1, g0))).toEqual([]);
  });
});

describe('setDueOn and end', () => {
  it('moves the date and nothing else', async () => {
    const target = await make({ kind: 'homework', dueOn: '2026-10-20' });
    await repo((r) => r.setDueOn(target.id, '2026-10-27'));
    expect(await repo((r) => r.findTarget(target.id))).toEqual({ ...target, dueOn: '2026-10-27' });
  });

  it('ends a target once: the first call does and keeps its instant, a second changes nothing', async () => {
    const target = await make();
    const first = new Date('2026-10-12T10:00:00.000Z');

    expect(await repo((r) => r.end(target.id, first))).toBe(true);
    expect(await repo((r) => r.end(target.id, new Date('2026-10-13T10:00:00.000Z')))).toBe(false);

    const ended = await repo((r) => r.findTarget(target.id));
    expect(ended?.endedAt?.toISOString()).toBe(first.toISOString());
    expect(await repo((r) => r.end('00000000-0000-0000-0000-000000000000', first))).toBe(false);
  });
});

describe('listEndedUnrecorded', () => {
  const TODAY = '2026-10-14';
  const endedOnDate = (targetId: string): TargetEventInput => ({
    targetId,
    kind: 'ended_on_date',
    before: null,
    after: { due_on: '2026-10-01' },
    actorUserId: null,
    sessionId: null,
  });

  it('lists the targets whose date has passed that the log does not yet record, nearest date first', async () => {
    const dueToday = await make({ dueOn: TODAY });
    const past = await make({ dueOn: '2026-10-01' });
    const otherEvents = await make({ dueOn: '2026-10-03' });
    const recorded = await make({ dueOn: '2026-10-02' });
    const endedEarly = await make({ dueOn: '2026-10-04' });
    await make({ dueOn: '2026-10-15' });
    await make({ enrollmentId: E2, dueOn: '2026-10-01' });
    await repo((r) => r.end(endedEarly.id, new Date('2026-10-02T08:00:00Z')));
    await repo((r) => r.insertEvent(endedOnDate(recorded.id)));
    // Only the event that records the date counts: the others are other things that happened.
    for (const kind of ['created', 'words_added', 'ended_early'] as const) {
      await repo((r) => r.insertEvent({ targetId: otherEvents.id, kind, before: null, after: null, actorUserId: 'u_1', sessionId: null }));
    }

    const unrecorded = await repo((r) => r.listEndedUnrecorded(E1, TODAY));

    // Phase 57 (spec D10): due today, it is still active.
    expect(unrecorded).toEqual([past, otherEvents]);
    expect(dueToday.dueOn).toBe(TODAY);
  });

  it('lists a target from the day after it is due, and drops it once its ended_on_date event is written', async () => {
    const target = await make({ dueOn: '2026-10-01' });
    expect(await repo((r) => r.listEndedUnrecorded(E1, '2026-09-30'))).toEqual([]);
    expect(await repo((r) => r.listEndedUnrecorded(E1, '2026-10-01'))).toEqual([]);
    expect((await repo((r) => r.listEndedUnrecorded(E1, '2026-10-02'))).map((row) => row.id)).toEqual([target.id]);
    expect((await repo((r) => r.listEndedUnrecorded(E1, TODAY))).map((row) => row.id)).toEqual([target.id]);

    await repo((r) => r.insertEvent(endedOnDate(target.id)));

    expect(await repo((r) => r.listEndedUnrecorded(E1, TODAY))).toEqual([]);
  });
});

describe('insertEvent', () => {
  it('appends events with their before, after, actor and session, and stores a null as NULL', async () => {
    const target = await make();
    const sessionId = await stock();
    await repo((r) =>
      r.insertEvent({
        targetId: target.id,
        kind: 'created',
        before: null,
        after: { kind: 'exam', due_on: '2026-10-20', gloss_ids: [glossIds[0]] },
        actorUserId: 'u_1',
        sessionId: null,
      }),
    );
    await repo((r) =>
      r.insertEvent({
        targetId: target.id,
        kind: 'date_changed',
        before: { due_on: '2026-10-20' },
        after: { due_on: '2026-10-27' },
        actorUserId: 'u_1',
        sessionId: null,
      }),
    );
    await repo((r) =>
      r.insertEvent({ targetId: target.id, kind: 'ended_on_date', before: null, after: { due_on: '2026-10-27' }, actorUserId: null, sessionId }),
    );

    const rows = await t.db.execute<{
      kind: string;
      before: unknown;
      after: unknown;
      actor_user_id: string | null;
      session_id: string | null;
    }>(sql`
      select kind, "before", "after", actor_user_id, session_id
      from target_events where target_id = ${target.id} order by kind`);

    expect(rows.rows).toEqual([
      { kind: 'created', before: null, after: { kind: 'exam', due_on: '2026-10-20', gloss_ids: [glossIds[0]] }, actor_user_id: 'u_1', session_id: null },
      { kind: 'date_changed', before: { due_on: '2026-10-20' }, after: { due_on: '2026-10-27' }, actor_user_id: 'u_1', session_id: null },
      { kind: 'ended_on_date', before: null, after: { due_on: '2026-10-27' }, actor_user_id: null, session_id: sessionId },
    ]);
  });

  it('accepts every kind of event the log knows', async () => {
    const target = await make();
    const kinds = ['created', 'words_added', 'words_removed', 'date_changed', 'ended_early', 'ended_on_date'] as const;
    for (const kind of kinds) {
      await repo((r) => r.insertEvent({ targetId: target.id, kind, before: null, after: null, actorUserId: null, sessionId: null }));
    }
    expect(await count(sql`select count(*)::int as n from target_events where target_id = ${target.id}`)).toBe(kinds.length);
  });
});

// Phase 57 (spec D2, D9). The one row a target path's stock records.
describe("a target path's session row", () => {
  it('stores the row and reads back its cap and owed words for that session and target only', async () => {
    const [a, b] = [await make(), await make({ kind: 'homework' })];
    const first = await stock('u_1', a.id);
    const second = await stock('u_1', b.id);

    await repo((r) => r.insertSessionTarget(first, pathRow(a.id)));
    await repo((r) => r.insertSessionTarget(second, pathRow(b.id, { capHalves: 20, owedGlossIds: [], stepDowns: ['g_b|spelling'] })));

    expect(await repo((r) => r.findSessionTarget(first, a.id))).toEqual({ capHalves: 7, owedGlossIds: ['g_a', 'g_b'], pastBudget: false, stepDowns: [] });
    // Phase 68 (spec D6): the step-downs the stock asks.
    expect(await repo((r) => r.findSessionTarget(second, b.id))).toEqual({ capHalves: 20, owedGlossIds: [], pastBudget: false, stepDowns: ['g_b|spelling'] });
    expect(await repo((r) => r.findSessionTarget(first, b.id))).toBeUndefined();
    const stored = await t.db.execute(sql`
      select days_left, cap_halves, readiness_pct, ready_count, word_count, fsrs_ready_count, wish, slots, picked, reason
      from session_targets where session_id = ${first}`);
    expect(stored.rows).toEqual([
      { days_left: 5, cap_halves: 7, readiness_pct: 18, ready_count: 1, word_count: 8, fsrs_ready_count: 2, wish: null, slots: null, picked: null, reason: null },
    ]);
  });

  // Phase 65b (spec D2).
  it('finds the target whose stock was chosen past its budget, with its owed words, and no other', async () => {
    const a = await make();
    const b = await make();
    // Each a stock on its own target's path: one per path (ADR 0014).
    const past = await stock('u_1', a.id);
    const owedOnly = await stock('u_1', b.id);
    await repo((r) => r.insertSessionTarget(past, pathRow(a.id, { pastBudget: true, owedGlossIds: ['g_a'] })));
    await repo((r) => r.insertSessionTarget(owedOnly, pathRow(b.id)));

    expect(await repo((r) => r.findPastBudget(past, [b.id, a.id]))).toEqual({ targetId: a.id, owedGlossIds: ['g_a'] });
    expect(await repo((r) => r.findSessionTarget(past, a.id))).toEqual({ capHalves: 7, owedGlossIds: ['g_a'], pastBudget: true, stepDowns: [] });
    expect(await repo((r) => r.findPastBudget(owedOnly, [b.id]))).toBeUndefined();
    expect(await repo((r) => r.findPastBudget(past, [b.id]))).toBeUndefined();
    expect(await repo((r) => r.findPastBudget(past, []))).toBeUndefined();
    expect(await repo((r) => r.findPastBudget('nope', [a.id]))).toBeUndefined();
  });

  it('finds nothing for an unknown or malformed id, nor for a phase 53 split row, which recorded no cap', async () => {
    const target = await make();
    const sessionId = await stock();
    await t.db.execute(sql`
      insert into session_targets (session_id, target_id, wish, slots, picked, reason, days_left, ready_count, word_count)
      values (${sessionId}, ${target.id}, 10, 10, 2, 'not_ready', 5, 0, 3)`);
    expect(await repo((r) => r.findSessionTarget(sessionId, target.id))).toBeUndefined();
    expect(await repo((r) => r.findSessionTarget('00000000-0000-0000-0000-000000000000', target.id))).toBeUndefined();
    expect(await repo((r) => r.findSessionTarget('nope', target.id))).toBeUndefined();
    expect(await repo((r) => r.findSessionTarget(sessionId, 'nope'))).toBeUndefined();
  });
});

// Phase 57 (spec D6, ADR 0014).
describe('listWords and listHolding', () => {
  it("lists a target's words with when each joined and the day it started, in the order added", async () => {
    const target = await make();
    await repo((r) => r.addWords(target.id, [glossIds[1], glossIds[0]]));
    await repo((r) => r.markStarted(target.id, [glossIds[0]], '2026-10-12'));
    expect(await repo((r) => r.listWords(target.id))).toEqual([
      { glossId: glossIds[1], addedAt: expect.any(Date), startedOn: null },
      { glossId: glossIds[0], addedAt: expect.any(Date), startedOn: '2026-10-12' },
    ]);
  });

  it('answers the targets of the enrollment holding a gloss, ended ones too, sorted', async () => {
    const [a, b, c] = [await make(), await make({ dueOn: '2026-10-01' }), await make()];
    const theirs = await make({ enrollmentId: E2 });
    for (const target of [a, b, theirs]) await repo((r) => r.addWords(target.id, [glossIds[0]]));
    await repo((r) => r.addWords(c.id, [glossIds[1]]));
    expect(await repo((r) => r.listHolding(E1, glossIds[0]))).toEqual([a.id, b.id].sort());
    expect(await repo((r) => r.listHolding(E1, glossIds[2]))).toEqual([]);
  });
});
