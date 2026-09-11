import type { APIRequestContext } from '@playwright/test';

import { MOCKSERVER_URL } from '../../urls';

/**
 * One namespace for the whole run rather than one per test: the server is a
 * single long-lived process with a single GEMINI_BASE_URL in its environment.
 * Safe because playwright.config.ts already runs `workers: 1` with
 * `fullyParallel: false`, and each spec clears the namespace before it registers.
 */
export const E2E_MOCK_NAMESPACE = 'e2e';

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
  payload: { kind: 'word' | 'phrase' | 'sentence'; entries: unknown[] },
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path },
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: envelope(payload),
      },
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
