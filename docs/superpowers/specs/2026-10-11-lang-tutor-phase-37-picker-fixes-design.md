# Phase 37 — Picker fixes: same-day recall, new words every session, speaking

- **Status:** Designed on 2026-10-11. Victor scoped it in the one-pager, then said "go till PR":
  the design questions the one-pager parked are answered here with recommendations, and the
  design is self-approved (CLAUDE.md, *Continue till PR*).
- **Date:** 2026-10-11
- **Source:** `drafts/2026-10-11-picker-fixes-one-pager.md` (scope), the analysis of lane 0's
  sessions of 2026-10-11, and a load simulation of a prototype of this design (D5). `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 35 (PR #132): word choice (its D5), card choice (D6), the constants (D7),
  and the bots' numbers (c) and (d) (D21).
- **Touches:** pure domain (`today.ts` new; `choose.ts`, `plan.ts`, `chooseConstants.ts`), two
  repo queries, `createNextSession` and the prepare job, one defaulted field in the job payload,
  the bots' analysis, and the e2e specs that run a second list session in a day. No migration, no
  wire change, no new secret.

---

## Goal

On 2026-10-11 Victor did nine list sessions. The seven afternoon ones, inside fifteen minutes,
gave only recognition cards and two new words while 44 waited. No session had a speaking card,
and sessions were refilled with words already answered right that day. Phase 35's picker has
four causes:

- **Recall waits for level 3** in the tested skill, which needs a step one day after the step to
  level 2. A word met today is never recalled today.
- **New words were blocked by the per-skill limit.** A new word tests reading (WR), and the limit
  of four picks per skill was filled by due WR words first. A word the limit held back was
  retried only after the words asked today.
- **Speaking was almost never chosen.** It came only through EXPAND: a word with nothing due
  whose four other skills are all tested.
- **Words asked today filled sessions** before the words a limit had held back.

After this phase:
- A word met or missed comes back later the same day as a recall card until answered right.
- Every session brings a new word while the daily limit allows.
- A session has a speaking card when the device records.
- A word answered right today comes back only when nothing else is left.
- The least-known words still come first.

**Done means**, Victor's five outcomes over a day of several sessions:

1. Every session brings new words, within the daily limit.
2. A word met early in the day is recalled later that day.
3. A word answered wrong returns later that day.
4. Speaking cards come up regularly when the device records.
5. No word answered right today returns as filler.

Two unit tests check them by running whole days through the real choosing, card, grading, memory
and level code (D9):
- lane 0's 2026-10-11 replayed for its nine sessions;
- the same list over twenty sessions.

`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In**, from the one-pager:
- recall as soon as a word is ready, the same day included (D2);
- new and missed words return the same day as recall cards until answered right (D1);
- new words every session, under a daily limit that counts new words only (D3, D5);
- speaking gets its cards (D4);
- least-known words first (D3);
- the bots' weekly numbers follow the new rules (D8).

