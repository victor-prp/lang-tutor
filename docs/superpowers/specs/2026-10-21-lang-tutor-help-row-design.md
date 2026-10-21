# Typed cards: help in a row of its own

- **Status:** Designed with Victor on 2026-10-21 from mocks, after his Android screenshot of a long
  word garbled by help's marks. He chose, in order: help's reading in a place of its own, not drawn
  on the input; the reading in בדיקה's space; then "always keep it this way", with the answer
  beside בדיקה and help beside עזרה; **help on top**; and **an empty dashed box** before any press.
  Lines marked **(my call)** are Claude's and were not separately confirmed.
- **Date:** 2026-10-21
- **Source:** the mocks, in the main checkout (gitignored), under
  `.superpowers/brainstorm/61295-1792588029/content/`: `help-long-word-options.html` (the problem,
  options A–D), `help-in-button-space-v2.html`, `help-a-lifecycle.html`, `help-two-rows.html`, and
  `help-on-top-final.html` (the layout as chosen).
- **Amends:** phase 63's D2 and D3 rendering (`2026-10-18-lang-tutor-phase-63-help-in-the-answer-design.md`)
  for the typed cards, and the answer bar's D2 (`2026-10-21-lang-tutor-typed-answer-bar-design.md`):
  עזרה leaves the input, and בדיקה leaves the bar's full width. Help's rules (phase 63 D3: what a
  press does, what is marked, what is given, when the button is done) do not change.
- **Touches:** `apps/mobile/src/components/TypedAnswerView.tsx`, possibly `HelpButton.tsx` (a width
  or style for this row), and e2e. No server, core, string or API-level change.

## Why

Victor's screenshot (Android, typed translation, answer `freddo`, typed `freddghgfhhhff`, help
pressed) shows the word twice, overlapping, and the red mark beside it rather than on it.

Phase 63 drew help's grey letters and red marks on a `Text` layer laid behind the transparent
`TextInput`, holding the typing again (its typed part meant to be invisible), so that they would
line up with the input's own text. On this phone they did not: the layer's copy sat several letters to
the right of the input's text, and its typed part, `fredd`, drew in black instead of transparent.
Two text engines (Android's `EditText` and a React Native `Text`) have to agree to the pixel on
start, alignment, glyph widths and colour, and nothing here can check that before the phone. The
web build, where e2e runs, lines up. Phase 63 named this "the riskiest piece" and planned a
follow-up. There is a second, built-in limit too: once the typing is longer than the box, the input
scrolls sideways and the layer cannot follow, so the layer hides (B5) and help shows nothing on
exactly the long phrases where it is most wanted.

The fix is to stop lining anything up. Help's reading becomes ordinary text in a place of its own.

## Goal

On every typed card that has help, help's reading shows whole and readable at any length, on
Android and web alike, and the answer bar keeps today's height and does not change shape when
עזרה is pressed.

## Non-goals

- Help's rules. `typedHelp.ts` (`pressTyped`, `typedHint`, `typedHelpDone`) and the session's help
  state are unchanged.
- Cards with help but no typing: the spoken card and listen choice (`LettersBox`, help inside its
  dashed box), letter tiles, the choice cards and matching. They keep phase 63's layout.
- The sentence translation's word taps (phase 59), the retype's rules (phase 55, 56), the second
  try (phase 34).
- The answer bar's other rules: it rides on the keyboard, its note line, the keyboard opening on a
  tap (D8), the locked answer in the card once judged (D5).

## Design

**D1. Two rows, from the moment the card opens.** On a typed card with help (typed translation,
dictation, typed meaning, typed gap, and say-translation typed), the answer bar holds, top to bottom:

1. the note line, when there is one, exactly as today (answer bar D2.1);
2. **help's row:** עזרה at the right, and beside it, to its left, a dashed box holding help's
   reading;
3. **the answer row:** בדיקה at the right, and beside it, to its left, the input box.

עזרה and בדיקה are the same width, so they stand as one column at the bar's right edge, with the
reading and the typing to their left. Both rows are there before any press, so pressing עזרה moves
nothing: no button changes size and no row appears. The bar is about as tall as today's (an input
row and a button row), and the typing keeps about the same width, since עזרה is no longer inside
the input.

**D2. Help's row.**

- **The button** is today's `HelpButton` (`typed-help`): the bulb and עזרה, `primarySurface`,
  disabled and grey while checking or when nothing is left to give (`typedHelpDone`), as today. It
  is as wide as בדיקה and as tall as the dashed box **(my call)**.
