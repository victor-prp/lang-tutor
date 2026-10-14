import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../../src/app';
import { signUp, signUpWithProfile } from '../../support/auth';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, expectEmails, mailBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { devicesOf, pinTappedAt, seedReminder, tappedAtOf } from '../../support/reminderRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 52 (spec D2, D4, D6). The learner's reminder endpoints through the app production
// assembles, with real sessions: the gate (401 without one, 403 without a profile) is part of
// what each route promises, and so is who a call acts for.
type Account = { cookie: string; userId: string };

let t: TestDb;
let ns: string;
let app: ReturnType<typeof createApp>;
let me: Account;
// The second learner, signed up the first time a test asks, so the others do not pay for it.
let otherAccount: Promise<Account> | null;
const other = () => (otherAccount ??= signUpWithProfile(app, ns, { email: 'other@example.com', username: 'other' }));

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('reminders');
  otherAccount = null;
  await expectEmails(ns);
  app = createApp(
    createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), mailBaseUrl: mailBaseUrlFor(ns) }),
  );
  me = await signUpWithProfile(app, ns, { email: 'learner@example.com', username: 'learner' });
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const call = (method: string, url: string, cookie: string | null, body?: unknown) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const getSettings = (cookie: string | null = me.cookie) => call('GET', '/api/me/reminders', cookie);
const putSettings = (body: unknown, cookie: string | null = me.cookie) => call('PUT', '/api/me/reminders', cookie, body);
const register = (body: unknown, cookie: string | null = me.cookie) => call('PUT', '/api/me/push-devices', cookie, body);
const unregister = (body: unknown, cookie: string | null = me.cookie) =>
  call('POST', '/api/me/push-devices/unregister', cookie, body);
const tap = (id: string, cookie: string | null = me.cookie) => call('POST', `/api/me/reminders/${id}/tap`, cookie);

const DEFAULTS = {
  enabled: true,
  daily_target: 1,
  days: [1, 2, 3, 4, 5, 6, 7],
  times: ['13:00', '17:00', '20:00', '22:00'],
  time_zone: 'UTC',
};
const SCHEDULE = { enabled: false, daily_target: 3, days: [1, 3, 5], times: ['08:00', '21:30'] };
const INVALID = { error: 'invalid request' };
const ANDROID = (token: string) => ({ token, platform: 'android' });
const UNKNOWN_UUID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';

describe('the gate', () => {
  const routes: [string, string, string, unknown?][] = [
    ['GET /api/me/reminders', 'GET', '/api/me/reminders'],
    ['PUT /api/me/reminders', 'PUT', '/api/me/reminders', SCHEDULE],
    ['PUT /api/me/push-devices', 'PUT', '/api/me/push-devices', ANDROID('ExponentPushToken[a]')],
    ['POST /api/me/push-devices/unregister', 'POST', '/api/me/push-devices/unregister', { token: 'ExponentPushToken[a]' }],
    ['POST /api/me/reminders/{id}/tap', 'POST', `/api/me/reminders/${UNKNOWN_UUID}/tap`],
  ];

  it.each(routes)('%s answers 401 without a session', async (_label, method, url, body) => {
    const res = await call(method, url, null, body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not signed in' });
  });

  it.each(routes)('%s answers 403 profile required to an address that has not onboarded', async (_label, method, url, body) => {
    const fresh = await signUp(app, ns, 'new@example.com');
    const res = await call(method, url, fresh.cookie, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'profile required' });
  });

  it('writes nothing for a call without a session', async () => {
    await putSettings(SCHEDULE, null);
    await register(ANDROID('ExponentPushToken[a]'), null);
    expect(await devicesOf(t.db)).toEqual([]);
    expect(await (await getSettings()).json()).toEqual(DEFAULTS);
  });
});

describe('GET /api/me/reminders', () => {
  it('answers the defaults, and UTC, for a learner who never saved a schedule', async () => {
    const res = await getSettings();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULTS);
  });

  it('names the time zone the app reported', async () => {
    expect((await call('PUT', '/api/me/time-zone', me.cookie, { time_zone: 'Asia/Jerusalem' })).status).toBe(204);

    expect(await (await getSettings()).json()).toEqual({ ...DEFAULTS, time_zone: 'Asia/Jerusalem' });
  });
});

