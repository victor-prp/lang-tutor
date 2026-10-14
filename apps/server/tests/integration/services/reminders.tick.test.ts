import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { ReminderService } from '../../../src/services/reminders';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  mockNamespace,
  pushBaseUrlFor,
  pushReceiptRequests,
  pushSends,
  stubPushReceipts,
  stubPushSend,
} from '../../support/mockServer';
import { allReminders, devicesOf, pinDecidedAt, remindersOf, seedCompletedSession } from '../../support/reminderRows';
import { seedUser, setTimeZone } from '../../support/seedUser';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 52 (spec D5, D6). The tick against Postgres and a faked Expo, through the service
// production assembles. The decision logic, case by case, is src/services/reminders.test.ts's;
// this is the proof that the claim, the count, the send and the record meet in the database.
//
// The clock is pinned in the past on purpose. The database stamps decided_at with its own
// clock, so a reminder this suite sends was decided "now", long after the pinned tick: no
// receipt sweep picks it up unless a test moves its decided_at to the tick's instant, which
// the receipts test does.

const ZONE = 'Asia/Jerusalem';
/** Wednesday 2026-09-02, 10:05 UTC: 13:05 in Jerusalem (UTC+3), five minutes into the 13:00 slot. */
const AT = Date.parse('2026-09-02T10:05:00Z');
const DAY = '2026-09-02';
const minutes = (n: number) => n * 60_000;
const TITLE = 'Time to practise';
const BODY = 'A few minutes now keeps your words fresh.';
const DNR = { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } as const;

let t: TestDb;
let ns: string;
let clock: number;
let logger: FakeLogger;
let service: ReminderService;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('reminder-tick');
  clock = AT;
  logger = createFakeLogger();
  service = createTestServerDeps({
    db: t.db,
    logger,
    rng: testRng(52),
    now: () => clock,
    pushBaseUrl: pushBaseUrlFor(ns),
  }).reminders;
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const tokenOf = (id: string) => `ExponentPushToken[${id}]`;

/** A learner in Jerusalem with one phone, registered as the app registers it. */
async function learnerWithPhone(id: string, token = tokenOf(id)): Promise<void> {
  await seedUser(t.db, id);
  await setTimeZone(t.db, id, ZONE);
  await service.registerDevice(id, { token, platform: 'android' });
}

const rowsOf = (userId: string) => remindersOf(t.db, userId);
const ticks = () => logger.events.filter((e) => e.event === 'reminder_tick');
const completedSessionOn = (userId: string, day: string) =>
  seedCompletedSession(t.db, { userId, day, completedAt: new Date(AT - minutes(60)) });

