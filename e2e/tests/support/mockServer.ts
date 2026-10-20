import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import type { APIRequestContext } from '@playwright/test';

import { NEW_PER_SESSION } from '../../../apps/server/src/domain/chooseConstants';
import { MOCKSERVER_URL, requireEnv } from '../../urls';
import { STUB_SENTENCE } from './cards';

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

/** Phase 55 (spec D4). The most cards a list session holds, so the positions a
 *  preparation stub answers: SESSION_LENGTH graded cards, and each ladder's meet
 *  and read aloud, which are free. */
export const MOST_CARDS = SESSION_LENGTH + 2 * NEW_PER_SESSION;

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

/**
 * Clears the namespace, then registers again the answers every list session's
 * preparation needs besides the batch (phase 34, below): a spec registers its
 * own stubs after this, as before, and never loses those.
 */
export async function clearGemini(request: APIRequestContext): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/clear`, {
    data: { path: `/${E2E_MOCK_NAMESPACE}/.*` },
  });
  if (!res.ok()) throw new Error(`MockServer clear failed: ${res.status()}`);
  await expectPreparationDefaults(request);
}

/**
 * Phase 34. Each in the server's prompt verbatim, so a stub answers its own
 * call and no other: ACCEPT_MARKER (apps/server/src/domain/accept.ts),
 * CONTEXT_MARKER (domain/context.ts) and CHECK_MARKER (domain/check.ts).
 */
const ACCEPT_MARKER = 'every right translation';
const CONTEXT_MARKER = 'pins the sense';
const CHECK_MARKER = 'a second opinion';
// Phase 66 (spec D2). The server's EXPLAIN_MARKER (apps/server/src/domain/explain.ts).
const EXPLAIN_MARKER = "list the mistakes in the learner's sentence";

/** Above the broad generation stub (no priority), below a spec's own answer to
 *  the same call (expectContext's and expectCheck's default). */
const DEFAULT_PRIORITY = 5;
const OVERRIDE_PRIORITY = 10;

async function expectMarked(
  request: APIRequestContext,
  marker: string,
  payload: unknown,
  priority: number,
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      priority,
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: `[\\s\\S]*${marker}[\\s\\S]*` } },
      httpResponse: { statusCode: 200, headers: { 'content-type': ['application/json'] }, body: envelope(payload) },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}

/**
 * Phase 34. A list session's preparation makes three calls besides the batch,
 * and these answer each one so that a session prepares as it did before them:
 *
 * - **accept** (spec D1): every rendering a session picks is asked once, in a
 *   background job. Answered with no other right word and no answer form, which
 *   stamps the rendering, so the job never retries. A failed one would retry in
 *   the background and could take a later spec's one-shot or body-matched stub.
 * - **context** (spec D6, D8): no sentence for any card, so every card falls
 *   back on its saved example, or shows none, and a sentence card is unmarked.
 * - **checker** (spec D5): it must name every option, or the attempt fails.
 *   expectCheck's answer keeps every card as the batch stubs made it.
 *
 * - **explain** (phase 66, spec D2): not a preparation call, but every translation card
 *   answered with a sentence of its own asks it beside its judge (phase 66b, spec D1).
 *   No mistakes, so a spec that never looks at the sentence's line sees "המשפט נכון",
 *   and no call reaches the generation stub.
 *
 * Registered by clearGemini, so every spec has them however it clears.
 */
async function expectPreparationDefaults(request: APIRequestContext): Promise<void> {
  await expectMarked(request, ACCEPT_MARKER, { answers: [], answer_form: null }, DEFAULT_PRIORITY);
  await expectContext(request, [], DEFAULT_PRIORITY);
  await expectCheck(request, {}, DEFAULT_PRIORITY);
  await expectMarked(request, EXPLAIN_MARKER, { corrected: '', mistakes: [] }, DEFAULT_PRIORITY);
}

/** Phase 34 (spec D6, D8). The context call's answer: per key, the sentence a
 *  bare-word card shows (`context`, `context_translation`, and `context_word`,
 *  the word to mark), or the practised word in a sentence card's Hebrew
 *  (`sentence_word`). A key left out falls back. Ranks above the default. */
export async function expectContext(
  request: APIRequestContext,
  items: { key: string; context?: string; context_translation?: string; context_word?: string; sentence_word?: string }[],
  priority = OVERRIDE_PRIORITY,
): Promise<void> {
  await expectMarked(request, CONTEXT_MARKER, { items }, priority);
}

/**
 * Phase 34 (spec D5). The checker's answer for q1 to q10, to MOST_CARDS since
 * phase 55: each of the three wrong options the batch stubs write (cards.ts) is
 * wrong, as an option and in a gap, and a sentence card's Hebrew translates
 * naturally as STUB_SENTENCE, which uses STUB_GAP, so the card is kept. It
 * reads no context sentence, so one the context call wrote is dropped:
 * `overrides` says how the checker reads one (`q3c`: `{ context_words }` for a
 * Hebrew sentence, `{ context_meaning }` for a target-language one). Ranks
 * above the default.
 */
export async function expectCheck(
  request: APIRequestContext,
  overrides: Record<string, Record<string, unknown>> = {},
  priority = OVERRIDE_PRIORITY,
): Promise<void> {
  const wrong = [false, false, false];
  const keys = Array.from({ length: MOST_CARDS }, (_, i) => `q${i + 1}`);
  const items = [
    ...keys.map((key) => ({ key, options: wrong, gap_fits: wrong, natural_translation: STUB_SENTENCE })),
    ...Object.keys(overrides)
      .filter((key) => !keys.includes(key))
      .map((key) => ({ key })),
  ].map((item) => ({ ...item, ...overrides[item.key] }));
  await expectMarked(request, CHECK_MARKER, { items }, priority);
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
 *  `{ items: [...] }`. The spec clears the namespace first, so this needs no
 *  body match: the only stubs beside it are phase 34's, each on its marker. */
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

/**
 * Phase 35. The generation call's answer, item by item, from each item's task.
 * A session no longer gives a position a fixed type (the card is chosen by the
 * learner's memory, spec D6), so no fixed list of keys can answer it. MockServer
 * renders this Velocity template per request instead: for each key `q1` to
 * `q<positions>`, it answers the task the request gave that key, from `byTask`.
 * The request's user part is JSON inside a JSON string, so an item reads
 * `\"key\":\"q3\",\"task\":\"word\"` in the body, and `contains` is a plain
 * substring test: `q1` never matches `q10`, whose next character differs.
 */
