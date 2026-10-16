import { applySession } from '../domain/memoryUpdate';
import { evaluateSession } from '../domain/progress';
import { targetSessionWrite } from '../domain/targetSkills';
import { createMemoryRepo } from '../repo/memory';
import { createProgressRepo } from '../repo/progress';
import { createTargetRepo } from '../repo/targets';
import { createTargetSkillRepo } from '../repo/targetSkills';
import type { Db } from './client';
import { createTransaction } from './transaction';

/**
 * Phase 20. Rebuilds gloss_progress and session_progress from the answer log,
 * for when the rule changes (spec §3). Every ended session is replayed in the
 * order it ended, through the same evaluateSession the live path runs. One
 * transaction: a failure halfway leaves the old progress in place.
 *
 * The first statement locks sessions in SHARE mode. Every session status UPDATE
 * (completeSession, transition) takes ROW EXCLUSIVE, which conflicts, so a
 * running server cannot end a session mid-recompute and overwrite a rebuilt row;
 * reads and row locks are unaffected, so the app keeps answering meanwhile.
 *
 * Here rather than in services/ because db/cli.ts is the command's composition
 * root, and ADR 0001 R4 forbids db/ from importing services/. The calls
 * below repeat recordProgress in services/sessionEnd.ts; this file's integration
 * test is what keeps the two in step.
 *
 * It rebuilds what today's saves can explain, no more. resetAll deletes every
 * session_progress row, and a session's rows come back only for glosses that are
 * saved now and were saved by that session's last answer. So a gloss unsaved
 * since, or an earlier save period of a re-saved gloss, loses its snapshot rows;
 * and a gloss saved between a session's last answer and its skip is counted by
 * the live path but not here. Both divergences are accepted. For a session about
 * glosses still saved since before its last answer, the rebuild is exactly what
 * the live path wrote.
 *
 * Phase 57 (spec D3, D4). Target skills, their log and each target word's started
 * day are rebuilt the same way, by the same targetSessionWrite, over the targets as
 * they stood at each session's last answer: its ends and date changes since are read
 * back from ended_at and the log, so a target ended early or moved keeps what its
 * sessions gave it then. Two divergences are accepted: a word taken out of a target
 * loses its skills on both paths, but its log lines only here; and a gloss merge
 * moves a target's skills on the live path, while here they come back from the
 * answers about either gloss. This is also the backfill: existing targets start
 * from their answers the first time it runs.
 */
export async function recomputeProgress(db: Db): Promise<{ sessions: number }> {
  const inTransaction = createTransaction(db, (tx) => ({
    progress: createProgressRepo(tx),
    memory: createMemoryRepo(tx),
    target: createTargetRepo(tx),
    targetSkills: createTargetSkillRepo(tx),
  }));
  return inTransaction(async ({ progress, memory, target, targetSkills }) => {
    await progress.lockSessions();
    await progress.resetAll();
    await memory.deleteAll();
    await targetSkills.deleteAll();
    await target.clearStarted();
    const ended = await progress.listEndedSessions();
    for (const sessionId of ended) {
      const evidence = await progress.findSessionEvidence(sessionId);
      if (!evidence) continue;
      const glossIds = [...new Set(evidence.answers.map((answer) => answer.glossId))];
      const rows = await progress.findRows({
        enrollmentId: evidence.enrollmentId,
        glossIds,
        savedBy: evidence.lastAnsweredAt,
      });
      if (rows.length > 0) {
        const outcome = evaluateSession(rows, evidence.answers, evidence.day);
        await progress.updateRows({ enrollmentId: evidence.enrollmentId, rows: outcome.changed });
        await progress.insertSnapshot({ sessionId, rows: outcome.snapshot });

        // Phase 35 (spec D8). Memory replays the same answers with the stored day.
        const saved = new Set(rows.map((row) => row.glossId));
        const before = await memory.findRows({ enrollmentId: evidence.enrollmentId, glossIds: [...saved] });
        const next = applySession(
          before,
          evidence.answers.filter((answer) => saved.has(answer.glossId)),
          evidence.day,
        );
        await memory.upsertRows({ enrollmentId: evidence.enrollmentId, rows: next });
      }

      // Phase 57 (spec D4). recordTargetSkills in services/sessionEnd.ts, call for call.
      const targets = await target.listActiveHolding(evidence.enrollmentId, glossIds, evidence.day, evidence.lastAnsweredAt);
      if (targets.length === 0) continue;
      const before = await targetSkills.findRows(targets.map((held) => held.id), glossIds);
      const write = targetSessionWrite({ sessionId, day: evidence.day, targets, before, answers: evidence.answers });
      await targetSkills.upsertRows(write.rows);
      await targetSkills.insertEvents(write.events);
      for (const started of write.started) await target.markStarted(started.targetId, started.glossIds, evidence.day);
    }
    return { sessions: ended.length };
  });
}
