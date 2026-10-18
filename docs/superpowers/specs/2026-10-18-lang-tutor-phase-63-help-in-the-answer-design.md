# Phase 63 — Help in the answer

- **Status:** Victor approved the design in the mockups on 2026-10-18. This document awaits his review. His
  rulings are at the end.
- **Date:** 2026-10-18
- **Source:**
  - The one-pager: `drafts/2026-10-18-help-button-one-pager.md` (main checkout).
  - The brainstorming chat of 2026-10-18 and its mockups, in `.superpowers/brainstorm/63915-1792319728/content/`
    (main checkout):
    - `help-v4a-marks-v4.html`, the typed card. Approved.
    - `help-all-cards.html`, every other card. Approved except sentence translation (R4).
- **Builds on:**
  - phase 55 (help on tiles and typed) and phase 56 (help on five more cards)
  - phases 59 and 62 (tapping a sentence's words)
  - ADR 0002 (no `Math.random` in the app), ADR 0010 (migrations), ADR 0012 (`API_LEVEL`)
- **Touches:**
  - core: `takesHelp`, `AnswerInput`, `evaluate`, the next-step schema
  - the server: the choice answer's path, the `answers_helped_text` check, and every reader of a choice's
    correctness
  - the app: the session's help state, `typedHelp`, a new shared help button, and every card view that takes help
  - e2e

---

## Goal

Victor (one-pager): the **עזרה** button sits at the bottom of the card, so it is hard to find, and once he
starts typing the keyboard hides it. Its letters show on a line of their own, away from the button, and
nothing says he can press it again. The choice cards and matching have no help at all, so there he guesses.

This phase puts one help button, the same everywhere, at the edge of the place he answers, and shows what it
gave right beside it. On the typed cards, help now reads what he typed: it marks a mistake, or gives the next
letter. The choice cards, listen choice and matching get help of their own.

**Done means** (the one-pager, as amended in the chat):

1. On Victor's phone, on every card with help, he finds **עזרה** while the keyboard is open, without closing
   it or scrolling.
2. *(Struck by R2.)* The one-pager's "after the first letter shows, the button says he can press again". The
   label now stays **עזרה**, and the cue is the button staying lit with its result beside it.
3. When stuck on a choice card, listen choice or matching, he presses help instead of guessing. (Assumed in
   the one-pager; Victor kept it. Read aloud was dropped, R6.)
4. The placement and wording were designed as mockups and approved by Victor before anything was built. The
   mockups above meet this.
5. Automated tests prove it, and `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:**
- one help button (D1), at the answer's edge on every card that has help (D2)
- on the typed cards, help that marks a mistake or gives the next letter, shown inside the input (D3)
- the letters box on the spoken card (D4) and on listen choice (D6)
- the tiles' built word in a box (D5)
- help on multiple, reverse and cloze choice (D7) and on matching (D8)
- no help button on sentence translation (D9)
- a helped choice, or a helped matching word, is a miss (D10–D12)

**Out:**
- These keep their places and behaviour:
  - tap a word
  - the cloze sentence hint (**רמז: הצגת המשפט בעברית**)
  - **הצגת התשובה**
  - **אי אפשר לדבר עכשיו**
- No help on read aloud, meet or new meaning, or during the retype.
- The 🔊 and 🎤 stay emoji; only the bulb is drawn.
- A before/after count of help presses.
- Help in the bots and the day simulation, which still never press it.

---

## 1. Decisions

### D1. One help button

One shared component (`HelpButton`) on every card that has help:

- **Look:** a soft chip.
  - fill `primarySurface` `#EEF2FB`
  - the label in `primary` `#3B5BDB`, 15 bold
  - radius 10, padding about 8 × 12
  - before the word, a thin line lightbulb icon, about 18 px, drawn in the label's colour
- **Label:** always **עזרה** (`strings.help`, unchanged), before and after any press (R2).
- **Disabled:**
  - when it has nothing left to give (each card below says when)
  - while an answer is being checked
  - Disabled means fill `#F2F2F5`, label and icon `#B4B4C3`, and not pressable.
- **The icon** is the app's first drawn one.
  - The expected route is `@expo/vector-icons` (Ionicons `bulb-outline`). It draws with `expo-font`, which is
    already a dependency, so it should add no native module.
  - The builder confirms the native fingerprint is unchanged (ADR 0012). If the icon needs another route that
    does change it, the PR says so, because the release then makes a new store build instead of an
    over-the-air update.
- **testIDs:** each card keeps its button's: `typed-help`, `tiles-help`, `speak-help`. The new ones are
  `choice-help`, `listen-help` and `board-help`.
- **What goes:** every old help control.
  - the text links in the actions columns
  - the separate hint lines, `typed-hint` above the input and `speak-hint` above the mic

### D2. Where it sits

The button sits at the right edge of the place the learner answers, and what help gave shows beside it.

| Card | The answer area | The button | What help gave shows |
|---|---|---|---|
| typed translation, say the translation typed, typed meaning, dictation, cloze typed | the input | inside the input, at its right edge | inside the input (D3) |
| letter tiles | the built word, now a box like the input | at the box's right end | the placed tiles (D5) |
| say the translation, spoken | a dashed letters box above the mic | at the box's right end | the letters, in the box (D4) |
| listen choice | a dashed letters box under the play button | at the box's right end | the letters, in the box (D6) |
| multiple, reverse and cloze choice | the options | in a row just above the options, at its right edge | the ruled-out options (D7) |
| matching | the two columns | in a row just above the columns, at its right edge | the helped pairs (D8) |

- **Physical, not logical:** the right edge is the screen's right, whatever the answer's direction. On typed
  meaning the answer is Hebrew and runs right to left, so the button sits where typing starts and the text
  runs leftward from it. This was approved in the all-cards mockup.
- **In view with the keyboard open:** the button is inside the answer area or directly above it, and that is
  where the screen keeps the focused input while the keyboard is open (Done 1).
- **The check:**
  - The builder has no Android device, and the e2e web build has no on-screen keyboard.
  - So e2e checks the layout at phone size, on the tallest typed card: cloze typed with its Hebrew sentence
    shown. It checks that the button sits inside the input and is in the viewport.
  - Victor checks the real keyboard on his phone after the merge (R10).

### D3. The typed cards: help reads what was typed

This covers typed translation, say the translation typed, typed meaning, dictation and cloze typed. Help works
toward `helpText(question)`, as today: the `answer`, or the `meaning` on typed meaning, or the `question` on
dictation.

**On each press,** help compares the typed text with that answer, character by character from the start:
- **A wrong character:** help marks the first character that differs (or the first one past the answer's end)
  and everything typed after it. A mark is red `#C92A2A` on `wrongSurface` `#FCEBEB`, underlined. No letter
  is given.
- **Everything typed is right,** meaning the text is a start of the answer: help gives the next step of the
  answer after the typed text. It uses today's steps (`typedHelp.ts`): a space or punctuation mark comes with
  the letter after it, and a combining mark with the letter before it.

**What shows** (the approved storyboard, `help-v4a-marks-v4.html`):
- **The grey letters.** The given letters not yet typed show in pale grey (`#B4B4C3`) right after the caret,
  ahead of the typing. While the answer goes on beyond them, a `…` follows. Typing a given letter takes it
  out of the grey. No length is shown.
- **Grey only on a right start.** The grey shows only while the typed text is a start of the answer. Typing
  something else hides it, and nothing is marked until the next press (storyboard step 4).
- **Marks clear on any edit** (step 6).
- **The input holds only the typing.** Its value is only ever what the learner typed: help never writes into
  it (phase 55).
- **Disabled at the end.** The button is disabled when nothing is left to give: the typed text is a start of
  the answer, and every step of the answer is already given or typed. Step 8 is the case where the whole word
  is typed right.

**Comparing:** character by character, after the folding `normaliseTyped` does.
- A capital is not a mistake, and neither is a typographic apostrophe.
- An accent is a mistake: `è` is not `e`.
- On typed meaning, the comparison uses `normaliseHebrew`'s folding instead.
- The builder maps the marks back onto the characters as typed.

**State:** today the session's `help` count means "steps revealed". It splits in two:
- **Pressed:** whether help was pressed on the card. This is what makes the answer `helped`, and a press that
  only marks counts (R3).
- **Given:** how far into the answer help has given, which is the grey.
- Both are kept on a phase 34 second try and through "can't speak now", as in phase 56 D5.
- **The marks** are the typed text they were made for: they show while the input still holds exactly that
  text.
- **Where the rules live:** they are pure functions in `apps/mobile/src/typedHelp.ts`, beside today's, with
  unit tests. Nothing on the server reads them.

**Rendering:** the grey letters and the marks are drawn over or behind the `TextInput`, aligned with its
text, on Android and on the web build that e2e runs.
- How is the builder's call, and it is the riskiest piece of the phase.
- A long answer that scrolls the input sideways must keep them aligned, or hide them.
- Victor checks it on his phone after the merge (R10), and nothing checks it on Android before then. So the
  builder favours the way of drawing most likely to hold on Android, and a misalignment found on the phone is
  fixed in a follow-up PR.

**Other right answers.** Help compares with the one answer it knows, the one it reveals today. On typed
translation, a lemma the checker would accept is marked from where it leaves that form. On typed meaning, a
synonym the judge would accept is marked the same way. My call (R5).

**Unchanged:**
- every press counts as help, and a helped answer is a miss (phase 56 D2)
- no help during the retype
- the retype after a wrong answer (phase 56 D7)
- the cloze sentence hint beside help

### D4. Say the translation, spoken

- **The box:** the letters line (`speak-hint`) becomes a dashed box above the mic, the same height and radius
  as the input.
  - It holds the letters help gave, in grey, with `…`.
  - The help button sits at its right end.
  - Before any press, the box is empty apart from the button.
- **A press:** nothing is typed here, so each press gives the next step from the start, as today
  (`revealed`).
- **Disabled** while a clip is being checked, or once every step is shown.
- **Turned typed:** when "can't speak now" turns the card typed, what was given carries over as the grey
  (D3).

### D5. Letter tiles

- **The box:** the built-word row (`tiles-built`) becomes a box like the input: white, a 1.5 px border, radius
  14, the placed tiles inside, and the help button at its right end.
- **A press** does what it does today: it places the next right tile.
- **A wrong tile** is still refused when tapped, and still makes the card helped (phase 55).
- **Disabled** once the word is complete, when the card answers itself.
- The tile pool and **הצגת התשובה** stay below the box.

### D6. Listen choice

New help.
- **The box:** a dashed letters box under the play button (`listen-play`), as on the spoken card, with the
  help button at its right end.
- **A press** gives the next step of the word the card plays (`question.question`, what `ListenPrompt` says),
  from the start, in grey with `…`.
- **Disabled** once the whole word is shown.
- The options are untouched.
- **Once answered,** the box goes, because the word then shows in writing as today.
- A press makes the answer helped (D10).

### D7. Multiple, reverse and cloze choice

New help.
- **Where:** in a row just above the options, at its right edge.
- **A press** rules out one wrong option: it fades (opacity 0.4), is struck through, and can't be tapped.
- **Disabled** when two options are left: two presses on four options.
- **Which wrong option goes** is the builder's call, within two rules:
  - never `Math.random` (ADR 0002)
  - not the same screen position every time; a deterministic pick from the question's id will do
- A press makes the answer helped (D10).

New meaning is a choice card too, and gets no help (Out).

### D8. Matching

New help.
- **Where:** in a row just above the two columns, at its right edge.
- **A press** matches one pair for the learner: the selected word or meaning if there is one, otherwise the
  first unmatched word in board order.
  - The fifth meaning, which belongs to no word, can't be matched. With it selected, a press matches the
    first unmatched word, as if nothing were selected.
- **The pair** shows in blue, not green: border `primary`, fill `primarySurface`, label `primary`. It is
  locked like a matched pair.
- **That word is helped,** and its answer is a miss (D11).
- **Disabled** once every word is matched. The board completes as today when its last pair is matched,
  whether by the learner or by help.
- **The banner** (**בניסיון הראשון: X מתוך Y**) counts a helped word as not right.

### D9. Sentence translation: no help button

Victor (R4): tapping the Hebrew words already shows their Italian, so the card needs no button.
- **What goes:** the help button and its hint line, from sentence translation.
- **A tap on the practised word still counts as help,** by the code phases 59 and 62 wrote:
  `wordTappedState` in the app, and the target tap on the server. So `sentence_translation` stays in
  `takesHelp`.
- **What the tap shows:** with the hint line gone, the tapped practised word shows its Italian under it, like
  any tapped word.
- **A card with no word map** (the `'mark'` tap) shows `question.answer` under the marked word instead. The
  builder checks how that card looks today.

### D10. Core and the wire: a helped choice

- **`takesHelp`** gains `multiple_choice`, `reverse_choice`, `cloze_choice`, `listen_choice` and `matching`.
  Not `new_meaning`.
- **`AnswerInput`'s `{ option_index }`** gains `helped?: boolean`.
  - On a card that takes help, `evaluate` with `helped: true` gives `is_correct: false`, whatever the option.
  - `answerFits` accepts the field.
- **The wire:** `NextStepRequestSchema`'s `option_index` branch gains `helped?: boolean`, and the route passes
  it into the answer. It is an optional request field, so `API_LEVEL` stays 5 (ADR 0012). The app ships after
  the server.
- **What the app sends:** `helped` on every choice answer of those five types: `true` once help was pressed
  on the card, `false` otherwise, as phase 56 does on the typed routes. A matching board sends it per word:
  `true` on a word help matched, `false` on the rest.

### D11. The server: a helped choice is a miss

- **Storing it:** `insertAnswer`'s choice branch stores `helped`.
- **A migration** drops the check `answers_helped_text` (`helped is null or typed_text is not null`).
  - Admitting a choice row would mean adding `or selected_option_position is not null`.
  - `answers_kind_valid` already requires exactly one of the two columns, so that check could never fail.
  - The column's comment names the choice cards instead. My call.
- **Reading it:** every place that derives a choice's correctness from `selected_option_position` reads
  `helped` too, and a helped choice is wrong.
  - Known places: `repo/progress.ts:98-100` (evidence and grades), and `repo/sessions.ts:286-288` and
    `:460-471` (session results).
  - The builder greps for every other reader.
- **The outcome:** a helped choice grades as a wrong choice does on its card.
  - its memory grade is AGAIN, and matching's per-word evidence is wrong
  - it counts as missed in the score and the missed list
  - it moves no target value, as `targetSkills` already skips helped answers
- **The log:** no new log line. A choice answer has no event line of its own, and the `request_body` line
  already logs the whole body, `helped` included, so a session's helped choices can already be read in
  `server.log`. My call.

### D12. The banner

- **A helped choice** follows phase 55: a right option shows tone `other`, **נכון, עם עזרה**, with no line;
  a wrong option shows as wrong.
- **Matching** keeps its board banner, counting helped words as not right (D8).
- No new copy.

---

## 2. Testing

- **Core:**
  - `takesHelp` lists twelve types (D10).
  - A helped `option_index` on each of the five is `is_correct: false` whatever the option; unhelped, it
    grades as today.
  - `helped` on new meaning or read aloud changes nothing.
  - The schema's `option_index` branch accepts `helped`.
- **Server (integration):**
  - A helped choice on each of the four choice types, and a helped matching word, is stored with
    `helped = true`.
  - Each grades as a wrong choice: evidence, memory grade, score and missed list.
  - Unhelped answers are unchanged.
  - A helped choice row is stored now that the check is dropped.
  - The existing "stores null on a card that takes no help" test moves to new meaning.
- **App (unit):**
  - `typedHelp`'s press rule:
    - the next step after a right start
    - marks from the first wrong character: a wrong letter, a missing letter, an extra letter, a capital, an
      accent, a curly apostrophe, Hebrew
    - disabled at the end
    - the grey hidden on a mismatch
    - marks cleared on any edit
    - a press that only marks makes the card helped
  - The choice rule-out: never the right option, at most down to two, deterministic.
  - Matching help:
    - it takes the selected word first, otherwise board order
    - the helped word is sent with `helped: true`
    - the board banner counts it as not right
  - Listen choice's letters.
  - Sentence translation has no button, and the target tap still makes the card helped.
  - `helped` in each route's body.
- **e2e:**
  - Move the phase 55 and 56 specs to the new controls: `help.spec`, `meaning-recall`, `sentence-cards`,
    `speaking`, `listening-variety`. They check the button inside the input, the grey letters and the marks,
    with the keyboard open.
  - Help on a choice card, on listen choice and on matching, with `helped: true` in the request bodies.
  - Sentence translation shows no help button.
  - Each card's help keeps its testID (D1).
- **Bots and the day simulation:** unchanged; they never press help.

---

## Left for Victor

1. Migrate lane 0 from the main checkout: `npm run db:migrate`.
2. After the merge, once the release reaches the phone (About shows the version), the phone check (Done 1,
   R10):
   - on a typed card with the keyboard open, the button is in view
   - the grey letters and the red marks line up with the typing
   - Anything off is a follow-up PR.

## Rulings

Victor, 2026-10-18, in the chat and the mockups:

- **R1. Placement:** help sits in the answer, not on a line of its own. On the typed cards the button is
  inside the input, and its letters show in grey inside the input after the typing (V4a). He chose it over the
  help line (A, A1–A3), the six looks V1–V8, the corner letters V4b and the blue ghost V4c, all shown in the
  mockups.
- **R2. The label:** it is always **עזרה**, with a line bulb before it (B1). There is no "+ אות", because help
  no longer only gives the next letter.
- **R3. Marking:**
  - Help marks only when pressed, never as you type.
  - A press with a mistake marks the first wrong letter and everything after it, and gives no letter.
  - A press with everything right gives the next letter.
- **R4. Sentence translation** gets no help button: tapping its Hebrew words already gives the Italian.
- **R5. (My call.)** Help compares with the one answer it reveals, so an accepted lemma or synonym is marked
  where it leaves that answer.
- **R6. Read aloud** gets no help: it already shows the word and plays it.
- **R7. Listen choice's help** shows the heard word's letters ("the letters on top of the sound"); it does not
  rule out options.
- **R8. Choice cards and matching:** help on a choice card rules out one wrong option per press. Matching
  help matches one pair per press, in blue. Both were approved in the all-cards mockup.
- **R9. (Assumed in the one-pager, kept.)** A helped answer on the new cards is a miss.
- **R10. The phone check comes after the merge,** not before. Android-only problems (the keyboard, the grey
  letters' alignment) are fixed in a follow-up PR.
