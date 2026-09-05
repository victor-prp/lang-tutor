import { createDb } from './client';
import { runMigrations } from './migrate';
import { seedContent } from './seed';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lang_tutor';

async function main(): Promise<void> {
  const { db, close } = createDb(url, {
    onError: (error) => console.error('unexpected error on idle Postgres client', error),
  });
  try {
    await runMigrations(db);
    await seedContent(db);
    console.log(`migrated and seeded ${url}`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
