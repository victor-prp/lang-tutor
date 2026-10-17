import { STOCK_SESSION, type StockSessionPayload } from '../domain/jobs';
import type { Path } from '../domain/session';
import type { Logger } from '../logger';
import type { Repos } from './transaction';

/**
 * Phase 43 (spec D3). Asks for a path's next session in stock, in the
 * transaction of the change that calls for it. The queue is `stately`: one job
 * queued and one running per key, so a burst of triggers is one job and one
 * arriving mid-run is queued, not lost. Phase 57 (spec D2, ADR 0014): one key per
 * path, the enrollment's id for the main path (as before) and the enrollment's and the
 * target's for a target's, so one path's request never holds another's back.
 */
export async function requestStock(
  repos: Pick<Repos, 'jobs'>,
  payload: StockSessionPayload & { reason: Exclude<StockSessionPayload['reason'], 'save'> },
): Promise<void> {
  const singletonKey = payload.target_id === undefined ? payload.enrollment_id : `${payload.enrollment_id}:${payload.target_id}`;
  await repos.jobs.enqueue(STOCK_SESSION, payload, { singletonKey });
}

/** Phase 57 (spec D2). The stock payload's path: its target, or none for the main path. */
export const pathPayload = (path: Path): { target_id?: string } => (path === null ? {} : { target_id: path });

/**
 * Phase 43 (ruling R3, review I1). After a save the stock waits `delaySeconds`
 * past the last save of a burst, so the burst becomes one session holding every
 * word of it. Under a key of its own, so a save just before a start never holds
 * the start's job back. Phase 57: the main path's, which a saved word joins.
 */
export async function requestStockAfterSave(repos: Pick<Repos, 'jobs'>, enrollmentId: string, delaySeconds: number): Promise<void> {
  await repos.jobs.enqueueOrPostpone(
    STOCK_SESSION,
    { enrollment_id: enrollmentId, reason: 'save' },
    { singletonKey: `${enrollmentId}:save`, startAfterSeconds: delaySeconds },
  );
}

/**
 * Phase 57 (ADR 0014). Takes the next-session locks of the main path and of `targetIds`'
 * paths, the main path's first and then the targets' in id order, so two use cases that each
 * take several never wait on each other. A change to targets takes them before it locks or
 * writes anything: a stock being written holds its path's lock and references the targets'
 * rows (phase 53, ruling R-D12b).
 */
export async function lockPaths(repos: Pick<Repos, 'session'>, enrollmentId: string, targetIds: readonly string[]): Promise<void> {
  await repos.session.lockNextSession(enrollmentId, null);
  for (const targetId of [...new Set(targetIds)].sort()) await repos.session.lockNextSession(enrollmentId, targetId);
}

/** The paths a change to `targetIds` touches: the main path's, whose words change with any
 *  target's, then each target's, in id order. */
const changedPaths = (targetIds: readonly string[]): Path[] => [null, ...[...new Set(targetIds)].sort()];

/**
 * Phase 53 (spec D12, ruling R-D12b), per path since phase 57 (spec D2). The stocks a change
 * to the learner's targets leaves, chosen without the change: the unstarted list stock of the
 * main path and of each changed target's path, retired (a seed, or a session already started,
 * never is). The caller took lockPaths for the same targets before it locked or wrote
 * anything. Answers the ids of the stocks retired.
 */
export async function retireStocks(repos: Pick<Repos, 'session'>, enrollmentId: string, targetIds: readonly string[]): Promise<string[]> {
  const retired: string[] = [];
  for (const path of changedPaths(targetIds)) {
    const { stock } = await repos.session.findOpen(enrollmentId, path);
    if (stock?.source === 'list' && (await repos.session.retireStock(stock.id))) retired.push(stock.id);
  }
  return retired;
}

/** Phase 53 (ruling R-D12b), phase 57 (spec D2). The next stock of the main path and of each
 *  changed target's path, asked of the stock job. */
export async function requestStocks(
  repos: Pick<Repos, 'jobs'>,
  enrollmentId: string,
  targetIds: readonly string[],
  // Phase 58 (final review I1): removing a level's words, or (58b) every word, restocks too,
  // whether or not a target held them.
  reason: 'target' | 'words_removed' = 'target',
): Promise<void> {
  for (const path of changedPaths(targetIds)) {
    await requestStock(repos, { enrollment_id: enrollmentId, reason, ...pathPayload(path) });
  }
}

/**
 * Phase 53 (ruling R-D12b), phase 57 (spec D2). A change to targets: its stocks retired, then
 * the next of each asked for (retireStocks, requestStocks). Shared by the target changes that
 * take no progress lock. A removal (a word out of a target, an unsave, a level's words or every
 * word) takes the two steps apart around that lock (ADR 0014 R4): it retires before it, since a
 * skip holds its stock's row and then the lock, and it asks after it, since a session end holds
 * the lock and then enqueues its path's stock under the same singleton key, whose uncommitted row
 * a stately insert waits on.
 */
export async function restockAfterTargetChange(
  repos: Pick<Repos, 'session' | 'jobs'>,
  enrollmentId: string,
  targetIds: readonly string[],
): Promise<string[]> {
  const retired = await retireStocks(repos, enrollmentId, targetIds);
  await requestStocks(repos, enrollmentId, targetIds);
  return retired;
}

/** Phase 53 (ruling R-D12b). Once the change committed: each stock it retired. */
export function logTargetRetired(
  logger: Logger,
  enrollmentId: string,
  sessionIds: readonly string[],
  reason: 'target_changed' | 'words_removed' = 'target_changed',
): void {
  for (const sessionId of sessionIds) {
    logger.info({ event: 'session_retired', enrollment_id: enrollmentId, session_id: sessionId, reason });
  }
}
