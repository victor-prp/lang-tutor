import type { APIRequestContext } from '@playwright/test';

import { MOCKSERVER_URL, requireEnv } from '../../urls';

/**
 * One namespace for the whole run rather than one per test: the server is a
 * single long-lived process with a single GEMINI_BASE_URL in its environment.
 * Safe because playwright.config.ts already runs `workers: 1` with
 * `fullyParallel: false`, and each spec clears the namespace before it registers.
 *
 * Per lane since phase 15, because "clears the namespace before it registers" is
 * only safe while one run owns it.
 */
export const E2E_MOCK_NAMESPACE = requireEnv('E2E_MOCK_NAMESPACE');

const path = `/${E2E_MOCK_NAMESPACE}/v1beta/models/.*:generateContent`;

function envelope(payload: unknown) {
  return JSON.stringify({
    candidates: [
      {
        content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] },
        finishReason: 'STOP',
      },
    ],
  });
}

export async function clearGemini(request: APIRequestContext): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/clear`, {
    data: { path: `/${E2E_MOCK_NAMESPACE}/.*` },
  });
  if (!res.ok()) throw new Error(`MockServer clear failed: ${res.status()}`);
}

export async function expectGemini(
  request: APIRequestContext,
  payload: {
    kind: 'word' | 'phrase' | 'sentence';
    entries: unknown[];
    /** Phase 13. Absent on every existing call site. */
    correction?: { corrected_form: string; alternatives?: string[] };
  },
  /**
   * `once` makes this a ONE-SHOT expectation, consumed in registration order.
   * The correction flow needs two different answers in one test, and MockServer
   * consumes one-shots in the order they were registered — so the count has to
   * match the calls exactly. Opt-in rather than the default, so the existing
   * specs (one expectation, one or more calls) are untouched.
   */
  opts: { once?: boolean } = {},
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path },
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: envelope(payload),
      },
      ...(opts.once ? { times: { remainingTimes: 1, unlimited: false } } : {}),
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}

export async function expectGeminiFailure(
  request: APIRequestContext,
  statusCode: number,
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path },
      httpResponse: { statusCode, body: '{"error":{"message":"upstream"}}' },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}
