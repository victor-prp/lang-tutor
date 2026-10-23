import { goalOf } from '../domain/myWordsGoal';
import { myWordsDayCounts } from '../domain/myWordsDay';
import type { MyWordsDayRow } from '../repo/myWordsDays';
import type { Logger } from '../logger';
import type { Repos } from './transaction';

/**
 * Phase 73 (spec D2, D3). Writes an enrollment's My words day whole, from what the database holds:
 * the day's counted sessions, the words first answered in them and their snapshots. Called by a
 * counted session's completion and by a change of the goal, in the caller's transaction.
 */
export async function recordMyWordsDay(
  repos: Repos,
  logger: Logger,
  input: { enrollmentId: string; day: string; sessionId: string | null; reason: 'session' | 'goal_changed' },
): Promise<MyWordsDayRow> {
  const { enrollmentId, day } = input;
  const counted = await repos.session.findCountedMainSessions(enrollmentId, day);
  const firstAnswers = await repos.session.findFirstAnswerSessions(enrollmentId, day);
  const snapshots = [];
  for (const sessionId of counted) snapshots.push({ sessionId, rows: await repos.progress.findSnapshot(sessionId) });
  const stored = await repos.enrollment.findMyWordsGoal(enrollmentId);
  const goal = goalOf(stored);
  const counts = myWordsDayCounts({ counted, firstAnswers, snapshots });
  const lastSessionId = input.sessionId ?? counted[counted.length - 1] ?? null;
  const row: MyWordsDayRow = { enrollmentId, day, goal, ...counts, lastSessionId };
  await repos.myWordsDays.upsert(row);
  logger.info({
    event: 'my_words_day_recorded',
    enrollment_id: enrollmentId,
    day,
    goal,
    sessions_done: counts.sessionsDone,
    new_words: counts.newWords,
    moved_up: counts.movedUp,
    ...(input.reason === 'goal_changed' ? { reason: 'goal_changed' } : { session_id: input.sessionId }),
  });
  return row;
}
