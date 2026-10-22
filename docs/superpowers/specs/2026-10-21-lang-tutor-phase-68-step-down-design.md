# Phase 68: homework steps down after a miss, and asks every card type

Status: approved by Victor in chat on 2026-10-21 ("All good. Continue till PR"); the calls marked
*(my call)* were made under "continue till PR".

## Why

Victor's homework sessions on 2026-10-21 (lane 0, enrollment `fabb8b81`, targets `cb204ee1` and
`f3ac1e97`):

- **Five card types.** After a word's first session, 225 target cards were say translation 89,
  typed translation 52, dictation 40, typed gap 28 and sentence 16. Multiple choice, reverse
  choice, letter tiles, read aloud, choose-the-gap, listen choice, typed meaning and matching:
  none. Sessions such as `a29dba3f` were 9 of 10 say translation.
- **The same hard card after a miss.** *domani* was asked its typed translation and missed 8
  times in a row, *potere* 6, *volere* its typed gap 6, *cattivo* gave up its say translation
  3 times. Each "wrong" was the right word typed after opening help, which phase 63 counts as a
  miss: the misses are real.
- **Matching never.** 0 boards in 86 homework sessions; My words had 18.

Root causes: phase 67 D2 fixed every target card's rung (`targetPicker.ts` `rungOf`: writing and
speaking recall, spelling dictation), where phase 57 stepped a skill at 0 back to recognition; phase
57 ruling T3-l exempts target sessions from `MAX_PER_TYPE`; a board is made only of multiple-choice
picks, which a target never makes (it practises writing, spelling and speaking), and a ladder's
multiple choice never goes on one (phase 54 D3).

Victor: "I would add 3 cards in the next session: 1. Say 'domani' 2. multi-choice with 'domani' 3.
Translate from hebrew. This way, I would probably have 100% success and good feeling." Then: "I am
not 100% sure we should use exactly the cards I suggested. Think and propose general approach";
the general approach below was his "All good". On rewards: "We already have rules how we reward
right answers toward readiness, why not keep the rules?" The type limit is per session, as on My
words; matching comes back in homework.

## Goals, non-goals, anti-goals

- **Goals.** A missed word gets easier before it gets hard again, and leaves the session answered
  right. Homework shows read aloud, reverse choice, choose-the-gap, letter tiles and matching again,
  and no session is mostly one type.
- **Non-goals.** My words (the main path) is unchanged. The reward rules are unchanged
  (`gradesFor`, `applyReadiness`). No new card type, no app change, no API change.
- **Anti-goals.** A miss must not push other words' cards to another session: sessions grow
  instead. A pick must never fall back to a card that serves none of its owed skill (T3-l's
  guarantee stays).

## Design

### D1. A step-down is owed

Per target word and practised skill S (phase 67 D2: writing, spelling where the device listens,
speaking), the word **owes a step-down on S** when, on the target's path, its latest answer to a
card serving S (`servedSkill`) was a **miss** and no right answer to **S's produce card** came after
it.

- **A miss**: a wrong choice, or a typed or spoken answer judged wrong or given up. Help folds into
  wrong (phase 63, decoded), and a tapped list word is a wrong sentence card (phase 59). A near
  miss, an alternative, a skip and an intro card are not misses.
- **S's produce card**: writing, typed translation, gap or sentence; spelling, dictation;
  speaking, say translation (also when answered by typing). These are the cards the picker asks at
  S's rung (`cardOf`).
- **Right**: exact, near miss or understood; a right choice.
- **Any day** *(my call)*: a word missed at night steps down in the next morning's first session.
- **The session in flight**: its answered cards are real answers; its unanswered cards count as
  answered right (the picker's in-flight credit), so a stock never repeats a step-down the session
  in flight is about to finish.

Pure, in `domain/stepDown.ts`; the open step-downs are ordered by their miss, oldest first.

### D2. See it, pick it, produce it

A step-down on S is asked as up to three cards of the word, each giving less than the one before,
spread through the session like a new word's ladder (other cards between them):

1. **See it.** Read aloud: the word is shown and said. Only when the session can speak and the
   word can be said; otherwise skipped. It ignores read aloud's level limit.
2. **Pick it.** The word among options or tiles, in the direction of the miss (from the learner's
   language). Writing and speaking: reverse choice, choose-the-gap (its sentence has a gap) or
   letter tiles (tiles fit), the one least used in the session, ties in that order. Spelling:
   letter tiles, else reverse choice. Plain multiple choice is not used: it practises the other
   direction.
3. **Produce it.** S's own card: writing, a recall card as `planCards` chooses (D4's cap);
   spelling, dictation; speaking, say translation.

