# Phase 56 — Help on more cards

- **Status:** Victor said "make decisions and continue till PR" on 2026-10-16, after reading the
  one-pager: the design is self-approved (CLAUDE.md, *Continue till PR*). Implemented inline on branch
  `phase-56-help-on-more-cards`: six tasks and a final review, which added R12 (D3, D5 amended).
  Every ruling is at the end.
- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-16-help-on-more-cards-one-pager.md` (main checkout), its decisions 1–15.
- **Builds on:** phase 55 (help on tiles and typed, the retype), phase 41 (cloze typed's fit check),
  phase 38 (cloze typed's hint), phase 34 (the second try), phase 27 (judged cards), phase 25
  (speaking), ADR 0012 (`API_LEVEL`).
- **Touches:** core's `takesHelp` and `evaluate`, the speech and judged request schemas, the session
  service, the app's typed and speaking cards, its session state, retype and feedback, and e2e.

---

## Goal

Victor tested phase 55 with a 6-word homework list. Help on tiles and typed felt right: instead of
giving up he gets a nudge and answers. The other cards where he must produce the answer have no
help: he gave up on say the translation three times in one morning. This phase gives those five
cards phase 55's help and, where the answer is a word to type, its retype.

**Done means** (Victor):

1. On Victor's phone: on any of the five cards below, when stuck he presses help and finishes the
   card instead of giving up.
2. In his local testing data: gave-ups and skips on those cards drop, and help is recorded per card
   type (§3).
3. Automated tests prove it.
4. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:** help on say the translation (spoken and typed), typed meaning, sentence translation,
dictation and cloze typed (D1); help grades as a miss (D2); the wire (D3) and the server (D4); one
help state per card in the app (D5) and its views (D6); the retype on typed meaning, dictation,
cloze typed and say the translation typed (D7); the banner (D8).

**Out** (the one-pager's list): help on choice cards; issue 3 (words in progress, drilling them,
the 2026-10-16 findings); a spoken retype on say the translation; the retype on sentence
translation; the intro stage and a new word's first session; help in the bots and the day
simulation, which neither model.

---

## 1. Decisions

### D1. The cards, and what help reveals

| Card | Help reveals | Its line reads | Retype |
|---|---|---|---|
| `say_translation`, spoken | `answer`, the Italian word | left to right | none (Out) |
| `say_translation`, typed | `answer` | left to right | yes |
| `typed_meaning` | `meaning`, the stored Hebrew meaning | right to left | yes |
| `sentence_translation` | `answer`, the practised word as the reference uses it | left to right | none (Out) |
| `dictation` | `question`, the form heard | left to right | yes |
| `cloze_typed` | `answer`, the gap's word | left to right | yes |

- Each press reveals one more character from the start, phase 55's `revealed`, in a line apart from
  the input; the button is disabled once all is shown. Never the reference sentence: the model
  accepts many wordings, and the practised word is what the card is for.
- A space or punctuation comes with the letter after it, and a trailing mark (`!`, `?`) with the last
  press. Phase 55 joined only spaces and apostrophes; `typedHelp`'s join set widens to every
  punctuation mark (`\p{P}`, plus the modifier apostrophe `ʼ`, which is a letter to Unicode). It
  changes no Italian form phase 55's tests cover.
- Cloze typed keeps its Hebrew-sentence hint (`sentence-hint`, `hint_opened`) beside letter help:
  the hint gives the meaning, not the word, so it stays recorded and ungraded; letter help reveals
  the gap's word and counts as help.
- No help on choice cards, `read_aloud`, `meet` or during a retype.

### D2. Help is a miss (core)

`takesHelp`'s list grows from `letter_tiles`, `typed_translation` to those two plus
`say_translation`, `typed_meaning`, `sentence_translation`, `dictation`, `cloze_typed`. Core's
`AnswerInput` gains `helped?: boolean` on its heard (`{ heard }`, `{ heard, sounds_like }`) and
judged (`{ text, judged }`) variants. `evaluate`, on a card that takes help, with `helped: true`:

| Branch | Stored verdict | Grades (unchanged tables) |
|---|---|---|
| plain text: typed, say typed, dictation, cloze typed | `wrong` | typed and say typed: written productive Again; dictation: spoken receptive Again; cloze: written productive Again |
| judged text: typed meaning, sentence translation | `wrong` | typed meaning: written receptive Again; sentence: written productive Again |
| heard speech, `sounds_like` included: say the translation | `gave_up`, `is_correct: false`, the transcript as its text | spoken productive Again |

A spoken answer is `gave_up`, not `wrong`: `gradesFor` and `evidenceFor` read `wrong` on
`say_translation` as the typed form's and would grade written productive, a skill the spoken card
does not test. `gave_up` grades the skill it does test. A helped answer never opens a phase 34 second
try (its verdict is never `alternative`); a helped second try resolves `wrong`, `gave_up` when
spoken. Score, missed list and `dayState` already read these verdicts as misses. `helped` on any
other card is ignored and stored null, as today.

### D3. The wire

`helped?: boolean` joins `JudgedAnswerRequestSchema` (`/sessions/{id}/judged-answer`) and
`SpeechAnswerRequestSchema` (`/sessions/{id}/speech`); `NextStepRequest`'s text answer has it since
phase 55, and its comment names the new cards. *Amended by R12:* its pass answer has it too. Optional request fields: `API_LEVEL` stays 4 (ADR
0012); the app ships after the server.

The responses keep reporting the judgement of what was said or typed, not the grade stored:
`SpeechAnswerResponse.verdict` the transcript's, and `JudgedAnswerResponse.verdict` the verdict
this call's rule or model reached. The app needs it to tell "right, with help" from wrong (D8).

### D4. The server

- `answerJudged` and `answerBySpeech` take `helped` and pass it into the `AnswerInput` they record.
  `submitAnswer` stores `helped` for every card `takesHelp` names, by the code phase 55 wrote.
- `answerText`: a helped answer never asks for the fit check (one-pager decision 13): it is a miss
  whatever the model says, so the call would be wasted.
- Replays. A helped spoken answer is the only `gave_up` stored with a transcript (a pass stores an
  empty text), so a re-sent clip finding it replays it as `understood` rather than refusing it as
  stale (phase 25 ruling R1). A helped judged answer replays its stored `wrong`: the judge's own
  verdict is not stored, so a lost response re-sent shows a retype for a text that was right. Rare,
  and the grade is the same either way.
- The logs `answer_judged` and `speech_judged` carry `helped: true` when it is set, so a session's
  helped cards can be read in `server.log`.
- No migration: `answers_helped_text` (`helped is null or typed_text is not null`) holds for every
  spoken and judged answer, which are stored as text. The column's comment names the new cards.

### D5. The app: one help state per card

The help count moves from `TypedAnswerView`'s local state into the session state: `QuizState.help`,
how many characters help has revealed on the card on screen, with `pressHelp()` on the hook. It is 0
on a new card, and kept when the same card comes back for its phase 34 second try and when "can't
speak now" turns a say the translation from spoken to typed (one-pager decision 5): the letters shown
stay shown, and help goes on from there.

Every answer the hook sends to a card that takes help carries `helped`, on every route (next-step,
judged, speech), first try or second, a spoken "show the answer" or skip included (R12): `true` once help was pressed on the card, `false` otherwise.
The tiles card still says it itself (a wrong tile helps, phase 55); its own help stays its own.

### D6. The app: the views

- **`TypedAnswerView`** takes `help: { presses, onPress } | null` from the session in place of its
  `help` flag and local count, on every card it renders: typed translation, say the translation
  typed, typed meaning, sentence translation, dictation, cloze typed. The line (`typed-hint`) reads
  in the card's `direction`, so a Hebrew meaning reads right to left. Every typed view is keyed by
  its question (`key={question.id}`, one-pager decision 11).
- **`SpeakingCardView`**, on say the translation only: **עזרה** (`speak-help`) beside "show the
  answer" and "can't speak now", disabled while a clip is checked or every letter is shown, and the
  revealed line (`speak-hint`, left to right) above the microphone. A clip not understood records
  nothing; the line stays for the next attempt.

### D7. The retype on four more cards

The retype (phase 55 D7) opens after a first answer whose verdict is `wrong` or `near_miss`, "show
the answer" included, on typed translation, dictation, cloze typed, say the translation typed, and
typed meaning, where the verdict is the judge's (`JudgedAnswerResponse.verdict`), opened when the
response lands. Not on sentence translation (Out), and not on a phase 34 second try.

- The right answer it shows (`retype-answer`) is `rightAnswer(question)`: the form or word on typed,
  say typed and cloze, the form on dictation, the meaning on typed meaning, in the card's direction.
- The retype is right when the text is that answer: on typed meaning, `normaliseHebrew` of both is
  equal, the comparison the banner already uses for the stored meaning (`judgeTyped` would strip an
  Italian article); on every other card, the card's own `evaluate` gives `exact` (the form or lemma
  on typed and say typed, the form only on dictation, the gap's word on cloze). Another accepted
  word is not right, as in phase 55.
- Otherwise as phase 55: two tries, no skip, no help, the answer hides at the first character, the
  wrong-script gate uses no try, nothing is sent and the grade is the first answer's. Copy reused:
  `retypeNotice` **הקלידו את המילה שוב**, `tryAgain` **נסו שוב**.

### D8. The banner

A helped answer whose text is right — `exact` or `alternative`, `understood` when spoken, and a near
miss on a second try — shows tone `other`, **נכון, עם עזרה**, no line (`feedbackHelped`, phase 55).
A helped wrong text is a wrong one, which opens the retype where D7 has one. The heard and judged
answers on the card carry `helped` for it, and `feedbackFor` reads the text's verdict without it.
No new copy.

---

## 2. Testing

- **Core (`quiz.test.ts`):** `takesHelp` lists seven types; on each new card a helped text, judged
  text or heard answer records `wrong` / `wrong` / `gave_up` whatever it says, `sounds_like`
  included; the same answer unhelped grades as today; a helped answer never opens a second try; a
  helped second try resolves `wrong` (`gave_up` spoken); `helped` on a choice or read aloud changes
  nothing.
- **Server (integration):** a helped answer on each of the five is stored with its verdict and
  `helped = true`, and writes the grade D2's table names; a helped spoken answer replays as
  `understood`; a helped cloze answer makes no fit-check call; the judged response reports the
  judge's verdict.
- **App (`typedHelp`, `retype`, `quiz`, `feedback` tests):** the reveal joins punctuation and
  Hebrew; help kept through a hold and through "can't speak now", reset on a new card; `helped` in
  each route's request body; the retype opens on each of the four (and typed meaning on the judge's
  `wrong`), not on sentence translation or a second try; the retype's right check per card; the
  helped banner for a heard and a judged answer.
- **e2e:** help and a retype on each card, in the spec that already reaches it (meaning recall,
  dictation, the sentence cards, speaking: help spoken, then the same card after "can't speak now");
  the bodies sent say `helped`; every spec that shows the answer on one of the four now meets a
  retype, through `playOut` and the phase 55 helpers.
- **Bots and the day simulation:** unchanged; the bots' tests already assert that no body says
  `helped`.

---

## 3. Counting Done means 2

Victor runs this on lane 0 (`lang_tutor`), read-only, before and after testing. A give-up or a skip
on these cards is an answer with no text: a spoken "show the answer" is `gave_up` with an empty
text, a typed one `wrong` with an empty text, a skip `skipped` with an empty text. A helped spoken
answer is `gave_up` too (D2), but stored with its transcript, so counting empty texts leaves it out
where counting `gave_up` would not (the one-pager's query, amended):

```sql
select q.type,
       count(*) filter (where a.typed_text = '') as gave_up_or_skipped,
       count(*) filter (where a.helped) as helped,
       count(*) as answered
