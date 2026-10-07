# Phase 25 — Speaking Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two speaking cards, `read_aloud` (the form is shown, the learner says it) and `say_translation` (the Hebrew is shown, the learner says the word). The app records a clip, the server has Gemini transcribe it blind, and a pure `judgeSpoken` decides whether the word was understood. "Can't speak now" turns the rest of a session's say-the-translation cards into typed cards and passes its read-aloud cards. `spoken_productive` goes live.

**Architecture:** The wire gains two `Question` members, a third `NextStepRequest` body (`pass`), a `speaking` flag on `CreateSessionRequest` and one endpoint, `POST /api/sessions/{id}/speech`, which takes base64 audio. The service checks the card, transcribes outside any transaction through a new `SpeechTranscriber` contract that the Gemini provider satisfies, judges the transcript with core's `judgeSpoken`, and steps the session through the same `submitAnswer` path as any answer. If the word was not understood, it writes nothing. Phase 24's planner gains the two types at the end of two tiers, filtered out when speaking is off, so a session without speaking is planned exactly as today. On the app, `src/recording.ts` wraps `expo-audio`'s recorder class behind a factory built in `_layout.tsx`, `SpeakingCardView` drives a record, stop and check cycle, and `useSession` holds the attempt, the pass and "can't speak now".

**Tech Stack:** TypeScript, Zod 4, Hono + @hono/zod-openapi (`hono/body-limit`), Drizzle + Postgres 17, pg-boss, Jest (Babel: tests do not type-check), Expo SDK 57 / React Native / react-native-web, `expo-audio` (recorder), `expo-file-system` (reading the clip), Playwright with Chromium's fake microphone, MockServer, Gemini `generateContent` with `inlineData` audio.

**Spec:** `docs/superpowers/specs/2026-10-07-lang-tutor-phase-25-speaking-design.md` (all of it, including § POC findings).

**Deviations from the spec, decided while planning:**
- **Built on phase 24 Part A (#93), not on phase 24 as completed.** Part B (the cloze cards) is not built yet, and speaking needs nothing from it. Victor asked on 2026-10-07 for the phase to be planned, built and opened as a PR now. The tiers therefore hold Part A's types plus the two speaking ones. Part B will insert the cloze types as its own plan says.
- **The migration is 0017** (`0017_speaking_cards.sql`), the next free number on master. Part B takes whatever comes after.
- **Speaking types are filtered out of the tiers when speaking is off**, not merely made ineligible. A session without speaking then keeps phase 24's rotation exactly, so no learner without a microphone, and no existing test, sees a different plan.
- **On the web, only a granted microphone counts as able to record** (D4 said "not yet asked" counts as yes). `expo-audio`'s web permission read *opens the browser's prompt* when the permission was never granted, so the app cannot read it at session start. Reading `navigator.permissions` instead only reports "granted", "denied" or "prompt", and a site that never granted gets no speaking cards. On a phone, "not yet asked" still counts as yes, and the first tap of the microphone asks. As a side effect, the existing e2e specs, whose Chromium never grants the microphone, plan exactly as before.
- **A clip under 1 000 base64 characters (~750 bytes) is "heard nothing" without a model call.** It holds no word, and Gemini answers an empty input with a 400.
- **The owner check returns 404**, as an unknown session does: a session id held by another learner is not theirs to probe.
- **A transcript is stored truncated to 100 characters** (`answers_typed_text_length`).
- **The five-second limit is the card's timer**, with the arithmetic in a pure `secondsLeft` that is unit-tested.
- **`LIVE_DIMENSIONS` changes in its own task (Task 8)**, together with every badge expectation it moves, so the recalibration is one reviewable diff.

## Global Constraints

- Every ADR in `docs/adr/` holds, and `npm run lint:arch` must print nothing. When a `scripts/check-adr-*.sh` gains a pattern, plant a violation first and see the check report it (CLAUDE.md).
- `domain/` stays pure: no `Date.now`, no `Math.random`, no I/O (ADR 0001 R3). Persistence imports domain *types* only (R4). A service depends on `SpeechTranscriber` from `services/speech.ts`, never on `providers/` (R11). Only `composition.ts` names `createGeminiTranscriber`.
- Every wire type is a `z.infer` (ADR 0003 R3); `api/index.ts` exports types only. Every endpoint is a `createRoute` (R1); the body limit is middleware (`router.use`), not a raw verb.
- No `jest.mock`. No optional or defaulted collaborator parameter (ADR 0002 R4, R5). `expo-audio` and `expo-file-system` are imported only by `apps/mobile/src/app/_layout.tsx` (ADR 0002 R1, extended in Task 6).
- Existing types keep their names, shapes and meaning. The seed session is unchanged.
- **Tiers** (`apps/server/src/domain/plan.ts`):
  - recognise `['multiple_choice', 'listen_choice', 'read_aloud']`;
  - pick the form `['reverse_choice', 'letter_tiles']`;
  - produce `['typed_translation', 'dictation', 'say_translation']`.
  With speaking off, or a session of one pick, `read_aloud` and `say_translation` are removed from the tiers before the rotation.
- **Speakable:** a saved form of 1 to 4 words (`MAX_SPOKEN_WORDS = 4`), counted by core's `spokenWords`.
- **Verdicts:** typed `exact | near_miss | alternative | wrong`; spoken `understood | alternative | gave_up | skipped`. The endpoint's `unheard` is never stored. Correct means anything but `wrong`, `gave_up` and `skipped`. `skipped` is left out of the score's total and the missed list.
- **Evidence** (spec D10): `read_aloud` understood → `spoken_productive` ✓ capped at 2. `say_translation` understood → `spoken_receptive` ✓ and `spoken_productive` ✓. `gave_up` → `spoken_productive` ✗. `alternative` and `skipped` → nothing. A typed verdict on `say_translation` → as `typed_translation`.
- `TRANSCRIBE_MARKER = 'transcribe the spoken audio'`; `SPEECH_TIMEOUT_MS` default `8_000`; `audio` is at most `270_000` characters; the route's body limit is `300 * 1024` bytes; `MIN_AUDIO_CHARS = 1_000`; `MAX_HEARD_CHARS = 100`. The transcriber sends `thinkingConfig: { thinkingBudget: 0 }` and `temperature: 0`.
- **Recording formats:** Android `{ extension: '.aac', sampleRate: 16000, numberOfChannels: 1, bitRate: 32000, outputFormat: 'aac_adts', audioEncoder: 'aac' }` → `audio/aac`; iOS `{ extension: '.m4a', sampleRate: 16000, numberOfChannels: 1, bitRate: 32000, outputFormat: 'aac ', audioQuality: 64 }` → `audio/mp4`; web `{ sampleRate: 16000, numberOfChannels: 1, bitRate: 128000, mimeType: 'audio/webm', bitsPerSecond: 128000 }` → `audio/webm`. Five seconds at most.
- **Hebrew strings, exactly:**
  - `קראו בקול`
  - `` `אמרו ב${languageName(language)}` ``
  - `הקלטה`
  - `` `מקליטים… ${seconds}` ``
  - `בודקים…`
  - `אי אפשר לדבר עכשיו`
  - `אין גישה למיקרופון`
  - `נכון! שמענו:`
  - `` `שמענו: ⁨${heard}⁩` ``
  - `לא הבנו. שמענו:`
  - `לא שמענו כלום`
  - `לא הצלחנו לבדוק`
  - `נסו שוב`
  - existing `המשך`, `הצגת התשובה`, `נכון! המילה שתרגלנו:`, `התשובה הנכונה:`, `כתבו את המילה ב…`.
- **`testID`s:** `speak-record`, `speak-status`, `speak-notice`, `speak-notice-heard`, `speak-try-again`, `speak-continue`, `speak-cant-speak`, `speak-show-answer`, `speak-form`, `speak-meaning`, `speak-answer`, `speak-heard`, `speak-no-mic`. A speaking card's prompt keeps `question-prompt` (and `question-part-of-speech` on say the translation). Existing ones are unchanged.
- **This worktree is lane slot 2** (`.claude/worktrees/phase-25-speaking`). Postgres and MockServer are already running from the main checkout. Run:
  - integration files with `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath <file>'` (with a space, `--selectProjects` eats the path);
  - server unit files with `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath <file>)`;
  - mobile tests with `(cd apps/mobile && npx jest <file>)`;
  - the eval with `(cd apps/server && npx tsx tests/eval/run.ts <filter>)`. `GEMINI_API_KEY` and `GEMINI_MODEL` are in the shell; never point it at MockServer.
- Never hardcode a port or a database name (ADR 0006). Never lower `TIER2_THRESHOLD`.
- **Never write into the main checkout** (`/Users/victorprp/git/lang-tutor`). Use absolute paths under the worktree. After each task the controller runs `git -C /Users/victorprp/git/lang-tutor status --short`, and it must be empty.
- **Typecheck is restored task by task.** Core after Task 1, the server after Task 5, mobile after Task 7. Babel runs tests without type-checking, so a task's tests can pass while a later workspace is still red. The whole-repo `npm run typecheck` is a gate from Task 7 on.
- Commit messages follow the repo's style (`feat(core): …`, `feat(server): …`, `test(e2e): …`, `docs: …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A retried upload after the answer was recorded** (the response was lost on a bad network). The second upload must not call the model or record a second answer: it replays the stored answer, as `next-step` does. *Pinned in Task 5, "replays an answered speaking card without a model call".*
2. **An upload for a card that is not current, or not a speaking card,** must be refused before the model is called, so a stale tab or a wrong client cannot spend money. *Pinned in Task 5, "refuses before transcribing".*
3. **A session whose last card is a read-aloud card passed by "can't speak now"** must complete and show results whose total leaves that card out. *Pinned in Task 7, "a passed last card completes the session", and in Task 5's integration "the score leaves a skipped card out".*
4. **A transcript longer than 100 characters** (the model rambling) must be stored, not refused by `answers_typed_text_length`. *Pinned in Task 1, "stores at most 100 characters of a transcript", and Task 5's integration with a 150-character stub.*
5. **Questions, sessions and answers stored before migration 0017** load and take answers unchanged, and a speaking row of the wrong shape is refused. *Pinned in Task 3, the 0017 migration test.*

---

### Task 1: Core — speaking questions, verdicts, `judgeSpoken`, `pass`, the score

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Create: `packages/core/src/domain/spoken.ts`, test `packages/core/src/domain/spoken.test.ts`
- Modify: `packages/core/src/domain/typed.ts` (export two helpers), `packages/core/src/domain/quiz.ts`, `packages/core/src/domain/index.ts`
- Test: `packages/core/src/domain/quiz.test.ts`, `packages/core/src/api/schemas.test.ts` (create it if it does not exist; otherwise append)

**Interfaces:**
- Produces (wire, `@lang-tutor/core/api`): `ReadAloudQuestion`, `SayTranslationQuestion`, `SpokenVerdict`, `AnswerVerdict`, `SpeechMimeType`, `SpeechVerdict`, `SpeechAnswerRequest`, `SpeechAnswerResponse`, `LlmTranscript`; `NextStepRequest` gains `{ user_id, question_id, pass: 'skip' | 'show_answer' }`; `CreateSessionRequest.speaking?: boolean`; `AnswerRecord.verdict?: AnswerVerdict`.
- Produces (`@lang-tutor/core/domain`):
  - `AnswerInput = { option_index } | { text } | { heard: string } | { pass: 'skip' | 'show_answer' }`
  - `SpeakingQuestion`, `isSpeaking(question): question is SpeakingQuestion`
  - `SpokenTarget = { forms: readonly string[]; alternatives: readonly string[] }`
  - `judgeSpoken(target, heard): SpeechVerdict`, `spokenWords(text): string[]`, `speakable(form): boolean`, `MAX_SPOKEN_WORDS = 4`
  - `spokenTarget(question: SpeakingQuestion): SpokenTarget`, `spokenVerdict(question: SpeakingQuestion, heard: string): SpeechVerdict`
  - `verdictCorrect(verdict: AnswerVerdict): boolean`
  - `evaluate`, `answerFits`, `rightAnswer`, `score`, `missed` covering both types.

- [ ] **Step 1: Write the failing tests for `judgeSpoken`**

Create `packages/core/src/domain/spoken.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { MAX_SPOKEN_WORDS, judgeSpoken, speakable, spokenWords } from './spoken';

const read = (form: string) => ({ forms: [form], alternatives: [] });

describe('spokenWords', () => {
  it('normalises, folds diacritics, keeps the breve, and splits on anything but letters', () => {
    expect(spokenWords('  Perché, CITTÀ!  ')).toEqual(['perche', 'citta']);
    expect(spokenWords('Ёлка')).toEqual(['елка']);
    expect(spokenWords('мой')).toEqual(['мой']);
    expect(spokenWords('моло́ко')).toEqual(['молоко']);
  });

  it("drops an Italian elision from a word, so l'acqua is the word acqua", () => {
    expect(spokenWords("L’acqua")).toEqual(['acqua']);
    expect(spokenWords("dell'acqua")).toEqual(['acqua']);
  });

  it("keeps an English contraction whole: don't is not t", () => {
    expect(spokenWords("don't")).toEqual(["don't"]);
  });
});

describe('judgeSpoken (spec D6)', () => {
  it('understands the target alone, or among filler words and an article', () => {
    expect(judgeSpoken(read('gatto'), 'gatto')).toBe('understood');
    expect(judgeSpoken(read('gatto'), 'Um, gatto.')).toBe('understood');
    expect(judgeSpoken(read('gatto'), 'il gatto')).toBe('understood');
  });

  it('folds diacritics: the spelling of a transcript is the model’s, not the learner’s', () => {
    expect(judgeSpoken(read('perché'), 'perche')).toBe('understood');
    expect(judgeSpoken(read('ёлка'), 'елка')).toBe('understood');
  });

  it('keeps й apart from и', () => {
    expect(judgeSpoken(read('мой'), 'мои')).toBe('unheard');
  });

  it('matches a phrase as a run of words, in order and side by side', () => {
    expect(judgeSpoken(read('per favore'), 'per favore')).toBe('understood');
    expect(judgeSpoken(read('per favore'), 'sì, per favore')).toBe('understood');
    expect(judgeSpoken(read('per favore'), 'favore per')).toBe('unheard');
    expect(judgeSpoken(read('per favore'), 'per il favore')).toBe('unheard');
  });

  it('compares whole words, never parts of words', () => {
    expect(judgeSpoken(read('gatto'), 'gattone')).toBe('unheard');
  });

  it('treats one letter off as another word: the feedback the learner needs', () => {
    expect(judgeSpoken(read('gatto'), 'gato')).toBe('unheard');
  });

  it('finds a target saved with its article or "to" when only the word was said', () => {
    expect(judgeSpoken(read('il gatto'), 'gatto')).toBe('understood');
    expect(judgeSpoken(read('to go'), 'go')).toBe('understood');
  });

  it('is unheard on an empty transcript', () => {
    expect(judgeSpoken(read('gatto'), '')).toBe('unheard');
    expect(judgeSpoken(read('gatto'), '   ')).toBe('unheard');
  });

  it('reports an alternative only after the forms', () => {
    const target = { forms: ['big', 'big'], alternatives: ['large'] };
    expect(judgeSpoken(target, 'large')).toBe('alternative');
    expect(judgeSpoken(target, 'big')).toBe('understood');
  });
});

describe('speakable (spec D3)', () => {
  it('takes one to four words and nothing longer', () => {
    expect(MAX_SPOKEN_WORDS).toBe(4);
    expect(speakable('gatto')).toBe(true);
    expect(speakable('caffè con il cornetto')).toBe(true);
    expect(speakable('vorrei un caffè con cornetto')).toBe(false);
    expect(speakable('…')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `(cd packages/core && npx jest src/domain/spoken.test.ts)`
Expected: FAIL, "Cannot find module './spoken'".

- [ ] **Step 3: Export the two helpers `judgeSpoken` reuses from `typed.ts`**

In `packages/core/src/domain/typed.ts`:
- rename the constant `LEADING` to `LEADING_WORDS` and export it (update its one use in `bare`);
- rename `undotted` to `foldDiacritics` and export it (update its use in `nearMiss`).

```ts
export const LEADING_WORDS = new Set(['to', 'a', 'an', 'the', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una']);
```

```ts
/** Without diacritics: `perché` → `perche`, `ёлка` → `елка`. The breve stays:
 *  й is its own letter, not a marked и, so `мои` is another word than `мой`. */
export const foldDiacritics = (text: string) =>
  text
    .normalize('NFD')
    .replace(/(?!̆)\p{M}/gu, '')
    .normalize('NFC');
```

- [ ] **Step 4: Write `spoken.ts`**

Create `packages/core/src/domain/spoken.ts`:

```ts
import type { SpeechVerdict } from '../api/types';
import { LEADING_WORDS, foldDiacritics, normaliseTyped } from './typed';

/**
 * Phase 25 (spec D6). How a transcript is judged against a speaking card.
 * Pure and shared, as judgeTyped is: the server judges with it, and the app
 * runs it on the transcript the server returned to word its banner, so the two
 * cannot disagree.
 */

/** Spec D3. The longest saved item a speaking card asks for: a phrase of four
 *  words. Longer is a sentence, which is Out. */
export const MAX_SPOKEN_WORDS = 4;

// An Italian elision a learner may say or drop: `l'acqua` is the word `acqua`.
// A closed list, so an English contraction (`don't`) stays whole.
const ELISIONS = ["l'", "un'", "dell'", "nell'", "all'", "dall'", "sull'", "quell'"];

function dropElision(word: string): string {
  const prefix = ELISIONS.find((elision) => word.startsWith(elision) && word.length > elision.length);
  return prefix ? word.slice(prefix.length) : word;
}

/** The words of a transcript or a target, as the judge compares them: typed
 *  normalising, diacritics folded (the breve kept), split on anything but a
 *  letter or an apostrophe, and an Italian elision dropped from each word. */
export function spokenWords(text: string): string[] {
  return foldDiacritics(normaliseTyped(text))
    .split(/[^\p{L}']+/u)
    .map((word) => word.replace(/^'+|'+$/gu, ''))
    .map(dropElision)
    .filter((word) => word !== '');
}

/** Whether `run` appears in `words` in order and side by side. */
function containsRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return false;
  for (let start = 0; start + run.length <= words.length; start++) {
    if (run.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/** A form's runs to look for: its words, and without a leading article or
 *  "to" when words remain, so a saved `il gatto` is found in `gatto`. */
function runsOf(form: string): string[][] {
  const words = spokenWords(form);
  return words.length > 1 && LEADING_WORDS.has(words[0]) ? [words, words.slice(1)] : [words];
}

/** What a transcript is judged against: the forms that are this word, and
 *  other words that are right but not this one (phase 23 D5). */
export type SpokenTarget = { forms: readonly string[]; alternatives: readonly string[] };

/**
 * - `understood`: one of the forms is among the heard words.
 * - `alternative`: one of the alternatives is. Checked after the forms.
 * - `unheard`: anything else, a near miss and silence included. It is never
 *   recorded (spec D5).
 */
export function judgeSpoken(target: SpokenTarget, heard: string): SpeechVerdict {
  const words = spokenWords(heard);
  const found = (forms: readonly string[]) => forms.some((form) => runsOf(form).some((run) => containsRun(words, run)));
  if (found(target.forms)) return 'understood';
  if (found(target.alternatives)) return 'alternative';
  return 'unheard';
}

/** Spec D3. Whether a saved form can be a speaking card: one to four words. */
export function speakable(form: string): boolean {
  const count = spokenWords(form).length;
  return count >= 1 && count <= MAX_SPOKEN_WORDS;
}
```

- [ ] **Step 5: Add the wire schemas**

In `packages/core/src/api/schemas.ts`, after `LetterTilesQuestionSchema`:

```ts
// Phase 25 (spec D2). The form, written; the learner says it. `meaning` is
// shown after the answer and read by the missed list, as dictation's is.
export const ReadAloudQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('read_aloud'),
  vocab_term_id: z.string(),
  question: z.string(),
  meaning: z.string(),
});

// Phase 25 (spec D2). The meaning; the learner says the word. It carries what
// the typed card carries, which is also what its typed form needs when the
// learner cannot speak (spec D8).
export const SayTranslationQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('say_translation'),
  vocab_term_id: z.string(),
  question: z.string(),
  part_of_speech: z.string(),
  answer: z.string(),
  lemma: z.string(),
  alternatives: z.array(z.string()),
});
```

Add both to `QuestionSchema`'s list, after `LetterTilesQuestionSchema`.

Replace the verdict block and `AnswerRecordSchema`:

```ts
// Phase 23. How a typed answer was judged (spec D5). Every verdict but `wrong`
// counts in the score.
export const TypedVerdictSchema = z.enum(['exact', 'near_miss', 'alternative', 'wrong']);

// Phase 25 (spec D5). How a speaking card was answered: understood as the
// word, as another right word, given up on, or passed. An attempt that was not
// understood is never recorded, so it has no verdict here.
export const SpokenVerdictSchema = z.enum(['understood', 'alternative', 'gave_up', 'skipped']);

// Every verdict an answer can be stored with.
export const AnswerVerdictSchema = z.enum([
  'exact',
  'near_miss',
  'alternative',
  'wrong',
  'understood',
  'gave_up',
  'skipped',
]);

export const AnswerRecordSchema = z.object({
  question_id: z.string(),
  is_correct: z.boolean(),
  answer_string: z.string(),
  // Phase 23. Present for a typed answer; phase 25, for a spoken one too.
  verdict: AnswerVerdictSchema.optional(),
});
```

In `CreateSessionRequestSchema`, after `listening`:

```ts
  // Phase 25 (spec D4). Whether the device can record, so the session may hold
  // speaking cards. Absent means no.
  speaking: z.boolean().optional(),
```

Add the third `NextStepRequestSchema` member:

```ts
  // Phase 25 (spec D5). A speaking card answered without audio: passed, or
  // "show me the answer".
  z.object({
    user_id: z.string().min(1),
    question_id: z.string().min(1),
    pass: z.enum(['skip', 'show_answer']),
  }),
```

After `NextStepResponseSchema`:

```ts
// Phase 25 (spec D12). What each platform records: Android AAC in ADTS, iOS AAC
// in M4A, and the browser's WebM. Gemini takes all three as they are (POC).
export const SpeechMimeTypeSchema = z.enum(['audio/aac', 'audio/mp4', 'audio/webm']);

// Phase 25 (spec D14). One spoken attempt at the current card. At most 200 KB of
// audio, as base64 (spec D13).
export const SpeechAnswerRequestSchema = z.object({
  user_id: z.string().min(1),
  question_id: z.string().min(1),
  mime_type: SpeechMimeTypeSchema,
  audio: z.string().min(1).max(270_000),
});

// How an attempt was judged. `unheard` records nothing (spec D5).
export const SpeechVerdictSchema = z.enum(['understood', 'alternative', 'unheard']);

export const SpeechAnswerResponseSchema = z.object({
  // What the model heard, at most 100 characters: shown on the card.
  heard: z.string(),
  verdict: SpeechVerdictSchema,
  // The next-step response when the answer was recorded, which the app queues
  // while the banner shows. Absent when the word was not understood.
  next: NextStepResponseSchema.optional(),
});
```

Next to `LlmDistractorsSchema` (search for it), add the model's transcript shape:

```ts
// Phase 25 (spec D13). The transcriber's answer: the words it heard, or an
// empty string for nothing intelligible.
export const LlmTranscriptSchema = z.object({ heard: z.string() });
```

- [ ] **Step 6: Infer and export the types**

In `packages/core/src/api/types.ts`, add the new schemas to the `import type { … } from './schemas'` list (`ReadAloudQuestionSchema`, `SayTranslationQuestionSchema`, `SpokenVerdictSchema`, `AnswerVerdictSchema`, `SpeechMimeTypeSchema`, `SpeechVerdictSchema`, `SpeechAnswerRequestSchema`, `SpeechAnswerResponseSchema`, `LlmTranscriptSchema`) and:

```ts
export type ReadAloudQuestion = z.infer<typeof ReadAloudQuestionSchema>;
export type SayTranslationQuestion = z.infer<typeof SayTranslationQuestionSchema>;
export type SpokenVerdict = z.infer<typeof SpokenVerdictSchema>;
export type AnswerVerdict = z.infer<typeof AnswerVerdictSchema>;
export type SpeechMimeType = z.infer<typeof SpeechMimeTypeSchema>;
export type SpeechVerdict = z.infer<typeof SpeechVerdictSchema>;
export type SpeechAnswerRequest = z.infer<typeof SpeechAnswerRequestSchema>;
export type SpeechAnswerResponse = z.infer<typeof SpeechAnswerResponseSchema>;
export type LlmTranscript = z.infer<typeof LlmTranscriptSchema>;
```

Add the same nine names to `packages/core/src/api/index.ts`'s `export type { … }` list, keeping it alphabetical.

- [ ] **Step 7: Write the failing quiz tests**

Append to `packages/core/src/domain/quiz.test.ts`:

```ts
import type { ReadAloudQuestion, SayTranslationQuestion } from '../api/types';

const READ: ReadAloudQuestion = { id: 'r1', type: 'read_aloud', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' };
const SAY: SayTranslationQuestion = {
  id: 's1',
  type: 'say_translation',
  vocab_term_id: 'l2',
  question: 'מדבר',
  part_of_speech: 'verb',
  answer: 'parlo',
  lemma: 'parlare',
  alternatives: ['dico'],
};

describe('phase 25 speaking cards', () => {
  it('takes a transcript or a pass on a speaking card, and a text only on say the translation', () => {
    expect(answerFits(READ, { heard: 'gatto' })).toBe(true);
    expect(answerFits(READ, { pass: 'skip' })).toBe(true);
    expect(answerFits(READ, { pass: 'show_answer' })).toBe(false);
    expect(answerFits(READ, { text: 'gatto' })).toBe(false);
    expect(answerFits(READ, { option_index: 0 })).toBe(false);
    expect(answerFits(SAY, { heard: 'parlo' })).toBe(true);
    expect(answerFits(SAY, { pass: 'show_answer' })).toBe(true);
    expect(answerFits(SAY, { text: 'parlo' })).toBe(true);
    expect(answerFits(SAY, { option_index: 0 })).toBe(false);
  });

  it('a heard answer stores the transcript with its verdict, and counts as correct', () => {
    expect(evaluate(READ, { heard: 'il gatto' })).toEqual({
      question_id: 'r1',
      is_correct: true,
      answer_string: 'il gatto',
      verdict: 'understood',
    });
    expect(evaluate(SAY, { heard: 'parlare' })).toMatchObject({ is_correct: true, verdict: 'understood' });
    expect(evaluate(SAY, { heard: 'dico' })).toMatchObject({ is_correct: true, verdict: 'alternative' });
  });

  it('read aloud takes the form only, not its lemma', () => {
    const shown: ReadAloudQuestion = { ...READ, question: 'parlo' };
    expect(spokenVerdict(shown, 'parlare')).toBe('unheard');
    expect(spokenVerdict(SAY, 'parlare')).toBe('understood');
  });

  it('never records an unheard transcript', () => {
    expect(() => evaluate(READ, { heard: 'cane' })).toThrow(/unheard/);
  });

  it('stores at most 100 characters of a transcript', () => {
    const heard = `gatto ${'a'.repeat(200)}`;
    expect(evaluate(READ, { heard }).answer_string).toHaveLength(100);
  });

  it('a skip is neither right nor counted; show the answer is a failure', () => {
    expect(evaluate(READ, { pass: 'skip' })).toEqual({ question_id: 'r1', is_correct: false, answer_string: '', verdict: 'skipped' });
    expect(evaluate(SAY, { pass: 'show_answer' })).toEqual({ question_id: 's1', is_correct: false, answer_string: '', verdict: 'gave_up' });
  });

  it('a typed answer to say the translation is judged as a typed card', () => {
    expect(evaluate(SAY, { text: 'parlare' })).toMatchObject({ is_correct: true, verdict: 'exact' });
    expect(evaluate(SAY, { text: 'mangio' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });

  it('the right answer of a read-aloud card is its form, of say the translation its word', () => {
    expect(rightAnswer(READ)).toBe('gatto');
    expect(rightAnswer(SAY)).toBe('parlo');
  });

  it('leaves a skipped card out of the score and of the missed list (spec D9)', () => {
    const answers = [evaluate(READ, { pass: 'skip' }), evaluate(SAY, { pass: 'show_answer' })];
    expect(score([READ, SAY], answers)).toEqual({ correct: 0, total: 1 });
    expect(missed([READ, SAY], answers).map((item) => item.question.id)).toEqual(['s1']);
  });

  it('knows which stored verdicts are right', () => {
    expect(['exact', 'near_miss', 'alternative', 'understood'].every((v) => verdictCorrect(v as never))).toBe(true);
    expect(['wrong', 'gave_up', 'skipped'].some((v) => verdictCorrect(v as never))).toBe(false);
  });
});
```

Add `spokenVerdict` and `verdictCorrect` to the file's existing `import { … } from './quiz'`.

- [ ] **Step 8: Run them to see them fail**

Run: `(cd packages/core && npx jest src/domain/quiz.test.ts)`
Expected: FAIL (`spokenVerdict` is not a function, and the speaking cases fall through to "does not fit").

- [ ] **Step 9: Implement the quiz rules**

In `packages/core/src/domain/quiz.ts`:

Imports: add `AnswerVerdict`, `ReadAloudQuestion`, `SayTranslationQuestion`, `SpeechVerdict` to the `../api/types` import, and `import { judgeSpoken, type SpokenTarget } from './spoken';`.

Replace `AnswerInput`, the choice types and `isChoice`:

```ts
/** Phase 23. A choice is answered by index, a typed card by its text. Phase 25:
 *  a speaking card by a transcript, which only the server builds from the audio
 *  it judged, or by a pass (spec D5). */
export type AnswerInput =
  | { option_index: number }
  | { text: string }
  | { heard: string }
  | { pass: 'skip' | 'show_answer' };

export type ChoiceQuestion = MultipleChoiceQuestion | ReverseChoiceQuestion | ListenChoiceQuestion | MatchingQuestion;
/** Phase 25. The cards answered by voice. */
export type SpeakingQuestion = ReadAloudQuestion | SayTranslationQuestion;
/** Phase 24. A question answered by text: typed, heard, or built from tiles. */
type TextQuestion = Exclude<Question, ChoiceQuestion | SpeakingQuestion>;

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
    case 'read_aloud':
    case 'say_translation':
      return false;
  }
}

export function isSpeaking(question: Question): question is SpeakingQuestion {
  return question.type === 'read_aloud' || question.type === 'say_translation';
}

/** Whether `answer` is the kind `question` takes. A read-aloud card has no
 *  "show the answer": its word is on the screen. */
export function answerFits(question: Question, answer: AnswerInput): boolean {
  if (isChoice(question)) return 'option_index' in answer;
  if (question.type === 'read_aloud') return 'heard' in answer || ('pass' in answer && answer.pass === 'skip');
  if (question.type === 'say_translation') return 'heard' in answer || 'pass' in answer || 'text' in answer;
  return 'text' in answer;
}

/** What the learner should have answered, as the feedback and the missed list show it. */
export function rightAnswer(question: Question): string {
  if (isChoice(question)) return question.options[question.correct_option];
  return question.type === 'dictation' || question.type === 'read_aloud' ? question.question : question.answer;
}

/** Phase 25 (spec D6). What a speaking card's transcript is judged against:
 *  read aloud, the form shown; say the translation, the form or its lemma, and
 *  the alternatives. */
export function spokenTarget(question: SpeakingQuestion): SpokenTarget {
  return question.type === 'read_aloud'
    ? { forms: [question.question], alternatives: [] }
    : { forms: [question.answer, question.lemma], alternatives: question.alternatives };
}

export function spokenVerdict(question: SpeakingQuestion, heard: string): SpeechVerdict {
  return judgeSpoken(spokenTarget(question), heard);
}

/** Phase 25 (spec D9). Whether a stored verdict counts as right. A skip is
 *  not right, and score leaves it out of the total. */
export function verdictCorrect(verdict: AnswerVerdict): boolean {
  return verdict !== 'wrong' && verdict !== 'gave_up' && verdict !== 'skipped';
}

// answers_typed_text_length: a transcript is stored as the text of its answer.
const MAX_ANSWER_TEXT = 100;
```

`verdictFor` now also takes a say-the-translation card's typed form:

```ts
function verdictFor(question: TextQuestion | SayTranslationQuestion, text: string): TypedVerdict {
  switch (question.type) {
    case 'typed_translation':
    case 'say_translation':
      return judgeTyped(question, text);
    case 'dictation':
      // Spec D7: what was said, and nothing else — not its lemma, not a synonym.
      return judgeTyped({ answer: question.question, lemma: question.question, alternatives: [] }, text);
    case 'letter_tiles':
      return judgeTiles(question.answer, text);
  }
}
```

Replace `evaluate`, `score` and `missed`:

```ts
// Callers check answerFits, and an option's range, first: the session's step
// owns those outcomes, so here a mismatch is a programming error. So is an
// unheard transcript, which step refuses before it gets here (spec D5).
export function evaluate(question: Question, answer: AnswerInput): AnswerRecord {
  if (isChoice(question) && 'option_index' in answer) {
    return {
      question_id: question.id,
      is_correct: answer.option_index === question.correct_option,
      answer_string: question.options[answer.option_index],
    };
  }
  if (isSpeaking(question) && 'heard' in answer) {
    const verdict = spokenVerdict(question, answer.heard);
    if (verdict === 'unheard') throw new Error('an unheard transcript is never recorded (spec D5)');
    return { question_id: question.id, is_correct: true, answer_string: answer.heard.slice(0, MAX_ANSWER_TEXT), verdict };
  }
  if (isSpeaking(question) && 'pass' in answer) {
    const verdict = answer.pass === 'skip' ? 'skipped' : 'gave_up';
    return { question_id: question.id, is_correct: false, answer_string: '', verdict };
  }
  if (!isChoice(question) && question.type !== 'read_aloud' && 'text' in answer) {
    const verdict = verdictFor(question, answer.text);
    return { question_id: question.id, is_correct: verdictCorrect(verdict), answer_string: answer.text, verdict };
  }
  throw new Error(`the answer does not fit a ${question.type} question`);
}

/** Phase 25 (spec D9). A skipped card is not in the total: a skip is not a failure. */
export function score(questions: readonly Question[], answers: readonly AnswerRecord[]): Score {
  return {
    correct: answers.filter((record) => record.is_correct).length,
    total: questions.length - answers.filter((record) => record.verdict === 'skipped').length,
  };
}

export function missed(
  questions: readonly Question[],
  answers: readonly AnswerRecord[],
): MissedQuestion[] {
  return answers
    .filter((record) => !record.is_correct && record.verdict !== 'skipped')
    .flatMap((record) => {
      const question = questions.find((item) => item.id === record.question_id);
      return question ? [{ question, correct_answer: rightAnswer(question) }] : [];
    });
}
```

In `packages/core/src/domain/index.ts`, export the new values and types:

```ts
export {
  SESSION_LENGTH,
  answerFits,
  evaluate,
  isChoice,
  isSpeaking,
  missed,
  pickQuestions,
  rightAnswer,
  score,
  shuffleOptions,
  shuffleSession,
  spokenTarget,
  spokenVerdict,
  verdictCorrect,
} from './quiz';
export type { AnswerInput, ChoiceQuestion, QuestionType, SpeakingQuestion } from './quiz';
export { MAX_SPOKEN_WORDS, judgeSpoken, speakable, spokenWords } from './spoken';
export type { SpokenTarget } from './spoken';
```

(keep the existing `typed` and `progress` export lines).

- [ ] **Step 10: Pin the wire shapes**

In `packages/core/src/api/schemas.test.ts` (create it with this content if absent, or append the `describe`):

```ts
import { describe, expect, it } from '@jest/globals';

import { NextStepRequestSchema, QuestionSchema, SpeechAnswerRequestSchema, SpeechAnswerResponseSchema } from './schemas';

describe('phase 25 wire shapes', () => {
  it('parses both speaking questions', () => {
    expect(QuestionSchema.parse({ id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' }).type).toBe(
      'read_aloud',
    );
    expect(
      QuestionSchema.parse({
        id: 's',
        type: 'say_translation',
        vocab_term_id: 'l',
        question: 'חתול',
        part_of_speech: 'noun',
        answer: 'gatto',
        lemma: 'gatto',
        alternatives: [],
      }).type,
    ).toBe('say_translation');
  });

  it('takes a pass on next-step, and refuses an unknown one', () => {
    expect(NextStepRequestSchema.safeParse({ user_id: 'u', question_id: 'q', pass: 'skip' }).success).toBe(true);
    expect(NextStepRequestSchema.safeParse({ user_id: 'u', question_id: 'q', pass: 'later' }).success).toBe(false);
  });

  it('bounds the audio and names the formats', () => {
    const base = { user_id: 'u', question_id: 'q', mime_type: 'audio/aac' };
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, audio: 'AAAA' }).success).toBe(true);
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, audio: '' }).success).toBe(false);
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, audio: 'A'.repeat(270_001) }).success).toBe(false);
    expect(SpeechAnswerRequestSchema.safeParse({ ...base, mime_type: 'audio/wav', audio: 'AAAA' }).success).toBe(false);
  });

  it('answers unheard with no next step', () => {
    expect(SpeechAnswerResponseSchema.safeParse({ heard: 'cane', verdict: 'unheard' }).success).toBe(true);
  });
});
```

- [ ] **Step 11: Run core's tests and typecheck**

Run: `(cd packages/core && npx jest && npx tsc --noEmit)`
Expected: PASS, and no type errors in core. The server and mobile typecheck stay red until Tasks 5 and 7, because their exhaustive switches do not know the new types yet.

- [ ] **Step 12: Commit**

```bash
git add packages/core
git commit -m "feat(core): read-aloud and say-the-translation cards, judgeSpoken and the pass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server domain — planner, evidence, generation content, `step`, the transcription prompt

