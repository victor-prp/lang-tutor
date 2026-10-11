# Phase 35 — Question choosing: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use
> checkbox (`- [ ]`) syntax. Every task is TDD: failing test first, then code, then green, then commit.

**Goal:** A hidden FSRS-6 memory per gloss and dimension chooses each session's words, dimensions
and cards. Six bots play production hourly on their own day and report weekly in a GitHub issue.

**Architecture:** Pure model and grading in `packages/core/src/domain/`, used by the server and
the bots. The server chooses words at create time (`domain/choose.ts`) and cards in the prepare
job (`domain/plan.ts`, rewritten). A learner's day comes from `services/learnerDay.ts` only. The
bots are a new `bots/` workspace driven by `.github/workflows/bots.yml`.

**Tech stack:** TypeScript, Hono + zod-openapi, Drizzle + Postgres, pg-boss, Jest (server),
`node --test` (bots, like nightly-qa), Playwright (e2e), GitHub Actions, espeak-ng + ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-11-lang-tutor-phase-35-question-choosing-design.md`.
Every task's implementer reads the spec section named in the task, and decision numbers (D1–D23)
below refer to it.

## Global constraints

- Read `CLAUDE.md` and every ADR in `docs/adr/` before touching `apps/server` or `apps/mobile`.
  `npm run lint:arch` must pass after every task.
- Work only in this worktree: `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-35-question-choosing`.
  Never write to the main checkout, `/Users/victorprp/git/lang-tutor`.
- Never hardcode a port or database name (ADR 0006). Use `npm run …` scripts, which go through
  the lane wrapper.
- Domain code is pure: the day is passed in, and no clock or rng is read (ADR 0001 R3).
- Server unit tests go in `apps/server/src/**/*.test.ts`, integration tests in
  `apps/server/tests/integration/**` (ADR 0004). Run one integration file with
  `npm run test:integration -w apps/server -- --selectProjects=integration --runTestsByPath <path>`.
- Every route is declared with `createRoute` and schemas from `@lang-tutor/core/api/schemas`
  (ADR 0003). Better Auth is imported only in `apps/server/src/auth/betterAuth.ts` (ADR 0009 R1).
  `insert(users)` happens only in `src/repo/users.ts` (ADR 0009 R6).
- **Migration number.** The last migration on master is 0026, and phase 34's open branch adds
  0027. Generate this phase's migration with `npm run db:generate -w apps/server` as the next
  number. If phase 34 merges first, merge master and regenerate this one after it.
- The constants in D7 live in one file with the values given there.
- Commit messages follow `git log`: `feat(server): …`, `test(e2e): …`, `docs(adr): …`, and end
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **A learner with fewer than ten saved words, or with only new words.** The session must still
   be built: N = number of saved glosses, multiple choice for NEW. Pinned in Task 4.
2. **A device with speaking and listening off.** SR and SK are never chosen, and their backlog
   never fills a session after a device change (the cap of four). Pinned in Task 4.
3. **A second session on the same day.** It must avoid the first session's glosses while others
   exist, and memory must use the t = 0 rule. Pinned in Tasks 3 and 4.
4. **A bot name that is a learner's, or a wrong secret.** The route must answer 404 or 401 and
   never sign in a learner. Pinned in Task 7.
5. **A bot run dying halfway.** The bots that finished keep their day, and the rest repeat it.
   Nothing is skipped. Pinned in Task 9.

---

### Task 1: The learner's day, `practice_day`, the migration, and ADR 0013

Spec: D10, D11 (columns only), §5 Data, D23.

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`users.kind`, `users.bot_day`, `sessions.practice_day`,
  table `gloss_memory`), and the generated `apps/server/src/db/migrations/00NN_*.sql`, adding the
  backfill by hand.
- Create: `apps/server/src/services/learnerDay.ts` and its test.
- Modify: `apps/server/src/repo/users.ts` (`findDayContext`), `apps/server/src/repo/sessions.ts`
  (set `practice_day`), `apps/server/src/repo/progress.ts` (`findSessionEvidence` reads
  `s.practice_day`), `apps/server/src/services/sessions.ts` (set the day where a session ends:
  `completeSession`, and the skip).
- Create: `docs/adr/adr-0013-learner-day.md`, `scripts/check-adr-0013-learner-day.sh`.
- Test: `apps/server/tests/integration/services/learnerDay.test.ts`.

**Interfaces:**
- Produces: `learnerDay(repos, userId: string, now: number): Promise<string>`, which gives
  `YYYY-MM-DD`. It is the UTC date of `now` for `kind = 'learner'`, and `bot_day` for
  `kind = 'bot'`.
- Produces: the `gloss_memory` table. Its Drizzle export is `glossMemory`, with columns
  `enrollmentId, glossId, dimension, stability, difficulty, lastDay, reps, lapses, params`.
- Produces: `SessionEvidence.day`, now read from `sessions.practice_day`.

- [ ] Write a failing integration test: a learner's session ending at 2026-03-04T23:59Z gets
  `practice_day` 2026-03-04. A bot profile with `bot_day` 2030-01-09 ending a session gets
  2030-01-09. The level rule's gap counts that day: set up a gloss at level 2 stepped on
  2030-01-08, and expect a step on bot day 2030-01-09 but not on 2030-01-08.
- [ ] Edit `schema.ts`, run `npm run db:generate -w apps/server`, and append the backfill:
  `UPDATE sessions s SET practice_day = (SELECT ((max(a.answered_at)) AT TIME ZONE 'UTC')::date
  FROM answers a WHERE a.session_id = s.id) WHERE s.status IN ('completed','skipped');`.
  Add the checks: `users_kind_known`, and `users_bot_day_iff_bot`, which is
  `(kind = 'bot') = (bot_day IS NOT NULL)`. Run `npm run db:migrate`.
- [ ] Implement `learnerDay`. In the same transaction that ends a session, call it and write
  `practice_day`. Change `findSessionEvidence` to select `s.practice_day::text AS day`.
- [ ] Write ADR 0013 with the `create-adr` skill: R1, R2 and R3 as in D23. Write the check script
  in the style of `check-adr-0011-*.sh`. For each rule, plant a violation in a scratch file, see
  the script report it, then remove the plant.
- [ ] Run `npm test -w apps/server`, the integration tests for progress and sessions, and
  `npm run lint:arch`. All must be green. Commit.

### Task 2: The FSRS-6 model and grading table in core

Spec: D2, D3.

**Files:**
- Create: `packages/core/src/domain/memory.ts`, `packages/core/src/domain/memoryGrades.ts`, and
  their `*.test.ts`. Export both from `packages/core/src/domain/index.ts`.

**Interfaces (produces):**
```ts
export type Grade = 1 | 2 | 3;
export type MemoryState = { stability: number; difficulty: number; lastDay: string; reps: number; lapses: number; params: string };
export const FSRS6_DEFAULT: { id: 'fsrs6-default'; w: readonly number[] };
export function retrievability(state: MemoryState, day: string): number;   // R(t,S), t = whole UTC days
export function review(state: MemoryState | null, grade: Grade, day: string): MemoryState; // null = first review
export type GradedPiece = { dimension: Dimension; grade: Grade };
export type GradableAnswer = { type: QuestionType; correct?: boolean; verdict?: AnswerVerdict | 'gave_up' | 'skipped' };
export function gradesFor(answer: GradableAnswer): GradedPiece[];          // D3's table
export function dimensionsTested(type: QuestionType): Dimension[];          // the dimensions a card evidences on success
```
Match the verdict names to the existing `AnswerVerdict` in `@lang-tutor/core/api`. Read
`apps/server/src/domain/progress.ts` `evidenceFor` for the exact verdict strings, and mirror its
`switch` shape.

- [ ] Failing tests:
  - a first Good gives S = 2.3065;
  - Good on each due day, where due means the first day R < 0.9, gives intervals of 2, 11, 46
    and 163 days, within ±1 day;
  - Hard from S = 2.3065 at its due day gives about 8.1, and Again gives about 0.6;
  - a same-day Good never lowers S;
  - D stays clamped between 1 and 10;
  - every row of D3's table, one test each, including near miss, gave up, alternative and skipped.
- [ ] Implement the formulas exactly as written in D2, with `w` from D2.
- [ ] `npm test -w packages/core`, then `npm run typecheck`. Commit.

### Task 3: Memory written at session end, and the recompute

Spec: D4, D8.

**Files:**
- Create: `apps/server/src/repo/memory.ts`, with `findRows({ enrollmentId, glossIds })` and
  `upsertRows({ enrollmentId, rows })`. Register it in `composition.ts`'s `Repos`.
- Create: `apps/server/src/domain/memoryUpdate.ts`:
  `applySession(rows: MemoryRow[], answers: GradedAnswer[], day: string): MemoryRow[]`. It
  applies the answers in order, and within one day the first review of a row is long-term
  (t ≥ 1 rule, or `review(null…)`) and later ones use t = 0.
- Modify: `services/sessions.ts` `recordProgress` (after levels), `repo/progress.ts` (the
  evidence also returns what `gradesFor` needs), `db/progressRecompute.ts` (reset and replay
  memory too).
- Test: `apps/server/src/domain/memoryUpdate.test.ts`,
  `apps/server/tests/integration/services/sessionsMemory.test.ts`, and an extension of the
  recompute's existing integration test.

**Interfaces:**
- Consumes: `review`, `gradesFor` (Task 2), `SessionEvidence.day` (Task 1).
- Produces: `MemoryRow = { glossId; dimension; state: MemoryState }` and `repos.memory`.

- [ ] Failing tests:
  - ending a session writes memory rows for saved glosses only;
  - a failure after the level write rolls both back (inject a throwing memory repo through the
    test composition);
  - two sessions on one day: the second applies the t = 0 rule;
  - the recompute leaves memory equal to what the live path wrote, for a fixture of three
    sessions over two days.
- [ ] Implement. Run the unit and integration tests for sessions and progress, then
  `lint:arch`. Commit.

### Task 4: Choosing the words at create time

Spec: D5, D7, D10 (today, asked today, new today).

**Files:**
- Create: `apps/server/src/domain/chooseConstants.ts`, with D7's table verbatim.
- Create: `apps/server/src/domain/choose.ts` and `choose.test.ts`.
- Modify: `apps/server/src/domain/jobs.ts` (`PrepareSessionPayloadSchema.picks[]` gains
  `dimension` and `rung: 1 | 2`, plus `level` and `r: number | null` for the job's card choice),
  `services/sessions.ts` `createNextSession`, `repo/sessions.ts`
  (`findGlossesAnsweredOn(enrollmentId, day)`, `countNewOn(enrollmentId, day)`), and
  `domain/session.ts` (remove `pickGlosses` and `pickSenses` once unused, keeping the
  one-per-normalised-key rule inside `chooseWords`).

**Interfaces (produces):**
```ts
export type ChoiceInput = {
  saved: { glossId: string; key: string; savedAt: string }[];
  memory: { glossId: string; dimension: Dimension; state: MemoryState }[];
  levels: { glossId: string; dimension: Dimension; level: number }[];
  today: string; askedToday: ReadonlySet<string>; newToday: number;
  listening: boolean; speaking: boolean; rng: () => number;
};
export type ChosenPick = { glossId: string; dimension: Dimension; rung: 1 | 2; level: number; r: number | null; cls: 'DUE' | 'NEW' | 'EXPAND' | 'NOT_DUE' | 'ASKED' };
export function chooseWords(input: ChoiceInput): ChosenPick[];
```

- [ ] Failing unit tests, one each:
  - the class order;
  - DUE by need ascending;
  - at least two NEW when the cap allows, at most three per session, and the daily cap of 15;
  - glosses asked today come last;
  - at most four picks per dimension;
  - at most four hard picks;
  - SR and SK only when the device allows;
  - three saved words give three picks;
  - an all-NEW list;
  - one pick per normalised key;
  - a level-5 word with R below 0.9 is DUE.
- [ ] Wire `createNextSession`: read memory, levels, today (`learnerDay`), asked-today and
  new-today; call `chooseWords`; enqueue the picks with their new fields. The seed path is
  unchanged.
- [ ] Unit and integration tests for sessions, `lint:arch`. Commit.

### Task 5: Choosing the card in the prepare job

Spec: D6.

**Files:**
- Modify: `apps/server/src/domain/plan.ts`. Replace `planSession` and `TIERS` with
  `planCards(picks: PlanPick[], input: PlanInput): SessionPlan`, keeping the `SessionPlan` shape
  (`order`, `types`, `board`) and `boardPicks`. `PlanPick` gains `dimension`, `rung`, `level`
  and `r`. `PlanInput` becomes `{ listening; speaking }`, and the ordinal goes away.
- Modify: `apps/server/src/domain/plan.test.ts` (rewritten), and `services/sessions.ts`
  `prepareSession` (pass the new fields; stop reading the ordinal). Also `repo/sessions.ts`:
  remove `countListSessions` if nothing else uses it.

- [ ] Failing tests:
  - the rung table for each dimension;
  - `p = g + (1 − g)·R^e` picks the type nearest 0.85;
  - ties go to the least-used type;
  - at most four of one type;
  - an empty rung falls back to the other rung, then to multiple choice;
  - NEW gets multiple choice;
  - the board is built when four multiple-choice picks with distinct forms and meanings exist;
  - the order puts the highest p first and avoids the same type twice in a row;
  - read aloud only while SK is unintroduced or below level 2.
- [ ] Implement and wire. Unit tests, the prepare integration tests (`sessions.prepare`), and
  `lint:arch`. Commit.

### Task 6: e2e specs off the rotation

Spec: §6 e2e.

**Files:** `e2e/tests/support/cards.ts` (drop `CYCLE`; `generationStub` keys every type), and
a new `e2e/tests/support/memory.ts`. The specs:
- `question-types.spec.ts`
- `speaking.spec.ts`
- `listening-variety.spec.ts`
- `meaning-recall.spec.ts`
- `sentence-cards.spec.ts`
- `progress.spec.ts`
- `next-session.spec.ts`
- `session.spec.ts`

`support/memory.ts` exports `seedMemory(username, rows: {form, dimension, stability, difficulty,
lastDay, level}[])`. It writes `gloss_memory` and `gloss_progress` through `E2E_DATABASE_URL`,
the way `e2e/globalSetup.ts` opens a connection, so a spec gets the dimension and rung it needs.
It names the rows per spec.

- [ ] Run `npm run e2e` and list the failing specs.
- [ ] For each spec that tests a card type, seed memory so that type comes out (D6), and assert
  the type from the screen, not from a position cycle. Specs that test flows (results, next
  session) assert what they test without fixing types. Keep each spec's intent, written in its
  header comment.
- [ ] `npm run e2e` green twice in a row. Commit.

### Task 7: Bot profiles and the bot route

Spec: D11, D12.

**Files:**
- Modify: `apps/server/src/config.ts` (optional `BOT_SECRET`), `apps/server/src/app.ts` (mount
  only when it is set), `apps/server/src/composition.ts`.
- Create: `apps/server/src/routes/bots.ts`, `apps/server/src/services/bots.ts`, and schemas in
  `packages/core/src/api/schemas.ts`: `BotSignInRequestSchema { name }`,
  `BotSignInResponseSchema { cookie: string }`, `BotDayRequestSchema { name, day }`.
- Modify: `apps/server/src/auth/betterAuth.ts`. Add `mintSession(userId): Promise<string>`,
  which returns the full `Cookie` header value. Use `(await auth.$context).internalAdapter.createSession(userId)`
  and sign the token the way Better Auth signs its session cookie (`better-auth/crypto`
  `makeSignature`, cookie name from `ctx.authCookies.sessionToken.name`). Verify by reading
  `node_modules/better-auth`.
- Modify: `apps/server/src/repo/users.ts`: `findBotByName(name)`, `setBotDay(name, day)`, and
  `createBot({ name, email })`, which inserts the auth user and the profile with `kind = 'bot'`.
- Modify: `apps/server/src/db/cli.ts`: the command `bots:create <names…>`, and a script
  `db:bots:create` in `apps/server/package.json` and the root `package.json`. This replaces the
  spec's `bots/src/accounts.ts`, because ADR 0009 R6 keeps `insert(users)` in `repo/users.ts`.
  The PR body records the change.
- Test: `apps/server/tests/integration/routes/bots.test.ts`.

**Interfaces (produces):**
- `POST /api/bots/sign-in` takes `{ name }` and returns `{ cookie }`.
- `PUT /api/bots/day` takes `{ name, day }` and returns 204.
- Both need `Authorization: Bearer <BOT_SECRET>`. They answer 401 for a wrong secret and 404 for
  an unknown name or a learner.

- [ ] Failing tests:
  - without `BOT_SECRET` both paths answer 404;
  - a wrong secret answers 401;
  - a learner's name answers 404;
  - a bot's cookie then reads `/api/me` as that bot;
  - `PUT /api/bots/day` sets the day, and a retry with the same day is idempotent;
  - every call logs `bot_route`;
  - `db:bots:create` creates `.invalid` bot identities and is idempotent.
- [ ] Implement, using a constant-time compare (`crypto.timingSafeEqual` on equal-length
  buffers). Run the integration tests, `npm run lint:arch` (ADR 0013 R2 and R3 and ADR 0009 must
  pass), and the openapi test. Commit.

### Task 8: The bots workspace: memory, roster, answering

Spec: D13, D14, D15, D16 (decisions only, no I/O).

**Files:**
- Create: `bots/package.json` and `bots/tsconfig.json`, copied from `nightly-qa/` (no
  `@playwright/mcp`; add a dependency on `@lang-tutor/core`). Add `"bots"` to the root
  `workspaces`, then run `npm install`.
- Create: `bots/src/roster.ts` (D13), `bots/src/rng.ts` (seeded from name and day), and
  `bots/src/actr.ts`:
  `recall(traces, now, params, tauShift): number` and `addTrace(...)`.
- Create: `bots/src/fsrsBot.ts`, using `review` and `retrievability` from `@lang-tutor/core`.
- Create: `bots/src/answer.ts`:
  `decide(card, botMemory, savedWords, rng) → { kind: 'option', index } | { kind: 'text', text } | { kind: 'pass', pass: 'show_answer' } | { kind: 'speak', word: string }`.
  It also matches a card to its gloss, D16 step 1.
- Create: `bots/words/{en,ru,it}.txt`. Take 1,000 words each from hermitdave/FrequencyWords 2018
  `*_50k.txt`: skip the top 100, keep alphabetic words of three letters or more. The header gives
  the source and its CC-BY-SA-4.0 licence.
- Tests: `bots/src/*.test.ts` (`node --test`).

- [ ] Failing tests:
  - ACT-R recall against hand-computed values for one, two and three traces;
  - the four-option guessing floor;
  - transfer traces;
  - the same name and day give the same draws;
  - `decide` for each card type and outcome (choice, typed, near miss, gave up, speak);
  - an unmatchable card is marked unmatched.
- [ ] Implement. `npm test -w bots`, `npm run typecheck`. Commit.

### Task 9: The bots workspace: playing a day, state, the dry run

Spec: D16 (I/O), D17, D18, D19, §6 dry run.

**Files:**
- Create: `bots/src/api.ts`, a fetch client for the public API: enrollments, translations, save,
  sessions, answers, speech, and the bot route. Take the paths and shapes from
  `packages/core/src/api/schemas.ts`.
- Create: `bots/src/speech.ts`. It runs `espeak-ng -v <lang> --stdout <word> | ffmpeg -f wav -i -
  -c:a libopus -f webm -`. When espeak-ng is missing it returns null, the caller passes with
  `show_answer`, and the log records it.
- Create: `bots/src/state.ts`. It reads and writes `bots-state/<bot>/state.json` in a checkout of
  the orphan branch `bots-state`, which `git worktree add` places under `bots/.state` (ignored),
  and commits after each bot.
- Create: `bots/src/play.ts` (one bot's day: save words, sessions at simulated hours, answer
  cards, log), and `bots/run.ts` (all bots, `--dry-run`, `--days N`, `--bots a,b`, `--api URL`).
- Create: `bots/fixtures/words-{en,ru,it}.txt` (ten words each, for CI). Add MockServer
  expectations for them in a namespace `bots`, following `e2e/tests/support/mockServer.ts`.
- Modify: the root `package.json`, adding `bots:dry`, which runs
  `bash scripts/lane-env.sh tsx bots/run.ts --dry-run`.
- Modify: `.github/workflows/ci.yml`. The `test-e2e` job gets a step after e2e:
  `npm run bots:dry -- --days 1 --bots steady-en --words fixtures`, with `BOT_SECRET` set for
  that server.

- [ ] Failing tests, with a fake API:
  - one day of play makes the expected calls;
  - a failed request ends that bot's day and the run goes on;
  - a run that dies after bot 2 leaves bots 1–2 at the new day and the rest at the old one, and
    the next run repeats the day only for the rest;
  - an unheard speech answer takes `show_answer`.
- [ ] Implement. Run it locally against this lane: start the server with `BOT_SECRET` set
  (`npm run server`), create the bots (`npm run db:bots:create`), run
  `npm run bots:dry -- --days 3`, and read its output. Commit.

### Task 10: Reports, analysis, the weekly issue, the workflow, the runbook

Spec: D18, D20, D21, D22, the runbook in §5.

**Files:**
- Create: `bots/src/analysis.ts`, with the five numbers exactly as D21's table defines them.
- Create: `bots/src/report.ts`. It runs `claude -p --model sonnet --max-turns 3
  --output-format json` with no tools, parses `total_cost_usd` and the usage, tags them with
  bot, week and run id, and allows at most six calls per run.
- Create: `bots/src/issue.ts`, which writes through `gh` and renders the daily line, the closing
  comment and the label `bots`.
- Create: `.github/workflows/bots.yml`, modelled on `nightly-qa.yml`: cron `17 * * * *`,
  dispatch, `concurrency: bots`, a 30-minute timeout, the fork guard,
  `vars.BOTS_ENABLED == 'true'`, `apt-get install espeak-ng ffmpeg`, the secrets
  `BOT_SECRET` and `CLAUDE_CODE_OAUTH_TOKEN`, the variable `BOTS_API_URL`, and permissions
  `contents: write` and `issues: write`.
- Create: `docs/runbooks/bots.md`: start, stop, read the issue, rerun a day, reset a bot.
- Tests: `bots/src/analysis.test.ts`, `report.test.ts`, `issue.test.ts`.

- [ ] Failing tests:
  - each of the five numbers on a handmade log;
  - a week boundary triggers reports;
  - the seventh report call in one run is refused;
  - the cost is parsed from a recorded CLI JSON sample;
  - the daily line and closing table render to a fixed text.
- [ ] Implement. `npm test -w bots`, `npm run typecheck`, `npm run lint:arch`. Commit.

---

## Finishing

Run the whole branch: `npm run typecheck`, `npm run test:all`, `npm run lint:arch`,
`npm run e2e`. Then `git-create-pr`. The PR body has a **Left for Victor** section with the
commands for spec §"Left for Victor", in that order. Then `ci-green`.
