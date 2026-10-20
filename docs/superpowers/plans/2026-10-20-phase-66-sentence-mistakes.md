# Phase 66 — Sentence mistakes, explained, not graded: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor: "go till PR", inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the translation judge grades the practised word only, and a new explain call, endpoint and
הסבר button show the sentence's mistakes without grading them.

**Architecture:** a pure prompt module (`domain/explain.ts`) beside `judge.ts`; a service method
`explainAnswer` (read txn → model call → write txn) on the sessions service, exposed as `POST
/api/sessions/{id}/explain`; a table `answer_explanations`; an app component mounted in the
translation card's reference block that fetches on mount and shows on tap.

**Tech Stack:** Hono + zod-openapi, Drizzle/Postgres, Gemini, Expo/React Native, Jest, Playwright, MockServer.

**Spec:** `docs/superpowers/specs/2026-10-20-lang-tutor-phase-66-sentence-mistakes-design.md`

## Global Constraints

- The explain call never blocks the grade or "continue"; the card works as today when it fails.
- The explain response schema has required fields only: `corrected`, `mistakes[{wrong,right,why}]`, at most 6.
- Explain's prompt marker is its own (`EXPLAIN_MARKER`) and must not contain JUDGE_MARKER's text.
- Model call outside any transaction (ADR 0001 R8); actor authorized (ADR 0009 R7); wire types inferred from zod (ADR 0003).
- UI copy, Hebrew: `הסבר`, `המשפט שלך, מתוקן:`, `המשפט שלך נכון`, `מכין הסבר…`, `ההסבר לא זמין כרגע`.
- No `API_LEVEL` bump. Never lower an eval threshold; judge case expectations change only as the spec's D1 lists.
- Lanes are full: unit, typecheck, lint:arch and evals locally; integration and e2e in CI (push early).

## Review Focus

1. Explain asked for a card whose second try is pending → 409, no call (Task 3 test).
2. Two overlapping explain requests → one stored row, both answered with it (Task 3 test: second request replays).
3. Explain asked before the card is answered → 400, no call (Task 3 test).
4. The learner's final text equal to the reference up to case/full stop → no button, and the server answers no mistakes without a call (Task 3, Task 4 tests).
5. Leaving the card while the explain request is in flight → no state update on the next card (Task 4: the component owns its state; unmount ignores the late result).

---

### Task 1: The judge grades the practised word only

**Files:** Modify `apps/server/src/domain/judge.ts` (`buildTranslationJudgePrompt`), `apps/server/tests/eval/cases.ts` (`TRANSLATION_JUDGE_CASES`); Test `apps/server/src/domain/judge.test.ts`.

- [ ] Unit test: the translation judge system prompt does not contain `"Any other detail of the sentence changed or left out"` and does contain `"ignore everything else in the answer"`.
- [ ] Rewrite the prompt's rules as spec D1 (right / misspelled / other_word / wrong around the word).
- [ ] Change the cases per D1: `prenotare una camera per tre` → exact, `book a table for four` → exact, `Он бегает.` → exact, `talk with everyone` → alternative; add the word-right-many-mistakes cases (it/ru/en, exact) and wrong-person/tense cases (wrong).
- [ ] Run `npx jest src/domain/judge.test.ts` (PASS) and `npx tsx tests/ev?l/run.ts "tjudge "`-style filter for the translation judge group twice; every row passes both runs.
- [ ] Commit `feat(server): phase 66 the translation judge grades the practised word only`.

### Task 2: The explain prompt and its parser

**Files:** Create `apps/server/src/domain/explain.ts`, `apps/server/src/domain/explain.test.ts`; Modify `packages/core/src/api/schemas.ts` (+ `types.ts`): `LlmSentenceExplainSchema`, `ExplainRequestSchema` (`{ question_id }`), `ExplainResponseSchema` (`{ corrected, mistakes }`), `SentenceMistakeSchema`.

**Interfaces — Produces:**
- `EXPLAIN_MARKER: string`
- `buildExplainPrompt(question: SentenceTranslationQuestion, context: JudgeContext, answer: string): { system; user; schema }`
- `parseExplain(raw: string): Explanation | null` where `Explanation = { corrected: string; mistakes: SentenceMistake[] }`, mistakes sliced to `MAX_MISTAKES = 6`
- `explainRuleResult(reference: string, text: string): Explanation | null` — `{ corrected: text, mistakes: [] }` for empty or reference-as-typed (`normaliseTyped`), else null
- `EXPLAIN_THINKING: number`

