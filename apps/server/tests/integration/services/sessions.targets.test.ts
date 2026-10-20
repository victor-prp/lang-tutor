import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import type { TargetKind } from '../../../src/domain/targets';
import { AccessDenied, SessionOpen, TargetClosed, TargetNotFound } from '../../../src/errors';
import type { SessionService } from '../../../src/services/sessions';
import type { TargetService } from '../../../src/services/targets';
import type { VocabularyService } from '../../../src/services/vocabulary';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stockJobKeys, stopTestBoss } from '../../support/jobs';
import { holdProgressLock, holdSessionEnd, holdSessionRowEnd, waitForBlockedQuery } from '../../support/locks';
import { insertGlossMemory, moveAnswersBack, readLearnerDay, readMemory, setLevel } from '../../support/progressRows';
import { asChoice, insertListSession, type AskedGloss } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, makeBot, seedUser, setTimeZone } from '../../support/seedUser';
import { endTargetNow, markPastBudget, readSessionTargets, readStartedOn, readStockRow, readTargetBudgets, readTargetEvents, readFirstReadinessEvents, readTargetReadiness, readTargetReadinessEvents, readTargetSkills, seedTarget, setTargetReadiness, setTargetWord } from '../../support/targetRows';
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
const PREVIOUS_DAY = '2030-01-07';
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
let vocabulary: VocabularyService;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
  await makeBot(t.db, 'u_1', DAY);
  logger = createFakeLogger();
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss });
  service = deps.sessions;
  targets = deps.targets;
  vocabulary = deps.vocabulary;
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

  it("starts a known word's new meaning with its new_meaning card, no ladder (phase 60, spec D1)", async () => {
    await savedWords();
    const [lift, collect] = (await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'pick up', translations: ['להרים', 'לאסוף'] })).glossIds;
    // Lift known in every live skill: collect is the family's new meaning, never asked.
    await insertGlossMemory(
      t.db,
      LIVE.map((dimension) => ({
        enrollmentId: E,
        glossId: lift,
        dimension,
        stability: 8,
        difficulty: 5,
        lastDay: '2030-01-05',
        reps: 2,
        lapses: 0,
        params: 'fsrs6-default',
      })),
    );
    const exam = await addTarget('exam', '2030-01-13', [collect]);

    const own = await service.createNextSession('u_1', E, NO_DEVICES, exam);
    expect((await prepareOf(own.sessionId)).picks).toEqual([
      expect.objectContaining({ gloss_id: collect, ladder: false, known_meanings: ['להרים'] }),
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

// Final review N1. A session entered and left before any answer is started with none: both home
// reads say so, so the app resumes it rather than send a create that answers session_open.
describe('a target session started with no answer (final review N1)', () => {
  it('reads started on the home read and on the targets list, and create refuses it while it is open', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const own = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [words[0]], types: ['multiple_choice'], targetId: exam });
    // In stock, not started. (The home read would check it: it records no day of its target.)
    expect((await targets.getTarget('u_1', exam)).session).toMatchObject({ session_id: own.sessionId, answered: 0, started: false });

    await service.startSession('u_1', own.sessionId, NO_DEVICES);

    expect((await service.currentSession('u_1', E, exam)).current).toMatchObject({ id: own.sessionId, answered: 0, started: true });
    expect((await targets.getTarget('u_1', exam)).session).toMatchObject({ session_id: own.sessionId, answered: 0, started: true });
    expect((await service.currentSession('u_1', E)).current).toBeNull();
    await expect(service.createNextSession('u_1', E, NO_DEVICES, exam)).rejects.toBeInstanceOf(SessionOpen);
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

// ADR 0014 R4. A session end holds the progress lock, then enqueues its path's stock under the
// path's singleton key. A removal that enqueued under that key before waiting for the lock would
// hold the uncommitted row the end's stately insert waits on: a deadlock (40P01).
describe('a removal beside a session end (ADR 0014 R4)', () => {
  it.each<[string, (words: AskedGloss[], exam: string) => Promise<unknown>, 'target' | 'words_removed']>([
    ['removeWord', (words, exam) => targets.removeWord('u_1', exam, words[0].glossId), 'target'],
    ['unsave', (words) => vocabulary.unsave('u_1', E, words[0].glossId), 'target'],
    // Phase 58 (ruling M1). Every saved word is new, so the level is all six, the exam's three among them.
    ['removeWords of a level', () => vocabulary.removeWords('u_1', E, { level: 1 }), 'words_removed'],
    // Phase 58b (ruling M2). Every word, the exam's three among them.
    ['removeWords of all', () => vocabulary.removeWords('u_1', E, { all: true }), 'words_removed'],
  ])('%s asks for the stocks only after the progress lock, so both commit', async (_, remove, reason) => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const ending = holdSessionEnd(t.db, boss, E);
    await ending.ready;

    const removal = remove(words, exam);
    try {
      await waitForBlockedQuery(t.db);
    } finally {
      ending.finish();
    }
    await expect(Promise.all([ending.done, removal])).resolves.toBeDefined();

    expect((await readTargetEvents(t.db, exam)).map((event) => event.kind)).toEqual(['words_removed']);
    expect(await stockJobs()).toEqual([
      { key: E, data: { enrollment_id: E, reason: 'complete' } },
      { key: `${E}:${exam}`, data: { enrollment_id: E, reason, target_id: exam } },
    ]);
  });
});

// Re-review N2 (ADR 0014 R4). Two targets ended on their date at once: the main path's stock
// that records both closes both started sessions before it takes the progress lock. An end of the
// second session that holds its row and then waits for that lock lets both commit; were the first
// session's progress recorded before the second's row, each would wait on the other (40P01).
describe('targets ended on their date at once (re-review N2, ADR 0014 R4)', () => {
  it("closes every ended path's started session before the progress lock, beside an end of one of them", async () => {
    const words = await savedWords();
    const first = await addTarget('exam', DAY, [words[0].glossId]);
    const second = await addTarget('exam', DAY, [words[1].glossId]);
    // The ended targets are read by date, then id: `later` is the one whose session is closed second.
    const [one, later] = [first, second].sort();
    const started: Record<string, string> = {};
    for (const [exam, word] of [[first, words[0]], [second, words[1]]] as const) {
      const own = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [word], types: ['multiple_choice'], targetId: exam });
      await service.startSession('u_1', own.sessionId, NO_DEVICES);
      started[exam] = own.sessionId;
    }
    await makeBot(t.db, 'u_1', NEXT_DAY);
    const ending = holdSessionRowEnd(t.db, started[later], E);
    await ending.ready;

    const main = service.createNextSession('u_1', E, NO_DEVICES);
    try {
      await waitForBlockedQuery(t.db);
    } finally {
      ending.finish();
    }
    await expect(Promise.all([ending.done, main])).resolves.toBeDefined();

    for (const exam of [one, later]) {
      expect((await readStockRow(t.db, started[exam])).status).toBe('skipped');
      expect((await readTargetEvents(t.db, exam)).map((event) => event.kind)).toEqual(['ended_on_date']);
    }
  });
});

