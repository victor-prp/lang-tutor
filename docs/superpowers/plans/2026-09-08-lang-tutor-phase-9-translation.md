# Phase 9 — Translation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A learner types a word, phrase or sentence and gets ranked meanings back from Gemini, with a **more** button for the rest and a per-meaning confirm button — nothing persisted.

**Architecture:** A new `providers/` layer holds outbound third-party I/O behind a two-line `LlmClient` contract declared in `services/`. `domain/translation.ts` stays pure and owns direction detection, the prompt, and parsing. A shared MockServer container stands in for Gemini in every test bucket, driven per test; a fourth opt-in bucket scores the real prompt against the real model.

**Tech Stack:** TypeScript, Hono + `@hono/zod-openapi`, Zod 4, Drizzle (untouched here), Expo/React Native, Jest, Playwright, MockServer, Gemini `generateContent`.

**Spec:** `docs/superpowers/specs/2026-09-08-lang-tutor-phase-9-translation-design.md`

## Global Constraints

Every task's requirements implicitly include these. Values are verbatim from the spec.

- **`text` bounds:** 1–100 characters after trimming. Violations are `400` with body `{ error: 'invalid request' }` (ADR 0003 R7).
- **Sense cap:** at most **5** senses per response.
- **Provider timeout:** **10 seconds**, via `AbortController`. No retry, no backoff.
- **Provider failure status:** `502` with body `{ error: 'translation unavailable' }`. Covers 5xx, 429, network failure, timeout, and unreadable model output.
- **Empty result:** `200` with `senses: []`. Never an error status.
- **Gemini call:** `POST {baseUrl}/v1beta/models/{model}:generateContent`, key in an **`x-goog-api-key` header** (never `?key=`), `generationConfig.responseMimeType: 'application/json'`, `generationConfig.responseSchema`, `temperature: 0`. Answer at `candidates[0].content.parts[0].text`.
- **Config:** `GEMINI_API_KEY` has **no default — `loadConfig` throws without it**. `GEMINI_BASE_URL` defaults to `https://generativelanguage.googleapis.com`. `GEMINI_MODEL` has no default in code.
- **MockServer:** port **1080**, `PUT /mockserver/expectation` to register.
- **Sentences:** `kind === 'sentence'` ⇒ exactly one sense, **no** `part_of_speech`, **no** `example`, and the UI shows neither **more** nor the save button.
- **ADR 0002:** no `jest.mock` anywhere; no optional or defaulted collaborator parameters; `process.env` only in `index.ts`, `db/cli.ts`, `_layout.tsx`.
- **ADR 0001 R3:** `apps/server/src/domain/` may import **only** `@lang-tutor/core/*`. No `from '../'` at all — not `errors.ts`, not `services/llm.ts`.
- **ADR 0001 R10 (new):** `providers/` imports nothing from `routes/`, `services/`, `domain/`, `repo/`, `db/`, `app.ts`, `composition.ts`.
- **ADR 0001 R11 (new):** `providers/` is imported **only** by `composition.ts`.
- **Every new ADR check must be demonstrated to fail on a planted violation** before it is trusted.
- **Hebrew copy** (exact strings, all in `apps/mobile/src/strings.ts`):
  - Home entry: `תרגום מלה או ביטוי`
  - Field placeholder: `מלה או ביטוי…`
  - Flip control: `⇄ החלף`
  - More: `עוד משמעויות` + ` (n)`
  - Choose: `זו המשמעות שחיפשתי`
  - Confirmed: `התרגום נשמר לאוצר המילים שלך`
  - New word: `מלה חדשה`
  - Empty: `לא מצאנו תרגום`
  - Error: `התרגום לא זמין`
  - Retry: `נסה שוב`

## Structural decisions locked in before any task starts

Three cross-layer type placements are forced by ADR 0001 and were resolved against the
existing `Transaction` precedent. **Do not "fix" these by adding imports.**

| Contract | Declared in | Implemented in | Where the types are checked |
|---|---|---|---|
| `LlmClient` | `services/llm.ts` | `providers/gemini.ts` — imports **nothing** from `services/` | `composition.ts`, on assignment |
| `TranslationPrompt` | `domain/translation.ts` | consumed as `LlmJsonRequest` | `services/translations.ts`, on the call |
| parse failure | `domain/` returns `null` | — | `services/translations.ts` throws `TranslationUnreadable` |

This mirrors `db/transaction.ts` exactly: it does not import `Transaction` from
`services/transaction.ts`; `createTransaction` returns a structurally compatible value and
`composition.ts` is where the assignment is verified. `TranslationPrompt` and
`LlmJsonRequest` are two names for one shape because R3 forbids `domain/` from importing
`services/` — that is deliberate, not duplication to be cleaned up.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/server/src/services/llm.ts` | `LlmJsonRequest`, `LlmClient`. Types only |
| `apps/server/src/providers/gemini.ts` | `createGeminiClient`, `toGeminiSchema`. The only outbound HTTP in the repo |
| `apps/server/src/domain/translation.ts` | `detectDirection`, `resolveKind`, `buildPrompt`, `parseLlmTranslation`, `dropNulls`. Pure |
| `apps/server/src/services/translations.ts` | `createTranslationService` — the use case. No transaction |
| `apps/server/src/routes/translations.ts` | `createTranslationsRouter` — transport only |
| `apps/mobile/src/app/translate.tsx` | The whole learner-facing flow |
| `apps/mobile/src/hooks/useTranslation.tsx` | Screen state machine, so the screen renders and does not orchestrate |
| `apps/server/tests/support/mockServer.ts` | Expectation registration, clearing, verification, namespaces |
| `apps/server/tests/support/geminiResponse.ts` | Builds the Gemini response envelope from `{ kind, senses }` |
| `apps/server/tests/eval/run.ts` | Standalone eval runner and scorecard |
| `apps/server/tests/eval/cases.ts` | The golden set |
| `e2e/tests/support/mockServer.ts` | The same three helpers, for Playwright's `request` fixture |
| `e2e/tests/translate.spec.ts` | The end-to-end flow |
| `.github/workflows/eval.yml` | `workflow_dispatch` + nightly, never on PRs |

**Modified**

| File | Change |
|---|---|
| `packages/core/src/api/schemas.ts` | Translation schemas, including `LlmTranslationSchema` |
| `packages/core/src/api/types.ts`, `index.ts` | Inferred types, exported |
| `apps/server/src/errors.ts` | `LlmUnavailable`, `TranslationUnreadable` |
| `apps/server/src/config.ts` | Three `GEMINI_*` fields; throws without the key |
| `apps/server/src/composition.ts` | Builds the client, adds `translations` to `AppDeps` |
| `apps/server/src/index.ts` | Passes `fetch` and the Gemini settings |
| `apps/server/src/app.ts` | Mounts `/api/translations` |
| `apps/server/tests/support/fakes.ts` | `translations` in `createFakeAppDeps`, `createFakeLlmClient` |
| `apps/mobile/src/api/client.ts` | `translate` |
| `apps/mobile/src/strings.ts` | The Hebrew copy above |
| `apps/mobile/src/app/index.tsx` | The entry card, in the reserved `futureSpace` |
| `docker-compose.yml` | The MockServer service |
| `package.json` | `db:up` brings up both services; `eval` script |
| `e2e/playwright.config.ts` | `GEMINI_BASE_URL`, `GEMINI_API_KEY` on the server entry |
| `e2e/globalSetup.ts` | MockServer reachability check |
| `docs/adr/adr-0001-layered-architecture.md` | R10, R11, amended R8, `providers/` row, new non-import rule |
| `docs/adr/adr-0002-di-with-closures.md` | R6's factory list gains `createGeminiClient`, `createTranslationService` |
| `docs/adr/adr-0004-test-topology.md` | R4's eval-bucket clause and two checks |
| `scripts/check-adr-0001-layered-architecture.sh` | Two new checks |
| `scripts/check-adr-0004-test-topology.sh` | Two new checks |
| `scripts/check-adrs.sh` | Header note on planted violations |
| `scripts/setup-worktree.sh` | Report a missing `GEMINI_API_KEY` |
| `README.md`, `CLAUDE.md` | Phase index, layer table, env vars, eval bucket, planted-violation rule |

**A note on running anything:** this repo's shell has a stripped `PATH`. Every command
below that needs `npm`, `node` or `docker` must be prefixed with:

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
```

Never run `npm run db:up` from a worktree while another checkout's Postgres holds 5432 —
reuse the running containers instead.

---

### Task 1: The wire contract in `packages/core`

**Files:**
- Modify: `packages/core/src/api/schemas.ts`
- Modify: `packages/core/src/api/types.ts`
- Modify: `packages/core/src/api/index.ts`
- Test: `packages/core/src/api/schemas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TranslationDirectionSchema`, `TranslationKindSchema`, `TranslationSenseSchema`,
  `TranslationRequestSchema`, `TranslationResponseSchema`, `LlmTranslationSchema` (values);
  `TranslationDirection`, `TranslationKind`, `TranslationSense`, `TranslationRequest`,
  `TranslationResponse`, `LlmTranslation` (types).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/api/schemas.test.ts`:

```ts
import {
  LlmTranslationSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
  TranslationSenseSchema,
} from './schemas';

