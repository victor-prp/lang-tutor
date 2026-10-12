# Phase 38 — Typed fill-in hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The typed fill-in card (`cloze_typed`) hides its Hebrew sentence behind a hint, accepts
words that fit the sentence read alone with a retry that opens the hint, and records whether the
hint was opened.

**Architecture:** The `sentence` generation task widens its alternatives (prompt + cap 10), so
`judgeTyped` already returns `alternative` and phase 34's retry already fires. The next-step
text request gains an optional `hint_opened`, stored in a new nullable `answers.hint_opened`.
The app keeps the hint state per card and picks the retry line by card type.

**Tech Stack:** TypeScript, Zod (`packages/core`), Hono + Drizzle + Postgres (`apps/server`),
Expo / React Native (`apps/mobile`), Playwright (`e2e`), Jest.

**Spec:** `docs/superpowers/specs/2026-10-12-lang-tutor-phase-38-typed-fill-in-hint-design.md`

## Global Constraints

- No `API_LEVEL` change; `PendingRetry.wording` stays `'word' | 'meaning'` (spec D3, R6).
- Hint button label, exactly: `רמז: הצגת המשפט בעברית`; testID `sentence-hint`.
- Retry second line on `cloze_typed`, exactly: `אבל התכוונו למילה אחרת — היעזרו במשפט בעברית ונסו שוב`.
- Sentence-task alternatives cap: 10 (`MAX_GAP_ALTERNATIVES`), the typed task's stays 5.
- `hint_opened` is stored only on the first answer of a `cloze_typed` card; null otherwise.
- Never hardcode a port or database name; run scripts through npm (lanes, ADR 0006).

## Review Focus

1. A network replay of a first answer carrying a different `hint_opened` must not change the
   stored value → Task 3 test "a replay keeps the stored value".
2. `settle` re-sending a first answer as a retry must drop `hint_opened` → Task 4 test
   "never on a retry".
3. A resumed session whose `cloze_typed` card is held for its retry shows the Hebrew without a
   tap → Task 4 test on `showsSentenceTranslation` with a pending retry.
4. `hint_opened` sent on a card that has no hint stores null → Task 3 test.
5. An older app that sends no `hint_opened` stores null and still works → Task 3 test.

---

### Task 1: The sentence task's alternatives fit the sentence read alone

**Files:**
- Modify: `apps/server/src/domain/sentences.ts` (cap), `apps/server/src/domain/distractors.ts:292` (prompt)
- Test: `apps/server/src/domain/sentences.test.ts`, `apps/server/src/domain/distractors.test.ts`

**Interfaces:** Produces `MAX_GAP_ALTERNATIVES = 10` exported from `domain/sentences.ts`.

- [ ] **Step 1: Failing tests.** In `sentences.test.ts`, inside the `validateSentenceItem` describe:

```ts
it('keeps up to ten alternatives, the words that fit the sentence read alone (phase 38 D2)', () => {
  const many = Array.from({ length: 12 }, (_, index) => `parola${index}`);
  const result = validateSentenceItem(INPUT, { ...good, alternatives: many });
  expect(result.ok && result.content.alternatives).toEqual(many.slice(0, 10));
});
```

(`INPUT` is the input object the describe already passes; reuse its name.) In
`distractors.test.ts` `buildDistractorPrompt` describe:

```ts
it('asks a sentence for every word that fits its gap read alone, at most ten (phase 38 D2)', () => {
  expect(prompt.system).toContain('would fill the gap with the sentence read on its own, without its translation');
  expect(prompt.system).toContain('at most 10');
});
```

- [ ] **Step 2:** `npm test --workspace apps/server -- sentences distractors` → both FAIL.
- [ ] **Step 3: Implement.** `sentences.ts`: add below `MAX_ALTERNATIVES`

```ts
/** Phase 38 (spec D2). The most alternatives a typed cloze asks for and keeps: every word
 *  that fits the gap with the sentence read alone. questions_type_valid allows ten. */
export const MAX_GAP_ALTERNATIVES = 10;
```

and in `validateSentenceItem` replace `MAX_ALTERNATIVES` with `MAX_GAP_ALTERNATIVES`; update
`MAX_ALTERNATIVES`'s comment to "the typed task". `distractors.ts`: import
`MAX_GAP_ALTERNATIVES` and replace the alternatives clause of the `"sentence"` line with:

