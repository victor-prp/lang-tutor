import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { installJobs, JOB_SCHEMA } from '../../../src/db/jobs';
import {
  ACCEPT_RENDERING,
  ACCEPT_RENDERING_FAILED,
  LOOK_UP_IMPORT_ITEM,
  LOOK_UP_IMPORT_ITEM_FAILED,
  PREPARE_SESSION,
  PREPARE_SESSION_FAILED,
  READ_PHOTO,
  READ_PHOTO_FAILED,
  REMIND,
} from '../../../src/domain/jobs';
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
      // Phase 34 (ruling R12): twice the sum of the batch's 120 s (phase 47 D1),
      // the context call's 60 s and the checker's 60 s. Phase 62c (spec D1): and the
      // gap check's 60 s, the rewrite's 60 s and a rewritten card's context call's 60 s.
      // Phase 62d (spec D5): and the point check's, the typed gaps' rewrite's and the re-check's.
      expire_seconds: 1200,
      deletion_seconds: 86_400,
      dead_letter: PREPARE_SESSION_FAILED,
    });
  });

  it('creates the photo import queues with their policies', async () => {
    const rows = await t.db.execute<QueueRow>(
      sql.raw(
        `select name, retry_limit, retry_backoff, expire_seconds, deletion_seconds, dead_letter
           from ${JOB_SCHEMA}.queue
          where name in ('${READ_PHOTO}', '${READ_PHOTO_FAILED}', '${LOOK_UP_IMPORT_ITEM}', '${LOOK_UP_IMPORT_ITEM_FAILED}')
          order by name`,
      ),
    );
    expect(rows.rows.map((row) => row.name)).toEqual([
      LOOK_UP_IMPORT_ITEM,
      LOOK_UP_IMPORT_ITEM_FAILED,
      READ_PHOTO,
      READ_PHOTO_FAILED,
    ]);
    expect(rows.rows.find((row) => row.name === READ_PHOTO)).toMatchObject({
      retry_limit: 2,
      retry_backoff: true,
      expire_seconds: 240,
      deletion_seconds: 86_400,
      dead_letter: READ_PHOTO_FAILED,
    });
    expect(rows.rows.find((row) => row.name === LOOK_UP_IMPORT_ITEM)).toMatchObject({
      retry_limit: 2,
      retry_backoff: true,
      expire_seconds: 180,
      deletion_seconds: 86_400,
      dead_letter: LOOK_UP_IMPORT_ITEM_FAILED,
    });
  });

  // Phase 34 (spec D1). `exclusive` is what makes the singleton key hold: one
  // accept job per rendering queued or active.
  it('creates the accept queues, the job queue exclusive, and installs again without touching its policy', async () => {
    const read = async () =>
      (
        await t.db.execute<QueueRow & { policy: string }>(
          sql.raw(
            `select name, policy, retry_limit, retry_backoff, expire_seconds, deletion_seconds, dead_letter
               from ${JOB_SCHEMA}.queue
              where name in ('${ACCEPT_RENDERING}', '${ACCEPT_RENDERING_FAILED}')
              order by name`,
          ),
        )
      ).rows;
    const rows = await read();
    expect(rows.map((row) => row.name)).toEqual([ACCEPT_RENDERING, ACCEPT_RENDERING_FAILED]);
    expect(rows[0]).toMatchObject({
      policy: 'exclusive',
      retry_limit: 2,
      retry_backoff: true,
      expire_seconds: 120,
      deletion_seconds: 86_400,
      dead_letter: ACCEPT_RENDERING_FAILED,
    });
    await installJobs(t.db);
    expect(await read()).toEqual(rows);
  });

  // Phase 52 (spec D5). `exclusive` is what makes two overlapping ticks one run. No retry and
  // no dead letter: the next tick, five minutes on, covers a run that failed or expired.
  it('creates the remind queue exclusive, never retried, and expiring inside the five minutes between ticks', async () => {
    const rows = (
      await t.db.execute<QueueRow & { policy: string }>(
        sql.raw(
          `select name, policy, retry_limit, expire_seconds, deletion_seconds, dead_letter
             from ${JOB_SCHEMA}.queue
            where name = '${REMIND}'`,
        ),
      )
    ).rows;
    expect(rows).toEqual([
      { name: REMIND, policy: 'exclusive', retry_limit: 0, expire_seconds: 240, deletion_seconds: 86_400, dead_letter: null },
    ]);
  });

  it('is idempotent: a second install changes nothing', async () => {
    const before = await queues();
    await installJobs(t.db);
    expect(await queues()).toEqual(before);
  });
});
