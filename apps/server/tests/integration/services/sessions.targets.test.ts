import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import type { TargetKind } from '../../../src/domain/targets';
import { AccessDenied, SessionOpen, TargetClosed, TargetNotFound } from '../../../src/errors';
import type { SessionService } from '../../../src/services/sessions';
import type { TargetService } from '../../../src/services/targets';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stockJobKeys, stopTestBoss } from '../../support/jobs';
import { holdProgressLock, waitForBlockedQuery } from '../../support/locks';
import { insertGlossMemory } from '../../support/progressRows';
import { insertListSession, type AskedGloss } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, makeBot, seedUser } from '../../support/seedUser';
import { endTargetNow, readSessionTargets, readStockRow, readTargetEvents, seedTarget, setTargetWord } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 57 (spec D1, D2, D10, ADR 0014). Every session belongs to one path: the main path ("My
// words"), which asks saved words in no active target, or a target's, which asks its words
// only. Each path has its own stock and its own started session. A change to a target retires
// the stocks of its path and of the main path and asks for both; a target's stock chosen on an
// earlier day is replaced when the target's day changed. The learner is a bot, so the day is the
// profile's (ADR 0013) and moves only when a test moves it: a bot's every instant is its day, so
// a target and its words read as made today (ruling P4).

const E = enrollmentOf('u_1');
const DAY = '2030-01-08';
const NEXT_DAY = '2030-01-09';
const NO_DEVICES = { listening: false, speaking: false };
const LEMMAS = ['apple', 'bread', 'cheese', 'dates', 'eggs', 'flour'];
const HEBREW = ['תפוח', 'לחם', 'גבינה', 'תמרים', 'ביצים', 'קמח'];
/** NO_DEVICES' live skills. */
const LIVE = ['written_receptive', 'written_productive', 'spelling'];

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let service: SessionService;
let targets: TargetService;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
  await makeBot(t.db, 'u_1', DAY);
  logger = createFakeLogger();
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss });
  service = deps.sessions;
  targets = deps.targets;
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

/** Past the seed, six words saved, one gloss each, in LEMMAS' order. */
async function savedWords(): Promise<AskedGloss[]> {
  const seed = await service.createNextSession('u_1', E, NO_DEVICES);
  await service.skipSession('u_1', seed.sessionId);
  const words: AskedGloss[] = [];
  for (const [i, lemma] of LEMMAS.entries()) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [HEBREW[i]] });
    words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation: HEBREW[i] });
  }
  return words;
}

const ids = (words: readonly AskedGloss[]) => words.map((word) => word.glossId);
const sorted = (glossIds: readonly string[]) => [...glossIds].sort();

/** A target holding `glossIds`, set up directly: the targets service is not this test's. */
const addTarget = (kind: TargetKind, dueOn: string, glossIds: string[]) => seedTarget(t.db, { enrollmentId: E, kind, dueOn, glossIds });

/** The preparation `sessionId` was given. */
async function prepareOf(sessionId: string): Promise<PrepareSessionPayload> {
  const payloads = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
  return payloads.find((payload) => payload.session_id === sessionId)!;
}
const picksOf = async (sessionId: string) => (await prepareOf(sessionId)).picks.map((pick) => pick.gloss_id);

const stockJobs = () => stockJobKeys(t.db);

const logged = (event: string) => logger.events.filter((entry) => entry.event === event);

