# Phase 70 — New-word limits the learner sees and sets

- **Date:** 2026-10-22
- **Source:** `drafts/2026-10-22-new-word-limits-one-pager.md` (main checkout), Victor's answers in
  the scoping talk. Built under "go till PR": every call not marked **(Victor)** is mine.
- **Builds on:** phase 69 Words for me (PR #233); the picker's daily cap (phase 35/37,
  `DAY_NEW_CAP`) and new words per session (phase 37 `NEW_FLOOR`, phase 54/55 `NEW_PER_SESSION`).

## Goal

**(Victor)** He added 15 words with Words for me on 2026-10-21 and none came up in his regular
sessions. The day's cap of 15 new words, shared with homework, was already spent (21 first meetings
that day, 20 of them on homework paths), and nothing told him. The next day they came one per
session, because due reviews left room for one. The learner should be told when the cap holds new
words back, and should be able to change both limits.

**Done means:**

1. **(Victor)** On a day the cap is spent, starting a regular session shows a short message
   explaining it; ticking "don't show again" stops it for good.
2. **(Victor)** After raising the daily cap in settings, the session after the one already prepared
   includes new words.
3. **(Victor)** Lowering it works the same way in reverse.
4. **(assumed)** After setting new words per session to N, the sessions after the prepared one
   include N new words even when reviews are due.
5. **(assumed)** Unit, integration and e2e tests prove D1–D7; `npm test`, `npm run test:all`,
   `npm run lint:arch` and `npm run e2e` pass.

## Non-goals (the one-pager's Out, Victor)

- Rebuilding the prepared session when a setting changes: the stock in hand is played as chosen.
- A message for the per-session limit.
- Changing how homework and exams use the cap: their planned words still ignore it.
- A tutor or parent setting the limits for a learner.
- A different cap per homework or exam.

**Anti-goals** (my call): a learner who never opens the new screen sees any change in what their
sessions ask (bots and the day simulation included); a notice on a session the cap did not touch.

## Decisions

### D1. Where the limits live (my call: per learner, as reminders are)

Two nullable columns on `users`: `day_new_cap` and `new_per_session`. Null means the default, so a
learner who never chose follows any later change of the default; a saved value equal to the default
is stored as null, so choosing one limit never pins the other. Migration `0050_new_word_limits`.
A learner's limits apply to every list they practise, each list counting its own new words, as the
cap does today.

### D2. The daily cap (Victor: configurable; values my call)

Default 15 (`DAY_NEW_CAP`, unchanged). The screen offers 5, 10, 15, 20, 30 and 50; the wire takes
any whole number from 1 to 100. The learner's cap replaces `DAY_NEW_CAP` everywhere it is read
today: the main path's room (`choose.ts`), a target's room for practice more's early starts
(`targetDayRead.ts`), and the practice-more-little check (`targets.ts`). A target's planned starts
keep ignoring it (non-goal).

### D3. New words per session (Victor: A, a number every session includes)

The setting is **automatic** (null, the default: today's rule, up to two new words and down to one
when reviews are due) or **1 or 2**. A number N means: every regular session includes N new words
while new words wait and the daily cap leaves room; reviews make room for them.

- The picker's reserve becomes `min(new words waiting, day room, N − ladders so far)` and its
  ceiling N, in place of the `NEW_FLOOR` backoff. A session keeps its ten places.
- The ceiling stays 2, `NEW_PER_SESSION` (builder check; the one-pager parked "above 2"): a new
  word's first session asks the distractor call three or four items (`ladderCards`, `taskFor`) and
  the batch takes ten (`LlmDistractorsSchema`), which is why phase 55 keeps the first two ladders in
  the prepare job. Three would need the model call split or widened, measured and evaluated: a
  follow-up, not this phase.
- Regular practice only (my call): a homework or exam session keeps its plan's pace.

### D4. What the session records (my call; Victor wants derived state recorded)

When a path's next session is chosen, the picker runs a second time with no daily cap (the main
path's cap, or a target's room, as infinity), on a constant rng so the real choice's draws are
untouched. The new words that second run picks beyond the first are the words the cap held back.
The session row records `new_words_held` (whole number, default 0) and `day_new_cap` (the cap the
choice used; null on a seed and on rows from before this phase). `session_stocked` logs both. On a
target path only practice more's early starts can differ, so a planned session records 0.

### D5. The wire (my call; additive, `API_LEVEL` unchanged)