- [ ] Unit tests: prompt carries hebrew_sentence, reference_translation, word, meaning, answer and EXPLAIN_MARKER and not JUDGE_MARKER; parser reads a good body, returns null on bad JSON / missing field, caps at 6; rule result for empty, reference with other case/full stop, and null otherwise.
- [ ] Implement; schema in core with required strings only.
- [ ] Add the eval group (`explain ` labels) in `tests/eval/cases.ts` + `askModel.ts` + `run.ts`: per it/ru/en one sentence with known mistakes (expected fix substring in some `right` or `corrected`), one valid paraphrase (no mistakes); every `why` has Hebrew letters. Its client in `run.ts` built as composition will build it.
- [ ] Run unit tests, `npx tsc --noEmit` in server and core, and the `explain ` group twice; measure the thinking budget (start 512) so calls stay well inside the judge timeout.
- [ ] Commit `feat(server): phase 66 the explain prompt, its parser and evals`.

### Task 3: The table, the service method and the endpoint

**Files:** Modify `apps/server/src/db/schema.ts` (+ migration `0047_answer_explanations.sql` (0046 was taken by phase 65b) via drizzle-kit generate), `apps/server/src/repo/sessions.ts` (`findExplainContext`, `insertExplanation`, `findExplanation`), `apps/server/src/services/sessions.ts` (`explainAnswer`), `apps/server/src/composition.ts` (`explainer` client), `apps/server/src/routes/sessions.ts` (`explainRoute`), test support `tests/support/mockServer.ts` (`expectExplain(ns, body | { status })`); Create `apps/server/tests/integration/routes/sessions.explain.test.ts`.

**Interfaces — Produces:** `sessions.explainAnswer(actorUserId, sessionId, { questionId }): Promise<Explanation>`; errors: `SessionNotFound` 404, `AnswerKindMismatch` 400 (not a translation, or not answered), `RetryPending` (new, 409), `LlmUnavailable` 502; route `POST /sessions/{id}/explain` → 200 `ExplainResponse`.

- [ ] Integration tests (sessions.explain.test.ts): reference-as-typed → no mistakes, 0 Gemini calls; a mistaken answer → the stub's body, one row stored, one call; same request again → same body, still one call; after a resolved second try the retry's text is explained (check the stored `text`); pending retry → 409; typed_meaning card → 400; unanswered translation card → 400; another learner → 403; failed stub → 502 and no row.
- [ ] Table `answer_explanations(session_id uuid, position int, text text not null, corrected text not null, mistakes jsonb not null, created_at timestamptz default now())`, PK and cascading FK `(session_id, position)` → `answers`.
- [ ] Repo primitives, service method per spec D2, route + openapi entry; `explainer` client (judge timeout, `EXPLAIN_THINKING`, record kind `sentence_explain`).
- [ ] Run `npx jest --selectProjects=unit` in server, `npx tsc --noEmit`, `./scripts/check-adrs.sh`; regenerate whatever openapi snapshot `openapi.test.ts` checks. Push the branch so CI runs integration.
- [ ] Commit `feat(server): phase 66 POST /sessions/:id/explain, stored per answer`.

### Task 4: The הסבר button in the app

**Files:** Modify `apps/mobile/src/api/client.ts` (`explainAnswer(sessionId, { question_id })`, judge timeout), `apps/mobile/src/strings.ts`, `apps/mobile/src/app/session.tsx` (`translatePrompt` reference block); Create `apps/mobile/src/components/SentenceExplain.tsx`, `apps/mobile/src/explain.ts` (`showsExplain(question, answerText): boolean`), tests beside them.

- [ ] Unit tests: `showsExplain` false for empty and reference-as-typed, true otherwise; component: shows the button, fetches once on mount, the tap shows loading → ready list (`corrected` + rows) / none (`המשפט שלך נכון`) / failed (`ההסבר לא זמין כרגע`); a second tap closes; a result arriving after unmount sets nothing.
- [ ] Implement; the final text comes from the session's answer (the retry's when there was one); testIDs `explain-button`, `explain-panel`, `explain-mistake`.
- [ ] Run mobile jest and `npx tsc --noEmit`.
- [ ] Commit `feat(mobile): phase 66 a הסבר button explains the sentence's mistakes`.

### Task 5: e2e and finish

**Files:** Modify `e2e/tests/support/mockServer.ts` (`stubExplain`), `e2e/tests/sentence-cards.spec.ts` (one test).

- [ ] e2e: answer a translation card with a non-reference sentence; `explain-button` visible; tap → `explain-mistake` shows the stub's `wrong → right`. Default explain stub registered where translation cards are answered, so no spec sees an unstubbed call.
- [ ] Push; CI runs it (no lane). Then `superpowers:finishing-a-development-branch` → `git-create-pr` → `ci-green`, with Left for Victor: release, and the migration runs at container start (ADR 0010).
