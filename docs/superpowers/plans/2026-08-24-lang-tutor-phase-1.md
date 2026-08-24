# lang-tutor Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable Hebrew, right-to-left React Native app in which a Hebrew speaker answers ten multiple-choice questions about English words and phrases, drawn from hardcoded mock data — inside an npm-workspace monorepo whose shared `core` package is ready for the phase 2 Node server.

**Architecture:** An npm-workspace monorepo. `packages/core` is a dependency-free TypeScript package holding the API contract (`api/`), the quiz rules (`domain/`), and internal helpers (`utils/`); it is consumed as source, so there is no build step. `apps/mobile` is an Expo Router stack of three screens over two seams: `Question` is a tagged union so future question types are additive, and all session state flows through a single `useSession` hook. The session *cursor* lives in the app because a server will never have one; the *rules* live in core because the server must agree with the client about them.

**Tech Stack:** npm workspaces, Expo SDK 57.0.16, React Native 0.86.2, React 19.2.3, TypeScript 6.0, Expo Router 57, Jest 29 (`jest-expo` 57.0.4 in the app, Babel 7 + `@babel/preset-typescript` in core).

**Spec:** [docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md](../specs/2026-08-24-lang-tutor-phase-1-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

**Layering.** The dependency direction inside `packages/core` is strict:

| Layer | May import | Must never import |
|---|---|---|
| `api` | nothing | `domain`, `utils` |
| `utils` | nothing | `api`, `domain` |
| `domain` | `api`, `utils` | — |

Two mechanical tests that keep this honest:

- **No function in `core` takes `SessionState`.** `SessionState` is a client concept. If something in core wants it, it is client logic and belongs in `apps/mobile`.
- **A `utils` file that imports a domain type is not a util.** If `shuffle` knows what a `Question` is, it is domain logic wearing a generic name.

`utils` is **not** in core's public `exports` map, so it is unreachable from `apps/mobile` at compile time. Core's own tests reach it by relative path, which is fine — they are inside the package.

**Core has no runtime dependencies.** Not React, not React Native, not Expo. This is what makes the monorepo cheap: with nothing to duplicate, hoisting cannot produce two copies of a library. The first dependency is expected to be a validation library in `api/`, in phase 2.

**Other constraints:**

- **Route directory is `apps/mobile/src/app/`.** Verified: the SDK 57 template puts routes there, and `expo export` logs `Using src/app as the root directory for Expo Router`.
- **Path alias:** inside `apps/mobile`, `@/*` resolves to `./src/*`. Cross-package imports use `@lang-tutor/core`, `@lang-tutor/core/api`, or `@lang-tutor/core/domain` — never a relative path into `packages/`, and never a deep path like `@lang-tutor/core/src/...`.
- **Data-object fields are `snake_case`** (`vocab_entry_id`, `correct_option`, `is_correct`, `answer_string`), matching the JSON a phase 2 API will return so no mapping layer is needed. All other TypeScript and React code is `camelCase`.
- **No user-visible string inlined in a screen or component.** Every one lives in `apps/mobile/src/strings.ts`.
- **No literal colour, spacing, radius, font size, or line height in a component.** All come from `apps/mobile/src/theme.ts`.
- **Directional styles use `start`/`end`**, never `left`/`right` — `paddingStart`, `marginEnd`, `borderTopStartRadius`. RTL mirroring is then inherited rather than hand-written.
- **`SESSION_LENGTH = 10`**, exported from `packages/core/src/domain/quiz.ts`. Nothing hardcodes 10.
- **Tests cover core (`domain`, `utils`) and the app's pure modules (`session.ts`, `mockQuestions.ts`).** No component or snapshot tests in phase 1 — they would calcify the layout that is about to be iterated on.
- **Test files import their globals:** `import { describe, expect, it } from '@jest/globals';`. TypeScript 6 does not auto-resolve `@types/jest` under these tsconfigs, so relying on ambient globals fails `tsc`.
- **Verification commands.** From the repo root, `npm test` (runs every workspace) and `npm run typecheck` (same) must both be clean before any commit.

## Verified environment

Every command, version, and code block in this plan was run in a throwaway monorepo probe at the versions below. Where a step's outcome was surprising, the plan says so inline.

| Fact | Verified value |
|---|---|
| Node / npm | v22.18.0 / 10.9.3 |
| Expo | `~57.0.16` |
| `jest-expo` | `57.0.4` — on the **Jest 29** line, so Jest is pinned to `~29.7.0` everywhere |
| Route directory | `apps/mobile/src/app/` |
| `metro.config.js` needed? | **No.** Metro resolved the symlinked workspace package and its subpath `exports` with no config. |
| `babel.config.js` needed? | **Yes, in both packages.** The SDK 57 template ships without one and `jest-expo` cannot transform TypeScript without it. |
| `create-expo-app` and git | Detects the surrounding repo and **skips `git init`** — it prompts `Skip initializing a new git repository? (Y/n)`; answer **Y**. |
| Hoisting | One `react`, one `react-native`, zero nested `node_modules`. |
| `@lang-tutor/core/utils` from the app | `TS2307: Cannot find module` — encapsulation is compiler-enforced. |
| Cross-package type errors | Caught. A bad `Question` literal in the app fails `tsc` with `TS2322`. |
| Test totals | core 17, app 12, **29 at the root**. |

**Verification status of the code in this plan.** The `packages/core` code, the workspace wiring, the app's `session.ts` cursor, and the Metro/tsc/Jest resolution of all three import forms were built and run in this exact monorepo layout. The three screens and five components were built and run in an earlier single-package probe (`tsc` clean, `expo export` producing all five routes); their only change here is import paths, which is precisely the surface `tsc` was shown to check across the package boundary. Each task carries its own gate regardless.

## Deviations from the spec

The spec predates the monorepo decision and was written before any of this was built. Each difference below is deliberate.

1. **Monorepo, not a single package.** The spec implies one Expo project. The learner-facing behaviour is identical; the structure anticipates the phase 2 Node server. Decided with the user during plan review.
2. **The engine is split three ways.** The spec describes one `src/session.ts` holding everything. Auditing it against "who owns this once a server exists" splits it into shared rules (`core/domain/quiz.ts`), a generic helper (`core/utils/shuffle.ts`), and a client-only cursor (`apps/mobile/src/session.ts`). Sampling and scoring must agree with a future server; the cursor is pure UI state the server will never have.
3. **Jest covers more than one file.** The spec says "covering `src/session.ts` only". It is now four test files across two packages, because the code it described is now in four places. The coverage boundary is unchanged in spirit: pure logic yes, components no.
4. **`answer` does not advance; a separate `advance` does.** The spec's test list says "`answer` scores correctly, advances, and reaches a terminal state". It cannot advance, because the feedback banner must stay on screen showing the answered state until the learner taps Continue. Both are tested.
5. **`pickQuestions` has no default arguments.** The spec's sketch was `createSession(pool, count)`. Core stays explicit so `Math.random` never enters the shared package; the app's `createSession` wrapper supplies the defaults.
6. **The `never` exhaustiveness guard is deferred.** `type Question = MultipleChoiceQuestion` is a type *alias*, not yet a union, so `const unhandled: never = question` in the `default` branch is a compile error today (`Type 'MultipleChoiceQuestion' is not assignable to type 'never'`). The `switch` and its `default` are in place now with a runtime throw and a comment stating exactly what to change; the compile-time check begins working the moment a second member joins the union.
7. **A root `<View style={{ direction: 'rtl' }}>` wraps the stack**, in addition to `I18nManager.forceRTL(true)`. `forceRTL` alone only takes effect after a reload on native and behaves inconsistently on web; the wrapper makes the first render right-to-left everywhere.
8. **The mock set has 16 questions, not "roughly sixteen".** The test asserts the count exceeds `SESSION_LENGTH`, which is what actually matters.

## File Structure

```
lang-tutor-init/
├── package.json                        workspace root: workspaces list + cross-package scripts
├── .gitignore
├── README.md
├── docs/superpowers/{specs,plans}/
├── packages/
│   └── core/                           @lang-tutor/core — no runtime dependencies
│       ├── package.json                main + exports map; utils deliberately unexported
│       ├── tsconfig.json
│       ├── babel.config.js             Babel 7 + preset-typescript, for Jest
│       └── src/
│           ├── index.ts                public surface: api + domain
│           ├── api/
│           │   ├── index.ts
│           │   └── types.ts            Question, MultipleChoiceQuestion, AnswerRecord, Score, MissedQuestion
│           ├── domain/
│           │   ├── index.ts
│           │   ├── quiz.ts             SESSION_LENGTH, pickQuestions, evaluate, score, missed
│           │   └── quiz.test.ts        12 tests
│           └── utils/
│               ├── shuffle.ts          generic Fisher-Yates
│               ├── shuffle.test.ts     5 tests
│               └── rng.ts              seededRng, for deterministic tests
└── apps/
    ├── mobile/
    │   ├── package.json, app.json, tsconfig.json, babel.config.js
    │   └── src/
    │       ├── session.ts              SessionState cursor over core's rules
    │       ├── session.test.ts         7 tests
    │       ├── theme.ts                design tokens
    │       ├── strings.ts              every Hebrew user-visible string
    │       ├── data/
    │       │   ├── mockQuestions.ts    16 English → Hebrew questions
    │       │   └── mockQuestions.test.ts   5 tests
    │       ├── hooks/useSession.tsx    the single session-state seam
    │       ├── components/
    │       │   ├── ProgressBar.tsx     RTL-filling progress bar
    │       │   ├── OptionButton.tsx    one option; idle/correct/wrong/dimmed
    │       │   ├── MultipleChoiceView.tsx  renders an MC question; equal-height options
    │       │   └── FeedbackBanner.tsx  bottom banner, slides up after an answer
    │       └── app/
    │           ├── _layout.tsx         forces RTL, mounts SessionProvider + stack
    │           ├── index.tsx           Home
    │           ├── session.tsx         Session; dispatches on question.type
    │           └── results.tsx         Results
    └── server/                         phase 2. Not created by this plan.
```

**Task order and why.** Core first, because the app depends on it and it needs no Expo toolchain to test. Then the app scaffold, which is the riskiest task and the one that produces something playable. Then the cursor and mock data, then the three screens in navigation order.

| Task | Deliverable | Tests after |
|---|---|---|
| 1 | `packages/core` complete and tested | 17 |
| 2 | Expo app scaffolded, workspace linked, RTL proven on screen | 17 |
| 3 | Session cursor + mock questions | 29 |
| 4 | `useSession` + Home screen | 29 |
| 5 | Session screen | 29 |
| 6 | Results screen + full playable loop | 29 |

---

## Task 1: The `core` package — contract, rules, helpers

**Files:**
- Create: `package.json` (workspace root), `.gitignore`
- Create: `packages/core/{package.json,tsconfig.json,babel.config.js}`
- Create: `packages/core/src/api/{types.ts,index.ts}`
- Create: `packages/core/src/utils/{shuffle.ts,rng.ts}`
- Create: `packages/core/src/domain/{quiz.ts,index.ts}`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/src/utils/shuffle.test.ts`, `packages/core/src/domain/quiz.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `@lang-tutor/core/api` (types only):
  - `MultipleChoiceQuestion = { id: string; type: 'multiple_choice'; vocab_entry_id: string; question: string; options: string[]; correct_option: number }`
  - `Question = MultipleChoiceQuestion`
  - `AnswerRecord = { question_id: string; is_correct: boolean; answer_string: string }`
  - `Score = { correct: number; total: number }`
  - `MissedQuestion = { question: Question; correct_answer: string }`
- Produces, from `@lang-tutor/core/domain`:
  - `SESSION_LENGTH: number`
  - `pickQuestions(pool: readonly Question[], count: number, rng: () => number): Question[]`
  - `evaluate(question: Question, optionIndex: number): AnswerRecord`
  - `score(questions: readonly Question[], answers: readonly AnswerRecord[]): Score`
  - `missed(questions: readonly Question[], answers: readonly AnswerRecord[]): MissedQuestion[]`
- Produces, internal to the package (**not** exported to consumers):
  - `shuffle<T>(items: readonly T[], rng: () => number): T[]` in `utils/shuffle.ts`
  - `seededRng(seed: number): () => number` in `utils/rng.ts`

- [ ] **Step 1: Create the workspace root**

The root holds no dependencies of its own. Its scripts are the integration cycle: one command tests or type-checks every package.

Create `package.json` at the repo root:

```json
{
  "name": "lang-tutor",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "mobile": "npm run start --workspace apps/mobile",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

- [ ] **Step 2: Create the root `.gitignore`**

`apps/mobile` gets its own from the Expo scaffold in Task 2; this one covers the hoisted root.

Create `.gitignore`:

```gitignore
node_modules/
dist/
.expo/
*.tsbuildinfo
.DS_Store
npm-debug.*
.env*.local
```

- [ ] **Step 3: Create core's package manifest**

Three things here are load-bearing:

- `"main"` and `"exports"` point at **TypeScript source**, not built output. Metro and `tsc` both handle this (verified), so there is no build step, no `dist/`, no watch process, and no stale-build class of bug.
- `"./utils"` is **deliberately absent** from `exports`. That is what makes `utils` an implementation detail the app cannot reach.
- Core has **no `dependencies`**, only dev tooling.

Create `packages/core/package.json`:

```json
{
  "name": "@lang-tutor/core",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./api": "./src/api/index.ts",
    "./domain": "./src/domain/index.ts"
  },
  "scripts": {
    "test": "jest",
    "typecheck": "tsc --noEmit"
  },
  "jest": {
    "testEnvironment": "node"
  },
  "devDependencies": {
    "@babel/core": "^7.29.7",
    "@babel/preset-env": "^7.29.7",
    "@babel/preset-typescript": "^7.29.7",
    "@jest/globals": "~29.7.0",
    "jest": "~29.7.0",
    "typescript": "~6.0.3"
  }
}
```

Babel is pinned to the **7.x** line on purpose: Jest 29 bundles `babel-jest` 29, which expects `@babel/core` 7. Babel 8 would install a second, incompatible core.

- [ ] **Step 4: Create core's TypeScript config**

`types: []` keeps ambient global types out, so a missing import is an error rather than silently resolving. `verbatimModuleSyntax` forces `import type` for type-only imports, which is what keeps the `api` layer erasable.

Create `packages/core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5: Create core's Babel config**

