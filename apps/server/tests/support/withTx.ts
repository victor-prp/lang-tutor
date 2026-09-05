import type { Db, Tx } from '../../src/db/client';

// A thin pass-through to db.transaction, not a try/catch: the repositories take a
// transaction handle, so their tests bind one the way production does. Nothing is
// caught here — a helper that swallowed a rollback would let a test report success
// on work the database discarded.
export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