// Final review I1. A target's end skips its path's started session, which takes the progress
// lock: it asks for the stocks only after it, as a removal does, or a session end holding that
// lock and enqueueing under the main path's key would wait on the end's uncommitted request.
describe("a target's end beside a session end (ADR 0014 R4, final review I1)", () => {
  it("skips its path's started session only after the progress lock, and asks for the stocks after it, so both commit", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const own = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [words[0]], types: ['multiple_choice'], targetId: exam });
    await service.startSession('u_1', own.sessionId, NO_DEVICES);
    const ending = holdSessionEnd(t.db, boss, E);
    await ending.ready;

    const end = targets.end('u_1', exam);
    try {
      await waitForBlockedQuery(t.db);
    } finally {
      ending.finish();
    }
    await expect(Promise.all([ending.done, end])).resolves.toBeDefined();

    expect((await readStockRow(t.db, own.sessionId)).status).toBe('skipped');
    expect((await readTargetEvents(t.db, exam)).map((event) => event.kind)).toEqual(['ended_early']);
    expect((await stockJobs()).map((job) => job.key).sort()).toEqual([E, `${E}:${exam}`].sort());
  });
});

// Phase 58 meets phase 57 (ruling M1). Removing a level is an unsave of every word at it, by
// path: the main path's stock and the stock of each active target that held a removed word go,
// and the next of each is asked for; a target that held none keeps its stock. Phase 58b (ruling
// M2): removing every word is the same removal.
describe('removing a level, or every word (phase 58, ruling M1; 58b, ruling M2)', () => {
  it("retires the main path's stock and the stock of the target holding a removed word, and asks for both", async () => {
    const words = await savedWords();
    // apple, eggs and flour stay new (level 1); bread, cheese and dates are lifted to 2.
    for (const word of [words[1], words[2], words[3]]) await setLevel(t.db, { enrollmentId: E, glossId: word.glossId, level: 2 });
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 2)));
    const homework = await addTarget('homework', '2030-01-13', ids(words.slice(2, 4)));
    const main = await service.createNextSession('u_1', E, NO_DEVICES);
    const examStock = await service.createNextSession('u_1', E, NO_DEVICES, exam);
    const homeworkStock = await service.createNextSession('u_1', E, NO_DEVICES, homework);
    expect([main.status, examStock.status, homeworkStock.status]).toEqual(['preparing', 'preparing', 'preparing']);

    expect(await vocabulary.removeWords('u_1', E, { level: 1 })).toEqual({ removed_words: 3, removed_glosses: 3 });

    expect(await readStockRow(t.db, main.sessionId)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: DAY, targetId: null });
    expect(await readStockRow(t.db, examStock.sessionId)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: DAY, targetId: exam });
    expect((await readStockRow(t.db, homeworkStock.sessionId)).status).toBe('preparing');
    expect(await stockJobs()).toEqual([
      { key: E, data: { enrollment_id: E, reason: 'words_removed' } },
      { key: `${E}:${exam}`, data: { enrollment_id: E, reason: 'words_removed', target_id: exam } },
    ]);
    expect(logged('session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: E, session_id: main.sessionId, reason: 'words_removed' },
      { event: 'session_retired', enrollment_id: E, session_id: examStock.sessionId, reason: 'words_removed' },
    ]);
    expect(await readTargetEvents(t.db, exam)).toEqual([
      { kind: 'words_removed', before: { gloss_ids: [words[0].glossId] }, after: { reason: 'unsaved' }, actorUserId: 'u_1', sessionId: null },
    ]);
    expect(await readTargetEvents(t.db, homework)).toEqual([]);
  });

  // Phase 58b (ruling M2). Every word is the same removal by path: the main path's stock and
  // the stock of every target that held a word go, and the next of each is asked for. Every
  // saved word goes, so an active target holding none is an empty one, which has no stock to
  // keep (NoSavedWords): it is neither retired nor restocked. The paths that keep their stocks
  // are another learner's.
  it("on all, retires the main path's stock and each holding target's, and leaves the rest alone", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 2)));
    const homework = await addTarget('homework', '2030-01-13', []);
    const main = await service.createNextSession('u_1', E, NO_DEVICES);
    const examStock = await service.createNextSession('u_1', E, NO_DEVICES, exam);
    // Another learner: a main path and a target path, each with its stock.
    const OTHER = enrollmentOf('u_2');
    await seedUser(t.db, 'u_2');
    await makeBot(t.db, 'u_2', DAY);
    await service.skipSession('u_2', (await service.createNextSession('u_2', OTHER, NO_DEVICES)).sessionId);
    const theirs = [];
    for (const [lemma, hebrew] of [['grapes', 'ענבים'], ['honey', 'דבש'], ['jam', 'ריבה']]) {
      theirs.push((await seedSavedSenses(t.db, { enrollmentId: OTHER, lemma, translations: [hebrew] })).glossIds[0]);
    }
    const otherExam = await seedTarget(t.db, { enrollmentId: OTHER, kind: 'exam', dueOn: '2030-01-13', glossIds: theirs.slice(0, 2) });
    const otherMain = await service.createNextSession('u_2', OTHER, NO_DEVICES);
    const otherExamStock = await service.createNextSession('u_2', OTHER, NO_DEVICES, otherExam);
    expect([main.status, examStock.status, otherMain.status, otherExamStock.status]).toEqual(['preparing', 'preparing', 'preparing', 'preparing']);
    const before = await stockJobs();

    expect(await vocabulary.removeWords('u_1', E, { all: true })).toEqual({ removed_words: 6, removed_glosses: 6 });

    expect(await readStockRow(t.db, main.sessionId)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: DAY, targetId: null });
    expect(await readStockRow(t.db, examStock.sessionId)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: DAY, targetId: exam });
    expect((await readStockRow(t.db, otherMain.sessionId)).status).toBe('preparing');
    expect((await readStockRow(t.db, otherExamStock.sessionId)).status).toBe('preparing');
    expect(before).toEqual([]);
    expect(await stockJobs()).toEqual([
      { key: E, data: { enrollment_id: E, reason: 'words_removed' } },
      { key: `${E}:${exam}`, data: { enrollment_id: E, reason: 'words_removed', target_id: exam } },
    ]);
    expect(logged('session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: E, session_id: main.sessionId, reason: 'words_removed' },
      { event: 'session_retired', enrollment_id: E, session_id: examStock.sessionId, reason: 'words_removed' },
    ]);
    expect(await readTargetEvents(t.db, exam)).toEqual([
      { kind: 'words_removed', before: { gloss_ids: sorted(ids(words.slice(0, 2))) }, after: { reason: 'unsaved' }, actorUserId: 'u_1', sessionId: null },
    ]);
    expect(await readTargetEvents(t.db, homework)).toEqual([]);
    expect(await readTargetEvents(t.db, otherExam)).toEqual([]);
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
    // Phase 67 (spec D3): twelve days out, one word of three is met today.
    expect(await readSessionTargets(t.db, stale)).toMatchObject([{ capHalves: 5, owedGlossIds: [a] }]);

    // `a` was started two days before and is ready: it rests, and the next day meets `b`.
    await setTargetWord(t.db, { targetId: exam, glossId: a, startedOn: '2030-01-07', halves: {} });
    await setTargetReadiness(t.db, { targetId: exam, glossId: a, dimensions: ['written_productive', 'spelling'], stability: 400, lastDay: '2030-01-07' });
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

