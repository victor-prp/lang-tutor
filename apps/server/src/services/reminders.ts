import { DEFAULT_REMINDER_SETTINGS, normalizeSettings, type ReminderSettings } from '../domain/reminders';
import { ReminderNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/** One notification for one phone. `data` reaches the app when the learner taps it. */
export type PushMessage = { to: string; title: string; body: string; channelId: string; data: Record<string, string> };

/** What the push service answers a message with: accepted for delivery under an id, or refused. */
export type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

/** What the push service later says of a delivery the ticket accepted. */
export type PushReceipt = { status: 'ok' } | { status: 'error'; message: string; details?: { error?: string } };

/**
 * Phase 52 (spec D7). The push service as the tick sees it. Declared here, not in the provider
 * that satisfies it, because providers/ may not be imported by a consumer (ADR 0001 R11):
 * composition.ts is where `createExpoPushClient` is checked against it. Both methods throw
 * PushUnavailable when the service cannot be reached or does not answer in time.
 */
export type PushSender = {
  /** One ticket per message, in the order the messages came. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** The receipts the service has so far, by ticket id; an id it has none for yet is absent. */
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
};

/** A learner's schedule and the zone its times are read in. */
export type ReminderView = { settings: ReminderSettings; timeZone: string };

// What Postgres accepts for a uuid, spelled out: the id arrives in a path, and a string that
// is not one would reach the `uuid` column as error 22P02 and answer 500 instead of 404.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A learner who never saved a schedule has the defaults, copied so no caller can change them. */
const defaults = (): ReminderSettings => ({
  ...DEFAULT_REMINDER_SETTINGS,
  days: [...DEFAULT_REMINDER_SETTINGS.days],
  times: [...DEFAULT_REMINDER_SETTINGS.times],
});

/**
 * Phase 52 (spec D2, D4, D6). Practice reminders: a learner's own schedule, the phones that
 * can be notified, and the report that a notification was tapped. One transaction each
 * (ADR 0001 R8). Every use case takes the signed-in user's id and touches only their rows
 * (ADR 0009 R7): a schedule and a device are the caller's by construction, and a reminder
 * is found only under the caller's id, so a stranger's is as absent as a missing one.
 */
export function createReminderService({
  transaction,
  logger,
  now,
}: {
  transaction: Transaction;
  // The tick sends through it; the learner's use cases below do not.
  push: PushSender;
  logger: Logger;
  // The tap's moment. The repository takes it from here, not from its own clock, so a test
  // that pins the clock pins the stored instant.
  now: () => number;
}) {
  return {
    /** GET /api/me/reminders: the stored schedule, or the defaults, and the learner's time zone. */
    settings: (actorUserId: string): Promise<ReminderView> =>
      transaction(async ({ reminders, user }) => ({
        settings: (await reminders.getSettings(actorUserId)) ?? defaults(),
        timeZone: (await user.findTimeZone(actorUserId)) ?? 'UTC',
      })),

    /** PUT /api/me/reminders: replaces the schedule whole, days and times sorted and distinct. */
    putSettings: (actorUserId: string, input: ReminderSettings): Promise<ReminderView> => {
      const settings = normalizeSettings(input);
      return transaction(async ({ reminders, user }) => {
        await reminders.putSettings(actorUserId, settings);
        return { settings, timeZone: (await user.findTimeZone(actorUserId)) ?? 'UTC' };
      });
    },

    /** PUT /api/me/push-devices: the token is the caller's from now on, whoever held it before. */
    registerDevice: (actorUserId: string, input: { token: string; platform: string }): Promise<void> =>
      transaction(({ reminders }) => reminders.upsertDevice({ token: input.token, userId: actorUserId, platform: input.platform })),

    /** POST /api/me/push-devices/unregister: the caller's own token goes; anyone else's stays. */
    unregisterDevice: (actorUserId: string, token: string): Promise<void> =>
      transaction(({ reminders }) => reminders.deleteDevice({ token, userId: actorUserId })),

    /**
     * POST /api/me/reminders/{id}/tap: the first tap's time stands. ReminderNotFound for an id
     * that is not the caller's, that does not exist, or that is not a uuid, which never reaches
     * the database.
     */
    tap: async (actorUserId: string, id: string): Promise<void> => {
      if (!UUID.test(id)) throw new ReminderNotFound(id);
      const found = await transaction(({ reminders }) =>
        reminders.markTapped({ id, userId: actorUserId, at: new Date(now()) }),
      );
      if (!found) throw new ReminderNotFound(id);
      // After the transaction resolves, as logCompletedSession: a commit that fails must not
      // leave a log of a tap the database never got.
      logger.info({ event: 'reminder_tapped', user_id: actorUserId, reminder_id: id });
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;
