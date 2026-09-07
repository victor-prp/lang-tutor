import type { CreateUserRequest, User } from '@lang-tutor/core/api';

import { InvalidLanguagePair, UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * The application layer for identity. Two use cases, one transaction each.
 *
 * There is no authentication here and there is not meant to be: `login` looks a
 * username up and returns the profile. Anything that needs to *authorize* an
 * action must not build on this — see ADR 0005.
 */
export function createUserService({
  transaction,
  logger,
}: {
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    register: async (input: CreateUserRequest): Promise<User> => {
      // Checked before a transaction is opened: no write is attempted, so
      // there is nothing to roll back. The database CHECK is the backstop for
      // anything that reaches the table by another route.
      if (input.native_language === input.target_language) {
        throw new InvalidLanguagePair(input.native_language);
      }

      const created = await transaction(({ user }) => user.insertUser(input));

      // After the transaction resolves, matching logCompletedSession: a commit
      // that fails must not leave a log claiming a user the database never got.
      logger.info({
        event: 'user_registered',
        user_id: created.id,
        username: created.username,
      });
      return created;
    },

    login: (username: string): Promise<User> =>
      transaction(async ({ user }) => {
        const found = await user.findByUsername(username);
        if (!found) throw new UserNotFound(username);
        return found;
      }),
  };
}

export type UserService = ReturnType<typeof createUserService>;
