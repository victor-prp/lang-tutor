import { test } from '@playwright/test';

/** How close to the end of the learner's day a date-dependent test does not start. */
const MIDNIGHT_MARGIN_MS = 3 * 60_000;
/** And how far past midnight it waits, so the new day is certainly the server's too. */
const PAST_MIDNIGHT_MS = 5_000;

/**
 * How long to wait before a test that reads the learner's today and then acts on it, or 0: the
 * time left until just past the next UTC midnight when that is under the margin. The e2e learner's
 * day is UTC's (playwright.config.ts, timezoneId), and a test that straddles it acts on a today
 * that has gone: a due date chosen as "the first day after today" is today by the time it is sent,
 * and the server refuses it (CI run 40041866540: targets read at 23:59:58, the create at 00:00:03,
 * 400 due_date).
 */
export function midnightWaitMs(now: number, marginMs = MIDNIGHT_MARGIN_MS): number {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const left = midnight.getTime() - now;
  return left < marginMs ? left + PAST_MIDNIGHT_MS : 0;
}

/** Waits out the end of the learner's day, when it is near, with the test's timeout extended by
 *  the wait. For a beforeEach of a spec whose tests read today and then act on it. */
export async function clearOfMidnight(now = Date.now()): Promise<void> {
  const wait = midnightWaitMs(now);
  if (wait === 0) return;
  test.info().setTimeout(test.info().timeout + wait);
  await new Promise((resolve) => setTimeout(resolve, wait));
}
