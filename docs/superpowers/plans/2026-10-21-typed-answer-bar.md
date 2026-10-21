# Typed cards' answer bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a typed card, the input and the big button sit in a bar that rides on the keyboard, outside the session's scroll view, so the question's top, the input and the button always show.

**Architecture:** The session hands each card a `frame(question, bar)` function that draws its scroll view and, under it inside the `KeyboardAvoidingView`, an optional bar. Choice cards call it with no bar. `TypedAnswerView` keeps its state and calls it with both parts. The bar's note and button rules are pure functions in `answerBar.ts`, unit-tested like `typedSubmit.ts`.

**Tech Stack:** Expo SDK 57, React Native 0.86, expo-router, Jest (jest-expo, pure logic only), Playwright e2e on web.

**Spec:** `docs/superpowers/specs/2026-10-21-lang-tutor-typed-answer-bar-design.md`

## Global Constraints

- Touch only `apps/mobile/src/app/session.tsx`, `apps/mobile/src/components/TypedAnswerView.tsx`, the new `apps/mobile/src/answerBar.ts` and its test, and e2e. No server, core or string changes.
- Keep every testID listed in the spec's D7.
- Keep `behavior="padding"` on both platforms and the `bodyUnderBanner` padding. Remove PR #225's `keyboardDidShow` listener and the scroll view's `onLayout` scroll-to-end.
- UI copy is the existing Hebrew strings: `strings.typedCheck`, `strings.checking`, `strings.tryAgain`, `strings.couldNotCheck`, `strings.retypeNotice`, `strings.wordOnlyNotice`, `strings.wrongScriptNotice(language)`.

## Review Focus

1. **The locked answer mounts in the question area** once judged. It must not take focus or bring the keyboard back (`autoFocus` only while unlocked). This is Android-only, so it goes on the phone check.
2. **Return in the bar's input still submits**, a word or a sentence (`submitBehavior="submit"`). No e2e covers it today; Task 2 adds one.
3. **A retype keeps the bar** while the card is answered but unlocked. The banner stays hidden until it ends. Covered by help.spec and meaning-recall.spec.
4. **הסבר still scrolls to the reasons** under the banner. The ref must reach whichever scroll view `frame` drew. Covered by sentence-cards.spec.
5. **The no-microphone line** still shows above both typed and choice cards. `frame` draws it, but no e2e covers it, so it goes on the phone check.

---

### Task 1: The bar's rules

**Files:**
- Create: `apps/mobile/src/answerBar.ts`
- Test: `apps/mobile/src/answerBar.test.ts`

**Interfaces:**
- Produces:
  - `barNote(s: { refused: 'wrong_script' | 'word_only' | null; failed: boolean; checking: boolean; retypeAttempt: number | null }): BarNote`, where `type BarNote = 'wrong_script' | 'word_only' | 'failed' | 'retype' | 'retype_again' | null`. `retypeAttempt` is null when no retype is open.
  - `barButton(s: { empty: boolean; checking: boolean; failed: boolean; retyping: boolean }): { label: 'check' | 'checking' | 'try_again'; testID: 'typed-submit' | 'judge-try-again'; disabled: boolean }`

- [ ] **Step 1: Write the failing tests**, `describe('barNote')` and `describe('barButton')`:
  - A refusal wins over everything: `{ refused: 'wrong_script', failed: true, checking: false, retypeAttempt: 1 }` → `'wrong_script'`; `word_only` likewise.
  - `failed` shows only when not checking and not retyping: `{ refused: null, failed: true, checking: false, retypeAttempt: null }` → `'failed'`; with `checking: true` → `null`; with `retypeAttempt: 1` → `'retype'`.
  - A retype's first attempt → `'retype'`; attempt 2 → `'retype_again'`.
  - Nothing → `null`.
  - Button: checking → `{ label: 'checking', testID: 'typed-submit', disabled: true }`; failed (not checking, not retyping) → `{ label: 'try_again', testID: 'judge-try-again', disabled: empty }`; failed while retyping → `{ label: 'check', testID: 'typed-submit', … }`; empty → disabled `check`; text → enabled `check`.
- [ ] **Step 2: Run them to see them fail:** `npx jest src/answerBar.test.ts` in `apps/mobile`. Expect: cannot find module `./answerBar`.
- [ ] **Step 3: Implement both functions** in `answerBar.ts`. The precedence is refusal, then failed, then retype, as the tests state.
- [ ] **Step 4: Run them to see them pass:** same command, all green.
- [ ] **Step 5: Commit** `feat(mobile): typed answer bar: the note and button rules`.

