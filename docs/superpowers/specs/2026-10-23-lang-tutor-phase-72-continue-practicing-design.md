# Phase 72 — Continue practising from a target session's results

- **Status:** Scoped with Victor on 2026-10-23 (one-pager), then "go till PR": the design is
  self-approved (CLAUDE.md, *Continue till PR*). Lines marked **(Victor)** are his answers; lines
  marked **(my call)** are Claude's.
- **Date:** 2026-10-23
- **Source:** `drafts/2026-10-23-continue-target-sessions-one-pager.md` (gitignored; restated here).
- **Builds on:** phase 57 (a target's path and card), 65 / 65b (today as a budget, the "practice
  more" sheet), 67b (the card's lines), 71 (the eve), ADR 0014 (each path keeps its own stocked
  next session).

## Why

A learner practising for homework or a test finishes a session, and the results screen's only
way on is home: "לתרגול הבא" and "סיום" both go back to it, where they find the target's card and
tap it again. Victor: it should be **very smooth: show the progress and how much is left for
today, and "Continue practicing" goes directly to the next session without even going to the home
screen (Victor).**

## Done means (Victor)

1. On the phone: finish a homework/test session, tap the continue button, and land on the next
   session's first question with no home screen in between.
2. The results screen's numbers match the home target card's.
3. No wait: the next session is ready when tapped, with no "preparing" screen. The server already
   stocks a target's next session when the current one starts and keeps it through a miss (ADR
   0014; phase 68's ruling of 2026-10-22, PR #236), so this holds in the normal case; D5 covers the
   rare one where it is not ready yet.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass.

## Goals, non-goals, anti-goals

- **In (Victor):** the results screen of a target session shows what the home card shows (readiness
  and today's line); its continue button starts that target's next session directly; once today is
  done it follows home's rules (it says so, and continuing asks the same "practice more" question
  home asks); on the eve it keeps going while a session can still raise the card.
- **Out (Victor):** what this session changed (words that moved up, grade before and after); the
  main path's (My words) results screen; any change to the home target card; any change to what a
  session holds or how many there are (budget, cards, eve rules).
- **Anti-goals (my call):** the results screen must never get around phase 65b's sheet; it must
  never show a number home would not show for the same read; the stack must not grow (back from
  the next session lands on home, not on an old results screen).

## Design

### D1. A session's read names its target (my call)

`GET /sessions/{id}` (`SessionViewSchema`) gains an optional `target_id`: the target whose path the
session belongs to (`sessions.target_id`), absent for the main path, the seed and a question-types
session. The app keeps it with the session it entered (`useSession`), so the results screen knows
the session's target however the session was entered (home's card, a reminder, a resume after the
app was killed). Additive and optional: no `API_LEVEL` change (ADR 0012); an app reading an older
server sees no field and keeps today's results screen.

Rejected: the app remembering which card it entered from. Every entry point would have to pass the
target along (the reminder start among them), and a later entry point that forgot would silently
fall back to the main path's results.

### D2. The target block on the results screen (Victor: home's numbers; layout my call)

For a session with a `target_id`, the results screen reads the active targets (`useTargets().reload`,
the read home makes) when it opens and finds that target. Under the score it draws a block, white
card like home's, with:

- a title line: the target's kind and countdown, as the card's header says them
  (`strings.targetCountdown`), so a learner with two targets knows which one this was;
- the readiness: `Readiness` from `TargetCard.tsx` (big percent, its bar, today's gain label);
- today's line: `Sessions` from `TargetCard.tsx` (the sessions line and dots, or the eve's word
  bars and words-left count).

The same components on the same read are what make Done-means 2 hold. The practised and missed
lists stay under the block, as they are. Until the read lands the block keeps its space empty and
the continue button is disabled. When the read fails, or the target is not in it (ended or
removed), there is no block and the buttons are today's ("לתרגול הבא" goes home).

The results screen keeps drawing the finished session while the next one loads: entering the next
session replaces the shared session state at once (`enter` installs it synchronously), and the
screen being replaced must not redraw its score and lists from the new, empty state during the
transition. How it holds them is the builder's.