export async function expectGeminiByTask(
  request: APIRequestContext,
  byTask: Record<string, Record<string, unknown>>,
  positions: number,
): Promise<void> {
  // Text inside a JSON string, as the envelope's `text` holds the payload.
  const inString = (text: string) => JSON.stringify(text).slice(1, -1);
  const items: string[] = [];
  for (let position = 1; position <= positions; position++) {
    for (const [task, answer] of Object.entries(byTask)) {
      const item = JSON.stringify({ key: `q${position}`, ...answer });
      // Velocity reads `$` and `#` as its own; no stub answer needs either.
      if (/[$#]/.test(item)) throw new Error(`a generation stub answer cannot hold $ or #: ${item}`);
      const marker = inString(`"key":"q${position}","task":"${task}"`);
      items.push(`#if($request.body.contains('${marker}'))\${sep}${inString(item)}#set($sep = ',')#end##`);
    }
  }
  // `##` ends a line with a comment, newline included, so the JSON string the
  // items are written into never holds a raw newline.
  const template = [
    "#set($sep = '')##",
    '{"statusCode":200,"headers":{"content-type":["application/json"]},"body":{"candidates":[{"content":{"role":"model","parts":[{"text":"' +
      inString('{"items":[') +
      '##',
    ...items,
    inString(']}') + '"}]},"finishReason":"STOP"}]}}',
  ].join('\n');
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path },
      httpResponseTemplate: { templateType: 'VELOCITY', template },
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

/** Phase 50 (spec D2). The sound-alike call's answer for one pair, matched on
 *  the server's SOUND_ALIKE_MARKER (apps/server/src/domain/soundAlike.ts) and
 *  on the heard word, so two queued answers cannot swap. Consumed once. */
export async function expectSoundAlike(request: APIRequestContext, heard: string, score: number): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      priority: 10,
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: `(?=[\\s\\S]*how alike they sound)[\\s\\S]*${heard}[\\s\\S]*` } },
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: envelope({ scores: [{ key: 'p1', score }] }),
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
  /** `once`, as expectGemini's: a one-shot, consumed by the first call that matches.
   *  Phase 31. `priority`: MockServer tries a higher priority first, so a stub
   *  matched on a marker outranks one matched on the same text. */
  opts: { delayMs?: number; once?: boolean; priority?: number } = {},
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      ...(opts.priority ? { priority: opts.priority } : {}),
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

/** Phase 66 (spec D2). The explain call's answer, matched on the server's EXPLAIN_MARKER
 *  (apps/server/src/domain/explain.ts) and ranked above the generation stub. Consumed once. */
export async function expectExplain(
  request: APIRequestContext,
  answer: { corrected: string; mistakes: { wrong: string; right: string; why: string }[] },
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      priority: OVERRIDE_PRIORITY,
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: `[\\s\\S]*${EXPLAIN_MARKER}[\\s\\S]*` } },
      httpResponse: { statusCode: 200, headers: { 'content-type': ['application/json'] }, body: envelope(answer) },
      times: { remainingTimes: 1, unlimited: false },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}

/** Phase 27. The meaning judge's answer (or, with `misspelled` or `other_word`, the translation judge's; with `fits`, phase 41's fit check), matched on the server's JUDGE_MARKER
 *  (apps/server/src/domain/judge.ts) and ranked above the generation stub.
 *  Consumed once, in registration order. `status` makes it a failed call
 *  instead; `delayMs` holds the answer back so the "checking" state can be seen. */
export async function expectJudge(
  request: APIRequestContext,
  verdict: 'right' | 'other_sense' | 'wrong' | 'misspelled' | 'other_word' | 'fits',
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
