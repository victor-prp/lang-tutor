import { randomUUID } from 'node:crypto';

import type { LlmEntry, LlmRendering, TranslationKind } from '@lang-tutor/core/api';

import { DISTRACTOR_MARKER, type Task } from '../../src/domain/distractors';
import { JUDGE_MARKER } from '../../src/domain/judge';
import { PHOTO_READING_MARKER } from '../../src/domain/photoReading';
import { SENSE_MATCH_MARKER } from '../../src/domain/senseMatching';
import { TRANSCRIBE_MARKER } from '../../src/domain/speech';
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
  opts: {
    kind: TranslationKind;
    entries: LlmEntry[];
    /** Phase 13. Without this no integration row can drive a stub that corrects. */
    correction?: { corrected_form: string; alternatives?: string[] };
    matchText?: string;
  },
): Promise<void> {
  await expectation(ns, {
    match: opts.matchText
      ? { body: { type: 'REGEX', regex: `[\\s\\S]*${opts.matchText}[\\s\\S]*` } }
      : {},
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(
          geminiResponse({
            kind: opts.kind,
            entries: opts.entries,
            ...(opts.correction ? { correction: opts.correction } : {}),
          }),
        ),
      },
    },
  });
}

/**
 * The SECOND call's answer, beside the first call's `expectGeminiJson`.
 *
 * MockServer takes the first matching expectation, and the two prompts are
 * distinguishable by body: only the reconciliation prompt says "reusing its
 * sense_code EXACTLY". Registering this one FIRST is therefore what keeps a
 * broad `expectGeminiJson` from answering the second call with a first-call
 * payload — and it is why `matchText` exists on both.
 */
export async function expectReconciliation(
  ns: string,
  opts: {
    /** The schema's own type, so a stub can carry the phase 31 fields. */
    senses: LlmRendering[];
    matchText?: string;
    /** Holds the answer back, so a test can do something else while this call is
     *  in flight — the 5-15 seconds a real reconciliation takes is the window
     *  every read-then-write race in this use case lives in. */
    delayMs?: number;
  },
): Promise<void> {
  await expectation(ns, {
    match: {
      body: {
        type: 'REGEX',
        regex: `[\\s\\S]*reusing its sense_code EXACTLY${
          opts.matchText ? `[\\s\\S]*${opts.matchText}` : ''
        }[\\s\\S]*`,
      },
    },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ senses: opts.senses })),
        ...(opts.delayMs ? { delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs } } : {}),
      },
    },
  });
}

/** Phase 26. The reader's answer, matched by its marker, so it never answers a
 *  lookup. Register it before any broad expectation. */
export async function expectPhotoRead(
  ns: string,
  items: { text: string; hebrew: string }[],
  opts: { delayMs?: number } = {},
): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${PHOTO_READING_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ items })),
        ...(opts.delayMs ? { delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs } } : {}),
      },
    },
  });
}

/** Phase 26. A reader that always fails, for the dead-letter path. */
export async function expectPhotoReadFailure(ns: string, statusCode: number): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${PHOTO_READING_MARKER}[\\s\\S]*` } },
    action: { httpResponse: { statusCode, body: '{"error":{"message":"upstream"}}' } },
  });
}

/** Phase 26. The match call's answer: a sense number from 1, or 0 for none. */
export async function expectSenseMatch(ns: string, sense: number): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${SENSE_MATCH_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ sense })),
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

/**
 * How many generateContent requests this namespace actually received.
 *
 * `verify` answers matched/not-matched; a count is what "exactly one provider
 * request for two lookups" needs. `matchText` narrows to requests whose body
 * carries a given string, so one test's traffic cannot be confused with
 * another's inside the same namespace.
 */
export async function countGeminiRequests(ns: string, matchText?: string): Promise<number> {
  const res = await fetch(`${ADMIN_URL}/mockserver/retrieve?type=REQUESTS&format=JSON`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'POST',
      path: generateContentPath(ns),
      ...(matchText ? { body: { type: 'REGEX', regex: `[\\s\\S]*${matchText}[\\s\\S]*` } } : {}),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`MockServer retrieve returned ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as unknown[]).length;
}

/**
 * Phase 19. The distractor call's answer for q1 to q10, so one stub fits any
 * session of up to ten questions. Matched on DISTRACTOR_MARKER, which only that
 * prompt carries, so a translation stub in the same namespace cannot answer it.
 *
 * Phase 23. Each key answers the task its position's type asks (spec D2):
 * Hebrew wrong options for today's card, English ones for a reversed card, and
 * no options but one alternative for a typed card.
 */
export const STUB_WRONG_HEBREW = ['דלת', 'קיר', 'תקרה'];
export const STUB_WRONG_ENGLISH = ['door', 'wall', 'ceiling'];
export const STUB_ALTERNATIVE = 'volume';

/** Phase 23's cycle of tasks: what a test's session of up to six words asks at
 *  ordinal 0 with listening off, at every position that asks anything. */
const CYCLE_TASKS: Task[] = Array.from({ length: 10 }, (_, i) => (['meaning', 'word', 'typed'] as const)[i % 3]);

export const STUB_SENTENCE = 'Tome sprint lantern kettle pillow ladder bucket violin turtle lizard';
export const STUB_SENTENCE_HEBREW = 'אני רואה ספר ופנס בבית';
export const STUB_GAP = 'lantern';

export async function expectDistractors(ns: string, opts: { delayMs?: number; tasks?: Task[] } = {}): Promise<void> {
  const items = (opts.tasks ?? CYCLE_TASKS).map((task, i) => {
    const key = `q${i + 1}`;
    switch (task) {
      case 'meaning':
        return { key, distractors: STUB_WRONG_HEBREW };
      case 'word':
        return { key, distractors: STUB_WRONG_ENGLISH };
      case 'typed':
        return { key, distractors: [], alternatives: [STUB_ALTERNATIVE] };
      case 'gap':
        return { key, distractors: STUB_WRONG_ENGLISH };
      // Phase 27 Part B. One sentence holds every word the tests save, once, so
      // whichever word a position asks, `gap` is a word of it. The sentence
      // is English (the enrollment's target), its translation Hebrew.
      case 'sentence':
        return { key, distractors: [], sentence: STUB_SENTENCE, gap: STUB_GAP, translation: STUB_SENTENCE_HEBREW, alternatives: [] };
      case 'translate':
        return { key, distractors: [], sentence: STUB_SENTENCE_HEBREW, gap: STUB_GAP, translation: STUB_SENTENCE };
    }
  });
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${DISTRACTOR_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ items })),
        ...(opts.delayMs ? { delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs } } : {}),
      },
    },
  });
}

/**
 * Phase 25. The transcription call's answer, matched on TRANSCRIBE_MARKER so a
 * generation or translation stub in the same namespace cannot answer it, and
 * the other way round. `once` consumes it, in registration order.
 */
export async function expectTranscription(ns: string, heard: string, opts: { once?: boolean } = {}): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${TRANSCRIBE_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ heard })),
      },
      ...(opts.once ? { times: { remainingTimes: 1, unlimited: false } } : {}),
    },
  });
}

/**
 * Phase 27. The judge call's answer, matched on JUDGE_MARKER so a generation or
 * transcription stub in the same namespace cannot answer it. Consumed once, and
 * prioritised so it wins over a broader stub registered earlier.
 */
export async function expectJudge(ns: string, verdict: 'right' | 'other_sense' | 'wrong'): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${JUDGE_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ verdict })),
      },
      times: { remainingTimes: 1, unlimited: false },
      priority: 10,
    },
  });
}
