# Typed cards: one answer field, the buttons inside

- **Status:** Chosen by Victor on 2026-10-22 from mocks ("B. Go till PR"). He asked for עזרה and
  בדיקה inside the text areas, and for more options; of four, he picked **B, one answer field**.
  Lines marked **(my call)** are Claude's and were not separately confirmed.
- **Date:** 2026-10-22
- **Source:** the mock, in the main checkout (gitignored):
  `.superpowers/brainstorm/19792-1792667968/content/buttons-inside.html`, option B.
- **Amends:** the help row spec (`2026-10-21-lang-tutor-help-row-design.md`) D1 and the look of its
  D2 and D3: the two rows and the button column at the right become one field. What help does, and
  every rule of the answer bar (`2026-10-21-lang-tutor-typed-answer-bar-design.md`), stay.
- **Touches:** `apps/mobile/src/components/TypedAnswerView.tsx`, `apps/mobile/src/theme.ts` (one
  shadow), `e2e/tests/help.spec.ts`. No server, core, string or API change.

## Why

Victor: the help row works well but looks unpolished. Today's bar is four shapes in a grid: a light
עזרה chip 48 px tall above a solid בדיקה block 65 px tall, beside an empty dashed box that looks like
a second place to type, above the input. Nothing shows which box has the keyboard.

## Goal

On a typed card the answer bar shows one field: help's line on top, the typing below, each button
inside the field at its right. Same behaviour, no taller bar, nothing moves on a press.

## Non-goals

- Help's rules (`typedHelp.ts`), the bar's note and button rules (`answerBar.ts`), the retype, the
  second try, the keyboard rules (no auto focus, the bar on the keyboard).
- The locked answer in the card once judged: today's box in its verdict colour.
- Cards whose help is not typed (`LettersBox`, letter tiles, choice cards, matching), and other
  inputs in the app.

## Design

**D1. One field.** The bar holds, top to bottom: the note line when there is one (unchanged), then
one field (`typed-box`) with a 1.5 px border and `radii.group` corners. In it:

1. **help's shelf**, when the card has help now: a pale strip (`colors.background`), עזרה at the
   right, help's reading to its left;
2. a hairline (`colors.border`), only under the shelf;
3. **the answer line:** בדיקה at the right, the input to its left.

With no help (a sentence translation, a retype) the field is the answer line alone.

**D2. Help's shelf.** עזרה is today's `HelpButton` (`typed-help`), as wide as בדיקה. The reading
area (`typed-help-row`) holds help's reading (`typed-hint`, with `typed-marks` and `typed-ghost`)
by today's rules: empty before any press, in the answer's direction, wrapping onto more lines when
long, not pressable. The shelf is as tall as עזרה until a reading wraps, so the first press moves
nothing.

**D3. The answer line.** בדיקה (`typed-submit`, or `judge-try-again`) is a solid blue button inside
the field: 92 px wide **(my call: fits בודקים…)**, 46 px tall, 10 px corners (the field's corner
less its padding), its label and states as today (בדיקה, בודקים…, נסו שוב; half-faded when
disabled). The input fills the rest of the line. A sentence's input grows from one line to three
and בדיקה stays at the bottom, beside the last line.

**D4. Where the keyboard is.** While the input has focus the field's border is the primary blue,
with a faint blue glow **(my call: the mock's glow)**; otherwise it is `colors.border`.

**D5. The test IDs stay:** `typed-bar`, `typed-box` (now the whole field while typing, the locked
box once judged), `typed-help`, `typed-help-row`, `typed-hint`, `typed-marks`, `typed-ghost`,
`typed-input`, `typed-submit`, `judge-try-again`.

## Testing

`help.spec.ts`, on the typed card: עזרה and בדיקה sit inside `typed-box`, עזרה above the input; the
field is blue while the input has focus and grey after a blur; the field's height is the same before
and after the first press. Every e2e spec that answers a typed card must still pass.

## Left for Victor

The Android phone check (no emulator here): both buttons inside the field at its right, the focus
border and glow, a long reading wrapping on the shelf, and a sentence's בדיקה at the bottom as the
box grows.
