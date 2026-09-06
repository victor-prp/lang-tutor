# Phase 7: OpenAPI Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each endpoint's route definition and its published OpenAPI description the same artifact, so the documentation cannot drift from the code.

**Architecture:** The wire contract moves into `packages/core/src/api/schemas.ts` as plain Zod 4 schemas, and every type in `packages/core/src/api/types.ts` becomes `z.infer` of one of them. `apps/server` swaps `Hono` for `OpenAPIHono` from `@hono/zod-openapi`: each endpoint becomes one `createRoute` definition (routing + request validation + response typing + OpenAPI generation) plus a handler, and `createApp` mounts `/openapi.json` and a Scalar page at `/docs`. A `defaultHook` preserves today's `{ error: 'invalid request' }` validation body, which the adapter would otherwise replace.

**Tech Stack:** TypeScript 6.0, Zod 4, Hono 4.13, `@hono/zod-openapi` 1.6.3, `@scalar/hono-api-reference` 0.12.0, Jest 29, npm workspaces.

**Spec:** [docs/superpowers/specs/2026-09-05-lang-tutor-phase-7-openapi-design.md](../specs/2026-09-05-lang-tutor-phase-7-openapi-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **The HTTP contract does not change.** Same paths, same status codes, same bodies — including `{ error: 'invalid request' }` on validation failure. One deliberate exception is documented under *Known deviation* below.
- **Every pre-existing route test passes unmodified.** If a test needs editing to pass, the contract moved. Stop and report rather than editing the test.
- **`git diff --stat apps/mobile` must be empty** at the end of every task and at the end of the phase.
- **`packages/core/src/api/index.ts` contains only `export type`** — nothing else, ever.
- **Every type in `packages/core/src/api/types.ts` is a `z.infer`.** None hand-written.
- **`packages/core` must not depend on any Hono adapter.** It uses plain Zod 4 (`import { z } from 'zod'`), never the adapter's extended `z`. OpenAPI metadata is attached server-side in `createRoute`.
- **Exact dependency versions to add:** `zod@^4.4.3` (root + `packages/core`), `@hono/zod-openapi@^1.6.3` (`apps/server`), `@scalar/hono-api-reference@^0.12.0` (`apps/server`).
- **Doc route names are `/openapi.json` and `/docs`.** Not `/doc` — one character apart is a permanent footgun.
- **Doc routes are always on.** No environment gate, no configuration flag.
- **Use `doc31`, not `doc`.** Zod 4 emits JSON Schema 2020-12, which corresponds to OpenAPI 3.1.
- Run commands from the repo root unless a step says otherwise.

## Verified before this plan was written

These were executed against the real packages (`hono@4.13.5`, `zod@4.4.3` and `4.5.4`, `@hono/zod-openapi@1.6.3`, `@scalar/hono-api-reference@0.12.0`) so the executor does not have to rediscover them. The spec listed the first two as unverified risks; they are now settled.

| Question | Answer |
|---|---|
| Do **plain** Zod 4 schemas (not the adapter's `z`) generate OpenAPI? | **Yes.** `createRoute` accepts them and `doc31` renders. The spec's fallback (server-side `.openapi()` wrappers) is not needed. |
| Does `app.doc31` exist on `OpenAPIHono` 1.6.3? | **Yes**, alongside `doc` and `getOpenAPI31Document`. Emits `"openapi": "3.1.0"`. |
| Does `z.infer` of the `NextStepResponse` discriminated union match the hand-written type **exactly**? | **Yes** — mutually assignable under `strict`, on both zod 4.4.3 and 4.5.4. `z.literal(false)` infers `false`, `z.null()` infers `null`, and `if (r.complete)` still narrows. The union renders as `oneOf` in the document. |
| Does an `OpenAPIHono` router still work when mounted on a **plain** `Hono` parent (what the existing route tests do)? | **Yes** — routing, `c.req.valid('json')` and the `defaultHook` 400 all work unchanged. |
| Do doc paths get the mount prefix from `app.route('/api/sessions', router)`? | **Yes** — a router path of `/{id}/next-step` appears as `/api/sessions/{id}/next-step`. |
| Do multi-status handlers (`c.json(x, 503)`, `404`, `409`) typecheck under `.openapi()`? | **Yes**, when each status is declared in `responses`. |
| Does Scalar need the network? | **Yes.** `/docs` returns a 2.8KB HTML shell whose only script is `https://cdn.jsdelivr.net/npm/@scalar/api-reference`. See *Known deviation*. |

## Known deviation from "no contract change"

**A malformed (non-JSON) request body returns 400 instead of 500.**

Today `await c.req.json()` throws, `app.onError` catches it, and the client gets `500 {"error":"internal error"}`. Under `@hono/zod-openapi` the body is parsed before the handler runs and a malformed body returns `400 Malformed JSON in request body` as plain text.

No test covers this and the mobile client sends `JSON.stringify` output, so nothing in the repo can reach it. 400 is also the more correct answer. Recorded here so it reads as a decision rather than an oversight — do not add code to restore the 500.

**Scalar loads its client bundle from a CDN**, so `/docs` needs network access to render. `/openapi.json` is fully offline. This is confirmed behaviour, not a bug to fix; Task 5 documents it in the README.

## Preconditions and sequencing

The spec requires phases 5 and 6 to land first. Both have: `createApp(deps: AppDeps)` and `createServerDeps` are in place (phase 5), and the unit/integration split by folder is in place (phase 6). Nothing in this plan needs to establish either. Confirm with `git log --oneline -3` before starting — the tip should be at or after the phase-6 merge.

Task order is the spec's risk mitigation, not preference:

1. **Task 1 ports `NextStepResponseSchema` first**, before any route is touched. The spec names it "the schema most likely to bite" — a discriminated union whose narrowing the mobile Results screen depends on — so its type parity is pinned in the very first task, where a failure costs one file rather than a rewritten router.
2. **Task 2 converts exactly one route** (`/health`) and confirms `/openapi.json` renders before Tasks 3 and 4 touch the other two. That was the spec's fallback trigger; it is kept as a checkpoint even though the mechanism is now verified.
3. **Task 3 converts one of the two session routes and leaves the other alone.** An `OpenAPIHono` serving a mix of `.openapi()` and plain `.post()` routes was verified to work, and the document lists only the converted one — so the intermediate commit is a working server, not a broken halfway state.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/api/schemas.ts` | Every wire schema, plain Zod 4. The single source of truth. | **new** |
| `packages/core/src/api/types.ts` | Every wire type, each one a `z.infer` of a schema in `schemas.ts`. | rewritten |
| `packages/core/src/api/schemas.test.ts` | Runtime parse behaviour + a compile-time pin on the `NextStepResponse` shape. | **new** |
| `packages/core/src/api/index.ts` | Type-only barrel. Gains `ErrorResponse` and `HealthResponse`. | one line each |
| `packages/core/package.json` | Adds the `zod` dependency and the `./api/schemas` export. | modified |
| `package.json` (root) | Adds `zod` so a **single** copy hoists to the root and both workspaces share one module instance. | modified |
| `apps/server/src/app.ts` | `createApp` returns an `OpenAPIHono`; `/health` becomes a `createRoute`; mounts `/openapi.json` and `/docs`. | rewritten |
| `apps/server/src/routes/sessions.ts` | Two `createRoute` definitions plus handlers; owns the `defaultHook`. | rewritten |
| `apps/server/src/routes/schemas.ts` | — | **deleted** (Task 4) |
| `apps/server/src/openapi.test.ts` | Unit test: the published document contains all three paths with their declared responses. | **new** |
| `apps/server/src/app.test.ts` | Gains `/openapi.json` and `/docs` smoke tests. | modified |
| `apps/server/tests/integration/routes/sessions.test.ts` | The 400 **body** assertion. Existing tests untouched. | one test added |
| `apps/server/package.json` | Adds the two runtime dependencies. | modified |
| `README.md` | Core is no longer dependency-free; documents the doc routes and the CDN caveat. | modified |

### Why the root `package.json` gains `zod`

This is not cosmetic and skipping it will cost hours. `@expo/cli` depends on `zod@^3.25.76`, which npm has hoisted to `node_modules/zod`. `apps/server` therefore keeps a **nested** `apps/server/node_modules/zod@4.4.3`.

Adding `zod` only to `packages/core` was tried against the real lockfile: npm produces `packages/core/node_modules/zod@4.5.4` next to `apps/server/node_modules/zod@4.4.3` — two different versions, two module instances. Pinning both to the exact same version does **not** help; npm still writes two physical copies, because the root slot is occupied by 3.x. Core would then build schemas with one Zod while the adapter validates them with another.

Declaring `zod` at the workspace root makes npm hoist **4.x** to `node_modules/zod`, nest `3.25.76` under `node_modules/@expo/cli/node_modules/zod` where Expo still resolves it, and leave `apps/server` and `packages/core` sharing the single root copy. Verified against this repo's lockfile.

---

### Task 1: The wire contract becomes Zod schemas in `packages/core`

Nothing in `apps/server` changes in this task. It ends with core owning every wire schema and every wire type inferred from one, the whole repo still typechecking, and both apps still passing.

**Files:**
- Modify: `package.json` (root — add `zod` to control hoisting)
- Modify: `packages/core/package.json` (add `zod`, add the `./api/schemas` export)
- Create: `packages/core/src/api/schemas.ts`
- Create: `packages/core/src/api/schemas.test.ts`
- Modify: `packages/core/src/api/types.ts` (fully rewritten)
- Modify: `packages/core/src/api/index.ts` (two names added)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, from `@lang-tutor/core/api/schemas` (values):
  `MultipleChoiceQuestionSchema`, `QuestionSchema`, `AnswerRecordSchema`, `ScoreSchema`,
  `MissedQuestionSchema`, `PositionSchema`, `CreateSessionRequestSchema`,
  `CreateSessionResponseSchema`, `NextStepRequestSchema`, `NextStepResponseSchema`,
  `ErrorSchema`, `HealthResponseSchema` — all `z.ZodType` values from plain Zod 4.
- Produces, from `@lang-tutor/core/api` (types only, unchanged names plus two):
  `MultipleChoiceQuestion`, `Question`, `AnswerRecord`, `Score`, `MissedQuestion`,
  `Position`, `CreateSessionRequest`, `CreateSessionResponse`, `NextStepRequest`,
  `NextStepResponse`, **`ErrorResponse`**, **`HealthResponse`**.

`ErrorSchema` and `HealthResponseSchema` are unused at the end of this task. Tasks 2-4 consume them; core is the one home for the wire contract, so they are defined here rather than dribbled in later.

- [ ] **Step 1: Add `zod` at the root so a single copy hoists**

Root `package.json` has no `dependencies` block today. Add one **after** `"workspaces"` and before `"scripts"`:

```json
  "dependencies": {
    "zod": "^4.4.3"
  },
```

`dependencies` rather than `devDependencies`: this backs a runtime dependency of two workspaces, and would have to survive an `--omit=dev` install if one is ever added. See *Why the root `package.json` gains `zod`* above for why the root entry exists at all.

- [ ] **Step 2: Add `zod` and the new entry point to `packages/core/package.json`**

Add a `dependencies` block after `"exports"`, and add the `./api/schemas` line to `exports`:

```json
  "exports": {
    ".": "./src/index.ts",
    "./api": "./src/api/index.ts",
    "./api/schemas": "./src/api/schemas.ts",
    "./domain": "./src/domain/index.ts"
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
```

The separate `./api/schemas` entry is the point: `./api` stays purely type-only, so a mobile import that forgets the `type` keyword fails loudly instead of quietly pulling Zod into the app bundle.

- [ ] **Step 3: Install and prove there is exactly one Zod instance**

```bash
npm install
node -e "
const path = require('path');
const server = require.resolve('zod', { paths: [path.resolve('apps/server/src')] });
const core = require.resolve('zod', { paths: [path.resolve('packages/core/src')] });
console.log('server ->', server);
console.log('core   ->', core);
if (server !== core) { console.error('FAIL: two zod module instances'); process.exit(1); }
console.log('OK: one instance, version', require(path.join(path.dirname(server), 'package.json')).version);
"
```

Expected: both paths are `<repo>/node_modules/zod/index.cjs` and the script prints `OK: one instance, version 4.x`.

If it prints FAIL, **stop and report** — do not proceed with two instances. The recovery is to check that the root `dependencies` edit in Step 1 actually landed, then `rm -rf node_modules package-lock.json && npm install`.

- [ ] **Step 4: Write the failing test**

Create `packages/core/src/api/schemas.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import {
  CreateSessionRequestSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
} from './schemas';
import type { MissedQuestion, NextStepResponse, Position, Question, Score } from './types';

const QUESTION: Question = {
  id: 'q1',
  type: 'multiple_choice',
  vocab_term_id: 'v1',
  question: 'dog',
  options: ['כלב', 'חתול', 'סוס', 'דג'],
  correct_option: 0,
};

// The two request schemas moved here from apps/server/src/routes/schemas.ts.
// These assertions are that move's proof: the validation rules came across
// unchanged, so the 400s the server returns today are the 400s it returns after.
describe('CreateSessionRequestSchema', () => {
  it('accepts a non-empty user_id', () => {
    expect(CreateSessionRequestSchema.safeParse({ user_id: 'u1' }).success).toBe(true);
  });

  it('rejects a missing user_id', () => {
    expect(CreateSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty user_id', () => {
    expect(CreateSessionRequestSchema.safeParse({ user_id: '' }).success).toBe(false);
  });
});

describe('NextStepRequestSchema', () => {
  const valid = { user_id: 'u1', question_id: 'q1', option_index: 0 };

  it('accepts a well-formed step', () => {
    expect(NextStepRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a missing question_id', () => {
    expect(NextStepRequestSchema.safeParse({ user_id: 'u1', option_index: 0 }).success).toBe(false);
  });

  it('rejects a negative option_index', () => {
    expect(NextStepRequestSchema.safeParse({ ...valid, option_index: -1 }).success).toBe(false);
  });

  it('rejects a fractional option_index', () => {
    expect(NextStepRequestSchema.safeParse({ ...valid, option_index: 1.5 }).success).toBe(false);
  });
});

// The response schema the spec flags as most likely to bite: a discriminated
// union whose narrowing the mobile Results screen depends on.
describe('NextStepResponseSchema', () => {
  const position: Position = { position: 3, total: 10 };

  it('parses an in-progress step', () => {
    const parsed = NextStepResponseSchema.safeParse({
      session_id: 's1',
      question: QUESTION,
      position,
      complete: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a completed step and narrows on `complete`', () => {
    const value: NextStepResponse = NextStepResponseSchema.parse({
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      score: { correct: 9, total: 10 },
      missed_questions: [{ question: QUESTION, correct_answer: 'כלב' }],
    });

    // Both the runtime assertion and the narrowing below are the test: if the
    // inferred union stops narrowing on `complete`, this file stops compiling
    // and `npm run typecheck` fails.
    if (!value.complete) throw new Error('expected a completed step');
    const score: Score = value.score;
    const missed: MissedQuestion[] = value.missed_questions;
    expect(score).toEqual({ correct: 9, total: 10 });
    expect(missed[0].correct_answer).toBe('כלב');
    expect(value.question).toBeNull();
  });

  it('rejects a completed step that omits score', () => {
    const parsed = NextStepResponseSchema.safeParse({
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      missed_questions: [],
    });
    expect(parsed.success).toBe(false);
  });
});

// A compile-time pin, erased at runtime. `complete: false` widening to
// `boolean`, or `score` becoming optional, are the realistic ways an inferred
// type drifts from what apps/mobile expects — and both would fail here during
// `npm run typecheck` rather than in a mobile screen months later.
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

const nextStepShapeIsPinned: Exact<
  NextStepResponse,
  | { session_id: string; question: Question; position: Position; complete: false }
  | {
      session_id: string;
      question: null;
      position: Position;
      complete: true;
      score: Score;
      missed_questions: MissedQuestion[];
    }
> = true;
void nextStepShapeIsPinned;
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
npm test --workspace packages/core
```

Expected: FAIL — `Cannot find module './schemas' from 'src/api/schemas.test.ts'`.

- [ ] **Step 6: Write `packages/core/src/api/schemas.ts`**

```ts
import { z } from 'zod';

// The wire contract, defined once. `apps/server` attaches OpenAPI metadata to
// these in createRoute; `apps/mobile` never sees this file, only the types
// inferred from it in ./types. Plain Zod 4 on purpose: core must not depend on
// a Hono adapter, and Zod 4's native JSON Schema output is what lets the
// adapter document these without one.
export const MultipleChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('multiple_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// A tagged union with one member today. The `type` field exists from day one so
// consumers switch on it; adding a question type is then additive.
export const QuestionSchema = MultipleChoiceQuestionSchema;

// Scoring reads `is_correct` and nothing else, so any future question type
// satisfies it. `answer_string` is the audit-log field: text rather than an
// option index, because option order is shuffled per session.
export const AnswerRecordSchema = z.object({
  question_id: z.string(),
  is_correct: z.boolean(),
  answer_string: z.string(),
});

export const ScoreSchema = z.object({
  correct: z.number().int(),
  total: z.number().int(),
});

export const MissedQuestionSchema = z.object({
  question: QuestionSchema,
  correct_answer: z.string(),
});

export const PositionSchema = z.object({
  position: z.number().int(),
  total: z.number().int(),
});

export const CreateSessionRequestSchema = z.object({
  user_id: z.string().min(1),
});

export const CreateSessionResponseSchema = z.object({
  session_id: z.string(),
  question: QuestionSchema,
  position: PositionSchema,
});

export const NextStepRequestSchema = z.object({
  user_id: z.string().min(1),
  question_id: z.string().min(1),
  option_index: z.number().int().nonnegative(),
});

// A discriminated union on `complete`: when true, the caller has everything
// the Results screen needs (score, missed_questions) in this same response —
// there is no separate results call.
export const NextStepResponseSchema = z.discriminatedUnion('complete', [
  z.object({
    session_id: z.string(),
    question: QuestionSchema,
    position: PositionSchema,
    complete: z.literal(false),
  }),
  z.object({
    session_id: z.string(),
    question: z.null(),
    position: PositionSchema,
    complete: z.literal(true),
    score: ScoreSchema,
    missed_questions: z.array(MissedQuestionSchema),
  }),
]);

// The failure body every endpoint can return. Until this phase this shape lived
// only inside handler code; declaring it here is what lets each route publish
// its failures instead of documenting a happy path.
export const ErrorSchema = z.object({
  error: z.string(),
});

// /health is part of the wire contract too: the e2e suite waits on it, and a
// 503 there is what distinguishes "server booting" from "broken".
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
});
```

- [ ] **Step 7: Rewrite `packages/core/src/api/types.ts`**

Replace the whole file:

```ts
import type { z } from 'zod';

import type {
  AnswerRecordSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorSchema,
  HealthResponseSchema,
  MissedQuestionSchema,
  MultipleChoiceQuestionSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
  PositionSchema,
  QuestionSchema,
  ScoreSchema,
} from './schemas';

// Every type here is inferred. The alternative — schemas on the server and
// hand-written types here — is two definitions of one contract, free to drift.
// Removing that freedom is the whole point of this phase, so a hand-written
// type in this file is a bug, not a shortcut. Prose about *why* each shape is
// the way it is lives next to its schema in ./schemas.
//
// The `import type` above matters: it keeps this module free of any runtime
// import of Zod, which is what lets ./index.ts stay a pure type barrel.

export type MultipleChoiceQuestion = z.infer<typeof MultipleChoiceQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type MissedQuestion = z.infer<typeof MissedQuestionSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type NextStepRequest = z.infer<typeof NextStepRequestSchema>;
export type NextStepResponse = z.infer<typeof NextStepResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

- [ ] **Step 8: Add the two new names to `packages/core/src/api/index.ts`**

Keep it alphabetical and keep it `export type` — nothing but `export type` may ever appear in this file:

```ts
export type {
  AnswerRecord,
  CreateSessionRequest,
  CreateSessionResponse,
  ErrorResponse,
  HealthResponse,
  MissedQuestion,
  MultipleChoiceQuestion,
  NextStepRequest,
  NextStepResponse,
  Position,
  Question,
  Score,
} from './types';
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npm test --workspace packages/core
```

Expected: PASS, including the ten new assertions in `schemas.test.ts`.

- [ ] **Step 10: Typecheck the whole repo**

```bash
npm run typecheck
```

Expected: all four workspaces green. This is the type-parity proof the spec asks for: `apps/mobile` and `apps/server` both compile against the newly inferred types with no source change of their own. A failure here means an inferred type drifted from the hand-written one it replaced — fix `schemas.ts`, never the consumer.

- [ ] **Step 11: Verify the invariants**

```bash
grep -nE "^(import|export)" packages/core/src/api/index.ts | grep -v "^[0-9]*:export type"
git diff --stat apps/mobile
```

Expected: **both commands print nothing.** The first prints any top-level `import` or `export` in the barrel that is not an `export type` — the type-only invariant. The second confirms `apps/mobile` is untouched.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json packages/core/package.json packages/core/src/api/
git commit -m "feat(core): define the wire contract as Zod schemas and infer every type from them"
```

---

### Task 2: `createApp` becomes an `OpenAPIHono` and publishes the document

This is the spec's "convert **one** route and confirm `/openapi.json` renders before touching the other two" sequencing. `/health` is that one route. The sessions router is left alone — it is still a plain `Hono` mounted with `app.route`, which works unchanged.

**Files:**
- Modify: `apps/server/package.json` (two dependencies)
- Modify: `apps/server/src/app.ts` (rewritten)
- Modify: `apps/server/src/app.test.ts` (tests added; the two existing `/health` tests are **not** touched)
- Test: `apps/server/src/app.test.ts` — the unit bucket, no database

**Interfaces:**
- Consumes: `HealthResponseSchema` from `@lang-tutor/core/api/schemas` (Task 1).
- Produces: `createApp(deps: AppDeps)` now returns an `OpenAPIHono` instead of a `Hono`. Its `.request()` and `.fetch` surface is unchanged, so all three call sites — `src/index.ts` (`createApp(deps).fetch`), `tests/integration/app.test.ts` (`.request(…)`) and `tests/integration/session-flow.test.ts` (`.fetch`) — need no edit. Task 4 relies on `app.route('/api/sessions', …)` still being called **before** `app.doc31(…)` in this file.

- [ ] **Step 1: Install the two dependencies**

```bash
npm install @hono/zod-openapi@^1.6.3 @scalar/hono-api-reference@^0.12.0 --workspace apps/server
npm run typecheck
```

Expected: install succeeds, typecheck still green (nothing imports them yet). `@hono/zod-openapi@1.6.3` needs `zod ^4.0.0` and `hono >=4.10.0`; `@scalar/hono-api-reference@0.12.0` needs `hono ^4.12.5`. The repo has hono 4.13.5 and zod 4.x, so both fit unmodified — an `npm error ERESOLVE` here means Task 1's root `zod` entry did not land.

- [ ] **Step 2: Write the failing tests**

Append to `apps/server/src/app.test.ts` (leave the existing `describe('GET /health', …)` block exactly as it is):

```ts
// The documentation routes need no database: after phase 5, createApp takes
// fakes. Their contents are asserted in src/openapi.test.ts once all three
// routes are declared; these two are the "it is mounted and it renders" pair.
describe('the documentation routes', () => {
  it('serves an OpenAPI 3.1 document at /openapi.json', async () => {
    const res = await createApp(depsWithPing(true)).request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('lang-tutor API');
    expect(Object.keys(doc.paths)).toContain('/health');
  });

  it('serves the Scalar reference at /docs', async () => {
    const res = await createApp(depsWithPing(true)).request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

// /health is the first route converted to a createRoute definition, so its
// declared statuses are the first proof that a route's failures are published
// rather than implied.
describe('the /health route definition', () => {
  it('declares both 200 and 503 in the document', async () => {
    const res = await createApp(depsWithPing(true)).request('/openapi.json');
    const doc = await res.json();
    expect(Object.keys(doc.paths['/health'].get.responses).sort()).toEqual(['200', '503']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test --workspace apps/server
```

Expected: the three new tests FAIL — `/openapi.json` and `/docs` return 404, so `expect(res.status).toBe(200)` fails and the JSON parse of a 404 body throws. The two existing `/health` tests still PASS.

- [ ] **Step 4: Rewrite `apps/server/src/app.ts`**

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HealthResponseSchema } from '@lang-tutor/core/api/schemas';
import { Scalar } from '@scalar/hono-api-reference';
import { cors } from 'hono/cors';

import type { AppDeps } from './composition';
import { createSessionsRouter } from './routes/sessions';

// Readiness, not just liveness: the e2e suite waits on this before starting the
// app, and a 503 here is what distinguishes "server booting" from "broken".
// Both statuses are declared, so both are published.
const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['health'],
  summary: 'Readiness check',
  responses: {
    200: {
      content: { 'application/json': { schema: HealthResponseSchema } },
      description: 'The server is ready to serve traffic.',
    },
    503: {
      content: { 'application/json': { schema: HealthResponseSchema } },
      description: 'The server is up but its database is not reachable.',
    },
  },
});

// Wires everything, holds no logic — and it does not know a database exists: no
// drizzle import, no Db, no SQL, and it never touches the console; every
// collaborator arrives in `deps`. An OpenAPIHono rather than a Hono because the
// route definitions below *are* the published description of this API.
export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono();
  app.use('*', cors());

  app.openapi(healthRoute, async (c) => {
    const ok = await deps.health.ping();
    return ok ? c.json({ ok: true }, 200) : c.json({ ok: false }, 503);
  });

  app.route('/api/sessions', createSessionsRouter(deps.sessions));

  // Registered after the routes they describe, so the document is generated
  // from a fully-populated router. Always on: no auth, no secrets, and an
  // open-source client already describes this surface — gating adds
  // configuration and removes no risk.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'lang-tutor API',
      version: '0.1.0',
      description:
        'Sessions of ten multiple-choice questions for Hebrew speakers learning English.',
    },
  });
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'lang-tutor API' }));

  app.onError((error, c) => {
    deps.logger.error('unhandled request error', error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
```

`doc31`, not `doc`: Zod 4 emits JSON Schema 2020-12, which corresponds to OpenAPI 3.1. `version: '0.1.0'` is a literal rather than a read of `package.json` — importing JSON would need a resolver flag in four places to save one string.

- [ ] **Step 5: Run the unit tests to verify they pass**

```bash
npm test --workspace apps/server
```

Expected: PASS — all five tests in `app.test.ts`, including the two pre-existing `/health` tests unmodified.

- [ ] **Step 6: Typecheck, then run the database-backed tests**

```bash
npm run typecheck
npm run db:up
npm run test:all
```

Expected: all green. `tests/integration/app.test.ts` calls `createApp(...).request(...)` and `tests/integration/session-flow.test.ts` serves `createApp(...).fetch` over a real socket; both must pass **without edits** — that is the proof that swapping `Hono` for `OpenAPIHono` did not change the app's surface.

- [ ] **Step 7: Look at the rendered page once, by eye**

```bash
npm run server
```

Then open <http://localhost:3001/docs> in a browser and confirm Scalar renders with `/health` listed under a `health` tag. Stop the server with Ctrl-C.

This is the one step in the plan that a test cannot replace. Note that the page loads its client bundle from `https://cdn.jsdelivr.net/npm/@scalar/api-reference`, so it needs network access; `/openapi.json` does not. If the page is blank, check the browser console before suspecting the route.

- [ ] **Step 8: Commit**

```bash
git add apps/server/package.json apps/server/src/app.ts apps/server/src/app.test.ts package-lock.json
git commit -m "feat(server): build the app on OpenAPIHono and publish /openapi.json and /docs"
```

---

### Task 3: `POST /api/sessions` becomes a route definition, and the validation body is pinned

Half a router conversion, on purpose. `POST /` becomes a `createRoute` + `.openapi()` handler while `POST /:id/next-step` stays a plain `router.post` — an `OpenAPIHono` serves both, and only the converted one appears in the document. Verified: the unconverted route keeps working and the document lists exactly one path.

This is also where the `defaultHook` lands, so this is where the validation body gets its assertion.

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`
- Modify: `apps/server/tests/support/fakes.ts` (add `createFakeAppDeps`)
- Create: `apps/server/src/openapi.test.ts`
- Modify: `apps/server/tests/integration/routes/sessions.test.ts` (**one test appended**; the ten existing tests are not touched)

**Interfaces:**
- Consumes: `CreateSessionRequestSchema`, `CreateSessionResponseSchema`, `ErrorSchema` from `@lang-tutor/core/api/schemas` (Task 1); `createApp` returning an `OpenAPIHono` (Task 2).
- Produces: `createSessionsRouter(sessions: SessionService)` now returns an `OpenAPIHono` carrying the `defaultHook`. Task 4 adds its second route to the same instance. `createFakeAppDeps(): AppDeps` in `tests/support/fakes.ts`, used by `src/openapi.test.ts` in this task and Task 4.

- [ ] **Step 1: Add a fake-deps helper to `apps/server/tests/support/fakes.ts`**

Append to the existing file (leave `createFakeLogger` exactly as it is):

```ts
import type { AppDeps } from '../../src/composition';
import type { SessionService } from '../../src/services/sessions';

// For tests that assert something about the *shape* of the app rather than its
// behaviour — the published document, for one. Every collaborator throws,
// because a document is generated from route definitions and must never reach a
// handler; if one of these fires, the test is asserting the wrong thing.
export function createFakeAppDeps(): AppDeps {
  const unreachable = (): never => {
    throw new Error('a document-shape test must not reach a collaborator');
  };
  const sessions: SessionService = {
    startSession: unreachable,
    submitAnswer: unreachable,
  };
  return {
    sessions,
    health: { ping: unreachable },
    logger: createFakeLogger(),
  };
}
```

Put the two `import type` lines at the top of the file with the existing `import type { Logger }` line, not in the middle.

- [ ] **Step 2: Write the failing document test**

Create `apps/server/src/openapi.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { createApp } from './app';
import { createFakeAppDeps } from '../tests/support/fakes';

// The "documentation cannot drift" proof, and a unit test: after phase 5
// createApp accepts fakes, so generating the document needs no database.
async function openApiDocument() {
  const res = await createApp(createFakeAppDeps()).request('/openapi.json');
  expect(res.status).toBe(200);
  return await res.json();
}

describe('POST /api/sessions in the published document', () => {
  it('is declared', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths)).toContain('/api/sessions');
    expect(doc.paths['/api/sessions'].post).toBeDefined();
  });

  it('declares its 200 and its 400', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/sessions'].post.responses).sort()).toEqual(['200', '400']);
  });

  it('declares a JSON request body', async () => {
    const doc = await openApiDocument();
    const body = doc.paths['/api/sessions'].post.requestBody;
    expect(body.content['application/json'].schema.required).toEqual(['user_id']);
  });

  // The published 400 must describe the body the server actually returns, which
  // the defaultHook keeps as { error: 'invalid request' } — a document that
  // promised a Zod issue payload would be honest about the library and wrong
  // about this server.
  it('declares the error body it actually returns', async () => {
    const doc = await openApiDocument();
    const schema =
      doc.paths['/api/sessions'].post.responses['400'].content['application/json'].schema;
    expect(schema.required).toEqual(['error']);
    expect(schema.properties.error.type).toBe('string');
  });
});
```

- [ ] **Step 3: Pin the validation body before changing it**

Append one test to `apps/server/tests/integration/routes/sessions.test.ts`, inside the existing `describe('POST /api/sessions', …)` block, after `it('rejects a missing user_id', …)`:

```ts
  // A characterisation test, added precisely because nothing asserted this
  // before. @hono/zod-openapi's built-in 400 carries a Zod issue payload
  // instead; the defaultHook restoring this body is the only thing between this
  // phase and a silent contract change. The other route tests assert
  // `res.status` only, and apps/mobile's client does `throw new
  // ApiError(res.status)` — so nothing else in this repository would notice.
  it('returns { error: "invalid request" } as the validation body', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
```

- [ ] **Step 4: Run both test files and confirm what fails**

```bash
npm test --workspace apps/server
npm run db:up
npm run test:integration --workspace apps/server
```

Expected, and this pair is the point of the task:
- `src/openapi.test.ts` — **all four FAIL**: `doc.paths['/api/sessions']` is `undefined`, so `Object.keys(doc.paths)` does not contain it and the property reads throw.
- The new integration test — **PASSES**. It pins behaviour that already exists. If it fails now, the conversion is not the problem and something else is wrong; stop and report.

- [ ] **Step 5: Convert `POST /` in `apps/server/src/routes/sessions.ts`**

Replace the imports and the `createSessionsRouter` function. `buildNextStepResponse` above them is unchanged, and `router.post('/:id/next-step', …)` is left exactly as it is — Task 4 converts it.

New imports at the top of the file:

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorSchema,
} from '@lang-tutor/core/api/schemas';
import type { NextStepResponse } from '@lang-tutor/core/api';

import {
  currentQuestion,
  missedQuestions,
  positionOf,
  sessionScore,
  type SessionRecord,
} from '../domain/session';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import type { SessionService } from '../services/sessions';
import { NextStepRequestSchema } from './schemas';
```

The `Hono` import and the `CreateSessionResponse` type import both go — `.openapi()` types the response from `CreateSessionResponseSchema`, so the local annotation is now the second definition of a thing that already has one.

The route definition, placed above `createSessionsRouter`:

```ts
const createSessionRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['sessions'],
  summary: 'Start a session',
  description: 'Draws ten questions and returns the first one.',
  request: {
    body: { content: { 'application/json': { schema: CreateSessionRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CreateSessionResponseSchema } },
      description: 'The session was created. `question` is its first question.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate.',
    },
  },
});
```

And the router:

```ts
// Transport only: parse, validate, and map an outcome to a status code. No SQL,
// no transaction, no knowledge that a database exists. The route definitions are
// also this API's published description — there is no second document to update.
export function createSessionsRouter(sessions: SessionService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload. The
  // contract says `{ error: 'invalid request' }`, and this is the only thing
  // that keeps it saying so.
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createSessionRoute, async (c) => {
    const { user_id } = c.req.valid('json');
    const { sessionId, record } = await sessions.startSession(user_id);
    return c.json(
      {
        session_id: sessionId,
        question: currentQuestion(record)!,
        position: positionOf(record),
      },
      200,
    );
  });

  router.post('/:id/next-step', async (c) => {
    const sessionId = c.req.param('id');
    const parsed = NextStepRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

    try {
      const record = await sessions.submitAnswer(
        sessionId,
        parsed.data.question_id,
        parsed.data.option_index,
      );
      return c.json(buildNextStepResponse(sessionId, record));
    } catch (error) {
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof OptionOutOfRange) {
        return c.json({ error: 'option_index is out of range for this question' }, 400);
      }
      throw error; // anything else is a real failure — app.ts's onError turns it into a 500
    }
  });

  return router;
}
```

- [ ] **Step 6: Run every test**

```bash
npm test --workspace apps/server
npm run test:integration --workspace apps/server
npm run typecheck
```

Expected: all green. Specifically — `src/openapi.test.ts`'s four tests now pass, and **all eleven** tests in `tests/integration/routes/sessions.test.ts` pass, the ten pre-existing ones without any edit. The route test file still builds its app with a plain `new Hono()`; an `OpenAPIHono` router mounted on a plain `Hono` parent works unchanged, including `c.req.valid('json')` and the `defaultHook`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/sessions.ts apps/server/src/openapi.test.ts apps/server/tests/support/fakes.ts apps/server/tests/integration/routes/sessions.test.ts
git commit -m "feat(server): declare POST /api/sessions as a route definition and pin the validation body"
```

---

### Task 4: `POST /api/sessions/{id}/next-step` publishes its failures, and `routes/schemas.ts` is deleted

The endpoint with four outcomes. Declaring 400, 404 and 409 alongside the 200 is the real work of this phase — it is what turns the published description from a happy-path sketch into an honest one.

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`
- Delete: `apps/server/src/routes/schemas.ts`
- Modify: `apps/server/src/openapi.test.ts` (two `describe` blocks appended)
- The ten pre-existing tests in `apps/server/tests/integration/routes/sessions.test.ts` are **not** touched

**Interfaces:**
- Consumes: `NextStepRequestSchema`, `NextStepResponseSchema`, `ErrorSchema` from `@lang-tutor/core/api/schemas` (Task 1); the `OpenAPIHono` router with its `defaultHook` (Task 3); `createFakeAppDeps` (Task 3).
- Produces: the complete document. Nothing later depends on new names.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/openapi.test.ts`:

```ts
const NEXT_STEP = '/api/sessions/{id}/next-step';

describe(`POST ${NEXT_STEP} in the published document`, () => {
  it('declares every status it can return', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths[NEXT_STEP].post.responses).sort()).toEqual([
      '200',
      '400',
      '404',
      '409',
    ]);
  });

  it('declares the id path parameter', async () => {
    const doc = await openApiDocument();
    expect(doc.paths[NEXT_STEP].post.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  // The discriminated union the mobile Results screen narrows on, published as
  // a two-member oneOf rather than flattened into a bag of optional fields.
  it('publishes the in-progress/completed union as a two-member oneOf', async () => {
    const doc = await openApiDocument();
    const schema = doc.paths[NEXT_STEP].post.responses['200'].content['application/json'].schema;
    expect(schema.oneOf).toHaveLength(2);
  });

  it('describes each failure with the error body it actually returns', async () => {
    const doc = await openApiDocument();
    for (const status of ['400', '404', '409']) {
      const schema =
        doc.paths[NEXT_STEP].post.responses[status].content['application/json'].schema;
      expect(schema.required).toEqual(['error']);
    }
  });
});

// The load-bearing assertion of the whole phase: this document is generated
// from the route definitions the server actually serves, so it cannot describe
// an endpoint the server does not have, or miss one it does.
describe('the document as a whole', () => {
  it('is an OpenAPI 3.1 document', async () => {
    const doc = await openApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual(
      expect.objectContaining({ title: 'lang-tutor API', version: '0.1.0' }),
    );
  });

  it('contains all three paths and nothing else', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/sessions',
      NEXT_STEP,
      '/health',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test --workspace apps/server
```

Expected: the four `next-step` tests FAIL (`doc.paths['/api/sessions/{id}/next-step']` is `undefined`), `contains all three paths and nothing else` FAILS (only two are listed), and `is an OpenAPI 3.1 document` PASSES already.

- [ ] **Step 3: Convert the route**

In `apps/server/src/routes/sessions.ts`, drop the last local-schema import and add `zod`. The import block becomes:

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorSchema,
  NextStepRequestSchema,
  NextStepResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import {
  currentQuestion,
  missedQuestions,
  positionOf,
  sessionScore,
  type SessionRecord,
} from '../domain/session';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import type { SessionService } from '../services/sessions';
```

`import type { NextStepResponse } from '@lang-tutor/core/api'` goes too — `buildNextStepResponse`'s return annotation is replaced below by the schema-inferred one. Both `import ... from './schemas'` lines are gone, which is what makes Step 4 possible.

Change `buildNextStepResponse`'s return type to the inferred one, leaving its body untouched:

```ts
function buildNextStepResponse(
  sessionId: string,
  record: SessionRecord,
): z.infer<typeof NextStepResponseSchema> {
```

Add the second route definition next to `createSessionRoute`:

```ts
// `id` is `z.string()` and must stay that way. A `.uuid()` here would turn a
// malformed session id into a 400, and the contract — asserted by an existing
// route test — is that an unknown id and a malformed one both 404. The
// repository layer is what decides that, not the router.
const nextStepRoute = createRoute({
  method: 'post',
  path: '/{id}/next-step',
  tags: ['sessions'],
  summary: 'Answer the current question',
  description:
    'Records an answer and returns the next question, or the final score once ten are answered. Re-sending the same answer replays the same response.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: NextStepRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: NextStepResponseSchema } },
      description:
        'The answer was recorded. `complete: false` carries the next question; `complete: true` carries the score and the missed questions.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate, or `option_index` is out of range.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No session has this id.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: "`question_id` is not the session's current question.",
    },
  },
});
```

Then replace the whole `router.post('/:id/next-step', …)` block with:

```ts
  router.openapi(nextStepRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { question_id, option_index } = c.req.valid('json');

    try {
      const record = await sessions.submitAnswer(id, question_id, option_index);
      return c.json(buildNextStepResponse(id, record), 200);
    } catch (error) {
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof OptionOutOfRange) {
        return c.json({ error: 'option_index is out of range for this question' }, 400);
      }
      throw error; // anything else is a real failure — app.ts's onError turns it into a 500
    }
  });
```

The status arguments are now load-bearing rather than decorative: `.openapi()` typechecks each returned body against the schema declared for that status, so a 404 returning the 200 shape stops compiling.

- [ ] **Step 4: Delete the server's schema file**

```bash
git rm apps/server/src/routes/schemas.ts
grep -rn "routes/schemas\|from './schemas'" apps/server/src apps/server/tests
```

Expected: the `grep` prints nothing. The two request schemas it held now live in `packages/core/src/api/schemas.ts` beside the responses they pair with — request and response defined together, which is the premise of the phase.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test --workspace apps/server
npm run db:up
npm run test:integration --workspace apps/server
npm run typecheck
```

Expected: all green, including the **eleven** tests in `tests/integration/routes/sessions.test.ts` — the ten pre-existing ones still unmodified. Two of them are the ones to watch: `404s for a malformed (non-UUID) session id, not 500` proves the `id` param schema stayed permissive, and `400s when option_index is past the last option` proves a domain 400 still reads as a 400 now that the adapter also owns a 400.

- [ ] **Step 6: Commit**

`git rm` in Step 4 already staged the deletion, so this only needs the two edited files:

```bash
git add apps/server/src/routes/sessions.ts apps/server/src/openapi.test.ts
git status --short   # expect: M routes/sessions.ts, M openapi.test.ts, D routes/schemas.ts
git commit -m "feat(server): declare next-step's four outcomes and delete the server-local schemas"
```

---

### Task 5: The README catches up, and the phase is verified end to end

Two README claims are now false and one capability is undocumented. This task fixes those and runs every success criterion from the spec as an explicit, checkable command.

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished server from Tasks 1-4.
- Produces: nothing code-facing.

- [ ] **Step 1: Fix the stale claim about `packages/core`**

In the `## Layout` table, the `packages/core` row says "No runtime dependencies." That is no longer true. Replace that row's text with:

```
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). One runtime dependency, `zod`: since phase 7 the wire contract *is* a set of Zod schemas, and every type in `api/types.ts` is inferred from one. Consumed as TypeScript source, so there is no build step. |
```

Then extend the paragraph below that table. After the sentence ending "— both `apps/mobile` and `apps/server` import them.", add:

```
`@lang-tutor/core/api/schemas` is a third entry point, and deliberately separate: it
exports the Zod schemas those types are inferred from. `apps/server` imports it to build
its route definitions; `apps/mobile` never does. Keeping the schemas out of `./api` is
what makes that enforceable — `./api` is type-only, so a mobile import that forgets the
`type` keyword fails loudly instead of quietly pulling Zod into the app bundle.
```

- [ ] **Step 2: Fix the layer table**

In `## Architecture`, the `routes/` row reads "services, domain types, zod schemas". Replace that cell with:

```
| `routes/` | services, the wire schemas from `@lang-tutor/core/api/schemas`, `@hono/zod-openapi` | Drizzle, SQL, `db/` |
```

Then, after the paragraph beginning "`routes/` (Hono handlers) never sees a `Db`…", add:

```
Since phase 7 a route is one `createRoute` definition plus its handler, and that
definition is simultaneously the routing entry, the request validator, the response type
and the published OpenAPI description. There is no second document to keep in step,
which is the point: a response that stops matching its declared schema stops compiling.
```

- [ ] **Step 3: Document the two new endpoints**

Add a new section between `## Running it` and `## Browsing the database`:

```markdown
## Reading the API

The server describes itself. With `npm run server` running:

| URL | What it is |
|---|---|
| <http://localhost:3001/openapi.json> | The generated OpenAPI 3.1 document |
| <http://localhost:3001/docs> | [Scalar](https://github.com/scalar/scalar) — reads the document and sends real requests from the page |

Both are always on. There is no auth and no secret here, and the API surface is already
fully described by an open-source client that calls it, so gating them would add
configuration and remove no risk.

Neither is hand-written. Every endpoint is one `createRoute` definition in
`apps/server/src/` — routing, request validation, response typing and documentation at
once — built from the Zod schemas in `packages/core/src/api/schemas.ts`. Documentation
that drifts is documentation that was written twice; this is written once.

`/docs` loads Scalar's client bundle from `cdn.jsdelivr.net`, so that page needs network
access. `/openapi.json` is generated in-process and works offline.
```

- [ ] **Step 4: Add the phase links**

The phase list under the intro stops at Phase 4, though phases 5 and 6 have shipped. Add all three so the index is complete:

```markdown
- Phase 5: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md) · [plan](docs/superpowers/plans/2026-09-05-lang-tutor-phase-5-di-corrections.md)
- Phase 6: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md) · [plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-6-test-topology.md)
- Phase 7: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-7-openapi-design.md) · [plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-7-openapi.md)
```

And extend the intro paragraph, which currently ends "The learner-facing app is unchanged.", with:

```
Phase 7 changes how the server's routes are *declared*: one definition per endpoint now
serves as routing, validation, response typing and OpenAPI generation at once, and the
wire contract lives in `packages/core` as Zod schemas that every API type is inferred
from. The HTTP contract itself is untouched.
```

- [ ] **Step 5: Verify every success criterion from the spec**

Run each of these and confirm the stated expectation before ticking this step. Do not tick it on a partial run.

```bash
npm run typecheck
npm run db:up
npm run test:all
npm run e2e
```

Expected: four green runs.

```bash
git diff --stat main -- apps/mobile
```

Expected: **no output.** This phase requires no mobile change; any line here is a failure of the phase, not a detail to explain away.

```bash
test ! -e apps/server/src/routes/schemas.ts && echo "deleted OK"
grep -nE "^(import|export)" packages/core/src/api/index.ts | grep -v "^[0-9]*:export type"
grep -c "z.infer" packages/core/src/api/types.ts
grep -nE "^export type" packages/core/src/api/types.ts | grep -v "z.infer" || echo "every type inferred OK"
```

Expected: `deleted OK`; no output from the barrel check; `12` from the count; `every type inferred OK`.

```bash
npm run server   # then, in another terminal:
curl -s localhost:3001/openapi.json | node -e "
let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
  const doc = JSON.parse(s);
  console.log('openapi', doc.openapi);
  for (const [p, ops] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(ops)) console.log(m.toUpperCase(), p, '->', Object.keys(op.responses).join(', '));
  }
});"
```

Expected exactly:

```
openapi 3.1.0
GET /health -> 200, 503
POST /api/sessions -> 200, 400
POST /api/sessions/{id}/next-step -> 200, 400, 404, 409
```

Then open <http://localhost:3001/docs>, confirm Scalar renders all three endpoints, and use its "Test Request" on `POST /api/sessions` with `{"user_id":"u1"}` to confirm a real 200 comes back. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe the generated OpenAPI document and core's new zod dependency"
```

- [ ] **Step 7: Report**

State plainly which of the spec's success criteria passed, with the command output for the document dump and the mobile diff. If any did not, say which and why rather than describing the phase as complete.
