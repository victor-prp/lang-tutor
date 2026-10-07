import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';

import {
  LOOK_UP_IMPORT_ITEM,
  LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS,
  LOOK_UP_IMPORT_ITEM_FAILED,
  PREPARE_SESSION,
  PREPARE_SESSION_EXPIRY_SECONDS,
  PREPARE_SESSION_FAILED,
  READ_PHOTO,
  READ_PHOTO_EXPIRY_SECONDS,
  READ_PHOTO_FAILED,
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
      // Twice the generation budget (domain/jobs.ts, spec D16): a worker that
      // crashed mid-call expires, and the expiry counts as a failed attempt.
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
      else await boss.createQueue(queue.name, queue.options);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
  if (failure) throw failure;
}
