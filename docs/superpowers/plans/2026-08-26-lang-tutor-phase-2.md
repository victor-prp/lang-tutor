# lang-tutor Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `apps/server`, a long-running Hono/Node process that becomes authoritative over quiz sessions — creating them, tracking progress, scoring answers, and logging completed sessions to stdout — while `apps/mobile` keeps its exact phase-1 learner-facing behavior but talks to the server instead of running the quiz locally.

**Architecture:** Two new REST endpoints (`create-new-session`, `next-step`) carry the whole session lifecycle, backed by an in-memory `Map` on the server — no database. Every question payload still includes `correct_option`, so the client shows correct/wrong feedback the instant the learner taps an option, with zero network wait; the `next-step` call that follows in the background both records that answer and returns what's next (or, on the last question, the final score and missed questions directly — there is no separate results call). The "Continue" tap is therefore always a local state change, never a network call. `packages/core`'s domain rules (`pickQuestions`, `evaluate`, `score`, `missed`) are reused unmodified by the server — this is exactly the second consumer phase 1's layering was built for.

**Tech Stack:** Hono 4.13.5, `@hono/node-server` 2.1.1, Zod 4.4.3, `tsx` 4.23.12 (dev/run, no build step — same "consume TypeScript directly" philosophy as `packages/core`), Jest 29 + Babel (matching the rest of the monorepo). Client adds `expo-crypto` and `@react-native-async-storage/async-storage` for a persisted per-install `user_id`.

**Spec:** [docs/superpowers/specs/2026-08-26-lang-tutor-phase-2-design.md](../specs/2026-08-26-lang-tutor-phase-2-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **No persistence.** Sessions live only in an in-memory `Map`; a server restart loses all in-flight sessions. This is accepted, not worked around.
- **No hidden `correct_option`.** Every `Question` sent to the client, at every point, includes the real answer — same as phase 1.
- **One round trip per question.** `next-step` always returns everything needed to show the next question (or the final results) in the same response that records the answer. The "Continue" tap never triggers a network call.
- **Shared wire types.** Every request/response shape for the two endpoints is defined once, in `packages/core/src/api/types.ts`, and imported by both `apps/server` and `apps/mobile`. Neither side redeclares its own copy.
- **`packages/core` stays dependency-free.** Zod schemas (runtime validation) live in `apps/server` only.
- **Data-object fields are `snake_case`** (`session_id`, `user_id`, `question_id`, `option_index`, `missed_questions`), matching phase 1's convention. Internal TypeScript/React code stays `camelCase`.
- **`apps/server` binds `0.0.0.0`**, not `localhost`, so a phone on the same Wi-Fi network can reach it via Expo Go.
- **CORS is enabled** on the server (`hono/cors`), needed for the Expo web target.
- **Verification commands.** From the repo root, `npm test` (runs every workspace) and `npm run typecheck` (same) must both be clean before any commit.

## Deviations from the spec

The spec was written and approved before this plan worked out the exact request/response contract and file layout. Each difference below is a plan-time decision, made for a concrete correctness or practicality reason discovered while turning the spec into code.

1. **`next-step`'s request body gains a `question_id` field**, beyond what the spec's prose examples showed. Without it, a lost response + client retry is ambiguous: the server can't tell "the client is retrying the answer for the question it's still looking at" from "the client is answering a new current question" using `option_index` and session state alone — a naive implementation would silently double-count the retried answer or score it against the wrong question. Including the id of the question the client is currently looking at (which it always has, from the previous response) makes the retry unambiguous and lets the server implement idempotency by simple, pure comparison against its own record — no separate cached-response field needed.
2. **The "simple error screen" is a native `Alert.alert` + redirect to Home, not a fourth route.** The spec's client-changes section said all three existing screens need no changes; a dedicated error *screen* would add a fourth route, which the spec never lists. An `Alert` with a single "start over" button delivers the same user-facing outcome (see the error, get routed back to Home) without adding a new file the spec didn't account for.
3. **`apps/mobile/src/app/index.tsx` gets a one-line import path change** (`SESSION_LENGTH` moves from `@/session` to `@lang-tutor/core/domain`), since `@/session` is deleted in this phase. This is not a behavior change — same constant, same value — so it doesn't conflict with the spec's "all three screens require no changes" in spirit, but it is technically a touched line in a screen file, worth naming explicitly rather than silently doing it.
4. **The env file for the LAN IP is `apps/mobile/.env.local`, not `.env`.** The repo's existing `.gitignore` patterns (`.env*.local` in both the root and `apps/mobile`) already ignore `.env.local` without any `.gitignore` edit; a bare `.env` is not currently ignored anywhere in the repo. Using the filename that's already covered avoids touching `.gitignore` at all. `apps/mobile/.env.example` is committed as the template.

## Verified environment

Every package version and integration point below was independently probed in a throwaway monorepo outside this repo before being written into this plan — the same rigor the phase 1 plan used, extended to a stack (Hono, a second workspace, `tsx`) phase 1 never touched.

| Fact | Verified value |
|---|---|
| `hono` | `4.13.5` |
| `@hono/node-server` | `2.1.1` — `peerDependencies: { hono: "^4" }`, `engines: { node: ">=20" }`. Node here is 22.18.0, so this is satisfied. |
| `zod` | `4.4.3` — no peer dependencies. |
| `tsx` | `4.23.12` |
| `tsx` + Hono + `@hono/node-server` | Booted a real server (`serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })`) via `npx tsx src/index.ts` and hit it with `curl` — real HTTP round trip confirmed working, no build step. |
| `packages/core`'s `exports` map, resolved by `tsx` | A second-workspace probe (`apps/server`-shaped) importing `@lang-tutor/core/domain` and `@lang-tutor/core/api` ran cleanly under `tsx` — phase 1 only verified this exports map under Metro and `tsc`; `tsx` is a third, previously-unverified resolver. |
| Same exports map, resolved by **Jest** (`testEnvironment: 'node'`, Babel + `@babel/preset-typescript`) | Also verified clean — a fourth previously-unverified resolver, since core's own tests only ever import by relative path, and mobile's tests never cross a package boundary at the domain layer. |
| Same exports map, resolved by `tsc` (`moduleResolution: "bundler"`, mirroring core's own tsconfig) | Clean, no errors. |
| `hono/cors` import + zod schema `.parse()` under this Jest/Babel setup | Both work; `.parse()` correctly throws on an invalid body. |
| Hono `app.route('/api/sessions', router)` mounting, `:id` params, and `c.req.json()` body parsing, together | Verified via two Jest tests hitting `app.request(...)` with a JSON body against both a collection route and a `:id`-parameterized route — exactly the shape `routes/sessions.ts` uses. |
| Jest's default `testMatch` | Already matches `tests/integration/session-flow.test.ts` (Jest's built-in pattern covers any `*.test.ts`, not just files under `src/`) — no custom `testMatch`/`roots` config needed in `apps/server`'s `package.json`. |

**Verification status of the code in this plan.** Every integration point above — the package versions, the exports-map resolution across four different tools, Hono's routing/mounting/body-parsing — was independently built and run. The exact business logic (`session.ts`'s `step` function, the store's sweep, the hook's request/response wiring) is new code written for this plan and gated by each task's own TDD cycle, the same way phase 1 treated its screens and components.

## File Structure

```
lang-tutor-init/
├── package.json                        + "server" script
├── packages/
│   └── core/src/api/
│       ├── types.ts                    + Position, CreateSessionRequest/Response,
│       │                                 NextStepRequest/Response
│       └── index.ts                    + re-exports of the above
└── apps/
    ├── mobile/
    │   ├── .env.example                 committed template for EXPO_PUBLIC_API_URL
    │   ├── package.json                 + expo-crypto, @react-native-async-storage/async-storage
    │   └── src/
    │       ├── api/
    │       │   ├── client.ts            createSession, nextStep, ApiError
    │       │   └── client.test.ts
    │       ├── userId.ts                getOrCreateUserId (persisted UUID)
    │       ├── userId.test.ts
    │       ├── strings.ts               + errorTitle, errorMessage, errorAction
    │       ├── hooks/useSession.tsx     rewritten internals, same public SessionValue shape
    │       └── app/index.tsx            one-line import fix (SESSION_LENGTH source)
    │       (removed: src/session.ts, src/session.test.ts,
    │        src/data/mockQuestions.ts, src/data/mockQuestions.test.ts)
    └── server/                          new workspace
        ├── package.json, tsconfig.json, babel.config.js
        ├── src/
        │   ├── app.ts                   createApp(): Hono — no listen call
        │   ├── index.ts                 listens on 0.0.0.0 via @hono/node-server
        │   ├── session.ts               newSessionRecord, step, positionOf, sessionScore, missedQuestions
        │   ├── session.test.ts
        │   ├── store/
        │   │   ├── sessionStore.ts      createSessionStore(): insert/get/set, lazy sweep
        │   │   └── sessionStore.test.ts
        │   ├── routes/
        │   │   ├── schemas.ts           Zod request schemas
        │   │   ├── sessions.ts          createSessionsRouter(store, questionPool)
        │   │   └── sessions.test.ts
        │   └── data/
        │       └── mockQuestions.ts     moved from apps/mobile, content unchanged
        └── tests/integration/
            └── session-flow.test.ts     real HTTP, full 10-question session, against the real app
```