describe('PUT /api/me/reminders', () => {
  it('answers the schedule as saved, and GET reads it back', async () => {
    const res = await putSettings(SCHEDULE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...SCHEDULE, time_zone: 'UTC' });

    const read = await getSettings();
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ...SCHEDULE, time_zone: 'UTC' });
  });

  it('sorts unsorted input, drops repeats, and answers and stores the sorted form', async () => {
    const res = await putSettings({ enabled: true, daily_target: 2, days: [5, 1, 3, 1], times: ['21:30', '08:00', '21:30', '13:00'] });
    const sorted = { enabled: true, daily_target: 2, days: [1, 3, 5], times: ['08:00', '13:00', '21:30'], time_zone: 'UTC' };
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sorted);
    expect(await (await getSettings()).json()).toEqual(sorted);
  });

  it('replaces the schedule whole: the second save does not keep anything of the first', async () => {
    await putSettings(SCHEDULE);
    await putSettings({ enabled: true, daily_target: 1, days: [], times: ['06:00'] });

    expect(await (await getSettings()).json()).toEqual({
      enabled: true,
      daily_target: 1,
      days: [],
      times: ['06:00'],
      time_zone: 'UTC',
    });
  });

  it('is the caller’s own: another learner keeps the defaults', async () => {
    const stranger = await other();
    await putSettings(SCHEDULE);

    expect(await (await getSettings(stranger.cookie)).json()).toEqual(DEFAULTS);
  });

  it('answers the zone of the learner who saved it', async () => {
    const stranger = await other();
    await call('PUT', '/api/me/time-zone', stranger.cookie, { time_zone: 'America/New_York' });

    expect(await (await putSettings(SCHEDULE)).json()).toEqual({ ...SCHEDULE, time_zone: 'UTC' });
    expect(await (await putSettings(SCHEDULE, stranger.cookie)).json()).toEqual({
      ...SCHEDULE,
      time_zone: 'America/New_York',
    });
  });

  it.each([
    ['a time of 25:00', { ...SCHEDULE, times: ['25:00'] }],
    ['a minute of 60', { ...SCHEDULE, times: ['12:60'] }],
    ['a time without its leading zero', { ...SCHEDULE, times: ['8:00'] }],
    ['no time at all', { ...SCHEDULE, times: [] }],
    ['nine times', { ...SCHEDULE, times: ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00'] }],
    ['a daily target of 0', { ...SCHEDULE, daily_target: 0 }],
    ['a daily target of 11', { ...SCHEDULE, daily_target: 11 }],
    ['a fractional daily target', { ...SCHEDULE, daily_target: 1.5 }],
    ['weekday 0', { ...SCHEDULE, days: [0, 1] }],
    ['weekday 8', { ...SCHEDULE, days: [8] }],
    ['no enabled flag', { daily_target: 3, days: [1], times: ['08:00'] }],
    ['the camelCase name of the target', { enabled: true, dailyTarget: 3, days: [1], times: ['08:00'] }],
  ])('answers 400 for %s, and keeps the schedule it had', async (_label, body) => {
    await putSettings(SCHEDULE);

    const res = await putSettings(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);

    expect(await (await getSettings()).json()).toEqual({ ...SCHEDULE, time_zone: 'UTC' });
  });
});