**Files:**
- Modify: `apps/server/src/domain/plan.ts`, test `apps/server/src/domain/plan.test.ts`
- Modify: `apps/server/src/domain/progress.ts`, test `apps/server/src/domain/progress.test.ts`
- Modify: `apps/server/src/domain/distractors.ts`, test `apps/server/src/domain/distractors.test.ts`
- Modify: `apps/server/src/domain/session.ts`, test `apps/server/src/domain/session.test.ts`
- Modify: `apps/server/src/domain/jobs.ts`
- Create: `apps/server/src/domain/speech.ts`, test `apps/server/src/domain/speech.test.ts`

**Interfaces:**
- Consumes (Task 1): `isSpeaking`, `spokenVerdict`, `speakable`, `answerFits`, `AnswerVerdict`, `LlmTranscriptSchema`.
- Produces:
  - `PlanPick = { form; translation; tiles: boolean; speakable: boolean }` and `PlanInput = { listening; speaking: boolean; ordinal }`;
  - `Evidence = { dimension; correct; cap: number | null }`, `READ_ALOUD_MAX_LEVEL = 2`;
  - `TextAnswerType` includes `'read_aloud' | 'say_translation'`, and its answers carry `verdict: AnswerVerdict`;
  - `StepOutcome` gains `{ status: 'unheard' }`;
  - `PrepareSessionPayload.speaking: boolean` (default false);
  - from `domain/speech.ts`: `TRANSCRIBE_MARKER`, `MIN_AUDIO_CHARS`, `MAX_HEARD_CHARS`, `transcriptionSystem(language: LanguageCode): string`, `parseTranscript(raw: string): string | null`, `tidyHeard(text: string): string`.

- [ ] **Step 1: Write the failing planner tests**

Append to `apps/server/src/domain/plan.test.ts` (it already builds picks; add `speakable` to its pick helper so every existing pick is `speakable: true`, and add `speaking: false` to every existing `planSession` input so they stay as they were):

