# Phase 27 Part B — Sentence Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three sentence cards. `cloze_choice`: the saved example with the word blanked, pick the missing word of four. `cloze_typed`: a sentence written for this session, with the word blanked (possibly inflected) and the whole sentence in Hebrew below it; type the missing word. `sentence_translation`: a short Hebrew sentence written for this session; type its translation, which the server's judge reads (Part A's endpoint, a second prompt).

**Architecture:** The session's one preparation call gains three tasks: `gap` (three wrong words that make the saved example wrong), `sentence` and `translate` (new sentences, given the sense and the sentences to avoid). Pure validators decide whether a written sentence is usable; an unusable one degrades its card to `typed_translation` instead of failing the session. Four nullable columns store a question's sentence, its translation and the gap's offsets. The planner inserts the three types into their tiers. The judged-answer endpoint learns the translation prompt through a per-type dispatch in `domain/judge.ts`. On the app, a `SentenceGap` component renders a sentence with its blank, and the existing choice and typed views take it as their prompt.

**Tech Stack:** TypeScript, Zod 4, Hono + @hono/zod-openapi, Drizzle + Postgres 17, pg-boss, Jest, Expo SDK 57 / React Native / react-native-web, Playwright, MockServer, Gemini.

**Spec:** `docs/superpowers/specs/2026-10-07-lang-tutor-phase-27-deeper-question-types-design.md` — Part B is D1, D2, D4 (translation), D5, D6, D7, D8, D9, D10, D11, D12, D14 (`sentence_degraded`), D15, and §2 "Part B". Read D5–D9 before any task. Part A (meaning recall and the judged-answer endpoint) is merged into this branch's base; its as-built names are in "Part A as built" below.

**Part A as built (what this plan builds on):**
- core: `TypedMeaningQuestion`; `AnswerInput`'s `{ text, judged }`; `isJudged(question)`, `JudgedQuestion = TypedMeaningQuestion`; `MAX_JUDGED_TEXT = 300`; `normaliseHebrew` (strips `\p{Cf}` too); `JudgedAnswerRequestSchema`/`JudgedAnswerResponseSchema`; `LlmMeaningJudgeSchema`.
- server `domain/judge.ts`: `JUDGE_MARKER`, `MeaningJudgeContext`, `meaningRuleVerdict`, `buildMeaningJudgePrompt`, `parseMeaningJudge`. `services/sessions.ts`: `answerJudged` (read tx check → rule or one `judge` call → `answer_judged` log → `submitAnswer({ text, judged })` → the stored verdict). `repo/questions.ts`: `findJudgeContext(questionId)` → `{ form, lemma, partOfSpeech, meaning, example, exampleTranslation } | undefined`.
- mobile: `TypedAnswerView` props `direction`, `checking`, `failed` (retry submits the current text); `useSession().submitJudged(text)` and `judging`; `feedbackFor` handles `{ text, judged }` for `typed_meaning`.
- migration `0018_typed_meaning.sql`. This plan's migration is `0019_sentence_cards.sql`.

**Deviations from the spec, decided while planning:**
- **The four sentence columns get their own check,** `questions_sentence_valid`, instead of a clause in every arm of `questions_shape_valid`: a sentence type has all four, every other type none, and the offsets lie inside the sentence.
- **A `cloze_typed` question stores no separate answer:** its answer is `sentence.slice(gap_start, gap_end)`, read back by `questionFrom`. Same for the word in a translation's reference.
- **`cloze_choice`'s right option is the text at the gap** (the form or the lemma as the example writes it), so the filled sentence reads right.
- **A translation's wrong banner names the practised word** (`התשובה הנכונה:` + the word, as other cards do), and the card itself shows `תרגום לדוגמה:` with the reference after every verdict. D12 put the reference in the banner; one place for it reads better.
- **Generation and judge eval groups each get their own scorecard line**, so a strong group cannot hide a weak one (final review of Part A).

## Global Constraints

- Every ADR holds; `npm run lint:arch` prints nothing. `domain/` pure (ADR 0001 R3); persistence imports domain types only (R4); only `composition.ts` names providers (R11); every endpoint a `createRoute`; every wire type a `z.infer`; no `jest.mock`; no optional collaborator parameter.
- Existing types keep their names, shapes and meaning. The seed session is unchanged.
- **Tiers** after this plan (`apps/server/src/domain/plan.ts`):
  - recognise `['multiple_choice', 'listen_choice', 'read_aloud', 'typed_meaning']`;
  - pick the form `['reverse_choice', 'cloze_choice', 'letter_tiles']`;
  - produce `['typed_translation', 'cloze_typed', 'dictation', 'say_translation', 'sentence_translation']`.
  Speaking off removes only `read_aloud` and `say_translation`.
- **Eligibility:** `cloze_choice` needs `findGap(example, [form, lemma])` to find a gap in the saved example; `cloze_typed` and `sentence_translation` need `speakable(form)` (at most `MAX_SPOKEN_WORDS = 4` words, core).
- **Judged types:** `typed_meaning` and `sentence_translation`. `cloze_typed` is judged on the phone by `judgeTyped({ answer: gapText, lemma: gapText, alternatives }, text)`.
- **Sentence limits:** `cloze_typed` sentence 3–12 words; `sentence_translation` Hebrew sentence 3–10 words; a gap has exactly as many words as the saved form; at most 3 recent sentences per sense and card are avoided (`MAX_AVOID = 3`); at most `MAX_ALTERNATIVES = 5` alternatives.
- **Translation judge verdicts:** the model answers `right | misspelled | other_word | wrong`, mapped to `exact | near_miss | alternative | wrong`.
- **Evidence:** `cloze_choice` correct → `written_receptive` ✓ and `written_productive` ✓ capped at 3; wrong → `written_productive` ✗ capped at 3 (as `reverse_choice`). `cloze_typed` and `sentence_translation` → as `typed_translation`.
- **Hebrew strings, exactly:**
  - `איזו מילה חסרה?` (cloze_choice instruction)
  - `` `השלימו את המילה החסרה ב${languageName(language)}` `` (cloze_typed)
  - `` `תרגמו ל${languageName(language)}` `` (sentence_translation)
  - `תרגום לדוגמה:` (the reference label)
  - existing `נכון!`, `כמעט! כך כותבים:`, `נכון! המילה שתרגלנו:`, `התשובה הנכונה:`, `בודקים…`, `לא הצלחנו לבדוק`, `נסו שוב`.
