# Phase 48 — A session survives a bad card

- **Status:** Scoped with Victor on 2026-10-14 (one-pager, four scope answers, then two changes:
  no spare card and no repair; at least 6 cards, filled with refused ones). Then "continue till
  PR, subagents": the design below is self-approved (CLAUDE.md, *Continue till PR*). Rulings are
  at the end.
- **Date:** 2026-10-14
- **Source:** the one-pager `drafts/2026-10-14-session-survives-one-card-one-pager.md` and the
  brief `drafts/2026-10-13-session-fails-on-one-card-brief.md` (both gitignored; restated below),
  and lane 0's failed stock `38b003b4` of 2026-10-13, read from `model_calls`.
- **Builds on:** phase 34 (the checker, D3–D5, D10), phase 27 (the degraded typed translation),
  phase 43 (the stock, R4), phase 47 (`model_calls`).
- **Touches:** `validateDistractors` and `readCheck` (per card instead of all or nothing); a new
  pure domain module that chooses which cards a session keeps; `prepareSession`; the generation
  prompt's wording; four eval cases and one eval check. No migration, no wire change, no app
  change.

---

## Goal

After generation, code validation and then a second model (the checker) refuse wrong options
that are really right. When one choice card keeps fewer than 3 wrong options, the whole attempt
throws. Generation and the checker both run at temperature 0, so pg-boss's two retries repeat
the same answers, and the session ends `failed`. In production, 3 sessions of 168 failed this way
(2026-10-11 to 10-13), and 9 lost one or more attempts of 30–60 s each.

Lane 0's stock `38b003b4` (2026-10-13 21:34) is the case at hand. q10, a gap card for *cream*,
reads "I like to put ___ in my coffee." The generator offered `sugar, salt, oil, water, bread,
fruit`, and the checker said four of them fit, correctly under its rule. Three attempts gave
byte-identical answers. The generator broke its own gap instruction ("prefer a word that
clashes … over a plausible neighbour"), and the prompt's general rule, "each wrong answer must be
plausible", pulls the other way.

**Done means:**

1. No session fails because of a card's content (a choice card, a gap card, the board's fifth
   meaning). Only transient errors fail an attempt.
2. Every session has at least 6 cards (or every planned card, when fewer than 6 were planned).
3. A deterministic refusal costs no retry: the `cream` case prepares in one attempt.
4. The eval shows the prompt fix lands: `cream` and `vero` get wrong options the checker
   accepts, and `TIER2_THRESHOLD` is not lowered.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and the eval pass.

## Scope

**In:** per-card verdicts from validation and the checker (D1, D2); the choice of kept cards,
with the floor of 6 (D3); writing the kept cards (D4); what still fails an attempt (D5); the
events (D6); the prompt (D7); the eval (D8).

**Out:**

- repairing a refused card, and a spare card to keep the session at 10;
- remembering that a rendering cannot be a choice card (brief direction 3): a dropped word stays
  due and may be picked the same way next time;
- changing the checker's prompt or rules;
- sentence cards and context sentences: they already degrade (phase 27, phase 34 D6–D8);
- reading back the production sessions of the brief.

---

## D1. Validation refuses a card, not the batch

`validateDistractors` stops returning `{ ok: false }`. It returns every item's verdict:
`{ byKey, refused }`, where `refused` maps a key to the reason (the same reason strings as
today: `"q4 offers a wrong answer in the explanation language … (0 of 6 usable, 3 needed)"`).

- A choice item (`meaning`, `word`, `gap`) with fewer than 3 usable wrong options is refused.
- A choice item the model did not answer is refused: `no answer for qK`.
- A typed item the model did not answer keeps no alternatives. A typed item cannot fail, as the
  function's own comment says.
- Sentence and translate items are unchanged: they come back `degraded`.

The board's fifth meaning (`boardMeanings` before the checker, `sessions.ts` ~L1085) works the
same way. When the board's first word is refused or no fifth meaning is usable, the **board** is
refused, all four words together (ruling R2).

A refused card is sent to neither the context call nor the checker: nothing it would show is
known to be good.

## D2. The checker refuses a card, not the attempt

A choice or gap card (or the board) that keeps fewer than 3 wrong options after the checker's
"yes" answers is refused, with today's reason string (`the checker calls 4 of q10's 6 wrong
options right, and 3 must be left`), instead of throwing.

`readCheck` stops refusing the whole answer when one choice or gap item is missing or miscounted
(`the checker did not say which of qK's N options are right`). That card is refused by the
checker, and the rest of the answer is read as usual (ruling R3). An answer that is empty or
unreadable as a whole still fails the attempt (D5).

