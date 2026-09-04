import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from './client';

// Deliberately the maintenance database: this test proves connectivity only,
// and must not depend on lang_tutor having been migrated yet.
const URL = 'postgres://postgres:postgres@localhost:5432/postgres';

const handle = createDb(URL);

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
});
