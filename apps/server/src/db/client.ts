import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

// The only place a connection is created. Everything downstream receives the
// handle it returns — see the DI rule in the spec. A module-level `export const
// db` here would give every test in a Jest worker one connection to one
// database, and the per-test cloned database would be unreachable.
export function createDb(connectionString: string, max = 5) {
  const pool = new Pool({ connectionString, max });
  pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client', err);
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

// One type for both a database and a transaction handle: Drizzle's transaction
// object is structurally compatible, so a service can pass its `tx` wherever a
// `Db` is expected.
export type Db = ReturnType<typeof createDb>['db'];
