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
  if (current?.status === 'failed') return { kind: 'failed' };
  if (state.next_source === 'seed') return { kind: 'start-seed' };
  return state.saved_count > 0 ? { kind: 'create' } : { kind: 'save-words-first' };
}

export function shouldPoll(state: CurrentSessionResponse | null): boolean {
  return state?.current?.status === 'preparing';
}
