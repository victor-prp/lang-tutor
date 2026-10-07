# Phase 23 — More Question Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List sessions mix today's card with Hebrew → target multiple choice and Hebrew → target typed answers, and the two written dimensions those feed go live.

**Architecture:** `Question` becomes a discriminated union of three types in `packages/core`, with one pure typed-answer judge that both the app (instant feedback) and the server (authoritative verdict) run. The server assigns types by position, asks the model one call for per-task content (Hebrew wrong options, target wrong options, or accepted alternatives), stores typed answers as text plus verdict, and feeds phase 20's evidence table.

**Tech Stack:** TypeScript, Zod 4, Hono + @hono/zod-openapi, Drizzle + Postgres, pg-boss, Expo / React Native, Jest, Playwright, Gemini evals.

**Spec:** `docs/superpowers/specs/2026-10-06-lang-tutor-phase-23-question-types-design.md`

## Global Constraints

- Every ADR in `docs/adr/` holds; `npm run lint:arch` must print nothing.
- `domain/` stays pure: no clock, no randomness, no I/O (ADR 0001 R3).
- Every wire type in `packages/core/src/api/types.ts` is a `z.infer` (ADR 0003 R3); `api/index.ts` exports types only.
- No `jest.mock`, no defaulted collaborator parameters (ADR 0002).
- `multiple_choice` keeps its exact name, shape and meaning; the seed session is unchanged.
- Type cycle: `['multiple_choice', 'reverse_choice', 'typed_translation']`, by position.
- Typed text on the wire: at most 100 characters, may be empty.
- At most five alternatives per typed question.
- The marker `three wrong answers` stays in the generation prompt.
- `LIVE_DIMENSIONS = ['written_receptive', 'written_productive', 'spelling']`.
- Hebrew UI strings use the plural/neutral forms the app already uses (`נסו`, `כתבו`, noun forms).
- Never hardcode a port or a database name (ADR 0006). No lane is available in this worktree: run unit tests, `npm run typecheck`, `npm run lint:arch` and evals locally; integration and e2e run in CI.
- Never lower `TIER2_THRESHOLD`.

## Review Focus

1. **iOS smart punctuation:** `l’acqua` typed for `l'acqua` must be exact → judge test in Task 1.
2. **Phone keyboard capitalisation and a trailing space:** `Casa ` for `casa` must be exact → judge test in Task 1.
3. **A retried typed next-step** (the client resends after the server recorded it) must replay, not desync or double-count → `step` test in Task 2.
4. **A model answer with `alternatives` missing, null-ish, Hebrew, or a copy of the answer** must still prepare the session → validation test in Task 2.
5. **Sessions and answers stored before this deploy** (all `multiple_choice`, every answer an option) must load and answer unchanged → migration integration test in Task 7.

---

### Task 1: Core — the question union, the typed judge, evaluate

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Create: `packages/core/src/domain/typed.ts`, `packages/core/src/domain/typed.test.ts`
- Modify: `packages/core/src/domain/quiz.ts`, `packages/core/src/domain/quiz.test.ts`, `packages/core/src/domain/progress.ts`, `packages/core/src/domain/progress.test.ts`, `packages/core/src/domain/index.ts`, `packages/core/src/api/schemas.test.ts`

**Interfaces:**
- Produces (wire, `@lang-tutor/core/api`): `Question` = `MultipleChoiceQuestion | ReverseChoiceQuestion | TypedTranslationQuestion`; `QuestionType` = `Question['type']`; `TypedVerdict` = `'exact' | 'near_miss' | 'alternative' | 'wrong'`; `AnswerRecord` gains `verdict?: TypedVerdict`; `NextStepRequest` = `{ user_id, question_id, option_index } | { user_id, question_id, text }`; `SessionProgressItem` gains `raised: KnowledgeDimension[]`; `LlmDistractors.items[]` = `{ key, distractors: string[] (≤3), alternatives?: string[] (≤10) }`.
- Produces (domain, `@lang-tutor/core/domain`): `AnswerInput = { option_index: number } | { text: string }`; `judgeTyped(question: TypedTranslationQuestion, text: string): TypedVerdict`; `normaliseTyped(text: string): string`; `evaluate(question: Question, answer: AnswerInput): AnswerRecord` (throws on a kind mismatch — callers check first); `answerFits(question, answer): boolean`; `rightAnswer(question): string`; `shuffleOptions(question, rng): Question`; `isChoice(question): question is MultipleChoiceQuestion | ReverseChoiceQuestion`; `TYPE_CYCLE`; `LIVE_DIMENSIONS` with three entries.

- [ ] **Step 1: Write the failing judge tests** — `packages/core/src/domain/typed.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import type { TypedTranslationQuestion } from '../api/types';
import { judgeTyped, normaliseTyped } from './typed';

const q = (answer: string, lemma = answer, alternatives: string[] = []): TypedTranslationQuestion => ({
  id: 'q1', type: 'typed_translation', vocab_term_id: 'l1', question: 'בית', part_of_speech: 'noun',
  answer, lemma, alternatives,
});

describe('normaliseTyped', () => {
  it('trims, collapses spaces, lowercases and drops trailing punctuation', () => {
    expect(normaliseTyped('  Thank   You! ')).toBe('thank you');
  });
  it('folds typographic apostrophes', () => {
    expect(normaliseTyped('l’acqua')).toBe("l'acqua");
  });
  it('removes Cyrillic stress marks but keeps Latin accents', () => {
    expect(normaliseTyped('молоко́')).toBe('молоко');
    expect(normaliseTyped('perché')).toBe('perché');
  });
});

describe('judgeTyped', () => {
  it('is exact for the form, ignoring case and a trailing space', () => {
    expect(judgeTyped(q('casa'), 'Casa ')).toBe('exact');
  });
  it('is exact for the lemma of an inflected form', () => {
    expect(judgeTyped(q('parlo', 'parlare'), 'parlare')).toBe('exact');
  });
  it('is exact with a leading article or "to"', () => {
    expect(judgeTyped(q('libro'), 'il libro')).toBe('exact');
    expect(judgeTyped(q('acqua'), "l'acqua")).toBe('exact');
    expect(judgeTyped(q('acqua'), 'l’acqua')).toBe('exact');
    expect(judgeTyped(q('remember'), 'to remember')).toBe('exact');
    expect(judgeTyped(q('to remember', 'remember'), 'remember')).toBe('exact');
  });
  it('is an alternative for another right word, before any near miss', () => {
    expect(judgeTyped(q('big', 'big', ['large']), 'large')).toBe('alternative');
    expect(judgeTyped(q('bello', 'bello', ['bella']), 'bella')).toBe('alternative');
  });
  it('is a near miss for a missing accent or ё, at any length', () => {
    expect(judgeTyped(q('perché'), 'perche')).toBe('near_miss');
    expect(judgeTyped(q('più'), 'piu')).toBe('near_miss');
    expect(judgeTyped(q('ёлка'), 'елка')).toBe('near_miss');
  });
  it('is a near miss for one edit on a word of five letters or more', () => {
    expect(judgeTyped(q('finestra'), 'finestar')).toBe('near_miss');
    expect(judgeTyped(q('finestra'), 'fineestra')).toBe('near_miss');
    expect(judgeTyped(q('finestra'), 'finstra')).toBe('near_miss');
    expect(judgeTyped(q('finestra'), 'finestre')).toBe('near_miss');
  });
  it('is wrong for one edit on a short word, two edits, another word, or nothing', () => {
    expect(judgeTyped(q('casa'), 'cosa')).toBe('wrong');
    expect(judgeTyped(q('finestra'), 'finestro!x')).toBe('wrong');
    expect(judgeTyped(q('finestra'), 'porta')).toBe('wrong');
    expect(judgeTyped(q('finestra'), '')).toBe('wrong');
    expect(judgeTyped(q('finestra'), '   ')).toBe('wrong');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest packages/core/src/domain/typed.test.ts` (from repo root: `npm test -w packages/core -- typed`). Expected: FAIL, module `./typed` not found.

