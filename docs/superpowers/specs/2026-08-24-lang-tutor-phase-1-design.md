# lang-tutor — Phase 1 Design

**Date:** 2026-08-24
**Status:** Approved in principle. Screen design is provisional — see [Approval model](#approval-model).

## Purpose

Build the first phase of the lang-tutor mobile app: a small, working app running
entirely on mock data, with a single question type, so the look and feel can be
evaluated on a real device before any server work begins.

Phase 1 is not a demo to be thrown away. It is the foundation later phases build
on, so its seams matter more than its feature count.

## Approval model

The screen design in this document is **provisional**. It is detailed enough to
build from, not settled enough to be final.

The first implementation step is a playable build. Final approval of layout,
copy, colour, spacing, and interaction timing happens only after hands-on use of
that build. Reactions from playing with it feed back into this document, which is
then updated. Nothing downstream — extra question types, gamification, a server —
starts before that approval.

## Scope

### In scope

- Three screens: Home, Session, Results.
- One question type: multiple choice, four options.
- Immediate answer feedback with a learner-controlled Continue step.
- Hardcoded Spanish → English mock questions.
- In-memory state only.

### Out of scope

Deliberately excluded from phase 1, all of which the design leaves room for:

- Any second question type (free text, voice, pronunciation, pictures).
- Points, streaks, daily targets, gamification.
- Adding or editing words.
- Persistence across app launches.
- Any server, API client, or authentication.
- Dark mode.
- Component or snapshot tests.

## Platform and stack

| Choice | Value | Reason |
|---|---|---|
| Framework | React Native via Expo | Works with the installed Node toolchain; no Xcode or Android Studio required. |
| Language | TypeScript | Tagged-union question types depend on real discriminated unions. |
| Navigation | Expo Router (file-based stack) | Native stack transitions and back gesture for free — both are part of the feel being judged. |
| Styling | `StyleSheet` over a theme token module | No component library. Gamified, custom UI later would fight a prebuilt one. |
| Tests | Jest, against the pure session engine only | See [Testing](#testing). |

Preview paths: `expo start` then `w` for the browser (fast iteration loop), or the
QR code with Expo Go on a physical phone (the honest test for feel).

## Data model

All data-object fields use `snake_case`, matching the shape a future JSON API is
expected to return, so phase 2 needs no mapping layer. TypeScript and React code
elsewhere stays `camelCase`.

```ts
type MultipleChoiceQuestion = {
  id: string;
  type: 'multiple_choice';
  vocab_entry_id: string;
  question: string;        // "la ventana"
  options: string[];       // four translations
  correct_option: number;  // index into options
};

type Question = MultipleChoiceQuestion;

type AnswerRecord = {
  question_id: string;
  is_correct: boolean;
};
```

Three deliberate decisions here:

**`Question` is a tagged union with one member.** The `type` field exists from day
one so the session screen dispatches through a `switch` rather than an `if` that
someone later has to convert. Adding free text, voice, or picture questions then
means writing a renderer and adding a case; the session flow, progress bar,
feedback banner, scoring, and Results screen keep working untouched. This is the
single most important seam in phase 1, and it costs roughly ten lines.

**`correct_option` is an index, not a string.** Duplicate option text can never
produce a false positive, and the tapped-option state is already an index.

**`AnswerRecord` carries only `is_correct`.** Scoring records whether a question
was answered correctly, never whether a particular button was tapped. Voice and
free-text answers therefore drop into scoring and Results without changes. Future
question types may attach their own raw payload; `is_correct` remains the
contract.

There is no vocabulary-entry type in phase 1. `vocab_entry_id` is an opaque
forward-looking string.

## Mock data

`src/data/mockQuestions.ts` exports a hardcoded `Question[]` of roughly twelve
Spanish → English multiple-choice questions, each with its four options written
out by hand.

Hand-written options are a feature, not a shortcut: distractors generated at
random would be semantically unrelated, and plausible distractors are what make a
multiple-choice question actually test recall. Writing them by hand also removes
the distractor-generation code path entirely.

In phase 2 this module becomes what a repository function returns, rather than
something screens import.

## Session engine

`src/session.ts` — plain TypeScript, no React imports, no side effects.

```
createSession(pool: Question[], count: number) -> SessionState
answer(state: SessionState, optionIndex: number) -> SessionState
```

Plus selectors for the current question, progress, and score. `createSession`
samples `count` questions without repeats and shuffles each question's option
order, adjusting `correct_option` to match.

Session length is a single exported constant, `SESSION_LENGTH = 10`. Screens and
Home's copy both read it, so changing session size is a one-line edit.

Screens never import this module directly. They go through a single `useSession`
hook, which is the only place session state is read or written. Phase 1 backs it
with React state; when points, targets, streaks, and persistence arrive, that hook
gains a storage backend and no screen changes. This is the second seam that makes
"in-memory only" a deliberate first implementation of an interface rather than a
shortcut to unpick.

## Screens

Navigation is an Expo Router stack. Results **replaces** Session in the stack
rather than pushing onto it, so backing out of Results reaches Home rather than a
completed quiz.

### Home — `app/index.tsx`

App title, a card showing the set (`Spanish · 10 words today`), and a primary
Start button that navigates to Session. Nothing else.

The layout intentionally leaves empty space below the card. Home is where streak,
points, and daily-target widgets land in later phases, so it starts as a visibly
unfinished hub rather than a splash screen.

### Session — `app/session.tsx`

The screen that matters most.

Header row with a back affordance and a `3 / 10` counter; a progress bar beneath
it; the question prompt; then the four options.

Session owns the question flow and the feedback banner. It does **not** own how a
question looks: it switches on `question.type` and delegates rendering. Phase 1
has one case, `multiple_choice`, rendering `MultipleChoiceView`.

Two states per question:

- **Answering** — four neutral option buttons, no banner.
- **Answered** — the tapped option turns green or red; the correct option is
  always shown green; the remaining two dim and stop responding to touch. A banner
  slides up from the bottom with a short message and a Continue button.

Continue advances to the next question, or to Results after the last one. The
learner controls the pace; nothing auto-advances.

Back-swipe mid-session abandons the session and returns Home, with no confirmation
dialog. A confirmation is worth adding later, but a modal now would interrupt the
flow being evaluated.

### Results — `app/results.tsx`

Score as `8 / 10`, a headline that varies by score band, a list of the missed
questions, and two buttons: **Practise again** (builds a fresh session) and
**Done** (returns Home).

Each row in the missed list shows the question prompt and its correct answer,
read as `options[correct_option]` — there is no separate translation field in
phase 1.

The missed-questions list is the one element here that is not decorative — it is
genuinely useful, and it is where a future "review these later" feature grows
from.

## Styling

`src/theme.ts` exports design tokens:

- **Colours** — background, surface, text, muted, correct, wrong, primary.
- **Spacing** — a single numeric scale.
- **Radii** and **font sizes**.

Components use `StyleSheet.create` referencing those tokens, never literal colour
or spacing values. Look-and-feel iteration then happens in one file, which matters
because that iteration is the entire point of phase 1.

Light theme with one accent colour. Dark mode later is a token swap, not a
refactor.

## Testing

Jest, covering `src/session.ts` only:

- A created session has exactly the requested number of questions.
- No question repeats within a session.
- `correct_option` still indexes the correct answer after option shuffling.
- `answer` scores correctly, advances, and reaches a terminal state after the
  last question.

No component or snapshot tests in phase 1. They would calcify the exact layout
and copy that is about to be iterated on.

## Implementation order

1. **Scaffold and build a playable app** — Expo project, theme tokens, mock
   questions, session engine with its tests, and the three screens. Runnable in a
   browser and on a phone via Expo Go. This step exists so the design can be
   judged by using it.
2. **Play-test and approve** — hands-on evaluation of look and feel. Findings
   update this document.
3. **Apply approved changes** — layout, copy, colour, spacing, and timing
   adjustments from step 2.

Steps beyond phase 1 are out of scope for this document.

## Phase 2 readiness

Three decisions carry the weight of everything planned after phase 1:

| Future need | What phase 1 already provides |
|---|---|
| Free text, voice, pronunciation, picture questions | `Question` is a tagged union; Session dispatches on `type` to a renderer. |
| Points, streaks, daily targets, progress | All session state flows through `useSession`. |
| A real server | `snake_case` data fields; mock data isolated in one module. |

Everything else — extra screens, a different palette, dark mode — is cheap to add
later and is therefore deliberately absent.
