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

Grades and readiness are the existing rules: read aloud grades nothing, a pick card grades writing
Hard when right, the produce card as usual; before the eve only a skill's first answer of the day
counts.

### D3. Where step-downs go

Every target session (owed, practice more, past the budget, the last review) asks the open
step-downs first, oldest miss first, **at most 3 a session** (`STEP_DOWNS_PER_SESSION`, *my call*).
They are on top of `SESSION_LENGTH`: the session grows. A step-down is one of the word's two picks a
session and asks S, so S leaves the word's owed skills. Ruling T3-m reads owed work only: a session
whose owed work the session in flight covers, holding nothing but step-downs, is filled with
practice more. The budget's play-forward has no answers, so the day's count of sessions does not
change.

### D4. At most 4 of a type a session

`MAX_PER_TYPE` (4) applies to target sessions too.

- **The picker** gives speaking and spelling at most 4 picks a session each (step-downs included),
  since each has one card at its rung. A word whose chosen skill is full takes its next skill in its
  own order (owed, then the counted or open order), else waits for the next session.
- **`planCards`** spreads writing over its recall types under the cap. When every eligible type of
  the pick's rung is full it keeps the best of them rather than falling to the other rung or to
  multiple choice (T3-l).

### D5. A matching board in homework

A target session with at least 4 met words whose forms and meanings differ (`boardPicks`) gets one
matching board of 4 of them, as an **extra card** *(my call)*: step-down words first, then the
session's other words in the order picked. A word on the board keeps its other cards; a ladder's
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

## Left to the builder

The exact merge order of step-down cards among the other cards; the names; how the in-flight
answered flag is read.

## Left for Victor

Release; `npm run db:migrate` on lane 0 (migration 0048); a session on the Android phone with a
missed word.
