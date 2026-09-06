import type { Db, Tx } from './client';

// The transaction seam. Generic in what it binds, so `db/` never learns that
// `repo/` exists — composition.ts supplies `bind`.
//
// `Tx` does not escape: a caller receives only what `bind` returns. That is the
// point. A service handed a `Db` can reach `db.query.<table>` and read any table
// in the schema without importing anything, so R2's import rules would never see
// it; a service handed one of these has no name in scope that leads to Drizzle.
export function createTransaction<R>(db: Db, bind: (tx: Tx) => R) {
  return <T>(run: (bound: R) => Promise<T>): Promise<T> =>
    db.transaction((tx) => run(bind(tx)));
}
