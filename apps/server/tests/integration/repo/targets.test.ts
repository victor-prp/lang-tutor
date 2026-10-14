import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql, type SQL } from 'drizzle-orm';

import type { TargetSplit } from '../../../src/domain/targetSession';
import type { ShareReason, TargetKind } from '../../../src/domain/targets';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createTargetRepo, type TargetEventInput, type TargetRepo } from '../../../src/repo/targets';
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

/** An unstarted list session in stock for u_1, or for u_2 (the unique index allows one per enrollment). */
const stock = (userId: 'u_1' | 'u_2' = 'u_1') =>
  withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession(userId, enrollmentOf(userId), NO_DEVICES, CHOSEN_ON));

const count = async (query: SQL) => (await t.db.execute<{ n: number }>(query)).rows[0].n;

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

const split = (targetId: string, over: Partial<TargetSplit> = {}): TargetSplit => ({
  targetId,
  wish: 10,
  slots: 10,
  picked: 10,
  reason: 'not_ready',
  daysLeft: 5,
  readyCount: 2,
  wordCount: 8,
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

  it('refuses a reason it does not know, and a split for a session or a target that is not there', async () => {
    const target = await make();
    const sessionId = await stock();
    await expect(repo((r) => r.insertSessionSplit(sessionId, [split(target.id, { reason: 'bored' as ShareReason })]))).rejects.toEqual(
      violating('session_targets_reason_known'),
    );
    await expect(
      repo((r) => r.insertSessionSplit('00000000-0000-0000-0000-000000000000', [split(target.id)])),
    ).rejects.toEqual(violating('session_targets_session_fk'));
    await expect(
      repo((r) => r.insertSessionSplit(sessionId, [split('00000000-0000-0000-0000-000000000000')])),
    ).rejects.toEqual(violating('session_targets_target_fk'));
  });

  // A target is handed the slots the main path could not use in a second pass, so it can
  // pick more than the slots it was given: nothing ties the two.
  it('lets a target pick more words than the slots it was given', async () => {
    const target = await make();
    const sessionId = await stock();
    await repo((r) => r.insertSessionSplit(sessionId, [split(target.id, { slots: 3, picked: 7 })]));
    expect(await repo((r) => r.findSessionSplit(sessionId))).toEqual([split(target.id, { slots: 3, picked: 7 })]);
  });

  it("takes a target's words, log and split with it", async () => {
    const target = await make();
    const sessionId = await stock();
    await repo((r) => r.addWords(target.id, glossIds));
    await repo((r) => r.insertEvent({ targetId: target.id, kind: 'created', before: null, after: null, actorUserId: 'u_1', sessionId: null }));
    await repo((r) => r.insertSessionSplit(sessionId, [split(target.id)]));

    await t.db.execute(sql`delete from targets where id = ${target.id}`);

    expect(await count(sql`select count(*)::int as n from target_words`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from target_events`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from session_targets`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from sessions where id = ${sessionId}`)).toBe(1);
  });

  it("takes a session's split with it, and leaves the target", async () => {
    const target = await make();
    const sessionId = await stock();
    await repo((r) => r.insertSessionSplit(sessionId, [split(target.id)]));

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

  it('lists what is due after today and not ended, nearest date first and then by id, with the words in the order added', async () => {
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

    expect(active.map((row) => row.id)).toEqual([...byId([tomorrowA, tomorrowB]).map((row) => row.id), far.id]);
    expect(active.find((row) => row.id === far.id)).toEqual({ ...far, glossIds: [glossIds[2], glossIds[0], glossIds[1]] });
    expect(active.find((row) => row.id === tomorrowA.id)).toEqual({ ...tomorrowA, glossIds: [glossIds[1]] });
    expect(active.find((row) => row.id === tomorrowB.id)).toEqual({ ...tomorrowB, glossIds: [] });
  });

  it('counts a target as active until the day it is due', async () => {
    const target = await make({ dueOn: '2026-10-15' });
    expect((await repo((r) => r.listActive(E1, '2026-10-14'))).map((row) => row.id)).toEqual([target.id]);
    expect(await repo((r) => r.listActive(E1, '2026-10-15'))).toEqual([]);
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

  it('lists the targets whose date has come that the log does not yet record, nearest date first', async () => {
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

    expect(unrecorded).toEqual([past, otherEvents, dueToday]);
  });

  it('lists a target from the day it is due, and drops it once its ended_on_date event is written', async () => {
    const target = await make({ dueOn: '2026-10-01' });
    expect(await repo((r) => r.listEndedUnrecorded(E1, '2026-09-30'))).toEqual([]);
    expect((await repo((r) => r.listEndedUnrecorded(E1, '2026-10-01'))).map((row) => row.id)).toEqual([target.id]);
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

describe('the session split', () => {
  it("stores one row per target a session served and reads them back by target id, with nothing for another session's", async () => {
    const [a, b, c, d] = [await make(), await make({ kind: 'homework' }), await make(), await make()];
    const theirs = await make({ enrollmentId: E2 });
    const sessionId = await stock();
    const otherSession = await stock('u_2');
    const rows = [
      split(a.id, { reason: 'exclusive', wish: 10, slots: 10, picked: 10, daysLeft: 1 }),
      split(b.id, { reason: 'run_up', slots: 0, picked: 0 }),
      split(c.id, { reason: 'not_ready', slots: 4, picked: 5 }),
      split(d.id, { reason: 'steady', wish: 3, slots: 3, picked: 2, readyCount: 8, wordCount: 8 }),
    ];

    await repo((r) => r.insertSessionSplit(sessionId, rows));
    await repo((r) => r.insertSessionSplit(otherSession, [split(theirs.id, { slots: 1, picked: 1 })]));

    const found = await repo((r) => r.findSessionSplit(sessionId));
    expect(found).toEqual([...rows].sort((x, y) => (x.targetId < y.targetId ? -1 : 1)));
    expect(await repo((r) => r.findSessionSplit(otherSession))).toEqual([split(theirs.id, { slots: 1, picked: 1 })]);
  });

  it('writes nothing for a session that served no target, and finds nothing for one, for an unknown id or a malformed one', async () => {
    const sessionId = await stock();
    await repo((r) => r.insertSessionSplit(sessionId, []));
    expect(await count(sql`select count(*)::int as n from session_targets`)).toBe(0);
    expect(await repo((r) => r.findSessionSplit(sessionId))).toEqual([]);
    expect(await repo((r) => r.findSessionSplit('00000000-0000-0000-0000-000000000000'))).toEqual([]);
    expect(await repo((r) => r.findSessionSplit('nope'))).toEqual([]);
  });

  it('refuses a target twice in one session', async () => {
    const target = await make();
    const sessionId = await stock();
    await expect(repo((r) => r.insertSessionSplit(sessionId, [split(target.id), split(target.id)]))).rejects.toEqual(
      violating('session_targets_pkey'),
    );
  });
});
