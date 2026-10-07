# Phase 24 Part A — Listening and Variety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four new card types: hear the word and pick its meaning (`listen_choice`), `dictation`, a `matching` board and `letter_tiles`. A tiered planner places them and rotates them by session. `spoken_receptive` goes live, and the generation call is capped at five minutes.

**Architecture:** A pure planner (`apps/server/src/domain/plan.ts`) turns a session's picks into an order and a type for each position. It draws from three tiers, rotated by the enrollment's list-session ordinal, and it decides eligibility before the one model call: the app's listening flag, a word that can be tiled, and four distinct board words. Every new type is answered by one of phase 23's two answer kinds. A board is four ordinary choice questions that share one option order. The repository joins consecutive matching questions into a `board` descriptor, so the app draws them as one card. The app sends `listening: canSpeak(target)` when it creates a session. New card views reuse `MultipleChoiceView` and `TypedAnswerView` where they can, and the board's and the tiles' state live in pure, unit-tested modules.

**Tech Stack:** TypeScript, Zod 4, Hono + @hono/zod-openapi, Drizzle + Postgres 17, pg-boss, Jest (Babel: tests do not type-check), Expo SDK 57 / React Native / react-native-web, expo-speech behind `useSpeech`, Playwright, MockServer.

**Spec:** `docs/superpowers/specs/2026-10-07-lang-tutor-phase-24-more-question-types-design.md`. Part A covers D1–D7 and D10–D16. Part B (D8, D9, the `gap` task, the cloze cards) gets its own plan.

**Deviations from the spec, decided while planning:**
- **The planner gets its own file**, `domain/plan.ts`, not `domain/session.ts`, which stays the session state machine.
- **Part A's tiers hold only the types that exist:**
  - recognise `[multiple_choice, listen_choice]`;
  - pick the form `[reverse_choice, letter_tiles]`;
  - produce `[typed_translation, dictation]`.

  A type cannot sit in a tier before it is in the `QuestionType` union. Part B inserts `cloze_choice` and `cloze_typed` at index 1 of the second and third tiers.
- **`withBoards` lives in `repo/questions.ts`** beside `questionFrom`, which already builds wire questions. ADR 0001 R4 lets persistence import domain *types* only.
- **`shuffleSession` lives in core** beside `shuffleOptions`, because it needs core's internal `shuffle`.
- **The e2e plays every Part A type in one ten-word session** at ordinal 0. The rotation at ordinal 1 is covered by unit tests, not a second e2e session.
- **An old prepare-session payload is tested at unit level** (Task 4), not through the queue.

## Global Constraints

- Every ADR in `docs/adr/` holds, and `npm run lint:arch` must print nothing.
- `domain/` stays pure: no `Date.now`, no `Math.random`, no I/O (ADR 0001 R3). The rng and the clock are received (ADR 0002). `index.ts` passes `Math.random` and `Date.now`.
- Persistence imports domain *types* only (ADR 0001 R4). Service tests import repositories only as types (ADR 0001 R2).
- Every wire type is a `z.infer` (ADR 0003 R3), and `api/index.ts` exports types only.
- No `jest.mock`. No optional or defaulted collaborator parameter (ADR 0002 R4, R5).
- `multiple_choice`, `reverse_choice` and `typed_translation` keep their names, shapes and meaning. The seed session is unchanged.
- **Tiers and rotation:** a tier's preferred type is `tier[(ordinal + run) % tier.length]`, falling forward to the next eligible type and ending at the tier's first.
- **Board:** four words and five meanings, placed after the first run of three, in sessions of 7 or more picks with four distinct forms and meanings.
- **Tiles:** a form of 3–10 letters and nothing else, after stress removal; two extra letters; stored as 5–12 tiles.
- `LIVE_DIMENSIONS = ['written_receptive', 'written_productive', 'spelling', 'spoken_receptive']`.
- `SESSION_GENERATION_BUDGET_MS = 300_000`, `PREPARE_SESSION_EXPIRY_SECONDS = 600`, retries stay at 2.
- The marker `three wrong answers` stays in the prompt. Part A changes no prompt text, so the eval needs no new cases.
- **Hebrew strings, exactly:**
  - `הקשיבו ובחרו את הפירוש`
  - `` `הקשיבו וכתבו ב${language}` ``
  - `התאימו כל מילה לפירוש שלה`
  - `` `הרכיבו את המילה ב${language}` ``
  - `השמעה חוזרת`
  - `אין במכשיר קול לשפה הזו, אז הנה המילה בכתב`
  - `` `בניסיון הראשון: ${right} מתוך ${total}` ``
- **`testID`s:** `listen-play`, `listen-no-voice`, `dictation-meaning`, `board`, `board-word-{i}`, `board-meaning-{i}`, `tiles`, `tile-{i}`, `tile-slot-{i}`, `tiles-built`, `tiles-submit`, `tiles-show-answer`. Existing ones are unchanged.
- **This worktree has lane 1**, so integration and e2e run locally. Run integration files with
  `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath <file>'`
  (`--selectProjects` with a space eats the path), and unit files with
  `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath <file>)`.
- Never hardcode a port or a database name (ADR 0006). Never lower `TIER2_THRESHOLD`.
- **Typecheck is restored task by task.** Core after Task 2, the server after Task 6, mobile after Task 8. Babel runs tests without type-checking, so a task's tests can pass while a later workspace is still red. The whole-repo `npm run typecheck` is a gate from Task 8 on.

## Review Focus

1. **A session resumed mid-board.** The current question is the board's third word, so two were answered before. The board shows those two matched, plays the other two, and submits two answers, not four. *Pinned in Task 7, "a resumed board".*
2. **Two senses of one word, or two words with one meaning, among the picks.** No board may hold both, because two pairings would be right. *Pinned in Task 3, "never puts two senses…".*
3. **A prepare-session job enqueued before this deploy**, with no `listening` and no `ordinal`, must prepare with listening off at ordinal 0, not fail. *Pinned in Task 4, the payload test.*
4. **Questions, sessions and answers stored before migration 0016** load and take answers unchanged. *Pinned in Task 9, the 0016 migration test.*
5. **A tap on a matched word, a taken meaning, or the same word twice** changes nothing and records no attempt. *Pinned in Task 7, "ignores a tap…".*

---

### Task 1: A five-minute generation budget, and the call measured (D16)

**Files:**
- Modify: `apps/server/src/domain/jobs.ts`
- Modify: `apps/server/src/config.ts`, test `apps/server/src/config.test.ts`
- Modify: `apps/server/src/db/jobs.ts`, test `apps/server/tests/integration/db/jobs.test.ts`
- Modify: `apps/server/src/composition.ts`, `apps/server/src/index.ts`
- Modify: `apps/server/src/services/sessions.ts`, tests `apps/server/src/services/sessions.prepare.test.ts`, `sessions.test.ts`, `sessions.progress.test.ts`
- Modify: `apps/server/tests/support/fakes.ts`, `apps/server/tests/support/serverDeps.ts`, `apps/server/tests/integration/composition.test.ts`

**Interfaces:**
- Produces:
  - `SESSION_GENERATION_BUDGET_MS: 300_000` and `PREPARE_SESSION_EXPIRY_SECONDS: 600`, in `domain/jobs.ts`;
  - `createServerDeps(io)`'s `io` gains `now: () => number`;
  - `createSessionService(deps)` gains `now: () => number`;
  - `createFakeClock(...ticks: number[]): () => number`, in `tests/support/fakes.ts`;
  - the `session_prepared` and `session_preparation_dropped` events gain `model_ms: number` and `item_count: number`.

- [ ] **Step 1: Write the failing tests.**

In `apps/server/src/config.test.ts`, replace the test named `defaults the session generation budget to 120 s and reads SESSION_GENERATION_TIMEOUT_MS` with these two, and add `import { PREPARE_SESSION_EXPIRY_SECONDS } from './domain/jobs';` to the imports:

```ts
  it('defaults the session generation budget to five minutes and reads SESSION_GENERATION_TIMEOUT_MS', () => {
    expect(loadConfig({}).sessionGenerationTimeoutMs).toBe(300_000);
    expect(loadConfig({ SESSION_GENERATION_TIMEOUT_MS: '5000' }).sessionGenerationTimeoutMs).toBe(5_000);
  });

  // Phase 24 (spec D16): expiry detects a crashed worker and must never cut a
  // healthy call off. The two numbers used to agree only through a comment.
  it('expires a prepare-session job no sooner than twice the default budget', () => {
    expect(PREPARE_SESSION_EXPIRY_SECONDS * 1000).toBeGreaterThanOrEqual(2 * loadConfig({}).sessionGenerationTimeoutMs);
  });
```

In `apps/server/tests/integration/db/jobs.test.ts`, change `expire_seconds: 240` to `expire_seconds: 600`.

In `apps/server/tests/support/fakes.ts`, add:

```ts
/** Phase 24. A clock that returns `ticks` in turn, then stays on the last. */
export function createFakeClock(...ticks: number[]): () => number {
  const queue = [...ticks];
  return () => (queue.length > 1 ? queue.shift()! : queue[0]);
}
```

In `apps/server/src/services/sessions.prepare.test.ts`:
- import `createFakeClock`;
- in `world()`, create `const logger = createFakeLogger();`;
- pass `logger` and `now: createFakeClock(1_000, 1_250)` to `createSessionService`;
- return `{ service, calls, llm, logger }`.

Then add:

```ts
  // Phase 24 (spec D16): the slowness is measured per session, not felt.
  it('logs how long the model took and how many items it was asked', async () => {
    const { service, logger } = world({});
    await service.prepareSession(PAYLOAD);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'session_prepared', model_ms: 250, item_count: 2 }),
    );
  });
```

In `sessions.test.ts` (three calls) and `sessions.progress.test.ts` (one call), pass `now: createFakeClock(0)` to every `createSessionService({...})`.

- [ ] **Step 2: Run the tests to see them fail.**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/config.test.ts src/services/sessions.prepare.test.ts)`
Expected: FAIL. `300_000` received `120_000`; `PREPARE_SESSION_EXPIRY_SECONDS` is undefined; the log event has no `model_ms`.

- [ ] **Step 3: Implement.**

`apps/server/src/domain/jobs.ts`, after `PREPARE_SESSION_FAILED`:

```ts
/** Phase 24 (spec D16). The most one generation call may take: five minutes,
 *  Victor's cap. The environment may lower it (config.ts); tests do. */
export const SESSION_GENERATION_BUDGET_MS = 300_000;

/** Twice the budget, phase 19's rule: a worker that crashed mid-call expires
 *  and is retried, and a healthy call is never cut off. */
export const PREPARE_SESSION_EXPIRY_SECONDS = (2 * SESSION_GENERATION_BUDGET_MS) / 1000;
```

`apps/server/src/config.ts`:
- delete `DEFAULT_SESSION_GENERATION_TIMEOUT_MS` and its comment;
- add `import { SESSION_GENERATION_BUDGET_MS } from './domain/jobs';`;
- default the value as `Number(env.SESSION_GENERATION_TIMEOUT_MS) || SESSION_GENERATION_BUDGET_MS`.

`apps/server/src/db/jobs.ts`:
- import `PREPARE_SESSION_EXPIRY_SECONDS` beside the queue names;
- replace `expireInSeconds: 240,` and its comment with:

```ts
      // Twice the generation budget (domain/jobs.ts, spec D16): a worker that
      // crashed mid-call expires, and the expiry counts as a failed attempt.
      expireInSeconds: PREPARE_SESSION_EXPIRY_SECONDS,
```

`apps/server/src/composition.ts`:
- add `now: () => number;` to `createServerDeps`'s `io`, under `rng`, with the comment `// Phase 24. A clock, received as rng is: it times the generation call.`;
- pass `now: io.now` to `createSessionService`.

`apps/server/src/index.ts`: add `now: Date.now,` after `rng: Math.random,`.

`apps/server/tests/support/serverDeps.ts`:
- pass `now: Date.now`;
- change the `sessionGenerationTimeoutMs` default to `io.sessionGenerationTimeoutMs ?? SESSION_GENERATION_BUDGET_MS`, importing the constant from `../../src/domain/jobs`.

`apps/server/tests/integration/composition.test.ts`: add `now: () => 0,` to the direct `createServerDeps` call.

`apps/server/src/services/sessions.ts`:
- add `now: () => number;` to `createSessionService`'s deps type and destructure it;
- in `prepareSession`, time the call:

```ts
      const started = now();
      const raw = await llm(
        buildDistractorPrompt({
          items,
          from: read.enrolled.target_language,
          to: read.enrolled.source_language,
        }),
      );
      const modelMs = now() - started;
```

and extend the final log:

```ts
      logger.info({
        event: written ? 'session_prepared' : 'session_preparation_dropped',
        session_id: sessionId,
        question_count: written ? read.context.length : 0,
        item_count: items.length,
        model_ms: modelMs,
        ...(written ? {} : { stage: 'write' }),
      });
```

- [ ] **Step 4: Run the tests to see them pass.**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/config.test.ts src/services/sessions.prepare.test.ts src/services/sessions.test.ts src/services/sessions.progress.test.ts)`
Expected: PASS.

Run: `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath tests/integration/db/jobs.test.ts tests/integration/composition.test.ts'`
Expected: PASS. `installJobs` updates an existing queue in place, so a migrated database reports `expire_seconds: 600`.

Run: `npm run typecheck --workspace apps/server && npm run lint:arch`
Expected: no errors; no violations.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): generation gets a five-minute budget, and the call is timed"
```

---

### Task 2: Core — four new question types, the judge's target, live listening

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Modify: `packages/core/src/domain/quiz.ts`, `typed.ts`, `progress.ts`, `index.ts`
- Test: `packages/core/src/domain/quiz.test.ts`, `typed.test.ts`, `progress.test.ts`

**Interfaces:**
- Produces:
  - wire types `ListenChoiceQuestion`, `DictationQuestion`, `MatchingQuestion`, `MatchingBoard` and `LetterTilesQuestion`, all in `Question`;
  - `QuestionType` now has seven members;
  - `ChoiceQuestion = MultipleChoiceQuestion | ReverseChoiceQuestion | ListenChoiceQuestion | MatchingQuestion`;
  - `TypedTarget = { answer: string; lemma: string; alternatives: readonly string[] }`;
  - `judgeTyped(target: TypedTarget, text: string): TypedVerdict` (a `TypedTranslationQuestion` still satisfies `TypedTarget`);
  - `judgeTiles(answer: string, built: string): TypedVerdict`;
  - `shuffleSession(questions: readonly Question[], rng: () => number): Question[]`;
  - `LIVE_DIMENSIONS` with `spoken_receptive` added.

- [ ] **Step 1: Write the failing tests.**

`packages/core/src/domain/typed.test.ts`: add `judgeTiles` to the import from `./typed`, then append:

```ts
describe('judgeTyped, with a dictation target (phase 24, spec D7)', () => {
  const heard = { answer: 'parlo', lemma: 'parlo', alternatives: [] };

  it('is exact for the spoken form only: the lemma is another word', () => {
    expect(judgeTyped(heard, 'Parlo ')).toBe('exact');
    expect(judgeTyped(heard, 'parlare')).toBe('wrong');
  });

  it('takes a missing accent as a near miss', () => {
    expect(judgeTyped({ answer: 'perché', lemma: 'perché', alternatives: [] }, 'perche')).toBe('near_miss');
  });
});

