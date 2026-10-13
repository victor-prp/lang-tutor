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
    /**
     * Phase 34. `singletonKey` holds only on a queue whose policy names it (an
     * `exclusive` queue keeps one job per key queued or active); a second send
     * while one is there is a no-op. Phase 43: `startAfterSeconds` holds the job
     * back that long, and a held job counts as queued.
     */
    enqueue: async <N extends JobName>(
      name: N,
      data: JobPayloads[N],
      options?: { singletonKey?: string; startAfterSeconds?: number },
    ): Promise<void> => {
      await boss.send(name, data, {
        db: fromDrizzle(tx, sql),
        ...(options?.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}),
        ...(options?.startAfterSeconds !== undefined ? { startAfter: options.startAfterSeconds } : {}),
      });
    },

    /**
     * Phase 43 (review I1). Enqueues the job, or, while the one with this key is
     * still waiting to start, moves its start to `startAfterSeconds` from now:
     * a trailing delay, so the job runs that long after the last of a burst.
     */
    enqueueOrPostpone: async <N extends JobName>(
      name: N,
      data: JobPayloads[N],
      options: { singletonKey: string; startAfterSeconds: number },
    ): Promise<void> => {
      await boss.upsert(name, data, {
        db: fromDrizzle(tx, sql),
        singletonKey: options.singletonKey,
        startAfter: options.startAfterSeconds,
      });
    },
  };
}

export type JobRepo = ReturnType<typeof createJobRepo>;