// Final review C1 (spec D2's stock lag, anti-goal 1), phase 67 (spec D2, D5). A target's stock is
// chosen at its session's start, crediting that session's cards as asked. When they are the day's
// last owed card, the session in flight is the budget's last, so the stock is past the budget (phase
// 65b) and records the owed word. A miss adds no card, so the day is done whatever the session's
// answers, and the stock is played as it is.
describe("a target's stock chosen beside the session that asks the day's last card (final review C1, phase 67)", () => {
  /** The exam's one word, met yesterday and below 90: on a device that cannot listen it owes one
   *  card today, its writing card, which one typed translation in flight asks. S1 is that card,
   *  started; its start sets the day's budget, one session, and asks for the path's stock, built
   *  here beside it. */
  async function coveredDay() {
    const words = await savedWords();
    const [word] = words;
    const exam = await addTarget('exam', '2030-01-13', [word.glossId]);
    await setTargetWord(t.db, { targetId: exam, glossId: word.glossId, startedOn: '2030-01-07', halves: Object.fromEntries(LIVE.map((d) => [d, 4])) });
    const s1 = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [word], types: ['typed_translation'], targetId: exam });
    await service.startSession('u_1', s1.sessionId, NO_DEVICES);
    const [job] = await stockJobs();
    await service.stockSession(job.data);
    const { stock } = (await readOpen(exam))!;
    expect(await readSessionTargets(t.db, stock)).toMatchObject([{ capHalves: 7, owedGlossIds: [word.glossId] }]);
    return { word, exam, s1, stock };
  }
  const readOpen = async (exam: string) => {
    const [stock] = ((await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[]).filter((payload) => payload.target);
    return stock && (await readStockRow(t.db, stock.session_id)).targetId === exam ? { stock: stock.session_id } : undefined;
  };

  it.each([
    ['a miss: it adds no card', 'zzzz'],
    ['every answer right', null],
  ])('is played as it is once that session ends with %s: the day is done', async (_, typed) => {
    const { word, exam, s1, stock } = await coveredDay();

    await service.submitAnswer('u_1', s1.sessionId, s1.questions[0].id, { text: typed ?? word.form });
    expect((await service.currentSession('u_1', E, exam)).dueCount).toBe(0);

    expect(await service.createNextSession('u_1', E, NO_DEVICES, exam)).toMatchObject({ sessionId: stock, created: false });
    expect((await service.currentSession('u_1', E, exam)).current?.id).toBe(stock);
    expect(logged('session_retired')).toEqual([]);
  });
});

