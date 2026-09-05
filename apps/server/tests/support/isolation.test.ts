import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { users } from '../../src/db/schema';
import { createTestDb, type TestDb } from './testDb';

let current: TestDb;

beforeEach(async () => {
  current = await createTestDb();
});

afterEach(async () => {
  await current.close();
});

describe('per-test database isolation', () => {
  it('starts with no users and writes one', async () => {
    expect(await current.db.select().from(users)).toEqual([]);
    await current.db.insert(users).values({ id: 'written-by-test-one' });
    expect(await current.db.select().from(users)).toHaveLength(1);
  });

  it('does not see the row the previous test wrote', async () => {
    // Fails if tests share a database, or if a truncate-between-tests strategy
    // were used and missed a table.
    expect(await current.db.select().from(users)).toEqual([]);
  });

  it('gets a distinct database name per test', async () => {
    const other = await createTestDb();
    try {
      expect(other.name).not.toBe(current.name);
    } finally {
      await other.close();
    }
  });
});
