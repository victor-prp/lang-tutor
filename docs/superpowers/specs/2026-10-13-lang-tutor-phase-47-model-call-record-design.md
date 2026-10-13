# Phase 47 — Capped thinking and a record of every model call

- **Status:** Scoped with Victor on 2026-10-13 (one-pager), the table, the approach (A) and the
  recording path discussed and approved; then "continue till PR": the prune and the rest are
  self-approved (CLAUDE.md, *Continue till PR*). Rulings are at the end. Implemented on branch
  `phase-47-model-call-record`. Building moved the cap from 1024 to 4096 (R8).
- **Date:** 2026-10-13
- **Source:** the one-pager `drafts/2026-10-13-model-call-record-one-pager.md` (gitignored; its
  Done-means are restated below), lane 0's failed stocks of 2026-10-13, and the measurements
  below. Victor chose a custom solution with one Postgres table over the off-the-shelf tools,
  after researching them himself.
- **Builds on:** phase 43 (the stock, R4: a failed stock is not rebuilt), phase 45 (the
  translation judge's own thinking budget), phase 34 (the call budgets, ruling R12).
- **Touches:** one migration (the `model_calls` table); the `LlmClient` contract gains a
  required `record`; the Gemini provider reports every call; a new repo and service; the
  session-generation client's thinking budget and timeout. No wire change, no app change.

---

## Goal

A stocked session sometimes fails to prepare. On lane 0 on 2026-10-13 the stock `c0c71c16` failed
three attempts in a row, about four minutes each: gemini-2.5-flash's thinking ran away (62,910
thinking tokens on the session-generation call) and then wrote Hebrew wrong options on the two
"word" items, which `validateDistractors` refuses. Sent again by hand, the same request came back
in 12 s with English options once and in about 240 s with the Hebrew ones twice. With
`thinkingBudget: 1024` it came back in 6.6–6.7 s with English options three times out of three;
with 0, Hebrew every time.

Nothing recorded what was sent or what came back: the prompt above had to be rebuilt by running
`prepareSession` against a copy of the database with a capturing `fetch`.

**Done means:**

1. No session-generation call takes over 120 s.
2. For any model call, the prompt sent, the result returned and how long it took can be read
   afterwards, on every lane and in production.
3. Calls can be counted across: how long each kind takes and how often it fails.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and the eval pass, and
`TIER2_THRESHOLD` is not lowered.

## Scope

**In:** the session-generation call's thinking cap and timeout (D1); the table (D2); every call
naming its kind and handles (D3); the provider reporting every call (D4); the recorder and the
prune (D5); the attempt number (D6); an eval case for the century request (D7).

**Out:**

- the Hebrew options themselves: a prompt weakness (R8), for the next phase or a prompt change;
- a failed card degrading instead of failing the session: Victor's next phase, from
  `drafts/2026-10-13-session-fails-on-one-card-brief.md`;
- rebuilding a failed stock automatically: phase 43's R4 stands;
- changing any prompt's wording, and thinking caps on any other call;
- analysis tooling: no dashboard or report screen, the table is read with SQL;
- storing the audio or the images.

---

## D1. The session-generation call: 4096 thinking tokens, 120 s

`sessionLlm` gets `thinkingBudget: SESSION_GENERATION_THINKING` (4096, R8), as phase 45 gave the
translation judge its 512. `SESSION_GENERATION_BUDGET_MS` drops from 300 s to 120 s, so Done-means
1 holds by construction: a call the cap did not keep short is cut at 120 s and fails the attempt,
which pg-boss retries as today. `PREPARE_SESSION_EXPIRY_SECONDS` follows from the budgets, from 840 s
to 480 s. The context call and the checker keep their 60 s each and no cap.

Measured with the eval (one full run each, 18 session-generation calls, run side by side): no cap
7.2 s median, 11.4 s slowest; 1024 5.7 s and 7.2 s; 4096 7.3 s and 17.5 s. The generation rows'
tier 2 was 107, 106 and 108 of 109: within the run-to-run noise of the calls left unchanged. The
eval's own client for this prompt gets the same cap.

