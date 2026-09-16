import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import { users } from '../../../src/db/schema';
import { seedUser } from '../../support/seedUser';
import { ADMIN_URL, dbPrefix } from '../../support/dbNames';
import { createTestDb, type TestDb } from '../../support/testDb';

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
    await seedUser(current.db, 'written_by_test_one');
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

  it("names the database after the test, under this lane's prefix", async () => {
    // The slug is the full "describe > it" name, so it is long enough to be
    // truncated — which is the interesting half of the assertion. The budget is
    // computed from the prefix, not from a constant: a lane's prefix is longer
    // than lane 0's bare `t_`, and a fixed budget would overrun the 63-byte
    // identifier limit and silently collide two tests.
    const prefix = dbPrefix();
    const parts = current.name.match(new RegExp(`^${prefix}test_([a-z0-9_]+)_([0-9a-f]{8})$`));
    expect(parts).not.toBeNull();

    // A truncation of this test's own name, never a rewriting of it — asserted
    // as a prefix rather than against a literal, because where the cut falls is
    // a function of how long THIS lane's prefix is, and pinning it to a literal
    // would be the constant this test exists to rule out.
    const [, slug] = parts ?? [];
    expect(
      'per_test_database_isolation_names_the_database_after_the_test_under_this_lane_s_prefix',
    ).toContain(slug);
    expect(slug.length).toBeGreaterThan(20);
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
        "per-test database isolation names the database after the test, under this lane's prefix",
      );
      expect(comment).toContain('isolation.test.ts');
      expect(comment).toContain(`worker: ${process.env.JEST_WORKER_ID ?? '1'}`);
      expect(comment).toMatch(/created: \d{4}-\d{2}-\d{2}T/);
    } finally {
      await admin.close();
    }
  });

  it('takes its prefix from the environment, so two checkouts never collide', async () => {
    // Not a tautology: this is the assertion that fails if TEST_DB_PREFIX is
    // read once at import time by one module and ignored by another.
    expect(dbPrefix()).toBe(process.env.TEST_DB_PREFIX ?? 't_');
  });
});