describe('TranslationRequestSchema', () => {
  it('accepts a word and a phrase', () => {
    expect(TranslationRequestSchema.safeParse({ text: 'book' }).success).toBe(true);
    expect(TranslationRequestSchema.safeParse({ text: 'break a leg' }).success).toBe(true);
  });

  it('rejects empty, blank and over-long text', () => {
    expect(TranslationRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(TranslationRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(TranslationRequestSchema.safeParse({ text: 'a'.repeat(101) }).success).toBe(false);
  });

  it('accepts text at exactly the 100-character limit', () => {
    expect(TranslationRequestSchema.safeParse({ text: 'a'.repeat(100) }).success).toBe(true);
  });

  it('treats direction as an optional override with two values', () => {
    expect(TranslationRequestSchema.safeParse({ text: 'book' }).success).toBe(true);
    expect(TranslationRequestSchema.safeParse({ text: 'book', direction: 'he_en' }).success).toBe(
      true,
    );
    expect(TranslationRequestSchema.safeParse({ text: 'book', direction: 'fr_he' }).success).toBe(
      false,
    );
  });
});

describe('TranslationSenseSchema', () => {
  it('accepts a sense with no part of speech and no example — the sentence case', () => {
    expect(TranslationSenseSchema.safeParse({ translation: 'קראתי ספר על החלל.' }).success).toBe(
      true,
    );
  });

  it('accepts a full sense', () => {
    const result = TranslationSenseSchema.safeParse({
      translation: 'ספר',
      part_of_speech: 'noun',
      example: { source: 'I read a book.', target: 'קראתי ספר.' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty translation', () => {
    expect(TranslationSenseSchema.safeParse({ translation: '' }).success).toBe(false);
  });

  it('rejects a half-filled example', () => {
    expect(
      TranslationSenseSchema.safeParse({ translation: 'ספר', example: { source: 'x' } }).success,
    ).toBe(false);
  });
});

describe('TranslationResponseSchema', () => {
  it('caps senses at five', () => {
    const sense = { translation: 'ספר' };
    const base = { text: 'book', direction: 'en_he', kind: 'word' } as const;
    expect(
      TranslationResponseSchema.safeParse({ ...base, senses: Array(5).fill(sense) }).success,
    ).toBe(true);
    expect(
      TranslationResponseSchema.safeParse({ ...base, senses: Array(6).fill(sense) }).success,
    ).toBe(false);
  });

  it('accepts an empty sense list', () => {
    expect(
      TranslationResponseSchema.safeParse({
        text: 'asdkjhasd',
        direction: 'en_he',
        kind: 'word',
        senses: [],
      }).success,
    ).toBe(true);
  });
});

describe('LlmTranslationSchema', () => {
  it('is the response shape minus text and direction', () => {
    const result = LlmTranslationSchema.safeParse({
      kind: 'word',
      senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a model that invents its own direction', () => {
    const result = LlmTranslationSchema.safeParse({
      kind: 'word',
      direction: 'he_en',
      senses: [{ translation: 'ספר' }],
    });
    // Extra keys are stripped rather than rejected; what matters is that the
    // server's own direction is never overwritten by the model's.
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('direction');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w @lang-tutor/core
```

Expected: FAIL — `TranslationRequestSchema` is not exported from `./schemas`.

- [ ] **Step 3: Add the schemas**

Append to `packages/core/src/api/schemas.ts`:

```ts
// Translation, phase 9. Two directions only; a third language would need more
// than an enum entry, so narrowing here is honest rather than limiting.
export const TranslationDirectionSchema = z.enum(['en_he', 'he_en']);

// Describes the input, not a meaning, so it sits at the top level of the
// response. `word` is decided in code for a single token; the model answers the
// phrase/sentence distinction, which no token count can settle.
export const TranslationKindSchema = z.enum(['word', 'phrase', 'sentence']);

// `part_of_speech` and `example` are optional because a sentence has neither: a
// part of speech classifies a lexical item, and an example restates an input
// that is already a sentence. Optional rather than empty strings keeps "none"
// distinguishable from "the model forgot".
export const TranslationSenseSchema = z.object({
  translation: z.string().min(1),
  part_of_speech: z.string().optional(),
  example: z.object({ source: z.string().min(1), target: z.string().min(1) }).optional(),
});

export const TranslationRequestSchema = z.object({
  // Trimmed before length is judged, so "   " is empty rather than three chars.
  // The 100-character ceiling is also the cap on how much untrusted text can
  // reach the model in one call.
  text: z.string().trim().min(1).max(100),
  // Absent means "detect from the script". Present only when the learner taps
  // the flip control, so a wrong detection is recoverable.
  direction: TranslationDirectionSchema.optional(),
});

export const TranslationResponseSchema = z.object({
  text: z.string(),
  direction: TranslationDirectionSchema,
  kind: TranslationKindSchema,
  senses: z.array(TranslationSenseSchema).max(5),
});

// What the model is asked to return, and the schema each provider converts into
// its own structured-output dialect. Deliberately the response shape *minus*
// `text` and `direction`: both are decided in code before the call, so offering
// them to the model would only invite it to disagree with the server.
export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  senses: z.array(TranslationSenseSchema).max(5),
});
```

- [ ] **Step 4: Infer and export the types**

In `packages/core/src/api/types.ts`, add to the import list from `./schemas`:

```ts
  LlmTranslationSchema,
  TranslationDirectionSchema,
  TranslationKindSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
  TranslationSenseSchema,
```

and append the inferred types (every type in this file is a `z.infer` — ADR 0003 R3):

```ts
export type TranslationDirection = z.infer<typeof TranslationDirectionSchema>;
export type TranslationKind = z.infer<typeof TranslationKindSchema>;
export type TranslationSense = z.infer<typeof TranslationSenseSchema>;
export type TranslationRequest = z.infer<typeof TranslationRequestSchema>;
export type TranslationResponse = z.infer<typeof TranslationResponseSchema>;
export type LlmTranslation = z.infer<typeof LlmTranslationSchema>;
```

In `packages/core/src/api/index.ts`, add to the `export type { ... }` block, keeping it
alphabetical (this file exports types only — ADR 0003 R4):

```ts
  LlmTranslation,
  TranslationDirection,
  TranslationKind,
  TranslationRequest,
  TranslationResponse,
  TranslationSense,
```

- [ ] **Step 5: Run the tests and the type check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w @lang-tutor/core && npm run typecheck -w @lang-tutor/core
```

Expected: PASS, and no type errors.

- [ ] **Step 6: Verify the ADR 0003 checks still hold**

```bash
bash scripts/check-adr-0003-openapi-wire-contract.sh
```

Expected: all six rules ok. R3 fails if any new type is hand-written; R4 fails if
`index.ts` exports a value.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/api/
git commit -m "feat(core): add the translation wire contract"
```

---

### Task 2: MockServer as a compose service, with its test helper

**Files:**
- Modify: `docker-compose.yml`
- Modify: `package.json:22-23` (`db:up`, `db:down`)
- Create: `apps/server/tests/support/mockServer.ts`
- Create: `apps/server/tests/support/geminiResponse.ts`
- Test: `apps/server/tests/integration/support/mockServer.test.ts`

**Interfaces:**
- Consumes: `TranslationKind`, `TranslationSense` (Task 1) — the helper is typed against the
  wire contract, which is why the contract lands first.
- Produces: `mockNamespace(label: string): string`, `geminiBaseUrlFor(ns: string): string`,
  `expectGeminiJson(ns: string, opts: { kind: TranslationKind; senses: TranslationSense[]; matchText?: string }): Promise<void>`,
  `expectGeminiStatus(ns: string, statusCode: number): Promise<void>`,
  `expectGeminiDelayedJson(ns: string, opts: { kind: TranslationKind; senses: TranslationSense[]; delayMs: number }): Promise<void>`,
  `expectGeminiRawBody(ns: string, body: string): Promise<void>`,
  `clearNamespace(ns: string): Promise<void>`,
  `verifyGeminiHeader(ns: string, name: string, value: string): Promise<boolean>`,
  `assertMockServerReachable(): Promise<void>`,
  `geminiResponse(payload: unknown)`, `geminiBlockedResponse()`.

- [ ] **Step 1: Confirm MockServer's image tag and admin API against a running container**

Only `PUT /mockserver/expectation` and port 1080 were verified during design. Confirm the
rest before writing code that depends on it.

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
docker pull mockserver/mockserver:5.15.0
docker run --rm -d --name ms-probe -p 1080:1080 mockserver/mockserver:5.15.0
sleep 8
# create
curl -s -o /dev/null -w 'expectation:%{http_code}\n' -X PUT localhost:1080/mockserver/expectation \
  -d '{"httpRequest":{"method":"POST","path":"/probe/.*"},"httpResponse":{"statusCode":200,"body":"ok"}}'
curl -s -w ' <- match\n' -X POST localhost:1080/probe/v1beta/models/x:generateContent
# verify / clear / reset
curl -s -o /dev/null -w 'verify:%{http_code}\n' -X PUT localhost:1080/mockserver/verify \
  -d '{"httpRequest":{"path":"/probe/.*"},"times":{"atLeast":1}}'
curl -s -o /dev/null -w 'clear:%{http_code}\n' -X PUT localhost:1080/mockserver/clear -d '{"path":"/probe/.*"}'
curl -s -o /dev/null -w 'reset:%{http_code}\n' -X PUT localhost:1080/mockserver/reset
docker rm -f ms-probe

# the liveness path the compose healthcheck and both reachability probes depend on
docker run --rm -d --name ms-probe2 -p 1080:1080 \
  -e MOCKSERVER_LIVENESS_HTTP_GET_PATH=/liveness/probe mockserver/mockserver:5.15.0
sleep 8
curl -s -o /dev/null -w 'liveness:%{http_code}\n' localhost:1080/liveness/probe
docker rm -f ms-probe2
```

Expected: `expectation:201`, `ok <- match`, `verify:202`, `clear:200`, `reset:200`,
`liveness:200`. **If any path or status differs, adjust `mockServer.ts` in Step 6 to match
what the container actually does** — this probe is the source of truth, not this document.
Record the tag you pulled; use that exact tag in Step 2 (never `latest`). If
`MOCKSERVER_LIVENESS_HTTP_GET_PATH` is not the right variable name for this version, find
the one that is: the compose healthcheck, `assertMockServerReachable` and e2e's
`globalSetup` all depend on that path answering 200.

- [ ] **Step 2: Add the service to compose and widen `db:up`**

In `docker-compose.yml`, add alongside `db:` (keep the existing `volumes:` block last):

```yaml
  # A generic, pinned mock HTTP server standing in for the Gemini API in every
  # test bucket. Deliberately third-party and behaviour-free: each test pushes
  # its own expectations in at runtime, which is what makes one shared instance
  # safe across several checkouts — the same reason the Postgres container is
  # safe to share while a first-party mock would not be.
  mockserver:
    image: mockserver/mockserver:5.15.0
    ports:
      - '1080:1080'
    environment:
      MOCKSERVER_LIVENESS_HTTP_GET_PATH: /liveness/probe
    healthcheck:
      test: ['CMD-SHELL', 'curl -sf http://localhost:1080/liveness/probe || exit 1']
      interval: 2s
      timeout: 3s
      retries: 30
```

In `package.json`, replace the two script lines so one command still satisfies the whole
prerequisite:

```json
    "db:up": "docker compose up -d --wait db mockserver",
    "db:down": "docker compose down",
```

- [ ] **Step 3: Write the failing test**

Create `apps/server/tests/integration/support/mockServer.test.ts`:

```ts
import { describe, expect, it, afterEach } from '@jest/globals';

import {
  assertMockServerReachable,
  clearNamespace,
  expectGeminiJson,
  expectGeminiStatus,
  geminiBaseUrlFor,
  mockNamespace,
  verifyGeminiHeader,
} from '../../support/mockServer';

// Exercises the harness itself, not application code — the same reason
// tests/integration/support/isolation.test.ts exists. ADR 0004 R6 covers it.
describe('the MockServer helper', () => {
  const namespaces: string[] = [];
  const ns = (label: string) => {
    const value = mockNamespace(label);
    namespaces.push(value);
    return value;
  };

  afterEach(async () => {
    await Promise.all(namespaces.splice(0).map(clearNamespace));
  });

  it('is reachable', async () => {
    await expect(assertMockServerReachable()).resolves.toBeUndefined();
  });

  it('serves a registered Gemini response inside its own namespace', async () => {
    const namespace = ns('serves');
    await expectGeminiJson(namespace, {
      kind: 'word',
      senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
    });

    const res = await fetch(
      `${geminiBaseUrlFor(namespace)}/v1beta/models/test-model:generateContent`,
      { method: 'POST', headers: { 'x-goog-api-key': 'k' }, body: JSON.stringify({ q: 'book' }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
    expect(JSON.parse(body.candidates[0].content.parts[0].text)).toEqual({
      kind: 'word',
      senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
    });
  });

  it('keeps two namespaces from seeing each other', async () => {
    const a = ns('iso-a');
    const b = ns('iso-b');
    await expectGeminiJson(a, { kind: 'word', senses: [{ translation: 'א' }] });
    await expectGeminiStatus(b, 500);

    const resA = await fetch(`${geminiBaseUrlFor(a)}/v1beta/models/m:generateContent`, {
      method: 'POST',
      body: '{}',
    });
    const resB = await fetch(`${geminiBaseUrlFor(b)}/v1beta/models/m:generateContent`, {
      method: 'POST',
      body: '{}',
    });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(500);
  });

  it('verifies which headers a request carried', async () => {
    const namespace = ns('verify');
    await expectGeminiJson(namespace, { kind: 'word', senses: [] });

    await fetch(`${geminiBaseUrlFor(namespace)}/v1beta/models/m:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': 'secret-value' },
      body: '{}',
    });

    await expect(verifyGeminiHeader(namespace, 'x-goog-api-key', 'secret-value')).resolves.toBe(
      true,
    );
    await expect(verifyGeminiHeader(namespace, 'x-goog-api-key', 'wrong')).resolves.toBe(false);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run db:up
npm run test:integration -w apps/server -- support/mockServer
```

Expected: FAIL — `Cannot find module '../../support/mockServer'`.

- [ ] **Step 5: Write the envelope builder**

Create `apps/server/tests/support/geminiResponse.ts`:

```ts
/**
 * The Gemini `generateContent` response envelope, built from the JSON the model
 * is pretending to have produced. A test declares senses; this puts them where
 * the real API puts them, so `providers/gemini.ts` is exercised for real.
 *
 * Repo code, but it runs in the test process — never inside the shared
 * container — so two checkouts cannot disagree about it.
 */
export function geminiResponse(payload: unknown) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
}

/** A safety-blocked response: no candidate at all. Maps to an empty sense list. */
export function geminiBlockedResponse() {
  return { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] } };
}
```

- [ ] **Step 6: Write the MockServer helper**

Create `apps/server/tests/support/mockServer.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { TranslationKind, TranslationSense } from '@lang-tutor/core/api';

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
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ns';
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

async function expectation(ns: string, spec: Record<string, unknown>): Promise<void> {
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
  opts: { kind: TranslationKind; senses: TranslationSense[]; matchText?: string },
): Promise<void> {
  await expectation(ns, {
    match: opts.matchText
      ? { body: { type: 'REGEX', regex: `[\\s\\S]*${opts.matchText}[\\s\\S]*` } }
      : {},
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ kind: opts.kind, senses: opts.senses })),
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
  opts: { kind: TranslationKind; senses: TranslationSense[]; delayMs: number },
): Promise<void> {
  await expectation(ns, {
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ kind: opts.kind, senses: opts.senses })),
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
    // 202 = matched, 406 = not matched. Both are answers, not failures.
  });
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
```

- [ ] **Step 7: Run the tests and make sure they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration -w apps/server -- support/mockServer
```

Expected: PASS, 4 tests. If `expectGeminiJson` 404s at the match step, the `path` regex is
wrong for this MockServer version — compare against the Step 1 probe output.

Note: nothing in this helper ever calls `PUT /mockserver/reset`. Jest runs integration files
in parallel across workers against one shared container, so a global reset would wipe
expectations a concurrent worker had just registered. Namespaces are cleared individually,
and the reachability probe is a read-only GET.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml package.json apps/server/tests/support/mockServer.ts \
  apps/server/tests/support/geminiResponse.ts \
  apps/server/tests/integration/support/mockServer.test.ts
git commit -m "test: add a shared MockServer compose service and its harness"
```

---

### Task 3: `domain/translation.ts` — the pure core

This task carries most of the phase's logic. It runs with Docker stopped.

**Files:**
- Create: `apps/server/src/domain/translation.ts`
- Test: `apps/server/src/domain/translation.test.ts`

**Interfaces:**
- Consumes: `LlmTranslationSchema`, `TranslationDirection`, `TranslationKind`, `TranslationSense`, `LlmTranslation` from Task 1.
- Produces:
  - `detectDirection(text: string): TranslationDirection`
  - `resolveKind(text: string, modelKind: TranslationKind): TranslationKind`
  - `buildPrompt(input: { text: string; direction: TranslationDirection }): TranslationPrompt`
  - `parseLlmTranslation(raw: string): LlmTranslation | null`
  - `normalizeSenses(kind: TranslationKind, senses: TranslationSense[]): TranslationSense[]`
  - `dropNulls(value: unknown): unknown`
  - `type TranslationPrompt = { system: string; user: string; schema: typeof LlmTranslationSchema }`

**Layering rule for this file:** ADR 0001 R3 forbids **every** `from '../'` import. That is
why `parseLlmTranslation` returns `null` instead of throwing `TranslationUnreadable`, and why
`TranslationPrompt` is declared here rather than imported from `services/llm.ts`. Do not
import `zod` either — `typeof LlmTranslationSchema` gives the schema's type without it.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/domain/translation.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from './translation';

describe('detectDirection', () => {
  it('reads Latin script as English to Hebrew', () => {
    expect(detectDirection('book')).toBe('en_he');
    expect(detectDirection('break a leg')).toBe('en_he');
  });

  it('reads any Hebrew character as Hebrew to English', () => {
    expect(detectDirection('מזלג')).toBe('he_en');
    expect(detectDirection('ספר')).toBe('he_en');
  });

  it('treats mixed input as Hebrew, because one Hebrew letter settles it', () => {
    expect(detectDirection('the ספר')).toBe('he_en');
  });

  it('falls back to en_he for input with no letters at all', () => {
    expect(detectDirection('123')).toBe('en_he');
  });
});

describe('resolveKind', () => {
  it('forces word for a single token, whatever the model said', () => {
    expect(resolveKind('book', 'sentence')).toBe('word');
    expect(resolveKind('  book  ', 'phrase')).toBe('word');
  });

  it('trusts the model once there is internal whitespace', () => {
    expect(resolveKind('break a leg', 'phrase')).toBe('phrase');
    expect(resolveKind('I read a book', 'sentence')).toBe('sentence');
  });
});

describe('buildPrompt', () => {
  it('puts only the learner text in the user part', () => {
    expect(buildPrompt({ text: 'book', direction: 'en_he' }).user).toBe('book');
  });

  it('states the direction in the system part', () => {
    expect(buildPrompt({ text: 'book', direction: 'en_he' }).system).toContain('English');
    expect(buildPrompt({ text: 'ספר', direction: 'he_en' }).system).toContain('Hebrew');
  });

  it('carries the three rules that exist because of specific failures', () => {
    const { system } = buildPrompt({ text: 'break a leg', direction: 'en_he' });
    expect(system).toMatch(/imperative/i); // fixed expressions stay phrases
    expect(system).toMatch(/idiom/i); // translated by meaning, not word by word
    expect(system).toMatch(/exactly one sense/i); // a sentence is not polysemous
  });

  it('caps senses and forbids inventing a translation', () => {
    const { system } = buildPrompt({ text: 'asdkjhasd', direction: 'en_he' });
    expect(system).toMatch(/at most 5/i);
    expect(system).toMatch(/empty/i);
  });

  it('hands over the Zod schema itself, not a JSON Schema document', () => {
    const { schema } = buildPrompt({ text: 'book', direction: 'en_he' });
    expect(typeof schema.safeParse).toBe('function');
  });
});

describe('parseLlmTranslation', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({ kind: 'word', senses: [{ translation: 'ספר' }] });
    expect(parseLlmTranslation(raw)).toEqual({ kind: 'word', senses: [{ translation: 'ספר' }] });
  });

  it('treats null and absent identically, so an OpenAI-style response still parses', () => {
    const raw = JSON.stringify({
      kind: 'sentence',
      senses: [{ translation: 'קראתי ספר.', part_of_speech: null, example: null }],
    });
    const parsed = parseLlmTranslation(raw);
    expect(parsed).toEqual({ kind: 'sentence', senses: [{ translation: 'קראתי ספר.' }] });
    expect(parsed?.senses[0]).not.toHaveProperty('part_of_speech');
  });

  it('returns null for output that is not JSON', () => {
    expect(parseLlmTranslation('I cannot help with that.')).toBeNull();
    expect(parseLlmTranslation('')).toBeNull();
  });

  it('returns null for JSON of the wrong shape', () => {
    expect(parseLlmTranslation(JSON.stringify({ senses: [] }))).toBeNull();
    expect(parseLlmTranslation(JSON.stringify({ kind: 'clause', senses: [] }))).toBeNull();
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', senses: [{}] }))).toBeNull();
  });

  it('returns null when the model exceeds the five-sense cap', () => {
    const senses = Array(6).fill({ translation: 'x' });
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', senses }))).toBeNull();
  });

  it('accepts a fenced code block, which models emit even when told not to', () => {
    const raw = '```json\n{"kind":"word","senses":[{"translation":"ספר"}]}\n```';
    expect(parseLlmTranslation(raw)).toEqual({ kind: 'word', senses: [{ translation: 'ספר' }] });
  });
});

describe('normalizeSenses', () => {
  it('reduces a sentence to one sense with no part of speech and no example', () => {
    const senses = [
      {
        translation: 'קראתי ספר על החלל.',
        part_of_speech: 'verb',
        example: { source: 'x', target: 'y' },
      },
      { translation: 'משהו אחר' },
    ];
    expect(normalizeSenses('sentence', senses)).toEqual([{ translation: 'קראתי ספר על החלל.' }]);
  });

  it('leaves a word and a phrase untouched', () => {
    const senses = [{ translation: 'ספר', part_of_speech: 'noun' }];
    expect(normalizeSenses('word', senses)).toEqual(senses);
    expect(normalizeSenses('phrase', senses)).toEqual(senses);
  });

  it('handles an empty list', () => {
    expect(normalizeSenses('sentence', [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- domain/translation
```

Expected: FAIL — `Cannot find module './translation'`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/domain/translation.ts`:

```ts
import type {
  LlmTranslation,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';
import { LlmTranslationSchema } from '@lang-tutor/core/api/schemas';

/**
 * The pure core of translation: which way round the request is, what to ask the
 * model, and how to read the answer. No I/O, no clock, no randomness.
 *
 * ADR 0001 R3 forbids any `from '../'` import here, which shapes two things
 * deliberately: `parseLlmTranslation` returns `null` rather than throwing
 * `TranslationUnreadable` from `../errors`, and `TranslationPrompt` is declared
 * here rather than imported from `../services/llm`. It is structurally identical
 * to `LlmJsonRequest`; `services/translations.ts` is where the two meet and the
 * compiler checks them. Same arrangement as `db/transaction.ts` and
 * `services/transaction.ts`.
 */
export type TranslationPrompt = {
  system: string;
  user: string;
  schema: typeof LlmTranslationSchema;
};

// The Hebrew block. Hebrew and Latin are disjoint in Unicode, so one character
// settles the direction — deterministic, free, and reproducible in a unit test,
// where asking the model would have been none of those things.
const HEBREW = /[֐-׿]/;

export function detectDirection(text: string): TranslationDirection {
  return HEBREW.test(text) ? 'he_en' : 'en_he';
}

/**
 * The model classifies `phrase` against `sentence`, because no token count can:
 * `break a leg` is three tokens and a phrase, `I read` is two and a sentence.
 * The single-token case is the one thing code can be certain of, so it wins
 * outright.
 */
export function resolveKind(text: string, modelKind: TranslationKind): TranslationKind {
  return /\s/.test(text.trim()) ? modelKind : 'word';
}

const LANGUAGE_NAMES = {
  en_he: { from: 'English', to: 'Hebrew' },
  he_en: { from: 'Hebrew', to: 'English' },
} as const;

export function buildPrompt(input: {
  text: string;
  direction: TranslationDirection;
}): TranslationPrompt {
  const { from, to } = LANGUAGE_NAMES[input.direction];

  // Three of these rules exist because of a specific failure mode, and each has
  // an eval case: an imperative fixed expression misclassified as a sentence, an
  // idiom translated word by word, and a sentence padded into a list of
  // alternatives behind a `more` button that should not appear.
  const system = [
    `You translate from ${from} to ${to} for a Hebrew-speaking learner of English.`,
    'Return JSON only, matching the supplied schema.',
    'Classify the input as "word", "phrase" or "sentence".',
    'A fixed dictionary expression is a "phrase" even when it is grammatically imperative:',
    '"break a leg" is a phrase, not a sentence.',
    'Translate an idiom by its meaning, never word by word.',
    `For a "word" or a "phrase": return its distinct senses ranked with the most common`,
    'first, at most 5. Give each sense a part_of_speech and one short natural example',
    `sentence in ${from} together with its ${to} translation.`,
    'For a "sentence": return exactly one sense holding the translation, and omit',
    'part_of_speech and example entirely — a sentence has no part of speech and needs',
    'no example of itself.',
    'If the input is not a word or expression in either language, return an empty',
    'senses array rather than inventing a translation.',
  ].join(' ');

  // The learner's text is untrusted and stays in its own part, never
  // concatenated into the instruction. Structured output is the real protection:
  // an injection cannot change the shape the client parses.
  return { system, user: input.text, schema: LlmTranslationSchema };
}

/**
 * Models emit fenced JSON even when asked not to. Stripping the fence is
 * tolerance for a formatting habit, not for a wrong shape — the schema still
 * decides whether the content is acceptable.
 */
function unfence(raw: string): string {
  const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : raw;
}

/**
 * Removes null-valued keys so `null` and absent mean the same thing. Under
 * OpenAI's strict structured output an optional field comes back as `null`
 * rather than missing, so a parser that tolerated only absence would break on a
 * provider swap — the exact coupling the `LlmClient` seam exists to prevent.
 */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, dropNulls(entry)]),
  );
}

