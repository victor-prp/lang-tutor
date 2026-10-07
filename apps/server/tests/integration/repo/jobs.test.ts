import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION } from '../../../src/domain/jobs';
import { createJobRepo } from '../../../src/repo/jobs';
import { countJobs, startTestBoss, stopTestBoss } from '../../support/jobs';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
let boss: PgBoss;

beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

const payload = { session_id: 's1', picks: [{ sense_id: 'x', variant_id: 'y' }], listening: false, ordinal: 0 };

describe('createJobRepo', () => {
  it('enqueues inside the caller transaction: committed, one job', async () => {
    await withTx(t.db, (tx) => createJobRepo(tx, boss).enqueue(PREPARE_SESSION, payload));
    expect(await countJobs(t.db, PREPARE_SESSION)).toBe(1);
  });

  it('a rolled-back transaction leaves no job', async () => {
    await expect(
      withTx(t.db, async (tx) => {
        await createJobRepo(tx, boss).enqueue(PREPARE_SESSION, payload);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await countJobs(t.db, PREPARE_SESSION)).toBe(0);
  });
});
