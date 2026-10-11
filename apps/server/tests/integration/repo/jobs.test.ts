import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { ACCEPT_RENDERING, PREPARE_SESSION } from '../../../src/domain/jobs';
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

const payload = { session_id: 's1', picks: [{ gloss_id: 'g', sense_id: 'x', variant_id: 'y', dimension: 'written_receptive' as const, rung: 1 as const, level: 1, r: null }], listening: false, speaking: false };

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

  // Phase 34 (spec D1). On the accept queue, whose policy is `exclusive`.
  it('holds one job per singleton key while it is queued, and a job for another key beside it', async () => {
    const accept = (variant: string) => ({ variant_id: variant, sense_id: 's', user_language_code: 'he' });
    await withTx(t.db, (tx) => createJobRepo(tx, boss).enqueue(ACCEPT_RENDERING, accept('v1'), { singletonKey: 'v1:s:he' }));
    await withTx(t.db, (tx) => createJobRepo(tx, boss).enqueue(ACCEPT_RENDERING, accept('v1'), { singletonKey: 'v1:s:he' }));
    expect(await countJobs(t.db, ACCEPT_RENDERING)).toBe(1);
    await withTx(t.db, (tx) => createJobRepo(tx, boss).enqueue(ACCEPT_RENDERING, accept('v2'), { singletonKey: 'v2:s:he' }));
    expect(await countJobs(t.db, ACCEPT_RENDERING)).toBe(2);
  });
});
