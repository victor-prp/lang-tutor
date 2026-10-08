import { and, count, eq, gte, lt, ne } from 'drizzle-orm';

import type { Db } from '../db/client';
import { authCodeSends, authUsers, users } from '../db/schema';
import { createTransaction } from '../db/transaction';
import { isUniqueViolation } from './pgErrors';

// ADR 0001 R4: repo/ may import domain TYPES only, so the one-line rule from
// domain/auth.ts is restated here rather than imported.
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Phase 29. The one place our own code writes auth_* tables (ADR 0009 R2):
 * the send log behind the per-email limit (spec D4), and the claim command's
 * email update (spec D10). Takes the database rather than a transaction, like
 * repo/health.ts: Better Auth's hook and the CLI call it outside any use case.
 */
export function createAuthRepo(db: Db) {
  // ADR 0001 R8: db.transaction is called only inside db/transaction.ts.
  const inTransaction = createTransaction(db, (tx) => tx);
  return {
    countSendsSince: async (email: string, since: Date): Promise<number> => {
      const [row] = await db
        .select({ n: count() })
        .from(authCodeSends)
        .where(and(eq(authCodeSends.email, normalizeEmail(email)), gte(authCodeSends.sentAt, since)));
      return row?.n ?? 0;
    },

    recordSend: async (email: string): Promise<void> => {
      await db.insert(authCodeSends).values({ email: normalizeEmail(email) });
    },

    pruneSendsBefore: async (before: Date): Promise<void> => {
      await db.delete(authCodeSends).where(lt(authCodeSends.sentAt, before));
    },

    claimAccount: async (input: {
      username: string;
      email: string;
    }): Promise<'claimed' | 'no_such_user' | 'email_taken'> => {
      const email = normalizeEmail(input.email);
      try {
        return await inTransaction(async (tx) => {
          const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username));
          if (!user) return 'no_such_user' as const;
          const [holder] = await tx
            .select({ id: authUsers.id })
            .from(authUsers)
            .where(and(eq(authUsers.email, email), ne(authUsers.id, user.id)));
          if (holder) return 'email_taken' as const;
          await tx.update(authUsers).set({ email, updatedAt: new Date() }).where(eq(authUsers.id, user.id));
          return 'claimed' as const;
        });
      } catch (error) {
        if (isUniqueViolation(error)) return 'email_taken';
        throw error;
      }
    },
  };
}

export type AuthRepo = ReturnType<typeof createAuthRepo>;
