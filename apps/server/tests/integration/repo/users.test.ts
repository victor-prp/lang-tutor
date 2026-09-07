import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { users } from '../../../src/db/schema';
import { UsernameTaken } from '../../../src/errors';
import { createUserRepo } from '../../../src/repo/users';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

const DANA = {
  username: 'dana',
  displayName: 'דנה',
  age: 34,
  nativeLanguage: 'he',
  targetLanguage: 'en',
};

describe('the users table', () => {
  it('generates an id when the caller supplies none', async () => {
    const [row] = await withTx(t.db, (tx) => tx.insert(users).values(DANA).returning());
    // A UUID, not something a client picked: 36 characters with four hyphens.
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('rejects a second row with the same username', async () => {
    await withTx(t.db, (tx) => tx.insert(users).values(DANA));
    await expect(
      withTx(t.db, (tx) => tx.insert(users).values({ ...DANA, displayName: 'אחר' })),
    ).rejects.toThrow();
  });

  it.each([
    ['an uppercase username', { username: 'Dana' }],
    ['a two-character username', { username: 'da' }],
    ['an empty display name', { displayName: '' }],
    ['an age below the floor', { age: 2 }],
    ['an age above the ceiling', { age: 121 }],
    ['a language pair that matches', { targetLanguage: 'he' }],
  ])('rejects %s', async (_label, override) => {
    await expect(
      withTx(t.db, (tx) => tx.insert(users).values({ ...DANA, ...override })),
    ).rejects.toThrow();
  });

  // Raw SQL on purpose: the columns are NOT NULL, so Drizzle's types already
  // refuse this. The point is that the database refuses it too, for anything
  // that reaches the table without passing through them.
  it('refuses a row with no profile', async () => {
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
  target_language: 'en' as const,
};

describe('createUserRepo', () => {
  it('inserts a user and returns it with a generated id', async () => {
    const user = await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));

    expect(user).toEqual({
      id: expect.any(String),
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he',
      target_language: 'en',
    });
    expect(user.id.length).toBeGreaterThan(0);
  });

  it('throws UsernameTaken rather than a raw driver error on a duplicate', async () => {
    await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));

    await expect(
      withTx(t.db, (tx) => createUserRepo(tx).insertUser({ ...REQUEST, display_name: 'אחרת' })),
    ).rejects.toBeInstanceOf(UsernameTaken);
  });

  it('finds a user by username', async () => {
    const created = await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));
    const found = await withTx(t.db, (tx) => createUserRepo(tx).findByUsername('dana'));
    expect(found).toEqual(created);
  });

  it('returns undefined for a username nobody has', async () => {
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findByUsername('nobody'))).toBeUndefined();
  });

  it('finds a user by id', async () => {
    const created = await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findById(created.id))).toEqual(created);
  });

  it('returns undefined for an id nobody has', async () => {
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findById('no-such-id'))).toBeUndefined();
  });
});