## D3. Which cards a session keeps

A new pure module, `domain/keepCards.ts`, decides. It needs no I/O, and the service's `rng`
draws its random choices (ADR 0001 R3: no `Math.random` in `domain/`).

- **Units.** A single card is a unit, and the board is one unit of four cards.
- **Pass.** Every unit that neither D1 nor D2 refused is kept.
- **Floor.** `MIN_SESSION_CARDS = 6`. The target is `min(6, planned cards)`. Cards are counted
  as written questions: the board counts as four (ruling R4).
- **Fill.** When the passed cards are fewer than the target, refused units are added in random
  order until the target is met. Units the checker refused go first, then units validation
  refused. A unit is added whole, so the board can overshoot the target.
- **What a filled unit shows.**
  - *Refused by the checker:* the card as generated, with its first three validated wrong
    options. The survivors go first, then the ones the checker called right, in the model's
    order. This is Victor's call: an ambiguous card is better than a failed session. A filled
    board takes the fifth meaning validation chose, without the checker's filter.
  - *Refused by validation:* a `typed_translation`, phase 27's degraded card (ruling R1). It has
    no three wrong options it could show: they are missing, repeated, in the wrong script, or
    known right. It is built as the checker's degraded sentence card is today (`typedAnswered`
    over nothing generated, with the saved example's explanation context).
- **Everything else** that was refused is dropped. Its word is treated as not asked. Nothing is
  written for it, and "asked" is read only from written questions and answers (`session_questions`,
  `answers`), so nothing needs undoing. A dropped `new_meaning` is offered again in a later session.

Its result is, per plan index, `keep`, `keep_as_typed` or `drop`, with the reason and stage of
each refusal.

## D4. Writing the kept cards

The cards keep the plan's order. Dropped ones leave gaps, which are closed up, so written
positions stay contiguous (`insertSessionQuestions` writes the array index, and `answers` and
`loadSession` index by position). Inside `prepareSession`, a card keeps its plan index for
everything that indexes the plan (`gaps[index]`, `read.picked[plan.order[index]]`, the board's
`own`). Only the written position is renumbered. The board stays contiguous because it is kept or
dropped whole.

A plan's board is decided on the planned picks (`BOARD_MIN_PICKS = 7`). A session that drops
cards keeps its board even if it ends with fewer than 7 cards. That is accepted: it is rare, and
the board stays playable.

## D5. What still fails an attempt

Only what a retry can change:

- a model call that throws (provider error, timeout): generation or the checker. The context call
  already never fails;
- an empty or unreadable generation answer, or an empty or unreadable checker answer;
- a pick whose dictionary rows are all gone, and a pick in another learner language (unchanged).

pg-boss's policy is unchanged (`retryLimit: 2`). It now sees only these errors.
`InvalidDistractors` stays as the error for an unreadable answer.

## D6. Events

- **`card_dropped`**, per dropped card: `session_id`, `key` (the plan's `qK`, which is the key in
  `model_calls`), `type` (as planned), `stage` (`validation` or `checker`), `reason`.
- **`card_kept_refused`**, per card a fill kept: the same fields, plus `position` and `shown_as`
  (`as_generated` or `typed_translation`).
- **`session_prepared`** gains `planned_count` and `dropped_count`. Its `question_count` is now
  the count written, no longer the picks' count.
- The existing per-card events (`checker_dropped`, `context_dropped`, `sentence_degraded`,
  `context_missing`) are logged only for written cards. Their `position` is the written position,
  which until now always equalled the plan index, and they gain `key`. A card kept as generated
  by a fill logs no `checker_dropped` for the options it still shows.

## D7. The prompt

Two changes to `buildDistractorPrompt`. The final wording is whatever the eval (D8) shows lands.
`DISTRACTOR_MARKER` ("six wrong answers") stays, since MockServer matches on it.

- **Gap.** The general rule "each wrong answer must be plausible: the same part of speech, the
  same register and a similar length" moves under `meaning` and `word` only. A gap's wrong answers
  stay the same part of speech and form, but must come from a different field than the blanked
  word, so a learner reading the sentence alone can rule each one out. The prompt says outright
  that a sentence with an open slot (anything one puts in a drink, any adjective for a city) must
  not get the slot's other fillers.
