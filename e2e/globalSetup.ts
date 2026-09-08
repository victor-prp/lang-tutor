import { sql } from 'drizzle-orm';

import { createDb } from '../apps/server/src/db/client';
import { runMigrations } from '../apps/server/src/db/migrate';
import { seedContent } from '../apps/server/src/db/seed';
import { MOCKSERVER_URL } from './urls';

const HOST = process.env.PGHOST ?? 'localhost';
const PORT = process.env.PGPORT ?? '5432';
const ADMIN_URL = `postgres://postgres:postgres@${HOST}:${PORT}/postgres`;

export const E2E_DATABASE = 'lang_tutor_e2e';
export const E2E_DATABASE_URL = `postgres://postgres:postgres@${HOST}:${PORT}/${E2E_DATABASE}`;

/**
 * Playwright starts its own long-lived server, so the per-test clone strategy
 * used by the Jest suites does not apply here. One database, dropped and rebuilt
 * per run, keeps the suite reproducible without needing a retention rule.
 */
export default async function globalSetup(): Promise<void> {
  // A read-only liveness GET, not `PUT /mockserver/reset`: the container is
  // shared, and a developer may have an integration run in flight against it.
  // Each spec clears only the /e2e namespace.
  const probe = await fetch(`${MOCKSERVER_URL}/liveness/probe`).catch(
    (error: unknown) => error as Error,
  );
  if (probe instanceof Error || !probe.ok) {
    throw new Error(
      `MockServer unreachable at ${MOCKSERVER_URL}\n` +
        'Run `npm run db:up` first (requires Docker).',
    );
  }

  const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    await admin.db.execute(sql.raw(`drop database if exists ${E2E_DATABASE} with (force)`));
    await admin.db.execute(sql.raw(`create database ${E2E_DATABASE}`));
  } finally {
    await admin.close();
  }

  const handle = createDb(E2E_DATABASE_URL, { max: 1, onError: () => {} });
  try {
    await runMigrations(handle.db);
    await seedContent(handle.db);
  } finally {
    await handle.close();
  }
}

// Playwright's own `globalSetup` config hook runs AFTER its `webServer` entries
// are already started and polled for health (verified empirically: with this
// file wired in as `globalSetup`, the server booted and `/health` polling ran
// for the full 60s timeout, and this function's body never executed). Since
// the server's `/health` depends on the e2e database existing, wiring this
// file in as Playwright's `globalSetup` would deadlock rather than provision
// anything. Instead this file is invoked directly, before `playwright test`
// starts, so the database exists by the time the server's readiness probe
// runs. See e2e/package.json's `e2e` script and playwright.config.ts's
// comment above its webServer entries.
if (require.main === module) {
  globalSetup().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
