import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

// The only place a connection is created. Everything downstream receives the
// handle it returns — see the DI rule in the spec. A module-level `export const
// db` here would give every test in a Jest worker one connection to one
// database, and the per-test cloned database would be unreachable.
export function createDb(
  connectionString: string,
  options: { max?: number; onError: (error: Error) => void },
) {
  const pool = new Pool({ connectionString, max: options.max ?? 5 });
  // The policy is received, not decided here: `db/` does not get to choose what
  // an idle-client failure means to the process it is running in.
  pool.on('error', options.onError);
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

// One type for both a database and a transaction handle: Drizzle's transaction
// object is structurally compatible, so a service can pass its `tx` wherever a
// `Db` is expected. Named as `NodePgDatabase<schema>` rather than
// `ReturnType<typeof createDb>['db']`: `drizzle()`'s return type is that plus a
// `$client: Pool` intersection member, which a `PgTransaction` does not have —
// keeping that member out of `Db` is what makes the "pass `tx` as `Db`" claim
// above actually typecheck.
export type Db = NodePgDatabase<typeof schema>;

// A transaction handle, derived from what Drizzle actually hands the transaction
// callback rather than hand-written from its generics. `Db` accepts a `Tx`, but
// not the reverse — which is what makes "one transaction per use case" a
// compile error instead of a convention someone has to remember.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
