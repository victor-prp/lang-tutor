import { STOCK_SESSION, type StockSessionPayload } from '../domain/jobs';
import type { Repos } from './transaction';

/**
 * Phase 43 (spec D3). Asks for the enrollment's next session in stock, in the
 * transaction of the change that calls for it. The queue is `stately`: one job
 * queued and one running per key, so a burst of triggers is one job and one
 * arriving mid-run is queued, not lost.
 */
export async function requestStock(
  repos: Pick<Repos, 'jobs'>,
  payload: StockSessionPayload & { reason: Exclude<StockSessionPayload['reason'], 'save'> },
): Promise<void> {
  await repos.jobs.enqueue(STOCK_SESSION, payload, { singletonKey: payload.enrollment_id });
}

/**
 * Phase 43 (ruling R3, review I1). After a save the stock waits `delaySeconds`
 * past the last save of a burst, so the burst becomes one session holding every
 * word of it. Under a key of its own, so a save just before a start never holds
 * the start's job back.
 */
export async function requestStockAfterSave(repos: Pick<Repos, 'jobs'>, enrollmentId: string, delaySeconds: number): Promise<void> {
  await repos.jobs.enqueueOrPostpone(
    STOCK_SESSION,
    { enrollment_id: enrollmentId, reason: 'save' },
    { singletonKey: `${enrollmentId}:save`, startAfterSeconds: delaySeconds },
  );
}