Building found 1024 too tight, and the cap is 4096 (R8). Five runs of the gap cases at each budget:

| budget | gap tier 2, five runs | generation median / slowest | thinking median / max | century batch, English options |
|---|---|---|---|---|
| none | 9/9 ×5 | 11.4 s / 13.5 s | 2,089 / 2,710 | 1 of 3 (the other two ran away, 4 min) |
| 1024 | 7, 7, 8, 7, 8 of 9 | 5.7 s / 6.1 s | 845 / 921 | 3 of 3 |
| 2048 | 9/9 ×5 | 8.2 s / 9.2 s | 1,408 / 1,640 | **0 of 5** |
| 4096 | 9/9 ×5 | 10.3 s / 12.8 s | 1,953 / 2,448 | 8 of 8, 15–19 s |

The full eval at 4096 passes: tier 1 clean, tier 2 273/285, gap 9/9.

## D2. The table

`model_calls`, one row per request, whatever its outcome:

| column | type | |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `started_at` | timestamptz not null | when the request went out |
| `kind` | text not null | D3 |
| `model` | text not null | e.g. `gemini-2.5-flash` |
| `session_id` | uuid null | session preparation |
| `attempt` | integer null | 1–3, D6 |
| `enrollment_id` | text null | |
| `user_id` | text null | |
| `request` | jsonb not null | the body as sent; the key is a header, never here; media replaced (D4) |
| `response` | jsonb null | the response body as received; null when none arrived |
| `http_status` | integer null | null when no response arrived |
| `error` | text null | the message `LlmUnavailable` carries |
| `duration_ms` | integer not null | |
| `prompt_tokens`, `output_tokens`, `thinking_tokens` | integer null | from `usageMetadata` |
| `finish_reason` | text null | the first candidate's |

Indexes: `(session_id, started_at)`, `(enrollment_id, started_at)`, `(user_id, started_at)`,
`(kind, started_at)`, `(started_at)`. No foreign keys and no check on `kind` (R2).

## D3. Every call names its kind

`LlmJsonRequest` gains a required `record: ModelCallRecord`:

```ts
type ModelCallRecord = { kind: ModelCallKind; sessionId?: string; attempt?: number; enrollmentId?: string; userId?: string };
```

`VisionJsonRequest` inherits it, and `SpeechTranscriber`'s request gains it. Required, so a call
site that does not name its kind does not compile. The kinds, one per call site:

| kind | call site | handles |
|---|---|---|
| `lookup` | `translations.ts` translate | user |
| `rendering` | `translations.ts` reconcile, repair, headword | user when a learner's lookup made it |
| `accept` | `translations.ts` accept-rendering | none |
| `sense_match` | `photoImports.ts` | user |
| `photo_read` | `photoImports.ts` | user |
| `transcription` | `sessions.ts` speaking | session, enrollment, user |
| `judge`, `translation_judge` | `sessions.ts` typed answer | session, enrollment, user |
| `fit_judge` | `sessions.ts` | session, enrollment, user |
| `session_generation`, `context`, `checker` | `sessions.ts` prepare | session, attempt, enrollment, user |
| `gloss_merge` | `glosses.ts` | none |

A handle a call site does not have is left out. The contract still returns `Promise<string>`:
no service sees tokens or the raw body.

## D4. The provider reports every call

`GeminiDeps` gains a required `onCall: (call: ModelCall) => Promise<void>`. `generate()` calls it
once per request, after the response is read or the request failed and before it returns or
throws, with the request body, the response body, the status, the error message, the duration
and what `usageMetadata` and the first candidate say. A timeout, a network failure, a non-2xx and
an unreadable body are all reported, then thrown as today.

