import type { CreateUserRequest, User } from '@lang-tutor/core/api';
import { eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { users } from '../db/schema';
import { UsernameTaken } from '../errors';

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
    target_language: row.targetLanguage,
  };
}

/**
 * Drizzle 0.45 wraps a driver error in a DrizzleQueryError whose `cause` is the
 * pg error carrying `code`; other paths throw the pg error directly. Walking the
 * chain is correct under both, and stays correct if another wrapper is added.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error; current != null; ) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
            targetLanguage: input.target_language,
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
