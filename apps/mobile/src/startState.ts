import type { MeResponse, User } from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';

/** Phase 29 (spec D19). What GET /api/me at start-up means. Only a 401 signs anyone out. */
export type StartState = 'loading' | 'signed_out' | 'needs_profile' | 'signed_in' | 'offline';

/** Ruling 11. How long start-up waits for each of refresh() and me(); past it, me() means offline. */
export const START_TIMEOUT_MS = 8_000;
/** Ruling 11. How long sign-out waits for the server to revoke the session. */
export const SIGN_OUT_TIMEOUT_MS = 5_000;

export function startStateOf(
  outcome: { kind: 'me'; user: User | null } | { kind: 'error'; error: unknown },
): Exclude<StartState, 'loading'> {
  if (outcome.kind === 'me') return outcome.user ? 'signed_in' : 'needs_profile';
  return outcome.error instanceof ApiError && outcome.error.status === 401 ? 'signed_out' : 'offline';
}

/**
 * Settles as `work()` does, or rejects with a network-style error once `ms`
 * have passed, so a request that never answers reads as one that failed. The
 * timer is cleared either way. `work` is called inside the chain, so one that
 * throws before returning a promise rejects here too.
 */
function within<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TypeError('Network request timed out')), ms);
  });
  return Promise.race([Promise.resolve().then(work), budget]).finally(() => clearTimeout(timer));
}

/**
 * The start-up sequence (spec D6). refresh() goes first: Better Auth's
 * get-session re-issues the cookie when the session is extended, and the
 * server middleware never extends, so without it a daily learner would be
 * signed out after 90 days. A refresh that fails or hangs only means the
 * session does not slide this time. Each call has START_TIMEOUT_MS, so the
 * learner never waits on a request that does not answer (ruling 11).
 */
export async function startUp(deps: {
  refresh: () => Promise<void>;
  me: () => Promise<MeResponse>;
}): Promise<{ state: Exclude<StartState, 'loading'>; me: MeResponse | null }> {
  await within(deps.refresh, START_TIMEOUT_MS).catch(() => {});
  try {
    const me = await within(deps.me, START_TIMEOUT_MS);
    return { state: startStateOf({ kind: 'me', user: me.user }), me };
  } catch (error) {
    return { state: startStateOf({ kind: 'error', error }), me: null };
  }
}

/**
 * Sign-out waits for the server's revoke, for SIGN_OUT_TIMEOUT_MS at most, and
 * never throws: the caller clears local state either way (ruling 11). Better
 * Auth's Expo client clears the stored cookie before sending, and again when
 * the reply arrives, so a late reply could wipe a session signed in since.
 * That is why this is not fire-and-forget, and why a revoke past its budget is
 * aborted: no late reply arrives.
 */
export async function signOutWithin(revoke: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  try {
    await within(() => revoke(controller.signal), SIGN_OUT_TIMEOUT_MS);
  } catch {
    controller.abort();
  }
}