```ts
describe('phase 25 speaking cards in the plan', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({
    form: `word${i}`,
    translation: `מילה${i}`,
    tiles: true,
    speakable: true,
  }));

  it('with speaking off, plans exactly what phase 24 planned', () => {
    for (const ordinal of [0, 1, 2, 3, 4, 5]) {
      for (const listening of [false, true]) {
        const types = planSession(ten, { listening, speaking: false, ordinal }).types;
        expect(types).not.toContain('read_aloud');
        expect(types).not.toContain('say_translation');
      }
    }
    // The second run at ordinal 2: phase 24's tier of two gives listen_choice.
    expect(planSession(ten, { listening: true, speaking: false, ordinal: 2 }).types[7]).toBe('listen_choice');
  });

  it('with listening off and speaking on, ordinal 0 asks read aloud at 8 and say the translation at 10', () => {
    expect(planSession(ten, { listening: false, speaking: true, ordinal: 0 }).types).toEqual([
      'multiple_choice',
      'reverse_choice',
      'typed_translation',
      'matching',
      'matching',
      'matching',
      'matching',
      'read_aloud',
      'letter_tiles',
      'say_translation',
    ]);
  });

  it('four sessions in a row show both speaking cards', () => {
    const seen = new Set([0, 1, 2, 3].flatMap((ordinal) => planSession(ten, { listening: true, speaking: true, ordinal }).types));
    expect(seen).toContain('read_aloud');
    expect(seen).toContain('say_translation');
  });

  it('never gives a speaking card to a phrase of five words', () => {
    const long = ten.map((pick) => ({ ...pick, speakable: false }));
    const types = [0, 1, 2, 3].flatMap((ordinal) => planSession(long, { listening: false, speaking: true, ordinal }).types);
    expect(types).not.toContain('read_aloud');
    expect(types).not.toContain('say_translation');
  });

  it('gives a one-word session no speaking card', () => {
    for (const ordinal of [0, 1, 2]) {
      expect(planSession([ten[0]], { listening: true, speaking: true, ordinal }).types).toEqual([
        expect.not.stringMatching(/read_aloud|say_translation/),
      ]);
    }
  });

  it('never puts two cards of one type in a row, over every size, with speaking on', () => {
    for (let size = 1; size <= 10; size++) {
      for (const ordinal of [0, 1, 2, 3]) {
        const types = planSession(ten.slice(0, size), { listening: true, speaking: true, ordinal }).types;
        types.forEach((type, i) => {
          if (i > 0 && type !== 'matching') expect(type).not.toBe(types[i - 1]);
        });
      }
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/plan.test.ts)`
Expected: FAIL (no speaking types are planned).

- [ ] **Step 3: Implement the planner change**

In `apps/server/src/domain/plan.ts`:

```ts
/** One pick as the plan reads it. `tiles`: the form can be built from tiles.
 *  `speakable`: it is one to four words, so it can be said (phase 25 D3). */
export type PlanPick = { form: string; translation: string; tiles: boolean; speakable: boolean };

/** `listening`: the app said its device has a voice for the target (spec D5).
 *  `speaking`: the app said it can record (phase 25 D4).
 *  `ordinal`: how many list sessions the enrollment had before this one. */
export type PlanInput = { listening: boolean; speaking: boolean; ordinal: number };

/** Each run of three climbs these tiers: recognise, pick the form, produce.
 *  A tier's first type is always eligible. Part B inserts the cloze types at
 *  index 1 of the second and third. Phase 25 appends read aloud, a warm-up, to
 *  the first, and say the translation, recall, to the third. */
export const TIERS: readonly (readonly QuestionType[])[] = [
  ['multiple_choice', 'listen_choice', 'read_aloud'],
  ['reverse_choice', 'letter_tiles'],
  ['typed_translation', 'dictation', 'say_translation'],
];

const SPEAKING: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);
```

In `eligible`, add:

```ts
    case 'read_aloud':
    case 'say_translation':
      // Only reached when speaking is on: planSession removes them otherwise.
      return pick.speakable;
```

In `planSession`, before the loop:

```ts
  // Phase 25. Speaking off, or a session of one word (whose only card "can't
  // speak now" could pass, leaving nothing to score): the speaking types leave
  // the tiers, so the rotation is phase 24's exactly.
  const speaking = input.speaking && picks.length > 1;
  const tiers = speaking ? TIERS : TIERS.map((tier) => tier.filter((type) => !SPEAKING.has(type)));
```

and inside the loop use `tiers[single % RUN]` instead of `TIERS[single % RUN]`.

- [ ] **Step 4: Run the planner tests**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/plan.test.ts)`
Expected: PASS. If an existing phase 24 test fails, it must be because its input lacked `speaking: false` or a pick lacked `speakable`; fix the input, never the expectation.

- [ ] **Step 5: Write the failing evidence tests**

In `apps/server/src/domain/progress.test.ts`, change the evidence helpers from `capped` to `cap` (`const right: Evidence = { dimension: 'written_receptive', correct: true, cap: null }; const cappedRight: Evidence = { ...right, cap: 3 };`, and the table's `piece(dimension, correct, cap: number | null = null)`), map `piece.cap` where it mapped `piece.capped`, then add:

```ts
describe('phase 25 evidence (spec D10)', () => {
  const s = 's1';
  it('reads aloud as spoken_productive capped at 2, crediting nothing below', () => {
    expect(evidenceFor({ senseId: s, type: 'read_aloud', verdict: 'understood' })).toEqual([
      { dimension: 'spoken_productive', correct: true, cap: READ_ALOUD_MAX_LEVEL },
    ]);
    expect(evidenceFor({ senseId: s, type: 'read_aloud', verdict: 'skipped' })).toEqual([]);
  });

  it('says the translation as spoken_productive, credited down to spoken_receptive', () => {
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'understood' })).toEqual([
      { dimension: 'spoken_receptive', correct: true, cap: null },
      { dimension: 'spoken_productive', correct: true, cap: null },
    ]);
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'gave_up' })).toEqual([
      { dimension: 'spoken_productive', correct: false, cap: null },
    ]);
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'alternative' })).toEqual([]);
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'skipped' })).toEqual([]);
  });

  it('reads a typed answer to say the translation as a typed card', () => {
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'exact' })).toEqual(
      evidenceFor({ senseId: s, type: 'typed_translation', verdict: 'exact' }),
    );
    expect(evidenceFor({ senseId: s, type: 'say_translation', verdict: 'wrong' })).toEqual([
      { dimension: 'written_productive', correct: false, cap: null },
    ]);
  });

  it('stops read aloud at level 2, and lifts the cap when say the translation is right the same day', () => {
    const D = '2026-10-07';
    const capped2: Evidence = { dimension: 'spoken_productive', correct: true, cap: 2 };
    const full: Evidence = { dimension: 'spoken_productive', correct: true, cap: null };
    expect(advance(row({ level: 1 }), [capped2], D).level).toBe(2);
    const atTwo = row({ level: 2, lastStepOn: '2026-09-01' });
    expect(advance(atTwo, [capped2], D)).toBe(atTwo);
    expect(advance(atTwo, [capped2, full], D).level).toBe(3);
  });

  it('keeps recognition-format evidence at 3 when a cap of 2 joins it', () => {
    const atThree = row({ level: 3, lastStepOn: '2026-09-01' });
    const D = '2026-10-07';
    expect(advance(atThree, [{ ...right, cap: 3 }, { ...right, cap: 2 }], D)).toBe(atThree);
    expect(advance(row({ level: 2, lastStepOn: '2026-09-01' }), [{ ...right, cap: 3 }, { ...right, cap: 2 }], D).level).toBe(3);
  });
});
```

(`row` is the test file's existing row helper; `READ_ALOUD_MAX_LEVEL` joins its import from `./progress`.)

- [ ] **Step 6: Run to see them fail**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/progress.test.ts)`
Expected: FAIL (`cap` is undefined, and the speaking types are not handled).

- [ ] **Step 7: Implement the evidence**

In `apps/server/src/domain/progress.ts`:

```ts
import type { AnswerVerdict } from '@lang-tutor/core/api';

/** Phase 24. The types answered by an option, and by a text with its verdict.
 *  Phase 25: a speaking card's answer is stored as a text with its verdict too. */
export type ChoiceAnswerType = 'multiple_choice' | 'reverse_choice' | 'listen_choice' | 'matching';
export type TextAnswerType = 'typed_translation' | 'dictation' | 'letter_tiles' | 'read_aloud' | 'say_translation';

export type AnsweredQuestion =
  | { senseId: string; type: ChoiceAnswerType; correct: boolean }
  | { senseId: string; type: TextAnswerType; verdict: AnswerVerdict };

/** One piece of evidence about one dimension. A capped piece alone can carry
 *  a dimension to its cap and no further; null is no cap. */
export type Evidence = { dimension: Dimension; correct: boolean; cap: number | null };

/** The highest level recognition-format evidence alone can reach. */
export const CAPPED_MAX_LEVEL = 3;

/** Phase 25 (spec D10). Reading a shown word aloud: "said it", and no more. */
export const READ_ALOUD_MAX_LEVEL = 2;
```

`evidenceFor` becomes (the typed card's table moves into a helper so a spoken verdict can never fall through a nested switch):

```ts
/** A typed answer's evidence (phase 23 D6), for a typed card and for the
 *  typed form of say the translation (phase 25 D8). */
function typedEvidence(verdict: AnswerVerdict, piece: (dimension: Dimension, correct: boolean) => Evidence): Evidence[] {
  switch (verdict) {
    case 'exact':
      return [piece('written_receptive', true), piece('written_productive', true), piece('spelling', true)];
    case 'near_miss':
      return [piece('written_receptive', true), piece('written_productive', true), piece('spelling', false)];
    case 'wrong':
      // A failure to recall is the productive failure; it says nothing
      // about spelling a form the learner did not produce.
      return [piece('written_productive', false)];
    default:
      // An alternative is right but not this word: nothing about this sense.
      return [];
  }
}

export function evidenceFor(answer: AnsweredQuestion): Evidence[] {
  const piece = (dimension: Dimension, correct: boolean, cap: number | null = null): Evidence => ({
    dimension,
    correct,
    cap,
  });
  switch (answer.type) {
    case 'multiple_choice':
      return [piece('written_receptive', answer.correct)];
    case 'reverse_choice':
      // Picking the form out of four is recognition of it: productive evidence,
      // capped. A failure says nothing about knowing the meaning.
      return answer.correct
        ? [piece('written_receptive', true), piece('written_productive', true, CAPPED_MAX_LEVEL)]
        : [piece('written_productive', false, CAPPED_MAX_LEVEL)];
    case 'typed_translation':
      return typedEvidence(answer.verdict, piece);
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
        case 'wrong':
          // A failure to recognise the word heard; nothing about spelling.
          return [piece('spoken_receptive', false)];
        default:
          // A dictation accepts no alternative (spec D7); unreachable.
          return [];
      }
    case 'letter_tiles':
      // The letters are given: production with support, capped like the
      // reversed card, and never spelling (spec D11).
      return answer.verdict === 'exact'
        ? [piece('written_receptive', true), piece('written_productive', true, CAPPED_MAX_LEVEL)]
        : [piece('written_productive', false, CAPPED_MAX_LEVEL)];
    case 'read_aloud':
      // Phase 25 (spec D10): saying a word that is shown is part of being
      // understood when speaking, and none of recall. Capped at 2, and nothing
      // downward: reading a word aloud shows nothing about understanding it.
      return answer.verdict === 'understood' ? [piece('spoken_productive', true, READ_ALOUD_MAX_LEVEL)] : [];
    case 'say_translation':
      switch (answer.verdict) {
        case 'understood':
          return [piece('spoken_receptive', true), piece('spoken_productive', true)];
        case 'gave_up':
          return [piece('spoken_productive', false)];
        case 'skipped':
        case 'alternative':
          return [];
        default:
          // Answered by typing, after "can't speak now" (spec D8).
          return typedEvidence(answer.verdict, piece);
      }
  }
}
```

In `advance`, replace the cap line:

```ts
  // The day's cap is the highest of its pieces' caps; one uncapped piece lifts it.
  const cap = pieces.some((piece) => piece.cap === null)
    ? MAX_LEVEL
    : Math.max(...pieces.map((piece) => piece.cap!));
```

Search the server for `capped` (`grep -rn "capped" apps/server/src apps/server/tests --include='*.ts'`) and update every remaining use to `cap`.

- [ ] **Step 8: Run the evidence tests**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/progress.test.ts)`
Expected: PASS.

- [ ] **Step 9: Generation content and the task per type**

Test first: append to `apps/server/src/domain/distractors.test.ts`:

```ts
describe('phase 25 generation', () => {
  const row = { senseId: 's', variantId: 'v', lexemeId: 'l', form: 'gatto', lemma: 'gatto', partOfSpeech: 'noun', translation: 'חתול' };
  it('asks the typed task for say the translation, and nothing for read aloud', () => {
    expect(taskFor('say_translation')).toBe('typed');
    expect(taskFor('read_aloud')).toBeNull();
  });
  it('stores the Hebrew as the prompt of both, and the alternatives of say the translation', () => {
    expect(generatedContent(row, 'read_aloud', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: 'חתול',
      options: null,
      alternatives: null,
      tiles: null,
    });
    expect(generatedContent(row, 'say_translation', { distractors: [], alternatives: ['micio'] }, NO_EXTRAS)).toEqual({
      prompt: 'חתול',
      options: null,
      alternatives: ['micio'],
      tiles: null,
    });
  });
});
```

(Import `taskFor`, `generatedContent`, `NOTHING_GENERATED`, `NO_EXTRAS` if the file does not already.)

Then in `apps/server/src/domain/distractors.ts`:

```ts
    case 'typed_translation':
    case 'say_translation':
      return 'typed';
    case 'dictation':
    case 'letter_tiles':
    case 'matching':
    case 'read_aloud':
      return null;
```

and in `generatedContent`:

```ts
    case 'typed_translation':
    case 'say_translation':
      return { ...none, prompt: row.translation, alternatives: generated.alternatives };
    case 'dictation':
    case 'read_aloud':
      return { ...none, prompt: row.translation };
```

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/distractors.test.ts)` — expected PASS.

- [ ] **Step 10: `step` refuses an unheard transcript**

Test first: append to `apps/server/src/domain/session.test.ts`:

```ts
describe('phase 25 speaking cards in step', () => {
  const record = (): SessionRecord => ({
    user_id: 'u1',
    questions: [
      { id: 'r1', type: 'read_aloud', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' },
      { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 },
    ],
    answers: [],
    complete: false,
    completed_at: null,
    status: 'ready',
    source: 'list',
  });

  it('records an understood transcript and advances', () => {
    const outcome = step(record(), 'r1', { heard: 'gatto' });
    expect(outcome).toMatchObject({ status: 'advanced' });
    if (outcome.status === 'advanced') expect(outcome.record.answers[0]).toMatchObject({ verdict: 'understood' });
  });

  it('refuses an unheard transcript and changes nothing (spec D5)', () => {
    expect(step(record(), 'r1', { heard: 'cane' })).toEqual({ status: 'unheard' });
  });

  it('passes a read-aloud card with skip, and refuses show_answer there', () => {
    expect(step(record(), 'r1', { pass: 'skip' })).toMatchObject({ status: 'advanced' });
    expect(step(record(), 'r1', { pass: 'show_answer' })).toEqual({ status: 'wrong_answer_kind' });
  });

  it('replays a transcript sent again for the card just answered', () => {
    const outcome = step(record(), 'r1', { heard: 'gatto' });
    if (outcome.status !== 'advanced') throw new Error('expected advanced');
    expect(step(outcome.record, 'r1', { heard: 'gatto' })).toMatchObject({ status: 'replayed' });
  });
});
```

Then in `apps/server/src/domain/session.ts`, import `isSpeaking` and `spokenVerdict` from `@lang-tutor/core/domain`, add `| { status: 'unheard' }` to `StepOutcome`, and in `step`, right after the `answerFits` check:

```ts
    // Phase 25 (spec D5). A transcript that is not the word records nothing:
    // a recogniser's reject is no evidence and never wrong (phase 20).
    if ('heard' in answer && isSpeaking(expected) && spokenVerdict(expected, answer.heard) === 'unheard') {
      return { status: 'unheard' };
    }
```

Also change the option range check's condition from `expected.type !== 'typed_translation'` to `isChoice(expected)` (import `isChoice`), since `answerFits` now admits more than two kinds.

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/session.test.ts)` — expected PASS.

- [ ] **Step 11: The payload's speaking flag**

In `apps/server/src/domain/jobs.ts`, after `listening`:

```ts
  // Phase 25 (spec D4). Absent in a job enqueued before the deploy: such a
  // session gets no speaking cards.
  speaking: z.boolean().default(false),
```

- [ ] **Step 12: The transcription prompt, pure**

Test first: create `apps/server/src/domain/speech.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { MAX_HEARD_CHARS, TRANSCRIBE_MARKER, parseTranscript, tidyHeard, transcriptionSystem } from './speech';

describe('the transcription prompt (spec D13)', () => {
  it('names the language and carries the marker, never an expected word', () => {
    const system = transcriptionSystem('it');
    expect(system).toContain(TRANSCRIBE_MARKER);
    expect(system).toContain('Italian');
    expect(system).toContain('Do not correct the speaker');
  });

  it('reads the heard words, tidied, and an empty answer as heard nothing', () => {
    expect(parseTranscript('{"heard":"  per   favore "}')).toBe('per favore');
    expect(parseTranscript('')).toBe('');
    expect(parseTranscript('{"heard":""}')).toBe('');
  });

  it('refuses an unreadable answer', () => {
    expect(parseTranscript('not json')).toBeNull();
    expect(parseTranscript('{"said":"gatto"}')).toBeNull();
  });

  it('keeps at most 100 characters', () => {
    expect(tidyHeard('a'.repeat(300))).toHaveLength(MAX_HEARD_CHARS);
  });
});
```

Then create `apps/server/src/domain/speech.ts`:

```ts
import { LlmTranscriptSchema } from '@lang-tutor/core/api/schemas';

import { LANGUAGES, type LanguageCode } from './languages';

/**
 * Phase 25 (spec D13). The pure half of transcription: what the model is told
 * and how its answer is read. services/sessions.ts calls the transcriber and
 * decides what a failure costs.
 */

/** Part of the instruction, and what MockServer matches to tell this call from
 *  the others. Changing the wording means changing the stubs. */
export const TRANSCRIBE_MARKER = 'transcribe the spoken audio';

/** A clip this short (about 750 bytes) holds no word, and Gemini answers an
 *  empty input with a 400: it is "heard nothing" without a call. */
export const MIN_AUDIO_CHARS = 1_000;

/** A transcript is stored as an answer's text (answers_typed_text_length). */
export const MAX_HEARD_CHARS = 100;

/** Blind: the language, never the expected word (spec D1). The POC's wording. */
export function transcriptionSystem(language: LanguageCode): string {
  const name = LANGUAGES[language].name;
  return [
    `Your task: ${TRANSCRIBE_MARKER}. A learner of ${name} is saying a word or a short phrase aloud.`,
    `Write exactly the words that were spoken, in ${name}, in its standard spelling with its accents.`,
    'Do not correct the speaker or guess what they meant: if they said a different word, or mispronounced it into another word, write that.',
    'If nothing intelligible was said, return an empty string.',
  ].join(' ');
}

export function tidyHeard(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, MAX_HEARD_CHARS);
}

/** The heard words, or '' for nothing heard (an empty answer is the provider's
 *  "no content"). Null when the answer cannot be read. */
export function parseTranscript(raw: string): string | null {
  if (raw === '') return '';
  try {
    const parsed = LlmTranscriptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? tidyHeard(parsed.data.heard) : null;
  } catch {
    return null;
  }
}
```

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/speech.test.ts)` — expected PASS.

- [ ] **Step 13: Run every server unit test and the arch check**

Run: `(cd apps/server && npx jest --selectProjects=unit) && npm run lint:arch`
Expected: unit tests PASS except service tests that build `planSession` inputs or call `createSessionService` (they are fixed in Task 5; if any fail now only because a `PlanPick` lacks `speakable` or a `PlanInput` lacks `speaking`, add those fields in the test input). `lint:arch` prints no violation.

- [ ] **Step 14: Commit**

