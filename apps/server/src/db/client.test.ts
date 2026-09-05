import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb, type Tx } from './client';
import { ADMIN_URL } from '../../tests/support/dbNames';

// Deliberately the maintenance database: this test proves connectivity only,
// and must not depend on lang_tutor having been migrated yet. A no-op error
// policy is what a short-lived test handle wants — there is no logger here to
// route an idle-client error to, and nothing to do about one.
const handle = createDb(ADMIN_URL, { max: 1, onError: () => {} });

// A compile-time assertion, not a runtime one: the pool handle must not satisfy
// `Tx`. If this ever compiles, tsc fails on the unused directive — so the
// asymmetry cannot silently regress.
// @ts-expect-error a pool handle is not a transaction handle
const notATransaction: Tx = handle.db;
void notATransaction;

afterAll(() => handle.close());

describe('createDb', () => {
  it('returns a handle that can query Postgres', async () => {
    const result = await handle.db.execute(sql`select 1 as one`);
    expect(result.rows[0]).toEqual({ one: 1 });
  });

  it('reports the server version, proving a real connection', async () => {
    const result = await handle.db.execute<{ server_version: string }>(sql`show server_version`);
    expect(result.rows[0].server_version).toMatch(/^17\./);
  });

  // The options object is the point of the new signature: under the old
  // positional `max` it lands in the pool config as an object, not a number.
  it('applies the pool size it is given', () => {
    expect(handle.pool.options.max).toBe(1);
  });
});
