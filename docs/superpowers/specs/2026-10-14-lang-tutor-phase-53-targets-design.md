# Phase 53 — Prepare for homework or a בוחן

- **Status:** Designed with Victor on 2026-10-14, in chat, from his one-pager. Approach A (split
  the session, reuse the picker) was chosen over a separate target picker and a priority boost.
  Each section was approved in turn; his corrections are recorded where they land: several
  targets in parallel (D1), the exclusive day before a בוחן (D5), the wizard (D10), readiness
  shown to the student in words of its own (D4, D11), and every skill practised for every kind
  (D3).
- **Date:** 2026-10-14
- **Source:** `drafts/2026-10-14-test-prep-target-one-pager.md` (main checkout).
- **Builds on:** phase 26 (photo import, whose Out list deferred "several photos in one import"
  and "starting a session from the photo's words"), phase 35 / 37 (the picker and its day
  state), phase 39 / 46 (families, known), phase 43 (the session in stock, its R5), ADR 0011
  (the learner unit is the gloss), ADR 0013 (the learner's day).
- **Touches:** a new pure domain module for targets; `chooseWords` gains three inputs; the
  stock (`stockNext`, the start); photo import (several photos); new tables and a migration;
  new endpoints in the OpenAPI contract; the app's home, a wizard and a target screen; the day
  simulation.

---

## Goal

A course student gets a word list for homework or a בוחן on a textbook page, a handout or a
whiteboard, and a date. Sessions today draw on everything saved, with no way to say "these
words, by this date". This phase lets the student set up a **target** — a kind, a due date and
its words — and makes sessions serve it: target words only at first, then a share that follows
how ready the words are, the kind, and how close the date is.

**Done means:**

1. The day simulation shows the sessions serving each target as D5–D7 say, in every scenario of
   §2: words met before the last day, target-only until ready, the kind's share after, the
   run-up, the exclusive day before a בוחן, nothing after the date (Victor: "tests that validate
   how well the server creates sessions based on the target").
2. A student can create a target through the wizard (photos, review, typed words, date), see
   each active target on home with "N of M ready", and add words, remove words and move the date
   from its screen.
3. With no active target, every session is chosen exactly as before: the existing picker and
   day tests pass unchanged.

`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:**
- Targets of two kinds, homework (שיעורי בית) and בוחן (`exam`), several active at once.
- Sessions split between targets and the main path (D5, D6); paced new words (D7).
- Readiness for the date, from memory, for the picker and the student alike (D4).
- One photo import holding several photos (D9).
- The wizard, home's list of targets, the target screen (D10, D11).
- A record of every session's split and an append-only target log (D8).

**Out:**
- Reports of how the test went; reminders before the date.
- A teacher seeing or setting a student's targets.
- Changing a target's kind after it is created.
- Kinds of בוחן (a dictation, a vocabulary test): one `exam` kind for now (Victor: "maybe later
  we will introduce test types").
- Picking saved words into a target from the saved list: a saved word on the list joins when
  it is photographed or typed.
- Several photos in the standalone photo import screen: it keeps one photo; the wizard and the
  target screen use several.

---

## 1. Decisions

### D1. A target

A target belongs to one enrollment. It has a kind (`homework` or `exam`), a due date — a learner
day (ADR 0013) — and words, each a gloss saved in that enrollment (ADR 0011). Tables:

- `targets`: id, enrollment, kind, `due_on` (date), created at, `ended_at` (an early end).
- `target_words`: target, gloss, added at. Foreign key to `dict_glosses`.

A target is **active** while today is before `due_on` and `ended_at` is null. On `due_on` it
ends by itself; nothing runs for that. Several targets can be active at once (Victor). The due
date can be moved to any day after today, at any time; nothing else about a target changes.

A target word is always saved. Removing a word from a target keeps it saved; unsaving a word
removes it from every target. A gloss can be in two targets.

### D2. Who may act

Only the learner themself creates, changes, ends or reads their targets: tutors are out. The
check uses the existing access rules with a new owner-only permission, `targets.manage`.

### D3. Every skill, for every kind

The kind sets how strict a target is, never which skills are practised: target words are asked
in the same live skills as the main path (Victor: "it's simpler and efficient anyway since it
helps to remember"). The picker's live skills are unchanged.

### D4. Readiness for the date

A target word's **readiness** is its chance of being remembered on `due_on`, in its weakest
skill: the memory model's retrievability at `due_on` (core's `retrievability(state, dueOn)`), over
the skills live in the enrollment's newest session. A live skill with no memory counts as 0.

| Readiness | homework | exam | Shown as (D11) |
|---|---|---|---|
| not met (no memory) | — | — | עוד לא התחלנו |
| below "almost" | < 0.6 | < 0.7 | בדרך |
| almost | ≥ 0.6 | ≥ 0.7 | כמעט מוכנה |
| ready | ≥ 0.8 | ≥ 0.9 | מוכנה |

The thresholds are starting values, named beside the picker's constants in
`chooseConstants.ts`. A target is **all ready** when every word is `ready`. This replaces
phase 46's "known" for targets: the picker and the screen read one number against one
threshold, so "20 of 20 ready" appears when the main path comes back. The saved list keeps
its levels unchanged; a word can be `מוכנה` for a בוחן and `נחשפה` in the list, and both are
true (Victor rejected reusing the level names for this reason).

### D5. Each target's wish

A pure function, per active target, from its kind, `daysLeft = daysBetween(today, due_on)`
(≥ 1 while active) and whether it is all ready. Slots are out of `SESSION_LENGTH` (10).

| | homework | exam |
|---|---|---|
| `daysLeft = 1` | 7, or 10 if not all ready | **10, exclusive** |
| `daysLeft = 2` | as below | 10 |
| not all ready | 10 | 10 |
| all ready (steady) | 3 | 5 |

The wish is the highest row that applies. **Exclusive** (Victor: "if there is a test, one day
before the due date the sessions are focused on the test only"): that day the exam takes every
slot from other targets and the main path. The numbers are starting values in
`chooseConstants.ts`.

### D6. The split, and picking

Pure. If any target is exclusive today, the exclusive targets share all slots evenly and the
rest get none. Otherwise, if the wishes sum to at most 10, each gets its wish; else each gets a
share in proportion to its wish, by largest remainder, ties to the nearer `due_on`. The main
path gets what is left.

Picking runs `chooseWords` once per target, nearest `due_on` first, over that target's words
with its slots and its new-word allowance (D7), then once over the saved words in no active
target with the slots left. `chooseWords` gains three inputs, defaulting to today's behaviour:

- `slots`: the most picks (today `SESSION_LENGTH`; `n` is the smaller of it and the groups).
- `taken`: glosses, keys and families earlier runs took, so a family is never asked twice in a
  session (phase 39) across runs.
- `speak`: whether this run may make the speaking pick. Only the first run that has slots does,
  so a session keeps one speaking card.

A run that picks fewer than its slots (a target with fewer free words) hands the rest to the
next run, and the last to the main path. The returns and day state are today's, read once and
passed to every run. With no active target there is one run of 10: today's picker exactly.

A gloss in two targets fills a slot of the target due first; it counts toward both targets'
readiness.

### D7. Pacing new target words

Per target: `newDays = max(1, daysLeft − 1)`, so every word is met before the last day.
Today's allowance is `ceil((unmet + metToday) / newDays) − metToday`, at least 0, where `unmet`
is the target's words with no memory and `metToday` those of its words first met today. The
allowance replaces `DAY_NEW_CAP` for the target's run; its new words still count toward
today's new words, so the main path meets fewer of its own on a heavy target day. Moving the
date or adding words re-paces from the next session.

### D8. What is recorded

Derive, then record (phase 39's rule):

- `session_targets`: per session and target it served — wish, slots, reason (`exclusive`,
  `run_up`, `not_ready`, `steady`), `daysLeft`, ready count and word count. Written in the
  transaction that chooses the session's words. Nothing reads it back except D12.
- `target_events`, append-only: `created`, `words_added`, `words_removed`, `date_changed`,
  `ended_early`, `ended_on_date`, each with the before and after values and the actor. A
  target past its date gets `ended_on_date` from the first session chosen after it.
- Log events: `target_created`, `target_changed`, `target_ended`.

### D9. One photo import, several photos

A photo import can hold several photos (`photo_import_photos`: import, position, photo, held
while reading, as today's `photo` column). The reading job reads each photo with today's
prompt, one call per photo, and appends its rows in photo order; a row whose text matches an
earlier row's (normalised) is dropped. The import is `read` when every photo has been tried and
at least one was read; a photo that failed is counted on the import and shown in the review
("one photo could not be read"). It is `failed` only when none was read. The request takes an
array of photos alongside today's single one, so the change is additive (no `API_LEVEL`
change). No prompt changes, so no eval changes.

### D10. The wizard

**New** on home opens a wizard, each step its own screen:

1. **Kind:** שיעורי בית or בוחן.
2. **Photos:** take or pick several, shown as thumbnails; nothing is read yet. Next (or skip).
3. **Review:** the photos are read as one import (D9); the student unticks rows and changes
   senses as in phase 26's review.
4. **Type more:** the lookup, one word at a time, collected in a list. Next (or skip).
5. **Due date:** a scrollable list of the next 60 days (no native date module). **Done.**

Nothing is saved until Done. The import holds its rows on the server as today; the typed words
are held by the app. Done sends one request — kind, due date, import id, typed gloss ids —
which saves the import's ticked rows and the typed words, creates the target with them and
logs `created`, in one transaction. Cancelling the wizard discards its import (phase 26's
discard). A wizard closed without cancelling — the app killed — leaves an unsaved import in the
photo-import list, where it is saved or discarded as any other; phase 26 has no automatic
cleanup, and this phase adds none.

### D11. Home and the target screen

Home lists the active targets, nearest `due_on` first: kind, "in N days", and "N of M ready"
(D4) — Victor: "it's an important motivator". Below them, **New**.

A target's screen shows its kind and date, and its words, each with its readiness in D4's words
and a remove button. Its actions: **add photos** (steps 2–3 of the wizard), **add a word** (step
4), **change the date** (step 5), **end** (with a confirmation). Additions go through one
endpoint that saves and joins in one transaction, so the existing save endpoints do not change.

### D12. The session in stock

Phase 43 prepares the next session ahead. Two cases would let it ignore a target:

- **A target changes.** Creating, ending, adding or removing words, or moving the date retires
  the enrollment's unstarted stocked session and requests a new one, in the same transaction.
- **A session prepared on an earlier day** (phase 43 R5 plays it as is). At start, if it was
  chosen on an earlier learner day and today's split (D6) differs from its `session_targets`,
  it is retired and a new one is built; the student waits for preparation once. This happens
  only on a day a split changes — a few times per target — and the exclusive day before a בוחן
  is one of them. With no active target and no recorded split, R5 holds unchanged.

### D13. The wire

New endpoints, all under the enrollment, in the OpenAPI contract (ADR 0003): list targets (with
ready counts), read one (words and readiness), create (D10's request), add words (photo import
id and/or gloss ids), remove a word, change the date, end. Photo import creation takes several
photos. Every change is additive: no `API_LEVEL` change.

---

## 2. Testing

**The day simulation** (`domain/day.test.ts`, phase 37's learner who misses one card in five,
six sessions a day), one scenario per row, checked day by day:

1. בוחן in 14 days, 20 words: all met before the last day; target-only until all ready; then
   5 of 10; 10 of 10 on the last two days; the day before, the בוחן alone; nothing after the
   date.
2. Homework, the same list and date: 3 of 10 once ready; 7 on the last day.
3. בוחן in 4 days: every session target-only; all met before the last day.
4. Homework and a בוחן overlapping: the proportional split, then the בוחן's exclusive day.
5. The date moved later, and words added, mid-run: the rest re-paced.
6. In every scenario: no family twice in a session, one speaking card per session when the
   device records, and the main path's due words asked after the date.

The simulation reports the share of target words ready on the due date. Its pass threshold is
set from the first honest run and never lowered to let a change pass.

**Unit:** the wish, the split, pacing and readiness, each pure. The existing `chooseWords` tests
run unchanged (no target: one run of 10).

**Integration:** creating a target from an import and typed words in one Done; several active;
moving the date; removing a word; unsaving removes from targets; `target_events` and
`session_targets` written; the unstarted stock retired on a change; yesterday's stock rebuilt
when the split changed, and played when it did not; a several-photo import merging duplicates
and counting a failed photo (MockServer for the reading call).

**App:** unit tests for the wizard's state; an e2e walk: New → בוחן → a photo → review → a typed
word → a date → Done; home shows the target; its screen removes a word and moves the date.

**Left for Victor:** the camera step with several photos on his Android phone.

## Risks

- **Readiness may arrive late or never for long lists.** Every live skill counts, speaking
  included, and spoken memory grows slowly. The simulation's ready share on the due date is the
  measure; the thresholds are the knob.
- **An exam-heavy week starves the main path**, by design. Due reviews wait and come back after
  the date; the simulation's row 6 checks they do.
- **A retired stock wastes its preparation calls.** Target changes are rare next to sessions.
- **Readiness depends on the live skills of the newest session.** A student who switches devices
  can see a word's readiness move without practising.