from answers a join questions q on q.id = a.question_id
where q.type in ('say_translation', 'typed_meaning', 'sentence_translation', 'dictation', 'cloze_typed')
  and a.answered_at >= now() - interval '7 days'
group by q.type order by q.type;
```

The first answer counts, never a second try's give-up. `helped` is null on every answer from before
this phase, so the before-count shows 0 helped.

---

## Rulings

Made during the run under *Continue till PR*; each says what it costs if wrong.

**The decisions as built**

- **R1. Done means 2 counts an answer with no text as a give-up or a skip** (§3; amends the
  one-pager's decision 15 and its query). A typed "show the answer" is stored `wrong` with an empty
  text, not `gave_up`, so counting `gave_up` and `skipped` would miss every typed give-up; a helped
  spoken answer is `gave_up` with its transcript, so counting empty texts also leaves it out. *If
  wrong:* the before/after comparison counts a slightly different thing from what Victor saw; the
  query is one line.
- **R2. A helped spoken answer replays as `understood`** (D4). The replay finds it by its shape, the
  one `gave_up` with a transcript, rather than reading `helped`, which `loadSession` does not load.
  An `alternative` said with help replays `understood` too. *If wrong:* both show **נכון, עם עזרה**,
  so a re-sent clip after a lost response only drops the line naming what was heard; the grade is
  the same.
- **R3. A helped judged answer replays its stored `wrong`** (D4). The judge's own verdict is not
  stored, so a lost response re-sent opens a retype for a text that was right. *If wrong:* one extra
  retype on a rare network retry; the grade is the same.
- **R4. Every punctuation mark joins the letter after it** (D1). `typedHelp`'s join set is
  `[\s\p{P}ʼ]`: the one-pager asked for punctuation; phase 55 joined spaces and apostrophes only.
  *If wrong:* a hyphenated or punctuated form reveals two characters on one press.
- **R5. The retype on typed meaning compares by `normaliseHebrew`** (D7), not by `judgeTyped`,
  whose leading-article rule is Italian and English. The meaning's trailing `!`, niqqud and spacing
  do not count. *If wrong:* a retype typed with a different mark is accepted; it is a retype, never
  graded.

**The app**

- **R6. The help count lives in the session state** (D5): `QuizState.help`, 0 on a new card, kept
  when `applyQueued` brings the same card back for its second try; `TypedAnswerView` no longer
  counts. That is what lets a say the translation keep its letters across "can't speak now", where
  the view changes. The tiles card keeps its own count. *If wrong:* none known; reverting is a prop.
- **R7. `opensRetype` takes the card's answer, not its text** (D7), so a typed meaning opens on its
  judged verdict; phase 55's tests pass `{ text }`. *If wrong:* one signature.
- **R8. A helped judged answer opens no hold** (`mayOpen`; not in the plan). It is stored `wrong`,
  so a hold its response carries was met from an earlier answer, and the answer goes again as that
  card's second try, as phase 34 does for a "show the answer". *If wrong:* such a race would show
  the helped banner over a held card.
- **R9. A planned unit test was dropped**: "help kept through can't speak now" could only spread an
  object in a pure test, and passed with no code; the e2e test covers it. *If wrong:* none.

**Server and tests**

- **R10. Answers from an older app to the five cards store `helped = null`**, as phase 55's do on
  tiles and typed: the unit expectations for the judged, speech and fit-check paths gained
  `helped: null`. *If wrong:* none; it is the column's meaning.
- **R11. The e2e help tests extend the specs that reach each card** rather than adding a spec with
  its own setup: the dictation in `listening-variety`, the meaning card in `meaning-recall`, both
  sentence cards in a new `sentence-cards` test, say the translation in `speaking`'s first session
  (spoken) and a new carry-over test. *If wrong:* those tests now play the card helped. An unhelped
  dictation answered right is still played by `answer-language.spec.ts`; an unhelped spoken say the
  translation is no longer played to its banner by any e2e test, only by the unit and integration
  tests.

**The final review**

- **R12. A spoken card given up after help says it was helped** (amends D3, D5; final review). The
  pass answer of `NextStepRequest` and core's `AnswerInput` gained `helped?`, and the app sends it on
  "show the answer" and on the skip after an unheard clip. Without it, pressing help on say the
  translation and then giving up — Victor's case — stored `helped = null`, so §3 never counted that
  help. A pass is a give-up or a skip whatever `helped` says; nothing reads it but §3. *If wrong:*
  the `helped` column counts help on cards that were given up anyway, which §3's give-up column
  already counts.