```ts
... and in alternatives every other ${learned.name} word that would fill the gap with the sentence read on its own, without its translation, leaving a correct and natural sentence, in the form the gap needs, the likeliest first, at most ${MAX_GAP_ALTERNATIVES}, or none. Leave distractors empty.`,
```

- [ ] **Step 4:** re-run → PASS. `npm run typecheck` passes.
- [ ] **Step 5: Commit** `feat(server): a typed cloze accepts words that fit its sentence read alone (phase 38 D2)`.

### Task 2: `hint_opened` on the wire

**Files:** Modify `packages/core/src/api/schemas.ts` (NextStepRequestSchema), `apps/server/src/routes/sessions.ts` (route description). Test `packages/core/src/api/schemas.test.ts`.

**Interfaces:** Produces `NextStepRequest` whose text variant has `hint_opened?: boolean`.

- [ ] **Step 1: Failing test** in `schemas.test.ts`:

```ts
describe('NextStepRequestSchema hint_opened (phase 38 D4)', () => {
  it('takes it on a text answer, optional and boolean', () => {
    expect(NextStepRequestSchema.safeParse({ question_id: 'q', text: 'x', hint_opened: true }).success).toBe(true);
    expect(NextStepRequestSchema.safeParse({ question_id: 'q', text: 'x' }).success).toBe(true);
    expect(NextStepRequestSchema.safeParse({ question_id: 'q', text: 'x', hint_opened: 'yes' }).success).toBe(false);
  });
});
```

- [ ] **Step 2:** `npm test --workspace packages/core -- schemas` → FAIL on the non-boolean
  case (Zod strips the unknown key, so only the type check fails).
- [ ] **Step 3: Implement.** Text variant:

```ts
  z.object({
    question_id: z.string().min(1),
    text: z.string().max(100),
    retry: z.boolean().optional(),
    // Phase 38 (spec D4). On a first answer to a typed cloze: whether the learner opened
    // the Hebrew sentence. Optional, so an older app is unchanged; stored for cloze_typed only.
    hint_opened: z.boolean().optional(),
  }),
```

Append to the next-step route description in `routes/sessions.ts`: `` A first `text` answer to a `cloze_typed` card may carry `hint_opened`, whether the learner opened its Hebrew sentence; it is stored with the answer and ignored on every other card and on a retry.``
- [ ] **Step 4:** PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(core): hint_opened on a text answer (phase 38 D4)`.

### Task 3: Storing `hint_opened`

**Files:**
- Modify: `apps/server/src/db/schema.ts` (answers), new `apps/server/src/db/migrations/0029_hint_opened.sql` (generated), `apps/server/src/repo/sessions.ts` (`insertAnswer`), `apps/server/src/services/sessions.ts` (`submitAnswer`), `apps/server/src/routes/sessions.ts` (next-step handler)
- Test: `apps/server/tests/support/questions.ts` (`readHintOpened`), new `apps/server/tests/integration/routes/sessions.hint.test.ts`, `apps/server/tests/integration/db/migrations.test.ts`

**Interfaces:**
- Consumes: Task 2's `hint_opened`.
- Produces: `insertAnswer(..., { text, verdict, pending?, hintOpened?: boolean | null })`; `submitAnswer(actor, id, qid, answer, { retry?, hintOpened? })`; `readHintOpened(db, sessionId): Promise<(boolean | null)[]>`.

- [ ] **Step 1: Failing tests.** `tests/support/questions.ts`:

```ts
/** Phase 38 (spec D4). Each stored answer's hint_opened, by position. */
export async function readHintOpened(db: Db, sessionId: string): Promise<(boolean | null)[]> {
  const rows = await db
    .select({ hintOpened: answers.hintOpened })
    .from(answers)
    .where(eq(answers.sessionId, sessionId))
    .orderBy(asc(answers.position));
  return rows.map((row) => row.hintOpened);
}
```

`sessions.hint.test.ts`: copy the setup of `sessions.retry.test.ts` (createTestDb, seedUser,
`buildTestApp`, `start(types)` with `alternatives: ['lamp']`; no MockServer stubs are needed, as
nothing here calls the model, but keep `namespaceFor` for `geminiBaseUrlFor`). Cases:

```ts
it('stores hint_opened on a first typed cloze answer, true and false as sent', async () => {
  const { sessionId, questions } = await start(['cloze_typed', 'cloze_typed']);
  await next(sessionId, { question_id: questions[0].id, text: 'wrong', hint_opened: true });
  await next(sessionId, { question_id: questions[1].id, text: 'wrong', hint_opened: false });
  expect(await readHintOpened(t.db, sessionId)).toEqual([true, false]);
});
it('stores null when an older app sends none', async () => { /* one cloze_typed, no field → [null] */ });
it('stores null on a card with no hint, even when sent', async () => { /* typed_translation with hint_opened: true → [null] */ });
it('a retry keeps the first answer’s value', async () => {
  // cloze_typed: 'lamp' with hint_opened: false opens the retry; the retry sends retry: true and
  // hint_opened: true; the stored value stays false.
});
it('a replay keeps the stored value', async () => {
  // two cloze_typed: first answered 'wrong' with hint_opened: true; the same body re-sent with
  // hint_opened: false replays (200, same response); stored stays [true].
});
```

