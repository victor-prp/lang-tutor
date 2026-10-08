import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createTestServerDeps } from '../../support/serverDeps';
import { ProfileExists, UsernameTaken } from '../../../src/errors';
import type { UserService } from '../../../src/services/users';
import { createFakeLogger } from '../../support/fakes';
import { seedIdentity } from '../../support/seedUser';
import { testRng } from '../../support/testRng';
import { createTestDb, type TestDb } from '../../support/testDb';

// The other half is src/services/users.test.ts. This half exists for what a
// fake cannot decide: whether the database actually refuses a duplicate.

let t: TestDb;
let service: UserService;

beforeEach(async () => {
  t = await createTestDb();
  // Phase 29: signing in creates the identity; onboarding creates the profile.
  await seedIdentity(t.db, 'u_dana');
  await seedIdentity(t.db, 'u_other');
  service = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }).users;
});

afterEach(async () => {
  await t.close();
});

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
};

describe('createProfile', () => {
  it("persists the profile under the signed-in user's id, which me then finds", async () => {
    const created = await service.createProfile('u_dana', REQUEST);
    expect(created).toEqual({ id: 'u_dana', ...REQUEST });
    expect(await service.me('u_dana')).toEqual(created);
    expect(await service.hasProfile('u_dana')).toBe(true);
  });

  it('refuses a username the database already holds for another user', async () => {
    await service.createProfile('u_dana', REQUEST);
    await expect(service.createProfile('u_other', { ...REQUEST, display_name: 'אחרת' })).rejects.toBeInstanceOf(
      UsernameTaken,
    );
  });

  it('refuses a second profile for one user', async () => {
    await service.createProfile('u_dana', REQUEST);
    await expect(service.createProfile('u_dana', { ...REQUEST, username: 'dana_two' })).rejects.toBeInstanceOf(
      ProfileExists,
    );
  });
});

describe('me and hasProfile', () => {
  it('answer null and false for a signed-in user before onboarding', async () => {
    expect(await service.me('u_dana')).toBeNull();
    expect(await service.hasProfile('u_dana')).toBe(false);
  });
});
