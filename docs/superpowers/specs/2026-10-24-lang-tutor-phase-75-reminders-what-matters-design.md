# Phase 75 — A reminder names what matters most, and opens it

- **Status:** Scoped with Victor on 2026-10-24 (one-pager, then mockups of every message and five
  side-picture variations), then "go till PR": the design is self-approved (CLAUDE.md, *Continue
  till PR*). Lines marked **(Victor)** are his answers; lines marked **(my call)** are Claude's.
- **Date:** 2026-10-24
- **Source:** `drafts/2026-10-24-reminders-most-pressing-one-pager.md` (main checkout, gitignored;
  restated here). Mockups: `.superpowers/brainstorm/43940-1792794720/content/` (`messages.html`,
  `side-picture-variations-v2.html`).
- **Builds on:** phase 52 (reminders, the tick, the decision log), phase 57 (a path per target, a
  reminder opens home's first card), phases 65, 67, 67b and 71 (a target's day: owed, done, the
  eve), phase 72 (a path's session opened in place of the results screen), phase 73 (My words'
  goal; its Out list: "reminders that know the goal… must account for several targets at once").
  ADR 0001 (layers), ADR 0002 (closures), ADR 0012 (native releases), ADR 0013 (the learner day),
  ADR 0014 (sessions belong to a path).

## Why

**(Victor)** "Being told to practise in general is too weak. We should go straight to the point
based on what matters the most, and use very specific info we have: tomorrow is the homework due
date…, the last practice of today is still waiting… Once he taps he goes directly to the session
without home screen."

Today one learner-wide setting, **תרגולים ביום** (default 1, any session of any course or path),
silences every reminder once it is met. A Wednesday with homework due Thursday at 40% and My words'
goal of 3: the 13:00 reminder says "הגיע הזמן לתרגל"; one My words session at 14:10 meets the
setting; 17:00, 20:00 and 22:00 are skipped, and the homework is never mentioned. The text never
changes, and a tap opens whichever card is first on home.

## Done means (Victor: "good tests that cover these scenarios")

1. Homework due tomorrow and not ready, one My words session done: the next reminder still comes,
   names the homework, and its tap opens the homework's session with no home screen.
2. Only My words' goal left: the reminder is about My words, and its tap opens a My words session.
3. Nothing owed on any path: no more reminders that day.
4. Each reminder records which path it was about and why.