// Final review I1 (ADR 0014 R4). A target's end closes its path: a session started there could
// never be resumed or skipped again, and an open session counts as today's, so its answers and
// first meetings read as today's on every day after. The end skips it in its own transaction,
// early or on its date, its answers counted once, as a skip's.
describe("a target's end skips the session started on its path (final review I1)", () => {
  /** What `day` reads as answered and as met: the learner's day as the choice reads it. */
  const readDay = (day: string) => readLearnerDay(t.db, E, day);

  /** A session started on the exam's path, its first card answered right on DAY. */
  async function startedOnExam(dueOn: string) {
    const words = await savedWords();
    const exam = await addTarget('exam', dueOn, ids(words.slice(0, 3)));
    const own = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: [words[0], words[1]],
      types: ['multiple_choice', 'multiple_choice'],
      targetId: exam,
    });
    await service.startSession('u_1', own.sessionId, NO_DEVICES);
    const card = asChoice(own.questions[0]);
    await service.submitAnswer('u_1', own.sessionId, card.id, { option_index: card.correct_option });
    // Open, it counts as any day's: here, the next day's.
    expect(await readDay(NEXT_DAY)).toEqual({ answered: [words[0].glossId], met: [words[0].glossId] });
    return { word: words[0], exam, own: own.sessionId };
  }

  it('ended early: skipped in the end, its answer written once, and no longer any other day\'s', async () => {
    const { word, exam, own } = await startedOnExam('2030-01-13');

    await targets.end('u_1', exam);

    expect(await readStockRow(t.db, own)).toMatchObject({ status: 'skipped', practiceDay: DAY });
    expect(await readDay(NEXT_DAY)).toEqual({ answered: [], met: [] });
    expect(await readDay(DAY)).toEqual({ answered: [word.glossId], met: [word.glossId] });
    // Counted once, as a skip counts: memory, and the exam's skills as they stood at the answer.
    expect((await readMemory(t.db, E)).map((row) => row.glossId)).toContain(word.glossId);
    expect(await readTargetSkills(t.db, exam)).toEqual([{ glossId: word.glossId, dimension: 'written_receptive', halves: 2, sessionId: own, day: DAY }]);
    expect(logged('session_skipped').filter((entry) => entry.session_id === own)).toEqual([{ event: 'session_skipped', session_id: own, reason: 'target_ended' }]);
  });

  // Correction (ruling I1-c). A learner, not a bot, whose day follows the clock: a session last
  // answered two days ago, left open, counts for that day when the end skips it, so its reviews
  // are dated when they were given.
  it("counts the skip for the day of the session's last answer", async () => {
    await seedUser(t.db, 'u_3');
    await setTimeZone(t.db, 'u_3', 'UTC');
    const enrollment = enrollmentOf('u_3');
    await service.skipSession('u_3', (await service.createNextSession('u_3', enrollment, NO_DEVICES)).sessionId);
    const saved = await seedSavedSenses(t.db, { enrollmentId: enrollment, lemma: 'grape', translations: ['ענב'] });
    const word: AskedGloss = { glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: 'grape', lemma: 'grape', translation: 'ענב' };
    const dayOf = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const exam = await seedTarget(t.db, { enrollmentId: enrollment, kind: 'exam', dueOn: dayOf(5), glossIds: [word.glossId] });
    const own = await insertListSession(t.db, { userId: 'u_3', enrollmentId: enrollment, asked: [word, word], types: ['multiple_choice', 'multiple_choice'], targetId: exam });
    await service.startSession('u_3', own.sessionId, NO_DEVICES);
    const card = asChoice(own.questions[0]);
    await service.submitAnswer('u_3', own.sessionId, card.id, { option_index: card.correct_option });
    await moveAnswersBack(t.db, own.sessionId, 2);

    await targets.end('u_3', exam);

    expect(await readStockRow(t.db, own.sessionId)).toMatchObject({ status: 'skipped', practiceDay: dayOf(-2) });
  });

  it('ended on its date: skipped by the first main-path stock that records the end', async () => {
    const { word, exam, own } = await startedOnExam(DAY);

    const after = '2030-01-10';
    await makeBot(t.db, 'u_1', NEXT_DAY);
    const main = await service.createNextSession('u_1', E, NO_DEVICES);

    expect(await readTargetEvents(t.db, exam)).toEqual([
      { kind: 'ended_on_date', before: null, after: { due_on: DAY }, actorUserId: null, sessionId: main.sessionId },
    ]);
    expect(await readStockRow(t.db, own)).toMatchObject({ status: 'skipped', practiceDay: NEXT_DAY });
    expect(await readDay(after)).toEqual({ answered: [], met: [] });
    expect((await readDay(NEXT_DAY)).answered).toEqual([word.glossId]);
    expect(logged('session_skipped').filter((entry) => entry.session_id === own)).toEqual([{ event: 'session_skipped', session_id: own, reason: 'target_ended' }]);
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

    // Ruling T5-q: the main path's saved words are those in no active target.
    expect(await service.currentSession('u_1', E)).toEqual({ current: null, nextSource: 'list', savedCount: 3, dueCount: 1 });
    // Five days of five: one word of three owed today.
    expect(await service.currentSession('u_1', E, exam)).toEqual({ current: null, nextSource: 'list', savedCount: 6, dueCount: 1 });

    await endTargetNow(t.db, exam);
    expect((await service.currentSession('u_1', E)).dueCount).toBe(2);
    expect((await service.currentSession('u_1', E, exam)).dueCount).toBe(0);
    expect((await service.currentSession('u_1', E)).savedCount).toBe(6);
  });

  it('counts none saved on the main path when every saved word is in a target (ruling T5-q)', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words));

    expect((await service.currentSession('u_1', E)).savedCount).toBe(0);
    expect((await service.currentSession('u_1', E, exam)).savedCount).toBe(6);

    await endTargetNow(t.db, exam);
    expect((await service.currentSession('u_1', E)).savedCount).toBe(6);
  });
});

