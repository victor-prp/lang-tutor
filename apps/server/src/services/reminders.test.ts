import { describe, expect, it } from '@jest/globals';

import {
  createFakeClock,
  createFakeJobRepo,
  createFakeLogger,
  createFakeTransaction,
  createInMemoryUserRepo,
  stub,
} from '../../tests/support/fakes';
import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from '../domain/reminders';
import { PushUnavailable, ReminderNotFound } from '../errors';
import type { ReminderRepo, ReminderResult } from '../repo/reminders';
import {
  createReminderService,
  type PushMessage,
  type PushReceipt,
  type PushSender,
  type PushTicket,
} from './reminders';
import type { Transaction } from './transaction';

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
    // The learner's use cases send nothing; a call to the stub would fail the test.
    push: stub<PushSender>({}),
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

// ---------------------------------------------------------------------------------------------
// The tick (spec D5, D6). The decision logic, with every collaborator faked: what is claimed,
// counted, sent, recorded and deleted, and in which transactions. The other half is
// tests/integration/services/reminders.tick.test.ts, against Postgres and MockServer.

/** Wednesday 2026-10-14, 13:05 UTC: the default 13:00 slot is due for a learner in UTC. */
const AT = Date.parse('2026-10-14T13:05:00Z');
const TITLE = 'Time to practise';
const BODY = 'A few minutes now keeps your words fresh.';

type Candidate = Awaited<ReturnType<ReminderRepo['candidates']>>[number];
type Recorded = { id: string; outcome: ReminderResult; evidence: unknown; tickets: unknown };

const learner = (userId: string, overrides: Partial<Candidate> = {}): Candidate => ({
  userId,
  timeZone: 'UTC',
  settings: null,
  tokens: [`ExponentPushToken[${userId}]`],
  ...overrides,
});

/** Accepts every message, under a ticket id that names its token. */
const acceptAll = async (messages: PushMessage[]): Promise<PushTicket[]> =>
  messages.map((message) => ({ status: 'ok', id: `ticket-${message.to}` }));

function buildTick(opts: {
  candidates: Candidate[];
  /** Completed sessions by learner, on whatever day is asked. */
  completed?: Record<string, number>;
  /** `userId|day|slot` keys an earlier tick already claimed. */
  claimed?: string[];
  /** A learner whose claim throws this. */
  claimFails?: Record<string, Error>;
  send?: (messages: PushMessage[]) => Promise<PushTicket[]>;
  awaiting?: { id: string; tickets: unknown }[];
  receipts?: (ids: string[]) => Promise<Record<string, PushReceipt>>;
  at?: number;
}) {
  const claims: { userId: string; localDay: string; slot: string; id: string }[] = [];
  const counted: { userId: string; day: string }[] = [];
  const records: Recorded[] = [];
  const deleted: string[] = [];
  const awaitingAsked: { olderThan: Date; newerThan: Date }[] = [];
  const receiptRecords: { id: string; receipts: unknown; at: Date }[] = [];
  const sends: PushMessage[][] = [];
  const receiptAsks: string[][] = [];
  const taken = new Set(opts.claimed ?? []);

  const reminders = stub<ReminderRepo>({
    candidates: async () => opts.candidates,
    claim: async ({ userId, localDay, slot }) => {
      const failure = opts.claimFails?.[userId];
      if (failure) throw failure;
      const key = `${userId}|${localDay}|${slot}`;
      if (taken.has(key)) return null;
      taken.add(key);
      const id = `r-${claims.length + 1}`;
      claims.push({ userId, localDay, slot, id });
      return id;
    },
    countCompletedOnDay: async (userId, day) => {
      counted.push({ userId, day });
      return opts.completed?.[userId] ?? 0;
    },
    record: async (id, result) => {
      records.push({ id, ...result });
    },
    deleteDevicesByToken: async (tokens) => {
      deleted.push(...tokens);
    },
    awaitingReceipts: async (input) => {
      awaitingAsked.push(input);
      return opts.awaiting ?? [];
    },
    recordReceipts: async (id, receipts, at) => {
      receiptRecords.push({ id, receipts, at });
    },
  });
  const jobs = createFakeJobRepo();

  // Which repository steps each transaction ran, in order: the shape ADR 0001 R8 asks for.
  const transactions: string[][] = [];
  const transaction: Transaction = (run) => {
    const steps: string[] = [];
    transactions.push(steps);
    const tracked = new Proxy(reminders, {
      get: (target, property) => {
        const method = (target as Record<string | symbol, unknown>)[property] as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          steps.push(String(property));
          return method(...args);
        };
      },
    });
    return createFakeTransaction({ reminders: tracked, jobs })(run);
  };

  const push: PushSender = {
    send: async (messages) => {
      sends.push(messages);
      return (opts.send ?? acceptAll)(messages);
    },
    receipts: async (ids) => {
      receiptAsks.push(ids);
      return opts.receipts ? opts.receipts(ids) : {};
    },
  };
  const logger = createFakeLogger();
  const service = createReminderService({ transaction, push, logger, now: createFakeClock(opts.at ?? AT) });
  return {
    service,
    claims,
    counted,
    records,
    deleted,
    awaitingAsked,
    receiptRecords,
    sends,
    receiptAsks,
    transactions,
    jobs,
    logger,
  };
}