**Grades (ruling R1, built).** The see and pick cards are intro cards, as a new word's first
cards are (phase 55): encoding, not evidence, so they grade nothing (no memory, no readiness, no
level). The produce card is evidence only when it is the session's own card (D3, `counts`);
otherwise the whole step-down is practice and grades nothing (`practice`). An intro miss opens no
step-down; a right produce card, intro or not, closes it. Why: graded by the existing rules, as
first drafted, the simulation's card overstated what the learner knew. The exam missed cold on its
last days read 91 on its date (master 79; phase 65's anti-goal says below 90). The FSRS ready share
on the date fell (0.66 → 0.54, 0.41 → 0.36) while the card rose. Two reasons: the easy pick card
became a skill's counted first answer of the day, and on the eve every right earned the bonus.

### D3. Where step-downs go

Every target session (owed, practice more, past the budget, the last review) asks the open
step-downs, oldest miss first, **at most 3 a session** (`STEP_DOWNS_PER_SESSION`, *my call*) and
**one a word** (two would see and pick it twice; final review). They are chosen **after** the
session's own cards, which they leave as they are (ruling R2, built):

- When the session asks the word on that skill at its rung, that card becomes the step-down's last,
  after the easier ones, and counts as it would have (`counts`).
- Otherwise the step-down is asked on top, outside `SESSION_LENGTH`, as practice (`practice`): the
  session grows.

Ruling T3-m reads owed work only: a session whose owed work the session in flight covers, holding
nothing but practice step-downs, is filled with practice more. The budget's play-forward has no
answers, so the day's count of sessions does not change. (First drafted, a step-down took one of
the word's two picks; in the simulation that displaced the word's counting card and the eve-only
homework took 12 sessions instead of 11.)

### D4. At most 4 of a type a session

`MAX_PER_TYPE` (4) holds a target session **none of whose cards can raise the card today**
(ruling R3, built): practice more and past-budget fill on words whose weakest counted skill is
already answered today, before the eve, and the due date's last review. Victor's 8–9-say sessions
on 2026-10-21 were exactly these (11 sessions, one readiness event).

- **Past 4 say cards**, a word's card is a read aloud (the word seen and said, which grades
  nothing). Any other full card passes to the word's next skill whose answer counts nothing today
  either; with none, it keeps its card.
- **Owed cards and cards that can raise the card are never capped.** Every wider cap tried moved the
  day simulation's "can raise" mark below master's: the fixed learner's misses land on other cards,
  and a read aloud is a free card there.
- **`planCards`** needs no cap: a target pick's R is 1, so writing's three recall types have equal
  chances and its least-used tie-break already spreads them.

### D5. A matching board in homework

A target session **none of whose cards can raise the card today** (ruling R4, built: the picker's
`boardsSession`, carried to `planCards` as `board`) with at least 4 met words whose forms and
meanings differ (`boardPicks`) gets one matching board of 4 of them, as an **extra card** *(my
call)*: step-down words first, then the session's other words in the order picked. On every target
session it broke phase 57's anti-goal 1 (a card serving no owed work while work is owed) and lowered
the 14-day exam's FSRS share 0.57 → 0.52. A word on the board keeps its other cards; a ladder's
word is never on it (phase 54 D3). It counts nothing toward readiness (matching grades written
receptive, which no kind counts) and opens no step-down (it serves no practised skill).

### D6. The next session holds the step-down

A stock is chosen when its session in flight starts, before that session's misses.

- `session_targets` records the stock's step-downs (`step_downs text[]`, `glossId|dimension`,
  sorted; null on older rows, read as none).
- A miss on a target path asks the stock job again (reason `miss`). Under the path's lock, the job
  replaces an unstarted list stock whose recorded step-downs differ from today's choice (retired as
  `stale_target`, as phase 53's replacement); one that matches is kept.
- `stockServes` (the serve-time check) compares step-downs too.

Ruling (2026-10-22, Victor): a miss keeps the next session. On lane 0 the replacement made the
learner wait between homework sessions: after the deploy, 6 of 7 homework completions waited
16–57 s for the next session, against 1 of 31 (28 s) the day before, because a miss in a session's
last minute retired a stock already prepared, and preparing its replacement takes 40–80 s. 15 of
the 17 stale retirements came from the miss-asked stock job. Now a miss asks for no stock, the stock
job and `stockServes` no longer compare step-downs, and a step-down missed in session N is asked by
the stock chosen when N+1 starts (it stays open until a right answer to the skill's produce card,
so waiting a session loses nothing). `session_targets.step_downs` still records what each stock
asks. The stock reason `miss` stays parseable for a job queued before the deploy.

## What the simulation says (one-off, uncommitted)

`day.test.ts` does not simulate step-downs. Fed step-downs, the session-end restock, relearn picks
and the board for one run, the built design holds every learner-outcome mark: FSRS share on the date
0.66 / 0.95 / 0.93 / 0.64 / 0.40 (master 0.66 / 0.93 / 0.93 / 0.68 / 0.41); the cold-missed exam 83
(< 90); the crammed second day 75.2 (≤ 77); sessions at most master's. One 67b measure dips: of
homework practice-more sessions flagged "can raise", 91/101 rose (pass 0.91, master 103/113); over
learners missing every 4th to 8th card, 0.911 against master's 0.927.

## Left to the builder

The exact merge order of step-down cards among the other cards; the names; how the in-flight
answered flag is read.

## Left for Victor

Release; `npm run db:migrate` on lane 0 (migration 0048); a session on the Android phone with a
missed word.
