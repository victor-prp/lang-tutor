import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { users } from '../../../src/db/schema';
import { ProfileExists, UsernameTaken } from '../../../src/errors';
import { createUserRepo } from '../../../src/repo/users';
import { seedIdentity } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  // Phase 29: a profile's id is its sign-in identity's (migration 0023).
  await seedIdentity(t.db, 'u_dana');
  await seedIdentity(t.db, 'u_other');
});

afterEach(async () => {
  await t.close();
});

const DANA = {
  id: 'u_dana',
  username: 'dana',
  displayName: 'דנה',
  age: 34,
  nativeLanguage: 'he',
};

describe('the users table', () => {
  it('rejects a second row with the same username', async () => {
    await withTx(t.db, (tx) => tx.insert(users).values(DANA));
    await expect(
      withTx(t.db, (tx) => tx.insert(users).values({ ...DANA, id: 'u_other', displayName: 'אחר' })),
    ).rejects.toThrow();
  });

  it.each([
    ['an uppercase username', { username: 'Dana' }],
    ['a two-character username', { username: 'da' }],
    ['an empty display name', { displayName: '' }],
    ['an age below the floor', { age: 2 }],
    ['an age above the ceiling', { age: 121 }],
  ])('rejects %s', async (_label, override) => {
    await expect(
      withTx(t.db, (tx) => tx.insert(users).values({ ...DANA, ...override })),
    ).rejects.toThrow();
  });

  // Raw SQL on purpose: the columns are NOT NULL, so Drizzle's types already
  // refuse this. The point is that the database refuses it too, for anything
  // that reaches the table without passing through them.
  it('refuses a row with no profile', async () => {
    await seedIdentity(t.db, 'bare');
    await expect(
      withTx(t.db, (tx) => tx.execute(sql`insert into users (id) values ('bare')`)),
    ).rejects.toThrow();
  });
});

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
};

describe('createUserRepo', () => {
  it('inserts a profile under the id it is given', async () => {
    const user = await withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', REQUEST));

    expect(user).toEqual({
      id: 'u_dana',
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he',
    });
  });

  it('throws UsernameTaken rather than a raw driver error when another user holds the username', async () => {
    await withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', REQUEST));

    await expect(
      withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_other', { ...REQUEST, display_name: 'אחרת' })),
    ).rejects.toBeInstanceOf(UsernameTaken);
  });

  it('throws ProfileExists for a second profile under one id', async () => {
    await withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', REQUEST));

    await expect(
      withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', { ...REQUEST, username: 'dana_two' })),
    ).rejects.toBeInstanceOf(ProfileExists);
  });

  // What a double tap sends: the same id AND the same username. The primary key
  // is checked first, so the answer is the true one — the profile exists.
  it('throws ProfileExists, not UsernameTaken, for the same request twice', async () => {
    await withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', REQUEST));

    await expect(
      withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', REQUEST)),
    ).rejects.toBeInstanceOf(ProfileExists);
  });

  it('finds a user by username', async () => {
    const created = await withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', REQUEST));
    const found = await withTx(t.db, (tx) => createUserRepo(tx).findByUsername('dana'));
    expect(found).toEqual(created);
  });

  it('returns undefined for a username nobody has', async () => {
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findByUsername('nobody'))).toBeUndefined();
  });

  it('finds a user by id', async () => {
    const created = await withTx(t.db, (tx) => createUserRepo(tx).insertUser('u_dana', REQUEST));
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findById('u_dana'))).toEqual(created);
  });

  it('returns undefined for an id nobody has', async () => {
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findById('no-such-id'))).toBeUndefined();
  });
});
