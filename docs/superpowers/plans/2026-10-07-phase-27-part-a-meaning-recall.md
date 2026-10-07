# Phase 27 Part A — Meaning Recall and the Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new card, `typed_meaning`: the word in the language being learned is shown, the learner types its Hebrew meaning, and the server judges the answer — by rule when it matches the stored meaning or is empty, otherwise with one model call while the card shows **בודקים…**. A right answer credits `written_receptive`.

**Architecture:** The wire gains one `Question` member and one endpoint, `POST /api/sessions/{id}/judged-answer`. The service (`answerJudged`) checks the card in a read transaction, judges outside any transaction with core's `normaliseHebrew`, the server's pure `domain/judge.ts` and a third `LlmClient` (its own budget, thinking off), then records the answer through the existing `submitAnswer` with a new server-built answer kind, `{ text, judged }`. The planner appends the type to the recognise tier. On the app, `TypedAnswerView` gains a right-to-left input and a checking state, and `useSession` gains `submitJudged`, modelled on phase 25's `submitSpeech`.

**Tech Stack:** TypeScript, Zod 4, Hono + @hono/zod-openapi, Drizzle + Postgres 17, pg-boss, Jest (Babel: tests do not type-check), Expo SDK 57 / React Native / react-native-web, Playwright, MockServer, Gemini `generateContent`.

**Spec:** `docs/superpowers/specs/2026-10-07-lang-tutor-phase-27-deeper-question-types-design.md` — Part A is D1–D4, D9 (the recognise tier only), D10 (the `typed_meaning` rows), D11 (`TypedMeaningQuestion`, the judged-answer request and response, `answers_typed_text_length`), D12 (`typed_meaning`'s row and the checking/failure text), D13, D14 (`answer_judged`, `answer_judge_failed`), D15. Read D1–D4 before any task.

**Deviations from the spec, decided while planning:**
- **`normaliseHebrew` lives in `packages/core`**, not the server: the server's rule (D3 step 2) and the app's banner (D12: "when the answer differs from the stored meaning") must compare the same way.
- **D12's two-part banner is one title:** `exact` with a different text reads **נכון! הפירוש השמור:** and the meaning on the line below, in the style of phase 23's **נכון! המילה שתרגלנו:**.
- **The migration is `0018_typed_meaning.sql`**, the next number after phase 25's `0017`. Phase 26 also claims `0017`; whichever merges second renumbers (spec D1).
- **The judge's answer schema is per type** (`LlmMeaningJudgeSchema`, an enum of the type's three verdicts), so Gemini's response schema already refuses a verdict the type does not have. Part B adds the translation one.

## Global Constraints

- Every ADR in `docs/adr/` holds, and `npm run lint:arch` must print nothing.
- `domain/` stays pure: no `Date.now`, no `Math.random`, no I/O (ADR 0001 R3). Persistence imports domain *types* only (R4). A service depends on `LlmClient` from `services/llm.ts`, never on `providers/` (R11). Only `composition.ts` names `createGeminiClient`.
- Every wire type is a `z.infer` (ADR 0003 R3); `api/index.ts` exports types only. Every endpoint is a `createRoute` (R1).
- No `jest.mock`. No optional or defaulted *collaborator* parameter (ADR 0002 R4, R5).
- Existing types keep their names, shapes and meaning. The seed session is unchanged.
- **Tiers** (`apps/server/src/domain/plan.ts`) after this plan:
  - recognise `['multiple_choice', 'listen_choice', 'read_aloud', 'typed_meaning']`;
  - pick the form `['reverse_choice', 'letter_tiles']`;
  - produce `['typed_translation', 'dictation', 'say_translation']`.
  `typed_meaning` is always eligible. Speaking off still removes only `read_aloud` and `say_translation`.
- **Judged types:** `typed_meaning` only (Part B adds `sentence_translation`). A judged card is answered only through the judged-answer endpoint; next-step's `text` body does not fit it (`wrong_answer_kind`).
- **Verdicts:** the model answers `right | other_sense | wrong`, mapped to `exact | alternative | wrong`. Stored verdicts are the existing typed ones; no new verdict.
- **Evidence** (spec D10): `typed_meaning` `exact` → `written_receptive` ✓ uncapped; `wrong` → `written_receptive` ✗; `alternative` → nothing.
- `JUDGE_MARKER = "judge the learner's answer"`; `JUDGE_TIMEOUT_MS` default `8_000`; the judge client sends `temperature: 0` and `thinkingConfig: { thinkingBudget: 0 }`; judged-answer `text` at most `300` characters (`MAX_JUDGED_TEXT`); `answers_typed_text_length` becomes `<= 300`; the app aborts the judged-answer request after `JUDGE_REQUEST_TIMEOUT_MS = 15_000`.
- **Hebrew strings, exactly:**
  - `כתבו את הפירוש בעברית` (instruction)
  - `נכון! הפירוש השמור:` (exact, but the text differs from the stored meaning)
  - `נכון, אבל כאן תרגלנו:` (alternative)
  - existing `נכון!`, `התשובה הנכונה:`, `בודקים…`, `לא הצלחנו לבדוק`, `נסו שוב`, `בדיקה`, `הצגת התשובה`, `התשובה שלך…`.
- **`testID`s:** the meaning card's root `View` is `meaning-card`; its input keeps `typed-input`, its buttons `typed-submit` and `typed-show-answer`, its prompt `question-prompt` and `question-part-of-speech`; the failure notice is `judge-failed` and its retry button `judge-try-again`.
- **This worktree is lane slot 4** (`.claude/worktrees/phase-27-deeper-question-types`, branch `phase-27-deeper-question-types`, stacked on `phase-25-speaking`). Postgres and MockServer run from the main checkout. Run:
  - server unit files: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath <file>)`;
  - integration files: `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath <file>'` (with a space, `--selectProjects` eats the path);
  - core: `(cd packages/core && npx jest <file>)`; mobile: `(cd apps/mobile && npx jest <file>)`;
  - the eval: `(cd apps/server && npx tsx tests/eval/run.ts <filter>)`. `GEMINI_API_KEY` and `GEMINI_MODEL` are in the shell; never point it at MockServer. Do not type `npm run eval` (a guard reads it as shell `eval`).
- Never hardcode a port or a database name (ADR 0006). Never lower `TIER2_THRESHOLD`.
- **Never write into the main checkout** (`/Users/victorprp/git/lang-tutor`). Use absolute paths under the worktree. After each task the controller checks the main checkout for stray writes.
- **Typecheck is restored task by task:** core after Task 1, the server after Task 4, mobile after Task 5. `npm run typecheck` is a gate from Task 5 on.
- Commit messages follow the repo's style (`feat(core): …`, `feat(server): …`, `feat(mobile): …`, `test(e2e): …`, `docs: …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A retried judged answer after it was recorded** (the response was lost on a bad network) must not call the model or record twice: it replays the stored verdict. *Pinned in Task 4, "replays a judged answer without a model call".*
2. **A judged-answer request for a card that is not current, or not judged,** must be refused before the model is called. *Pinned in Task 4, "refuses before judging".*
3. **An answer that is the stored meaning with niqqud, a maqaf or a full stop** must be `exact` without a call. *Pinned in Task 1 (`normaliseHebrew`) and Task 4 ("rules without a call").*
4. **The model times out or answers garbage:** the card shows **לא הצלחנו לבדוק** with **נסו שוב**, keeps the typed text, records nothing, and a retry can still succeed. *Pinned in Task 4 ("records nothing when the judge fails") and Task 5 ("a failed check keeps the card and retries").*
5. **A next-step `text` body sent to a meaning card** (an old app, a crafted request) is refused, so it can never record an unjudged verdict. *Pinned in Task 1 (`answerFits`) and Task 4's integration.*

---

### Task 1: Core — the `typed_meaning` question, judged answers, `normaliseHebrew`

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Create: `packages/core/src/domain/hebrew.ts`, `packages/core/src/domain/hebrew.test.ts`
- Modify: `packages/core/src/domain/quiz.ts`, `packages/core/src/domain/index.ts` (export the new names)
- Test: `packages/core/src/api/schemas.test.ts`, `packages/core/src/domain/quiz.test.ts`

**Interfaces:**
- Produces:
  - `TypedMeaningQuestionSchema` / `TypedMeaningQuestion`: `{ id, type: 'typed_meaning', vocab_term_id, question /* the form */, part_of_speech, meaning }`.
  - `JudgedAnswerRequestSchema` / `JudgedAnswerRequest`: `{ user_id: string.min(1), question_id: string.min(1), text: string.max(300) }`.
  - `JudgedAnswerResponseSchema` / `JudgedAnswerResponse`: `{ verdict: TypedVerdict, next: NextStepResponse }`.
  - `LlmMeaningJudgeSchema` / `LlmMeaningJudge`: `{ verdict: 'right' | 'other_sense' | 'wrong' }`.
  - `MAX_JUDGED_TEXT = 300` (core `domain/quiz.ts`).
  - `type JudgedQuestion = TypedMeaningQuestion`; `isJudged(question: Question): question is JudgedQuestion`.
  - `AnswerInput` gains `{ text: string; judged: TypedVerdict }`.
  - `normaliseHebrew(text: string): string` (core `domain/hebrew.ts`).

- [ ] **Step 1: Write the failing tests**

