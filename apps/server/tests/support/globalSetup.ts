import { sql } from 'drizzle-orm';

import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { seedContent } from '../../src/db/seed';
import { ADMIN_URL, templateName, urlFor } from './dbNames';

/**
 * Migrating and seeding is the expensive part, so it happens once per worker
 * into a template. Each test then clones its template, which Postgres does as a
 * copy — tens of milliseconds, and parallel across workers.
 */
export default async function globalSetup(config: { maxWorkers: number }): Promise<void> {
  const admin = createDb(ADMIN_URL, 1);

  try {
    await admin.db.execute(sql`select 1`);
  } catch (error) {
    await admin.close().catch(() => undefined);
    // A driver stack trace here reads like a code failure. It is not.
    throw new Error(
      `Postgres unreachable at ${ADMIN_URL}\n` +
        'Run `npm run db:up` first (requires Docker).\n' +
        `Underlying error: ${(error as Error).message}`,
    );
  }

  try {
    for (let worker = 1; worker <= config.maxWorkers; worker++) {
      const name = templateName(worker);
      await admin.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
      await admin.db.execute(sql.raw(`create database ${name}`));

      const handle = createDb(urlFor(name), 1);
      try {
        await runMigrations(handle.db);
        await seedContent(handle.db);
      } finally {
        // The template must have no open connections, or cloning it fails.
        await handle.close();
      }
    }
  } finally {
    await admin.close();
  }
}