**Task order and why.** Shared types first, since both later halves of the stack depend on them. Then the server bottom-up: `session.ts`'s domain logic (which owns the `SessionRecord` type) → `sessionStore.ts` (which only ever holds a `SessionRecord` by id — infrastructure depending on the domain type, not the reverse) → HTTP routes → integration test — each layer's tests only need the layer below it, mirroring how phase 1 built `packages/core` before anything that consumed it. Then the client: the API-facing leaf modules (`client.ts`, `userId.ts`) before the hook that wires them together, since the hook is the one piece with no automated tests of its own (matching phase 1's "no component/hook tests" boundary) and is easiest to get right last, against already-tested building blocks. Manual end-to-end verification closes the plan out, the same role phase 1's "run and confirm mirroring" step played.

| Task | Deliverable | Tests after |
|---|---|---|
| 1 | Shared wire types in `packages/core/api` | 29 (unchanged — types only) |
| 2 | `apps/server` scaffolded, mock data moved | 34 |
| 3 | `session.ts` domain logic | +9 |
| 4 | `sessionStore.ts` | +5 |
| 5 | HTTP routes (`app.ts`, `routes/`) | +8 |
| 6 | Real-HTTP integration test | +1 |
| 7 | Client API layer (`client.ts`, `userId.ts`) | +6 |
| 8 | `useSession` rewrite, old client code removed | same count, net fewer files |
| 9 | Manual end-to-end verification, README | — |

---

## Task 1: Shared wire types

**Files:**
- Modify: `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`

**Interfaces:**
- Consumes: `Question`, `AnswerRecord`, `Score`, `MissedQuestion` (already in `types.ts`).
- Produces, from `@lang-tutor/core/api`:
  - `Position = { position: number; total: number }`
  - `CreateSessionRequest = { user_id: string }`
  - `CreateSessionResponse = { session_id: string; question: Question; position: Position }`
  - `NextStepRequest = { user_id: string; question_id: string; option_index: number }`
  - `NextStepResponse` — a discriminated union on `complete`:
    - `{ session_id: string; question: Question; position: Position; complete: false }`
    - `{ session_id: string; question: null; position: Position; complete: true; score: Score; missed_questions: MissedQuestion[] }`

These are type-only additions with no runtime behavior, so there is no Jest test for this task — `tsc` is the only verification, the same way `types.ts`'s existing types have no dedicated test file today.

- [ ] **Step 1: Add the wire types**

Append to `packages/core/src/api/types.ts` (after the existing `MissedQuestion` type):

```ts
export type Position = {
  position: number;
  total: number;
};

export type CreateSessionRequest = {
  user_id: string;
};

export type CreateSessionResponse = {
  session_id: string;
  question: Question;
  position: Position;
};

export type NextStepRequest = {
  user_id: string;
  question_id: string;
  option_index: number;
};

// A discriminated union on `complete`: when true, the caller has everything
// the Results screen needs (score, missed_questions) in this same response —
// there is no separate results call.
export type NextStepResponse =
  | {
      session_id: string;
      question: Question;
      position: Position;
      complete: false;
    }
  | {
      session_id: string;
      question: null;
      position: Position;
      complete: true;
      score: Score;
      missed_questions: MissedQuestion[];
    };
```

- [ ] **Step 2: Export them from the barrel**

Replace the contents of `packages/core/src/api/index.ts`:

```ts
export type {
  AnswerRecord,
  CreateSessionRequest,
  CreateSessionResponse,
  MissedQuestion,
  MultipleChoiceQuestion,
  NextStepRequest,
  NextStepResponse,
  Position,
  Question,
  Score,
} from './types';
```

- [ ] **Step 3: Type-check**

```bash
npm run typecheck --workspace packages/core
```

Expected: silent.

- [ ] **Step 4: Run the full test suite to confirm nothing broke**

```bash
npm test
```

Expected: 29 tests passing, unchanged from phase 1 — this task adds no runtime code.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api/types.ts packages/core/src/api/index.ts
git commit -m "Add shared session wire types to @lang-tutor/core/api"
```

---

## Task 2: Scaffold `apps/server`, move the question pool

**Files:**
- Create: `apps/server/{package.json,tsconfig.json,babel.config.js}`
- Create: `apps/server/src/data/{mockQuestions.ts,mockQuestions.test.ts}`
- Modify: root `package.json` (add `"server"` script)
- Delete: `apps/mobile/src/data/{mockQuestions.ts,mockQuestions.test.ts}` (Task 8 removes the app's remaining reference to them; deleting the files now would break `apps/mobile`'s build in between tasks, so this task **copies** the data to the server and leaves the mobile copy in place until Task 8)

**Interfaces:**
- Consumes: `Question` from `@lang-tutor/core/api`, `SESSION_LENGTH` from `@lang-tutor/core/domain`.
- Produces: `mockQuestions: Question[]` (16 entries) from `apps/server/src/data/mockQuestions.ts`.

- [ ] **Step 1: Create the server's package manifest**

Package versions are the ones verified in the Verified environment table above. `main`/`exports` are intentionally absent — nothing imports `apps/server` as a package, unlike `packages/core`.

Create `apps/server/package.json`:

```json
{
  "name": "server",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "@hono/node-server": "^2.1.1",
    "@lang-tutor/core": "*",
    "hono": "^4.13.5",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@babel/core": "^7.29.7",
    "@babel/preset-env": "^7.29.7",
    "@babel/preset-typescript": "^7.29.7",
    "@jest/globals": "~29.7.0",
    "jest": "~29.7.0",
    "tsx": "^4.23.12",
    "typescript": "~6.0.3"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "jest",
    "typecheck": "tsc --noEmit"
  },
  "jest": {
    "testEnvironment": "node"
  }
}
```

- [ ] **Step 2: Create the server's TypeScript config**

Same shape as `packages/core`'s — `moduleResolution: "bundler"` is what the Verified environment probe confirmed resolves `@lang-tutor/core`'s `exports` map correctly under `tsc`.

Create `apps/server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": []
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create the server's Babel config**

Identical to `packages/core`'s — Jest needs this to strip TypeScript; no Expo preset here either, since this is a plain Node process.

Create `apps/server/babel.config.js`:

```js
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-typescript',
  ],
};
```

- [ ] **Step 4: Add the workspace-level dev script**

Edit the root `package.json`'s `"scripts"` block, adding `"server"` alongside the existing `"mobile"` entry:

```json
{
  "scripts": {
    "mobile": "npm run start --workspace apps/mobile",
    "server": "npm run dev --workspace apps/server",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

- [ ] **Step 5: Install**

```bash
npm install
```

Confirm the new workspace linked and nothing duplicated:

```bash
ls -l node_modules/@lang-tutor/
ls -d apps/server/node_modules 2>/dev/null || echo "fully hoisted - good"
```

Expected: `core -> ../../packages/core` (unchanged); no `apps/server/node_modules`.

- [ ] **Step 6: Move the question pool — write it in its new home**

This is the exact content of `apps/mobile/src/data/mockQuestions.ts`, relocated. The mobile copy is left in place until Task 8 deletes it, so `apps/mobile` keeps building throughout this task.

Create `apps/server/src/data/mockQuestions.ts`:

```ts
import type { Question } from '@lang-tutor/core/api';