// Phase 65b (spec D2). Past the budget, a session asks its owed work and then practice more; the
// practice more moves memory and readiness, but the plan's skills move only for the owed words.
describe("a session past the budget moves its target's plan only for its owed words (phase 65b)", () => {
  const play = async (pastBudget: boolean) => {
    const words = await savedWords();
    const homework = await addTarget('homework', '2030-01-13', [words[0].glossId, words[1].glossId]);
    // The practice more word started yesterday, at 8 halves in writing: a miss would cost it 4.
    await setTargetWord(t.db, { targetId: homework, glossId: words[1].glossId, startedOn: '2030-01-07', halves: { written_productive: 8 } });
    const own = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: [words[0], words[1]],
      types: ['typed_translation', 'typed_translation'],
      targetId: homework,
    });
    if (pastBudget) await markPastBudget(t.db, { sessionId: own.sessionId, targetId: homework, owedGlossIds: [words[0].glossId] });
    await service.startSession('u_1', own.sessionId, NO_DEVICES);
    await service.submitAnswer('u_1', own.sessionId, own.questions[0].id, { text: words[0].form });
    await service.submitAnswer('u_1', own.sessionId, own.questions[1].id, { text: 'zzzz' });
    const skills = await readTargetSkills(t.db, homework);
    const writing = (glossId: string) => skills.find((row) => row.glossId === glossId && row.dimension === 'written_productive')?.halves;
    return { words, homework, writing };
  };

  it("leaves a practice more word's skills as they were on a miss, and moves the owed word's", async () => {
    const { words, homework, writing } = await play(true);
    expect(writing(words[1].glossId)).toBe(8);
    expect(writing(words[0].glossId)).toBeGreaterThan(0);
    // Both words were asked: both are started.
    expect(await readStartedOn(t.db, homework)).toEqual({ [words[0].glossId]: DAY, [words[1].glossId]: '2030-01-07' });
    // Readiness still reads the miss: the practice more word's writing missed today.
    const readiness = await readTargetReadiness(t.db, homework);
    expect(readiness.find((row) => row.glossId === words[1].glossId && row.dimension === 'written_productive')).toMatchObject({ missedToday: true });
  });

  it('costs the miss, as before, when the session was not chosen past the budget', async () => {
    const { words, writing } = await play(false);
    expect(writing(words[1].glossId)).toBe(4);
  });
});