/** `null` means unreadable. The caller decides what that costs — see
 *  services/translations.ts, which raises TranslationUnreadable. */
export function parseLlmTranslation(raw: string): LlmTranslation | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmTranslationSchema.safeParse(dropNulls(json));
  return result.success ? result.data : null;
}

/**
 * Makes the sentence contract true regardless of what the model returned. The
 * schema permits a sentence with three senses and a part of speech; the app's
 * contract does not, and the server is the last place that can enforce it.
 */
export function normalizeSenses(
  kind: TranslationKind,
  senses: TranslationSense[],
): TranslationSense[] {
  if (kind !== 'sentence') return senses;
  return senses.slice(0, 1).map((sense) => ({ translation: sense.translation }));
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- domain/translation && npm run typecheck -w apps/server
```

Expected: PASS, and no type errors.

- [ ] **Step 5: Confirm the domain layer is still pure**

```bash
bash scripts/check-adr-0001-layered-architecture.sh
```

Expected: all fifteen rules ok. R3's two commands are the ones at risk — if either prints,
a `from '../'` import or a `Date.now`/`Math.random` crept in.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/translation.ts apps/server/src/domain/translation.test.ts
git commit -m "feat(server): add pure translation domain logic"
```

---

### Task 4: The `LlmClient` seam and the Gemini provider

**Files:**
- Modify: `apps/server/src/errors.ts`
- Create: `apps/server/src/services/llm.ts`
- Create: `apps/server/src/providers/gemini.ts`
- Test: `apps/server/src/providers/gemini.test.ts`

**Interfaces:**
- Consumes: `LlmTranslationSchema` (Task 1) in tests only.
- Produces:
  - `type LlmJsonRequest = { system: string; user: string; schema: ZodType }`
  - `type LlmClient = (request: LlmJsonRequest) => Promise<string>`
  - `toGeminiSchema(schema: ZodType): Record<string, unknown>`
  - `createGeminiClient(deps: { fetch: typeof globalThis.fetch; baseUrl: string; apiKey: string; model: string; timeoutMs: number }): LlmClient`
  - `class LlmUnavailable extends Error`, `class TranslationUnreadable extends Error`

**Layering rule for this file:** R10 — `providers/gemini.ts` imports **nothing** from
`services/`, `domain/`, `routes/`, `repo/`, `db/`, `app.ts` or `composition.ts`. It may
import `errors.ts`, which is a leaf module. It does **not** annotate its return as
`LlmClient`; `composition.ts` checks that assignment, exactly as `db/transaction.ts` leaves
`Transaction` to be checked there.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/providers/gemini.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import { LlmTranslationSchema } from '@lang-tutor/core/api/schemas';

import { LlmUnavailable } from '../errors';
import { createGeminiClient, toGeminiSchema } from './gemini';

const request = { system: 'be helpful', user: 'book', schema: LlmTranslationSchema };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function geminiBody(text: string) {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] };
}

function clientWith(fetchImpl: typeof globalThis.fetch) {
  return createGeminiClient({
    fetch: fetchImpl,
    baseUrl: 'https://example.test',
    apiKey: 'secret',
    model: 'test-model',
    timeoutMs: 50,
  });
}

describe('toGeminiSchema', () => {
  it('strips the keys Gemini rejects and keeps the ones it needs', () => {
    const schema = toGeminiSchema(LlmTranslationSchema) as Record<string, unknown>;
    const senses = (schema.properties as Record<string, Record<string, unknown>>).senses;
    const item = senses.items as Record<string, unknown>;

    expect(schema).not.toHaveProperty('$schema');
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(item).not.toHaveProperty('additionalProperties');
    expect(senses.maxItems).toBe(5);
    expect(item.required).toEqual(['translation']);
    expect(schema.required).toEqual(['kind', 'senses']);
  });

  it('leaves no $schema or additionalProperties at any depth', () => {
    const serialized = JSON.stringify(toGeminiSchema(LlmTranslationSchema));
    expect(serialized).not.toContain('$schema');
    expect(serialized).not.toContain('additionalProperties');
  });
});

