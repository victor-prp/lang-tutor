import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';

import { enrollments, pushDevices, reminders, reminderSettings, users } from '../../../src/db/schema';
import type { ReminderSettings } from '../../../src/domain/reminders';
import { createReminderRepo, type ReminderResult } from '../../../src/repo/reminders';
import { seedEnrollment, seedUser, seedUserWithoutEnrollment, setTimeZone } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/** Phase 52 (spec D2, D4, D6). reminder_settings, push_devices and reminders: the repository and the constraints under it. */

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
  await seedUser(t.db, 'u_3');
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createReminderRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createReminderRepo(tx)));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = '2026-10-14';
const SETTINGS: ReminderSettings = { enabled: false, dailyTarget: 3, days: [1, 3, 5], times: ['08:00', '21:30'] };

const devicesOf = () => t.db.select().from(pushDevices).orderBy(pushDevices.token);
const rowOf = async (id: string) => {
  const [row] = await t.db.select().from(reminders).where(eq(reminders.id, id));
  return row;
};
/**
 * A reminder the way the tick leaves it: claimed, then recorded as `outcome`. `at` pins
 * decided_at afterwards: the database stamps microseconds and a Date holds milliseconds, so
 * a test that orders reminders by time names the instants rather than trusting two quick
 * transactions to differ by a whole millisecond.
 */
async function decided(
  userId: string,
  slot: string,
  outcome: ReminderResult = 'sent',
  opts: { day?: string; at?: Date } = {},
): Promise<string> {
  const id = await repo((r) => r.claim({ userId, localDay: opts.day ?? DAY, slot }));
  if (id === null) throw new Error(`slot ${slot} was already claimed`);
  await repo((r) => r.record(id, { outcome, evidence: { slot }, tickets: outcome === 'sent' ? [{ status: 'ok', id: `ticket-${slot}` }] : null }));
  if (opts.at) await t.db.update(reminders).set({ decidedAt: opts.at }).where(eq(reminders.id, id));
  return id;
}
const LONG_AGO = new Date('2020-01-01T00:00:00Z');
/** Moves a device's clocks back, so that a later bump is plainly later. */
const backdateDevice = (token: string) =>
  t.db.update(pushDevices).set({ createdAt: LONG_AGO, lastSeenAt: LONG_AGO }).where(eq(pushDevices.token, token));
describe('reminder settings (D2)', () => {
  it('has none for a learner who never saved a schedule', async () => {
    expect(await repo((r) => r.getSettings('u_1'))).toBeNull();
  });

  it('round-trips a schedule, and a second save replaces the first whole', async () => {
    await repo((r) => r.putSettings('u_1', SETTINGS));
    expect(await repo((r) => r.getSettings('u_1'))).toEqual(SETTINGS);

    const replaced: ReminderSettings = { enabled: true, dailyTarget: 1, days: [], times: ['13:00'] };
    await repo((r) => r.putSettings('u_1', replaced));
    expect(await repo((r) => r.getSettings('u_1'))).toEqual(replaced);
    expect(await t.db.select().from(reminderSettings).where(eq(reminderSettings.userId, 'u_1'))).toHaveLength(1);
  });

  it("keeps each learner's schedule to themselves", async () => {
    await repo((r) => r.putSettings('u_1', SETTINGS));
    expect(await repo((r) => r.getSettings('u_2'))).toBeNull();
  });
});

