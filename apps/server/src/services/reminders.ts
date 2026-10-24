import { REMIND } from '../domain/jobs';
import { isTimeZone } from '../domain/learnerClock';
import {
  chooseReminder,
  DEFAULT_REMINDER_SETTINGS,
  dueSlots,
  normalizeSettings,
  pathEvidence,
  REMINDER_CHANNEL,
  reminderMessage,
  type ReminderPath,
  type ReminderSettings,
} from '../domain/reminders';
import { PushUnavailable, ReminderNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * One notification for one phone. `data` reaches the app when the learner taps it. `priority`
 * is Expo's: on Android 'high' is FCM high priority, which Doze lets through at once, where
 * the default ('normal') may wait for a maintenance window.
 */
export type PushMessage = {
  to: string;
  title: string;
  body: string;
  channelId: string;
  priority: 'default' | 'normal' | 'high';
  /** Phase 75 (spec D5). Android: a notification under the same tag replaces the one shown. */
  tag?: string;
  /** Phase 75 (spec D4). A picture by URL, which Android shows on the notification's side. */
  richContent?: { image: string };
  data: Record<string, string>;
};

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

/** What one tick did, logged as its summary line. */
export type TickSummary = { candidates: number; claimed: number; sent: number; skipped: number; failed: number };

/** Expo needs a while to produce a receipt, and keeps it about a day: the tick asks for receipts
 *  of reminders sent between these two ages, once. */
const RECEIPTS_AFTER_MS = 15 * 60_000;
const RECEIPTS_UNTIL_MS = 23 * 60 * 60_000;

/** Expo's word for a token that will never receive again: its device is deleted. */
const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

const goneFor = (answer: PushTicket | PushReceipt | undefined): boolean =>
  answer?.status === 'error' && answer.details?.error === DEVICE_NOT_REGISTERED;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Phase 75 (spec D5). One tag for every reminder: the newest replaces the one in the shade. */
const REMINDER_TAG = 'reminder';

/**
 * The tickets Expo accepted, out of a sent reminder's stored ones: each ticket's id, and the
 * token the tick stored beside it, because a receipt names only the ticket and a
 * DeviceNotRegistered receipt must find its device. Read defensively: the column is jsonb.
 */
function acceptedTickets(tickets: unknown): { id: string; to: string | null }[] {
  if (!Array.isArray(tickets)) return [];
  return tickets.flatMap((ticket: unknown) => {
    if (typeof ticket !== 'object' || ticket === null) return [];
    const { status, id, to } = ticket as { status?: unknown; id?: unknown; to?: unknown };
    return status === 'ok' && typeof id === 'string' ? [{ id, to: typeof to === 'string' ? to : null }] : [];
  });
}

/** A learner who never saved a schedule has the defaults, copied so no caller can change them. */
const defaults = (): ReminderSettings => ({
  ...DEFAULT_REMINDER_SETTINGS,
  days: [...DEFAULT_REMINDER_SETTINGS.days],
  times: [...DEFAULT_REMINDER_SETTINGS.times],
});

/**
 * Phase 52 (spec D2, D4, D5, D6). Practice reminders: a learner's own schedule, the phones
 * that can be notified, the report that a notification was tapped, and the tick that sends
 * them. The learner's use cases are one transaction each (ADR 0001 R8), take the signed-in
 * user's id and touch only their rows (ADR 0009 R7): a schedule and a device are the caller's
 * by construction, and a reminder is found only under the caller's id, so a stranger's is as
 * absent as a missing one. The tick acts for no one and reads every learner with a phone.
 */
export function createReminderService({
  transaction,
  push,
  logger,
  now,
  paths,
  imageBaseUrl,
}: {
  transaction: Transaction;
  // The tick sends through it; the learner's use cases do not.
  push: PushSender;
  logger: Logger;
  // The tap's moment and the tick's. The repository takes them from here, not from its own
  // clock, so a test that pins the clock pins the stored instant and the slots that are due.
  now: () => number;
  /** Phase 75 (spec D1). A learner's paths today, read as home reads them (reminderPaths.ts):
   *  each read its own transaction, between the slot's claim and its record. */
  paths: (userId: string) => Promise<ReminderPath[]>;
  /** Phase 75 (spec D4). Where the side pictures are served (Config.reminderImageBaseUrl);
   *  null sends none. */
  imageBaseUrl: string | null;
}) {
  /**
   * Receipts for reminders sent between 15 minutes and 23 hours before `at`, not yet fetched:
   * one call for all of them, then each reminder stores its own, and the devices Expo says are
   * gone are deleted with it. Whatever fails here, the tick logs, and the reminders not yet
   * stored are asked about again by the next tick.
   */
  async function fetchReceipts(at: number): Promise<void> {
    const awaiting = await transaction(({ reminders }) =>
      reminders.awaitingReceipts({ olderThan: new Date(at - RECEIPTS_AFTER_MS), newerThan: new Date(at - RECEIPTS_UNTIL_MS) }),
    );
    if (awaiting.length === 0) return;
    const rows = awaiting.map((row) => ({ id: row.id, tickets: acceptedTickets(row.tickets) }));
    const ids = rows.flatMap((row) => row.tickets.map((ticket) => ticket.id));

    const receipts = ids.length > 0 ? await push.receipts(ids) : {};

    for (const row of rows) {
      const mine: Record<string, PushReceipt> = {};
      const gone: string[] = [];
      for (const ticket of row.tickets) {
        const receipt = receipts[ticket.id];
        if (receipt === undefined) continue;
        mine[ticket.id] = receipt;
        if (goneFor(receipt) && ticket.to !== null) gone.push(ticket.to);
      }
      await transaction(async ({ reminders }) => {
        await reminders.recordReceipts(row.id, mine, new Date(at));
        await reminders.deleteDevicesByToken(gone);
      });
    }
  }

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

    /**
     * POST /api/internal/reminders/tick (spec D5): asks for one run of the reminder job. The
     * queue is exclusive under this key, so a tick while a run is queued or active adds nothing.
     */
    requestTick: (): Promise<void> => transaction(({ jobs }) => jobs.enqueue(REMIND, {}, { singletonKey: REMIND })),

    /**
     * The `remind` job (spec D5, D6). Every learner with a phone: each slot of their schedule
     * that is due now is claimed, decided, sent or skipped, and recorded. Then the receipts of
     * reminders sent a while ago are fetched. One learner's failure is logged and the next
     * learner is still reminded.
     *
     * Phase 75 (spec D1–D5): what is decided is which path the reminder is about, over the
     * learner's paths as home reads them; a slot with nothing owed anywhere is skipped.
     *
     * The claim and the result are two transactions with the reads and the push call between
     * them, never one held across them (ADR 0001 R8): each is idempotent, and a run that dies between them
     * leaves the slot `claimed`, which no later run claims again. That costs one reminder,
     * never a duplicate.
     */
    tick: async (): Promise<TickSummary> => {
      const at = now();
      const summary: TickSummary = { candidates: 0, claimed: 0, sent: 0, skipped: 0, failed: 0 };
      const candidates = await transaction(({ reminders }) => reminders.candidates());
      summary.candidates = candidates.length;

      for (const { userId, timeZone, settings: stored, tokens } of candidates) {
        try {
          // A zone the runtime does not know would make every clock read throw. The route that
          // stores one checks it; this is for a row that got one another way.
          if (!isTimeZone(timeZone)) {
            logger.info({ event: 'reminder_time_zone_invalid', user_id: userId, time_zone: timeZone });
            continue;
          }
          const settings = stored ?? DEFAULT_REMINDER_SETTINGS;
          for (const { localDay, slot } of dueSlots(settings, timeZone, at)) {
            const id = await transaction(({ reminders }) => reminders.claim({ userId, localDay, slot }));
            if (id === null) continue;
            summary.claimed += 1;
            const base = { time_zone: timeZone, devices: tokens.length };

            // Phase 75 (spec D1, D5). The day as home reads it. A read that fails is the slot's
            // failure, as a push that fails is: the next slot reads again.
            let day: ReminderPath[];
            try {
              day = await paths(userId);
            } catch (error) {
              await transaction(({ reminders }) =>
                reminders.record(id, { outcome: 'failed', evidence: { ...base, error: reasonOf(error) }, tickets: null }),
              );
              summary.failed += 1;
              continue;
            }

            // Spec D2, D3. The most pressing path, in the cards' words; nothing owed anywhere skips
            // the slot, under phase 52's name for "the day's work is met".
            const choice = chooseReminder(day);
            const withLanguage = new Set(day.map((path) => path.enrollmentId)).size > 1;
            const message = choice === null ? null : reminderMessage(choice, { withLanguage });
            const evidence = {
              ...base,
              paths: day.map(pathEvidence),
              chosen:
                choice === null || message === null
                  ? null
                  : {
                      enrollment_id: choice.path.enrollmentId,
                      target_id: choice.path.kind === 'my_words' ? null : choice.path.targetId,
                      kind: choice.path.kind,
                      rank: choice.rank,
                      ...message,
                    },
            };
            if (choice === null || message === null) {
              await transaction(({ reminders }) => reminders.record(id, { outcome: 'skip_target_met', evidence, tickets: null }));
              summary.skipped += 1;
              continue;
            }

            // Spec D6: the tap opens this path, so the data names it.
            const data: Record<string, string> = { reminder_id: id, enrollment_id: choice.path.enrollmentId };
            if (choice.path.kind !== 'my_words') data.target_id = choice.path.targetId;
            let tickets: PushTicket[];
            try {
              tickets = await push.send(
                tokens.map((to) => ({
                  to,
                  title: message.title,
                  body: message.body,
                  channelId: REMINDER_CHANNEL,
                  // A reminder is for a given hour: an idle phone must not hold it back (final review M1).
                  priority: 'high',
                  tag: REMINDER_TAG,
                  ...(imageBaseUrl === null ? {} : { richContent: { image: `${imageBaseUrl}/${message.image}.png` } }),
                  data,
                })),
              );
            } catch (error) {
              if (!(error instanceof PushUnavailable)) throw error;
              await transaction(({ reminders }) =>
                reminders.record(id, {
                  outcome: 'failed',
                  evidence: { ...evidence, error: error.message },
                  tickets: null,
                }),
              );
              summary.failed += 1;
              continue;
            }
            // The provider answers one ticket per message, in order, so a ticket's token is the
            // one at its position.
            const gone = tokens.filter((_, index) => goneFor(tickets[index]));
            await transaction(async ({ reminders }) => {
              await reminders.record(id, {
                outcome: 'sent',
                evidence,
                tickets: tickets.map((ticket, index) => ({ ...ticket, to: tokens[index] })),
              });
              await reminders.deleteDevicesByToken(gone);
            });
            summary.sent += 1;
          }
        } catch (error) {
          logger.info({ event: 'reminder_tick_error', user_id: userId, error: reasonOf(error) });
        }
      }

      try {
        await fetchReceipts(at);
      } catch (error) {
        // A push service that cannot answer, or a write that failed: the sends above stand, and
        // every reminder whose receipts were not stored is still awaiting them.
        logger.info({ event: 'reminder_receipts_error', error: reasonOf(error) });
      }
      logger.info({ event: 'reminder_tick', ...summary });
      return summary;
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;
