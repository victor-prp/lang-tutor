# Phase 62c — Gap card rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gap to choose (`cloze_choice`) that validation refuses, or that the checker leaves fewer
than three wrong options, is rewritten once with feedback, and kept when the rewrite passes.

**Architecture:** Pure decisions (which cards, what feedback, the rewrite items) in a new
`domain/gapRewrite.ts`. The batch prompt builder adds the rewrite rule only to a call that carries a
rewrite item. `prepareSession` runs the gap check beside the word-map call, rewrites, then runs the
final checker beside a second word-map call for the rewritten cards. The eval's gap runner calls
the same domain functions.

**Tech Stack:** TypeScript, Jest (unit and service buckets), Gemini via `LlmClient`, `tsx` evals.

**Spec:** `docs/superpowers/specs/2026-10-18-lang-tutor-phase-62c-gap-card-rewrite-design.md`

## Global Constraints

- The batch prompt as the main generation call sends it stays byte-for-byte today's (spec anti-goal).
- Never lower `TIER2_THRESHOLD`, loosen an eval assertion, or skip or delete a case.
- Model calls run with no transaction open (ADR 0001 R8); `domain/` imports `@lang-tutor/core/*` only (R3).
- New call kinds: `gap_check` (checker's prompt, own client), `gap_rewrite` (batch prompt, own client,
  `SESSION_GENERATION_THINKING`); the second word-map call is `context`.
- Each new call adds its budget to `PREPARE_SESSION_CALL_BUDGETS_MS`, the second word-map call included.
- A rescue that fails never fails the attempt; a card that fails twice is refused as today.
- Run commands from `apps/server` in the worktree; tests directly (`npx jest …`), no `bash -c` wrapper
  (memory `task-done-no-bash-c`); evals as `npx tsx tests/eval/run.ts <filter>`.

## Review Focus

1. A session whose only gap card is rewritten and whose second word-map call fails: the card is written
   without a map, not dropped (Task 3 test).
2. A gap check that miscounts one card and judges another: the miscounted card goes to the final
   checker, the judged one does not (Task 3 test).
3. A rewrite answer whose wrong option is another item's right answer: validation refuses it, the
   card keeps its original refusal (Task 1 test on `rewriteOthers`, Task 3 test).
4. A question-types session whose rewritten card the final checker still refuses: kept as the
   ambiguous card with the rewritten sentence, not the old one (Task 3 test).
5. A rewrite answer that returns keys it was not asked: ignored, as validation ignores them today
   (covered by `validateDistractors`; Task 3 asserts only asked keys change).

---

### Task 1: The rewrite's prompt and its pure decisions

**Files:**
- Modify: `apps/server/src/domain/distractors.ts` (`DistractorItem`, `buildDistractorPrompt`)
- Create: `apps/server/src/domain/gapRewrite.ts`
- Test: `apps/server/src/domain/distractors.test.ts`, `apps/server/src/domain/gapRewrite.test.ts`

**Interfaces:**
- Produces, in `distractors.ts`:
  - `export type GapRewrite = { sentence: string | null; fits: string[]; problem: string | null }`
  - `DistractorItem.rewrite?: GapRewrite`
  - `export const REWRITE_MARKER = 'its last sentence'` (a phrase of the rewrite rule, for tests and MockServer)
- Produces, in `gapRewrite.ts`:
  - `export type GapFault = { key: string; stage: 'validation' | 'checker'; rewrite: GapRewrite }`
  - `export type GapJudged = ReadonlyMap<string, { options: string[]; alsoRight: boolean[] }>`
  - `export function gapCheckItem(key: string, sentence: SentenceContent, options: string[]): CheckItem`
  - `export function gapFaults(input: { items: readonly DistractorItem[]; answer: LlmDistractors | null; verdict: DistractorVerdict; judged: GapJudged | null }): GapFault[]`
  - `export function rewriteItems(items: readonly DistractorItem[], faults: readonly GapFault[]): DistractorItem[]`
  - `export function rewriteOthers(items: readonly DistractorItem[], faults: readonly GapFault[], others: readonly OtherRow[]): OtherRow[]`