`packages/core/src/domain/hebrew.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { normaliseHebrew } from './hebrew';

describe('normaliseHebrew (phase 27 D3)', () => {
  it('removes points and cantillation', () => {
    expect(normaliseHebrew('לְדַבֵּר')).toBe('לדבר');
  });
  it('reads a maqaf as a space and drops punctuation', () => {
    expect(normaliseHebrew('בית־ספר.')).toBe('בית ספר');
    expect(normaliseHebrew('  "לדבר",  ')).toBe('לדבר');
  });
  it('keeps letters, including final forms, and collapses spaces', () => {
    expect(normaliseHebrew('ספר   טוב')).toBe('ספר טוב');
    expect(normaliseHebrew('מלך')).toBe('מלך');
  });
  it('is NFC', () => {
    expect(normaliseHebrew('שָׁלוֹם'.normalize('NFD'))).toBe('שלום');
  });
});
```

Add to `packages/core/src/domain/quiz.test.ts` (keep its existing imports; add `isJudged`, `MAX_JUDGED_TEXT`):

```ts
const MEANING: Question = {
  id: 'm1',
  type: 'typed_meaning',
  vocab_term_id: 'l1',
  question: 'parlare',
  part_of_speech: 'verb',
  meaning: 'לדבר',
};

describe('typed_meaning (phase 27 D3)', () => {
  it('is judged, not a choice and not speaking', () => {
    expect(isJudged(MEANING)).toBe(true);
    expect(isChoice(MEANING)).toBe(false);
    expect(isJudged({ ...MEANING, type: 'typed_translation', answer: 'x', lemma: 'x', alternatives: [] } as Question)).toBe(false);
  });
  it('takes only a judged text', () => {
    expect(answerFits(MEANING, { text: 'לדבר', judged: 'exact' })).toBe(true);
    expect(answerFits(MEANING, { text: 'לדבר' })).toBe(false);
    expect(answerFits(MEANING, { option_index: 0 })).toBe(false);
  });
  it('records the verdict it was given, never judging itself', () => {
    expect(evaluate(MEANING, { text: 'לשוחח', judged: 'exact' })).toEqual({
      question_id: 'm1',
      is_correct: true,
      answer_string: 'לשוחח',
      verdict: 'exact',
    });
    expect(evaluate(MEANING, { text: 'ספר', judged: 'alternative' })).toMatchObject({ is_correct: true, verdict: 'alternative' });
    expect(evaluate(MEANING, { text: 'לאכול', judged: 'wrong' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });
  it('stores at most MAX_JUDGED_TEXT characters', () => {
    const long = 'א'.repeat(MAX_JUDGED_TEXT + 20);
    expect(evaluate(MEANING, { text: long, judged: 'wrong' }).answer_string).toHaveLength(MAX_JUDGED_TEXT);
  });
  it('a typed card still refuses a judged answer', () => {
    const typed: Question = { id: 't1', type: 'typed_translation', vocab_term_id: 'l1', question: 'לדבר', part_of_speech: 'verb', answer: 'parlare', lemma: 'parlare', alternatives: [] };
    expect(answerFits(typed, { text: 'parlare', judged: 'exact' })).toBe(false);
  });
  it('its right answer is the meaning, and it is missed like any card', () => {
    expect(rightAnswer(MEANING)).toBe('לדבר');
    const record = evaluate(MEANING, { text: '', judged: 'wrong' });
    expect(missed([MEANING], [record])).toEqual([{ question: MEANING, correct_answer: 'לדבר' }]);
  });
});
```

Add to `packages/core/src/api/schemas.test.ts`:

```ts
describe('phase 27 Part A schemas', () => {
  it('parses a typed_meaning question', () => {
    const q = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'parlare', part_of_speech: 'verb', meaning: 'לדבר' };
    expect(QuestionSchema.parse(q)).toEqual(q);
  });
  it('bounds a judged answer at 300 characters and needs ids', () => {
    expect(JudgedAnswerRequestSchema.safeParse({ user_id: 'u', question_id: 'q', text: 'א'.repeat(300) }).success).toBe(true);
    expect(JudgedAnswerRequestSchema.safeParse({ user_id: 'u', question_id: 'q', text: 'א'.repeat(301) }).success).toBe(false);
    expect(JudgedAnswerRequestSchema.safeParse({ user_id: '', question_id: 'q', text: 'x' }).success).toBe(false);
  });
  it('a next-step body cannot carry a verdict', () => {
    const parsed = NextStepRequestSchema.parse({ user_id: 'u', question_id: 'q', text: 'x', judged: 'exact' });
    expect(parsed).not.toHaveProperty('judged');
  });
  it('the meaning judge answers one of three verdicts', () => {
    expect(LlmMeaningJudgeSchema.safeParse({ verdict: 'other_sense' }).success).toBe(true);
    expect(LlmMeaningJudgeSchema.safeParse({ verdict: 'misspelled' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `(cd packages/core && npx jest src/domain/hebrew.test.ts src/domain/quiz.test.ts src/api/schemas.test.ts)`
Expected: FAIL — `normaliseHebrew`, `isJudged`, `MAX_JUDGED_TEXT`, `JudgedAnswerRequestSchema`, `LlmMeaningJudgeSchema` are not defined, and `typed_meaning` does not parse.

- [ ] **Step 3: Implement**

`packages/core/src/domain/hebrew.ts`:

```ts
/**
 * Phase 27 (spec D3). Two Hebrew answers compared as: NFC, a maqaf read as a
 * space, points and cantillation removed, every other punctuation mark or
 * symbol read as a space, single spaces, trimmed. Shared on purpose: the
 * server's rule ("the stored meaning, exactly") and the app's banner ("the
 * answer differs from the stored meaning") must agree.
 */
