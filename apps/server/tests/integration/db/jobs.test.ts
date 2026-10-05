import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { installJobs, JOB_SCHEMA } from '../../../src/db/jobs';
import { PREPARE_SESSION, PREPARE_SESSION_FAILED } from '../../../src/domain/jobs';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

type QueueRow = {
  name: string;
  retry_limit: number;
  retry_backoff: boolean;
  expire_seconds: number;
  deletion_seconds: number;
  dead_letter: string | null;
};

async function queues(): Promise<QueueRow[]> {
  const rows = await t.db.execute<QueueRow>(
    sql.raw(
      // Our two queues only: pg-boss may keep internal queues in the same table.
      `select name, retry_limit, retry_backoff, expire_seconds, deletion_seconds, dead_letter
         from ${JOB_SCHEMA}.queue
        where name in ('${PREPARE_SESSION}', '${PREPARE_SESSION_FAILED}')
        order by name`,
    ),
  );
  return rows.rows;
}

describe('installJobs', () => {
  it('leaves every migrated database with the pg-boss schema and both queues', async () => {
    // The template ran runMigrations, so a clone already has them.
    const rows = await queues();
    expect(rows.map((row) => row.name)).toEqual([PREPARE_SESSION, PREPARE_SESSION_FAILED]);

    const prepare = rows.find((row) => row.name === PREPARE_SESSION)!;
    expect(prepare).toMatchObject({
      retry_limit: 2,
      retry_backoff: true,
      expire_seconds: 240,
      deletion_seconds: 86_400,
      dead_letter: PREPARE_SESSION_FAILED,
    });
  });

  it('is idempotent: a second install changes nothing', async () => {
    const before = await queues();
    await installJobs(t.db);
    expect(await queues()).toEqual(before);
  });
});