- [ ] **Step 1: Capture today's prompt for the byte check.** In a scratchpad script (not committed),
  print `JSON.stringify(buildDistractorPrompt(input))` for a fixture with a gap, a sentence, a
  translate, a meaning and a word item and learner words; save the output from the unchanged code.

- [ ] **Step 2: Write the failing tests.**
  - `distractors.test.ts`, describe `buildDistractorPrompt (phase 62c)`:
    - `a prompt with no rewrite item says nothing of a rewrite`: `system` lacks `REWRITE_MARKER`, `user` has no `"rewrite"` key.
    - `a rewrite item carries its old sentence and what fit, and the rule is added`: `system` contains `REWRITE_MARKER`; the item's JSON has `rewrite: { old_sentence: 'Io ho un fratello qui ora.', fits: ['tavolo', 'amico'] }`; a validation one has `rewrite: { old_sentence, problem }`.
  - `gapRewrite.test.ts`:
    - `gapCheckItem blanks the gap`: sentence `Io ho un fratello qui ora.` gap 9–17 → `{ key, task: 'gap', sentence: 'Io ho un ___ qui ora.', options }`.
    - `a gap item validation refused is a validation fault with its old sentence and why`.
    - `a gap item the check left fewer than three is a checker fault naming what fit`: options `['tavolo','sorella','amico','casa','libro','gatto']`, alsoRight `[t,f,t,f,t,t]` → `fits: ['tavolo','amico','libro','gatto']`.
    - `a gap item the check left three or more, or did not judge, is no fault`; `judged: null` → validation faults only.
    - `a non-gap item is never a fault`.
    - `rewriteItems sets rewrite and adds the old sentence to avoid, once`; a fault with `sentence: null` adds nothing to `avoid`.
    - `rewriteOthers is the session's others and every item not rewritten`, as `{ form, translation }`.

- [ ] **Step 3: Run them to verify they fail.** `npx jest src/domain/gapRewrite.test.ts src/domain/distractors.test.ts` → FAIL (missing exports).

- [ ] **Step 4: Implement.** In `buildDistractorPrompt`, when any item has `rewrite`, add one line
  after the `"gap"` task line (exact wording is the builder's, judged in Task 4). It says: an item
  with `rewrite` was written before; its last sentence is `old_sentence`; `fits` are wrong answers
  that made it correct, or `problem` is why it was refused; write a new sentence for its word whose
  words around the gap rule those out (pointing first, then short, then `learner_words` wherever
  pointing allows; a word outside `learner_words` where pointing needs one, of any kind). Include
  the Italian example from the spec ("Mio fratello è qui ora." against *mio tavolo*). The item JSON
  gains `rewrite: { old_sentence, fits?, problem? }` only for such items. `gapFaults`: validation
  faults first, then checker faults, in item order; the old sentence of a refused item is its raw
  answer's `sentence` (null when none).

- [ ] **Step 5: Run the tests, then the byte check.** The jest command above → PASS. Re-run Step 1's
  script and `cmp` against the saved output → identical.

- [ ] **Step 6: Commit.** `feat(server): a gap item can carry a rewrite, and the faults that call for one`

### Task 2: The two clients, their budgets and the wiring

**Files:**
- Modify: `apps/server/src/services/llm.ts` (`ModelCallKind`), `src/domain/jobs.ts`, `src/config.ts`,
  `src/composition.ts`, `src/index.ts`, `src/services/sessions.ts` (deps only),
  `tests/support/serverDeps.ts`, `tests/integration/composition.test.ts`
- Test: `src/config.test.ts`; every `createSessionService` call in `src/services/sessions*.test.ts`

**Interfaces:**
- Produces: `GAP_CHECK_BUDGET_MS = 30_000`, `GAP_REWRITE_BUDGET_MS = 45_000` (provisional; Task 4
  sets them); `PREPARE_SESSION_CALL_BUDGETS_MS = [SESSION_GENERATION_BUDGET_MS, CONTEXT_CALL_BUDGET_MS,
  GAP_CHECK_BUDGET_MS, GAP_REWRITE_BUDGET_MS, CONTEXT_CALL_BUDGET_MS, CHECKER_CALL_BUDGET_MS]`;
  config `gapCheckTimeoutMs` (`GAP_CHECK_TIMEOUT_MS`), `gapRewriteTimeoutMs` (`GAP_REWRITE_TIMEOUT_MS`),
  each capped at its budget like `checkerCallTimeoutMs`; `createSessionService` deps `gapCheckLlm:
  LlmClient`, `gapRewriteLlm: LlmClient`; `ModelCallKind` adds `'gap_check' | 'gap_rewrite'`.

- [ ] **Step 1: Write the failing tests** in `config.test.ts`: the two defaults, env reads, cap and
  nonsense, as the checker's test does; the expiry test's sum and the budgets list updated to the
  list above.
- [ ] **Step 2: Run** `npx jest src/config.test.ts` → FAIL.
- [ ] **Step 3: Implement** the constants, config, composition clients (rewrite client with
  `thinkingBudget: SESSION_GENERATION_THINKING`), index wiring, serverDeps defaults, the service deps,
  and pass `createFakeLlmClient(new Error('no gap call expected'))`-style fakes in every service
  test's `createSessionService` call (prepare test: `opts.gapCheckReply ?? checking()`,
  `opts.rewriteReply ?? new Error('no rewrite expected')`, both returned from `world`).