### D3. The continue button does what home's button does (Victor: directly; label my call)

The primary button acts on that target exactly as home's card button does with the same read:
`targetSessionAction` → `targetPress` → enter a started session, or create on the target's path
(which answers the stocked session), with the "practice more" check of D4 in between. The session
is opened by **replacing** the results screen with the session screen, so the stack stays home →
session and back from it reaches home. A fresh session is started (`next.start`) as home starts it.

- **Label:** while today owes work (`today.state === 'owed'`), a new string **"להמשיך לתרגל"**;
  otherwise home's card label for the state (`לתרגל עוד` once today is done or on a rest day,
  `חזרה אחרונה` on the date), so the button says what home's would.
- **Look:** filled when home's is (`targetButtonSolid`), pale otherwise. "סיום" stays under it and
  goes home, as today.
- **testID:** `results-continue`, a new one; the main path's "לתרגול הבא" keeps
  `results-next-session`. The e2e helpers that tap `results-next-session` after a target session
  to get home (`targets.spec.ts` `backHome`, `practice-more.spec.ts` `playAndReturn`) tap
  `results-done` instead.

### D4. Once today is done (Victor: home's rules)

When `askBeforePracticeMore(target, optedOut)` holds (today done, a session adds little, readiness
under 100, the learner has not turned the question off), the press opens the same
`PracticeMoreSheet` home opens, and the tick box saves the same setting. "לתרגל בכל זאת" enters the
session as in D3. "אחזור מחר" goes home (my call: the learner said they are done for today); a tap
outside or Android back only closes the sheet. Today the sheet sends both to `onLater(false)`, so
it gains a separate cancel callback; home wires cancel to what it does now (close, save nothing),
so home is unchanged. On the eve phase 71's `today.state` stays `owed` while a session can still
raise the card, so the button keeps going with no sheet.

### D5. Not ready, failed, ended (my call: as home)

- The stock is still preparing (a very short session ended before its stock was built), or create
  replaced a stale one: the button shows home's preparing look, disabled, and the results screen
  reads the targets again every `POLL_INTERVAL_MS` while it does, only while focused. When the
  session is ready the button is pressable again; the app does not enter it on its own.
- A failed preparation: home's failed note and retry label, which goes through create again.
- Create refused with `session_open`: the path's started session, read again, is entered (home's
  final review N1). `target closed`: home. `not enough questions`: home's alert.

### D6. One code path for home and results (my call)

The target-press logic now in `LearningSection` (`practiceTarget`, `startTarget`, `answerAsk` and
the sheet's state) moves into one hook both screens use, which takes how to open the session screen
(home pushes it, results replaces). Home's behaviour does not change; the reminder start keeps its
own flow.

### D7. Everything else is unchanged

The main path, the seed and a question-types session have no `target_id`: their results screen is
exactly today's. The home card, the server's stocking and the sessions' content do not change.

## Testing

- **Server:** the session read carries `target_id` for a target path's session and none for the
  main path's (route and service tests; an integration test on the repo read if the column is read
  there). The auth matrix needs no new fixture: no new route.
- **Mobile unit:** the pure parts (the button's label and look per `today.state`, which block shows
  for which read) in the style of `targets.test.ts`.
- **e2e:** a target session finished → the results screen shows the target block with the
  readiness and today's line the home card shows → the continue button opens the next session's
  first question with home never shown, and back from it reaches home. A day already done with
  `practice_more_little` → the sheet opens from the results screen, and "אחזור מחר" goes home. A
  main path session's results screen is unchanged (its existing specs). On web home stays mounted,
  hidden, under Results, so the reused components' testIDs (`target-readiness-<id>`,
  `target-sessions-<id>`, …) appear twice: the block has a container testID (`results-target`) and
  every new locator is scoped to it.

## Left to the builder

How the results screen holds the finished session's view (D2), the hook's name and shape (D6), the
block's spacing within the clean-and-calm look (white card, one blue), and the e2e fixtures.

## Left for Victor

- Try it on the Android phone: finish a homework session, continue, and back out of the next one.
- Release as usual (the server ships before the app, ADR 0012); no migration.