describe('push devices (D4)', () => {
  it('registers a token for a learner', async () => {
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    expect(await devicesOf()).toMatchObject([{ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }]);
  });

  it('hands a token to the next learner who registers it, and bumps last_seen_at only', async () => {
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    await backdateDevice('ExponentPushToken[a]');

    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_2', platform: 'android' }));
    const rows = await devicesOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('u_2');
    expect(rows[0].createdAt).toEqual(LONG_AGO);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it('bumps last_seen_at when the same learner registers the token again', async () => {
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    await backdateDevice('ExponentPushToken[a]');
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    const rows = await devicesOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("deleteDevice removes the caller's own token and refuses another learner's", async () => {
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));

    await repo((r) => r.deleteDevice({ token: 'ExponentPushToken[a]', userId: 'u_2' }));
    expect(await devicesOf()).toHaveLength(1);

    await repo((r) => r.deleteDevice({ token: 'ExponentPushToken[a]', userId: 'u_1' }));
    expect(await devicesOf()).toEqual([]);
  });

  it('deleteDevice on a token nobody holds is a no-op', async () => {
    await repo((r) => r.deleteDevice({ token: 'ExponentPushToken[ghost]', userId: 'u_1' }));
    expect(await devicesOf()).toEqual([]);
  });

  it("deleteDevicesByToken removes the named tokens whoever holds them, and nothing for an empty list", async () => {
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[b]', userId: 'u_2', platform: 'android' }));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[c]', userId: 'u_2', platform: 'android' }));

    await repo((r) => r.deleteDevicesByToken([]));
    expect(await devicesOf()).toHaveLength(3);

    await repo((r) => r.deleteDevicesByToken(['ExponentPushToken[a]', 'ExponentPushToken[b]', 'ExponentPushToken[ghost]']));
    expect((await devicesOf()).map((d) => d.token)).toEqual(['ExponentPushToken[c]']);
  });
});

describe('candidates (D5)', () => {
  it('lists only learners with a device, with their zone, schedule and tokens', async () => {
    await setTimeZone(t.db, 'u_1', 'Asia/Jerusalem');
    await repo((r) => r.putSettings('u_1', SETTINGS));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[b]', userId: 'u_1', platform: 'android' }));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[c]', userId: 'u_2', platform: 'android' }));
    // u_3 has a schedule and no phone: nobody to remind.
    await repo((r) => r.putSettings('u_3', SETTINGS));

    expect(await repo((r) => r.candidates())).toEqual([
      { userId: 'u_1', timeZone: 'Asia/Jerusalem', settings: SETTINGS, tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'] },
      { userId: 'u_2', timeZone: 'UTC', settings: null, tokens: ['ExponentPushToken[c]'] },
    ]);
  });

  it('is empty when no learner has a device', async () => {
    expect(await repo((r) => r.candidates())).toEqual([]);
  });

  // Final review I2: a tutor with students and no course of their own has nothing to practise.
  it('leaves out a user with a device and no enrollment, and lists them once they own one', async () => {
    await seedUserWithoutEnrollment(t.db, 'u_tutor');
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[t]', userId: 'u_tutor', platform: 'android' }));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));

    expect((await repo((r) => r.candidates())).map((c) => c.userId)).toEqual(['u_1']);

    await seedEnrollment(t.db, { id: 'e_u_tutor', userId: 'u_tutor', targetLanguage: 'en' });
    expect(await repo((r) => r.candidates())).toEqual([
      { userId: 'u_1', timeZone: 'UTC', settings: null, tokens: ['ExponentPushToken[a]'] },
      { userId: 'u_tutor', timeZone: 'UTC', settings: null, tokens: ['ExponentPushToken[t]'] },
    ]);
  });

  it('lists a learner with several enrollments once, with every token', async () => {
    await seedEnrollment(t.db, { id: 'e_u_1_it', userId: 'u_1', targetLanguage: 'it' });
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[b]', userId: 'u_1', platform: 'android' }));

    expect(await repo((r) => r.candidates())).toEqual([
      { userId: 'u_1', timeZone: 'UTC', settings: null, tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'] },
    ]);
  });
});

describe('claim (D5, D6)', () => {
  it('gives an id the first time a slot is claimed and null every time after', async () => {
    const first = await repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' }));
    expect(first).toMatch(UUID);
    expect(await repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' }))).toBeNull();
    expect(await t.db.select().from(reminders)).toHaveLength(1);
  });

  it('leaves the claimed row as the claim made it, stamped by the database', async () => {
    const id = await repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' }));
    const row = await rowOf(id as string);
    expect(row.evidence).toEqual({});
    expect(row).toMatchObject({
      userId: 'u_1',
      localDay: DAY,
      slot: '13:00',
      outcome: 'claimed',
      tickets: null,
      receipts: null,
      receiptsCheckedAt: null,
      tappedAt: null,
      sessionId: null,
    });
    expect(row.decidedAt).toBeInstanceOf(Date);
  });

  it('keys a slot by learner, day and time', async () => {
    const ids = await Promise.all([
      repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' })),
      repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '17:00' })),
      repo((r) => r.claim({ userId: 'u_1', localDay: '2026-10-15', slot: '13:00' })),
      repo((r) => r.claim({ userId: 'u_2', localDay: DAY, slot: '13:00' })),
    ]);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(4);
  });

  it('lets exactly one of two concurrent claims of a slot through', async () => {
    const results = await Promise.all([
      repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' })),
      repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' })),
    ]);
    expect(results.filter((id) => id !== null)).toHaveLength(1);
    expect(await t.db.select().from(reminders)).toHaveLength(1);
  });
});

