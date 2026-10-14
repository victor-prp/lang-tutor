import { and, asc, count, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { enrollments, pushDevices, reminderSettings, reminders, sessions, users } from '../db/schema';
import type { MarkCandidate, ReminderSettings } from '../domain/reminders';

/** What a tick decides for a slot it has claimed. `claimed` is the claim itself, never a result. */
export type ReminderResult = 'sent' | 'skip_target_met' | 'failed';

/**
 * Phase 52 (spec D2, D4, D6). reminder_settings, push_devices and reminders: a
 * learner's schedule, the phones that can be notified, and the log of what each
 * tick decided. Every function is one persistence step (ADR 0001 R9); the tick
 * and the learner endpoints compose them into use cases.
 */
export function createReminderRepo(tx: Tx) {
  return {
    /** The learner's stored schedule; null when they never saved one, which means the defaults. */
    getSettings: async (userId: string): Promise<ReminderSettings | null> => {
      const [row] = await tx.select().from(reminderSettings).where(eq(reminderSettings.userId, userId));
      if (!row) return null;
      return { enabled: row.enabled, dailyTarget: row.dailyTarget, days: row.days, times: row.times };
    },

    /** Replaces the learner's schedule whole, creating it on the first save. */
    putSettings: async (userId: string, settings: ReminderSettings): Promise<void> => {
      const values = {
        enabled: settings.enabled,
        dailyTarget: settings.dailyTarget,
        days: settings.days,
        times: settings.times,
      };
      await tx
        .insert(reminderSettings)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: reminderSettings.userId, set: { ...values, updatedAt: sql`now()` } });
    },

    /** Registers a token for the learner. A token already held by someone else moves to them
     *  (one phone, two accounts), and a known one is seen again: `last_seen_at` moves, `created_at` stays. */
    upsertDevice: async (input: { token: string; userId: string; platform: string }): Promise<void> => {
      await tx
        .insert(pushDevices)
        .values(input)
        .onConflictDoUpdate({
          target: pushDevices.token,
          set: { userId: input.userId, platform: input.platform, lastSeenAt: sql`now()` },
        });
    },

    /** Removes the learner's own token. Another learner's token is left alone, and so is an unknown one. */
    deleteDevice: async (input: { token: string; userId: string }): Promise<void> => {
      await tx.delete(pushDevices).where(and(eq(pushDevices.token, input.token), eq(pushDevices.userId, input.userId)));
    },

    /** Removes tokens whatever their owner: Expo has said they will never receive again. */
    deleteDevicesByToken: async (tokens: string[]): Promise<void> => {
      if (tokens.length === 0) return;
      await tx.delete(pushDevices).where(inArray(pushDevices.token, tokens));
    },

    /**
     * Every learner with at least one device, in id order: their time zone, their stored
     * schedule (null when they have none), and their tokens in token order. `users` is not
     * a table this repository owns; its time zone is read here and written in repo/users.ts.
     */
    candidates: async (): Promise<
      { userId: string; timeZone: string; settings: ReminderSettings | null; tokens: string[] }[]
    > => {
      const rows = await tx
        .select({
          userId: pushDevices.userId,
          token: pushDevices.token,
          timeZone: users.timeZone,
          enabled: reminderSettings.enabled,
          dailyTarget: reminderSettings.dailyTarget,
          days: reminderSettings.days,
          times: reminderSettings.times,
        })
        .from(pushDevices)
        .innerJoin(users, eq(users.id, pushDevices.userId))
        .leftJoin(reminderSettings, eq(reminderSettings.userId, pushDevices.userId))
        .orderBy(asc(pushDevices.userId), asc(pushDevices.token));
      const byUser = new Map<
        string,
        { userId: string; timeZone: string; settings: ReminderSettings | null; tokens: string[] }
      >();
      for (const row of rows) {
        let candidate = byUser.get(row.userId);
        if (!candidate) {
          // Every settings column is NOT NULL, so a null one means the left join found no row.
          const settings =
            row.enabled === null || row.dailyTarget === null || row.days === null || row.times === null
              ? null
              : { enabled: row.enabled, dailyTarget: row.dailyTarget, days: row.days, times: row.times };
          candidate = { userId: row.userId, timeZone: row.timeZone, settings, tokens: [] };
          byUser.set(row.userId, candidate);
        }
        candidate.tokens.push(row.token);
      }
      return [...byUser.values()];
    },

    /**
     * Claims one slot of one learner's day: inserts it as `claimed`, stamped with the
     * database's `now()`. The new row's id when this call won the slot; null when the slot
     * was already claimed, by an earlier tick or a concurrent one.
     */
    claim: async (input: { userId: string; localDay: string; slot: string }): Promise<string | null> => {
      const [row] = await tx
        .insert(reminders)
        .values({ userId: input.userId, localDay: input.localDay, slot: input.slot, outcome: 'claimed' })
        .onConflictDoNothing({ target: [reminders.userId, reminders.localDay, reminders.slot] })
        .returning({ id: reminders.id });
      return row?.id ?? null;
    },

    /**
     * Sessions the learner completed with `practice_day = day`, across every enrollment they
     * own. A skipped or failed session is not completed, and a tutor finishing a session on
     * the learner's list counts for the learner, whose enrollment it is. Goes through
     * `enrollments` because that is where the learner's rows are indexed: `sessions` has no
     * index on `user_id`, only on `enrollment_id`.
     */
    countCompletedOnDay: async (userId: string, day: string): Promise<number> => {
      const [row] = await tx
        .select({ completed: count() })
        .from(sessions)
        .innerJoin(enrollments, eq(enrollments.id, sessions.enrollmentId))
        .where(and(eq(enrollments.userId, userId), eq(sessions.status, 'completed'), eq(sessions.practiceDay, day)));
      return row?.completed ?? 0;
    },

    /** Writes what the tick decided for a claimed slot, and stamps `decided_at` with the moment it did. */
    record: async (
      id: string,
      result: { outcome: ReminderResult; evidence: unknown; tickets: unknown },
    ): Promise<void> => {
      await tx
        .update(reminders)
        .set({
          outcome: result.outcome,
          evidence: result.evidence ?? {},
          tickets: result.tickets ?? null,
          decidedAt: sql`now()`,
        })
        .where(eq(reminders.id, id));
    },

    /**
     * Marks a reminder tapped, once: the first tap's time stands. False when no reminder with
     * that id belongs to the learner, whether it is someone else's or does not exist, so the
     * caller cannot tell the two apart. A repeated tap on their own is true.
     */
    markTapped: async (input: { id: string; userId: string; at: Date }): Promise<boolean> => {
      const rows = await tx
        .update(reminders)
        .set({ tappedAt: sql`coalesce(${reminders.tappedAt}, ${input.at.toISOString()}::timestamptz)` })
        .where(and(eq(reminders.id, input.id), eq(reminders.userId, input.userId)))
        .returning({ id: reminders.id });
      return rows.length > 0;
    },

    /** The learner's `sent` reminders of `day`, oldest first, with the session each was marked for. */
    sentOnDay: async (userId: string, day: string): Promise<MarkCandidate[]> => {
      const rows = await tx
        .select({ id: reminders.id, decidedAt: reminders.decidedAt, sessionId: reminders.sessionId })
        .from(reminders)
        .where(and(eq(reminders.userId, userId), eq(reminders.localDay, day), eq(reminders.outcome, 'sent')))
        .orderBy(asc(reminders.decidedAt), asc(reminders.id));
      return rows.map((row) => ({ id: row.id, decidedAt: row.decidedAt.getTime(), sessionId: row.sessionId }));
    },

    /** Gives a reminder the session that finished after it. A reminder that has one keeps it: the first stands. */
    markSession: async (id: string, sessionId: string): Promise<void> => {
      await tx
        .update(reminders)
        .set({ sessionId })
        .where(and(eq(reminders.id, id), isNull(reminders.sessionId)));
    },

    /** `sent` reminders whose receipts were not fetched yet and that were decided at or before
     *  `olderThan` (Expo needs a while to produce receipts) and after `newerThan` (it keeps them
     *  about a day), oldest first. */
    awaitingReceipts: async (input: { olderThan: Date; newerThan: Date }): Promise<{ id: string; tickets: unknown }[]> => {
      return tx
        .select({ id: reminders.id, tickets: reminders.tickets })
        .from(reminders)
        .where(
          and(
            eq(reminders.outcome, 'sent'),
            isNull(reminders.receiptsCheckedAt),
            lte(reminders.decidedAt, input.olderThan),
            gt(reminders.decidedAt, input.newerThan),
          ),
        )
        .orderBy(asc(reminders.decidedAt), asc(reminders.id));
    },

    /** Stores the receipts fetched for a reminder and when, so it is not asked about again. */
    recordReceipts: async (id: string, receipts: unknown, at: Date): Promise<void> => {
      await tx
        .update(reminders)
        .set({ receipts: receipts ?? null, receiptsCheckedAt: at })
        .where(eq(reminders.id, id));
    },
  };
}

export type ReminderRepo = ReturnType<typeof createReminderRepo>;
