# Phase 71: the eve has no daily goal, only "every word ready"

- **Date:** 2026-10-22
- **Status:** approved by Victor in chat ("option 1 is the best. Go till PR")
- **Replaces:** on the eve only (one day left), phase 65's day as a budget of sessions (spec D7) and
  phase 67b's card lines (spec D7) and amber strip (spec D9). Every other day is unchanged.
- **Mockups:** Design canvas https://claude.ai/artifact/7QcF9T26asqMUKEeyL4wnU, row "Option 1 ·
  Words left". Evidence chart: https://claude.ai/artifact/RxMz8h31CXi4u3F29oT5UV.

## Why

Victor, in prod on 22 Oct, the eve of a 9-word homework he had barely practised (15% at the start
of the day). After 4 sessions the card read 82%, the strip "שיעורי הבית מחר ו-7 מילים צריכות
חיזוק", and the day's line "כמעט שם · עוד תרגול אחד". The fifth session the server had stocked held
**one card**.

- The eve's budget is one pass: one card per practised skill for each word below its bar, one
  check for a ready word, played forward as if every answer were right (phase 67 D5: a miss adds no
  card). It never looks at how far the card is from 100%. Victor missed 12 of 45 answers (8 with
  help, 4 gave-up says); each left a word short and added nothing.
- On the eve a session in `owed` mode asks only the owed cards, so the budget's last session is
  whatever is left over: here one card.
- The day simulation (master, 10-word homework, skipped until the eve): a learner who never misses
  reaches 100% inside the 6-session budget; one who misses 1 in 5 ends the budget at 79–88% with
  4 of 10 words ready and needs 10–12 sessions; 1 in 4, 65–88% and 11–14 sessions.

Victor: **"daily goal has no meaning the day before due date. The only goal now is do the maximum
in order to be ready for the homework tomorrow."** He chose option 1 of three mocked (words left,
sessions to 100%, count up).

## Goals

- On the eve the card's goal is every word ready; it counts the words still short, and every
  session visibly moves something.
- Never "done" on the eve while a session can still raise the card; every eve session is a full
  one.

## Non-goals

- Any day before the eve, and the date itself: budgets, lines, strip, sheet as they are.
- Catching up a skipped day before the eve (a separate question, raised with Victor).
- The target screen's word groups ("נשאר להיום", "תורגלו היום"): unchanged.

## Decisions

### D1. The eve's day is owed while a session can raise the card (server)

`todaySummary`: with one day left, the state is `owed` while one more session today can raise the
card (`canRaiseToday`, phase 67b D6: on the eve, any met word below its bar, or an unmet one while
the day has room for new words). Otherwise it is the plan's state, as before: `owed` while the
eve's check cards are left, then `done` (or `rest` before any answer). The budget does not decide
the eve's state. It is still set and stored at the path's first session, as a record, and its
fields stay on the wire. The new app does not draw them on the eve.

### D2. No eve session is the owed work alone (server)

Where a target session on the eve would be chosen in `owed` mode, it is chosen in `past_budget`
mode instead: the owed cards first, then practice more fills the session with the words below
their bar (phase 65b D2, phase 67b R1). `owed` mode with nothing left to ask still falls to `more`
(T3-m). The day simulation's `chooseFor` mirrors it. Anti-goal 1 (phase 57: while work is owed, only
owed work) gets the eve as its second exception beside past the budget, gated as "owed work first".

**Ruling R1 (build):** the spec first said "every eve session is full". The simulation shows that
practice more itself asks one card a word below its bar (phase 67b R1), so as words reach the bar
the eve's sessions shrink: 6, 5, 3, then 1 card (10-word homework skipped until the eve, the five
miss phases). Filling them is a product choice phase 67b left open ("R1's short eve sessions"):
repeat the short words (faster, and a card right after its answer was shown inflates readiness) or
add ready words (a miss lowers the card). This phase keeps practice more as it is and fixes only
the owed-only session, the one-card session Victor met; the simulation reports the sizes ungated.

### D3. Each word's readiness on the home list (wire)

`TargetSummary` gains `word_readiness`: each word's readiness as the card counts it (100 at its
kind's bar, the target word's `readiness_pct`), in the order the words were added. An addition: no
API level (an older app ignores it; see D8).

### D4. The card's row on the eve: words left (app)

With one day left and at least one word, the sessions row becomes a words row (Victor's mock):

| State | Line | Side |
|---|---|---|
| Some word below its bar | "עוד 7 מילים לחזק" (one: "עוד מילה אחת לחזק") | "2 מתוך 9 מוכנות" |
| Every word ready, check cards owed | "נשארה בדיקה אחרונה לפני מחר" (my call) | none |
| Every word ready, nothing owed | "עשית את זה! ✓" (phase 67b's 100% line) | none |

- Under the line, one bar per word in place of the session dots: the ready words first, then by
  readiness, highest first; a ready word's bar is full and green (`colors.progress`), any other is
  filled to its readiness in light blue (#84ADFF, my call: told apart from green by lightness too).
- The line is dark grey and bold while words are short, as in the mock; the 100% line keeps its
  green. The screen reader reads the line and its side ("עוד 7 מילים לחזק, 2 מתוך 9 מוכנות"), the
  bars hidden, as the dots are.
- The target screen's header draws the same row (it reuses the card's `Sessions`).

### D5. The amber strip on the eve (app)

"שיעורי הבית מחר · היום מתרגלים עד שכל המילים מוכנות" (an exam: "הבוחן מחר · …"), in place of
"…מחר ו-7 מילים צריכות חיזוק": the count moves to the card's row (D4). The date itself keeps
"…היום ו-3 מילים צריכות חיזוק". Every word ready keeps "כל המילים מוכנות לשיעורי הבית ✓".

### D6. The button and the sheet follow (app, no new rule)

The button is solid "לתרגל עכשיו" while the day is owed (phase 64 D4), so all eve long below 100%
(D1). The practice-more sheet shows only on a done day that cannot be raised (phase 67b D8), so
never on the eve below 100%.

### D7. Copy

All new Hebrew lines are in `strings.ts`, each with its exact text in `strings.test.ts`. Victor's
from the mock: the strip, "עוד N מילים לחזק", "N מתוך M מוכנות". Mine: the one-word line and the
check line.

### D8. Older apps (ADR 0012)

Not an API level: `word_readiness` is new, and `today.state` keeps its values and meaning ("work
owed today"); only the eve's plan of what is owed changes. An older app on the eve after the
budget draws "כמעט שם · עוד תרגול אחד" with a solid button, the misleading line this phase
removes, until its over-the-air update lands. Recorded in `apiLevel.ts` as phase 67b did.

## Testing

- Domain: `todaySummary` on the eve (owed while it can raise, after the budget too; the plan's
  state once it cannot); the eve's `past_budget` mode.
- Day simulation: `chooseFor` mirrors D2; the phase 67b eve gates still hold; a new gate: on the
  eve no target session is the owed work alone, its sizes below 100% reported.
- Services and routes: the summary's eve state and `word_readiness`; the session service's mode on
  the eve.
- App: the eve's line, side, bars and spoken text by table; the strip; strings.
- e2e: the exam due tomorrow in `targets.spec.ts` reads the new strip and the words row.

## Left for Victor

- Merge and release (no migration).
- Look at the eve on Android with a homework due tomorrow.