**Out**, from the one-pager:
- card and judging problems (rare-meaning prompts are phase 34's);
- meanings of one word arriving together;
- the level rule and badges, unchanged;
- new card types;
- learner settings, the daily limit included;
- showing the schedule;
- fitting the memory model to this app's answers;
- the bots themselves: only two of their numbers are recomputed.

**The one-pager's open question.** "Least known" means forgotten soonest: the lowest predicted
recall (R) of the word's weakest skill, not its lowest level. This was the one-pager's assumption.

---

## D1. Same-day returns

`apps/server/src/domain/today.ts`, pure: `dayState(answers, introduced)`.
- `answers` holds today's answers in answer order. These are the answers in sessions counting for
  the learner's day (phase 35 D10), each with its gloss, its session, the card type and the
  verdict.
- `introduced` holds the glosses first answered while saved today. This is phase 35's "new today",
  now as ids.

Each gloss answered today is read through its answers in order:
- **Met today.** At its first answer today, a gloss introduced today owes a return in written
  receptive (WR), opened in that session.
- **A return.** An answer in a later session than the one that opened the owed return counts as
  one return. If it grades the owed dimension Good or Hard (phase 35 D3), the return is settled.
- **A miss.** An answer that grades any dimension Again opens an owed return in that dimension,
  in that session, replacing any return still open. Within one answer, the settling is read
  first: a typed translation with one letter wrong settles a WR return and opens one in spelling.

After its last answer, a gloss is a **return** for the next session (`STEP` in code) when it
still owes a return and has made fewer than `RETURNS_PER_DAY` (3) returns today. It is tested in
the owed dimension, and returns are ordered by when theirs opened. Every other gloss answered
today is **done** for the day.

A session is only created once the previous one has ended (phase 19), so every answer `dayState`
reads is from an earlier session than the one being chosen.

**Why.** Retrieving a word again after feedback is what makes it last. Karpicke & Roediger (2008)
found that dropping an item from testing after one correct recall cost most of the benefit. The
gap between retrievals matters, not its pattern (Karpicke & Bauernschmidt 2011). So a return
comes in a later session and is asked last (D6), the session-sized cousin of Anki's learning
steps.

One correct return ends it, as Victor put it: "until answered right". Rawson & Dunlosky (2011)
recommend three correct recalls in the first round. Raising this criterion is a later tuning,
not part of this phase.

Three returns a day bound a word that keeps failing. The memory model brings it back the next
day, because an Again leaves stability under a day.

## D2. Recall decided by memory

A pick is **recall** (rung 2) when it is a return, or when its dimension has memory with
R ≥ `RUNG_R` (0.75). Otherwise it is **recognition** (rung 1): a dimension's first card, or a
word half forgotten. The level no longer decides.

A word met in the morning has WR memory with R = 1 for the rest of the day, so the afternoon
recalls it. Phase 35 waited for level 3. Recognition before recall in each skill follows Laufer &
Goldstein (2004).

Two things are unchanged:
- **The level rule's caps.** Capped evidence still caps a level, whatever the rung.
- **Read aloud.** It is offered while the speaking skill (SK) is below level 2, and it writes no
  memory. SK stays without memory until a say-the-translation card. Once SK reaches level 2, the
  next SK card falls back from read aloud to say the translation (phase 35 D6).

## D3. Choosing the words

`chooseWords` keeps phase 35's inputs, except that `steps` and `done` from D1 replace
`askedToday`.

| Class | What it is | Dimension tested |
|---|---|---|
| `STEP` | a return owed (D1) | the owed one, at rung 2 |
| `NEW` | no memory | WR |
| `DUE` | the weakest live dimension with memory has R ≤ `R_TARGET` | that one |
| `EXPAND` | nothing due, and a live dimension untested | the first untested in ORDER |
| `NOT_DUE` | everything tested, nothing due | the weakest |
| `DONE` | answered today, no return owed (D1) | as the classes above would choose |
| `SPEAK` | the speaking pick when it moves a gloss to SK (D4, tiers 3 and 4); tiers 1 and 2 keep their class | SK |

A return whose dimension is not live this session, because the device changed, waits for a later
session.

```
N        = min(10, distinct keys)
newLeft  = max(0, DAY_NEW_CAP − newToday)
speak    = SPEAKING_PER_SESSION when speaking is live and N ≥ 2, else 0
room     = N − speak − |STEP| − |DUE|
reserve  = min(|NEW|, newLeft, clamp(room, NEW_FLOOR, NEW_PER_SESSION))

1. NEW, newest saved first, up to reserve
2. the speaking pick (D4)
3. STEP, earliest opened first
4. DUE, least known first
5. EXPAND, least known first, while its dimension has fewer than PER_DIMENSION_CAP picks
6. more NEW, up to newLeft
7. NOT_DUE, least known first
8. what pass 5's dimension cap and the hard cap held back
9. DONE, least known first
10. only while the session is still empty: NEW past the daily limit
```

`|STEP|` and `|DUE|` count this session's candidates in those classes. Every pass takes each gloss
at most once, and one gloss per normalised key (phase 31 D18). `HARD_CAP` still applies to passes
3–7: a pick whose best card has an expected success below 0.6. "Least known first" sorts by the
lowest R of the weakest live dimension with memory, as phase 35 did.

What changed, and why:
- **The new-word reserve comes first and depends on load.** With a backlog of due words, a
  session still brings `NEW_FLOOR` (1) new word. With room, it brings up to `NEW_PER_SESSION` (3).
  Each new word now also returns the same day. A fixed reserve of three outgrows a learner who
  does one to three sessions a day (D5).
- **The per-skill limit holds back only expansions**, the flood it was for: a device newly able to
  listen, with every word's spoken skill untested. New words, returns and due words are never
  held back by it. So a less-known word is never pushed behind a better-known one.
- **`DONE` comes after everything else.** A word answered right today is asked again only when no
  other word can be. On a heavy day, that means extra practice of the day's words, often in a
  skill they have not been tested in.
- **Ruling 15's last resort** (new words past the daily limit) now only fills a session that would
  otherwise be empty.

## D4. The speaking pick

When speaking is live and N ≥ 2, one pick tests SK if any gloss qualifies. It is the first of:
1. a return in SK, earliest first;
2. a `DUE` gloss whose weakest dimension is SK, least known first;
3. a gloss with memory that is not due and has no SK memory, least known first;
4. a `DUE` gloss with no SK memory, best known first, so the most urgent reviews keep their
   place.

Its card follows phase 35 D6: read aloud while SK is below level 2, else say the translation. The
picker does not see forms, so a form of five or more words, which cannot be said, falls back to
multiple choice as it does today.

**Why.** Speaking used to come only through EXPAND, after four other skills, and only on a day
when nothing was due. None of lane 0's 76 practised words had SK memory, and none was ever picked
for it.

## D5. The numbers

`chooseConstants.ts`:

| Constant | Value | Change |
|---|---|---|
| `NEW_FLOOR` | 1 | new here; phase 35 held a private floor of 2 in `choose.ts` |
| `NEW_PER_SESSION` | 3 | unchanged: the reserve when there is room |
| `DAY_NEW_CAP` | 15 | unchanged value, now checked against review load |
| `RETURNS_PER_DAY` | 3 | new |
| `SPEAKING_PER_SESSION` | 1 | new |
| `PER_DIMENSION_CAP` | 4 | now limits expansions only |
| `RUNG_R` | 0.75 | now read with memory, not level |

**The load simulation.** A prototype of D1–D4 ran with the real card, grading, memory and level
code for 60 days. It started with 150 saved words and saved four more each day. The learner
recalled by the memory model, with a per-word difficulty.

| Sessions a day | New-word reserve | Overdue words on day 60 | Mean recall |
|---|---|---|---|
| 1 | fixed 3 | 141 | 0.82 |
| 1 | floor 1, as chosen | 15 | 0.95 |
| 3 | fixed 3 | 244 | 0.87 |
| 3 | floor 2 | 284 | 0.85 |
| 3 | floor 1, as chosen | 31 | 0.94 |
| 8 or 20 | any of these | 24–58 | 0.95–0.99 |

Each new word costs about ten cards over its first weeks. That matches Anki's rule of thumb:
daily reviews settle near ten times the new cards a day. A reserve that ignores the backlog adds
words faster than one to three sessions a day can keep.

The daily limit only binds on a heavy day with many unpractised words. The test was two days of
20 sessions, then 2 sessions a day:

| Daily limit | Overdue words at peak | Lowest mean recall |
|---|---|---|
| 10 | 21 | 0.89 |
| 15 | 26 | 0.89 |
| 20 | 37 | 0.87 |

The limit stays at 15. At two sessions a day, a heavy day's words are absorbed in about two weeks.

## D6. Card order

The returns are asked after every other card in the session. Each group keeps phase 35's order:
- highest p first;
- no type twice in a row where that can be avoided;
- the board placed by its p.

The first return also avoids the type of the card just before it. So a return is at least the
rest of the session away from the previous answer (D1).

`PlanPick` gains `step`. The job payload's pick gains `step`, which defaults to `false` for a job
enqueued before the deploy.

## D7. Reading today

- `findAnswersOn(enrollmentId, day)` replaces `findGlossesAnsweredOn`. It returns every answer in
  a session counting for `day`, or still open, in answer order. Each is decoded as
  `findSessionEvidence` decodes a session's answers.
- `findIntroducedOn(enrollmentId, day)` replaces `countNewOn`. It applies the same rule but
  returns the gloss ids instead of their count.
- `createNextSession` reads both, calls `dayState`, and passes the returns and the done set to
  `chooseWords`.

No migration is needed: the answers table already holds everything D1 reads.

## D8. The bots' numbers

Two of the five weekly numbers re-run the picker's rules (phase 35 D21), so they follow the new
ones. The bots themselves do not change.

- **(c) Intervals grow.** Only a word's first review in each dimension on each day counts. A
  same-day return is learning, not an interval. Without this, every new word would add a 0-day
  gap.
- **(d) Difficulty fits.** It becomes the share of cards whose rung disagrees with D2: recall for
  a return or for memory at R ≥ `RUNG_R`, recognition otherwise. `serverView` replays D1 for each
  simulated day by importing `dayState`, so it knows each return and its dimension. It already
  imports the rung table and the constants.

The bots have not started, because phase 35's rollout is Victor's, so no week of history changes
meaning.

## D9. Testing

**Unit.**
- **`today.ts`:**
  - a word met today owes WR;
  - a Good or Hard in a later session settles it, and one in the same session does not;
  - an Again opens a return in its dimension and replaces an open one;
  - after three returns the word is done;
  - skipped and alternative verdicts settle nothing;
  - returns are ordered by when they opened.
- **`choose.ts`:**
  - the rung by memory;
  - the reserve under a backlog and with room, and the daily limit;
  - the speaking pick's four tiers, and none when N < 2;
  - returns before due words, and only when their dimension is live;
  - the per-skill limit on expansions only;
  - `DONE` after what a limit held back;
  - new words past the daily limit only in an empty session.
- **`plan.ts`:** returns last, and the type rule across the boundary.
- **The day tests** (`domain/day.test.ts`). A day runner wires `dayState`, `chooseWords`,
  `planCards`, `applySession` and `evaluateSession`. A fixed learner answers: every fifth card is
  wrong, and a read aloud is understood.
  - It runs twice. First on lane 0's list at the start of 2026-10-11 for that day's nine
    sessions, then on the same list for twenty.
  - The list is an anonymised fixture, `domain/day.fixture.ts`. Ids and keys are replaced; keys
    that were equal stay equal. Memory and levels are rebuilt by replaying every earlier session
    through phase 35's rules.
  - Each run asserts the five outcomes:
    1. While the limit allows, every session has a `NEW` pick.
    2. Every word met before the last session has a rung-2 pick in a later session.
    3. Every miss before the last session is followed by a later pick of that word,
       unless the word has made its `RETURNS_PER_DAY` returns.
    4. Every session without a `DONE` pick has an SK pick.
    5. In a session with a `DONE` pick, the other picks are exactly what `chooseWords` picks with
       the done words removed.

**Integration.**
- the two repo queries, replacing phase 35's two tests;
- a session created after a miss holds that word as a recall card, with `step` in the job
  payload.

**Bots.**
- (c) with same-day returns;
- (d) with a return, and with memory below level 3;
- `serverView` puts a return on its owed dimension.

**e2e.**
- Specs that run a second list session in a day now meet returns.
- `speaking.spec` reseeds its second session so that its read aloud and say-the-translation
  cards still come out under D2.
- `e2e/tests/support/memory.ts` documents the new rung bands.

## Left for Victor

Nothing beyond merging and releasing. Phase 35's own rollout steps are unchanged.

## Risks

- **More recall means more misses.** In the simulation the share right falls to 0.85–0.88.
  Returns absorb the misses. The bots' share right will show whether `RUNG_R` needs to rise.
- **Same-day R is 1**, so a return's expected success reads as 1. Returns are ordered last and
  never count toward `HARD_CAP`, so the overestimate decides nothing else.
- **Light learners get one new word a session while a backlog lasts.** That is the intent of D5.
  If it feels slow, `NEW_FLOOR` is the knob.
- **Phase 34 is in flight** and changes question generation, not the picker. If it lands first,
  master is merged in before the PR.
