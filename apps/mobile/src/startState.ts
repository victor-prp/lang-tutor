import type { MeResponse, User } from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';

/** Phase 29 (spec D19). What GET /api/me at start-up means. Only a 401 signs anyone out. */
export type StartState = 'loading' | 'signed_out' | 'needs_profile' | 'signed_in' | 'offline';

export function startStateOf(
  outcome: { kind: 'me'; user: User | null } | { kind: 'error'; error: unknown },
): Exclude<StartState, 'loading'> {
  if (outcome.kind === 'me') return outcome.user ? 'signed_in' : 'needs_profile';
  return outcome.error instanceof ApiError && outcome.error.status === 401 ? 'signed_out' : 'offline';
}

/**
 * The start-up sequence (spec D6). refresh() goes first: Better Auth's
 * get-session re-issues the cookie when the session is extended, and the
 * server middleware never extends, so without it a daily learner would be
 * signed out after 90 days. refresh() never throws.
 */
export async function startUp(deps: {
  refresh: () => Promise<void>;
  me: () => Promise<MeResponse>;
}): Promise<{ state: Exclude<StartState, 'loading'>; me: MeResponse | null }> {
  await deps.refresh();
  try {
    const me = await deps.me();
    return { state: startStateOf({ kind: 'me', user: me.user }), me };
  } catch (error) {
    return { state: startStateOf({ kind: 'error', error }), me: null };
  }
}