Write each body in full, with `next = (id, body) => postJson(app, \`/api/sessions/${id}/next-step\`, body)` and `expect(res.status).toBe(200)` after every call. `migrations.test.ts`: a `describe('0029_hint_opened')` that runs migrations up to `0028_ambiguous_questions`, inserts one typed answer as the 0028 block does, runs all, and expects `select hint_opened from answers` → `[{ hint_opened: null }]`; then expects inserting a choice answer (`typed_text` null) with `hint_opened = true` to reject with the constraint name `answers_hint_opened_typed`.

- [ ] **Step 2:** `npm run test:integration -- --runTestsByPath tests/integration/routes/sessions.hint.test.ts` (from the repo root; see memory *jest-select-projects-path*) → FAIL (no column).
- [ ] **Step 3: Implement.**
  - `schema.ts` answers: after `retryVerdict`

    ```ts
    // Phase 38 (spec D4). Whether the learner opened a typed cloze's Hebrew sentence
    // before its first answer. Null on every other card, on an older app, and never
    // changed by a retry.
    hintOpened: boolean('hint_opened'),
    ```

    and a check `check('answers_hint_opened_typed', sql\`${t.hintOpened} is null or ${t.typedText} is not null\`)`.
  - `cd apps/server && npx drizzle-kit generate --name hint_opened`; confirm the SQL adds the column and the constraint only.
  - `repo/sessions.ts` `insertAnswer`: answer type gains `hintOpened?: boolean | null`; the text insert writes `hintOpened: answer.hintOpened ?? null`.
  - `services/sessions.ts` `submitAnswer`: options become `{ retry = false, hintOpened }: { retry?: boolean; hintOpened?: boolean } = {}`; in the first-answer insert, add

    ```ts
    // Phase 38 (spec D4): only the card that has a hint records it.
    hintOpened: loaded.questions[loaded.answers.length].type === 'cloze_typed' ? (hintOpened ?? null) : null,
    ```

    to the text branch's object.
  - `routes/sessions.ts` next-step handler: pass `{ retry: body.retry ?? false, hintOpened: 'text' in body ? body.hint_opened : undefined }`.
- [ ] **Step 4:** the hint test, `migrations.test.ts` and `sessions.retry.test.ts` PASS; `npm run typecheck`; `npm run lint:arch`.
- [ ] **Step 5: Commit** `feat(server): store whether a typed cloze's hint was opened (phase 38 D4)`.

### Task 4: The app's card, retry line and request

**Files:**
- Modify: `apps/mobile/src/sentence.ts`, `strings.ts`, `feedback.ts`, `components/RetryNotice.tsx`, `components/TypedAnswerView.tsx`, `components/SpeakingCardView.tsx`, `quiz.ts`, `hooks/useSession.tsx`, `app/session.tsx`
- Test: `sentence.test.ts`, `strings.test.ts`, `feedback.test.ts`, `quiz.test.ts`

**Interfaces:**
- Consumes: Task 2's `hint_opened`.
- Produces: `showsSentenceTranslation(type, state: { answered: boolean; hintOpen: boolean; retrying: boolean })`; `retryNotice(type: Question['type'], pending)`; `nextStepRequest(questionId, input, retry, hintOpened?: boolean)`; `SessionValue.submitText(text: string, hintOpened?: boolean)`.

- [ ] **Step 1: Failing tests.** Replace `sentence.test.ts`'s `showsSentenceTranslation` describe:

```ts
describe('showsSentenceTranslation', () => {
  const closed = { answered: false, hintOpen: false, retrying: false };
  it('a choice card keeps its Hebrew until answered, since it hints the word', () => {
    expect(showsSentenceTranslation('cloze_choice', closed)).toBe(false);
    expect(showsSentenceTranslation('cloze_choice', { ...closed, answered: true })).toBe(true);
  });
  it('a typed gap card hides it until the hint, a retry or the answer (phase 38 D1)', () => {
    expect(showsSentenceTranslation('cloze_typed', closed)).toBe(false);
    expect(showsSentenceTranslation('cloze_typed', { ...closed, hintOpen: true })).toBe(true);
    expect(showsSentenceTranslation('cloze_typed', { ...closed, retrying: true })).toBe(true);
    expect(showsSentenceTranslation('cloze_typed', { ...closed, answered: true })).toBe(true);
  });
});
```