```bash
git add apps/server/src/domain
git commit -m "feat(server): speaking cards in the planner, their evidence and the transcription prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Persistence — migration 0017, the questions, the answers, the evidence read

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create (generated): `apps/server/src/db/migrations/0017_speaking_cards.sql`, `meta/0017_snapshot.json`, `meta/_journal.json` entry
- Modify: `apps/server/src/repo/questions.ts`, `apps/server/src/repo/sessions.ts`, `apps/server/src/repo/progress.ts`
- Test: `apps/server/tests/integration/db/migrations.test.ts`, `apps/server/tests/integration/repo/questions.test.ts`, `apps/server/tests/integration/repo/sessions.test.ts`, `apps/server/tests/integration/repo/progress.test.ts`

**Interfaces:**
- Consumes: Task 1's `AnswerVerdict`, `verdictCorrect`; Task 2's `TextAnswerType`.
- Produces: `questionFrom` builds `read_aloud` (`question` = form, `meaning` = prompt) and `say_translation` (`question` = prompt, `answer` = form, `lemma`, `part_of_speech`, `alternatives`); `insertAnswer(sessionId, position, questionId, { displayIndex } | { text: string; verdict: AnswerVerdict })`; `loadSession` reads every verdict with `verdictCorrect`.

- [ ] **Step 1: Change the checks in `schema.ts`**

In the `questions` table's checks:

```ts
    check(
      'questions_type_known',
      sql`${t.type} in ('multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles', 'read_aloud', 'say_translation')`,
    ),
```

and in `questions_shape_valid`, before `else false end`:

```ts
        when 'read_aloud' then ${t.options} is null and ${t.prompt} is not null and ${t.alternatives} is null and ${t.tiles} is null
        when 'say_translation' then ${t.options} is null and ${t.prompt} is not null and ${t.tiles} is null
          and ${t.alternatives} is not null and coalesce(array_length(${t.alternatives}, 1), 0) <= 5
```

Update the comment above it to say phase 25's two speaking types store the Hebrew as their prompt, and say the translation its alternatives, as the typed card does.

In the `answers` table:

```ts
    check(
      'answers_verdict_known',
      sql`${t.verdict} in ('exact', 'near_miss', 'alternative', 'wrong', 'understood', 'gave_up', 'skipped')`,
    ),
```

- [ ] **Step 2: Generate the migration**

Run: `bash scripts/lane-env.sh npm run db:generate --workspace apps/server -- --name speaking_cards`
Expected: `apps/server/src/db/migrations/0017_speaking_cards.sql` with three `DROP CONSTRAINT`/`ADD CONSTRAINT` pairs, `meta/0017_snapshot.json`, and a journal entry. Open the SQL and prepend this comment (drizzle keeps comments):

```sql
-- Phase 25. Read-aloud and say-the-translation questions, and the verdicts of a
-- spoken answer (spec §2). Every existing row satisfies the new checks
-- unchanged: no question is of a speaking type, and every verdict is one of
-- phase 23's four.
```

Then `bash scripts/lane-env.sh npm run db:check --workspace apps/server` (expected: no drift) and `npm run db:migrate` (expected: migrated).

- [ ] **Step 3: Write the failing migration test**

In `apps/server/tests/integration/db/migrations.test.ts`, follow the file's existing 0016 test (find it with `grep -n "0016" apps/server/tests/integration/db/migrations.test.ts`) and add a 0017 test in the same shape:

- migrate a fresh database to 0016, insert one question of each phase 24 type and one answer of each typed verdict, migrate to 0017, and assert they all still read back unchanged;
- assert a `read_aloud` row with `alternatives` set is refused (`questions_shape_valid`), a `say_translation` row without `alternatives` is refused, and an answer with verdict `'unheard'` is refused (`answers_verdict_known`);
- assert a `read_aloud` row with a prompt only and a `say_translation` row with a prompt and `{}` alternatives are accepted, as are answers with `understood`, `gave_up` and `skipped`.

Reuse the file's own helpers for "migrate to N" and for inserting a question row; copy the 0016 test's structure line for line, changing only the types, columns and verdicts above.

- [ ] **Step 4: Run it**

Run: `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath tests/integration/db/migrations.test.ts'`
Expected: PASS.

- [ ] **Step 5: Build the two wire shapes in `questionFrom`**

In `apps/server/src/repo/questions.ts`, in the first `switch (row.type)` of `questionFrom`:

```ts
    case 'read_aloud':
      return { ...base, type: 'read_aloud', question: row.form, meaning: row.prompt! };
    case 'say_translation':
      return {
        ...base,
        type: 'say_translation',
        question: row.prompt!,
        part_of_speech: row.partOfSpeech,
        answer: row.form,
        lemma: row.lemma,
        alternatives: row.alternatives ?? [],
      };
```

Extend the doc comment: phase 25's read-aloud card shows the form and keeps the Hebrew as its meaning; say the translation asks the Hebrew, as the typed card does.

- [ ] **Step 6: Store and read every verdict**

In `apps/server/src/repo/sessions.ts`: import `AnswerVerdict` (replacing `TypedVerdict`) and `verdictCorrect` from `@lang-tutor/core/domain`. In `loadSession`:

```ts
        if (answer.typedText !== null) {
          const verdict = answer.verdict as AnswerVerdict;
          return {
            question_id: answer.questionId,
            is_correct: verdictCorrect(verdict),
            answer_string: answer.typedText,
            verdict,
          };
        }
```

and widen `insertAnswer`'s parameter to `{ displayIndex: number } | { text: string; verdict: AnswerVerdict }`, with its doc comment noting that a spoken answer (phase 25) is stored the same way: the transcript, or '' for a pass, and its verdict.

In `apps/server/src/repo/progress.ts`, add `'read_aloud'` and `'say_translation'` to `TEXT_TYPES`, and cast the verdict as `AnswerVerdict` (import it from `@lang-tutor/core/api`) instead of `TypedVerdict`.

- [ ] **Step 7: Write the failing repository round trips**

`apps/server/tests/integration/repo/questions.test.ts` — add, using `insertListSession` from `tests/support/questions.ts` with `types: ['read_aloud', 'say_translation']` and `alternatives: ['lamp']`:

```ts
  it('stores and reads back both speaking types (phase 25)', async () => {
    const asked = [];
    for (const [lemma, translation] of [
      ['tome', 'ספר'],
      ['lantern', 'פנס'],
    ]) {
      const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
      asked.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
    }
    const { questions } = await insertListSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      asked,
      alternatives: ['lamp'],
      types: ['read_aloud', 'say_translation'],
    });
    expect(questions[0]).toEqual({ id: questions[0].id, type: 'read_aloud', vocab_term_id: asked[0].lexemeId, question: 'tome', meaning: 'ספר' });
    expect(questions[1]).toEqual({
      id: questions[1].id,
      type: 'say_translation',
      vocab_term_id: asked[1].lexemeId,
      question: 'פנס',
      part_of_speech: 'noun',
      answer: 'lantern',
      lemma: 'lantern',
      alternatives: ['lamp'],
    });
  });
```

(Use the file's existing setup for `t`, `seedUser`, `enrollmentOf` and `seedSavedSenses`; add any import it lacks.)

`apps/server/tests/integration/repo/sessions.test.ts` — add a test that inserts the same two-card session, writes `insertAnswer(sessionId, 0, q0, { text: 'tome', verdict: 'understood' })` and `insertAnswer(sessionId, 1, q1, { text: '', verdict: 'skipped' })` in one transaction, and asserts `loadSession` reads `[{ is_correct: true, answer_string: 'tome', verdict: 'understood' }, { is_correct: false, answer_string: '', verdict: 'skipped' }]` (with `question_id`s).

`apps/server/tests/integration/repo/progress.test.ts` — add a test that `findSessionEvidence` reads those two answers as `{ type: 'read_aloud', verdict: 'understood' }` and `{ type: 'say_translation', verdict: 'skipped' }` with their sense ids.

- [ ] **Step 8: Run them**

Run each with `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath <file>'`.
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db apps/server/src/repo apps/server/tests/integration
git commit -m "feat(server): store read-aloud and say-the-translation questions and spoken verdicts (migration 0017)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The transcriber — contract, provider, config, fakes

**Files:**
- Create: `apps/server/src/services/speech.ts`
- Modify: `apps/server/src/providers/gemini.ts`, test `apps/server/src/providers/gemini.test.ts`
- Modify: `apps/server/src/config.ts`, test `apps/server/src/config.test.ts`
- Modify: `apps/server/tests/support/fakes.ts`
- Modify: `docs/adr/adr-0002-di-with-closures.md` (R6's list)

**Interfaces:**
- Produces:
  - `services/speech.ts`: `LlmAudioRequest = { system: string; audio: string; mimeType: string; schema: ZodType }`, `SpeechTranscriber = (request: LlmAudioRequest) => Promise<string>`;
  - `createGeminiTranscriber(deps: { fetch; baseUrl; apiKey; model; timeoutMs })` returning `(request: { system; audio; mimeType; schema }) => Promise<string>` (raw JSON text, '' for no content, throws `LlmUnavailable`);
  - `Config.speechTimeoutMs: number` (default 8 000, from `SPEECH_TIMEOUT_MS`);
  - `createFakeTranscriber(...replies: (string | Error)[])` with `.calls: LlmAudioRequest[]`.

- [ ] **Step 1: The contract**

Create `apps/server/src/services/speech.ts`:

```ts
import type { ZodType } from 'zod';

/**
 * Phase 25 (spec D13). The audio counterpart of LlmClient: one JSON-shaped
 * completion over one clip. Types only, as llm.ts is, so a provider's name
 * never reaches the service layer; composition.ts is where the assignment is
 * checked (ADR 0001 R11). LlmClient stays text only: widening it for audio
 * would widen it for every caller.
 */
export type LlmAudioRequest = {
  system: string;
  /** The clip, base64. */
  audio: string;
  /** One of SpeechMimeTypeSchema's. */
  mimeType: string;
  /** The canonical Zod schema of the answer; each provider converts it. */
  schema: ZodType;
};

/**
 * Returns the model's raw JSON text; parsing happens once, in domain/speech.ts.
 * An empty string means the provider produced no content. Every failure throws
 * `LlmUnavailable`.
 */
export type SpeechTranscriber = (request: LlmAudioRequest) => Promise<string>;
```

- [ ] **Step 2: Write the failing provider tests**

In `apps/server/src/providers/gemini.test.ts`, follow the existing `createGeminiClient` tests' fake-fetch helper and add:

```ts
describe('createGeminiTranscriber (phase 25)', () => {
  const schema = z.object({ heard: z.string() });

  it('sends the clip as inlineData, the instruction as the system part, and thinking off', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"heard":"gatto"}' }] } }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const transcribe = createGeminiTranscriber({ fetch, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 1_000 });

    expect(await transcribe({ system: 'transcribe the spoken audio', audio: 'QUJD', mimeType: 'audio/aac', schema })).toBe('{"heard":"gatto"}');
    expect(seen[0].url).toBe('http://g/v1beta/models/m:generateContent');
    expect((seen[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const body = JSON.parse(String(seen[0].init.body));
    expect(body.systemInstruction.parts[0].text).toBe('transcribe the spoken audio');
    expect(body.contents[0].parts).toEqual([{ inlineData: { mimeType: 'audio/aac', data: 'QUJD' } }]);
    expect(body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  });

  it('answers an empty candidate with the empty string', async () => {
    const fetch = (async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const transcribe = createGeminiTranscriber({ fetch, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 1_000 });
    expect(await transcribe({ system: 's', audio: 'QUJD', mimeType: 'audio/aac', schema })).toBe('');
  });

  it('turns a failure status and a timeout into LlmUnavailable', async () => {
    const failing = (async () => new Response('{}', { status: 400 })) as unknown as typeof globalThis.fetch;
    await expect(
      createGeminiTranscriber({ fetch: failing, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 1_000 })({
        system: 's',
        audio: 'QUJD',
        mimeType: 'audio/aac',
        schema,
      }),
    ).rejects.toBeInstanceOf(LlmUnavailable);
    const hanging = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof globalThis.fetch;
    await expect(
      createGeminiTranscriber({ fetch: hanging, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 10 })({
        system: 's',
        audio: 'QUJD',
        mimeType: 'audio/aac',
        schema,
      }),
    ).rejects.toThrow(/timed out after 10ms/);
  });
});
```

(Import `z` from `zod`, `LlmUnavailable` from `../errors`, and `createGeminiTranscriber` from `./gemini`, if not already imported.)

- [ ] **Step 3: Run to see them fail**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/providers/gemini.test.ts)`
Expected: FAIL (`createGeminiTranscriber` is not exported).

- [ ] **Step 4: Implement the provider, sharing the call with `createGeminiClient`**

In `apps/server/src/providers/gemini.ts`, pull the body of `createGeminiClient`'s returned function (the abort timer, the `fetch`, the error mapping and the candidate read) into one module-private helper, and build both factories on it:

```ts
type GeminiDeps = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

/** One generateContent call and its envelope: the budget, the key header, the
 *  failure mapping and the first candidate's text ('' for none). */
async function generate(deps: GeminiDeps, body: Record<string, unknown>): Promise<string> {
  const endpoint = `${deps.baseUrl}/v1beta/models/${deps.model}:generateContent`;
  // One budget for the whole call. No retry: a learner who taps retry *is*
  // the retry, and three sequential ten-second waits would be worse than one.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  let response: Response;
  try {
    response = await deps.fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // A header, never `?key=`: a query parameter puts the secret into
        // URLs, access logs and any intermediary proxy.
        'x-goog-api-key': deps.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Abort and network failure arrive here identically. The message names the
    // cause and never the key.
    throw new LlmUnavailable(controller.signal.aborted ? `timed out after ${deps.timeoutMs}ms` : 'network failure');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new LlmUnavailable(`responded ${response.status}`);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new LlmUnavailable('response body was not JSON');
  }

  // A safety block arrives as promptFeedback.blockReason with no candidate.
  // Empty string is the contract's "no content" — the input was refused, the
  // provider was not broken.
  const text = (json as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })?.candidates?.[0]?.content
    ?.parts?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

export function createGeminiClient(deps: GeminiDeps) {
  return (request: { system: string; user: string; schema: ZodType }): Promise<string> =>
    generate(deps, {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.schema),
      },
    });
}

/**
 * Phase 25 (spec D13). The same provider over one audio clip. Thinking is off:
 * transcribing a word gains nothing from reasoning, and the POC measured it as
 * about 0.3 s of every call. `thinkingBudget` is the 2.5 family's field
 * (GEMINI_MODEL is gemini-2.5-flash); a change of model re-checks it.
 */
export function createGeminiTranscriber(deps: GeminiDeps) {
  return (request: { system: string; audio: string; mimeType: string; schema: ZodType }): Promise<string> =>
    generate(deps, {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: request.mimeType, data: request.audio } }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.schema),
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
}
```

Keep the file's top comment, and add one line to it saying the module now also carries an audio call.

- [ ] **Step 5: Run every provider test**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/providers/gemini.test.ts)`
Expected: PASS (the existing `createGeminiClient` tests unchanged).

- [ ] **Step 6: The speech budget in config**

Test first: in `apps/server/src/config.test.ts`:

```ts
  it('reads the speech budget, defaulting to 8 s (phase 25)', () => {
    expect(loadConfig({}).speechTimeoutMs).toBe(8_000);
    expect(loadConfig({ SPEECH_TIMEOUT_MS: '3000' }).speechTimeoutMs).toBe(3_000);
    expect(loadConfig({ SPEECH_TIMEOUT_MS: 'nonsense' }).speechTimeoutMs).toBe(8_000);
  });
```

Then in `apps/server/src/config.ts`: add `speechTimeoutMs: number;` to `Config`,

```ts
// Phase 25 (spec D13). One transcription, which the POC measured at 1.5–2 s.
// Past this the card says it could not check and offers another try.
const DEFAULT_SPEECH_TIMEOUT_MS = 8_000;
```

and in `loadConfig`: `speechTimeoutMs: Number(env.SPEECH_TIMEOUT_MS) || DEFAULT_SPEECH_TIMEOUT_MS,`.

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/config.test.ts)` — expected PASS.

- [ ] **Step 7: A fake transcriber for service tests**

In `apps/server/tests/support/fakes.ts`, next to `createFakeLlmClient`:

```ts
/** Phase 25. Replies in order, the last repeating, as createFakeLlmClient does.
 *  An Error in the queue is thrown. */
export function createFakeTranscriber(...replies: (string | Error)[]) {
  const calls: LlmAudioRequest[] = [];
  const queue = [...replies];
  const transcriber: SpeechTranscriber = async (request) => {
    calls.push(request);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(transcriber, { calls });
}
```

with `import type { LlmAudioRequest, SpeechTranscriber } from '../../src/services/speech';`.

- [ ] **Step 8: ADR 0002's factory list**

In `docs/adr/adr-0002-di-with-closures.md`, R6's list: add `createGeminiTranscriber` after `createGeminiClient`. Extend the sentence after the list: "`createGeminiClient` and `createGeminiTranscriber` are annotated at their call sites in `composition.ts` …". Bump the **Date** line with `; R6's list gains createGeminiTranscriber 2026-10-07 (phase 25)`.

- [ ] **Step 9: Run the unit suite and the arch check**

Run: `(cd apps/server && npx jest --selectProjects=unit src/providers src/config.test.ts src/domain) && npm run lint:arch`
Expected: PASS, no violation.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/services/speech.ts apps/server/src/providers apps/server/src/config.ts apps/server/src/config.test.ts apps/server/tests/support/fakes.ts docs/adr/adr-0002-di-with-closures.md
git commit -m "feat(server): a speech transcriber contract and its Gemini provider, thinking off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The service and the route — answer by speech, pass, the speaking flag

**Files:**
- Modify: `apps/server/src/services/sessions.ts`, tests `apps/server/src/services/sessions.test.ts`, `sessions.prepare.test.ts`, `sessions.progress.test.ts`
- Create: `apps/server/src/services/sessions.speech.test.ts`
- Modify: `apps/server/src/routes/sessions.ts`, `apps/server/src/composition.ts`, `apps/server/src/index.ts`
- Modify: `apps/server/tests/support/fakes.ts` (`createFakeAppDeps`), `apps/server/tests/support/serverDeps.ts`, `apps/server/tests/support/mockServer.ts`
- Modify: `apps/server/src/openapi.test.ts`
- Test: `apps/server/tests/integration/routes/sessions.speech.test.ts` (new), `apps/server/tests/integration/composition.test.ts` (if it lists `createServerDeps`' inputs)

**Interfaces:**
- Consumes: Task 1 (`isSpeaking`, `spokenVerdict`, `speakable`, `SpeechVerdict`), Task 2 (`PlanPick.speakable`, `PlanInput.speaking`, `step`'s `unheard`, `transcriptionSystem`, `parseTranscript`, `MIN_AUDIO_CHARS`, `TRANSCRIBE_MARKER`), Task 4 (`SpeechTranscriber`, `createGeminiTranscriber`, `speechTimeoutMs`, `createFakeTranscriber`).
- Produces:
  - `createSessionService({ transaction, rng, now, logger, llm, transcriber })`;
  - `createNextSession(enrollmentId, { listening: boolean; speaking: boolean })`;
  - `answerBySpeech(sessionId, { userId, questionId, audio, mimeType }): Promise<SpeechResult>` where `SpeechResult = { heard: string; verdict: SpeechVerdict; session: SessionResult | null }`;
  - `submitAnswer` accepts `{ pass }` (and `{ heard }`, internally);
  - `POST /api/sessions/{id}/speech`: 200 `SpeechAnswerResponse`; 400 invalid body or not a speaking card; 404 unknown session or another learner's; 409 not current, or not ready; 413 body over 300 KB; 502 the transcriber failed.
  - `createServerDeps(io)` gains `speechTimeoutMs: number`; `createTestServerDeps` passes `8_000` unless given `speechTimeoutMs`.
  - `expectTranscription(ns, heard, opts?: { once?: boolean })` in `tests/support/mockServer.ts`.

- [ ] **Step 1: Write the failing service tests**

Create `apps/server/src/services/sessions.speech.test.ts`:

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
import { TRANSCRIBE_MARKER } from '../domain/speech';
import type { SessionRecord, SessionState } from '../domain/session';
import { AnswerKindMismatch, LlmUnavailable, QuestionDesynced, SessionNotFound } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const STATE: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'ready', source: 'list' };
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'it', created_at: '' };
const READ: Question = { id: 'r1', type: 'read_aloud', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' };
const CHOICE: Question = { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 };
const AUDIO = 'A'.repeat(2_000);

const record = (answers: SessionRecord['answers'] = []): SessionRecord => ({
  user_id: 'u1',
  questions: [READ, CHOICE],
  answers,
  complete: false,
  completed_at: null,
  status: 'ready',
  source: 'list',
});

function setup(transcriber: ReturnType<typeof createFakeTranscriber>, loaded: SessionRecord = record()) {
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
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment }),
    rng: testRng(7),
    now: createFakeClock(1_000, 2_500),
    logger,
    llm: createFakeLlmClient(''),
    transcriber,
  });
  return { service, inserted, logger };
}

