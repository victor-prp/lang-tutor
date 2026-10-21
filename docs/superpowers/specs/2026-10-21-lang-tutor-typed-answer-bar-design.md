# Typed cards: an answer bar that rides on the keyboard

- **Status:** Designed with Victor on 2026-10-21 from mocks. He picked option B ("B"), approved its
  eight states ("Looks good"), then said "Go till PR" (CLAUDE.md, *Continue till PR*). Lines marked
  **(my call)** are Claude's, shown on the mocks as "my call" but not separately confirmed.
- **Date:** 2026-10-21
- **Source:** the mocks, in the main checkout (gitignored):
  `.superpowers/brainstorm/25633-1792578354/content/typed-cards-keyboard.html` (the problem and
  options A–C) and `b-every-state.html` (B in eight states).
- **Replaces:** PR #225's scroll-to-end (merged 2026-10-21). It keeps that PR's
  `behavior="padding"` on Android and the banner-only bottom padding.
- **Touches:** `apps/mobile/src/app/session.tsx` and `apps/mobile/src/components/TypedAnswerView.tsx`
  only. No server, core or string changes.

## Why

On Android the keyboard covered a typed card's input and its בדיקה "in many cases". The app is edge
to edge (target SDK 36), so the system no longer shrinks the screen for the keyboard, and the
session's `KeyboardAvoidingView` did nothing on Android. PR #225 made it pad and scrolled the card to
its end once the keyboard was up. That brought the button into view but pushed the question off the
top of tall cards: "sometimes I don't see the question".

Both failures have one cause. The question, the input and the button share one scrolling column, and
with the keyboard up a sentence card is taller than the ~390 dp left on a 360 × 780 dp phone. One
column can show the question's top or the button, not both. Whatever must always show has to sit
outside the scrolling part.

## Goal

On every typed card, with the keyboard up or down, the question's top, the input and בדיקה are all
on screen without scrolling. What doesn't fit is the end of the question area, a short scroll away.

## Non-goals

- Other screens with inputs (sign-in, onboarding, students/invite, LookupPanel). They have no
  `KeyboardAvoidingView` at all; that's separate work.
- `react-native-keyboard-controller`. It isn't in Expo Go, which Victor tests with.
- Choice, tiles, matching, speaking and meet cards. They have no keyboard and keep today's layout.

## Design

**D1. Two parts.** A typed card (typed translation, dictation, typed meaning, typed gap, sentence
translation, and say-translation typed with speaking off) draws in two parts:

- the **question area**, in the session's scroll view: everything about the question;
- the **answer bar**, under the scroll view and inside the `KeyboardAvoidingView`: everything about
  the answer being typed.

With the keyboard up, the bar sits on the keyboard. With it down, after בדיקה or when the learner
closes it, the bar sits at the bottom of the screen. The question area scrolls on its own and opens
at its top. Nothing scrolls it on keyboard events: PR #225's `keyboardDidShow` listener and its
`onLayout` scroll-to-end go.

**D2. The answer bar**, top to bottom. It is white and full width, with the hairline top edge
`shadows.bar`.

1. **One note line, when there is one**, about what was typed or what to do:
   - wrong alphabet (`wrong-script`, red, the language in bold, as today);
   - "the whole sentence" (`word-only`, red);
   - couldn't check (`judge-failed`, red) **(my call)**;
   - the retype's "הקלידו את המילה שוב" / "נסו שוב" (`retype-notice`, dark).
2. **The input box**, full width, with עזרה inside at its right edge, the grey help letters and the
   marks, all as today.
3. **The big button**, today's full-width blue `answerStyles.check`:
   - בדיקה (`typed-submit`), faded while the input is empty;
   - בודקים… while a judged answer is out;
   - **נסו שוב (`judge-try-again`) once the check failed (my call).** It replaces today's small link
     beside "couldn't check" and sends what is in the box.

**D3. The question area:** the instruction, the prompt (with its hints, taps and part of speech), a
second try's `RetryNotice`, the retype's title and right answer (`retype`, `retype-title`,
`retype-answer`, while showing), and **הצגת התשובה at its end (my call)**. On a tall card that link
is a short scroll down. It hides while checking and during a retype, as today.

**D4. A sentence input grows (my call).** It starts at one line and grows with the text up to three
lines, then scrolls inside itself. Its text is `fontSizes.md` / `lineHeights.md`, against 20/30 for a
word, so three lines fit beside the big button. Return still submits, as today.

**D5. Answered.** Once the card is judged, the bar goes away. The answer box, locked and in its
colour (green, red or orange, as today, still `typed-input`, not editable), appears in the question
area under the question. The corrected sentence (`below`) sits under it, and the banner comes up as
today. While a retype is open, the card is answered but unlocked, so the bar stays.

**D6. Kept from PR #225:** `behavior="padding"` on both platforms, because on Android it is the only
thing that moves the bar above the keyboard. Also kept: the 192 dp bottom padding only while the
banner shows.

**D7. TestIDs are kept**, so the e2e specs stand unchanged: `typed-input`, `typed-box`,
`typed-help`, `typed-hint`, `typed-ghost`, `typed-marks`, `typed-submit`, `typed-show-answer`,
`judge-failed`, `judge-try-again`, `wrong-script`, `wrong-script-language`, `word-only`, `retype`,
`retype-title`, `retype-answer`, `retype-notice`, and the card roots `meaning-card`, `cloze-card` and
`translate-card`.

**D8. The keyboard opens on a tap (Victor, after PR #228).** A typed card opens with the keyboard
down, so the whole question shows before typing starts. The keyboard comes up when the learner taps
the input. **(my call)** The same goes for a second try and a retype: their note or right answer
shows whole first. Before, both brought the keyboard back by themselves. The input has no
`autoFocus` and no focus call.

## Left to the builder

- How the bar leaves the scroll view. The session owns the scroll view and the
  `KeyboardAvoidingView`, and `TypedAnswerView` owns the typed state. One way: the session hands
  every card a `frame(question, bar)` function that draws its scroll view (with the no-microphone
  line and the banner padding) and the bar under it. Choice cards call it with no bar, and
  `TypedAnswerView` calls it with both parts.
- The bar's paddings, and the input box's height in the bar. The mocks used a 52 dp box and a 10 dp
  gap; today's box is 62 dp.
- Whether the locked answer stays a `TextInput` (`editable={false}`) or becomes text. It must still
  read as `typed-input` with its value, and must not take focus or open the keyboard when it mounts.

## Verification

- `npm run typecheck`, the mobile unit tests and `npm run lint:arch`.
- The e2e specs that drive typed cards: help, meaning-recall, answer-language, sentence-cards,
  question-types, listening-variety, ambiguous-questions and speaking. They run on web, where the
  bar sits at the bottom of the screen.
- **On Victor's Android phone (Left for Victor):** each state on the mocks. A word card, a Hebrew
  answer, a long sentence, a second try, wrong alphabet, checking and couldn't check, answered, and a
  retype. Each time the keyboard comes up, the question's top, the input and the button all show.
