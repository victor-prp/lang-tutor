import { asc, eq } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { pushDevices, reminders, sessions } from '../../src/db/schema';
import { createReminderRepo, type ReminderResult } from '../../src/repo/reminders';
import { enrollmentOf } from './seedUser';
import { withTx } from './withTx';

/**
 * Phase 52 (spec D6). A reminder row the way the tick leaves it: claimed, then recorded as
 * `outcome` (sent by default, with a ticket as a send leaves one). tests/support/ is the test
 * composition root, so it may reach the repository and the tables. The tests about a tap, and
 * about what a finished session marks, need a row to aim at without running a tick.
 */
export async function seedReminder(
  db: Db,
  input: { userId: string; localDay?: string; slot?: string; outcome?: ReminderResult },
): Promise<string> {
  const slot = input.slot ?? '13:00';
  const outcome = input.outcome ?? 'sent';
  const id = await withTx(db, (tx) =>
    createReminderRepo(tx).claim({ userId: input.userId, localDay: input.localDay ?? '2026-10-14', slot }),
  );
  if (id === null) throw new Error(`slot ${slot} of ${input.localDay ?? '2026-10-14'} was already claimed`);
  await withTx(db, (tx) =>
    createReminderRepo(tx).record(id, {
      outcome,
      evidence: { slot },
      tickets: outcome === 'sent' ? [{ status: 'ok', id: `ticket-${slot}` }] : null,
    }),
  );
  return id;
}

/** When the reminder was tapped: null until it is. */
export async function tappedAtOf(db: Db, id: string): Promise<Date | null> {
  const [row] = await db.select({ tappedAt: reminders.tappedAt }).from(reminders).where(eq(reminders.id, id));
  if (!row) throw new Error(`no reminder ${id}`);
  return row.tappedAt;
}

/** Sets the tap's time directly, so a test can tell whether a later tap moved it. */
export async function pinTappedAt(db: Db, id: string, at: Date): Promise<void> {
  await db.update(reminders).set({ tappedAt: at }).where(eq(reminders.id, id));
}

/** Every registered device as `{ token, userId }`, in token order. */
export async function devicesOf(db: Db): Promise<{ token: string; userId: string }[]> {
  return db
    .select({ token: pushDevices.token, userId: pushDevices.userId })
    .from(pushDevices)
    .orderBy(asc(pushDevices.token));
}

/** Phase 52 (task 6). A learner's reminder rows as the table holds them, in slot order. */
export async function remindersOf(db: Db, userId: string) {
  return db.select().from(reminders).where(eq(reminders.userId, userId)).orderBy(asc(reminders.slot));
}

/** Every reminder row, whoever's. */
export async function allReminders(db: Db) {
  return db.select().from(reminders).orderBy(asc(reminders.userId), asc(reminders.slot));
}

/**
 * Moves a reminder's decided_at. The database stamps it with its own clock, so a test that pins
 * the tick's clock puts the decision at the tick's instant before it asks about receipts.
 */
export async function pinDecidedAt(db: Db, id: string, at: Date): Promise<void> {
  await db.update(reminders).set({ decidedAt: at }).where(eq(reminders.id, id));
}

/** A session the learner finished on their seeded enrollment, counting for `day`. */
export async function seedCompletedSession(db: Db, input: { userId: string; day: string; completedAt: Date }): Promise<void> {
  await db.insert(sessions).values({
    userId: input.userId,
    enrollmentId: enrollmentOf(input.userId),
    status: 'completed',
    source: 'list',
    completedAt: input.completedAt,
    practiceDay: input.day,
    listening: false,
    speaking: false,
  });
}
