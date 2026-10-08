import type { CreateUserRequest, User } from '@lang-tutor/core/api';

import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * The application layer for profiles. Three use cases, one transaction each.
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

    /** The session middleware's profile check. */
    hasProfile: (userId: string): Promise<boolean> =>
      transaction(async ({ user }) => (await user.findById(userId)) !== undefined),
  };
}

export type UserService = ReturnType<typeof createUserService>;
