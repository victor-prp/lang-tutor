import { dayInTimeZone } from '../domain/learnerClock';
import type { Repos } from './transaction';

/**
 * Phase 35 (spec D10, ADR 0013 R1). The day a learner's progress counts for,
 * as `YYYY-MM-DD`: the date of `now` in the learner's time zone (phase 52,
 * spec D1; `users.time_zone`, UTC until the app reports one), and the day the
 * profile is on for a bot. The only place a progress day is computed, by the
 * formula in `domain/learnerClock.ts`; the level rule, the memory update and
 * the recompute all read the `practice_day` it wrote.
 *
 * `userId` is the enrollment's owner, not the actor: a tutor practising for a
 * learner counts on the learner's day.
 */
export async function learnerDay(
  repos: Pick<Repos, 'user'>,
  userId: string,
  now: number,
): Promise<string> {
  const context = await repos.user.findDayContext(userId);
  if (!context) throw new Error(`learnerDay: no profile for user ${userId}`);
  if (context.kind === 'bot') return context.day;
  return dayInTimeZone(now, context.timeZone);
}

/**
 * Phase 57 (ruling P4). learnerDay of each instant, the profile read once: a target's
 * created day and its words' added days. A bot's are all its day, as learnerDay's.
 */
export async function learnerDays(repos: Pick<Repos, 'user'>, userId: string, instants: readonly number[]): Promise<string[]> {
  const context = await repos.user.findDayContext(userId);
  if (!context) throw new Error(`learnerDay: no profile for user ${userId}`);
  return instants.map((at) => (context.kind === 'bot' ? context.day : dayInTimeZone(at, context.timeZone)));
}
