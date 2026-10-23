import type { CurrentSessionResponse, SessionStatus, TargetSummary } from '@lang-tutor/core/api';

import { strings } from '@/strings';
import { homeOrder } from '@/targets';

/** How often home re-reads a preparing session (spec §7). */
export const POLL_INTERVAL_MS = 3_000;

/** What the home screen's primary area offers. The server decides the state,
 *  and this only names it, so the screen is a switch over one value. */
export type HomeAction =
  | { kind: 'create' }
  /** Phase 73 (spec D6). No words of its own: Words for me, not a session. */
  | { kind: 'discover' }
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
    return state.saved_count > 0 ? { kind: 'failed' } : { kind: 'discover' };
  }
  if (state.next_source === 'seed') return { kind: 'discover' };
  return state.saved_count > 0 ? { kind: 'create' } : { kind: 'discover' };
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
      // Final review N1: a session entered and left before any answer is started with none,
      // and resumed; create would answer it 409. `started` is absent from an older server.
      return session.started || session.answered > 0
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

/** Phase 57 (spec D11). The line under My words' title: how many words wait for review, else
 *  (none waiting) the meanings saved. */
export function myWordsLine(state: CurrentSessionResponse, language: string): string {
  return state.due_count > 0 ? strings.wordsWaiting(state.due_count) : strings.homeSavedLabel(state.saved_count, language);
}

/** Phase 64 (spec D4). My words' button is solid whenever pressing it starts or resumes a
 *  session; pale while one is made or prepared, after a failure, and with nothing to start. */
export function mainButtonSolid(action: HomeAction | null): boolean {
  return action?.kind === 'start' || action?.kind === 'resume';
}

/** Phase 64 (spec D4). My words' blue header: the words due for review, else the meanings
 *  saved, each with what it counts. */
export function myWordsBand(state: CurrentSessionResponse, language: string): { big: string; line: string } {
  if (state.due_count > 0) return { big: strings.countNumber(state.due_count), line: strings.myWordsDue(state.due_count) };
  return { big: strings.countNumber(state.saved_count), line: strings.myWordsSaved(language) };
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
  | { kind: 'answered'; sessionId: string; status: SessionStatus }
  /** Final review N1. Refused with session_open: the path's started session, read again. */
  | { kind: 'open'; sessionId: string };

/** Final review N1. A target path's session to enter after a create refused with session_open,
 *  from a list read since: its session when it is ready (started, or a stock the list read
 *  before the start), else none. */
export function openSessionOf(targets: readonly TargetSummary[] | null, targetId: string): string | null {
  const session = targets?.find((target) => target.id === targetId)?.session;
  return session?.status === 'ready' ? session.session_id : null;
}

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
    case 'discover':
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
  return targetReminderStep(target, created, latest, 'clear');
}

/** The target half of a reminder's start, home's (phase 57) and the practice screen's (phase 75):
 *  the target's button, then its create waited on until the session it answers is ready. A failed
 *  session is left alone on home, as phase 52 leaves one ('clear'), and made again on the practice
 *  screen, as the button retries ('create'). */