export const mockQuestions: Question[] = [
  {
    id: 'q-window',
    type: 'multiple_choice',
    vocab_entry_id: 'v-window',
    question: 'window',
    options: ['דלת', 'חלון', 'שולחן', 'קיר'],
    correct_option: 1,
  },
  {
    id: 'q-book',
    type: 'multiple_choice',
    vocab_entry_id: 'v-book',
    question: 'book',
    options: ['ספר', 'עיפרון', 'מחשב', 'כיסא'],
    correct_option: 0,
  },
  {
    id: 'q-water',
    type: 'multiple_choice',
    vocab_entry_id: 'v-water',
    question: 'water',
    options: ['לחם', 'חלב', 'מים', 'קפה'],
    correct_option: 2,
  },
  {
    id: 'q-friend',
    type: 'multiple_choice',
    vocab_entry_id: 'v-friend',
    question: 'friend',
    options: ['שכן', 'מורה', 'רופא', 'חבר'],
    correct_option: 3,
  },
  {
    id: 'q-difficult',
    type: 'multiple_choice',
    vocab_entry_id: 'v-difficult',
    question: 'difficult',
    options: ['קל', 'קשה', 'חשוב', 'מהיר'],
    correct_option: 1,
  },
  {
    id: 'q-remember',
    type: 'multiple_choice',
    vocab_entry_id: 'v-remember',
    question: 'to remember',
    options: ['לשכוח', 'לזכור', 'ללמוד', 'לחשוב'],
    correct_option: 1,
  },
  {
    id: 'q-excuse-me',
    type: 'multiple_choice',
    vocab_entry_id: 'v-excuse-me',
    question: 'excuse me',
    options: ['שלום', 'תודה', 'סליחה', 'בבקשה'],
    correct_option: 2,
  },
  {
    id: 'q-good-morning',
    type: 'multiple_choice',
    vocab_entry_id: 'v-good-morning',
    question: 'good morning',
    options: ['לילה טוב', 'בוקר טוב', 'ערב טוב', 'שבוע טוב'],
    correct_option: 1,
  },
  {
    id: 'q-thank-you-very-much',
    type: 'multiple_choice',
    vocab_entry_id: 'v-thank-you-very-much',
    question: 'thank you very much',
    options: ['תודה רבה', 'בבקשה רבה', 'סליחה רבה', 'שלום רב'],
    correct_option: 0,
  },
  {
    id: 'q-how-do-you-do',
    type: 'multiple_choice',
    vocab_entry_id: 'v-how-do-you-do',
    question: 'How do you do?',
    options: ['מה השעה?', 'מה נשמע?', 'מה קרה?', 'מה זה?'],
    correct_option: 1,
  },
  {
    id: 'q-see-you-later',
    type: 'multiple_choice',
    vocab_entry_id: 'v-see-you-later',
    question: 'see you later',
    options: ['נתראה מחר', 'נתראה אחר כך', 'ניפגש בבוקר', 'נדבר בהמשך'],
    correct_option: 1,
  },
  {
    id: 'q-i-dont-understand',
    type: 'multiple_choice',
    vocab_entry_id: 'v-i-dont-understand',
    question: "I don't understand",
    options: ['אני לא יודע', 'אני לא שומע', 'אני לא מבין', 'אני לא זוכר'],
    correct_option: 2,
  },
  {
    id: 'q-what-is-your-name',
    type: 'multiple_choice',
    vocab_entry_id: 'v-what-is-your-name',
    question: 'What is your name?',
    options: ['מאיפה אתה?', 'איך קוראים לך?', 'בן כמה אתה?', 'מה אתה עושה?'],
    correct_option: 1,
  },
  {
    id: 'q-have-a-nice-day',
    type: 'multiple_choice',
    vocab_entry_id: 'v-have-a-nice-day',
    question: 'Have a nice day!',
    options: [
      'שיהיה לך יום נעים!',
      'שיהיה לך בוקר טוב!',
      'שיהיה לך שבוע טוב!',
      'שיהיה לך לילה טוב!',
    ],
    correct_option: 0,
  },
  {
    id: 'q-where-is-the-station',
    type: 'multiple_choice',
    vocab_entry_id: 'v-where-is-the-station',
    question: 'Where is the station?',
    options: ['איפה הבית?', 'איפה השוק?', 'איפה התחנה?', 'איפה הרחוב?'],
    correct_option: 2,
  },
  {
    id: 'q-nice-to-meet-you',
    type: 'multiple_choice',
    vocab_entry_id: 'v-nice-to-meet-you',
    question: 'Nice to meet you',
    options: ['נעים להכיר', 'טוב לראות אותך', 'נתראה בקרוב', 'תודה שבאת'],
    correct_option: 0,
  },
];
```

- [ ] **Step 7: Move the mock-data test alongside it**

Also unchanged content — it already imports `SESSION_LENGTH` from `@lang-tutor/core/domain` and `mockQuestions` by relative path, so nothing about it is mobile-specific.

Create `apps/server/src/data/mockQuestions.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { mockQuestions } from './mockQuestions';

const LONG_PROMPT_LENGTH = 15;

