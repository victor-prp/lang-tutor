import type { CreateUserRequest, NewWordLimits, User } from '@lang-tutor/core/api';

import { isTimeZone } from '../domain/learnerClock';
import { limitsOf, storedDayCap } from '../domain/newWordLimits';
import { InvalidTimeZone } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * The application layer for profiles. Four use cases, one transaction each.
 *
 * Phase 29 (ADR 0009): who the user is comes from the session, never from
 * here. Every use case takes the signed-in user's id, which routes/actor.ts
 * read from the session cookie; nothing in this file looks a user up by a name
 * a client typed.
 */
export function createUserService({
  transaction,
  logger,
}: {
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    /** Onboarding: the signed-in user's own profile, under the session's id (spec D9). */
    createProfile: async (actorUserId: string, input: CreateUserRequest): Promise<User> => {
      const created = await transaction(({ user }) => user.insertUser(actorUserId, input));
      // After the transaction resolves, matching logCompletedSession: a commit
      // that fails must not leave a log claiming a profile the database never got.
      logger.info({ event: 'profile_created', user_id: created.id, username: created.username });
      return created;
    },

    /** GET /api/me: the profile, or null until onboarding. */
    me: (actorUserId: string): Promise<User | null> =>
      transaction(async ({ user }) => (await user.findById(actorUserId)) ?? null),

    /** PUT /api/me/time-zone: the IANA zone the app reports on every launch (phase 52, spec D1). */
    setTimeZone: async (actorUserId: string, timeZone: string): Promise<void> => {
      if (!isTimeZone(timeZone)) throw new InvalidTimeZone(timeZone);
      await transaction(({ user }) => user.setTimeZone(actorUserId, timeZone));
    },

    /** GET /api/me/new-words (phase 70, spec D5): the cap in force, and per session or automatic. */
    newWordLimits: (actorUserId: string): Promise<NewWordLimits> =>
      transaction(async ({ user }) => wireLimits(await user.findNewWordLimits(actorUserId))),

    /** PUT /api/me/new-words (phase 70, spec D1, D5): replaces both; the default cap is stored as
     *  null, so the learner keeps following it. Answers what it stored. */
    putNewWordLimits: (actorUserId: string, input: NewWordLimits): Promise<NewWordLimits> =>
      transaction(async ({ user }) => {
        const stored = { dayCap: storedDayCap(input.day_cap), perSession: input.per_session };
        await user.setNewWordLimits(actorUserId, stored);
        return wireLimits(stored);
      }),

    /** The session middleware's profile check. */
    hasProfile: (userId: string): Promise<boolean> =>
      transaction(async ({ user }) => (await user.findById(userId)) !== undefined),
  };
}

/** Phase 70 (spec D5). Stored limits on the wire: the cap in force, per session as chosen. */
function wireLimits(stored: { dayCap: number | null; perSession: number | null }): NewWordLimits {
  const limits = limitsOf(stored);
  return { day_cap: limits.dayCap, per_session: limits.perSession };
}

export type UserService = ReturnType<typeof createUserService>;
