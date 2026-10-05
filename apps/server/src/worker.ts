import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION, PREPARE_SESSION_FAILED } from './domain/jobs';
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
  sessions: SessionService,
  options: { pollingIntervalSeconds: number },
): Promise<void> {
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
}
