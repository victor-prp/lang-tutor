import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { createApp } from '../../../src/app';
import { REMIND } from '../../../src/domain/jobs';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { countJobs, startTestBoss, stopTestBoss } from '../../support/jobs';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 52 (spec D5). The reminder tick, through the app production assembles: mounted only
// when REMINDER_SECRET is set, behind the secret, and answering with one queued run.
const SECRET = 'a-reminder-secret-that-is-at-least-32-characters';
const TICK = '/api/internal/reminders/tick';
let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  logger = createFakeLogger();
});

afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

const appWith = (reminderSecret: string | null) =>
  createApp(createTestServerDeps({ db: t.db, logger, rng: testRng(52), boss, reminderSecret }));

/** EventBridge's call: a POST with no body and the secret as a bearer token. */
const tick = (app: ReturnType<typeof createApp>, authorization: string | null = `Bearer ${SECRET}`) =>
  app.request(TICK, { method: 'POST', headers: authorization === null ? {} : { authorization } });

describe('without REMINDER_SECRET', () => {
  it('answers 404, secret or not, and queues nothing', async () => {
    const app = appWith(null);
    for (const authorization of [`Bearer ${SECRET}`, null]) {
      const res = await tick(app, authorization);
      expect([authorization, res.status]).toEqual([authorization, 404]);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(await countJobs(t.db, REMIND)).toBe(0);
  });
});

describe('with REMINDER_SECRET', () => {
  it('answers 401 to a wrong, missing or differently sized secret, and queues nothing', async () => {
    const app = appWith(SECRET);
    for (const secret of [`${SECRET}x`, SECRET.slice(0, -1), 'nope', '']) {
      const res = await tick(app, `Bearer ${secret}`);
      expect([secret, res.status]).toEqual([secret, 401]);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    const missing = await tick(app, null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'unauthorized' });
    expect(await countJobs(t.db, REMIND)).toBe(0);
  });

  it('answers 401 to the secret under another scheme, or with no scheme', async () => {
    const app = appWith(SECRET);
    for (const authorization of [`Basic ${SECRET}`, SECRET]) {
      const res = await tick(app, authorization);
      expect([authorization, res.status]).toEqual([authorization, 401]);
    }
    expect(await countJobs(t.db, REMIND)).toBe(0);
  });

  it('answers 202 and queues one run, and a second tick while it waits queues nothing more', async () => {
    const app = appWith(SECRET);

    const first = await tick(app);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ queued: true });
    expect(await countJobs(t.db, REMIND)).toBe(1);

    const second = await tick(app);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ queued: true });
    expect(await countJobs(t.db, REMIND)).toBe(1);
  });

  it('logs one line per call with its status, and never the secret', async () => {
    const app = appWith(SECRET);
    await tick(app);
    await tick(app, 'Bearer wrong');
    await tick(app, null);

    expect(logger.events.filter((e) => e.event === 'reminder_tick_route')).toEqual([
      { event: 'reminder_tick_route', status: 202 },
      { event: 'reminder_tick_route', status: 401 },
      { event: 'reminder_tick_route', status: 401 },
    ]);
    const logged = JSON.stringify(logger.events) + JSON.stringify(logger.errors);
    expect(logged).not.toContain(SECRET);
  });

  it('answers 404 to any other path under /api/internal, without a session', async () => {
    const app = appWith(SECRET);
    for (const path of ['/api/internal', '/api/internal/other', '/api/internal/sessions']) {
      for (const authorization of [`Bearer ${SECRET}`, null]) {
        const res = await app.request(path, { method: 'POST', headers: authorization === null ? {} : { authorization } });
        expect([path, authorization, res.status]).toEqual([path, authorization, 404]);
        expect(await res.json()).toEqual({ error: 'not found' });
      }
    }
    expect(await countJobs(t.db, REMIND)).toBe(0);
  });

  it('checks the secret first on any path under /api/internal/reminders, as /api/bots/* does, and answers 404 past it', async () => {
    const app = appWith(SECRET);
    for (const path of ['/api/internal/reminders', '/api/internal/reminders/tick/more']) {
      const without = await app.request(path, { method: 'POST' });
      expect([path, without.status]).toEqual([path, 401]);
      const withSecret = await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } });
      expect([path, withSecret.status]).toEqual([path, 404]);
    }
    expect(await countJobs(t.db, REMIND)).toBe(0);
  });

  it('answers 404 to a GET of the tick, with the secret', async () => {
    const app = appWith(SECRET);
    const res = await app.request(TICK, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(404);
    expect(await countJobs(t.db, REMIND)).toBe(0);
  });
});
