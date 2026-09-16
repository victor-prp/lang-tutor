import { sql } from 'drizzle-orm';

import { createDb } from '../../apps/server/src/db/client';
import { runMigrations } from '../../apps/server/src/db/migrate';
import { seedContent } from '../../apps/server/src/db/seed';

const HOST = process.env.PGHOST ?? 'localhost';
const PORT = process.env.PGPORT ?? '5432';
const ADMIN_URL = `postgres://postgres:postgres@${HOST}:${PORT}/postgres`;

/**
 * A database of its own, not e2e's. The two suites must be able to run at the
 * same time without one dropping the other's database out from under it, and a
 * QA run wants a guaranteed-empty dictionary anyway: every lookup the agent
 * makes should reach the real provider, which is the whole point of the run.
 */
export const QA_DATABASE = 'lang_tutor_qa';
export const QA_DATABASE_URL = `postgres://postgres:postgres@${HOST}:${PORT}/${QA_DATABASE}`;

export async function provision(): Promise<void> {
  const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    await admin.db.execute(sql.raw(`drop database if exists ${QA_DATABASE} with (force)`));
    await admin.db.execute(sql.raw(`create database ${QA_DATABASE}`));
  } finally {
    await admin.close();
  }

  const handle = createDb(QA_DATABASE_URL, { max: 1, onError: () => {} });
  try {
    await runMigrations(handle.db);
    await seedContent(handle.db);
  } finally {
    await handle.close();
  }
}

if (require.main === module) {
  provision()
    .then(() => console.log(`  ok         ${QA_DATABASE} provisioned`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