describe('judgeTiles (phase 24, spec D11)', () => {
  it('is exact for the word, ignoring case and Cyrillic stress', () => {
    expect(judgeTiles('молоко́', 'молоко')).toBe('exact');
    expect(judgeTiles('casa', 'Casa')).toBe('exact');
  });

  it('is wrong for any other order, and for nothing', () => {
    expect(judgeTiles('casa', 'caas')).toBe('wrong');
    expect(judgeTiles('casa', '')).toBe('wrong');
  });
});
```

`packages/core/src/domain/quiz.test.ts`:
- extend the imports with the types `DictationQuestion`, `LetterTilesQuestion`, `ListenChoiceQuestion` and `MatchingQuestion` from `../api/types`, and with `shuffleSession` from `./quiz`;
- append:

```ts
const listen: ListenChoiceQuestion = {
  id: 'l1', type: 'listen_choice', vocab_term_id: 'v', question: 'casa',
  options: ['בית', 'דלת', 'קיר', 'גג'], correct_option: 0,
};
const dictation: DictationQuestion = { id: 'd1', type: 'dictation', vocab_term_id: 'v', question: 'parlo', meaning: 'מדבר' };
const tiles: LetterTilesQuestion = {
  id: 't1', type: 'letter_tiles', vocab_term_id: 'v', question: 'בית', part_of_speech: 'noun',
  answer: 'casa', tiles: ['s', 'a', 'c', 'x', 'a', 'q'],
};
const BOARD = { question_ids: ['m1', 'm2'], words: ['casa', 'gatto'], correct_options: [0, 1] };
const word = (id: string, form: string, correct: number): MatchingQuestion => ({
  id, type: 'matching', vocab_term_id: 'v', question: form,
  options: ['בית', 'חתול', 'כלב'], correct_option: correct, board: BOARD,
});

describe('phase 24 types', () => {
  it('answers a listening card and a board word by option, the rest by text', () => {
    expect(answerFits(listen, { option_index: 0 })).toBe(true);
    expect(answerFits(word('m1', 'casa', 0), { option_index: 2 })).toBe(true);
    expect(answerFits(dictation, { text: 'parlo' })).toBe(true);
    expect(answerFits(tiles, { option_index: 0 })).toBe(false);
  });

  it('judges a dictation against the spoken form, and tiles exactly', () => {
    expect(evaluate(dictation, { text: 'parlare' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
    expect(evaluate(dictation, { text: 'parlo' })).toMatchObject({ is_correct: true, verdict: 'exact' });
    expect(evaluate(tiles, { text: 'casa' })).toMatchObject({ is_correct: true, verdict: 'exact' });
    expect(evaluate(listen, { option_index: 1 })).toEqual({ question_id: 'l1', is_correct: false, answer_string: 'דלת' });
  });

  it('names the right answer: the meaning, the heard form, the built word', () => {
    expect(rightAnswer(listen)).toBe('בית');
    expect(rightAnswer(dictation)).toBe('parlo');
    expect(rightAnswer(tiles)).toBe('casa');
  });

  it('leaves a board word to shuffleSession: shuffleOptions alone would split the board', () => {
    const lone = word('m1', 'casa', 0);
    expect(shuffleOptions(lone, seededRng(5))).toBe(lone);
  });
});

describe('shuffleSession (phase 24, spec D10)', () => {
  it('shuffles a board once: every word shows one order, and the board follows it', () => {
    const shuffled = shuffleSession([listen, word('m1', 'casa', 0), word('m2', 'gatto', 1)], seededRng(5));
    const first = shuffled[1] as MatchingQuestion;
    const second = shuffled[2] as MatchingQuestion;
    expect(second.options).toEqual(first.options);
    expect(first.options[first.correct_option]).toBe('בית');
    expect(second.options[second.correct_option]).toBe('חתול');
    expect(first.board.correct_options).toEqual([first.correct_option, second.correct_option]);
    expect(second.board).toEqual(first.board);
  });

  it('shuffles every other choice on its own, as shuffleOptions does', () => {
    const [shown] = shuffleSession([listen], seededRng(5));
    expect(shown).toEqual(shuffleOptions(listen, seededRng(5)));
  });
});
```

`packages/core/src/domain/progress.test.ts`: change the expected list in the test that pins `LIVE_DIMENSIONS` (line 42) to `['written_receptive', 'written_productive', 'spelling', 'spoken_receptive']`.

- [ ] **Step 2: Run the tests to see them fail.**

Run: `npm test --workspace packages/core`
Expected: FAIL. `judgeTiles` and `shuffleSession` are not exported; `answerFits` and `rightAnswer` mishandle the new types; `LIVE_DIMENSIONS` has three members.

- [ ] **Step 3: Implement.**

`packages/core/src/api/schemas.ts`, after `TypedTranslationQuestionSchema`:

```ts
// Phase 24. Hear the word, pick its meaning: today's card with its prompt
// spoken rather than shown. `question` is the form the app speaks, and shows
// once the card is answered (spec D6).
export const ListenChoiceQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('listen_choice'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
});

// Phase 24. Hear the word, type it. Judged against the spoken form alone
// (spec D7). `meaning` is shown after the answer and read by the missed list.
export const DictationQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('dictation'),
  vocab_term_id: z.string(),
  question: z.string(),
  meaning: z.string(),
});

// Phase 24 (spec D10). A matching board, as each of its words carries it: every
// word's question id, the word, and its right option among the shared options.
export const MatchingBoardSchema = z.object({
  question_ids: z.array(z.string()),
  words: z.array(z.string()),
  correct_options: z.array(z.number().int()),
});

// Phase 24. One word of a board. A board is consecutive questions of this type,
// each answered by its first-tried meaning. `options` are the board's five
// meanings, in the one order all its words share.
export const MatchingQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('matching'),
  vocab_term_id: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  correct_option: z.number().int(),
  board: MatchingBoardSchema,
});

// Phase 24 (spec D11). The meaning; the learner builds the word from `tiles`,
// its letters and two more, shuffled. `answer` is the form, for the local judge.
export const LetterTilesQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('letter_tiles'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  answer: z.string(),
  tiles: z.array(z.string()),
});
```

Then add the four member schemas to `QuestionSchema`'s `z.discriminatedUnion('type', [...])` list.

`packages/core/src/api/types.ts`:
- add the five schemas to the import;
- add these lines beside `TypedTranslationQuestion`:

```ts
export type ListenChoiceQuestion = z.infer<typeof ListenChoiceQuestionSchema>;
export type DictationQuestion = z.infer<typeof DictationQuestionSchema>;
export type MatchingBoard = z.infer<typeof MatchingBoardSchema>;
export type MatchingQuestion = z.infer<typeof MatchingQuestionSchema>;
export type LetterTilesQuestion = z.infer<typeof LetterTilesQuestionSchema>;
```

`packages/core/src/api/index.ts`: add the five type names to its `export type { ... }` list.

`packages/core/src/domain/typed.ts`:
- add the type below;
- change `judgeTyped`'s signature to `judgeTyped(target: TypedTarget, text: string): TypedVerdict` and rename `question` to `target` in its body;
- append `judgeTiles`.

```ts
/** What a typed answer is judged against (phase 24): a typed card's own fields,
 *  or a dictation's spoken form as both answer and lemma with no alternatives. */
export type TypedTarget = { answer: string; lemma: string; alternatives: readonly string[] };
```

```ts
/** Phase 24 (spec D11). Tiles cannot slip: the built word is the form, or it is wrong. */
export function judgeTiles(answer: string, built: string): TypedVerdict {
  const typed = normaliseTyped(built);
  return typed !== '' && typed === normaliseTyped(answer) ? 'exact' : 'wrong';
}
```

Remove the now-unused `TypedTranslationQuestion` import from `typed.ts` if nothing else uses it.

`packages/core/src/domain/quiz.ts`. Update the imports:
- from `../api/types`: add `ListenChoiceQuestion`, `MatchingQuestion` and `TypedVerdict` (the text types need no import: `TextQuestion` is derived);
- from `./typed`: `judgeTiles`, `judgeTyped`.

Then replace `ChoiceQuestion`, `isChoice`, `rightAnswer`, `shuffleOptions` and `evaluate` with:

```ts
export type ChoiceQuestion = MultipleChoiceQuestion | ReverseChoiceQuestion | ListenChoiceQuestion | MatchingQuestion;
/** Phase 24. A question answered by text: typed, heard, or built from tiles. */
type TextQuestion = Exclude<Question, ChoiceQuestion>;

export function isChoice(question: Question): question is ChoiceQuestion {
  switch (question.type) {
    case 'multiple_choice':
    case 'reverse_choice':
    case 'listen_choice':
    case 'matching':
      return true;
    case 'typed_translation':
    case 'dictation':
    case 'letter_tiles':
      return false;
  }
}

/** What the learner should have answered, as the feedback and the missed list show it. */
export function rightAnswer(question: Question): string {
  if (isChoice(question)) return question.options[question.correct_option];
  return question.type === 'dictation' ? question.question : question.answer;
}

/** A choice's options in a new order. A text card has none and comes back as
 *  it is, and so does a board word: its board shares one order, which
 *  shuffleSession gives it. */
export function shuffleOptions(question: Question, rng: () => number): Question {
  if (!isChoice(question) || question.type === 'matching') return question;
  const correct = question.options[question.correct_option];
  const options = shuffle(question.options, rng);
  return { ...question, options, correct_option: options.indexOf(correct) };
}

/**
 * Phase 24 (spec D10). A list session's shown orders: each choice shuffled on
 * its own, and a board's words once, together, so all of them show one order
 * and the board's correct options follow it. A board's words share their
 * canonical options (repo/questions), which is what lets one order fit all.
 */
export function shuffleSession(questions: readonly Question[], rng: () => number): Question[] {
  let boardOrder: string[] | null = null;
  return questions.map((question) => {
    if (question.type !== 'matching') return shuffleOptions(question, rng);
    const order = (boardOrder ??= shuffle(question.options, rng));
    const at = (index: number) => order.indexOf(question.options[index]);
    return {
      ...question,
      options: order,
      correct_option: at(question.correct_option),
      board: { ...question.board, correct_options: question.board.correct_options.map(at) },
    };
  });
}

function verdictFor(question: TextQuestion, text: string): TypedVerdict {
  switch (question.type) {
    case 'typed_translation':
      return judgeTyped(question, text);
    case 'dictation':
      // Spec D7: what was said, and nothing else — not its lemma, not a synonym.
      return judgeTyped({ answer: question.question, lemma: question.question, alternatives: [] }, text);
    case 'letter_tiles':
      return judgeTiles(question.answer, text);
  }
}

// Callers check answerFits, and an option's range, first: the session's step
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
    const verdict = verdictFor(question, answer.text);
    return { question_id: question.id, is_correct: verdict !== 'wrong', answer_string: answer.text, verdict };
  }
  throw new Error(`the answer does not fit a ${question.type} question`);
}
```

`packages/core/src/domain/progress.ts`: set `LIVE_DIMENSIONS` to `['written_receptive', 'written_productive', 'spelling', 'spoken_receptive']`, with this comment:

```ts
/** The dimensions some question type feeds. Phase 23 made the three written
 *  ones live; phase 24's listening cards feed spoken_receptive (spec D13). A
 *  badge is the mean over these, so each going live recalibrates it once. */
```

`packages/core/src/domain/index.ts`:
- add `shuffleSession` to the `./quiz` export;
- export `judgeTiles` beside `judgeTyped`;
- add `export type { TypedTarget } from './typed';`.

- [ ] **Step 4: Run the tests to see them pass.**

Run: `npm test --workspace packages/core && npm run typecheck --workspace packages/core`
Expected: PASS, and no type errors. The server and mobile typechecks are red from here until Tasks 6 and 8, because their exhaustive switches do not know the new types yet.

- [ ] **Step 5: Commit.**

```bash
git add packages/core
git commit -m "feat(core): listening, dictation, board and tiles questions, and their judges"
```

---

### Task 3: The planner and the tiles (pure server domain)

**Files:**
- Create: `apps/server/src/domain/plan.ts`, `apps/server/src/domain/plan.test.ts`
- Create: `apps/server/src/domain/tiles.ts`, `apps/server/src/domain/tiles.test.ts`
- Modify: `apps/server/src/domain/languages.ts`

**Interfaces:**
- Consumes: `QuestionType` from `@lang-tutor/core/domain`; `pickSenses` from `./session`; `stripStress` from `./languages`.
- Produces:
  - `PlanPick = { form: string; translation: string; tiles: boolean }`;
  - `PlanInput = { listening: boolean; ordinal: number }`;
  - `SessionPlan = { order: number[]; types: QuestionType[]; board: { start: number } | null }`;
  - `planSession(picks: readonly PlanPick[], input: PlanInput): SessionPlan`;
  - `TIERS`, `BOARD_SIZE = 4`, `BOARD_MIN_PICKS = 7`;
  - `tileEligible(form: string): boolean`;
  - `tilesFor(form: string, alphabet: string, rng: () => number): string[]`;
  - `Language.alphabet: string`.

- [ ] **Step 1: Write the failing tests.**

`apps/server/src/domain/plan.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { planSession, type PlanPick } from './plan';

const pick = (n: number, tiles = true): PlanPick => ({ form: `word${n}`, translation: `מילה${n}`, tiles });
const picks = (count: number, tiles = true) => Array.from({ length: count }, (_, i) => pick(i, tiles));
const ON = { listening: true, ordinal: 0 };
const OFF = { listening: false, ordinal: 0 };
const BOARD = ['matching', 'matching', 'matching', 'matching'];

describe('planSession (spec D3, D4, D10)', () => {
  it('lays ten words out as a run, the board and a run, with six different single types', () => {
    const plan = planSession(picks(10), ON);
    expect(plan.types).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      ...BOARD,
      'listen_choice', 'letter_tiles', 'dictation',
    ]);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rotates by ordinal, so two ten-word sessions in a row show every type', () => {
    expect(planSession(picks(10), { listening: true, ordinal: 1 }).types).toEqual([
      'listen_choice', 'letter_tiles', 'dictation',
      ...BOARD,
      'multiple_choice', 'reverse_choice', 'typed_translation',
    ]);
  });

  it('has no board below seven words, and opens on phase 23 cycle', () => {
    const plan = planSession(picks(6), OFF);
    expect(plan.board).toBeNull();
    expect(plan.types).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'multiple_choice', 'letter_tiles', 'typed_translation',
    ]);
  });

  it('places the board after the first run at seven, eight and nine words', () => {
    for (const n of [7, 8, 9]) {
      const plan = planSession(picks(n), OFF);
      expect(plan.board).toEqual({ start: 3 });
      expect(plan.types.slice(3, 7)).toEqual(BOARD);
      expect(plan.types).toHaveLength(n);
    }
  });

  it('falls forward within a tier to an eligible type, ending at the first', () => {
    const plan = planSession(picks(10, false), OFF);
    expect(plan.types.filter((type) => type !== 'matching')).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'multiple_choice', 'reverse_choice', 'typed_translation',
    ]);
  });

  // Review Focus 2.
  it('never puts two senses of one word, or two words with one meaning, on a board', () => {
    const list: PlanPick[] = [
      pick(0), pick(1), pick(2),
      { form: 'lock', translation: 'מנעול', tiles: true },
      { form: 'Lock', translation: 'טירה', tiles: true },
      { form: 'big', translation: 'גדול', tiles: true },
      { form: 'large', translation: 'גדול', tiles: true },
      pick(7), pick(8), pick(9),
    ];
    const plan = planSession(list, OFF);
    expect(plan.board).toEqual({ start: 3 });
    expect(plan.order).toEqual([0, 1, 2, 3, 5, 7, 8, 4, 6, 9]);
  });

  it('has no board when four distinct words cannot be found', () => {
    const same = Array.from({ length: 8 }, (_, i) => ({ form: i < 3 ? `w${i}` : 'lock', translation: `מ${i}`, tiles: true }));
    const plan = planSession(same, OFF);
    expect(plan.board).toBeNull();
    expect(plan.types).not.toContain('matching');
  });

  it('never gives two cards in a row one type, at any size, ordinal or listening', () => {
    for (let n = 1; n <= 10; n++) {
      for (const ordinal of [0, 1, 2, 3]) {
        for (const listening of [true, false]) {
          const { types, board } = planSession(picks(n), { listening, ordinal });
          // A board is one card: keep its first word only.
          const cards = types.filter((_, i) => !(board && i > board.start && i < board.start + 4));
          for (let i = 1; i < cards.length; i++) expect(cards[i]).not.toBe(cards[i - 1]);
        }
      }
    }
  });
});
```

`apps/server/src/domain/tiles.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { testRng } from '../../tests/support/testRng';
import { LANGUAGES } from './languages';
import { tileEligible, tilesFor } from './tiles';

