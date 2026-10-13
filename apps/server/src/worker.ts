import type { PgBoss } from 'pg-boss';

import {
  ACCEPT_RENDERING,
  ACCEPT_RENDERING_FAILED,
  LOOK_UP_IMPORT_ITEM,
  LOOK_UP_IMPORT_ITEM_FAILED,
  MERGE_GLOSSES,
  PREPARE_SESSION,
  PREPARE_SESSION_FAILED,
  READ_PHOTO,
  READ_PHOTO_FAILED,
  RENDER_LEMMA,
  RENDER_LEMMA_FAILED,
  STOCK_SESSION,
} from './domain/jobs';
import type { GlossService } from './services/glosses';
import type { PhotoImportService } from './services/photoImports';
import type { SessionService } from './services/sessions';
import type { TranslationService } from './services/translations';

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
  services: {
    sessions: SessionService;
    photoImports: PhotoImportService;
    glosses: GlossService;
    translations: TranslationService;
  },
  options: { pollingIntervalSeconds: number },
): Promise<void> {
  const { sessions, photoImports, glosses, translations } = services;
  await boss.work(
    PREPARE_SESSION,
    // Four at once per process: one model call each, kept under the quota.
    { localConcurrency: 4, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      // Phase 47 (spec D6). The attempt, 1 to 3, names this run's model calls.
      for (const job of jobs) await sessions.prepareSession(job.data, { attempt: job.retryCount + 1 });
    },
  );
  // Phase 43 (spec D3). Two at once per process: each is one transaction, and
  // the queue keeps one job active per enrollment.
  await boss.work(
    STOCK_SESSION,
    { localConcurrency: 2, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await sessions.stockSession(job.data);
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

  // Phase 31 (spec D7). One merge at a time per process: each locks a lexeme.
  await boss.work(MERGE_GLOSSES, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await glosses.mergeLexeme(job.data);
  });

  // Phase 31 (spec D12). Two at once per process: each is a lookup's calls.
  await boss.work(
    RENDER_LEMMA,
    { localConcurrency: 2, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await translations.renderLemma(job.data);
    },
  );
  await boss.work(RENDER_LEMMA_FAILED, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await translations.failLemmaRender(job.data);
  });

  // Phase 34 (spec D1). Two at once per process: one short call each, beside the
  // sessions that enqueue them.
  await boss.work(
    ACCEPT_RENDERING,
    { localConcurrency: 2, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await translations.acceptRendering(job.data);
    },
  );
  await boss.work(ACCEPT_RENDERING_FAILED, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await translations.failAcceptRendering(job.data);
  });
}
