import { STOCK_SAVE_DELAY_SECONDS, STOCK_SESSION, type StockSessionPayload } from '../domain/jobs';
import type { Repos } from './transaction';

/**
 * Phase 43 (spec D3). Asks for the enrollment's next session in stock, in the
 * transaction of the change that calls for it. The queue is `stately`: one job
 * queued and one running per key, so a burst of triggers is one job and one
 * arriving mid-run is queued, not lost. A save waits (ruling R3) under a key of
 * its own, so a save just before a start never holds the start's job back.
 */
export async function requestStock(repos: Pick<Repos, 'jobs'>, payload: StockSessionPayload): Promise<void> {
  if (payload.reason === 'save') {
    await repos.jobs.enqueue(STOCK_SESSION, payload, {
      singletonKey: `${payload.enrollment_id}:save`,
      startAfterSeconds: STOCK_SAVE_DELAY_SECONDS,
    });
    return;
  }
  await repos.jobs.enqueue(STOCK_SESSION, payload, { singletonKey: payload.enrollment_id });
}