describe('tileEligible (spec D4, D11)', () => {
  it('takes one word of three to ten letters, and nothing else', () => {
    expect(tileEligible('casa')).toBe(true);
    expect(tileEligible('perché')).toBe(true);
    expect(tileEligible('молоко́')).toBe(true);
    expect(tileEligible('re')).toBe(false);
    expect(tileEligible('precipitevolissimevolmente')).toBe(false);
    expect(tileEligible('pick up')).toBe(false);
    expect(tileEligible("l'acqua")).toBe(false);
  });
});

describe('tilesFor (spec D11)', () => {
  it("is the word's letters, lowercased and unstressed, plus two from the alphabet", () => {
    const tiles = tilesFor('Молоко́', LANGUAGES.ru.alphabet, testRng(7));
    expect(tiles).toHaveLength(8);
    const rest = [...tiles];
    for (const letter of 'молоко') rest.splice(rest.indexOf(letter), 1);
    expect(rest).toHaveLength(2);
    for (const extra of rest) expect(LANGUAGES.ru.alphabet).toContain(extra);
  });

  it('is reproducible under a seeded rng', () => {
    expect(tilesFor('casa', LANGUAGES.it.alphabet, testRng(3))).toEqual(tilesFor('casa', LANGUAGES.it.alphabet, testRng(3)));
  });

  it('refuses a word that cannot be tiled', () => {
    expect(() => tilesFor('pick up', LANGUAGES.en.alphabet, testRng(3))).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/plan.test.ts src/domain/tiles.test.ts)`
Expected: FAIL. Neither `./plan` nor `./tiles` exists.

- [ ] **Step 3: Implement.**

`apps/server/src/domain/languages.ts`: add this to the `Language` type, after `letters`:

```ts
  /** Phase 24 (spec D11). The letters a tiles card's two extra tiles are drawn
   *  from, lowercase. Accented Italian vowels are letters of their own. */
  alphabet: string;
```

Then give each entry its value:
- `he`: `'אבגדהוזחטיכלמנסעפצקרשת'`
- `en`: `'abcdefghijklmnopqrstuvwxyz'`
- `ru`: `'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'`
- `it`: `'abcdefghilmnopqrstuvzàèéìòù'`

`apps/server/src/domain/tiles.ts`:

```ts
import { stripStress } from './languages';
import { pickSenses } from './session';

/**
 * Phase 24 (spec D11). Letter tiles: which words can be built from tiles, and
 * the tiles themselves. Pure; the rng is passed in (ADR 0001 R3).
 */

export const TILE_MIN_LETTERS = 3;
export const TILE_MAX_LETTERS = 10;
export const EXTRA_TILES = 2;

/** The word's letters, lowercased and unstressed, one per code point after
 *  NFC; null when it is not one word of 3 to 10 letters. A phrase or an
 *  elision has no sensible tile set, and a long word is a wall of tiles. */
function tileLetters(form: string): string[] | null {
  const letters = [...stripStress(form).normalize('NFC').toLowerCase()];
  if (letters.length < TILE_MIN_LETTERS || letters.length > TILE_MAX_LETTERS) return null;
  return letters.every((letter) => /\p{L}/u.test(letter)) ? letters : null;
}

export function tileEligible(form: string): boolean {
  return tileLetters(form) !== null;
}

/** The word's letters and two from `alphabet`, shuffled. */
export function tilesFor(form: string, alphabet: string, rng: () => number): string[] {
  const letters = tileLetters(form);
  if (!letters) throw new Error(`"${form}" cannot be built from tiles`);
  const pool = [...alphabet];
  const extras = Array.from({ length: EXTRA_TILES }, () => pool[Math.floor(rng() * pool.length)]);
  const all = [...letters, ...extras];
  // pickSenses keeping every entry is a uniform shuffle.
  return pickSenses(all, all.length, rng);
}
```

`apps/server/src/domain/plan.ts`:

```ts
import type { QuestionType } from '@lang-tutor/core/domain';

/**
 * Phase 24 (spec D3, D4, D10). Which type each position of a list session
 * gets, and in which order its picks are asked. Pure and deterministic: the
 * same picks, flags and ordinal give the same plan, so an e2e test knows every
 * position's type without a seeded rng.
 */

/** One pick as the plan reads it. `tiles`: the form can be built from tiles. */
export type PlanPick = { form: string; translation: string; tiles: boolean };

/** `listening`: the app said its device has a voice for the target (spec D5).
 *  `ordinal`: how many list sessions the enrollment had before this one. */
export type PlanInput = { listening: boolean; ordinal: number };

/** `order[i]` is the index into the picks asked at position `i`, `types[i]`
 *  its type. A board takes positions `start` to `start + 3`. */
export type SessionPlan = { order: number[]; types: QuestionType[]; board: { start: number } | null };

/** Each run of three climbs these tiers: recognise, pick the form, produce.
 *  A tier's first type is always eligible. Part B inserts the cloze types at
 *  index 1 of the second and third. */
export const TIERS: readonly (readonly QuestionType[])[] = [
  ['multiple_choice', 'listen_choice'],
  ['reverse_choice', 'letter_tiles'],
  ['typed_translation', 'dictation'],
];

export const BOARD_SIZE = 4;
export const BOARD_MIN_PICKS = 7;
const RUN = TIERS.length;

function eligible(type: QuestionType, pick: PlanPick, input: PlanInput): boolean {
  switch (type) {
    case 'multiple_choice':
    case 'reverse_choice':
    case 'typed_translation':
      return true;
    case 'listen_choice':
    case 'dictation':
      return input.listening;
    case 'letter_tiles':
      return pick.tiles;
    case 'matching':
      return false;
  }
}

const key = (text: string) => text.trim().toLowerCase();

/** The first four picks from `from` on whose forms and meanings all differ:
 *  two senses of one word, or two words with one meaning, would each make two
 *  pairings right. Null when four cannot be found. */
function boardPicks(picks: readonly PlanPick[], from: number): number[] | null {
  const taken: number[] = [];
  for (let i = from; i < picks.length && taken.length < BOARD_SIZE; i++) {
    const clash = taken.some(
      (j) => key(picks[j].form) === key(picks[i].form) || key(picks[j].translation) === key(picks[i].translation),
    );
    if (!clash) taken.push(i);
  }
  return taken.length === BOARD_SIZE ? taken : null;
}

/** The preferred type, or the next eligible one in the tier's order. */
function typeIn(tier: readonly QuestionType[], preferred: number, pick: PlanPick, input: PlanInput): QuestionType {
  for (let step = 0; step < tier.length; step++) {
    const type = tier[(preferred + step) % tier.length];
    if (eligible(type, pick, input)) return type;
  }
  return tier[0];
}

export function planSession(picks: readonly PlanPick[], input: PlanInput): SessionPlan {
  const firstRun = Math.min(RUN, picks.length);
  const board = picks.length >= BOARD_MIN_PICKS ? boardPicks(picks, firstRun) : null;
  const onBoard = new Set(board ?? []);
  const singles = picks.map((_, index) => index).filter((index) => !onBoard.has(index));
  const order = board ? [...singles.slice(0, firstRun), ...board, ...singles.slice(firstRun)] : singles;

  const types: QuestionType[] = [];
  let single = 0;
  for (const index of order) {
    if (onBoard.has(index)) {
      types.push('matching');
      continue;
    }
    const tier = TIERS[single % RUN];
    const run = Math.floor(single / RUN);
    types.push(typeIn(tier, (input.ordinal + run) % tier.length, picks[index], input));
    single++;
  }
  return { order, types, board: board ? { start: firstRun } : null };
}
```

- [ ] **Step 4: Run the tests to see them pass.**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/plan.test.ts src/domain/tiles.test.ts src/domain/languages.test.ts)`
Expected: PASS. If `languages.test.ts` does not exist, drop it from the command.

Run: `npm run lint:arch`
Expected: no violations. `plan.ts` and `tiles.ts` import only core and sibling domain modules.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/domain
git commit -m "feat(server): the session planner and letter tiles, pure"
```

---

### Task 4: Evidence for the new types, and the payload's new fields

**Files:**
- Modify: `apps/server/src/domain/progress.ts`, test `apps/server/src/domain/progress.test.ts`
- Modify: `apps/server/src/domain/jobs.ts`
- Create: `apps/server/src/domain/jobs.test.ts`

**Interfaces:**
- Produces:
  - `ChoiceAnswerType = 'multiple_choice' | 'reverse_choice' | 'listen_choice' | 'matching'`;
  - `TextAnswerType = 'typed_translation' | 'dictation' | 'letter_tiles'`;
  - `AnsweredQuestion = { senseId; type: ChoiceAnswerType; correct: boolean } | { senseId; type: TextAnswerType; verdict: TypedVerdict }`;
  - `PrepareSessionPayload` gains `listening: boolean` (default false) and `ordinal: number` (default 0).

- [ ] **Step 1: Write the failing tests.**

Append to `apps/server/src/domain/progress.test.ts`, importing `type AnsweredQuestion` and `type Evidence` from `./progress` if they are not imported already:

```ts
describe('evidenceFor, phase 24 (spec D12)', () => {
  const sense = 's1';
  const piece = (dimension: string, correct: boolean, capped = false) => ({ dimension, correct, capped });
  const cases: [AnsweredQuestion, Evidence[]][] = [
    [{ senseId: sense, type: 'listen_choice', correct: true }, [piece('spoken_receptive', true)] as Evidence[]],
    [{ senseId: sense, type: 'listen_choice', correct: false }, [piece('spoken_receptive', false)] as Evidence[]],
    [{ senseId: sense, type: 'dictation', verdict: 'exact' }, [piece('spoken_receptive', true), piece('spelling', true)] as Evidence[]],
    [{ senseId: sense, type: 'dictation', verdict: 'near_miss' }, [piece('spoken_receptive', true), piece('spelling', false)] as Evidence[]],
    [{ senseId: sense, type: 'dictation', verdict: 'wrong' }, [piece('spoken_receptive', false)] as Evidence[]],
    [{ senseId: sense, type: 'matching', correct: true }, [piece('written_receptive', true)] as Evidence[]],
    [{ senseId: sense, type: 'matching', correct: false }, [piece('written_receptive', false)] as Evidence[]],
    [
      { senseId: sense, type: 'letter_tiles', verdict: 'exact' },
      [piece('written_receptive', true), piece('written_productive', true, true)] as Evidence[],
    ],
    [{ senseId: sense, type: 'letter_tiles', verdict: 'wrong' }, [piece('written_productive', false, true)] as Evidence[]],
  ];
  it.each(cases)('%o', (answer, expected) => {
    expect(evidenceFor(answer)).toEqual(expected);
  });

  it('never credits a written dimension for listening: nothing crosses modalities', () => {
    const dimensions = evidenceFor({ senseId: sense, type: 'dictation', verdict: 'exact' }).map((p) => p.dimension);
    expect(dimensions.filter((d) => d.startsWith('written'))).toEqual([]);
  });
});
```

`apps/server/src/domain/jobs.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { PrepareSessionPayloadSchema } from './jobs';

describe('PrepareSessionPayloadSchema', () => {
  // Review Focus 3: a job enqueued before phase 24 has neither field.
  it('reads a payload from before phase 24 as listening off, at the first ordinal', () => {
    expect(
      PrepareSessionPayloadSchema.parse({ session_id: 's', picks: [{ sense_id: 'a', variant_id: 'b' }] }),
    ).toMatchObject({ listening: false, ordinal: 0 });
  });

  it('keeps both when present', () => {
    expect(
      PrepareSessionPayloadSchema.parse({
        session_id: 's',
        picks: [{ sense_id: 'a', variant_id: 'b' }],
        listening: true,
        ordinal: 4,
      }),
    ).toMatchObject({ listening: true, ordinal: 4 });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/progress.test.ts src/domain/jobs.test.ts)`
Expected: FAIL. `evidenceFor` returns `undefined` for the new types, and the payload has neither field.

- [ ] **Step 3: Implement.**

`apps/server/src/domain/progress.ts`, replacing `AnsweredQuestion`:

```ts
/** Phase 24. The types answered by an option, and by a text with its verdict. */
export type ChoiceAnswerType = 'multiple_choice' | 'reverse_choice' | 'listen_choice' | 'matching';
export type TextAnswerType = 'typed_translation' | 'dictation' | 'letter_tiles';

/** One answer as the rule reads it: which sense, which exercise, and how it
 *  was judged. A choice is right or wrong; a text answer has its verdict. */
export type AnsweredQuestion =
  | { senseId: string; type: ChoiceAnswerType; correct: boolean }
  | { senseId: string; type: TextAnswerType; verdict: TypedVerdict };
```

In `evidenceFor`, add these cases to the outer `switch (answer.type)`, and update its doc comment to say "filled in for phase 23's types (spec D6) and phase 24's (spec D12)":

```ts
    case 'listen_choice':
      // Hearing, then knowing the meaning: the spoken receptive dimension
      // only. Nothing crosses modalities (phase 20).
      return [piece('spoken_receptive', answer.correct)];
    case 'matching':
      // A word's first-tried meaning: recognition, as today's card.
      return [piece('written_receptive', answer.correct)];
    case 'dictation':
      switch (answer.verdict) {
        case 'exact':
          return [piece('spoken_receptive', true), piece('spelling', true)];
        case 'near_miss':
          return [piece('spoken_receptive', true), piece('spelling', false)];
        case 'alternative':
          // A dictation accepts no alternative (spec D7); unreachable.
          return [];
        case 'wrong':
          // A failure to recognise the word heard; nothing about spelling.
          return [piece('spoken_receptive', false)];
      }
    case 'letter_tiles':
      // The letters are given: production with support, capped like the
      // reversed card, and never spelling (spec D11).
      return answer.verdict === 'exact'
        ? [piece('written_receptive', true), piece('written_productive', true, true)]
        : [piece('written_productive', false, true)];
```

`apps/server/src/domain/jobs.ts`: add both fields to `PrepareSessionPayloadSchema`:

```ts
  // Phase 24 (spec D5, D3). Absent in a job enqueued before the deploy: such a
  // session gets no listening cards, and the rotation's first step.
  listening: z.boolean().default(false),
  ordinal: z.number().int().nonnegative().default(0),
```

- [ ] **Step 4: Run the tests to see them pass.**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/progress.test.ts src/domain/jobs.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/domain
git commit -m "feat(server): evidence for listening, dictation, board and tiles; payload flags"
```

---

### Task 5: Persistence — schema, migration 0016, repositories

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0016_listening_variety.sql` (generated) and its `meta/` snapshot
- Modify: `apps/server/src/repo/questions.ts`, `apps/server/src/repo/sessions.ts`, `apps/server/src/repo/progress.ts`

**Interfaces:**
- Consumes: Task 2's question types; Task 4's `ChoiceAnswerType` and `TextAnswerType`.
- Produces:
  - `questions.tiles text[]`;
  - `QuestionRow.tiles`;
  - `questionFrom(row, order)` builds all seven types, a matching row as a board of one;
  - `withBoards(questions: readonly Question[]): Question[]`;
  - `insertGeneratedQuestions` input items gain `tiles: string[] | null`, and its result is passed through `withBoards`;
  - `countListSessions(enrollmentId: string): Promise<number>`;
  - `loadSession` attaches boards.

- [ ] **Step 1: Change the schema.** In `apps/server/src/db/schema.ts`, `questions` table:

```ts
    // Phase 24. A tiles card's tiles: its letters and two more, shuffled.
    tiles: text('tiles').array(),
```

Replace the type and shape checks:

```ts
    check(
      'questions_type_known',
      sql`${t.type} in ('multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles')`,
    ),
    // Phase 23 and 24. Each type's shape (spec D13, phase 24 §2): a choice has
    // options, every type but the Hebrew-option ones stores the Hebrew prompt,
    // only a typed card has alternatives, and only a tiles card has tiles.
    check(
      'questions_shape_valid',
      sql`case ${t.type}
        when 'multiple_choice' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'listen_choice' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'matching' then ${t.options} is not null and ${t.prompt} is null and ${t.alternatives} is null and ${t.tiles} is null
        when 'reverse_choice' then ${t.options} is not null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'typed_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 5
        when 'dictation' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'letter_tiles' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null
          and coalesce(array_length(${t.tiles}, 1), 0) between 5 and 12
        else false end`,
    ),
```

- [ ] **Step 2: Generate the migration.**

Run: `npm run db:generate --workspace apps/server -- --name listening_variety`

Expected: `apps/server/src/db/migrations/0016_listening_variety.sql`, holding `ADD COLUMN "tiles" text[]` and a drop and re-add of `questions_type_known` and `questions_shape_valid`. Read it, then add this header by hand:

```sql
-- Phase 24. Listening, dictation, board and tiles questions (spec §2). Every
-- existing row satisfies the new checks unchanged: none has tiles, and every
-- question is one of phase 23's three types in its phase 23 shape.
```

Run: `npm run db:check --workspace apps/server`
Expected: no drift.

- [ ] **Step 3: Update `repo/questions.ts`.**
- Add `tiles: string[] | null` to `QuestionRow`.
- Add `tiles: questions.tiles` to `questionColumns`.
- Import `type MatchingQuestion` from `@lang-tutor/core/api`.
- Replace `questionFrom`, and add `withBoards`:

```ts
/**
 * Turns a question row into the API's `Question`. `order` is a session's
 * `option_order`; without it, or for a text card (whose order is `{}`), the
 * options come back in canonical order.
 *
 * Phase 23: today's card asks the variant's form; the reversed and typed cards
 * ask the stored Hebrew prompt. Phase 24: a listening card and a board word ask
 * the form too (spoken, or beside its meanings); a dictation speaks the form
 * and keeps the Hebrew as its meaning; a tiles card asks the Hebrew. A matching
 * row comes back as a board of one, which withBoards joins.
 */
export function questionFrom(row: QuestionRow, order: number[] | null): Question {
  const base = { id: row.id, vocab_term_id: row.lexemeId };
  switch (row.type) {
    case 'typed_translation':
      return {
        ...base,
        type: 'typed_translation',
        question: row.prompt!,
        part_of_speech: row.partOfSpeech,
        answer: row.form,
        lemma: row.lemma,
        alternatives: row.alternatives ?? [],
      };
    case 'dictation':
      return { ...base, type: 'dictation', question: row.form, meaning: row.prompt! };
    case 'letter_tiles':
      return {
        ...base,
        type: 'letter_tiles',
        question: row.prompt!,
        part_of_speech: row.partOfSpeech,
        answer: row.form,
        tiles: row.tiles!,
      };
  }
  const canonical = canonicalOptions(row.options!);
  const shown = order && order.length > 0 ? order.map((position) => canonical[position]) : canonical;
  const choice = {
    options: shown.map((option) => option.text),
    correct_option: shown.findIndex((option) => option.is_correct),
  };
  switch (row.type) {
    case 'reverse_choice':
      return { ...base, type: 'reverse_choice', question: row.prompt!, part_of_speech: row.partOfSpeech, ...choice };
    case 'listen_choice':
      return { ...base, type: 'listen_choice', question: row.form, ...choice };
    case 'matching':
      return {
        ...base,
        type: 'matching',
        question: row.form,
        ...choice,
        board: { question_ids: [row.id], words: [row.form], correct_options: [choice.correct_option] },
      };
    default:
      return { ...base, type: 'multiple_choice', question: row.form, ...choice };
  }
}

/**
 * Phase 24 (spec D10). Gives each run of consecutive matching questions the
 * whole board: every word's question id, the word, and its correct option. A
 * session holds at most one board, and its words share one option order.
 */
export function withBoards(questions: readonly Question[]): Question[] {
  const result = [...questions];
  for (let start = 0; start < result.length; ) {
    let end = start;
    while (end < result.length && result[end].type === 'matching') end++;
    if (end === start) {
      start++;
      continue;
    }
    const run = result.slice(start, end) as MatchingQuestion[];
    const board = {
      question_ids: run.map((question) => question.id),
      words: run.map((question) => question.question),
      correct_options: run.map((question) => question.correct_option),
    };
    for (let i = start; i < end; i++) result[i] = { ...(result[i] as MatchingQuestion), board };
    start = end;
  }
  return result;
}
```

In `insertGeneratedQuestions`:
- add `tiles: string[] | null;` to the input item type;
- write `tiles: question.tiles` into `values`;
- pass `tiles: question.tiles` into the `questionFrom` row;
- wrap the returned list: `return withBoards(rows.map(...))`.

In `loadQuestionPool`, nothing changes: the seed is multiple choice only.

- [ ] **Step 4: Update `repo/sessions.ts`.**
- Import `withBoards` beside `questionFrom`.
- In `insertSessionQuestions`, replace `if (question.type === 'typed_translation') {` with `if (!('options' in question)) {`, and change its comment to "A text card (typed, dictation, tiles) has no options, so its order is `{}`." Persistence imports domain types only, so it tests the shape rather than calling `isChoice`.
- In `loadSession`, build the questions as `withBoards(questionRows.map((row) => questionFrom(row, row.optionOrder)))`.
- Add:

```ts
    /** Phase 24 (spec D3). How many list sessions an enrollment has had, of any
     *  status: the planner's rotation step for the next one. */
    countListSessions: async (enrollmentId: string): Promise<number> => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.enrollmentId, enrollmentId), eq(sessions.source, 'list')));
      return row.count;
    },
```

- [ ] **Step 5: Update `repo/progress.ts`.** In `findSessionEvidence`, replace the per-row mapping so every text type reads its verdict:

```ts
        answers: rows.rows.map((row): AnsweredQuestion => {
          // Phase 23 and 24. A text answer carries the verdict it was shown.
          if (TEXT_TYPES.has(row.type)) {
            return { senseId: row.sense_id, type: row.type as TextAnswerType, verdict: row.verdict as TypedVerdict };
          }
          return {
            senseId: row.sense_id,
            type: row.type as ChoiceAnswerType,
            // selected_option_position is canonical (sessions.insertAnswer), and
            // question_options_valid makes positions 0..n-1.
            correct: canonicalOptions(row.options!)[row.selected_option_position!].is_correct,
          };
        }),
```

with, at module level:

```ts
const TEXT_TYPES: ReadonlySet<string> = new Set(['typed_translation', 'dictation', 'letter_tiles']);
```

Import `ChoiceAnswerType` and `TextAnswerType` as types from `../domain/progress`. `findSnapshot` is unchanged: it already reads the Hebrew from `prompt`, falling back to the correct option (spec D15).

- [ ] **Step 6: Verify.**

Run: `npm run lint:arch`
Expected: no violations. The repositories import only domain types.

Run: `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath tests/integration/repo/questions.test.ts tests/integration/repo/sessions.test.ts tests/integration/db/migrations.test.ts'`
Expected: PASS. Every phase 23 behaviour is unchanged; new behaviour is tested in Task 9.

- [ ] **Step 7: Commit.**

```bash
git add apps/server/src/db apps/server/src/repo
git commit -m "feat(server): store listening, dictation, board and tiles questions (migration 0016)"
```

---

### Task 6: Generation and the service — the job builds Part A sessions

**Files:**
- Modify: `apps/server/src/domain/distractors.ts`, test `apps/server/src/domain/distractors.test.ts`
- Modify: `apps/server/src/domain/session.ts` (remove `TYPE_CYCLE`, `typeFor`), test `apps/server/src/domain/session.test.ts`
- Modify: `apps/server/src/services/sessions.ts`, tests `apps/server/src/services/sessions.prepare.test.ts`, `apps/server/src/services/sessions.test.ts`
- Modify: `apps/server/src/routes/sessions.ts`
- Modify: `apps/server/tests/support/questions.ts`, `apps/server/tests/support/mockServer.ts`, and every caller of `createNextSession`

**Interfaces:**
- Consumes: `planSession`, `BOARD_SIZE`, `SessionPlan` (Task 3); `tileEligible`, `tilesFor`, `LANGUAGES[...].alphabet` (Task 3); `shuffleSession` (Task 2); `countListSessions`, `withBoards` (Task 5).
- Produces:
  - `taskFor(type): Task | null`;
  - `tasksFor(plan: SessionPlan): (Task | null)[]`;
  - `keyOf(position: number): string`;
  - `distractorItems(context: GenerationContext[], tasks: readonly (Task | null)[]): DistractorItem[]`;
  - `boardMeanings(meanings: readonly string[], wrong: readonly string[]): string[] | null`;
  - `Extras = { tiles: string[] | null; board: { meanings: string[]; own: number } | null }`;
  - `NOTHING_GENERATED: Generated`, `NO_EXTRAS: Extras`;
  - `generatedContent(row, type, generated, extras): { prompt; options; alternatives; tiles }`;
  - `createNextSession(enrollmentId: string, options: { listening: boolean })`.

- [ ] **Step 1: Write the failing tests.**

In `apps/server/src/domain/distractors.test.ts`:
- change every existing `distractorItems(context, types)` call to `distractorItems(context, types.map(taskFor))`;
- change every `generatedContent(row, type, generated)` call to `generatedContent(row, type, generated, NO_EXTRAS)`, and add `tiles: null` to the expected objects;
- append:

```ts
describe('phase 24 generation (spec D2, D10)', () => {
  it('asks nothing for a dictation, a tiles card or a board word but the first', () => {
    expect(taskFor('dictation')).toBeNull();
    expect(taskFor('letter_tiles')).toBeNull();
    expect(taskFor('matching')).toBeNull();
    expect(taskFor('listen_choice')).toBe('meaning');
    const plan = planSession(
      Array.from({ length: 10 }, (_, i) => ({ form: `w${i}`, translation: `מ${i}`, tiles: true })),
      { listening: true, ordinal: 0 },
    );
    expect(tasksFor(plan)).toEqual(['meaning', 'word', 'typed', 'meaning', null, null, null, 'meaning', null, null]);
  });

  it('keys an item by its position, whichever positions ask nothing', () => {
    const rows = ['a', 'b', 'c'].map((form) => ({ ...ROW, form, lemma: form }));
    expect(distractorItems(rows, ['meaning', null, 'typed']).map((item) => item.key)).toEqual(['q1', 'q3']);
  });

  it("takes a board's fifth meaning from the first wrong one that is none of its four", () => {
    expect(boardMeanings(['בית', 'דלי', 'עץ', 'סיר'], ['דלי', 'שולחן', 'כיסא'])).toEqual(['בית', 'דלי', 'עץ', 'סיר', 'שולחן']);
    expect(boardMeanings(['בית', 'דלי', 'עץ', 'סיר'], ['בית ', 'דלי', 'עץ'])).toBeNull();
  });

  it('stores each new type in its shape (spec D15)', () => {
    expect(generatedContent(ROW, 'listen_choice', { distractors: ['א', 'ב', 'ג'], alternatives: [] }, NO_EXTRAS)).toMatchObject({
      prompt: null, alternatives: null, tiles: null,
    });
    expect(generatedContent(ROW, 'dictation', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: ROW.translation, options: null, alternatives: null, tiles: null,
    });
    expect(generatedContent(ROW, 'letter_tiles', NOTHING_GENERATED, { tiles: ['a', 'b', 'c', 'd', 'e'], board: null })).toEqual({
      prompt: ROW.translation, options: null, alternatives: null, tiles: ['a', 'b', 'c', 'd', 'e'],
    });
    const board = generatedContent(ROW, 'matching', NOTHING_GENERATED, {
      tiles: null,
      board: { meanings: ['א', 'ב', 'ג', 'ד', 'ה'], own: 2 },
    });
    expect(board.options!.map((o) => o.is_correct)).toEqual([false, false, true, false, false]);
    expect(board.prompt).toBeNull();
  });
});
```

`ROW` is the `GenerationContext` fixture the file already has. If it is named differently, use that name. Import `planSession` from `./plan`, and the new names from `./distractors`.

In `apps/server/src/domain/session.test.ts`, delete the `describe('typeFor', …)` block and `typeFor` from the import.

In `apps/server/src/services/sessions.prepare.test.ts`:
- give `PAYLOAD` the fields `listening: false, ordinal: 0`;
- replace the fake `insertGeneratedQuestions` body with the builder below, which shapes every type the way `questionFrom` and `withBoards` do:

```ts
    insertGeneratedQuestions: async (input) => {
      calls.generated.push(input);
      // Shaped as repo/questions' questionFrom and withBoards shape them; a
      // services test may import a repository only as a type (ADR 0001 R2).
      const onBoard = input.questions.flatMap((q, i) => (q.type === 'matching' ? [i] : []));
      const correct = (q: (typeof input.questions)[number]) => q.options!.findIndex((o) => o.is_correct);
      const board = {
        question_ids: onBoard.map((i) => `g${i}`),
        words: onBoard.map((i) => input.questions[i].form),
        correct_options: onBoard.map((i) => correct(input.questions[i])),
      };
      return input.questions.map((q, i): Question => {
        const base = { id: `g${i}`, vocab_term_id: q.lexemeId };
        const choice = () => ({ options: q.options!.map((o) => o.text), correct_option: correct(q) });
        switch (q.type) {
          case 'typed_translation':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.form, lemma: q.lemma, alternatives: q.alternatives! };
          case 'dictation':
            return { ...base, type: q.type, question: q.form, meaning: q.prompt! };
          case 'letter_tiles':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.form, tiles: q.tiles! };
          case 'reverse_choice':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, ...choice() };
          case 'matching':
            return { ...base, type: q.type, question: q.form, ...choice(), board };
          case 'multiple_choice':
          case 'listen_choice':
            return { ...base, type: q.type, question: q.form, ...choice() };
        }
      });
    },
```

Then append:

```ts
const FORMS = ['ромашка', 'черепаха', 'подушка', 'зонтик', 'ведро', 'скрипка', 'лопата', 'кастрюля', 'фонарь', 'ящерица'];
const MEANINGS = ['מרגנית', 'צב', 'כרית', 'מטרייה', 'דלי', 'כינור', 'את חפירה', 'סיר', 'פנס', 'לטאה'];
const TEN: GenerationContext[] = FORMS.map((form, i) => ({
  senseId: `s${i}`, variantId: `v${i}`, lexemeId: `l${i}`, form, lemma: form, partOfSpeech: 'noun', translation: MEANINGS[i],
}));
const TEN_PAYLOAD = {
  session_id: SESSION,
  picks: TEN.map((row) => ({ sense_id: row.senseId, variant_id: row.variantId })),
  listening: true,
  ordinal: 0,
};
// q4 is the board's first word. Its first wrong meaning, דלי, is a board word's
// own meaning, so the fifth meaning must be the next one.
const TEN_REPLY = JSON.stringify({
  items: [
    { key: 'q1', distractors: ['דלת', 'קיר', 'תקרה'] },
    { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
    { key: 'q3', distractors: [], alternatives: [] },
    { key: 'q4', distractors: ['דלי', 'שולחן', 'כיסא'] },
    { key: 'q8', distractors: ['ענן', 'גשם', 'רוח'] },
  ],
});

describe('prepareSession, phase 24 (spec D3, D10, D11)', () => {
  it('plans ten words as a run, the board and a run, and writes each its content', async () => {
    const { service, calls, llm } = world({ context: TEN, reply: TEN_REPLY });
    await service.prepareSession(TEN_PAYLOAD);

    const asked = JSON.parse(llm.calls[0].user).items.map((item: { key: string; task: string }) => `${item.key}:${item.task}`);
    expect(asked).toEqual(['q1:meaning', 'q2:word', 'q3:typed', 'q4:meaning', 'q8:meaning']);

    const [input] = calls.generated as {
      questions: { type: string; prompt: string | null; options: { text: string; is_correct: boolean }[] | null; tiles: string[] | null }[];
    }[];
    expect(input.questions.map((q) => q.type)).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'matching', 'matching', 'matching', 'matching',
      'listen_choice', 'letter_tiles', 'dictation',
    ]);
    expect(input.questions[3].options!.map((o) => o.text)).toEqual(['מטרייה', 'דלי', 'כינור', 'את חפירה', 'שולחן']);
    expect(input.questions[4].options!.find((o) => o.is_correct)!.text).toBe('דלי');
    expect(input.questions[8].tiles).toHaveLength([...'фонарь'].length + 2);
    expect(input.questions[9]).toMatchObject({ prompt: 'לטאה', options: null, tiles: null });

    const shown = calls.sessionQuestions[0] as { options?: string[] }[];
    for (const i of [4, 5, 6]) expect(shown[i].options).toEqual(shown[3].options);
  });

  it("refuses a board whose wrong meanings are all its words' own, so pg-boss retries", async () => {
    // Each is valid for q4 (none is зонтик's own מטרייה), and each is another
    // board word's meaning: only the board check can refuse them.
    const reply = TEN_REPLY.replace('["דלי","שולחן","כיסא"]', '["דלי","כינור","את חפירה"]');
    const { service } = world({ context: TEN, reply });
    await expect(service.prepareSession(TEN_PAYLOAD)).rejects.toThrow(/board/);
  });

  it('gives a listening-off session no listening card', async () => {
    // Listening off, the tenth card is typed (dictation falls back), so q10 is asked too.
    const reply = JSON.stringify({
      items: [...JSON.parse(TEN_REPLY).items, { key: 'q10', distractors: [], alternatives: [] }],
    });
    const { service, calls } = world({ context: TEN, reply });
    await service.prepareSession({ ...TEN_PAYLOAD, listening: false });
    const [input] = calls.generated as { questions: { type: string }[] }[];
    expect(input.questions.map((q) => q.type)).not.toContain('listen_choice');
    expect(input.questions.map((q) => q.type)).not.toContain('dictation');
  });
});
```

Update the existing phase 23 test `gives each position its type, in pick order…`. It prepares three picks with listening off at ordinal 0, so its expectations hold unchanged. Only the `PAYLOAD` spread needs the new fields, which it inherits.

In `apps/server/src/services/sessions.test.ts`, find the `createNextSession` test that creates a list session and reads the fake job repo's `enqueued`. Add `countListSessions: async () => 2` to its session stub, call `createNextSession(E, { listening: true })`, and assert:

```ts
    expect(jobs.enqueued[0].data).toMatchObject({ listening: true, ordinal: 2 });
```

Pass `{ listening: false }` to every other `createNextSession` call in that file.

- [ ] **Step 2: Run the tests to see them fail.**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/distractors.test.ts src/domain/session.test.ts src/services/sessions.prepare.test.ts src/services/sessions.test.ts)`
Expected: FAIL. `tasksFor`, `boardMeanings` and `NO_EXTRAS` are missing; the service still cycles three types.

- [ ] **Step 3: Implement `domain/distractors.ts`.**
- Import `type SessionPlan` from `./plan`.
- Replace `taskFor`, `distractorItems` and `generatedContent`, and add the new exports:

```ts
/** What the model is asked to do for one item, or null when a type needs
 *  nothing generated: a dictation, a tiles card, and a board word (its board
 *  asks through its first word, tasksFor). */
export function taskFor(type: QuestionType): Task | null {
  switch (type) {
    case 'multiple_choice':
    case 'listen_choice':
      return 'meaning';
    case 'reverse_choice':
      return 'word';
    case 'typed_translation':
      return 'typed';
    case 'dictation':
    case 'letter_tiles':
    case 'matching':
      return null;
  }
}

/** Phase 24. Each position's task. A board's first word asks for wrong
 *  meanings, which its fifth meaning is taken from (spec D10). */
export function tasksFor(plan: SessionPlan): (Task | null)[] {
  return plan.types.map((type, position) => (position === plan.board?.start ? 'meaning' : taskFor(type)));
}

/** A position's key: `q1` is the first card, whichever positions ask nothing. */
export const keyOf = (position: number): string => `q${position + 1}`;

/** `context` in session order, `tasks[i]` its position's task. */
export function distractorItems(context: GenerationContext[], tasks: readonly (Task | null)[]): DistractorItem[] {
  return context.flatMap((row, index) => {
    const task = tasks[index];
    return task
      ? [{ key: keyOf(index), task, form: row.form, lemma: row.lemma, partOfSpeech: row.partOfSpeech, translation: row.translation }]
      : [];
  });
}

/** Phase 24 (spec D10). A board's five meanings as stored: its four words'
 *  meanings, then the first of the first word's wrong meanings that is none of
 *  them, so the last pair is never forced. Null when all three are. */
export function boardMeanings(meanings: readonly string[], wrong: readonly string[]): string[] | null {
  const taken = new Set(meanings.map(comparable));
  const extra = wrong.map((text) => text.trim()).find((text) => !taken.has(comparable(text)));
  return extra === undefined ? null : [...meanings, extra];
}

/** What a position needs beyond the model's answer: a tiles card's tiles, and
 *  a board word's board (its meanings, and which of them is its own). */
export type Extras = { tiles: string[] | null; board: { meanings: string[]; own: number } | null };
export const NO_EXTRAS: Extras = { tiles: null, board: null };
export const NOTHING_GENERATED: Generated = { distractors: [], alternatives: [] };

export type QuestionContent = {
  prompt: string | null;
  options: QuestionOption[] | null;
  alternatives: string[] | null;
  tiles: string[] | null;
};

/**
 * Phase 23 and 24. One generated question's stored content (phase 23 D13,
 * phase 24 D15). Types whose options are Hebrew keep the meaning as their
 * correct option; every other type stores it as the prompt. The prompt is
 * stored, not joined: a question records what was asked.
 */
export function generatedContent(row: GenerationContext, type: QuestionType, generated: Generated, extras: Extras): QuestionContent {
  const none: QuestionContent = { prompt: null, options: null, alternatives: null, tiles: null };
  switch (type) {
    case 'multiple_choice':
    case 'listen_choice':
      return { ...none, options: optionsFor(row.translation, generated.distractors) };
    case 'reverse_choice':
      return { ...none, prompt: row.translation, options: optionsFor(row.form, generated.distractors) };
    case 'typed_translation':
      return { ...none, prompt: row.translation, alternatives: generated.alternatives };
    case 'dictation':
      return { ...none, prompt: row.translation };
    case 'letter_tiles':
      if (!extras.tiles) throw new Error(`the tiles card for ${row.form} has no tiles`);
      return { ...none, prompt: row.translation, tiles: extras.tiles };
    case 'matching': {
      const board = extras.board;
      if (!board) throw new Error(`the board word ${row.form} has no board`);
      return {
        ...none,
        options: board.meanings.map((text, position) => ({ position, text, is_correct: position === board.own })),
      };
    }
  }
}
```

- [ ] **Step 4: Implement the service and the route.**

In `apps/server/src/domain/session.ts`, delete `TYPE_CYCLE`, `typeFor`, their comment, and the `QuestionType` import if it is now unused.

In `apps/server/src/services/sessions.ts`:
- Update the imports:
  - from core domain: `LIVE_DIMENSIONS`, `shuffleSession`, `type AnswerInput`, replacing `shuffleOptions`;
  - from `../domain/distractors`: `NOTHING_GENERATED`, `boardMeanings`, `buildDistractorPrompt`, `distractorItems`, `generatedContent`, `keyOf`, `parseLlmDistractors`, `tasksFor`, `validateDistractors`;
  - `BOARD_SIZE`, `planSession` from `../domain/plan`;
  - `tileEligible`, `tilesFor` from `../domain/tiles`;
  - `LANGUAGES`, `type LanguageCode` from `../domain/languages`;
  - remove `typeFor`.
- Change `createNextSession` to take `options: { listening: boolean }`, and in its list branch:

```ts
        const saved = await vocabulary.listSavedSenses(enrollmentId);
        if (saved.length === 0) throw new NoSavedWords(enrollmentId);
        const picks = pickSenses(saved, SESSION_LENGTH, rng);
        // Phase 24 (spec D3): the rotation's step is how many list sessions came
        // before this one. Read before the insert, so it does not count itself.
        const ordinal = await session.countListSessions(enrollmentId);
        const sessionId = await session.insertPreparingSession(enrolled.user_id, enrollmentId);
        await jobs.enqueue(PREPARE_SESSION, {
          session_id: sessionId,
          picks: picks.map((pick) => ({ sense_id: pick.senseId, variant_id: pick.variantId })),
          listening: options.listening,
          ordinal,
        });
```

- In `prepareSession`, replace everything from `// Phase 23 (spec D2).` to the end of the write transaction with:

```ts
      // Phase 24 (spec D3, D4). The plan decides each position's type and the
      // order of the picks, before the model is asked anything.
      const target = read.enrolled.target_language as LanguageCode;
      const plan = planSession(
        read.context.map((row) => ({ form: row.form, translation: row.translation, tiles: tileEligible(row.form) })),
        { listening: payload.listening, ordinal: payload.ordinal },
      );
      const ordered = plan.order.map((index) => read.context[index]);
      const items = distractorItems(ordered, tasksFor(plan));

      const started = now();
      const raw = await llm(buildDistractorPrompt({ items, from: target, to: read.enrolled.source_language }));
      const modelMs = now() - started;
      // An empty string is the provider's "no content" (a safety block). Here,
      // unlike a lookup, there is nothing useful to serve without it.
      const answer = raw === '' ? null : parseLlmDistractors(raw);
      if (!answer) throw new InvalidDistractors(sessionId, 'the model answer was unreadable');
      const verdict = validateDistractors(items, answer, read.enrolled.source_language);
      if (!verdict.ok) throw new InvalidDistractors(sessionId, verdict.reason);

      // Spec D10: the board's fifth meaning is its first word's first wrong
      // meaning that is none of the four.
      const board = plan.board;
      const meanings = board
        ? boardMeanings(
            ordered.slice(board.start, board.start + BOARD_SIZE).map((row) => row.translation),
            verdict.byKey.get(keyOf(board.start))!.distractors,
          )
        : null;
      if (board && !meanings) {
        throw new InvalidDistractors(sessionId, "every wrong meaning of the board is one of its words' own");
      }

      const written = await transaction(async ({ session, question }) => {
        // Conditional: a skip that landed during the model call wins, and this
        // transaction then writes nothing at all.
        if (!(await session.transition(sessionId, ['preparing'], 'ready'))) return false;
        const generated = await question.insertGeneratedQuestions({
          userId: read.state.userId,
          enrollmentId: read.state.enrollmentId,
          targetLanguage: target,
          userLanguageCode: read.enrolled.source_language,
          questions: ordered.map((row, index) => {
            const type = plan.types[index];
            return {
              senseId: row.senseId,
              variantId: row.variantId,
              form: row.form,
              lemma: row.lemma,
              partOfSpeech: row.partOfSpeech,
              lexemeId: row.lexemeId,
              type,
              ...generatedContent(row, type, verdict.byKey.get(keyOf(index)) ?? NOTHING_GENERATED, {
                tiles: type === 'letter_tiles' ? tilesFor(row.form, LANGUAGES[target].alphabet, rng) : null,
                board: type === 'matching' && board && meanings ? { meanings, own: index - board.start } : null,
              }),
            };
          }),
        });
        // Each choice shuffled on its own, a board's words once together; the
        // question order is the plan's and is not shuffled.
        await session.insertSessionQuestions(sessionId, shuffleSession(generated, rng));
        return true;
      });
```

Keep the final `logger.info` from Task 1.

- In `apps/server/src/routes/sessions.ts`:
  - change the handler to `const { enrollment_id, listening } = c.req.valid('json');` and call `sessions.createNextSession(enrollment_id, { listening: listening ?? false })`;
  - rewrite the create route's `description` sentence about types to: "Its question types come from a plan: runs of three cards that climb from recognition to recall, a matching board in sessions of seven words or more, and listening cards only when the request says `listening: true`."
  - in `packages/core/src/api/schemas.ts`, give `CreateSessionRequestSchema` the field:

```ts
  // Phase 24 (spec D5). Whether the device has a voice for the target, so the
  // session may hold listening cards. Absent means no.
  listening: z.boolean().optional(),
```

- [ ] **Step 5: Update the test support and every `createNextSession` caller.**

`apps/server/tests/support/questions.ts`:
- replace the `typeFor` import with `import type { QuestionType } from '@lang-tutor/core/domain';`, plus `LANGUAGES` from `../../src/domain/languages`, `tilesFor` from `../../src/domain/tiles`, and `testRng` from `./testRng`;
- give `insertListSession`'s input an optional `types?: QuestionType[]`;
- build the content with extras:

```ts
/** Phase 23's cycle: the default types of a test's list session. */
const CYCLE: QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];
```

```ts
    const types = input.types ?? input.asked.map((_, index) => CYCLE[index % CYCLE.length]);
    // Phase 24. A board's words share five meanings: theirs, and one wrong.
    const boardStart = types.indexOf('matching');
    const meanings = [...input.asked.filter((_, i) => types[i] === 'matching').map((s) => s.translation), 'שגוי0'];
```

and in the per-question mapping:

```ts
        ...generatedContent(
          { ...sense, partOfSpeech: 'noun' },
          types[index],
          types[index] === 'multiple_choice' || types[index] === 'listen_choice'
            ? { distractors: ['שגוי1', 'שגוי2', 'שגוי3'], alternatives: [] }
            : { distractors: ['wrong1', 'wrong2', 'wrong3'], alternatives: input.alternatives ?? [] },
          {
            tiles: types[index] === 'letter_tiles' ? tilesFor(sense.form, LANGUAGES.en.alphabet, testRng(1)) : null,
            board: types[index] === 'matching' ? { meanings, own: index - boardStart } : null,
          },
        ),
```

Update its doc comment: "Options keep their canonical order: the right index is 0, except for a board word, whose right index is its place on the board."

`apps/server/tests/support/mockServer.ts`:
- replace the `typeFor` import with `import type { Task } from '../../src/domain/distractors';`;
- give `expectDistractors` an explicit task list:

```ts
/** Phase 23's cycle of tasks: what a test's session of up to six words asks at
 *  ordinal 0 with listening off, at every position that asks anything. */
const CYCLE_TASKS: Task[] = Array.from({ length: 10 }, (_, i) => (['meaning', 'word', 'typed'] as const)[i % 3]);

export async function expectDistractors(ns: string, opts: { delayMs?: number; tasks?: Task[] } = {}): Promise<void> {
  const items = (opts.tasks ?? CYCLE_TASKS).map((task, i) => {
    const key = `q${i + 1}`;
    switch (task) {
      case 'meaning':
        return { key, distractors: STUB_WRONG_HEBREW };
      case 'word':
        return { key, distractors: STUB_WRONG_ENGLISH };
      case 'typed':
        return { key, distractors: [], alternatives: [STUB_ALTERNATIVE] };
    }
  });
  // …the expectation itself is unchanged
```

Then run `grep -rn 'createNextSession(' apps/server nightly-qa --include='*.ts'` and pass `{ listening: false }` at every call site the steps above have not already changed.

- [ ] **Step 6: Run the tests to see them pass.**

Run: `npm test --workspace apps/server && npm run typecheck --workspace apps/server && npm run lint:arch`
Expected: PASS, no type errors, no violations. The server typecheck is green again from here.

- [ ] **Step 7: Commit.**

```bash
git add apps/server packages/core/src/api/schemas.ts
git commit -m "feat(server): the prepare-session job plans listening, board and tiles cards"
```

---

### Task 7: Mobile — pure modules for the board, tiles, feedback, results, strings

**Files:**
- Create: `apps/mobile/src/board.ts`, `apps/mobile/src/board.test.ts`
- Create: `apps/mobile/src/tiles.ts`, `apps/mobile/src/tiles.test.ts`
- Modify: `apps/mobile/src/feedback.ts`, test `apps/mobile/src/feedback.test.ts`
- Modify: `apps/mobile/src/progress.ts`, test `apps/mobile/src/progress.test.ts`
- Modify: `apps/mobile/src/strings.ts`

**Interfaces:**
- Produces:
  - `BoardState`, `startBoard(question)`, `tapWord(state, question, word)`, `tapMeaning(state, question, meaning)`, `meaningTaken(state, question, meaning)` and `firstAttempts(state): number[] | null`;
  - `placeTile(placed, tile)`, `removeTile(placed, slot)` and `builtWord(tiles, placed)`;
  - `CardAnswer = AnswerInput | { board: number[] }`, and `feedbackFor(question, answer: CardAnswer)`;
  - `missedPair` covers seven types;
  - the strings `questionInstructionListen`, `questionInstructionDictation(language)`, `questionInstructionMatching`, `questionInstructionTiles(language)`, `listenAgain`, `listenNoVoice` and `boardResult(right, total)`.

- [ ] **Step 1: Write the failing tests.**

`apps/mobile/src/board.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { MatchingQuestion } from '@lang-tutor/core/api';

import { firstAttempts, startBoard, tapMeaning, tapWord } from './board';

const question = (current = 'm1'): MatchingQuestion => ({
  id: current,
  type: 'matching',
  vocab_term_id: 'v',
  question: 'casa',
  options: ['בית', 'חתול', 'כלב', 'עץ', 'דלת'],
  correct_option: 0,
  board: { question_ids: ['m1', 'm2', 'm3', 'm4'], words: ['casa', 'gatto', 'cane', 'albero'], correct_options: [0, 1, 2, 3] },
});

const play = (q: MatchingQuestion, taps: (['w' | 'm', number])[]) =>
  taps.reduce((state, [kind, index]) => (kind === 'w' ? tapWord(state, q, index) : tapMeaning(state, q, index)), startBoard(q));

describe('the matching board (spec D10)', () => {
  it('locks a right pair, whichever is tapped first', () => {
    const q = question();
    expect(play(q, [['w', 0], ['m', 0]]).matched).toEqual([true, false, false, false]);
    expect(play(q, [['m', 1], ['w', 1]]).matched).toEqual([false, true, false, false]);
  });

  it('charges a wrong pair to the word, releases both, and keeps only the first try', () => {
    const q = question();
    const state = play(q, [['w', 0], ['m', 4], ['w', 0], ['m', 2], ['w', 0], ['m', 0]]);
    expect(state.first[0]).toBe(4);
    expect(state.first[2]).toBeNull();
    expect(state.matched[0]).toBe(true);
  });

  it('shows the last miss until the next tap', () => {
    const q = question();
    const missed = play(q, [['w', 0], ['m', 4]]);
    expect(missed.miss).toEqual({ word: 0, meaning: 4 });
    expect(tapWord(missed, q, 1).miss).toBeNull();
  });

  // Review Focus 5.
  it('ignores a tap on a matched word or a taken meaning, and a second tap on a word deselects', () => {
    const q = question();
    const matched = play(q, [['w', 0], ['m', 0]]);
    expect(tapWord(matched, q, 0)).toBe(matched);
    expect(tapMeaning(matched, q, 0)).toBe(matched);
    const toggled = play(q, [['w', 1], ['w', 1]]);
    expect(toggled.word).toBeNull();
    expect(toggled.first).toEqual([null, null, null, null]);
  });

  it('gives every first try once the last word is matched, and not before', () => {
    const q = question();
    const three = play(q, [['w', 0], ['m', 1], ['w', 0], ['m', 0], ['w', 1], ['m', 1], ['w', 2], ['m', 2]]);
    expect(firstAttempts(three)).toBeNull();
    expect(firstAttempts(tapMeaning(tapWord(three, q, 3), q, 3))).toEqual([1, 1, 2, 3]);
  });

  // Review Focus 1.
  it('starts a resumed board with the earlier words matched, and submits only the rest', () => {
    const q = question('m3');
    const start = startBoard(q);
    expect(start.matched).toEqual([true, true, false, false]);
    const done = play(q, [['w', 2], ['m', 2], ['w', 3], ['m', 3]]);
    expect(firstAttempts(done)).toEqual([2, 3]);
  });
});
```

`apps/mobile/src/tiles.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { builtWord, placeTile, removeTile } from './tiles';

describe('letter tiles (spec D11)', () => {
  const tiles = ['s', 'a', 'c', 'x', 'a', 'q'];

  it('builds the word in the order the tiles were placed', () => {
    const placed = [2, 1, 0, 4].reduce(placeTile, [] as number[]);
    expect(builtWord(tiles, placed)).toBe('casa');
  });

  it('places a tile once, and returns a placed one to the pool', () => {
    expect(placeTile([2], 2)).toEqual([2]);
    expect(builtWord(tiles, removeTile([2, 1, 0], 1))).toBe('cs');
  });
});
```

`apps/mobile/src/feedback.test.ts`: append:

```ts
describe('feedbackFor, phase 24', () => {
  const board: Question = {
    id: 'm1', type: 'matching', vocab_term_id: 'l', question: 'casa',
    options: ['בית', 'חתול', 'כלב', 'עץ', 'דלת'], correct_option: 0,
    board: { question_ids: ['m1', 'm2', 'm3', 'm4'], words: ['casa', 'gatto', 'cane', 'albero'], correct_options: [0, 1, 2, 3] },
  };

  it('counts a board by first tries, correct only at all of them', () => {
    expect(feedbackFor(board, { board: [4, 1, 2, 3] })).toEqual({
      tone: 'wrong', title: 'בניסיון הראשון: 3 מתוך 4', line: null, verdict: null,
    });
    expect(feedbackFor(board, { board: [0, 1, 2, 3] }).tone).toBe('correct');
  });

  it('names the heard form after a wrong dictation, and the meaning after a wrong listening card', () => {
    const dictation: Question = { id: 'd', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' };
    expect(feedbackFor(dictation, { text: 'parlare' })).toMatchObject({ tone: 'wrong', line: 'parlo' });
    const listen: Question = { id: 'l', type: 'listen_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 };
    expect(feedbackFor(listen, { option_index: 1 })).toMatchObject({ tone: 'wrong', line: 'בית' });
  });
});
```

`apps/mobile/src/progress.test.ts`: append beside the existing `missedPair` tests:

```ts
describe('missedPair, phase 24', () => {
  it('reads word → meaning for every new type', () => {
    expect(missedPair({ question: { id: 'l', type: 'listen_choice', vocab_term_id: 'v', question: 'casa', options: ['בית'], correct_option: 0 }, correct_answer: 'בית' }))
      .toEqual({ word: 'casa', meaning: 'בית' });
    expect(missedPair({ question: { id: 'd', type: 'dictation', vocab_term_id: 'v', question: 'parlo', meaning: 'מדבר' }, correct_answer: 'parlo' }))
      .toEqual({ word: 'parlo', meaning: 'מדבר' });
    expect(missedPair({ question: { id: 't', type: 'letter_tiles', vocab_term_id: 'v', question: 'בית', part_of_speech: 'noun', answer: 'casa', tiles: [] }, correct_answer: 'casa' }))
      .toEqual({ word: 'casa', meaning: 'בית' });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.**

Run: `npm test --workspace apps/mobile`
Expected: FAIL. `./board` and `./tiles` do not exist, there is no board answer in `feedbackFor`, and `missedPair` mishandles a dictation.

- [ ] **Step 3: Implement.**

`apps/mobile/src/board.ts`:

```ts
import type { MatchingQuestion } from '@lang-tutor/core/api';

/**
 * Phase 24 (spec D10). A matching board's play as pure state: which words are
 * matched, each word's first-tried meaning, and what is selected. The view
 * renders it and the session submits `firstAttempts` once every word is
 * matched. Words before the current question were answered before a resume:
 * they start matched and are not submitted again.
 */
export type BoardState = {
  /** The board index of the first word this screen plays. */
  start: number;
  matched: boolean[];
  /** The meaning each word was first paired with, or null before any try. */
  first: (number | null)[];
  word: number | null;
  meaning: number | null;
  /** The last wrong pair, shown until the next tap. */
  miss: { word: number; meaning: number } | null;
};

export function startBoard(question: MatchingQuestion): BoardState {
  const start = question.board.question_ids.indexOf(question.id);
  return {
    start,
    matched: question.board.words.map((_, index) => index < start),
    first: question.board.words.map(() => null),
    word: null,
    meaning: null,
    miss: null,
  };
}

/** Whether a meaning already belongs to a matched word. */
export function meaningTaken(state: BoardState, question: MatchingQuestion, meaning: number): boolean {
  return question.board.correct_options.some((correct, word) => state.matched[word] && correct === meaning);
}

// A wrong pair is charged to the word: it shows the learner did not know that
// word's meaning, not that they did not know the other word's.
function pair(state: BoardState, question: MatchingQuestion, word: number, meaning: number): BoardState {
  const right = question.board.correct_options[word] === meaning;
  return {
    ...state,
    first: state.first.map((tried, index) => (index === word && tried === null ? meaning : tried)),
    matched: right ? state.matched.map((done, index) => done || index === word) : state.matched,
    word: null,
    meaning: null,
    miss: right ? null : { word, meaning },
  };
}

export function tapWord(state: BoardState, question: MatchingQuestion, word: number): BoardState {
  if (state.matched[word]) return state;
  if (state.meaning !== null) return pair(state, question, word, state.meaning);
  return { ...state, word: state.word === word ? null : word, miss: null };
}

export function tapMeaning(state: BoardState, question: MatchingQuestion, meaning: number): BoardState {
  if (meaningTaken(state, question, meaning)) return state;
  if (state.word !== null) return pair(state, question, state.word, meaning);
  return { ...state, meaning: state.meaning === meaning ? null : meaning, miss: null };
}

/** The first-tried meaning of every word this screen played, in board order;
 *  null until the last word is matched. */
export function firstAttempts(state: BoardState): number[] | null {
  if (!state.matched.every(Boolean)) return null;
  return state.first.slice(state.start).map((meaning) => meaning!);
}
```

`apps/mobile/src/tiles.ts`:

```ts
/** Phase 24 (spec D11). Letter tiles as pure state: `placed` holds tile indices
 *  in the order they were tapped. */
export function placeTile(placed: readonly number[], tile: number): number[] {
  return placed.includes(tile) ? [...placed] : [...placed, tile];
}

export function removeTile(placed: readonly number[], slot: number): number[] {
  return placed.filter((_, index) => index !== slot);
}

export function builtWord(tiles: readonly string[], placed: readonly number[]): string {
  return placed.map((tile) => tiles[tile]).join('');
}
```

`apps/mobile/src/feedback.ts`: add the type and the board branch at the top of `feedbackFor`, whose parameter becomes `answer: CardAnswer`:

```ts
/** Phase 24. What a card was answered with: an option, a text, or a board's
 *  first tries (spec D10). */
export type CardAnswer = AnswerInput | { board: number[] };
```

```ts
  if ('board' in answer) {
    if (question.type !== 'matching') throw new Error(`a board answer for a ${question.type} card`);
    const start = question.board.question_ids.indexOf(question.id);
    const right = answer.board.filter((meaning, i) => meaning === question.board.correct_options[start + i]).length;
    return {
      tone: right === answer.board.length ? 'correct' : 'wrong',
      title: strings.boardResult(right, answer.board.length),
      line: null,
      verdict: null,
    };
  }
```

`apps/mobile/src/progress.ts`, replacing `missedPair`:

```ts
export function missedPair({ question, correct_answer }: MissedQuestion): { word: string; meaning: string } {
  switch (question.type) {
    case 'multiple_choice':
    case 'listen_choice':
    case 'matching':
      return { word: question.question, meaning: correct_answer };
    case 'dictation':
      return { word: question.question, meaning: question.meaning };
    case 'reverse_choice':
    case 'typed_translation':
    case 'letter_tiles':
      return { word: correct_answer, meaning: question.question };
  }
}
```

`apps/mobile/src/strings.ts`, after `typedShowAnswer`:

```ts
  // Phase 24 (spec D14).
  questionInstructionListen: 'הקשיבו ובחרו את הפירוש',
  questionInstructionDictation: (language: string) => `הקשיבו וכתבו ב${languageName(language)}`,
  questionInstructionMatching: 'התאימו כל מילה לפירוש שלה',
  questionInstructionTiles: (language: string) => `הרכיבו את המילה ב${languageName(language)}`,
  listenAgain: 'השמעה חוזרת',
  listenNoVoice: 'אין במכשיר קול לשפה הזו, אז הנה המילה בכתב',
  boardResult: (right: number, total: number) => `בניסיון הראשון: ${right} מתוך ${total}`,
```

- [ ] **Step 4: Run the tests to see them pass.**

Run: `npm test --workspace apps/mobile`
Expected: PASS, including `strings.test.ts`. If it checks every string for a property such as "no Latin letters", the new ones satisfy it.

- [ ] **Step 5: Commit.**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): board and tiles state, board feedback, missed pairs for every type"
```

---

### Task 8: Mobile — the cards, the session and the create flag

**Files:**
- Create: `apps/mobile/src/components/ListenPrompt.tsx`, `MatchingBoardView.tsx`, `LetterTilesView.tsx`
- Modify: `apps/mobile/src/components/MultipleChoiceView.tsx`, `TypedAnswerView.tsx`, `OptionButton.tsx`
- Modify: `apps/mobile/src/hooks/useSession.tsx`, `apps/mobile/src/hooks/useNextSession.tsx`, `apps/mobile/src/app/session.tsx`

**Interfaces:**
- Consumes: Task 7's modules; `useSpeech()` with `canSpeak`, `isPlaying` and `toggle`.
- Produces:
  - `SessionValue.answer: CardAnswer | null`;
  - `SessionValue.submitBoard(firstAttempts: number[]): void`;
  - `answerStyles`, exported from `TypedAnswerView.tsx`;
  - `OptionVisualState` gains `'selected'`.

- [ ] **Step 1: `OptionButton.tsx`.** Change the state type to `'idle' | 'correct' | 'wrong' | 'dimmed' | 'selected'`, and add to `stateStyles`:

```ts
  // Phase 24. A board's word or meaning waiting for its pair.
  selected: { borderColor: colors.primary, borderWidth: 2 },
```

- [ ] **Step 2: `ListenPrompt.tsx`.**

```tsx
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SpeakButton } from '@/components/SpeakButton';
import { useSpeech } from '@/hooks/useSpeech';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  /** The card's id: a new card plays again, a re-render does not. */
  questionId: string;
  /** What is spoken, and shown once the card is answered. */
  text: string;
  language: string;
  answered: boolean;
};

/**
 * Phase 24 (spec D6). A listening card's prompt. The word is spoken once on
 * arrival and on every tap, and shown only after the answer. A device with no
 * voice for the language shows it in writing, with a line saying why.
 */
export function ListenPrompt({ questionId, text, language, answered }: Props) {
  const { canSpeak, isPlaying, toggle } = useSpeech();
  const voiced = canSpeak(language);
  // Once per card. React's development double-run of effects would otherwise
  // call toggle twice, and the second call stops the first.
  const played = useRef<string | null>(null);

  useEffect(() => {
    // `voiced` is a dependency so a browser that loads its voices after the
    // first render still plays the card when they arrive.
    if (!voiced || played.current === questionId) return;
    played.current = questionId;
    void toggle(text, language);
  }, [questionId, voiced, text, language, toggle]);

  if (answered || !voiced) {
    return (
      <View style={styles.revealed}>
        <View style={styles.row}>
          <Text style={styles.word} testID="question-prompt">
            {text}
          </Text>
          <SpeakButton text={text} language={language} testID="speak-prompt" />
        </View>
        {voiced ? null : (
          <Text style={styles.note} testID="listen-no-voice">
            {strings.listenNoVoice}
          </Text>
        )}
      </View>
    );
  }

  const playing = isPlaying(text, language);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={strings.listenAgain}
      accessibilityState={{ selected: playing }}
      aria-selected={playing}
      testID="listen-play"
      onPress={() => void toggle(text, language)}
      style={[styles.play, playing && styles.playing]}
    >
      <Text style={styles.glyph}>🔊</Text>
    </Pressable>
  );
}

const PLAY = 96;
const styles = StyleSheet.create({
  revealed: { alignItems: 'center', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  // The word is the target language: left to right inside the mirrored screen.
  word: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, writingDirection: 'ltr' },
  note: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center' },
  play: {
    alignSelf: 'center',
    width: PLAY,
    height: PLAY,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playing: { backgroundColor: colors.primary },
  glyph: { fontSize: fontSizes.xl },
});
```

- [ ] **Step 3: `MultipleChoiceView.tsx` takes a listening card.**
- Type the prop as `question: Exclude<ChoiceQuestion, MatchingQuestion>`, importing `type MatchingQuestion` from `@lang-tutor/core/api`.
- Compute `const listening = question.type === 'listen_choice';`.
- Render the prompt row only when `!listening`. In its place, when listening, render:

```tsx
      {listening ? (
        <ListenPrompt questionId={question.id} text={question.question} language={language} answered={answered} />
      ) : (
        <View style={styles.promptRow}>{/* the existing prompt Text and SpeakButton, unchanged */}</View>
      )}
```

`reversed` stays `question.type === 'reverse_choice'`. A listening card's options are Hebrew, so their direction stays `'rtl'`.

- [ ] **Step 4: `TypedAnswerView.tsx` takes a dictation.**
- Move `instruction`, `prompt`, `partOfSpeech`, `actions`, `check`, `checkDisabled`, `checkLabel` and `showAnswer` out of `styles` into `export const answerStyles = StyleSheet.create({...})`, unchanged, and use `answerStyles.x` for them. The input styles stay in `styles`.
- Type the prop as `question: TypedTranslationQuestion | DictationQuestion`, and add `language: string` to `Props`.
- Make `partOfSpeech` `question.type === 'typed_translation' ? strings.partOfSpeech(question.part_of_speech) : undefined`.
- Replace the prompt `Text` and the part-of-speech `Text` with:

```tsx
      {question.type === 'dictation' ? (
        <>
          <ListenPrompt questionId={question.id} text={question.question} language={language} answered={answered} />
          {answered ? (
            <Text style={answerStyles.partOfSpeech} testID="dictation-meaning">
              {question.meaning}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={answerStyles.prompt} testID="question-prompt">
            {question.question}
          </Text>
          {partOfSpeech ? (
            <Text style={answerStyles.partOfSpeech} testID="question-part-of-speech">
              {partOfSpeech}
            </Text>
          ) : null}
        </>
      )}
```

- [ ] **Step 5: `LetterTilesView.tsx`.**

```tsx
import type { LetterTilesQuestion, TypedVerdict } from '@lang-tutor/core/api';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { answerStyles } from '@/components/TypedAnswerView';
import { strings } from '@/strings';
import { builtWord, placeTile, removeTile } from '@/tiles';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  question: LetterTilesQuestion;
  instruction: string;
  answered: boolean;
  verdict: TypedVerdict | null;
  onSubmit: (text: string) => void;
};

/** Phase 24 (spec D11). The meaning, and the word to build from its letters and
 *  two more. A tap places a tile; a tap on a placed tile returns it. */
export function LetterTilesView({ question, instruction, answered, verdict, onSubmit }: Props) {
  const [placed, setPlaced] = useState<number[]>([]);

  useEffect(() => {
    setPlaced([]);
  }, [question.id]);

  const partOfSpeech = strings.partOfSpeech(question.part_of_speech);
  const built = verdict === null ? null : verdict === 'wrong' ? styles.slotsWrong : styles.slotsCorrect;

  return (
    <View style={styles.container}>
      <Text style={answerStyles.instruction}>{instruction}</Text>
      <Text style={answerStyles.prompt} testID="question-prompt">
        {question.question}
      </Text>
      {partOfSpeech ? (
        <Text style={answerStyles.partOfSpeech} testID="question-part-of-speech">
          {partOfSpeech}
        </Text>
      ) : null}
      <View style={[styles.slots, built]} testID="tiles-built">
        {placed.map((tile, slot) => (
          <Pressable
            key={`slot-${tile}`}
            accessibilityRole="button"
            testID={`tile-slot-${slot}`}
            disabled={answered}
            onPress={() => setPlaced((current) => removeTile(current, slot))}
            style={styles.tile}
          >
            <Text style={styles.letter}>{question.tiles[tile]}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.pool} testID="tiles">
        {question.tiles.map((letter, tile) => {
          const used = placed.includes(tile);
          return (
            <Pressable
              key={`${question.id}-${tile}`}
              accessibilityRole="button"
              testID={`tile-${tile}`}
              disabled={answered || used}
              onPress={() => setPlaced((current) => placeTile(current, tile))}
              style={[styles.tile, used && styles.tileUsed]}
            >
              <Text style={styles.letter}>{letter}</Text>
            </Pressable>
          );
        })}
      </View>
      {answered ? null : (
        <View style={answerStyles.actions}>
          <Pressable
            accessibilityRole="button"
            testID="tiles-submit"
            disabled={placed.length === 0}
            onPress={() => onSubmit(builtWord(question.tiles, placed))}
            style={[answerStyles.check, placed.length === 0 && answerStyles.checkDisabled]}
          >
            <Text style={answerStyles.checkLabel}>{strings.typedCheck}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" testID="tiles-show-answer" hitSlop={8} onPress={() => onSubmit('')}>
            <Text style={answerStyles.showAnswer}>{strings.typedShowAnswer}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const TILE = 44;
const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  // The word being built is the target language: left to right, whatever the screen.
  slots: {
    direction: 'ltr',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: TILE + spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1.5,
    borderColor: colors.border,
  },
  slotsCorrect: { borderColor: colors.correct },
  slotsWrong: { borderColor: colors.wrong },
  pool: { direction: 'ltr', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm },
  tile: {
    minWidth: TILE,
    height: TILE,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileUsed: { opacity: 0.25 },
  letter: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.text },
});
```

- [ ] **Step 6: `MatchingBoardView.tsx`.**

```tsx
import type { MatchingQuestion } from '@lang-tutor/core/api';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { firstAttempts, meaningTaken, startBoard, tapMeaning, tapWord, type BoardState } from '@/board';
import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { answerStyles } from '@/components/TypedAnswerView';
import { spacing } from '@/theme';

type Props = {
  question: MatchingQuestion;
  instruction: string;
  answered: boolean;
  onComplete: (firstAttempts: number[]) => void;
};

/**
 * Phase 24 (spec D10). Four words and five meanings: a tap on each side pairs
 * them, in either order. A right pair locks; a wrong one flashes until the next
 * tap. When the last word is matched, the board reports each word's first try.
 */
export function MatchingBoardView({ question, instruction, answered, onComplete }: Props) {
  const [state, setState] = useState<BoardState>(() => startBoard(question));
  const reported = useRef<string | null>(null);

  useEffect(() => {
    setState(startBoard(question));
    // A new board, not a re-render of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  const done = firstAttempts(state);
  useEffect(() => {
    if (!done || answered || reported.current === question.id) return;
    reported.current = question.id;
    onComplete(done);
  }, [done, answered, question.id, onComplete]);

  const wordState = (word: number): OptionVisualState => {
    if (state.matched[word]) return 'correct';
    if (state.miss?.word === word) return 'wrong';
    return state.word === word ? 'selected' : 'idle';
  };
  const meaningState = (meaning: number): OptionVisualState => {
    if (meaningTaken(state, question, meaning)) return 'correct';
    if (state.miss?.meaning === meaning) return 'wrong';
    return state.meaning === meaning ? 'selected' : 'idle';
  };

  return (
    <View style={styles.container} testID="board">
      <Text style={answerStyles.instruction}>{instruction}</Text>
      {/* A row in the mirrored screen: the Hebrew meanings on the right. */}
      <View style={styles.columns}>
        <View style={styles.column}>
          {question.options.map((meaning, index) => (
            <OptionButton
              key={`meaning-${index}`}
              testID={`board-meaning-${index}`}
              label={meaning}
              direction="rtl"
              state={meaningState(index)}
              disabled={answered || meaningTaken(state, question, index)}
              onPress={() => setState((current) => tapMeaning(current, question, index))}
              onMeasure={() => undefined}
            />
          ))}
        </View>
        <View style={styles.column}>
          {question.board.words.map((word, index) => (
            <OptionButton
              key={`word-${index}`}
              testID={`board-word-${index}`}
              label={word}
              direction="ltr"
              state={wordState(index)}
              disabled={answered || state.matched[index]}
              onPress={() => setState((current) => tapWord(current, question, index))}
              onMeasure={() => undefined}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  columns: { flexDirection: 'row', gap: spacing.md },
  column: { flex: 1, gap: spacing.sm },
});
```

If the repo has no ESLint config, drop the `eslint-disable` line.

- [ ] **Step 7: `useSession.tsx` sends a board's answers.**
- Import `type NextStepResponse` from `@lang-tutor/core/api` and `type CardAnswer` from `@/feedback`.
- In `SessionValue` and `QuizState`, change `answer` to `CardAnswer | null`.
- Add `submitBoard: (firstAttempts: number[]) => void;` to `SessionValue`, with the comment `/** Phase 24. Answers a board: each word's first-tried meaning, in board order. */`.
- Extract the response handling from `answerWith` into a shared callback, and add `submitBoard`:

```ts
  // What a next-step response becomes once it lands: queued for Continue, or
  // applied at once when Continue was already tapped. Shared by a single
  // answer and a board's last one.
  const queueResponse = useCallback((sessionId: string, call: Promise<NextStepResponse>) => {
    void call
      .then((response) => {
        const queued: Queued = response.complete
          ? {
              complete: true,
              score: response.score,
              missedQuestions: response.missed_questions,
              progress: response.progress,
            }
          : { complete: false, question: response.question, position: response.position.position };
        setState((latest) => {
          if (!latest || latest.sessionId !== sessionId) return latest;
          return latest.advanceRequested ? applyQueued(latest, queued) : { ...latest, queued };
        });
      })
      .catch(() => {
        // The session may have been abandoned while this was in flight; only
        // the session it belongs to may alert. stateRef, not the stale closure.
        if (stateRef.current?.sessionId === sessionId) handleApiFailure();
      });
  }, []);
```

`answerWith` keeps its guard and `setState`, then calls `queueResponse(sessionId, api.nextStep(sessionId, { user_id: userId, question_id: question.id, ...input }))`. Add `queueResponse` to its dependencies.

```ts
  // Phase 24 (spec D10). A board's words are separate questions: their answers
  // go in board order, one call after another, and only the last response is
  // queued — the ones between are the board's own next words.
  const submitBoard = useCallback(
    (firstAttempts: number[]) => {
      if (!state || state.answer !== null || state.question?.type !== 'matching') return;
      const { sessionId, userId, question } = state;
      const ids = question.board.question_ids.slice(question.board.question_ids.indexOf(question.id));
      setState((current) => (current ? { ...current, answer: { board: firstAttempts } } : current));
      queueResponse(
        sessionId,
        (async () => {
          let response: NextStepResponse | undefined;
          for (const [index, id] of ids.entries()) {
            response = await api.nextStep(sessionId, { user_id: userId, question_id: id, option_index: firstAttempts[index] });
          }
          if (!response) throw new Error('a board with no words to answer');
          return response;
        })(),
      );
    },
    [state, api, queueResponse],
  );
```

Add `submitBoard` to both branches of the `useMemo` value and to its dependencies. In the no-session branch it is the same callback, which is inert without a state.

- [ ] **Step 8: `useNextSession.tsx` sends the flag.** Import `useSpeech`, take `const { canSpeak } = useSpeech();` in the provider, and create sessions with:

```ts
      // Phase 24 (spec D5): only the device knows whether it can speak the
      // target, so only it can ask for listening cards.
      return await api.createSession({ enrollment_id: active.id, listening: canSpeak(active.target_language) });
```

Add `canSpeak` to `create`'s dependencies. `SpeechProvider` already wraps `NextSessionProvider` in `_layout.tsx`, so the hook is in scope.

- [ ] **Step 9: `app/session.tsx` renders every type.** Import `LetterTilesView` and `MatchingBoardView`, then:

```tsx
    case 'listen_choice':
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstructionListen}
          language={language}
          selectedOption={session.selectedOption}
          onSelect={session.select}
        />
      );
    case 'dictation':
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionDictation(language)}
          language={language}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer).verdict : null}
          onSubmit={session.submitText}
        />
      );
    case 'letter_tiles':
      return (
        <LetterTilesView
          question={question}
          instruction={strings.questionInstructionTiles(language)}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer).verdict : null}
          onSubmit={session.submitText}
        />
      );
    case 'matching':
      return (
        <MatchingBoardView
          question={question}
          instruction={strings.questionInstructionMatching}
          answered={session.answered}
          onComplete={session.submitBoard}
        />
      );
```

Pass `language={language}` to the existing `typed_translation` case's `TypedAnswerView` too.

- [ ] **Step 10: Verify.**

Run: `npm test --workspace apps/mobile && npm run typecheck && npm run lint:arch && npm run build:web --workspace apps/mobile`
Expected: tests PASS. The whole-repo typecheck is clean, `lint:arch` prints nothing, and the static web export builds. The export pre-renders every page in Node, where `useSpeech` has no voices, so `ListenPrompt` must render its written fallback there without throwing.

- [ ] **Step 11: Commit.**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): listening, dictation, board and tiles cards"
```

---

### Task 9: Integration tests

**Files:**
- Modify: `apps/server/tests/integration/jobs/prepareSession.test.ts`
- Modify: `apps/server/tests/integration/repo/questions.test.ts`, `apps/server/tests/integration/repo/sessions.test.ts`
- Modify: `apps/server/tests/integration/db/migrations.test.ts`, `apps/server/tests/integration/db/progressRecompute.test.ts`
- Modify: the sessions route test, `apps/server/tests/integration/routes/sessions.test.ts`

**Interfaces:**
- Consumes: everything above. `insertListSession(db, { …, types })` from Task 6's test support.

- [ ] **Step 1: The job, end to end.** In `prepareSession.test.ts`, add:

```ts
const TEN_WORDS: Record<string, string> = {
  tome: 'ספר', sprint: 'ריצה', lantern: 'פנס', kettle: 'קומקום', pillow: 'כרית',
  ladder: 'סולם', bucket: 'דלי', violin: 'כינור', turtle: 'צב', lizard: 'לטאה',
};

it('prepares a ten-word session with listening on: a run, the board, a run (spec D3, D10)', async () => {
  await expectDistractors(ns, {
    tasks: ['meaning', 'word', 'typed', 'meaning', 'meaning', 'meaning', 'meaning', 'meaning', 'word', 'typed'],
  });
  const seed = await deps.sessions.createNextSession(E, { listening: true });
  await deps.sessions.skipSession(seed.sessionId);
  for (const [lemma, translation] of Object.entries(TEN_WORDS)) {
    await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  }
  const { sessionId } = await deps.sessions.createNextSession(E, { listening: true });

  await waitFor(async () => (await statusOf(sessionId)) === 'ready');
  const { questions } = await deps.sessions.getSession(sessionId);
  expect(questions.map((q) => q.type)).toEqual([
    'multiple_choice', 'reverse_choice', 'typed_translation',
    'matching', 'matching', 'matching', 'matching',
    'listen_choice', 'letter_tiles', 'dictation',
  ]);
  const board = questions.slice(3, 7) as MatchingQuestion[];
  for (const word of board) {
    expect(word.options).toEqual(board[0].options);
    expect(word.board.question_ids).toEqual(board.map((q) => q.id));
    expect(word.options[word.correct_option]).toBe(TEN_WORDS[word.question]);
  }
  expect(board[0].options).toHaveLength(5);
  expect(board[0].options).toContain(STUB_WRONG_HEBREW[0]);
  const tiles = questions[8] as LetterTilesQuestion;
  expect(tiles.tiles).toHaveLength([...tiles.answer].length + 2);
});
```

Import `type LetterTilesQuestion` and `type MatchingQuestion` from `@lang-tutor/core/api`. In `requestListSession`, pass `{ listening: false }` to both `createNextSession` calls. Its three-word session still plans phase 23's cycle, so the existing test is unchanged.

- [ ] **Step 2: The shapes.** In `repo/questions.test.ts`:
- add `tiles: string[] | null` to the `BAD` element type and `tiles: null` to the existing entries;
- pass `tiles: bad.tiles` into the insert;
- add these entries:

```ts
    { label: 'a dictation with options', type: 'dictation', prompt: 'ספר', options: generatedOptions('tome', ['a', 'b', 'c']), alternatives: null, tiles: null },
    { label: 'a dictation without its meaning', type: 'dictation', prompt: null, options: null, alternatives: null, tiles: null },
    { label: 'a tiles card with four tiles', type: 'letter_tiles', prompt: 'ספר', options: null, alternatives: null, tiles: ['t', 'o', 'm', 'e'] },
    { label: 'a listening card with a prompt', type: 'listen_choice', prompt: 'ספר', options: generatedOptions('ספר', ['a', 'b', 'c']), alternatives: null, tiles: null },
    { label: 'a board word with tiles', type: 'matching', prompt: null, options: generatedOptions('ספר', ['a', 'b', 'c']), alternatives: null, tiles: ['t', 'o', 'm', 'e', 'x'] },
```

- [ ] **Step 3: Boards round-trip.** In `repo/sessions.test.ts`, add a test:
1. Save four senses with `seedSavedSenses`.
2. Call `insertListSession(t.db, { …, asked: four, types: ['matching', 'matching', 'matching', 'matching'] })`.
3. `loadSession` it, and assert that each question's `board.question_ids` is the four ids and that `board.correct_options[i]` is `i`. The options are canonical and each word's own meaning sits at its board index.
4. Insert an answer for the first word with `insertAnswer(sessionId, 0, ids[0], { displayIndex: 2 })`, reload, and assert `answers[0]` is `{ question_id: ids[0], is_correct: false, answer_string: <the third meaning> }`.

- [ ] **Step 4: Old rows survive 0016 (Review Focus 4).** In `migrations.test.ts`, add `describe('0016_listening_variety', …)`, shaped exactly like the `0015_question_types` block above it:
- migrate up to `migrationsUpTo('0015_question_types')`;
- insert one `multiple_choice` question with options and one `typed_translation` question (prompt `'עפיפון'`, alternatives `'{}'`), a ready list session over both, and an option answer to the first;
- `runMigrations`;
- in a transaction, `loadSession` and assert both types and the first answer unchanged;
- insert a typed answer to the second with `{ text: 'kite', verdict: 'exact' }`, reload, and assert it reads back with `is_correct: true`.

- [ ] **Step 5: The recompute over Part A's types.** In `progressRecompute.test.ts`, add:

```ts
  it('writes back exactly what the live path wrote for a session of every phase 24 type', async () => {
    const { sessions: live } = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
    const words = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'], ['quill', 'נוצה'], ['lantern', 'פנס'],
      ['kettle', 'קומקום'], ['pillow', 'כרית'], ['ladder', 'סולם'], ['bucket', 'דלי'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
      words.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { sessionId, questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      asked: words,
      types: ['listen_choice', 'letter_tiles', 'dictation', 'matching', 'matching', 'matching', 'matching'],
    });

    await live.submitAnswer(sessionId, questions[0].id, { option_index: 0 });
    await live.submitAnswer(sessionId, questions[1].id, { text: 'quill' });
    await live.submitAnswer(sessionId, questions[2].id, { text: 'lantern' });
    // Board words: right except the second, which first tried the fifth meaning.
    await live.submitAnswer(sessionId, questions[3].id, { option_index: 0 });
    await live.submitAnswer(sessionId, questions[4].id, { option_index: 4 });
    await live.submitAnswer(sessionId, questions[5].id, { option_index: 2 });
    const done = await live.submitAnswer(sessionId, questions[6].id, { option_index: 3 });
    expect(done.status).toBe('completed');

    const written = async () => ({ progress: await readProgress(t.db, E), snapshot: await readSnapshot(t.db, sessionId) });
    const before = await written();
    const level = (senseId: string, dimension: string) =>
      before.progress.find((row) => row.senseId === senseId && row.dimension === dimension)!.level;
    expect(level(words[0].senseId, 'spoken_receptive')).toBe(2);
    expect(level(words[1].senseId, 'written_productive')).toBe(2);
    expect(level(words[1].senseId, 'spelling')).toBe(1);
    expect(level(words[2].senseId, 'spoken_receptive')).toBe(2);
    expect(level(words[2].senseId, 'spelling')).toBe(2);
    expect(level(words[3].senseId, 'written_receptive')).toBe(2);
    expect(level(words[4].senseId, 'written_receptive')).toBe(1);

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 1 });
    expect(await written()).toEqual(before);
  });