const summaryOf = (logger: ReturnType<typeof createFakeLogger>) => logger.events.filter((e) => e.event === 'reminder_tick');

describe('requestTick', () => {
  it('queues one run of the remind job, with no payload, under the singleton key remind', async () => {
    const { service, jobs } = buildTick({ candidates: [] });

    await service.requestTick();

    expect(jobs.enqueued).toEqual([{ name: 'remind', data: {}, options: { singletonKey: 'remind' } }]);
  });
});

describe('tick: a slot that is due', () => {
  it('sends one message per phone, then records the reminder sent with each ticket beside its token', async () => {
    const dana = learner('u_dana', { tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'] });
    const { service, claims, sends, records, deleted } = buildTick({ candidates: [dana] });

    const summary = await service.tick();

    expect(claims).toEqual([{ userId: 'u_dana', localDay: '2026-10-14', slot: '13:00', id: 'r-1' }]);
    expect(sends).toEqual([
      [
        { to: 'ExponentPushToken[a]', title: TITLE, body: BODY, channelId: 'reminders', data: { reminder_id: 'r-1' } },
        { to: 'ExponentPushToken[b]', title: TITLE, body: BODY, channelId: 'reminders', data: { reminder_id: 'r-1' } },
      ],
    ]);
    expect(records).toEqual([
      {
        id: 'r-1',
        outcome: 'sent',
        evidence: { completed_today: 0, daily_target: 1, time_zone: 'UTC', devices: 2 },
        tickets: [
          { status: 'ok', id: 'ticket-ExponentPushToken[a]', to: 'ExponentPushToken[a]' },
          { status: 'ok', id: 'ticket-ExponentPushToken[b]', to: 'ExponentPushToken[b]' },
        ],
      },
    ]);
    expect(deleted).toEqual([]);
    expect(summary).toEqual({ candidates: 1, claimed: 1, sent: 1, skipped: 0, failed: 0 });
  });

  it('claims and counts in one transaction, and records and deletes in another, with the send between them', async () => {
    const { service, transactions } = buildTick({ candidates: [learner('u_dana')] });

    await service.tick();

    expect(transactions).toEqual([
      ['candidates'],
      ['claim', 'countCompletedOnDay'],
      ['record', 'deleteDevicesByToken'],
      ['awaitingReceipts'],
    ]);
  });

  it("reads the slot and the day on the learner's own clock, and counts that day's sessions", async () => {
    // 13:05 UTC is 03:05 the next day in Kiritimati (UTC+14), and 16:05 in Jerusalem (UTC+3).
    const east = learner('u_east', {
      timeZone: 'Pacific/Kiritimati',
      settings: { enabled: true, dailyTarget: 1, days: [4], times: ['03:00', '13:00'] },
    });
    const israel = learner('u_il', {
      timeZone: 'Asia/Jerusalem',
      settings: { enabled: true, dailyTarget: 1, days: [3], times: ['13:00', '16:00'] },
    });
    const { service, claims, counted, records } = buildTick({ candidates: [east, israel] });

    await service.tick();

    expect(claims).toEqual([
      { userId: 'u_east', localDay: '2026-10-15', slot: '03:00', id: 'r-1' },
      { userId: 'u_il', localDay: '2026-10-14', slot: '16:00', id: 'r-2' },
    ]);
    expect(counted).toEqual([
      { userId: 'u_east', day: '2026-10-15' },
      { userId: 'u_il', day: '2026-10-14' },
    ]);
    expect(records.map((r) => (r.evidence as { time_zone: string }).time_zone)).toEqual(['Pacific/Kiritimati', 'Asia/Jerusalem']);
  });

  it('skips a slot whose daily target is met: the evidence is recorded and nothing is sent', async () => {
    const dana = learner('u_dana', { settings: { enabled: true, dailyTarget: 2, days: [3], times: ['13:00'] } });
    const { service, sends, records, deleted } = buildTick({ candidates: [dana], completed: { u_dana: 2 } });

    const summary = await service.tick();

    expect(sends).toEqual([]);
    expect(records).toEqual([
      {
        id: 'r-1',
        outcome: 'skip_target_met',
        evidence: { completed_today: 2, daily_target: 2, time_zone: 'UTC', devices: 1 },
        tickets: null,
      },
    ]);
    expect(deleted).toEqual([]);
    expect(summary).toEqual({ candidates: 1, claimed: 1, sent: 0, skipped: 1, failed: 0 });
  });

  it('still sends to a learner one session short of a target above one', async () => {
    const dana = learner('u_dana', { settings: { enabled: true, dailyTarget: 3, days: [3], times: ['13:00'] } });
    const { service, records } = buildTick({ candidates: [dana], completed: { u_dana: 2 } });

    await service.tick();

    expect(records).toMatchObject([{ outcome: 'sent', evidence: { completed_today: 2, daily_target: 3 } }]);
  });

  it('decides nothing for a slot an earlier tick claimed: no count, no send, no record', async () => {
    const { service, counted, sends, records } = buildTick({
      candidates: [learner('u_dana')],
      claimed: ['u_dana|2026-10-14|13:00'],
    });

    const summary = await service.tick();

    expect(counted).toEqual([]);
    expect(sends).toEqual([]);
    expect(records).toEqual([]);
    expect(summary).toEqual({ candidates: 1, claimed: 0, sent: 0, skipped: 0, failed: 0 });
  });
});

describe('tick: what is never claimed', () => {
  // Review focus 4.
  it('claims nothing for a learner with reminders off, or with no day chosen', async () => {
    const off = learner('u_off', { settings: { ...DEFAULT_REMINDER_SETTINGS, enabled: false } });
    const noDays = learner('u_nodays', { settings: { ...DEFAULT_REMINDER_SETTINGS, days: [] } });
    const { service, claims, sends, transactions } = buildTick({ candidates: [off, noDays] });

    const summary = await service.tick();

    expect(claims).toEqual([]);
    expect(sends).toEqual([]);
    expect(transactions).toEqual([['candidates'], ['awaitingReceipts']]);
    expect(summary).toEqual({ candidates: 2, claimed: 0, sent: 0, skipped: 0, failed: 0 });
  });

  it('claims nothing between slots', async () => {
    const { service, claims } = buildTick({ candidates: [learner('u_dana')], at: Date.parse('2026-10-14T13:30:00Z') });
    await service.tick();
    expect(claims).toEqual([]);
  });
});

describe('tick: one learner going wrong', () => {
  // Review focus 2.
  it('records a send Expo refused as failed, with the error, and still reminds the next learner', async () => {
    let calls = 0;
    const { service, records, logger } = buildTick({
      candidates: [learner('u_a'), learner('u_b')],
      send: async (messages) => {
        calls += 1;
        if (calls === 1) throw new PushUnavailable(500);
        return acceptAll(messages);
      },
    });

    const summary = await service.tick();

    expect(records).toEqual([
      {
        id: 'r-1',
        outcome: 'failed',
        evidence: { completed_today: 0, daily_target: 1, time_zone: 'UTC', devices: 1, error: 'push service unavailable (500)' },
        tickets: null,
      },
      {
        id: 'r-2',
        outcome: 'sent',
        evidence: { completed_today: 0, daily_target: 1, time_zone: 'UTC', devices: 1 },
        tickets: [{ status: 'ok', id: 'ticket-ExponentPushToken[u_b]', to: 'ExponentPushToken[u_b]' }],
      },
    ]);
    expect(summary).toEqual({ candidates: 2, claimed: 2, sent: 1, skipped: 0, failed: 1 });
    expect(logger.events.filter((e) => e.event === 'reminder_tick_error')).toEqual([]);
  });

  it('records a timed-out send as failed too', async () => {
    const { service, records } = buildTick({
      candidates: [learner('u_a')],
      send: async () => {
        throw new PushUnavailable('timeout');
      },
    });
    await service.tick();
    expect(records).toMatchObject([{ outcome: 'failed', evidence: { error: 'push service unavailable (timeout)' } }]);
  });

  // Review focus 1.
  it('logs and skips a learner whose stored zone is not a time zone, and reminds the rest', async () => {
    const { service, claims, records, logger } = buildTick({
      candidates: [learner('u_a'), learner('u_mars', { timeZone: 'Mars/Olympus' }), learner('u_b')],
    });

    const summary = await service.tick();

    expect(claims.map((c) => c.userId)).toEqual(['u_a', 'u_b']);
    expect(records.map((r) => r.outcome)).toEqual(['sent', 'sent']);
    expect(logger.events).toContainEqual({ event: 'reminder_time_zone_invalid', user_id: 'u_mars', time_zone: 'Mars/Olympus' });
    expect(logger.events.filter((e) => e.event === 'reminder_tick_error')).toEqual([]);
    expect(summary).toEqual({ candidates: 3, claimed: 2, sent: 2, skipped: 0, failed: 0 });
  });

  it('logs a learner whose claim throws, and goes on to the next', async () => {
    const { service, records, logger } = buildTick({
      candidates: [learner('u_a'), learner('u_b')],
      claimFails: { u_a: new Error('connection reset') },
    });

    await service.tick();

    expect(logger.events).toContainEqual({ event: 'reminder_tick_error', user_id: 'u_a', error: 'connection reset' });
    expect(records).toMatchObject([{ outcome: 'sent', tickets: [{ to: 'ExponentPushToken[u_b]' }] }]);
  });

  it('leaves the slot claimed, and records nothing, when the send fails in a way that is not the push service', async () => {
    let calls = 0;
    const { service, claims, records, logger } = buildTick({
      candidates: [learner('u_a'), learner('u_b')],
      send: async (messages) => {
        calls += 1;
        if (calls === 1) throw new TypeError('not a function');
        return acceptAll(messages);
      },
    });

    const summary = await service.tick();

    expect(claims.map((c) => c.id)).toEqual(['r-1', 'r-2']);
    expect(records.map((r) => r.id)).toEqual(['r-2']);
    expect(logger.events).toContainEqual({ event: 'reminder_tick_error', user_id: 'u_a', error: 'not a function' });
    expect(summary).toEqual({ candidates: 2, claimed: 2, sent: 1, skipped: 0, failed: 0 });
  });
});

describe('tick: phones Expo says are gone', () => {
  it('deletes the device a DeviceNotRegistered ticket is for, and only that one', async () => {
    const dana = learner('u_dana', {
      tokens: ['ExponentPushToken[gone]', 'ExponentPushToken[busy]', 'ExponentPushToken[fine]'],
    });
    const tickets: PushTicket[] = [
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
      { status: 'ok', id: 'ticket-fine' },
    ];
    const { service, records, deleted } = buildTick({ candidates: [dana], send: async () => tickets });

    await service.tick();

    expect(deleted).toEqual(['ExponentPushToken[gone]']);
    expect(records).toMatchObject([
      {
        outcome: 'sent',
        tickets: [
          { status: 'error', details: { error: 'DeviceNotRegistered' }, to: 'ExponentPushToken[gone]' },
          { status: 'error', details: { error: 'MessageRateExceeded' }, to: 'ExponentPushToken[busy]' },
          { status: 'ok', id: 'ticket-fine', to: 'ExponentPushToken[fine]' },
        ],
      },
    ]);
  });
});

describe('tick: receipts', () => {
  const DNR: PushReceipt = { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } };

  it('asks once for the receipts of reminders sent 15 minutes to 23 hours ago, and stores each its own', async () => {
    const { service, awaitingAsked, receiptAsks, receiptRecords, deleted } = buildTick({
      candidates: [],
      awaiting: [
        {
          id: 'r-old-1',
          tickets: [
            { status: 'ok', id: 't-1', to: 'ExponentPushToken[a]' },
            { status: 'ok', id: 't-2', to: 'ExponentPushToken[b]' },
          ],
        },
        {
          id: 'r-old-2',
          tickets: [
            { status: 'ok', id: 't-3', to: 'ExponentPushToken[c]' },
            { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' }, to: 'ExponentPushToken[d]' },
          ],
        },
      ],
      receipts: async () => ({ 't-1': { status: 'ok' }, 't-2': DNR, 't-3': { status: 'ok' } }),
    });

    await service.tick();

    expect(awaitingAsked).toEqual([
      { olderThan: new Date('2026-10-14T12:50:00Z'), newerThan: new Date('2026-10-13T14:05:00Z') },
    ]);
    expect(receiptAsks).toEqual([['t-1', 't-2', 't-3']]);
    expect(receiptRecords).toEqual([
      { id: 'r-old-1', receipts: { 't-1': { status: 'ok' }, 't-2': DNR }, at: new Date(AT) },
      { id: 'r-old-2', receipts: { 't-3': { status: 'ok' } }, at: new Date(AT) },
    ]);
    // A receipt's DeviceNotRegistered deletes its token; an error ticket was dealt with at send.
    expect(deleted).toEqual(['ExponentPushToken[b]']);
  });

  it('stores each reminder with its receipts and the devices they delete, in one transaction per reminder', async () => {
    const { service, transactions } = buildTick({
      candidates: [],
      awaiting: [
        { id: 'r-old-1', tickets: [{ status: 'ok', id: 't-1', to: 'ExponentPushToken[a]' }] },
        { id: 'r-old-2', tickets: [{ status: 'ok', id: 't-2', to: 'ExponentPushToken[b]' }] },
      ],
      receipts: async () => ({ 't-1': { status: 'ok' }, 't-2': { status: 'ok' } }),
    });

    await service.tick();

    expect(transactions).toEqual([
      ['candidates'],
      ['awaitingReceipts'],
      ['recordReceipts', 'deleteDevicesByToken'],
      ['recordReceipts', 'deleteDevicesByToken'],
    ]);
  });

  it('asks Expo nothing when no reminder is waiting', async () => {
    const { service, receiptAsks, receiptRecords } = buildTick({ candidates: [] });
    await service.tick();
    expect(receiptAsks).toEqual([]);
    expect(receiptRecords).toEqual([]);
  });

  it('marks a reminder with no accepted ticket checked, without asking Expo', async () => {
    const { service, receiptAsks, receiptRecords } = buildTick({
      candidates: [],
      awaiting: [{ id: 'r-old', tickets: [{ status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } }] }],
    });
    await service.tick();
    expect(receiptAsks).toEqual([]);
    expect(receiptRecords).toEqual([{ id: 'r-old', receipts: {}, at: new Date(AT) }]);
  });

  it('stores the receipt of a ticket kept without its token, and deletes nothing for it', async () => {
    const { service, receiptRecords, deleted } = buildTick({
      candidates: [],
      awaiting: [{ id: 'r-old', tickets: [{ status: 'ok', id: 't-1' }] }],
      receipts: async () => ({ 't-1': DNR }),
    });
    await service.tick();
    expect(receiptRecords).toEqual([{ id: 'r-old', receipts: { 't-1': DNR }, at: new Date(AT) }]);
    expect(deleted).toEqual([]);
  });

  it('leaves every reminder for the next tick when Expo cannot answer, and still logs the summary', async () => {
    const { service, receiptRecords, deleted, logger } = buildTick({
      candidates: [learner('u_dana')],
      awaiting: [{ id: 'r-old', tickets: [{ status: 'ok', id: 't-1', to: 'ExponentPushToken[a]' }] }],
      receipts: async () => {
        throw new PushUnavailable('timeout');
      },
    });

    const summary = await service.tick();

    expect(receiptRecords).toEqual([]);
    expect(deleted).toEqual([]);
    expect(logger.events).toContainEqual({ event: 'reminder_receipts_error', error: 'push service unavailable (timeout)' });
    expect(summary.sent).toBe(1);
    expect(summaryOf(logger)).toHaveLength(1);
  });
});

describe('tick: the summary', () => {
  it('logs one line, last, with what the tick claimed, sent, skipped and failed', async () => {
    let calls = 0;
    const { service, logger } = buildTick({
      candidates: [learner('u_sent'), learner('u_met'), learner('u_failed'), learner('u_mars', { timeZone: 'Mars/Olympus' })],
      completed: { u_met: 1 },
      send: async (messages) => {
        calls += 1;
        if (calls === 2) throw new PushUnavailable(503);
        return acceptAll(messages);
      },
    });

    await service.tick();

    expect(summaryOf(logger)).toEqual([{ event: 'reminder_tick', candidates: 4, claimed: 3, sent: 1, skipped: 1, failed: 1 }]);
    expect(logger.events[logger.events.length - 1]).toEqual(summaryOf(logger)[0]);
  });
});
