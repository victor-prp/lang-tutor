import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, STOCK_SESSION, type PrepareSessionPayload, type StockSessionPayload } from '../../../src/domain/jobs';
import type { SessionService } from '../../../src/services/sessions';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { insertListSession, type AskedGloss } from '../../support/questions';
import { createTestServerDeps } from '../../support/serverDeps';
import { markReady } from '../../support/sessionRows';
import { enrollmentOf, makeBot, seedUser } from '../../support/seedUser';
import { readSessionTargets, readStockRow, seedTarget, setTargetWord } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 68 (spec D1, D3, D6). A miss on a target path owes the word a step-down on the skill it
// missed, asked as see it, pick it, produce it. The stock is chosen when the session in flight
// starts, before its misses, and a miss keeps it (D6 ruling, 2026-10-22): replacing it made the
// learner wait for a new preparation between sessions. The step-down is asked by the stock chosen
// when the next session starts. The learner is a bot, so the day is the profile's (ADR 0013).

const E = enrollmentOf('u_1');
const DAY = '2030-01-08';
const PREVIOUS_DAY = '2030-01-07';
const NO_DEVICES = { listening: false, speaking: false };

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let service: SessionService;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
  await makeBot(t.db, 'u_1', DAY);
  logger = createFakeLogger();
  service = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss }).sessions;
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

/** Past the seed, two words saved. */
async function savedWords(): Promise<AskedGloss[]> {
  const seed = await service.createNextSession('u_1', E, NO_DEVICES);
  await service.skipSession('u_1', seed.sessionId);
  const words: AskedGloss[] = [];
  for (const [lemma, translation] of [
    ['apple', 'תפוח'],
    ['bread', 'לחם'],
  ]) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
    words.push({ glossId: saved.glossIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
  return words;
}

/** The oldest queued stock job, run and completed as the worker would: the queue keeps one queued
 *  job per path, so a later request waits for this one to leave it. */
async function runStockJob(): Promise<StockSessionPayload> {
  const [job] = await boss.fetch<StockSessionPayload>(STOCK_SESSION);
  await service.stockSession(job.data);
  await boss.complete(STOCK_SESSION, job.id);
  return job.data;
}

/** The newest target stock's preparation. */
async function newestTargetStock(): Promise<PrepareSessionPayload> {
  const payloads = ((await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[]).filter((payload) => payload.target);
  return payloads[payloads.length - 1];
}

/** A homework of both words, met yesterday, whose session S1 asks each its typed translation and
 *  has started: its start asked for the path's stock, chosen beside it. */
async function startedDay() {
  const [apple, bread] = await savedWords();
  const homework = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: '2030-01-13', glossIds: [apple.glossId, bread.glossId] });
  for (const word of [apple, bread]) await setTargetWord(t.db, { targetId: homework, glossId: word.glossId, startedOn: PREVIOUS_DAY, halves: {} });
  const s1 = await insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    asked: [apple, bread],
    types: ['typed_translation', 'typed_translation'],
    targetId: homework,
  });
  await service.startSession('u_1', s1.sessionId, NO_DEVICES);
  expect(await runStockJob()).toMatchObject({ reason: 'start', target_id: homework });
  const stock = (await newestTargetStock()).session_id;
  expect(await readSessionTargets(t.db, stock)).toMatchObject([{ stepDowns: [] }]);
  return { apple, bread, homework, s1, stock };
}

describe('a miss on a target path (phase 68, spec D6, ruling 2026-10-22)', () => {
  it('keeps the next session as it was chosen: no stock is asked for, none retired', async () => {
    const { s1, stock } = await startedDay();

    await service.submitAnswer('u_1', s1.sessionId, s1.questions[0].id, { text: 'zzzz' });
    expect(await boss.fetch(STOCK_SESSION)).toEqual([]);
    expect(await readStockRow(t.db, stock)).toMatchObject({ status: 'preparing' });
    expect(logger.events.filter((entry) => entry.event === 'session_retired')).toEqual([]);
  });

  it('keeps it when the session ends on a missed card: its end asks for the stock, which stays', async () => {
    const { homework, s1, stock } = await startedDay();
    await service.submitAnswer('u_1', s1.sessionId, s1.questions[0].id, { text: 'apple' });

    // The last card, missed, ends S1: its end takes the progress lock, so the stock is asked after it.
    await service.submitAnswer('u_1', s1.sessionId, s1.questions[1].id, { text: 'zzzz' });
    expect(await runStockJob()).toMatchObject({ reason: 'complete', target_id: homework });
    expect(await readStockRow(t.db, stock)).toMatchObject({ status: 'preparing' });
    expect((await newestTargetStock()).session_id).toBe(stock);
    expect(logger.events.filter((entry) => entry.event === 'session_retired')).toEqual([]);
  });

  it('asks for no stock on a right answer', async () => {
    const { apple, s1, stock } = await startedDay();

    await service.submitAnswer('u_1', s1.sessionId, s1.questions[0].id, { text: apple.form });
    expect(await boss.fetch(STOCK_SESSION)).toEqual([]);
    expect(await readStockRow(t.db, stock)).toMatchObject({ status: 'preparing' });
  });

  /** S1 ended, apple missed and bread right; the stock kept beside it, prepared and started: its
   *  start asks for the next, chosen beside it. Answers that stock's preparation. */
  async function nextStartAfterAMiss() {
    const day = await startedDay();
    await service.submitAnswer('u_1', day.s1.sessionId, day.s1.questions[0].id, { text: 'zzzz' });
    await service.submitAnswer('u_1', day.s1.sessionId, day.s1.questions[1].id, { text: 'bread' });
    expect(await runStockJob()).toMatchObject({ reason: 'complete' });
    await markReady(t.db, day.stock);
    await service.startSession('u_1', day.stock, NO_DEVICES);
    expect(await runStockJob()).toMatchObject({ reason: 'start', target_id: day.homework });
    const next = await newestTargetStock();
    expect(next.session_id).not.toBe(day.stock);
    return { ...day, next };
  }

  it('asks the step-down in the stock chosen when the next session starts', async () => {
    const { apple, next } = await nextStartAfterAMiss();
    expect(await readSessionTargets(t.db, next.session_id)).toMatchObject([{ stepDowns: [`${apple.glossId}|written_productive`] }]);
  });

  it('asks the step-down once the day is done, in practice more, on top when the session asks its word another skill', async () => {
    const { apple, bread, next } = await nextStartAfterAMiss();

    // A homework counts spelling, which apple has not answered today: practice more asks it that
    // (typed, as this device cannot listen), so the writing step-down is practice on top.
    expect(next.picks.map((pick) => [pick.gloss_id, pick.dimension, pick.relearn ?? null])).toEqual([
      [apple.glossId, 'spelling', null],
      [bread.glossId, 'written_productive', null],
      [apple.glossId, 'written_productive', 'practice'],
    ]);
  });

  it('flags a session that cannot raise the card for a board: the due date, whose card is frozen (spec D5)', async () => {
    const [apple, bread] = await savedWords();
    const homework = await seedTarget(t.db, { enrollmentId: E, kind: 'homework', dueOn: DAY, glossIds: [apple.glossId, bread.glossId] });
    for (const word of [apple, bread]) await setTargetWord(t.db, { targetId: homework, glossId: word.glossId, startedOn: PREVIOUS_DAY, halves: {} });

    await service.stockSession({ enrollment_id: E, reason: 'start', target_id: homework, ...NO_DEVICES });
    expect(await newestTargetStock()).toMatchObject({ target: true, board: true });
  });
});
