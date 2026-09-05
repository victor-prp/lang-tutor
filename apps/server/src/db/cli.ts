import { loadConfig } from '../config';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { seedContent } from './seed';

// A second process is a legitimate second composition root — but it reads the
// same config as the first rather than a copy-pasted connection string.
async function main(): Promise<void> {
  const { databaseUrl, poolMax } = loadConfig(process.env);
  const { db, close } = createDb(databaseUrl, {
    max: poolMax,
    onError: (error) => console.error('unexpected error on idle Postgres client', error),
  });
  try {
    await runMigrations(db);
    await seedContent(db);
    console.log(`migrated and seeded ${databaseUrl}`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