Jest needs this to strip TypeScript. Note it does **not** use `babel-preset-expo` — core must not depend on Expo.

Create `packages/core/babel.config.js`:

```js
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-typescript',
  ],
};
```

- [ ] **Step 6: Install**

```bash
npm install
```

Expected: an `npm warn` about no workspace matching `apps/*` is fine — `apps/` does not exist yet. Confirm the symlink:

```bash
ls -l node_modules/@lang-tutor/
```

Expected: `core -> ../../packages/core`

- [ ] **Step 7: Write the API contract**

Types only, no behaviour. This is the file a phase 2 server and the mobile app both read to agree on shapes.

Create `packages/core/src/api/types.ts`:

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

export type Score = {
  correct: number;
  total: number;
};

export type MissedQuestion = {
  question: Question;
  correct_answer: string;
};
```

Create `packages/core/src/api/index.ts`:

```ts
export type {
  AnswerRecord,
  MissedQuestion,
  MultipleChoiceQuestion,
  Question,
  Score,
} from './types';
```

- [ ] **Step 8: Write the failing test for `shuffle`**

`shuffle` gets its own tests because it is now a named unit rather than a private helper — and because "did it actually reorder, and did it keep every element" is exactly the property a quiz depends on and would be miserable to debug through `pickQuestions`.

Create `packages/core/src/utils/shuffle.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { seededRng } from './rng';
import { shuffle } from './shuffle';