- [ ] **Step 4: Run** `npx jest src/config.test.ts src/services` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit.** `feat(server): clients and budgets for the gap check and the rewrite`

### Task 3: prepareSession runs the gap check, the rewrite and the second word maps

**Files:**
- Modify: `apps/server/src/services/sessions.ts` (`prepareSession`)
- Test: `apps/server/src/services/sessions.prepare.test.ts`

**Interfaces:**
- Consumes: Task 1's `gapCheckItem`, `gapFaults`, `rewriteItems`, `rewriteOthers`; Task 2's clients.
- Produces: events `gap_check_failed` (`session_id`, `gap_check_ms`, `reason`) and `gap_rewritten`
  (`session_id`, `key`, `position` when written, `stage`, `reason`, `old_sentence`, `new_sentence` or
  `failed`); `session_prepared` gains `gap_check_ms`, `rewrite_ms`, `rewrite_count`.

- [ ] **Step 1: Move the existing gap tests.** The two tests near line 1827 that answer `q2`'s
  `gap_fits` through `checkReply` answer it through `gapCheckReply`; the all-true one also sets a
  rewrite reply that throws, and keeps today's refusal and reason.
- [ ] **Step 2: Write the failing tests**, describe `phase 62c: a gap card's one rewrite`:
  - `the gap check is asked while the word maps are still out`: a `contextLlm` that waits on a gate the
    `gapCheckLlm` opens; the test finishes (sequential calls would hang).
  - `a gap card the gap check passed is not asked again`: `checkerLlm` items have no `gap` item for `q2`.
  - `a card the gap check left short is rewritten, rechecked and written with its new sentence and map`:
    `gapRewriteLlm` asked once, its system has `REWRITE_MARKER`, record kind `gap_rewrite`; `contextLlm`
    asked twice, the second with `q2` only; the checker asked `q2`'s new sentence; the inserted
    `cloze_choice` has the new sentence and words; `gap_rewritten` logged with both sentences.
  - `a gap card validation refused is rewritten with why`.
  - `a rewrite that fails leaves the card refused as today and the session prepared`: rewrite throws;
    `card_dropped` with today's checker reason; `gap_rewritten` with `failed`.
  - `a gap check that fails sends its items to the final checker, and a validation refusal is still rewritten`.
  - `a card the gap check miscounted goes to the final checker` (Review Focus 2).
  - `a rewritten card whose second word map fails is written without a map` (Review Focus 1).
  - `a rewrite whose wrong option is another item's answer keeps the original refusal` (Review Focus 3).
  - `a question-types session keeps a rewritten card the checker still refuses, with its new sentence` (Review Focus 4).
  - `a session with no gap card asks no gap check`; `session_prepared` has `rewrite_count: 0`.
