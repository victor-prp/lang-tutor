# lang-tutor — Phase 1 Design

**Date:** 2026-08-24
**Status:** Approved in principle. Screen design is provisional — see [Approval model](#approval-model).

## Purpose

Build the first phase of the lang-tutor mobile app: a small, working app running
entirely on mock data, with a single question type, so the look and feel can be
evaluated on a real device before any server work begins.

**The learner is a Hebrew speaker memorising English words and phrases.** That
single fact drives more of this design than any other: the interface is Hebrew and
right-to-left, prompts are English inside an RTL layout, and answer options hold
phrases rather than single words. See
[Bidirectional text and RTL](#bidirectional-text-and-rtl).

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
- Hardcoded English → Hebrew mock questions, covering both words and phrases.
- Hebrew interface copy, right-to-left layout throughout.
- In-memory state only.

### Out of scope

Deliberately excluded from phase 1, all of which the design leaves room for:

- Any second question type (free text, voice, pronunciation, pictures).
- Points, streaks, daily targets, gamification.
- Adding or editing words.
- Persistence across app launches.
- Any server, API client, or authentication.
- Dark mode.
- A localisation framework. Hebrew UI strings are hardcoded constants in one
  module. There is no second interface language to switch to, so `i18n` machinery
  would be plumbing with nothing on the other end.
- An English (LTR) interface option, or any language toggle.
- Audio, so no pronunciation of the English prompt.
- Component or snapshot tests.

## Platform and stack

| Choice | Value | Reason |
|---|---|---|
| Framework | React Native via Expo | Works with the installed Node toolchain; no Xcode or Android Studio required. |
| Language | TypeScript | Tagged-union question types depend on real discriminated unions. |
| Navigation | Expo Router (file-based stack) | Native stack transitions and back gesture for free — both are part of the feel being judged. |
| Styling | `StyleSheet` over a theme token module | No component library. Gamified, custom UI later would fight a prebuilt one. |
| Direction | RTL forced on at startup via `I18nManager` | The only supported direction, so it is set once rather than detected. |
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
  question: string;        // English word or phrase, e.g. "window"
  options: string[];       // four Hebrew translations, e.g. "חלון"
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

`src/data/mockQuestions.ts` exports a hardcoded `Question[]` of roughly sixteen
questions: an English word or phrase as the prompt, four Hebrew options written out
by hand.

The set deliberately mixes lengths, because layout has to survive both:

- **Single words** — `window` → `חלון`, `book` → `ספר`.
- **Short phrases** — `good morning` → `בוקר טוב`.
- **Full expressions** — `How do you do?` → `?מה נשמע`, long enough to wrap onto a
  second line on a narrow phone.

At least three or four questions must be long enough to wrap. A mock set of only
short words would let a layout bug ship invisibly and then break the moment real
content arrives.

Hand-written options are a feature, not a shortcut: distractors generated at
random would be semantically unrelated, and plausible distractors are what make a
multiple-choice question actually test recall. Writing them by hand also removes
the distractor-generation code path entirely. For phrase questions the distractors
should be other plausible phrases, not single words — otherwise option length
alone gives the answer away.

In phase 2 this module becomes what a repository function returns, rather than
something screens import.

## Bidirectional text and RTL

The interface is Hebrew and right-to-left; the content being learned is English and
left-to-right. Both appear on the same screen, so direction is a layout concern
throughout rather than a translation task at the end.

**Layout direction** is forced once at app startup with
`I18nManager.forceRTL(true)` and `allowRTL(true)`, before the first render. React
Native then mirrors flex layouts automatically, which means styles should use
`start`/`end` rather than `left`/`right` so mirroring is inherited instead of
fought. Native RTL flips require a reload to take effect, so this is set at
startup and never toggled.

What mirroring produces, screen by screen:

- The Session back affordance sits at the **top right**, and points right.
- The `3 / 10` counter moves to the top left.
- The progress bar fills **right to left**.
- All Hebrew text is right-aligned; option buttons align their text to the right.

**The English prompt stays left-to-right.** It is rendered with explicit
`direction: 'ltr'` and centre alignment, so it reads correctly inside the mirrored
screen. Centring sidesteps the worst of bidirectional edge cases — a prompt ending
in `?` or `.` is a classic case where mixed-direction text puts the punctuation on
the wrong end.

**Numerals** (`3 / 10`, `8 / 10`) render LTR even inside RTL text, which is correct
Hebrew typography and needs no special handling beyond not reversing them by hand.

**Fonts** are the system default. Both iOS and Android ship Hebrew coverage, so no
custom font is bundled. Hebrew has no capital letters and a different vertical
rhythm from Latin script, so line heights set for English will look cramped —
`theme.ts` therefore carries slightly generous line-height tokens, to be tuned
during the play-test rather than guessed at now.

This section is where the play-test is most likely to find problems. RTL bugs are
visual and hard to reason about on paper, which is a further argument for step 1
being a runnable build.

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

All interface copy is Hebrew, held as constants in `src/strings.ts`. Screens never
inline a user-visible string, so copy revisions after the play-test happen in one
file. Stack push and pop animations mirror automatically under RTL, so screens
slide in from the left.

### Home — `app/index.tsx`

App title, a card showing the set (`10 מילים באנגלית` — "10 words in English"), and
a primary Start (`התחל`) button that navigates to Session. Nothing else.

The layout intentionally leaves empty space below the card. Home is where streak,
points, and daily-target widgets land in later phases, so it starts as a visibly
unfinished hub rather than a splash screen.

### Session — `app/session.tsx`

The screen that matters most.

Header row with a back affordance at the top right and a `3 / 10` counter at the
top left; a progress bar beneath it filling right to left; a Hebrew instruction
line (`?מה הפירוש` — "what does this mean?"); the English prompt, centred and LTR;
then the four Hebrew options, right-aligned.

**Option buttons are variable height with wrapping text.** Because prompts include
phrases, an option can run onto a second line, so the four buttons cannot be
assumed to fit a fixed vertical slot. Consequences worth stating, since each is a
place this could go wrong:

- Buttons size to their content; all four in a question match the tallest, so the
  set stays visually even.
- The option column scrolls if the four buttons plus the feedback banner exceed the
  viewport on a small phone.
- The feedback banner overlays rather than displaces the options, so answering
  never reflows what the learner is looking at.

Session owns the question flow and the feedback banner. It does **not** own how a
question looks: it switches on `question.type` and delegates rendering. Phase 1
has one case, `multiple_choice`, rendering `MultipleChoiceView`.

Two states per question:

- **Answering** — four neutral option buttons, no banner.
- **Answered** — the tapped option turns green or red; the correct option is
  always shown green; the remaining two dim and stop responding to touch. A banner
  slides up from the bottom with a short Hebrew message and a Continue (`המשך`)
  button.

Continue advances to the next question, or to Results after the last one. The
learner controls the pace; nothing auto-advances.

Back-swipe mid-session abandons the session and returns Home, with no confirmation
dialog. A confirmation is worth adding later, but a modal now would interrupt the
flow being evaluated.

### Results — `app/results.tsx`

Score as `8 / 10`, a headline that varies by score band, a list of the missed
questions, and two buttons: **Practise again** (`תרגל שוב`, builds a fresh session)
and **Done** (`סיום`, returns Home).

Each row in the missed list shows the question prompt and its correct answer, read
as `options[correct_option]` — there is no separate translation field in phase 1.
Each row therefore mixes directions: the English prompt LTR on one side, the Hebrew
answer RTL on the other. Rows are laid out as two aligned columns rather than one
run of text, so the two scripts cannot collide.

The missed-questions list is the one element here that is not decorative — it is
genuinely useful, and it is where a future "review these later" feature grows
from.

## Styling

`src/theme.ts` exports design tokens:

- **Colours** — background, surface, text, muted, correct, wrong, primary.
- **Spacing** — a single numeric scale.
- **Radii**, **font sizes**, and **line heights** (generous, for Hebrew).

Components use `StyleSheet.create` referencing those tokens, never literal colour
or spacing values. Directional styles use `start`/`end`, `paddingStart`,
`marginEnd` and similar rather than `left`/`right`, so RTL mirroring is inherited
rather than hand-written. Look-and-feel iteration then happens in one file, which matters
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

1. **Scaffold and build a playable app** — Expo project with RTL forced at
   startup, theme tokens, Hebrew strings module, mock questions, session engine
   with its tests, and the three screens. Runnable in a browser and on a phone via
   Expo Go. This step exists so the design can be judged by using it.
2. **Play-test and approve** — hands-on evaluation of look and feel. Findings
   update this document. Worth checking specifically: that mirroring is complete
   and nothing sits on the wrong side, that long phrases wrap without breaking the
   option column, that mixed English and Hebrew rows on Results read cleanly, and
   that Hebrew line heights look right rather than cramped.
3. **Apply approved changes** — layout, copy, colour, spacing, and timing
   adjustments from step 2.

Browser RTL and native RTL are not identical, so mirroring must be confirmed on a
real phone, not only in the web preview.

Steps beyond phase 1 are out of scope for this document.

## Phase 2 readiness

Three decisions carry the weight of everything planned after phase 1:

| Future need | What phase 1 already provides |
|---|---|
| Free text, voice, pronunciation, picture questions | `Question` is a tagged union; Session dispatches on `type` to a renderer. |
| Points, streaks, daily targets, progress | All session state flows through `useSession`. |
| A real server | `snake_case` data fields; mock data isolated in one module. |
| More interface languages | All UI copy in `src/strings.ts`; directional styles use `start`/`end`, so an LTR interface needs no layout rewrite. |

Everything else — extra screens, a different palette, dark mode — is cheap to add
later and is therefore deliberately absent.