- [ ] **Step 3: Wire schemas** — in `packages/core/src/api/schemas.ts`, replace the question block:

```ts
// Phase 23. Today's card: the target word, four meanings in the learner's language.
export const MultipleChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('multiple_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// Phase 23. The same card turned round: the meaning, four target words.
// `part_of_speech` disambiguates a Hebrew prompt (ספר is a book or "counted").
export const ReverseChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('reverse_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// Phase 23. The meaning; the learner types the target word. The client holds
// what it needs to judge locally, as it holds `correct_option` on a choice:
// the saved form, its lemma, and other words the model said are also right.
export const TypedTranslationQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('typed_translation'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  answer: z.string(),
  lemma: z.string(),
  alternatives: z.array(z.string()),
});

export const QuestionSchema = z.discriminatedUnion('type', [
  MultipleChoiceQuestionSchema,
  ReverseChoiceQuestionSchema,
  TypedTranslationQuestionSchema,
]);

// Phase 23. How a typed answer was judged (spec D5). Every verdict but `wrong`
// counts in the score.
export const TypedVerdictSchema = z.enum(['exact', 'near_miss', 'alternative', 'wrong']);

export const AnswerRecordSchema = z.object({
  question_id: z.string(),
  is_correct: z.boolean(),
  answer_string: z.string(),
  // Phase 23. Present for a typed answer only.
  verdict: TypedVerdictSchema.optional(),
});
```

`SessionProgressItemSchema` gains `raised: z.array(KnowledgeDimensionSchema)` (comment: "the live dimensions that rose in this session"). `NextStepRequestSchema` becomes:

```ts
// Phase 23. A choice is answered by index, a typed card by its text. Empty
// text is "show me the answer", which is wrong.
export const NextStepRequestSchema = z.union([
  z.object({
    user_id: z.string().min(1),
    question_id: z.string().min(1),
    option_index: z.number().int().nonnegative(),
  }),
  z.object({
    user_id: z.string().min(1),
    question_id: z.string().min(1),
    text: z.string().max(100),
  }),
]);
```

`LlmDistractorsSchema` item becomes `z.object({ key: z.string(), distractors: z.array(z.string()).max(3), alternatives: z.array(z.string()).max(10).optional() })`, with the comment updated: three for a choice item, none for a typed one; `alternatives` is optional and capped at twice what is kept, so a surplus never fails a session (same reasoning as `LlmTranslationSchema.alternatives`).

`types.ts`: add `ReverseChoiceQuestion`, `TypedTranslationQuestion`, `TypedVerdict` as `z.infer`s; `index.ts`: export them as types.

- [ ] **Step 4: The judge** — `packages/core/src/domain/typed.ts`:

```ts
import type { TypedTranslationQuestion, TypedVerdict } from '../api/types';

/**
 * Phase 23. How a typed answer is judged (spec D5). Pure, and shared on
 * purpose: the app runs it for instant feedback, the server runs it again for
 * the verdict it stores, and one function over the same data cannot disagree.
 */

// One leading word a learner may add or drop: an English or Italian article,
// or the English infinitive marker. Language-agnostic, because a false accept
// ("a casa" for "casa") costs nothing and plumbing a language costs a field.
const LEADING = new Set(['to', 'a', 'an', 'the', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una']);
const ELIDED = ["l'", "un'"];

const NEAR_MISS_MIN_LETTERS = 5;

export function normaliseTyped(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[’‘ʼ]/g, "'")
    .replace(/(\p{Script=Cyrillic})́/gu, '$1')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?…]+$/u, '');
}

/** The text without one leading article or "to", when anything is left. */
function bare(text: string): string {
  const space = text.indexOf(' ');
  if (space > 0 && LEADING.has(text.slice(0, space))) return text.slice(space + 1);
  for (const prefix of ELIDED) {
    if (text.startsWith(prefix) && text.length > prefix.length) return text.slice(prefix.length);
  }
  return text;
}

const same = (a: string, b: string) => a === b || bare(a) === bare(b);

/** Without diacritics: `perché` → `perche`, `ёлка` → `елка`. */
const undotted = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');

/** Optimal string alignment distance, capped: true when at most one edit
 *  (insert, delete, substitute, or swap two neighbours) turns a into b. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const x = [...a];
  const y = [...b];
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[x.length][y.length] <= 1;
}

const letterCount = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

function nearMiss(typed: string, target: string): boolean {
  const t = bare(typed);
  const w = bare(target);
  if (undotted(t) === undotted(w)) return true;
  return letterCount(w) >= NEAR_MISS_MIN_LETTERS && oneEditApart(t, w);
}

export function judgeTyped(question: TypedTranslationQuestion, text: string): TypedVerdict {
  const typed = normaliseTyped(text);
  if (typed === '') return 'wrong';
  const targets = [...new Set([question.answer, question.lemma].map(normaliseTyped))];
  if (targets.some((target) => same(typed, target))) return 'exact';
  if (question.alternatives.map(normaliseTyped).some((alt) => same(typed, alt))) return 'alternative';
  if (targets.some((target) => nearMiss(typed, target))) return 'near_miss';
  return 'wrong';
}
```

