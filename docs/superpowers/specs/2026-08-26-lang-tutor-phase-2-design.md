# lang-tutor Phase 2 Design: Server-Side Sessions

**Goal:** Introduce `apps/server`, a long-running Node process that becomes authoritative
over quiz sessions. The learner-facing functionality is unchanged from phase 1 — ten
multiple-choice questions, immediate feedback, a results screen — but session creation,
progress, and the pool of questions move from the mobile app to the server. The server
holds session state in memory only (no database) and logs each completed session to
stdout. This phase also lays groundwork — not implementation — for future adaptive
question selection.

**Relationship to phase 1:** [2026-08-24-lang-tutor-phase-1-design.md](2026-08-24-lang-tutor-phase-1-design.md)
and its [plan](../plans/2026-08-24-lang-tutor-phase-1.md) built the monorepo, `packages/core`
(dependency-free API contract + quiz domain rules), and the Expo app. Phase 1 explicitly
anticipated this phase: `packages/core`'s data types are already snake_case to match a
server response with no mapping layer, and its `SessionState` cursor was deliberately kept
client-side with a comment that "a server will never have one" — this phase is where that
changes.

## Why server-authoritative sessions

A future phase wants adaptive difficulty: e.g. after two correct answers in a row on the
same word, the next question about that word gets harder. That decision can only be made
by something that has seen the session's answer history so far. A design where the server
hands out all ten questions up front and the client scores itself locally cannot support
this — by the time the server is involved again, the session is already over.

So the server must be involved on every question, holding the session's progress itself.
The risk this creates is latency: if every learner action had to wait on a network round
trip, the quiz would feel sluggish. The design below avoids that by (a) sending the full
question — including the correct answer — so the client can show correct/wrong feedback
**instantly**, without waiting on the network, and (b) folding "record this answer" and
"give me the next question" into a single call, so there is exactly one round trip per
question, not two, and the "Continue" tap that follows is a pure local state change.

Adaptive selection logic itself is explicitly **not** implemented this phase — see
Out of scope. Only the shape that would allow it later (per-answer server round trip,
server-held history) is built now.

## Command / API contract

Two commands, translated directly to REST endpoints. `user_id` is sent on every
request — a client-generated placeholder (no auth yet) that future phases can use to
tie sessions to a real identity.

### `create-new-session` — `POST /api/sessions`

```
body: { user_id: string }
resp: { session_id: string, question: Question, position: { position: 1, total: 10 } }
```

Server picks 10 questions from its own pool via `pickQuestions` (from
`@lang-tutor/core/domain`) and stores a new `SessionRecord` in memory.

### `next-step` — `POST /api/sessions/:id/next-step`

```
body: { user_id: string, option_index: number }
resp (not complete): { session_id, question: Question, position: { position, total }, complete: false }
resp (complete):     { session_id, question: null, position, complete: true,
                        score: { correct: number, total: number }, missed_questions: MissedQuestion[] }
```

Records the answer to the *current* question in the session (via `evaluate` from
`@lang-tutor/core/domain`), advances the server's cursor, and returns either the next
question or — if that was the 10th answer — the final score and missed questions
directly in the same response. There is no separate results call: the last `next-step`
response *is* the results payload, which means the client already has everything the
Results screen needs by the time the learner taps "Continue" after the last question,
same as every question before it — no extra round trip at the end.

Re-submitting an answer to the question the session is currently on (rather than moving
forward) is **idempotent**: it returns the same recorded result again without changing
state, rather than erroring — this covers double-taps and retried requests. This includes
a retried call *after* completion: if the session is already `complete`, `next-step`
returns the same completion payload again without re-triggering the completion log line
a second time.

At the moment `complete` becomes `true`, the server logs the full session
(`session_id`, `user_id`, all questions, all answers, final score) as one JSON line to
stdout, and marks it complete in the store — but does **not** evict it on this same call.
Evicting immediately would break the idempotent-retry guarantee above: if the completion
response is lost in transit and the client retries, an already-evicted session would
incorrectly 404 instead of replaying the same result. Instead, completed sessions are
swept lazily (e.g. dropped once a few minutes old, checked opportunistically on the next
`create-new-session` call), which still keeps the store from growing unbounded over the
server's lifetime without punishing a same-moment retry.

### Errors

- Unknown `session_id` (never created, already completed and evicted, or the server
  restarted mid-session) → `404`. The client shows a simple "something went wrong,
  let's start over" screen and routes back to Home. No retry/reconnect logic —
  restarting the quiz is an acceptable outcome for a phase with no persistence.
- Malformed request body (wrong types, missing fields) → `400`, caught by request
  validation (see Server internals) before it reaches session logic.

## Server internals (`apps/server`, new workspace)