`strings.test.ts`: `expect(strings.sentenceHint).toBe('רמז: הצגת המשפט בעברית'); expect(strings.retryMeantAnother).toBe('אבל התכוונו למילה אחרת — היעזרו במשפט בעברית ונסו שוב');`.
`feedback.test.ts`: update the two `retryNotice` calls to `retryNotice('typed_translation', …)` and `retryNotice('typed_meaning', …)`, and add

```ts
it('a typed cloze says the word fits but another was meant (phase 38 D3)', () => {
  expect(retryNotice('cloze_typed', { answer: 'wasted', wording: 'word' })).toEqual({
    right: strings.retryRight('wasted'),
    again: strings.retryMeantAnother,
  });
});
```

`quiz.test.ts`:

```ts
describe('nextStepRequest hint_opened (phase 38 D4)', () => {
  it('carries it on a first text answer', () => {
    expect(nextStepRequest('c1', { text: 'spent' }, null, true)).toEqual({ question_id: 'c1', text: 'spent', hint_opened: true });
    expect(nextStepRequest('c1', { text: '' }, null, false)).toEqual({ question_id: 'c1', text: '', hint_opened: false });
  });
  it('never on a retry, and not when unset', () => {
    const pending = { answer: 'wasted', wording: 'word' as const };
    expect(nextStepRequest('c1', { text: 'spent' }, pending, true)).toEqual({ question_id: 'c1', text: 'spent', retry: true });
    expect(nextStepRequest('c1', { text: 'spent' }, null)).toEqual({ question_id: 'c1', text: 'spent' });
  });
});
```

- [ ] **Step 2:** `npm test --workspace apps/mobile -- sentence strings feedback quiz` → FAIL.
- [ ] **Step 3: Implement.**
  - `sentence.ts`:

    ```ts
    /** Phase 27 (spec D5). Whether a gap card shows its Hebrew line: a choice card
     *  holds it back until the answer, as it hints which word fits. Phase 38 (spec
     *  D1): a typed card too, unless the learner opened the hint or a second try is
     *  pending, since the Hebrew alone gives the word away. */
    export function showsSentenceTranslation(
      type: 'cloze_choice' | 'cloze_typed',
      { answered, hintOpen, retrying }: { answered: boolean; hintOpen: boolean; retrying: boolean },
    ): boolean {
      return answered || (type === 'cloze_typed' && (hintOpen || retrying));
    }
    ```

  - `strings.ts` after `retryAnotherMeaning`: `retryMeantAnother: 'אבל התכוונו למילה אחרת — היעזרו במשפט בעברית ונסו שוב',` and near `questionInstructionClozeTyped`: `sentenceHint: 'רמז: הצגת המשפט בעברית',` (each with a `// Phase 38 (spec D1/D3)` comment).
  - `feedback.ts` `retryNotice(type: Question['type'], pending: PendingRetry)`: `again: type === 'cloze_typed' ? strings.retryMeantAnother : pending.wording === 'meaning' ? strings.retryAnotherMeaning : strings.retryAnotherWord`.
  - `RetryNotice` takes `{ retry, type }`; `TypedAnswerView` passes `type={question.type}`, `SpeakingCardView` likewise.
  - `quiz.ts` `nextStepRequest(questionId, input, retry, hintOpened?: boolean)`: after building `request`, `const hinted = 'text' in input && retry === null && hintOpened !== undefined ? { ...request, hint_opened: hintOpened } : request; return retried(hinted, retry);`.
  - `useSession.tsx`: `answerWith(input, hintOpened?: boolean)` passes it to `nextStepRequest(question.id, input, as, hintOpened)` and adds it to the `useCallback` closure; `submitText = useCallback((text: string, hintOpened?: boolean) => answerWith({ text }, hintOpened), [answerWith])`; update the `SessionValue` doc line.
  - `app/session.tsx`: `gapPrompt(question, answered, language, testID?, hint?: { open: boolean; retrying: boolean; onOpen: () => void })`. It computes `showsSentenceTranslation(question.type, { answered, hintOpen: hint?.open ?? false, retrying: hint?.retrying ?? false })`, and when that is false and `hint` is set, renders
    ```tsx
    <Pressable accessibilityRole="button" testID="sentence-hint" hitSlop={8} onPress={hint.onOpen}>
      <Text style={styles.hint}>{strings.sentenceHint}</Text>
    </Pressable>
    ```
    in place of the Hebrew line. Add a local component:
    ```tsx
    // Phase 38 (spec D1, D4). The typed gap card holds whether its hint is open, and
    // sends it with the first answer. Keyed by question id, so a new card starts closed.
    function ClozeTypedCard({ question, session, language }: { question: ClozeTypedQuestion; session: SessionValue; language: string }) {
      const [hintOpen, setHintOpen] = useState(false);
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionClozeTyped(language)}
          language={language}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
          onSubmit={(text) => session.submitText(text, hintOpen)}
          direction="ltr"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          retry={session.retry}
          prompt={gapPrompt(question, session.answered, language, undefined, { open: hintOpen, retrying: session.retry !== null, onOpen: () => setHintOpen(true) })}
        />
      );
    }
    ```
    and the `cloze_typed` case returns `<ClozeTypedCard key={question.id} question={question} session={session} language={language} />`. Style `hint: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.primary, fontWeight: '700', writingDirection: 'rtl' }`. The `cloze_choice` call is unchanged (no `hint`).
