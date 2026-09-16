import { sql } from 'drizzle-orm';

import { createDb } from '../../src/db/client';
import { ADMIN_URL } from './dbNames';

/**
 * How long a test may spend dropping databases.
 *
 * DROP DATABASE requests an immediate checkpoint and waits for it, and while the
 * integration suite runs, every other worker is cloning a database per test —
 * one drop was measured at 33 seconds under that load. The 30s testTimeout in
 * jest.config.js is sized for a clone and a pool, not for that.
 *
 * This is also why testDb.ts never drops anything: a per-test database is left
 * for the next run's sweep, which runs alone in globalSetup before any worker
 * starts. Only a test whose databases fall outside the sweep's prefix has to
 * clean up after itself, and it should do so once per file rather than per test.
 */
export const DROP_TIMEOUT_MS = 120_000;

/**
 * Drops each database if it is there, concurrently.
 *
 * Concurrently on purpose: the drops are independent, and the checkpoint each
 * one waits for is a single server-wide event, so four together cost roughly one
 * wait rather than four.
 */
export async function dropDatabases(names: string[]): Promise<void> {
  const admin = createDb(ADMIN_URL, { max: names.length, onError: () => {} });
  try {
    await Promise.all(
      names.map((name) => {
        const quoted = `"${name.replace(/"/g, '""')}"`;
        return admin.db.execute(sql.raw(`drop database if exists ${quoted} with (force)`));
      }),
    );
  } finally {
    await admin.close();
  }
}
