# Phase 65 — Readiness as a grade, and today as a budget

- **Status:** Designed with Victor on 2026-10-19, in chat and in mockups. A builder check asked four
  questions, all settled without him and marked "builder check" (D7.1, D7.4, D8, D11). Victor
  approved the document with "go till PR. subagents" (CLAUDE.md, *Continue till PR*).
- **Date:** 2026-10-19
- **Source:**
  - The one-pager: `drafts/2026-10-19-readiness-grade-one-pager.md` (main checkout, gitignored).
  - The evidence: `drafts/2026-10-19-readiness-grade-evidence/` (main checkout): read-only replays of
    Victor's homework target `fe5861d3` on lane 0 through core's `gradesFor` and FSRS, which reproduce
    `gloss_memory` exactly. Every number quoted below comes from them.
  - The brainstorming chat of 2026-10-19 and its mockups, in
    `.superpowers/brainstorm/86053-1792407295/content/` (main checkout):
    - `card-approved.html`: the card through one day. Approved.
    - `practice-more-confirm.html`: the "practice more" sheet. Approved, without the number (R3).
    - Superseded, kept for the record: `grade-on-card.html`, `grade-on-card-v2.html`,
      `today-budget-day.html`, `today-gain.html`.
- **Builds on:**
  - phase 57 (target skills, the cap, the plan, the target picker, readiness D9, home D11, the
    target screen D12), phase 64 (the card, the fuse, the "not ready" line), phase 35 (the FSRS
    memory model), phase 56 (help grades as a miss), phase 59 (a tapped word is a miss), phase 43
    (sessions in stock), phase 39 ("derive, then record")
  - ADR 0001 (layers), 0007 (jobs), 0011 (the gloss), 0012 (`API_LEVEL`), 0013 (the learner day),
    0014 (sessions belong to a path)
- **Replaces:** phase 57 D9's readiness (target skills ÷ 10) and its "ready = 100%", the readiness
  half of D11's card and D12's word rows, and the anti-goal "'Ready' is shown before the date can
  support it". The plan, the cap and the target picker stay (Non-goals).
- **Touches:**
  - core: a pure readiness rule beside `memory.ts`; the target schemas; `API_LEVEL`
  - the server: a readiness memory per target, word and skill, with an event log, written at session
    end and rebuilt by the recompute; `targetDay`'s "done for today"; the session budget, counted by
    playing the unchanged target picker forward; the target view; the day simulation
  - the app: `TargetCard`, the target screen, `targets.ts`, the "practice more" sheet, a setting in
    הגדרות, strings; e2e

Lines marked **(Victor)** are his decisions. Lines marked **(my call)** are Claude's, made in the open
and not yet confirmed. Everything else follows from those or from the code.

---

## Goal

Victor (one-pager): readiness should answer "if I were asked the homework words, what grade would I
get?" Today it answers "how much did I practice according to the plan?" On 2026-10-19, after three
days of mostly correct answers, his 15-word homework (due Thursday 2026-10-22) showed 49.7%: 74 of its
75 target skills sat exactly at the cap for three days left, the most the rules allow. It felt unfair
and demotivating. And memory fades: "even if I answered well yesterday, but forgot today when asked,
it still isn't saved well in my memory."

The same answers, read by this phase's rules, give **83** for the homework (45 → 70 → 83 at the end of
17, 18 and 19 Oct).

**Done means:**

1. Readiness answers "if the teacher checked these words on the due date, what grade would I get",
   out of 100, and the day's first tries decide it: right yesterday but wrong today lowers it.
   **(Victor)**
2. It follows answers, never the calendar: nothing moves it overnight. **(Victor)**
3. It is close to the grade Victor actually gets. He checks this by hand; the starting values below
   are tuned from what he reports, in a later phase. **(Victor)**
