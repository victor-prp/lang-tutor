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
 * Here rather than in services/ because db/cli.ts is the command's composition
 * root, and ADR 0001 R4 forbids db/ from importing services/. The four calls
 * below repeat recordProgress in services/sessions.ts; this file's integration
 * test is what keeps the two in step.
 *
 * A sense counts in a session only if it was saved by the session's last
 * answer, the live path's "its rows exist when the session ends" read back from
 * timestamps. A sense saved between a session's last answer and its skip is the
 * one case where the two disagree, and that is accepted.
 */
export async function recomputeProgress(db: Db): Promise<{ sessions: number }> {
  const inTransaction = createTransaction(db, (tx) => createProgressRepo(tx));
  return inTransaction(async (progress) => {
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
