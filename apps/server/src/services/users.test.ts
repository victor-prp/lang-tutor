import { describe, expect, it } from '@jest/globals';

import {
  createFakeLogger,
  createFakeTransaction,
  createInMemoryUserRepo,
} from '../../tests/support/fakes';
import { ProfileExists, UsernameTaken } from '../errors';
import { createUserService } from './users';

// The other half of this file's tests is
// tests/integration/services/users.test.ts, which covers what only real
// Postgres can decide — the constraints, above all.

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
};

function build() {
  const repo = createInMemoryUserRepo();
  const logger = createFakeLogger();
  const service = createUserService({ transaction: createFakeTransaction({ user: repo }), logger });
  return { repo, logger, service };
}

describe('createProfile', () => {
  it("creates the profile under the signed-in user's own id", async () => {
    const { service } = build();
    expect(await service.createProfile('u_dana', REQUEST)).toEqual({ id: 'u_dana', ...REQUEST });
  });

  it('logs the new profile once the write has resolved', async () => {
    const { service, logger } = build();
    await service.createProfile('u_dana', REQUEST);
    expect(logger.events).toEqual([{ event: 'profile_created', user_id: 'u_dana', username: 'dana' }]);
  });

  it('propagates ProfileExists for a second profile, and logs nothing', async () => {
    const { service, logger } = build();
    await service.createProfile('u_dana', REQUEST);
    logger.events.length = 0;

    await expect(service.createProfile('u_dana', { ...REQUEST, username: 'dana_two' })).rejects.toBeInstanceOf(
      ProfileExists,
    );
    expect(logger.events).toEqual([]);
  });

  it('propagates UsernameTaken for a handle another user holds, and logs nothing', async () => {
    const { service, logger } = build();
    await service.createProfile('u_dana', REQUEST);
    logger.events.length = 0;

    await expect(service.createProfile('u_other', REQUEST)).rejects.toBeInstanceOf(UsernameTaken);
    expect(logger.events).toEqual([]);
  });
});

describe('me and hasProfile', () => {
  it('answers null and false before onboarding', async () => {
    const { service } = build();
    expect(await service.me('u_dana')).toBeNull();
    expect(await service.hasProfile('u_dana')).toBe(false);
  });

  it('answers the profile and true after it', async () => {
    const { service } = build();
    const created = await service.createProfile('u_dana', REQUEST);
    expect(await service.me('u_dana')).toEqual(created);
    expect(await service.hasProfile('u_dana')).toBe(true);
  });
});