- **Broad words.** For `meaning` and `word`: when the word is broad (*true*, *real*, *good*,
  *thing*), its near neighbours are right in some use, so wrong answers come from another field
  of meaning.

## D8. The eval

- **`cream`**, in `GAP_CASES` (en): *I like to put cream in my coffee.* Its `fits` list holds the
  slot's other fillers (sugar, milk, honey, salt, water, oil, cinnamon, butter, syrup, ice,
  whiskey, chocolate, cocoa, vanilla, caramel, lemon, spice). Tier 2: no wrong option fits.
- **`vero`**, in `DISTRACTOR_CASES` (it → he): a `meaning` item (vero → אמיתי) and a `word`
  item, each with its known right answers as `synonyms`. Tier 1 already refuses Hebrew options on
  the word item (the 9cb1b1a8 failure).
- **Through the checker.** Both new cases carry `checked: true`. After generation, the eval sends
  each choice and gap item to the real checker, built as `prepareSession` builds it, and adds a
  tier 2 check: at least 3 wrong options survive. This is production's rule, and it measures
  Done-means 4 directly.
- **The checker itself.** A `CHECK_CASES` row for the cream gap: `sugar` fits, `chair` and
  `music` do not. It guards the checker's correct verdict, which this phase must not loosen.

Acceptance: the gap group and the new cases pass tier 2 in 3 of 3 runs, the generation rows'
tier 2 is not lower than on master over the same runs, and the whole run stays at or above
`TIER2_THRESHOLD`.

---

## Testing

- **`domain/keepCards.test.ts`:** everything passes; one dropped; the board dropped as a unit;
  the floor met by checker-refused units first, then validation-refused ones as typed; the board
  overshooting; fewer than 6 planned; the same `rng` giving the same choice.
- **`domain/distractors.test.ts`, `domain/check.test.ts`:** per-card refusals with today's
  reasons; a missing typed answer keeps no alternatives; a miscounted checker item refuses only
  its card.
- **`services/sessions.prepare.test.ts`:** the "fails the batch" tests become "drops the card":
  the session is `ready` with N−1 contiguous positions and a `card_dropped` event. Also: a
  refused board drops four; a fill keeps a checker-refused card with survivors first; a fill
  turns a validation-refused card into a typed translation; unreadable answers and provider
  failures still throw.
- **Integration (MockServer, ADR 0004):** in `prepareSession.checker.test.ts`, the cream case on
  a choice card, which takes the same refusal path as a gap card. A checker answer calls every
  option of one card in seven right, and the session is prepared in one attempt (one generation
  request) with the other six. The gap card's path is pinned in the unit tests. The existing "checker returns 500" test
  still leaves the session `preparing` for a retry.
- **e2e:** no new spec. The stubs are all good, so every existing spec must pass unchanged.
- **Eval:** D8, run locally three times (`npx tsx tests/eval/run.ts <filter>`), and the full run
  once.

---

## Rulings

- **R1. A validation-refused card fills as a typed translation, not as generated.** Victor chose
  ambiguous cards over a failed session. A validation-refused card's options are not ambiguous,
  they are broken (missing, repeated, wrong script, or known right), so it is shown as phase 27's
  degraded card instead. This keeps Done-means 1 and 2 without ever showing broken options. The
  fill is needed when fewer cards are left than the target: 6, or every planned card when 6 or
  fewer were planned. With 10 planned that takes 5 or more refused; with 6 or fewer, one. A board
  refused at validation in a session of 7 to 9 cards needs it too, and is filled as four typed
  translations, words that are usually new to the learner. These cases are rare: validation
  refusals were 1 of the 16 failed attempts in production, and short sessions come from short
  lists, which are new learners. The alternative, dropping a validation-refused first meeting even
  below the floor, was left for Victor.
- **R2. The board is one unit.** Its fifth meaning is shared by four words, and `withBoards`
  rebuilds a board from any run of matching rows. Dropping one word would silently leave a
  three-word board.
- **R3. A checker item it miscounted refuses that card only.** At temperature 0 a retry repeats
  the miscount, so failing the attempt only adds waiting. The rest of the answer is aligned by key.
- **R4. The floor counts written questions.** The server's `total`, the progress bar and the score
  all count questions, and a board is four of them.
- **R5. Event positions are written positions.** Anyone reading events against the stored
  questions matches them by position. Until now the plan index and the written position were
  always equal.
  `key` is added so an event can also be matched to its `model_calls` request.
