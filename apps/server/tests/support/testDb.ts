import { sql } from 'drizzle-orm';

import { createDb, type Db } from '../../src/db/client';
import { ADMIN_URL, currentWorkerId, templateName, urlFor } from './dbNames';

let counter = 0;

export type TestDb = { db: Db; name: string; close: () => Promise<void> };

/**
 * A database of its own for one test. Nothing is shared with any other test and
 * nothing is reused: every clone starts from the template's pristine seed.
 */
export async function createTestDb(): Promise<TestDb> {
  const worker = currentWorkerId();
  const name = `lang_tutor_test_${worker}_${counter++}`;
  const admin = createDb(ADMIN_URL, 1);

  try {
    await admin.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
    await admin.db.execute(
      sql.raw(`create database ${name} template ${templateName(worker)}`),
    );
  } finally {
    await admin.close();
  }

  const handle = createDb(urlFor(name));

  return {
    db: handle.db,
    name,
    close: async () => {
      // DROP DATABASE fails while any connection remains, so end the pool first.
      await handle.close();
      const dropper = createDb(ADMIN_URL, 1);
      try {
        await dropper.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
      } finally {
        await dropper.close();
      }
    },
  };
}