The transcriber and the vision client report their body with each `inlineData` replaced by
`{ mimeType, bytes }`. `ModelCall` is declared in `services/llm.ts` beside `LlmClient`; the
provider satisfies it structurally, as it does `LlmClient` (ADR 0001 R10, R11).

## D5. The recorder

`services/modelCalls.ts`, `createModelCallService({ transaction, logger, now })`, one use case:
`record(call)`, one transaction that inserts the row and deletes every row whose `started_at` is
more than 7 days before now (`MODEL_CALL_RETENTION_DAYS`, R3). Any failure is logged
(`model_call_not_recorded`) and swallowed: a recording never fails or changes the call it records
(R4). `repo/modelCalls.ts` has the two primitives, `insert` and `deleteBefore`.

`composition.ts` builds it and hands `record` to every Gemini client, `createGlossTools`'s
included. A separate transaction from the caller's, by ADR 0001 R8's amendment: no transaction is
open across a model call, and the row is an independent write, correct whether or not the
caller's writes land. It must survive the caller's failure: the failed attempts are the ones most
wanted.

## D6. The attempt

`worker.ts` passes `{ attempt: job.retryCount + 1 }` as `prepareSession`'s second argument, which
hands it to the three calls of the attempt. Still one service call per handler (ADR 0007 R4).

## D7. An eval case for the century request

A distractor case built from the century request's two "word" items (century → מאה, dish →
צלחת) and its two typed items, so the eval holds the prompt known to run away. With the cap it
answers in English; the existing "every wrong option is in English script" check fails it otherwise.

---

## Testing

- **Unit:** the provider reports success, timeout, network failure, non-2xx and unreadable bodies,
  the tokens and finish reason, and replaces media; the recorder swallows a failed write; each
  `sessions.ts` call names its kind and handles, the attempt included, against the fakes.
- **Integration:** the repo's insert and the 7-day delete; the schema test's new table.
- **Eval:** the full run with the cap, and D7's case.

---

## Rulings

Taken under "continue till PR", for Victor to overturn.

- **R1. The kind comes from the call site, not the client.** One client, `llm`, serves the lookup,
  three rendering calls, the accept call and the sense match; a kind fixed per client would call
  all of them `lookup`.
- **R2. No foreign keys, no check on `kind`.** A record must never fail on a session a reseed
  deleted mid-call, and never hold back a user's or session's deletion; the prune bounds what is
  left behind. The kinds are a closed union in the server, so a new one needs no migration.
- **R3. The prune runs with each record, not on a schedule.** pg-boss's scheduler is off in every
  process ("no cron"), and turning it on adds a timer to each. With `(started_at)` indexed the
  delete is a short range scan. Production calls the model every hour (the bots), so its oldest
  row is at most a little over 7 days old; an idle lane keeps its rows until its next call.
- **R4. Recording never fails a call.** A lost record is a gap in the analysis; a failed call is a
  failed session or lookup.
- **R5. Media is replaced, not stored.** A photo of a page and a learner's voice are a different
  kind of data from a word list, and large.
- **R6. The eval records nothing.** It has no database; its clients get a no-op `onCall`.
- **R7. Retention is 7 days** (Victor, in brainstorming; first scoped as 30).
- **R8. The cap is 4096, not the 1024 Victor approved.** 1024 failed the eval's gap group in every
  one of five runs (a wrong option that also fits the blank: *mangio* for *compro*, *finish* for
  *begin*), and the eval must pass without lowering `TIER2_THRESHOLD`. 2048 passed the gap group
  but wrote Hebrew options for the century batch five times of five. 4096 passed both, and still
  bounds the runaway: thinking never passed about 4k tokens, against 62,910 uncapped. The Hebrew
  options are not a thinking problem: they come and go with the budget (1024 English, 2048 Hebrew,
  4096 English), so the prompt or the next phase's degrade-the-card is their fix. 3072 answered
  century in English five of five at about 12 s but was not run on the gap cases.
