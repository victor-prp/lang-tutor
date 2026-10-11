import { BotDayRequestSchema, BotNameSchema } from '@lang-tutor/core/api/schemas';

import { UsernameTaken } from '../errors';
import { createBotIdentityRepo } from '../repo/auth';
import { createUserRepo } from '../repo/users';
import type { Db } from './client';
import { createTransaction } from './transaction';

const DaySchema = BotDayRequestSchema.shape.day;

/** Phase 35 (spec D11). Where a bot's address lives: reserved, so no mail reaches it. */
const botEmail = (name: string): string => `${name}@bots.invalid`;

export type CreateBotsOutcome = { created: string[]; existing: string[] };

/**
 * Phase 35 (spec D11, ruling 4). `npm run db:bots:create -- --day <day> <names…>`,
 * the only way a bot profile comes to exist. Each bot gets a sign-in identity
 * (repo/auth.ts, ADR 0009 R2) and a profile with `kind = 'bot'` on `day`
 * (repo/users.ts, ADR 0009 R6), all names in one transaction: a refusal creates
 * none of the batch.
 *
 * Idempotent: a name that already is a bot is reported as existing and left
 * alone, its day included. A name whose username a learner holds is refused.
 */
export async function createBots(db: Db, input: { names: string[]; day: string }): Promise<CreateBotsOutcome> {
  if (input.names.length === 0) throw new Error('no bot names given');
  for (const name of input.names) {
    if (!BotNameSchema.safeParse(name).success) {
      throw new Error(`not a bot name: ${JSON.stringify(name)} (lowercase letters, digits and hyphens, 3 to 30)`);
    }
  }
  if (!DaySchema.safeParse(input.day).success) throw new Error(`not a day: ${JSON.stringify(input.day)} (YYYY-MM-DD)`);

  const names = [...new Set(input.names)];
  const inTransaction = createTransaction(db, (tx) => ({
    identity: createBotIdentityRepo(tx),
    user: createUserRepo(tx),
  }));
  return inTransaction(async ({ identity, user }) => {
    const outcome: CreateBotsOutcome = { created: [], existing: [] };
    for (const name of names) {
      if (await user.findBotByName(name)) {
        outcome.existing.push(name);
        continue;
      }
      const id = await identity.insertIdentity({ name, email: botEmail(name) });
      try {
        await user.insertBot({ id, name, day: input.day });
      } catch (error) {
        if (error instanceof UsernameTaken) throw new Error(`${name}: a learner already has the username ${error.username}`);
        throw error;
      }
      outcome.created.push(name);
    }
    return outcome;
  });
}