### Task 2: The bar leaves the scroll view

**Files:**
- Modify: `apps/mobile/src/app/session.tsx`: imports, `renderQuestion`, `ClozeTypedCard`, `SessionScreen`'s effects and render, styles. Remove `typedForm`, and its misplaced comment moves to `bodyUnderBanner`.
- Modify: `apps/mobile/src/components/TypedAnswerView.tsx`
- Test: e2e, `e2e/tests/help.spec.ts` (one Return step), then the typed specs.

**Interfaces:**
- Consumes: `barNote` and `barButton` from Task 1.
- Produces:
  - `export type CardFrame = (question: ReactNode, bar?: ReactNode) => ReactNode` in `TypedAnswerView.tsx`.
  - A required `frame: CardFrame` prop on `TypedAnswerView`.
  - `renderQuestion(question, session, language, learner, explainOpen, frame: CardFrame)`.

- [ ] **Step 1: Add the failing e2e step.** In `help.spec.ts`'s typed-translation flow, answer one card by `input.press('Enter')` instead of clicking `typed-submit`. Expect its banner (`feedback-correct` or `feedback-wrong`) to show and `typed-input` not to be editable. Pick the card where the spec already types a full answer.
- [ ] **Step 2: Session.** Remove the `keyboardDidShow` effect, the `onLayout` and the `Keyboard` import. Inside `SessionScreen`, define `frame` to return a fragment: the existing `ScrollView` (ref, `contentContainerStyle`, `keyboardShouldPersistTaps="handled"`, the no-mic line, then `question`), then `bar`. Replace the `ScrollView` in the render with `renderQuestion(…, frame)`. In `renderQuestion`, every non-typed return becomes `frame(<…/>)`, and `read_aloud` with speaking off returns `frame(null)`. Typed cases pass `frame` to `TypedAnswerView` (through `ClozeTypedCard`), and the say-translation typed case loses its `typedForm` wrapper.
- [ ] **Step 3: TypedAnswerView.** Keep all state and effects. Build `question`, a `View` with the root testID: instruction, prompt, `RetryNotice`, and the retype block (`retype` with title and answer while showing). When `locked`, add the answer box and then `below`. When not locked, checking or retyping, add `typed-show-answer` last. Build `bar` only when not locked: a `View` with `styles.bar`, holding the note from `barNote` (rendered with its testID and colour: `wrong-script` via `InstructionText`, `word-only`, `judge-failed`, `retype-notice`), then the box, then the button from `barButton` (`answerStyles.check`, `checkDisabled`, its label from the strings above). Return `frame(question, bar)`.
- [ ] **Step 4: The box in two places.**
  - `autoFocus={!locked}`.
  - A sentence input (multiline) starts at one line, grows to three (`maxHeight` 3 × `lineHeights.md` + its vertical padding), and uses `fontSizes.md` / `lineHeights.md`. `styles.inputMultiline` loses `minHeight: 96`, except on the locked box, which shows all its text.
  - Bar styles: `backgroundColor: colors.surface`, `shadows.bar`, `marginHorizontal: -spacing.lg` with `paddingHorizontal: spacing.md`, `paddingVertical: spacing.sm`, `gap: spacing.sm`.
- [ ] **Step 5: Verify.** In `apps/mobile`, `npx tsc --noEmit` and `npx jest`; at the root, `npm run lint:arch`.
- [ ] **Step 6: Run the typed e2e specs** from the worktree root: `npm run e2e -- tests/help.spec.ts tests/meaning-recall.spec.ts tests/answer-language.spec.ts tests/sentence-cards.spec.ts tests/question-types.spec.ts tests/listening-variety.spec.ts tests/ambiguous-questions.spec.ts tests/speaking.spec.ts`. Expect all pass, the new Return step included. Afterwards, `rm -rf e2e/test-results` (it trips ADR 0006 R2).
- [ ] **Step 7: Commit** `feat(mobile): typed cards answer in a bar that rides on the keyboard`, then the e2e step as `test(e2e): …` if it's separate.

### Task 3: PR

- [ ] `git-create-pr`, with **Left for Victor**: the Android phone check of the spec's eight states and Review Focus 1 and 5. Then `ci-green`.
