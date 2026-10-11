import { UserNotFound } from '../errors';
import type { Transaction } from './transaction';

/**
 * Phase 35 (spec D12). A session for a user, as the `Cookie` header value that
 * carries it. Satisfied by auth/betterAuth.ts's `mintSession`, which only
 * composition.ts may name (ADR 0001 R13).
 */
export type MintSession = (userId: string) => Promise<string>;

/**
 * Phase 35 (spec D12). The bot route's two use cases. Both act on a bot
 * profile only: a name that names a learner is UserNotFound, exactly like a
 * name nobody has, so nothing here can sign anyone in as a learner or move a
 * learner's day. The secret is the route's to check, before either is called.
 */
export function createBotService({ transaction, mintSession }: { transaction: Transaction; mintSession: MintSession }) {
  return {
    /** POST /api/bots/sign-in: a normal Better Auth session for the bot `name`. */
    signIn: async (name: string): Promise<{ cookie: string }> => {
      const bot = await transaction(({ user }) => user.findBotByName(name));
      if (!bot) throw new UserNotFound(name);
      return { cookie: await mintSession(bot.id) };
    },

    /** PUT /api/bots/day: puts the bot on `day`. The same day again is a no-op. */
    setDay: async (name: string, day: string): Promise<void> => {
      const found = await transaction(({ user }) => user.setBotDay(name, day));
      if (!found) throw new UserNotFound(name);
    },
  };
}

export type BotService = ReturnType<typeof createBotService>;
