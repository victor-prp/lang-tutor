import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { registerWorkers } from '../../../src/worker';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  countGeminiRequests,
  expectDistractors,
  expectGeminiStatus,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let deps: AppDeps;
let ns: string;
const E = enrollmentOf('u_1');

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  ns = mockNamespace(expect.getState().currentTestName ?? 'prepare-session');
  logger = createFakeLogger();
  boss = await startTestBoss(t.db);
  deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns) });
  await registerWorkers(boss, deps.sessions, { pollingIntervalSeconds: 0.5 });
});

afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

/** Past the seed (skipped), two saved words, and a list session requested. */
async function requestListSession(): Promise<string> {
  const seed = await deps.sessions.createNextSession(E);
  await deps.sessions.skipSession(seed.sessionId);
  await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'] });
  await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'sprint', translations: ['ריצה'] });
  const { sessionId } = await deps.sessions.createNextSession(E);
  return sessionId;
}

const statusOf = async (sessionId: string) => (await deps.sessions.getSession(sessionId)).status;

describe('prepare-session through the queue', () => {
  it('turns a list session ready, with its saved words as the prompts', async () => {
    await expectDistractors(ns);
    const sessionId = await requestListSession();

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const record = await deps.sessions.getSession(sessionId);
    expect(record.questions.map((q) => q.question).sort()).toEqual(['sprint', 'tome']);
    for (const question of record.questions) {
      expect(question.options).toHaveLength(4);
      expect(['ספר', 'ריצה']).toContain(question.options[question.correct_option]);
    }
  });

  it('a provider that keeps failing ends the session failed, through the dead-letter queue', async () => {
    await expectGeminiStatus(ns, 500);
    const sessionId = await requestListSession();

    await waitFor(async () => (await statusOf(sessionId)) === 'failed', 25_000);
    // One attempt and two retries.
    expect(await countGeminiRequests(ns)).toBe(3);
    expect((await deps.sessions.currentSession(E)).current).toMatchObject({ id: sessionId, status: 'failed' });
  });

  // Review Focus 2: a skip lands while the model is still answering.
  it('a skip during generation wins: the job writes nothing', async () => {
    await expectDistractors(ns, { delayMs: 3_000 });
    const sessionId = await requestListSession();

    await waitFor(async () => (await countGeminiRequests(ns)) === 1);
    await deps.sessions.skipSession(sessionId);
    await waitFor(async () => logger.events.some((e) => e.event === 'session_preparation_dropped'), 15_000);

    const record = await deps.sessions.getSession(sessionId);
    expect(record.status).toBe('skipped');
    expect(record.questions).toEqual([]);
  });
});