describe('PUT /api/me/push-devices', () => {
  it('registers the token for the caller and answers 204 with no body', async () => {
    const res = await register(ANDROID('ExponentPushToken[a]'));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await devicesOf(t.db)).toEqual([{ token: 'ExponentPushToken[a]', userId: me.userId }]);
  });

  it('is idempotent, and a second token is a second phone', async () => {
    expect((await register(ANDROID('ExponentPushToken[a]'))).status).toBe(204);
    expect((await register(ANDROID('ExponentPushToken[a]'))).status).toBe(204);
    expect((await register(ANDROID('ExponentPushToken[b]'))).status).toBe(204);

    expect(await devicesOf(t.db)).toEqual([
      { token: 'ExponentPushToken[a]', userId: me.userId },
      { token: 'ExponentPushToken[b]', userId: me.userId },
    ]);
  });

  it('hands a token to the second learner who registers it: one phone, two accounts', async () => {
    const stranger = await other();
    await register(ANDROID('ExponentPushToken[shared]'));

    const res = await register(ANDROID('ExponentPushToken[shared]'), stranger.cookie);

    expect(res.status).toBe(204);
    expect(await devicesOf(t.db)).toEqual([{ token: 'ExponentPushToken[shared]', userId: stranger.userId }]);
  });

  it.each([
    ['another platform', { token: 'ExponentPushToken[a]', platform: 'ios' }],
    ['no platform', { token: 'ExponentPushToken[a]' }],
    ['an empty token', { token: '', platform: 'android' }],
    ['a token over 256 characters', { token: 't'.repeat(257), platform: 'android' }],
    ['no token', { platform: 'android' }],
  ])('answers 400 for %s, and registers nothing', async (_label, body) => {
    const res = await register(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);
    expect(await devicesOf(t.db)).toEqual([]);
  });
});

describe('POST /api/me/push-devices/unregister', () => {
  it('removes the caller’s own token and answers 204 with no body', async () => {
    await register(ANDROID('ExponentPushToken[a]'));
    await register(ANDROID('ExponentPushToken[b]'));

    const res = await unregister({ token: 'ExponentPushToken[a]' });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await devicesOf(t.db)).toEqual([{ token: 'ExponentPushToken[b]', userId: me.userId }]);
  });

  it('answers 204 for a token nobody registered', async () => {
    expect((await unregister({ token: 'ExponentPushToken[never]' })).status).toBe(204);
  });

  it('leaves another learner’s token alone, and still answers 204', async () => {
    const stranger = await other();
    await register(ANDROID('ExponentPushToken[theirs]'), stranger.cookie);

    const res = await unregister({ token: 'ExponentPushToken[theirs]' });

    expect(res.status).toBe(204);
    expect(await devicesOf(t.db)).toEqual([{ token: 'ExponentPushToken[theirs]', userId: stranger.userId }]);
  });

  it.each([
    ['an empty token', { token: '' }],
    ['a token over 256 characters', { token: 't'.repeat(257) }],
    ['no token', {}],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await unregister(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID);
  });
});

describe('POST /api/me/reminders/{id}/tap', () => {
  it('sets tapped_at on the caller’s own reminder and answers 204 with no body', async () => {
    const id = await seedReminder(t.db, { userId: me.userId });
    expect(await tappedAtOf(t.db, id)).toBeNull();

    const before = Date.now();
    const res = await tap(id);
    const after = Date.now();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const tappedAt = await tappedAtOf(t.db, id);
    expect(tappedAt).toBeInstanceOf(Date);
    expect(tappedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(tappedAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it('keeps the first tap’s time when the notification is tapped again', async () => {
    const id = await seedReminder(t.db, { userId: me.userId });
    const first = new Date('2026-10-14T13:00:05Z');
    await pinTappedAt(t.db, id, first);

    const res = await tap(id);

    expect(res.status).toBe(204);
    expect((await tappedAtOf(t.db, id))!.getTime()).toBe(first.getTime());
  });

  it('answers 404 for someone else’s reminder, and leaves it untapped', async () => {
    const stranger = await other();
    const theirs = await seedReminder(t.db, { userId: stranger.userId });

    const res = await tap(theirs);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(await tappedAtOf(t.db, theirs)).toBeNull();
  });

  it('answers the same 404 for a reminder that does not exist', async () => {
    const res = await tap(UNKNOWN_UUID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it.each([['not-a-uuid'], ['123'], ['3f2b8c1e5a4d4e6f9b7a1c2d3e4f5a6b']])(
    'answers 404, not 500, for the id %j, which is not a uuid',
    async (id) => {
      await seedReminder(t.db, { userId: me.userId });

      const res = await tap(id);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    },
  );
});