- [ ] **Step 3: Run** `npx jest src/services/sessions.prepare.test.ts` → the new tests FAIL.
- [ ] **Step 4: Implement**, keeping today's order of everything else:
  - keep the batch's raw answer outside its `try`; move `candidatesOf` above the word-map call;
  - extract the context call into `askContext(items: ContextItem[])` (its logging unchanged) and the
    per-card map/context step into a function applied per card, so a rewritten card's can be redone;
  - `Promise.all` the word-map call and the gap check (`gapCheckLlm`, `record('gap_check')`,
    `buildCheckPrompt` of the unrefused `cloze_choice` cards' `gapCheckItem`s); an empty or
    unreadable answer, or a throw, is `gap_check_failed` and `judged: null`;
  - `gapFaults` → one rewrite call (`gapRewriteLlm`, `record('gap_rewrite')`, `buildDistractorPrompt`
    with `rewriteItems`, `rewriteOthers` and the learner words) → `validateDistractors` on it with the
    same others; a rescued card replaces its `verdict` entry, loses its refusal and gets a fresh
    context item; a checker fault not rescued is refused at `checker` with today's message;
  - the final checker skips the `gap` items the gap check judged and kept, and runs beside the
    second `askContext` for the rescued cards; the gap check's findings for unrescued cards join
    `findings`, so survivors and the ambiguous card read them as today.
- [ ] **Step 5: Run** `npx jest src/services` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 6: Commit.** `feat(server): a gap card the checker refuses gets one rewrite`

### Task 4: The eval runs the same rescue

**Files:**
- Modify: `apps/server/tests/eval/run.ts` (`scoreSentences`, `survivesChecker`, `sentenceTier1` callers),
  `apps/server/tests/eval/askModel.ts` (`askDistractors` takes optional `others`), `src/domain/jobs.ts`
  (measured budgets), `src/config.test.ts` if values move

**Interfaces:**
- Consumes: Task 1's functions; `askCheck`, `askDistractors`.

- [ ] **Step 1: Restructure the gap path.** For a `checked` gap case: validate the first answer, ask
  the gap check of its gap items (`gapCheckItem`), `gapFaults`, one rewrite through `askDistractors`
  on `sessionLlm` with `rewriteItems`/`rewriteOthers` and the case's learner words, validate it, and
  check the rescued items again. Build the answer the cards would show (rescued items replaced).
  - tier 1: `sentenceTier1` on the **first** answer, unchanged, plus each rewritten item's
    "every wrong option is in script" on the rewrite's answer;
  - tier 2: survivors, list share and the rest on the shown answer; an item with no card after the
    rescue is a failed survivor check (not skipped);
  - the row prints both sentences of a rewritten item, and each call's ms.
  The distractor (`words`) cases' `survivesChecker` path stays as it is.
- [ ] **Step 2: Typecheck** `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 3: Run the gap group three times.** `npx tsx tests/eval/run.ts "gap "` ×3 → gap tier 2 ≥ 14/16
  each time, tier 1 clean. Note the slowest gap check and rewrite ms.
- [ ] **Step 4: Set the budgets** to about three times the slowest seen, between 20 and 60 s; update
  `config.test.ts` if the values moved; `npx jest src/config.test.ts` → PASS.
- [ ] **Step 5: Run the full suite twice** (`npx tsx tests/eval/run.ts`) and compare every row with
  master's reports (`/private/tmp/claude-501/-Users-victorprp-git-lang-tutor/536c8737-f517-434c-8d1a-fa8965ea1951/scratchpad/logs/full-master-*.log`).
  Only the gap rows may differ beyond master's own run-to-run noise. If the list-share check now
  fails where the checker's did, stop and record it for Victor; do not loosen either.
- [ ] **Step 6: Commit.** `test(eval): the gap runner rescues a card as production does`

### Task 5: Whole-suite checks and the spec's record

**Files:**
- Modify: the spec's status line and a rulings entry for what Task 4 measured

- [ ] **Step 1: Run** `npx jest` (unit), `npx tsc --noEmit -p .`, `../../scripts/check-adrs.sh` → PASS.
- [ ] **Step 2: Run** `npm run test:integration` from the worktree root if the lane's database is up;
  else leave it to CI and say so → PASS.
- [ ] **Step 3: Record** the measured budgets and the eval results in the spec; commit
  `docs(spec): phase 62c records the measured budgets and the eval runs`.