- [ ] **Step 5: quiz.ts** — rewrite `evaluate`, add helpers, keep `pickQuestions`/`score`/`missed` behaviour:

```ts
export type AnswerInput = { option_index: number } | { text: string };

export type ChoiceQuestion = MultipleChoiceQuestion | ReverseChoiceQuestion;

export function isChoice(question: Question): question is ChoiceQuestion {
  return question.type !== 'typed_translation';
}

/** A choice is answered by index, a typed card by text. */
export function answerFits(question: Question, answer: AnswerInput): boolean {
  return isChoice(question) ? 'option_index' in answer : 'text' in answer;
}

/** What the learner should have answered, as the feedback and the missed list show it. */
export function rightAnswer(question: Question): string {
  return isChoice(question) ? question.options[question.correct_option] : question.answer;
}

/** A choice's options in a new order; a typed card has none and is returned as is. */
export function shuffleOptions(question: Question, rng: () => number): Question {
  if (!isChoice(question)) return question;
  const correct = question.options[question.correct_option];
  const options = shuffle(question.options, rng);
  return { ...question, options, correct_option: options.indexOf(correct) };
}

// Callers check answerFits (and an option's range) first: the session's step
// owns those outcomes, so here a mismatch is a programming error.
export function evaluate(question: Question, answer: AnswerInput): AnswerRecord {
  if (isChoice(question) && 'option_index' in answer) {
    return {
      question_id: question.id,
      is_correct: answer.option_index === question.correct_option,
      answer_string: question.options[answer.option_index],
    };
  }
  if (!isChoice(question) && 'text' in answer) {
    const verdict = judgeTyped(question, answer.text);
    return { question_id: question.id, is_correct: verdict !== 'wrong', answer_string: answer.text, verdict };
  }
  throw new Error(`answer does not fit a ${question.type} question`);
}
```

`missed` uses `rightAnswer(question)` for `correct_answer`. `pickQuestions` maps with `shuffleOptions`. `domain/index.ts` exports `AnswerInput`, `ChoiceQuestion`, `answerFits`, `evaluate`, `isChoice`, `judgeTyped`, `normaliseTyped`, `rightAnswer`, `shuffleOptions`.

- [ ] **Step 6: LIVE_DIMENSIONS** — `packages/core/src/domain/progress.ts`: `LIVE_DIMENSIONS = ['written_receptive', 'written_productive', 'spelling']` with the comment naming phase 23's three exercise types. Update `progress.test.ts` if it pins the old list.

- [ ] **Step 7: Update quiz tests** — every `evaluate(q, n)` becomes `evaluate(q, { option_index: n })`; add:

```ts
describe('evaluate, typed', () => {
  const typed: Question = { id: 't1', type: 'typed_translation', vocab_term_id: 'l1', question: 'בית',
    part_of_speech: 'noun', answer: 'casa', lemma: 'casa', alternatives: ['abitazione'] };
  it('counts a near miss and an alternative as correct, and keeps the text and verdict', () => {
    expect(evaluate(typed, { text: 'casa' })).toEqual({ question_id: 't1', is_correct: true, answer_string: 'casa', verdict: 'exact' });
    expect(evaluate(typed, { text: 'abitazione' }).is_correct).toBe(true);
    expect(evaluate(typed, { text: '' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });
  it('lists a wrong typed answer as missed, with the form as the right answer', () => {
    expect(missed([typed], [evaluate(typed, { text: 'porta' })])).toEqual([{ question: typed, correct_answer: 'casa' }]);
  });
  it('refuses an answer of the wrong kind', () => {
    expect(answerFits(typed, { option_index: 0 })).toBe(false);
    expect(() => evaluate(typed, { option_index: 0 })).toThrow();
  });
});
```

`schemas.test.ts`: add parse cases for the three question shapes, both request shapes (and that `{ option_index, text }` with neither user field fails), `text` of 101 characters failing, and `alternatives` optional in `LlmDistractorsSchema`.

- [ ] **Step 8: Run** — `npm test -w packages/core` and `npm run typecheck -w packages/core`. Expected: PASS. (The server and mobile will not typecheck until Tasks 2–6.)

- [ ] **Step 9: Commit** — `feat(core): three question types and the typed-answer judge`.

---

### Task 2: Server domain — type cycle, step, evidence, generation

**Files:**
- Modify: `apps/server/src/domain/session.ts`, `session.test.ts`, `progress.ts`, `progress.test.ts`, `distractors.ts`, `distractors.test.ts`

**Interfaces:**
- Consumes: Task 1's `AnswerInput`, `answerFits`, `evaluate`, `isChoice`, `QuestionType`, `TypedVerdict`, `LIVE_DIMENSIONS`.
- Produces: `TYPE_CYCLE: readonly QuestionType[]`, `typeFor(position: number): QuestionType`; `step(record, questionId, answer: AnswerInput): StepOutcome` with new `{ status: 'wrong_answer_kind' }`; `AnsweredQuestion = { senseId; type: 'multiple_choice' | 'reverse_choice'; correct: boolean } | { senseId; type: 'typed_translation'; verdict: TypedVerdict }`; `ProgressChange` gains `raised: Dimension[]`; `Task = 'meaning' | 'word' | 'typed'`, `taskFor(type)`; `DistractorItem` gains `task`; `distractorItems(context, types: QuestionType[])`; `DistractorVerdict` ok branch `byKey: Map<string, { distractors: string[]; alternatives: string[] }>`; `generatedContent(row: GenerationContext, type: QuestionType, generated: { distractors: string[]; alternatives: string[] }): { prompt: string | null; options: QuestionOption[] | null; alternatives: string[] | null }` where `QuestionOption = { position: number; text: string; is_correct: boolean }` (declared in this module, structurally the db type); `MAX_ALTERNATIVES = 5`.

- [ ] **Step 1: Failing tests, session** — in `session.test.ts` convert `step(record, id, n)` calls to `{ option_index: n }` and add:

