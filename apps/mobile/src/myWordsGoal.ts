import { strings } from '@/strings';

// Phase 73 (spec D1). The My words daily goal: sessions a day, 1 to 20; off is null elsewhere.
export const MIN_GOAL = 1;
export const MAX_GOAL = 20;
// What the switch restores when it is turned back on.
export const DEFAULT_GOAL = 3;

export function stepGoal(goal: number, direction: 1 | -1): number {
  return Math.min(MAX_GOAL, Math.max(MIN_GOAL, goal + direction));
}

export const goalLabel = (goal: number): string => strings.myWordsGoalValue(goal);