export function normaliseHebrew(text: string): string {
  return text
    .normalize('NFC')
    .replace(/־/gu, ' ')
    .replace(/[֑-ֽֿ-ׇ]/gu, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
```

`packages/core/src/api/schemas.ts` — after `SayTranslationQuestionSchema`:

```ts
// Phase 27 (spec D2, D11). The form, written; the learner types its Hebrew
// meaning, which the server judges (D3). `meaning` is the stored meaning: shown
// after the answer, and read by the missed list.
export const TypedMeaningQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('typed_meaning'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  meaning: z.string(),
});
```

Add `TypedMeaningQuestionSchema` to `QuestionSchema`'s list (last). After `SpeechAnswerResponseSchema`:

```ts
// Phase 27 (spec D3, D11). An answer to a card the server judges, with a model
// call when no rule decides it. At most 300 characters.
export const JudgedAnswerRequestSchema = z.object({
  user_id: z.string().min(1),
  question_id: z.string().min(1),
  text: z.string().max(300),
});

export const JudgedAnswerResponseSchema = z.object({
  verdict: TypedVerdictSchema,
  // The next-step response, which the app queues while the banner shows.
  next: NextStepResponseSchema,
});
```

Next to `LlmTranscriptSchema` (find it with `grep -n LlmTranscriptSchema packages/core/src/api/schemas.ts`):

```ts
// Phase 27 (spec D4). The model's verdict on a meaning-recall answer. Mapped
// to a typed verdict in the server (domain/judge.ts).
export const LlmMeaningJudgeSchema = z.object({
  verdict: z.enum(['right', 'other_sense', 'wrong']),
});
```

`packages/core/src/api/types.ts`: add `TypedMeaningQuestion`, `JudgedAnswerRequest`, `JudgedAnswerResponse`, `LlmMeaningJudge` as `z.infer`s, in the style of the file. `packages/core/src/api/index.ts`: export them as types.

`packages/core/src/domain/quiz.ts`:
- import `TypedMeaningQuestion` from `../api/types`;
- `AnswerInput` gains a member, with a comment: `| { text: string; judged: TypedVerdict }` — "Phase 27 (spec D3). A text the server judged, by rule or by a model call. Only the server builds it: the next-step schema has no `judged` field.";
- `export const MAX_JUDGED_TEXT = 300;` with the comment "answers_typed_text_length (phase 27 D11)";
- `export type JudgedQuestion = TypedMeaningQuestion;` and

```ts
/** Phase 27 (spec D3). The cards whose text answer the server judges. */
export function isJudged(question: Question): question is JudgedQuestion {
  return question.type === 'typed_meaning';
}
```

- `isChoice`: add `case 'typed_meaning':` to the `false` group (the switch is exhaustive).
- `TextQuestion` must exclude judged questions: `type TextQuestion = Exclude<Question, ChoiceQuestion | SpeakingQuestion | JudgedQuestion>;`
- `answerFits`: before the final `return 'text' in answer;` add
  `if (isJudged(question)) return 'text' in answer && 'judged' in answer;`
  and make the last line refuse a judged answer on a non-judged card: `return 'text' in answer && !('judged' in answer);`
- `rightAnswer`: `if (question.type === 'typed_meaning') return question.meaning;` before the existing return.
- `evaluate`: before the text branch:

```ts
  if (isJudged(question) && 'judged' in answer) {
    return {
      question_id: question.id,
      is_correct: verdictCorrect(answer.judged),
      answer_string: answer.text.slice(0, MAX_JUDGED_TEXT),
      verdict: answer.judged,
    };
  }
```

  and narrow the existing text branch's condition to `!isChoice(question) && !isJudged(question) && question.type !== 'read_aloud' && 'text' in answer && !('judged' in answer)`.

Export `normaliseHebrew`, `isJudged`, `MAX_JUDGED_TEXT` and `JudgedQuestion` from `packages/core/src/domain/index.ts`.

- [ ] **Step 4: Run the tests and the core typecheck**

Run: `(cd packages/core && npx jest && npx tsc --noEmit)`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): the typed_meaning question, judged answers and normaliseHebrew

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server domain — the judge, the tier, the evidence, the generated content

**Files:**
- Create: `apps/server/src/domain/judge.ts`, `apps/server/src/domain/judge.test.ts`
- Modify: `apps/server/src/domain/plan.ts`, `apps/server/src/domain/progress.ts`, `apps/server/src/domain/distractors.ts`
- Test: `apps/server/src/domain/plan.test.ts`, `apps/server/src/domain/progress.test.ts`, `apps/server/src/domain/distractors.test.ts`

**Interfaces:**
- Consumes: `normaliseHebrew`, `TypedMeaningQuestion`, `LlmMeaningJudgeSchema`, `TypedVerdict` (Task 1); `LANGUAGES`, `LanguageCode` (`domain/languages.ts`).
- Produces (`domain/judge.ts`):
  - `JUDGE_MARKER = "judge the learner's answer"`;
  - `type MeaningJudgeContext = { language: LanguageCode; form: string; lemma: string; partOfSpeech: string; meaning: string; example: string | null; exampleTranslation: string | null }`;
  - `meaningRuleVerdict(meaning: string, text: string): TypedVerdict | null` — `'wrong'` for empty text, `'exact'` for the stored meaning, `null` when the model must decide;
  - `buildMeaningJudgePrompt(context: MeaningJudgeContext, answer: string): { system: string; user: string; schema: typeof LlmMeaningJudgeSchema }`;
  - `parseMeaningJudge(raw: string): TypedVerdict | null` — `null` when unreadable or empty.
- Produces (elsewhere): `TIERS[0]` ends with `'typed_meaning'`; `TextAnswerType` includes `'typed_meaning'`; `taskFor('typed_meaning') === null`; `generatedContent(row, 'typed_meaning', …)` stores `{ prompt: row.translation }`.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/domain/judge.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import {
  JUDGE_MARKER,
  buildMeaningJudgePrompt,
  meaningRuleVerdict,
  parseMeaningJudge,
  type MeaningJudgeContext,
} from './judge';

const CONTEXT: MeaningJudgeContext = {
  language: 'it',
  form: 'prenotare',
  lemma: 'prenotare',
  partOfSpeech: 'verb',
  meaning: 'להזמין',
  example: 'Vorrei prenotare un tavolo.',
  exampleTranslation: 'הייתי רוצה להזמין שולחן.',
};

describe('meaningRuleVerdict (spec D3 step 2)', () => {
  it('is wrong for an empty answer, without a call', () => {
    expect(meaningRuleVerdict('להזמין', '   ')).toBe('wrong');
  });
  it('is exact for the stored meaning, with points, a maqaf or a full stop', () => {
    expect(meaningRuleVerdict('להזמין', 'לְהַזְמִין.')).toBe('exact');
    expect(meaningRuleVerdict('בית ספר', 'בית־ספר')).toBe('exact');
  });
  it('leaves anything else to the model', () => {
    expect(meaningRuleVerdict('להזמין', 'לשריין')).toBeNull();
  });
});

describe('buildMeaningJudgePrompt (spec D4)', () => {
  const prompt = buildMeaningJudgePrompt(CONTEXT, 'לשריין');
  it('carries the marker MockServer matches on, and the language', () => {
    expect(prompt.system).toContain(JUDGE_MARKER);
    expect(prompt.system).toContain('Italian');
  });
  it('sends the word, its sense and the answer', () => {
    expect(JSON.parse(prompt.user)).toEqual({
      word: 'prenotare',
      lemma: 'prenotare',
      part_of_speech: 'verb',
      saved_meaning: 'להזמין',
      example: 'Vorrei prenotare un tavolo.',
      example_translation: 'הייתי רוצה להזמין שולחן.',
      answer: 'לשריין',
    });
  });
  it('names all three verdicts', () => {
    for (const verdict of ['"right"', '"other_sense"', '"wrong"']) expect(prompt.system).toContain(verdict);
  });
});

describe('parseMeaningJudge (spec D4)', () => {
  it('maps the three verdicts onto typed verdicts', () => {
    expect(parseMeaningJudge('{"verdict":"right"}')).toBe('exact');
    expect(parseMeaningJudge('{"verdict":"other_sense"}')).toBe('alternative');
    expect(parseMeaningJudge('{"verdict":"wrong"}')).toBe('wrong');
  });
  it('is null for no content, a fenced or unknown answer it cannot read', () => {
    expect(parseMeaningJudge('')).toBeNull();
    expect(parseMeaningJudge('{"verdict":"misspelled"}')).toBeNull();
    expect(parseMeaningJudge('not json')).toBeNull();
  });
  it('reads a fenced answer', () => {
    expect(parseMeaningJudge('```json\n{"verdict":"right"}\n```')).toBe('exact');
  });
});
```

Add to `apps/server/src/domain/plan.test.ts` (reuse the file's existing pick builders; read the top of the file for their names):

```ts
describe('typed_meaning in the recognise tier (phase 27 D9)', () => {
  it('is the last type of the recognise tier', () => {
    expect(TIERS[0]).toEqual(['multiple_choice', 'listen_choice', 'read_aloud', 'typed_meaning']);
  });
  it('is chosen when its turn comes, and when listening falls through to it', () => {
    // Four picks, ordinal 0, no listening, no speaking: the second run's
    // recognise card prefers listen_choice, which falls through to
    // typed_meaning (the next eligible in the tier's order).
    const plan = planSession(picks(4), { listening: false, speaking: false, ordinal: 0 });
    expect(plan.types).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation', 'typed_meaning']);
  });
  it('never puts two cards of a type in a row, over sizes 1 to 10 and ordinals 0 to 4', () => {
    for (let size = 1; size <= 10; size++) {
      for (let ordinal = 0; ordinal <= 4; ordinal++) {
        for (const flags of [{ listening: false, speaking: false }, { listening: true, speaking: true }]) {
          const types = planSession(picks(size), { ...flags, ordinal }).types;
          types.forEach((type, i) => {
            if (i > 0) expect(type === types[i - 1] && type !== 'matching').toBe(false);
          });
        }
      }
    }
  });
});
```

If the file's builder is not called `picks(n)`, adapt the calls to it. Then update the existing `plan.test.ts` expectations that the new tier member changes (run the file, read each failure, and confirm each new expected plan by applying `tier[(ordinal + run) % tier.length]` with the fall-through by hand — never by copying the received value without checking it).

Add to `apps/server/src/domain/progress.test.ts`:

```ts
describe('typed_meaning evidence (phase 27 D10)', () => {
  const answer = (verdict: 'exact' | 'alternative' | 'wrong') => ({ senseId: 's1', type: 'typed_meaning' as const, verdict });
  it('credits written_receptive, uncapped, for a right meaning', () => {
    expect(evidenceFor(answer('exact'))).toEqual([{ dimension: 'written_receptive', correct: true, cap: null }]);
  });
  it('is a written_receptive failure when wrong', () => {
    expect(evidenceFor(answer('wrong'))).toEqual([{ dimension: 'written_receptive', correct: false, cap: null }]);
  });
  it('says nothing for another sense', () => {
    expect(evidenceFor(answer('alternative'))).toEqual([]);
  });
});
```

Add to `apps/server/src/domain/distractors.test.ts` (reuse its `row`/context builder):

```ts
describe('typed_meaning content (phase 27 D15)', () => {
  it('asks the model nothing and stores the meaning as the prompt', () => {
    expect(taskFor('typed_meaning')).toBeNull();
    expect(generatedContent(ROW, 'typed_meaning', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: ROW.translation,
      options: null,
      alternatives: null,
      tiles: null,
    });
  });
});
```

(`ROW` stands for whatever `GenerationContext` fixture the file already declares; use it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/judge.test.ts src/domain/plan.test.ts src/domain/progress.test.ts src/domain/distractors.test.ts)`
Expected: FAIL — `./judge` does not exist; the tier lacks `typed_meaning`; `evidenceFor` has no case.

- [ ] **Step 3: Implement**

`apps/server/src/domain/judge.ts`:

```ts
import type { TypedVerdict } from '@lang-tutor/core/api';
import { LlmMeaningJudgeSchema } from '@lang-tutor/core/api/schemas';
import { normaliseHebrew } from '@lang-tutor/core/domain';

import { LANGUAGES, type LanguageCode } from './languages';
import { unfence } from './translation';

/**
 * Phase 27 (spec D3, D4). The pure half of judging an open answer: the rules
 * that decide without a model, what the model is told, and how its answer is
 * read. services/sessions.ts calls the model and decides what a failure costs.
 */

/** Part of every judge instruction, and what MockServer matches to tell this
 *  call from the others. Changing the wording means changing the stubs. */
export const JUDGE_MARKER = "judge the learner's answer";

/** What the meaning judge is told about the card: the word, and the sense its
 *  saved example pins. The example is absent for a saved sense without one. */
export type MeaningJudgeContext = {
  language: LanguageCode;
  form: string;
  lemma: string;
  partOfSpeech: string;
  meaning: string;
  example: string | null;
  exampleTranslation: string | null;
};

/** Spec D3 step 2. Empty text is "show me the answer"; the stored meaning is
 *  right as typed. Null: only the model can tell. */
export function meaningRuleVerdict(meaning: string, text: string): TypedVerdict | null {
  const typed = normaliseHebrew(text);
  if (typed === '') return 'wrong';
  return typed === normaliseHebrew(meaning) ? 'exact' : null;
}

export function buildMeaningJudgePrompt(context: MeaningJudgeContext, answer: string) {
  const name = LANGUAGES[context.language].name;
  const system = [
    `Your task: ${JUDGE_MARKER}. A Hebrew-speaking learner of ${name} was shown a ${name} word and typed its meaning in Hebrew.`,
    'The meaning practised is saved_meaning, in the sense the example shows.',
    'Return JSON only, matching the supplied schema, with one field, verdict:',
    '- "right": the answer means the same as saved_meaning in this sense. Accept a synonym, another form, tense or person of it (for example לדבר, מדבר, דיבר), with or without a prefix such as ה, ל, ו or ש, with or without niqqud, and with small Hebrew spelling slips.',
    '- "other_sense": the answer is a correct meaning of the word, but of a different sense than the one practised.',
    '- "wrong": anything else, including an answer that is only related, too general, or the meaning of another word.',
  ].join('\n');
  const user = JSON.stringify({
    word: context.form,
    lemma: context.lemma,
    part_of_speech: context.partOfSpeech,
    saved_meaning: context.meaning,
    example: context.example,
    example_translation: context.exampleTranslation,
    answer,
  });
  return { system, user, schema: LlmMeaningJudgeSchema };
}

const MEANING_VERDICTS: Record<'right' | 'other_sense' | 'wrong', TypedVerdict> = {
  right: 'exact',
  other_sense: 'alternative',
  wrong: 'wrong',
};

/** The model's verdict as a typed verdict. Null when the answer is empty (no
 *  content is no verdict here) or cannot be read. */
export function parseMeaningJudge(raw: string): TypedVerdict | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = LlmMeaningJudgeSchema.safeParse(JSON.parse(unfence(raw)));
    return parsed.success ? MEANING_VERDICTS[parsed.data.verdict] : null;
  } catch {
    return null;
  }
}
```

(`unfence` is exported by `domain/translation.ts`, as `distractors.ts` imports it.)

`apps/server/src/domain/plan.ts`:
- `TIERS[0]` becomes `['multiple_choice', 'listen_choice', 'read_aloud', 'typed_meaning']`, and the comment above `TIERS` gains: "Phase 27 appends meaning recall, receptive recall, to the first: the hardest recognise card, so last."
- `eligible`: add `case 'typed_meaning':` to the group that returns `true`.

`apps/server/src/domain/progress.ts`:
- `TextAnswerType` gains `'typed_meaning'`.
- `evidenceFor` gains, after `case 'say_translation'`:

```ts
    case 'typed_meaning':
      // Phase 27 (spec D10). Recalling a meaning is stronger than picking it
      // from four, which is credited uncapped; the answer is Hebrew, so no
      // spelling. Another sense says nothing about this one.
      if (answer.verdict === 'exact') return [piece('written_receptive', true)];
      if (answer.verdict === 'wrong') return [piece('written_receptive', false)];
      return [];
