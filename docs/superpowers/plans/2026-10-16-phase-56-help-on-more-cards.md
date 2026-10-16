# Phase 56 — Help on more cards: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor's `continue till PR`: inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 55's letter help, and its retype, on say the translation, typed meaning, sentence
translation, dictation and cloze typed.

**Architecture:** Core's `takesHelp` list grows and `evaluate` grades `helped` in its heard and
judged branches too; the speech and judged requests carry `helped`; the server passes it through,
skips the fit check for it and replays a helped spoken answer. The app keeps one help count per card
in its session state, feeds it to the typed and speaking views, and opens the retype on four more
cards.

**Tech Stack:** TypeScript, Zod 4, Hono, Drizzle/Postgres, Jest, Expo/React Native, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-phase-56-help-on-more-cards-design.md`

## Global Constraints

- `API_LEVEL` stays 4: only optional request fields are added (ADR 0012).
- No migration; `answers_helped_text` already allows every spoken and judged answer.
- Hebrew copy only, reused from phase 55: `help` **עזרה**, `retypeNotice` **הקלידו את המילה שוב**,
  `tryAgain` **נסו שוב**, `feedbackHelped` **נכון, עם עזרה**.
- Bots never send `helped`; the day simulation is untouched (never lower a mark).
- Never hardcode a port or database name; integration runs through `scripts/lane-env.sh`.

## Review Focus

1. A say the translation helped while spoken, then "can't speak now": the typed card shows the same
   letters and its answer is sent `helped: true` (Task 3, `quiz.test.ts`; Task 5, e2e).
2. A helped spoken clip whose response is lost and re-sent: the replay answers `understood`, not a
   409 (Task 2).
3. A helped cloze answer the rule calls wrong: no fit-check call, and the retype opens (Tasks 2, 3).
4. A typed meaning answered wrong by the judge opens the retype, and a Hebrew retype with or without
   the meaning's trailing `!` is right (Task 3, `retype.test.ts`).
5. A judged answer's card value keeps `judged` when the banner strips `helped` (Task 3,
   `feedback.test.ts`).

---

### Task 1: Core grades help on seven cards; the wire carries it

**Files:** `packages/core/src/domain/quiz.ts`, `packages/core/src/api/schemas.ts`; tests
`packages/core/src/domain/quiz.test.ts`, `packages/core/src/api/schemas.test.ts`.

**Produces:** `takesHelp(type)` true for `letter_tiles`, `typed_translation`, `say_translation`,
`typed_meaning`, `sentence_translation`, `dictation`, `cloze_typed`; `AnswerInput` heard and judged
variants with `helped?: boolean`; `JudgedAnswerRequest.helped?`, `SpeechAnswerRequest.helped?`.

- [ ] Tests first, in `quiz.test.ts`'s phase 55 block (a new `phase 56` describe): the `TAKES_HELP`
  table flips the five types to `true`; a helped text on dictation, cloze typed and say the
  translation records `wrong`; a helped judged answer (`{ text, judged: 'exact', helped: true }`) on
  typed meaning and sentence translation records `wrong`, `is_correct: false`; a helped heard answer
  on say the translation, and a helped `sounds_like` one, records `gave_up`, `is_correct: false`,
  the transcript as `answer_string`, `retry_state: null`; a helped `alternative` heard or judged
  answer opens no retry; `evaluateRetry` of a helped heard answer is `gave_up`; `helped` on a read
  aloud heard answer is ignored (`understood`). Replace phase 55's "ignores helped on any other
  type" dictation/cloze lines with a multiple choice and a read aloud.
- [ ] `schemas.test.ts`: both request schemas keep `helped`, accept none, refuse a non-boolean.
- [ ] Run `npm test --workspace packages/core` (fails).
- [ ] Implement. In `quiz.ts`:

```ts
const HELPED: ReadonlySet<QuestionType> = new Set([
  'letter_tiles', 'typed_translation', 'say_translation', 'typed_meaning', 'sentence_translation', 'dictation', 'cloze_typed',
]);
// AnswerInput: | { heard: string; helped?: boolean } | { heard: string; sounds_like: string; helped?: boolean }
//              | { text: string; judged: TypedVerdict; helped?: boolean }
const isHelped = (question: Question, answer: AnswerInput) => 'helped' in answer && answer.helped === true && takesHelp(question.type);
// heard branch, after the unheard throw:
if (isHelped(question, answer)) return recorded(question, { question_id: question.id, is_correct: false, answer_string: answer.heard.slice(0, MAX_ANSWER_TEXT), verdict: 'gave_up' });
// judged branch: const verdict = isHelped(question, answer) ? 'wrong' : answer.judged;
// text branch: use isHelped in place of the inline test.
```

  In `schemas.ts`, add `helped: z.boolean().optional()` with a phase 56 comment to
  `SpeechAnswerRequestSchema` and `JudgedAnswerRequestSchema`; widen the next-step `helped` comment
  to the seven cards.
- [ ] Run core tests and `npm run typecheck` (or the workspace `tsc`), then commit
  `feat(core): help grades on five more cards; the speech and judged requests carry it (phase 56)`.

### Task 2: The server passes help through

**Files:** `apps/server/src/routes/sessions.ts`, `apps/server/src/services/sessions.ts`,
`apps/server/src/db/schema.ts` (comment only); tests
`apps/server/tests/integration/routes/sessions.helped.test.ts`, `apps/server/src/services/sessions.test.ts` if a unit case breaks.

**Consumes:** Task 1's `AnswerInput` and schemas.

- [ ] Tests first, in `sessions.helped.test.ts` (add `expectJudge`, `expectTranscription` stubs as
  `sessions.judge.test.ts` / `sessions.speech.test.ts` do; a namespace per test):
  - next-step: a helped dictation, cloze typed and say the translation typed answer, right text,
    stored `wrong` with `helped = true`;
  - judged: a helped typed meaning with the stored meaning (rule, no call) and a helped sentence
    translation (`expectJudge(ns, 'right')` style stub) are stored `wrong`, `helped = true`, and the
    response `verdict` is `exact`;
  - speech: a helped say the translation clip transcribed as the word is stored `gave_up` with the
    transcript and `helped = true`, the response `verdict` is `understood`, and the same request
    again replays `understood` with no second record; at the session's end spoken productive has a
    lapse;
  - a helped cloze answer the rule calls wrong with `check_fit: true` makes no fit call (no
    `answer_fit_checked` / `answer_fit_check_failed` log) and is stored `wrong`;
  - phase 55's "neither tiles nor typed" case becomes a multiple choice alone (cloze typed now takes
    help).
- [ ] Run the file: `bash scripts/lane-env.sh npm exec --workspace apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/routes/sessions.helped.test.ts` (fails).
- [ ] Implement:
  - routes: pass `helped: body.helped` to `answerJudged` and `answerBySpeech`.
  - `answerBySpeech(input.helped?)`: `const answer = { heard, ...(soundsLike ? { sounds_like } : {}), ...(input.helped === undefined ? {} : { helped: input.helped }) }`; log `helped: true` in `speech_judged` when set; replay: accept a stored `gave_up` whose text is not empty (a helped spoken answer) and report it `understood`.
  - `answerJudged(input.helped?)`: record `{ text, judged: verdict, helped }`; log `helped: true`;
    respond `input.helped ? verdict : stored ?? verdict`.
  - `answerText`: the fit-check guard adds `&& !input.helped`.
  - `schema.ts`: the `helped` column comment names the seven cards (no migration).
- [ ] Run the file again, then `npm test --workspace apps/server`, then commit
  `feat(server): help on the speech and judged routes; no fit check for a helped gap (phase 56)`.

### Task 3: The app's pure parts — help count, retype, banner

**Files:** `apps/mobile/src/typedHelp.ts`, `retype.ts`, `quiz.ts`, `feedback.ts`, `judging.ts`;
tests `typedHelp.test.ts`, `retype.test.ts`, `quiz.test.ts`, `feedback.test.ts`.

**Produces:**
- `helpText(question): string | null` in `typedHelp.ts` — `meaning` on typed meaning, `question` on
  dictation, `answer` on typed, say, cloze typed, sentence translation, else null. The join set
  becomes `/[\s\p{P}ʼ]/u`.
- `retype.ts`: `RETYPED` = typed translation, dictation, cloze typed, say the translation;
  `opensRetype(question, answer: CardAnswer)`: a judged typed meaning whose `judged` is `wrong` or
  `near_miss`, or a text answer on a `RETYPED` card whose unhelped `evaluate` verdict is `wrong` or
  `near_miss`; `retypeRight(question, text)`: typed meaning → `normaliseHebrew` equal to `meaning`,
  else `evaluate(question, { text }).verdict === 'exact'`; `retypeChecked(retype, question, text)`
  uses it.
- `quiz.ts`: `QuizState.help: number` (0 in `enteredState`; `applyQueued` keeps it only when the
  queued card is the card on screen); `helpPressedState(current)`; `retypeFor` handles a judged
  answer; `retypeCheckedState` for any card with a retype; `helpedFor(question, help, card?)` →
  `boolean | undefined`: undefined unless `takesHelp`; tiles `card?.helped === true`; others
  `help > 0`.
- `feedback.ts`: `CardAnswer` heard variant `{ heard; verdict; helped? }`; `unhelped` drops only the
  `helped` key; `helpedOr` counts `understood` as right; `checksFit` false for a helped answer.
- `judging.ts`: `judgedAnswer(text, response, helped?)` carries `helped` when defined.

- [ ] Tests first: `typedHelp` (a Hebrew meaning with a space and a trailing `!`; a comma joins
  the next letter; `helpText` per type); `retype` (opens on each of the four for wrong, near miss,
  `''`; not exact, alternative; typed meaning on judged `wrong`, not `exact`; never sentence
  translation; `retypeRight` per card, Hebrew with or without `!`, cloze alternative not right,
  dictation lemma not right); `quiz` (help 0 on a new card, kept through a hold, `helpedFor` per
  type, tiles by card, `nextStepRequest` body); `feedback` (helped heard `understood` and helped
  judged `exact` → `נכון, עם עזרה`, tone `other`; helped judged `wrong` → wrong; `unhelped` keeps
  `judged`; `checksFit` false when helped).
- [ ] Run `npm test --workspace apps/mobile` (fails), implement, run again; commit
  `feat(mobile): one help count a card; the retype on four more cards (phase 56)`.

### Task 4: The app's hook and views

**Files:** `apps/mobile/src/hooks/useSession.tsx`, `components/TypedAnswerView.tsx`,
`components/SpeakingCardView.tsx`, `app/session.tsx`.

**Consumes:** Task 3's `helpText`, `helpPressedState`, `helpedFor`, `retypeRight`, `opensRetype`.

- [ ] `useSession`: `help: number` and `pressHelp()` on `SessionValue`; `submitText` sends
  `helpedFor(question, state.help, card)`; `submitJudged` and `submitSpeech` add `helped` to their
  requests and to the card answer (`judgedAnswer(text, response, helped)`, `{ heard, verdict, helped }`).
- [ ] `TypedAnswerView`: `help: { presses: number; onPress: () => void } | null` replaces the
  `help` flag and the local count; the hint text is `helpText(question)`, in `direction`; the
  retype answer is `rightAnswer(question)` in `direction`; `onSubmit(text)` (the hook knows help).
- [ ] `SpeakingCardView` (say the translation only): `help` prop of the same shape; `speak-hint`
  line above the microphone, `speak-help` **עזרה** in the actions, disabled while checking or all
  shown.
- [ ] `session.tsx`: every `TypedAnswerView` keyed by question id and given
  `help={{ presses: session.help, onPress: session.pressHelp }}`, the retype props on typed meaning,
  dictation, cloze typed and say typed; `SpeakingCardView` for say the translation gets `help`.
- [ ] `npx tsc --noEmit -p apps/mobile` and `npm test --workspace apps/mobile`; commit
  `feat(mobile): help on the typed and speaking cards (phase 56)`.

### Task 5: e2e

**Files:** `e2e/tests/support/cards.ts` (`playOut` for dictation, cloze typed, say typed and
meaning retypes), the specs that show the answer on those cards
(`question-types`, `listening-variety`, `answer-language`, `ambiguous-questions`,
`sentence-cards`, `meaning-recall`, `speaking`), new tests beside the specs that reach each card.

- [ ] New tests: in `meaning-recall.spec.ts` help on typed meaning (RTL letters), a judged wrong,
  the retype and the body `{ text, helped: true }`; in `listening-variety.spec.ts` help on
  dictation and its retype; in `sentence-cards.spec.ts` help on cloze typed beside the hint and on a
  sentence translation (judged body says `helped`, banner **נכון, עם עזרה**); in `speaking.spec.ts`
  help on say the translation spoken, the clip understood with **נכון, עם עזרה** and the speech
  body `helped: true`, and a second test: help spoken, "can't speak now", the typed card shows the
  same letters and sends `helped: true`.
- [ ] Every existing spec that shows the answer or answers wrong on one of the four meets the
  retype: finish it with `retypeShown`/`retypeWrong`.
- [ ] Run `npm run e2e` (lane-derived), fix, commit `test(e2e): help and the retype on five more cards (phase 56)`.

### Task 6: Finish

- [ ] `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`, `cd bots && npm test`.
- [ ] Add the run's rulings to the spec as numbered `R1.`, `R2.` entries, as phase 55's spec has them, then commit
  `docs(spec): phase 56 records the rulings of its run`.
- [ ] `superpowers:finishing-a-development-branch` → `git-create-pr` → `ci-green`.
