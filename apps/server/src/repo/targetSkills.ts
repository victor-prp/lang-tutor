import type { Dimension } from '@lang-tutor/core/domain';
import { and, asc, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { targetSkillEvents, targetSkills } from '../db/schema';
import type { TargetSkillEvent, TargetSkillRow } from '../domain/targetSkills';

/**
 * Phase 57 (spec D3, D4). target_skills and its log: written when a session ends, in its
 * transaction, and rebuilt by the recompute. No row locks: a target's skills are written only
 * when a session ends, as gloss_progress is (repo/progress.ts).
 */
export function createTargetSkillRepo(tx: Tx) {
  return {
    /** The rows of these targets about these glosses; a skill with no row is at 0. */
    findRows: async (targetIds: readonly string[], glossIds: readonly string[]): Promise<TargetSkillRow[]> => {
      if (targetIds.length === 0 || glossIds.length === 0) return [];
      const rows = await tx
        .select()
        .from(targetSkills)
        .where(and(inArray(targetSkills.targetId, [...targetIds]), inArray(targetSkills.glossId, [...glossIds])))
        .orderBy(asc(targetSkills.targetId), asc(targetSkills.glossId), asc(targetSkills.dimension));
      return rows.map((row) => ({
        targetId: row.targetId,
        glossId: row.glossId,
        dimension: row.dimension as Dimension,
        halves: row.halves,
        sessionId: row.sessionId,
        day: row.day,
      }));
    },

    /** Each row's value, and the session and day that set it. */
    upsertRows: async (rows: readonly TargetSkillRow[]): Promise<void> => {
      if (rows.length === 0) return;
      await tx
        .insert(targetSkills)
        .values([...rows])
        .onConflictDoUpdate({
          target: [targetSkills.targetId, targetSkills.glossId, targetSkills.dimension],
          set: { halves: sql`excluded.halves`, sessionId: sql`excluded.session_id`, day: sql`excluded.day` },
        });
    },

    /** Final review T4. Each line stamped `at`, the instant of its session's last answer as
     *  Postgres prints it (SessionEvidence.lastAnsweredAt), not the writing transaction's now():
     *  the session end and the recompute stamp a line alike, so a rebuilt log reads in the
     *  order the live one does. */
    insertEvents: async (events: readonly TargetSkillEvent[], at: string): Promise<void> => {
      if (events.length === 0) return;
      await tx.insert(targetSkillEvents).values(events.map((event) => ({ ...event, createdAt: sql`${at}::timestamptz` })));
    },

    /** Recompute only: every value and every line of the log, before the replay rebuilds them. */
    deleteAll: async (): Promise<void> => {
      await tx.delete(targetSkillEvents);
      await tx.delete(targetSkills);
    },
  };
}

export type TargetSkillRepo = ReturnType<typeof createTargetSkillRepo>;