4. Replaying the 17–19 Oct homework gives 45, 70 and 83 at the end of those days, not ~25%, ~40% and
   49.7%. (from Victor's "replaying gives a grade that reflects those answers")
5. Right answers later the same day raise readiness, up to a limit: "the main visible motivator".
   **(Victor)**
6. A בוחן drops when a word is forgotten cold and stays close to the real grade; homework rarely
   drops. **(Victor)**
7. The card shows readiness as its big number, with today's gain bright at the end of its bar, and
   today as a count of sessions that never grows during the day. **(Victor)**
8. "לתרגל עוד" after today's sessions asks first, says another session adds little, and can be told
   not to ask again. **(Victor)**
9. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Non-goals

- What a target session asks, the plan, the cap table and target skills (phase 57 D3–D8). They keep
  answering "how much of today's plan is done" and keep driving the picker. The one change to them is
  where "done for today" stops (D7).
- FSRS, `gloss_memory`, levels, "known" and the main path ("My words"). Readiness reads its own copy
  of the memory (D2).
- Entering the real grade in the app. Victor compares by hand (Done 3).
- The בוחן's "write a sentence with the word": no card asks for a sentence of the learner's own
  (D1).
- Tuning the starting values. They are set here and tuned from Victor's real grades later.

## Anti-goals

The phase fails, even if every test passes, if:

- Readiness moves overnight, or a right answer lowers it.
- The count of today's sessions grows during the day.
- A בוחן whose same words are missed cold on every one of its last days still reads 90 or more on its
  date. In the evidence's scenario B, the bonus without the hold put such a list at 96.
- The "practice more" sheet says another session adds little when the session it would start could
  add more (D9).

---

## 1. What readiness is

### D1. The question it answers **(Victor)**

A target's **readiness** is the grade the learner would get if the teacher checked its words on the
due date, out of 100. It is labelled **מוכנות**, never "predicted grade" (Victor: "a more abstract
term"). It counts only what the check asks:

| Kind | The check (Victor) | Skills counted |
|---|---|---|
| homework | given the Hebrew, say and write the Italian correctly | written productive, spelling, spoken productive |
| exam (בוחן) | given the Hebrew, write the Italian correctly and write a sentence with it | written productive, spelling |

- The sentence part of a בוחן is not graded (my call): no card asks the learner to write a sentence
  of their own. Sentence translation and typed gaps already feed written productive and spelling.
- Only live skills count, as today: speaking is dropped for a word that cannot be said, and for a
  learner whose sessions do not record (phase 53 R9, `readTargetDay`).
- A word's **chance** is its counted skills' chances multiplied: a word is right only if every part
  is right, as a teacher marks a line (Victor confirmed "pass or fail as a whole").
- The target's readiness is the mean of its words' chances × 100, rounded down (my call, as phase 57
  R7). It reads as "about 11 of 15 words": the sum of the chances is the words one can expect right.
- A live counted skill never answered has chance 0 (my call), so an unpractised word pulls readiness
  down.

### D2. Its own memory, per target, word and skill (my call)

Readiness reads a copy of the FSRS memory model, kept per target, word and counted skill, because its
rules differ from the main memory's (D3) and its bonus depends on the target's due date. It is fed by
every graded answer about the word in the enrollment — any path, any day, including before the word
joined the target — through core's `gradesFor`, in answer order, each on its session's `practice_day`
(ADR 0013). Readiness is about what the learner remembers, whichever path taught it; target skills,
which count only answers since the word joined, stay as they are for the plan.

"Derive, then record" (phase 39, Victor's standing preference): the rule is pure, its result is
written in the session-end transaction beside the target skills, with an append-only event log (the
skill, before and after chance, the rule that fired, the session), and the recompute
(`db/progressRecompute.ts`) rebuilds both from the answers. A target created, or a word added, builds
its rows by replaying that word's answers (my call).

### D3. How an answer moves a skill

Per target, word and counted skill, with `day` the session's `practice_day` and `due` the target's
date. `R(state, due)` is core's `retrievability`.

1. **The first answer of the day decides** **(Victor: "forgot today when asked → not saved")**. It is
   a long-term FSRS review (`review(state, grade, day)`): a right answer grows the memory, a miss
   lowers it.
2. **A miss counts once a day** (my call, from the replays). A later miss the same day is a same-day
   FSRS review (`review` with t = 0) only if no miss has counted that day; every further miss is
   ignored. Help-and-retry cannot pile up: on 18 Oct, six misses in one evening took *finestra*'s
   writing to stability 0.01.
3. **Later right answers the same day close ¼ of the gap to 100, at most twice a day** **(Victor:
   "increase the readiness based on right answers on the same day with some limit"; ¼ and two are my
   call, chosen with him in the replays)**. Each sets the stability that makes
   `R(state, due) = r + ¼ (1 − r)`, with `r` its value before; the last-review day and difficulty do
   not change. Hard and Good count alike. Constants `READINESS_BONUS_SHARE = 0.25`,
   `READINESS_BONUS_PER_DAY = 2` in `chooseConstants.ts`.
4. **Exam only: a cold miss holds the skill at half** **(Victor: "one that drops when you forget a
   word cold and stays closer to your real grade" for tests)**. When the first answer of a day is a
   miss, the skill's chance counts × ½ until the first answer of a later day is right. Same-day bonuses
   still raise the memory under the hold. Homework has no hold **(Victor: "a grade that rarely drops"
   for homework)**. Constant `READINESS_EXAM_HOLD = 0.5`.
5. **Help is a miss**, and so is a tapped list word (phases 56 and 59), because `gradesFor` reads them
   so; nothing new.
6. **Nothing moves overnight**: the chance is read for the due date, so time passing changes nothing
   until the next answer.
7. **On the due date readiness is final** (my call): it shows the value from the end of the eve.
   FSRS counts whole days, so any review on the date would read as certain (100). Answers on the date
   still feed the main memory and the plan's last review (phase 57 D10).

A skill's chance is `R(state, due)`, × ½ under an exam hold, and 0 with no state.

The evidence shows what each rule does on Victor's answers (`bonus.mts`):

| Rule set | End of 17 Oct | 18 Oct | 19 Oct |
|---|---|---|---|
| Today's app (target skills) | ~25% | ~40% | 49.7% |
| Homework: rules 1–3, 5–6 | 45 | 70 | 83 |
| The same answers as a בוחן: rules 1–6, write and spell | 54 | 56 | 77 |

As a בוחן, 18 Oct's cold misses drop it 60 → 47 in one session. Victor chose that drop for tests.

### D4. A word is ready at 90 (my call)

A word is **ready** (מוכנה) when its chance is at least 90 (`READINESS_WORD_READY = 90`). `ready_count`
counts those words. It drives phase 64's "not ready" line ("…ו-3 מילים עוד לא מוכנות"), the green
"כל המילים מוכנות" line, and phase 57 R9's outlined card on the date (every word ready, where it was
100%).

---

## 2. What the card and screen show

### D5. The target card **(Victor: C1, with the bar C, without "עד אתמול")**

`card-approved.html`. The header, the fuse, the "not ready" line and the button stay as phase 64 made
them. Below the header:

- **Readiness is the big number**: "79%" in large type, coloured red → orange → yellow → green as
  readiness is today (`readinessColor`), with "מוכנות" and the kind ("לשיעורי הבית", "לבוחן") beside
  it.
- **A bar under it**: the part up to the start of today pale, today's gain bright at its end, labelled
  "+13% היום". Before any answer today the bar shows only the pale part and no label. A day that ends
  lower (a בוחן's cold miss) shows no bright part, and the label reads "−4% היום" in grey, never red
  (my call).
- **Today, in sessions** (D6, D7): "היום: 3 מתוך 5 תרגולים" and "עוד 2", one dot per session, green
  when done. Before the first session: "היום: 5 תרגולים" and "כ-25 דקות" (my call: from the predicted
  cards, D7.1). When the budget is met: "סיימת להיום ✓"; when it ended early, "4 במקום 5" and the unused
  dot faded. A session past the budget is a blue dot, "+1 בונוס".
- The rest-day and due-date notes stay as phase 57 and 64 wrote them; on the date the big number is
  the final readiness (D3.7).

All Hebrew in the mockups is placeholder wording to finish in the build (UI is Hebrew only, RTL).

### D6. The target screen (my call)

The header repeats the card's lines (it already reuses `targetCardState`). The word groups (נשאר
להיום, סיימת להיום, נוספו היום, בהמשך) stay: they are the plan. Each word's pill shows its chance, in
readiness's colour, and "מוכנה" at 90 or more. Tapping a word opens its counted skills — כתיבה, איות,
דיבור for homework — each a bar out of 100 with its chance, and "חצי עד שתענה נכון מחר" under a
held exam skill. The cap line and the 0–10 values leave the screen.

---

## 3. Today as a budget

### D7. The session budget **(Victor: "I expect 2 more sessions and I am done"; the mechanics are my call)**

Today's line counts sessions, and the count is a promise: it never grows during the day.

1. **Set once, at the start of the path's first session of the learner day.** The count is the
   sessions the target picker itself would make for today's owed work if every answer were right:
   the server plays `chooseTargetPicks` forward over the day's plan, with its limits (two ladders a
   session, two picks a word, one change per skill per session, three speaking cards). To that it
   adds room for misses at the learner's own recent first-try miss rate (Victor's Monday: 4 in 45),
   as whole sessions (my call, builder check: a formula would under-count, and an under-count cannot
   be fixed later because the count never grows). It lives in the server's `domain/`, beside the
   picker it runs. Before the first session the card shows the same count, computed the same way, as
   an offer; the minutes beside it come from the predicted cards (about 30 seconds a card, my call).
2. **Recorded** (derive, then record): the target, the day, the count, and what it was made from, in
   the transaction that starts the session.
3. **Sessions done** are the path's completed sessions on that learner day (`sessions.target_id`,
   `practice_day`, `status = 'completed'`, as `countCompletedOnDay` counts reminders).
