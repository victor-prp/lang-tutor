import { loadConfig } from '../config';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { reseedContent } from './reseed';
import { seedContent } from './seed';

// A second process is a legitimate second composition root — but it reads the
// same config as the first rather than a copy-pasted connection string.
async function main(): Promise<void> {
  const { databaseUrl, poolMax } = loadConfig(process.env);
  const { db, close } = createDb(databaseUrl, {
    max: poolMax,
    onError: (error) => console.error('unexpected error on idle Postgres client', error),
  });
  // A flag rather than a second entry point: ADR 0002 names three composition
  // roots, and a fourth for a five-line command would be an ADR edit paying
  // for nothing. `process.argv` is not `process.env`, and this file is a
  // composition root either way.
  const reseed = process.argv.includes('--reseed');
  try {
    await runMigrations(db);
    if (reseed) {
      await reseedContent(db);
      console.log(`migrated and RESEEDED ${databaseUrl} — the dictionary was cleared first,`);
      console.log('so every looked-up word is gone as well as every recorded one.');
    } else {
      await seedContent(db);
      console.log(`migrated and seeded ${databaseUrl}`);
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