```

`apps/server/src/domain/distractors.ts`:
- `taskFor`: add `case 'typed_meaning':` to the `return null;` group.
- `generatedContent`: add `case 'typed_meaning':` to the `case 'dictation': case 'read_aloud':` group, which returns `{ ...none, prompt: row.translation }`.

- [ ] **Step 4: Run the server unit suite**

Run: `(cd apps/server && npx jest --selectProjects=unit)`
Expected: PASS. Fix any other unit test that predicted a plan the new tier changes, by the hand check described in Step 1.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain
git commit -m "feat(server): the meaning judge's rules, prompt and parser, and typed_meaning in the planner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Persistence — migration 0018, the question's shape, the judge's context

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0018_typed_meaning.sql` and its drizzle meta (`meta/0018_snapshot.json`, `meta/_journal.json`) — generated
- Modify: `apps/server/src/repo/questions.ts`, `apps/server/src/repo/progress.ts`
- Test: `apps/server/tests/integration/db/migrations.test.ts`, `apps/server/tests/integration/repo/questions.test.ts`, `apps/server/tests/integration/repo/progress.test.ts`

**Interfaces:**
- Consumes: `TypedMeaningQuestion` (Task 1); `generatedContent` storing `{ prompt }` (Task 2).
- Produces:
  - `questions_type_known` admits `'typed_meaning'`; `questions_shape_valid` gives it `options is null and prompt is not null and alternatives is null and tiles is null`; `answers_typed_text_length` is `length(typed_text) <= 300`.
  - `questionFrom` builds `{ id, type: 'typed_meaning', vocab_term_id, question: form, part_of_speech, meaning: prompt }`.
  - `QuestionRepo.findJudgeContext(questionId: string): Promise<{ form: string; lemma: string; partOfSpeech: string; meaning: string; example: string | null; exampleTranslation: string | null } | undefined>` — the question's prompt variant form, its lexeme's lemma and part of speech, the stored prompt, and `dict_var_translations.example_source` / `example_target` for the question's `prompt_variant_id`, `sense_id` and `user_language_code`.
  - `repo/progress.ts`'s `TEXT_TYPES` includes `'typed_meaning'`.

- [ ] **Step 1: Write the failing integration tests**

In `apps/server/tests/integration/db/migrations.test.ts`, add a case in the file's style for 0018 (read how it tests 0017: it migrates to the previous version, inserts rows, migrates forward, and asserts):

```ts
describe('0018: typed_meaning (phase 27)', () => {
  it('keeps every existing question and answer, and admits a typed_meaning question with a prompt only', async () => {
    // Insert, before 0018, one question of each existing type and one answer
    // with a 100-character text, exactly as the 0017 case does; migrate.
    // Then: the rows are unchanged; a typed_meaning row with a prompt and no
    // options/alternatives/tiles inserts; one with options is refused by
    // questions_shape_valid; an answer of 300 characters inserts and one of
    // 301 is refused by answers_typed_text_length.
  });
});
```

Write the body following the 0017 case's helpers exactly; the comments above list what it must assert. In `tests/integration/repo/questions.test.ts`, add:

```ts
it('loads a typed_meaning question with its form, part of speech and meaning (phase 27)', async () => {
  // Insert a list session whose first question is typed_meaning with prompt
  // 'להזמין' over a seeded sense (seedSavedSenses / insertListSession, as the
  // say_translation case in this file does). loadSession's first question is
  // { type: 'typed_meaning', question: <form>, part_of_speech: <pos>, meaning: 'להזמין' }.
});

it('findJudgeContext reads the lemma, part of speech, meaning and the saved example (phase 27)', async () => {
  // Seed a sense whose dict_var_translations row has example_source
  // 'Vorrei prenotare un tavolo.' and example_target 'הייתי רוצה להזמין שולחן.'
  // (extend the seed helper's options if it does not take examples yet).
  // Expect { form, lemma, partOfSpeech, meaning: the prompt, example, exampleTranslation }.
  // A question id that does not exist gives undefined.
});
```

In `tests/integration/repo/progress.test.ts`, add a case that a completed session with a `typed_meaning` answer of verdict `exact` is read by `findSessionEvidence` as `{ type: 'typed_meaning', verdict: 'exact' }` (follow the `say_translation` case).

- [ ] **Step 2: Run them to verify they fail**

Run: `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath tests/integration/db/migrations.test.ts tests/integration/repo/questions.test.ts tests/integration/repo/progress.test.ts'`
Expected: FAIL — no 0018, `typed_meaning` refused by `questions_type_known`, `findJudgeContext` missing.

- [ ] **Step 3: Implement**

`apps/server/src/db/schema.ts`:
- `questions_type_known`: add `'typed_meaning'` at the end of the list.
- `questions_shape_valid`: add, before `else false end`,
  `when 'typed_meaning' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null`, and extend the comment above the check with "Phase 27's meaning recall stores the meaning as its prompt and nothing else."
- `answers_typed_text_length`: `length(${t.typedText}) <= 300`, with the comment "Phase 27 (spec D11): a judged answer is at most 300 characters."

Generate the migration: `(cd apps/server && npx drizzle-kit generate --name typed_meaning)`. Open the generated SQL, check it drops and re-adds exactly the three constraints, and prepend a comment in the style of `0017_speaking_cards.sql`:

```sql
-- Phase 27 Part A. Meaning-recall questions, and judged answers of up to 300
-- characters (spec D11). Every existing row satisfies the new checks unchanged:
-- no question is of the new type, and every stored text is at most 100.
```

If drizzle-kit names it other than `0018_typed_meaning.sql`, rename the file and its `_journal.json` tag to match. Run `(cd apps/server && npx drizzle-kit check)`: it must report nothing.