4. **Sessions are what the picker makes** (my call, builder check). The picker does not change: a
   session holds the owed work the picker finds, so the day's last sessions can be short, as on
   19 Oct (10, 10, 10, 9, 5, 4, 2, 10 cards). The count is of sessions, whatever their length, and the
   play-forward in rule 1 predicts the short ones too. Filling every session to `SESSION_LENGTH` would
   need new picker rules and would change the cards the day simulation plays; it is not worth that
   here.
5. **Misses fit inside.** A miss makes work owed again (phase 57 D4), and the remaining budgeted
   sessions ask it as the picker does today. What does not fit carries to tomorrow, as phase 57 D6's
   unfinished work already does.
6. **Done for today** is: the budget is met, or no word owes work (whichever comes first). The second
   is "finished early" (D5). This replaces `targetDay`'s "no word owed and answered today" for the
   card's state; the plan's owed words are unchanged and still lead the next session's picks.
7. **Practice past the budget** is phase 57 D7's "practice more" session, asking any work still owed
   first. It is shown as a bonus dot and raises readiness through D3's same-day bonus.
8. **The eve gets no exception** (Victor agreed: "It's ok"). The budget can end a בוחן's eve with
   work still owed. Readiness and phase 64's "not ready" line then say so ("עוד תרגול אחד יעזור"), and
   the D9 sheet does not appear, because the next session asks owed work and can add more.

