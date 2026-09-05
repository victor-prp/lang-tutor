import { sql } from 'drizzle-orm';

import { createDb } from '../../src/db/client';
import { ADMIN_URL, templateName } from './dbNames';

export default async function globalTeardown(config: { maxWorkers: number }): Promise<void> {
  const admin = createDb(ADMIN_URL, 1);
  try {
    for (let worker = 1; worker <= config.maxWorkers; worker++) {
      await admin.db.execute(
        sql.raw(`drop database if exists ${templateName(worker)} with (force)`),
      );
    }
  } finally {
    await admin.close();
  }
}
