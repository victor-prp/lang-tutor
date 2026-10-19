import { and, eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { targetBudgets } from '../db/schema';
import type { TargetBudget } from '../domain/targetBudget';

/**
 * Phase 65 (spec D7.1, D7.2). target_budgets: a target's budget for one learner day, written once
 * in the transaction that starts its path's first session of the day and never rewritten. No row
 * locks: a path has one started session at a time (ADR 0014), so two first starts of one path's
 * day cannot both be writing, and a second insert of a day does nothing.
 */
export function createTargetBudgetRepo(tx: Tx) {
  return {
    /** The target's budget for `day`, if one was set. */
    find: async (targetId: string, day: string): Promise<TargetBudget | undefined> => {
      const [row] = await tx
        .select({
          targetId: targetBudgets.targetId,
          day: targetBudgets.day,
          sessions: targetBudgets.sessions,
          cards: targetBudgets.cards,
          missRoom: targetBudgets.missRoom,
        })
        .from(targetBudgets)
        .where(and(eq(targetBudgets.targetId, targetId), eq(targetBudgets.day, day)));
      return row;
    },

    /** Sets the day's budget; a day already set keeps the one it has. */
    insert: async (budget: TargetBudget): Promise<void> => {
      await tx.insert(targetBudgets).values(budget).onConflictDoNothing({ target: [targetBudgets.targetId, targetBudgets.day] });
    },
  };
}

export type TargetBudgetRepo = ReturnType<typeof createTargetBudgetRepo>;
