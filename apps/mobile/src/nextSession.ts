import type { CurrentSessionResponse, SessionStatus, TargetSummary } from '@lang-tutor/core/api';
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

/** Phase 57 (spec D1, final review C1). What a target's button does with its card's action:
 *  a started session is resumed as it is; an unstarted one, none, or a failed one goes through
 *  create (POST /sessions with the target), which answers the path's stock, replaced first when
 *  it no longer serves the target's day, or builds one: entered when create answers it ready,
 *  else the card shows it preparing. A preparing one is not pressable.
 *
 *  `waitForVoices`: only a create that builds the session waits for this device's voices. One
 *  that answers the stock, or replaces it, uses the devices the stock was built for, so the
 *  tap does not wait on voices that may never load. */
export function targetPress(
  action: HomeAction,
): { kind: 'enter'; sessionId: string; fresh: boolean } | { kind: 'create'; waitForVoices: boolean } | { kind: 'none' } {
  switch (action.kind) {
    case 'resume':
      return { kind: 'enter', sessionId: action.sessionId, fresh: false };
    case 'start':
      return { kind: 'create', waitForVoices: false };
    case 'create':
    case 'failed':
      return { kind: 'create', waitForVoices: true };
    default:
      return { kind: 'none' };
  }
}

/** Final review M2. What My words says when it has nothing of its own to practise: that every
 *  saved word is in the targets, which practise them, when one holds a word; otherwise, to save
 *  words first. `targets` is home's read of them, null until it lands. */
export function mainEmptyNote(
  targets: readonly Pick<TargetSummary, 'kind' | 'word_count'>[] | null,
): { kind: 'save-words-first' | 'all-in-targets'; text: string } {
  const holding = (targets ?? []).filter((target) => target.word_count > 0);
  if (holding.length === 0) return { kind: 'save-words-first', text: strings.saveWordsFirst };
  return { kind: 'all-in-targets', text: strings.allWordsInTargets(holding.map((target) => target.kind)) };
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
  | { kind: 'clear' }
  /** Phase 57 (final review C1). Send create for this target's path, then decide again; it
   *  waits for the voices only when it builds the session (targetPress). */
  | { kind: 'create'; targetId: string; waitForVoices: boolean };

/** Phase 57 (final review C1). Where the create a reminder sent for a target's path stands: not
 *  sent, out, failed, or answered with the session it names and that session's status. */
export type TargetCreate =
  | { kind: 'none' }
  | { kind: 'sending' }
  | { kind: 'failed' }
  | { kind: 'answered'; sessionId: string; status: SessionStatus };

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
 *  `first`), judged on `held`: the targets read made after the tap, as it landed ('reading'
 *  until it is in, 'failed' if it failed, since then home cannot tell which card is first).
 *  Never on the list a render of home holds, which can be from before that read (final review
 *  CI-1: the homework owed work, home's older list had no target yet, and My words was entered).
 *
 *  A target first is never left for My words. Its started session is resumed as it is; a failed
 *  one is left alone, as phase 52 leaves a failed session; otherwise the reminder goes through
 *  create, as the card's button does (final review C1: create answers the stock, replaced when it
 *  no longer serves the day), enters what create answers ready, and waits while it prepares
 *  until `latest`, home's newest list, shows that session ready. A list showing another session
 *  or none is waited out, never cleared on: a render from before create's own read shows the
 *  stock create replaced. My words first follows phase 52's rules over the main path's action. */
export function homeReminderStartOf(
  held: 'reading' | 'failed' | readonly TargetSummary[],
  main: HomeAction | null,
  flags: { failed: boolean; read: boolean },
  created: TargetCreate = { kind: 'none' },
  latest: readonly TargetSummary[] = [],
): ReminderStart {
  if (held === 'reading') return { kind: 'wait' };
  if (held === 'failed') return { kind: 'clear' };
  const { first } = homeOrder(held);
  const target = held.find((candidate) => candidate.id === first);
  if (!target) return reminderStartOf(main, flags);
  const action = targetSessionAction(target);
  if (action.kind === 'resume') return { kind: 'enter', sessionId: action.sessionId, fresh: false };
  if (action.kind === 'failed') return { kind: 'clear' };
  switch (created.kind) {
    case 'none':
      return { kind: 'create', targetId: target.id, waitForVoices: action.kind === 'create' };
    case 'sending':
      return { kind: 'wait' };
    case 'failed':
      return { kind: 'clear' };
    case 'answered': {
      if (created.status === 'ready') return { kind: 'enter', sessionId: created.sessionId, fresh: true };
      if (created.status !== 'preparing') return { kind: 'clear' };
      const now = latest.find((candidate) => candidate.id === target.id)?.session;
      if (now?.session_id !== created.sessionId) return { kind: 'wait' };
      if (now.status === 'ready') return { kind: 'enter', sessionId: created.sessionId, fresh: true };
      return now.status === 'preparing' ? { kind: 'wait' } : { kind: 'clear' };
    }
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