`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Goals, non-goals, anti-goals

- **In (Victor):** at each of the learner's reminder times, one notification about the single most
  pressing thing, in specific words; the order below; reminders stop only when nothing is owed on
  any path, in every course; a tap opens that path's session directly; תרגולים ביום leaves the
  reminders screen (on/off, days and hours stay); a picture on the side per kind, option 2 (the
  kind's tile with a small WordsPal badge); the WordsPal W in the notification's top line, from
  the logo Victor gave (blue).
- **Out (Victor):** new timing (smart times, times from a due date); more than one notification
  per time, or one per path; muting one path; model-written wording; any change to what a path's
  day is (a target's owed/done, the eve, My words' goal); email, SMS, in-app banners, "session is
  ready"; the app's launcher icon (my call: a separate change, offered to Victor).
- **Anti-goals (my call):** the phase fails, even with every test green, if a reminder's numbers
  ever differ from the home card's for the same moment; if a reminder is sent while nothing is
  owed, or skipped while something is; if two notifications go out for one slot; if a tap lands on
  home for a path that can still be practised; if anything about sessions, targets or My words'
  day changes.

---

## Design

### D1. What a path owes, read as home reads it (my call)

For a reminder the learner's day is a list of **paths**, one per active target and one My words
per course, across every enrollment the learner owns:

- **A target:** the same `targets.list` read home's cards are drawn from (phase 57/65/67b/71), so
  the numbers are the card's: `kind`, `days_left`, `today.state`, `word_count`, `ready_count`,
  `readiness_pct`, `today.sessions_offer`, `today.sessions_done`, `today.minutes`. A target is
  **owed** when `today.state === 'owed'` and it has a word. `done`, `rest` and `due_today` owe
  nothing (phase 57: nothing is owed on the date itself).
- **My words:** a new read-only use case, `sessions.myWordsDay(actor, enrollmentId)`, answering
  phase 73's `myWordsToday` (the goal in force, the sessions done) and the main path's waiting
  count (`waitingOn`, home's "N מילים מחכות לחזרה"). It is home's `currentSession` read without
  its writes (the stale-stock replacement, the offered log). My words is **owed** while its goal is
  on and `sessions_done < goal`.

The reminder service is handed these reads as closures by the composition root, as phase 26 hands
the photo-import service `translations.translate` (ADR 0001 R8's phase 26 note): it imports their
types only. A new module, `services/reminderPaths.ts`, turns the learner's enrollments
(`enrollments.list`), their targets and My words' day into `ReminderPath[]`; each read is its own
read transaction, between the slot's claim and its record (R8: reads before third-party I/O may be
their own). The tick acts as the learner over their own enrollments, which the reads authorize.

### D2. The order (Victor)

`chooseReminder(paths)` in `domain/reminders.ts`, pure, returns the one path to remind about, or
none:

1. **A target due tomorrow** (`days_left === 1`) that is owed: the eve (phase 71 keeps it owed
   while a session can raise the card, and while its last check is owed).
2. **Any other owed target** (`days_left >= 2`).
3. **My words** whose goal is not met.

Within a rank, **a test before homework (Victor; at every rank, my reading, marked assumed in the
one-pager)**, then the nearest date, then the enrollments' order and the target's id, so the choice
is stable. Ranks are across courses. None owed: the slot is skipped and no notification goes out.

### D3. The messages (Victor approved the mockup's lines; wording reuses the cards')

`reminderMessage(choice, { language })` in the domain, Hebrew like every string the app shows. `K`
is the kind with its article (הבוחן, שיעורי הבית), `KL` with ל (לבוחן, לשיעורי הבית). `ב<שפה>`
follows the kind only when the learner owns more than one enrollment (my call), e.g. "הבוחן
באיטלקית מחר", "המילים שלי באנגלית"; the names are the app's (עברית, אנגלית, רוסית, איטלקית).

| Rank | When | Title | Body |
|---|---|---|---|
| 1 | words below the bar (`n = word_count − ready_count > 0`) | `K מחר` | `n מילים צריכות חיזוק · מוכנות KL: p%` (n = 1: `מילה אחת צריכה חיזוק`) |
| 1 | every word ready, the last check owed | `K מחר` | `כל המילים מוכנות · נשארה בדיקה אחרונה לפני מחר` |
| 2 | nothing done today, an offer of s | `K בעוד d ימים` | `היעד של היום: s תרגולים · כ-m דקות` (s = 1: `תרגול אחד`; no minutes part when m = 0) |
| 2 | one left of the offer | `K בעוד d ימים` | `כמעט שם · עוד תרגול אחד ליעד של היום` |
| 2 | more than one left | `K בעוד d ימים` | `התחלה טובה · עוד k ליעד של היום` |
| 2 | owed with no offer to count by | `K בעוד d ימים` | `נשאר תרגול להיום` |
| 3 | nothing done today | `המילים שלי` | `היעד של היום: g תרגולים · w מילים מחכות לחזרה` (g = 1: `תרגול אחד`; w = 1: `מילה אחת מחכה לחזרה`; no second part when w = 0) |
| 3 | some done | `המילים שלי` | `כל הכבוד! עוד k תרגולים להיום` (k = 1: `כל הכבוד! עוד תרגול אחד להיום`) |

`p` is `readiness_pct`, `s` `sessions_offer`, `m` `minutes`, `g` the goal, `w` the waiting count.

### D4. The picture on the side and the W in the top line (Victor: option 2, "use this icon")

- **Side picture:** five PNGs, 192 × 192, transparent: the kind's tile (the cards' blue gradient
  `#3B5BDB → #5B7BF0`, white icon: calendar for בוחן, document for שיעורי בית, book for המילים שלי, as
  `TargetCard`/`MyWordsCard` draw them) with a small white circle in the lower left corner holding
  the WordsPal W in the logo's blue. The rank 1 tile with words below the bar is amber
  (`#F79009 → #FDB022`), like the card's ⚠. Files: `exam.png`, `exam-urgent.png`,
  `homework.png`, `homework-urgent.png`, `my-words.png`, in `apps/mobile/public/notifications/`,
  which the web export copies and the production container already serves (`createWebHandler`).
  They are drawn from an SVG source kept beside them (`notifications/source.html`, my call) by a
  one-off script, so they can be redrawn.
- **Sent as** Expo's `richContent: { image }`. On Android expo-notifications sets it as the
  notification's large icon (`ExpoNotificationBuilder`); when Android itself draws a closed app's
  notification, Firebase may also show it as a big picture in the expanded view. Only the phone
  shows which, so it is Left for Victor, with a switch (below).
- **The URL:** `REMINDER_IMAGE_BASE_URL` when set (`off` turns pictures off); otherwise, where the
  server serves the web export (`WEB_DIST_DIR`) and knows its public origin (`AUTH_BASE_URL`),
  `<AUTH_BASE_URL>/notifications`; otherwise none, and the message has no picture (dev, CI, e2e).
