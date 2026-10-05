import { sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';

import type { Tx } from '../db/client';
import type { JobName, JobPayloads } from '../domain/jobs';

/**
 * The only way anything enqueues a job (ADR 0007 rule 2). Bound to the use
 * case's transaction like every other repository, and the job row is written
 * through that same transaction: the job and the rows it is about commit
 * together or not at all.
 *
 * `boss` must be started: pg-boss resolves the queue through a cache that
 * start() fills. Constructed in index.ts and handed down; never built here.
 */
export function createJobRepo(tx: Tx, boss: PgBoss) {
  return {
    enqueue: async <N extends JobName>(name: N, data: JobPayloads[N]): Promise<void> => {
      await boss.send(name, data, { db: fromDrizzle(tx, sql) });
    },
  };
}

export type JobRepo = ReturnType<typeof createJobRepo>;