function targetReminderStep(
  target: TargetSummary,
  created: TargetCreate,
  latest: readonly TargetSummary[],
  onFailed: 'clear' | 'create',
): ReminderStart {
  const action = targetSessionAction(target);
  if (action.kind === 'resume') return { kind: 'enter', sessionId: action.sessionId, fresh: false };
  if (action.kind === 'failed' && onFailed === 'clear') return { kind: 'clear' };
  switch (created.kind) {
    case 'none':
      return { kind: 'create', targetId: target.id, waitForVoices: action.kind === 'create' || action.kind === 'failed' };
    case 'sending':
      return { kind: 'wait' };
    case 'failed':
      return { kind: 'clear' };
    case 'open':
      return { kind: 'enter', sessionId: created.sessionId, fresh: false };
    case 'answered': {
      if (created.status === 'ready') return { kind: 'enter', sessionId: created.sessionId, fresh: true };
      if (created.status !== 'preparing') return { kind: 'clear' };
      const listed = latest.find((candidate) => candidate.id === target.id);
      const now = listed?.session;
      if (now?.session_id !== created.sessionId) {
        // Home's render can be from before create's own read, so it waits a different session out.
        // The practice screen's list is read after its create (final review I1): a different
        // session is the path's now, and none, or a failed one, is home's to explain.
        if (onFailed === 'clear' || !listed) return { kind: 'wait' };
        if (!now) return { kind: 'clear' };
        if (now.status === 'ready') return { kind: 'enter', sessionId: now.session_id, fresh: !(now.started || now.answered > 0) };
        return now.status === 'preparing' ? { kind: 'wait' } : { kind: 'clear' };
      }
      if (now.status === 'ready') return { kind: 'enter', sessionId: created.sessionId, fresh: true };
      return now.status === 'preparing' ? { kind: 'wait' } : { kind: 'clear' };
    }
  }
}

/** Phase 75 (spec D6). Where the practice screen's own My words create stands: not sent, out,
 *  made and read again (final review I1), or failed. */
export type MyWordsMade = 'none' | 'sending' | 'made' | 'failed';

/** Final review I1. The practice screen's make: the create, then a read of what it made, so the
 *  screen judges on that read; a create or a read that failed is `failed`, never left waiting. */
export async function makeMyWords(create: () => Promise<unknown>, refresh: () => Promise<boolean>): Promise<'made' | 'failed'> {
  try {
    await create();
  } catch {
    return 'failed';
  }
  return (await refresh()) ? 'made' : 'failed';
}

/** Phase 75 (spec D6). What the practice screen does next. */
export type PracticeStep =
  | { kind: 'enter'; sessionId: string; fresh: boolean }
  | { kind: 'wait' }
  | { kind: 'home' }
  | { kind: 'create'; targetId: string; waitForVoices: boolean }
  | { kind: 'make' }
  | { kind: 'discover' };

/**
 * Phase 75 (spec D6, builder check 2 and 5). The practice screen a tapped reminder opens, for the
 * path it named: that card's button at the moment of the tap, judged on reads made after the
 * screen opened, then the session waited for while it prepares. A target goes through the same
 * steps home's reminder takes (targetReminderStep), except that a failed session is made again;
 * one no longer in the read, or a read that failed, goes home. My words does what its button
 * does, and makes a missing session itself (`made` is that create), since only home makes one
 * on its own. Home, Words for me and the session are where the screen can lead.
 */
export function practiceStartOf(input: {
  targetId: string | null;
  targets: 'reading' | 'failed' | readonly TargetSummary[];
  main: HomeAction | null;
  flags: { failed: boolean; read: boolean };
  created: TargetCreate;
  made: MyWordsMade;
  latest: readonly TargetSummary[];
}): PracticeStep {
  const { targetId, targets, main, flags, made } = input;
  if (targetId !== null) {
    if (targets === 'reading') return { kind: 'wait' };
    if (targets === 'failed') return { kind: 'home' };
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) return { kind: 'home' };
    const step = targetReminderStep(target, input.created, input.latest, 'create');
    return step.kind === 'clear' ? { kind: 'home' } : step;
  }
  if (main === null) return flags.failed ? { kind: 'home' } : { kind: 'wait' };
  if (!flags.read) return { kind: 'wait' };
  switch (main.kind) {
    case 'start':
      return { kind: 'enter', sessionId: main.sessionId, fresh: true };
    case 'resume':
      return { kind: 'enter', sessionId: main.sessionId, fresh: false };
    case 'preparing':
      return { kind: 'wait' };
    case 'discover':
      return { kind: 'discover' };
    case 'create':
    case 'failed':
      // Made and read again, and still none, or failed to prepare: home's card explains it.
      return made === 'none' ? { kind: 'make' } : made === 'sending' ? { kind: 'wait' } : { kind: 'home' };
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
