import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import type { TargetKind } from '../../../src/domain/targets';
import type { SessionService } from '../../../src/services/sessions';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, makeBot, seedUser } from '../../support/seedUser';
import { readSessionSplit, readStockRow, readTargetEvents, seedTarget } from '../../support/targetRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 53 (spec D8, D12, ruling R-D12). A stock serves the learner's targets on the learner
// day, and records that day and the split it was chosen with. A stock chosen on an earlier
// day is replaced on the home read when the day's split differs from the one it recorded,
// and played as it is when it does not. The learner is a bot, so the day is the profile's
// (ADR 0013) and moves only when a test moves it.

const E = enrollmentOf('u_1');
const DAY = '2030-01-08';
const NEXT_DAY = '2030-01-09';
const NO_DEVICES = { listening: false, speaking: false };
const LEMMAS = ['apple', 'bread', 'cheese', 'dates', 'eggs', 'flour'];
const HEBREW = ['תפוח', 'לחם', 'גבינה', 'תמרים', 'ביצים', 'קמח'];

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

/** Past the seed, six words saved, one gloss each, in LEMMAS' order. */
async function savedWords(): Promise<string[]> {
  const seed = await service.createNextSession('u_1', E, NO_DEVICES);
  await service.skipSession('u_1', seed.sessionId);
  const glossIds: string[] = [];
  for (const [i, lemma] of LEMMAS.entries()) {
    glossIds.push((await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [HEBREW[i]] })).glossIds[0]);
  }
  return glossIds;
}

/** A target holding `glossIds`, set up directly: the targets service is not this test's. */
const addTarget = (kind: TargetKind, dueOn: string, glossIds: string[]) => seedTarget(t.db, { enrollmentId: E, kind, dueOn, glossIds });

/** The slots a session gave each target it served, by target id. */
async function slotsOf(sessionId: string): Promise<Record<string, number>> {
  return Object.fromEntries((await readSessionSplit(t.db, sessionId)).map((row) => [row.targetId, row.slots]));
}

/** The glosses the preparation of `sessionId` was given, in pick order. */
async function picksOf(sessionId: string): Promise<string[]> {
  const payloads = (await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[];
  return payloads.find((payload) => payload.session_id === sessionId)!.picks.map((pick) => pick.gloss_id);
}

const logged = (event: string) => logger.events.filter((entry) => entry.event === event);

describe('a stock for a learner with a target (spec D6, D8)', () => {
  it('serves the exam first, and records the split and the learner day its words were chosen on', async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-13', words.slice(0, 3));

    const { sessionId, status } = await service.createNextSession('u_1', E, NO_DEVICES);

    expect(status).toBe('preparing');
    expect(await readStockRow(t.db, sessionId)).toEqual({ status: 'preparing', practiceDay: null, chosenOn: DAY });
    // Five days off, no word of it met: the exam asks for every slot. Phase 55 (spec D4, D5): two
    // ladders, the session's ceiling, and the two slots they leave stay off the main path.
    expect(await readSessionSplit(t.db, sessionId)).toEqual([
      { targetId: exam, wish: 10, slots: 10, picked: 2, reason: 'not_ready', daysLeft: 5, readyCount: 0, wordCount: 3 },
    ]);
    const picks = await picksOf(sessionId);
    expect(picks).toHaveLength(2);
    expect(words.slice(0, 3)).toEqual(expect.arrayContaining(picks));
  });
});

describe('a stock chosen on an earlier day (spec D12, ruling R-D12)', () => {
  it("is replaced on the home read when the day's split changed: the exam's eve takes every slot", async () => {
    const words = await savedWords();
    // On DAY the exam is two days off, its run-up, beside a homework far off: half each.
    const exam = await addTarget('exam', '2030-01-10', words.slice(0, 3));
    const homework = await addTarget('homework', '2030-01-20', words.slice(3, 5));
    const { sessionId: stale } = await service.createNextSession('u_1', E, NO_DEVICES);
    expect(await slotsOf(stale)).toEqual({ [exam]: 5, [homework]: 5 });

    await makeBot(t.db, 'u_1', NEXT_DAY);
    const { current } = await service.currentSession('u_1', E);

    expect(current).toEqual({ id: expect.any(String), status: 'preparing', source: 'list', answered: 0, total: 0 });
    const fresh = current!.id;
    expect(fresh).not.toBe(stale);
    // Retired, which no learner did: skipped with no practice day.
    expect(await readStockRow(t.db, stale)).toEqual({ status: 'skipped', practiceDay: null, chosenOn: DAY });
    expect(await readStockRow(t.db, fresh)).toEqual({ status: 'preparing', practiceDay: null, chosenOn: NEXT_DAY });
    expect(await slotsOf(fresh)).toEqual({ [exam]: 10, [homework]: 0 });
    // Phase 55 (spec D4, D5): the exam's two ladders, and nothing else: the two slots they leave
    // fit no homework ladder and stay off the main path.
    const picks = await picksOf(fresh);
    expect(picks).toHaveLength(2);
    expect(words.slice(0, 3)).toEqual(expect.arrayContaining(picks));
    expect(logged('session_retired')).toEqual([{ event: 'session_retired', enrollment_id: E, session_id: stale, reason: 'stale_split' }]);
    // Chosen today, the new stock is the one the next home read offers.
    expect((await service.currentSession('u_1', E)).current?.id).toBe(fresh);
  });

  it("is played as it is when the day's split is the same (phase 43 R5)", async () => {
    const words = await savedWords();
    const exam = await addTarget('exam', '2030-01-20', words.slice(0, 3));
    const { sessionId: stock } = await service.createNextSession('u_1', E, NO_DEVICES);

    await makeBot(t.db, 'u_1', NEXT_DAY);

    expect((await service.currentSession('u_1', E)).current?.id).toBe(stock);
    expect(await readStockRow(t.db, stock)).toEqual({ status: 'preparing', practiceDay: null, chosenOn: DAY });
    expect(await slotsOf(stock)).toEqual({ [exam]: 10 });
    expect(await jobPayloads(t.db, PREPARE_SESSION)).toHaveLength(1);
    expect(logged('session_retired')).toEqual([]);
  });

  it("is replaced once the exam's date has come, and the stock built records the exam ended on it", async () => {
    const words = await savedWords();
    // On DAY the exam's eve, every slot; on NEXT_DAY its date, when it serves nothing.
    const exam = await addTarget('exam', NEXT_DAY, words.slice(0, 3));
    const { sessionId: stale } = await service.createNextSession('u_1', E, NO_DEVICES);
    expect(await slotsOf(stale)).toEqual({ [exam]: 10 });
    expect(await readTargetEvents(t.db, exam)).toEqual([]);

    await makeBot(t.db, 'u_1', NEXT_DAY);
    const { current } = await service.currentSession('u_1', E);

    const fresh = current!.id;
    expect(fresh).not.toBe(stale);
    expect(await slotsOf(fresh)).toEqual({});
    expect(await readTargetEvents(t.db, exam)).toEqual([
      { kind: 'ended_on_date', before: null, after: { due_on: NEXT_DAY }, actorUserId: null, sessionId: fresh },
    ]);
    expect(logged('target_ended')).toEqual([{ event: 'target_ended', target_id: exam, how: 'on_date' }]);
  });
});
