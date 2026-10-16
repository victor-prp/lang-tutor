import type { CurrentSessionResponse, TargetSummary } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { strings } from '@/strings';
import { homeOrder } from '@/targets';

/** How often home re-reads a preparing session (spec §7). */
export const POLL_INTERVAL_MS = 3_000;

/** What the home screen's primary area offers. The server decides the state,
 *  and this only names it, so the screen is a switch over one value. */
export type HomeAction =
  | { kind: 'start-seed' }
  | { kind: 'create' }
  | { kind: 'save-words-first' }
  | { kind: 'preparing'; sessionId: string }
  | { kind: 'start'; sessionId: string }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'failed' };

export function homeActionOf(state: CurrentSessionResponse): HomeAction {
  const { current } = state;
  if (current?.status === 'preparing') return { kind: 'preparing', sessionId: current.session_id };
  if (current?.status === 'ready') {
    return current.answered > 0
      ? { kind: 'resume', sessionId: current.session_id }
      : { kind: 'start', sessionId: current.session_id };
  }
  if (current?.status === 'failed') {
    // Offering create with nothing saved would answer 409 no_saved_words and loop.
    return state.saved_count > 0 ? { kind: 'failed' } : { kind: 'save-words-first' };
  }
  if (state.next_source === 'seed') return { kind: 'start-seed' };
  return state.saved_count > 0 ? { kind: 'create' } : { kind: 'save-words-first' };
}

/** Phase 57 (spec D1, D11). What a target's card offers, read from its own path's session
 *  as homeActionOf reads `current`. A target always has words, so a failed session is
 *  offered again, and with no session the card creates one (with the target's id). The
 *  server stocks a target's next session itself, so the card never creates on its own. */
export function targetSessionAction(target: Pick<TargetSummary, 'session'>): HomeAction {
  const { session } = target;
  switch (session?.status) {
    case 'preparing':
      return { kind: 'preparing', sessionId: session.session_id };
    case 'ready':
      return session.answered > 0
        ? { kind: 'resume', sessionId: session.session_id }
        : { kind: 'start', sessionId: session.session_id };
    case 'failed':
      return { kind: 'failed' };
    default:
      return { kind: 'create' };
  }
}

/** Phase 57 (spec D11). The line under My words' title: the seed's words before the first
 *  session, else how many words wait for review, else (none waiting) the meanings saved. */
export function myWordsLine(state: CurrentSessionResponse, language: string): string {
  if (homeActionOf(state).kind === 'start-seed') return strings.homeSetLabel(SESSION_LENGTH, language);
  return state.due_count > 0 ? strings.wordsWaiting(state.due_count) : strings.homeSavedLabel(state.saved_count, language);
}

/** Phase 43 (spec D7). The `create` state is not a button: home sends create
 *  itself, once per focus and enrollment (`attemptedFor` is the enrollment it
 *  was sent for), so a create that keeps failing is never sent in a loop. */
export function shouldAutoCreate(action: HomeAction | null, attemptedFor: string | null, activeId: string): boolean {
  return action?.kind === 'create' && attemptedFor !== activeId;
}

/** Phase 43 (spec D7). What the `create` state shows: "preparing" while home's
 *  create runs, and a retry once it failed for this enrollment. */
export function createLook(failedFor: string | null, activeId: string): 'preparing' | 'retry' {
  return failedFor === activeId ? 'retry' : 'preparing';
}

/** Phase 52 (spec D8). What home does with `start=reminder` for the action it
 *  shows: enter the ready session with the arguments the start button passes,
 *  wait, or clear the param because there is nothing to start.
 *
 *  `read` is whether the action comes from a read made after the tap. The one
 *  home held when the tap came can be about a session finished since (a target
 *  of two, the first just done), so nothing is entered or cleared on it. `failed`
 *  is a read or a create that failed: waiting on would let a later recovery
 *  start a session the learner did not ask for. */
export type ReminderStart =
  | { kind: 'enter'; sessionId: string; fresh: boolean }
  | { kind: 'wait' }
  | { kind: 'clear' };

export function reminderStartOf(
  action: HomeAction | null,
  { failed, read }: { failed: boolean; read: boolean },
): ReminderStart {
  if (action === null) return failed ? { kind: 'clear' } : { kind: 'wait' };
  if (!read) return { kind: 'wait' };
  switch (action.kind) {
    case 'start':
      return { kind: 'enter', sessionId: action.sessionId, fresh: true };
    case 'resume':
      return { kind: 'enter', sessionId: action.sessionId, fresh: false };
    case 'preparing':
      return { kind: 'wait' };
    case 'create':
      return failed ? { kind: 'clear' } : { kind: 'wait' };
    case 'start-seed':
    case 'save-words-first':
    case 'failed':
      return { kind: 'clear' };
  }
}

/** Phase 57 (spec D2, D11). A reminder opens the path of home's first card (homeOrder's
 *  `first`). `targets` is the targets read made after the tap: 'reading' until it is in,
 *  'failed' if it failed, since then home cannot tell which card is first. A target first
 *  is entered when its session is ready, as its card's button enters it, and the param is
 *  cleared otherwise: the reminder never creates a session. My words first follows phase
 *  52's rules over the main path's action. */
export function homeReminderStartOf(
  targets: 'reading' | 'failed' | readonly TargetSummary[],
  main: HomeAction | null,
  flags: { failed: boolean; read: boolean },
): ReminderStart {
  if (targets === 'reading') return { kind: 'wait' };
  if (targets === 'failed') return { kind: 'clear' };
  const { first } = homeOrder(targets);
  const target = targets.find((candidate) => candidate.id === first);
  if (!target) return reminderStartOf(main, flags);
  const action = targetSessionAction(target);
  switch (action.kind) {
    case 'start':
      return { kind: 'enter', sessionId: action.sessionId, fresh: true };
    case 'resume':
      return { kind: 'enter', sessionId: action.sessionId, fresh: false };
    default:
      return { kind: 'clear' };
  }
}

export function shouldPoll(state: CurrentSessionResponse | null): boolean {
  return state?.current?.status === 'preparing';
}

/** A read of the current session, tagged with the enrollment it was about. */
export type StoredCurrent = { enrollmentId: string; state: CurrentSessionResponse };

/** What to show for the active enrollment. A read stored for any other
 *  enrollment (a slow answer that landed after a switch) is never shown. */
export function currentFor(
  stored: StoredCurrent | null,
  activeId: string | undefined,
): CurrentSessionResponse | null {
  return stored !== null && stored.enrollmentId === activeId ? stored.state : null;
}

/** Whether home has nothing to show because the first read for the active
 *  enrollment failed. A read already shown wins: a failed poll keeps it. */
export function loadFailedFor(
  failedEnrollmentId: string | null,
  activeId: string | undefined,
  current: CurrentSessionResponse | null,
): boolean {
  return current === null && activeId !== undefined && failedEnrollmentId === activeId;
}
