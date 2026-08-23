# lang-tutor Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable Hebrew, right-to-left React Native app in which a Hebrew speaker answers ten multiple-choice questions about English words and phrases, drawn from hardcoded mock data.

**Architecture:** An Expo Router stack of three screens (Home, Session, Results) over two deliberate seams: `Question` is a tagged union so future question types are additive, and all session state flows through a single `useSession` hook. The quiz logic lives in `src/session.ts` as pure TypeScript with no React imports, so it is unit-testable without rendering. Screens are thin presentation over theme tokens and a Hebrew strings module.

**Tech Stack:** Expo SDK 57, React Native 0.86.2, React 19.2.3, TypeScript 6.0, Expo Router 57, Jest 29 with the `jest-expo` preset.

**Spec:** [docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md](../specs/2026-08-24-lang-tutor-phase-1-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Route directory is `src/app/`, not `app/`.** The SDK 57 template puts routes there. The spec says `app/index.tsx`; the real path is `src/app/index.tsx`.
- **Path alias:** `@/*` resolves to `./src/*`. Use it for all cross-directory imports.
- **Data-object fields are `snake_case`** (`vocab_entry_id`, `correct_option`, `is_correct`, `answer_string`). All other TypeScript and React code is `camelCase`.
- **No user-visible string may be inlined in a screen or component.** Every one lives in `src/strings.ts`.
- **No literal colour, spacing, radius, font size, or line height in a component.** All come from `src/theme.ts`.
- **Directional styles use `start`/`end`**, never `left`/`right` — `paddingStart`, `marginEnd`, `borderTopStartRadius`, and so on. RTL mirroring is then inherited rather than hand-written.
- **`SESSION_LENGTH = 10`**, exported from `src/session.ts`. Nothing hardcodes 10.
- **Tests cover `src/session.ts` and `src/data/mockQuestions.ts` only.** No component or snapshot tests in phase 1 — they would calcify the layout that is about to be iterated on.
- **Test files import their globals:** `import { describe, expect, it } from '@jest/globals';`. TypeScript 6 does not auto-resolve `@types/jest` under this tsconfig, so relying on ambient globals fails `tsc`.
- **Verification commands** run from the repo root: `npx tsc --noEmit` must exit 0, and `npm test` must be fully green, before any commit.

## Deviations from the spec

These were discovered by building and running the code. Each is a deliberate refinement, not a silent change.

1. **Routes live in `src/app/`.** Forced by the SDK 57 template layout.
2. **`answer` does not advance; a separate `advance` does.** The spec's test list says "`answer` scores correctly, advances, and reaches a terminal state". It cannot advance, because the feedback banner has to stay on screen showing the answered state until the learner taps Continue. The two operations are split and both are tested.
3. **The `never` exhaustiveness guard is deferred.** `type Question = MultipleChoiceQuestion` is a type *alias*, not yet a union, so `const unhandled: never = question` in the `default` branch is a compile error today (`Type 'MultipleChoiceQuestion' is not assignable to type 'never'`). The `switch` and its `default` branch are in place now with a runtime throw and a comment saying exactly what to change; the compile-time check starts working the moment a second member joins the union.
4. **`createSession` takes an injectable random function.** `createSession(pool, count, rng)` defaults to `Math.random`, so tests pass a seeded generator and shuffling assertions are deterministic.
5. **A root `<View style={{ direction: 'rtl' }}>` wraps the stack**, in addition to `I18nManager.forceRTL(true)`. `forceRTL` alone only takes effect after a reload on native, and behaves inconsistently on web. The wrapper makes the very first render right-to-left everywhere.
6. **`babel.config.js` must be created.** The SDK 57 template ships without one, and `jest-expo` cannot transform TypeScript without it.
7. **The mock set has 16 questions, not "roughly sixteen".** Task 3's test asserts the count exceeds `SESSION_LENGTH`, which is what actually matters.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | `MultipleChoiceQuestion`, `Question`, `AnswerRecord`. Data shapes only. |
| `src/session.ts` | Pure quiz engine: `SESSION_LENGTH`, `createSession`, `answer`, `advance`, selectors. No React. |
| `src/session.test.ts` | Unit tests for the engine. |
| `src/data/mockQuestions.ts` | 16 hardcoded English → Hebrew questions. |
| `src/data/mockQuestions.test.ts` | Guards the mock set's shape and its long-prompt coverage. |
| `src/theme.ts` | Design tokens: colours, spacing, radii, font sizes, line heights. |
| `src/strings.ts` | Every Hebrew user-visible string. |
| `src/hooks/useSession.tsx` | The single session-state seam: provider plus hook. |
| `src/components/ProgressBar.tsx` | Right-to-left filling progress bar. |
| `src/components/OptionButton.tsx` | One answer option, with idle/correct/wrong/dimmed states. |
| `src/components/MultipleChoiceView.tsx` | Renders a multiple-choice question; owns equal-height option measurement. |
| `src/components/FeedbackBanner.tsx` | Bottom banner that slides up after an answer. |
| `src/app/_layout.tsx` | Forces RTL, mounts `SessionProvider` and the stack. |
| `src/app/index.tsx` | Home screen. |
| `src/app/session.tsx` | Session screen; dispatches on `question.type`. |
| `src/app/results.tsx` | Results screen. |
| `babel.config.js` | `babel-preset-expo`, required by `jest-expo`. |

---

## Task 1: Scaffold the Expo project in the repo, force RTL, add tokens and strings

**Files:**
- Create (by scaffold): `package.json`, `app.json`, `tsconfig.json`, `.gitignore`, `assets/`
- Create: `src/theme.ts`, `src/strings.ts`
- Modify: `src/app/_layout.tsx`, `src/app/index.tsx`, `README.md`, `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `colors`, `spacing`, `radii`, `fontSizes`, `lineHeights` from `@/theme`; `strings` from `@/strings`. A running app with RTL forced.

`create-expo-app` refuses to scaffold into a directory containing any plain file (it rejects even `README.md`), and it initialises its own `.git`. So the scaffold happens outside the repo, its `.git` is deleted, and the contents are copied in. Skipping the `rm -rf` would destroy this repo's history.

- [ ] **Step 1: Scaffold the project outside the repo**

```bash
cd /tmp && rm -rf lang-tutor-scaffold
npx --yes create-expo-app@latest lang-tutor-scaffold --template default
```

Expected: `Your project is ready!`

Then confirm the SDK version, because this plan's paths and versions assume SDK 57:

```bash
node -e "console.log(require('/tmp/lang-tutor-scaffold/package.json').dependencies.expo)"
ls /tmp/lang-tutor-scaffold/src/app
```

Expected: an `expo` version on the `~57` line, and routes under `src/app/`. If either differs, stop — the route paths and the `jest-expo` version below need revisiting.

- [ ] **Step 2: Delete the scaffold's git repo, then copy it into this repo**

```bash
rm -rf /tmp/lang-tutor-scaffold/.git
cp -R /tmp/lang-tutor-scaffold/. /Users/vperepelitsky/git/vic-prp/lang-tutor-init/
cd /Users/vperepelitsky/git/vic-prp/lang-tutor-init
git log --oneline | head -3
```

Expected: the existing commit history is still listed. If it shows only an Expo commit, `.git` was overwritten — stop and restore.

- [ ] **Step 3: Install dependencies**

```bash
npm install
```

- [ ] **Step 4: Strip the template's example app**

`reset-project` prompts interactively; piping `n` chooses delete-rather-than-keep. It removes `src/` and `scripts/` and writes a minimal `src/app/index.tsx` and `src/app/_layout.tsx`.

```bash
echo "n" | node ./scripts/reset-project.js
ls src/app
```

Expected: `_layout.tsx  index.tsx`

- [ ] **Step 5: Remove the now-dangling reset-project script**

`scripts/` was just deleted, so the npm script points at nothing. Edit `package.json` and delete this line from `"scripts"`:

```json
    "reset-project": "node ./scripts/reset-project.js",
```

- [ ] **Step 6: Set the app's identity and pin it to a light interface**

Edit `app.json`. Change `name`, `slug` and `scheme`, and change `userInterfaceStyle` from `"automatic"` to `"light"` — phase 1 is light-theme only, and leaving it automatic lets a device in dark mode recolour system surfaces.

```json
{
  "expo": {
    "name": "lang tutor",
    "slug": "lang-tutor",
    "scheme": "langtutor",
    "userInterfaceStyle": "light"
  }
}
```

Leave every other key in `app.json` exactly as the template wrote it.

- [ ] **Step 7: Create the theme tokens**

Create `src/theme.ts`:

```ts
export const colors = {
  background: '#F5F6FA',
  surface: '#FFFFFF',
  text: '#16161D',
  muted: '#8A8A99',
  border: '#E3E4EC',
  primary: '#3B5BDB',
  onPrimary: '#FFFFFF',
  correct: '#1F9254',
  correctSurface: '#E7F6EC',
  wrong: '#C92A2A',
  wrongSurface: '#FCEBEB',
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radii = { sm: 8, md: 14, lg: 22, pill: 999 } as const;

export const fontSizes = { sm: 14, md: 17, lg: 20, xl: 28, xxl: 40 } as const;

// Hebrew has no capitals and a different vertical rhythm from Latin script, so
// line heights are deliberately generous. Tune these during the play-test.
export const lineHeights = { sm: 22, md: 27, lg: 30, xl: 38, xxl: 50 } as const;
```

- [ ] **Step 8: Create the Hebrew strings module**

Create `src/strings.ts`:

```ts
export const strings = {
  appTitle: 'lang tutor',
  homeSubtitle: 'תרגול אוצר מילים',
  homeSetLabel: (count: number) => `${count} מילים באנגלית`,
  start: 'התחל',
  questionInstruction: 'מה הפירוש?',
  continueLabel: 'המשך',
  feedbackCorrect: 'נכון!',
  feedbackWrong: 'התשובה הנכונה:',
  resultsHeadlineGreat: 'מצוין!',
  resultsHeadlineGood: 'עבודה טובה!',
  resultsHeadlineKeepPractising: 'ממשיכים לתרגל',
  resultsMissedTitle: 'כדאי לחזור על אלה',
  practiseAgain: 'תרגל שוב',
  done: 'סיום',
} as const;
```

- [ ] **Step 9: Force RTL in the root layout**

Replace the contents of `src/app/_layout.tsx`:

```tsx
import { Stack } from 'expo-router';
import { I18nManager, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

// Must run before the first render. Native only applies a direction flip on
// reload, so RTL is set once at startup and never toggled.
I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

export default function RootLayout() {
  return (
    <View style={styles.root}>
      <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
    </View>
  );
}

const styles = StyleSheet.create({
  // `direction` is belt-and-braces alongside forceRTL: it makes the very first
  // render right-to-left without waiting for a reload, and it works on web.
  root: { flex: 1, direction: 'rtl', backgroundColor: colors.background },
  content: { backgroundColor: colors.background },
});
```

- [ ] **Step 10: Write a temporary RTL smoke screen**

This screen exists only to prove mirroring works. Task 4 replaces it with the real Home screen.

Replace the contents of `src/app/index.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

export default function RtlSmokeScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.row}>
        <Text style={styles.marker}>{'1'}</Text>
        <Text style={styles.marker}>{'2'}</Text>
        <Text style={styles.marker}>{'3'}</Text>
      </View>
      <Text style={styles.hebrew}>{strings.homeSubtitle}</Text>
      <Text style={styles.english}>{'How do you do?'}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  row: { flexDirection: 'row', gap: spacing.md },
  marker: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.primary },
  hebrew: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  english: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
});
```

- [ ] **Step 11: Type-check**

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 12: Run the app and confirm mirroring**

```bash
npx expo start --web
```

Expected, all four:
1. The markers read `3 2 1` from left to right — that is `1 2 3` laid out right-to-left, which proves the row mirrored.
2. The Hebrew line is right-aligned.
3. The English line is centred and reads `How do you do?` correctly, with the `?` at its right-hand end.
4. The background is the light `#F5F6FA`, not white.