- **`testID`s:** `sentence-gap` (the sentence with its blank), `sentence-translation` (the Hebrew line under a gap sentence, and the Hebrew sentence on a translation card), `translation-reference` (the reference after a translation is judged), `cloze-card`, `translate-card` (card roots). Choice options keep `option-N`; typed inputs keep `typed-input`, `typed-submit`, `typed-show-answer`.
- **Log events:** `sentence_degraded` `{ session_id, position, type, reason }`.
- **This worktree** is `.claude/worktrees/phase-27b-sentence-cards`, lane slot 6 (branch `phase-27b-sentence-cards`, stacked on `phase-27-deeper-question-types`). Run:
  - core `(cd packages/core && npx jest <file>)`; server unit `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath <file>)`; mobile `(cd apps/mobile && npx jest <file>)`;
  - integration: write a wrapper script to your scratchpad (`cd <worktree>/apps/server && npx jest --selectProjects=integration --runTestsByPath "$@"`) and run `bash scripts/lane-env.sh bash <wrapper> <files>` from the worktree root (the guard refuses `bash -c`);
  - the eval: `npx tsx tests/eval/run.ts <filter>` from `apps/server` (a wrapper if a guard refuses the path); never `npm run eval`.
- Never hardcode a port or a database name. Never lower `TIER2_THRESHOLD`.
- **Never write into the main checkout.** Absolute paths under the worktree.
- Typecheck is restored task by task: core after Task 1, server after Task 4, mobile after Task 5; whole-repo `npm run typecheck` is a gate from Task 5 on.
- Commit messages: repo style, ending with a `Co-Authored-By:` line naming the committing model.

## Review Focus

1. **A model that writes the saved example back, or last session's sentence,** must not produce a card that repeats it: the item degrades to `typed_translation`. *Pinned in Task 2 (validators) and Task 4 (prepareSession degrades and logs).*
2. **A gap the model names that is not in its sentence, or occurs twice, or is a compound tense of a one-word form** degrades, never crashes the session or stores bad offsets. *Pinned in Task 2.*
3. **An inflected gap:** the lemma typed into `Ieri ___ per ore` (gap `parlavamo`) is wrong, the gap's form is exact, a one-letter slip on it is a near miss. *Pinned in Task 1.*
4. **A translation answer that differs from the reference but is right** is accepted by the judge; one equal to the reference (case, final full stop) is `exact` without a call. *Pinned in Task 3 (rule) and Task 6 (eval).*
5. **Rows stored before 0019** keep loading, and a sentence column on a non-sentence type (or offsets outside the sentence) is refused. *Pinned in Task 3's migration test.*

---

### Task 1: Core — three questions, the translation judge's schema, the gap judge

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts`; `packages/core/src/domain/quiz.ts`, `index.ts`
- Test: `packages/core/src/api/schemas.test.ts`, `packages/core/src/domain/quiz.test.ts`

**Interfaces:**
- Produces:
  - `GapSchema` `{ start: int ≥ 0, end: int ≥ 1 }`;
  - `ClozeChoiceQuestion` `{ id, type: 'cloze_choice', vocab_term_id, sentence, gap, translation, meaning, options, correct_option }`;
  - `ClozeTypedQuestion` `{ id, type: 'cloze_typed', vocab_term_id, sentence, gap, translation, meaning, answer, alternatives }`;
  - `SentenceTranslationQuestion` `{ id, type: 'sentence_translation', vocab_term_id, question /* the Hebrew sentence */, meaning, sentence /* the reference */, gap, answer /* the word as the reference writes it */ }`;
  - `LlmDistractorsSchema` items gain optional `sentence`, `gap`, `translation` strings;
  - `LlmTranslationJudgeSchema` `{ verdict: 'right' | 'misspelled' | 'other_word' | 'wrong' }`;
  - `JudgedQuestion = TypedMeaningQuestion | SentenceTranslationQuestion`; `ChoiceQuestion` includes `ClozeChoiceQuestion`.

- [ ] **Step 1: Write the failing tests**

`quiz.test.ts` additions:

```ts
const CLOZE_CHOICE: Question = {
  id: 'cc', type: 'cloze_choice', vocab_term_id: 'l1',
  sentence: 'Vorrei prenotare un tavolo.', gap: { start: 7, end: 16 }, translation: 'הייתי רוצה להזמין שולחן.',
  meaning: 'להזמין', options: ['prenotare', 'mangiare', 'dormire', 'correre'], correct_option: 0,
};
const CLOZE_TYPED: Question = {
  id: 'ct', type: 'cloze_typed', vocab_term_id: 'l2',
  sentence: 'Ieri parlavamo per ore.', gap: { start: 5, end: 14 }, translation: 'אתמול דיברנו שעות.',
  meaning: 'לדבר', answer: 'parlavamo', alternatives: ['chiacchieravamo'],
};
const TRANSLATION: Question = {
  id: 'st', type: 'sentence_translation', vocab_term_id: 'l3', question: 'אני רוצה להזמין שולחן',
  meaning: 'להזמין', sentence: 'Voglio prenotare un tavolo.', gap: { start: 7, end: 16 }, answer: 'prenotare',
};