describe('the tick', () => {
  it("reminds a learner whose slot is due on their clock: one push naming the reminder, and the row sent with its ticket", async () => {
    await learnerWithPhone('u_1');
    await stubPushSend(ns, [{ status: 'ok', id: 'ticket-1' }]);

    await service.tick();

    const rows = await rowsOf('u_1');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(await pushSends(ns)).toEqual([
      { to: tokenOf('u_1'), title: TITLE, body: BODY, channelId: 'reminders', data: { reminder_id: row.id } },
    ]);
    expect(row).toMatchObject({
      localDay: DAY,
      slot: '13:00',
      outcome: 'sent',
      evidence: { completed_today: 0, daily_target: 1, time_zone: ZONE, devices: 1 },
      tickets: [{ status: 'ok', id: 'ticket-1', to: tokenOf('u_1') }],
      receipts: null,
      receiptsCheckedAt: null,
    });
    expect(ticks()).toEqual([{ event: 'reminder_tick', candidates: 1, claimed: 1, sent: 1, skipped: 0, failed: 0 }]);
  });

  it('skips a learner who already finished a session that day, with the evidence, and asks Expo nothing', async () => {
    await learnerWithPhone('u_1');
    await completedSessionOn('u_1', DAY);

    await service.tick();

    const rows = await rowsOf('u_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      localDay: DAY,
      slot: '13:00',
      outcome: 'skip_target_met',
      evidence: { completed_today: 1, daily_target: 1, time_zone: ZONE, devices: 1 },
      tickets: null,
    });
    expect(await pushSends(ns)).toEqual([]);
  });

  it('counts only that day: a session finished the day before does not skip the reminder', async () => {
    await learnerWithPhone('u_1');
    await completedSessionOn('u_1', '2026-09-01');
    await stubPushSend(ns, [{ status: 'ok', id: 'ticket-1' }]);

    await service.tick();

    expect((await rowsOf('u_1'))[0]).toMatchObject({ outcome: 'sent', evidence: { completed_today: 0 } });
  });

  it('decides a slot once: a second tick at 13:10 sends nothing more and writes no new row', async () => {
    await learnerWithPhone('u_1');
    await stubPushSend(ns, [{ status: 'ok', id: 'ticket-1' }]);

    await service.tick();
    clock = AT + minutes(5);
    await service.tick();

    expect(await pushSends(ns)).toHaveLength(1);
    expect(await rowsOf('u_1')).toHaveLength(1);
    expect(ticks()).toEqual([
      { event: 'reminder_tick', candidates: 1, claimed: 1, sent: 1, skipped: 0, failed: 0 },
      { event: 'reminder_tick', candidates: 1, claimed: 0, sent: 0, skipped: 0, failed: 0 },
    ]);
  });

  // Review focus 2.
  it('records a send Expo answers 500 to as failed, with the error, and the next learner in the same tick is still sent', async () => {
    await learnerWithPhone('u_1');
    await learnerWithPhone('u_2');
    // Every send succeeds, except the first, which is u_1's: the tick goes through learners in id order.
    await stubPushSend(ns, [{ status: 'ok', id: 'ticket-2' }]);
    await stubPushSend(ns, [], { status: 500, times: 1 });

    await service.tick();

    expect((await pushSends(ns)).map((message) => message.to)).toEqual([tokenOf('u_1'), tokenOf('u_2')]);
    const [failed] = await rowsOf('u_1');
    expect(failed).toMatchObject({
      outcome: 'failed',
      evidence: { completed_today: 0, daily_target: 1, time_zone: ZONE, devices: 1, error: 'push service unavailable (500)' },
      tickets: null,
    });
    const [sent] = await rowsOf('u_2');
    expect(sent).toMatchObject({ outcome: 'sent', tickets: [{ status: 'ok', id: 'ticket-2', to: tokenOf('u_2') }] });
    expect(ticks()).toEqual([{ event: 'reminder_tick', candidates: 2, claimed: 2, sent: 1, skipped: 0, failed: 1 }]);
  });

  // Review focus 1.
  it('skips a learner whose stored zone is not a time zone, and the others are sent', async () => {
    await learnerWithPhone('u_1');
    await learnerWithPhone('u_2');
    await learnerWithPhone('u_3');
    // The route refuses such a zone, so it can only arrive another way: straight into the table.
    await setTimeZone(t.db, 'u_2', 'Mars/Olympus');
    await stubPushSend(ns, [{ status: 'ok', id: 'ticket' }]);

    await service.tick();

    expect(await rowsOf('u_2')).toEqual([]);
    expect((await rowsOf('u_1')).map((row) => row.outcome)).toEqual(['sent']);
    expect((await rowsOf('u_3')).map((row) => row.outcome)).toEqual(['sent']);
    expect((await pushSends(ns)).map((message) => message.to)).toEqual([tokenOf('u_1'), tokenOf('u_3')]);
    expect(logger.events).toContainEqual({ event: 'reminder_time_zone_invalid', user_id: 'u_2', time_zone: 'Mars/Olympus' });
    expect(logger.events.filter((e) => e.event === 'reminder_tick_error')).toEqual([]);
  });

  // Review focus 4.
  it('claims no row for a learner with reminders off, or with no day chosen', async () => {
    await learnerWithPhone('u_1');
    await learnerWithPhone('u_2');
    await service.putSettings('u_1', { enabled: false, dailyTarget: 1, days: [1, 2, 3, 4, 5, 6, 7], times: ['13:00'] });
    await service.putSettings('u_2', { enabled: true, dailyTarget: 1, days: [], times: ['13:00'] });

    await service.tick();

    expect(await allReminders(t.db)).toEqual([]);
    expect(await pushSends(ns)).toEqual([]);
    expect(ticks()).toEqual([{ event: 'reminder_tick', candidates: 2, claimed: 0, sent: 0, skipped: 0, failed: 0 }]);
  });
});

describe('phones Expo says are gone', () => {
  it("deletes the device a DeviceNotRegistered ticket is for, and keeps the learner's other one", async () => {
    await learnerWithPhone('u_1', 'ExponentPushToken[a]');
    await service.registerDevice('u_1', { token: 'ExponentPushToken[b]', platform: 'android' });
    // The tokens are sent in token order, and a ticket answers the message at its position.
    await stubPushSend(ns, [DNR, { status: 'ok', id: 'ticket-b' }]);

    await service.tick();

    expect(await devicesOf(t.db)).toEqual([{ token: 'ExponentPushToken[b]', userId: 'u_1' }]);
    expect((await rowsOf('u_1'))[0]).toMatchObject({
      outcome: 'sent',
      evidence: { devices: 2 },
      tickets: [
        { ...DNR, to: 'ExponentPushToken[a]' },
        { status: 'ok', id: 'ticket-b', to: 'ExponentPushToken[b]' },
      ],
    });
  });

  it('stores the receipts twenty minutes on, deletes the device a DeviceNotRegistered receipt is for, and asks only once', async () => {
    await learnerWithPhone('u_1', 'ExponentPushToken[a]');
    await service.registerDevice('u_1', { token: 'ExponentPushToken[b]', platform: 'android' });
    await stubPushSend(ns, [
      { status: 'ok', id: 'ticket-a' },
      { status: 'ok', id: 'ticket-b' },
    ]);
    await service.tick();
    const [sent] = await rowsOf('u_1');
    // The database stamped decided_at with its own clock; put it at the tick's instant.
    await pinDecidedAt(t.db, sent.id, new Date(AT));

    const receipts = { 'ticket-a': { status: 'ok' as const }, 'ticket-b': DNR };
    await stubPushReceipts(ns, receipts);
    clock = AT + minutes(20);
    await service.tick();

    const [checked] = await rowsOf('u_1');
    expect(checked.receipts).toEqual(receipts);
    expect(checked.receiptsCheckedAt).toEqual(new Date(AT + minutes(20)));
    expect(await devicesOf(t.db)).toEqual([{ token: 'ExponentPushToken[a]', userId: 'u_1' }]);
    expect(await pushReceiptRequests(ns)).toEqual([['ticket-a', 'ticket-b']]);

    clock = AT + minutes(25);
    await service.tick();
    expect(await pushReceiptRequests(ns)).toHaveLength(1);
    // The 13:00 slot was still due at 13:25, and was not sent again.
    expect(await pushSends(ns)).toHaveLength(2);
  });
});