describe('a path per target (spec D1, D2)', () => {
  it("gives a target's path and the main path a stock each, each asking its own words, the target's recording its day", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));

    const main = await service.createNextSession('u_1', E, NO_DEVICES);
    const own = await service.createNextSession('u_1', E, NO_DEVICES, exam);

    expect(main).toMatchObject({ status: 'preparing', source: 'list', created: true });
    expect(own).toMatchObject({ status: 'preparing', source: 'list', created: true });
    expect(await readStockRow(t.db, main.sessionId)).toEqual({ status: 'preparing', practiceDay: null, chosenOn: DAY, targetId: null });
    expect(await readStockRow(t.db, own.sessionId)).toEqual({ status: 'preparing', practiceDay: null, chosenOn: DAY, targetId: exam });
    // The main path asks none of the exam's words; the exam's path asks only its own.
    expect(ids(words.slice(3))).toEqual(expect.arrayContaining(await picksOf(main.sessionId)));
    expect((await picksOf(main.sessionId)).length).toBeGreaterThan(0);
    // Five days left of five: the plan meets one word of three today (spec D6), its ladder.
    const first = sorted(ids(words.slice(0, 3)))[0];
    expect(await prepareOf(own.sessionId)).toMatchObject({ target: true, picks: [{ gloss_id: first, ladder: true }] });
    expect((await prepareOf(main.sessionId)).target).toBeUndefined();
    expect(await readSessionTargets(t.db, own.sessionId)).toEqual([
      {
        targetId: exam,
        daysLeft: 5,
        capHalves: 7,
        readinessPct: 0,
        readyCount: 0,
        wordCount: 3,
        fsrsReadyCount: 0,
        owedGlossIds: [first],
        wish: null,
        slots: null,
        picked: null,
        reason: null,
      },
    ]);
    expect(await readSessionTargets(t.db, main.sessionId)).toEqual([]);
    // Each path's stock is answered as it is.
    expect(await service.createNextSession('u_1', E, NO_DEVICES)).toMatchObject({ sessionId: main.sessionId, created: false });
    expect(await service.createNextSession('u_1', E, NO_DEVICES, exam)).toMatchObject({ sessionId: own.sessionId, created: false });
    expect(logged('session_stocked')).toEqual([
      { event: 'session_stocked', enrollment_id: E, session_id: main.sessionId, reason: 'create' },
      { event: 'session_stocked', enrollment_id: E, session_id: own.sessionId, reason: 'create', target_id: exam },
    ]);
  });

  it('starts one session per path: session_open only within a path', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const main = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [words[3]], types: ['multiple_choice'] });
    const own = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [words[0]], types: ['multiple_choice'], targetId: exam });

    await service.startSession('u_1', main.sessionId, NO_DEVICES);
    await service.startSession('u_1', own.sessionId, NO_DEVICES);

    expect((await service.currentSession('u_1', E)).current?.id).toBe(main.sessionId);
    expect((await service.currentSession('u_1', E, exam)).current?.id).toBe(own.sessionId);
    const second = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [words[1]], types: ['multiple_choice'], targetId: exam });
    await expect(service.startSession('u_1', second.sessionId, NO_DEVICES)).rejects.toBeInstanceOf(SessionOpen);
    await expect(service.createNextSession('u_1', E, NO_DEVICES, exam)).rejects.toBeInstanceOf(SessionOpen);
    await expect(service.createNextSession('u_1', E, NO_DEVICES)).rejects.toBeInstanceOf(SessionOpen);
  });

  it("asks for the next stock of a started session's path only, which builds beside it", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const own = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [words[0]], types: ['multiple_choice'], targetId: exam });

    await service.startSession('u_1', own.sessionId, { listening: true, speaking: false });

    const jobs = await stockJobs();
    expect(jobs).toEqual([
      { key: `${E}:${exam}`, data: { enrollment_id: E, reason: 'start', listening: true, speaking: false, target_id: exam } },
    ]);
    await service.stockSession(jobs[0].data);
    const { current } = await service.currentSession('u_1', E, exam);
    expect(current?.id).toBe(own.sessionId);
    const [stock] = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
    expect(await readStockRow(t.db, stock.session_id)).toMatchObject({ status: 'preparing', targetId: exam });
    expect(ids(words.slice(0, 3))).toEqual(expect.arrayContaining(stock.picks.map((pick) => pick.gloss_id)));
    // The main path was not asked for, and has none.
    expect((await service.currentSession('u_1', E)).current).toBeNull();
  });

  it('refuses a target that is not one of the enrollment\'s: unknown, malformed or another learner\'s', async () => {
    await savedWords();
    await seedUser(t.db, 'u_2');
    const [theirWord] = (await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_2'), lemma: 'grape', translations: ['ענב'] })).glossIds;
    const theirs = await seedTarget(t.db, { enrollmentId: enrollmentOf('u_2'), kind: 'exam', dueOn: '2030-01-13', glossIds: [theirWord] });

    for (const path of ['00000000-0000-0000-0000-000000000000', 'nope']) {
      await expect(service.createNextSession('u_1', E, NO_DEVICES, path)).rejects.toBeInstanceOf(TargetNotFound);
      await expect(service.currentSession('u_1', E, path)).rejects.toBeInstanceOf(TargetNotFound);
    }
    await expect(service.createNextSession('u_1', E, NO_DEVICES, theirs)).rejects.toBeInstanceOf(AccessDenied);
    await expect(service.currentSession('u_1', E, theirs)).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe('the main path asks no active target\'s words (spec D1)', () => {
  it('and asks them again once the target is ended: the change retires its stock and asks for the next', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-20', ids(words.slice(0, 5)));
    const before = await service.createNextSession('u_1', E, NO_DEVICES);
    expect(await picksOf(before.sessionId)).toEqual([words[5].glossId]);

    await targets.end('u_1', exam);

    expect((await readStockRow(t.db, before.sessionId)).status).toBe('skipped');
    const main = (await stockJobs()).find((job) => job.key === E)!;
    await service.stockSession(main.data);
    const { current } = await service.currentSession('u_1', E);
    // Newest saved first, as ever (phase 35 D5): the exam's last word is back.
    expect(await picksOf(current!.id)).toContain(words[4].glossId);
  });
});

describe("a target's date (spec D10, ruling P2)", () => {
  it('keeps it active through its due date, and ends it the day after: the next main stock records it', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', NEXT_DAY, ids(words.slice(0, 5)));
    const first = await service.createNextSession('u_1', E, NO_DEVICES);
    expect(await picksOf(first.sessionId)).toEqual([words[5].glossId]);

    // The due date: still active, so the main path still leaves its words, and its path builds.
    await makeBot(t.db, 'u_1', NEXT_DAY);
    await service.skipSession('u_1', first.sessionId);
    const onDate = await service.createNextSession('u_1', E, NO_DEVICES);
    expect(await picksOf(onDate.sessionId)).toEqual([words[5].glossId]);
    const lastReview = await service.createNextSession('u_1', E, NO_DEVICES, exam);
    expect(await readSessionTargets(t.db, lastReview.sessionId)).toMatchObject([{ targetId: exam, daysLeft: 0, capHalves: 20 }]);
    expect(await readTargetEvents(t.db, exam)).toEqual([]);

    // The day after: closed to its path, and back on the main path.
    await makeBot(t.db, 'u_1', '2030-01-10');
    await expect(service.createNextSession('u_1', E, NO_DEVICES, exam)).rejects.toBeInstanceOf(TargetClosed);
    await service.skipSession('u_1', onDate.sessionId);
    const after = await service.createNextSession('u_1', E, NO_DEVICES);
    expect(await picksOf(after.sessionId)).toContain(words[4].glossId);
    expect(await readTargetEvents(t.db, exam)).toEqual([
      { kind: 'ended_on_date', before: null, after: { due_on: NEXT_DAY }, actorUserId: null, sessionId: after.sessionId },
    ]);
    // Its path is off home: the stock left on it is retired.
    expect((await readStockRow(t.db, lastReview.sessionId)).status).toBe('skipped');
    expect(logged('target_ended')).toEqual([{ event: 'target_ended', target_id: exam, how: 'on_date' }]);
    expect(logged('session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: E, session_id: lastReview.sessionId, reason: 'target_ended' },
    ]);
  });
});

describe('a change to a target (spec D2, ruling R-D12b)', () => {
  it("retires its path's stock and the main path's, and asks for both", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const main = await service.createNextSession('u_1', E, NO_DEVICES);
    const own = await service.createNextSession('u_1', E, NO_DEVICES, exam);

    await targets.changeDate('u_1', exam, { due_on: '2030-01-20' });

    expect((await readStockRow(t.db, main.sessionId)).status).toBe('skipped');
    expect((await readStockRow(t.db, own.sessionId)).status).toBe('skipped');
    expect(await stockJobs()).toEqual(
      expect.arrayContaining([
        { key: E, data: { enrollment_id: E, reason: 'target' } },
        { key: `${E}:${exam}`, data: { enrollment_id: E, reason: 'target', target_id: exam } },
      ]),
    );
    expect(await stockJobs()).toHaveLength(2);
    expect(logged('session_retired')).toEqual(
      expect.arrayContaining([
        { event: 'session_retired', enrollment_id: E, session_id: main.sessionId, reason: 'target_changed' },
        { event: 'session_retired', enrollment_id: E, session_id: own.sessionId, reason: 'target_changed' },
      ]),
    );
  });

  it('takes a word out of a target only once a session end holding the progress lock is done (ruling T4-k)', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const held = holdProgressLock(t.db, E);
    await held.ready;

    const removal = targets.removeWord('u_1', exam, words[0].glossId);
    try {
      await waitForBlockedQuery(t.db);
    } finally {
      held.release();
      await held.done;
    }
    await removal;

    expect(await readTargetEvents(t.db, exam)).toEqual([
      { kind: 'words_removed', before: { gloss_ids: [words[0].glossId] }, after: { reason: 'removed' }, actorUserId: 'u_1', sessionId: null },
    ]);
  });
});