describe('createGeminiClient', () => {
  it('posts to the generateContent path with the key in a header', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const client = clientWith(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return jsonResponse(geminiBody('{"kind":"word","senses":[]}'));
    });

    await client(request);

    expect(seenUrl).toBe('https://example.test/v1beta/models/test-model:generateContent');
    expect(seenInit?.method).toBe('POST');
    expect((seenInit?.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
    // Never a query parameter: that would put the secret in URLs and access logs.
    expect(seenUrl).not.toContain('key=');
  });

  it('sends the system instruction, the user text and structured-output config', async () => {
    let body: Record<string, unknown> = {};
    const client = clientWith(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(geminiBody('{"kind":"word","senses":[]}'));
    });

    await client(request);

    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be helpful' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'book' }] }]);
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.temperature).toBe(0);
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseSchema).toBeDefined();
    expect(JSON.stringify(config.responseSchema)).not.toContain('$schema');
  });

  it('returns the model text verbatim', async () => {
    const client = clientWith(async () => jsonResponse(geminiBody('{"kind":"word","senses":[]}')));
    await expect(client(request)).resolves.toBe('{"kind":"word","senses":[]}');
  });

  it('returns an empty string when the response was safety-blocked', async () => {
    const client = clientWith(async () =>
      jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    );
    // Empty string is the contract's "no content", which the service turns into
    // an empty sense list rather than an error.
    await expect(client(request)).resolves.toBe('');
  });

  it('returns an empty string when a candidate carries no text part', async () => {
    const client = clientWith(async () => jsonResponse({ candidates: [{ content: {} }] }));
    await expect(client(request)).resolves.toBe('');
  });

  it('maps a 500 to LlmUnavailable', async () => {
    const client = clientWith(async () => jsonResponse({ error: 'boom' }, 500));
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('maps a 429 to LlmUnavailable', async () => {
    const client = clientWith(async () => jsonResponse({ error: 'slow down' }, 429));
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('maps a network failure to LlmUnavailable', async () => {
    const client = clientWith(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('maps a body that is not JSON to LlmUnavailable', async () => {
    const client = clientWith(async () => new Response('<html>gateway</html>', { status: 200 }));
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('aborts once the budget is spent and maps that to LlmUnavailable', async () => {
    const client = clientWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('does not leak the key into the error message', async () => {
    const client = clientWith(async () => jsonResponse({ error: 'boom' }, 500));
    await expect(client(request)).rejects.toThrow(expect.not.stringContaining('secret'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- providers/gemini
```

Expected: FAIL — `Cannot find module './gemini'`.

- [ ] **Step 3: Add the two errors**

Append to `apps/server/src/errors.ts`:

```ts
/** The provider could not be reached, refused the request, or ran out of time.
 *  One error for every cause the learner can do nothing different about; the
 *  distinguishing detail goes in the log, not the status. */
export class LlmUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`language model unavailable: ${detail}`);
    this.name = 'LlmUnavailable';
  }
}

/** The provider answered, but not with something that satisfies the schema.
 *  Separate from LlmUnavailable because the operator needs to know whether the
 *  provider failed or the prompt did, even though both map to 502. */
export class TranslationUnreadable extends Error {
  constructor(readonly rawExcerpt: string) {
    super('the model response did not match the expected shape');
    this.name = 'TranslationUnreadable';
  }
}
```

- [ ] **Step 4: Declare the seam**

Create `apps/server/src/services/llm.ts`:

```ts
import type { ZodType } from 'zod';

/**
 * The entire provider abstraction: one JSON-shaped completion call.
 *
 * Types only, exactly as `services/transaction.ts` holds `Transaction` — which
 * is what keeps a provider's name out of the service layer without an interface
 * file or a base class. `providers/` implements this structurally and imports
 * nothing from here (ADR 0001 R10); `composition.ts` is where the assignment is
 * checked (R11).
 *
 * Deliberately not covered: streaming, tool calls, multi-turn conversations,
 * embeddings, token accounting. A seam wide enough for capabilities nobody uses
 * is a seam nobody can change.
 */
export type LlmJsonRequest = {
  system: string;
  user: string;
  /**
   * The canonical Zod schema, NOT a JSON Schema document. Each provider converts
   * it to its own dialect, because the dialects contradict each other: Gemini
   * rejects `additionalProperties` while OpenAI's strict mode requires it, and
   * Zod expresses optional by omitting from `required` while OpenAI's strict
   * mode forbids that. A document here would mean this layer had already picked
   * a provider.
   */
  schema: ZodType;
};

/**
 * Returns the model's raw JSON text. Parsing and validation happen once, in
 * `domain/`, so malformed output fails identically whoever served it.
 *
 * An **empty string means the provider produced no content** — a safety block,
 * or a candidate with no text. That is a valid answer about the input, not a
 * failure, and the caller turns it into an empty result. Every actual failure
 * throws `LlmUnavailable`.
 */
export type LlmClient = (request: LlmJsonRequest) => Promise<string>;
```

- [ ] **Step 5: Write the provider**

Create `apps/server/src/providers/gemini.ts`:

```ts
import { z, type ZodType } from 'zod';

import { LlmUnavailable } from '../errors';

/**
 * The only outbound HTTP in this repository (ADR 0001 R10/R11). It knows about
 * Gemini's request shape, its response envelope and its schema dialect, and
 * nothing about translation: no senses, no directions, no `kind`.
 *
 * Raw `fetch` rather than `@google/genai`, because the SDK reads
 * GEMINI_API_KEY from the environment itself, which ADR 0002 R2 forbids outside
 * a composition root.
 *
 * Note there is no `: LlmClient` annotation. That type lives in `services/`,
 * which R10 forbids importing; the assignment is checked in `composition.ts`,
 * exactly as `db/transaction.ts` leaves `Transaction` to be checked there.
 */

// Keys Zod emits that Gemini's Schema type does not accept. Measured, not
// guessed: z.toJSONSchema emits `$schema` at the root and
// `additionalProperties: false` on every object. OpenAI's strict mode wants the
// second one *kept*, which is exactly why this conversion belongs to a provider
// rather than to the caller.
const UNSUPPORTED_KEYS = ['$schema', 'additionalProperties'] as const;

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_KEYS.includes(key as (typeof UNSUPPORTED_KEYS)[number]))
      .map(([key, value]) => [key, strip(value)]),
  );
}

export function toGeminiSchema(schema: ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export function createGeminiClient(deps: {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}) {
  const endpoint = `${deps.baseUrl}/v1beta/models/${deps.model}:generateContent`;

  return async (request: { system: string; user: string; schema: ZodType }): Promise<string> => {
    // One budget for the whole call. No retry: a learner who taps retry *is*
    // the retry, and three sequential ten-second waits would be worse than one.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

    let response: Response;
    try {
      response = await deps.fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // A header, never `?key=`: a query parameter puts the secret into
          // URLs, access logs and any intermediary proxy.
          'x-goog-api-key': deps.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(request.schema),
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // Abort and network failure arrive here identically. The message names the
      // cause and never the key.
      throw new LlmUnavailable(
        controller.signal.aborted ? `timed out after ${deps.timeoutMs}ms` : 'network failure',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new LlmUnavailable(`responded ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LlmUnavailable('response body was not JSON');
    }

    // A safety block arrives as promptFeedback.blockReason with no candidate.
    // Empty string is the contract's "no content" — the input was refused, the
    // provider was not broken.
    const text = (body as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' ? text : '';
  };
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- providers/gemini && npm run typecheck -w apps/server
```

Expected: PASS, 13 tests. If `toGeminiSchema`'s two tests fail on `maxItems` or `required`,
re-run the measurement — the installed Zod may emit a different document than the one this
plan was written against:

```bash
node -e "const {z}=require('zod');const s=require('./packages/core/src/api/schemas.ts');" 2>/dev/null || \
  echo "inspect z.toJSONSchema(LlmTranslationSchema) from a scratch .mjs inside the repo root"
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/errors.ts apps/server/src/services/llm.ts \
  apps/server/src/providers/gemini.ts apps/server/src/providers/gemini.test.ts
git commit -m "feat(server): add the LlmClient seam and the Gemini provider"
```

---

### Task 5: `services/translations.ts` — the use case

**Files:**
- Create: `apps/server/src/services/translations.ts`
- Modify: `apps/server/tests/support/fakes.ts`
- Test: `apps/server/src/services/translations.test.ts`

**Interfaces:**
- Consumes: `buildPrompt`, `detectDirection`, `normalizeSenses`, `parseLlmTranslation`, `resolveKind` (Task 3); `LlmClient`, `LlmJsonRequest` (Task 4); `TranslationUnreadable` (Task 4).
- Produces:
  - `createTranslationService(deps: { llm: LlmClient; logger: Logger }): TranslationService`
  - `type TranslationService = ReturnType<typeof createTranslationService>` with `translate(input: TranslationRequest): Promise<TranslationResponse>`
  - `createFakeLlmClient(...replies: (string | Error)[])` in `tests/support/fakes.ts`

**This is the first use case with no transaction at all** — it touches no table. That is
what makes ADR 0001 R8's wording false, and Task 8 amends it. Do not add a `transaction`
parameter to make it look like its neighbours.

- [ ] **Step 1: Add the fake LLM client**

Append to `apps/server/tests/support/fakes.ts` (and add `import type { LlmClient, LlmJsonRequest } from '../../src/services/llm';` to the imports at the top):

```ts
/**
 * Replies in order; the last reply repeats once the queue is down to one, so a
 * test that calls twice does not have to say so. An Error in the queue is
 * thrown rather than returned, which is how a provider failure is simulated
 * without a socket.
 */
export function createFakeLlmClient(...replies: (string | Error)[]) {
  const calls: LlmJsonRequest[] = [];
  const queue = [...replies];

  const client: LlmClient = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };

  return Object.assign(client, { calls });
}
```

Also add `translations` to `createFakeAppDeps`, so the document-shape test keeps failing
loudly on any collaborator it reaches (add the import
`import type { TranslationService } from '../../src/services/translations';`):

```ts
  const translations: TranslationService = {
    translate: unreachable,
  };
```

and include `translations` in the returned object.

- [ ] **Step 2: Write the failing tests**

Create `apps/server/src/services/translations.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { createFakeLlmClient, createFakeLogger } from '../../tests/support/fakes';
import { LlmUnavailable, TranslationUnreadable } from '../errors';
import { createTranslationService } from './translations';

const reply = (payload: unknown) => JSON.stringify(payload);

function serviceWith(...replies: (string | Error)[]) {
  const llm = createFakeLlmClient(...replies);
  const logger = createFakeLogger();
  return { service: createTranslationService({ llm, logger }), llm, logger };
}

describe('translate', () => {
  it('detects the direction and echoes the trimmed text back', async () => {
    const { service } = serviceWith(reply({ kind: 'word', senses: [{ translation: 'ספר' }] }));

    const result = await service.translate({ text: '  book  ' });

    expect(result.text).toBe('book');
    expect(result.direction).toBe('en_he');
  });

  it('honours an explicit direction, which is what the flip control sends', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', senses: [] }));

    const result = await service.translate({ text: 'book', direction: 'he_en' });

    expect(result.direction).toBe('he_en');
    expect(llm.calls[0].system).toContain('Hebrew to English');
  });

  it('passes the prompt straight through to the client', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', senses: [] }));

    await service.translate({ text: 'book' });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toBe('book');
    expect(typeof llm.calls[0].schema.safeParse).toBe('function');
  });

  it('overrides the model when a single token is called a sentence', async () => {
    const { service } = serviceWith(
      reply({ kind: 'sentence', senses: [{ translation: 'ספר' }] }),
    );

    const result = await service.translate({ text: 'book' });

    expect(result.kind).toBe('word');
  });

  it('reduces a real sentence to one bare sense', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'sentence',
        senses: [
          { translation: 'קראתי ספר.', part_of_speech: 'verb', example: { source: 'a', target: 'b' } },
          { translation: 'אחר' },
        ],
      }),
    );

    const result = await service.translate({ text: 'I read a book' });

    expect(result.kind).toBe('sentence');
    expect(result.senses).toEqual([{ translation: 'קראתי ספר.' }]);
  });

  it('treats no content as an empty result rather than a failure', async () => {
    const { service, logger } = serviceWith('');

    const result = await service.translate({ text: 'asdkjhasd' });

    expect(result.senses).toEqual([]);
    expect(logger.events.map((event) => event.event)).toContain('translation_no_content');
  });

  it('treats an empty sense list from the model as an empty result', async () => {
    const { service } = serviceWith(reply({ kind: 'word', senses: [] }));
    await expect(service.translate({ text: 'asdkjhasd' })).resolves.toMatchObject({ senses: [] });
  });

  it('raises TranslationUnreadable for output that does not match the schema', async () => {
    const { service } = serviceWith('I cannot help with that.');
    await expect(service.translate({ text: 'book' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
  });

  it('truncates the excerpt it carries, so a log line cannot be flooded', async () => {
    const { service } = serviceWith('x'.repeat(5000));
    await expect(service.translate({ text: 'book' })).rejects.toMatchObject({
      rawExcerpt: expect.stringMatching(/^x{200}$/),
    });
  });

  it('lets LlmUnavailable through untouched', async () => {
    const { service } = serviceWith(new LlmUnavailable('responded 500'));
    await expect(service.translate({ text: 'book' })).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('logs one event per successful translation', async () => {
    const { service, logger } = serviceWith(
      reply({ kind: 'word', senses: [{ translation: 'ספר' }] }),
    );

    await service.translate({ text: 'book' });

    expect(logger.events).toEqual([
      { event: 'translated', direction: 'en_he', kind: 'word', sense_count: 1 },
    ]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- services/translations
```

Expected: FAIL — `Cannot find module './translations'`.

- [ ] **Step 4: Write the service**

Create `apps/server/src/services/translations.ts`:

```ts
import type { TranslationRequest, TranslationResponse } from '@lang-tutor/core/api';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from '../domain/translation';
import { TranslationUnreadable } from '../errors';
import type { Logger } from '../logger';
import type { LlmClient } from './llm';

/**
 * One use case: translate a word, phrase or sentence.
 *
 * **No transaction, because no table is touched.** ADR 0001 R8 is amended in
 * this phase for exactly this reason — "each use case is exactly one
 * transaction call" was written when the only I/O was Postgres.
 *
 * This layer knows nothing about Gemini, HTTP, or schema dialects. It receives
 * an `LlmClient` and hands it what `domain/` built; `buildPrompt`'s
 * `TranslationPrompt` and `LlmJsonRequest` are the same shape under two names,
 * and this call is where the compiler checks that.
 */
export function createTranslationService({
  llm,
  logger,
}: {
  llm: LlmClient;
  logger: Logger;
}) {
  return {
    translate: async (input: TranslationRequest): Promise<TranslationResponse> => {
      // The schema already trimmed this, but the service must not depend on the
      // order validators ran in.
      const text = input.text.trim();
      const direction = input.direction ?? detectDirection(text);

      const raw = await llm(buildPrompt({ text, direction }));

      // An empty string is the contract's "no content" — a safety block, or a
      // candidate with no text. The input was refused; nothing is broken.
      if (raw === '') {
        logger.info({ event: 'translation_no_content', direction });
        return { text, direction, kind: resolveKind(text, 'word'), senses: [] };
      }

      const parsed = parseLlmTranslation(raw);
      // `domain/` cannot throw this itself: R3 forbids it importing ../errors.
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      const kind = resolveKind(text, parsed.kind);
      const senses = normalizeSenses(kind, parsed.senses);

      logger.info({ event: 'translated', direction, kind, sense_count: senses.length });
      return { text, direction, kind, senses };
    },
  };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
```

- [ ] **Step 5: Run the tests and make sure they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server && npm run typecheck -w apps/server
```

Expected: PASS. The whole unit bucket runs here because `fakes.ts` changed, and
`app.test.ts` compiles against the new `AppDeps` shape.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/translations.ts \
  apps/server/src/services/translations.test.ts apps/server/tests/support/fakes.ts
git commit -m "feat(server): add the translation use case"
```

---

### Task 6: Configuration, composition and the process root

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `scripts/setup-worktree.sh`
- Modify: `README.md`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes: `createGeminiClient` (Task 4), `createTranslationService` (Task 5).
- Produces:
  - `loadGeminiConfig(env: NodeJS.ProcessEnv): GeminiConfig` where `GeminiConfig = { apiKey: string; baseUrl: string; model: string }`
  - `AppDeps` gains `translations: TranslationService`
  - `createServerDeps(io: { db: Db; logger: Logger; rng: () => number; fetch: typeof globalThis.fetch; gemini: GeminiConfig }): AppDeps`
  - `TRANSLATION_TIMEOUT_MS = 10_000`

**Why the config is split, not extended:** `db/cli.ts` also calls `loadConfig(process.env)`.
If `loadConfig` threw on a missing `GEMINI_API_KEY`, `npm run db:migrate` would start
requiring an LLM key it has no use for. `loadGeminiConfig` is a second, separate reader that
only the server process calls.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/config.test.ts`:

```ts
import { loadGeminiConfig } from './config';

describe('loadGeminiConfig', () => {
  const complete = {
    GEMINI_API_KEY: 'k',
    GEMINI_MODEL: 'gemini-flash-test',
  } as NodeJS.ProcessEnv;

  it('reads the three settings', () => {
    expect(
      loadGeminiConfig({ ...complete, GEMINI_BASE_URL: 'http://localhost:1080/ns' }),
    ).toEqual({
      apiKey: 'k',
      baseUrl: 'http://localhost:1080/ns',
      model: 'gemini-flash-test',
    });
  });

  it('defaults the base URL to Google, because production is the common case', () => {
    expect(loadGeminiConfig(complete).baseUrl).toBe('https://generativelanguage.googleapis.com');
  });

  it('throws when the key is absent, rather than failing at the first lookup', () => {
    expect(() => loadGeminiConfig({ GEMINI_MODEL: 'm' } as NodeJS.ProcessEnv)).toThrow(
      /GEMINI_API_KEY/,
    );
  });

  it('throws when the key is blank', () => {
    expect(() =>
      loadGeminiConfig({ ...complete, GEMINI_API_KEY: '  ' } as NodeJS.ProcessEnv),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it('throws when the model is absent — there is no safe default to guess', () => {
    expect(() => loadGeminiConfig({ GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv)).toThrow(
      /GEMINI_MODEL/,
    );
  });

  it('never puts the key in the error message', () => {
    expect(() =>
      loadGeminiConfig({ GEMINI_API_KEY: '', GEMINI_MODEL: '' } as NodeJS.ProcessEnv),
    ).toThrow(expect.not.stringContaining('k'));
  });
});

describe('loadConfig', () => {
  it('still works with no Gemini settings at all, so db:migrate is unaffected', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toContain('postgres://');
    expect(config.port).toBe(3001);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- config
```

Expected: FAIL — `loadGeminiConfig` is not exported.

- [ ] **Step 3: Add the reader**

Append to `apps/server/src/config.ts`:

```ts
/**
 * The provider settings, read separately from Config on purpose.
 *
 * `db/cli.ts` calls loadConfig too, and a migration has no use for an LLM key —
 * folding these into Config would make `npm run db:migrate` fail without one.
 */
export type GeminiConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Throws rather than defaulting. A missing key must fail at startup, not at the
 * moment a learner taps the button — the same reasoning that removed the
 * language defaults from `users` in phase 8: a default can only mask a bug.
 * There is deliberately no `GEMINI_MODEL` default either, because guessing a
 * model id silently changes what the app costs and how it answers.
 */
export function loadGeminiConfig(env: NodeJS.ProcessEnv): GeminiConfig {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Set it to a real key, or point GEMINI_BASE_URL at ' +
        'local MockServer (http://localhost:1080/<namespace>) with any dummy value.',
    );
  }

  const model = env.GEMINI_MODEL?.trim();
  if (!model) {
    throw new Error('GEMINI_MODEL is not set (for example: a current Gemini Flash model id).');
  }

  return { apiKey, baseUrl: env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL, model };
}
```

- [ ] **Step 4: Wire it through composition**

In `apps/server/src/composition.ts`, add the imports:

```ts
import type { GeminiConfig } from './config';
import { createGeminiClient } from './providers/gemini';
import { createTranslationService, type TranslationService } from './services/translations';
import type { LlmClient } from './services/llm';
```

Add to `AppDeps`:

```ts
  translations: TranslationService;
```

Extend the signature and body of `createServerDeps`:

```ts
// The one place in the repo that names both `createGeminiClient` and `LlmClient`
// (ADR 0001 R11). The annotation below is what checks that the provider
// satisfies the contract — providers/ cannot import it, exactly as
// db/transaction.ts cannot import Transaction.
const TRANSLATION_TIMEOUT_MS = 10_000;

export function createServerDeps(io: {
  db: Db;
  logger: Logger;
  rng: () => number;
  fetch: typeof globalThis.fetch;
  gemini: GeminiConfig;
}): AppDeps {
  const transaction = createTransaction(io.db, (tx) => ({
    session: createSessionRepo(tx),
    question: createQuestionRepo(tx),
    user: createUserRepo(tx),
  }));

  const llm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: TRANSLATION_TIMEOUT_MS,
  });

  return {
    sessions: createSessionService({ transaction, rng: io.rng, logger: io.logger }),
    users: createUserService({ transaction, logger: io.logger }),
    translations: createTranslationService({ llm, logger: io.logger }),
    health: createHealthRepo(io.db),
    logger: io.logger,
  };
}
```

- [ ] **Step 5: Wire the process root**

In `apps/server/src/index.ts`, add `loadGeminiConfig` to the config import, then inside
`main()` — **before** `createDb`, so a missing key fails before a pool is opened:

```ts
  const config = loadConfig(process.env);
  // Before the pool: a misconfigured server should fail without having opened
  // a connection it will never use.
  const gemini = loadGeminiConfig(process.env);
```

and pass it down:

```ts
  const deps = createServerDeps({
    db,
    logger,
    rng: Math.random,
    fetch: globalThis.fetch,
    gemini,
  });
```

- [ ] **Step 6: Add a test-deps helper and repoint every existing call site**

Widening `createServerDeps` breaks **17 existing call sites** across
`tests/integration/{app,composition,session-flow}.test.ts`,
`tests/integration/routes/{users,sessions}.test.ts` and
`tests/integration/services/{users,sessions}.test.ts`. Editing 17 argument lists is both
tedious and the kind of change that gets half-done, so add one helper instead.

Create `apps/server/tests/support/serverDeps.ts`:

```ts
import type { Db } from '../../src/db/client';
import { createServerDeps, type AppDeps } from '../../src/composition';
import type { Logger } from '../../src/logger';

/**
 * Production's assembly with test-shaped I/O. Exists so a change to
 * createServerDeps's signature touches one file rather than every integration
 * test — the same reason ADR 0001 grants tests/support/ its composition-root
 * carve-out.
 *
 * `geminiBaseUrl` defaults to an unroutable namespace: a test that has not
 * registered a MockServer expectation should fail loudly rather than reach a
 * real provider. Tests that translate pass their own namespace URL.
 */
export function createTestServerDeps(io: {
  db: Db;
  logger: Logger;
  rng: () => number;
  geminiBaseUrl?: string;
}): AppDeps {
  return createServerDeps({
    db: io.db,
    logger: io.logger,
    rng: io.rng,
    fetch: globalThis.fetch,
    gemini: {
      apiKey: 'test-key',
      baseUrl: io.geminiBaseUrl ?? 'http://127.0.0.1:9/never-registered',
      model: 'test-model',
    },
  });
}
```

`geminiBaseUrl` is optional here and that is allowed: ADR 0002 R5 bans optional
*collaborator* parameters in `apps/server/src` and `apps/mobile/src`, and `tests/support/`
is outside both scanned trees. It is a string, not a collaborator.

Then in each of the seven files listed above, change the import and the call:

```ts
// was: import { createServerDeps } from '../../../src/composition';
import { createTestServerDeps } from '../../support/serverDeps';

// was: createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })
```

`composition.test.ts` keeps **one** direct `createServerDeps` call, so the real signature
stays covered rather than only the helper's. Adjust the relative import depth per file
(`../../support/` from `tests/integration/**`, `../support/` from `tests/integration/*`).

- [ ] **Step 7: Run the whole suite and the type check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run db:up
npm test -w apps/server && npm run test:integration -w apps/server && npm run typecheck -w apps/server
```

Expected: PASS throughout. Two things to watch:

- `index.test.ts` must still pass — importing the module performs no I/O (ADR 0002 R7).
  `loadGeminiConfig` runs inside `main()`; if it was placed at module scope this test fails.
- If any integration file still calls `createServerDeps` with three arguments, `tsc` reports
  a missing-property error naming `fetch` — that file was missed in Step 6.

- [ ] **Step 8: Report a missing key in the worktree setup script**

In `scripts/setup-worktree.sh`, alongside the existing `.env.local` reporting, add:

```bash
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "note: GEMINI_API_KEY is not set — 'npm run server' will refuse to start."
  echo "      For local work, point GEMINI_BASE_URL at MockServer and use any dummy key:"
  echo "        export GEMINI_BASE_URL=http://localhost:1080/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev"
fi
```

- [ ] **Step 9: Document the variables**

In `README.md`, add to the environment/configuration section:

```markdown
| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | none — the server refuses to start | Never logged. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Pointed at a MockServer namespace by every test bucket. |
| `GEMINI_MODEL` | none — the server refuses to start | A current Gemini Flash model id. |

`npm run db:migrate` needs none of these: migrations read `loadConfig` only.
```

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/config.test.ts \
  apps/server/src/composition.ts apps/server/src/index.ts \
  apps/server/tests/support/serverDeps.ts apps/server/tests/integration/ \
  scripts/setup-worktree.sh README.md
git commit -m "feat(server): wire the Gemini client through composition"
```

---

### Task 7: `routes/translations.ts` and the mounted endpoint

**Files:**
- Create: `apps/server/src/routes/translations.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/openapi.test.ts`
- Test: `apps/server/tests/integration/routes/translations.test.ts`

**Interfaces:**
- Consumes: `TranslationService` (Task 5); `TranslationRequestSchema`, `TranslationResponseSchema`, `ErrorSchema` (Task 1); `LlmUnavailable`, `TranslationUnreadable` (Task 4); `createTestServerDeps` (Task 6); the MockServer helper (Task 2).
- Produces: `createTranslationsRouter(translations: TranslationService)`, mounted so the path is `POST /api/translations`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/integration/routes/translations.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createTranslationsRouter } from '../../../src/routes/translations';
import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  expectGeminiDelayedJson,
  expectGeminiJson,
  expectGeminiRawBody,
  expectGeminiStatus,
  geminiBaseUrlFor,
  mockNamespace,
  verifyGeminiHeader,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('routes-translations');
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

// Production's assembly with a per-test database and this test's own MockServer
// namespace. Nothing is injected into the server: the real Gemini client makes
// a real HTTP request over a real socket, and only the base URL differs from
// production.
function buildTestApp() {
  const deps = createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    geminiBaseUrl: geminiBaseUrlFor(ns),
  });
  const app = new Hono();
  app.route('/api', createTranslationsRouter(deps.translations));
  return app;
}

function translate(body: unknown) {
  return buildTestApp().request('/api/translations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/translations', () => {
  it('returns ranked senses for a word', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      senses: [
        {
          translation: 'ספר',
          part_of_speech: 'noun',
          example: { source: 'I read a book.', target: 'קראתי ספר.' },
        },
        { translation: 'להזמין', part_of_speech: 'verb' },
      ],
    });

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: 'book',
      direction: 'en_he',
      kind: 'word',
      senses: [
        {
          translation: 'ספר',
          part_of_speech: 'noun',
          example: { source: 'I read a book.', target: 'קראתי ספר.' },
        },
        { translation: 'להזמין', part_of_speech: 'verb' },
      ],
    });
  });

  it('detects Hebrew input without being told', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [{ translation: 'fork' }] });

    const res = await translate({ text: 'מזלג' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ direction: 'he_en' });
  });

  it('honours an explicit direction', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [{ translation: 'x' }] });

    const res = await translate({ text: 'book', direction: 'he_en' });

    expect(await res.json()).toMatchObject({ direction: 'he_en' });
  });

  it('reduces a sentence to one bare sense', async () => {
    await expectGeminiJson(ns, {
      kind: 'sentence',
      senses: [
        { translation: 'קראתי ספר.', part_of_speech: 'verb', example: { source: 'a', target: 'b' } },
      ],
    });

    const res = await translate({ text: 'I read a book' });

    expect(await res.json()).toMatchObject({
      kind: 'sentence',
      senses: [{ translation: 'קראתי ספר.' }],
    });
  });

  it('returns 200 with an empty sense list for gibberish', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [] });

    const res = await translate({ text: 'asdkjhasd' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ senses: [] });
  });

  it('sends the API key as a header', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [] });

    await translate({ text: 'book' });

    // The unit test asserts this against a fake fetch; this asserts the real
    // client actually put it on the wire.
    await expect(verifyGeminiHeader(ns, 'x-goog-api-key', 'test-key')).resolves.toBe(true);
  });

  it('rejects empty, blank and over-long text with the contract error body', async () => {
    for (const text of ['', '   ', 'a'.repeat(101)]) {
      const res = await translate({ text });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    }
  });

  it('rejects an unknown direction', async () => {
    const res = await translate({ text: 'book', direction: 'fr_he' });
    expect(res.status).toBe(400);
  });

  it('returns 502 when the provider fails', async () => {
    await expectGeminiStatus(ns, 500);

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'translation unavailable' });
  });

  it('returns 502 when the provider rate-limits', async () => {
    await expectGeminiStatus(ns, 429);
    expect((await translate({ text: 'book' })).status).toBe(502);
  });

  it('returns 502 when the model answers with unreadable output', async () => {
    await expectGeminiRawBody(
      ns,
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] } }],
      }),
    );

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'translation unavailable' });
  });

  it('returns 200 with no senses when the model is safety-blocked', async () => {
    await expectGeminiRawBody(ns, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ senses: [] });
  });

  it('gives up on a provider that exceeds the timeout budget', async () => {
    // The client's budget is 10s; 11s is past it. Jest's testTimeout is 30s.
    await expectGeminiDelayedJson(ns, { kind: 'word', senses: [], delayMs: 11_000 });

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(502);
  }, 25_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run db:up
npm run test:integration -w apps/server -- routes/translations
```

Expected: FAIL — `Cannot find module '../../../src/routes/translations'`.

- [ ] **Step 3: Write the route**

Create `apps/server/src/routes/translations.ts`:

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  TranslationRequestSchema,
  TranslationResponseSchema,
} from '@lang-tutor/core/api/schemas';

import { LlmUnavailable, TranslationUnreadable } from '../errors';
import type { TranslationService } from '../services/translations';

const translateRoute = createRoute({
  method: 'post',
  path: '/translations',
  tags: ['translations'],
  summary: 'Translate a word, phrase or sentence',
  description:
    'Returns every sense in one response, ranked with the most common first, so a client ' +
    'can reveal the rest without a second request. An input that is not a word or ' +
    'expression yields 200 with an empty `senses` array — that is an answer, not a failure. ' +
    'NOTE: this endpoint calls a paid third-party model on every request and there is no ' +
    'rate limit in front of it.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: TranslationRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: TranslationResponseSchema } },
      description:
        'The translation. `direction` is what the server detected, or the override that was ' +
        'sent; `kind` describes the input. A `sentence` carries exactly one sense, with no ' +
        'part of speech and no example.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate.',
    },
    502: {
      content: { 'application/json': { schema: ErrorSchema } },
      description:
        'The language model could not be reached, refused the request, ran out of time, or ' +
        'answered with something that did not match the expected shape.',
    },
  },
});

// Transport only: parse, validate, map an outcome to a status code. Mounted at
// /api, so this publishes as /api/translations.
export function createTranslationsRouter(translations: TranslationService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload; the
  // contract says { error: 'invalid request' } (ADR 0003 R7).
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(translateRoute, async (c) => {
    const input = c.req.valid('json');
    try {
      return c.json(await translations.translate(input), 200);
    } catch (error) {
      // Two errors, one status: the learner can do nothing different about
      // either. Which one it was lives in the log, where the operator needs it.
      if (error instanceof LlmUnavailable || error instanceof TranslationUnreadable) {
        return c.json({ error: 'translation unavailable' }, 502);
      }
      throw error; // app.ts's onError turns anything else into a 500
    }
  });

  return router;
}
```

- [ ] **Step 4: Mount it**

In `apps/server/src/app.ts`, add the import and the mount beside the existing routers:

```ts
import { createTranslationsRouter } from './routes/translations';
```

```ts
  app.route('/api', createUsersRouter(deps.users));
  app.route('/api', createTranslationsRouter(deps.translations));
  app.route('/api/sessions', createSessionsRouter(deps.sessions));
```

- [ ] **Step 5: Extend the published-document test**

Append to `apps/server/src/openapi.test.ts`, inside the existing describe block, matching
the style already there:

```ts
  it('publishes the translation endpoint with all three statuses', () => {
    const path = doc.paths['/api/translations']?.post;
    expect(path).toBeDefined();
    expect(Object.keys(path.responses).sort()).toEqual(['200', '400', '502']);
  });

  it('declares the error body it actually returns for a translation failure', () => {
    const responses = doc.paths['/api/translations'].post.responses;
    for (const status of ['400', '502']) {
      const schema = responses[status].content['application/json'].schema;
      expect(schema.properties).toHaveProperty('error');
    }
  });

  it('warns in the published description that the endpoint costs money', () => {
    expect(doc.paths['/api/translations'].post.description).toMatch(/rate limit/i);
  });
```

If the local variable holding the generated document is not called `doc`, use whatever the
surrounding tests use — read the file's top before writing this.

- [ ] **Step 6: Run everything and make sure it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server && npm run test:integration -w apps/server && npm run typecheck -w apps/server
```

Expected: PASS. The timeout test takes ~11s on its own; the whole integration bucket
should still finish well inside Jest's 30s per-test ceiling.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/translations.ts apps/server/src/app.ts \
  apps/server/src/openapi.test.ts apps/server/tests/integration/routes/translations.test.ts
git commit -m "feat(server): add POST /api/translations"
```

---

### Task 8: ADR 0001 — R10, R11, the amended R8, and checks proven to fail

The server side is complete, so the new rules can be written against real code.

**Files:**
- Modify: `docs/adr/adr-0001-layered-architecture.md`
- Modify: `scripts/check-adr-0001-layered-architecture.sh`
- Modify: `scripts/check-adrs.sh`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `providers/gemini.ts` (Task 4), `services/llm.ts` (Task 4), `services/translations.ts` (Task 5).
- Produces: two enforced rules, and the planted-violation discipline recorded where a reader will find it.

**Read before starting:** the `## Rules`, `## Rules that are not import rules` and
`## How to detect a violation` sections of `docs/adr/adr-0001-layered-architecture.md`. The
script mirrors that block **verbatim**, and the two must stay in sync — that is stated in
the ADR itself.

- [ ] **Step 1: Add R10 and R11 to the rule table**

Append two rows to the `## Rules` table in `docs/adr/adr-0001-layered-architecture.md`.
Appended, not renumbered: R1–R9 are cited by the check script, the README and three earlier
specs.

```markdown
| R10 | `providers/` | `fetch`, its own transport types, `errors`, `logger` | `routes/`, `services/`, `domain/`, `repo/`, `db/`, `app.ts`, `composition.ts` |
| R11 | `providers/` | — | **anything, from anywhere but `composition.ts`** — every consumer depends on a contract type declared in `services/` (`LlmClient` is the first), and only the composition root knows which provider satisfies it |
```

Add `providers/` to the layer diagram in `## Decision`, beside `repo/`:

```
  domain/           domain      repo/ + db/      providers/
  packages/core                 Drizzle, SQL     outbound HTTP
  pure functions, no I/O                         one importer: composition.ts
```

- [ ] **Step 2: Amend R8 and add the new non-import rule**

In `## Rules that are not import rules`, change R8's opening clause from "Each use case is
exactly one `transaction(...)` call" to:

```markdown
- **R8 — A use case *that touches the database* is exactly one `transaction(...)` call;
  `db/transaction.ts` owns the mechanism.**
```

Then, after R9, add:

```markdown
- **R12 — A provider maps every failure of its own into `errors.ts`.** A provider-specific
  error shape must not escape the layer: `services/` and `routes/` handle `LlmUnavailable`
  and `TranslationUnreadable`, never a Gemini status object. Not greppable — the *absence*
  of a leaked type is invisible to a regex — so this is enforced by review, alongside R6
  and R9.
```

Also add a sentence to R8's body explaining the amendment, so the change reads as a
decision:

```markdown
  The qualifier matters as of phase 9: `services/translations.ts` is a use case with
  **zero** transactions, because it touches no table. R8's detection command greps for
  *excess* `.transaction(` call sites, so nothing would have flagged the mismatch and this
  prose would have quietly stopped describing the code.
```

- [ ] **Step 3: Add the two commands to the ADR's detection block**

In `## How to detect a violation`, after R7's command, add:

```bash
# R10 — providers must not reach upward
grep -rnE "from '\.\./(routes|services|domain|repo|db)/|from '\.\./(app|composition)'" \
  apps/server/src/providers/

# R11 — providers are constructed only at the composition root
grep -rnE "(from|require\(|import\()[[:space:]]*'[^']*providers/" \
  apps/server/src apps/server/tests --include='*.ts' --exclude-dir=providers \
  | grep -vE "^[^:]*(composition\.ts|tests/support/|tests/eval/)"
```

Update the section's opening sentence from "all fifteen checks below" to "all seventeen
checks below".

**Three things about the R11 command are deliberate and must not be "simplified":**

```markdown
- The directory is skipped with `--exclude-dir`, **not** with `grep -v '/providers/'`.
  A content filter would match every violation's own import path and delete exactly the
  lines the check is hunting, leaving a command that can never report anything. Every
  remaining `-v` filter is anchored to the path with `^[^:]*` for the same reason.
- It matches `require(` and `import(` as well as `from`, so a dynamic import cannot launder
  the dependency, and it scans `apps/server/tests` so an integration test cannot construct
  a provider directly and be black-box in name only. `tests/support/` is exempt as the test
  composition root; there is no blanket `*.test.ts` exemption, because a service's unit test
  has a fake `LlmClient` and no reason to import a provider.
- `tests/eval/` is exempt for the same reason `tests/support/` is: it is a second test
  composition root, and naming `createGeminiClient` is its entire purpose — it is the only
  code here that calls the real provider.
```

- [ ] **Step 4: Add the checks to the script**

In `scripts/check-adr-0001-layered-architecture.sh`, follow the existing `check`/`ok`
reporting helper the file already uses for the other fifteen rules, and add:

```bash
check "R10" "providers must not reach upward" \
  "grep -rnE \"from '\\.\\./(routes|services|domain|repo|db)/|from '\\.\\./(app|composition)'\" apps/server/src/providers/"

check "R11" "providers are constructed only at the composition root" \
  "grep -rnE \"(from|require\\(|import\\()[[:space:]]*'[^']*providers/\" apps/server/src apps/server/tests --include='*.ts' --exclude-dir=providers | grep -vE \"^[^:]*(composition\\.ts|tests/support/|tests/eval/)\""
```

Read the script's existing helper first and match its exact calling convention — the two
lines above show the commands, not necessarily the argument order that file uses.

- [ ] **Step 5: Prove both checks fail on a planted violation**

**This step is not optional and not a formality.** An earlier draft of R11 shipped in a form
that could never report anything and passed a "run it, it prints nothing" review, because a
vacuous check and a satisfied one are indistinguishable that way.

```bash
cd /Users/vperepelitsky/git/vic-prp/lang-tutor-init

# R10: a provider reaching upward
printf "%s\n" "import type { LlmClient } from '../services/llm';" > apps/server/src/providers/__probe.ts
bash scripts/check-adr-0001-layered-architecture.sh; echo "exit=$?  (expect non-zero, R10 reported)"
rm apps/server/src/providers/__probe.ts

# R11: a service importing a provider
printf "%s\n" "import { createGeminiClient } from '../providers/gemini';" > apps/server/src/services/__probe.ts
bash scripts/check-adr-0001-layered-architecture.sh; echo "exit=$?  (expect non-zero, R11 reported)"
rm apps/server/src/services/__probe.ts

# R11 again, via a dynamic import from a test — the laundering route
printf "%s\n" "const p = await import('../../src/providers/gemini');" > apps/server/tests/integration/__probe.ts
bash scripts/check-adr-0001-layered-architecture.sh; echo "exit=$?  (expect non-zero, R11 reported)"
rm apps/server/tests/integration/__probe.ts

# and clean: no probes left
bash scripts/check-adrs.sh; echo "exit=$?  (expect 0)"
git status --short   # must be empty of __probe files
```

Expected: the first three runs report a violation and exit non-zero; the last exits 0. **If
any planted violation is not reported, the check is inert — fix the command, not the
probe.**

- [ ] **Step 6: Record the discipline where it belongs**

In `scripts/check-adrs.sh`, add to the header comment block, after the discovery-convention
paragraph:

```bash
# Every check added here must be shown to FAIL on a deliberately planted
# violation before it is trusted. A check that can never fire prints nothing,
# which is indistinguishable from a check that passes — one shipped that way
# once, excluding its target directory with `grep -v '/providers/'`, which
# matched every violation's own import path and deleted the lines it was
# hunting. Plant a violation, confirm it is reported, remove it.
```

In `CLAUDE.md`, under the architecture-decisions section, add:

```markdown
When adding a check to any `scripts/check-adr-*.sh`, plant a violation of the rule first
and confirm the script reports it. A check that cannot fire prints nothing, exactly like a
check that passes, so "it printed nothing" is not evidence on its own.
```

- [ ] **Step 7: Add the two new factories to ADR 0002's R6 list**

R6 requires a factory's type to be `ReturnType<typeof createX>` rather than hand-written,
and keeps a list short enough to spot-check in review. Two factories joined the repo in this
phase, so the list is now wrong by omission.

In `docs/adr/adr-0002-di-with-closures.md`, R6's parenthesised list gains
`createGeminiClient` and `createTranslationService`:

```markdown
  (`createDb`, `createConsoleLogger`, `createSessionRepo`, `createQuestionRepo`,
  `createHealthRepo`, `createUserRepo`, `createTransaction`, `createSessionService`,
  `createUserService`, `createGeminiClient`, `createTranslationService`, `createServerDeps`,
  `createApiClient`, `createRememberedUsernameStore`)
```

Note that `createGeminiClient` is the one factory on that list whose return type is **not**
annotated at its definition — R10 forbids it importing `LlmClient` — so R6's spot-check for
it happens at `composition.ts`, where the annotation lives. Add that as a parenthetical so a
future reviewer does not read the missing annotation as a violation:

```markdown
  `createGeminiClient` is annotated at its call site in `composition.ts` rather than at its
  definition, because ADR 0001 R10 forbids `providers/` from importing the contract it
  satisfies — the same arrangement as `createTransaction` and `Transaction`.
```

No detection command changes: R6 is not greppable, which is why it carries a list.

- [ ] **Step 8: Run the full architecture check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run lint:arch
```

Expected: ADR 0001 reports **seventeen** rules, no violations; the other four ADRs
unchanged and passing.

- [ ] **Step 9: Commit**

```bash
git add docs/adr/adr-0001-layered-architecture.md docs/adr/adr-0002-di-with-closures.md \
  scripts/check-adr-0001-layered-architecture.sh scripts/check-adrs.sh CLAUDE.md
git commit -m "docs: add ADR 0001 R10/R11 for providers and amend R8"
```

---

### Task 9: The mobile flow

**Files:**
- Modify: `apps/mobile/src/api/client.ts`
- Modify: `apps/mobile/src/api/client.test.ts`
- Modify: `apps/mobile/src/strings.ts`
- Modify: `apps/mobile/src/app/_layout.tsx`
- Modify: `apps/mobile/src/app/index.tsx`
- Create: `apps/mobile/src/hooks/useTranslation.tsx`
- Create: `apps/mobile/src/app/translate.tsx`

**Interfaces:**
- Consumes: `TranslationRequest`, `TranslationResponse`, `TranslationSense`, `TranslationDirection` (Task 1); `POST /api/translations` (Task 7).
- Produces: `api.translate(request: TranslationRequest): Promise<TranslationResponse>`; `TranslationProvider`, `useTranslation()`; the `/translate` route.

**On test coverage for this task:** the repo has **no React component tests** — every mobile
test today is a plain module (`client.test.ts`, `currentUser.test.ts`,
`requireEnvValue.test.ts`). Adding `@testing-library/react-native` for one screen is a
dependency and a Jest-config change this phase has not justified, so the screen and the hook
are covered by the e2e suite in Task 10, and the unit test here covers the API call only.
This is a deliberate gap, not an oversight.

- [ ] **Step 1: Write the failing client test**

Append to `apps/mobile/src/api/client.test.ts`, matching the harness the existing tests use
in that file (a fake `fetch` passed to `createApiClient`):

```ts
describe('translate', () => {
  it('posts the text to /api/translations and returns the parsed body', async () => {
    const response = {
      text: 'book',
      direction: 'en_he',
      kind: 'word',
      senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
    };
    let seenUrl = '';
    let seenBody: unknown;
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(api.translate({ text: 'book' })).resolves.toEqual(response);
    expect(seenUrl).toBe('http://api.test/api/translations');
    expect(seenBody).toEqual({ text: 'book' });
  });

  it('sends an explicit direction when one is given', async () => {
    let seenBody: unknown;
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: async (_url, init) => {
        seenBody = JSON.parse(String(init?.body));
        return new Response('{}', { status: 200 });
      },
    });

    await api.translate({ text: 'book', direction: 'he_en' });

    expect(seenBody).toEqual({ text: 'book', direction: 'he_en' });
  });

  it('raises ApiError with the status, so the screen can tell 400 from 502', async () => {
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: async () => new Response('{"error":"translation unavailable"}', { status: 502 }),
    });

    await expect(api.translate({ text: 'book' })).rejects.toMatchObject({ status: 502 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/mobile
```

Expected: FAIL — `api.translate is not a function`.

- [ ] **Step 3: Add the client call**

In `apps/mobile/src/api/client.ts`, add `TranslationRequest` and `TranslationResponse` to
the type import from `@lang-tutor/core/api`, then add to the returned object:

```ts
    translate: (request: TranslationRequest) =>
      postJson<TranslationResponse>('/api/translations', request),
```

- [ ] **Step 4: Add the Hebrew copy**

Add to `apps/mobile/src/strings.ts`, inside the `strings` object:

```ts
  translateEntry: 'תרגום מלה או ביטוי',
  translateTitle: 'תרגום',
  translatePlaceholder: 'מלה או ביטוי…',
  translateAction: 'תרגם',
  translateDirection: (direction: string) =>
    direction === 'he_en' ? 'מעברית לאנגלית' : 'מאנגלית לעברית',
  translateFlip: '⇄ החלף',
  translateTopSense: 'המשמעות הנפוצה',
  translateMore: (count: number) => `עוד משמעויות (${count})`,
  translateChoose: 'זו המשמעות שחיפשתי',
  translateChosen: 'התרגום נשמר לאוצר המילים שלך',
  translateNewWord: 'מלה חדשה',
  translateEmpty: 'לא מצאנו תרגום',
  translateUnavailable: 'התרגום לא זמין',
  translateRetry: 'נסה שוב',
  translateTooLong: 'עד 100 תווים',
  // Known parts of speech only. An unfamiliar value returns undefined and the
  // screen omits the line, so a value the model invents tomorrow degrades to a
  // missing label rather than a broken card — the same reason the wire keeps
  // this field a plain string.
  partOfSpeech: (value: string): string | undefined =>
    ({
      noun: 'שם עצם',
      verb: 'פועל',
      adjective: 'שם תואר',
      adverb: 'תואר הפועל',
      preposition: 'מלת יחס',
      pronoun: 'כינוי גוף',
      conjunction: 'מלת חיבור',
      interjection: 'מלת קריאה',
      phrase: 'ביטוי',
    })[value.toLowerCase()],
```

- [ ] **Step 5: Add the state machine**

Create `apps/mobile/src/hooks/useTranslation.tsx`:

```tsx
import type { TranslationDirection, TranslationResponse } from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { ApiError, type ApiClient } from '@/api/client';

// Mirrors the SessionProvider shape: constructed at the composition root with
// the api client passed in, so nothing here reaches for a module-level
// singleton (ADR 0002).
export type TranslationStatus = 'idle' | 'loading' | 'answered' | 'empty' | 'error';

export type TranslationValue = {
  status: TranslationStatus;
  text: string;
  setText: (value: string) => void;
  result: TranslationResponse | undefined;
  revealed: boolean;
  reveal: () => void;
  chosenIndex: number | null;
  choose: (index: number) => void;
  submit: () => void;
  flip: () => void;
  reset: () => void;
};

const TranslationContext = createContext<TranslationValue | undefined>(undefined);

export function TranslationProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [status, setStatus] = useState<TranslationStatus>('idle');
  const [text, setText] = useState('');
  const [result, setResult] = useState<TranslationResponse | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);

  const run = useCallback(
    async (query: string, direction: TranslationDirection | undefined) => {
      const trimmed = query.trim();
      if (trimmed.length === 0 || trimmed.length > 100) return;

      setStatus('loading');
      setRevealed(false);
      setChosenIndex(null);
      try {
        const response = await api.translate(
          direction ? { text: trimmed, direction } : { text: trimmed },
        );
        setResult(response);
        // An empty sense list is a successful answer about the input, not a
        // failure — a distinct state, not the error state.
        setStatus(response.senses.length === 0 ? 'empty' : 'answered');
      } catch (error) {
        // 400 cannot happen here (the field is validated before submit), so
        // every failure reads the same to the learner. ApiError carries the
        // status for a future distinction.
        void (error instanceof ApiError);
        setResult(undefined);
        setStatus('error');
      }
    },
    [api],
  );

  const value = useMemo<TranslationValue>(
    () => ({
      status,
      text,
      setText,
      result,
      revealed,
      chosenIndex,
      reveal: () => setRevealed(true),
      choose: (index: number) => setChosenIndex(index),
      submit: () => void run(text, undefined),
      // Re-requests with the opposite direction made explicit, which is what
      // makes a wrong detection recoverable rather than a dead end.
      flip: () =>
        void run(text, result?.direction === 'he_en' ? 'en_he' : 'he_en'),
      reset: () => {
        setStatus('idle');
        setText('');
        setResult(undefined);
        setRevealed(false);
        setChosenIndex(null);
      },
    }),
    [status, text, result, revealed, chosenIndex, run],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationValue {
  const value = useContext(TranslationContext);
  if (!value) throw new Error('useTranslation must be used inside a TranslationProvider');
  return value;
}
```

- [ ] **Step 6: Wire the provider and the home entry**

In `apps/mobile/src/app/_layout.tsx`, add the import and wrap inside `SessionProvider`:

```tsx
import { TranslationProvider } from '@/hooks/useTranslation';
```

```tsx
        <SessionProvider api={api}>
          <TranslationProvider api={api}>
            <View style={styles.root} {...rtlProps}>
              <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
            </View>
          </TranslationProvider>
        </SessionProvider>
```

In `apps/mobile/src/app/index.tsx`, put the entry in the space this screen already reserves —
replace the `futureSpace` View with:

```tsx
      <Pressable
        accessibilityRole="button"
        testID="translate-entry"
        onPress={() => router.push('/translate')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.translateEntry}</Text>
      </Pressable>

      {/* Deliberately empty. Streak, points and daily-target widgets land here. */}
      <View style={styles.futureSpace} />
```

and add the two styles:

```tsx
  secondaryButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    color: colors.primary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
```

- [ ] **Step 7: Write the screen**

Create `apps/mobile/src/app/translate.tsx`:

```tsx
import type { TranslationSense } from '@lang-tutor/core/api';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTranslation } from '@/hooks/useTranslation';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function TranslateScreen() {
  const t = useTranslation();
  const tooLong = t.text.trim().length > 100;
  const canSubmit = t.text.trim().length > 0 && !tooLong && t.status !== 'loading';

  // A sentence has one translation rather than competing senses, so it gets
  // neither `more` nor a save button. Withholding the save is deliberate: a
  // sentence is already known not to belong in a vocabulary, and offering to
  // save one would promise the single behaviour that is not coming.
  const isSentence = t.result?.kind === 'sentence';
  const senses = t.result?.senses ?? [];
  const visible = isSentence || t.revealed ? senses : senses.slice(0, 1);
  const hidden = senses.length - visible.length;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="translate-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text style={styles.title}>{strings.translateTitle}</Text>
      </View>

      {/* NOT forced LTR. The username field pins writingDirection because a
          username is lowercase ASCII; this field takes either script, so it
          follows its content. Forcing a direction here puts the caret on the
          wrong side for every Hebrew lookup. */}
      <TextInput
        testID="translate-input"
        style={styles.input}
        value={t.text}
        onChangeText={t.setText}
        placeholder={strings.translatePlaceholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => canSubmit && t.submit()}
      />
      {tooLong ? <Text style={styles.fieldError}>{strings.translateTooLong}</Text> : null}

      <Pressable
        accessibilityRole="button"
        testID="translate-submit"
        disabled={!canSubmit}
        onPress={t.submit}
        style={[styles.button, !canSubmit && styles.buttonDisabled]}
      >
        <Text style={styles.buttonLabel}>{strings.translateAction}</Text>
      </Pressable>

      {t.status === 'loading' ? (
        // A skeleton, not a progressive render: a structured JSON response
        // cannot be shown partially.
        <View testID="translate-loading" style={styles.skeleton}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}

      {t.status === 'error' ? (
        <View testID="translate-error" style={styles.notice}>
          <Text style={styles.noticeText}>{strings.translateUnavailable}</Text>
          <Pressable accessibilityRole="button" testID="translate-retry" onPress={t.submit}>
            <Text style={styles.link}>{strings.translateRetry}</Text>
          </Pressable>
        </View>
      ) : null}

      {t.status === 'empty' ? (
        <View testID="translate-empty" style={styles.notice}>
          <Text style={styles.noticeText}>{strings.translateEmpty}</Text>
        </View>
      ) : null}

      {t.status === 'answered' && t.result ? (
        <ScrollView contentContainerStyle={styles.results}>
          <View style={styles.directionRow}>
            <Text style={styles.directionLabel}>
              {strings.translateDirection(t.result.direction)}
            </Text>
            <Pressable accessibilityRole="button" testID="translate-flip" onPress={t.flip}>
              <Text style={styles.link}>{strings.translateFlip}</Text>
            </Pressable>
          </View>

          {visible.map((sense, index) => (
            <SenseCard
              key={`${sense.translation}-${index}`}
              sense={sense}
              isTop={index === 0 && !isSentence}
              chosen={t.chosenIndex === index}
              showChoose={!isSentence && t.chosenIndex === null}
              onChoose={() => t.choose(index)}
            />
          ))}

          {!isSentence && hidden > 0 && t.chosenIndex === null ? (
            <Pressable
              accessibilityRole="button"
              testID="translate-more"
              onPress={t.reveal}
              style={styles.moreButton}
            >
              <Text style={styles.moreLabel}>{strings.translateMore(hidden)}</Text>
            </Pressable>
          ) : null}

          {t.chosenIndex !== null ? (
            <Pressable
              accessibilityRole="button"
              testID="translate-new-word"
              onPress={t.reset}
              style={styles.moreButton}
            >
              <Text style={styles.moreLabel}>{strings.translateNewWord}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

function SenseCard({
  sense,
  isTop,
  chosen,
  showChoose,
  onChoose,
}: {
  sense: TranslationSense;
  isTop: boolean;
  chosen: boolean;
  showChoose: boolean;
  onChoose: () => void;
}) {
  const partOfSpeech = sense.part_of_speech
    ? strings.partOfSpeech(sense.part_of_speech)
    : undefined;

  return (
    <View style={[styles.card, isTop && styles.cardTop, chosen && styles.cardChosen]}>
      {isTop ? <Text style={styles.badge}>{strings.translateTopSense}</Text> : null}
      <Text style={styles.translation}>{sense.translation}</Text>
      {partOfSpeech ? <Text style={styles.partOfSpeech}>{partOfSpeech}</Text> : null}

      {sense.example ? (
        <View style={styles.example}>
          <Text style={styles.exampleSource}>{sense.example.source}</Text>
          <Text style={styles.exampleTarget}>{sense.example.target}</Text>
        </View>
      ) : null}

      {chosen ? (
        <Text testID="translate-chosen" style={styles.chosenLabel}>
          {strings.translateChosen}
        </Text>
      ) : null}

      {/* The card's own button selects it, not the card body: these cards are
          read and compared, and a tap-anywhere card turns reading into
          accidental choosing. */}
      {showChoose ? (
        <Pressable
          accessibilityRole="button"
          testID="translate-choose"
          onPress={onChoose}
          style={styles.chooseButton}
        >
          <Text style={styles.chooseLabel}>{strings.translateChoose}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    fontSize: fontSizes.md,
    color: colors.text,
  },
  fieldError: { color: colors.wrong, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: colors.onPrimary, fontSize: fontSizes.md, fontWeight: '700' },
  skeleton: {
    height: 140,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  noticeText: { color: colors.text, fontSize: fontSizes.md, writingDirection: 'rtl' },
  results: { gap: spacing.sm, paddingBottom: spacing.xl },
  directionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  directionLabel: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cardTop: { borderColor: colors.primary, borderWidth: 2 },
  cardChosen: { borderColor: colors.correct, borderWidth: 2, backgroundColor: colors.correctSurface },
  badge: { color: colors.primary, fontSize: fontSizes.sm, fontWeight: '700', writingDirection: 'rtl' },
  translation: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  partOfSpeech: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  example: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  exampleSource: { color: colors.text, fontSize: fontSizes.sm, lineHeight: lineHeights.sm },
  exampleTarget: {
    color: colors.muted,
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    writingDirection: 'rtl',
  },
  chosenLabel: {
    marginTop: spacing.sm,
    color: colors.correct,
    fontSize: fontSizes.sm,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  chooseButton: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  chooseLabel: { color: colors.onPrimary, fontSize: fontSizes.sm, fontWeight: '700' },
  moreButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  moreLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
```

- [ ] **Step 8: Run the mobile tests, the type check and the ADR checks**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/mobile && npm run typecheck -w apps/mobile && npm run lint:arch
```

Expected: PASS. `lint:arch` matters here: ADR 0002 R1's mobile grep must not find an
AsyncStorage or `expo-crypto` import outside `_layout.tsx`, and R3 must find no
module-level `export const x = createX(...)` in the new files.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/
git commit -m "feat(mobile): add the translate screen"
```

---

### Task 10: e2e

**Files:**
- Create: `e2e/tests/support/mockServer.ts`
- Create: `e2e/tests/translate.spec.ts`
- Modify: `e2e/playwright.config.ts`
- Modify: `e2e/globalSetup.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `E2E_MOCK_NAMESPACE`, `GEMINI_MOCK_BASE_URL`, and expectation helpers taking Playwright's `APIRequestContext`.

**No new `webServer` entry.** MockServer is a compose service and is already up, so
Playwright starts nothing extra — which also means there is no start-ordering question to
get wrong.

- [ ] **Step 1: Add the namespace constants and the helper**

Create `e2e/tests/support/mockServer.ts`:

```ts
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
      { content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' },
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
  payload: { kind: 'word' | 'phrase' | 'sentence'; senses: unknown[] },
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
```

- [ ] **Step 2: Add the URL constant and point the server at it**

In `e2e/urls.ts`:

```ts
/** The shared MockServer compose service, standing in for the Gemini API. */
export const MOCKSERVER_URL = 'http://localhost:1080';
```

In `e2e/playwright.config.ts`, add the imports and extend **only** the first `webServer`
entry's `env`:

```ts
import { E2E_MOCK_NAMESPACE } from './tests/support/mockServer';
import { API_URL, APP_URL, MOCKSERVER_URL } from './urls';
```

```ts
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        // Only the base URL differs from production. There is no stub mode
        // inside the server.
        GEMINI_BASE_URL: `${MOCKSERVER_URL}/${E2E_MOCK_NAMESPACE}`,
        GEMINI_API_KEY: 'e2e',
        GEMINI_MODEL: 'e2e-model',
      },
```

- [ ] **Step 3: Check reachability in globalSetup**

In `e2e/globalSetup.ts`, add to the top of the exported `globalSetup` function, before the
database work:

```ts
  // A read-only liveness GET, not `PUT /mockserver/reset`: the container is
  // shared, and a developer may have an integration run in flight against it.
  // Each spec clears only the /e2e namespace.
  const probe = await fetch(`${MOCKSERVER_URL}/liveness/probe`).catch(
    (error: unknown) => error as Error,
  );
  if (probe instanceof Error || !probe.ok) {
    throw new Error(
      `MockServer unreachable at ${MOCKSERVER_URL}\n` +
        'Run `npm run db:up` first (requires Docker).',
    );
  }
```

and import `MOCKSERVER_URL` from `./urls`.

- [ ] **Step 4: Write the spec**

Create `e2e/tests/translate.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { clearGemini, expectGemini, expectGeminiFailure } from './support/mockServer';
import { createUser } from './support/users';

const BOOK_SENSES = [
  {
    translation: 'ספר',
    part_of_speech: 'noun',
    example: { source: 'I read a book about space.', target: 'קראתי ספר על החלל.' },
  },
  {
    translation: 'להזמין',
    part_of_speech: 'verb',
    example: { source: "I'd like to book a table.", target: 'אני רוצה להזמין שולחן.' },
  },
  {
    translation: 'לרשום',
    part_of_speech: 'verb',
    example: { source: 'The referee booked him.', target: 'השופט רשם לו כרטיס.' },
  },
];

// Registers expectations through Playwright's `request` fixture, the pattern
// phase 8 established for creating a learner via POST /api/users.
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

async function openTranslate(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const username = await createUser(request);
  await page.goto('/login');
  await page.getByTestId('username-input').fill(username);
  await page.getByTestId('login-button').click();
  await page.getByTestId('translate-entry').click();
  return page;
}

test('a word shows its most common meaning, reveals the rest, and confirms a choice', async ({
  page,
  request,
}) => {
  await expectGemini(request, { kind: 'word', senses: BOOK_SENSES });
  await openTranslate(page, request);

  await page.getByTestId('translate-input').fill('book');
  await page.getByTestId('translate-submit').click();

  // The top sense only, with the other two behind `more`.
  await expect(page.getByText('ספר')).toBeVisible();
  await expect(page.getByText('להזמין')).toBeHidden();
  await expect(page.getByTestId('translate-more')).toContainText('2');

  await page.getByTestId('translate-more').click();
  await expect(page.getByText('להזמין')).toBeVisible();
  await expect(page.getByText('לרשום')).toBeVisible();

  await page.getByTestId('translate-choose').nth(1).click();
  await expect(page.getByTestId('translate-chosen')).toHaveText(
    'התרגום נשמר לאוצר המילים שלך',
  );
  await expect(page.getByTestId('translate-new-word')).toBeVisible();
});

test('a sentence gets one translation, with neither more nor a save button', async ({
  page,
  request,
}) => {
  await expectGemini(request, {
    kind: 'sentence',
    senses: [{ translation: 'אני מצפה לראות אותך.' }],
  });
  await openTranslate(page, request);

  await page.getByTestId('translate-input').fill("I'm looking forward to seeing you");
  await page.getByTestId('translate-submit').click();

  await expect(page.getByText('אני מצפה לראות אותך.')).toBeVisible();
  await expect(page.getByTestId('translate-more')).toHaveCount(0);
  await expect(page.getByTestId('translate-choose')).toHaveCount(0);
});

test('gibberish says so instead of inventing a translation', async ({ page, request }) => {
  await expectGemini(request, { kind: 'word', senses: [] });
  await openTranslate(page, request);

  await page.getByTestId('translate-input').fill('asdkjhasd');
  await page.getByTestId('translate-submit').click();

  await expect(page.getByTestId('translate-empty')).toHaveText('לא מצאנו תרגום');
});

test('a failing provider shows the error, and retry works once it recovers', async ({
  page,
  request,
}) => {
  await expectGeminiFailure(request, 500);
  await openTranslate(page, request);

  await page.getByTestId('translate-input').fill('book');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-error')).toBeVisible();

  // Replacing the expectation is what makes this a test of retry *working*
  // rather than of the error state rendering.
  await clearGemini(request);
  await expectGemini(request, { kind: 'word', senses: BOOK_SENSES });

  await page.getByTestId('translate-retry').click();
  await expect(page.getByText('ספר')).toBeVisible();
});
```

If `createUser` in `e2e/tests/support/users.ts` has a different signature or return shape,
use whatever `onboarding.spec.ts` and `session.spec.ts` already use — read them first. The
same applies to the `username-input` and `login-button` test ids.

- [ ] **Step 5: Run the suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run db:up
npm run e2e
```

Expected: all specs pass, including the untouched `session.spec.ts` and
`onboarding.spec.ts`. If the server fails to boot, check its captured stdout for
`GEMINI_MODEL is not set` — the `env` block in Step 2 is incomplete.

- [ ] **Step 6: Commit**

```bash
git add e2e/
git commit -m "test(e2e): cover the translate flow"
```

---

### Task 11: The prompt eval bucket, and ADR 0004's third bucket

**Files:**
- Create: `apps/server/tests/eval/cases.ts`
- Create: `apps/server/tests/eval/run.ts`
- Create: `.github/workflows/eval.yml`
- Modify: `apps/server/package.json`, `package.json`
- Modify: `.gitignore`
- Modify: `docs/adr/adr-0004-test-topology.md`
- Modify: `scripts/check-adr-0004-test-topology.sh`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `loadGeminiConfig` (Task 6), `createGeminiClient` (Task 4), `createTranslationService` (Task 5), `TranslationResponse` (Task 1).
- Produces: `npm run eval`; `CASES`, `type EvalCase`.

**`tests/eval/` is a second test composition root.** It names `createGeminiClient` directly,
because talking to the real provider is its entire purpose — so ADR 0001 R11's command must
exempt it alongside `tests/support/`. Task 8 Step 3 and Step 4 carry that exemption; if it is
missing, `npm run lint:arch` fails as soon as `run.ts` exists.

- [ ] **Step 1: Write the golden set**

Create `apps/server/tests/eval/cases.ts`:

```ts
import type { TranslationDirection, TranslationKind } from '@lang-tutor/core/api';

/**
 * Each case stresses one property of the prompt. `acceptTop` is a *set*, not a
 * string: a rewording must not fail a case, only a wrong meaning should.
 */
export type EvalCase = {
  label: string;
  text: string;
  direction?: TranslationDirection;
  expectKind: TranslationKind;
  /** Accepted values for the highest-ranked sense. Empty when expectEmpty. */
  acceptTop: string[];
  /** Must appear as some sense's translation, in any position. */
  expectAlso?: string[];
  /** Must appear nowhere — a literal rendering of an idiom, for instance. */
  rejectAny?: string[];
  expectEmpty?: boolean;
};

export const CASES: EvalCase[] = [
  {
    label: 'ranking: the common sense first, the rarer one still present',
    text: 'book',
    expectKind: 'word',
    acceptTop: ['ספר'],
    expectAlso: ['להזמין', 'הזמנה', 'לשריין'],
  },
  {
    label: 'ranking: a homonym with an unrelated second sense',
    text: 'bank',
    expectKind: 'word',
    acceptTop: ['בנק'],
    expectAlso: ['גדה', 'גדת הנהר', 'שפה'],
  },
  {
    label: 'senses spanning parts of speech',
    text: 'light',
    expectKind: 'word',
    acceptTop: ['אור'],
    expectAlso: ['קל', 'בהיר', 'להדליק'],
  },
  {
    label: 'an idiom translated by meaning, and classified phrase despite being imperative',
    text: 'break a leg',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה', 'שיהיה בהצלחה'],
    rejectAny: ['לשבור רגל', 'שבור רגל'],
  },
  {
    label: 'a non-imperative fixed expression',
    text: 'point of view',
    expectKind: 'phrase',
    acceptTop: ['נקודת מבט', 'השקפה'],
  },
  {
    label: 'an inflected form still resolves',
    text: 'running',
    expectKind: 'word',
    acceptTop: ['ריצה', 'לרוץ', 'רץ'],
  },
  {
    label: 'the reverse direction, and that script detection agreed',
    text: 'מזלג',
    expectKind: 'word',
    acceptTop: ['fork'],
  },
  {
    label: 'a sentence: classified as one, and exactly one sense',
    text: "I'm looking forward to seeing you",
    expectKind: 'sentence',
    acceptTop: ['אני מצפה לראות אותך', 'אני מחכה לראות אותך'],
  },
  {
    label: 'register: slang against temperature',
    text: 'cool',
    expectKind: 'word',
    acceptTop: ['מגניב', 'קריר', 'נחמד'],
    expectAlso: ['קריר', 'צונן', 'מגניב'],
  },
  {
    label: 'gibberish returns nothing rather than an invented translation',
    text: 'asdkjhasd',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
  },
];
```

- [ ] **Step 2: Write the runner**

Create `apps/server/tests/eval/run.ts`:

```ts
/**
 * Scores the real prompt against the real model. A signal, never a gate: a
 * model update can turn this red with no change to this repository, so it does
 * not run on pull requests and is not a required check.
 *
 * A standalone tsx script rather than a third Jest project, for two reasons: a
 * Jest project sits one --selectProjects mistake away from being swept into CI,
 * and pass/fail per case is the wrong output — what a prompt change needs is a
 * scorecard.
 *
 * It exercises the real artifact: the same prompt builder, parser and provider
 * production uses. Only the base URL differs from a normal run. It deliberately
 * does not go through HTTP — the object under test is the prompt, and booting a
 * server and a database would add nothing to the loop around it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TranslationResponse } from '@lang-tutor/core/api';

import { loadGeminiConfig } from '../../src/config';
import { createGeminiClient } from '../../src/providers/gemini';
import { createTranslationService } from '../../src/services/translations';
import { CASES, type EvalCase } from './cases';

const TIER2_THRESHOLD = 0.85;
const TIMEOUT_MS = 30_000;
const HEBREW = /[֐-׿]/;

type Check = { name: string; ok: boolean; detail?: string };

function tier1(kase: EvalCase, result: TranslationResponse): Check[] {
  const checks: Check[] = [];
  const senses = result.senses;

  checks.push({
    name: 'at most 5 senses',
    ok: senses.length <= 5,
    detail: `${senses.length}`,
  });

  if (kase.expectEmpty) {
    checks.push({ name: 'no senses', ok: senses.length === 0, detail: `${senses.length}` });
    return checks;
  }

  checks.push({ name: 'at least one sense', ok: senses.length >= 1 });
  if (senses.length === 0) return checks;

  if (result.direction === 'en_he') {
    checks.push({
      name: 'translation is in Hebrew script',
      ok: senses.every((sense) => HEBREW.test(sense.translation)),
    });
  }

  if (result.kind === 'sentence') {
    // The server enforces this, so a failure here means normalizeSenses broke,
    // not that the model misbehaved.
    checks.push({ name: 'a sentence has exactly one sense', ok: senses.length === 1 });
    checks.push({
      name: 'a sentence has no part_of_speech and no example',
      ok: senses.every((sense) => !sense.part_of_speech && !sense.example),
    });
  } else {
    checks.push({
      name: 'every sense has a part of speech',
      ok: senses.every((sense) => Boolean(sense.part_of_speech)),
    });
    checks.push({
      name: 'every example names the queried term or an inflection of it',
      // A stem check, not equality: "booked" and "running" must both count.
      ok: senses.every((sense) => {
        if (!sense.example) return false;
        const stem = kase.text.trim().toLowerCase().slice(0, Math.max(4, kase.text.length - 3));
        return sense.example.source.toLowerCase().includes(stem);
      }),
    });
    checks.push({
      name: 'every example carries a non-empty translation',
      ok: senses.every((sense) => Boolean(sense.example?.target?.trim())),
    });
  }

  return checks;
}

function tier2(kase: EvalCase, result: TranslationResponse): Check[] {
  const checks: Check[] = [];
  const translations = result.senses.map((sense) => sense.translation);
  const contains = (needles: string[]) =>
    needles.some((needle) => translations.some((value) => value.includes(needle)));

  checks.push({
    name: `kind is ${kase.expectKind}`,
    ok: result.kind === kase.expectKind,
    detail: result.kind,
  });

  if (kase.expectEmpty) return checks;

  checks.push({
    name: 'top sense is in the accepted set',
    ok: kase.acceptTop.some((accepted) => translations[0]?.includes(accepted)),
    detail: translations[0],
  });

  if (kase.expectAlso) {
    checks.push({
      name: 'an expected additional sense is present',
      ok: contains(kase.expectAlso),
      detail: translations.join(' | '),
    });
  }

  if (kase.rejectAny) {
    checks.push({
      name: 'no literal rendering of the idiom',
      ok: !contains(kase.rejectAny),
      detail: translations.join(' | '),
    });
  }

  return checks;
}

async function main(): Promise<void> {
  // Exits non-zero with a clear message rather than skipping quietly: a green
  // "0 cases ran" is the one outcome worse than a red suite.
  const gemini = loadGeminiConfig(process.env);
  if (gemini.baseUrl.includes('localhost') || gemini.baseUrl.includes('127.0.0.1')) {
    throw new Error(
      `GEMINI_BASE_URL points at ${gemini.baseUrl}. The eval bucket must call the real API; ` +
        'unset it to use the default.',
    );
  }

  const llm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: TIMEOUT_MS,
  });
  const service = createTranslationService({
    llm,
    logger: { info: () => {}, error: () => {} },
  });

  const rows: {
    label: string;
    text: string;
    tier1: Check[];
    tier2: Check[];
    result?: TranslationResponse;
    error?: string;
  }[] = [];

  for (const kase of CASES) {
    try {
      const result = await service.translate(
        kase.direction ? { text: kase.text, direction: kase.direction } : { text: kase.text },
      );
      rows.push({
        label: kase.label,
        text: kase.text,
        tier1: tier1(kase, result),
        tier2: tier2(kase, result),
        result,
      });
    } catch (error) {
      rows.push({
        label: kase.label,
        text: kase.text,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      });
    }
  }

  // Scorecard. Every case prints its actual output, so a drop is diagnosable
  // rather than merely red.
  let tier1Failures = 0;
  let tier2Passed = 0;
  let tier2Total = 0;

  for (const row of rows) {
    const t1Bad = row.tier1.filter((check) => !check.ok);
    const t2Bad = row.tier2.filter((check) => !check.ok);
    tier1Failures += t1Bad.length;
    tier2Passed += row.tier2.filter((check) => check.ok).length;
    tier2Total += row.tier2.length;

    const mark = t1Bad.length > 0 ? 'FAIL' : t2Bad.length > 0 ? 'warn' : 'ok  ';
    console.log(`\n[${mark}] ${row.text} — ${row.label}`);
    if (row.result) {
      console.log(
        `       kind=${row.result.kind} direction=${row.result.direction} ` +
          `senses=${row.result.senses.map((sense) => sense.translation).join(' | ') || '(none)'}`,
      );
    }
    for (const check of [...t1Bad, ...t2Bad]) {
      console.log(`       ${t1Bad.includes(check) ? 'T1' : 'T2'} ${check.name}: ${check.detail ?? ''}`);
    }
  }

  const score = tier2Total === 0 ? 0 : tier2Passed / tier2Total;
  console.log(
    `\ntier 1: ${tier1Failures} failure(s) (must be 0)\n` +
      `tier 2: ${tier2Passed}/${tier2Total} = ${(score * 100).toFixed(1)}% ` +
      `(threshold ${(TIER2_THRESHOLD * 100).toFixed(0)}%)`,
  );

  // Gitignored, so a prompt change can be diffed against the previous run
  // instead of judged from memory.
  const dir = join(__dirname, '.results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ model: gemini.model, score, rows }, null, 2));
  console.log(`report: ${file}`);

  if (tier1Failures > 0 || score < TIER2_THRESHOLD) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 3: Add the scripts and ignore the reports**

In `apps/server/package.json` scripts:

```json
    "eval": "tsx tests/eval/run.ts",
```

In the root `package.json` scripts:

```json
    "eval": "npm run eval --workspace apps/server",
```

In `.gitignore`:

```
apps/server/tests/eval/.results/
```

- [ ] **Step 4: Confirm the model id against the live API**

The design deliberately left this open: public sources disagreed across four Gemini Flash
generations, so no id was written into either document. This is where it gets settled, and
it must be settled by asking the API rather than by picking one.

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
export GEMINI_API_KEY=<a real key>
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" \
  https://generativelanguage.googleapis.com/v1beta/models \
  | grep -o '"name": *"models/[^"]*"' | sort
```

Pick the current Flash-class model that supports `generateContent` — Flash rather than Pro,
because latency *is* the experience here and this is a one-shot structured extraction, not a
reasoning task. Record the exact id in the README's environment table (Task 6 Step 9) and use
it below. **Do not hardcode it in application code**; it stays a config value.

- [ ] **Step 5: Run the evals against the real model**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
export GEMINI_API_KEY=<a real key>
export GEMINI_MODEL=<the id confirmed in Step 4>
unset GEMINI_BASE_URL
npm run eval
```

Expected: a scorecard, tier 1 with **0** failures, tier 2 at or above 85%. Ten calls,
temperature 0 — cents per run.

**If tier 1 fails, fix the prompt in `domain/translation.ts`, not the case.** A tier 1
failure means the prompt is not producing the shape the contract promises. If tier 2 sits
just below threshold on wording rather than meaning, widen that case's `acceptTop` — that is
what an accepted-answer *set* is for. Re-run after either change.

- [ ] **Step 6: Confirm it fails loudly without a key**

```bash
env -u GEMINI_API_KEY npm run eval; echo "exit=$?  (expect non-zero)"
```

Expected: a message naming `GEMINI_API_KEY`, exit non-zero. A green "0 cases ran" here would
be the worst possible outcome, which is why this step exists.

- [ ] **Step 7: Amend ADR 0004 for the third bucket**

In `docs/adr/adr-0004-test-topology.md`, extend R4's row in the `## Rules` table:

```markdown
| R4 | `apps/server/tests/` | test files under `tests/integration/`; `*.eval.ts` under `tests/eval/` | a `*.test.ts` anywhere else under `tests/` |
```

Add to `## Decision`, after the existing diagram description:

```markdown
`apps/server/tests/eval/**/*.eval.ts` is the third bucket: opt-in, run by `npm run eval`,
and the only code in the repo that calls a real language model. It is a **signal, not a
gate** — a provider's model update can turn it red with no change to this repository — so it
runs on `workflow_dispatch` and a nightly schedule, never on a pull request, and is not a
required check. The `.eval.ts` extension is what keeps R4's `find` and both Jest projects
from picking these files up; naming them `*.test.ts` would have swept them into a bucket
that must never make a network call.

`tests/eval/` is a second test composition root, alongside `tests/support/`: it names
`createGeminiClient` directly, which is why ADR 0001 R11's command exempts it.
```

Add two commands to `## How to detect a violation`:

```bash
# R4 — no Jest project may pick up an eval file
grep -n "eval" apps/server/jest.config.js

# R4 — nothing under tests/eval/ is imported by src/
grep -rn "tests/eval" apps/server/src --include='*.ts'
```

Update the section's opening from "the five commands below" to "the seven commands below".

- [ ] **Step 8: Add those two checks to the script**

In `scripts/check-adr-0004-test-topology.sh`, following the file's existing helper
convention:

```bash
check "R4" "no Jest project picks up an eval file" \
  "grep -n 'eval' apps/server/jest.config.js"

check "R4" "nothing under tests/eval/ is imported by src/" \
  "grep -rn 'tests/eval' apps/server/src --include='*.ts'"
```

- [ ] **Step 9: Prove both new checks fail on a planted violation**

```bash
cd /Users/vperepelitsky/git/vic-prp/lang-tutor-init

printf "%s\n" "// eval" >> apps/server/jest.config.js
bash scripts/check-adr-0004-test-topology.sh; echo "exit=$?  (expect non-zero)"
git checkout apps/server/jest.config.js

printf "%s\n" "import { CASES } from '../tests/eval/cases';" > apps/server/src/__probe.ts
bash scripts/check-adr-0004-test-topology.sh; echo "exit=$?  (expect non-zero)"
rm apps/server/src/__probe.ts

bash scripts/check-adrs.sh; echo "exit=$?  (expect 0)"
git status --short  # must show no probe files
```

Expected: the first two runs report a violation; the third exits 0.

- [ ] **Step 10: Add the CI workflow**

Create `.github/workflows/eval.yml`. **Read `.github/workflows/ci.yml` first** and match its
conventions for action versions, the Node setup and the install step rather than trusting the
versions below:

```yaml
# A signal, not a gate. Never on pull_request: a model update can turn this red
# with no change to this repository, and an external vendor's release schedule
# must not be able to block a merge.
name: eval

on:
  workflow_dispatch:
  schedule:
    - cron: '17 3 * * *'

jobs:
  eval:
    # Never on a fork: this job holds the only API key in the repository.
    if: github.repository_owner == 'victor-prp'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run eval
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          GEMINI_MODEL: ${{ vars.GEMINI_MODEL }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: eval-report
          path: apps/server/tests/eval/.results/
```

- [ ] **Step 11: Note the bucket in CLAUDE.md**

Add to `CLAUDE.md`:

```markdown
# Prompt evals

`apps/server/tests/eval/**/*.eval.ts` is an opt-in fourth test bucket, run by
`npm run eval`, and the only code here that calls a real language model. It is never part of
`npm run test:all` and never runs on a pull request: a model update can turn it red with no
change to this repo, so it is a signal rather than a gate. It needs `GEMINI_API_KEY` and
`GEMINI_MODEL`, and refuses to run against MockServer.
```

- [ ] **Step 12: Commit**

```bash
git add apps/server/tests/eval/ apps/server/package.json package.json .gitignore \
  .github/workflows/eval.yml docs/adr/adr-0004-test-topology.md \
  scripts/check-adr-0004-test-topology.sh CLAUDE.md
git commit -m "test: add the prompt eval bucket and record it in ADR 0004"
```

---

### Task 12: README — the phase index and the honest API warning

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Add the phase narrative and index entry**

In `README.md`, after the phase 8 paragraph:

```markdown
Phase 9 gives the learner a dictionary. Typing a word, a phrase or a sentence returns its
meanings from a language model, ranked with the most common first, each with an example
sentence in both languages; a **more** button reveals the rest and a button on each meaning
confirms the one that fits. Nothing is saved yet — this phase exists to validate the
experience, and the confirmation it shows is deliberately ahead of the storage that arrives
next. It is also the first time the server calls a third party, holds a secret, or depends
on a non-deterministic answer.
```

and to the phase list:

```markdown
- Phase 9: [design](docs/superpowers/specs/2026-09-08-lang-tutor-phase-9-translation-design.md) · [plan](docs/superpowers/plans/2026-09-08-lang-tutor-phase-9-translation.md)
```

- [ ] **Step 2: Add `providers/` to the architecture table**

```markdown
| `providers/` | `fetch`, its own transport types, `errors`, `logger` | services, routes, domain, repo, db — and nothing but `composition.ts` may import it |
```

Add a sentence to the paragraph below that table:

```markdown
Since phase 9 there is one more layer: `providers/` holds outbound third-party I/O behind a
two-line `LlmClient` contract declared in `services/`. A service depends on that contract and
never learns which provider satisfies it, so switching from Gemini to another vendor is one
new file in `providers/` and one changed line in `index.ts` — the same shape the
`Transaction` seam already gives the database.
```

- [ ] **Step 3: Make the *Reading the API* note honest**

Extend the existing note about there being no auth:

```markdown
As of phase 9 one endpoint on this open API costs money to call: `POST /api/translations`
reaches a paid third-party model on every request, with no authentication and no rate limit
in front of it. That is acceptable for a play-test on a local network and **must not** reach
a public host in this state.
```

- [ ] **Step 4: Mention MockServer in the local-setup section**

```markdown
`npm run db:up` starts two containers: Postgres, and a MockServer instance that stands in for
the Gemini API in every test bucket. Integration and e2e tests register their own expectations
against it per test, so no test needs network access or an API key.
```

- [ ] **Step 5: Verify the whole suite one last time**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run db:up && npm run lint:arch && npm run typecheck && npm run test:all && npm run e2e
```

Expected: `lint:arch` reports seventeen ADR 0001 rules and seven ADR 0004 rules with no
violations; every other suite green. `npm run eval` is deliberately **not** in this list.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: record phase 9 in the README"
```

---
