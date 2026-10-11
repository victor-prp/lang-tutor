import type { Repos } from './transaction';

/**
 * Phase 35 (spec D10, ADR 0013 R1). The day a learner's progress counts for,
 * as `YYYY-MM-DD`: the UTC date of `now` for a learner, and the day the
 * profile is on for a bot. The only place a progress day is computed; the level
 * rule, the memory update and the recompute all read the `practice_day` it
 * wrote.
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
  return new Date(now).toISOString().slice(0, 10);
}
