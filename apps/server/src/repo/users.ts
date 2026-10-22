import type { CreateUserRequest, User } from '@lang-tutor/core/api';
import { and, eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { users } from '../db/schema';
import { ProfileExists, UsernameTaken } from '../errors';
import { constraintOf, isUniqueViolation } from './pgErrors';

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
    time_zone: row.timeZone,
    tester: row.tester,
  };
}

/**
 * Phase 35 (spec D11). A bot's name (`steady-en`) is kept as its username with
 * each hyphen an underscore (`steady_en`), because the username check allows no
 * hyphen. The bot name format allows no underscore, so two names never share a
 * username. Here alone, so creating a bot and finding one cannot disagree.
 */
const botUsername = (name: string): string => name.replaceAll('-', '_');

/** What a bot profile is given that onboarding would have asked for. */
const BOT_AGE = 30;
const BOT_NATIVE_LANGUAGE = 'he';

export function createUserRepo(tx: Tx) {
  return {
    /**
     * Phase 29 (spec D9). The profile, under the id of the sign-in identity it
     * belongs to. Inserts optimistically and lets the constraints decide. A
     * check-then-insert would race: the gap between the SELECT and the INSERT
     * is exactly long enough for another transaction to take the username, or
     * for a double tap to create the profile twice. The primary key refuses a
     * second profile; the unique username refuses a taken handle.
     */
    insertUser: async (id: string, input: CreateUserRequest): Promise<User> => {
      try {
        const [row] = await tx
          .insert(users)
          .values({
            id,
            username: input.username,
            displayName: input.display_name,
            age: input.age,
            nativeLanguage: input.native_language,
          })
          .returning();
        return toUser(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (constraintOf(error) === 'users_pkey') throw new ProfileExists(id);
          throw new UsernameTaken(input.username);
        }
        throw error;
      }
    },

    /** Phase 35 (spec D10, D11, ADR 0013 R2). What the learner's day depends
     *  on: a learner's is the date in their time zone (phase 52, spec D1), and a
     *  bot has the day it is on. */
    findDayContext: async (
      userId: string,
    ): Promise<{ kind: 'learner'; timeZone: string } | { kind: 'bot'; day: string } | undefined> => {
      const [row] = await tx
        .select({ kind: users.kind, botDay: users.botDay, timeZone: users.timeZone })
        .from(users)
        .where(eq(users.id, userId));
      if (!row) return undefined;
      if (row.kind === 'bot') return { kind: 'bot', day: row.botDay! };
      return { kind: 'learner', timeZone: row.timeZone };
    },

    /** Phase 52 (spec D1). Records the IANA zone the app reported. The caller has
     *  already checked it is one (services/users.ts), and the profile exists
     *  (the session gate), so a row that matches nothing changes nothing. */
    setTimeZone: async (userId: string, timeZone: string): Promise<void> => {
      await tx.update(users).set({ timeZone }).where(eq(users.id, userId));
    },

    /** Phase 70 (spec D1). The new-word limits a profile stores, null for the default; nulls for an
     *  id with no profile (every bot and learner who never chose has nulls too). */
    findNewWordLimits: async (userId: string): Promise<{ dayCap: number | null; perSession: number | null }> => {
      const [row] = await tx
        .select({ dayCap: users.dayNewCap, perSession: users.newPerSession })
        .from(users)
        .where(eq(users.id, userId));
      return row ?? { dayCap: null, perSession: null };
    },

    /** Phase 70 (spec D1). Replaces both limits; the caller stores the default cap as null. */
    setNewWordLimits: async (userId: string, limits: { dayCap: number | null; perSession: number | null }): Promise<void> => {
      await tx.update(users).set({ dayNewCap: limits.dayCap, newPerSession: limits.perSession }).where(eq(users.id, userId));
    },

    /** Phase 52 (spec D2). The zone the learner's schedule is read in: what the app last reported,
     *  UTC until it has. Undefined for an id with no profile. */
    findTimeZone: async (userId: string): Promise<string | undefined> => {
      const [row] = await tx.select({ timeZone: users.timeZone }).from(users).where(eq(users.id, userId));
      return row?.timeZone;
    },

    /**
     * Phase 35 (spec D11). A bot profile under the id of its sign-in identity,
     * on `day`. Only `npm run db:bots:create` calls it (db/bots.ts). A learner
     * holding the username is refused as UsernameTaken, like onboarding.
     */
    insertBot: async (input: { id: string; name: string; day: string }): Promise<void> => {
      try {
        await tx.insert(users).values({
          id: input.id,
          username: botUsername(input.name),
          displayName: input.name,
          age: BOT_AGE,
          nativeLanguage: BOT_NATIVE_LANGUAGE,
          kind: 'bot',
          botDay: input.day,
        });
      } catch (error) {
        if (isUniqueViolation(error) && constraintOf(error) !== 'users_pkey') throw new UsernameTaken(botUsername(input.name));
        throw error;
      }
    },

    /**
     * Phase 35 (spec D12). The profile a bot name names, only if it is a bot:
     * a learner's name finds nothing, exactly like a name nobody has, so the
     * bot route can never reach a learner.
     */
    findBotByName: async (name: string): Promise<{ id: string } | undefined> => {
      const [row] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, botUsername(name)), eq(users.kind, 'bot')));
      return row;
    },

    /**
     * Phase 35 (spec D12, ADR 0013 R2). Puts a bot on `day`. False when the name
     * names no bot, in which case nothing changed. Setting the day it is already
     * on is a no-op that still answers true, so a retried run is harmless.
     */
    setBotDay: async (name: string, day: string): Promise<boolean> => {
      const rows = await tx
        .update(users)
        .set({ botDay: day })
        .where(and(eq(users.username, botUsername(name)), eq(users.kind, 'bot')))
        .returning({ id: users.id });
      return rows.length > 0;
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
