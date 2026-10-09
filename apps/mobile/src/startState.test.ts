import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApiError } from './api/client';
import { SIGN_OUT_TIMEOUT_MS, START_TIMEOUT_MS, signOutWithin, startStateOf, startUp } from './startState';

const user = { id: 'u1', username: 'dana', display_name: 'דנה', age: 30, native_language: 'he' as const };

describe('startStateOf', () => {
  it('a profile means signed in; none means onboarding', () => {
    expect(startStateOf({ kind: 'me', user })).toBe('signed_in');
    expect(startStateOf({ kind: 'me', user: null })).toBe('needs_profile');
  });

  it('only a 401 means signed out', () => {
    expect(startStateOf({ kind: 'error', error: new ApiError(401) })).toBe('signed_out');
  });

  it('a network failure or a server error keeps the session and offers a retry', () => {
    expect(startStateOf({ kind: 'error', error: new TypeError('Network request failed') })).toBe('offline');
    expect(startStateOf({ kind: 'error', error: new ApiError(500) })).toBe('offline');
  });
});

describe('startUp', () => {
  it('refreshes the session before asking who is signed in, so the cookie slides with use', async () => {
    const calls: string[] = [];
    await startUp({
      refresh: async () => {
        calls.push('refresh');
      },
      me: async () => {
        calls.push('me');
        return { email: 'a@b.co', user };
      },
    });
    expect(calls).toEqual(['refresh', 'me']);
  });

  it('maps the answers of /api/me', async () => {
    const refresh = async () => {};
    const me = { email: 'a@b.co', user };
    expect(await startUp({ refresh, me: async () => me })).toEqual({ state: 'signed_in', me });
    const bare = { email: 'a@b.co', user: null };
    expect(await startUp({ refresh, me: async () => bare })).toEqual({ state: 'needs_profile', me: bare });
  });

  it('maps errors: a 401 signs out, a network failure is offline', async () => {
    const refresh = async () => {};
    expect(
      await startUp({
        refresh,
        me: async () => {
          throw new ApiError(401);
        },
      }),
    ).toEqual({ state: 'signed_out', me: null });
    expect(
      await startUp({
        refresh,
        me: async () => {
          throw new TypeError('Network request failed');
        },
      }),
    ).toEqual({ state: 'offline', me: null });
  });
});

// Ruling 11. A request that never answers must not hold the learner behind a
// spinner: start-up and sign-out each give it a budget.
describe('the budgets', () => {
  const never = <T,>(): Promise<T> => new Promise<T>(() => {});
  const me = { email: 'a@b.co', user };

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('asks /api/me once a refresh that never answers has used its budget', async () => {
    let asked = false;
    const pending = startUp({
      refresh: never,
      me: async () => {
        asked = true;
        return me;
      },
    });
    await jest.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1);
    expect(asked).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(asked).toBe(true);
    await expect(pending).resolves.toEqual({ state: 'signed_in', me });
  });

  it('is offline once a /api/me that never answers has used its budget', async () => {
    let settled = false;
    const pending = startUp({ refresh: async () => {}, me: never }).finally(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ state: 'offline', me: null });
  });

  it('goes on to /api/me when refresh throws', async () => {
    const result = await startUp({
      refresh: async () => {
        throw new TypeError('Network request failed');
      },
      me: async () => me,
    });
    expect(result).toEqual({ state: 'signed_in', me });
  });

  it('sign-out waits for the revoke when it answers', async () => {
    let revoked = false;
    await signOutWithin(async () => {
      revoked = true;
    });
    expect(revoked).toBe(true);
  });

  it('sign-out gives up on a revoke that never answers, and aborts it so a late reply changes nothing', async () => {
    let signal: AbortSignal | undefined;
    let settled = false;
    const pending = signOutWithin((s) => {
      signal = s;
      return never();
    }).finally(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it('sign-out does not throw when the revoke fails', async () => {
    await expect(
      signOutWithin(async () => {
        throw new TypeError('Network request failed');
      }),
    ).resolves.toBeUndefined();
  });
});
