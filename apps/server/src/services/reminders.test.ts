import { describe, expect, it } from '@jest/globals';

import {
  createFakeClock,
  createFakeLogger,
  createFakeTransaction,
  createInMemoryUserRepo,
  stub,
} from '../../tests/support/fakes';
import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from '../domain/reminders';
import { ReminderNotFound } from '../errors';
import type { ReminderRepo } from '../repo/reminders';
import { createReminderService } from './reminders';

// The other half of this file's tests is tests/integration/routes/reminders.test.ts, which covers
// what only a real session and Postgres can decide: the gate, the constraints, the 404s.

const UUID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const NOW = Date.parse('2026-10-14T18:30:00Z');

type Tap = { id: string; userId: string; at: Date };

function build(opts: { tapOwners?: Record<string, string> } = {}) {
  const settings = new Map<string, ReminderSettings>();
  const devices = new Map<string, { userId: string; platform: string }>();
  const taps: Tap[] = [];
  const reminders = stub<ReminderRepo>({
    getSettings: async (userId) => settings.get(userId) ?? null,
    putSettings: async (userId, s) => {
      settings.set(userId, s);
    },
    upsertDevice: async ({ token, userId, platform }) => {
      devices.set(token, { userId, platform });
    },
    deleteDevice: async ({ token, userId }) => {
      if (devices.get(token)?.userId === userId) devices.delete(token);
    },
    markTapped: async (input) => {
      taps.push(input);
      return opts.tapOwners?.[input.id] === input.userId;
    },
  });
  const user = createInMemoryUserRepo();
  const logger = createFakeLogger();
  const service = createReminderService({
    transaction: createFakeTransaction({ reminders, user }),
    logger,
    now: createFakeClock(NOW),
  });
  return { service, settings, devices, taps, user, logger };
}

describe('settings', () => {
  it('answers the defaults for a learner who never saved a schedule, and their time zone', async () => {
    const { service, user } = build();
    await user.insertUser('u_dana', { username: 'dana', display_name: 'Dana', age: 30, native_language: 'he' });

    const view = await service.settings('u_dana');

    expect(view).toEqual({ settings: DEFAULT_REMINDER_SETTINGS, timeZone: 'UTC' });
    expect(DEFAULT_REMINDER_SETTINGS).toEqual({
      enabled: true,
      dailyTarget: 1,
      days: [1, 2, 3, 4, 5, 6, 7],
      times: ['13:00', '17:00', '20:00', '22:00'],
    });
  });

  it('hands out a copy of the defaults, so a caller cannot change them for the next learner', async () => {
    const { service } = build();
    const first = await service.settings('u_dana');
    first.settings.times.push('23:59');
    first.settings.days.length = 0;

    expect((await service.settings('u_dana')).settings).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(DEFAULT_REMINDER_SETTINGS.times).toHaveLength(4);
  });

  it("answers the learner's stored schedule and the zone the app reported", async () => {
    const { service, user } = build();
    await user.insertUser('u_dana', { username: 'dana', display_name: 'Dana', age: 30, native_language: 'he' });
    await user.setTimeZone('u_dana', 'Asia/Jerusalem');
    const mine: ReminderSettings = { enabled: false, dailyTarget: 3, days: [2, 4], times: ['08:00'] };
    await service.putSettings('u_dana', mine);

    expect(await service.settings('u_dana')).toEqual({ settings: mine, timeZone: 'Asia/Jerusalem' });
  });

  it('keeps one learner out of another learner’s schedule', async () => {
    const { service } = build();
    await service.putSettings('u_dana', { enabled: false, dailyTarget: 5, days: [1], times: ['06:00'] });

    expect((await service.settings('u_other')).settings).toEqual(DEFAULT_REMINDER_SETTINGS);
  });
});