Built on [Hono](https://hono.dev), run via `@hono/node-server` as an always-on Node
process — not deployed serverless this phase. Hono is chosen over Express specifically
because its route/handler code is runtime-agnostic (Node, Cloudflare Workers, Bun, Lambda
via adapter), so a later phase can move to serverless hosting without rewriting the API
layer — even though doing so will require solving the state-storage problem this phase
deliberately defers (an in-memory `Map` does not survive across serverless invocations on
different execution environments).

```
apps/server/
├── package.json, tsconfig.json
└── src/
    ├── index.ts              Hono app; @hono/node-server listen on 0.0.0.0
    ├── routes/
    │   ├── sessions.ts       the 2 route handlers
    │   └── schemas.ts        Zod schemas for the two request bodies
    ├── store/
    │   └── sessionStore.ts   in-memory Map<session_id, SessionRecord>;
    │                         create/get/complete + a lazy sweep for stale completed entries
    ├── session.ts            createSession / recordAnswerAndAdvance — phase 1's mobile
    │                         session.ts cursor, relocated and adapted to be store-backed
    │                         instead of React-state-backed
    └── data/
        └── mockQuestions.ts  moved from apps/mobile — the server owns the question pool now
```

- `SessionRecord = { user_id: string; questions: Question[]; index: number; answers: AnswerRecord[] }`
  — structurally phase 1's `SessionState` plus `user_id`.
- Route handlers stay thin: validate the request body against a Zod schema, call into
  `session.ts` / `sessionStore.ts`, shape the response. All quiz logic (`pickQuestions`,
  `evaluate`, `score`, `missed`) still comes from `@lang-tutor/core/domain`, untouched —
  this is exactly the reuse phase 1's layering was built for.
- Zod schemas live in `apps/server/`, not in `packages/core`. Core stays dependency-free;
  only the server parses untrusted input, so only the server needs a validation library.
- CORS is enabled via Hono's `cors()` middleware, needed for the Expo web target (native
  `fetch` from Expo Go is not subject to CORS, but the web target is).
- Binding `0.0.0.0` (not `localhost`) is required so a phone running Expo Go on the same
  Wi-Fi network can reach the server — see Testing on a physical device, below.

## Client changes (`apps/mobile`)

**Removed:** `src/session.ts` (the cursor — now server-side) and
`src/data/mockQuestions.ts` (data — now server-side).

**New:** `src/api/client.ts` — two functions (`createSession`, `nextStep`) wrapping
`fetch` against a configurable base URL.

**`useSession` hook (`src/hooks/useSession.tsx`):** rewritten internally to drive local
React state from the two API calls instead of local pure functions, but its **public
shape is unchanged** — `question`, `position`, `selectedOption`, `answered`, `complete`,
`correctCount`, `missedQuestions`, etc. all still exist with the same meaning. This means
**all three screens (Home, Session, Results) require no changes** — they were already
written against the hook's interface, not its implementation.

Interaction flow inside the hook:
1. **Start:** call `createSession`; store `{ session_id, question, position }`.
2. **Option tap:** compute `is_correct` locally from the tapped option against
   `question.correct_option` — instant feedback banner, no network wait. In the
   background, call `nextStep` to register the answer server-side and fetch what's
   next — which, on the last question, is the final score and missed questions rather
   than another `Question`.
3. **Continue tap:** swap to the already-fetched next question (no network wait) — or,
   if the last `nextStep` response was `complete: true`, navigate straight to the
   Results screen using the score/missed questions it already returned. Either branch
   is a local state change only; there is no network call on this tap, ever.
4. **Any API failure** (network error or `404`): surface the simple error screen, route
   back to Home.

**`user_id`:** generated once per app install (random UUID) and sent on every request.
Not used for anything server-side yet beyond appearing in the completion log line —
groundwork for a future phase that ties sessions to a real identity.

**Base URL config:** `EXPO_PUBLIC_API_URL`, read at build/runtime, set to the dev
machine's LAN IP address. Documented in the README alongside how to find that IP.

## Testing on a physical device (Expo Go)

Same workflow as phase 1's `npm run mobile` + scan-the-QR-code, with two additions:

1. Start the server (`npm run server` or similar) — it binds `0.0.0.0`, so it's reachable
   from other devices on the same network, not just `localhost`.
2. Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to `http://<dev-machine-LAN-IP>:<port>`.
   Phone and dev machine must be on the same Wi-Fi network.

The Expo web target and simulators can keep using `localhost`, since they share the host
machine's network namespace.

## Testing approach

Mirrors phase 1's boundary: pure logic is unit-tested, components/screens are not.

- `apps/server/src/session.ts` — unit tests analogous to phase 1's `session.test.ts`:
  create, answer-and-advance, completion (score + missed questions in the final step),
  idempotent re-answer of the current question, idempotent re-call after completion.
- `apps/server/src/store/sessionStore.ts` — unit tests for create/get/complete and the
  stale-completed-session sweep.
- Route-level tests via Hono's built-in test client (`app.request(...)`) — no real HTTP
  server needed; covers the `404`/idempotency/completion behaviors end-to-end through the
  routes.
- `apps/mobile/src/api/client.ts` — unit tests with mocked `fetch`.
- No new component/screen tests, same rationale as phase 1: they would calcify UI that's
  still being iterated on.

## Out of scope for phase 2

- **Any persistence** (database, file-backed sessions). Sessions are in-memory only and
  are lost on server restart — that is accepted, not worked around.
- **Actual adaptive-difficulty logic.** Only the round-trip shape and server-held answer
  history that would make it possible later. No difficulty concept exists on `Question`
  yet.
- **Auth / real user accounts.** `user_id` is a client-generated placeholder, unvalidated
  server-side beyond being present.
- **Hiding `correct_option` from the client.** The full question, including the answer,
  is sent as in phase 1.
- **Concrete cloud deployment** (Lambda, containers, a hosting provider). Hono is chosen
  to keep that door open, not to walk through it — phase 2 runs locally only.

## File structure additions

```
lang-tutor-init/
├── apps/
│   ├── mobile/
│   │   └── src/
│   │       ├── api/
│   │       │   ├── client.ts          createSession, nextStep
│   │       │   └── client.test.ts
│   │       └── hooks/useSession.tsx   rewritten internals, same public shape
│   │       (removed: src/session.ts, src/session.test.ts,
│   │        src/data/mockQuestions.ts, src/data/mockQuestions.test.ts)
│   └── server/                        new workspace
│       ├── package.json, tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── routes/{sessions.ts,schemas.ts}
│           ├── store/sessionStore.ts
│           ├── session.ts
│           └── data/mockQuestions.ts  moved from apps/mobile, unchanged content
```