const attempt = { userId: 'u1', questionId: 'r1', audio: AUDIO, mimeType: 'audio/aac' };

describe('answerBySpeech (spec D5)', () => {
  it('records an understood transcript, with the instruction for the target language', async () => {
    const transcriber = createFakeTranscriber('{"heard":"il gatto"}');
    const { service, inserted } = setup(transcriber);
    const result = await service.answerBySpeech(SESSION, attempt);
    expect(result).toMatchObject({ heard: 'il gatto', verdict: 'understood' });
    expect(result.session?.answers[0]).toMatchObject({ verdict: 'understood', is_correct: true });
    expect(inserted).toEqual([[SESSION, 0, 'r1', { text: 'il gatto', verdict: 'understood' }]]);
    expect(transcriber.calls[0]).toMatchObject({ audio: AUDIO, mimeType: 'audio/aac' });
    expect(transcriber.calls[0].system).toContain(TRANSCRIBE_MARKER);
    expect(transcriber.calls[0].system).toContain('Italian');
    expect(transcriber.calls[0].system).not.toContain('gatto');
  });

  it('writes nothing when the word was not understood', async () => {
    const { service, inserted } = setup(createFakeTranscriber('{"heard":"cane"}'));
    expect(await service.answerBySpeech(SESSION, attempt)).toEqual({ heard: 'cane', verdict: 'unheard', session: null });
    expect(inserted).toEqual([]);
  });

  it('hears nothing in a clip too short to hold a word, without a model call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const { service } = setup(transcriber);
    expect(await service.answerBySpeech(SESSION, { ...attempt, audio: 'AAAA' })).toMatchObject({ heard: '', verdict: 'unheard' });
    expect(transcriber.calls).toHaveLength(0);
  });

  it('refuses before transcribing: another learner, a card that is not current, a card that is not spoken', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const { service } = setup(transcriber);
    await expect(service.answerBySpeech(SESSION, { ...attempt, userId: 'u2' })).rejects.toBeInstanceOf(SessionNotFound);
    await expect(service.answerBySpeech(SESSION, { ...attempt, questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    const atChoice = setup(transcriber, record([{ question_id: 'r1', is_correct: true, answer_string: 'gatto', verdict: 'understood' }]));
    await expect(atChoice.service.answerBySpeech(SESSION, { ...attempt, questionId: 'c2' })).rejects.toBeInstanceOf(AnswerKindMismatch);
    expect(transcriber.calls).toHaveLength(0);
  });

  it('replays an answered speaking card without a model call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const answered = record([{ question_id: 'r1', is_correct: true, answer_string: 'gatto', verdict: 'understood' }]);
    const { service, inserted } = setup(transcriber, answered);
    expect(await service.answerBySpeech(SESSION, attempt)).toMatchObject({ heard: 'gatto', verdict: 'understood' });
    expect(transcriber.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('turns an unreadable answer into LlmUnavailable, and a provider failure passes through', async () => {
    await expect(setup(createFakeTranscriber('nonsense')).service.answerBySpeech(SESSION, attempt)).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
    await expect(
      setup(createFakeTranscriber(new LlmUnavailable('responded 503'))).service.answerBySpeech(SESSION, attempt),
    ).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('logs speech_judged with the wait, and never the audio', async () => {
    const { service, logger } = setup(createFakeTranscriber('{"heard":"gatto"}'));
    await service.answerBySpeech(SESSION, attempt);
    const event = logger.infos.find((entry) => (entry as { event?: string }).event === 'speech_judged');
    expect(event).toEqual({
      event: 'speech_judged',
      session_id: SESSION,
      question_type: 'read_aloud',
      verdict: 'understood',
      heard: 'gatto',
      transcribe_ms: 1_500,
      bytes: 1_500,
      mime_type: 'audio/aac',
    });
  });
});

describe('a pass (spec D5, D8)', () => {
  it('stores a skip as an empty text with its verdict', async () => {
    const { service, inserted } = setup(createFakeTranscriber(''));
    const result = await service.submitAnswer(SESSION, 'r1', { pass: 'skip' });
    expect(inserted).toEqual([[SESSION, 0, 'r1', { text: '', verdict: 'skipped' }]]);
    expect(result.answers[0]).toMatchObject({ is_correct: false, verdict: 'skipped' });
  });
});
```

Before running, check the field name `createFakeLogger` records info calls under (`grep -n "infos\|info:" apps/server/tests/support/fakes.ts`) and use it in the last-but-one test. `bytes` is `Math.floor(audio.length * 3 / 4)`.

- [ ] **Step 2: Run to see them fail**

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/services/sessions.speech.test.ts)`
Expected: FAIL (`transcriber` is not a dependency, and `answerBySpeech` is not a function).

- [ ] **Step 3: Implement the service**

In `apps/server/src/services/sessions.ts`:

Imports: `type SpeechVerdict` from `@lang-tutor/core/api`; `isSpeaking`, `speakable`, `spokenVerdict` from `@lang-tutor/core/domain`; `currentQuestion` from `../domain/session`; `MIN_AUDIO_CHARS`, `parseTranscript`, `transcriptionSystem` from `../domain/speech`; `LlmTranscriptSchema` from `@lang-tutor/core/api/schemas`; `LlmUnavailable` from `../errors`; `type SpeechTranscriber` from `./speech`.

Add, below `SessionResult`:

```ts
/** Phase 25. What one spoken attempt came to: the transcript, how it was
 *  judged, and the session when the answer was recorded (null when not). */
export type SpeechResult = { heard: string; verdict: SpeechVerdict; session: SessionResult | null };
```

`createSessionService` takes `transcriber: SpeechTranscriber` beside `llm`.

`createNextSession`'s options become `{ listening: boolean; speaking: boolean }`, and its enqueue adds `speaking: options.speaking,`.

In `prepareSession`, the plan's picks and input become:

```ts
      const plan = planSession(
        read.context.map((row) => ({
          form: row.form,
          translation: row.translation,
          tiles: tileEligible(row.form),
          speakable: speakable(row.form),
        })),
        { listening: payload.listening, speaking: payload.speaking, ordinal: payload.ordinal },
      );
```

In `submitAnswer`, handle the new outcome and store any non-option answer as its recorded text:

```ts
        const outcome = step(loaded, questionId, answer);
        if (outcome.status === 'invalid_question') throw new QuestionDesynced(questionId);
        if (outcome.status === 'wrong_answer_kind') throw new AnswerKindMismatch(questionId);
        if (outcome.status === 'out_of_range') {
          throw new OptionOutOfRange('option_index' in answer ? answer.option_index : -1);
        }
        // answerBySpeech judges before it gets here, with the same pure function.
        if (outcome.status === 'unheard') throw new Error('an unheard transcript reached submitAnswer');
```

and

```ts
        const recorded = outcome.record.answers[loaded.answers.length];
        await repos.session.insertAnswer(
          sessionId,
          loaded.answers.length,
          questionId,
          'option_index' in answer
            ? { displayIndex: answer.option_index }
            : { text: recorded.answer_string, verdict: recorded.verdict! },
        );
```

Add the use case after `submitAnswer`:

```ts
    /**
     * Phase 25 (spec D5). One spoken attempt at the current card. The card is
     * checked first, so no model call is spent on a stale or wrong request; the
     * clip is transcribed outside any transaction (ADR 0001 R8); and an
     * understood answer is recorded through submitAnswer, exactly as a
     * next-step is. A transcript that is not the word writes nothing.
     */
    answerBySpeech: async (
      sessionId: string,
      input: { userId: string; questionId: string; audio: string; mimeType: string },
    ): Promise<SpeechResult> => {
      const checked = await transaction(async (repos) => {
        const loaded = await repos.session.loadSession(sessionId);
        // Another learner's session is answered as an unknown one.
        if (!loaded || loaded.user_id !== input.userId) throw new SessionNotFound(sessionId);
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }
        // A retry of an attempt already recorded: the stored answer, no call.
        const last = loaded.answers[loaded.answers.length - 1];
        if (last && last.question_id === input.questionId) {
          const progress = await progressOf(repos, sessionId, loaded);
          const replay: SpeechResult = {
            heard: last.answer_string,
            verdict: last.verdict === 'alternative' ? 'alternative' : 'understood',
            session: { ...loaded, progress },
          };
          return { replay };
        }
        const current = currentQuestion(loaded);
        if (!current || current.id !== input.questionId) throw new QuestionDesynced(input.questionId);
        if (!isSpeaking(current)) throw new AnswerKindMismatch(input.questionId);
        const state = await repos.session.findState(sessionId);
        const enrolled = state ? await repos.enrollment.findById(state.enrollmentId) : undefined;
        if (!enrolled) throw new SessionNotFound(sessionId);
        return { current, language: enrolled.target_language as LanguageCode };
      });
      if ('replay' in checked) return checked.replay;

      const started = now();
      let heard = '';
      if (input.audio.length >= MIN_AUDIO_CHARS) {
        const raw = await transcriber({
          system: transcriptionSystem(checked.language),
          audio: input.audio,
          mimeType: input.mimeType,
          schema: LlmTranscriptSchema,
        });
        const parsed = parseTranscript(raw);
        if (parsed === null) throw new LlmUnavailable('the transcript was unreadable');
        heard = parsed;
      }
      const transcribeMs = now() - started;

      const verdict = spokenVerdict(checked.current, heard);
      const session = verdict === 'unheard' ? null : await service.submitAnswer(sessionId, input.questionId, { heard });
      logger.info({
        event: 'speech_judged',
        session_id: sessionId,
        question_type: checked.current.type,
        verdict,
        heard,
        transcribe_ms: transcribeMs,
        bytes: Math.floor((input.audio.length * 3) / 4),
        mime_type: input.mimeType,
      });
      return { heard, verdict, session };
    },
```

`answerBySpeech` calls `submitAnswer` on the same object, so build the object as a `const service = { … }` and `return service;` at the end of `createSessionService` (the type `SessionService = ReturnType<typeof createSessionService>` is unchanged).

Every existing `createSessionService({ … })` in `sessions.test.ts`, `sessions.prepare.test.ts` and `sessions.progress.test.ts` gains `transcriber: createFakeTranscriber('')`, and every `createNextSession(…, { listening })` call gains `speaking: false`. In `sessions.prepare.test.ts`, add one case: a payload with `speaking: true` and two speakable picks at ordinal 0 plans `say_translation` nowhere and `read_aloud` nowhere for two picks (one run), and a payload without `speaking` parses with `speaking: false`. Use the file's existing helpers.

- [ ] **Step 4: Run the service tests**

Run: `(cd apps/server && npx jest --selectProjects=unit src/services)`
Expected: PASS.

- [ ] **Step 5: Wire the transcriber**

`apps/server/src/composition.ts`: import `createGeminiTranscriber` with `createGeminiClient` and `type SpeechTranscriber` from `./services/speech`; add to `createServerDeps`' `io`:

```ts
  // Phase 25 (spec D13). One transcription's budget: short, because a learner
  // is waiting on a card.
  speechTimeoutMs: number;
```

and before the return:

```ts
  // Phase 25. The same provider over audio. Named here and nowhere else
  // (ADR 0001 R11); the annotation checks it satisfies the contract.
  const transcriber: SpeechTranscriber = createGeminiTranscriber({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.speechTimeoutMs,
  });
```

and pass `transcriber` to `createSessionService`.

`apps/server/src/index.ts`: pass `speechTimeoutMs: config.speechTimeoutMs,`.
`apps/server/tests/support/serverDeps.ts`: add `speechTimeoutMs?: number;` to `createTestServerDeps`' input (this is the test composition root, so the optional is allowed there as `translationTimeoutMs?` is) and pass `speechTimeoutMs: io.speechTimeoutMs ?? 8_000`.
If `apps/server/tests/integration/composition.test.ts` builds `createServerDeps` directly, add `speechTimeoutMs: 8_000` there too.
`apps/server/tests/support/fakes.ts` `createFakeAppDeps`: add `answerBySpeech: unreachable,`.

- [ ] **Step 6: The route**

In `apps/server/src/routes/sessions.ts`: import `SpeechAnswerRequestSchema` and `SpeechAnswerResponseSchema` from core's schemas, `bodyLimit` from `hono/body-limit`, and `LlmUnavailable` from `../errors`.

```ts
const speechRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/speech',
  tags: ['sessions'],
  summary: 'Answer the current speaking card by voice',
  description:
    'Takes one recorded attempt at the current `read_aloud` or `say_translation` card, as base64 audio (`audio/aac`, `audio/mp4` or `audio/webm`, at most 200 KB). The server transcribes it with a language model, which costs money on every call, and judges the transcript. `understood` and `alternative` record the answer and carry `next`, the next-step response. `unheard` records nothing: the card stays current and may be tried again. Re-sending an attempt that was recorded replays it without a model call.',
  request: {
    params: sessionIdParam,
    body: { required: true, content: { 'application/json': { schema: SpeechAnswerRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SpeechAnswerResponseSchema } },
      description: 'The attempt was judged. `next` is present when the answer was recorded.',
    },
    400: failure('The request body did not validate, or the current card is not a speaking card.'),
    404: failure('No session has this id, or it is not this learner’s.'),
    409: failure("`question_id` is not the session's current question, or the session is not ready (`session_not_ready`)."),
    413: failure('The body is over 300 KB.'),
    502: failure('The transcription failed or timed out; the card may be tried again.'),
  },
});
```

Update `nextStepRoute`'s description to add: "A speaking card is answered by voice through `/speech`, or here with `pass`: `skip` passes it (a read-aloud card takes only this), and `show_answer` gives up on a `say_translation` card, which is wrong. A `say_translation` card also takes `text`, answered as a typed card." Update `createSessionRoute`'s description: "… listening cards only when the request says `listening: true`, and speaking cards only when it says `speaking: true`."

In `createSessionsRouter`: the create handler passes `{ listening: listening ?? false, speaking: speaking ?? false }` (destructure `speaking`); the next-step handler builds the answer as

```ts
    const answer =
      'text' in body ? { text: body.text } : 'pass' in body ? { pass: body.pass } : { option_index: body.option_index };
```

and register the body limit and the handler:

```ts
  // Phase 25 (spec D13). 270 000 characters of base64 and the JSON around them.
  router.use('/sessions/:id/speech', bodyLimit({ maxSize: 300 * 1024, onError: (c) => c.json({ error: 'audio too large' }, 413) }));

  router.openapi(speechRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await sessions.answerBySpeech(id, {
        userId: body.user_id,
        questionId: body.question_id,
        audio: body.audio,
        mimeType: body.mime_type,
      });
      return c.json(
        {
          heard: result.heard,
          verdict: result.verdict,
          ...(result.session ? { next: buildNextStepResponse(id, result.session) } : {}),
        },
        200,
      );
    } catch (error) {
      if (error instanceof SessionNotFound) return c.json({ error: 'session not found' }, 404);
      if (error instanceof SessionNotReady) return c.json({ error: 'session_not_ready' }, 409);
      if (error instanceof QuestionDesynced) {
        return c.json({ error: "question_id does not match the session's current question" }, 409);
      }
      if (error instanceof AnswerKindMismatch) return c.json({ error: 'the current card is not a speaking card' }, 400);
      if (error instanceof LlmUnavailable) return c.json({ error: 'speech unavailable' }, 502);
      throw error;
    }
  });
```

- [ ] **Step 7: The published document**

In `apps/server/src/openapi.test.ts`: the path list becomes fourteen, with `'/api/sessions/{id}/speech'` between `NEXT_STEP` and `'/api/sessions/{id}/skip'`, and the test's name says fourteen. Add:

```ts
describe('POST /api/sessions/{id}/speech in the published document', () => {
  it('declares every status it can return, and says it costs money', async () => {
    const doc = await openApiDocument();
    const op = doc.paths['/api/sessions/{id}/speech'].post;
    expect(Object.keys(op.responses).sort()).toEqual(['200', '400', '404', '409', '413', '502']);
    expect(op.description).toMatch(/costs money/);
  });
});
```

Run: `(cd apps/server && npx jest --selectProjects=unit --runTestsByPath src/openapi.test.ts)` — expected PASS.

- [ ] **Step 8: A MockServer stub for the transcription**

In `apps/server/tests/support/mockServer.ts`, import `TRANSCRIBE_MARKER` from `../../src/domain/speech` and add:

```ts
/**
 * Phase 25. The transcription call's answer, matched on TRANSCRIBE_MARKER so a
 * generation or translation stub in the same namespace cannot answer it, and
 * the other way round. `once` consumes it, in registration order.
 */
export async function expectTranscription(ns: string, heard: string, opts: { once?: boolean } = {}): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${TRANSCRIBE_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ heard })),
      },
      ...(opts.once ? { times: { remainingTimes: 1, unlimited: false } } : {}),
    },
  });
}
```

- [ ] **Step 9: Write the failing route integration tests**

Create `apps/server/tests/integration/routes/sessions.speech.test.ts`. Copy the setup of `apps/server/tests/integration/routes/sessions.test.ts` (its `beforeEach`/`afterEach`, `postJson`), and build the app with a MockServer namespace:

```ts
function buildTestApp(ns: string) {
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) });
  app.route('/api', createSessionsRouter(deps.sessions));
  return app;
}

/** A ready list session: read aloud, say the translation, today's card. */
async function startSpeaking() {
  const asked = [];
  for (const [lemma, translation] of [
    ['tome', 'ספר'],
    ['lantern', 'פנס'],
    ['quill', 'נוצה'],
  ]) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
    asked.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
  return insertListSession(t.db, {
    userId: 'u_1',
    enrollmentId: enrollmentOf('u_1'),
    asked,
    alternatives: ['lamp'],
    types: ['read_aloud', 'say_translation', 'multiple_choice'],
  });
}

const AUDIO = 'A'.repeat(2_000);
```

Tests (each `const ns = mockNamespace(<test name>)`, `afterEach` clears it with `clearNamespace`):

```ts
describe('POST /api/sessions/:id/speech', () => {
  it('records an understood attempt and carries the next step; an unheard one records nothing', async () => {
    const ns = mockNamespace('speech-understood');
    await expectTranscription(ns, 'tomb', { once: true });
    await expectTranscription(ns, 'the tome', { once: true });
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    const speak = () =>
      postJson(app, `/api/sessions/${sessionId}/speech`, { user_id: 'u_1', question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO });

    const missed = await speak();
    expect(missed.status).toBe(200);
    expect(await missed.json()).toEqual({ heard: 'tomb', verdict: 'unheard' });

    const heard = await speak();
    const body = await heard.json();
    expect(body).toMatchObject({ heard: 'the tome', verdict: 'understood', next: { complete: false, question: { type: 'say_translation' } } });
  });

  it('answers say the translation with an alternative, then completes with a skip left out of the score', async () => {
    const ns = mockNamespace('speech-score');
    await expectTranscription(ns, 'lamp');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    expect((await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[0].id, pass: 'skip' })).status).toBe(200);
    const said = await (
      await postJson(app, `/api/sessions/${sessionId}/speech`, { user_id: 'u_1', question_id: questions[1].id, mime_type: 'audio/aac', audio: AUDIO })
    ).json();
    expect(said).toMatchObject({ verdict: 'alternative' });
    const done = await (
      await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[2].id, option_index: 0 })
    ).json();
    expect(done.score.total).toBe(2);
    expect(done.missed_questions.map((m: { question: { id: string } }) => m.question.id)).not.toContain(questions[0].id);
  });

  it('stores a long transcript truncated to 100 characters', async () => {
    const ns = mockNamespace('speech-long');
    await expectTranscription(ns, `tome ${'a'.repeat(150)}`);
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    const res = await postJson(app, `/api/sessions/${sessionId}/speech`, { user_id: 'u_1', question_id: questions[0].id, mime_type: 'audio/aac', audio: AUDIO });
    expect(res.status).toBe(200);
    expect((await res.json()).heard).toHaveLength(100);
  });

  it('400s a choice card, 404s another learner, 409s a card that is not current, and 502s a failing model', async () => {
    const ns = mockNamespace('speech-errors');
    const app = buildTestApp(ns);
    const { sessionId, questions } = await startSpeaking();
    const at = (question_id: string, user_id = 'u_1') =>
      postJson(app, `/api/sessions/${sessionId}/speech`, { user_id, question_id, mime_type: 'audio/aac', audio: AUDIO });
    expect((await at(questions[0].id, 'u_2')).status).toBe(404);
    expect((await at(questions[1].id)).status).toBe(409);
    await expectGeminiStatus(ns, 503);
    expect((await at(questions[0].id)).status).toBe(502);
    expect((await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[0].id, pass: 'skip' })).status).toBe(200);
    await clearNamespace(ns);
    await expectTranscription(ns, 'lantern');
    expect((await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[1].id, text: 'lantern' })).status).toBe(200);
    expect((await at(questions[2].id)).status).toBe(400);
  });

  it('413s a body over 300 KB', async () => {
    const app = buildTestApp(mockNamespace('speech-large'));
    const { sessionId, questions } = await startSpeaking();
    const res = await app.request(`/api/sessions/${sessionId}/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(400 * 1024) },
      body: JSON.stringify({ user_id: 'u_1', question_id: questions[0].id, mime_type: 'audio/aac', audio: 'A'.repeat(400 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
```

(Imports: `mockNamespace`, `geminiBaseUrlFor`, `expectTranscription`, `expectGeminiStatus`, `clearNamespace` from `../../support/mockServer`, and the helpers the copied setup uses.)

- [ ] **Step 10: Run them, and the existing session suites**

Run: `bash scripts/lane-env.sh bash -c 'cd apps/server && npx jest --selectProjects=integration --runTestsByPath tests/integration/routes/sessions.speech.test.ts tests/integration/routes/sessions.test.ts tests/integration/services/sessions.test.ts tests/integration/jobs/prepareSession.test.ts tests/integration/composition.test.ts'`
Expected: PASS.

- [ ] **Step 11: The recompute replays spoken answers**

In the integration test that checks the recompute writes back what the live path wrote (`grep -rln "recompute" apps/server/tests/integration`), add a session holding a `read_aloud` answered `understood`, a `say_translation` answered `gave_up` and one answered by `text`, and assert the recompute's rows equal the live path's, as that file's phase 24 case does.

Run that file. Expected: PASS.

- [ ] **Step 12: The server is green**

Run: `npm run typecheck --workspace apps/server && (cd apps/server && npx jest --selectProjects=unit) && npm run test:integration && npm run lint:arch`
Expected: all PASS, no violation. (`npm run test:integration` runs through the lane wrapper.)

- [ ] **Step 13: Commit**

```bash
git add apps/server packages/core
git commit -m "feat(server): answer a speaking card by voice, pass it, and plan speaking sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mobile — the recorder

**Files:**
- Create: `apps/mobile/src/recording.ts`, test `apps/mobile/src/recording.test.ts`
- Create: `apps/mobile/src/hooks/useRecording.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx`, `apps/mobile/package.json` (+ `package-lock.json`)
- Modify: `docs/adr/adr-0002-di-with-closures.md` (R1, R6), `scripts/check-adr-0002-di-with-closures.sh`

**Interfaces:**
- Produces (`@/recording`):
  - `RecordPermission = 'granted' | 'undetermined' | 'denied'`;
  - `Clip = { audio: string; mimeType: SpeechMimeType; bytes: number }`;
  - `MAX_RECORDING_SECONDS = 5`, `secondsLeft(startedAt: number, now: number): number`;
  - `recordingOptions(platform: string): Record<string, unknown>`, `mimeTypeFor(platform: string): SpeechMimeType`;
  - `canRecordWith(permission: RecordPermission, platform: string): boolean`;
  - `createRecorder(deps)` → `{ canRecord(): Promise<boolean>; start(): Promise<'recording' | 'denied'>; stop(): Promise<Clip>; cancel(): Promise<void> }`; `Recorder = ReturnType<typeof createRecorder>`.
- Produces (`@/hooks/useRecording`): `RecordingProvider({ recorder, children })`, `useRecorder(): Recorder`.

- [ ] **Step 1: Write the failing recorder tests**

Create `apps/mobile/src/recording.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { MAX_RECORDING_SECONDS, canRecordWith, createRecorder, mimeTypeFor, recordingOptions, secondsLeft } from './recording';

function fakes(platform: string, granted = true) {
  const log: string[] = [];
  const engine = {
    uri: null as string | null,
    prepareToRecordAsync: async () => {
      log.push('prepare');
    },
    record: () => {
      log.push('record');
    },
    stop: async () => {
      log.push('stop');
      engine.uri = 'file:///clip';
    },
    release: () => {
      log.push('release');
    },
  };
  const recorder = createRecorder({
    platform,
    makeEngine: (options) => {
      log.push(`make ${String(options.extension ?? options.mimeType)}`);
      return engine;
    },
    permission: async () => 'undetermined',
    requestPermission: async () => granted,
    setRecordingMode: async (on) => {
      log.push(`mode ${on}`);
    },
    readBase64: async (uri) => {
      log.push(`read ${uri}`);
      return { base64: 'QUJD', bytes: 3 };
    },
  });
  return { recorder, log };
}

describe('createRecorder (spec D12)', () => {
  it('on iOS sets the recording mode before recording and clears it after', async () => {
    const { recorder, log } = fakes('ios');
    expect(await recorder.start()).toBe('recording');
    expect(await recorder.stop()).toEqual({ audio: 'QUJD', mimeType: 'audio/mp4', bytes: 3 });
    expect(log).toEqual(['mode true', 'make .m4a', 'prepare', 'record', 'stop', 'mode false', 'read file:///clip', 'release']);
  });

  it('never touches the mode on Android, and records AAC', async () => {
    const { recorder, log } = fakes('android');
    await recorder.start();
    expect((await recorder.stop()).mimeType).toBe('audio/aac');
    expect(log).not.toContain('mode true');
    expect(log).toContain('make .aac');
  });

  it('makes no engine when the microphone is refused', async () => {
    const { recorder, log } = fakes('android', false);
    expect(await recorder.start()).toBe('denied');
    expect(log).toEqual([]);
  });

  it('stops nothing when nothing is recording, and cancel drops a clip', async () => {
    const { recorder, log } = fakes('ios');
    await expect(recorder.stop()).rejects.toThrow(/not recording/);
    await recorder.start();
    await recorder.cancel();
    expect(log).toContain('mode false');
    expect(log).toContain('release');
    expect(log.some((line) => line.startsWith('read'))).toBe(false);
  });
});

describe('the recording rules', () => {
  it('records 16 kHz mono in each platform’s format', () => {
    expect(recordingOptions('android')).toMatchObject({ sampleRate: 16000, numberOfChannels: 1, outputFormat: 'aac_adts', audioEncoder: 'aac' });
    expect(recordingOptions('ios')).toMatchObject({ sampleRate: 16000, numberOfChannels: 1, outputFormat: 'aac ', extension: '.m4a' });
    expect(recordingOptions('web')).toMatchObject({ mimeType: 'audio/webm' });
    expect([mimeTypeFor('android'), mimeTypeFor('ios'), mimeTypeFor('web')]).toEqual(['audio/aac', 'audio/mp4', 'audio/webm']);
  });

  it('counts "not yet asked" as able on a phone, and only "granted" on the web (spec D4)', () => {
    expect(canRecordWith('undetermined', 'android')).toBe(true);
    expect(canRecordWith('denied', 'ios')).toBe(false);
    expect(canRecordWith('granted', 'web')).toBe(true);
    expect(canRecordWith('undetermined', 'web')).toBe(false);
  });

  it('counts five seconds down, never below zero', () => {
    expect(MAX_RECORDING_SECONDS).toBe(5);
    expect(secondsLeft(10_000, 10_000)).toBe(5);
    expect(secondsLeft(10_000, 12_400)).toBe(3);
    expect(secondsLeft(10_000, 99_000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `(cd apps/mobile && npx jest src/recording.test.ts)`
Expected: FAIL, "Cannot find module './recording'".

- [ ] **Step 3: Write `recording.ts`**

Create `apps/mobile/src/recording.ts`:

```ts
import type { SpeechMimeType } from '@lang-tutor/core/api';

/**
 * Phase 25 (spec D12). One clip at a time, through the class expo-audio's
 * useAudioRecorder wraps, so no hook is needed. The composition root
 * (_layout.tsx) passes every concrete piece in (ADR 0002), so this file is
 * tested with fakes.
 */

export type RecordPermission = 'granted' | 'undetermined' | 'denied';

/** One recorded attempt, as the speech endpoint takes it. */
export type Clip = { audio: string; mimeType: SpeechMimeType; bytes: number };

/** What the recorder needs of expo-audio's recorder class. The web's has no
 *  `release` (POC). */
type RecorderEngine = {
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  uri: string | null;
  release?: () => void;
};

/** Spec D7. The card stops recording by itself after this. */
export const MAX_RECORDING_SECONDS = 5;

export function secondsLeft(startedAt: number, now: number): number {
  return Math.max(0, MAX_RECORDING_SECONDS - Math.floor((now - startedAt) / 1000));
}

/** Spec D12: 16 kHz mono AAC on a phone, the browser's WebM on the web. Flat,
 *  as expo-audio's createRecordingOptions would make them for each platform,
 *  because the class is constructed directly. */
export function recordingOptions(platform: string): Record<string, unknown> {
  const common = { sampleRate: 16000, numberOfChannels: 1, isMeteringEnabled: false };
  if (platform === 'android') {
    return { ...common, extension: '.aac', bitRate: 32000, outputFormat: 'aac_adts', audioEncoder: 'aac' };
  }
  if (platform === 'ios') {
    return { ...common, extension: '.m4a', bitRate: 32000, outputFormat: 'aac ', audioQuality: 64 };
  }
  return { ...common, bitRate: 128000, mimeType: 'audio/webm', bitsPerSecond: 128000 };
}

export function mimeTypeFor(platform: string): SpeechMimeType {
  if (platform === 'android') return 'audio/aac';
  if (platform === 'ios') return 'audio/mp4';
  return 'audio/webm';
}

/** Spec D4, as built. A phone asks on the first tap, so "not yet asked" counts
 *  as able. The web cannot read the permission without prompting for it, so
 *  only a site that was granted counts. */
export function canRecordWith(permission: RecordPermission, platform: string): boolean {
  return platform === 'web' ? permission === 'granted' : permission !== 'denied';
}

export type RecorderDeps = {
  platform: string;
  makeEngine: (options: Record<string, unknown>) => RecorderEngine;
  /** Reads the permission without asking for it. */
  permission: () => Promise<RecordPermission>;
  /** Asks for it; true when granted. */
  requestPermission: () => Promise<boolean>;
  /** iOS only: the play-and-record category while recording (spec D12). */
  setRecordingMode: (on: boolean) => Promise<void>;
  readBase64: (uri: string) => Promise<{ base64: string; bytes: number }>;
};

export function createRecorder(deps: RecorderDeps) {
  let engine: RecorderEngine | null = null;
  const ios = deps.platform === 'ios';

  async function finish(current: RecorderEngine): Promise<void> {
    await current.stop();
    if (ios) await deps.setRecordingMode(false);
  }

  return {
    canRecord: async (): Promise<boolean> => canRecordWith(await deps.permission(), deps.platform),

    start: async (): Promise<'recording' | 'denied'> => {
      if (!(await deps.requestPermission())) return 'denied';
      if (ios) await deps.setRecordingMode(true);
      const next = deps.makeEngine(recordingOptions(deps.platform));
      await next.prepareToRecordAsync();
      next.record();
      engine = next;
      return 'recording';
    },

    stop: async (): Promise<Clip> => {
      const current = engine;
      if (!current) throw new Error('not recording');
      engine = null;
      await finish(current);
      if (!current.uri) throw new Error('the recorder gave no uri');
      const { base64, bytes } = await deps.readBase64(current.uri);
      current.release?.();
      return { audio: base64, mimeType: mimeTypeFor(deps.platform), bytes };
    },

    /** Leaving a card mid-recording: stop and drop the clip. */
    cancel: async (): Promise<void> => {
      const current = engine;
      if (!current) return;
      engine = null;
      await finish(current).catch(() => undefined);
      current.release?.();
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;
```

- [ ] **Step 4: Run the tests**

Run: `(cd apps/mobile && npx jest src/recording.test.ts)`
Expected: PASS.

- [ ] **Step 5: The provider**

Create `apps/mobile/src/hooks/useRecording.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';

import type { Recorder } from '@/recording';

// Phase 25. The recorder, built once in _layout.tsx (ADR 0002). It holds no
// state a screen renders, so a plain context, as useSpeaker's is.
const RecordingContext = createContext<Recorder | null>(null);

export function RecordingProvider({ recorder, children }: { recorder: Recorder; children: ReactNode }) {
  return <RecordingContext.Provider value={recorder}>{children}</RecordingContext.Provider>;
}

export function useRecorder(): Recorder {
  const recorder = useContext(RecordingContext);
  if (!recorder) throw new Error('useRecorder must be used inside a RecordingProvider');
  return recorder;
}
```

- [ ] **Step 6: Install `expo-file-system` at SDK 57's range**

Run: `node -p "require('./node_modules/expo/bundledNativeModules.json')['expo-file-system']"` (expected `~57.0.5`), then `npm install -w apps/mobile "expo-file-system@~57.0.5"`. (`npx expo install` refuses to run under this npm.) Check `apps/mobile/package.json` lists it and `git diff --stat package-lock.json` is small.

- [ ] **Step 7: Build it in the composition root**

In `apps/mobile/src/app/_layout.tsx`:

```ts
import {
  AudioModule,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { File } from 'expo-file-system';
```

```ts
import { RecordingProvider } from '@/hooks/useRecording';
import { createRecorder, type RecordPermission } from '@/recording';
```

After the speaker:

```ts
// Phase 25 (spec D12). The recorder class useAudioRecorder wraps, built outside
// any hook. The web build names it AudioRecorderWeb (POC).
const recorder = createRecorder({
  platform: Platform.OS,
  makeEngine: (options) =>
    Platform.OS === 'web'
      ? new (AudioModule as unknown as { AudioRecorderWeb: typeof AudioModule.AudioRecorder }).AudioRecorderWeb(options)
      : new AudioModule.AudioRecorder(options),
  // expo-audio's web read opens the browser's prompt when the site was never
  // granted, so the web reads the permission itself, which never prompts.
  permission: async (): Promise<RecordPermission> => {
    if (Platform.OS === 'web') {
      try {
        const { state } = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'undetermined';
      } catch {
        return 'denied';
      }
    }
    const answer = await getRecordingPermissionsAsync();
    return answer.granted ? 'granted' : answer.canAskAgain ? 'undetermined' : 'denied';
  },
  requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
  setRecordingMode: (on) =>
    setAudioModeAsync(
      on
        ? { allowsRecording: true, playsInSilentMode: true }
        : { allowsRecording: false, playsInSilentMode: true, interruptionMode: 'mixWithOthers' },
    ),
  // A phone reads the file directly: fetch(file://) with FileReader uploaded
  // 15 bytes from Android (POC). The web's uri is a blob: URL. fetch is held in
  // a local, because a browser refuses it called as a method of another object.
  readBase64: async (uri) => {
    if (Platform.OS !== 'web') {
      const file = new File(uri);
      return { base64: await file.base64(), bytes: file.size ?? 0 };
    }
    const fetchUri = globalThis.fetch;
    const blob = await (await fetchUri(uri)).blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), bytes: blob.size };
  },
});
```

Wrap the tree: `<SpeechProvider speaker={speaker}><RecordingProvider recorder={recorder}> … </RecordingProvider></SpeechProvider>`, with `RecordingProvider` directly inside `SpeechProvider` so every other provider is below it.

- [ ] **Step 8: ADR 0002 R1 names `expo-file-system`, and its check fires**

First plant a violation: create a scratch file `apps/mobile/src/plant.ts` containing `import { File } from 'expo-file-system'; export const planted = File;`.

In `scripts/check-adr-0002-di-with-closures.sh`, extend `r1_mobile`'s pattern with `\|from 'expo-file-system'` and the check's label to `AsyncStorage/expo-crypto/expo-speech/expo-audio/expo-file-system imported only at _layout.tsx`.

Run: `bash scripts/check-adr-0002-di-with-closures.sh`
Expected: `VIOLATION  R1  …expo-file-system…` naming `apps/mobile/src/plant.ts`.

Delete `apps/mobile/src/plant.ts` and run it again. Expected: every rule `ok`.

In `docs/adr/adr-0002-di-with-closures.md`: R1's mobile list gains `expo-file-system`; the "How to detect" block's R1 grep gains `\|from 'expo-file-system'` exactly as the script; R6's list gains `createRecorder` after `createSpeaker`; the **Date** line notes `R1 widened 2026-10-07 (phase 25): expo-file-system`.

- [ ] **Step 9: Run the mobile tests, the typecheck of the new files, and the arch check**

Run: `(cd apps/mobile && npx jest) && npm run lint:arch`
Expected: PASS and no violation. (`apps/mobile`'s typecheck is still red until Task 7, because `session.tsx`'s switch does not know the speaking types; `npx tsc --noEmit -p apps/mobile 2>&1 | grep -v "session.tsx\|feedback"` must show no error in `recording.ts`, `useRecording.tsx` or `_layout.tsx`.)

- [ ] **Step 10: Commit**

```bash
git add apps/mobile docs/adr/adr-0002-di-with-closures.md scripts/check-adr-0002-di-with-closures.sh package-lock.json
git commit -m "feat(mobile): a recorder behind the composition root, expo-file-system in ADR 0002

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Mobile — the speaking card, the session's attempt, pass and "can't speak now"

**Files:**
- Modify: `apps/mobile/src/api/client.ts`, test `apps/mobile/src/api/client.test.ts`
- Create: `apps/mobile/src/speaking.ts`, test `apps/mobile/src/speaking.test.ts`
- Modify: `apps/mobile/src/feedback.ts`, test `apps/mobile/src/feedback.test.ts`
- Modify: `apps/mobile/src/strings.ts`
- Modify: `apps/mobile/src/hooks/useSession.tsx`, `apps/mobile/src/hooks/useNextSession.tsx`
- Create: `apps/mobile/src/components/SpeakingCardView.tsx`
- Modify: `apps/mobile/src/components/TypedAnswerView.tsx`, `apps/mobile/src/components/LetterTilesView.tsx`, `apps/mobile/src/app/session.tsx`

**Interfaces:**
- Consumes: Task 1's wire types and `evaluate`/`rightAnswer`; Task 6's `Clip`, `useRecorder`, `secondsLeft`, `MAX_RECORDING_SECONDS`.
- Produces:
  - `api.answerBySpeech(sessionId: string, request: SpeechAnswerRequest): Promise<SpeechAnswerResponse>`;
  - `@/speaking`: `SpeechAttempt = { phase: 'idle' } | { phase: 'checking' } | { phase: 'unheard'; heard: string } | { phase: 'failed' }`, `IDLE_ATTEMPT`, `SpeakingOff = null | 'chosen' | 'no_mic'`, `attemptNotice(attempt): { title: string; heard: string | null } | null`, `passesUnseen(question, speakingOff, answered): boolean`, `isSkip(answer: CardAnswer): boolean`;
  - `SessionValue` gains `speech: SpeechAttempt`, `speakingOff: SpeakingOff`, `submitSpeech(clip: Clip): void`, `pass(kind: 'skip' | 'show_answer'): void`, `retrySpeech(): void`, `stopSpeaking(reason: 'chosen' | 'no_mic'): void`;
  - `Feedback.verdict: AnswerVerdict | null`.

- [ ] **Step 1: The API call, test first**

In `apps/mobile/src/api/client.test.ts`, following its existing fake-`fetch` pattern:

```ts
  it('posts a spoken attempt to the speech endpoint (phase 25)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ heard: 'gatto', verdict: 'unheard' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = createApiClient({ baseUrl: 'http://api', fetch });
    const request = { user_id: 'u', question_id: 'q', mime_type: 'audio/aac' as const, audio: 'QUJD' };
    expect(await api.answerBySpeech('s 1', request)).toEqual({ heard: 'gatto', verdict: 'unheard' });
    expect(calls[0].url).toBe('http://api/api/sessions/s%201/speech');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(request);
  });
```

Then in `client.ts` import `SpeechAnswerRequest`, `SpeechAnswerResponse` and add:

```ts
    answerBySpeech: (sessionId: string, request: SpeechAnswerRequest) =>
      postJson<SpeechAnswerResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/speech`, request),
```

Run: `(cd apps/mobile && npx jest src/api/client.test.ts)` — expected PASS.

- [ ] **Step 2: The strings**

In `apps/mobile/src/strings.ts`, after the phase 24 block:

```ts
  // Phase 25 (spec D7).
  questionInstructionReadAloud: 'קראו בקול',
  questionInstructionSay: (language: string) => `אמרו ב${languageName(language)}`,
  record: 'הקלטה',
  recordingSecondsLeft: (seconds: number) => `מקליטים… ${seconds}`,
  checking: 'בודקים…',
  cantSpeak: 'אי אפשר לדבר עכשיו',
  noMicrophone: 'אין גישה למיקרופון',
  feedbackHeard: 'נכון! שמענו:',
  // FSI/PDI: a target-language transcript inside a Hebrew line.
  heardLine: (heard: string) => `שמענו: ⁨${heard}⁩`,
  notUnderstood: 'לא הבנו. שמענו:',
  heardNothing: 'לא שמענו כלום',
  couldNotCheck: 'לא הצלחנו לבדוק',
  tryAgain: 'נסו שוב',
```

- [ ] **Step 3: The pure speaking rules, test first**

Create `apps/mobile/src/speaking.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { IDLE_ATTEMPT, attemptNotice, isSkip, passesUnseen } from './speaking';
import { strings } from './strings';

const READ: Question = { id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' };
const SAY: Question = {
  id: 's',
  type: 'say_translation',
  vocab_term_id: 'l',
  question: 'חתול',
  part_of_speech: 'noun',
  answer: 'gatto',
  lemma: 'gatto',
  alternatives: [],
};

describe('attemptNotice (spec D7)', () => {
  it('says what was heard, that nothing was, or that it could not check, and nothing otherwise', () => {
    expect(attemptNotice({ phase: 'unheard', heard: 'cane' })).toEqual({ title: strings.notUnderstood, heard: 'cane' });
    expect(attemptNotice({ phase: 'unheard', heard: '' })).toEqual({ title: strings.heardNothing, heard: null });
    expect(attemptNotice({ phase: 'failed' })).toEqual({ title: strings.couldNotCheck, heard: null });
    expect(attemptNotice(IDLE_ATTEMPT)).toBeNull();
    expect(attemptNotice({ phase: 'checking' })).toBeNull();
  });
});

describe('passesUnseen (spec D8)', () => {
  it('passes an unanswered read-aloud card once speaking is off, and nothing else', () => {
    expect(passesUnseen(READ, 'chosen', false)).toBe(true);
    expect(passesUnseen(READ, 'no_mic', false)).toBe(true);
    expect(passesUnseen(READ, null, false)).toBe(false);
    expect(passesUnseen(READ, 'chosen', true)).toBe(false);
    expect(passesUnseen(SAY, 'chosen', false)).toBe(false);
    expect(passesUnseen(undefined, 'chosen', false)).toBe(false);
  });
});

describe('isSkip', () => {
  it('is a skip pass only', () => {
    expect(isSkip({ pass: 'skip' })).toBe(true);
    expect(isSkip({ pass: 'show_answer' })).toBe(false);
    expect(isSkip({ heard: 'gatto' })).toBe(false);
  });
});
```

Create `apps/mobile/src/speaking.ts`:

```ts
import type { Question } from '@lang-tutor/core/api';

import type { CardAnswer } from '@/feedback';
import { strings } from '@/strings';

/** Phase 25 (spec D7). A speaking card's attempt that recorded nothing yet:
 *  in flight, not understood, or not checked. An understood attempt is an
 *  answer, not an attempt. */
export type SpeechAttempt = { phase: 'idle' } | { phase: 'checking' } | { phase: 'unheard'; heard: string } | { phase: 'failed' };

export const IDLE_ATTEMPT: SpeechAttempt = { phase: 'idle' };

/** Spec D8. Speaking is off for the rest of the session: the learner chose it,
 *  or the microphone was refused. */
export type SpeakingOff = null | 'chosen' | 'no_mic';

/** What the card says under its button after an attempt that recorded nothing. */
export function attemptNotice(attempt: SpeechAttempt): { title: string; heard: string | null } | null {
  if (attempt.phase === 'failed') return { title: strings.couldNotCheck, heard: null };
  if (attempt.phase !== 'unheard') return null;
  return attempt.heard === '' ? { title: strings.heardNothing, heard: null } : { title: strings.notUnderstood, heard: attempt.heard };
}

/** Spec D8. A read-aloud card is passed without being shown once speaking is
 *  off: there is nothing to type for a word already on the screen. */
export function passesUnseen(question: Question | undefined, speakingOff: SpeakingOff, answered: boolean): boolean {
  return question?.type === 'read_aloud' && speakingOff !== null && !answered;
}

/** A skip shows no banner: the next card follows at once. */
export function isSkip(answer: CardAnswer): boolean {
  return 'pass' in answer && answer.pass === 'skip';
}
```

Run: `(cd apps/mobile && npx jest src/speaking.test.ts)` — expected PASS.

- [ ] **Step 4: The banner for a spoken answer, test first**

Append to `apps/mobile/src/feedback.test.ts`:

```ts
describe('phase 25 banners', () => {
  const READ: Question = { id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' };
  const SAY: Question = {
    id: 's',
    type: 'say_translation',
    vocab_term_id: 'l',
    question: 'מדבר',
    part_of_speech: 'verb',
    answer: 'parlo',
    lemma: 'parlare',
    alternatives: ['dico'],
  };
  it('names what was heard when understood', () => {
    expect(feedbackFor(READ, { heard: 'il gatto' })).toEqual({
      tone: 'correct',
      title: strings.feedbackHeard,
      line: 'il gatto',
      verdict: 'understood',
    });
  });
  it('names the practised word for an alternative', () => {
    expect(feedbackFor(SAY, { heard: 'dico' })).toEqual({
      tone: 'correct',
      title: strings.feedbackAlternative,
      line: 'parlo',
      verdict: 'alternative',
    });
  });
  it('shows the answer for show the answer, and judges a typed form as typed', () => {
    expect(feedbackFor(SAY, { pass: 'show_answer' })).toMatchObject({ tone: 'wrong', title: strings.feedbackWrong, line: 'parlo' });
    expect(feedbackFor(SAY, { text: 'parlare' })).toMatchObject({ tone: 'correct', verdict: 'exact' });
  });
});
```

In `apps/mobile/src/feedback.ts`: `verdict: AnswerVerdict | null` (import `AnswerVerdict` instead of `TypedVerdict`), and before `const record = evaluate(question, answer);`:

```ts
  // Phase 25 (spec D7). The server judged the transcript with the same pure
  // function, so evaluate here gives the verdict it stored.
  if ('heard' in answer) {
    const record = evaluate(question, answer);
    if (record.verdict === 'alternative') {
      return { tone: 'correct', title: strings.feedbackAlternative, line: rightAnswer(question), verdict: 'alternative' };
    }
    return { tone: 'correct', title: strings.feedbackHeard, line: answer.heard, verdict: 'understood' };
  }
```

In `TypedAnswerView.tsx` and `LetterTilesView.tsx`, widen the `verdict` prop to `AnswerVerdict | null`. `TypedAnswerView`'s `question` prop becomes `TypedTranslationQuestion | DictationQuestion | SayTranslationQuestion`, and its part-of-speech line shows for every type but dictation:

```ts
  const partOfSpeech = question.type !== 'dictation' ? strings.partOfSpeech(question.part_of_speech) : undefined;
```

Run: `(cd apps/mobile && npx jest src/feedback.test.ts)` — expected PASS.

- [ ] **Step 5: The session's attempt, pass and "can't speak now"**

In `apps/mobile/src/hooks/useSession.tsx`:

Imports: `Clip` from `@/recording`; `IDLE_ATTEMPT`, `passesUnseen`, `type SpeakingOff`, `type SpeechAttempt` from `@/speaking`.

`SessionValue` gains:

```ts
  /** Phase 25. The speaking card's attempt that has recorded nothing yet. */
  speech: SpeechAttempt;
  /** Phase 25 (spec D8). Off for the rest of the session, and why. */
  speakingOff: SpeakingOff;
  /** Sends a recorded clip for the speaking card on screen. */
  submitSpeech: (clip: Clip) => void;
  /** Answers a speaking card without audio: skip, or show the answer. */
  pass: (kind: 'skip' | 'show_answer') => void;
  /** Back to a fresh attempt after one that recorded nothing. */
  retrySpeech: () => void;
  /** "Can't speak now", or a refused microphone. */
  stopSpeaking: (reason: 'chosen' | 'no_mic') => void;
```

`QuizState` gains `speech: SpeechAttempt; speakingOff: SpeakingOff;`. `enter` sets `speech: IDLE_ATTEMPT, speakingOff: null`. `applyQueued` sets `speech: IDLE_ATTEMPT` in both of its returns.

Pull the `Queued` construction out of `queueResponse` into a module function, used by both paths:

```ts
function queuedFrom(response: NextStepResponse): Queued {
  return response.complete
    ? { complete: true, score: response.score, missedQuestions: response.missed_questions, progress: response.progress }
    : { complete: false, question: response.question, position: response.position.position };
}
```

and in `queueResponse` use `const queued = queuedFrom(response);`.

Add, after `submitBoard`:

```ts
  // Phase 25 (spec D5). The server transcribes and judges, so the banner waits
  // for it. Not understood: the card stays, with what was heard. Understood:
  // the answer is the transcript, and the response's next step is queued.
  const submitSpeech = useCallback(
    (clip: Clip) => {
      if (!state || state.answer !== null || !state.question || state.speech.phase === 'checking') return;
      const { sessionId, userId, question } = state;
      const mine = (latest: QuizState | null) => latest !== null && latest.sessionId === sessionId && latest.question?.id === question.id;
      setState((current) => (current ? { ...current, speech: { phase: 'checking' } } : current));
      void api
        .answerBySpeech(sessionId, { user_id: userId, question_id: question.id, mime_type: clip.mimeType, audio: clip.audio })
        .then((response) => {
          setState((latest) => {
            if (!latest || !mine(latest)) return latest;
            if (response.verdict === 'unheard' || !response.next) {
              return { ...latest, speech: { phase: 'unheard', heard: response.heard } };
            }
            return { ...latest, speech: IDLE_ATTEMPT, answer: { heard: response.heard }, queued: queuedFrom(response.next) };
          });
        })
        .catch(() => {
          setState((latest) => (latest && mine(latest) ? { ...latest, speech: { phase: 'failed' } } : latest));
        });
    },
    [state, api],
  );

  // A skip shows no banner: Continue is requested at once, so the next card
  // appears as soon as the server answers (spec D8).
  const pass = useCallback(
    (kind: 'skip' | 'show_answer') => {
      if (!state || state.answer !== null || !state.question) return;
      const { sessionId, userId, question } = state;
      setState((current) =>
        current ? { ...current, answer: { pass: kind }, speech: IDLE_ATTEMPT, advanceRequested: kind === 'skip' } : current,
      );
      queueResponse(sessionId, api.nextStep(sessionId, { user_id: userId, question_id: question.id, pass: kind }));
    },
    [state, api, queueResponse],
  );

  const retrySpeech = useCallback(() => {
    setState((current) => (current ? { ...current, speech: IDLE_ATTEMPT } : current));
  }, []);

  const stopSpeaking = useCallback((reason: 'chosen' | 'no_mic') => {
    setState((current) => (current && current.speakingOff === null ? { ...current, speakingOff: reason, speech: IDLE_ATTEMPT } : current));
  }, []);

  // Spec D8: with speaking off, a read-aloud card is passed without being shown.
  useEffect(() => {
    if (state && passesUnseen(state.question, state.speakingOff, state.answer !== null)) pass('skip');
  }, [state, pass]);
```

`useMemo`'s two returns gain `speech`, `speakingOff`, `submitSpeech`, `pass`, `retrySpeech`, `stopSpeaking` (the no-session one with `speech: IDLE_ATTEMPT, speakingOff: null`), and its dependency list gains the four callbacks.

- [ ] **Step 6: The flag at session creation**

In `apps/mobile/src/hooks/useNextSession.tsx`: `const recorder = useRecorder();` (import from `@/hooks/useRecording`), and in `create`:

```ts
      // Phase 25 (spec D4): only the device knows whether it can record.
      const speaking = await recorder.canRecord();
      return await api.createSession({
        enrollment_id: active.id,
        listening: speaker.snapshot().tags.has(active.target_language),
        speaking,
      });
```

(inside the existing `try`, so `reload()` still runs), with `recorder` in the callback's dependencies.

- [ ] **Step 7: The card**

Create `apps/mobile/src/components/SpeakingCardView.tsx`:

```tsx
import type { ReadAloudQuestion, SayTranslationQuestion } from '@lang-tutor/core/api';
import { rightAnswer } from '@lang-tutor/core/domain';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SpeakButton } from '@/components/SpeakButton';
import { answerStyles } from '@/components/TypedAnswerView';
import type { CardAnswer } from '@/feedback';
import { useRecorder } from '@/hooks/useRecording';
import { MAX_RECORDING_SECONDS, secondsLeft, type Clip } from '@/recording';
import { attemptNotice, type SpeechAttempt } from '@/speaking';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  question: ReadAloudQuestion | SayTranslationQuestion;
  instruction: string;
  /** The enrollment's target language: every word on the card is in it. */
  language: string;
  answer: CardAnswer | null;
  speech: SpeechAttempt;
  onClip: (clip: Clip) => void;
  onRetry: () => void;
  onPass: (kind: 'skip' | 'show_answer') => void;
  onCantSpeak: (reason: 'chosen' | 'no_mic') => void;
};

/**
 * Phase 25 (spec D7). Tap to record, tap to stop; five seconds at most. While
 * the clip is checked the button is disabled. An attempt that was not
 * understood says what was heard, in neutral colours: it is not wrong.
 */
export function SpeakingCardView({ question, instruction, language, answer, speech, onClip, onRetry, onPass, onCantSpeak }: Props) {
  const recorder = useRecorder();
  const [recording, setRecording] = useState(false);
  const [left, setLeft] = useState(MAX_RECORDING_SECONDS);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // The timer's stop reads the latest callback, not the one from when it began.
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const answered = answer !== null;
  const checking = speech.phase === 'checking';
  const notice = attemptNotice(speech);
  const read = question.type === 'read_aloud';
  const form = rightAnswer(question);

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  // Leaving the card mid-recording drops the clip.
  useEffect(
    () => () => {
      clearTimer();
      void recorder.cancel();
    },
    [recorder],
  );

  async function stop() {
    clearTimer();
    setRecording(false);
    try {
      onClipRef.current(await recorder.stop());
    } catch {
      // Nothing recorded: the button is ready for another try.
    }
  }

  async function onMic() {
    if (answered || checking) return;
    if (recording) return stop();
    if (notice) onRetry();
    if ((await recorder.start()) === 'denied') {
      onCantSpeak('no_mic');
      return;
    }
    const startedAt = Date.now();
    setLeft(MAX_RECORDING_SECONDS);
    setRecording(true);
    timer.current = setInterval(() => {
      const remaining = secondsLeft(startedAt, Date.now());
      setLeft(remaining);
      if (remaining === 0) void stop();
    }, 250);
  }

  const heard = answer && 'heard' in answer ? answer.heard : null;
  const status = recording ? strings.recordingSecondsLeft(left) : checking ? strings.checking : null;

  return (
    <View style={styles.container}>
      <Text style={answerStyles.instruction}>{instruction}</Text>

      {question.type === 'read_aloud' ? (
        <View style={styles.row}>
          <Text style={styles.form} testID="question-prompt">
            {question.question}
          </Text>
          {/* Spec D2: no speaker before the answer, or reading becomes repeating. */}
          {answered || notice ? <SpeakButton text={form} language={language} testID="speak-form" /> : null}
        </View>
      ) : (
        <>
          <Text style={answerStyles.prompt} testID="question-prompt">
            {question.question}
          </Text>
          {strings.partOfSpeech(question.part_of_speech) ? (
            <Text style={answerStyles.partOfSpeech} testID="question-part-of-speech">
              {strings.partOfSpeech(question.part_of_speech)}
            </Text>
          ) : null}
        </>
      )}

      {answered && question.type === 'read_aloud' ? (
        <Text style={styles.meaning} testID="speak-meaning">
          {question.meaning}
        </Text>
      ) : null}
      {answered && !read ? (
        <View style={styles.row}>
          <Text style={styles.form} testID="speak-answer">
            {form}
          </Text>
          <SpeakButton text={form} language={language} testID="speak-form" />
        </View>
      ) : null}
      {heard !== null && answer && 'heard' in answer && !read ? (
        <Text style={styles.heard} testID="speak-heard">
          {strings.heardLine(heard)}
        </Text>
      ) : null}

      {answered ? null : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.record}
            accessibilityState={{ selected: recording, disabled: checking }}
            aria-selected={recording}
            disabled={checking}
            testID="speak-record"
            onPress={() => void onMic()}
            style={[styles.mic, recording && styles.micOn, checking && styles.micBusy]}
          >
            <Text style={styles.glyph}>🎤</Text>
          </Pressable>
          {status ? (
            <Text style={styles.status} testID="speak-status">
              {status}
            </Text>
          ) : null}

          {notice ? (
            <View style={styles.notice} testID="speak-notice">
              <Text style={styles.noticeTitle}>{notice.title}</Text>
              {notice.heard !== null ? (
                <Text style={styles.form} testID="speak-notice-heard">
                  {notice.heard}
                </Text>
              ) : null}
              <View style={styles.noticeActions}>
                <Pressable accessibilityRole="button" testID="speak-try-again" onPress={onRetry} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{strings.tryAgain}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" testID="speak-continue" onPress={() => onPass('skip')} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{strings.continueLabel}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <View style={answerStyles.actions}>
            {read ? null : (
              <Pressable accessibilityRole="button" testID="speak-show-answer" hitSlop={8} onPress={() => onPass('show_answer')}>
                <Text style={answerStyles.showAnswer}>{strings.typedShowAnswer}</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" testID="speak-cant-speak" hitSlop={8} onPress={() => onCantSpeak('chosen')}>
              <Text style={answerStyles.showAnswer}>{strings.cantSpeak}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const MIC = 96;
const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  // A target-language word: left to right inside the mirrored screen.
  form: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, writingDirection: 'ltr', textAlign: 'center' },
  meaning: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  heard: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  mic: {
    alignSelf: 'center',
    width: MIC,
    height: MIC,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micOn: { backgroundColor: colors.primary },
  micBusy: { opacity: 0.4 },
  glyph: { fontSize: fontSizes.xl },
  status: { alignSelf: 'center', fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted },
  notice: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noticeTitle: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, fontWeight: '700', writingDirection: 'rtl' },
  noticeActions: { flexDirection: 'row', gap: spacing.md, justifyContent: 'center' },
  secondary: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primary },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
});
```

(If `radii.pill` or any `fontSizes`/`lineHeights` key used here is missing from `@/theme`, use the nearest existing one, as `ListenPrompt.tsx` does.)

- [ ] **Step 8: The session screen**

In `apps/mobile/src/app/session.tsx`: import `SpeakingCardView` and `isSkip` from `@/speaking`. Add two cases to `renderQuestion`:

```tsx
    case 'read_aloud':
      // Spec D8: with speaking off, the card is passed unseen.
      if (session.speakingOff !== null) return null;
      return (
        <SpeakingCardView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionReadAloud}
          language={language}
          answer={session.answer}
          speech={session.speech}
          onClip={session.submitSpeech}
          onRetry={session.retrySpeech}
          onPass={session.pass}
          onCantSpeak={session.stopSpeaking}
        />
      );
    case 'say_translation':
      // Spec D8: with speaking off, the same card is typed.
      if (session.speakingOff !== null) {
        return (
          <View style={styles.typedForm}>
            {session.speakingOff === 'no_mic' ? (
              <Text style={styles.noMic} testID="speak-no-mic">
                {strings.noMicrophone}
              </Text>
            ) : null}
            <TypedAnswerView
              question={question}
              instruction={strings.questionInstructionTyped(language)}
              language={language}
              answered={session.answered}
              verdict={session.answer ? feedbackFor(question, session.answer).verdict : null}
              onSubmit={session.submitText}
            />
          </View>
        );
      }
      return (
        <SpeakingCardView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionSay(language)}
          language={language}
          answer={session.answer}
          speech={session.speech}
          onClip={session.submitSpeech}
          onRetry={session.retrySpeech}
          onPass={session.pass}
          onCantSpeak={session.stopSpeaking}
        />
      );
```

The banner: `{session.answer && !isSkip(session.answer) ? (<FeedbackBanner … />) : null}`.

Styles: `typedForm: { gap: spacing.md }`, `noMic: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center' }`.

- [ ] **Step 9: A passed last card completes the session**

Add to `apps/mobile/src/speaking.test.ts` a case on the pure rule that matters here: `passesUnseen` is false once the card is answered, so the effect fires one pass per card. (The session hook itself has no unit harness in this repo; the completion is pinned end to end in Task 5's integration "the score leaves a skipped card out" and in Task 10's e2e.)

```ts
  it('a passed last card completes the session: one pass, then nothing more', () => {
    expect(passesUnseen(READ, 'chosen', false)).toBe(true);
    expect(passesUnseen(READ, 'chosen', true)).toBe(false);
  });
```

- [ ] **Step 10: The whole repo is green**

Run: `npm run typecheck && (cd apps/mobile && npx jest) && npm test && npm run lint:arch`
Expected: PASS, and no violation.

- [ ] **Step 11: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): the speaking card, its attempt, pass and can't speak now

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `spoken_productive` goes live (spec D11)

**Files:**
- Modify: `packages/core/src/domain/progress.ts`, its test
- Modify: every test whose badge or `raised` expectation moves (find them as below)

**Interfaces:**
- Produces: `LIVE_DIMENSIONS = ['written_receptive', 'written_productive', 'spelling', 'spoken_receptive', 'spoken_productive']`.

- [ ] **Step 1: Change the constant, test first**

In `packages/core/src/domain/progress.test.ts`, change the `LIVE_DIMENSIONS` expectation to the five above, in that order, and add:

```ts
  it('drops a badge by at most one level when spoken_productive goes live (phase 25 D11)', () => {
    expect(badge([4, 4, 4, 4])).toBe(4);
    expect(badge([4, 4, 4, 4, 1])).toBe(3);
    expect(badge([3, 3, 3, 3, 1])).toBe(3);
    expect(badge([5, 5, 5, 5, 1])).toBe(4);
  });
```

Run: `(cd packages/core && npx jest src/domain/progress.test.ts)` — expected FAIL on the constant. Then in `packages/core/src/domain/progress.ts`:

```ts
/** Phase 20's switch for what the badge averages. Phase 23 added
 *  written_productive and spelling, phase 24 spoken_receptive, and phase 25
 *  spoken_productive: every dimension is live. */
export const LIVE_DIMENSIONS: readonly Dimension[] = [
  'written_receptive',
  'written_productive',
  'spelling',
  'spoken_receptive',
  'spoken_productive',
];
```

(keep the existing doc comment's history, extended by the phase 25 sentence). Run again — expected PASS.

- [ ] **Step 2: Find every expectation that moves**

Run: `npm test 2>&1 | tail -40` and `npm run test:integration 2>&1 | grep -E "✕|●" | head -40`.
For each failure, confirm it fails only because a badge is now a mean over five dimensions (a word whose `spoken_productive` is 1 reads lower), and update the expected level or the expected live list. Phase 24 did the same in commit `55383fe` and `4efb1ca` ("level expectations for three live dimensions"). A failure for any other reason is a bug to report, not an expectation to change.

- [ ] **Step 3: The e2e expectations**

Run: `grep -rn "level\|רמה\|נחשפה\|מוכרת\|חדשה\|LIVE\|הבנת הנשמע" e2e/tests/*.spec.ts | head -40` and update any expectation of a badge level that the fifth dimension moves (run `npm run e2e -- tests/progress.spec.ts tests/next-session.spec.ts tests/question-types.spec.ts tests/listening-variety.spec.ts` to see which).

- [ ] **Step 4: Commit**

```bash
git add packages/core apps/server apps/mobile e2e
git commit -m "feat(core): spoken_productive goes live, and badges recalibrate once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The transcription eval

**Files:**
- Create: `apps/server/tests/eval/audio/*.aac` (26 clips)
- Modify: `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/askModel.ts`, `apps/server/tests/eval/run.ts`

**Interfaces:**
- Consumes: Task 2's `transcriptionSystem`, `parseTranscript`; Task 4's `createGeminiTranscriber`; Task 1's `judgeSpoken`.
- Produces: `TranscriptionCase = { label: string; file: string; language: 'it' | 'ru' | 'en'; target: string; expect: 'understood' | 'unheard' }`, `TRANSCRIPTION_CASES`, `askTranscription(transcriber, { file, language }): Promise<string>`.

- [ ] **Step 1: Make the clips**

Each clip is macOS `say` with 0.6 s of silence before and after (spec D12: clips without it transcribe badly), converted to Android's format, AAC in ADTS, 16 kHz mono. For each row `file|voice|spoken` below, run:

```bash
say -v "<voice>" -o "$TMPDIR/clip.wav" --file-format=WAVE --data-format=LEI16@16000 "[[slnc 600]] <spoken> [[slnc 600]]"
afconvert -f adts -d aac "$TMPDIR/clip.wav" apps/server/tests/eval/audio/<file>.aac
```

Rows (voices: Alice for Italian, Milena for Russian, Samantha for English):

```
it-gatto|Alice|gatto
it-perche|Alice|perché
it-finestra|Alice|finestra
it-cucchiaio|Alice|cucchiaio
it-citta|Alice|città
it-per-favore|Alice|per favore
it-caffe-con-cornetto|Alice|caffè con cornetto
it-grazie-mille|Alice|grazie mille
it-gato|Alice|gato
it-cane|Alice|cane
ru-moloko|Milena|молоко
ru-yolka|Milena|ёлка
ru-luk|Milena|лук
ru-spasibo|Milena|спасибо
ru-lozhka|Milena|ложка
ru-dobroe-utro|Milena|доброе утро
ru-lyuk|Milena|люк
ru-les|Milena|лес
en-through|Samantha|through
en-weather|Samantha|weather
en-knife|Samantha|knife
en-island|Samantha|island
en-thank-you|Samantha|thank you
en-good-morning|Samantha|good morning
en-taught|Samantha|taught
en-bat|Samantha|bat
```

Check: `ls apps/server/tests/eval/audio | wc -l` is 26 and `du -sh apps/server/tests/eval/audio` is under 400 KB.

- [ ] **Step 2: The cases**

In `apps/server/tests/eval/cases.ts`, append:

```ts
/**
 * Phase 25 (spec §2, Eval). One clip each, said right or said as another word.
 * Made with macOS `say` and 0.6 s of silence on each side, as a recording has:
 *
 *   say -v Alice -o "$TMPDIR/clip.wav" --file-format=WAVE --data-format=LEI16@16000 "[[slnc 600]] gatto [[slnc 600]]"
 *   afconvert -f adts -d aac "$TMPDIR/clip.wav" apps/server/tests/eval/audio/it-gatto.aac
 *
 * Synthetic voices, not a learner's accent: these prove the path and the
 * instruction, not accuracy for Victor's voice (spec, Risks).
 */
export type TranscriptionCase = {
  label: string;
  file: string;
  language: 'it' | 'ru' | 'en';
  target: string;
  expect: 'understood' | 'unheard';
};

const said = (language: TranscriptionCase['language'], file: string, target: string): TranscriptionCase => ({
  label: `${language}: ${target} said right`,
  file,
  language,
  target,
  expect: 'understood',
});
const other = (language: TranscriptionCase['language'], file: string, target: string, spoken: string): TranscriptionCase => ({
  label: `${language}: ${spoken} said for ${target}`,
  file,
  language,
  target,
  expect: 'unheard',
});

export const TRANSCRIPTION_CASES: TranscriptionCase[] = [
  said('it', 'it-gatto', 'gatto'),
  said('it', 'it-perche', 'perché'),
  said('it', 'it-finestra', 'finestra'),
  said('it', 'it-cucchiaio', 'cucchiaio'),
  said('it', 'it-citta', 'città'),
  said('it', 'it-per-favore', 'per favore'),
  said('it', 'it-caffe-con-cornetto', 'caffè con cornetto'),
  said('it', 'it-grazie-mille', 'grazie mille'),
  other('it', 'it-gato', 'gatto', 'gato'),
  other('it', 'it-cane', 'gatto', 'cane'),
  said('ru', 'ru-moloko', 'молоко'),
  said('ru', 'ru-yolka', 'ёлка'),
  said('ru', 'ru-luk', 'лук'),
  said('ru', 'ru-spasibo', 'спасибо'),
  said('ru', 'ru-lozhka', 'ложка'),
  said('ru', 'ru-dobroe-utro', 'доброе утро'),
  other('ru', 'ru-lyuk', 'лук', 'люк'),
  other('ru', 'ru-les', 'лук', 'лес'),
  said('en', 'en-through', 'through'),
  said('en', 'en-weather', 'weather'),
  said('en', 'en-knife', 'knife'),
  said('en', 'en-island', 'island'),
  said('en', 'en-thank-you', 'thank you'),
  said('en', 'en-good-morning', 'good morning'),
  other('en', 'en-taught', 'thought', 'taught'),
  other('en', 'en-bat', 'bad', 'bat'),
];
```

- [ ] **Step 3: Ask the model**

In `apps/server/tests/eval/askModel.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LlmTranscriptSchema } from '@lang-tutor/core/api/schemas';

import { parseTranscript, transcriptionSystem } from '../../src/domain/speech';
import type { SpeechTranscriber } from '../../src/services/speech';

/** Phase 25. The real instruction and the real parser over one clip — what
 *  answerBySpeech does to it, without a database. Null when unreadable. */
export async function askTranscription(
  transcriber: SpeechTranscriber,
  input: { file: string; language: 'it' | 'ru' | 'en' },
): Promise<string | null> {
  const audio = readFileSync(join(__dirname, 'audio', `${input.file}.aac`)).toString('base64');
  const raw = await transcriber({
    system: transcriptionSystem(input.language),
    audio,
    mimeType: 'audio/aac',
    schema: LlmTranscriptSchema,
  });
  return parseTranscript(raw);
}
```

- [ ] **Step 4: Score it in its own line**

In `apps/server/tests/eval/run.ts`:
- import `TRANSCRIPTION_CASES` and `type TranscriptionCase` from `./cases`, `askTranscription` from `./askModel`, `createGeminiTranscriber` with `createGeminiClient`, and `judgeSpoken` from `@lang-tutor/core/domain`;
- filter: `const transcriptionCases = TRANSCRIPTION_CASES.filter((kase) => matches(kase.label, kase.target, kase.file));`, included in the "matched no case" sum;
- after `llm`: `const transcriber = createGeminiTranscriber({ fetch: globalThis.fetch, baseUrl: gemini.baseUrl, apiKey: gemini.apiKey, model: gemini.model, timeoutMs: TIMEOUT_MS });`;
- a scorer:

```ts
  const scoreTranscription = async (kase: TranscriptionCase): Promise<Row> => {
    try {
      const heard = await askTranscription(transcriber, { file: kase.file, language: kase.language });
      const verdict = heard === null ? null : judgeSpoken({ forms: [kase.target], alternatives: [] }, heard) === 'understood' ? 'understood' : 'unheard';
      return {
        label: kase.label,
        text: kase.file,
        tier1: [{ name: 'the answer parses', ok: heard !== null, detail: heard === null ? 'unreadable' : undefined }],
        tier2: [{ name: `judged ${kase.expect}`, ok: verdict === kase.expect, detail: `heard "${heard ?? ''}"` }],
        heard: heard ?? undefined,
      };
    } catch (error) {
      return {
        label: kase.label,
        text: kase.file,
        tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }],
        tier2: [],
        error: (error as Error).message,
      };
    }
  };
```

(add `heard?: string` to the `Row` type, and print `       heard=${row.heard}` when present, beside the other per-row lines);
- run it in the same `Promise.all` with `mapWithConcurrency(transcriptionCases, CONCURRENCY, scoreTranscription)`, and add its rows to `rows`;
- score transcription separately: compute `transcriptionScore` from the transcription rows' tier 2 checks only, and `score` from the other rows only, as before. Print a second line, `transcription tier 2: P/T = X% (threshold 85%)`, and fail when either score is below `TIER2_THRESHOLD` (a score with zero checks, as in a filtered run, does not fail). Add `${transcriptionCases.length} transcription` to the counts line, and `transcriptionScore` to the report JSON.

- [ ] **Step 5: Run it against the real model**

Run, while iterating: `(cd apps/server && npx tsx tests/eval/run.ts said)` (every transcription label contains "said"; a few other cases may match too, which is harmless). Then once, in full: `(cd apps/server && npx tsx tests/eval/run.ts)`.
Expected: tier 1 has 0 failures, and both tier 2 lines are at or above 85%. If a case fails, read its `heard`. A clip that `say` renders badly is re-made, and an instruction problem is fixed in `transcriptionSystem`. Never lower `TIER2_THRESHOLD`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/tests/eval
git commit -m "test(eval): transcription cases, scored against the real model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: End to end, and the spec records what was built

**Files:**
- Modify: `e2e/tests/support/mockServer.ts`, `e2e/tests/support/cards.ts`
- Create: `e2e/tests/speaking.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-07-lang-tutor-phase-25-speaking-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `expectTranscription(request, heard)` (e2e), `CardKind` gains `'read' | 'say'`.

- [ ] **Step 1: The e2e transcription stub**

In `e2e/tests/support/mockServer.ts`:

```ts
/** Phase 25. The transcription call's answer, matched on the server's
 *  TRANSCRIBE_MARKER (apps/server/src/domain/speech.ts) and ranked above the
 *  generation stub, which matches any call. Consumed once, in registration
 *  order, so a test can queue "not understood" and then "understood". */
export async function expectTranscription(request: APIRequestContext, heard: string): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      priority: 10,
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: '[\\s\\S]*transcribe the spoken audio[\\s\\S]*' } },
      httpResponse: { statusCode: 200, headers: { 'content-type': ['application/json'] }, body: envelope({ heard }) },
      times: { remainingTimes: 1, unlimited: false },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}
```

- [ ] **Step 2: Cards know the speaking kinds**

In `e2e/tests/support/cards.ts`: `CardKind` gains `'read' | 'say'`, and `kindOnScreen` checks, before `typed-input`:

```ts
  if (await has('speak-record')) {
    const prompt = stripIsolates(await page.getByTestId('question-prompt').textContent());
    return HEBREW.test(prompt) ? 'say' : 'read';
  }
```

and add:

```ts
/** Phase 25. Records one attempt on the speaking card: tap, about a second of
 *  Chromium's fake microphone, tap. */
export async function speak(page: Page) {
  await page.getByTestId('speak-record').click();
  await expect(page.getByTestId('speak-status')).toBeVisible();
  await page.waitForTimeout(1_000);
  await page.getByTestId('speak-record').click();
}
```

- [ ] **Step 3: Write the spec**

Create `e2e/tests/speaking.spec.ts`, following `listening-variety.spec.ts` (copy its `saveTenWords`, its login and create steps, and its board answering):

```ts
import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { answerChoice, answerTyped, generationStubFor, readCard, speak } from './support/cards';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { tapUntil } from './support/interactions';
import { BOARD_WORDS } from './support/lexemes';
import { clearGemini, expectGemini, expectGeminiPayload, expectTranscription } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner } from './support/users';
import { withVoices } from './support/voices';

test.setTimeout(300_000);
// A granted microphone and Chromium's fake one: the app records, and the
// transcription is MockServer's. No voices, so no listening cards (phase 24 D5).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const MEANING_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.form, w.translation]));
const FORM_OF: Record<string, string> = Object.fromEntries(BOARD_WORDS.map((w) => [w.translation, w.form]));
```

The test (`'speaking: read aloud, say the translation, and can't speak now'`):

1. Set up as `listening-variety.spec.ts` does, with `await withVoices(page, [])`, learner `e2e_speak_ru`, ten saved words.
2. **Session 1, ordinal 0** (listening off, speaking on: spec D3 as built): stub `generationStubFor({ 1: 'meaning', 2: 'word', 3: 'typed', 4: 'meaning', 10: 'typed' })`. Create, start.
3. Positions 1–3 and the board 4–7, answered right, exactly as `listening-variety.spec.ts` answers them (the board with no wrong pairing).
4. Position 8, `readCard(page, 8, 10, 'read')`: `await expectTranscription(request, 'кошка'); await expectTranscription(request, card.prompt);`. `await speak(page)`, then expect `speak-notice` to contain `לא הבנו` and `speak-notice-heard` to have the text `кошка`, and `feedback-correct` not to be visible. Tap `speak-try-again`, `await speak(page)`, then expect `feedback-title` to have the text `נכון! שמענו:` and `feedback-line` to contain the form. Continue.
5. Position 9, `readCard(page, 9, 10, 'tiles')`: build the word as `listening-variety.spec.ts` does. Continue.
6. Position 10, `readCard(page, 10, 10, 'say')`: `await expectTranscription(request, FORM_OF[card.prompt]); await speak(page);` and expect `feedback-correct`. Continue.
7. Results: expect `page.getByText(/דיבור/).first()` to be visible (`raised` names it, spec D7).
8. **Session 2, ordinal 1** (spec D3 as built: read aloud at 1, tiles at 2, say the translation at 3, the board at 4–7, read aloud at 8, reverse at 9, say the translation at 10): `await clearGemini(request)` and stub `generationStubFor({ 3: 'typed', 4: 'meaning', 9: 'word', 10: 'typed' })`. Go home (`page.getByTestId('next-session-button')` or the results' next-session action, as `next-session.spec.ts` does), create, start.
9. Position 1, `readCard(page, 1, 10, 'read')`: tap `speak-cant-speak`. The card passes unseen: `readCard(page, 2, 10, 'tiles')` and build the word. Continue.
10. Position 3: `readCard(page, 3, 10, 'typed')` (with speaking off, say the translation is the typed card). `await answerTyped(page, FORM_OF[card.prompt])`, expect `feedback-correct`. Continue.
11. Skip the rest: tap `session-skip` (the dialog is accepted by the page's `dialog` handler) and expect the home screen.
12. `expect(diagnostics.pageErrors, report()).toEqual([])`.

If the plan at either ordinal is not as listed (check with `apps/server/src/domain/plan.test.ts`'s ordinal-0 case), the spec is wrong, not the planner: correct the spec's positions and stub keys from the planner's output for ten tile-eligible, speakable picks at that ordinal.

- [ ] **Step 4: Run it, then every e2e spec**

Run: `npm run e2e -- tests/speaking.spec.ts`
Expected: PASS.
Then: `npm run e2e`
Expected: every spec PASS. The other specs never grant the microphone, so their sessions plan as before.

- [ ] **Step 5: The spec records what was built**

In `docs/superpowers/specs/2026-10-07-lang-tutor-phase-25-speaking-design.md`:
- **Status:** "Planned and built on 2026-10-07 on phase 24 Part A (#93); see the plan `docs/superpowers/plans/2026-10-07-phase-25-speaking.md`."
- **Builds on:** Part A (#93); Part B is not required, and inserts its cloze types into these tiers when it lands.
- D3: the tiers as built (Part A's types plus the two), and "speaking off removes the speaking types before the rotation, so a session without speaking is planned exactly as phase 24 plans it".
- D4: the web counts only a granted microphone (the plan's deviation, with its reason).
- D5: the owner check is a 404; a clip under 1 000 base64 characters is heard as nothing without a call.
- §2 Server: migration **0017** (`0017_speaking_cards.sql`), not 0018.
- Add the build's other deviations from the plan's list, one line each.

- [ ] **Step 6: Every gate, one last time**

Run: `npm run typecheck && npm test && npm run test:integration && npm run lint:arch && npm run e2e`
Expected: all PASS, and `lint:arch` prints no violation. (The eval ran in Task 9; run it again only if the instruction changed since.)

- [ ] **Step 7: Commit**

```bash
git add e2e docs/superpowers/specs/2026-10-07-lang-tutor-phase-25-speaking-design.md
git commit -m "test(e2e): speaking cards end to end; the spec records what was built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
