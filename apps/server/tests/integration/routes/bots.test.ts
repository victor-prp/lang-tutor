import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../../src/app';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { botDayOf, seedBot, seedUser } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 35 (spec D12). The bot route, through the app production assembles:
// mounted only when BOT_SECRET is set, behind the secret, for bots only.
const SECRET = 'a-bot-secret-that-is-at-least-32-characters';
let t: TestDb;
let logger: FakeLogger;

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  await seedBot(t.db, 'steady-en', '2026-10-11');
  // A learner whose username is what a bot named `dana-en` would map to.
  await seedUser(t.db, 'dana_en');
});

afterEach(async () => {
  await t.close();
});

const appWith = (botSecret: string | null) =>
  createApp(createTestServerDeps({ db: t.db, logger, rng: testRng(7), botSecret }));

const call = (
  app: ReturnType<typeof createApp>,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  secret: string | null = SECRET,
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
    body: JSON.stringify(body),
  });

const signIn = (app: ReturnType<typeof createApp>, name: string, secret?: string | null) =>
  call(app, 'POST', '/api/bots/sign-in', { name }, secret);
const setDay = (app: ReturnType<typeof createApp>, name: string, day: string, secret?: string | null) =>
  call(app, 'PUT', '/api/bots/day', { name, day }, secret);

describe('without BOT_SECRET', () => {
  it('answers 404 on both paths, secret or not', async () => {
    const app = appWith(null);
    for (const secret of [SECRET, null]) {
      expect((await signIn(app, 'steady-en', secret)).status).toBe(404);
      expect((await setDay(app, 'steady-en', '2026-10-12', secret)).status).toBe(404);
    }
    expect(await botDayOf(t.db, 'steady_en')).toBe('2026-10-11');
  });
});

describe('with BOT_SECRET', () => {
  it('answers 401 to a wrong, missing or differently sized secret, and does nothing', async () => {
    const app = appWith(SECRET);
    for (const secret of [`${SECRET}x`, SECRET.slice(0, -1), 'nope', '', null]) {
      const res = await signIn(app, 'steady-en', secret);
      expect([secret, res.status]).toEqual([secret, 401]);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
      expect((await setDay(app, 'steady-en', '2026-10-12', secret)).status).toBe(401);
    }
    expect(await botDayOf(t.db, 'steady_en')).toBe('2026-10-11');
  });

  it('answers 401 to the secret under another scheme', async () => {
    const app = appWith(SECRET);
    const res = await app.request('/api/bots/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${SECRET}` },
      body: JSON.stringify({ name: 'steady-en' }),
    });
    expect(res.status).toBe(401);
  });

  it("answers 404 for a learner's name, the same as an unknown one, and changes nothing", async () => {
    const app = appWith(SECRET);
    for (const name of ['dana-en', 'nobody-here']) {
      const res = await signIn(app, name);
      expect([name, res.status]).toEqual([name, 404]);
      expect(await res.json()).toEqual({ error: 'not found' });
      const day = await setDay(app, name, '2026-10-12');
      expect([name, day.status]).toEqual([name, 404]);
      expect(await day.json()).toEqual({ error: 'not found' });
    }
    expect(await botDayOf(t.db, 'dana_en')).toBeNull();
  });

  it('answers 400 to a name or a day that does not validate', async () => {
    const app = appWith(SECRET);
    for (const name of ['Steady-en', 'steady_en', 'st', 'a'.repeat(31)]) {
      expect([name, (await signIn(app, name)).status]).toEqual([name, 400]);
    }
    for (const day of ['2026-1-12', '2026-02-30', '12/10/2026', '2026-10-12T00:00:00Z']) {
      const res = await setDay(app, 'steady-en', day);
      expect([day, res.status]).toEqual([day, 400]);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    }
  });

  it("signs a bot in: the returned cookie reads /api/me as that bot", async () => {
    const app = appWith(SECRET);
    const res = await signIn(app, 'steady-en');
    expect(res.status).toBe(200);
    const { cookie } = (await res.json()) as { cookie: string };
    expect(cookie).toMatch(/^better-auth\.session_token=[^;\s]+; better-auth\.dont_remember=[^;\s]+$/);

    const me = await app.request('/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      email: 'steady-en@bots.invalid',
      user: expect.objectContaining({ username: 'steady_en', display_name: 'steady-en' }),
    });
  });

  it('mints a one-day session, which get-session does not slide to ninety', async () => {
    const app = appWith(SECRET);
    const { cookie } = (await (await signIn(app, 'steady-en')).json()) as { cookie: string };
    const res = await app.request('/api/auth/get-session', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as { session: { expiresAt: string } };
    const left = new Date(session.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(23 * 3600_000);
    expect(left).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('a cookie with a forged signature reads nothing', async () => {
    const app = appWith(SECRET);
    const { cookie } = (await (await signIn(app, 'steady-en')).json()) as { cookie: string };
    const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('=')).split('.')[0];
    const forged = `better-auth.session_token=${encodeURIComponent(`${token}.${'A'.repeat(43)}=`)}`;
    expect((await app.request('/api/me', { headers: { cookie: forged } })).status).toBe(401);
  });

  it("sets the bot's day, and a retry with the same day changes nothing", async () => {
    const app = appWith(SECRET);
    const first = await setDay(app, 'steady-en', '2026-10-12');
    expect(first.status).toBe(204);
    expect(await botDayOf(t.db, 'steady_en')).toBe('2026-10-12');

    const again = await setDay(app, 'steady-en', '2026-10-12');
    expect(again.status).toBe(204);
    expect(await botDayOf(t.db, 'steady_en')).toBe('2026-10-12');
  });

  it('logs one bot_route line per call, with the operation and the name, and never the secret or the cookie', async () => {
    const app = appWith(SECRET);
    const { cookie } = (await (await signIn(app, 'steady-en')).json()) as { cookie: string };
    await setDay(app, 'steady-en', '2026-10-12');
    await signIn(app, 'dana-en');
    await signIn(app, 'steady-en', 'wrong');

    const lines = logger.events.filter((e) => e.event === 'bot_route');
    expect(lines).toEqual([
      { event: 'bot_route', operation: 'sign-in', name: 'steady-en', status: 200 },
      { event: 'bot_route', operation: 'day', name: 'steady-en', status: 204 },
      { event: 'bot_route', operation: 'sign-in', name: 'dana-en', status: 404 },
      { event: 'bot_route', operation: 'sign-in', name: null, status: 401 },
    ]);
    const logged = JSON.stringify(logger.events) + JSON.stringify(logger.errors);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(cookie.split(';')[0].split('=')[1]);
  });

  it('answers 404 to any other path under /api/bots, without a session', async () => {
    const app = appWith(SECRET);
    const res = await app.request('/api/bots/whatever', { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(404);
  });
});
