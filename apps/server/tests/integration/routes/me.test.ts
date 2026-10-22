import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../../src/app';
import { signUp, signUpWithProfile } from '../../support/auth';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, expectEmails, mailBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { setTester, storedNewWordLimitsOf, timeZoneOf } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 52 (spec D1). PUT /api/me/time-zone through the app production assembles,
// with a real session: the gate (401 without one, 403 without a profile) is part
// of what the route promises.
let t: TestDb;
let ns: string;
let app: ReturnType<typeof createApp>;
let cookie: string;
let userId: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('me');
  await expectEmails(ns);
  app = createApp(
    createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), mailBaseUrl: mailBaseUrlFor(ns) }),
  );
  ({ cookie, userId } = await signUpWithProfile(app, ns, { email: 'learner@example.com', username: 'learner' }));
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

function putTimeZone(body: unknown, headers: Record<string, string> = { cookie }) {
  return app.request('/api/me/time-zone', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('GET /api/me', () => {
  // Phase 52 (spec D1). The profile carries the zone the server holds, so the app reports its
  // own only when it differs.
  it('carries the stored time zone: UTC until the app reports one, then the report', async () => {
    const zoneInMe = async () => {
      const res = await app.request('/api/me', { headers: { cookie } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { user: { time_zone: string } }).user.time_zone;
    };
    expect(await zoneInMe()).toBe('UTC');

    await putTimeZone({ time_zone: 'Asia/Jerusalem' });
    expect(await zoneInMe()).toBe('Asia/Jerusalem');
  });
});

// Phase 61 (spec D1). A tester is a flag on the account, off until db:tester turns it on.
describe('the tester flag', () => {
  it('is off for a new account, and on once set', async () => {
    const testerInMe = async () => {
      const res = await app.request('/api/me', { headers: { cookie } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { user: { tester: boolean } }).user.tester;
    };
    expect(await testerInMe()).toBe(false);
    await setTester(t.db, userId);
    expect(await testerInMe()).toBe(true);
  });
});

describe('PUT /api/me/time-zone', () => {
  it('records the zone and answers 204', async () => {
    expect(await timeZoneOf(t.db, userId)).toBe('UTC');

    const res = await putTimeZone({ time_zone: 'Asia/Jerusalem' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await timeZoneOf(t.db, userId)).toBe('Asia/Jerusalem');
  });

  it('is idempotent, and the latest report wins', async () => {
    expect((await putTimeZone({ time_zone: 'Asia/Jerusalem' })).status).toBe(204);
    expect((await putTimeZone({ time_zone: 'Asia/Jerusalem' })).status).toBe(204);
    expect((await putTimeZone({ time_zone: 'America/New_York' })).status).toBe(204);
    expect(await timeZoneOf(t.db, userId)).toBe('America/New_York');
  });

  it('answers 400 for a name that is not a time zone, and keeps the stored one', async () => {
    await putTimeZone({ time_zone: 'Asia/Jerusalem' });

    const res = await putTimeZone({ time_zone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
    expect(await timeZoneOf(t.db, userId)).toBe('Asia/Jerusalem');
  });

  it.each([
    ['an empty name', { time_zone: '' }],
    ['a name over 64 characters', { time_zone: 'a'.repeat(65) }],
    ['a body without a name', {}],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await putTimeZone(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 401 without a session', async () => {
    const res = await putTimeZone({ time_zone: 'Asia/Jerusalem' }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not signed in' });
    expect(await timeZoneOf(t.db, userId)).toBe('UTC');
  });

  it('answers 403 profile required to an address that has not onboarded', async () => {
    const fresh = await signUp(app, ns, 'new@example.com');
    const res = await putTimeZone({ time_zone: 'Asia/Jerusalem' }, { cookie: fresh.cookie });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'profile required' });
  });
});

// Phase 70 (spec D1, D5). The learner's new-word limits.
describe('GET and PUT /api/me/new-words', () => {
  const limits = (headers: Record<string, string> = { cookie }) => app.request('/api/me/new-words', { headers });
  const putLimits = (body: unknown, headers: Record<string, string> = { cookie }) =>
    app.request('/api/me/new-words', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('answers the defaults to a learner who never chose: 15 a day, automatic per session', async () => {
    const res = await limits();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ day_cap: 15, per_session: null });
  });

  it('replaces both and answers what it stored; GET then reads it', async () => {
    const res = await putLimits({ day_cap: 30, per_session: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ day_cap: 30, per_session: 2 });
    expect(await (await limits()).json()).toEqual({ day_cap: 30, per_session: 2 });
    expect(await storedNewWordLimitsOf(t.db, userId)).toEqual({ dayNewCap: 30, newPerSession: 2 });
  });

  it('stores the default cap as null, so choosing per session never pins the cap', async () => {
    await putLimits({ day_cap: 30, per_session: 2 });
    const res = await putLimits({ day_cap: 15, per_session: 1 });
    expect(await res.json()).toEqual({ day_cap: 15, per_session: 1 });
    expect(await storedNewWordLimitsOf(t.db, userId)).toEqual({ dayNewCap: null, newPerSession: 1 });
  });

  it.each([
    ['per session 3', { day_cap: 15, per_session: 3 }],
    ['per session 0', { day_cap: 15, per_session: 0 }],
    ['a cap of 0', { day_cap: 0, per_session: null }],
    ['a cap of 101', { day_cap: 101, per_session: null }],
    ['a cap that is not whole', { day_cap: 12.5, per_session: null }],
    ['a body without the cap', { per_session: 2 }],
  ])('answers 400 for %s and stores nothing', async (_label, body) => {
    const res = await putLimits(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
    expect(await storedNewWordLimitsOf(t.db, userId)).toEqual({ dayNewCap: null, newPerSession: null });
  });

  it('answers 401 without a session', async () => {
    expect((await limits({})).status).toBe(401);
    expect((await putLimits({ day_cap: 30, per_session: null }, {})).status).toBe(401);
  });
});
