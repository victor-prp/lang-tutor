import { describe, expect, it } from '@jest/globals';

import { createFakeAppDeps, createFakeLogger } from '../../tests/support/fakes';
import { createApp } from '../app';

// Phase 52 (spec D5). The tick's routing through createApp, with fakes: what answers where it
// is mounted and where it is not, and that only a good secret reaches the service. The queued
// job itself is tests/integration/routes/internalReminders.test.ts's.

const SECRET = 'a-reminder-secret-that-is-at-least-32-characters';
const TICK = '/api/internal/reminders/tick';

function build(mounted: boolean) {
  const base = createFakeAppDeps();
  const logger = createFakeLogger();
  let requested = 0;
  const service = {
    ...base.reminders,
    requestTick: async () => {
      requested += 1;
    },
  };
  const app = createApp({ ...base, logger, reminderTick: mounted ? { secret: SECRET, service } : null });
  return { app, logger, requested: () => requested };
}

const post = (app: ReturnType<typeof createApp>, path: string, authorization: string | null) =>
  app.request(path, { method: 'POST', headers: authorization === null ? {} : { authorization } });

describe('the reminder tick, unmounted', () => {
  it('answers 404 under /api/internal, secret or not, before any session check', async () => {
    const { app } = build(false);
    for (const path of [TICK, '/api/internal', '/api/internal/other']) {
      for (const authorization of [`Bearer ${SECRET}`, null]) {
        const res = await post(app, path, authorization);
        expect([path, authorization, res.status]).toEqual([path, authorization, 404]);
        expect(await res.json()).toEqual({ error: 'not found' });
      }
    }
  });
});

describe('the reminder tick, mounted', () => {
  it('answers 202 to the secret, and asks the service for one run per call', async () => {
    const { app, requested } = build(true);
    const res = await post(app, TICK, `Bearer ${SECRET}`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(requested()).toBe(1);
  });

  it('answers 401 to anything else, and never reaches the service', async () => {
    const { app, requested } = build(true);
    for (const authorization of [`Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, 'Bearer ', `Basic ${SECRET}`, SECRET, null]) {
      const res = await post(app, TICK, authorization);
      expect([authorization, res.status]).toEqual([authorization, 401]);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(requested()).toBe(0);
  });

  it('answers 404 to another /api/internal path, and to a GET of the tick, without a session', async () => {
    const { app, requested } = build(true);
    expect((await post(app, '/api/internal/other', null)).status).toBe(404);
    expect((await post(app, '/api/internal/other', `Bearer ${SECRET}`)).status).toBe(404);
    expect((await app.request(TICK, { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(404);
    expect(requested()).toBe(0);
  });

  it('logs one line per call with its status, and never the secret', async () => {
    const { app, logger } = build(true);
    await post(app, TICK, `Bearer ${SECRET}`);
    await post(app, TICK, 'Bearer wrong');

    expect(logger.events).toEqual([
      { event: 'reminder_tick_route', status: 202 },
      { event: 'reminder_tick_route', status: 401 },
    ]);
    expect(JSON.stringify(logger.events) + JSON.stringify(logger.errors)).not.toContain(SECRET);
  });
});