describe('mockQuestions', () => {
  it('holds more questions than one session needs, so repeat sessions vary', () => {
    expect(mockQuestions.length).toBeGreaterThan(SESSION_LENGTH);
  });

  it('gives every question a unique id', () => {
    const ids = mockQuestions.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every question exactly four distinct options', () => {
    for (const question of mockQuestions) {
      expect(question.options).toHaveLength(4);
      expect(new Set(question.options).size).toBe(4);
    }
  });

  it('points correct_option at a real option', () => {
    for (const question of mockQuestions) {
      expect(question.correct_option).toBeGreaterThanOrEqual(0);
      expect(question.correct_option).toBeLessThan(question.options.length);
    }
  });

  it('includes enough long prompts to exercise text wrapping', () => {
    const longPrompts = mockQuestions.filter(
      (question) => question.question.length >= LONG_PROMPT_LENGTH,
    );
    expect(longPrompts.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 8: Run the new workspace's tests and type-checker**

```bash
npm test --workspace apps/server
npm run typecheck --workspace apps/server
```

Expected: 5 tests passing, `tsc` silent.

- [ ] **Step 9: Run the full monorepo suite**

```bash
npm test
npm run typecheck
```

Expected: 34 tests total (29 + 5 new), both commands clean. `apps/mobile` is untouched by this task, so its 12 tests still pass unchanged.

- [ ] **Step 10: Commit**

```bash
git add apps/server package.json package-lock.json
git commit -m "Scaffold apps/server workspace, move the question pool onto it"
```

---

## Task 3: `session.ts` — the server's domain logic

**Files:**
- Create: `apps/server/src/session.ts`
- Test: `apps/server/src/session.test.ts`

**Interfaces:**
- Consumes: `AnswerRecord`, `MissedQuestion`, `Position`, `Question`, `Score` from `@lang-tutor/core/api`; `SESSION_LENGTH`, `evaluate`, `missed`, `pickQuestions`, `score` from `@lang-tutor/core/domain`.
- Produces, from `apps/server/src/session.ts`:
  - `SESSION_LENGTH` (re-exported)
  - `SessionRecord = { user_id: string; questions: Question[]; answers: AnswerRecord[]; complete: boolean; completed_at: number | null }`
  - `newSessionRecord(userId: string, pool: readonly Question[], rng?: () => number): SessionRecord`
  - `currentQuestion(record: SessionRecord): Question | undefined`
  - `positionOf(record: SessionRecord): Position`
  - `StepOutcome = { status: 'invalid_question' } | { status: 'advanced' | 'replayed'; record: SessionRecord; justCompleted: boolean }`
  - `step(record: SessionRecord, questionId: string, optionIndex: number): StepOutcome`
  - `sessionScore(record: SessionRecord): Score`
  - `missedQuestions(record: SessionRecord): MissedQuestion[]`

This is the piece that makes `next-step` idempotent (see Deviations #1): `step` looks only at whether `questionId` matches the record's *current* question (fresh answer) or the question that was *just* answered (a retried request — replayed, no mutation), and rejects anything else. It never needs a separately cached response, because a replay is always derivable fresh from the record's own already-updated state.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/session.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { AnswerRecord, Question } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import {
  currentQuestion,
  missedQuestions,
  newSessionRecord,
  positionOf,
  sessionScore,
  step,
  type SessionRecord,
} from './session';

function makeQuestion(n: number): Question {
  return {
    id: `q${n}`,
    type: 'multiple_choice',
    vocab_entry_id: `v${n}`,
    question: `word ${n}`,
    options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
    correct_option: 0,
  };
}

const POOL: Question[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

function makeRecord(questions: Question[], answers: AnswerRecord[] = []): SessionRecord {
  return {
    user_id: 'u1',
    questions,
    answers,
    complete: answers.length === questions.length,
    completed_at: null,
  };
}

describe('newSessionRecord', () => {
  it('starts with no answers and the first question current', () => {
    const record = newSessionRecord('u1', POOL, () => 0.5);
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
    expect(record.complete).toBe(false);
    expect(record.completed_at).toBeNull();
    expect(record.user_id).toBe('u1');
    expect(currentQuestion(record)).toBe(record.questions[0]);
    expect(positionOf(record)).toEqual({ position: 1, total: SESSION_LENGTH });
  });
});

describe('positionOf', () => {
  it('reports 1-based position, capped at total once complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    expect(positionOf(done)).toEqual({ position: 1, total: 1 });
  });
});

describe('step', () => {
  it('records a fresh answer and advances to the next question', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const outcome = step(makeRecord([q0, q1]), q0.id, q0.correct_option);
    expect(outcome.status).toBe('advanced');
    if (outcome.status !== 'advanced') throw new Error('unreachable');
    expect(outcome.record.answers).toHaveLength(1);
    expect(outcome.record.answers[0]).toEqual({
      question_id: q0.id,
      is_correct: true,
      answer_string: q0.options[q0.correct_option],
    });
    expect(outcome.record.complete).toBe(false);
    expect(outcome.justCompleted).toBe(false);
    expect(currentQuestion(outcome.record)).toBe(q1);
  });

  it('marks the record complete on the last question and reports justCompleted', () => {
    const q0 = makeQuestion(0);
    const outcome = step(makeRecord([q0]), q0.id, q0.correct_option);
    expect(outcome.status).toBe('advanced');
    if (outcome.status !== 'advanced') throw new Error('unreachable');
    expect(outcome.record.complete).toBe(true);
    expect(outcome.justCompleted).toBe(true);
    expect(currentQuestion(outcome.record)).toBeUndefined();
  });

  it('replays the same outcome when retried with the question that was just answered', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const answered = makeRecord(
      [q0, q1],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    const outcome = step(answered, q0.id, q0.correct_option);
    expect(outcome).toEqual({ status: 'replayed', record: answered, justCompleted: false });
  });

  it('replays the completion outcome when retried after the session is already complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    expect(done.complete).toBe(true);
    const outcome = step(done, q0.id, q0.correct_option);
    expect(outcome).toEqual({ status: 'replayed', record: done, justCompleted: false });
  });

  it('rejects a question_id that matches neither the current nor the just-answered question', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const outcome = step(makeRecord([q0, q1]), 'not-a-real-id', 0);
    expect(outcome).toEqual({ status: 'invalid_question' });
  });

  it('rejects a stale question_id once the session is complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    const outcome = step(done, 'not-a-real-id', 0);
    expect(outcome).toEqual({ status: 'invalid_question' });
  });
});

describe('sessionScore and missedQuestions', () => {
  it('delegates to the shared domain rules', () => {
    const [q0, q1, q2] = [makeQuestion(0), makeQuestion(1), makeQuestion(2)];
    const record = makeRecord(
      [q0, q1, q2],
      [
        { question_id: q0.id, is_correct: true, answer_string: q0.options[0] },
        { question_id: q1.id, is_correct: false, answer_string: q1.options[1] },
        { question_id: q2.id, is_correct: true, answer_string: q2.options[0] },
      ],
    );
    expect(sessionScore(record)).toEqual({ correct: 2, total: 3 });
    expect(missedQuestions(record)).toEqual([
      { question: q1, correct_answer: q1.options[q1.correct_option] },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test --workspace apps/server
```

Expected: FAIL — `Cannot find module './session'`.

- [ ] **Step 3: Implement `session.ts`**

Create `apps/server/src/session.ts`:

```ts
import type { AnswerRecord, MissedQuestion, Position, Question, Score } from '@lang-tutor/core/api';
import { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from '@lang-tutor/core/domain';

export { SESSION_LENGTH };

export type SessionRecord = {
  user_id: string;
  questions: Question[];
  answers: AnswerRecord[];
  complete: boolean;
  completed_at: number | null;
};

export function newSessionRecord(
  userId: string,
  pool: readonly Question[],
  rng: () => number = Math.random,
): SessionRecord {
  return {
    user_id: userId,
    questions: pickQuestions(pool, SESSION_LENGTH, rng),
    answers: [],
    complete: false,
    completed_at: null,
  };
}

export function currentQuestion(record: SessionRecord): Question | undefined {
  return record.questions[record.answers.length];
}

export function positionOf(record: SessionRecord): Position {
  return {
    position: Math.min(record.answers.length + 1, record.questions.length),
    total: record.questions.length,
  };
}

export type StepOutcome =
  | { status: 'invalid_question' }
  | { status: 'advanced' | 'replayed'; record: SessionRecord; justCompleted: boolean };

// Records the answer to `questionId` if it is the session's current question,
// advancing to the next one. If `questionId` is instead the question that was
// just answered by the previous call, this is a retried request: the record
// is returned unchanged rather than double-counting the answer. Any other
// `questionId` means the client and server have desynced.
export function step(record: SessionRecord, questionId: string, optionIndex: number): StepOutcome {
  if (record.complete) {
    const lastQuestion = record.questions[record.questions.length - 1];
    return questionId === lastQuestion.id
      ? { status: 'replayed', record, justCompleted: false }
      : { status: 'invalid_question' };
  }

  const expected = currentQuestion(record);
  if (expected && questionId === expected.id) {
    const answers = [...record.answers, evaluate(expected, optionIndex)];
    const complete = answers.length === record.questions.length;
    const updated: SessionRecord = { ...record, answers, complete };
    return { status: 'advanced', record: updated, justCompleted: complete };
  }

  const previouslyAnswered =
    record.answers.length > 0 ? record.questions[record.answers.length - 1] : undefined;
  if (previouslyAnswered && questionId === previouslyAnswered.id) {
    return { status: 'replayed', record, justCompleted: false };
  }

  return { status: 'invalid_question' };
}

export function sessionScore(record: SessionRecord): Score {
  return score(record.questions, record.answers);
}

export function missedQuestions(record: SessionRecord): MissedQuestion[] {
  return missed(record.questions, record.answers);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test --workspace apps/server
npm run typecheck --workspace apps/server
```

Expected: PASS, 9 new tests (14 total in this workspace); `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts
git commit -m "Add server session domain logic with idempotent step()"
```

---

## Task 4: `sessionStore.ts` — the in-memory store

**Files:**
- Create: `apps/server/src/store/sessionStore.ts`
- Test: `apps/server/src/store/sessionStore.test.ts`

**Interfaces:**
- Consumes: `SessionRecord` (type only) from `../session`.
- Produces, from `apps/server/src/store/sessionStore.ts`:
  - `STALE_AFTER_MS: number`
  - `SessionStore` (the return type of `createSessionStore`)
  - `createSessionStore(): SessionStore`, where `SessionStore` has:
    - `insert(record: SessionRecord, now?: number): string` — returns a generated session id
    - `get(sessionId: string): SessionRecord | undefined`
    - `set(sessionId: string, record: SessionRecord): void`

A factory function rather than a module-level singleton `Map`, so each test (and each app instance built in Task 5) gets its own isolated store with no risk of state leaking between tests. `now` is an injectable clock — the same dependency-injection pattern `packages/core`'s `pickQuestions` uses for `rng` — so the sweep can be tested deterministically without a real 5-minute wait.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/store/sessionStore.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import type { SessionRecord } from '../session';
import { STALE_AFTER_MS, createSessionStore } from './sessionStore';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    user_id: 'u1',
    questions: [],
    answers: [],
    complete: false,
    completed_at: null,
    ...overrides,
  };
}

describe('createSessionStore', () => {
  it('insert generates an id and stores the record, retrievable via get', () => {
    const store = createSessionStore();
    const record = makeRecord();
    const id = store.insert(record);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(store.get(id)).toBe(record);
  });

  it('insert never reuses an id across two calls', () => {
    const store = createSessionStore();
    const idA = store.insert(makeRecord());
    const idB = store.insert(makeRecord());
    expect(idA).not.toBe(idB);
  });

  it('get returns undefined for an unknown id', () => {
    const store = createSessionStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('set replaces the stored record for an existing id', () => {
    const store = createSessionStore();
    const id = store.insert(makeRecord());
    const updated = makeRecord({ complete: true, completed_at: 123 });
    store.set(id, updated);
    expect(store.get(id)).toBe(updated);
  });

  it('sweeps completed sessions older than STALE_AFTER_MS on the next insert, keeping newer ones', () => {
    const store = createSessionStore();
    const staleId = store.insert(makeRecord({ complete: true, completed_at: 0 }), 0);
    const freshId = store.insert(makeRecord({ complete: true, completed_at: 1000 }), 1000);

    // Triggers a sweep at a time well past STALE_AFTER_MS for staleId but not freshId.
    store.insert(makeRecord(), 1000 + STALE_AFTER_MS + 1);

    expect(store.get(staleId)).toBeUndefined();
    expect(store.get(freshId)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test --workspace apps/server
```

Expected: FAIL — `Cannot find module './sessionStore'`.

- [ ] **Step 3: Implement `sessionStore.ts`**

Create `apps/server/src/store/sessionStore.ts`:

```ts
import type { SessionRecord } from '../session';

export const STALE_AFTER_MS = 5 * 60 * 1000;

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore() {
  const sessions = new Map<string, SessionRecord>();

  function sweepStale(now: number): void {
    for (const [id, record] of sessions) {
      if (record.complete && record.completed_at !== null && now - record.completed_at > STALE_AFTER_MS) {
        sessions.delete(id);
      }
    }
  }

  return {
    // Evicting immediately on completion would break next-step's idempotent
    // retry (see session.ts's `step`): a lost response + client retry would
    // 404 instead of replaying. Sweeping only stale-and-complete entries,
    // opportunistically on the next insert, keeps memory bounded without
    // punishing a same-moment retry.
    insert(record: SessionRecord, now: number = Date.now()): string {
      sweepStale(now);
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, record);
      return sessionId;
    },
    get(sessionId: string): SessionRecord | undefined {
      return sessions.get(sessionId);
    },
    set(sessionId: string, record: SessionRecord): void {
      sessions.set(sessionId, record);
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test --workspace apps/server
npm run typecheck --workspace apps/server
```

Expected: PASS, 5 new tests (19 total in this workspace); `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store
git commit -m "Add in-memory session store with a lazy stale-completion sweep"
```

---

## Task 5: HTTP routes — `app.ts`, `routes/`, `index.ts`

**Files:**
- Create: `apps/server/src/routes/{schemas.ts,sessions.ts}`
- Test: `apps/server/src/routes/sessions.test.ts`
- Create: `apps/server/src/app.ts`, `apps/server/src/index.ts`

**Interfaces:**
- Consumes: everything from `../session` and `../store/sessionStore` (Tasks 3–4); `CreateSessionResponse`, `NextStepResponse`, `Question` from `@lang-tutor/core/api`; `mockQuestions` from `../data/mockQuestions`.
- Produces:
  - `CreateSessionRequestSchema`, `NextStepRequestSchema` (Zod) from `routes/schemas.ts`
  - `createSessionsRouter(store: SessionStore, questionPool: readonly Question[]): Hono` from `routes/sessions.ts`
  - `createApp(): Hono` from `app.ts` — no `listen` call, so tests and the Task 6 integration test can mount it without binding a real port as an import side effect
  - `index.ts` — the only file that actually calls `serve(...)`

- [ ] **Step 1: Write the Zod request schemas**

Create `apps/server/src/routes/schemas.ts`:

```ts
import { z } from 'zod';

export const CreateSessionRequestSchema = z.object({
  user_id: z.string().min(1),
});

export const NextStepRequestSchema = z.object({
  user_id: z.string().min(1),
  question_id: z.string().min(1),
  option_index: z.number().int().nonnegative(),
});
```

- [ ] **Step 2: Write the failing route tests**

Create `apps/server/src/routes/sessions.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import { Hono } from 'hono';

import { createSessionStore } from '../store/sessionStore';
import { createSessionsRouter } from './sessions';

function makeQuestion(n: number): Question {
  return {
    id: `q${n}`,
    type: 'multiple_choice',
    vocab_entry_id: `v${n}`,
    question: `word ${n}`,
    options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
    correct_option: 0,
  };
}

const POOL: Question[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

function buildTestApp() {
  const app = new Hono();
  app.route('/api/sessions', createSessionsRouter(createSessionStore(), POOL));
  return app;
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions', () => {
  it('creates a session and returns the first question', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { user_id: 'u1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.session_id).toBe('string');
    expect(body.position).toEqual({ position: 1, total: 10 });
    expect(body.question.id).toBeDefined();
  });

  it('rejects a missing user_id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', {});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sessions/:id/next-step', () => {
  it('404s for an unknown session id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions/does-not-exist/next-step', {
      user_id: 'u1',
      question_id: 'q0',
      option_index: 0,
    });
    expect(res.status).toBe(404);
  });

  it('advances to the next question on a fresh answer', async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();

    const res = await postJson(app, `/api/sessions/${created.session_id}/next-step`, {
      user_id: 'u1',
      question_id: created.question.id,
      option_index: created.question.correct_option,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(false);
    expect(body.position).toEqual({ position: 2, total: 10 });
    expect(body.question.id).not.toBe(created.question.id);
  });

  it('replays the same response when the same step is retried', async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();
    const stepBody = {
      user_id: 'u1',
      question_id: created.question.id,
      option_index: created.question.correct_option,
    };

    const first = await (
      await postJson(app, `/api/sessions/${created.session_id}/next-step`, stepBody)
    ).json();
    const retry = await (
      await postJson(app, `/api/sessions/${created.session_id}/next-step`, stepBody)
    ).json();
    expect(retry).toEqual(first);
  });

  it("409s when question_id does not match the session's current question", async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();

    const res = await postJson(app, `/api/sessions/${created.session_id}/next-step`, {
      user_id: 'u1',
      question_id: 'not-the-current-question',
      option_index: 0,
    });
    expect(res.status).toBe(409);
  });

  it('completes the session on the 10th answer, returning score and missed_questions', async () => {
    const app = buildTestApp();
    let current = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();

    let last;
    for (let i = 0; i < 10; i++) {
      last = await (
        await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
          user_id: 'u1',
          question_id: current.question.id,
          option_index: current.question.correct_option,
        })
      ).json();
      current = last;
    }

    expect(last.complete).toBe(true);
    expect(last.question).toBeNull();
    expect(last.score).toEqual({ correct: 10, total: 10 });
    expect(last.missed_questions).toEqual([]);
  });

  it('tracks an incorrect answer in the final score and missed_questions', async () => {
    const app = buildTestApp();
    let current = await (await postJson(app, '/api/sessions', { user_id: 'u1' })).json();
    const firstQuestion = current.question;
    const wrongIndex = (firstQuestion.correct_option + 1) % firstQuestion.options.length;

    let last = await (
      await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
        user_id: 'u1',
        question_id: current.question.id,
        option_index: wrongIndex,
      })
    ).json();
    current = last;

    for (let i = 1; i < 10; i++) {
      last = await (
        await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
          user_id: 'u1',
          question_id: current.question.id,
          option_index: current.question.correct_option,
        })
      ).json();
      current = last;
    }

    expect(last.score).toEqual({ correct: 9, total: 10 });
    expect(last.missed_questions).toEqual([
      {
        question: firstQuestion,
        correct_answer: firstQuestion.options[firstQuestion.correct_option],
      },
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm test --workspace apps/server
```

Expected: FAIL — `Cannot find module './sessions'`.

- [ ] **Step 4: Implement the sessions router**

Create `apps/server/src/routes/sessions.ts`:

```ts
import type { CreateSessionResponse, NextStepResponse, Question } from '@lang-tutor/core/api';
import { Hono } from 'hono';

import {
  currentQuestion,
  missedQuestions,
  newSessionRecord,
  positionOf,
  sessionScore,
  step,
  type SessionRecord,
} from '../session';
import type { SessionStore } from '../store/sessionStore';
import { CreateSessionRequestSchema, NextStepRequestSchema } from './schemas';

function buildNextStepResponse(sessionId: string, record: SessionRecord): NextStepResponse {
  if (record.complete) {
    return {
      session_id: sessionId,
      question: null,
      position: positionOf(record),
      complete: true,
      score: sessionScore(record),
      missed_questions: missedQuestions(record),
    };
  }
  return {
    session_id: sessionId,
    question: currentQuestion(record)!,
    position: positionOf(record),
    complete: false,
  };
}

export function createSessionsRouter(store: SessionStore, questionPool: readonly Question[]) {
  const router = new Hono();

  router.post('/', async (c) => {
    const parsed = CreateSessionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

    const record = newSessionRecord(parsed.data.user_id, questionPool);
    const sessionId = store.insert(record);
    const response: CreateSessionResponse = {
      session_id: sessionId,
      question: currentQuestion(record)!,
      position: positionOf(record),
    };
    return c.json(response);
  });

  router.post('/:id/next-step', async (c) => {
    const sessionId = c.req.param('id');
    const record = store.get(sessionId);
    if (!record) return c.json({ error: 'session not found' }, 404);

    const parsed = NextStepRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

    const outcome = step(record, parsed.data.question_id, parsed.data.option_index);
    if (outcome.status === 'invalid_question') {
      return c.json({ error: "question_id does not match the session's current question" }, 409);
    }

    let updated = outcome.record;
    if (outcome.status === 'advanced') {
      if (outcome.justCompleted) {
        updated = { ...updated, completed_at: Date.now() };
        // The one place a completed session is logged — exactly once, since a
        // retried next-step for an already-complete session takes the
        // 'replayed' branch above and never reaches here again.
        console.log(
          JSON.stringify({
            session_id: sessionId,
            user_id: updated.user_id,
            questions: updated.questions,
            answers: updated.answers,
            score: sessionScore(updated),
          }),
        );
      }
      store.set(sessionId, updated);
    }

    return c.json(buildNextStepResponse(sessionId, updated));
  });

  return router;
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npm test --workspace apps/server
npm run typecheck --workspace apps/server
```

Expected: PASS, 8 new tests (27 total in this workspace); `tsc` silent.

- [ ] **Step 6: Wire up `app.ts` and `index.ts`**

No new tests here — this is composition of already-tested pieces, verified by the manual run in Task 9 and, more immediately, by the Task 6 integration test that imports `createApp` directly.

Create `apps/server/src/app.ts`:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { mockQuestions } from './data/mockQuestions';
import { createSessionsRouter } from './routes/sessions';
import { createSessionStore } from './store/sessionStore';

export function createApp() {
  const app = new Hono();
  app.use('*', cors());
  const store = createSessionStore();
  app.route('/api/sessions', createSessionsRouter(store, mockQuestions));
  return app;
}
```

Create `apps/server/src/index.ts`:

```ts
import { serve } from '@hono/node-server';

import { createApp } from './app';

const port = Number(process.env.PORT) || 3001;

serve({ fetch: createApp().fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`lang-tutor server listening on http://0.0.0.0:${info.port}`);
});
```

- [ ] **Step 7: Smoke-test it by hand**

```bash
npm run server &
sleep 1
curl -s -X POST http://localhost:3001/api/sessions -H 'Content-Type: application/json' -d '{"user_id":"smoke-test"}'
kill %1
```

Expected: a JSON response with `session_id`, `question`, and `position: {"position":1,"total":10}`.

- [ ] **Step 8: Run the full monorepo suite**

```bash
npm test
npm run typecheck
```

Expected: 56 tests total (34 after Task 2, +9 from Task 3, +5 from Task 4, +8 from this task); `tsc` silent across every workspace.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/routes apps/server/src/app.ts apps/server/src/index.ts
git commit -m "Add Hono HTTP routes for create-new-session and next-step"
```

---

## Task 6: Real-HTTP integration test

**Files:**
- Create: `apps/server/tests/integration/session-flow.test.ts`

**Interfaces:**
- Consumes: `createApp` from `../../src/app`.

Deliberately outside `src/` — this isn't a unit test. It imports the app from `app.ts`, never `index.ts` (which would also bind the real configured port as an import side effect), starts it on an ephemeral port (`port: 0`) via `@hono/node-server`, and drives it with real `fetch` calls — a real socket, not `app.request()`'s in-process shortcut. This is the automated check that the documented wire contract is what the server actually produces, end to end, the same way a real client would use it: at each step it reads `correct_option` straight off the response (exactly what `apps/mobile`'s `useSession` will do in Task 8) rather than needing any test-only hook into the server's internals.

- [ ] **Step 1: Write the integration test**

Create `apps/server/tests/integration/session-flow.test.ts`:

```ts
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';

let server: ReturnType<typeof serve>;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: createApp().fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('integration: a full session over real HTTP', () => {
  it('creates a session, answers all 10 questions correctly, and completes with a perfect score', async () => {
    const created = await postJson('/api/sessions', { user_id: 'integration-user' });
    expect(created.status).toBe(200);
    expect(created.body.position).toEqual({ position: 1, total: 10 });

    let current = created.body;
    let last;
    for (let i = 0; i < 10; i++) {
      const res = await postJson(`/api/sessions/${current.session_id}/next-step`, {
        user_id: 'integration-user',
        question_id: current.question.id,
        option_index: current.question.correct_option,
      });
      expect(res.status).toBe(200);
      last = res.body;
      current = last;
    }

    expect(last.complete).toBe(true);
    expect(last.question).toBeNull();
    expect(last.score).toEqual({ correct: 10, total: 10 });
    expect(last.missed_questions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
npm test --workspace apps/server
```

Expected: PASS, 1 new test (28 total in this workspace), running alongside the unit and route tests with no extra configuration — Jest's default `testMatch` already covers `tests/**/*.test.ts` (verified in the Verified environment table above).

- [ ] **Step 3: Run the full monorepo suite**

```bash
npm test
npm run typecheck
```

Expected: 57 tests total; `tsc` silent.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests
git commit -m "Add real-HTTP integration test for a full session"
```

---

## Task 7: Client API layer — `api/client.ts`, `userId.ts`

**Files:**
- Create: `apps/mobile/src/api/{client.ts,client.test.ts}`
- Create: `apps/mobile/src/{userId.ts,userId.test.ts}`
- Create: `apps/mobile/.env.example`
- Modify: `apps/mobile/package.json` (new dependencies)

**Interfaces:**
- Consumes: `CreateSessionRequest`, `CreateSessionResponse`, `NextStepRequest`, `NextStepResponse` from `@lang-tutor/core/api` (Task 1).
- Produces:
  - `ApiError extends Error` with a `status: number` field, from `@/api/client`
  - `createSession(request: CreateSessionRequest): Promise<CreateSessionResponse>`
  - `nextStep(sessionId: string, request: NextStepRequest): Promise<NextStepResponse>`
  - `getOrCreateUserId(): Promise<string>` from `@/userId`

- [ ] **Step 1: Install the two new native dependencies**

Both are Expo-managed packages; `expo install` (not plain `npm install`) picks the version range compatible with this project's Expo SDK 57, the same way every other native dependency in `apps/mobile/package.json` was added.

```bash
cd apps/mobile && npx expo install @react-native-async-storage/async-storage expo-crypto && cd ../..
```

Expected: both packages added to `apps/mobile/package.json`'s `"dependencies"` with SDK-57-compatible version ranges, and the root's hoisted install updated (`npm install` may be needed afterward if `expo install` doesn't run it automatically — run `npm install` from the repo root if `apps/mobile/node_modules` was created).

- [ ] **Step 2: Create the env var template**

`.env.local` (not `.env` — see Deviations #4) is what a developer actually creates locally; it's already covered by the existing `.env*.local` `.gitignore` pattern in both the root and `apps/mobile`, so no `.gitignore` edit is needed.

Create `apps/mobile/.env.example`:

```
# Copy this file to .env.local and set it to your dev machine's LAN IP so a
# phone running Expo Go on the same Wi-Fi network can reach the server.
# The web target and simulators can keep using localhost.
EXPO_PUBLIC_API_URL=http://localhost:3001
```

- [ ] **Step 3: Write the failing tests for the API client**

Create `apps/mobile/src/api/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApiError, createSession, nextStep } from './client';

describe('api/client', () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.EXPO_PUBLIC_API_URL;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = 'http://example.test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.EXPO_PUBLIC_API_URL = originalBaseUrl;
  });

  it('createSession posts to /api/sessions with the request body', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        session_id: 's1',
        question: { id: 'q1' },
        position: { position: 1, total: 10 },
      }),
    }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await createSession({ user_id: 'u1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.test/api/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u1' }),
      }),
    );
    expect(result.session_id).toBe('s1');
  });

  it('nextStep posts to /api/sessions/:id/next-step with the request body', async () => {
    const responseBody = {
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      score: { correct: 10, total: 10 },
      missed_questions: [],
    };
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => responseBody }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await nextStep('s1', { user_id: 'u1', question_id: 'q1', option_index: 0 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.test/api/sessions/s1/next-step',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u1', question_id: 'q1', option_index: 0 }),
      }),
    );
    expect(result).toEqual(responseBody);
  });

  it('throws an ApiError carrying the response status when the request fails', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(createSession({ user_id: 'u1' })).rejects.toBeInstanceOf(ApiError);
    await expect(createSession({ user_id: 'u1' })).rejects.toMatchObject({ status: 404 });
  });

  it('throws when EXPO_PUBLIC_API_URL is not set', async () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    await expect(createSession({ user_id: 'u1' })).rejects.toThrow('EXPO_PUBLIC_API_URL');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
npm test --workspace apps/mobile
```

Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 5: Implement the API client**

Create `apps/mobile/src/api/client.ts`:

```ts
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  NextStepRequest,
  NextStepResponse,
} from '@lang-tutor/core/api';

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`API request failed with status ${status}`);
  }
}

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  // Read directly off process.env.EXPO_PUBLIC_API_URL (not via an
  // indirection) so Metro's build-time inlining for EXPO_PUBLIC_* variables
  // recognizes and replaces it in the real app bundle.
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is not set');
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ApiError(res.status);
  }
  return (await res.json()) as TResponse;
}