```

- [ ] **Step 6: The route.** In the sessions route test, beside the existing create tests, add:
- `{ enrollment_id, listening: true }` is answered 201;
- `{ enrollment_id, listening: 'yes' }` is answered 400 with `{ error: 'invalid request' }`.

Pass `{ listening: false }` wherever that file calls the service directly.

- [ ] **Step 7: Run every integration test.**

Run: `npm run test:integration`
Expected: PASS. Afterwards, `npm run lane:list` shows no leftover probe databases for this lane. Drop any that remain, as the memory note warns.

- [ ] **Step 8: Commit.**

```bash
git add apps/server/tests
git commit -m "test(server): phase 24 sessions through the queue, shapes, boards, migration, recompute"
```

---

### Task 10: E2E — the support, the existing specs, and a ten-word session

**Files:**
- Create: `e2e/tests/support/voices.ts`, `e2e/tests/listening-variety.spec.ts`
- Modify: `e2e/tests/voice.spec.ts`, `e2e/tests/support/cards.ts`, `e2e/tests/support/lexemes.ts`
- Modify: `e2e/tests/question-types.spec.ts`, `e2e/tests/next-session.spec.ts`, `e2e/tests/progress.spec.ts`

**Interfaces:**
- Produces:
  - `withVoices(page, languages)`, `spoken(page)`, `type Utterance`, and `spokenAfter(page, before): Promise<Utterance>`, all in `support/voices.ts`;
  - `CardKind` gains `'listen' | 'dictation' | 'tiles' | 'board'`;
  - `readCard(page, position, total, expected = CYCLE[(position - 1) % 3])`;
  - `generationStubFor(tasks: Record<number, 'meaning' | 'word' | 'typed'>, alternatives?)`;
  - `BOARD_WORDS`.

- [ ] **Step 1: Share the voice recorder.** Move `withVoices`, `spoken` and the `Utterance` type from `voice.spec.ts` into `e2e/tests/support/voices.ts` verbatim, and export them. `voice.spec.ts` imports them from there. Add:

```ts
/** Phase 24. The first utterance after the first `before`, once there is one. */
export async function spokenAfter(page: Page, before: number): Promise<Utterance> {
  await expect.poll(async () => (await spoken(page)).length).toBeGreaterThan(before);
  return (await spoken(page))[before];
}
```

- [ ] **Step 2: Cards know every kind.** In `support/cards.ts`:

```ts
export type CardKind = 'choice' | 'reverse' | 'typed' | 'listen' | 'dictation' | 'tiles' | 'board';

