/**
 * The eval's own fetch. A 503 is the provider saying it is overloaded right now,
 * which says nothing about the prompt under test, yet each one is a tier 1
 * failure that turns test-eval red: on 2026-10-19 two 503s in one run, and the
 * rewrite one of them cost, failed a branch whose diff touched none of those
 * prompts. So a 503 is asked once more, after a pause; a second 503 stands.
 *
 * Nothing else is retried. A timeout (the abort the client's budget raises) is
 * what tier 1 measures, a 429 means the run outran its quota (lower
 * EVAL_CONCURRENCY), and the production client keeps no retry at all
 * (providers/gemini.ts): a learner who taps retry is the retry.
 */
export const OVERLOAD_PAUSE_MS = 3_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function retryOverloaded(
  fetch: typeof globalThis.fetch,
  wait: (ms: number) => Promise<void> = pause,
): typeof globalThis.fetch {
  return async (input, init) => {
    const first = await fetch(input, init);
    if (first.status !== 503) return first;
    console.log(`[provider] responded 503, asking once more in ${OVERLOAD_PAUSE_MS} ms`);
    await wait(OVERLOAD_PAUSE_MS);
    return fetch(input, init);
  };
}
