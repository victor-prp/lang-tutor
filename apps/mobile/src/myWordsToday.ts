import type { MyWordsToday } from '@lang-tutor/core/api';

import { mainButtonSolid, type HomeAction } from '@/nextSession';
import { strings } from '@/strings';

/** Phase 73 (spec D5). The pure rules of My words' day: its line, dots, tiles and button,
 *  read from the server's `today`. A goal of null is off: no line, no dots. */

const goalMet = (today: MyWordsToday): boolean => today.goal !== null && today.sessions_done >= today.goal;

export function todayLine(today: MyWordsToday): { text: string; side: string | null; tone: 'plain' | 'done' } | null {
  const { goal, sessions_done: done } = today;
  if (goal === null) return null;
  if (done >= goal) return { text: strings.myWordsTodayDone(done), side: null, tone: 'done' };
  if (done === 0) return { text: strings.targetSessionsGoal(goal), side: strings.targetSessionsMinutes(today.minutes), tone: 'plain' };
  return { text: strings.myWordsTodayLeft(goal - done), side: null, tone: 'plain' };
}

export function todayDots(today: MyWordsToday): ('done' | 'todo' | 'bonus')[] {
  const { goal, sessions_done: done } = today;
  if (goal === null) return [];
  const dots = (count: number, dot: 'done' | 'todo' | 'bonus') => Array.from({ length: Math.max(0, count) }, () => dot);
  return [...dots(Math.min(done, goal), 'done'), ...dots(goal - done, 'todo'), ...dots(done - goal, 'bonus')];
}

export function todayTiles(
  today: MyWordsToday,
): { newWords: { count: number; label: string }; movedUp: { count: number; label: string } } | null {
  if (today.new_words === 0 && today.moved_up === 0) return null;
  return {
    newWords: { count: today.new_words, label: strings.myWordsTileNew(today.new_words) },
    movedUp: { count: today.moved_up, label: strings.myWordsTileMovedUp(today.moved_up) },
  };
}

/** What a screen reader says of the day, its dots hidden: the line, then the count they draw. */
export function todaySpoken(today: MyWordsToday): string {
  const line = todayLine(today);
  if (!line || today.goal === null) return '';
  if (line.side !== null) return `${line.text}, ${line.side}`;
  const dots = todayDots(today);
  const count = strings.targetSessionsSpoken(
    dots.filter((dot) => dot === 'done').length,
    today.goal,
    dots.filter((dot) => dot === 'bonus').length,
  );
  return `${line.text}, ${count}`;
}

/** Once the goal is met the button is pale and offers more; otherwise it is today's button. */
export function myWordsButton(today: MyWordsToday | undefined, action: HomeAction | null): { label: string; filled: boolean } {
  if (today && goalMet(today)) return { label: strings.practiceMore, filled: false };
  return { label: strings.practiceNow, filled: mainButtonSolid(action) };
}
