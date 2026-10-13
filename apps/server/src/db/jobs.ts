import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle, type QueuePolicy } from 'pg-boss';

import {
  ACCEPT_RENDERING,
  ACCEPT_RENDERING_EXPIRY_SECONDS,
  ACCEPT_RENDERING_FAILED,
  LOOK_UP_IMPORT_ITEM,
  LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS,
  LOOK_UP_IMPORT_ITEM_FAILED,
  MERGE_GLOSSES,
  MERGE_GLOSSES_EXPIRY_SECONDS,
  PREPARE_SESSION,
  PREPARE_SESSION_EXPIRY_SECONDS,
  PREPARE_SESSION_FAILED,
  READ_PHOTO,
  READ_PHOTO_EXPIRY_SECONDS,
  READ_PHOTO_FAILED,
  RENDER_LEMMA,
  RENDER_LEMMA_EXPIRY_SECONDS,
  RENDER_LEMMA_FAILED,
  STOCK_SESSION,
  STOCK_SESSION_EXPIRY_SECONDS,
  type JobName,
} from '../domain/jobs';
import type { Db } from './client';

/**
 * The schema pg-boss lives in, inside whatever database it is handed. Each lane
 * and each cloned test database therefore has its own queue, with no new env
 * value and no new container (ADR 0006).
 */
export const JOB_SCHEMA = 'pgboss';

type QueueDefinition = {
  name: JobName;
  // Phase 34. Set at creation only: pg-boss refuses to change a queue's policy,
  // so a changed one means a new queue. Absent is pg-boss's `standard`.
  policy?: QueuePolicy;
  // The subset that both createQueue and updateQueue accept, so one definition
  // serves a fresh install and a changed one.
  options: {
    retryLimit: number;
    retryBackoff?: boolean;
    expireInSeconds?: number;
    deleteAfterSeconds: number;
    deadLetter?: JobName;
  };
};

/**
 * Every queue and its policy (spec §3). Order matters: a dead-letter queue must
 * exist before the queue that names it, because pg-boss holds a foreign key
 * from one to the other.
 */
export const JOB_QUEUES: QueueDefinition[] = [
  { name: PREPARE_SESSION_FAILED, options: { retryLimit: 2, deleteAfterSeconds: 86_400 } },
  {
    name: PREPARE_SESSION,
    options: {
      retryLimit: 2,
      retryBackoff: true,
      // Twice the sum of the attempt's call budgets (domain/jobs.ts,
      // PREPARE_SESSION_CALL_BUDGETS_MS; spec D16, phase 34 ruling R12): a worker
      // that crashed mid-call expires, and the expiry counts as a failed attempt.
      expireInSeconds: PREPARE_SESSION_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
      deadLetter: PREPARE_SESSION_FAILED,
    },
  },
  { name: READ_PHOTO_FAILED, options: { retryLimit: 2, deleteAfterSeconds: 86_400 } },
  {
    name: READ_PHOTO,
    options: {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: READ_PHOTO_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
      deadLetter: READ_PHOTO_FAILED,
    },
  },
  { name: LOOK_UP_IMPORT_ITEM_FAILED, options: { retryLimit: 2, deleteAfterSeconds: 86_400 } },
  {
    name: LOOK_UP_IMPORT_ITEM,
    options: {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
      deadLetter: LOOK_UP_IMPORT_ITEM_FAILED,
    },
  },
  // Phase 31 (spec D7). No dead letter: a merge that keeps failing leaves two
  // glosses, which the by-hand tool (dict:glosses:merge) also finds.
  {
    name: MERGE_GLOSSES,
    options: { retryLimit: 2, retryBackoff: true, expireInSeconds: MERGE_GLOSSES_EXPIRY_SECONDS, deleteAfterSeconds: 86_400 },
  },
  // Phase 31 (spec D12). The dead letter releases the job's claim
  // (dict_lemma_renders), so a render whose retries are spent is asked for again
  // by the next save or start. The saved form serves meanwhile.
  { name: RENDER_LEMMA_FAILED, options: { retryLimit: 2, deleteAfterSeconds: 86_400 } },
  {
    name: RENDER_LEMMA,
    options: {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: RENDER_LEMMA_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
      deadLetter: RENDER_LEMMA_FAILED,
    },
  },
  // Phase 34 (spec D1). `exclusive`: one job per rendering queued, retrying or
  // active, so every session that picks the rendering meanwhile, and the
  // backfill, asks for the call it is already waiting on. The dead letter
  // writes nothing: the rendering stays unstamped, and the next session that
  // picks it asks again.
  { name: ACCEPT_RENDERING_FAILED, options: { retryLimit: 2, deleteAfterSeconds: 86_400 } },
  {
    name: ACCEPT_RENDERING,
    policy: 'exclusive',
    options: {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: ACCEPT_RENDERING_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
      deadLetter: ACCEPT_RENDERING_FAILED,
    },
  },
  // Phase 43 (spec D3). `stately`: one job queued and one active per enrollment
  // (the singleton key), so a burst of triggers is one job and a trigger that
  // arrives mid-run is queued rather than lost. No dead letter: a stock never
  // built is built by the next trigger, or by the home screen's create.
  {
    name: STOCK_SESSION,
    policy: 'stately',
    options: {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: STOCK_SESSION_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
    },
  },
];

/**
 * Installs (or migrates) pg-boss's schema and creates or updates every queue.
 * Called by runMigrations, so db:migrate, both test globalSetups and nightly-qa
 * all get it without a call site of their own. Idempotent.
 *
 * Runs on the caller's own Drizzle handle through pg-boss's adapter rather than
 * opening a second pool. supervise, schedule and the instance registry are off:
 * this instance lives for one install and must leave no rows or timers behind.
 */
export async function installJobs(db: Db): Promise<void> {
  const boss = new PgBoss({
    db: fromDrizzle(db, sql),
    schema: JOB_SCHEMA,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  // An EventEmitter with no 'error' listener throws from wherever pg-boss emits
  // it. Collected and rethrown instead, so a failure surfaces here, once.
  let failure: unknown;
  boss.on('error', (error) => {
    failure ??= error;
  });

  await boss.start();
  try {
    for (const queue of JOB_QUEUES) {
      if (await boss.getQueue(queue.name)) await boss.updateQueue(queue.name, queue.options);
      else await boss.createQueue(queue.name, { ...queue.options, ...(queue.policy ? { policy: queue.policy } : {}) });
    }
  } finally {
    await boss.stop({ graceful: false });
  }
  if (failure) throw failure;
}

/**
 * Phase 31. A started pg-boss on the caller's handle for the length of `run`,
 * for an enqueue outside the server: the CLI's lemma backfill. Built as
 * installJobs builds its own, and stopped however `run` ends.
 */
export async function withJobQueue<T>(db: Db, run: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = new PgBoss({
    db: fromDrizzle(db, sql),
    schema: JOB_SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  let failure: unknown;
  boss.on('error', (error) => {
    failure ??= error;
  });
  await boss.start();
  try {
    return await run(boss);
  } finally {
    await boss.stop({ graceful: false });
    if (failure) throw failure;
  }
}
