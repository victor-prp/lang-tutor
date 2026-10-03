import type { CreateUserRequest, User } from '@lang-tutor/core/api';
import { eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { users } from '../db/schema';
import { UsernameTaken } from '../errors';
import { isUniqueViolation } from './pgErrors';

// The columns are nullable until task 10 tightens them, so the row type is
// wider than User. Anything this function is handed came from an INSERT that
// supplied every field, or from a SELECT filtered to rows that have one.
type UserRow = typeof users.$inferSelect;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username!,
    display_name: row.displayName!,
    age: row.age!,
    native_language: row.nativeLanguage,
  };
}

export function createUserRepo(tx: Tx) {
  return {
    /**
     * Inserts optimistically and lets the unique constraint decide. A
     * check-then-insert would race: the gap between the SELECT and the INSERT
     * is exactly long enough for another transaction to take the username.
     */
    insertUser: async (input: CreateUserRequest): Promise<User> => {
      try {
        const [row] = await tx
          .insert(users)
          .values({
            username: input.username,
            displayName: input.display_name,
            age: input.age,
            nativeLanguage: input.native_language,
          })
          .returning();
        return toUser(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new UsernameTaken(input.username);
        throw error;
      }
    },

    findByUsername: async (username: string): Promise<User | undefined> => {
      const [row] = await tx.select().from(users).where(eq(users.username, username));
      return row ? toUser(row) : undefined;
    },

    findById: async (id: string): Promise<User | undefined> => {
      const [row] = await tx.select().from(users).where(eq(users.id, id));
      return row ? toUser(row) : undefined;
    },
  };
}

export type UserRepo = ReturnType<typeof createUserRepo>;