/** The kind of the card on screen, from what it renders. */
async function kindOnScreen(page: Page): Promise<CardKind> {
  const has = async (id: string) => (await page.getByTestId(id).count()) > 0;
  if (await has('board')) return 'board';
  if (await has('tiles')) return 'tiles';
  if (await has('listen-play')) return (await has('typed-input')) ? 'dictation' : 'listen';
  if (await has('typed-input')) return 'typed';
  const prompt = stripIsolates(await page.getByTestId('question-prompt').textContent());
  return HEBREW.test(prompt) ? 'reverse' : 'choice';
}

/**
 * The card at `position` of `total`, read once the counter shows it, and
 * checked against `expected`: by default phase 23's cycle, which a session of
 * four words at ordinal 0 with no voices still follows (phase 24 plan).
 */
export async function readCard(
  page: Page,
  position: number,
  total: number,
  expected: CardKind = CYCLE[(position - 1) % 3],
): Promise<Card> {
  await expect(page.getByTestId('progress-label')).toHaveText(new RegExp(`${position}\\s*/\\s*${total}`));
  const kind = await kindOnScreen(page);
  expect(kind, `position ${position}`).toBe(expected);
  const prompt =
    (await page.getByTestId('question-prompt').count()) > 0
      ? stripIsolates(await page.getByTestId('question-prompt').textContent())
      : '';
  const options =
    kind === 'choice' || kind === 'reverse' || kind === 'listen'
      ? await Promise.all([0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`option-${i}`).textContent())))
      : [];
  return { kind, prompt, options };
}