`apps/server/src/repo/questions.ts`:
- `questionFrom`: add the `typed_meaning` case building the Interfaces shape. Read how `say_translation` gets its `part_of_speech` and form (the same joins serve).
- `findJudgeContext`: a `tx.execute` over `questions q JOIN dict_variants v ON v.id = q.prompt_variant_id JOIN dict_lexemes l ON l.id = v.lexeme_id LEFT JOIN dict_var_translations tr ON tr.variant_id = q.prompt_variant_id AND tr.sense_id = q.sense_id AND tr.user_language_code = q.user_language_code WHERE q.id = $questionId`, returning `v.form, l.lemma, l.part_of_speech, q.prompt, tr.example_source, tr.example_target`. An invalid uuid must return `undefined`, not throw: check the id against the repo's `UUID_RE` first, as `loadSession` does.

`apps/server/src/repo/progress.ts`: add `'typed_meaning'` to `TEXT_TYPES`. Check `findSnapshot` reads the meaning from `prompt` for every non-Hebrew-option type (phase 24 D15); if it lists types, add `typed_meaning` there too.

- [ ] **Step 4: Run the integration tests**

Run the Step 2 command again, then the whole integration bucket: `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration && npx jest --selectProjects=integration-serial'`
Expected: PASS. Then drop any probe databases this left (`npm run lane:list` shows them).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db apps/server/src/repo apps/server/tests/integration
git commit -m "feat(server): migration 0018, the typed_meaning question and the judge's context

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The judged-answer endpoint — client, config, service, route

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/providers/gemini.ts`, `apps/server/src/composition.ts`, `apps/server/src/index.ts` (if it reads config fields one by one), `apps/server/tests/support/serverDeps.ts`
- Modify: `apps/server/src/services/sessions.ts`, `apps/server/src/routes/sessions.ts`
- Modify every `createSessionService({...})` call site to pass `judge`: `apps/server/src/services/sessions.test.ts`, `sessions.prepare.test.ts`, `sessions.progress.test.ts`, `sessions.speech.test.ts` (find them with `grep -rln "createSessionService(" apps/server`)
- Create: `apps/server/src/services/sessions.judge.test.ts`, `apps/server/tests/integration/routes/sessions.judge.test.ts`
- Modify: `apps/server/tests/support/mockServer.ts` (an `expectJudge` stub), `apps/server/src/config.test.ts` (if it exists), `apps/server/src/openapi.test.ts` (if it lists routes)

**Interfaces:**
- Consumes: Task 1's schemas and `AnswerInput`; Task 2's `meaningRuleVerdict`, `buildMeaningJudgePrompt`, `parseMeaningJudge`; Task 3's `findJudgeContext`.
- Produces:
  - `loadConfig(env).judgeTimeoutMs` from `JUDGE_TIMEOUT_MS`, default `8_000`;
  - `createGeminiClient(deps)` accepts `thinkingBudget?: number`; when present the request's `generationConfig` gains `thinkingConfig: { thinkingBudget }`;
  - `createServerDeps(io)` takes `judgeTimeoutMs: number` and wires `judge: LlmClient` into `createSessionService`;
  - `createTestServerDeps(io)` takes `judgeTimeoutMs?: number` (default `8_000`);
  - `SessionService.answerJudged(sessionId: string, input: { userId: string; questionId: string; text: string }): Promise<JudgedResult>` where `export type JudgedResult = { verdict: TypedVerdict; session: SessionResult }`;
  - route `POST /api/sessions/{id}/judged-answer` → 200 `JudgedAnswerResponse`; 400 (body invalid, or the card is not judged), 404, 409, 502.

- [ ] **Step 1: Write the failing unit tests**

`apps/server/src/services/sessions.judge.test.ts`, modelled on `sessions.speech.test.ts` (same fakes, same `setup` shape):

```ts
import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Question } from '@lang-tutor/core/api';

import {
  createFakeClock,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  createFakeTranscriber,
  stub,
} from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { JUDGE_MARKER } from '../domain/judge';
import type { SessionRecord, SessionState } from '../domain/session';
import { AnswerKindMismatch, LlmUnavailable, QuestionDesynced, SessionNotFound } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const STATE: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'ready', source: 'list' };
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'it', created_at: '' };
const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין' };
const CHOICE: Question = { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 };
const CONTEXT = { form: 'prenotare', lemma: 'prenotare', partOfSpeech: 'verb', meaning: 'להזמין', example: 'Vorrei prenotare un tavolo.', exampleTranslation: 'הייתי רוצה להזמין שולחן.' };

const record = (questions: Question[] = [MEANING, CHOICE], answers: SessionRecord['answers'] = []): SessionRecord => ({
  user_id: 'u1',
  questions,
  answers,
  complete: false,
  completed_at: null,
  status: 'ready',
  source: 'list',
});

function setup(judge: ReturnType<typeof createFakeLlmClient>, loaded: SessionRecord = record()) {
  const inserted: unknown[] = [];
  const logger = createFakeLogger();
  const session = stub<SessionRepo>({
    loadSession: async () => loaded,
    findState: async () => STATE,
    insertAnswer: async (...args) => {
      inserted.push(args);
    },
  });
  const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
  const question = stub<QuestionRepo>({ findJudgeContext: async () => CONTEXT });
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment, question }),
    rng: testRng(7),
    now: createFakeClock(1_000, 1_400),
    logger,
    llm: createFakeLlmClient(''),
    transcriber: createFakeTranscriber(''),
    judge,
  });
  return { service, inserted, logger };
}

const answer = (text: string) => ({ userId: 'u1', questionId: 'm1', text });

