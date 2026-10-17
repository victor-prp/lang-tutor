import { sql } from 'drizzle-orm';

import { createDb } from '../../../apps/server/src/db/client';
import { E2E_DATABASE_URL } from '../../globalSetup';

/** Phase 61 (spec D1). Makes `username` a tester, as `npm run db:tester` would, straight
 *  into this lane's e2e database. */
export async function makeTester(username: string): Promise<void> {
  const handle = createDb(E2E_DATABASE_URL, { max: 1, onError: () => {} });
  try {
    await handle.db.execute(sql`update users set tester = true where username = ${username}`);
  } finally {
    await handle.close();
  }
}