/** Phase 24. A stub answering exactly the keys a plan asks, each by its task. */
export function generationStubFor(tasks: Record<number, 'meaning' | 'word' | 'typed'>, alternatives: string[] = []) {
  return {
    items: Object.entries(tasks).map(([position, task]) => {
      const key = `q${position}`;
      if (task === 'meaning') return { key, distractors: WRONG_HEBREW };
      if (task === 'word') return { key, distractors: WRONG_RUSSIAN };
      return { key, distractors: [], alternatives };
    }),
  };
}
```

- [ ] **Step 3: The existing list specs run with no voices.** At the start of each test in `question-types.spec.ts`, `next-session.spec.ts` and `progress.spec.ts`, before `logIn`, add `await withVoices(page, []);`. Their position 4 is the recognise tier's second type, which is the listening card when the device has a voice. Locally, Chromium on a Mac may report system voices, so the specs pin "no voice" to stay what CI sees.

- [ ] **Step 4: The fixtures.** In `support/lexemes.ts`:

```ts
/** Phase 24. Ten single-sense Russian nouns: none in the seed (checked against
 *  content.ts and content.generated.ts), each of five to eight letters so any
 *  can be a tiles card, each with its own meaning so any four make a board. */
const single = (form: string, translation: string, code: string) => ({
  form,
  translation,
  payload: { kind: 'word' as const, entries: [{ lemma: form, part_of_speech: 'noun', senses: [{ translation, sense_code: code }] }] },
});