describe('shuffle', () => {
  it('returns a new array and leaves the input untouched', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, seededRng(1));
    expect(out).not.toBe(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('preserves every element exactly once', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = shuffle(input, seededRng(2));
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('is deterministic for a given seed', () => {
    expect(shuffle([1, 2, 3, 4, 5, 6], seededRng(3))).toEqual(
      shuffle([1, 2, 3, 4, 5, 6], seededRng(3)),
    );
  });

  it('actually reorders rather than returning the input order', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(input, seededRng(4))).not.toEqual(input);
  });

  it('handles empty and single-element arrays', () => {
    expect(shuffle([], seededRng(5))).toEqual([]);
    expect(shuffle(['only'], seededRng(6))).toEqual(['only']);
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

```bash
npm test --workspace packages/core
```

Expected: FAIL — `Cannot find module './rng'`.

- [ ] **Step 10: Implement the helpers**

A linear congruential generator: small, dependency-free, and reproducible, which is the whole point. It exists so tests can assert on shuffled output without flaking.

Create `packages/core/src/utils/rng.ts`:

```ts
/** Deterministic pseudo-random source, for reproducible tests. */
export function seededRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}
```

Create `packages/core/src/utils/shuffle.ts` — Fisher-Yates, generic, and knowing nothing about quizzes:

```ts
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
```

- [ ] **Step 11: Run it to verify it passes**

```bash
npm test --workspace packages/core
```

Expected: PASS, 5 tests.

- [ ] **Step 12: Write the failing test for the quiz rules**

Every function here takes plain data and returns plain data — no `SessionState` anywhere, which is the layering rule in action.

Create `packages/core/src/domain/quiz.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import type { Question } from '../api/types';
import { seededRng } from '../utils/rng';
import { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from './quiz';

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

describe('pickQuestions', () => {
  it('returns exactly the requested number of questions', () => {
    expect(pickQuestions(POOL, SESSION_LENGTH, seededRng(1))).toHaveLength(SESSION_LENGTH);
  });

  it('never repeats a question', () => {
    const ids = pickQuestions(POOL, SESSION_LENGTH, seededRng(2)).map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps correct_option pointing at the correct answer after shuffling options', () => {
    for (const question of pickQuestions(POOL, SESSION_LENGTH, seededRng(3))) {
      const original = POOL.find((item) => item.id === question.id)!;
      expect(question.options[question.correct_option]).toBe(
        original.options[original.correct_option],
      );
      expect([...question.options].sort()).toEqual([...original.options].sort());
    }
  });

  it('throws when the pool is smaller than the requested count', () => {
    expect(() => pickQuestions(POOL.slice(0, 3), SESSION_LENGTH, seededRng(4))).toThrow(
      'pool has 3 questions, need at least 10',
    );
  });

  it('does not mutate the pool', () => {
    const before = JSON.stringify(POOL);
    pickQuestions(POOL, SESSION_LENGTH, seededRng(5));
    expect(JSON.stringify(POOL)).toBe(before);
  });
});

describe('evaluate', () => {
  it('records a correct answer with the chosen option text', () => {
    const question = makeQuestion(1);
    expect(evaluate(question, question.correct_option)).toEqual({
      question_id: 'q1',
      is_correct: true,
      answer_string: 'a1',
    });
  });

  it('records answer_string for a wrong answer too', () => {
    const question = makeQuestion(2);
    expect(evaluate(question, 3)).toEqual({
      question_id: 'q2',
      is_correct: false,
      answer_string: 'd2',
    });
  });
});

describe('score', () => {
  it('counts correct answers against the number of questions asked', () => {
    const questions = [makeQuestion(1), makeQuestion(2), makeQuestion(3)];
    const answers = [
      evaluate(questions[0], 0),
      evaluate(questions[1], 1),
      evaluate(questions[2], 0),
    ];
    expect(score(questions, answers)).toEqual({ correct: 2, total: 3 });
  });

  it('reports zero correct for an unanswered set', () => {
    expect(score([makeQuestion(1), makeQuestion(2)], [])).toEqual({ correct: 0, total: 2 });
  });
});

describe('missed', () => {
  it('lists only wrong answers, with the correct answer text', () => {
    const questions = [makeQuestion(1), makeQuestion(2), makeQuestion(3)];
    const answers = [
      evaluate(questions[0], 0),
      evaluate(questions[1], 2),
      evaluate(questions[2], 0),
    ];
    expect(missed(questions, answers)).toEqual([
      { question: questions[1], correct_answer: 'a2' },
    ]);
  });

  it('returns an empty list for a perfect score', () => {
    const questions = [makeQuestion(1), makeQuestion(2)];
    const answers = questions.map((question) => evaluate(question, question.correct_option));
    expect(missed(questions, answers)).toEqual([]);
  });

  it('ignores answers whose question is not in the set', () => {
    const questions = [makeQuestion(1)];
    expect(missed(questions, [evaluate(makeQuestion(99), 1)])).toEqual([]);
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

```bash
npm test --workspace packages/core
```

Expected: FAIL — `Cannot find module './quiz'`.

- [ ] **Step 14: Implement the quiz rules**

Create `packages/core/src/domain/quiz.ts`:

```ts
import type { AnswerRecord, MissedQuestion, Question, Score } from '../api/types';
import { shuffle } from '../utils/shuffle';

export const SESSION_LENGTH = 10;

function shuffleOptions(question: Question, rng: () => number): Question {
  const correct = question.options[question.correct_option];
  const options = shuffle(question.options, rng);
  return { ...question, options, correct_option: options.indexOf(correct) };
}

// No default arguments: a server must not inherit Math.random by accident. The
// app's createSession wrapper supplies the client-side defaults.
export function pickQuestions(
  pool: readonly Question[],
  count: number,
  rng: () => number,
): Question[] {
  if (pool.length < count) {
    throw new Error(`pool has ${pool.length} questions, need at least ${count}`);
  }
  return shuffle(pool, rng)
    .slice(0, count)
    .map((question) => shuffleOptions(question, rng));
}

export function evaluate(question: Question, optionIndex: number): AnswerRecord {
  return {
    question_id: question.id,
    is_correct: optionIndex === question.correct_option,
    answer_string: question.options[optionIndex],
  };
}

export function score(questions: readonly Question[], answers: readonly AnswerRecord[]): Score {
  return {
    correct: answers.filter((record) => record.is_correct).length,
    total: questions.length,
  };
}

export function missed(
  questions: readonly Question[],
  answers: readonly AnswerRecord[],
): MissedQuestion[] {
  return answers
    .filter((record) => !record.is_correct)
    .flatMap((record) => {
      const question = questions.find((item) => item.id === record.question_id);
      return question
        ? [{ question, correct_answer: question.options[question.correct_option] }]
        : [];
    });
}
```

- [ ] **Step 15: Write the barrels**

Create `packages/core/src/domain/index.ts`:

```ts
export { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from './quiz';
```

Create `packages/core/src/index.ts`:

```ts
export * from './api';
export * from './domain';
// utils is deliberately absent: it is internal to this package.
```

- [ ] **Step 16: Run the tests and the type-checker**

```bash
npm test --workspace packages/core
npm run typecheck --workspace packages/core
```

Expected: 17 tests passing across 2 suites (`shuffle.test.ts`, `quiz.test.ts`), and `tsc` silent. Core's suite runs in well under a second — no React Native machinery is loaded.

- [ ] **Step 17: Commit**

```bash
git add -A
git commit -m "Add @lang-tutor/core: api contract, quiz rules and helpers"
```

---

## Task 2: Scaffold the Expo app, link the workspace, force RTL

**Files:**
- Create (by scaffold): `apps/mobile/{package.json,app.json,tsconfig.json,.gitignore}`, `apps/mobile/assets/`
- Create: `apps/mobile/babel.config.js`, `apps/mobile/src/theme.ts`, `apps/mobile/src/strings.ts`
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/app/index.tsx`, `README.md`

**Interfaces:**
- Consumes: `@lang-tutor/core` exists as a workspace package (Task 1).
- Produces: a running Expo app with RTL forced; `colors`, `spacing`, `radii`, `fontSizes`, `lineHeights` from `@/theme`; `strings` from `@/strings`.

This is the riskiest task in the plan, so its steps are the most explicit. Read Step 1's note before running anything.

- [ ] **Step 1: Scaffold the app with `--no-install`**

Two behaviours to know, both verified rather than assumed:

- **It will ask about git.** Because the repo already exists, `create-expo-app` prints `You are creating a project inside of an existing Git repository. Skip initializing a new git repository? (Y/n)`. **Answer Y** (the default). It then creates no nested `.git`, so this repo's history is never at risk.
- **`--no-install` matters.** Without it, npm installs into `apps/mobile/node_modules` and writes `apps/mobile/package-lock.json`, both of which then have to be deleted so the workspace root can own dependency resolution. Skipping the install avoids that entirely.

```bash
npx --yes create-expo-app@latest apps/mobile --template default --no-install
```

Expected: `✅ Your project is ready!` and a warning that modules are not installed — that warning is correct here; the root install in Step 3 handles it.

- [ ] **Step 2: Verify the scaffold matches this plan's assumptions**

```bash
node -e "console.log('expo', require('./apps/mobile/package.json').dependencies.expo)"
ls apps/mobile/src/app
ls -d apps/mobile/.git 2>/dev/null || echo "no nested .git - good"
git log --oneline | head -3
```

Expected: an `expo` version on the `~57` line; `_layout.tsx explore.tsx index.tsx` under `src/app/`; no nested `.git`; and this repo's existing commits still listed. If the SDK is not 57, stop — the `jest-expo` version and route paths below need revisiting.

- [ ] **Step 3: Wire the app's manifest, then install once**

Edit `apps/mobile/package.json`. Add `@lang-tutor/core` as a dependency, add the two scripts the root commands call, and add the Jest block. **Keep** the `reset-project` script for now — Step 4 needs it.

Add to `"dependencies"`:

```json
    "@lang-tutor/core": "*"
```

Add to `"devDependencies"`:

```json
    "@jest/globals": "~29.7.0",
    "jest": "~29.7.0",
    "jest-expo": "~57.0.4"
```

Add to `"scripts"`:

```json
    "test": "jest",
    "typecheck": "tsc --noEmit"
```

Add at the top level:

```json
  "jest": {
    "preset": "jest-expo",
    "testPathIgnorePatterns": ["/node_modules/", "/dist/"]
  }
```

`jest-expo` 57.0.4 depends on `babel-jest` and `@jest/globals` in the `^29` range, which is why Jest is pinned to `~29.7.0` and not the current 30.

Then install from the root — once, for every workspace:

```bash
npm install
```

Verify the link and that nothing was duplicated:

```bash
ls -l node_modules/@lang-tutor/
ls -d apps/mobile/node_modules packages/core/node_modules 2>/dev/null || echo "fully hoisted - good"
find . -type d -path "*/node_modules/react" -not -path "*/node_modules/*/node_modules/*" | head
```

Expected: `core -> ../../packages/core`; no nested `node_modules`; exactly one `./node_modules/react`. More than one copy of React means hoisting failed and the app will fail at runtime with `Invalid hook call` — stop and resolve it before continuing.

- [ ] **Step 4: Strip the template's example app**

The template ships a tabs example. `reset-project` deletes `src/` and `scripts/` and writes a minimal `src/app/index.tsx` and `src/app/_layout.tsx`. It prompts; piping `n` chooses delete rather than move-to-`/example`.

```bash
cd apps/mobile && echo "n" | node ./scripts/reset-project.js && cd ../..
find apps/mobile/src -type f
```

Expected output includes `❌ /src deleted.` and `❌ /scripts deleted.`, leaving exactly `apps/mobile/src/app/_layout.tsx` and `apps/mobile/src/app/index.tsx`.

- [ ] **Step 5: Remove the now-dangling script**

`scripts/` no longer exists. Delete this line from `"scripts"` in `apps/mobile/package.json`:

```json
    "reset-project": "node ./scripts/reset-project.js",
```

- [ ] **Step 6: Set the app's identity and pin it to a light interface**

Edit `apps/mobile/app.json`. Change `name`, `slug`, `scheme`, and change `userInterfaceStyle` from `"automatic"` to `"light"` — phase 1 is light-theme only, and leaving it automatic lets a device in dark mode recolour system surfaces underneath the design being judged.

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

Leave every other key exactly as the template wrote it.

- [ ] **Step 7: Create the app's Babel config**

The SDK 57 template ships without one and `jest-expo` cannot transform TypeScript without it. Unlike core's, this one uses the Expo preset.

Create `apps/mobile/babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
```

- [ ] **Step 8: Create the theme tokens**

Create `apps/mobile/src/theme.ts`:

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

- [ ] **Step 9: Create the Hebrew strings module**

Create `apps/mobile/src/strings.ts`:

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

All Hebrew copy here is a **draft** — written without a native-speaker review. It is in one file precisely so the play-test can rewrite it cheaply.

- [ ] **Step 10: Force RTL in the root layout**

Replace the contents of `apps/mobile/src/app/_layout.tsx`:

```tsx
import { Stack } from 'expo-router';
import { I18nManager, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/theme';

// Must run before the first render. Native only applies a direction flip on
// reload, so RTL is set once at startup and never toggled.
I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

export default function RootLayout() {
  return (
    // Every screen uses SafeAreaView. The navigator happens to provide a
    // fallback provider, but relying on that is relying on an internal detail —
    // and on web the insets are zero without an explicit provider.
    <SafeAreaProvider>
      <View style={styles.root}>
        <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  // `direction` is belt-and-braces alongside forceRTL: it makes the very first
  // render right-to-left without waiting for a reload, and it works on web.
  root: { flex: 1, direction: 'rtl', backgroundColor: colors.background },
  content: { backgroundColor: colors.background },
});
```

- [ ] **Step 11: Write a temporary RTL smoke screen**

This screen exists only to prove mirroring works, and Task 4 replaces it with the real Home screen. It is worth its own step because an RTL bug found here costs minutes, and found after three screens are built costs hours.

Replace the contents of `apps/mobile/src/app/index.tsx`:

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

- [ ] **Step 12: Type-check both packages from the root**

```bash
npm run typecheck
```

Expected: silent for both workspaces. This is the first time the root command covers two packages.

- [ ] **Step 13: Run the app and confirm mirroring**

```bash
npm run mobile
```

Then press `w` for the browser. Expected, all four:

1. The markers read `3 2 1` from left to right — that is `1 2 3` laid out right-to-left, which proves the row mirrored.
2. The Hebrew line is right-aligned.
3. The English line is centred and reads `How do you do?` correctly, with the `?` at its right-hand end.
4. The background is the light `#F5F6FA`, not white.

If the markers read `1 2 3` from the left, mirroring is not active — stop and fix before building anything on top of it.

- [ ] **Step 14: Replace the root README**

The repo root README is currently a single line, and the scaffold wrote its own boilerplate inside `apps/mobile/` (leave that one alone). Replace the root `README.md` entirely (the outer four-backtick fence is this plan's; the file starts at `# lang-tutor`):

````markdown
# lang-tutor

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 runs entirely on mock data with a single multiple-choice question type,
so the look and feel can be judged on a real device before any server exists.

- Design: [docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md)
- Plan: [docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)

## Layout

An npm-workspace monorepo.

| Path | What it is |
|---|---|
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). No runtime dependencies. Consumed as TypeScript source, so there is no build step. |
| `apps/mobile` | The Expo app. Screens, components, theme, Hebrew copy, and the session cursor. |
| `apps/server` | Phase 2. Does not exist yet. |

`utils/` is not in core's `exports` map, so it is unreachable from the app by
design. Anything the app needs comes from `@lang-tutor/core/api` (types) or
`@lang-tutor/core/domain` (rules).

## Running it

```bash
npm install       # from the repo root — it owns dependency resolution
npm run mobile
```

Then press `w` for the browser, or scan the QR code with Expo Go on a phone.
The interface is Hebrew and right-to-left; browser and native RTL are not
identical, so confirm layout on a real device.

## Checks

```bash
npm test          # every workspace
npm run typecheck # every workspace
```
````

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "Scaffold Expo app in the workspace with forced RTL, tokens and Hebrew strings"
```

---

## Task 3: The session cursor and the mock questions

**Files:**
- Create: `apps/mobile/src/session.ts`, `apps/mobile/src/data/mockQuestions.ts`
- Test: `apps/mobile/src/session.test.ts`, `apps/mobile/src/data/mockQuestions.test.ts`

**Interfaces:**
- Consumes: `Question`, `AnswerRecord`, `Score`, `MissedQuestion` from `@lang-tutor/core/api`; `SESSION_LENGTH`, `pickQuestions`, `evaluate`, `score`, `missed` from `@lang-tutor/core/domain`.
- Produces, from `@/session`:
  - `SESSION_LENGTH` (re-exported, so screens have one import for it)
  - `SessionState = { questions: Question[]; index: number; answers: AnswerRecord[]; selected_option: number | null }`
  - `createSession(pool: readonly Question[], count?: number, rng?: () => number): SessionState`
  - `answer(state, optionIndex): SessionState`, `advance(state): SessionState`
  - `currentQuestion(state): Question | undefined`, `isAnswered(state): boolean`, `isComplete(state): boolean`
  - `progress(state): { position: number; total: number }`
  - `sessionScore(state): Score`, `missedQuestions(state): MissedQuestion[]`
- Produces, from `@/data/mockQuestions`: `mockQuestions: Question[]` — 16 entries.

Note the naming: core exports `score` and `missed`, which take plain data; the app wraps them as `sessionScore` and `missedQuestions`, which take a `SessionState`. Different names because they are different functions with different arities — reusing the names would make call sites ambiguous about which layer they are in.

- [ ] **Step 1: Write the failing test for the cursor**

This tests only what the app owns: where you are in a session, and that answering does not advance. Sampling and scoring are already tested in core, so these tests use a fixed `rng` and assert on delegation rather than re-testing the rules.

Create `apps/mobile/src/session.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import {
  SESSION_LENGTH,
  advance,
  answer,
  createSession,
  currentQuestion,
  isAnswered,
  isComplete,
  missedQuestions,
  progress,
  sessionScore,
} from './session';

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

describe('createSession', () => {
  it('starts unanswered on the first question', () => {
    const state = createSession(POOL, SESSION_LENGTH, () => 0.5);
    expect(state.questions).toHaveLength(SESSION_LENGTH);
    expect(state.index).toBe(0);
    expect(state.answers).toEqual([]);
    expect(isAnswered(state)).toBe(false);
    expect(progress(state)).toEqual({ position: 1, total: 10 });
  });
});

describe('answer', () => {
  it('records the answer without advancing', () => {
    const state = createSession(POOL, 2, () => 0.5);
    const question = currentQuestion(state)!;
    const next = answer(state, question.correct_option);
    expect(next.answers).toHaveLength(1);
    expect(next.answers[0].is_correct).toBe(true);
    expect(next.selected_option).toBe(question.correct_option);
    expect(next.index).toBe(0);
  });

  it('ignores a second answer to the same question', () => {
    const state = createSession(POOL, 2, () => 0.5);
    const once = answer(state, 0);
    expect(answer(once, 1)).toBe(once);
  });
});

describe('advance', () => {
  it('moves on and clears the selection', () => {
    const state = advance(answer(createSession(POOL, 2, () => 0.5), 0));
    expect(state.index).toBe(1);
    expect(state.selected_option).toBeNull();
  });

  it('does nothing while unanswered', () => {
    const state = createSession(POOL, 2, () => 0.5);
    expect(advance(state)).toBe(state);
  });

  it('reaches a terminal state after the last question', () => {
    let state = createSession(POOL, 2, () => 0.5);
    state = advance(answer(state, 0));
    expect(isComplete(state)).toBe(false);
    state = advance(answer(state, 0));
    expect(isComplete(state)).toBe(true);
    expect(currentQuestion(state)).toBeUndefined();
  });
});

describe('sessionScore and missedQuestions', () => {
  it('delegates scoring to the shared domain rules', () => {
    let state = createSession(POOL, 3, () => 0.5);
    const first = currentQuestion(state)!;
    state = advance(answer(state, first.correct_option));
    const second = currentQuestion(state)!;
    const wrong = (second.correct_option + 1) % second.options.length;
    state = advance(answer(state, wrong));
    const third = currentQuestion(state)!;
    state = advance(answer(state, third.correct_option));

    expect(sessionScore(state)).toEqual({ correct: 2, total: 3 });
    expect(missedQuestions(state)).toEqual([
      { question: second, correct_answer: second.options[second.correct_option] },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test --workspace apps/mobile
```

Expected: FAIL — `Cannot find module './session'`.

- [ ] **Step 3: Implement the cursor**

Every function here takes or returns a `SessionState`, which is exactly why none of it belongs in core.

Create `apps/mobile/src/session.ts`:

```ts
import type { AnswerRecord, MissedQuestion, Question, Score } from '@lang-tutor/core/api';
import { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from '@lang-tutor/core/domain';

// Re-exported so screens have a single import for it rather than reaching past
// this module into core.
export { SESSION_LENGTH };

export type SessionState = {
  questions: Question[];
  index: number;
  answers: AnswerRecord[];
  /** null while the current question is unanswered. */
  selected_option: number | null;
};

// In phase 2 this stops calling pickQuestions and starts calling the API. The
// cursor, the selectors and all four screens are untouched by that change.
export function createSession(
  pool: readonly Question[],
  count: number = SESSION_LENGTH,
  rng: () => number = Math.random,
): SessionState {
  return {
    questions: pickQuestions(pool, count, rng),
    index: 0,
    answers: [],
    selected_option: null,
  };
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
  return {
    ...state,
    selected_option: optionIndex,
    answers: [...state.answers, evaluate(question, optionIndex)],
  };
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

export function sessionScore(state: SessionState): Score {
  return score(state.questions, state.answers);
}

export function missedQuestions(state: SessionState): MissedQuestion[] {
  return missed(state.questions, state.answers);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test --workspace apps/mobile
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing test for the mock questions**

The long-prompt assertion is the one that matters most: it stops someone shrinking the set to short words, which would hide option-wrapping bugs until real content arrived.

Create `apps/mobile/src/data/mockQuestions.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { mockQuestions } from './mockQuestions';

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

- [ ] **Step 6: Run it to verify it fails**

```bash
npm test --workspace apps/mobile
```

Expected: FAIL — `Cannot find module './mockQuestions'`.

- [ ] **Step 7: Write the mock data**

Distractors are hand-written and length-matched to the correct answer, so option length never gives the answer away. For phrase questions the distractors are other plausible phrases, not single words, for the same reason.

Create `apps/mobile/src/data/mockQuestions.ts`:

```ts
import type { Question } from '@lang-tutor/core/api';

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

Note `q-i-dont-understand` uses double quotes, because the prompt contains an apostrophe.

- [ ] **Step 8: Run everything from the root**

```bash
npm test
npm run typecheck
```

Expected: **29 tests** — 17 in `packages/core`, 12 in `apps/mobile` — and `tsc` silent for both.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add session cursor over core rules and 16 mock questions"
```

---

## Task 4: The `useSession` seam and the Home screen

**Files:**
- Create: `apps/mobile/src/hooks/useSession.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/app/index.tsx`

**Interfaces:**
- Consumes: everything from `@/session`; `mockQuestions` from `@/data/mockQuestions`; `MissedQuestion` and `Question` from `@lang-tutor/core/api`; `strings`; theme tokens.
- Produces:
  - `SessionProvider({ children }: { children: ReactNode })`
  - `useSession(): SessionValue`, where

    ```ts
    type SessionValue = {
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
    ```

This hook is the only place session state is read or written. Screens import `@/session` for `SESSION_LENGTH` and nothing else.

- [ ] **Step 1: Create the provider and hook**

Note `MissedQuestion` is imported from core rather than redeclared here — the Results screen and a future server therefore describe a missed question with the same type.

Create `apps/mobile/src/hooks/useSession.tsx`:

```tsx
import type { MissedQuestion, Question } from '@lang-tutor/core/api';
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
  missedQuestions,
  progress,
  sessionScore,
  type SessionState,
} from '@/session';

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
    setState(createSession(mockQuestions));
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
      correctCount: sessionScore(state).correct,
      missedQuestions: missedQuestions(state),
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

In `apps/mobile/src/app/_layout.tsx`, add the import and wrap the existing `<View>`:

```tsx
import { SessionProvider } from '@/hooks/useSession';
```

```tsx
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <View style={styles.root}>
          <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
        </View>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
```

Leave the `I18nManager` calls, the `SafeAreaProvider` import and the `styles` block untouched.

- [ ] **Step 3: Replace the RTL smoke screen with the real Home screen**

This deletes the temporary screen from Task 2. Replace the whole contents of `apps/mobile/src/app/index.tsx`:

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

- [ ] **Step 4: Type-check and run the tests**

```bash
npm run typecheck
npm test
```

Expected: `tsc` silent; 29 tests still passing. There are no tests for the hook — phase 1 tests pure logic, not React.

- [ ] **Step 5: Run the app and confirm Home**

```bash
npm run mobile
```

Press `w`. Expected: title `lang tutor`, Hebrew subtitle and card label both right-aligned, card reading `10 מילים באנגלית`, and a blue `התחל` button. Tapping it navigates to a not-found route — `src/app/session.tsx` does not exist yet, which is correct at this point.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add useSession state seam and the Home screen"
```

---

## Task 5: The Session screen

**Files:**
- Create: `apps/mobile/src/components/{ProgressBar,OptionButton,MultipleChoiceView,FeedbackBanner}.tsx`
- Create: `apps/mobile/src/app/session.tsx`

**Interfaces:**
- Consumes: `useSession` from `@/hooks/useSession`; `MultipleChoiceQuestion` and `Question` from `@lang-tutor/core/api`; `strings`; theme tokens.
- Produces:
  - `ProgressBar({ position, total }: { position: number; total: number })`
  - `OptionVisualState = 'idle' | 'correct' | 'wrong' | 'dimmed'`
  - `OptionButton({ label, state, disabled, minHeight, onPress, onMeasure })` where `onMeasure: (height: number) => void` and `minHeight?: number`
  - `MultipleChoiceView({ question, selectedOption, onSelect })`
  - `FeedbackBanner({ isCorrect, correctAnswer, onContinue })`

- [ ] **Step 1: Create the progress bar**

Two flexed children rather than a percentage width: flex ratios mirror automatically inside an RTL row, so the bar fills right-to-left with no direction-specific code.

Create `apps/mobile/src/components/ProgressBar.tsx`:

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

Create `apps/mobile/src/components/OptionButton.tsx`:

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

Create `apps/mobile/src/components/MultipleChoiceView.tsx`:

```tsx
import type { MultipleChoiceQuestion } from '@lang-tutor/core/api';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

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

Create `apps/mobile/src/components/FeedbackBanner.tsx`:

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

Create `apps/mobile/src/app/session.tsx`:

```tsx
import type { Question } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedbackBanner } from '@/components/FeedbackBanner';
import { MultipleChoiceView } from '@/components/MultipleChoiceView';
import { ProgressBar } from '@/components/ProgressBar';
import { useSession } from '@/hooks/useSession';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

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
npm run typecheck
npm test
```

Expected: `tsc` silent; 29 tests passing.

- [ ] **Step 7: Run the app and play through a session**

```bash
npm run mobile
```

Press `w`. Expected, all of it:

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

## Task 6: The Results screen and the full playable loop

**Files:**
- Create: `apps/mobile/src/app/results.tsx`

**Interfaces:**
- Consumes: `useSession` from `@/hooks/useSession` (`correctCount`, `total`, `missedQuestions`, `hasSession`, `start`); `strings`; theme tokens.
- Produces: nothing consumed by later tasks — this closes the loop.

- [ ] **Step 1: Create the Results screen**

The missed list uses two flexed columns rather than one bidirectional string. Mixing an English phrase and a Hebrew translation in a single `Text` puts the bidi algorithm in charge of the order, and it will not always agree with the layout. Separate `Text` nodes, each with its own `writingDirection`, are deterministic.

Create `apps/mobile/src/app/results.tsx`:

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

  const { correctCount, total, missedQuestions } = session;

  // A new session, then replace: Results never stacks up behind itself.
  function onPractiseAgain() {
    session.start();
    router.replace('/session');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.headline}>{headlineFor(correctCount, total)}</Text>
        <Text style={styles.score}>{`${correctCount} / ${total}`}</Text>

        {missedQuestions.length > 0 ? (
          <View style={styles.missed}>
            <Text style={styles.missedTitle}>{strings.resultsMissedTitle}</Text>
            {missedQuestions.map(({ question, correct_answer }) => (
              <View key={question.id} style={styles.missedRow}>
                <Text style={styles.missedPrompt}>{question.question}</Text>
                <Text style={styles.missedAnswer}>{correct_answer}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={onPractiseAgain} style={styles.primary}>
          <Text style={styles.primaryLabel}>{strings.practiseAgain}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace('/')}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>{strings.done}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg },
  body: { paddingTop: spacing.xxl, paddingBottom: spacing.xl, gap: spacing.md },
  headline: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  score: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
  },
  missed: { marginTop: spacing.lg, gap: spacing.sm },
  missedTitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
    color: colors.muted,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  missedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  // The English side sits at the start of the row (the right, under RTL) and
  // reads LTR internally; the Hebrew side takes the remaining half.
  missedPrompt: {
    flex: 1,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'ltr',
    textAlign: 'right',
  },
  missedAnswer: {
    flex: 1,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
    textAlign: 'left',
  },
  actions: { paddingBottom: spacing.lg, gap: spacing.sm },
  primary: {
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
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
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
npm run typecheck
npm test
```

Expected: `tsc` silent; 29 tests passing across both workspaces.

- [ ] **Step 3: Verify the router builds every route**

```bash
npm exec --workspace apps/mobile -- expo export --platform web
```

Expected in the output: `Using src/app as the root directory for Expo Router` and `Static routes (5)` — Home, Session, Results, plus the `_sitemap` and `+not-found` routes Expo Router generates. A route missing here means a file in `src/app/` has no default export.

Delete the build artefact so it never lands in a commit:

```bash
rm -rf apps/mobile/dist
```

Confirm `git status` is clean apart from the new screen.

- [ ] **Step 4: Play the whole loop**

```bash
npm run mobile
```

Press `w`, then walk the loop end to end:

1. Home → Start → question `1 / 10`.
2. Answer all ten; deliberately get about three wrong.
3. Continue on question 10 lands on Results — no flash of an empty session.
4. Score reads `7 / 10`; the headline matches the band (`≥ 9` great, `≥ 6` good, else keep practising).
5. The missed list holds exactly the three you got wrong, each with its correct translation.
6. Practise again starts a fresh session at `1 / 10` with a different question order.
7. Done returns Home.
8. From Results, the browser back button reaches Home rather than the finished session.
9. Back-swipe (or back button) mid-session abandons it and returns Home with no confirmation; Start then begins a new session at `1 / 10`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add Results screen and close the practice loop"
```

- [ ] **Step 6: Remove the probe directory**

The probe at `/tmp/ltmono` verified the workspace wiring and is no longer needed:

```bash
rm -rf /tmp/ltmono
```

---

## Play-test gate

Everything above is buildable from the spec alone. What follows cannot be: it needs a person, a phone and an opinion. Spec implementation steps 2 and 3 land here.

- [ ] **Step 1: Run it on a real phone**

```bash
npm run mobile
```

Scan the QR code with Expo Go. A phone is required, not a simulator — thumb reach, tap accuracy and Hebrew font rendering are all wrong on a desktop browser.

- [ ] **Step 2: Play at least five full sessions and record what is wrong**

Judge, in this order. The first four are the spec's own play-test checklist; browser RTL and native RTL are not identical, which is why they are checked here rather than in Task 5.

1. **Mirroring** — is it complete? Nothing on the wrong side: back arrow top right, counter top left, progress filling right to left, options right-aligned, stack screens sliding in from the left.
2. **Wrapping** — do long phrases wrap without breaking the option column, and do all four buttons still match heights on a narrow phone?
3. **Results rows** — do the mixed English and Hebrew rows read cleanly, with no collision between the two scripts?
4. **Reading comfort** — is the English prompt large enough, and are the Hebrew line heights right rather than cramped? (`lineHeights` in `theme.ts` is explicitly marked as needing this pass.)
5. **Rhythm** — does the answer → feedback → continue cycle feel quick or laboured? The banner is 220 ms; try 150 and 300.
6. **Reach** — can the options and Continue all be hit one-handed?
7. **Copy** — every Hebrew string was written without a native-speaker review. Correct all of it in `strings.ts`.
8. **Content** — do the 16 mock questions read like real practice material, and are the distractors plausible rather than obviously wrong?

- [ ] **Step 3: Fix what the play-test found**

Small, committed changes: theme tokens, timings, copy, mock data. If a finding needs a structural change — a different question layout, a change to how feedback is delivered — it is a **spec change**, not a fix. Write it into the spec, then plan it.

- [ ] **Step 4: Update the spec with what the play-test decided**

Amend `docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md` with the settled values (final timings, type sizes, reviewed copy) and commit. Phase 2 starts from the spec, so anything decided by hand and left only in the code will be lost.

- [ ] **Step 5: Get approval**

Phase 1 is done when the look and feel is approved on a real device. That approval is the entry condition for phase 2 (real vocabulary data and a server).

