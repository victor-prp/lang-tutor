import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../src/db/client';
import { users } from '../../src/db/schema';
import { ADMIN_URL } from './dbNames';
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

  it('names the database after the test and comments it with the detail', async () => {
    // The slug is the full "describe > it" name, so it is long enough to be
    // truncated — which is the interesting half of the assertion. 63-byte limit
    // minus `t_test_` (7), the separator (1) and 8 hex chars leaves 47 for the
    // slug; this name's slug is cut to 46 because the 47th character was `_`.
    expect(current.name).toMatch(
      /^t_test_per_test_database_isolation_names_the_database_[0-9a-f]{8}$/,
    );
    expect(current.name.length).toBeLessThanOrEqual(63);

    const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });
    try {
      const result = await admin.db.execute<{ comment: string | null }>(sql`
        select shobj_description(oid, 'pg_database') as comment
        from pg_database
        where datname = ${current.name}
      `);
      const comment = result.rows[0]?.comment ?? '';
      // The untruncated name, which is what the identifier could not carry.
      expect(comment).toContain(
        'per-test database isolation names the database after the test and comments it with the detail',
      );
      expect(comment).toContain('isolation.test.ts');
      expect(comment).toContain(`worker: ${process.env.JEST_WORKER_ID ?? '1'}`);
      expect(comment).toMatch(/created: \d{4}-\d{2}-\d{2}T/);
    } finally {
      await admin.close();
    }
  });
});
