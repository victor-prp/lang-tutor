import { randomUUID } from 'node:crypto';

import { expect } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb, type Db } from '../../src/db/client';
import { ADMIN_URL, currentWorkerId, templateName, testDbName, urlFor } from './dbNames';

export type TestDb = { db: Db; name: string; close: () => Promise<void> };

/**
 * A database of its own for one test. Nothing is shared with any other test and
 * nothing is reused: every clone starts from the template's pristine seed.
 *
 * The database outlives the test on purpose — `close()` ends the pool but does
 * not drop, so after a run `\l` shows which test each database served and `\l+`
 * shows the detail. globalSetup's sweep reclaims them on the next run.
 */
export async function createTestDb(): Promise<TestDb> {
  const worker = currentWorkerId();
  // Available inside beforeEach, not only inside the test body: jest-circus sets
  // it before the hooks for the test it is about to run. Verified, not assumed.
  const state = expect.getState();
  const testName = state.currentTestName ?? 'unnamed';
  const name = testDbName(testName, randomUUID().slice(0, 8));

  // A no-op error policy: a per-test handle lives for one test and has no logger
  // to route an idle-client error to.
  const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });

  try {
    // No `drop database if exists` first: the random suffix makes a live
    // collision impossible, and stale databases are the sweep's job, not this
    // call's — paying a round trip per test to re-check that is waste.
    await admin.db.execute(
      sql.raw(`create database ${name} template ${templateName(worker)}`),
    );

    // What the 63-byte identifier could not carry. COMMENT ON DATABASE writes to
    // a shared catalog, so it works from the maintenance connection — no second
    // connection into the new database is needed.
    const comment = [
      `test: ${testName}`,
      `file: ${state.testPath ?? 'unknown'}`,
      `worker: ${worker}`,
      `created: ${new Date().toISOString()}`,
    ].join(' | ');
    await admin.db.execute(
      sql.raw(`comment on database ${name} is '${comment.replace(/'/g, "''")}'`),
    );
  } finally {
    await admin.close();
  }

  const handle = createDb(urlFor(name), { onError: () => {} });

  return {
    db: handle.db,
    name,
    close: async () => {
      // Only the pool. Ending it is load-bearing against Postgres's
      // max_connections; dropping the database is not, and would throw away the
      // name and COMMENT this phase exists to leave behind.
      await handle.close();
    },
  };
}
