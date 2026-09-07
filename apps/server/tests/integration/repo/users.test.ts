import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { users } from '../../../src/db/schema';
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

  // Transitional: upsertUser still writes a bare row until task 10 tightens
  // these columns to NOT NULL. Delete this test in task 10.
  it('still accepts a row with no profile, until task 10', async () => {
    const [row] = await withTx(t.db, (tx) =>
      tx.insert(users).values({ id: 'legacy-1' }).returning(),
    );
    expect(row.username).toBeNull();
  });
});
