import type { Dimension } from '@lang-tutor/core/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { targetReadiness, targetReadinessEvents } from '../db/schema';
import type { TargetReadinessEvent, TargetReadinessRow } from '../domain/readinessWrite';

/**
 * Phase 65 (spec D2, D3). target_readiness and its log: written when a session ends, in its
 * transaction, and rebuilt by the recompute. No row locks, as target_skills (repo/targetSkills.ts).
 */
export function createTargetReadinessRepo(tx: Tx) {
  return {
    /** The rows of these targets about these glosses; a skill with no row has not been answered. */
    findRows: async (targetIds: readonly string[], glossIds: readonly string[]): Promise<TargetReadinessRow[]> => {
      if (targetIds.length === 0 || glossIds.length === 0) return [];
      const rows = await tx
        .select()
        .from(targetReadiness)
        .where(and(inArray(targetReadiness.targetId, [...targetIds]), inArray(targetReadiness.glossId, [...glossIds])))
        .orderBy(asc(targetReadiness.targetId), asc(targetReadiness.glossId), asc(targetReadiness.dimension));
      return rows.map((row) => ({
        targetId: row.targetId,
        glossId: row.glossId,
        dimension: row.dimension as Dimension,
        sessionId: row.sessionId,
        row: {
          state: {
            stability: row.stability,
            difficulty: row.difficulty,
            lastDay: row.lastDay,
            reps: row.reps,
            lapses: row.lapses,
            params: row.params,
          },
          day: row.day,
          missedToday: row.missedToday,
          bonusUsed: row.bonusUsed,
          held: row.held,
        },
      }));
    },

    /** Each row's value, and the session that set it. */
    upsertRows: async (rows: readonly TargetReadinessRow[]): Promise<void> => {
      if (rows.length === 0) return;
      await tx
        .insert(targetReadiness)
        .values(
          rows.map((entry) => ({
            targetId: entry.targetId,
            glossId: entry.glossId,
            dimension: entry.dimension,
            stability: entry.row.state.stability,
            difficulty: entry.row.state.difficulty,
            lastDay: entry.row.state.lastDay,
            reps: entry.row.state.reps,
            lapses: entry.row.state.lapses,
            params: entry.row.state.params,
            day: entry.row.day,
            missedToday: entry.row.missedToday,
            bonusUsed: entry.row.bonusUsed,
            held: entry.row.held,
            sessionId: entry.sessionId,
          })),
        )
        .onConflictDoUpdate({
          target: [targetReadiness.targetId, targetReadiness.glossId, targetReadiness.dimension],
          set: {
            stability: sql`excluded.stability`,
            difficulty: sql`excluded.difficulty`,
            lastDay: sql`excluded.last_day`,
            reps: sql`excluded.reps`,
            lapses: sql`excluded.lapses`,
            params: sql`excluded.params`,
            day: sql`excluded.day`,
            missedToday: sql`excluded.missed_today`,
            bonusUsed: sql`excluded.bonus_used`,
            held: sql`excluded.held`,
            sessionId: sql`excluded.session_id`,
          },
        });
    },

    /** Each line stamped `at`, the instant of its session's last answer as Postgres prints it
     *  (SessionEvidence.lastAnsweredAt), not the writing transaction's now(): the session end and
     *  the recompute stamp a line alike, as repo/targetSkills.ts does. */
    insertEvents: async (events: readonly TargetReadinessEvent[], at: string): Promise<void> => {
      if (events.length === 0) return;
      await tx
        .insert(targetReadinessEvents)
        .values(events.map((event) => ({ ...event, createdAt: sql`${at}::timestamptz` })));
    },

    /** What each skill read at the start of `day`: the `before` of its first line that day. */
    findFirstEventsOn: async (
      targetId: string,
      day: string,
    ): Promise<{ glossId: string; dimension: Dimension; before: number }[]> => {
      const rows = await tx
        .select({
          glossId: targetReadinessEvents.glossId,
          dimension: targetReadinessEvents.dimension,
          before: targetReadinessEvents.before,
        })
        .from(targetReadinessEvents)
        .where(and(eq(targetReadinessEvents.targetId, targetId), eq(targetReadinessEvents.day, day)))
        .orderBy(asc(targetReadinessEvents.createdAt), asc(targetReadinessEvents.id));
      const seen = new Set<string>();
      const first: { glossId: string; dimension: Dimension; before: number }[] = [];
      for (const row of rows) {
        const key = `${row.glossId}\u0000${row.dimension}`;
        if (seen.has(key)) continue;
        seen.add(key);
        first.push({ glossId: row.glossId, dimension: row.dimension as Dimension, before: row.before });
      }
      return first;
    },

    /** Recompute only: every value and every line of the log, before the replay rebuilds them. */
    deleteAll: async (): Promise<void> => {
      await tx.delete(targetReadinessEvents);
      await tx.delete(targetReadiness);
    },
  };
}

export type TargetReadinessRepo = ReturnType<typeof createTargetReadinessRepo>;
