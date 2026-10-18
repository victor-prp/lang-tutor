# Phase 64b — Same-size cards and named bars

- **Status:** Victor chose it in the mockups on 2026-10-18 and said "Go till PR".
- **Date:** 2026-10-18
- **Source:** the chat of 2026-10-18 after PR #210, and its mockups in
  `.superpowers/brainstorm/11878-1792351101/content/` (main checkout): `stack-fixes.html`,
  `stack-fixes-mywords.html` (option 3, the header growing), `six-cards.html` (option 1).
- **Builds on:** phase 64 (PR #210): the tabs, the card stack (D3), the card (D4), urgency (D5).
- **Touches:** the app only: the stack, the card, the first tab's name and icon, e2e.

## Goal

Victor, on phase 64's home: the dots are too small to tap, on the phone too, and say nothing to a
screen reader; and "I don't like the cards have different sizes, it feels weird and unnatural, feels
like every right or left scroll it jumps". Also: rename the first tab to home, "we may add more items
in the future".

## Decisions

### D1. The first tab is בית

The tab **תרגול** becomes **בית**, with a house icon (Ionicons `home-outline`). Its testID becomes
`tab-home`. *(My call: "בית" rather than "ראשי".)*

### D2. Every card the same height

The cards sit side by side in one row, so each is as tall as the tallest, and the row fills the space
between what is above it (a tutor's invitation, the saved-words notice) and the bars: no card, edge
or control moves when the card changes.

- **The blue header grows** into whatever the card's own lines leave (R2): the count or countdown in
  its middle, the lines under it, the button always at the card's bottom.
- **No stack edges** behind the card: cards slide side by side now, not off a pile.

### D3. Sliding

The card follows the finger and slides to its neighbour (about 280 ms, easing out). In RTL the next
card is to the left, so a drag to the right brings it. It stops at the first and the last card
instead of wrapping *(my call: a wrap would slide across every card at once)*; a short drag springs
back.

### D4. Named bars

The dots become one bar per card under the row (`six-cards.html` option 1, `stack-fixes.html`
option 3):

- **Equal widths**, each a 5 pt bar over its label, the whole column a 44 pt target. Tapping a bar
  brings its card; swiping still works (R3).
- **Colour:** the card on show blue, a card in its last two days that is not on show amber (phase 64
  D5), the rest grey.
- **Label, up to four cards:** the name: **המילים שלי**, **בוחן**, **שיעורי בית**; when two targets
  share a kind, each adds its due day's letter: **שיעורי בית ה׳**.
- **Label, five cards or more** (R4): the kind's icon (book, calendar, page) and, for a target, its
  due day's letter. *(My call: the switch is at five, where full names stop fitting.)*
- **Screen reader:** each bar is a button labelled with the card's full name and place:
  "שיעורי בית ה׳, 3 מתוך 6"; the current one is selected.
- **One card:** no bars, as before.

### D4b. Coming back to בית

Shows the first card by priority, never the card left (R5): as phase 64 does, on focus and whenever
the order changes.

## Testing

- **App (unit):** the bars' labels (one of a kind, two of a kind, five cards and more, My words), their
  colours, and their spoken labels.
- **e2e:** the tab is `tab-home` and reads בית; bars replace dots (`home-bar-<card>` for
  `home-dot-<card>`); the bars name the cards; tapping one brings its card; every card has the same
  height.

## Left for Victor

1. After the merge, on the phone: the slide under the finger, the bars' tap targets, TalkBack reading a
   bar.

## Rulings

Victor, 2026-10-18, in the chat and the mockups:

- **R1.** Same-size cards that slide, over today's stack (`stack-fixes.html`).
- **R2.** The blue header grows into a short card's space, over white space (`stack-fixes-mywords.html`).
- **R3.** Named bars (option 3), over bigger dots and over arrows with a counter; swiping stays.
- **R4.** With many cards, an icon and the day (option 1), over one line for the current card and over
  a scrolling strip (`six-cards.html`).
- **R5.** Rename the first tab to home; coming back to it shows the cards by priority, not the last
  state.

### Made while building (2026-10-18)

Each with what it costs if wrong.

- **A drag never presses the card it starts on.** The stack claims a sideways drag in the capture
  phase; on the web, where react-native-web presses on the DOM click, the click a drag leaves
  behind is swallowed. Cost: a click within half a second of a drag is lost on the web.
- **The cards grow from their content** (`flexGrow`, not `flex: 1`), so the tallest card sets the
  least height and the free space stretches every card. Cost: on a small phone a short card's
  button can sit below the fold when another card is taller than the screen.
- **Final review, fixed:** the cards beside the one on show are hidden from screen readers and, on
  the web, inert; coming back to בית jumps to the first card instead of sliding across every card,
  and slides ease out; the saved-words notice sits above the cards.
- **Final review, deferred:** a quick flick under 50 pt springs back and the row has no resistance
  at its ends; the first frame is laid out at zero width before the stage is measured; the bars use
  `aria-selected` on a button (TalkBack reads "selected"; web screen readers may not); a hot fuse
  keeps pulsing on a card that is not on show; four full names may ellipsize on a narrow phone
  (part of the phone check).

