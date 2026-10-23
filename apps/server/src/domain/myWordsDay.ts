import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';
import { progressChanges, type SnapshotRead } from './progress';

/**
 * Phase 73 (spec D2–D3). What a learner's My words day holds, from the sessions that count for
 * it: how many are done, the words first answered in them, and the words whose badge rose in
 * them. Pure: the caller picks the counted sessions and reads the rows.
 */
export type MyWordsDayInput = {
  counted: readonly string[];
  firstAnswers: readonly { glossId: string; sessionId: string }[];
  snapshots: readonly { sessionId: string; rows: readonly SnapshotRead[] }[];
};

export function myWordsDayCounts(input: MyWordsDayInput): {
  sessionsDone: number;
  newWords: number;
  movedUp: number;
} {
  const counted = new Set(input.counted);
  const newWords = new Set(
    input.firstAnswers.filter((a) => counted.has(a.sessionId)).map((a) => a.glossId),
  );
  const movedUp = new Set<string>();
  for (const snapshot of input.snapshots) {
    if (!counted.has(snapshot.sessionId)) continue;
    for (const change of progressChanges(snapshot.rows, LIVE_DIMENSIONS)) {
      if (change.levelAfter > change.levelBefore) movedUp.add(change.glossId);
    }
  }
  return { sessionsDone: input.counted.length, newWords: newWords.size, movedUp: movedUp.size };
}