export function createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
  return postJson<CreateSessionResponse>('/api/sessions', request);
}

export function nextStep(sessionId: string, request: NextStepRequest): Promise<NextStepResponse> {
  return postJson<NextStepResponse>(`/api/sessions/${sessionId}/next-step`, request);
}
```

- [ ] **Step 6: Run it to verify it passes**

```bash
npm test --workspace apps/mobile
```

Expected: PASS, 4 new tests (16 total in this workspace).

- [ ] **Step 7: Write the failing tests for `userId`**

`@react-native-async-storage/async-storage` ships its own official Jest mock; this is the documented way to test code that uses it.

Create `apps/mobile/src/userId.test.ts`:

```ts
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getOrCreateUserId } from './userId';

describe('getOrCreateUserId', () => {
  it('creates and persists a UUID the first time it is called', async () => {
    const id = await getOrCreateUserId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(await AsyncStorage.getItem('lang-tutor:user-id')).toBe(id);
  });

  it('returns the same id on a second call instead of generating a new one', async () => {
    const first = await getOrCreateUserId();
    const second = await getOrCreateUserId();
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

```bash
npm test --workspace apps/mobile
```

Expected: FAIL — `Cannot find module './userId'`.

- [ ] **Step 9: Implement `userId.ts`**

Create `apps/mobile/src/userId.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const STORAGE_KEY = 'lang-tutor:user-id';

// A client-generated placeholder — no auth exists yet. Persisted so the same
// install keeps the same id across app restarts; unused server-side beyond
// appearing in the completion log line, groundwork for a future phase that
// ties sessions to a real identity.
export async function getOrCreateUserId(): Promise<string> {
  const existing = await AsyncStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await AsyncStorage.setItem(STORAGE_KEY, created);
  return created;
}
```

- [ ] **Step 10: Run it to verify it passes, then run the full suite**

```bash
npm test --workspace apps/mobile
npm test
npm run typecheck
```

Expected: 18 tests in `apps/mobile` (16 + 2 new); 63 tests across the whole monorepo (57 + 6); `tsc` silent everywhere.

- [ ] **Step 11: Commit**

```bash
git add apps/mobile/src/api apps/mobile/src/userId.ts apps/mobile/src/userId.test.ts apps/mobile/.env.example apps/mobile/package.json package-lock.json
git commit -m "Add mobile API client and persisted user_id"
```

---

## Task 8: Rewrite `useSession`, remove the client-side cursor and mock data

**Files:**
- Modify: `apps/mobile/src/strings.ts`, `apps/mobile/src/app/index.tsx`
- Modify (full rewrite): `apps/mobile/src/hooks/useSession.tsx`
- Delete: `apps/mobile/src/session.ts`, `apps/mobile/src/session.test.ts`, `apps/mobile/src/data/mockQuestions.ts`, `apps/mobile/src/data/mockQuestions.test.ts`

**Interfaces:**
- Consumes: `createSession`, `nextStep` from `@/api/client` (Task 7); `getOrCreateUserId` from `@/userId` (Task 7); `SESSION_LENGTH` from `@lang-tutor/core/domain`; `MissedQuestion`, `Question`, `Score` from `@lang-tutor/core/api`.
- Produces: `SessionProvider`, `useSession(): SessionValue` — **the exact same `SessionValue` shape as phase 1** (`hasSession`, `question`, `position`, `total`, `selectedOption`, `answered`, `complete`, `correctCount`, `missedQuestions`, `start`, `select`, `next`). No screen file changes as a result of this shape — see Deviation #3 for the one unrelated one-line import fix `index.tsx` still needs.

There is no failing-test step for this task: hooks have no automated tests in this codebase (phase 1: "There are no tests for the hook — phase 1 tests pure logic, not React"), so this task is verified by `tsc` plus the manual run in Task 9.

- [ ] **Step 1: Add the error-dialog strings**

Edit `apps/mobile/src/strings.ts`, adding three keys before the closing `} as const;` (drafts, same as every other string in this file — no native-speaker review yet):

```ts
  errorTitle: 'משהו השתבש',
  errorMessage: 'נתחיל שוב מההתחלה',
  errorAction: 'אישור',
```

- [ ] **Step 2: Fix the one import `@/session`'s removal breaks**

`apps/mobile/src/app/index.tsx` currently imports `SESSION_LENGTH` from `@/session`, which this task deletes. Same constant, same value — just its source. In `apps/mobile/src/app/index.tsx`, change:

```tsx
import { SESSION_LENGTH } from '@/session';
```

to:

```tsx
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
```

No other line in this file changes.

- [ ] **Step 3: Rewrite the hook**

Replace the entire contents of `apps/mobile/src/hooks/useSession.tsx`:

```tsx
import type { MissedQuestion, Question, Score } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';

import { createSession, nextStep } from '@/api/client';
import { strings } from '@/strings';
import { getOrCreateUserId } from '@/userId';

export type SessionValue = {
  hasSession: boolean;
  question: Question | undefined;
  position: number;
  total: number;
  selectedOption: number | null;
  answered: boolean;
  complete: boolean;
  correctCount: number;
  missedQuestions: MissedQuestion[];
  start: () => void;
  select: (optionIndex: number) => void;
  next: () => void;
};

// What the background next-step call resolved to, waiting to be applied when
// the learner taps Continue. Only one of these is ever in flight at a time,
// since `select` cannot fire again until a new question is on screen.
type Queued =
  | { complete: false; question: Question; position: number }
  | { complete: true; score: Score; missedQuestions: MissedQuestion[] };

type QuizState = {
  sessionId: string;
  userId: string;
  question: Question | undefined;
  position: number;
  total: number;
  selectedOption: number | null;
  complete: boolean;
  correctCount: number;
  missedQuestions: MissedQuestion[];
  queued: Queued | null;
  // Set when Continue is tapped before the background next-step call has
  // resolved. Applied the moment that call does resolve, so the learner
  // never has to tap Continue a second time.
  advanceRequested: boolean;
};

const SessionContext = createContext<SessionValue | null>(null);

function handleApiFailure() {
  Alert.alert(strings.errorTitle, strings.errorMessage, [
    { text: strings.errorAction, onPress: () => router.replace('/') },
  ]);
}

function applyQueued(current: QuizState, queued: Queued): QuizState {
  if (queued.complete) {
    return {
      ...current,
      question: undefined,
      complete: true,
      correctCount: queued.score.correct,
      missedQuestions: queued.missedQuestions,
      selectedOption: null,
      queued: null,
      advanceRequested: false,
    };
  }
  return {
    ...current,
    question: queued.question,
    position: queued.position,
    selectedOption: null,
    queued: null,
    advanceRequested: false,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Phase 2 still keeps a client-side copy of the current step for rendering,
  // but the server is now the source of truth for progress and scoring.
  const [state, setState] = useState<QuizState | null>(null);

  const start = useCallback(() => {
    void (async () => {
      try {
        const userId = await getOrCreateUserId();
        const response = await createSession({ user_id: userId });
        setState({
          sessionId: response.session_id,
          userId,
          question: response.question,
          position: response.position.position,
          total: response.position.total,
          selectedOption: null,
          complete: false,
          correctCount: 0,
          missedQuestions: [],
          queued: null,
          advanceRequested: false,
        });
      } catch {
        handleApiFailure();
      }
    })();
  }, []);

  // Reads `state` directly (and depends on it) rather than going through
  // setState's updater-function form, because the updater form is invoked
  // twice by React Strict Mode to catch exactly the kind of impurity that a
  // real network call inside it would be — nextStep must fire exactly once
  // per tap, so it stays outside any updater entirely.
  const select = useCallback(
    (optionIndex: number) => {
      if (!state || state.selectedOption !== null || !state.question) return;
      const { sessionId, userId, question } = state;

      setState((current) => (current ? { ...current, selectedOption: optionIndex } : current));

      // Fired in the background: correctness is already visible to the
      // learner from `question.correct_option` the moment this returns
      // (see MultipleChoiceView), so this call only has to register the
      // answer server-side and fetch what's next before Continue is tapped.
      void nextStep(sessionId, {
        user_id: userId,
        question_id: question.id,
        option_index: optionIndex,
      })
        .then((response) => {
          const queued: Queued = response.complete
            ? { complete: true, score: response.score, missedQuestions: response.missed_questions }
            : { complete: false, question: response.question, position: response.position.position };
          setState((latest) => {
            if (!latest || latest.sessionId !== sessionId) return latest;
            return latest.advanceRequested ? applyQueued(latest, queued) : { ...latest, queued };
          });
        })
        .catch(() => handleApiFailure());
    },
    [state],
  );

  const next = useCallback(() => {
    setState((current) => {
      if (!current) return current;
      return current.queued
        ? applyQueued(current, current.queued)
        : { ...current, advanceRequested: true };
    });
  }, []);

  const value = useMemo<SessionValue>(() => {
    if (!state) {
      return {
        hasSession: false,
        question: undefined,
        position: 0,
        total: SESSION_LENGTH,
        selectedOption: null,
        answered: false,
        complete: false,
        correctCount: 0,
        missedQuestions: [],
        start,
        select,
        next,
      };
    }
    return {
      hasSession: true,
      question: state.question,
      position: state.position,
      total: state.total,
      selectedOption: state.selectedOption,
      answered: state.selectedOption !== null,
      complete: state.complete,
      correctCount: state.correctCount,
      missedQuestions: state.missedQuestions,
      start,
      select,
      next,
    };
  }, [state, start, select, next]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return value;
}
```

- [ ] **Step 4: Delete the client-side cursor and mock data**

```bash
git rm apps/mobile/src/session.ts apps/mobile/src/session.test.ts \
       apps/mobile/src/data/mockQuestions.ts apps/mobile/src/data/mockQuestions.test.ts
```

- [ ] **Step 5: Type-check and run the tests**

```bash
npm run typecheck
npm test
```

Expected: `tsc` silent across every workspace. 51 tests total (17 core + 28 server + 6 mobile — mobile drops from 18 to 6 as the 7 `session.test.ts` and 5 `mockQuestions.test.ts` tests are removed, net of Task 7's +6).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/strings.ts apps/mobile/src/app/index.tsx apps/mobile/src/hooks/useSession.tsx
git commit -m "Rewrite useSession to call the server; remove the client-side cursor and mock data"
```

---

## Task 9: Manual end-to-end verification, README

**Files:**
- Modify: `README.md`

Every layer up to this point has automated coverage; nothing so far has actually run the server and the app together. This task is that check — the same role phase 1's "run the app and confirm mirroring" step played — plus documenting the new two-process workflow.

- [ ] **Step 1: Start the server**

```bash
npm run server
```

Expected: `lang-tutor server listening on http://0.0.0.0:3001` (or whatever `PORT` is set to), no errors.

- [ ] **Step 2: Play a full session on the web target**

In a second terminal:

```bash
npm run mobile
```

Press `w`. Expected, all of the following:

1. Home screen loads exactly as in phase 1 (title, Hebrew subtitle, `10 מילים באנגלית` card, blue `התחל` button) — nothing here should look different.
2. Tapping start navigates to the Session screen with a real question from the server (not the old hardcoded mock set — cross-check a prompt against `apps/server/src/data/mockQuestions.ts` if in doubt).
3. Tapping an option shows correct/wrong feedback **immediately** — no visible loading delay, since correctness is computed from the question payload already on the client, not the network call.
4. Tapping "Continue" advances to the next question with no visible loading delay either (the next question was already fetched in the background while the feedback banner was showing).
5. After the 10th question, tapping "Continue" navigates to the Results screen showing a score and, for any wrong answers, a missed-questions list — both must match what was actually answered during the session.
6. "תרגל שוב" (practise again) starts a fresh session (a new `session_id` — check the server's terminal output, which now shows two completion log lines after this second run finishes) and "סיום" returns to Home.

- [ ] **Step 3: Confirm the error path**

With the app still on a question screen mid-session, stop the server (`Ctrl+C` in its terminal), then tap an option. Expected: the native "משהו השתבש" alert appears; tapping "אישור" returns to the Home screen. Restart the server (`npm run server`) before continuing.

- [ ] **Step 4: Play a session on a physical device via Expo Go**

Mirrors phase 1's device workflow, with the LAN setup this phase adds:

```bash
# Find your machine's LAN IP (macOS):
ipconfig getifaddr en0
```

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
# then edit apps/mobile/.env.local, replacing localhost with the LAN IP just found
```

Restart `npm run mobile` (env files are only read at Metro startup), scan the QR code with Expo Go on a phone connected to the **same Wi-Fi network** as the dev machine, and play through a full session exactly as in Step 2. Expected: identical behavior to the web target — this confirms `0.0.0.0` binding and the LAN `EXPO_PUBLIC_API_URL` both work together.

- [ ] **Step 5: Replace the root README**

Replace the contents of `README.md`:

````markdown
# lang-tutor

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 ran entirely on mock data with a single multiple-choice question type. Phase 2
adds a server: it creates sessions, tracks progress, scores answers, and logs each
completed session — all in memory, no database yet. The learner-facing app is unchanged.

- Phase 1: [design](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md) · [plan](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)
- Phase 2: [design](docs/superpowers/specs/2026-08-26-lang-tutor-phase-2-design.md) · [plan](docs/superpowers/plans/2026-08-26-lang-tutor-phase-2.md)

## Layout

An npm-workspace monorepo.

| Path | What it is |
|---|---|
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). No runtime dependencies. Consumed as TypeScript source, so there is no build step. |
| `apps/mobile` | The Expo app. Screens, components, theme, Hebrew copy, and the API client. |
| `apps/server` | A Hono server on `@hono/node-server`. In-memory session state — no database. Owns the question pool and the quiz's progress; the app talks to it over HTTP. Also consumed as TypeScript source via `tsx`, no build step. |

`utils/` is not in core's `exports` map, so it is unreachable from either app by
design. Anything a consumer needs comes from `@lang-tutor/core/api` (types) or
`@lang-tutor/core/domain` (rules) — both `apps/mobile` and `apps/server` import them.

## Running it

Two processes: the server, then the app.

```bash
npm install       # from the repo root — it owns dependency resolution
npm run server    # terminal 1 — binds 0.0.0.0:3001 by default
npm run mobile    # terminal 2
```

Then press `w` for the browser, or scan the QR code with Expo Go on a phone. The
interface is Hebrew and right-to-left; browser and native RTL are not identical, so
confirm layout on a real device.

**Testing on a physical device:** the phone needs a real IP to reach the server —
`localhost` only works for the web target and simulators, which share the dev machine's
network namespace.

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
# edit apps/mobile/.env.local: set EXPO_PUBLIC_API_URL to your dev machine's LAN IP
# (macOS: ipconfig getifaddr en0), then restart `npm run mobile`
```

Phone and dev machine must be on the same Wi-Fi network.

## Checks

```bash
npm test          # every workspace, including apps/server's real-HTTP integration test
npm run typecheck # every workspace
```
````

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Update README for the two-process phase 2 workflow"
```

---
