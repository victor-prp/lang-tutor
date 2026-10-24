import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { createApp } from '../../../src/app';
import { REMIND } from '../../../src/domain/jobs';
import { registerWorkers } from '../../../src/worker';
import { createFakeLogger } from '../../support/fakes';
import { countJobs, startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import { clearNamespace, mockNamespace, pushBaseUrlFor, pushSends, stubPushSend } from '../../support/mockServer';
import { enrollmentOf, seedUser, setTimeZone } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

// Phase 52 (spec D5). The whole chain, once: EventBridge's tick queues the job, the worker runs
// it, and the learner whose slot is due is reminded. The tick's decisions are
// services/reminders.tick.test.ts's.

const SECRET = 'a-reminder-secret-that-is-at-least-32-characters';
/** Wednesday 2026-09-02, 13:05 in Jerusalem. */
const AT = Date.parse('2026-09-02T10:05:00Z');
const TOKEN = 'ExponentPushToken[u_1]';

let t: TestDb;
let ns: string;
let boss: PgBoss;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('jobs-remind');
  boss = await startTestBoss(t.db);
});
afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

describe('the remind job', () => {
  it('runs the tick the route queued, and the learner whose slot is due is reminded', async () => {
    const logger = createFakeLogger();
    const deps = createTestServerDeps({
      db: t.db,
      logger,
      rng: testRng(52),
      boss,
      now: () => AT,
      pushBaseUrl: pushBaseUrlFor(ns),
      reminderSecret: SECRET,
    });
    await seedUser(t.db, 'u_1');
    await setTimeZone(t.db, 'u_1', 'Asia/Jerusalem');
    // Phase 75 (spec D1): a word of their own, so My words owes its goal today.
    await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma: 'apple', translations: ['תפוח'] });
    await deps.reminders.registerDevice('u_1', { token: TOKEN, platform: 'android' });
    await stubPushSend(ns, [{ status: 'ok', id: 'ticket-1' }]);

    const res = await createApp(deps).request('/api/internal/reminders/tick', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(202);
    expect(await countJobs(t.db, REMIND)).toBe(1);

    await registerWorkers(boss, deps, { pollingIntervalSeconds: 0.5 });
    await waitFor(async () => logger.events.some((event) => event.event === 'reminder_tick'));

    expect(logger.events).toContainEqual({ event: 'reminder_tick', candidates: 1, claimed: 1, sent: 1, skipped: 0, failed: 0 });
    expect((await pushSends(ns)).map((message) => message.to)).toEqual([TOKEN]);
  });
});
