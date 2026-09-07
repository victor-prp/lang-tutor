import { describe, expect, it } from '@jest/globals';

import {
  createFakeLogger,
  createFakeTransaction,
  createInMemoryUserRepo,
} from '../../tests/support/fakes';
import { InvalidLanguagePair, UsernameTaken, UserNotFound } from '../errors';
import { createUserService } from './users';

// The other half of this file's tests is
// tests/integration/services/users.test.ts, which covers what only real
// Postgres can decide — the unique constraint, above all.

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
  target_language: 'en' as const,
};

function build() {
  const repo = createInMemoryUserRepo();
  const logger = createFakeLogger();
  const service = createUserService({ transaction: createFakeTransaction(repo), logger });
  return { repo, logger, service };
}

describe('register', () => {
  it('returns the created user', async () => {
    const { service } = build();
    const user = await service.register(REQUEST);
    expect(user.username).toBe('dana');
    expect(user.display_name).toBe('דנה');
    expect(user.id).toEqual(expect.any(String));
  });

  it('logs the registration once the write has resolved', async () => {
    const { service, logger } = build();
    const user = await service.register(REQUEST);
    expect(logger.events).toEqual([
      { event: 'user_registered', user_id: user.id, username: 'dana' },
    ]);
  });

  it('rejects a matching language pair without writing anything', async () => {
    const { service, repo } = build();
    await expect(
      service.register({ ...REQUEST, target_language: 'he' }),
    ).rejects.toBeInstanceOf(InvalidLanguagePair);
    expect(repo.rows).toEqual([]);
  });

  it('propagates UsernameTaken and logs nothing', async () => {
    const { service, logger } = build();
    await service.register(REQUEST);
    logger.events.length = 0;

    await expect(service.register(REQUEST)).rejects.toBeInstanceOf(UsernameTaken);
    expect(logger.events).toEqual([]);
  });
});

describe('login', () => {
  it('returns the user registered under that username', async () => {
    const { service } = build();
    const created = await service.register(REQUEST);
    expect(await service.login('dana')).toEqual(created);
  });

  it('throws UserNotFound for a username nobody has', async () => {
    const { service } = build();
    await expect(service.login('nobody')).rejects.toBeInstanceOf(UserNotFound);
  });
});