describe("a target's stock chosen on an earlier day (spec D2, phase 53 R4 per path)", () => {
  it("is replaced on the home read when today's cap is another", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const { sessionId: stale } = await service.createNextSession('u_1', E, NO_DEVICES, exam);

    // Four days left: the cap rises from 7 to 8 half-points.
    await makeBot(t.db, 'u_1', NEXT_DAY);
    const { current } = await service.currentSession('u_1', E, exam);

    const fresh = current!.id;
    expect(fresh).not.toBe(stale);
    expect(await readStockRow(t.db, stale)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: DAY, targetId: exam });
    expect(await readStockRow(t.db, fresh)).toEqual({ status: 'preparing', practiceDay: null, chosenOn: NEXT_DAY, targetId: exam });
    expect(await readSessionTargets(t.db, fresh)).toMatchObject([{ daysLeft: 4, capHalves: 8 }]);
    expect(logged('session_retired')).toEqual([{ event: 'session_retired', enrollment_id: E, session_id: stale, reason: 'stale_target' }]);
    // Chosen today, the new stock is the one the next home read offers.
    expect((await service.currentSession('u_1', E, exam)).current?.id).toBe(fresh);
  });

  it('is replaced when today owes other words at the same cap', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-20', ids(words.slice(0, 3)));
    const { sessionId: stale } = await service.createNextSession('u_1', E, NO_DEVICES, exam);
    const [a, b] = sorted(ids(words.slice(0, 3)));
    expect(await readSessionTargets(t.db, stale)).toMatchObject([{ capHalves: 5, owedGlossIds: [a, b] }]);

    // `a` was started two days before, and is at the cap in every live skill: done today.
    await setTargetWord(t.db, { targetId: exam, glossId: a, startedOn: '2030-01-07', halves: Object.fromEntries(LIVE.map((d) => [d, 5])) });
    await makeBot(t.db, 'u_1', NEXT_DAY);
    const { current } = await service.currentSession('u_1', E, exam);

    expect(current!.id).not.toBe(stale);
    expect(await readSessionTargets(t.db, current!.id)).toMatchObject([{ capHalves: 5, owedGlossIds: [b] }]);
    expect(await picksOf(current!.id)).toEqual([b]);
  });

  it('is played as it is when its cap and owed words are the same (phase 43 R5)', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-20', ids(words.slice(0, 3)));
    const { sessionId: stock } = await service.createNextSession('u_1', E, NO_DEVICES, exam);

    await makeBot(t.db, 'u_1', NEXT_DAY);

    expect((await service.currentSession('u_1', E, exam)).current?.id).toBe(stock);
    expect(await service.createNextSession('u_1', E, NO_DEVICES, exam)).toMatchObject({ sessionId: stock, created: false });
    expect(await readStockRow(t.db, stock)).toMatchObject({ status: 'preparing', chosenOn: DAY });
    expect(await jobPayloads(t.db, PREPARE_SESSION)).toHaveLength(1);
    expect(logged('session_retired')).toEqual([]);
  });

  it("is never replaced on the main path, whose stock is played as it is (phase 43 R5)", async () => {
    const words = await savedWords();
    await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const { sessionId: stock } = await service.createNextSession('u_1', E, NO_DEVICES);

    await makeBot(t.db, 'u_1', NEXT_DAY);

    expect((await service.currentSession('u_1', E)).current?.id).toBe(stock);
    expect(logged('session_retired')).toEqual([]);
  });
});

describe('the home read of a path (spec D11)', () => {
  it("answers the main path as before without a target, with its words due, and a target's with its words owed", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    // Recall long faded in written receptive: due. One main-path word and one of the exam's.
    const faded = (glossId: string) => ({
      enrollmentId: E,
      glossId,
      dimension: 'written_receptive',
      stability: 1,
      difficulty: 5,
      lastDay: '2029-12-01',
      reps: 1,
      lapses: 0,
      params: 'fsrs6-default',
    });
    await insertGlossMemory(t.db, [faded(words[0].glossId), faded(words[3].glossId)]);

    expect(await service.currentSession('u_1', E)).toEqual({ current: null, nextSource: 'list', savedCount: 6, dueCount: 1 });
    // Five days of five: one word of three owed today.
    expect(await service.currentSession('u_1', E, exam)).toEqual({ current: null, nextSource: 'list', savedCount: 6, dueCount: 1 });

    await endTargetNow(t.db, exam);
    expect((await service.currentSession('u_1', E)).dueCount).toBe(2);
    expect((await service.currentSession('u_1', E, exam)).dueCount).toBe(0);
  });
});