describe('answerJudged (spec D3)', () => {
  it('rules an empty answer wrong, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted } = setup(judge);
    expect((await service.answerJudged(SESSION, answer('  '))).verdict).toBe('wrong');
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([[SESSION, 0, 'm1', { text: '  ', verdict: 'wrong' }]]);
  });

  it('rules the stored meaning exact, without a call, and logs it as a rule', async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    const { service, logger } = setup(judge);
    expect((await service.answerJudged(SESSION, answer('לְהַזְמִין.'))).verdict).toBe('exact');
    expect(judge.calls).toHaveLength(0);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'answer_judged', judged_by: 'rule', verdict: 'exact' }));
  });

  it('asks the model once otherwise, and records the mapped verdict', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted, logger } = setup(judge);
    const result = await service.answerJudged(SESSION, answer('לשריין'));
    expect(result.verdict).toBe('exact');
    expect(result.session.answers[0]).toMatchObject({ verdict: 'exact', is_correct: true, answer_string: 'לשריין' });
    expect(inserted).toEqual([[SESSION, 0, 'm1', { text: 'לשריין', verdict: 'exact' }]]);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].system).toContain(JUDGE_MARKER);
    expect(JSON.parse(judge.calls[0].user)).toMatchObject({ saved_meaning: 'להזמין', example: 'Vorrei prenotare un tavolo.', answer: 'לשריין' });
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'answer_judged', question_type: 'typed_meaning', verdict: 'exact', judged_by: 'model', judge_ms: 400 }),
    );
  });

  it('records another sense as an alternative', async () => {
    const { service } = setup(createFakeLlmClient('{"verdict":"other_sense"}'));
    expect((await service.answerJudged(SESSION, answer('ספר'))).verdict).toBe('alternative');
  });

  it('records nothing when the judge fails, and says why', async () => {
    const { service, inserted, logger } = setup(createFakeLlmClient(new LlmUnavailable('timed out after 8000ms')));
    await expect(service.answerJudged(SESSION, answer('לשריין'))).rejects.toBeInstanceOf(LlmUnavailable);
    expect(inserted).toEqual([]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'answer_judge_failed', question_type: 'typed_meaning' }));
  });

  it('treats an unreadable verdict as a failed judge', async () => {
    const { service, inserted } = setup(createFakeLlmClient('{"verdict":"maybe"}'));
    await expect(service.answerJudged(SESSION, answer('לשריין'))).rejects.toBeInstanceOf(LlmUnavailable);
    expect(inserted).toEqual([]);
  });

  it('replays a judged answer without a model call', async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    const answered = record([MEANING, CHOICE], [{ question_id: 'm1', is_correct: true, answer_string: 'לשריין', verdict: 'exact' }]);
    const { service, inserted } = setup(judge, answered);
    const result = await service.answerJudged(SESSION, answer('לשריין'));
    expect(result.verdict).toBe('exact');
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('refuses before judging: another learner, a stale card, a card that is not judged', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    await expect(setup(judge).service.answerJudged(SESSION, { ...answer('x'), userId: 'u2' })).rejects.toBeInstanceOf(SessionNotFound);
    await expect(setup(judge).service.answerJudged(SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    const choiceFirst = record([CHOICE, MEANING]);
    await expect(setup(judge, choiceFirst).service.answerJudged(SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(AnswerKindMismatch);
    expect(judge.calls).toHaveLength(0);
  });
});
```


Add to `apps/server/src/config.test.ts` (or the config tests' file): `JUDGE_TIMEOUT_MS` absent → `judgeTimeoutMs === 8_000`; `'2500'` → `2_500`.

Add a provider test next to the transcriber's (find with `grep -rn "thinkingBudget" apps/server/src`): `createGeminiClient({ …, thinkingBudget: 0 })` sends `generationConfig.thinkingConfig = { thinkingBudget: 0 }`; without it, no `thinkingConfig` key.

- [ ] **Step 2: Run them to verify they fail**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/services/sessions.judge.test.ts)`
Expected: FAIL — `answerJudged` is not a function (and `judge` is an unknown dep).

- [ ] **Step 3: Implement the client, config and wiring**

- `config.ts`: `judgeTimeoutMs: number` in the config type; `const DEFAULT_JUDGE_TIMEOUT_MS = 8_000;`; `judgeTimeoutMs: Number(env.JUDGE_TIMEOUT_MS) || DEFAULT_JUDGE_TIMEOUT_MS`.
- `providers/gemini.ts`: `GeminiDeps` gains `thinkingBudget?: number` (a setting, not a collaborator: ADR 0002 R5 does not apply). `createGeminiClient`'s `generationConfig` spreads `...(deps.thinkingBudget === undefined ? {} : { thinkingConfig: { thinkingBudget: deps.thinkingBudget } })`.
- `composition.ts`: after the transcriber,

```ts
  // Phase 27 (spec D3). The judge waits on the learner, as the transcriber
  // does: its own budget, and thinking off for the wait (D4).
  const judge: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.judgeTimeoutMs,
    thinkingBudget: 0,
  });
```

  pass `judge` to `createSessionService`, and add `judgeTimeoutMs: number` to the io type. Follow how `speechTimeoutMs` flows from `index.ts` and `config.ts` and do the same.
- `tests/support/serverDeps.ts`: `judgeTimeoutMs?: number` in io, `judgeTimeoutMs: io.judgeTimeoutMs ?? 8_000` in the call.
- Every `createSessionService({…})` in the unit tests: add `judge: createFakeLlmClient('')`.

- [ ] **Step 4: Implement `answerJudged`**

In `services/sessions.ts`: add `judge: LlmClient` to the deps; import `isJudged`, `MAX_JUDGED_TEXT` from core and `meaningRuleVerdict`, `buildMeaningJudgePrompt`, `parseMeaningJudge` from `../domain/judge`; export

```ts
/** Phase 27. A judged answer: its verdict, and the session it was recorded in. */
export type JudgedResult = { verdict: TypedVerdict; session: SessionResult };
```

and add the use case after `answerBySpeech`:

```ts
    /**
     * Phase 27 (spec D3). A text answer the server judges. The card is checked
     * first, so no model call is spent on a stale or wrong request; a rule
     * decides an empty answer and the stored meaning; otherwise the judge is
     * called outside any transaction (ADR 0001 R8); and the verdict is recorded
     * through submitAnswer, exactly as a next-step is.
     */
    answerJudged: async (
      sessionId: string,
      input: { userId: string; questionId: string; text: string },
    ): Promise<JudgedResult> => {
      type Checked =
        | { replay: JudgedResult }
        | { current: JudgedQuestion; context: MeaningJudgeContext };
      const checked = await transaction(async (repos): Promise<Checked> => {
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded || loaded.user_id !== input.userId) throw new SessionNotFound(sessionId);
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }
        // A retry of an answer already recorded: the stored verdict, no call.
        // Only this endpoint answers a judged card, so any typed verdict is one.
        const last = loaded.answers[loaded.answers.length - 1];
        if (last && last.question_id === input.questionId) {
          const verdict = TypedVerdictSchema.safeParse(last.verdict);
          if (!verdict.success) throw new QuestionDesynced(input.questionId);
          return { replay: { verdict: verdict.data, session: { ...loaded, progress: await progressOf(repos, sessionId, loaded) } } };
        }
        const current = currentQuestion(loaded);
        if (!current || current.id !== input.questionId) throw new QuestionDesynced(input.questionId);
        if (!isJudged(current)) throw new AnswerKindMismatch(input.questionId);
        const state = await repos.session.findState(sessionId);
        const enrolled = state ? await repos.enrollment.findById(state.enrollmentId) : undefined;
        const found = await repos.question.findJudgeContext(current.id);
        if (!enrolled || !found) throw new SessionNotFound(sessionId);
        return { current, context: { language: enrolled.target_language as LanguageCode, ...found } };
      });
      if ('replay' in checked) return checked.replay;

      const text = input.text.slice(0, MAX_JUDGED_TEXT);
      let verdict = meaningRuleVerdict(checked.current.meaning, text);
      const judgedBy = verdict === null ? 'model' : 'rule';
      const started = now();
      if (verdict === null) {
        try {
          const raw = await judge(buildMeaningJudgePrompt(checked.context, text));
          verdict = parseMeaningJudge(raw);
          if (verdict === null) throw new LlmUnavailable('the verdict was unreadable');
        } catch (error) {
          logger.info({
            event: 'answer_judge_failed',
            session_id: sessionId,
            question_type: checked.current.type,
            judge_ms: now() - started,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
      // Logged before the answer is recorded: a paid call is always logged,
      // even when submitAnswer then throws on a desync race.
      logger.info({
        event: 'answer_judged',
        session_id: sessionId,
        question_type: checked.current.type,
        verdict,
        judged_by: judgedBy,
        ...(judgedBy === 'model' ? { judge_ms: now() - started } : {}),
        chars: text.length,
      });
      const session = await service.submitAnswer(sessionId, input.questionId, { text, judged: verdict });
      return { verdict, session };
    },
```

`TypedVerdictSchema` comes from `@lang-tutor/core/api/schemas`; `JudgedQuestion` from core's domain; `MeaningJudgeContext` from `../domain/judge`. `findJudgeContext`'s return has `meaning`; the context spreads it, so `MeaningJudgeContext` gets `form`, `lemma`, `partOfSpeech`, `meaning`, `example`, `exampleTranslation` from it and `language` from the enrollment. A `LlmUnavailable` thrown by the provider passes through the `catch` unchanged.

- [ ] **Step 5: Implement the route**

In `routes/sessions.ts`, import `JudgedAnswerRequestSchema` and `JudgedAnswerResponseSchema`, and add after the speech route:

```ts
const judgedAnswerRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/judged-answer',
  tags: ['sessions'],
  summary: 'Answer the current card that the server judges',
  description:
    'Takes the text answer to the current `typed_meaning` card. An empty text, or the stored meaning, is judged by rule; any other text is judged by a language model, which costs money on every call. The answer is recorded with its verdict, and `next` is the next-step response. Re-sending an answer that was recorded replays it without a model call. A judged card takes no answer through `next-step`.',
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: JudgedAnswerRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: JudgedAnswerResponseSchema } },
      description: 'The answer was judged and recorded.',
    },
    400: failure('The request body did not validate, or the current card is not one the server judges.'),
    404: failure('No session has this id, or it is not this learner’s.'),
    409: failure("`question_id` is not the session's current question, or the session is not ready (`session_not_ready`)."),
    502: failure('The judge failed or timed out; nothing was recorded, and the answer may be sent again.'),
  },
});
```

and the handler, mirroring the speech handler's error mapping:

```ts
  router.openapi(judgedAnswerRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await sessions.answerJudged(id, { userId: body.user_id, questionId: body.question_id, text: body.text });
      return c.json({ verdict: result.verdict, next: buildNextStepResponse(id, result.session) }, 200);
    } catch (error) {
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof AnswerKindMismatch) return c.json({ error: 'the current card is not judged by the server' }, 400);
      if (error instanceof LlmUnavailable) return c.json({ error: 'judge unavailable' }, 502);
      throw error;
    }
  });
```

Update the next-step route's `description` to end with: "A `typed_meaning` card is answered only through `/judged-answer`."

- [ ] **Step 6: Write the route's integration test**

`apps/server/tests/support/mockServer.ts`: add `expectJudge(ns, verdict)` beside the transcription stub (read that file: it holds the integration suite's own helpers), matching the body regex `[\s\S]*judge the learner's answer[\s\S]*`, priority 10, consumed once, answering `{ verdict }`; and use the existing status-failure helper for a 502.

`apps/server/tests/integration/routes/sessions.judge.test.ts`, modelled on `sessions.speech.test.ts` (same `buildTestApp`, `insertListSession`, `readStoredAnswers`): a ready list session whose first question is `typed_meaning` (prompt `'ספר'`) and second `multiple_choice`. Cases:
- the stored meaning with points → 200, `verdict: 'exact'`, no MockServer call needed, the answer stored with verdict `exact`;
- a synonym with `expectJudge(ns, 'right')` → 200 `exact`, `next.question` is the second card;
- the same request sent again → 200, the same verdict, still one stored answer;
- `expectGeminiStatus(ns, 500)` → 502, nothing stored; then `expectJudge(ns, 'wrong')` and the same request → 200 `wrong`;
- another learner's `user_id` → 404; the second card's id → 409;
- a `next-step` with `{ text }` for the meaning card → the status next-step answers a wrong answer kind with (read the next-step handler for it), and nothing stored;
- `text` of 301 characters → 400.

- [ ] **Step 7: Run everything the task touches**

Run:
- `(cd apps/server && npx jest --selectProjects=unit && npx tsc --noEmit)`
- `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath tests/integration/routes/sessions.judge.test.ts tests/integration/routes/sessions.speech.test.ts tests/integration/routes/sessions.test.ts'`
- `npm run lint:arch`
Expected: PASS, no type errors, `lint:arch` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat(server): the judged-answer endpoint, with its own client and budget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mobile — the meaning card, the judged submit, the banners

**Files:**
- Modify: `apps/mobile/src/api/client.ts`, `apps/mobile/src/api/client.test.ts`
- Modify: `apps/mobile/src/quiz.ts` (the `QuizState` type), `apps/mobile/src/hooks/useSession.tsx`
- Modify: `apps/mobile/src/feedback.ts`, `apps/mobile/src/feedback.test.ts`
- Modify: `apps/mobile/src/components/TypedAnswerView.tsx`, `apps/mobile/src/app/session.tsx`, `apps/mobile/src/strings.ts`, `apps/mobile/src/strings.test.ts`
- Modify: `apps/mobile/src/progress.ts` and its test (the missed list's word → meaning, if it switches on type)
- Create: `apps/mobile/src/judging.ts`, `apps/mobile/src/judging.test.ts`

**Interfaces:**
- Consumes: `JudgedAnswerRequest`, `JudgedAnswerResponse`, `TypedMeaningQuestion`, `normaliseHebrew`, `isJudged`, `AnswerInput`'s `{ text, judged }` (Task 1); the endpoint (Task 4).
- Produces:
  - `ApiClient.judgeAnswer(sessionId: string, request: JudgedAnswerRequest): Promise<JudgedAnswerResponse>`, aborted after `JUDGE_REQUEST_TIMEOUT_MS = 15_000`;
  - `type JudgeAttempt = 'idle' | 'checking' | 'failed'` (`judging.ts`), held in `QuizState.judging`, reset to `'idle'` on every new card;
  - `SessionValue.judging: JudgeAttempt` and `SessionValue.submitJudged(text: string): void`;
  - `CardAnswer` includes `{ text: string; judged: TypedVerdict }` (it already does through `AnswerInput`; `feedbackFor` must handle it without calling `evaluate`'s judge);
  - `TypedAnswerView` props gain `direction: 'ltr' | 'rtl'`, `checking: boolean`, `failed: boolean`, `onRetry: () => void`, and its `question` union gains `TypedMeaningQuestion`.

- [ ] **Step 1: Write the failing tests**

`apps/mobile/src/feedback.test.ts` — add:

```ts
describe('typed_meaning banners (phase 27 D12)', () => {
  const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין' };
  it('a right answer as stored is just right', () => {
    expect(feedbackFor(MEANING, { text: 'לְהַזְמִין', judged: 'exact' })).toEqual({ tone: 'correct', title: 'נכון!', line: null, verdict: 'exact' });
  });
  it('a right answer in other words shows the stored meaning', () => {
    expect(feedbackFor(MEANING, { text: 'לשריין', judged: 'exact' })).toEqual({
      tone: 'correct',
      title: 'נכון! הפירוש השמור:',
      line: 'להזמין',
      verdict: 'exact',
    });
  });
  it('another sense names the meaning practised', () => {
    expect(feedbackFor(MEANING, { text: 'ספר', judged: 'alternative' })).toEqual({
      tone: 'correct',
      title: 'נכון, אבל כאן תרגלנו:',
      line: 'להזמין',
      verdict: 'alternative',
    });
  });
  it('a wrong answer shows the meaning', () => {
    expect(feedbackFor(MEANING, { text: '', judged: 'wrong' })).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'להזמין', verdict: 'wrong' });
  });
});
```

`apps/mobile/src/api/client.test.ts` — add, in the style of the `answerBySpeech` cases:
- `judgeAnswer` posts `{ user_id, question_id, text }` to `/api/sessions/s%201/judged-answer` and returns the body;
- it aborts after `JUDGE_REQUEST_TIMEOUT_MS` (fake timers, as the speech case does).

`apps/mobile/src/judging.ts` holds the pure state transitions `useSession` uses, so they are unit-tested without React:

```ts
import type { JudgedAnswerResponse, TypedVerdict } from '@lang-tutor/core/api';

/** Phase 27 (spec D13). A judged card's check: none yet, in flight, or failed
 *  (the card keeps the text, and "try again" sends it again). */
export type JudgeAttempt = 'idle' | 'checking' | 'failed';

/** Whether a submit may start: an unanswered card, not already checking. */
export function canJudge(attempt: JudgeAttempt, answered: boolean): boolean {
  return !answered && attempt !== 'checking';
}

/** The answer a judged response sets on the card. */
export function judgedAnswer(text: string, response: JudgedAnswerResponse): { text: string; judged: TypedVerdict } {
  return { text, judged: response.verdict };
}
```

`apps/mobile/src/judging.test.ts`: `canJudge('idle', false)` true; `canJudge('checking', false)` false; `canJudge('failed', false)` true; `canJudge('idle', true)` false; `judgedAnswer('לשריין', { verdict: 'exact', next })` is `{ text: 'לשריין', judged: 'exact' }`.

`apps/mobile/src/strings.test.ts`: the three new strings equal the Global Constraints' text exactly.

- [ ] **Step 2: Run them to verify they fail**

Run: `(cd apps/mobile && npx jest src/feedback.test.ts src/api/client.test.ts src/judging.test.ts src/strings.test.ts)`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `strings.ts`, beside phase 25's block:

```ts
  // Phase 27 (spec D12).
  questionInstructionMeaning: 'כתבו את הפירוש בעברית',
  feedbackSavedMeaning: 'נכון! הפירוש השמור:',
  feedbackOtherSense: 'נכון, אבל כאן תרגלנו:',
```

- `feedback.ts`: before `const record = evaluate(question, answer);`

```ts
  // Phase 27 (spec D12). A judged card's verdict is the server's: the app
  // never judges it, so it only words the banner.
  if ('judged' in answer) {
    if (question.type !== 'typed_meaning') throw new Error(`a judged answer for a ${question.type} card`);
    const meaning = question.meaning;
    if (answer.judged === 'wrong') return { tone: 'wrong', title: strings.feedbackWrong, line: meaning, verdict: 'wrong' };
    if (answer.judged === 'alternative') return { tone: 'correct', title: strings.feedbackOtherSense, line: meaning, verdict: 'alternative' };
    return normaliseHebrew(answer.text) === normaliseHebrew(meaning)
      ? { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict: answer.judged }
      : { tone: 'correct', title: strings.feedbackSavedMeaning, line: meaning, verdict: answer.judged };
  }
```

  (`near_miss` cannot come from the meaning judge; it falls to the last branch, which is right for it.)
- `api/client.ts`: `export const JUDGE_REQUEST_TIMEOUT_MS = 15_000;` and `judgeAnswer`, a copy of `answerBySpeech`'s abort-and-post shape posting to `` `/api/sessions/${encodeURIComponent(sessionId)}/judged-answer` ``.
- `quiz.ts`: `QuizState` gains `judging: JudgeAttempt`. Wherever a new card is applied (`applyQueued`, and `enter`'s initial state in `useSession.tsx`), `judging` is `'idle'`.
- `useSession.tsx`: `SessionValue` gains `judging` and `submitJudged`. Implement `submitJudged` after `submitSpeech`, in its shape:

```ts
  // Phase 27 (spec D13). The server judges, so the banner waits for it. A
  // failed check keeps the card, and its text, for another try.
  const submitJudged = useCallback(
    (text: string) => {
      if (!state || !state.question || !canJudge(state.judging, state.answer !== null)) return;
      const { sessionId, userId, question } = state;
      const mine = (latest: QuizState | null) =>
        latest !== null && latest.sessionId === sessionId && latest.question?.id === question.id && latest.answer === null && latest.judging === 'checking';
      setState((current) => (current ? { ...current, judging: 'checking' } : current));
      void api
        .judgeAnswer(sessionId, { user_id: userId, question_id: question.id, text })
        .then((response) => {
          setState((latest) =>
            latest && mine(latest)
              ? { ...latest, judging: 'idle', answer: judgedAnswer(text, response), queued: queuedFrom(response.next) }
              : latest,
          );
        })
        .catch(() => {
          setState((latest) => (latest && mine(latest) ? { ...latest, judging: 'failed' } : latest));
        });
    },
    [state, api],
  );
```

  and expose `judging: state.judging` and `submitJudged` in both value objects, adding `submitJudged` to the `useMemo` dependency list. Read how `answer` updates the score count (`correctCount`) for a spoken answer and make sure a judged answer counts the same way (`verdictCorrect`).
- `TypedAnswerView.tsx`: add the four props. The `question` union gains `TypedMeaningQuestion`; its prompt branch is the same as the typed card's (it has `question` and `part_of_speech`), and the root `View` gets `testID="meaning-card"` when `question.type === 'typed_meaning'`. The input's style takes `direction`: `{ textAlign: direction === 'rtl' ? 'right' : 'left', writingDirection: direction }` replacing the fixed LTR pair, with the comment "The answer's language decides: a target word left to right, a Hebrew meaning right to left (phase 27 D13)." While `checking`: the input is not editable, the check button is disabled and reads `strings.checking`, and the show-answer link is hidden. When `failed`: under the button, a `Text` `testID="judge-failed"` with `strings.couldNotCheck`, and a `Pressable` `testID="judge-try-again"` labelled `strings.tryAgain` that calls `onRetry`. The local `text` state already survives a failure, since `question.id` does not change.
- `session.tsx`: every existing `TypedAnswerView` gets `direction="ltr"`, `checking={false}`, `failed={false}`, `onRetry={() => undefined}`. The new case:

```tsx
    case 'typed_meaning':
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionMeaning}
          language={language}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer).verdict : null}
          direction="rtl"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          onRetry={() => session.submitJudged(lastTextRef.current)}
          onSubmit={(text) => {
            lastTextRef.current = text;
            session.submitJudged(text);
          }}
        />
      );
```

  `lastTextRef` is a `useRef('')` created in `SessionScreen` and passed into `renderQuestion` with the other arguments; adapt the signature. (Retry sends the text that failed. Typing a new text and pressing בדיקה also works, since `failed` allows a submit.)
- `progress.ts` (mobile): if the missed list's word → meaning pair switches on type, add `typed_meaning`: word `question.question`, meaning `question.meaning`.

- [ ] **Step 4: Run the mobile suite and the whole typecheck**

Run: `(cd apps/mobile && npx jest) && npm run typecheck && npm run lint:arch`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): the meaning-recall card, judged by the server while it checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The judge's eval

**Files:**
- Modify: `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/askModel.ts`, `apps/server/tests/eval/run.ts`

**Interfaces:**
- Consumes: `buildMeaningJudgePrompt`, `parseMeaningJudge`, `meaningRuleVerdict`, `MeaningJudgeContext` (Task 2); `createGeminiClient`'s `thinkingBudget` (Task 4).
- Produces: `JUDGE_CASES: JudgeCase[]` where `type JudgeCase = { label: string; context: MeaningJudgeContext; answer: string; expect: 'exact' | 'alternative' | 'wrong' }`; `askJudge(llm, kase): Promise<TypedVerdict | null>`; a `judge tier 2` scorecard line with its own threshold check.

- [ ] **Step 1: Write the cases**

In `cases.ts`, after `TRANSCRIPTION_CASES`, at least 30 `JudgeCase`s, ten per target language (`it`, `ru`, `en`), each over a real saved-word shape with an example and its translation. Each language has at least:
- two synonyms that are `exact` (`prenotare`/להזמין → `לשריין`; `begin`/להתחיל → `לפתוח`);
- two other forms or tenses that are `exact` (`parlare`/לדבר → `מדבר`, `דיבר`);
- one with a prefix or niqqud or a small Hebrew typo that is `exact` (`ספר` → `הספר`; `להזמין` → `להזמן`);
- two other senses that are `alternative` (`book` saved as להזמין → `ספר`; `pianta` saved as צמח → `מפה`; `лук` saved as בצל → `קשת`);
- three wrong ones: a related but different meaning (`book`/להזמין → `לבטל`), a too general one (`спешить`/למהר → `ללכת`), and an unrelated one.

Word every case's `label` by what it tests (`'it synonym: prenotare → לשריין'`). Do not include an answer equal to the stored meaning: the rule decides those without a call, and the eval scores the prompt.

- [ ] **Step 2: Add the runner**

`askModel.ts`:

```ts
/** Phase 27. The real meaning-judge prompt and parser over one answer — what
 *  answerJudged sends when no rule decides. Null when unreadable. */
export async function askJudge(llm: LlmClient, kase: { context: MeaningJudgeContext; answer: string }): Promise<TypedVerdict | null> {
  return parseMeaningJudge(await llm(buildMeaningJudgePrompt(kase.context, kase.answer)));
}
```

`run.ts`: filter `JUDGE_CASES` by `matches(kase.label, kase.answer, kase.context.form)`; include their count in the "matched no case" check; build a `judge` client exactly as production does (`createGeminiClient({ …, timeoutMs: TIMEOUT_MS, thinkingBudget: 0 })`); `scoreJudge` returns a row with tier 1 `the answer parses` and tier 2 `judged <expect>` (detail: the verdict received); score judge rows on their own line, `judge tier 2: p/t = x% (threshold 85%)`, include `judgeScore` in the report JSON, and exit 1 when `belowThreshold(judgeTotal, judgeScore)`. Print each row's verdict in the scorecard, as `heard=` is printed.

- [ ] **Step 3: Run it against the real model**

Run: `(cd apps/server && npx tsx tests/eval/run.ts judge)` — the filter matches every label containing "judge"; if the labels do not, use a filter that selects exactly the judge cases (each label can start with `judge `).
Expected: tier 1 has 0 failures; judge tier 2 ≥ 85%.

If tier 2 falls short: read each failing row. A case whose expected verdict is genuinely arguable is reworded or replaced with a clearer one, and the reason goes in its label's comment. A pattern the model gets wrong changes the prompt in `domain/judge.ts` (keep `judge.test.ts` green). Only if prompt changes cannot reach the threshold, set `thinkingBudget` to a small number (for example 512) in *both* `composition.ts` and the eval, rerun, and record the measured effect in the spec's status. Never lower `TIER2_THRESHOLD`. Run the full eval once at the end — `(cd apps/server && npx tsx tests/eval/run.ts)` — so the other groups are seen to be unaffected.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/eval apps/server/src/domain/judge.ts apps/server/src/domain/judge.test.ts
git commit -m "test(eval): the meaning judge, scored against the real model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: End to end, the shifted rotation, and the spec records what was built

**Files:**
- Modify: `e2e/tests/support/cards.ts`, `e2e/tests/support/mockServer.ts`
- Create: `e2e/tests/meaning-recall.spec.ts`
- Modify: whichever existing specs fail on the shifted rotation (expect `question-types.spec.ts`, `next-session.spec.ts`, `progress.spec.ts`, `session.spec.ts`, `listening-variety.spec.ts`, `speaking.spec.ts` to be candidates; change only those that fail)
- Modify: `docs/superpowers/specs/2026-10-07-lang-tutor-phase-27-deeper-question-types-design.md` (status)

**Interfaces:**
- Consumes: everything above. The card's `testID`s from Global Constraints.
- Produces: `CardKind` gains `'meaning'`, detected by `meaning-card` before the typed check; `expectJudge(request, verdict)` in e2e's `mockServer.ts`.

- [ ] **Step 1: Teach the helpers the new card**

`cards.ts`: `CardKind` gains `'meaning'`; in `kindOnScreen`, before `if (await has('typed-input')) return 'typed';`, add `if (await has('meaning-card')) return 'meaning';`. Add:

```ts
/** Phase 27. Answers a meaning card. The stored meaning is judged by rule,
 *  with no model call; anything else needs an expectJudge stub first. */
export async function answerMeaning(page: Page, text: string) {
  await page.getByTestId('typed-input').fill(text);
  await page.getByTestId('typed-submit').click();
}
```

`mockServer.ts` (e2e): `expectJudge(request, verdict: 'right' | 'other_sense' | 'wrong')`, a copy of `expectTranscription` matching `[\s\S]*judge the learner's answer[\s\S]*`, answering `{ verdict }`.

- [ ] **Step 2: Write the new spec**

`e2e/tests/meaning-recall.spec.ts`: a new learner saves four Italian words (reuse the lexeme helpers the other specs use), with the generation stub answering positions 1–3 by their tasks (`generationStubFor({ 1: 'meaning', 2: 'word', 3: 'typed' })`), and starts the first list session. At ordinal 0 with no voices, position 4 is `typed_meaning` (D9's fall-through). The test:
1. answers positions 1–3 right;
2. at position 4, reads the card as `'meaning'`, checks the instruction `כתבו את הפירוש בעברית`, and that the input's direction is right to left (`dir`/computed `direction` is `rtl`);
3. registers `expectJudge(request, 'right')`, types a synonym of the word's saved meaning, presses בדיקה, sees `בודקים…`, then the banner `נכון! הפירוש השמור:` with the saved meaning;
4. continues to the results, where the word is listed with its meaning.

A second test, on a fresh learner: register `expectGeminiFailure(request, 500)` *after* the generation stub has been consumed (or with priority above it, matched on the judge marker — add a `status` option to `expectJudge` if needed), type a synonym, see `לא הצלחנו לבדוק` and `נסו שוב`; then register `expectJudge(request, 'wrong')`, press `judge-try-again`, and see `התשובה הנכונה:` with the meaning.

- [ ] **Step 3: Run the whole e2e suite and fix what the rotation shifted**

Run: `npm run e2e`.
For each failure caused by the new rotation (a position that now shows a meaning card), update that spec: expect `'meaning'` at that position and answer it with `answerMeaning(page, <the word's saved meaning>)` (judged by rule, no stub) or `typed-show-answer` when the test wants it wrong. Confirm each new expected type by hand from D9's tiers and the fall-through, never by copying what the run printed. A failure not caused by the rotation is a bug to fix, not an expectation to change.

- [ ] **Step 4: Run every suite**

Run: `npm test && npm run test:all && npm run typecheck && npm run lint:arch && npm run e2e`
Expected: all pass. (`npm run eval` is Task 6's.) Drop probe databases if any are left (`npm run lane:list`).

- [ ] **Step 5: Record what was built**

In the spec's Status bullet, add: "Part A is implemented on branch `phase-27-deeper-question-types` from `docs/superpowers/plans/2026-10-07-phase-27-part-a-meaning-recall.md`. Planning and building found these deviations:" followed by one line per deviation (the four in this plan's header, plus any found while building, such as a thinking budget the eval needed, with its measured effect).

- [ ] **Step 6: Commit**

```bash
git add e2e docs/superpowers/specs
git commit -m "test(e2e): the meaning-recall card, and the rotation it shifts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
