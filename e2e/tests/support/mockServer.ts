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

/** Phase 19. Any model answer, not only a translation: the distractor call's
 *  `{ items: [...] }`. The spec clears the namespace first, so this is the only
 *  expectation and needs no body match. */
export async function expectGeminiPayload(request: APIRequestContext, payload: unknown): Promise<void> {
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

/** Phase 25. The transcription call's answer, matched on the server's
 *  TRANSCRIBE_MARKER (apps/server/src/domain/speech.ts) and ranked above the
 *  generation stub, which matches any call. Consumed once, in registration
 *  order, so a test can queue "not understood" and then "understood". */
export async function expectTranscription(request: APIRequestContext, heard: string): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      priority: 10,
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: '[\\s\\S]*transcribe the spoken audio[\\s\\S]*' } },
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: envelope({ heard }),
      },
      times: { remainingTimes: 1, unlimited: false },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}

/**
 * Phase 26. A model answer for the one call whose request body matches
 * `bodyRegex`. A photo import makes several calls at once (the read, a lookup
 * per row, a match call) whose order is not fixed, so each answer is matched by
 * what is in its request rather than by order. MockServer answers with the
 * first expectation that matches, so register the narrowest first.
 */
export async function expectGeminiMatching(
  request: APIRequestContext,
  bodyRegex: string,
  payload: unknown,
  /** `once`, as expectGemini's: a one-shot, consumed by the first call that matches. */
  opts: { delayMs?: number; once?: boolean } = {},
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: `[\\s\\S]*${bodyRegex}[\\s\\S]*` } },
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: envelope(payload),
        ...(opts.delayMs ? { delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs } } : {}),
      },
      ...(opts.once ? { times: { remainingTimes: 1, unlimited: false } } : {}),
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}

/**
 * Phase 31. The body regex for a model call whose user part is exactly `text`.
 * The provider sends that part as `"parts":[{"text":"…"}]`, and the system
 * prompt's quoted words are escaped inside the JSON, so they never match.
 */
export function userText(text: string): string {
  return `"text":"${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`;
}

/** Phase 29. Resend, answered 200 for this lane's namespace. `clearGemini` wipes it, so every sign-in registers it again. */
export async function expectEmails(request: APIRequestContext): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path: `/${E2E_MOCK_NAMESPACE}/emails` },
      httpResponse: { statusCode: 200, headers: { 'content-type': ['application/json'] }, body: '{"id":"e2e"}' },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}

/** The 8 digits of the latest code "emailed" to `email` in this lane's namespace. */
export async function codeFor(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/retrieve?type=REQUESTS&format=JSON`, {
    data: { method: 'POST', path: `/${E2E_MOCK_NAMESPACE}/emails` },
  });
  if (!res.ok()) throw new Error(`MockServer retrieve failed: ${res.status()}`);
  const requests = (await res.json()) as { body: { json: { to: string[]; subject: string } } }[];
  const mine = requests.map((r) => r.body.json).filter((b) => b.to.includes(email.toLowerCase()));
  const digits = (mine[mine.length - 1]?.subject ?? '').replace(/\D/g, '');
  if (digits.length !== 8) throw new Error(`no code was emailed to ${email}`);
  return digits;
}

/** Phase 27. The meaning judge's answer (or, with `misspelled` or `other_word`, the translation judge's), matched on the server's JUDGE_MARKER
 *  (apps/server/src/domain/judge.ts) and ranked above the generation stub.
 *  Consumed once, in registration order. `status` makes it a failed call
 *  instead; `delayMs` holds the answer back so the "checking" state can be seen. */
export async function expectJudge(
  request: APIRequestContext,
  verdict: 'right' | 'other_sense' | 'wrong' | 'misspelled' | 'other_word',
  opts: { status?: number; delayMs?: number } = {},
): Promise<void> {
  const failed = opts.status !== undefined && opts.status !== 200;
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      priority: 10,
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: "[\\s\\S]*judge the learner's answer[\\s\\S]*" } },
      httpResponse: {
        statusCode: opts.status ?? 200,
        ...(failed ? { body: '{"error":{"message":"upstream"}}' } : { headers: { 'content-type': ['application/json'] }, body: envelope({ verdict }) }),
        ...(opts.delayMs ? { delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs } } : {}),
      },
      times: { remainingTimes: 1, unlimited: false },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}
