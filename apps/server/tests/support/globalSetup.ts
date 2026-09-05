import { sql } from 'drizzle-orm';

import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { seedContent } from '../../src/db/seed';
import { ADMIN_URL, templateName, urlFor } from './dbNames';

/**
 * Sweeps the previous run's databases, then migrates and seeds one template per
 * worker. Migrating and seeding is the expensive part, so it happens once per
 * worker; each test then clones its template, which Postgres does as a copy —
 * tens of milliseconds, and parallel across workers.
 */
export default async function globalSetup(config: { maxWorkers: number }): Promise<void> {
  const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });

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
    // Reclaim everything the last run left behind — per-test databases (kept on
    // purpose so they could be inspected) and worker templates alike. Matching by
    // pattern rather than dropping templates by exact worker number is what stops
    // a 4-worker run followed by a 2-worker run from stranding t_tmpl_3 and 4.
    //
    // A regex, and both prefixes spelled out, rather than LIKE 't_%'. Two reasons,
    // and neither is style: `_` is a LIKE wildcard, so 't_%' would also sweep
    // `taxes` and `todo` — in a POSIX regex `_` is literal, so there is no escape
    // to get wrong. And naming the two prefixes keeps the blast radius to database
    // names this harness actually creates; a bare `t_` prefix match would take a
    // hand-made `t_scratch` with it. A third category of test database, if one is
    // ever added, goes in this pattern deliberately.
    const stale = await admin.db.execute<{ datname: string }>(
      sql`select datname from pg_database where datname ~ ${'^t_(test|tmpl)_'}`,
    );
    for (const { datname } of stale.rows) {
      // Quoted and with embedded double-quotes escaped Postgres-style: an
      // unquoted identifier that needs folding (mixed case, a space — anything
      // still matching the sweep regex above) would otherwise fail this DROP,
      // and since this sweep is the only thing that ever removes such a
      // database, every later run would die here the same way until a human
      // dropped it by hand.
      const quoted = `"${datname.replace(/"/g, '""')}"`;
      await admin.db.execute(sql.raw(`drop database if exists ${quoted} with (force)`));
    }

    for (let worker = 1; worker <= config.maxWorkers; worker++) {
      const name = templateName(worker);
      await admin.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
      await admin.db.execute(sql.raw(`create database ${name}`));

      const handle = createDb(urlFor(name), { max: 1, onError: () => {} });
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
