# Phase 73 — A daily goal for My words, today's progress, and continuing from its results

- **Status:** Scoped with Victor on 2026-10-23 (one-pager, then a brainstorming talk with mockups),
  then "continue till PR, subagents": the design is self-approved (CLAUDE.md, *Continue till PR*).
  Lines marked **(Victor)** are his answers; lines marked **(my call)** are Claude's.
- **Date:** 2026-10-23
- **Source:** `drafts/2026-10-23-my-words-daily-goal-one-pager.md` (gitignored; restated here, and
  changed by the talk: the goal is per course, reminders and the drill-down are out).
- **Builds on:** phase 64 (the home card), 65 / 67b (a target's today line in sessions), 69 (Words
  for me), 70 (a learner setting and its screen), 72 (continue from a target's results), ADR 0013
  (the learner day), ADR 0014 (the main path is a path).

## Why

**(Victor)** A learner who practises only My words can't tell how much is enough today: there is no
finish line, it never feels done, and nothing pulls them back the next day. Target cards have a
daily line; My words shows only how many words wait. And between sessions the learner goes back to
home and taps again, where learning should flow from one session to the next, as phase 72 made it
for targets. Someone "in the zone" who wants more sessions is excellent, and nothing should slow
them down.

## Done means (Victor)

1. On the phone, goal 3: the My words card goes "היעד של היום: 3 תרגולים" → "כל הכבוד! עוד 2
   תרגולים להיום" → green "כל הכבוד! עשית 3 תרגולים היום"; a fourth session starts straight away and
   counts ("עשית 4 תרגולים היום").
2. A goal changed in settings shows on the card at once, today; otherwise the count never grows
   during the day.
3. "להמשיך לתרגל" on a My words session's results opens the next session's first question, with no
   home screen in between and normally no wait.
4. The results screen's numbers match the home card's.
5. Today's progress, new words and words moved up, shows as two tiles on the card and on results.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass.

## Goals, non-goals, anti-goals

- **In (Victor):** a daily My words goal counted in sessions, per course, 1–20 or off, default 3;
  the card's today line and dots; today's progress tiles; My words' results screen with the same
  block and a continue button that never asks; a learner with no words of their own is sent to
  Words for me and from there straight into a first session; each day's goal and result recorded.
- **Out (Victor):** a streak; measuring the habit (before/after counts); reminders that know the
  goal (a later phase, which must account for several targets at once); what a My words session
  holds; anything on targets beyond phase 72; home's card order; drill-down screens from the tiles
  (a later phase: Victor chose tiles so they can open one).
- **Anti-goals (my call):** the phase fails, even with every test green, if a target's card, its
  results screen or the "practice more" sheet changes; if a session's content changes (the picker,
  the stock, the day simulation's measures); if the card and the results screen ever show different
  numbers for the same moment; if the stack grows (back from the next session must land on home).

## Design

### D1. The goal setting (Victor: per course, 1–20 or off, default 3, applies today)

- **Stored** on `enrollments` as `my_words_goal smallint null`: null is the default (3), 0 is off,
  1–20 a goal; a check holds it between 0 and 20. A saved 3 is stored as null, as phase 70 stores
  its defaults, so a later change of the default reaches everyone who never chose. Migration
  `0051_my_words_goal` (with D3's table).
- **Wire (my call):** `GET /api/enrollments/{id}/my-words-goal` → `{ goal: number | null }`, the goal
  in force (3 when never set) or null when off. `PUT` with the same body (1–20 or null) replaces it
  and answers the stored result. A new permission `my_words_goal.manage` in no role: the owner only
  (ADR 0008). The auth matrix gains a STRANGER fixture for both routes.
- **Applies today:** the PUT rewrites today's day row when one exists (D3), in its transaction, so
  the card's next read shows the new goal; lowering it below the sessions done turns the card green.
- **Screen (Victor: the reminders' stepper; my call: where):** הגדרות gains a row, **יעד יומי**,
  next to מילים חדשות. It opens a screen titled with the active course
  (`יעד יומי · <language name>`), with a switch for the goal and, when on, the reminders screen's
  − / + stepper ("3 תרגולים", 1 to 20). Each change saves as it is made, the newest only
  (`createSaver`, as the reminders and new-words screens save). Turning it on again restores 3.

### D2. What counts (Victor, and my call on the edges)

A **counted session** is a main-path session (`target_id` null) of kind `practice` and source
`list` that **completed** on the learner's day (`practice_day`, ADR 0013). Not counted: the seed
(Victor: a demo, not the learner's list), a tester's question-types session, a skipped or failed
session, any target session. Each course counts its own sessions against its own goal (Victor).

- **sessions done:** the counted sessions of the day.
- **new words (Victor):** words met for the first time that day in a counted session: a word whose
  first answer while saved, over **all** its sessions on every path, falls in a counted session of
  that day (builder check, my call). `findIntroducedOn` finds the first answer first, then this
  keeps the words whose first-answer session is a counted one. Filtering the sessions first would
  count a homework's words as new in the first My words session after the homework ends.
- **moved up (Victor):** distinct words whose badge (the level the word list shows: חדשה → נחשפה
  → מוכרת → ידועה → בשליטה) rose in a counted session that day, once per word however often it
  rose. It is the same rise the results screen marks "עלתה לרמה N": `progressChanges` over the
  session's `session_progress` rows with `LIVE_DIMENSIONS`, `badgeRaised`. A skill step that leaves
  the badge where it was does not count; a rise in a target session does not count here.

### D3. The day row (Victor: "derive, then record"; shape approved in the talk)

A new table **`my_words_days`**, one row per enrollment and learner day:

| column | holds |
|---|---|
| `enrollment_id`, `day` | the key (`day` a date, the learner's day) |
| `goal` | the goal in force at the last write: 1–20, or null when off |
| `sessions_done`, `new_words`, `moved_up` | D2's counts for that day |
| `last_session_id` | the session whose end wrote it last; kept by a goal change (the PUT rewrites only a row a session wrote) |
| `updated_at` | when |

- **Written** by the transaction that completes a counted session, after `recordProgress` (so under
  the progress lock, ADR 0014 R4), as an upsert whose counts are **recomputed** from the day's rows,
  never incremented: a word that rose twice stays one, and a write that happens twice doubles
  nothing. Also by the goal PUT, for today's row only and only when it exists (a day with no counted
  session has no row).
- **Logged:** each write logs `my_words_day_recorded` with the enrollment, the day, the five numbers
  and `session_id` or `reason: 'goal_changed'`.
- **Not rebuilt** by the recompute, as `target_budgets` is not (my call): it records what the learner
  was shown that day. The per-word trace stays in `session_progress`.

### D4. The card's read (my call)

`GET /api/enrollments/{id}/sessions/current` for the main path gains an optional
`today: { goal: number | null, sessions_done, new_words, moved_up, minutes }`: today's row when there
is one, zeros otherwise, and the goal from the setting (which the PUT keeps equal to the row's).
`minutes` is the goal × `SESSION_LENGTH` × `CARD_SECONDS` / 60, rounded (3 → 15), as a target's
offer computes it. Absent on a target's path. Additive and optional: no `API_LEVEL` change (ADR
0012); an older server sends nothing and the app shows today's card.

### D5. The card (Victor, from the mockups)

The header stays as it is (words due, or saved). The body, above the button:

| state | today line | dots | tiles | button |
|---|---|---|---|---|
| no session yet today | "היעד של היום: 3 תרגולים", grey; side "כ-15 דקות" | 3 empty | hidden | solid "לתרגל עכשיו" |
| some done, goal not met | "כל הכבוד! עוד 2 תרגולים להיום" (one left: "כל הכבוד! עוד תרגול אחד להיום"), grey | green per session done, grey to go | shown | solid "לתרגל עכשיו" |
| goal met or passed | "כל הכבוד! עשית 3 תרגולים היום" (one: "עשית תרגול אחד היום"), green, bold; the number is the real count | the goal's dots green, then one blue dot per extra session (a target's bonus colour) | shown | pale "לתרגל עוד", which starts the session with no question |
| goal off | none | none | shown | as today |

- **Tiles (Victor: B):** two side by side, a big blue number and a label: "מילים חדשות היום" and
  "עלו רמה היום" (for one: "מילה חדשה היום", "עלתה רמה היום", my call). Both hidden while both are
  0 (my call); either one alone shows its 0.
- The goal-of-one start line is "היעד של היום: תרגול אחד" (`targetSessionsGoal`'s wording).
- A screen reader reads the line and the count as one sentence and skips the dots, as a target's
  `Sessions` row does. With a goal above about 10 the dots stay on one row by narrowing (the
  builder's); the line carries the exact count.

### D6. No words of their own (Victor)

The My words card never starts the seed again. When the main path has nothing of the learner's own
to practise (today's `save-words-first` action, either kind, and the `start-seed` action), the card
shows the goal line (if on), and "לתרגל עכשיו" opens מילים חדשות בשבילי (`/discover`). The header
shows the saved count ("0 · מילים שמורות"), no longer the seed's set (builder check). The
"all your words are in homework / test" note, when it is the reason, stays above the button (my
call); the "save words first" note goes, since the button now does it.

- **The server:** the main path's next source is the seed only when the enrollment has no session
  **and no saved word on the main path** (today: no session). A learner who saved words before a
  first session gets a list session. The seed stays reachable through the API for an enrollment
  with neither, which the e2e helpers use.
- **After saving (Victor: straight into the session):** when Words for me was opened from the card,
  saving creates the main path's session and opens it as soon as it is ready, without showing home.
  While it prepares the learner sees the app's preparing look ("מכינים שאלות"); where that look is
  drawn (the save button, or a waiting state before the session screen) is the builder's, as long as
  home is not shown and back from the session lands on home. Opened from the words tab, Words for me
  ends as today (home, "N מילים נשמרו").
- **When no session can be made (builder check, my call):** create can refuse after the save, for
  example when every other word is in a target and today's new-word cap is spent, so the main path
  has only new words and no room for them (409 `no_saved_words`, or `not enough questions`). The
  learner then lands on home exactly as from the words tab ("N מילים נשמרו"), and home shows what it
  shows today for that state. This is the one case where home appears.

### D7. My words' results screen (Victor, from the mockups)

The session read (`GET /sessions/{id}`, `SessionViewSchema`) gains an optional `kind`
(`practice` or `question_types`, from `sessions.kind`), so the app can tell a counted session from a
tester's (builder check; additive, no `API_LEVEL` change). With `source` and phase 72's `target_id`
it decides the screen.

For a counted session (D2) the results screen reads the main path's current state when it opens
(the read home makes, D4) and, under the score, draws a block with a small title "המילים שלי ·
היום", the card's today line and dots, and the tiles, using the card's own parts on the same read
(Done 4). Goal off: the tiles alone; nothing to show: no block. The practised and missed lists stay
under it, unchanged.

- **The button (Victor: never asks; label my call):** always **"להמשיך לתרגל"**, solid, testID
  `results-continue`, past the goal too. It does what the card's button does with the same read:
  enter a stocked or started session, send create when there is none, show the preparing look and
  read again every `POLL_INTERVAL_MS` while it prepares (pressable when ready, never entered on its
  own), the failed note and retry after a failure. The session is opened by **replacing** the
  results screen (phase 72 D3), so back from it reaches home. "סיום" goes home, as today.
- **Holding the finished session:** as phase 72 D2, the screen keeps drawing the finished session
  while the next one loads.
- The seed's and a question-types session's results screen is today's (`results-next-session`).

### D8. One code path (my call)

The My words press (start or resume, create, preparing, retry, and now Words for me when there are
no words) moves out of `LearningSection` into one hook that home and results both use, taking how
to open the session screen (home pushes, results replaces), as phase 72's `usePracticeTarget` does
for targets. Home's behaviour is unchanged except D5 and D6.

### D9. Unchanged

Reminders (and `reminder_settings.daily_target`, which keeps counting every path), home's order,
targets, their results, the "practice more" sheet, the picker and the stock, and the day
simulation's measures.

## Testing

- **Server unit:** the counts' pure rule (D2: dedup of moved up, completed-only, main path only,
  seed and question-types excluded); the goal's stored/default/off mapping; the seed rule (D6); the
  minutes.
- **Integration:** completing a counted session writes the row with recomputed counts, a second
  completion rewrites it; a target session and a seed write none; the goal PUT rewrites today's row
  and writes none on a day with no row; the current read's `today`; the routes and the auth matrix's
  STRANGER fixtures.
- **Mobile unit:** the card's line, dots and tiles per state (D5) and the results button (D7), in
  the style of `targets.test.ts`.
- **e2e:** play My words sessions and watch the card's line, dots and tiles; finish one and continue
  from results straight into the next session's first card (no `GET sessions/current` between the
  press and the first card; results itself now makes that read when it opens, so the count starts
  at the press), and back lands on home; change the goal in settings and see the
  card; a learner with no words taps the card, lands in Words for me, saves, and reaches a session
  without home. Locators on results are scoped to the block's container testID, since home stays
  mounted underneath on web. Specs that played the seed from home's card must start from saved
  words or Words for me instead.

## Left to the builder

The hook's name and shape (D8), where the preparing look sits after Words for me (D6), the dots'
narrowing for large goals, the block's spacing within the clean-and-calm look, the e2e fixtures and
which existing specs need a new start.

## Left for Victor

- Merge once CI is green; release as usual (the server ships before the app, ADR 0012); the
  container migrates 0051.
- On lane 0: `git pull && npm install && npm run db:migrate`, then on the Android phone: play My
  words sessions to the goal and past it, continue from results, change the goal, and try a new
  course with no words.
