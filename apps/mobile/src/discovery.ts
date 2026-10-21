import type {
  DiscoveryAnswerResult,
  DiscoveryLearningContext,
  DiscoveryRun,
  DiscoverySelfLevel,
  DiscoveryState,
  PhotoImportItem,
} from '@lang-tutor/core/api';

import { strings } from './strings';

/**
 * Phase 69. Words for me, the screen's pure half: which step a run is at, the choices it
 * offers, and what the card and the list show (spec D1–D8).
 */

/** Spec D1. The screen's steps, in order: the questions once, then how many, then the cards
 *  and the fetch of each round, then the list. */
export type DiscoverStep = 'questions' | 'goal' | 'fetching' | 'card' | 'list';

/** Where the screen opens: a run open resumes at its step. A run asking with no card
 *  unanswered needs its next round, never an empty card. */
export function stepOf(state: DiscoveryState): DiscoverStep {
  if (state.profile === null) return 'questions';
  const run = state.run;
  if (run === null) return 'goal';
  if (run.status === 'listing') return 'list';
  if (run.status !== 'asking') return 'goal';
  return run.cards.length > 0 ? 'card' : 'fetching';
}

/** Spec D6. */
export const GOAL_CHOICES = [5, 10, 15, 20, 30] as const;
export const DEFAULT_GOAL = 15;

/** Spec D2. The two questions' answers, in the order they are shown, with their copy. */
export const SELF_LEVELS: readonly { value: DiscoverySelfLevel; label: string }[] = [
  { value: 'none', label: strings.discoverLevelNone },
  { value: 'basic', label: strings.discoverLevelBasic },
  { value: 'simple', label: strings.discoverLevelSimple },
  { value: 'everyday', label: strings.discoverLevelEveryday },
  { value: 'fluent', label: strings.discoverLevelFluent },
];
export const LEARNING_CONTEXTS: readonly { value: DiscoveryLearningContext; label: string }[] = [
  { value: 'school', label: strings.discoverContextSchool },
  { value: 'course', label: strings.discoverContextCourse },
  { value: 'self', label: strings.discoverContextSelf },
  { value: 'family', label: strings.discoverContextFamily },
];

/** Spec D5. The line a typed answer leaves on its card. */
export function verdictLine(result: DiscoveryAnswerResult): { tone: 'right' | 'wrong'; text: string } {
  return result.known ? { tone: 'right', text: strings.discoverRight } : { tone: 'wrong', text: strings.discoverWrong(result.meaning) };
}

/** Spec D8. The list polls while a row is still looked up, and cannot be saved till then. */
export function itemsWaiting(run: DiscoveryRun): boolean {
  return run.items.some((row) => row.status === 'pending');
}

/** The rows Continue would add: ticked, and looked up with a gloss. */
export function tickedCount(run: DiscoveryRun): number {
  return run.items.filter((row) => row.status === 'ready' && row.ticked).length;
}

/** One row as the server now has it, the others as they were. */
export function withItem(run: DiscoveryRun, row: PhotoImportItem): DiscoveryRun {
  return { ...run, items: run.items.map((current) => (current.position === row.position ? row : current)) };
}

/** Spec D8. "לרשימה" shows from the first word not known, while the run asks. */
export function canEnd(run: DiscoveryRun): boolean {
  return run.status === 'asking' && run.unknown_count > 0;
}
