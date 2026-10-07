import type { PgBoss } from 'pg-boss';

import {
  LOOK_UP_IMPORT_ITEM,
  LOOK_UP_IMPORT_ITEM_FAILED,
  PREPARE_SESSION,
  PREPARE_SESSION_FAILED,
  READ_PHOTO,
  READ_PHOTO_FAILED,
} from './domain/jobs';
import type { PhotoImportService } from './services/photoImports';
import type { SessionService } from './services/sessions';

/**
 * The job side of the app, as app.ts is the HTTP side (ADR 0007, ADR 0001 R5):
 * each queue name mapped to one service use case, with that queue's worker
 * options. No logic. The use case parses its own payload.
 *
 * `pollingIntervalSeconds` is received rather than fixed, so a test can poll
 * fast without production polling the database twice a second.
 */
export async function registerWorkers(
  boss: PgBoss,
  services: { sessions: SessionService; photoImports: PhotoImportService },
  options: { pollingIntervalSeconds: number },
): Promise<void> {
  const { sessions, photoImports } = services;
  await boss.work(
    PREPARE_SESSION,
    // Four at once per process: one model call each, kept under the quota.
    { localConcurrency: 4, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await sessions.prepareSession(job.data);
    },
  );
  await boss.work(
    PREPARE_SESSION_FAILED,
    { pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await sessions.failPreparation(job.data);
    },
  );

  // Phase 26 (spec D2). Two reads at once per process: each is one long call.
  await boss.work(
    READ_PHOTO,
    { localConcurrency: 2, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await photoImports.readPhoto(job.data);
    },
  );
  await boss.work(READ_PHOTO_FAILED, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await photoImports.failRead(job.data);
  });
  // Four rows at once, like session preparation: a lookup is one to six calls.
  await boss.work(
    LOOK_UP_IMPORT_ITEM,
    { localConcurrency: 4, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await photoImports.lookUpItem(job.data);
    },
  );
  await boss.work(LOOK_UP_IMPORT_ITEM_FAILED, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await photoImports.failItem(job.data);
  });
}