- `GET /api/me/new-words` → `{ day_cap, per_session }`: the cap in force (stored or default) and
  the per-session number or null for automatic. `PUT` with the same body replaces both and answers
  the stored result. Own data only, as `/api/me/reminders`; the auth matrix lists both as own-only.
- `GET /api/sessions/{id}` gains an optional `held_new_words: { count, day_cap }`, present only
  while it is news (builder check): the session holds words back, it was chosen on the learner's
  day today (`chosen_on`), and the cap it was chosen under is the learner's cap now. A session
  chosen last night, or before the learner changed the cap, says nothing: it is the prepared
  session the non-goals leave as it is, and its message would describe a day or a cap that no
  longer holds.

### D6. The message (Victor: short, "don't show again")

On the session screen, when the session view carries `held_new_words` and no card has been
answered yet (position 1), a bottom sheet in the readiness sheet's pattern opens over the first
card, once each time the screen opens the session (ruling B5). Every path's session, entered from home, a target's
card or a tapped reminder, passes through that screen. The first card is not read aloud until the
sheet closes.

- Title **"הגעת למכסת המילים החדשות"**; body **"המכסה היא {day_new_cap} מילים חדשות ביום, ולכן
  בתרגול הזה פחות מילים חדשות. אפשר לשנות אותה בהגדרות."**; one button **"המשך"**; a tick box
  **"אל תציג לי את זה שוב"**.
- "המשך", a tap outside and Android back all close it; the session goes on.
- The tick is kept on the device per username, as the practice-more question's is
  (`practiceMoreAsk.ts`); the new settings screen has a switch that turns the message back on.

### D7. Settings (Victor: both limits configurable)

Settings gains a row **"מילים חדשות"** that opens a screen of the same name:

- **"מילים חדשות ביום"**: chips 5, 10, 15, 20, 30, 50; under them **"שיעורי בית ומבחנים פוגשים את
  המילים שתוכננו להם גם אחרי המכסה."**
- **"מילים חדשות בכל תרגול"**: chips אוטומטי, 1, 2; under them **"אוטומטי: 1–2, לפי כמה מילים
  מחכות לחזרה."**
- **"להציג הודעה כשהמכסה מתמלאה"**: a switch (D6).

Each tap saves at once, the newest change only, as the reminders screen saves.

## Testing

- Unit: the picker with a cap and with N (a backlog still gets N; automatic unchanged); the held count, main path and practice more; a planned target session holds 0;
  `day.test.ts` unchanged at the defaults; the mobile sheet decision and the store.
- Integration: the settings routes (defaults, replace, validation, the default stored as null,
  own only); a stocked session records `new_words_held` and `day_new_cap`; the session view reports
  them only on its day and under the same cap; a raised cap reaches the next stock.
- e2e: the screen saves both limits; the sheet opens on a held session, "המשך" closes it, the tick
  keeps it closed, the switch brings it back.

## Builder check (2026-10-22)

A fresh reader raised four questions; all four are settled above as my calls: the ceiling of 3
dropped for the distractor batch (D3), the message only while it is news (D5), a value equal to
the default stored as null (D1), and, with the ceiling at 2, no session grows. Its two smaller
points, a target's create and a reminder's start, are covered by the message living on the session
screen (D6).

## Left to the builder

Names of functions and test fixtures; where the sheet component and the store sit in the mobile
tree; how the e2e fixture reaches a session with words held back.

## Rulings (the build, 2026-10-22)

- **B1.** Per session's ceiling stays `NEW_PER_SESSION`; the setting replaces the `NEW_FLOOR`
  backoff with the learner's number, and its rng-free second run (`heldByCap`, `heldByRoom`)
  counts what the cap held back without drawing from the real choice's rng.
- **B2.** One migration, `0050_new_word_limits`, for both tables: `users` gains the two limits
  (checked 1–100 and 1–2), `sessions` the held count (default 0) and the cap it read.
- **B3.** `insertPreparingSession` takes the held record as an optional last argument; absent, the
  columns' defaults (a seed's 0 and null).
- **B4.** A target's 0 held is pinned by the stock unit tests and the target integration log line;
  `heldByRoom`'s own tests cover practice more's blocked starts.
- **B5.** The message shows once each time the session screen opens a held session (a ref on the
  screen), so leaving before the first answer and coming back shows it again until it is ticked off.
- **B6.** The reminders screen's chip moved, unchanged, to `components/Chip.tsx`, which the new
  screen shares.