If the markers read `1 2 3` from the left, mirroring is not active — stop and fix before continuing.

- [ ] **Step 13: Replace the template README**

The scaffold overwrote `README.md` with Expo boilerplate. Replace its entire contents with the following (the outer four-backtick fence is this plan's; the file itself starts at `# lang-tutor`):

````markdown
# lang-tutor

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 runs entirely on mock data with a single multiple-choice question type,
so the look and feel can be judged on a real device before any server exists.

- Design: [docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md)
- Plan: [docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)

## Running it

```bash
npm install
npx expo start
```

Then press `w` for the browser, or scan the QR code with Expo Go on a phone.
The interface is Hebrew and right-to-left; browser and native RTL are not
identical, so confirm layout on a real device.

## Tests

```bash
npm test          # Jest, covering the pure session engine and the mock data
npx tsc --noEmit  # type-check
```
````

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "Scaffold Expo app with forced RTL, theme tokens and Hebrew strings"
```

---

## Task 2: Data types and the pure session engine

**Files:**
- Create: `babel.config.js`, `src/types.ts`, `src/session.ts`
- Test: `src/session.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/types.ts`: `MultipleChoiceQuestion`, `Question`, `AnswerRecord` (shapes exactly as in Step 3).
  - `src/session.ts`: `SESSION_LENGTH: number`; `SessionState`; `createSession(pool: readonly Question[], count?: number, rng?: () => number): SessionState`; `answer(state: SessionState, optionIndex: number): SessionState`; `advance(state: SessionState): SessionState`; `currentQuestion(state): Question | undefined`; `isComplete(state): boolean`; `isAnswered(state): boolean`; `progress(state): { position: number; total: number }`; `score(state): { correct: number; total: number }`; `missed(state): { question: Question; correct_answer: string }[]`.

- [ ] **Step 1: Install Jest**

`jest-expo` 57 is built on the Jest 29 line, so Jest is pinned to 29 to match. `@jest/globals` is declared directly because the test files import from it.

```bash
npm install --save-dev jest@~29.7.0 jest-expo@~57.0.4 @jest/globals@~29.7.0
```

- [ ] **Step 2: Create the Babel config**

The SDK 57 template ships without one, and `jest-expo` cannot transform TypeScript without it. Create `babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
```

- [ ] **Step 3: Wire the test script and Jest preset**

Add a `"test"` script and a `"jest"` block to `package.json`:

```json
{
  "scripts": {
    "test": "jest"
  },
  "jest": {
    "preset": "jest-expo",
    "testPathIgnorePatterns": ["/node_modules/", "/dist/"]
  }
}
```

Keep the existing `start`, `android`, `ios`, `web` and `lint` scripts.

- [ ] **Step 4: Create the data types**

Create `src/types.ts`:

```ts
export type MultipleChoiceQuestion = {
  id: string;
  type: 'multiple_choice';
  vocab_entry_id: string;
  question: string;
  options: string[];
  correct_option: number;
};

// A tagged union with one member today. The `type` field exists from day one so
// consumers switch on it; adding a question type is then additive.
export type Question = MultipleChoiceQuestion;

// Scoring reads `is_correct` and nothing else, so any future question type
// satisfies it. `answer_string` is the audit-log field: text rather than an
// option index, because option order is shuffled per session.
export type AnswerRecord = {
  question_id: string;
  is_correct: boolean;
  answer_string: string;
};
```

- [ ] **Step 5: Write the failing test**

Create `src/session.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import {
  SESSION_LENGTH,
  advance,
  answer,
  createSession,
  currentQuestion,
  isComplete,
  missed,
  progress,
  score,
} from './session';
import type { Question } from './types';

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

// A seeded generator so shuffling is reproducible and these assertions are not
// flaky. The engine defaults to Math.random in the app.
function seededRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

describe('createSession', () => {
  it('creates a session of exactly the requested length', () => {
    const state = createSession(POOL, SESSION_LENGTH, seededRng(1));
    expect(state.questions).toHaveLength(SESSION_LENGTH);
  });

  it('never repeats a question within a session', () => {
    const state = createSession(POOL, SESSION_LENGTH, seededRng(2));
    const ids = state.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps correct_option pointing at the correct answer after shuffling', () => {
    const state = createSession(POOL, SESSION_LENGTH, seededRng(3));
    for (const question of state.questions) {
      const original = POOL.find((item) => item.id === question.id)!;
      const expected = original.options[original.correct_option];
      expect(question.options[question.correct_option]).toBe(expected);
      expect([...question.options].sort()).toEqual([...original.options].sort());
    }
  });

  it('throws when the pool is smaller than the requested length', () => {
    expect(() => createSession(POOL.slice(0, 3), SESSION_LENGTH, seededRng(4))).toThrow(
      'pool has 3 questions, need at least 10',
    );
  });

  it('starts unanswered on the first question', () => {
    const state = createSession(POOL, SESSION_LENGTH, seededRng(5));
    expect(state.index).toBe(0);
    expect(state.selected_option).toBeNull();
    expect(state.answers).toEqual([]);
    expect(progress(state)).toEqual({ position: 1, total: 10 });
  });
});

describe('answer', () => {
  it('scores a correct answer and records the chosen text', () => {
    const state = createSession(POOL, 2, seededRng(6));
    const question = currentQuestion(state)!;
    const next = answer(state, question.correct_option);
    expect(next.answers).toHaveLength(1);
    expect(next.answers[0]).toEqual({
      question_id: question.id,
      is_correct: true,
      answer_string: question.options[question.correct_option],
    });
  });

  it('records answer_string for a wrong answer too', () => {
    const state = createSession(POOL, 2, seededRng(7));
    const question = currentQuestion(state)!;
    const wrongIndex = (question.correct_option + 1) % question.options.length;
    const next = answer(state, wrongIndex);
    expect(next.answers[0].is_correct).toBe(false);
    expect(next.answers[0].answer_string).toBe(question.options[wrongIndex]);
  });

  it('ignores a second answer to the same question', () => {
    const state = createSession(POOL, 2, seededRng(8));
    const once = answer(state, 0);
    const twice = answer(once, 1);
    expect(twice).toBe(once);
    expect(twice.answers).toHaveLength(1);
  });

  it('does not advance on its own', () => {
    const state = createSession(POOL, 2, seededRng(9));
    expect(answer(state, 0).index).toBe(0);
  });
});

describe('advance', () => {
  it('moves to the next question and clears the selection', () => {
    const state = advance(answer(createSession(POOL, 2, seededRng(10)), 0));
    expect(state.index).toBe(1);
    expect(state.selected_option).toBeNull();
  });

  it('does nothing while the current question is unanswered', () => {
    const state = createSession(POOL, 2, seededRng(11));
    expect(advance(state)).toBe(state);
  });

  it('reaches a terminal state after the last question', () => {
    let state = createSession(POOL, 2, seededRng(12));
    expect(isComplete(state)).toBe(false);
    state = advance(answer(state, 0));
    expect(isComplete(state)).toBe(false);
    state = advance(answer(state, 0));
    expect(isComplete(state)).toBe(true);
    expect(currentQuestion(state)).toBeUndefined();
  });
});

describe('score and missed', () => {
  it('counts correct answers and lists missed questions with their correct answer', () => {
    let state = createSession(POOL, 3, seededRng(13));
    const first = currentQuestion(state)!;
    state = advance(answer(state, first.correct_option));

    const second = currentQuestion(state)!;
    const wrongIndex = (second.correct_option + 1) % second.options.length;
    state = advance(answer(state, wrongIndex));

    const third = currentQuestion(state)!;
    state = advance(answer(state, third.correct_option));

    expect(score(state)).toEqual({ correct: 2, total: 3 });
    expect(missed(state)).toEqual([
      { question: second, correct_answer: second.options[second.correct_option] },
    ]);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module './session'`.

- [ ] **Step 7: Write the engine**

Create `src/session.ts`:

```ts
import type { AnswerRecord, Question } from './types';

export const SESSION_LENGTH = 10;

export type SessionState = {
  questions: Question[];
  index: number;
  answers: AnswerRecord[];
  /** null while the current question is unanswered. */
  selected_option: number | null;
};

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function shuffleOptions(question: Question, rng: () => number): Question {
  const correct = question.options[question.correct_option];
  const options = shuffle(question.options, rng);
  return { ...question, options, correct_option: options.indexOf(correct) };
}

export function createSession(
  pool: readonly Question[],
  count: number = SESSION_LENGTH,
  rng: () => number = Math.random,
): SessionState {
  if (pool.length < count) {
    throw new Error(`pool has ${pool.length} questions, need at least ${count}`);
  }
  const questions = shuffle(pool, rng)
    .slice(0, count)
    .map((question) => shuffleOptions(question, rng));
  return { questions, index: 0, answers: [], selected_option: null };
}

export function currentQuestion(state: SessionState): Question | undefined {
  return state.questions[state.index];
}

export function isComplete(state: SessionState): boolean {
  return state.index >= state.questions.length;
}

export function isAnswered(state: SessionState): boolean {
  return state.selected_option !== null;
}

export function answer(state: SessionState, optionIndex: number): SessionState {
  const question = currentQuestion(state);
  if (!question || isAnswered(state)) return state;
  const record: AnswerRecord = {
    question_id: question.id,
    is_correct: optionIndex === question.correct_option,
    answer_string: question.options[optionIndex],
  };
  return { ...state, selected_option: optionIndex, answers: [...state.answers, record] };
}

export function advance(state: SessionState): SessionState {
  if (!isAnswered(state)) return state;
  return { ...state, index: state.index + 1, selected_option: null };
}

export function progress(state: SessionState): { position: number; total: number } {
  return {
    position: Math.min(state.index + 1, state.questions.length),
    total: state.questions.length,
  };
}

export function score(state: SessionState): { correct: number; total: number } {
  return {
    correct: state.answers.filter((record) => record.is_correct).length,
    total: state.questions.length,
  };
}

export function missed(state: SessionState): { question: Question; correct_answer: string }[] {
  return state.answers
    .filter((record) => !record.is_correct)
    .flatMap((record) => {
      const question = state.questions.find((item) => item.id === record.question_id);
      return question
        ? [{ question, correct_answer: question.options[question.correct_option] }]
        : [];
    });
}
```

- [ ] **Step 8: Run the tests and the type-checker**

```bash
npm test
npx tsc --noEmit
```

Expected: 13 tests passing in 1 suite, and `tsc` silent.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add data types and pure session engine with tests"
```

---

## Task 3: Mock questions

**Files:**
- Create: `src/data/mockQuestions.ts`
- Test: `src/data/mockQuestions.test.ts`

**Interfaces:**
- Consumes: `Question` from `@/types`; `SESSION_LENGTH` from `@/session`.
- Produces: `mockQuestions: Question[]` from `@/data/mockQuestions` — 16 entries.

- [ ] **Step 1: Write the failing test**

The long-prompt assertion is the one that matters most: it stops someone shrinking the set to short words, which would hide option-wrapping bugs until real content arrived.

Create `src/data/mockQuestions.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { mockQuestions } from './mockQuestions';
import { SESSION_LENGTH } from '../session';

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

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test
```

Expected: FAIL — `Cannot find module './mockQuestions'`.

- [ ] **Step 3: Write the mock data**

Distractors are hand-written and length-matched to the correct answer, so option length never gives the answer away. Create `src/data/mockQuestions.ts`:

```ts
import type { Question } from '@/types';

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

- [ ] **Step 4: Run the tests and the type-checker**

```bash
npm test
npx tsc --noEmit
```

Expected: 18 tests passing across 2 suites, and `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add 16 mock English-to-Hebrew questions with shape guards"
```

---

## Task 4: The useSession seam and the Home screen

**Files:**
- Create: `src/hooks/useSession.tsx`
- Modify: `src/app/_layout.tsx`, `src/app/index.tsx`

**Interfaces:**
- Consumes: `mockQuestions` from `@/data/mockQuestions`; the whole engine surface from `@/session`; `strings`, `colors`, `spacing`, `radii`, `fontSizes`, `lineHeights`.
- Produces:
  - `SessionProvider({ children }: { children: ReactNode })`
  - `useSession(): SessionValue`, where `SessionValue` is `{ hasSession: boolean; question: Question | undefined; position: number; total: number; selectedOption: number | null; answered: boolean; complete: boolean; correctCount: number; missedQuestions: MissedQuestion[]; start: () => void; select: (optionIndex: number) => void; next: () => void }`
  - `MissedQuestion = { question: Question; correct_answer: string }`

This hook is the only place session state is read or written. Screens never import `@/session` for state — only for `SESSION_LENGTH`.

- [ ] **Step 1: Create the provider and hook**

Create `src/hooks/useSession.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { mockQuestions } from '@/data/mockQuestions';
import {
  SESSION_LENGTH,
  advance,
  answer,
  createSession,
  currentQuestion,
  isAnswered,
  isComplete,
  missed,
  progress,
  score,
  type SessionState,
} from '@/session';
import type { Question } from '@/types';

export type MissedQuestion = { question: Question; correct_answer: string };

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

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  // Phase 1 keeps session state in memory. Persistence, points and daily
  // targets all land here later, and no screen changes when they do.
  const [state, setState] = useState<SessionState | null>(null);

  const start = useCallback(() => {
    setState(createSession(mockQuestions, SESSION_LENGTH));
  }, []);

  const select = useCallback((optionIndex: number) => {
    setState((current) => (current ? answer(current, optionIndex) : current));
  }, []);

  const next = useCallback(() => {
    setState((current) => (current ? advance(current) : current));
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
    const { position, total } = progress(state);
    return {
      hasSession: true,
      question: currentQuestion(state),
      position,
      total,
      selectedOption: state.selected_option,
      answered: isAnswered(state),
      complete: isComplete(state),
      correctCount: score(state).correct,
      missedQuestions: missed(state),
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

- [ ] **Step 2: Mount the provider in the root layout**

In `src/app/_layout.tsx`, add the import and wrap the existing `<View>`:

```tsx
import { SessionProvider } from '@/hooks/useSession';
```

```tsx
export default function RootLayout() {
  return (
    <SessionProvider>
      <View style={styles.root}>
        <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
      </View>
    </SessionProvider>
  );
}
```

Leave the `I18nManager` calls and the `styles` block untouched.

- [ ] **Step 3: Replace the RTL smoke screen with the real Home screen**

This deletes the temporary screen from Task 1. Replace the whole contents of `src/app/index.tsx`:

```tsx
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '@/hooks/useSession';
import { SESSION_LENGTH } from '@/session';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function HomeScreen() {
  const { start } = useSession();

  function onStart() {
    start();
    router.push('/session');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.appTitle}</Text>
      <Text style={styles.subtitle}>{strings.homeSubtitle}</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{strings.homeSetLabel(SESSION_LENGTH)}</Text>
      </View>

      <Pressable accessibilityRole="button" onPress={onStart} style={styles.button}>
        <Text style={styles.buttonLabel}>{strings.start}</Text>
      </Pressable>

      {/* Deliberately empty. Streak, points and daily-target widgets land here. */}
      <View style={styles.futureSpace} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
  },
  subtitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  card: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardLabel: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  futureSpace: { flex: 1 },
});
```

- [ ] **Step 4: Type-check and run the existing tests**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` silent; 18 tests still passing. There are no tests for the hook — phase 1 tests the engine, not React.

- [ ] **Step 5: Run the app and confirm Home**

```bash
npx expo start --web
```

Expected: title `lang tutor`, Hebrew subtitle and card label both right-aligned, card reads `10 מילים באנגלית`, and a blue `התחל` button. Tapping it navigates to a not-found route — `src/app/session.tsx` does not exist yet, which is correct at this point.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add useSession state seam and the Home screen"
```

---

## Task 5: The Session screen

**Files:**
- Create: `src/components/ProgressBar.tsx`, `src/components/OptionButton.tsx`, `src/components/MultipleChoiceView.tsx`, `src/components/FeedbackBanner.tsx`, `src/app/session.tsx`

**Interfaces:**
- Consumes: `useSession` from `@/hooks/useSession`; `MultipleChoiceQuestion` and `Question` from `@/types`; `strings`; theme tokens.
- Produces:
  - `ProgressBar({ position, total }: { position: number; total: number })`
  - `OptionVisualState = 'idle' | 'correct' | 'wrong' | 'dimmed'`
  - `OptionButton({ label, state, disabled, minHeight, onPress, onMeasure })`
  - `MultipleChoiceView({ question, selectedOption, onSelect })`
  - `FeedbackBanner({ isCorrect, correctAnswer, onContinue })`

- [ ] **Step 1: Create the progress bar**

Two flexed children rather than a percentage width: flex ratios mirror automatically inside an RTL row, so the bar fills right-to-left with no direction-specific code.

Create `src/components/ProgressBar.tsx`:

```tsx
import { StyleSheet, View } from 'react-native';

import { colors, radii } from '@/theme';

export function ProgressBar({ position, total }: { position: number; total: number }) {
  const ratio = total === 0 ? 0 : Math.max(0, Math.min(1, position / total));
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { flex: ratio }]} />
      <View style={{ flex: 1 - ratio }} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  fill: { backgroundColor: colors.primary, borderRadius: radii.pill },
});
```

- [ ] **Step 2: Create the option button**

`onMeasure` reports this button's rendered height so the parent can equalise all four. `minHeight` comes back down from the parent's measured maximum; because the reported height then never shrinks, this converges after one extra render rather than looping.

Create `src/components/OptionButton.tsx`:

```tsx
import { Pressable, StyleSheet, Text, type LayoutChangeEvent } from 'react-native';

import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export type OptionVisualState = 'idle' | 'correct' | 'wrong' | 'dimmed';

type Props = {
  label: string;
  state: OptionVisualState;
  disabled: boolean;
  minHeight?: number;
  onPress: () => void;
  onMeasure: (height: number) => void;
};

export function OptionButton({ label, state, disabled, minHeight, onPress, onMeasure }: Props) {
  function handleLayout(event: LayoutChangeEvent) {
    onMeasure(event.nativeEvent.layout.height);
  }

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onLayout={handleLayout}
      style={({ pressed }) => [
        styles.base,
        stateStyles[state],
        minHeight ? { minHeight } : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.label, state === 'dimmed' ? styles.labelDimmed : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  label: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  labelDimmed: { color: colors.muted },
});

const stateStyles = StyleSheet.create({
  idle: {},
  correct: { borderColor: colors.correct, backgroundColor: colors.correctSurface },
  wrong: { borderColor: colors.wrong, backgroundColor: colors.wrongSurface },
  dimmed: { opacity: 0.45 },
});
```

- [ ] **Step 3: Create the multiple-choice view**

Create `src/components/MultipleChoiceView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';
import type { MultipleChoiceQuestion } from '@/types';

type Props = {
  question: MultipleChoiceQuestion;
  selectedOption: number | null;
  onSelect: (optionIndex: number) => void;
};

export function MultipleChoiceView({ question, selectedOption, onSelect }: Props) {
  // All four buttons match the tallest, so a wrapped phrase does not leave the
  // set visually ragged. Reset on every new question.
  const [maxHeight, setMaxHeight] = useState(0);

  useEffect(() => {
    setMaxHeight(0);
  }, [question.id]);

  const answered = selectedOption !== null;

  function visualState(index: number): OptionVisualState {
    if (!answered) return 'idle';
    if (index === question.correct_option) return 'correct';
    if (index === selectedOption) return 'wrong';
    return 'dimmed';
  }

  return (
    <View style={styles.container}>
      <Text style={styles.instruction}>{strings.questionInstruction}</Text>
      <Text style={styles.prompt}>{question.question}</Text>
      <View style={styles.options}>
        {question.options.map((option, index) => (
          <OptionButton
            key={`${question.id}-${index}`}
            label={option}
            state={visualState(index)}
            disabled={answered}
            minHeight={maxHeight > 0 ? maxHeight : undefined}
            onPress={() => onSelect(index)}
            onMeasure={(height) =>
              setMaxHeight((previous) => (height > previous ? height : previous))
            }
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  instruction: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  // The English prompt is centred and explicitly LTR so it reads correctly
  // inside the mirrored screen, punctuation included.
  prompt: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  options: { gap: spacing.sm },
});
```

- [ ] **Step 4: Create the feedback banner**

It is absolutely positioned, so it overlays the options rather than displacing them — answering never reflows what the learner is reading.

Create `src/components/FeedbackBanner.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';

import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  isCorrect: boolean;
  correctAnswer: string;
  onContinue: () => void;
};

const HIDDEN_OFFSET = 200;

export function FeedbackBanner({ isCorrect, correctAnswer, onContinue }: Props) {
  const translateY = useRef(new Animated.Value(HIDDEN_OFFSET)).current;

  useEffect(() => {
    translateY.setValue(HIDDEN_OFFSET);
    Animated.timing(translateY, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [translateY, correctAnswer]);

  return (
    <Animated.View
      style={[
        styles.banner,
        isCorrect ? styles.bannerCorrect : styles.bannerWrong,
        { transform: [{ translateY }] },
      ]}
    >
      <Text style={[styles.title, isCorrect ? styles.titleCorrect : styles.titleWrong]}>
        {isCorrect ? strings.feedbackCorrect : strings.feedbackWrong}
      </Text>
      {isCorrect ? null : <Text style={styles.answer}>{correctAnswer}</Text>}
      <Pressable accessibilityRole="button" onPress={onContinue} style={styles.button}>
        <Text style={styles.buttonLabel}>{strings.continueLabel}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    gap: spacing.sm,
  },
  bannerCorrect: { backgroundColor: colors.correctSurface },
  bannerWrong: { backgroundColor: colors.wrongSurface },
  title: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  titleCorrect: { color: colors.correct },
  titleWrong: { color: colors.wrong },
  answer: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  button: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
```

- [ ] **Step 5: Create the Session screen**

`renderQuestion` is the type seam: the only place phase 1 dispatches on `question.type`.

Create `src/app/session.tsx`:

```tsx
import { Redirect, router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedbackBanner } from '@/components/FeedbackBanner';
import { MultipleChoiceView } from '@/components/MultipleChoiceView';
import { ProgressBar } from '@/components/ProgressBar';
import { useSession } from '@/hooks/useSession';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';
import type { Question } from '@/types';

// The one place phase 1 dispatches on question type. Adding a question type
// means a new case here plus a new view component; the header, progress bar,
// feedback banner and scoring are untouched.
function renderQuestion(
  question: Question,
  selectedOption: number | null,
  onSelect: (optionIndex: number) => void,
) {
  switch (question.type) {
    case 'multiple_choice':
      return (
        <MultipleChoiceView
          question={question}
          selectedOption={selectedOption}
          onSelect={onSelect}
        />
      );
    default:
      // Unreachable while Question has a single member. Once a second question
      // type joins the union, replace this line with
      // `const unhandled: never = question;` and TypeScript will fail the build
      // on any unhandled type.
      throw new Error('unhandled question type');
  }
}

export default function SessionScreen() {
  const session = useSession();

  // Results replaces Session in the stack, so backing out of Results reaches
  // Home rather than a finished quiz.
  useEffect(() => {
    if (session.hasSession && session.complete) {
      router.replace('/results');
    }
  }, [session.hasSession, session.complete]);

  if (!session.hasSession) {
    return <Redirect href="/" />;
  }

  const question = session.question;
  if (!question) {
    return null;
  }

  const isCorrect = session.selectedOption === question.correct_option;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" hitSlop={12} onPress={() => router.back()}>
          <Text style={styles.back}>{'→'}</Text>
        </Pressable>
        <Text style={styles.counter}>{`${session.position} / ${session.total}`}</Text>
      </View>

      <ProgressBar position={session.position} total={session.total} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {renderQuestion(question, session.selectedOption, session.select)}
      </ScrollView>

      {session.answered ? (
        <FeedbackBanner
          isCorrect={isCorrect}
          correctAnswer={question.options[question.correct_option]}
          onContinue={session.next}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
  },
  // A glyph, not an icon, so it is not auto-mirrored. Back points right in RTL.
  back: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.muted },
  counter: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    fontWeight: '700',
  },
  // Bottom padding keeps the last option clear of the overlaid banner.
  body: { paddingTop: spacing.xl, paddingBottom: spacing.xxl * 4 },
});
```

- [ ] **Step 6: Type-check and run the tests**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` silent; 18 tests passing.

- [ ] **Step 7: Run the app and play through a session**

```bash
npx expo start --web
```

Expected, all of it:
1. Back arrow `→` at the top right, counter `1 / 10` at the top left.
2. Progress bar fills from the right.
3. Hebrew instruction right-aligned; English prompt centred.
4. Tapping an option turns it green or red, always shows the correct one green, dims the other two, and slides a banner up from the bottom.
5. The options do not shift when the banner appears.
6. Continue advances and the counter increments.
7. On a long question such as `Have a nice day!`, options wrap to two lines and all four are the same height.
8. Continue on question 10 navigates to a not-found route — `results.tsx` does not exist yet, which is correct here.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add Session screen with multiple-choice view and feedback banner"
```

---

## Task 6: The Results screen and the full loop

**Files:**
- Create: `src/app/results.tsx`

**Interfaces:**
- Consumes: `useSession`; `strings`; theme tokens.
- Produces: the `/results` route. Nothing later depends on it.

- [ ] **Step 1: Create the Results screen**

Missed rows are two flexed columns, not one run of text, so the LTR English prompt and the RTL Hebrew answer cannot collide. In the mirrored layout the prompt sits on the right and the answer on the left.

Create `src/app/results.tsx`:

```tsx
import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '@/hooks/useSession';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

function headlineFor(correct: number, total: number): string {
  const ratio = total === 0 ? 0 : correct / total;
  if (ratio >= 0.9) return strings.resultsHeadlineGreat;
  if (ratio >= 0.6) return strings.resultsHeadlineGood;
  return strings.resultsHeadlineKeepPractising;
}

export default function ResultsScreen() {
  const session = useSession();

  if (!session.hasSession) {
    return <Redirect href="/" />;
  }

  function onPractiseAgain() {
    session.start();
    router.replace('/session');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.score}>{`${session.correctCount} / ${session.total}`}</Text>
        <Text style={styles.headline}>{headlineFor(session.correctCount, session.total)}</Text>

        {session.missedQuestions.length > 0 ? (
          <View style={styles.missed}>
            <Text style={styles.missedTitle}>{strings.resultsMissedTitle}</Text>
            {session.missedQuestions.map((item) => (
              <View key={item.question.id} style={styles.missedRow}>
                <Text style={styles.missedPrompt}>{item.question.question}</Text>
                <Text style={styles.missedAnswer}>{item.correct_answer}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={onPractiseAgain} style={styles.primaryButton}>
          <Text style={styles.primaryLabel}>{strings.practiseAgain}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace('/')}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryLabel}>{strings.done}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl },
  body: { paddingBottom: spacing.xl, gap: spacing.sm },
  score: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  headline: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.muted,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  missed: {
    marginTop: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  missedTitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  missedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  missedPrompt: {
    flex: 1,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'ltr',
  },
  missedAnswer: {
    flex: 1,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    textAlign: 'left',
    writingDirection: 'rtl',
  },
  actions: { paddingBottom: spacing.lg, gap: spacing.sm },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondaryButton: { borderRadius: radii.md, paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: {
    color: colors.muted,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
```

- [ ] **Step 2: Type-check and run the tests**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` silent; 18 tests passing.

- [ ] **Step 3: Verify the whole app bundles, all three routes included**

This catches route and import errors that a running dev server can hide, because static rendering actually executes each screen.

```bash
npx expo export --platform web
```

Expected: `Static routes (5)` listing `/ (index)`, `/results`, `/session`, `/_sitemap` and `/+not-found`.

- [ ] **Step 4: Play the full loop end to end**

```bash
npx expo start --web
```

Walk it through and confirm each:
1. Home → `התחל` → Session.
2. Answer all ten questions; after the tenth, Continue lands on Results.
3. Score shows `n / 10`; get at least one wrong deliberately and confirm the missed list shows the English prompt and the Hebrew answer in two clean columns.
4. Get 10/10 and confirm the missed block disappears entirely.
5. `תרגל שוב` starts a fresh session from question 1.
6. `סיום` returns Home.
7. From Results, the device back gesture reaches Home, never a finished quiz.
8. Mid-session, back-swipe abandons and returns Home with no dialog.

- [ ] **Step 5: Clean up the scaffold temp directory**

```bash
rm -rf /tmp/lang-tutor-scaffold
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add Results screen, completing the phase 1 loop"
```

---

## After the plan: the play-test gate

The spec's implementation order puts a hard gate here. Phase 1 code is complete, but the **screen design is still provisional** — layout, copy, colour, spacing and interaction timing are not approved until they have been used by hand.

Run on a real phone, not only the browser:

```bash
npx expo start
```

Scan the QR code with Expo Go. Browser RTL and native RTL are not identical, so mirroring must be confirmed on a device.

What to look at, from the spec:

- Mirroring is complete and nothing sits on the wrong side.
- Long phrases wrap without breaking the option column.
- Mixed English and Hebrew rows on Results read cleanly.
- Hebrew line heights look right rather than cramped.
- The Hebrew copy in `src/strings.ts` is idiomatic. It was written without a native-speaker review, so treat every string as a draft.

Findings update the spec, then the adjustments are applied. Nothing beyond phase 1 — extra question types, gamification, persistence, a server — starts before that approval.