// Phase 65 (spec D2, D3). A session's end writes a target's readiness and its log, from the
// answers in order: the first try of the day decides, a miss counts once, a right after counts
// as a bonus.
describe("a session's end records the target's readiness (phase 65)", () => {
  it('writes one row per counted skill and an event per applied answer: right, wrong, right', async () => {
    const words = await savedWords();
    const homework = await addTarget('homework', '2030-01-13', [words[0].glossId]);
    const own = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: [words[0], words[0], words[0]],
      types: ['typed_translation', 'typed_translation', 'typed_translation'],
      targetId: homework,
    });
    await service.startSession('u_1', own.sessionId, NO_DEVICES);
    for (const [i, right] of [true, false, true].entries()) {
      await service.submitAnswer('u_1', own.sessionId, own.questions[i].id, { text: right ? words[0].form : 'zzzz' });
    }

    const events = await readTargetReadinessEvents(t.db, homework);
    const productive = events.filter((event) => event.dimension === 'written_productive');
    expect(productive.map((event) => event.why).sort()).toEqual(['bonus', 'first_right', 'miss']);
    expect(productive.every((event) => event.day === DAY && event.sessionId === own.sessionId)).toBe(true);
    const rows = await readTargetReadiness(t.db, homework);
    expect(rows.filter((row) => row.dimension === 'written_productive')).toHaveLength(1);
    expect(rows.every((row) => ['written_productive', 'spelling', 'spoken_productive'].includes(row.dimension))).toBe(true);
    expect(rows.find((row) => row.dimension === 'written_productive')).toMatchObject({ day: DAY, missedToday: true, bonusUsed: 1, held: false, sessionId: own.sessionId });
  });

  it("puts readiness on the target's summary, from the start of today, on the skills the check asks", async () => {
    const words = await savedWords();
    const homework = await addTarget('homework', '2030-01-13', [words[0].glossId]);
    const own = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: [words[0], words[0]],
      types: ['typed_translation', 'typed_translation'],
      targetId: homework,
    });
    await service.startSession('u_1', own.sessionId, NO_DEVICES);
    for (const question of own.questions) await service.submitAnswer('u_1', own.sessionId, question.id, { text: words[0].form });

    const read = await targets.getTarget('u_1', homework);

    // A device that does not record: homework counts write and spell only. A first right and a
    // bonus each, from nothing at the start of today.
    expect(read.words[0].skills.map((skill) => skill.dimension)).toEqual(['written_productive', 'spelling']);
    expect(read.words[0].skills.every((skill) => skill.chance > 0 && !skill.held)).toBe(true);
    expect(read.readiness_pct).toBe(read.words[0].readiness_pct);
    expect(read.readiness_pct).toBeGreaterThan(0);
    expect(read.readiness_start_pct).toBe(0);
    expect(read.today).toMatchObject({ sessions_done: 1, sessions_budget: expect.any(Number) });
  });

  it("reads the day's first line as the first answer's, whatever else the day held", async () => {
    const words = await savedWords();
    const homework = await addTarget('homework', '2030-01-13', [words[0].glossId]);
    const play = async (rights: boolean[]) => {
      const own = await insertListSession(t.db, {
        userId: 'u_1',
        enrollmentId: E,
        asked: rights.map(() => words[0]),
        types: rights.map(() => 'typed_translation' as const),
        targetId: homework,
      });
      await service.startSession('u_1', own.sessionId, NO_DEVICES);
      for (const [i, right] of rights.entries()) {
        await service.submitAnswer('u_1', own.sessionId, own.questions[i].id, { text: right ? words[0].form : 'zzzz' });
      }
    };
    const firstOf = async () =>
      (await readFirstReadinessEvents(t.db, homework, DAY)).find((event) => event.dimension === 'written_productive');

    await play([true, false, true]);
    const first = await firstOf();
    // Right, wrong, right: the first line is the first right, read from the start state (nothing).
    const events = await readTargetReadinessEvents(t.db, homework);
    expect(events.filter((event) => event.dimension === 'written_productive' && event.why === 'first_right')).toHaveLength(1);
    expect(first).toEqual({ glossId: words[0].glossId, dimension: 'written_productive', before: 0 });

    // A second session later the same day leaves it where it was.
    await play([false]);
    expect(await firstOf()).toEqual(first);
  });
});

