import type { CurrentSessionResponse } from '@lang-tutor/core/api';

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
