import { and, count, eq, gte, lt, ne } from 'drizzle-orm';

import type { Db } from '../db/client';
import { authCodeSends, authUsers, users } from '../db/schema';
import { createTransaction } from '../db/transaction';
import { isUniqueViolation } from './pgErrors';

// ADR 0001 R4: repo/ may import domain TYPES only, so the one-line rules from
// domain/auth.ts are restated here rather than imported.
const normalizeEmail = (email: string): string => email.trim().toLowerCase();
/** Migration 0022's placeholder identities end in `.invalid`; a claimed one does not. */
const isUnclaimed = (email: string): boolean => normalizeEmail(email).endsWith('.invalid');

export type ClaimOutcome = 'claimed' | 'no_such_user' | 'already_claimed' | 'email_taken';

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

    /**
     * Ruling 10. Only an unclaimed account is claimed. An address already held
     * by an identity with no profile (someone signed in on the new build
     * before the claim and never onboarded) is taken over: that identity goes,
     * its sessions and accounts by cascade. An address whose identity has a
     * profile is refused. `email_verified` stays false; the first code sign-in
     * verifies it.
     */
    claimAccount: async (input: { username: string; email: string }): Promise<ClaimOutcome> => {
      const email = normalizeEmail(input.email);
      try {
        return await inTransaction(async (tx): Promise<ClaimOutcome> => {
          const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username));
          if (!user) return 'no_such_user';
          const [identity] = await tx.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, user.id));
          if (!identity || !isUnclaimed(identity.email)) return 'already_claimed';
          const [holder] = await tx
            .select({ id: authUsers.id, profile: users.id })
            .from(authUsers)
            .leftJoin(users, eq(users.id, authUsers.id))
            .where(and(eq(authUsers.email, email), ne(authUsers.id, user.id)));
          if (holder?.profile) return 'email_taken';
          if (holder) await tx.delete(authUsers).where(eq(authUsers.id, holder.id));
          await tx.update(authUsers).set({ email, updatedAt: new Date() }).where(eq(authUsers.id, user.id));
          return 'claimed';
        });
      } catch (error) {
        if (isUniqueViolation(error)) return 'email_taken';
        throw error;
      }
    },
  };
}

export type AuthRepo = ReturnType<typeof createAuthRepo>;