### D8. Stock (my call, builder check)

Unchanged. Sessions are made ahead as phase 43 and ADR 0014 make them, and `replaceIfStale` re-checks
target stock as it does today. With rule 4 the budget asks nothing new of the stock, so no session
waits on "preparing" (phase 43 Done 1).

### D9. The "practice more" sheet **(Victor)**

`practice-more-confirm.html`. After the budget is met, tapping "לתרגל עוד" opens a sheet over the card
instead of starting the session:

- Title "סיימת את התרגול של היום". Text: another session today raises readiness only a little, and
  tomorrow, after a night, practice helps much more. **No number** **(Victor: "no need to show specific
  numbers")**.
- "אחזור מחר" (the main button, closes the sheet) and "לתרגל בכל זאת" (starts the session).
- A tick box "אל תציג לי את זה שוב". Kept on the device, in AsyncStorage beside the remembered
  enrollment, per user (my call); a switch in הגדרות turns the sheet back on (my call).
- It appears only when the next session could add little (my call, Victor agreed "looks good"): the
  most it could add with every answer right, read from the session the button would start, is under
  2 points (`READINESS_LITTLE = 2`). On a בוחן's eve with bonus still to earn, the sheet does not
  appear. The server says which, on the target's summary.

---

## 4. The wire and the simulation

### D10. The wire (my call)

On `TargetSummarySchema` and `TargetWordSchema` (`packages/core/src/api/schemas.ts`):

- `readiness_pct`: the new readiness (D1). Its meaning changes, so `API_LEVEL` goes from 5 to 6 in
  the same PR (ADR 0012).
- `readiness_start_pct`: readiness at the start of today (the bar's pale part).
- `ready_count`: words at 90 or more (D4), a changed meaning.
- `today`: gains `sessions_budget` (null before it is set, with `sessions_offer` the count shown),
  `sessions_done`, and `ended_early`; `state` keeps its values, with `done` per D7.6.
- `practice_more_little`: whether the sheet appears (D9).
- Per word: `readiness_pct` its chance, and `skills` becomes the counted skills, each
  `{dimension, chance, held}` in place of `{value, cap}`.

`openapi.test.ts` pins the new keys.

### D11. The day simulation

`day.test.ts` keeps every phase 57 measure that reads the plan and target skills (owed work, done
for today, the eve's cap), renamed where they say "readiness" so they read as the plan's. The
simulated learner plays the day's budget, then "practice more" sessions until no word owes work, as
a diligent learner does (my call, builder check): the picker is unchanged (D7.4), so phase 57's gates
(the plan at 100% on the eve, the 2026-10-16 replay, the 3-day exam) keep testing the plan, and the
FSRS marks (`READY_ON_DUE_PASS`) stay as gates, never lowered. Should any of them move, they are
compared on all five phases' aggregates against master's, never on one (phase 54's lesson). New
measures:

- How often the budget alone covered the day's owed work, and on which days it did not (the eve
  first), reported, not gated.

- The 17–19 Oct replay as a fixture (the answers' types, verdicts, help and days, glosses as lemmas):
  readiness 45, 70, 83 as homework at the end of each day; as a בוחן, 54, 56, 77.
- Over every scenario: readiness never moves between days without an answer, never drops after a
  right answer, and the day's session count never grows.
- The anti-goal scenario: a בוחן whose same skills are missed cold on each of its last two days reads
  below 90 on its date.
- Readiness on the due date beside the FSRS share, reported, not gated: the yardstick for tuning.

---

## 5. Testing

- **Core, pure:** D3's rules one by one (first try, one miss a day, the bonus and its limit, the hold
  and its lifting, the frozen due date), D1's word and target arithmetic, D4's ready count.
- **Server domain, pure:** D7's count, by playing the picker forward (new words over several sessions,
  a skill that needs two sessions to reach its cap, the miss room).
- **Server unit:** the session-end write of readiness rows and events beside target skills; the
  budget set at the first session and never raised; "done for today" by budget and by no work;
  `practice_more_little`.
- **Integration:** the session-end transaction writes readiness and its log; the recompute rebuilds
  them identically; a word added to a target replays its history; the wire's new fields.
- **App:** `targets.ts` (card state, the bar's parts, dots, the sheet's rule), the setting.
- **e2e:** the card shows the big readiness, the bar and the dots; "לתרגל עוד" after the budget opens
  the sheet, "לתרגל בכל זאת" starts a session, the tick box stops the sheet, הגדרות brings it back;
  every spec that checks readiness labels (`targets.spec.ts`, `photo-import.spec.ts`).

## Constraints

- ADRs: 0001 (the readiness rule is pure domain; the write is in the session-end service's
  transaction), 0007 (stock), 0010 (one migration), 0011 (the gloss is the unit), 0012 (`API_LEVEL`
  to 6), 0013 (`practice_day` is the day), 0014 (budgets are per path).
- UI is Hebrew only (hard-coded, RTL); the home tab is בית.

## Left to the builder

- Table, column and event names; the wire's exact shape within D10.
- How the budget's miss room is computed from the recent miss rate, within D7.1 (whole sessions,
  never fewer than the play-forward).

---

## Rulings

*(None yet. Rulings made while building go here, written "Ruling:".)*