- [ ] **Step 4:** the four tests PASS; `npm test --workspace apps/mobile`; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(mobile): the typed fill-in card hides its Hebrew behind a hint (phase 38 D1, D3, D4)`.

### Task 5: End-to-end

**Files:** Modify `e2e/tests/support/cards.ts` (`generationStub`), `e2e/tests/sentence-cards.spec.ts`.

- [ ] **Step 1:** `generationStub(alternatives = [], gapAlternatives: string[] = [])`: the `sentence` stub's `alternatives` becomes `gapAlternatives`; `expectGeneration(request, alternatives = [], gapAlternatives = [])` forwards it.
- [ ] **Step 2:** In the `cloze-typed` branch of the sentence-cards walk, replace the "Hebrew always shown" lines with:

```ts
// Phase 38 (spec D1): the Hebrew is a hint, closed until tapped.
await expect(page.getByTestId('sentence-translation')).toHaveCount(0);
await page.getByTestId('sentence-hint').click();
await expect(page.getByTestId('sentence-hint')).toHaveCount(0);
await expect(page.getByTestId('sentence-translation')).toBeVisible();
await expect(page.getByTestId('sentence-translation-mark')).toHaveText(MARKED);
```

(the rest of the branch, the right answer and its banner, stays).
- [ ] **Step 3:** A new test in the same file, `a typed gap takes a word that fits, opens its hint and asks again`: reach the session with `expectGeneration(request, [], ['купила'])` in its setup (add a `gapAlternatives` parameter to `reachSentenceSession` / `saveSixWords` if they call `expectGeneration`), pass every card until the `cloze-typed` one, check the Hebrew line is absent, answer `купила`, then expect `retry-notice` visible, `retry-again` to have the exact retry line, `sentence-translation` visible without a tap, `typed-input` empty; answer `STUB_GAP`, expect `feedback-correct` and title `נכון!`. Assert `diagnostics.pageErrors` is empty, as the other tests do.
- [ ] **Step 4:** `npm run e2e -- sentence-cards` → PASS. Then the whole `npm run e2e`.
- [ ] **Step 5: Commit** `test(e2e): the typed gap's hint and its fitting-word retry (phase 38)`.

### Task 6: Eval

**Files:** Modify `apps/server/tests/eval/run.ts` (`sentenceTier2`).

- [ ] **Step 1:** In `sentenceTier2`, for `kase.task === 'sentence'`, add per item:

```ts
{
  name: `${item.form}: lists another word that fits the gap read alone`,
  ok: (got?.alternatives ?? []).length > 0,
  detail: `${got?.sentence ?? '(none)'} +${(got?.alternatives ?? []).join('/')}`,
},
```

alongside the existing `offSense` check (which only some items have: return both when present).
Update the doc comment above `SentenceCaseItem` to name it.
- [ ] **Step 2:** From `apps/server`: `npx tsx tests/eval/run.ts sentence` → tier 1 and tier 2 at or above threshold; read the printed alternatives for fit. Then `npx tsx tests/eval/run.ts` (all) passes, `TIER2_THRESHOLD` untouched.
- [ ] **Step 3: Commit** `test(eval): a sentence lists the words that fit its gap (phase 38 D2)` (commit with `-F` from a scratchpad message file: the worktree guard refuses "eval" in `-m`).

### Task 7: Whole-branch check

- [ ] `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run typecheck`, `npm run e2e` all pass.
- [ ] Spec status line gains "Implemented on branch `phase-38-typed-fill-in-hint`" and any deviation found while building; commit.