- **Top line:** `app.json`'s expo-notifications plugin gets `icon` (a 96 × 96 white W on
  transparent, `assets/images/notification-icon.png`, Android draws it as a silhouette) and
  `color` (the logo's blue). That changes the fingerprint, so the next release ships a new binary
  (ADR 0012); until then the top line keeps today's icon.
- **The W:** a vector redrawn from Victor's blue logo (the image itself did not reach the repo):
  the open book's thin arc over a looped W, the logo's blue gradient. When Victor adds the logo as a
  file, it replaces the vector in both places (Left for Victor).

### D5. What is sent, and recorded (my call)

- **Message:** title and body from D3, channel `reminders`, priority `high` (as now), `tag:
  'reminder'` so a new reminder replaces the last one in the shade rather than stacking (shown in
  the mockup's note), the picture when D4 gives one, and `data: { reminder_id, enrollment_id }`
  plus `target_id` for a target.
- **Skip:** none owed records `skip_target_met`, as phase 52 named "the day's work is met"; the
  outcome check (`reminders_outcome_known`) stays as it is, so there is no migration.
- **Evidence** (`reminders.evidence`, jsonb, so no migration): `time_zone`, `devices`, `paths` (each
  path's `enrollment_id`, `target_id`, `kind`, `state`, `days_left`, `sessions_done`, `sessions_offer`
  or `goal`, `word_count`, `ready_count`), and `chosen` (`enrollment_id`, `target_id`, `kind`,
  `rank`, `title`, `body`, `image`) or `null`. Done-means 4 is this column.
- **A read that fails** records `failed` with the error, as a push that fails does; the next slot
  tries again.
- **`daily_target`** stays in the table and on the wire, unread by the tick: old apps still show
  and save it, the new app saves back what it read. `API_LEVEL` stays.
- The tap and the session mark (phase 52 D6) are unchanged.

### D6. The tap opens the path's session (Victor: "directly to the session without home screen")

- **The tap:** the app reads `enrollment_id` and `target_id` from the notification's data
  (`reminderTapOf`, replacing `reminderIdOf`), reports the tap as now, and opens
  **`/practice?enrollment=<id>&target=<id>`** (no `target` for My words) over home: dismissed to
  home first, as `openReminderTap` does today, then pushed. A notification without
  `enrollment_id` (sent before this release) keeps phase 52/57's `/?start=reminder`.
- **The practice screen** (`src/app/practice.tsx`) draws only a spinner and "פותחים את
  התרגול…". It switches to the reminder's course when it is not the active one (`switchTo`), waits
  for that course's reads, then does what that path's card button does, through the same code:
  `pathReminderStartOf` in `nextSession.ts` (the target half of `homeReminderStartOf`, extracted,
  for a named target; `reminderStartOf` for My words, except that it creates a missing session
  itself, since only home auto-creates, and a learner with no words goes to Words for me). It
  polls while the session prepares, as home does. When it enters the session it **replaces
  itself** with the session screen (phase 72's way), so back from the session lands on home.
- **Nothing to open** (the target ended or was removed, the course is gone, a read failed): it
  replaces itself with home, which shows what is left (my call, the parked question).
- **No "practice more" question** on this path (my call): the reminder fires only while the day is
  owed, and a learner who tapped it chose to practise.

### D7. The reminders screen (Victor)

The **תרגולים ביום** row and its stepper go. On/off, days and hours stay. The save sends back the
`daily_target` it read (D5).

### D8. Everything else is unchanged

The schedule, the tick's cadence, slots and claims, the decision log's columns, device
registration, sessions, targets and My words' day.

## Testing

- **Unit (domain):** `chooseReminder`: each rank, a test before homework at every rank, the
  nearest date, ranks across two courses, `done`/`rest`/`due_today` and empty targets owe nothing,
  My words with its goal off or met; `reminderMessage`: every row of D3, singulars, the language
  only with two courses; the picture's name.
- **Unit (services):** the tick with fake reads: the chosen message, data, tag and picture;
  no picture without a base URL; `skip_target_met` with the evidence when nothing is owed;
  `failed` when a read throws; Done-means 1–3 as path lists. `reminderPaths` with fake reads.
- **Integration (CI):** Done-means 1–3 through the real reads on a seeded learner (a homework due
  tomorrow with words below the bar, a My words session done; then only My words left; then
  nothing), the evidence row (Done-means 4); `myWordsDay` refuses another learner's enrollment, as
  `currentSession` does; the web handler serves a picture.
- **Mobile unit:** `reminderTapOf`, `openReminderTap` with and without a path, `pathReminderStartOf`
  (enter, create, wait, discover, home), the reminders screen without the row.
- **e2e:** `/practice` with a target enters that target's session directly, back lands on home;
  `/practice` for My words enters a My words session; the reminders screen has no target row.

## Left to the builder

The practice screen's layout beyond the spinner and its line; how the PNGs are rendered (a
Playwright screenshot of the SVG source is enough); test names and fixtures.

## Left for Victor

Merge; release (the server and a new Android binary, since the notification icon changes the
fingerprint); then on the Android phone: a reminder about a target and one about My words, closed
app and open app, collapsed and expanded, a tap from each straight into its session. If the expanded
view shows the picture as a large banner and it looks wrong, set `REMINDER_IMAGE_BASE_URL=off` in
the container's environment to send none. Add the logo as a file if the redrawn W should be
replaced.
