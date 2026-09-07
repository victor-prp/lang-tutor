import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createServerDeps } from '../../../src/composition';
import { InvalidLanguagePair, UsernameTaken, UserNotFound } from '../../../src/errors';
import type { UserService } from '../../../src/services/users';
import { createFakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import { createTestDb, type TestDb } from '../../support/testDb';

// The other half is src/services/users.test.ts. This half exists for the one
// thing a fake cannot decide: whether the database actually refuses a duplicate.

let t: TestDb;
let service: UserService;

beforeEach(async () => {
  t = await createTestDb();
  service = createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }).users;
});

afterEach(async () => {
  await t.close();
});

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
  target_language: 'en' as const,
};

describe('register', () => {
  it('persists a user that login can then find', async () => {
    const created = await service.register(REQUEST);
    expect(await service.login('dana')).toEqual(created);
  });

  it('issues an id the caller did not supply', async () => {
    const created = await service.register(REQUEST);
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('refuses a username the database already holds', async () => {
    await service.register(REQUEST);
    await expect(
      service.register({ ...REQUEST, display_name: 'אחרת' }),
    ).rejects.toBeInstanceOf(UsernameTaken);
  });

  it('refuses a matching language pair', async () => {
    await expect(
      service.register({ ...REQUEST, target_language: 'he' }),
    ).rejects.toBeInstanceOf(InvalidLanguagePair);
  });
});

describe('login', () => {
  it('throws UserNotFound for a username nobody registered', async () => {
    await expect(service.login('nobody')).rejects.toBeInstanceOf(UserNotFound);
  });
});
