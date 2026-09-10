import { randomUUID } from 'node:crypto';

import type { LlmEntry, TranslationKind } from '@lang-tutor/core/api';

import { geminiResponse } from './geminiResponse';

// tests/support/ is the test composition root, so naming a concrete URL and
// reading the environment is what this file is for (ADR 0001, ADR 0004 R6).
const ADMIN_URL = process.env.MOCKSERVER_URL ?? 'http://localhost:1080';

/**
 * A namespace per test, not per checkout. A shared prefix would collide between
 * parallel Jest workers inside one checkout, which is the failure a per-worktree
 * prefix would not have caught.
 */
export function mockNamespace(label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'ns';
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

export function geminiBaseUrlFor(ns: string): string {
  return `${ADMIN_URL}/${ns}`;
}

function generateContentPath(ns: string): string {
  return `/${ns}/v1beta/models/.*:generateContent`;
}

async function admin(action: string, body: unknown, okStatuses: number[]): Promise<Response> {
  const res = await fetch(`${ADMIN_URL}/mockserver/${action}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!okStatuses.includes(res.status)) {
    throw new Error(
      `MockServer ${action} failed with ${res.status}: ${await res.text()}\n` +
        'If the status is unexpected, re-run Task 2 Step 1 — the container is the source of truth.',
    );
  }
  return res;
}

type ExpectationSpec = {
  match?: Record<string, unknown>;
  action: Record<string, unknown>;
};

async function expectation(ns: string, spec: ExpectationSpec): Promise<void> {
  await admin(
    'expectation',
    {
      httpRequest: { method: 'POST', path: generateContentPath(ns), ...(spec.match ?? {}) },
      ...spec.action,
    },
    [200, 201],
  );
}

export async function expectGeminiJson(
  ns: string,
  opts: { kind: TranslationKind; entries: LlmEntry[]; matchText?: string },
): Promise<void> {
  await expectation(ns, {
    match: opts.matchText
      ? { body: { type: 'REGEX', regex: `[\\s\\S]*${opts.matchText}[\\s\\S]*` } }
      : {},
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ kind: opts.kind, entries: opts.entries })),
      },
    },
  });
}

export async function expectGeminiStatus(ns: string, statusCode: number): Promise<void> {
  await expectation(ns, {
    action: { httpResponse: { statusCode, body: '{"error":{"message":"upstream"}}' } },
  });
}

export async function expectGeminiDelayedJson(
  ns: string,
  opts: { kind: TranslationKind; entries: LlmEntry[]; delayMs: number },
): Promise<void> {
  await expectation(ns, {
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ kind: opts.kind, entries: opts.entries })),
        delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs },
      },
    },
  });
}

/** For output the model should not have produced — unparseable, or valid JSON of the wrong shape. */
export async function expectGeminiRawBody(ns: string, body: string): Promise<void> {
  await expectation(ns, {
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body,
      },
    },
  });
}

export async function clearNamespace(ns: string): Promise<void> {
  await admin('clear', { path: `/${ns}/.*` }, [200]);
}

/**
 * Asserts a request actually arrived carrying this header. This is what proves
 * the real client sends `x-goog-api-key`: a unit test with a fake fetch would
 * keep passing if the provider stopped sending it.
 */
export async function verifyGeminiHeader(
  ns: string,
  name: string,
  value: string,
): Promise<boolean> {
  const res = await fetch(`${ADMIN_URL}/mockserver/verify`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      httpRequest: { path: generateContentPath(ns), headers: { [name]: [value] } },
      times: { atLeast: 1 },
    }),
  });
  // 202 = matched, 406 = not matched. Both are answers, not failures.
  if (res.status === 202) return true;
  if (res.status === 406) return false;
  throw new Error(`MockServer verify returned ${res.status}: ${await res.text()}`);
}

/**
 * A clear, actionable message rather than a fetch stack trace — matching what
 * globalSetup.ts already does for an unreachable Postgres.
 *
 * Deliberately a read-only liveness GET, never `PUT /mockserver/reset`. Jest
 * runs integration files in parallel across workers against this one shared
 * container, so a reset here would wipe expectations another worker had just
 * registered. Each test clears only its own namespace.
 */
export async function assertMockServerReachable(): Promise<void> {
  try {
    const res = await fetch(`${ADMIN_URL}/liveness/probe`);
    if (!res.ok) throw new Error(`liveness probe returned ${res.status}`);
  } catch (error) {
    throw new Error(
      `MockServer unreachable at ${ADMIN_URL}\n` +
        'Run `npm run db:up` first (requires Docker).\n' +
        `Underlying error: ${(error as Error).message}`,
    );
  }
}