- **The dashed box** (`typed-help-row`) has the spoken card's letters-box border: 1.5 px dashed
  `colors.border`, `radii.md`, no fill. **Before any press it is empty** (Victor's choice). It is
  not pressable **(my call)**.
- **The reading** (`typed-hint`) is the text phase 63's layer held, by phase 63's rules, now drawn
  as ordinary text in that box and no longer over the input:
  - **A wrong character, after a press:** the typing as typed, dark up to the first wrong
    character, and from it to the end in red `colors.wrong` on `colors.wrongSurface`, underlined
    (`typed-marks`). It shows while the input holds exactly the text the press read, and goes with
    the next edit.
  - **A right start:** the typing as typed, dark, then the given letters not yet typed in grey
    `colors.faint`, with `…` while the answer goes on (`typed-ghost`). It shows only while the
    typing is a start of the answer. Typing a given letter takes it out of the grey.
  - **Nothing to show** (no press yet, a mark gone with an edit, or the given letters all typed):
    the box is empty and `typed-hint` is absent.
  - **Why not the storyboard's rules (my call).** `help-a-lifecycle.html` showed a reading that
    changed only on a press, with a mark dimmed after an edit. That hides letters already given once
    a mark has been made and fixed, and the next press then gives one letter more than the learner
    needed (`pressTyped` gives the step after the given ones). Phase 63's rules show them again as
    soon as the typing is a right start.
- **Size and direction.** The reading's text is `fontSizes.lg`/`lineHeights.lg` or one step smaller
  (builder's call), in the answer's direction: a target word left to right, a Hebrew meaning right
  to left. It sits at its box's start for that direction. It wraps when it does not fit one line,
  past about two dozen letters, and only then does the row grow.

**D3. The answer row.**

- **The input box** (`typed-box`, `typed-input`) is today's box without עזרה: its border in its
  tone, its placeholder, its text in the answer's direction, Return submits, and it opens the
  keyboard on a tap (answer bar D8). It holds only the typing, and nothing is drawn over or behind
  it. The placeholder shows whenever the input is empty, since the grey letters are no longer where
  it is (this undoes phase 63's final-review swap).
- **בדיקה** is today's button (`typed-submit`, or `judge-try-again`) with today's labels and rules
  (`barButton`): בדיקה, faded while the input is empty; בודקים… while checking; נסו שוב once the
  check failed. It no longer spans the bar. It sits beside the input, as tall as the input box. Its
  width fits the longest label, בודקים…, and is fixed, so the label changes nothing around it.

**D4. Typed cards with no help** (the sentence translation, and the retype while it is open): no
help row. The bar is the note line, if any, and the answer row **(my call)**.

- The sentence input grows from one line to three, as today (answer bar D4), and בדיקה stays at the
  row's bottom, beside the input's last line.
- The retype keeps its note (`retype-notice`) above the answer row.

**D5. States, as today unless said.**

- **The note line** (wrong alphabet, the whole sentence, couldn't check, the retype's notice) sits
  above help's row.
- **Checking:** עזרה is disabled, and the reading stays as it was.
- **A second try** (phase 34): the session clears the marks, as today, and the given letters stay,
  so on a right start the grey shows again.
- **Turned typed** ("can't speak now"): what was given shows at once as grey with `…` in the
  reading, before any press (phase 63 D4).
- **Judged:** the bar goes away as today. The locked answer box appears in the card, with no help
  row (answer bar D5).

**D6. What goes.** The layer behind the input, its `overflow` state and `onTextLayout` measuring,
the `hidden` and `under` (transparent) styles, `pointerEvents: 'none'`, and the `paddingStart` that
made room for עזרה inside the box. The input's background no longer needs to be transparent.

**D7. TestIDs.** All of today's stay, with their meanings: `typed-box`, `typed-input`,
`typed-help`, `typed-hint`, `typed-marks`, `typed-ghost`, `typed-submit`, `judge-try-again`,
`judge-failed`, `wrong-script`, `wrong-script-language`, `word-only`, `retype`, `retype-title`,
`retype-answer`, `retype-notice`, `typed-show-answer`, and the card roots. New: `typed-help-row`,
the dashed box, and `typed-bar`, the answer bar itself, so e2e can check that עזרה is in it
**(my call)**. `typed-help` is no longer inside `typed-box`.

**D8. Drawing on Android.** Nothing here has to line up with anything, so the worst an Android
difference can do is put the reading at the other end of its own box, which still reads. To keep it
at the start, follow the repo's rule: no physical `textAlign` on a `Text`, because native RTL swaps
left and right on a `Text` and web does not (1fff73e, phase 63 B8). Give the reading's container the
answer's direction (as `LetterTilesView` does with `direction: 'ltr'` for its slots) and let the
text start there. React Native Web's style validator deletes `direction` (see `_layout.tsx`), so
the reading's `Text` also carries `writingDirection` in the answer's direction, as the layer did;
without it a word card's reading would start at the right on web, and e2e would not notice. Pad by
start and end, never left and right.

## Left to the builder

- The reading's font step, the dashed box's padding and minimum height, the shared width of the two
  buttons (it must fit בודקים…), and whether `HelpButton` takes a `style` prop or the row wraps it.
- Whether the reading is one `Text` with nested spans, as the layer was, or another shape, provided
  the testIDs in D7 hold.

## Verification

- `npm run typecheck`, the mobile unit tests and `npm run lint:arch`.
- **e2e, updated where they test the old drawing:**
  - `help.spec.ts` and `sentence-cards.spec.ts` check `typed-help` inside `typed-box`. They now
    check `typed-help` in the viewport, above `typed-input` (its box's bottom above the input's
    top), and inside the bar.
  - `help.spec.ts` checks that the placeholder goes while the grey letters show. It now checks that
    the placeholder stays.
  - The rest stand unchanged: the reading's texts, its marks and grey, its `rtl` direction on a
    meaning card, a mark going with an edit, the grey back on a right start, and no `typed-help` or
    `typed-hint` in a retype or on a sentence translation.
  - Add one: before any press, `typed-help-row` is visible and `typed-hint` is absent.
- **On Victor's Android phone (Left for Victor):**
  - the screenshot's case, a long wrong word marked;
  - a phrase longer than the input;
  - grey letters on a right start, and on a card turned typed;
  - a Hebrew meaning;
  - a sentence translation and a retype, with no help row;
  - each time, the reading at its box's start and the two buttons in one column.