describe('record (D5, D6)', () => {
  it('writes the outcome, evidence and tickets, and stamps decided_at with the moment it did', async () => {
    const id = (await repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' }))) as string;
    await t.db.update(reminders).set({ decidedAt: LONG_AGO }).where(eq(reminders.id, id));

    const evidence = { completed_today: 0, daily_target: 1, time_zone: 'UTC', devices: 2 };
    const tickets = [{ status: 'ok', id: 't-1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }];
    await repo((r) => r.record(id, { outcome: 'sent', evidence, tickets }));

    const row = await rowOf(id);
    expect(row).toMatchObject({ outcome: 'sent', evidence, tickets });
    expect(row.decidedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it('records a skip with no tickets', async () => {
    const id = await decided('u_1', '13:00', 'skip_target_met');
    expect(await rowOf(id)).toMatchObject({ outcome: 'skip_target_met', tickets: null });
  });

  it('gives two slots decided in turn distinct instants, compared where the microseconds are', async () => {
    await decided('u_1', '13:00');
    await decided('u_1', '17:00');
    const result = await t.db.execute(sql`select count(distinct decided_at)::int as instants from reminders`);
    expect(result.rows).toEqual([{ instants: 2 }]);
  });

  it('refuses an outcome the table does not know', async () => {
    const id = (await repo((r) => r.claim({ userId: 'u_1', localDay: DAY, slot: '13:00' }))) as string;
    await expect(
      repo((r) => r.record(id, { outcome: 'bogus' as unknown as ReminderResult, evidence: {}, tickets: null })),
    ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'reminders_outcome_known' } });
  });
});

describe('markTapped (D6)', () => {
  const AT = new Date('2026-10-14T13:05:00Z');

  it("sets tapped_at on the learner's own reminder and answers true", async () => {
    const id = await decided('u_1', '13:00');
    expect(await repo((r) => r.markTapped({ id, userId: 'u_1', at: AT }))).toBe(true);
    expect((await rowOf(id)).tappedAt).toEqual(AT);
  });

  it('keeps the first tap: a second one answers true and moves nothing', async () => {
    const id = await decided('u_1', '13:00');
    await repo((r) => r.markTapped({ id, userId: 'u_1', at: AT }));
    expect(await repo((r) => r.markTapped({ id, userId: 'u_1', at: new Date('2026-10-14T18:00:00Z') }))).toBe(true);
    expect((await rowOf(id)).tappedAt).toEqual(AT);
  });

  it("answers false for a stranger's reminder and leaves it untapped", async () => {
    const id = await decided('u_1', '13:00');
    expect(await repo((r) => r.markTapped({ id, userId: 'u_2', at: AT }))).toBe(false);
    expect((await rowOf(id)).tappedAt).toBeNull();
  });

  it('answers false for a reminder that does not exist', async () => {
    expect(await repo((r) => r.markTapped({ id: '00000000-0000-4000-8000-000000000052', userId: 'u_1', at: AT }))).toBe(false);
  });
});

describe('sentOnDay and markSession (D6)', () => {
  it("lists the learner's sent reminders of the day, oldest first, with the session each was marked for", async () => {
    const first = await decided('u_1', '13:00', 'sent', { at: new Date('2026-10-14T13:00:30Z') });
    const second = await decided('u_1', '17:00', 'sent', { at: new Date('2026-10-14T17:00:30Z') });
    await decided('u_1', '20:00', 'skip_target_met');
    await decided('u_1', '22:00', 'failed');
    await decided('u_1', '13:00', 'sent', { day: '2026-10-13' });
    await decided('u_2', '13:00');
    await repo((r) => r.markSession(first, 'session-1'));

    const found = await repo((r) => r.sentOnDay('u_1', DAY));
    expect(found).toEqual([
      { id: first, decidedAt: Date.parse('2026-10-14T13:00:30Z'), sessionId: 'session-1' },
      { id: second, decidedAt: Date.parse('2026-10-14T17:00:30Z'), sessionId: null },
    ]);
  });

  it('is empty on a day nothing was sent', async () => {
    await decided('u_1', '13:00', 'skip_target_met');
    expect(await repo((r) => r.sentOnDay('u_1', DAY))).toEqual([]);
  });

  it('leaves a reminder that already has a session with the first one', async () => {
    const id = await decided('u_1', '13:00');
    await repo((r) => r.markSession(id, 'session-1'));
    await repo((r) => r.markSession(id, 'session-2'));
    expect((await rowOf(id)).sessionId).toBe('session-1');
  });
});

describe('receipts (D5)', () => {
  const AT = new Date('2026-10-14T12:00:00Z');
  const minutesBefore = (minutes: number) => new Date(AT.getTime() - minutes * 60_000);
  const range = { olderThan: minutesBefore(15), newerThan: minutesBefore(23 * 60) };
  const decidedMinutesBefore = (id: string, minutes: number) =>
    t.db.update(reminders).set({ decidedAt: minutesBefore(minutes) }).where(eq(reminders.id, id));

  it('finds sent reminders decided between 15 minutes and 23 hours before, not yet checked', async () => {
    const tooFresh = await decided('u_1', '13:00');
    const justOldEnough = await decided('u_1', '14:00');
    const inside = await decided('u_1', '15:00');
    const justTooOld = await decided('u_1', '16:00');
    const checked = await decided('u_1', '17:00');
    const skipped = await decided('u_1', '18:00', 'skip_target_met');
    const failed = await decided('u_1', '19:00', 'failed');
    await decidedMinutesBefore(tooFresh, 14);
    await decidedMinutesBefore(justOldEnough, 15);
    await decidedMinutesBefore(inside, 120);
    await decidedMinutesBefore(justTooOld, 23 * 60);
    await decidedMinutesBefore(checked, 60);
    await decidedMinutesBefore(skipped, 60);
    await decidedMinutesBefore(failed, 60);
    await repo((r) => r.recordReceipts(checked, { 'ticket-17:00': { status: 'ok' } }, AT));

    const found = await repo((r) => r.awaitingReceipts(range));
    // Oldest first; the 15-minute edge is in and the 23-hour edge is out.
    expect(found).toEqual([
      { id: inside, tickets: [{ status: 'ok', id: 'ticket-15:00' }] },
      { id: justOldEnough, tickets: [{ status: 'ok', id: 'ticket-14:00' }] },
    ]);
  });

  it('stores the receipts with the time they were fetched, and stops asking after them', async () => {
    const id = await decided('u_1', '13:00');
    await decidedMinutesBefore(id, 20);
    expect(await repo((r) => r.awaitingReceipts(range))).toHaveLength(1);

    const receipts = { 'ticket-13:00': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } };
    await repo((r) => r.recordReceipts(id, receipts, AT));

    expect(await rowOf(id)).toMatchObject({ receipts, receiptsCheckedAt: AT });
    expect(await repo((r) => r.awaitingReceipts(range))).toEqual([]);
  });
});

describe('the tables (D2, D4, D6)', () => {
  it("takes a learner's settings, devices and reminders with them when the learner goes", async () => {
    await repo((r) => r.putSettings('u_1', SETTINGS));
    await repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_1', platform: 'android' }));
    await decided('u_1', '13:00');
    await decided('u_2', '13:00');

    // A profile is deleted after what hangs off it by a plain foreign key: its enrollment.
    await t.db.delete(enrollments).where(eq(enrollments.userId, 'u_1'));
    await t.db.delete(users).where(eq(users.id, 'u_1'));

    expect(await t.db.select().from(reminderSettings)).toEqual([]);
    expect(await devicesOf()).toEqual([]);
    expect((await t.db.select().from(reminders)).map((row) => row.userId)).toEqual(['u_2']);
  });

  it('refuses a device, settings or reminder for a learner who does not exist', async () => {
    await expect(repo((r) => r.upsertDevice({ token: 'ExponentPushToken[a]', userId: 'u_ghost', platform: 'android' }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
    await expect(repo((r) => r.putSettings('u_ghost', SETTINGS))).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(repo((r) => r.claim({ userId: 'u_ghost', localDay: DAY, slot: '13:00' }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });
});
