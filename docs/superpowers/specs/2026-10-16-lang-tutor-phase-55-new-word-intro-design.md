# Phase 55 — A new word's intro stage, and help on tiles and typed cards

- **Status:** Victor said "go till PR, subagents" on 2026-10-16 after deciding the one-pager in
  chat, question by question: the design is self-approved (CLAUDE.md, *Continue till PR*).
  Rulings made during the run are at the end.
- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-15-new-word-intro-ladder-one-pager.md` (main checkout), and issues 1
  and 2 of `drafts/2026-10-15-phase-54-testing-issues.md`.
- **Builds on:** phase 54 (the ladder, `meet`, slots), phase 53 (targets, pools), phase 38
  (`hint_opened`), phase 34 (the second try after another accepted word), phase 24 (letter tiles),
  ADR 0012 (`API_LEVEL`).
- **Touches:** the card plan (`plan.ts`), the picker's constants and pools (`chooseConstants.ts`,
  `choose.ts`), core's `evaluate` and tile letters, the wire's text answer, one migration (a column
  on `answers`), the app's tiles, typed and meet cards and the session hook, the bots, the day
  simulation and e2e.

---

## Goal

Victor tested phase 54. The meet card asks him to say the word, but nothing listens. The choice
cards are easy by elimination, and the typed card is too hard: he could not type a single word he
had just met. This phase turns a new word's first session into an **intro stage** — meet it, say
it, write it — followed by three spaced practice cards, and gives the tiles and typed cards a help
that keeps the learner producing the word instead of failing it.

**Done means** (Victor):

1. On Victor's phone: he meets a new word, says it, builds it from tiles, and at the end of the
   session can type it, with help if he needs it, instead of failing every time; and the next day.
2. First-session typed cards answered with no help are counted (§3), and the count rises from
   phase 54's about zero.
3. Tests prove it works as designed: the first session's card order (the intro stage back to back,
   the later cards never adjacent), per-tile checking, the helps, the retype after a wrong typed
   answer, and that an answer without help grades as today.
4. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:** the meet card (D1); the ladder (D2) and where its cards sit (D3); slots and the cap of two
(D4); a target's leftover slots (D5); help, and how it grades (D6); the app's tiles and typed cards
and the retype (D7); the bots (D8); the day simulation (D9).

**Out** (the one-pager's list):
- Issue 3, the limit on words in progress and drilling them: its own next phase.
- Recently met words as the choice cards' wrong options.
- No main vocabulary until a target's words are stable: issue 3's phase, which defines "stable" as
  its "in progress".
- More on the meet card: images, an example sentence, "I already know it".
- A formal comparison of next-day recall against phase 54's ladder.
- New day-simulation outcomes: the existing ones are restated for the new ladder; a target check
  that moves with two new words a session is re-measured, never lowered.

---

## 1. Decisions

### D1. The meet card

The line **אמרו את המילה בקול** (`testID="meet-say"`, `strings.meetSayAloud`) goes. The card shows
the title, the word (spoken on arrival and on a tap), its meaning and **המשך**, as before. Saying the
word moves to the intro stage's read-aloud card (D2), where the app listens.

### D2. The ladder

A ladder pick (phase 54 D3) becomes these cards, in this order:

| Stage | Card | Type | When | Graded |
|---|---|---|---|---|
| Intro | Meet | `meet` | always | no |
| Intro | Read aloud | `read_aloud` | the session can speak and the form is speakable | no memory (as today) |
| Intro | Write it | `letter_tiles` | the form takes tiles (`pick.tiles`) | yes |
| Intro | Write it | `typed_translation` | the form does not take tiles: more than 10 letters, an elision, a phrase | yes |
| P1 | Italian → choose the Hebrew | `multiple_choice` | always | yes |
| P2 | Hebrew → choose the Italian | `reverse_choice` | always | yes |
| P3 | Hebrew → type the Italian | `typed_translation` | always | yes |

- **Can speak** for the ladder's read-aloud is `input.speaking && pick.speakable`. The plan's
  `picks.length > 1` rule stays on the session's speaking pick only: a session of one ladder still
  says its word.
- Every card grades, records and writes progress exactly as the same type does today, help aside
  (D6). A ladder read-aloud heard `understood` counts as right in the score and raises spoken
  production up to `READ_ALOUD_MAX_LEVEL`, as any read-aloud does; "can't speak now" skips it unseen
  and turns speaking off for the rest of the session, as today.
- The session's own speaking pick (phase 37 D4) is unchanged; it is another word's card.
- `LADDER_TYPES` gives way to a function of the pick: `ladderCards(pick, speaking)` returns the
  intro types and the three practice types.

### D3. Where a ladder's cards sit

Phase 54 D5's stream and even merge, with one change: **a word's intro stage is one unit.**

1. The ladder stream: every ladder's intro unit in pick order, then every P1, every P2, every P3.
   With two ladders: `[M_A R_A T_A] [M_B R_B T_B] A1 B1 A2 B2 A3 B3`.
2. The other cards and the returns are ordered as today.
3. The merge spreads the stream's units evenly among the other units, so nothing is placed inside
   an intro unit. A stream unit that would follow a card of its own word goes after the next other
   unit, while one is left — as today, for the unit's first card.

So a word's intro cards are back to back; no other two cards of one word are adjacent while the
session has another card to put between them; a session of ladders and nothing else is their cards
in stream order.

### D4. Slots, and the cap of two

- `LADDER_SLOTS` 3 → **4**: a ladder takes four of the session's `SESSION_LENGTH` (10) slots, its
  four graded cards (write it, P1, P2, P3). The meet and read-aloud cards are free. Every ladder
  costs four, tiles or typed.
- `NEW_PER_SESSION` 3 → **2**: at most two ladders a session, across every pool and pass. The
  reserve formula, `NEW_FLOOR` and `DAY_NEW_CAP` are unchanged.

So a session is at most 10 graded cards plus up to four free ones. Two ladders and two other words:
14 cards with speaking, 12 without. A backlog of due words still lets one new word in: one ladder
and six reviews, 12 cards with speaking.

### D5. A target's leftover slots stay out of the main path

Today slots a target cannot fill pass forward to the main path (phase 53 R7, phase 54 R2). Now:

- A target's unused slots pass to the later targets, and come back to the targets in the second
  pass, but **never reach the main path**. The session ends shorter instead.
- The main path's own unused slots still go back to the targets (phase 53 R7).
- A target with no words (phase 53 R11) still passes its slots on to the main path: it has nothing
  of its own to ask.
- The pass past the daily cap (phase 54, ruling 15, `taken.size === 0`) is unchanged.

A fresh 30-word homework list therefore gives two ladders and nothing else: 12 cards, 8 graded. The
exam's eve shows no main-path card (closes phase 54 R2's gap).

### D6. Help, and how it grades

**Wire.** The text answer shape of `NextStepRequest` gains `helped?: boolean`, and core's
`AnswerInput` text variant gains `helped?: boolean`. The app sends it on every answer to a
`letter_tiles` or `typed_translation` card, a phase 34 second try included: `true` when the learner
pressed help or placed a wrong tile on the card so far, `false` otherwise. An optional request field: `API_LEVEL` stays 4 (ADR 0012's rule raises it
for a new *required* field, a removal or a changed meaning; the app ships after the server).

**Grade.** In core `evaluate`, a `letter_tiles` or `typed_translation` answer with `helped: true`
is recorded with verdict **`wrong`**, `is_correct: false`, whatever its text — any help is a miss,
on a first session and on a review. A retry (phase 34) with `helped: true` records `retry_verdict`
`wrong`. Because the stored verdict is `wrong`, everything downstream already treats it as a miss
and needs no change: `gradesFor` (written productive Again), `evidenceFor`, `score` (counts as
wrong), `missed` (lists the word), `dayState` (opens a return). `helped` on any other type is
ignored and stored null, as `hint_opened` is outside `cloze_typed`.

**Storage.** Migration `0039_helped`: `answers.helped boolean` (null unless a first text answer to
`letter_tiles` or `typed_translation` carried it), with `answers_helped_text` check `helped is null
or typed_text is not null`. `insertAnswer` writes it; nothing reads it but the count in §3 and the
tests. An answer without help grades as today.

### D7. The app

**Tile letters, shared.** `tileLetters(form)` (today private in the server's `domain/tiles.ts`:
`stripStress`, NFC, lowercase, one letter per code point, 3–10 letters) moves to `packages/core`
with its `stripStress` regex, and the server's `tilesFor` and `tileEligible` use it. The app checks
each tile against `tileLetters(question.answer)`, the same letters the tiles were built from.

**Letter tiles** (`LetterTilesView`, pure state in `apps/mobile/src/tiles.ts`):
- A tapped tile is checked at once against the next expected letter, by letter (duplicates and
  extra tiles may share a letter). Right: it is placed. Wrong: it is not placed, it stays in the
  pool, the line **לא האות הזאת** (`tiles-wrong`) shows until the next right tile, and the card is
  now helped.
- **עזרה** (`tiles-help`) places the next right letter — the first unused tile with that letter —
  and marks the card helped.
- Placed tiles are always the word's right start, so they are not removable. The card answers
  itself when the last letter is placed: `submitText(built, helped)`. The check button goes;
  **הצגת התשובה** (`tiles-show-answer`) stays and sends `''` (wrong).

**Typed translation** (`TypedAnswerView`):
- **עזרה** (`typed-help`): each press reveals one more character of `question.answer` from its
  start — a space or apostrophe comes with the letter after it — in a line apart from the input
  (`typed-hint`, LTR, the revealed letters and `…`, no length shown). Help never changes the input.
  Once pressed, the card is helped. The button is disabled once the whole form is revealed.
- The answer is sent as today, with `helped`.

**The retype.** After a first answer to `typed_translation` whose own text verdict (`evaluate`
without `helped`) is `wrong` or `near_miss` — `''` from **הצגת התשובה** included — the card enters
the retype, before any banner:
1. The card shows the first answer's title (**התשובה הנכונה:** or **כמעט! כך כותבים:**), the right
   answer (`retype-answer`) and **הקלידו את המילה שוב** (`retype-notice`); the input is cleared and
   editable; the word is spoken, as the banner's cue does today.
2. The right answer hides at the first character typed.
3. **בדיקה** checks the retype locally: right means `judgeTyped` gives `exact` (the form or the
   lemma, case and a leading article as today, accents required; another accepted word is not
   right). Right: the banner shows **נכון!** with **המשך**.
4. Wrong: the right answer shows again with **נסו שוב**, and the learner retypes once more. A
   second wrong retype ends it: the banner shows **התשובה הנכונה:**, the answer and **המשך**.
5. No skip during the retype. Retypes are never sent to the server; the grade is the first
   answer's.

The retype applies to every `typed_translation` card, ladder or not. It does not apply to
`say_translation` typed while speaking is off, `cloze_typed` or `dictation`, which are unchanged.
An `alternative` verdict keeps phase 34's second try, unchanged.

**Feedback for a helped answer** whose text is right: tone `other`, title **נכון, עם עזרה**, no
line. A helped answer whose text is wrong is a wrong answer (the retype, for typed).

**The hook** (`useSession`, pure parts in `quiz.ts`): `submitText(text, hint?)` carries `helped`
for tiles and typed; `nextStepRequest` adds `helped` to a text answer, first or second try, when it
is defined. A
retype state (attempt 1 or 2, then done) withholds the banner and `next()` until it ends; the
server's response is queued meanwhile, as today.

Hebrew copy, all in `strings.ts`: `help` **עזרה**, `tilesWrong` **לא האות הזאת**, `retypeNotice`
**הקלידו את המילה שוב**, `retypeAgain` **נסו שוב** (the existing `tryAgain`), `feedbackHelped`
**נכון, עם עזרה**. `meetSayAloud` is removed.

### D8. The bots

The bots never use help (`helped` is not sent), so their grades are unchanged. `decide()` already
answers `read_aloud` (speak) and `letter_tiles` (text); the bots meet the new ladder's cards in the
same session, and their ladder reading (`analysis.ts`, `report.ts`: a ladder is a session's cards
of a word with a meet card) counts the intro read-aloud and the write-it card as ladder cards, not
"the same word again" and not off-rung. A test plays a ladder of the new shape.

### D9. The day simulation

`day.test.ts` plans with `tiles: true, speakable: true`, so every simulated ladder is meet, read
aloud, tiles, P1, P2, P3. Outcomes 8–11 are restated for the new ladder: its intro unit back to
back, then the three practice cards; at most two ladders a session; graded cards (all but meet and
a ladder's read-aloud) at most `SESSION_LENGTH`; the adjacency bound counted outside intro units.
The target scenarios follow D5: no main-path card while a target leaves slots unused. Phase 53's
ready-on-due measures and phase 54's aggregates are re-measured on the five phases and reported,
never lowered (phase 54 R6, R7; memory: compare five-phase aggregates against master's).

---

## 2. Testing

- **Core (`quiz.test.ts`, `tiles` in core):** `evaluate` with `helped` on tiles and typed gives
  `wrong` whatever the text, and the same text without it grades as today; `helped` on a multiple
  choice or a cloze answer changes nothing; a helped retry is `wrong`; `tileLetters` as the server
  had it.
- **Plan (`plan.test.ts`):** `ladderCards` for tiles and non-tiles forms, speaking on and off, a
  form that cannot be spoken; the intro unit back to back for one and two ladders, with and
  without other cards; a session of one ladder gets its read-aloud; no other two cards of a word
  adjacent while another card exists.
- **Picker (`choose.test.ts`, `targetSession.test.ts`):** a ladder costs four; at most two ladders;
  the reserve with a backlog (one ladder, six reviews); a target's unused slots stay out of the
  main path, reach a later target, and an empty target's slots still reach the main path; the main
  path's unused slots still go back to the targets.
- **Server (integration):** a helped tiles answer and a helped typed answer are stored `wrong` with
  `helped = true` and write written productive Again; an unhelped one as today; the prepare job
  writes a ladder as meet, read aloud, tiles (or typed), P1, P2, P3.
- **App (`tiles.test.ts`, `quiz.test.ts`, `feedback.test.ts`, a new `typedHelp`/`retype` test):**
  tile checking by letter with duplicates and extras; help places the next letter; the hint's
  reveal steps over spaces and apostrophes; the retype's states (right, wrong then right, wrong
  twice) and when it opens (wrong, near miss, show answer; not exact, not alternative, not a helped
  right answer); `helped` in the request body.
- **e2e:** `meet.spec.ts` follows the new ladder (no `meet-say`; read aloud and tiles after the
  meet card; new totals); a new `help.spec.ts` plays a wrong tile, tiles help, typed help and a
  retype (wrong, then right), and checks the bodies sent (`helped`); every spec that counts a
  ladder's cards or answers its tiles moves to the new totals and the self-answering tiles card.
- **Bots:** `answer.test.ts` answers a tiles card; `play.test.ts` plays a ladder of the new shape.
- **Day simulation:** D9.

---

## 3. Counting Done means 2

Run against production after the release (read-only). A ladder's typed cards are the
`typed_translation` answers in a session that also holds a `meet` card of the same gloss:

```sql
select date_trunc('week', a.answered_at) as week,
       count(*) as typed_in_first_session,
       count(*) filter (where a.verdict in ('exact', 'near_miss')
                          and coalesce(a.helped, false) = false) as right_without_help
from answers a
join questions q on q.id = a.question_id and q.type = 'typed_translation'
where exists (
  select 1 from session_questions sq
  join questions m on m.id = sq.question_id and m.type = 'meet' and m.gloss_id = q.gloss_id
  where sq.session_id = a.session_id)
group by 1 order by 1;
```

Phase 54's weeks give the baseline (their `helped` is null).

---

## Rulings

Made during the run under *Continue till PR*; each says what it costs if wrong.
