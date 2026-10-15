import { STOCK_SESSION, type StockSessionPayload } from '../domain/jobs';
import type { Logger } from '../logger';
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

/**
 * Phase 53 (spec D12, ruling R-D12b). The stock a change to the learner's targets leaves: the
 * unstarted list stock, chosen without the change, retired (a seed, or a session already
 * started, never is), and the next asked of the stock job. The caller took lockNextSession
 * before it locked or wrote anything: a stock being written holds that lock and references
 * the active targets' rows. Answers the id of the stock retired, or null. Shared by the
 * targets service and an unsave that takes a word out of a target (final review M2).
 */
export async function restockAfterTargetChange(repos: Pick<Repos, 'session' | 'jobs'>, enrollmentId: string): Promise<string | null> {
  const { stock } = await repos.session.findOpen(enrollmentId);
  const retired = stock?.source === 'list' && (await repos.session.retireStock(stock.id)) ? stock.id : null;
  await requestStock(repos, { enrollment_id: enrollmentId, reason: 'target' });
  return retired;
}

/** Phase 53 (ruling R-D12b). Once the change committed: the stock it retired, if any. */
export function logTargetRetired(logger: Logger, enrollmentId: string, sessionId: string | null): void {
  if (sessionId !== null) {
    logger.info({ event: 'session_retired', enrollment_id: enrollmentId, session_id: sessionId, reason: 'target_changed' });
  }
}