```ts
describe('typeFor', () => {
  it('cycles choice, reverse, typed from the first position', () => {
    expect(Array.from({ length: 10 }, (_, i) => typeFor(i))).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'multiple_choice',
    ]);
  });
});

describe('step, typed', () => {
  // record with questions [typedQ('t1'), typedQ('t2')]
  it('records a typed answer with its verdict', ...);   // advanced, answers[0].verdict === 'near_miss'
  it('refuses text for a choice and an index for a typed card', ...); // { status: 'wrong_answer_kind' }
  it('replays a retried typed answer without recording it twice', ...); // second call with same id → replayed
});
```

(Write them out in full with a `typedQ(id)` helper building `{ id, type: 'typed_translation', vocab_term_id: 'l', question: 'חלון', part_of_speech: 'noun', answer: 'finestra', lemma: 'finestra', alternatives: [] }`, using `step(record, 't1', { text: 'finestar' })`.)

- [ ] **Step 2: Implement session** —

```ts
/** Phase 23. A list session's types, by position (spec D2). */
export const TYPE_CYCLE: readonly QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];
export const typeFor = (position: number): QuestionType => TYPE_CYCLE[position % TYPE_CYCLE.length];
```

`step(record, questionId, answer: AnswerInput)`: the replay branches are unchanged (they ignore the answer). On the expected question: `if (!answerFits(expected, answer)) return { status: 'wrong_answer_kind' };` then, for `'option_index' in answer`, the existing range check, then `evaluate(expected, answer)`.

- [ ] **Step 3: Failing tests, progress** — in `progress.test.ts` add an `evidenceFor` table test covering every row of spec D6:

```ts
it.each([
  [{ senseId: 's', type: 'multiple_choice', correct: true }, [['written_receptive', true, false]]],
  [{ senseId: 's', type: 'multiple_choice', correct: false }, [['written_receptive', false, false]]],
  [{ senseId: 's', type: 'reverse_choice', correct: true }, [['written_receptive', true, false], ['written_productive', true, true]]],
  [{ senseId: 's', type: 'reverse_choice', correct: false }, [['written_productive', false, true]]],
  [{ senseId: 's', type: 'typed_translation', verdict: 'exact' }, [['written_receptive', true, false], ['written_productive', true, false], ['spelling', true, false]]],
  [{ senseId: 's', type: 'typed_translation', verdict: 'near_miss' }, [['written_receptive', true, false], ['written_productive', true, false], ['spelling', false, false]]],
  [{ senseId: 's', type: 'typed_translation', verdict: 'alternative' }, []],
  [{ senseId: 's', type: 'typed_translation', verdict: 'wrong' }, [['written_productive', false, false]]],
] as const)('%o gives %j', (answer, expected) => {
  expect(evidenceFor(answer as AnsweredQuestion).map((p) => [p.dimension, p.correct, p.capped])).toEqual(expected);
});
```

plus: reverse-only correct evidence over several days stops `written_productive` at 3 (`evaluateSession` across days with `advance`), and `progressChanges` returns `raised: ['written_receptive']` for a row set where only that live dimension rose, `[]` where nothing rose, and the badge over three live dimensions (`(2,1,1)` → 1). Update existing `progressChanges` expectations to include `raised` and the three-dimension badge.

- [ ] **Step 4: Implement progress** — `evidenceFor`:

```ts
export function evidenceFor(answer: AnsweredQuestion): Evidence[] {
  const piece = (dimension: Dimension, correct: boolean, capped = false): Evidence => ({ dimension, correct, capped });
  switch (answer.type) {
    case 'multiple_choice':
      return [piece('written_receptive', answer.correct)];
    case 'reverse_choice':
      // Recognition of the form: productive evidence capped at 3, and a success
      // credits recognition below it. A failure says nothing about recognition.
      return answer.correct
        ? [piece('written_receptive', true), piece('written_productive', true, true)]
        : [piece('written_productive', false, true)];
    case 'typed_translation':
      switch (answer.verdict) {
        case 'exact':
          return [piece('written_receptive', true), piece('written_productive', true), piece('spelling', true)];
        case 'near_miss':
          return [piece('written_receptive', true), piece('written_productive', true), piece('spelling', false)];
        case 'alternative':
          // Right, but not this word: no evidence about this sense.
          return [];
        case 'wrong':
          // A failure to recall says nothing about spelling.
          return [piece('written_productive', false)];
      }
  }
}
```

`progressChanges`: each change adds `raised: DIMENSIONS.filter((d) => live.includes(d) && shown.some((row) => row.dimension === d && row.levelAfter > row.levelBefore))`.

- [ ] **Step 5: Failing tests, distractors** — in `distractors.test.ts`: `buildDistractorPrompt` includes each item's `task` in the user JSON and both languages' writing rules (`Write Italian with every accent` and `no nikud`) and still contains `DISTRACTOR_MARKER`; `validateDistractors`:
  - a `word` item with three target words passes; with a Hebrew word fails (`contains Hebrew`); with the form as a distractor fails;
  - a `word` item whose distractor is another item's form with the same Hebrew prompt fails;
  - a `typed` item passes with no `alternatives` key, with `[]`, and with `['large', '', 'גדול', 'big', 'large', 'a', 'b', 'c', 'd', 'e']` cleaned to `['large', 'a', 'b', 'c', 'd']` (empty, Hebrew, the answer and repeats dropped, five kept); its `distractors` are ignored;
  - a `meaning` item keeps today's rules (existing tests, items given `task: 'meaning'`);
  - `generatedContent` per type: `multiple_choice` → prompt null, options translation-first, alternatives null; `reverse_choice` → prompt = translation, options form-first; `typed_translation` → prompt = translation, options null, alternatives as given.

- [ ] **Step 6: Implement distractors** — the prompt:

```ts
export type Task = 'meaning' | 'word' | 'typed';
export const taskFor = (type: QuestionType): Task =>
  type === 'multiple_choice' ? 'meaning' : type === 'reverse_choice' ? 'word' : 'typed';

const system = [
  `You write the answers for a ${learned.name} vocabulary quiz for a Hebrew-speaking learner.`,
  'Return JSON only, matching the supplied schema.',
  `Each item is a ${learned.name} word or phrase with its lemma and part of speech, its correct ${answers.name} translation, and a task:`,
  `- "meaning": the learner sees the ${learned.name} word and picks its ${answers.name} translation. Write ${DISTRACTOR_MARKER} in ${answers.name} as distractors.`,
  `- "word": the learner sees the ${answers.name} translation and picks the ${learned.name} word. Write ${DISTRACTOR_MARKER} in ${learned.name} as distractors.`,
  `- "typed": the learner sees the ${answers.name} translation and types the ${learned.name} word. Leave distractors empty. As alternatives, list every other ${learned.name} word or phrase that translates it equally well in this sense, at most five, or none.`,
  'Each wrong answer must be plausible: the same part of speech, the same register and a',
  'similar length as the correct answer.',
  'A wrong answer must never be right: not the correct answer itself, not a synonym of it, and',
  'not another valid translation of the word.',
  'The three wrong answers of an item must differ from each other.',
  "When several items share a word, none of an item's wrong answers may be another item's correct answer.",
  'Answer every item, using its key exactly as given.',
  ...answers.writing,
  ...learned.writing,
].join('\n');
// user: { items: [{ key, task, word, lemma, part_of_speech, correct }] }
```

`validateDistractors(items, answer)`: per item by `task` — `meaning`: today's checks; `word`: three non-empty distinct, none `comparable` to the form or lemma, none containing a Hebrew letter (`/\p{Script=Hebrew}/u`), none the form of a sibling with the same `comparable(translation)`; `typed`: `alternatives` cleaned (trim; drop empty, Hebrew, comparable to form or lemma, repeats; keep `MAX_ALTERNATIVES`). Returns `byKey` of `{ distractors, alternatives }`. `generatedContent` as in Interfaces.

- [ ] **Step 7: Run** — `npm test -w apps/server -- domain`. Expected: PASS.

- [ ] **Step 8: Commit** — `feat(server): type cycle, evidence for the new types, three-task generation`.

---