describe('putSettings', () => {
  it('sorts the days and the times and drops repeats, before storing and in the answer', async () => {
    const { service, settings } = build();
    const unsorted: ReminderSettings = {
      enabled: true,
      dailyTarget: 2,
      days: [5, 1, 3, 1],
      times: ['21:30', '08:00', '21:30', '13:00'],
    };

    const view = await service.putSettings('u_dana', unsorted);

    const expected = { enabled: true, dailyTarget: 2, days: [1, 3, 5], times: ['08:00', '13:00', '21:30'] };
    expect(view.settings).toEqual(expected);
    expect(settings.get('u_dana')).toEqual(expected);
  });

  it('does not change the input it was given', async () => {
    const { service } = build();
    const input: ReminderSettings = { enabled: true, dailyTarget: 1, days: [3, 1], times: ['20:00', '08:00'] };

    await service.putSettings('u_dana', input);

    expect(input).toEqual({ enabled: true, dailyTarget: 1, days: [3, 1], times: ['20:00', '08:00'] });
  });

  it('keeps an empty list of days, which is a schedule that never fires', async () => {
    const { service } = build();
    const view = await service.putSettings('u_dana', { enabled: true, dailyTarget: 1, days: [], times: ['08:00'] });
    expect(view.settings.days).toEqual([]);
  });
});

describe('devices', () => {
  it('registers a token for the caller, and a second learner registering it takes it over', async () => {
    const { service, devices } = build();
    await service.registerDevice('u_dana', { token: 'ExponentPushToken[abc]', platform: 'android' });
    expect(devices.get('ExponentPushToken[abc]')).toEqual({ userId: 'u_dana', platform: 'android' });

    await service.registerDevice('u_other', { token: 'ExponentPushToken[abc]', platform: 'android' });
    expect(devices.get('ExponentPushToken[abc]')).toEqual({ userId: 'u_other', platform: 'android' });
  });

  it('unregisters the caller’s own token, and leaves another learner’s alone', async () => {
    const { service, devices } = build();
    await service.registerDevice('u_dana', { token: 'mine', platform: 'android' });
    await service.registerDevice('u_other', { token: 'theirs', platform: 'android' });

    await service.unregisterDevice('u_dana', 'theirs');
    expect([...devices.keys()].sort()).toEqual(['mine', 'theirs']);

    await service.unregisterDevice('u_dana', 'mine');
    expect([...devices.keys()]).toEqual(['theirs']);
  });
});

describe('tap', () => {
  it('records the tap for the caller at the service’s own clock, and logs it', async () => {
    const { service, taps, logger } = build({ tapOwners: { [UUID]: 'u_dana' } });

    await service.tap('u_dana', UUID);

    expect(taps).toEqual([{ id: UUID, userId: 'u_dana', at: new Date(NOW) }]);
    expect(logger.events).toEqual([{ event: 'reminder_tapped', user_id: 'u_dana', reminder_id: UUID }]);
  });

  it('accepts a uuid in capitals, which Postgres reads as the same uuid', async () => {
    const { service, taps } = build({ tapOwners: { [UUID.toUpperCase()]: 'u_dana' } });
    await service.tap('u_dana', UUID.toUpperCase());
    expect(taps).toHaveLength(1);
  });

  it('is ReminderNotFound when the repository finds no reminder of the caller’s, and logs nothing', async () => {
    const { service, taps, logger } = build({ tapOwners: { [UUID]: 'u_dana' } });

    await expect(service.tap('u_stranger', UUID)).rejects.toBeInstanceOf(ReminderNotFound);

    expect(taps).toHaveLength(1);
    expect(logger.events).toEqual([]);
  });

  it.each([
    ['not-a-uuid'],
    [''],
    ['3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6'],
    ['3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6bb'],
    ['3f2b8c1e5a4d4e6f9b7a1c2d3e4f5a6b'],
    ['3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6g'],
    [`${UUID}; drop table reminders`],
    [` ${UUID}`],
  ])('is ReminderNotFound for %j without asking the repository', async (id) => {
    const { service, taps } = build({ tapOwners: { [UUID]: 'u_dana' } });

    await expect(service.tap('u_dana', id)).rejects.toBeInstanceOf(ReminderNotFound);

    expect(taps).toEqual([]);
  });
});
