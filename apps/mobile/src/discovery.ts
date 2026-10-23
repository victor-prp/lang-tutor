import type {
  CurrentSession,
  DiscoveryLearningContext,
  DiscoveryRun,
  DiscoverySelfLevel,
  DiscoveryState,
} from '@lang-tutor/core/api';

import { strings } from './strings';

/**
 * Phase 69. Words for me, the screen's pure half: which step a run is at and the choices it
 * offers (spec D1–D8). Phase 74: a card's suggestion and its sheet, what ✕ does, and the end
 * screen's state (spec D2, D8, D9).
 */

/** Spec D1, phase 74 D6. The screen's steps, in order: the questions once, then how many (a run
 *  the learner starts) or straight to the start (one the app starts), then the cards and the
 *  fetch of each round, then the end. */
export type DiscoverStep = 'questions' | 'goal' | 'starting' | 'fetching' | 'card' | 'end';

/** Where the screen opens: a run open resumes at its step. A run asking with no card
 *  unanswered needs its next round, never an empty card. `fromApp` is a run the app starts. */
export function stepOf(state: DiscoveryState, fromApp: boolean): DiscoverStep {
  if (state.profile === null) return 'questions';
  const run = state.run;
  if (run !== null && run.status === 'saved') return 'end';
  if (run === null || run.status !== 'asking') return fromApp ? 'starting' : 'goal';
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

export type AddChoice = 'add' | 'skip';

/** Phase 74 (spec D2). After a right pick the app suggests not adding; otherwise adding. */
export function suggestionOf(pick: number | null, right: number): AddChoice {
  return pick === right ? 'skip' : 'add';
}

/** Phase 74 (spec D2). The sheet a choice against the suggestion opens: `knew`, the learner knew
 *  the word and adds it; `new`, they did not and skip it. The suggestion itself opens none. */
export function sheetCaseOf(suggested: AddChoice, chosen: AddChoice): 'knew' | 'new' | null {
  if (suggested === chosen) return null;
  return chosen === 'add' ? 'knew' : 'new';
}

/** Phase 74 (spec D8). What ✕ does: during the cards (a later round being fetched counts) it ends
 *  the run with two words added or more, and warns with fewer; anywhere else it leaves. */
export function closeStep(run: DiscoveryRun | null, step: DiscoverStep): 'end' | 'warn' | 'leave' {
  const duringCards = run !== null && run.status === 'asking' && (step === 'card' || (step === 'fetching' && run.round > 0));
  if (!duringCards) return 'leave';
  return run.added_count >= 2 ? 'end' : 'warn';
}

/** Phase 74 (spec D8). The warning's second button: a learner the app sent who has words of their
 *  own practises without new ones; anyone else leaves, the run open. */
export function warnEscape(fromApp: boolean, wordsBefore: number): 'practise' | 'leave' {
  return fromApp && wordsBefore > 0 ? 'practise' : 'leave';
}

/** Phase 74 (spec D8). The learner's words from before this run: My words' count less what the
 *  run has saved. */
export function savedBefore(savedCount: number, run: DiscoveryRun | null): number {
  const saved = run ? run.added.filter((word) => word.status === 'saved').length : 0;
  return Math.max(0, savedCount - saved);
}

/**
 * Phase 74 (spec D9). The end screen's bottom, from My words' session: start it once ready;
 * wait while it is prepared or a word is still looked up; with a word saved and no session,
 * ask for one once (`created`), then wait; nothing to offer with no word saved; a failure says so.
 */
export function endStep(run: DiscoveryRun, current: CurrentSession | null, created: boolean): 'start' | 'wait' | 'create' | 'empty' | 'failed' {
  if (current?.status === 'ready') return 'start';
  if (current?.status === 'preparing') return 'wait';
  if (current?.status === 'failed') return 'failed';
  if (run.added.some((word) => word.status === 'pending')) return 'wait';
  if (run.added.some((word) => word.status === 'saved')) return created ? 'wait' : 'create';
  return 'empty';
}

/** Phase 73 (spec D6). While waiting on a session asked for: what the re-read `current` says. */
export function waitStep(current: { session_id: string; status: string } | null | undefined, sessionId: string): 'open' | 'wait' | 'home' {
  if (!current || current.session_id !== sessionId) return 'wait';
  if (current.status === 'ready') return 'open';
  return current.status === 'failed' ? 'home' : 'wait';
}