export const BOARD_WORDS = [
  single('ромашка', 'מרגנית', 'daisy'),
  single('черепаха', 'צב', 'turtle'),
  single('подушка', 'כרית', 'pillow'),
  single('зонтик', 'מטרייה', 'umbrella'),
  single('ведро', 'דלי', 'bucket'),
  single('скрипка', 'כינור', 'violin'),
  single('лопата', 'את חפירה', 'shovel'),
  single('кастрюля', 'סיר', 'pot'),
  single('фонарь', 'פנס', 'lantern'),
  single('ящерица', 'לטאה', 'lizard'),
];
```

- [ ] **Step 5: Write the new spec.** `e2e/tests/listening-variety.spec.ts`:

```ts
import { expect, test, type APIRequestContext } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, generationStubFor, readCard } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini, expectGemini, expectGeminiPayload } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner, logIn } from './support/users';
import { spoken, spokenAfter, withVoices } from './support/voices';

test.setTimeout(240_000);

const MEANING_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.form, w.translation]));
const FORM_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.translation, w.form]));

/** Past a skipped seed, with the ten words looked up and saved through the API. */
async function saveTenWords(request: APIRequestContext, userId: string): Promise<void> {
  const enrollments = (await (await request.get(`${API_URL}/api/users/${userId}/enrollments`)).json()) as { id: string }[];
  const enrollmentId = enrollments[0].id;
  const seed = (await (await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } })).json()) as {
    session_id: string;
  };
  expect((await request.post(`${API_URL}/api/sessions/${seed.session_id}/skip`)).ok()).toBe(true);
  for (const word of BOARD_WORDS) {
    await clearGemini(request);
    await expectGemini(request, word.payload);
    const lookup = await request.post(`${API_URL}/api/translations`, {
      data: { text: word.form, from: 'ru', to: 'he', enrollment_id: enrollmentId },
    });
    expect(lookup.ok(), await lookup.text()).toBe(true);
    const { senses } = (await lookup.json()) as { senses: { sense_id?: string; variant_id?: string }[] };
    const saved = await request.post(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary`, {
      data: { entries: senses.map((sense) => ({ sense_id: sense.sense_id!, variant_id: sense.variant_id! })) },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
}

test('ten words: a run, a board, a listening card, tiles and a dictation', async ({ page, request }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());
  await withVoices(page, ['ru-RU']);
  const user = await createLearner(request, 'e2e_listen_ru', 'ru');
  await saveTenWords(request, user.id);

  // Ordinal 0, listening on (spec D3): q1 meaning, q2 word, q3 typed, q4 the
  // board's wrong meanings, q8 the listening card's. Nothing else is asked.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStubFor({ 1: 'meaning', 2: 'word', 3: 'typed', 4: 'meaning', 8: 'meaning' }));
  await logIn(page, 'e2e_listen_ru');
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');

  // 1–3: the first run.
  await answerChoice(page, await readCard(page, 1, 10, 'choice'), true);
  await page.getByTestId('continue-button').click();
  await answerChoice(page, await readCard(page, 2, 10, 'reverse'), true);
  await page.getByTestId('continue-button').click();
  const typed = await readCard(page, 3, 10, 'typed');
  await answerTyped(page, FORM_OF[typed.prompt]);
  await page.getByTestId('continue-button').click();

  // 4–7: the board. One wrong pairing for the first word, then every word right.
  await readCard(page, 4, 10, 'board');
  const words = await Promise.all([0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`board-word-${i}`).textContent())));
  const meanings = await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => stripIsolates(await page.getByTestId(`board-meaning-${i}`).textContent())),
  );
  await page.getByTestId('board-word-0').click();
  await page.getByTestId(`board-meaning-${meanings.findIndex((m) => m !== MEANING_OF[words[0]])}`).click();
  for (const [i, word] of words.entries()) {
    await page.getByTestId(`board-word-${i}`).click();
    await page.getByTestId(`board-meaning-${meanings.indexOf(MEANING_OF[word])}`).click();
  }
  await expect(page.getByTestId('feedback-title')).toHaveText(/3\s*מתוך\s*4/);
  const beforeListen = (await spoken(page)).length;
  await page.getByTestId('continue-button').click();

  // 8: the word is spoken on arrival and not shown; pick its meaning.
  const listen = await readCard(page, 8, 10, 'listen');
  const heard = await spokenAfter(page, beforeListen);
  expect(heard.lang).toBe('ru-RU');
  await page.getByTestId(`option-${listen.options.indexOf(MEANING_OF[heard.text])}`).click();
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await expect(page.getByTestId('question-prompt')).toHaveText(heard.text);
  await page.getByTestId('continue-button').click();

  // 9: build the word from its tiles.
  const tilesCard = await readCard(page, 9, 10, 'tiles');
  const count = await page.getByTestId(/^tile-\d+$/).count();
  const tiles = await Promise.all(Array.from({ length: count }, async (_, i) => (await page.getByTestId(`tile-${i}`).textContent()) ?? ''));
  const used = new Set<number>();
  for (const letter of FORM_OF[tilesCard.prompt]) {
    const index = tiles.findIndex((tile, i) => tile === letter && !used.has(i));
    used.add(index);
    await page.getByTestId(`tile-${index}`).click();
  }
  await page.getByTestId('tiles-submit').click();
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  const beforeDictation = (await spoken(page)).length;
  await page.getByTestId('continue-button').click();

  // 10: hear it, type it.
  await readCard(page, 10, 10, 'dictation');
  const dictated = await spokenAfter(page, beforeDictation);
  await answerTyped(page, dictated.text);
  await expect(page.getByTestId('feedback-correct')).toBeVisible();
  await page.getByTestId('continue-button').click();

  // Results: listening is practice now (spec D13).
  await expect(page.getByText(/הבנת הנשמע/).first(), report()).toBeVisible();
});
```

- [ ] **Step 6: Run the e2e suite.**

Run: `bash scripts/lane-env.sh npm run e2e --workspace e2e -- tests/listening-variety.spec.ts`
Expected: PASS.

Run: `npm run e2e`
Expected: every spec PASSES, the three existing list specs and `voice.spec.ts` included.

- [ ] **Step 7: Commit.**

```bash
git add e2e
git commit -m "test(e2e): a ten-word session plays every phase 24 Part A card"
```

---

### Task 11: The spec records what was built, then the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-lang-tutor-phase-24-more-question-types-design.md` (Status line only)

- [ ] **Step 1: Update the spec's Status.** It should say that Part A is implemented on branch `phase-24-more-question-types`, and name this plan's five deviations. Commit: `docs: phase 24 spec records what Part A built`.

- [ ] **Step 2: Verify everything.**

Run: `npm test && npm run typecheck && npm run lint:arch && npm run test:integration && npm run e2e`
Expected: all PASS. Part A changes no prompt text, so `npm run eval` runs in CI's `test-eval` job rather than here.

- [ ] **Step 3: Finish the branch.** Per CLAUDE.md, use `superpowers:finishing-a-development-branch` → "Push and create a Pull Request" via `git-create-pr`, then `ci-green`. The PR description must:
- announce the badge recalibration (spec D13);
- name the five-minute budget (D16);
- list for Victor's device: the auto-play on a listening card, a board on a phone screen, the tiles row's direction, and the speaker on iOS silent mode.
