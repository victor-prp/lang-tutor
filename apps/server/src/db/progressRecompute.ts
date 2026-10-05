import { evaluateSession } from '../domain/progress';
import { createProgressRepo } from '../repo/progress';
import type { Db } from './client';
import { createTransaction } from './transaction';

/**
 * Phase 20. Rebuilds sense_progress and session_progress from the answer log,
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
 * root, and ADR 0001 R4 forbids db/ from importing services/. The four calls
 * below repeat recordProgress in services/sessions.ts; this file's integration
 * test is what keeps the two in step.
 *
 * It rebuilds what today's saves can explain, no more. resetAll deletes every
 * session_progress row, and a session's rows come back only for senses that are
 * saved now and were saved by that session's last answer. So a sense unsaved
 * since, or an earlier save period of a re-saved sense, loses its snapshot rows;
 * and a sense saved between a session's last answer and its skip is counted by
 * the live path but not here. Both divergences are accepted. For a session about
 * senses still saved since before its last answer, the rebuild is exactly what
 * the live path wrote.
 */
export async function recomputeProgress(db: Db): Promise<{ sessions: number }> {
  const inTransaction = createTransaction(db, (tx) => createProgressRepo(tx));
  return inTransaction(async (progress) => {
    await progress.lockSessions();
    await progress.resetAll();
    const ended = await progress.listEndedSessions();
    for (const sessionId of ended) {
      const evidence = await progress.findSessionEvidence(sessionId);
      if (!evidence) continue;
      const rows = await progress.findRows({
        enrollmentId: evidence.enrollmentId,
        senseIds: [...new Set(evidence.answers.map((answer) => answer.senseId))],
        savedBy: evidence.lastAnsweredAt,
      });
      if (rows.length === 0) continue;
      const outcome = evaluateSession(rows, evidence.answers, evidence.day);
      await progress.updateRows({ enrollmentId: evidence.enrollmentId, rows: outcome.changed });
      await progress.insertSnapshot({ sessionId, rows: outcome.snapshot });
    }
    return { sessions: ended.length };
  });
}