### Task 3: Persistence — schema, migration 0015, repositories

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/migrate.ts` (only if a function changes), `apps/server/src/repo/questions.ts`, `repo/sessions.ts`, `repo/progress.ts`
- Create: `apps/server/src/db/migrations/0015_question_types.sql` (+ snapshot, journal) via `npm run db:generate -w apps/server`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `AnsweredQuestion`, `QuestionOption`.
- Produces: `questionFrom(row: QuestionRow, order: number[] | null): Question` where `QuestionRow = { id; type: string; prompt: string | null; options: QuestionOption[] | null; alternatives: string[] | null; form: string; lemma: string; partOfSpeech: string; lexemeId: string }`; `insertGeneratedQuestions({ userId, enrollmentId, targetLanguage, userLanguageCode, questions: { senseId; variantId; form; lemma; partOfSpeech; lexemeId; type: QuestionType; prompt: string | null; options: QuestionOption[] | null; alternatives: string[] | null }[] }): Promise<Question[]>`; `insertAnswer(sessionId, position, questionId, answer: { displayIndex: number } | { text: string; verdict: TypedVerdict })`; `findSessionEvidence` returns `AnsweredQuestion[]` including typed verdicts; `findSnapshot` reads `prompt ?? correct option`.

- [ ] **Step 1: Schema** — `questions`: `options` drops `.notNull()`; add `prompt: text('prompt')`, `alternatives: text('alternatives').array()`; replace the options check with `check('questions_options_valid', sql\`${t.options} is null or question_options_valid(${t.options})\`)`; add

```ts
check('questions_type_known', sql`${t.type} in ('multiple_choice', 'reverse_choice', 'typed_translation')`),
// Phase 23. Each type's shape (spec D13): a choice has options, a reversed or
// typed card stores its Hebrew prompt, and only a typed card has alternatives.
check(
  'questions_shape_valid',
  sql`case ${t.type}
        when 'multiple_choice' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null
        when 'reverse_choice' then ${t.options} is not null and ${t.prompt} is not null and ${t.alternatives} is null
        when 'typed_translation' then ${t.options} is null and ${t.prompt} is not null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 5
        else false end`,
),
```

`answers`: `selectedOptionPosition` drops `.notNull()`; add `typedText: text('typed_text')`, `verdict: text('verdict')`; add

```ts
check(
  'answers_kind_valid',
  sql`(${t.selectedOptionPosition} is null) = (${t.typedText} is not null)
      and (${t.typedText} is null) = (${t.verdict} is null)`,
),
check('answers_verdict_known', sql`${t.verdict} in ('exact', 'near_miss', 'alternative', 'wrong')`),
check('answers_typed_text_length', sql`length(${t.typedText}) <= 100`),
```

- [ ] **Step 2: Generate the migration** — `npm run db:generate -w apps/server`, rename to `0015_question_types` in the journal if drizzle names it randomly (keep drizzle's name if the repo's convention allows; recent ones were renamed to descriptive tags — follow that: rename the file and the journal `tag`). Prepend a comment block: phase 23, every existing row satisfies the new checks unchanged. Verify `npm run db:check -w apps/server` passes.

- [ ] **Step 3: repo/questions.ts** — join `dict_lexemes` for `lemma` and `part_of_speech` wherever `questionFrom` is fed (`loadQuestionPool`, `insertGeneratedQuestions` input, `repo/sessions.loadSession`). `questionFrom`:

```ts
export function questionFrom(row: QuestionRow, order: number[] | null): Question {
  const base = { id: row.id, vocab_term_id: row.lexemeId };
  if (row.type === 'typed_translation') {
    return { ...base, type: 'typed_translation', question: row.prompt!, part_of_speech: row.partOfSpeech,
      answer: row.form, lemma: row.lemma, alternatives: row.alternatives ?? [] };
  }
  const canonical = canonicalOptions(row.options!);
  const shown = order && order.length > 0 ? order.map((position) => canonical[position]) : canonical;
  const choice = { options: shown.map((o) => o.text), correct_option: shown.findIndex((o) => o.is_correct) };
  return row.type === 'reverse_choice'
    ? { ...base, type: 'reverse_choice', question: row.prompt!, part_of_speech: row.partOfSpeech, ...choice }
    : { ...base, type: 'multiple_choice', question: row.form, ...choice };
}
```

`insertGeneratedQuestions` writes `type`, `prompt`, `options`, `alternatives` per question.

- [ ] **Step 4: repo/sessions.ts** — `insertSessionQuestions`: for a typed question, `optionOrder: []`; choice questions keep the text-to-canonical mapping (select `type` too, and skip the lookup for typed). `loadSession`: select `questions.type`, `prompt`, `alternatives`, lexeme `lemma`/`partOfSpeech`; answers select `typedText`, `verdict`; a typed answer record is `{ question_id, is_correct: verdict !== 'wrong', answer_string: typedText, verdict }`. `insertAnswer(sessionId, position, questionId, answer)`: `{ displayIndex }` keeps today's path; `{ text, verdict }` inserts `typedText`, `verdict`, `selectedOptionPosition: null`.

- [ ] **Step 5: repo/progress.ts** — `findSessionEvidence` selects `q.type, a.verdict` and maps: `typed_translation` → `{ senseId, type, verdict }`, otherwise `{ senseId, type, correct: canonicalOptions(options)[selected].is_correct }`. `findSnapshot` selects `q.prompt` and sets `translation: row.prompt ?? correctOptionText`.

- [ ] **Step 6: Typecheck** — `npm run typecheck -w apps/server` (tests too: fix every `insertAnswer`/`AnsweredQuestion` call site in `tests/support/*` and `tests/integration/**` to the new shapes — `insertAnswer(s, p, q, n)` → `insertAnswer(s, p, q, { displayIndex: n })`).

- [ ] **Step 7: Commit** — `feat(server): store reversed and typed questions and typed answers`.

---

### Task 4: Service, errors, route

**Files:**
- Modify: `apps/server/src/errors.ts`, `services/sessions.ts`, `services/sessions.test.ts`, `services/sessions.prepare.test.ts`, `services/sessions.progress.test.ts`, `routes/sessions.ts`, `apps/server/tests/support/fakes.ts` (if its fake app deps call `submitAnswer`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `submitAnswer(sessionId: string, questionId: string, answer: AnswerInput): Promise<SessionResult>`; `AnswerKindMismatch`; route accepts both bodies.

- [ ] **Step 1: Failing service tests** — `sessions.prepare.test.ts`: with a three-item context (`CONTEXT` plus an `it`/`ru` third word) and a reply `{ items: [{ key:'q1', distractors:[3 Hebrew] }, { key:'q2', distractors:[3 Russian] }, { key:'q3', distractors: [], alternatives: ['репчатый лук'] }] }`, assert `insertGeneratedQuestions` received types `['multiple_choice','reverse_choice','typed_translation']`, the reverse options form-first with Russian distractors and `prompt: 'בצל'`, the typed `alternatives: ['репчатый лук']` and `options: null`, and that `insertSessionQuestions` got the questions in pick order (ids `g0, g1, g2`). The fake `insertGeneratedQuestions` builds questions via `questionFrom`. `sessions.test.ts`: `submitAnswer` with `{ text }` on a typed current question calls `insertAnswer` with `{ text, verdict: 'near_miss' }`; with `{ option_index: 0 }` on a typed question throws `AnswerKindMismatch`. `sessions.progress.test.ts`: `CHANGE` gains `raised: ['written_receptive']` and `levelAfter` per the three-dimension badge (`(2,1,1)` → 1, so `levelBefore: 1, levelAfter: 1`).

- [ ] **Step 2: Implement** — `errors.ts`:

```ts
export class AnswerKindMismatch extends Error {
  constructor(readonly questionId: string) {
    super(`the answer to ${questionId} is not the kind its question takes`);
    this.name = 'AnswerKindMismatch';
  }
}
```

`submitAnswer(sessionId, questionId, answer: AnswerInput)`: `if (outcome.status === 'wrong_answer_kind') throw new AnswerKindMismatch(questionId);` then insert: `const recorded = outcome.record.answers[loaded.answers.length]; await repos.session.insertAnswer(sessionId, loaded.answers.length, questionId, 'text' in answer ? { text: answer.text, verdict: recorded.verdict! } : { displayIndex: answer.option_index });`.

`prepareSession`: `const types = read.context.map((_, index) => typeFor(index)); const items = distractorItems(read.context, types);` … `questions: read.context.map((row, index) => ({ ...rowFields, type: types[index], ...generatedContent(row, types[index], verdict.byKey.get(items[index].key)!) }))` … `await session.insertSessionQuestions(sessionId, generated.map((question) => shuffleOptions(question, rng)));` with a comment: order is the pick order, already random, and the type cycle depends on it (spec D2).

`routes/sessions.ts`: the handler passes `'text' in body ? { text: body.text } : { option_index: body.option_index }`; maps `AnswerKindMismatch` → `400 { error: "the answer is not the kind this question takes" }`; `progressItem` adds `raised: change.raised`; the next-step route `description` names the two bodies and the 400; the create route `description` names the type cycle.

- [ ] **Step 3: Run** — `npm test -w apps/server` and `npm run typecheck -w apps/server`. Expected: PASS.

- [ ] **Step 4: Commit** — `feat(server): answer typed cards and prepare mixed sessions`.

---

### Task 5: Eval — the three tasks against the real model

**Files:**
- Modify: `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/run.ts`, `apps/server/tests/eval/askModel.ts`

- [ ] **Step 1: Cases** — `DistractorCase.items[]` gains `task?: Task` (default `'meaning'`), `synonyms` documented as right answers in the language of that task's options, and `alternatives?: string[]` (known right alternatives for `typed`). Add:
  - `'Italian words to pick, Hebrew shown'`: `word` items `parlo` (synonyms `['dico']`), `casa` (`['abitazione', 'dimora']`), `sempre` (`['ognora']`), `bella` (`['carina', 'graziosa']`);
  - `'Russian words to pick, Hebrew shown'`: `word` items `окно` (`['оконце']`), `быстро` (`['скоро', 'живо']`), `красивая` (`['прекрасная']`);
  - `'Typed answers with well-known synonyms'` (`en`): `typed` items `big`/`גדול` (alternatives `['large']`), `begin`/`להתחיל` (`['start']`), `quickly`/`מהר` (`['fast']`);
  - `'A mixed session, as prepare-session sends it'` (`it`): `meaning` `libro`, `word` `finestra`, `typed` `macchina`/`מכונית` (alternatives `['auto', 'automobile']`), `meaning` `acqua`.
- [ ] **Step 2: Scoring** — `itemsOf` passes `types` mapped from tasks; tier 1: `validateDistractors(...).ok`; script check per task (`meaning` → `kase.to` script, `word` → `kase.from` script, `typed` → alternatives contain no Hebrew); tier 2: `meaning`/`word` — no offered wrong option is a known synonym (existing check); `typed` — at least one known alternative is listed (only when the case names any). Print alternatives in the scorecard row.
- [ ] **Step 3: Run** — `npm run eval -- distractor` style filters while iterating (`npm run eval -w apps/server -- "pick"`, `-- "typed"`, `-- "mixed"`), then the full `npm run eval`. Expected: tier 1 zero failures, tier 2 ≥ threshold. A failing case changes the prompt wording in Task 2's `buildDistractorPrompt`, never the threshold.
- [ ] **Step 4: Commit** — `test(eval): reversed and typed generation cases`.

---

### Task 6: Mobile — the typed card, the reversed card, feedback, results

**Files:**
- Create: `apps/mobile/src/components/TypedAnswerView.tsx`, `apps/mobile/src/feedback.ts`, `apps/mobile/src/feedback.test.ts`
- Modify: `components/MultipleChoiceView.tsx`, `components/FeedbackBanner.tsx`, `hooks/useSession.tsx`, `app/session.tsx`, `app/results.tsx`, `progress.ts`, `progress.test.ts`, `strings.ts`, `strings.test.ts` (if it enumerates), `api/client.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Question`, `AnswerInput`, `evaluate`, `judgeTyped`, `rightAnswer`, `isChoice`).
- Produces: `feedbackFor(question: Question, answer: AnswerInput): Feedback` where `Feedback = { tone: 'correct' | 'wrong'; title: string; line: string | null; verdict: TypedVerdict | null }`; `useSession()` gains `answer: AnswerInput | null`, `submitText(text: string)`; `selectedOption` remains (derived: `answer && 'option_index' in answer ? answer.option_index : null`).

- [ ] **Step 1: Failing tests** — `feedback.test.ts`:

```ts
const choice: Question = { id: 'c', type: 'multiple_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 };
const typed: Question = { id: 't', type: 'typed_translation', vocab_term_id: 'l', question: 'חלון', part_of_speech: 'noun', answer: 'finestra', lemma: 'finestra', alternatives: ['vetrata'] };

it('a right choice is correct with no line', () => {
  expect(feedbackFor(choice, { option_index: 0 })).toEqual({ tone: 'correct', title: 'נכון!', line: null, verdict: null });
});
it('a wrong choice shows the right answer', () => {
  expect(feedbackFor(choice, { option_index: 1 })).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'בית', verdict: null });
});
it('a near miss is correct and shows the spelling', () => {
  expect(feedbackFor(typed, { text: 'finestar' })).toEqual({ tone: 'correct', title: 'כמעט! כך כותבים:', line: 'finestra', verdict: 'near_miss' });
});
it('an alternative is correct and names the practised word', () => {
  expect(feedbackFor(typed, { text: 'vetrata' })).toEqual({ tone: 'correct', title: 'נכון! המילה שתרגלנו:', line: 'finestra', verdict: 'alternative' });
});
it('an empty answer is wrong and shows the answer', () => {
  expect(feedbackFor(typed, { text: '' })).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'finestra', verdict: 'wrong' });
});
```

`progress.test.ts`: `practisedRows` with items `[a: raised [] same badge, b: badge up, c: raised ['written_productive'] same badge]` returns order `b, c, a` with `progressed` true on c only. `client.test.ts`: `nextStep` posts `{ user_id, question_id, text }` unchanged.

- [ ] **Step 2: strings** — add:

```ts
questionInstructionReverse: (language: string) => `איך אומרים ב${languageName(language)}?`,
questionInstructionTyped: (language: string) => `כתבו את המילה ב${languageName(language)}`,
typedPlaceholder: 'התשובה שלך…',
typedCheck: 'בדיקה',
typedShowAnswer: 'הצגת התשובה',
feedbackNearMiss: 'כמעט! כך כותבים:',
feedbackAlternative: 'נכון! המילה שתרגלנו:',
dimensionsRaised: (dimensions: Dimension[]) => `התקדמות: ${dimensions.map((d) => DIMENSION_NAMES[d]).join(', ')}`,
```

- [ ] **Step 3: feedback.ts** —

```ts
export type Feedback = { tone: 'correct' | 'wrong'; title: string; line: string | null; verdict: TypedVerdict | null };

/** Phase 23. The banner after an answer. The same evaluate the server runs, so
 *  what the learner is told is what the server records (spec D9). */
export function feedbackFor(question: Question, answer: AnswerInput): Feedback {
  const record = evaluate(question, answer);
  const verdict = record.verdict ?? null;
  const right = rightAnswer(question);
  if (!record.is_correct) return { tone: 'wrong', title: strings.feedbackWrong, line: right, verdict };
  if (verdict === 'near_miss') return { tone: 'correct', title: strings.feedbackNearMiss, line: right, verdict };
  if (verdict === 'alternative') return { tone: 'correct', title: strings.feedbackAlternative, line: right, verdict };
  return { tone: 'correct', title: strings.feedbackCorrect, line: null, verdict };
}
```

- [ ] **Step 4: Components** — `FeedbackBanner` props `{ feedback: Feedback; onContinue }`, testID `feedback-correct`/`feedback-wrong` from `tone`, an extra `testID="feedback-line"` on the line, and `feedback-near-miss` on the title when `verdict === 'near_miss'` (e2e reads it). The line is LTR-isolated text (`⁨…⁩`) so a Latin word sits right inside the RTL banner. `MultipleChoiceView` gains `instruction: string` and `reversed: boolean` props: when reversed, the prompt is `writingDirection: 'rtl'` and option labels `'ltr'` (OptionButton gains a `direction` prop). `TypedAnswerView`:

```tsx
type Props = {
  question: TypedTranslationQuestion;
  instruction: string;
  answered: AnswerInput | null;
  verdict: TypedVerdict | null;
  onSubmit: (text: string) => void;
};
// TextInput: testID="typed-input", value, onChangeText, editable={answered === null},
// autoFocus, autoCapitalize="none", autoCorrect={false}, spellCheck={false},
// autoComplete="off", maxLength={100}, returnKeyType="done", blurOnSubmit={false},
// onSubmitEditing={submit}, style LTR, border colour by verdict (correct/wrong).
// Under the prompt: strings.partOfSpeech(question.part_of_speech) in muted text (omitted when undefined).
// Buttons: "typed-submit" (disabled when text.trim() === '' or answered), "typed-show-answer" → onSubmit('').
// submit(): if answered or empty, return; Keyboard.dismiss(); onSubmit(text).
// Reset text on question.id change.
```

- [ ] **Step 5: useSession** — state `answer: AnswerInput | null` replaces `selectedOption`; `select(i)` and `submitText(text)` share one `answer(input)` path guarded by `state.answer !== null`, which sends `api.nextStep(sessionId, { user_id, question_id, ...input })`. `answered = answer !== null`. `applyQueued` resets `answer: null`.

- [ ] **Step 6: session.tsx** — `renderQuestion` switches exhaustively (`const unhandled: never = question`), using `active.target_language` from `useCurrentUser()` for instructions; the banner uses `feedbackFor(question, session.answer)`; `ScrollView` gets `keyboardShouldPersistTaps="handled"`; the body is wrapped in `KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}`.

- [ ] **Step 7: results** — `practisedRows` returns `PractisedRow = SessionProgressItem & { raised: boolean; progressed: boolean }` where `raised` is the badge rising and `progressed` is `!raised && item.raised.length > 0`; ordering raised, progressed, rest. The `raised` field on the wire collides with the row's boolean: name the row booleans `badgeRaised` and `progressed`, keep the wire's `raised` array. Results render `practised-raised` for `badgeRaised` (unchanged text) and `practised-progressed` with `strings.dimensionsRaised(item.raised)` for `progressed`, styled with the highlighted row.

- [ ] **Step 8: Run** — `npm test -w apps/mobile`, `npm run typecheck -w apps/mobile`. Expected: PASS.

- [ ] **Step 9: Commit** — `feat(mobile): typed and reversed cards, verdict feedback, dimension progress on results`.

---

### Task 7: Integration tests

**Files:**
- Modify: `apps/server/tests/integration/db/migrations.test.ts`, `db/schema.test.ts`, `db/progressRecompute.test.ts`, `repo/questions.test.ts`, `repo/sessions.test.ts`, `repo/progress.test.ts`, `routes/sessions.test.ts`, `services/sessions.test.ts`, `jobs/prepareSession.test.ts`, `session-flow.test.ts`, `tests/support/mockServer.ts` (distractor stub gains alternatives), `tests/support/progressRows.ts` (if it builds evidence)

- [ ] **Step 1:** `migrations.test.ts`: migrate to 0014, insert a seed question, a list session, its `session_questions` and an answer the old way, migrate the rest, then load and answer that session through `createServerDeps` (Review Focus 5).
- [ ] **Step 2:** `schema.test.ts`: the new checks refuse a typed question with options, a reverse question without a prompt, six alternatives, an answer with both an option and text, text without a verdict, and verdict `maybe`.
- [ ] **Step 3:** `repo/questions.test.ts` + `repo/sessions.test.ts`: insert one question of each type, build a session of them, `loadSession` returns the three shapes (typed with `answer`, `lemma`, `alternatives`), a typed answer round-trips with its verdict, `insertSessionQuestions` writes `{}` for typed.
- [ ] **Step 4:** `repo/progress.test.ts`: `findSessionEvidence` returns a typed verdict; `findSnapshot` returns form + Hebrew for reverse and typed questions.
- [ ] **Step 5:** `jobs/prepareSession.test.ts`: three saved senses, the stub answering per key (`q1` Hebrew distractors, `q2` target distractors, `q3` alternatives); the ready session's types are the cycle in order and the typed question carries the alternatives.
- [ ] **Step 6:** `routes/sessions.test.ts`: next-step with `text` → 200 and advances; `option_index` on a typed card → 400 with the published error; the completed body's `progress[].raised` is an array.
- [ ] **Step 7:** `progressRecompute.test.ts`: a session with all three types recomputes to exactly what the live path wrote.
- [ ] **Step 8:** `npm run typecheck`; commit `test(integration): question types end to end`. These run in CI (no lane here).

---

### Task 8: E2E

**Files:**
- Create: `e2e/tests/question-types.spec.ts`
- Modify: `e2e/tests/next-session.spec.ts`, `e2e/tests/progress.spec.ts`, `e2e/tests/support/` (a shared `answerCard` helper and a per-key generation stub builder)

- [ ] **Step 1: Helpers** — `e2e/tests/support/cards.ts`:

```ts
/** A generation stub for `count` keys following the type cycle: Hebrew wrong
 *  options for a choice, target-language ones for a reversed card, and the
 *  given alternatives for a typed one. */
export function generationStub(count: number, targetWrong: string[], alternatives: string[] = []) { … }

/** Reads the card on screen and answers it: by option text for a choice, by
 *  typing for a typed card. Returns which type it was. */
export async function answerCard(page, pick: { option?: (texts: string[]) => number; text?: string }) { … }
```

- [ ] **Step 2:** `question-types.spec.ts` — learner `e2e_types_ru`: skip the seed; save `прочитала` and `лук` (four senses); create the list session with `generationStub(4, ['писать', 'дверь', 'стена'])`; position 1 is a choice (four options, `question-prompt` is Cyrillic) → pick the right one; position 2 is reversed (prompt Hebrew, options Cyrillic) → pick the right one; position 3 is typed (`typed-input` visible) → type the answer with one letter swapped if it is five letters or more, else exactly; expect `feedback-correct`, and for the swapped case `feedback-near-miss` and the line showing the form; position 4 → choice. Results: a `practised-row` with `practised-raised` or `practised-progressed`. Then open the word detail of the typed word and expect `כתיבה` with a level, not `טרם תורגל`. Second test: a typed card answered with `typed-show-answer` → `feedback-wrong`, and the missed list on results contains the form.
- [ ] **Step 3:** `next-session.spec.ts` and `progress.spec.ts`: use `generationStub` and `answerCard`; progress expectations follow the three-dimension badge (a word answered right only on a choice stays חדשה but shows `practised-progressed`; adjust the list filter expectations accordingly).
- [ ] **Step 4:** `npx tsc --noEmit -p e2e` (or the e2e workspace typecheck); commit `test(e2e): mixed sessions and the typed card`. These run in CI.

---

### Task 9: Docs, verification, PR

- [ ] **Step 1:** Update the spec's Status with deviations found while building (if any), and ADR 0003's examples if they name `QuestionSchema` as single-member (grep).
- [ ] **Step 2:** Run `npm test`, `npm run typecheck`, `npm run lint:arch`, `npm run db:check -w apps/server`, `npm run eval`. All green.
- [ ] **Step 3:** `/code-review`-style self-review of the branch diff (superpowers:requesting-code-review), fix findings.
- [ ] **Step 4:** Push and open the PR via `git-create-pr`; then `ci-green` until integration, e2e and eval are green.
