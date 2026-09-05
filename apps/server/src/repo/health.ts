import { sql } from 'drizzle-orm';

import type { Db } from '../db/client';

// The pool handle, not a transaction handle: this is the one place a
// non-transactional call is genuinely intended.
export function createHealthRepo(db: Db) {
  return {
    // A boolean rather than a throw, so app.ts maps an outcome to a status code
    // with no try/catch — "wires everything, holds no logic" survives.
    ping: async (): Promise<boolean> => {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type HealthRepo = ReturnType<typeof createHealthRepo>;
