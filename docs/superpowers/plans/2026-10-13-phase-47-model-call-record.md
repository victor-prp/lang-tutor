# Phase 47 — Capped thinking and a model-call record: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Victor: "continue till PR",
> inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cap the session-generation call (1024 thinking tokens, 120 s; built as 4096, spec R8) and record every model call in
one Postgres table, kept 7 days.

**Architecture:** the provider reports each request to an injected `onCall`; `composition.ts` wires it
to a new `modelCalls` service whose `record` inserts the row and prunes, in a transaction of its own.
Every call site names its kind and handles through a required `record` field on the request.

**Tech stack:** TypeScript, Drizzle (migration via `npm run db:generate`), Jest (unit + integration),
the eval in `apps/server/tests/ev?l/`.

**Spec:** `docs/superpowers/specs/2026-10-13-lang-tutor-phase-47-model-call-record-design.md`

## Global constraints

- `SESSION_GENERATION_THINKING = 1024` (built as 4096: spec R8); `SESSION_GENERATION_BUDGET_MS = 120_000`; `MODEL_CALL_RETENTION_DAYS = 7`.
- ADR 0001 R10/R11: `providers/` imports no service type; `ModelCall` lives in `services/llm.ts`, satisfied structurally.
- A recording never fails or changes the call it records.
- No lane on this machine (all 9 taken): unit, typecheck, `lint:arch` and the eval run locally; integration and e2e in CI.

## Review focus

1. A timeout or network failure is still reported (with `response` null), then thrown as `LlmUnavailable`: provider test.
2. Audio and image bytes never reach the row: provider test on the transcriber and vision bodies.
3. A failing insert leaves the model's answer untouched and logs `model_call_not_recorded`: service test.
4. Each prepare attempt's three calls carry the same session and attempt: sessions prepare test.
5. A row older than 7 days is deleted by the next record, a newer one kept: repo integration test.

---

### Task 1: the table and the repository

**Files:** `src/db/schema.ts` (table `modelCalls`), the generated migration `src/db/migrations/0033_*.sql`,
`src/repo/modelCalls.ts`, `src/services/transaction.ts` (`Repos.modelCall`), `src/composition.ts`
(`bindRepos`), `tests/support/fakes.ts` (fake repos), `tests/integration/repo/modelCalls.test.ts`,
`tests/integration/db/schema.test.ts`.

**Produces:** `createModelCallRepo(tx)` → `{ insert(row: ModelCallRow): Promise<void>; deleteBefore(cutoff: Date): Promise<number> }`.

- [ ] Integration test: insert two rows (`started_at` now and now − 8 days), `deleteBefore(now − 7 days)` returns 1, the new row stays.
- [ ] Table per spec D2, indexes per D2; `npm run db:generate`; the schema test names the table.
- [ ] Repo; `Repos.modelCall`; `bindRepos`; fakes compile. Typecheck, commit.

### Task 2: the contract and the provider's report

**Files:** `src/services/llm.ts` (`ModelCallKind`, `ModelCallRecord`, `ModelCall`, `record` on `LlmJsonRequest`),
`src/services/speech.ts` (`record` on `LlmAudioRequest`), `src/providers/gemini.ts` (`onCall`, `kind` from
`request.record`, media replaced), `src/providers/gemini.test.ts`.

**Produces:** `ModelCall = { record: ModelCallRecord; model; startedAt: Date; request: unknown; response: unknown | null; httpStatus: number | null; error: string | null; durationMs: number; promptTokens: number | null; outputTokens: number | null; thinkingTokens: number | null; finishReason: string | null }`;
`GeminiDeps.onCall: (call: ModelCall) => Promise<void>` (required).

- [ ] Provider tests first: success reports body, response, tokens, finish reason; timeout, network failure, 503 and an unreadable body report then throw; transcriber and vision report `{ mimeType, bytes }` in place of `data`.
- [ ] Implement in `generate()`. Commit.

### Task 3: the recorder, the wiring, the cap, the call sites

**Files:** `src/services/modelCalls.ts` (+ test), `src/domain/jobs.ts` (budget 120 s, `SESSION_GENERATION_THINKING`,
`MODEL_CALL_RETENTION_DAYS`), `src/composition.ts` (service, `onCall` on every client, `sessionLlm`'s cap),
`src/worker.ts` (attempt), every call site in `src/services/{translations,photoImports,sessions,glosses}.ts`,
their tests and `tests/support/*`.

- [ ] Service test: `record` inserts and calls `deleteBefore(now − 7 d)`; a throwing transaction is logged and swallowed.
- [ ] Implement; wire in `composition.ts` (and `createGlossTools`).
- [ ] Each call site passes `record` per spec D3; `prepareSession(data, { attempt })`; worker passes `job.retryCount + 1`.
- [ ] Sessions prepare test: the three calls of an attempt carry kind, session, attempt, enrollment and user.
- [ ] `npx tsc --noEmit`, `npx jest` (unit), `npm run lint:arch`. Commit per concern.

### Task 4: the eval

**Files:** `tests/ev?l/run.ts`, `askModel.ts`, `askPhoto.ts`, `cases.ts`.

- [ ] No-op `onCall` on every eval client; `record: { kind }` on every ask; the generation client gets the cap.
- [ ] The century case (spec D7) in `DISTRACTOR_CASES`.
- [ ] Run the eval in full (`npx tsx tests/ev?l/run.ts` from `apps/server`). Commit.

### Finishing

Spec "as built" note, `git-create-pr`, `ci-green`. Left for Victor: `npm run lane:clean -- --yes` (no free lane).