describe('phase 27 Part B cards', () => {
  it('a gap choice is a choice, judged by its option', () => {
    expect(isChoice(CLOZE_CHOICE)).toBe(true);
    expect(evaluate(CLOZE_CHOICE, { option_index: 0 })).toMatchObject({ is_correct: true, answer_string: 'prenotare' });
    expect(rightAnswer(CLOZE_CHOICE)).toBe('prenotare');
  });
  it('a typed gap wants the form the sentence needs', () => {
    expect(evaluate(CLOZE_TYPED, { text: 'parlavamo' })).toMatchObject({ verdict: 'exact', is_correct: true });
    expect(evaluate(CLOZE_TYPED, { text: 'parlare' })).toMatchObject({ verdict: 'wrong', is_correct: false });
    expect(evaluate(CLOZE_TYPED, { text: 'parlavano' })).toMatchObject({ verdict: 'near_miss' });
    expect(evaluate(CLOZE_TYPED, { text: 'chiacchieravamo' })).toMatchObject({ verdict: 'alternative' });
    expect(rightAnswer(CLOZE_TYPED)).toBe('parlavamo');
    expect(answerFits(CLOZE_TYPED, { text: 'x', judged: 'exact' })).toBe(false);
  });
  it('a translation is judged by the server', () => {
    expect(isJudged(TRANSLATION)).toBe(true);
    expect(answerFits(TRANSLATION, { text: 'x' })).toBe(false);
    expect(evaluate(TRANSLATION, { text: 'Vorrei prenotare un tavolo', judged: 'exact' })).toMatchObject({ is_correct: true, verdict: 'exact' });
    expect(rightAnswer(TRANSLATION)).toBe('Voglio prenotare un tavolo.');
  });
  it('no card that is not judged takes a judged answer', () => {
    const say: Question = { id: 's', type: 'say_translation', vocab_term_id: 'l', question: 'לדבר', part_of_speech: 'verb', answer: 'parlare', lemma: 'parlare', alternatives: [] };
    expect(answerFits(say, { text: 'parlare', judged: 'exact' })).toBe(false);
  });
});
```

(`parlavano` is one substitution from `parlavamo` on a word of 9 letters: a near miss under phase 23's rule.)

`schemas.test.ts`: each of the three shapes parses; `GapSchema` refuses a negative start; `LlmDistractorsSchema` parses an item with `sentence`, `gap`, `translation`; `LlmTranslationJudgeSchema` accepts `misspelled` and refuses `other_sense`.

- [ ] **Step 2: Run to see them fail** — `(cd packages/core && npx jest src/domain/quiz.test.ts src/api/schemas.test.ts)`.

- [ ] **Step 3: Implement**

`schemas.ts`, after `TypedMeaningQuestionSchema`:

```ts
// Phase 27 (spec D7, D11). Where a word sits in a sentence: JavaScript string
// indices, [start, end), computed in TypeScript and never in SQL.
export const GapSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() });

// Phase 27 (spec D7). The saved example with the word blanked; four target
// words to pick from. `translation` (Hebrew) and `meaning` show after the answer.
export const ClozeChoiceQuestionSchema = z.object({
  id: z.string(), type: z.literal('cloze_choice'), vocab_term_id: z.string(),
  sentence: z.string(), gap: GapSchema, translation: z.string(), meaning: z.string(),
  options: z.array(z.string()), correct_option: z.number().int(),
});

// Phase 27 (spec D5). A sentence written for this session, the word blanked in
// whatever form it needs, and the whole sentence in Hebrew. `answer` is the
// gap's text: the client judges locally against it and `alternatives`.
export const ClozeTypedQuestionSchema = z.object({
  id: z.string(), type: z.literal('cloze_typed'), vocab_term_id: z.string(),
  sentence: z.string(), gap: GapSchema, translation: z.string(), meaning: z.string(),
  answer: z.string(), alternatives: z.array(z.string()),
});

// Phase 27 (spec D6). A Hebrew sentence to translate, judged by the server.
// `sentence` is a reference translation, `gap` and `answer` the practised word
// in it: shown after the answer.
export const SentenceTranslationQuestionSchema = z.object({
  id: z.string(), type: z.literal('sentence_translation'), vocab_term_id: z.string(),
  question: z.string(), meaning: z.string(), sentence: z.string(), gap: GapSchema, answer: z.string(),
});
```

(Format with one property per line as the file does.) Add the three to `QuestionSchema`. `LlmDistractorsSchema` items gain `sentence: z.string().optional()`, `gap: z.string().optional()`, `translation: z.string().optional()` with a comment "Phase 27: the sentence tasks' answers (spec D5, D6)". Next to `LlmMeaningJudgeSchema`:

```ts
// Phase 27 (spec D4). The model's verdict on a sentence translation.
export const LlmTranslationJudgeSchema = z.object({
  verdict: z.enum(['right', 'misspelled', 'other_word', 'wrong']),
});
```

`types.ts`/`index.ts`: the `z.infer`s and type exports.

`quiz.ts`:
- `ChoiceQuestion` gains `ClozeChoiceQuestion`; `JudgedQuestion = TypedMeaningQuestion | SentenceTranslationQuestion`; `isJudged` returns true for both.
- `isChoice`: `cloze_choice` true; `cloze_typed`, `sentence_translation` false.
- `answerFits`: replace its last line so no card that is not judged takes a judged text: `return 'text' in answer && !('judged' in answer);`, and the `say_translation` line becomes `'heard' in answer || 'pass' in answer || ('text' in answer && !('judged' in answer))`.
- `verdictFor` gains `case 'cloze_typed': return judgeTyped({ answer: question.answer, lemma: question.answer, alternatives: question.alternatives }, text);` with the comment "Phase 27 (spec D5): the form the sentence needs; its lemma is wrong unless the sentence needs it."
- `rightAnswer`: `cloze_typed` → `answer`; `sentence_translation` → `sentence`; a `cloze_choice` is a choice (its option).

- [ ] **Step 4: Run** `(cd packages/core && npx jest && npx tsc --noEmit)` — PASS.
- [ ] **Step 5: Commit** `feat(core): the three sentence cards, and the translation judge's verdicts`.

