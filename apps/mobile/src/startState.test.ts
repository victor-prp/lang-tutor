import { describe, expect, it } from '@jest/globals';

import { ApiError } from './api/client';
import { startStateOf, startUp } from './startState';

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