// Phase 65 (spec D7.1, D7.2). Today's budget: set in the transaction that starts the target path's
// first session of the learner day, from the picker played forward over the day as it stands, and
// never rewritten that day.
describe("today's budget (phase 65, spec D7)", () => {
  it("is set when the path's first session of the day starts, and a later one the same day leaves it", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    // Five days left of five: the plan meets one word of three today (spec D6).
    const planned = words.find((word) => word.glossId === sorted(ids(words.slice(0, 3)))[0])!;
    const first = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [planned], types: ['multiple_choice'], targetId: exam });
    expect(await readTargetBudgets(t.db, exam)).toEqual([]);

    await service.startSession('u_1', first.sessionId, NO_DEVICES);

    // The picker played forward: the word's ladder (4 cards), whose practice cards take its written
    // skills to 4 half-points (ruling T9-a), then one card to the cap of 7 in a second session;
    // with no answer to read a miss rate from, the default's one session of room (ceil(2 / 0.8)).
    const set = await readTargetBudgets(t.db, exam);
    expect(set).toEqual([{ day: DAY, sessions: 1, cards: 4, missRoom: 0, doneBefore: 0, createdAt: expect.any(Date) }]);

    // Its card answered right, the session ends and the word is started. A second session the same
    // day leaves the budget be.
    const card = asChoice(first.questions[0]);
    await service.submitAnswer('u_1', first.sessionId, card.id, { option_index: card.correct_option });
    expect(await readStockRow(t.db, first.sessionId)).toMatchObject({ status: 'completed', practiceDay: DAY });
    const second = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [planned], types: ['typed_translation'], targetId: exam });
    await service.startSession('u_1', second.sessionId, NO_DEVICES);

    expect(await readTargetBudgets(t.db, exam)).toEqual(set);
  });

  // Task 9 (e2e). A session no start call started is started by its first answer: the app's own
  // start waits up to three seconds on the device's voices, and a quick first tap lands before it.
  // That start sets the day's budget too, as the start call would, from the day before the answer.
  it('is set when the first answer starts the session, as the start call sets it', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const planned = words.find((word) => word.glossId === sorted(ids(words.slice(0, 3)))[0])!;
    const first = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [planned, planned], types: ['typed_translation', 'multiple_choice'], targetId: exam });

    await service.submitAnswer('u_1', first.sessionId, first.questions[0].id, { text: planned.form });

    // The same budget the start call sets in the test above: the day before this answer.
    const set = await readTargetBudgets(t.db, exam);
    expect(set).toEqual([{ day: DAY, sessions: 1, cards: 4, missRoom: 0, doneBefore: 0, createdAt: expect.any(Date) }]);
    // The start call that lands after it leaves it be, as does the session's next answer.
    await service.startSession('u_1', first.sessionId, NO_DEVICES);
    const card = asChoice(first.questions[1]);
    await service.submitAnswer('u_1', first.sessionId, card.id, { option_index: card.correct_option });
    expect(await readTargetBudgets(t.db, exam)).toEqual(set);
  });

  // Review Focus 4, coordinator's ruling. A session started on the eve and ended the next day is
  // that day's (its practice_day): the day's first start counts it among the sessions promised.
  it("counts a session started the day before and completed today among today's sessions", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const planned = words.find((word) => word.glossId === sorted(ids(words.slice(0, 3)))[0])!;
    await makeBot(t.db, 'u_1', PREVIOUS_DAY);
    const eve = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [planned], types: ['multiple_choice'], targetId: exam });
    await service.startSession('u_1', eve.sessionId, NO_DEVICES);
    const eveBudget = await readTargetBudgets(t.db, exam);
    expect(eveBudget).toMatchObject([{ day: PREVIOUS_DAY, doneBefore: 0 }]);

    // The night passes; its card is answered right and it ends, today's.
    await makeBot(t.db, 'u_1', DAY);
    const card = asChoice(eve.questions[0]);
    await service.submitAnswer('u_1', eve.sessionId, card.id, { option_index: card.correct_option });
    expect(await readStockRow(t.db, eve.sessionId)).toMatchObject({ status: 'completed', practiceDay: DAY });

    const next = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [planned], types: ['typed_translation'], targetId: exam });
    await service.startSession('u_1', next.sessionId, NO_DEVICES);

    // Phase 67 (spec D2, D5): the word, met yesterday and below 90, owes its writing card today (the
    // device cannot listen): one session of one card, no room for misses; and the one done.
    expect(await readTargetBudgets(t.db, exam)).toEqual([
      ...eveBudget,
      { day: DAY, sessions: 1 + 1, cards: 1, missRoom: 0, doneBefore: 1, createdAt: expect.any(Date) },
    ]);
  });

  // Review Focus 4, ruling P1. The summary counts a session by its practice_day: started on the
  // eve and ended today, it is today's session done, and not the eve's.
  it("counts a session started the day before and completed today in today's sessions done on the summary", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const planned = words.find((word) => word.glossId === sorted(ids(words.slice(0, 3)))[0])!;
    await makeBot(t.db, 'u_1', PREVIOUS_DAY);
    const eve = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [planned], types: ['multiple_choice'], targetId: exam });
    await service.startSession('u_1', eve.sessionId, NO_DEVICES);
    // Started on the eve, which set the eve's budget: none done yet.
    const [eveBudget] = await readTargetBudgets(t.db, exam);
    expect((await targets.getTarget('u_1', exam)).today).toMatchObject({ sessions_budget: eveBudget.sessions, sessions_done: 0, state: 'owed' });

    await makeBot(t.db, 'u_1', DAY);
    const card = asChoice(eve.questions[0]);
    await service.submitAnswer('u_1', eve.sessionId, card.id, { option_index: card.correct_option });

    // Today: no session started yet, so no budget; the offer is today's play (one session of one
    // card, phase 67) and the one done, as the day's first start would set it.
    expect((await targets.getTarget('u_1', exam)).today).toMatchObject({
      state: 'owed',
      sessions_budget: null,
      sessions_offer: 1 + 1,
      sessions_done: 1,
      minutes: 1,
    });
    // Read back on the eve, it is not the eve's.
    await makeBot(t.db, 'u_1', PREVIOUS_DAY);
    expect((await targets.getTarget('u_1', exam)).today).toMatchObject({ sessions_budget: eveBudget.sessions, sessions_done: 0 });
  });

  it("sets none for a main-path session", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', ids(words.slice(0, 3)));
    const main = await insertListSession(t.db, { userId: 'u_1', enrollmentId: E, asked: [words[3]], types: ['multiple_choice'] });
    await service.startSession('u_1', main.sessionId, NO_DEVICES);
    expect(await readTargetBudgets(t.db, exam)).toEqual([]);
  });
});