---

### Task 2: Server domain — the gap finder, the sentence validators, the tasks, the tiers, the evidence

**Files:**
- Create: `apps/server/src/domain/cloze.ts`, `cloze.test.ts`, `sentences.ts`, `sentences.test.ts`
- Modify: `apps/server/src/domain/distractors.ts`, `plan.ts`, `progress.ts` (and their tests)

**Interfaces:**
- Consumes: Task 1's types; core `speakable`, `normaliseTyped`, `normaliseHebrew`; `LANGUAGES[code].letters`.
- Produces:
  - `findGap(sentence: string, candidates: readonly string[]): { start: number; end: number } | null` (`cloze.ts`);
  - `wordCount(text: string): number` (`sentences.ts`);
  - `type SentenceContent = { sentence: string; translation: string; gap: { start: number; end: number }; alternatives: string[] }` and `validateSentenceItem(input: { form: string; target: LanguageCode; avoid: readonly string[] }, found: { sentence?: string; gap?: string; translation?: string; alternatives?: string[] }): { ok: true; content: SentenceContent } | { ok: false; reason: string }`;
  - `type TranslateContent = { hebrew: string; reference: string; gap: { start: number; end: number } }` and `validateTranslateItem(input: { form: string; target: LanguageCode; avoid: readonly string[] }, found: …): { ok: true; content: TranslateContent } | { ok: false; reason: string }`;
  - constants `SENTENCE_MAX_WORDS = 12`, `TRANSLATE_MAX_WORDS = 10`, `SENTENCE_MIN_WORDS = 3`, `MAX_AVOID = 3`;
  - `Task` gains `'gap' | 'sentence' | 'translate'`; `GenerationContext` gains `example: string | null; exampleTranslation: string | null`;
  - `type RecentSentences = Map<string /* senseId */, { cloze: string[]; translate: string[] }>`; `distractorItems(context, tasks, recent: RecentSentences)`;
  - `DistractorItem` gains `example: string | null`, `exampleTranslation: string | null`, `avoid: string[]`;
  - `Generated` gains `sentence: SentenceContent | null`, `translate: TranslateContent | null`, `degraded: string | null`; `NOTHING_GENERATED` has all three null;
  - `Extras` gains `gap: { start: number; end: number } | null` (a `cloze_choice` card's gap in the saved example); `NO_EXTRAS.gap = null`;
  - `QuestionContent` gains `sentence`, `sentenceTranslation`, `gapStart`, `gapEnd` (all `null` for other types);
  - `PlanPick` gains `clozeGap: boolean`; `TIERS` per Global Constraints.

- [ ] **Step 1: Failing tests** — write these before any code.

`cloze.test.ts`:

```ts
describe('findGap (spec D7, phase 24 D8)', () => {
  it('finds a word as a whole word, any case', () => {
    expect(findGap('Vorrei prenotare un tavolo.', ['prenotare'])).toEqual({ start: 7, end: 16 });
    expect(findGap('Prenotare è facile.', ['prenotare'])).toEqual({ start: 0, end: 9 });
  });
  it('takes the first candidate that occurs exactly once', () => {
    expect(findGap('I booked a table.', ['book', 'booked'])).toEqual({ start: 2, end: 8 });
  });
  it('never matches inside a word', () => {
    expect(findGap('The gattone sleeps.', ['gatto'])).toBeNull();
  });
  it('matches a multi-word form as a sequence, across any spacing', () => {
    expect(findGap('Per  favore, aiutami.', ['per favore'])).toEqual({ start: 0, end: 11 });
  });
  it('reads Cyrillic letters as letters', () => {
    expect(findGap('Я ем ложкой суп.', ['ложкой'])).toEqual({ start: 5, end: 11 });
    expect(findGap('Я ем ложкой суп.', ['ложка'])).toBeNull();
  });
  it('is null for no occurrence or two', () => {
    expect(findGap('Il cane e il cane.', ['cane'])).toBeNull();
    expect(findGap('', ['cane'])).toBeNull();
  });
});
```

`sentences.test.ts` (Italian target, form `parlare`):

```ts
const INPUT = { form: 'parlare', target: 'it' as const, avoid: ['Mi piace parlare con te.'] };
describe('validateSentenceItem (spec D5)', () => {
  const good = { sentence: 'Ieri parlavamo per ore.', gap: 'parlavamo', translation: 'אתמול דיברנו שעות.', alternatives: ['chiacchieravamo', 'parlavamo', 'דיברנו'] };
  it('accepts a new sentence with its gap, and cleans the alternatives', () => {
    expect(validateSentenceItem(INPUT, good)).toEqual({
      ok: true,
      content: { sentence: 'Ieri parlavamo per ore.', translation: 'אתמול דיברנו שעות.', gap: { start: 5, end: 14 }, alternatives: ['chiacchieravamo'] },
    });
  });
  it.each([
    ['a sentence it was told to avoid', { ...good, sentence: 'Mi piace parlare con te.', gap: 'parlare' }],
    ['a gap that is not in the sentence', { ...good, gap: 'parlato' }],
    ['a compound tense for a one-word form', { ...good, sentence: 'Ieri abbiamo parlato per ore.', gap: 'abbiamo parlato' }],
    ['a gap that occurs twice', { ...good, sentence: 'Parlavamo e parlavamo.', gap: 'parlavamo' }],
    ['too few words', { ...good, sentence: 'Parlavamo ieri.' }],
    ['too many words', { ...good, sentence: 'Ieri sera noi parlavamo per ore e ore con gli amici del mare al bar.' }],
    ['Hebrew in the sentence', { ...good, sentence: 'Ieri parlavamo שעות.' }],
    ['a translation with no Hebrew', { ...good, translation: 'Yesterday we talked.' }],
    ['nothing written', {}],
  ])('degrades %s', (_, found) => {
    expect(validateSentenceItem(INPUT, found).ok).toBe(false);
  });
});

describe('validateTranslateItem (spec D6)', () => {
  const input = { form: 'prenotare', target: 'it' as const, avoid: ['אני רוצה להזמין שולחן'] };
  const good = { sentence: 'הזמנו חדר במלון', translation: 'Abbiamo prenotato una camera in albergo.', gap: 'prenotato' };
  it('accepts a Hebrew sentence and a reference that holds the word once', () => {
    expect(validateTranslateItem(input, good)).toEqual({
      ok: true,
      content: { hebrew: 'הזמנו חדר במלון', reference: 'Abbiamo prenotato una camera in albergo.', gap: { start: 8, end: 17 } },
    });
  });
  it.each([
    ['a Hebrew sentence it was told to avoid', { ...good, sentence: 'אני רוצה להזמין שולחן.' }],
    ['Latin letters in the Hebrew sentence', { ...good, sentence: 'הזמנו hotel במלון' }],
    ['too many Hebrew words', { ...good, sentence: 'אתמול בערב הזמנו חדר גדול ויפה מאוד במלון החדש שבמרכז העיר' }],
    ['a gap missing from the reference', { ...good, gap: 'prenotare' }],
    ['Hebrew in the reference', { ...good, translation: 'Abbiamo prenotato חדר.' }],
  ])('degrades %s', (_, found) => {
    expect(validateTranslateItem(input, found).ok).toBe(false);
  });
});
```

(`avoid` matching ignores case, a final full stop and, for Hebrew, points and punctuation: compare with `normaliseTyped` for target text and `normaliseHebrew` for Hebrew.)

`distractors.test.ts`: `taskFor` gives `gap`, `sentence`, `translate` for the three types; `distractorItems` puts `avoid` = the saved example + the sense's recent `cloze` sentences (at most `MAX_AVOID` recent, newest first) on a `sentence` item, and the sense's recent `translate` sentences on a `translate` item; the prompt (`buildDistractorPrompt`) describes the three tasks and sends `example`, `example_translation`, `avoid` per item; `validateDistractors` (a) validates a `gap` item as a choice of target-language words where neither the form, the lemma nor the gap's own text may be a wrong answer, refusing the attempt on failure; (b) never refuses for a `sentence`/`translate` item but returns `degraded` with the validator's reason, or the content; `generatedContent` builds the three shapes:
- `cloze_choice` → `{ prompt: row.translation, options: optionsFor(gapText, distractors), sentence: row.example, sentenceTranslation: row.exampleTranslation, gapStart, gapEnd }` where `gapText = row.example.slice(extras.gap.start, extras.gap.end)`;
- `cloze_typed` → `{ prompt: row.translation, alternatives: content.alternatives, sentence: content.sentence, sentenceTranslation: content.translation, gapStart: content.gap.start, gapEnd: content.gap.end }`;
- `sentence_translation` → `{ prompt: row.translation, sentence: content.reference, sentenceTranslation: content.hebrew, gapStart, gapEnd }`;
- a missing content or gap throws (the service never calls it so: it degrades first).

`plan.test.ts`: the tiers equal Global Constraints; `cloze_choice` needs `clozeGap`, the two sentence types need `speakable`; a hand-derived ordinal-1, ten-pick, all-eligible plan; "never two in a row" over sizes 1–10, ordinals 0–5, the flag combinations. Update existing expectations by hand derivation only.

`progress.test.ts`: the evidence rows of Global Constraints for the three types.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement**

`cloze.ts`:

```ts
/**
 * Phase 27 (spec D7, phase 24 D8). Where a word sits in a sentence: the first
 * candidate that occurs exactly once as whole words, ignoring case. Letters,
 * marks and digits are word characters in any script; a multi-word candidate
 * matches its words in order across any run of spaces. Offsets are JavaScript
 * string indices into `sentence`.
 */
const WORD = '[\\p{L}\\p{M}\\p{N}]';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function findGap(sentence: string, candidates: readonly string[]): { start: number; end: number } | null {
  for (const candidate of candidates) {
    const words = candidate.trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) continue;
    const pattern = new RegExp(`(?<!${WORD})${words.map(escape).join('\\s+')}(?!${WORD})`, 'giu');
    const found = [...sentence.matchAll(pattern)];
    if (found.length === 1) {
      const start = found[0].index!;
      return { start, end: start + found[0][0].length };
    }
  }
  return null;
}
```

`sentences.ts` — implement the two validators exactly as the tests demand, in this order, returning the first reason: content present; word counts (`wordCount` counts whitespace-separated tokens that contain a letter); scripts (target sentence: no `LANGUAGES.he.letters` match and at least one `LANGUAGES[target].letters` match; Hebrew sentence: a Hebrew letter and no target letter; reference: no Hebrew letter); gap word count equals `wordCount(form)`; `findGap(sentence, [gap])` not null; not in `avoid`. Cleaned alternatives: trimmed, non-empty, no Hebrew letter, not the gap (by `normaliseTyped`), unique, at most `MAX_ALTERNATIVES`. Every function and constant gets a one-line why-comment citing the spec decision.

`distractors.ts`:
- Task, `taskFor`, `GenerationContext`, `DistractorItem`, `distractorItems(context, tasks, recent)`:
  - a `sentence` item's `avoid` = `[row.example, ...(recent.get(row.senseId)?.cloze ?? []).slice(0, MAX_AVOID)]` without nulls;
  - a `translate` item's `avoid` = `(recent.get(row.senseId)?.translate ?? []).slice(0, MAX_AVOID)`;
  - every other item's `avoid` = `[]`.
- `buildDistractorPrompt`: three task lines after `"typed"`:

```ts
    `- "gap": the learner sees the example sentence with the ${learned.name} word blanked, and picks the missing word. Write ${DISTRACTOR_MARKER} in ${learned.name}: words of the same part of speech and in the same form as the blanked word, each of which makes this sentence wrong or meaningless. Never a word that also fits the sentence.`,
    `- "sentence": write a new, natural, everyday ${learned.name} sentence of ${SENTENCE_MIN_WORDS} to ${SENTENCE_MAX_WORDS} words that uses the word in the meaning given by correct and shown by the example, never in another sense. Use whatever form of the word the sentence needs, written as consecutive words, as many as the word has. It must differ from every sentence in avoid. Put it in sentence; the word exactly as written in the sentence in gap; the whole sentence in natural ${answers.name}, which fixes its person, number and tense, in translation; and in alternatives every other ${learned.name} word that would fill the gap equally well given that translation, in the same form, or none. Leave distractors empty.`,
    `- "translate": write a short, natural, everyday ${answers.name} sentence of ${SENTENCE_MIN_WORDS} to ${TRANSLATE_MAX_WORDS} words that uses the meaning in correct, in the sense the example shows. It must differ from every sentence in avoid. Put it in sentence; a natural ${learned.name} translation of it that uses the word, in whatever form the translation needs, in translation; and that word exactly as written in the translation in gap. Leave distractors empty.`,
```

  and each user item gains `example`, `example_translation` and, when non-empty, `avoid`. A `gap` item also sends `sentence: example` and `blank: <the gap's text>` (the service passes the gap via the item: add `blank: string | null` to `DistractorItem`, set from `findGap` for `gap` items).
- `validateDistractors`: `gap` items go through `badChoice` as a `word` task with rights `[form, lemma, blank]`; `sentence`/`translate` items set `sentence`/`translate` content or `degraded`; `typed` and choice items unchanged.
- `generatedContent(row, type, generated, extras)` per the test list.

`plan.ts`: TIERS; `PlanPick.clozeGap`; `eligible`: `cloze_choice` → `pick.clozeGap`; `cloze_typed`, `sentence_translation` → `pick.speakable`; update the TIERS comment.

`progress.ts`: `ChoiceAnswerType` + `cloze_choice` (evidence as `reverse_choice`); `TextAnswerType` + `cloze_typed`, `sentence_translation` (evidence `typedEvidence`).

- **Notes for the implementer:** `badChoice` treats a `gap` item as it treats a `word` item (target-language wrong answers, none in the explanation's script, the sibling rule over translations), with `[form, lemma, blank]` as its rights. `DistractorItem`'s new fields are required, so `apps/server/tests/eval/run.ts`'s `itemsOf` must fill them (`example: null`, `exampleTranslation: null`, `avoid: []`, `blank: null` for the existing cases) — open the file with your file tools if a guard refuses shell access to an `eval` path. `sessions.prepare.test.ts`'s fake repo needs the new shapes, as Part A's Task 2 did.

- [ ] **Step 4: Run** `(cd apps/server && npx jest --selectProjects=unit)` — PASS.
- [ ] **Step 5: Commit** `feat(server): the gap finder, the sentence validators and tasks, and the sentence cards in the planner`.

---

### Task 3: The translation judge

**Files:**
- Modify: `apps/server/src/domain/judge.ts`, `judge.test.ts`; `apps/server/src/services/sessions.ts`, `sessions.judge.test.ts`

**Interfaces:**
- Consumes: Task 1's `SentenceTranslationQuestion`, `LlmTranslationJudgeSchema`, `JudgedQuestion`.
- Produces (`judge.ts`):
  - `type JudgeContext = MeaningJudgeContext` (alias; same fields);
  - `translationRuleVerdict(reference: string, text: string): TypedVerdict | null` — `wrong` for empty, `exact` when `normaliseTyped(text) === normaliseTyped(reference)`;
  - `buildTranslationJudgePrompt(question: SentenceTranslationQuestion, context: JudgeContext, answer: string)` → `{ system, user, schema: LlmTranslationJudgeSchema }`, system containing `JUDGE_MARKER`, user JSON `{ hebrew_sentence, reference_translation, word, lemma, part_of_speech, meaning, answer }`;
  - `parseTranslationJudge(raw): TypedVerdict | null`;
  - `ruleVerdict(question: JudgedQuestion, text)`, `judgePrompt(question, context, text)`, `parseJudge(type: JudgedQuestion['type'], raw)` — one switch each over the two judged types, delegating to the per-type functions.
- `answerJudged` uses `ruleVerdict` / `judgePrompt` / `parseJudge` instead of the meaning-only calls; nothing else in it changes.

- [ ] **Step 1: Failing tests** — `judge.test.ts`: the rule (empty → wrong; the reference with another case and no full stop → exact; anything else null); the prompt carries the marker, the target language name, and the JSON above; the system names the four verdicts and says: judge on conveying the Hebrew sentence and on the practised word (any form the sentence needs), ignore slips in other words and small grammar slips that do not touch it; `misspelled` = one-letter or accent slip in the practised word; `other_word` = another word instead of it; `wrong` = meaning missed, not a sentence, word left out or used wrongly including the wrong form. The parser maps the four verdicts and returns null for `other_sense`, `''`, junk; reads a fenced answer. The dispatchers route each type. `sessions.judge.test.ts`: a `sentence_translation` card is ruled exact for its reference (no call), judged by one call otherwise (the prompt's user JSON holds `hebrew_sentence` and `reference_translation`), and `misspelled` is recorded as `near_miss`.

- [ ] **Step 2–4:** fail, implement, `(cd apps/server && npx jest --selectProjects=unit)` PASS.
- [ ] **Step 5: Commit** `feat(server): the translation judge`.

---

### Task 4: Persistence and preparation — migration 0019, the sentences stored and avoided, degraded cards

**Files:**
- Modify: `apps/server/src/db/schema.ts`; create `apps/server/src/db/migrations/0019_sentence_cards.sql` (+ drizzle meta, generated)
- Modify: `apps/server/src/repo/questions.ts`, `apps/server/src/repo/progress.ts`, `apps/server/src/services/sessions.ts`
- Test: `tests/integration/db/migrations.test.ts`, `tests/integration/repo/questions.test.ts`, `tests/integration/repo/progress.test.ts`, `src/services/sessions.prepare.test.ts`, a prepared-session integration test (the file phase 24/25 use for "a list session prepared through the queue")

**Interfaces:**
- Produces:
  - columns `questions.sentence text`, `sentence_translation text`, `gap_start integer`, `gap_end integer`;
  - `questions_type_known` admits the three types; `questions_shape_valid` arms: `cloze_choice` options + prompt, no alternatives/tiles; `cloze_typed` prompt + alternatives (≤ 5), no options/tiles; `sentence_translation` prompt, no options/alternatives/tiles;
  - `questions_sentence_valid`: `(type in ('cloze_choice','cloze_typed','sentence_translation')) = (sentence is not null and sentence_translation is not null and gap_start is not null and gap_end is not null)` and `(gap_start is null or (gap_start >= 0 and gap_start < gap_end and gap_end <= length(sentence)))`;
  - `QuestionRow`/`questionColumns` gain the four; `questionFrom` builds the three shapes (`answer = sentence.slice(gapStart, gapEnd)`); `insertGeneratedQuestions` writes them;
  - `findGenerationContext` also returns `example` and `exampleTranslation` (`tr.example_source`, `tr.example_target`);
  - `findRecentSentences({ enrollmentId, senseIds, limit }): Promise<RecentSentences>` — per sense, newest first (by `questions.created_at`), the `sentence` of `cloze_typed` questions and the `sentence_translation` of `sentence_translation` questions of this enrollment, at most `limit` each;
  - `repo/progress.ts` reads the new types (choice / text).
  - `prepareSession`: reads recent sentences in its read transaction; sets `clozeGap` per pick from `findGap(row.example ?? '', [row.form, row.lemma])` and passes that gap to the `gap` item and to `generatedContent`'s extras; after validation, a degraded position becomes `typed_translation` with `NOTHING_GENERATED` alternatives, and `sentence_degraded` `{ session_id, position, type, reason }` is logged for it.

- [ ] **Step 1: Failing tests:**
  - migration 0019: every existing type still inserts unchanged; each of the three types inserts with its columns; a sentence column on `multiple_choice` is refused (`questions_sentence_valid`); `gap_end` past the sentence's length is refused; a sentence type without its sentence is refused.
  - repo: `questionFrom` round-trips each type through `insertGeneratedQuestions` and `loadSession`; `findGenerationContext` returns the example; `findRecentSentences` returns newest first, only this enrollment's, only the two types, at most `limit`.
  - service unit (fakes): a `sentence` item the fake model answers with the saved example becomes `typed_translation`, and `sentence_degraded` is logged with `reason`; the recent sentences reach the item's `avoid`; `cloze_choice` gets its gap from the example.
  - integration: a list session prepared through the queue (MockServer answering every task) stores the three types with their sentences.

- [ ] **Step 2–4:** generate the migration with `(cd apps/server && npx drizzle-kit generate --name sentence_cards)`, prepend the house comment, `npx drizzle-kit check`; implement; run the server unit suite, `npx tsc --noEmit` (the server typechecks after this task), the changed integration files, then the whole integration bucket; `npm run lint:arch`.
- [ ] **Step 5: Commit** `feat(server): migration 0019, sentences stored and avoided, and a bad sentence degrades its card`.

---

### Task 5: Mobile — the three cards

**Files:**
- Create: `apps/mobile/src/components/SentenceGap.tsx`, `apps/mobile/src/sentence.ts`, `apps/mobile/src/sentence.test.ts`
- Modify: `MultipleChoiceView.tsx`, `TypedAnswerView.tsx`, `app/session.tsx`, `feedback.ts`, `feedback.test.ts`, `strings.ts`, `strings.test.ts`, `progress.ts` (+ test)

**Interfaces:**
- Consumes: Task 1's three types; Part A's `submitJudged`, `judging`, `TypedAnswerView`'s `direction`/`checking`/`failed`.
- Produces: `splitAtGap(sentence: string, gap: { start: number; end: number }): { before: string; word: string; after: string }` (`sentence.ts`, pure); `SentenceGap` `{ sentence, gap, filled: boolean }` rendering `before`, a blank (`_____`) or the word in bold, `after`, left to right, `testID="sentence-gap"`; `MultipleChoiceView` and `TypedAnswerView` accept a `prompt?: ReactNode` that replaces their default prompt.

- [ ] **Step 1: Failing tests:** `splitAtGap('Ieri parlavamo per ore.', { start: 5, end: 14 })` → `{ before: 'Ieri ', word: 'parlavamo', after: ' per ore.' }`; feedback for `cloze_choice` (as a choice, the option), `cloze_typed` (phase 23's typed banners with the gap's word), `sentence_translation` with `{ text, judged }`: `exact` → `נכון!` line null; `near_miss` → `כמעט! כך כותבים:` + `answer`; `alternative` → `נכון! המילה שתרגלנו:` + `answer`; `wrong` → `התשובה הנכונה:` + `answer`, tone wrong; the four strings exactly; the missed pair for each type is `answer`/option → `meaning`.
- [ ] **Step 2–3: Implement:**
  - `MultipleChoiceView`'s `question` type now admits `ClozeChoiceQuestion`, which has no `question` field: when `prompt` is given the view renders it instead of reading `question.question` (and no prompt speaker); narrow on `question.type` where the old code reads `question.question`.
  - `cloze_choice`: `MultipleChoiceView` with `prompt={<View testID="cloze-card"><SentenceGap … filled={answered} />{answered ? <Text testID="sentence-translation">{translation}</Text> : null}</View>}`, instruction `איזו מילה חסרה?`; after the answer the sentence gets a `SpeakButton`.
  - `cloze_typed`: `TypedAnswerView` (LTR, judged locally via `submitText`) with prompt = `SentenceGap` + the Hebrew translation (`sentence-translation`, right to left); instruction `השלימו את המילה החסרה ב…`.
  - `sentence_translation`: `TypedAnswerView` with `direction="ltr"`, `checking`/`failed` from `judging`, `onSubmit={session.submitJudged}`, prompt = the Hebrew sentence (`testID="sentence-translation"`, right to left, root `translate-card`), a multi-line input (`multiline`, `maxLength={300}` for this card only; Return inserts nothing special — the button submits), and after the answer `תרגום לדוגמה:` with the reference, its word in bold via `splitAtGap`, `testID="translation-reference"`, and a `SpeakButton` for it. Instruction `תרגמו ל…`.
  - `feedback.ts`'s judged branch handles `sentence_translation` per the tests.
- [ ] **Step 4: Run** `(cd apps/mobile && npx jest) && npm run typecheck && npm run lint:arch`.
- [ ] **Step 5: Commit** `feat(mobile): the gap and translation cards`.

---

### Task 6: The eval — gaps, sentences, translations, harder meaning cases

**Files:** `apps/server/tests/eval/cases.ts`, `askModel.ts`, `run.ts`

- [ ] **Step 1: Cases** (labels prefixed `gap `, `sentence `, `translate `, `tjudge `, so a filter selects a group):
  - **gap:** per target language, three items from real example shapes (phase 24 §2), each `task: 'gap'` with its sentence and blank, and `fits` listing words that would also fit (never to be offered), including one sentence where a careless wrong word would fit (`I want to ___ a table`: `book`; `clean` fits).
  - **sentence / translate:** per target language, four `sentence` and four `translate` cases; at least two per language over a word with several senses (`book` as להזמין; `run` as לנהל; `pianta` as צמח; `ключ` as מפתח), each listing `offSense` words whose presence shows the wrong sense (`book`/להזמין: `read`, `page`, `novel`, `ספר`; `run`/לנהל: `לרוץ`, `fast`, `marathon`), and one case per language with a non-empty `avoid`. Tier 1: the item passes `validateSentenceItem`/`validateTranslateItem` (not degraded). Tier 2: no `offSense` word appears as a whole word in the sentence or the translation.
  - **tjudge (translation judge):** per target language at least eight: two right paraphrases unlike the reference, one with the word in another valid form, one misspelled practised word, one other word in its place, one wrong form of the practised word, one missed meaning, one non-sentence. Expected verdicts are what a careful teacher would say.
  - **Harder meaning cases** (Part A's deferred finding): niqqud in the answer, ש/ו prefixes, a near-synonym in another register, an English answer (`wrong`), the target word typed back (`wrong`).
- [ ] **Step 2: Runner:** each group scored on its own tier-2 line (`gap tier 2`, `sentence tier 2`, `translation judge tier 2`), each with its own exit-1 check against `TIER2_THRESHOLD`; tier 1 failures still must be 0; the report JSON gains the scores.
- [ ] **Step 3: Run against the real model**, twice for the new groups, once in full. Below threshold: reword an arguable case (reason in a comment), else change the prompt (keep unit tests green), else for the judge a small thinking budget in both composition and eval; never the threshold.
- [ ] **Step 4: Commit** `test(eval): gaps, new sentences and the translation judge against the real model`.

---

### Task 7: End to end, the rotation, and the spec

**Files:** `e2e/tests/support/cards.ts`, `e2e/tests/support/mockServer.ts`, create `e2e/tests/sentence-cards.spec.ts`, the specs the rotation shifts, the spec's status.

- [ ] **Step 1: Helpers:** `CardKind` gains `'cloze-choice'`, `'cloze-typed'`, `'translate'`, detected by `cloze-card` (with options → choice, with `typed-input` → typed) and `translate-card`, before the generic checks. `generationStubFor` answers the new tasks with fixed content in the saved words' language: `gap` → three wrong target words; `sentence` → `{ sentence: '<a 5-word sentence holding the form once>', gap: form, translation: '<Hebrew>' , alternatives: [] }`; `translate` → `{ sentence: '<3–10 Hebrew words>', translation: '<a sentence holding the form once>', gap: form }`.
- [ ] **Step 2: New spec:** a session reaching all three cards (pick the size and ordinal from D9 by hand, so the planned positions are known; saved words whose dictionary examples contain their form, so `cloze_choice` is eligible). The choice card shows no Hebrew before the answer and the translation after; the typed gap refuses the lemma of an inflected gap and accepts its form; the translation card, judged `right` by an `expectJudge` stub, shows `נכון!` and `תרגום לדוגמה:` with the reference.
- [ ] **Step 3:** the whole e2e suite; update rotation-shifted specs by hand derivation only.
- [ ] **Step 4:** `npm test && npm run test:all && npm run typecheck && npm run lint:arch && npm run e2e`.
- [ ] **Step 5:** spec status: Part B built, with this plan's deviations and anything found while building.
- [ ] **Step 6: Commit** `test(e2e): the sentence cards, and the rotation they shift` and `docs: phase 27 spec records what Part B built`.
