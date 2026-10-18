# Phase 62c — A gap card the checker refuses gets one rewrite

- **Status:** design agreed with Victor on 2026-10-18 (placement B, scope as played back: "agree");
  builder check done, its three questions settled as my calls (D1 budgets, D4, D6). Awaiting
  Victor's review of this document.
- **Date:** 2026-10-18
- **Source:** the brainstorming of 2026-10-18, started from the `test-eval` gap group failing on
  master since phase 62, and the earlier session's investigation that day (seven prompt rewordings,
  none kept; memory note `gap-eval-temperature-zero-lottery`).
- **Builds on:** phase 62 (a gap to choose writes its own sentence, ruling R7: refused when it fails,
  no fallback), phase 48 (a refused card is dropped, not the session; the checker's `gap` test),
  phase 34 (the checker, spares), phase 59 (the learner's words).
- **Touches:** `prepareSession` in `services/sessions.ts`, the batch prompt builder and validation in
  `domain/distractors.ts`, the checker's call (`domain/check.ts`, unchanged prompt), model call kinds
  (`services/llm.ts`), the prompt evals' gap runner (`tests/eval/run.ts`), unit and service tests.

---

## Goal

Since phase 62 a gap to choose (`cloze_choice`) writes its sentence per session from the learner's
words. With Victor's real list (io, ho, qui, ora, con, poi, ci sono…), the sentence for *fratello* is
"Io ho un fratello qui ora.", which any noun completes. The checker rightly calls tavolo / amico /
libro / gatto right, fewer than three wrong options are left, and the card is refused (R7). It
happens in his sessions, not only in the eval: lane 0's log at 12:11 on 2026-10-18 has
`card_dropped … cloze_choice … the checker calls 6 of q8's 6 wrong options right`.

Every Gemini call runs at temperature 0, so the same word with the same list gives nearly the same
sentence each session: the card is lost every time, not now and then. The same eval row is
`test-eval`'s gap group failure (13–15 of 16 against 14 needed, red on master runs 39081400074 and
39112109763).

This phase rescues such a card: it is rewritten once, told what was wrong with it.

## Why it happens

The batch prompt's learner-words rule lets the model add a word "where the sentence cannot stand,
or cannot point to the word, without it, and then a simple one (a pronoun, an article, a
preposition, or the verb to be or to have)". A word added to point to a noun can never be one of
those, so with a list of function words the model writes a sentence that points to nothing. The
typed gap shows the same fault ("Io ho un ___." → cane / gatto / libro in the pointing probe), hidden
there because its Hebrew hint gives the word away.

Rewording the prompt is not the fix. At temperature 0 any edit to the shared batch prompt re-rolls
every task in it at once. Of seven rewordings tried on 2026-10-18, the one that cleared the gap group
broke translate (a two-word Hebrew sentence, a tier-1 failure) and put *corretto* among *vero*'s
wrong answers.

## Goals, non-goals, anti-goals

**Goals**

- A gap to choose that fails is rewritten once, with feedback, and kept when the rewrite passes.
- No extra wait in a session where no gap card fails.
- The eval runs the same rewrite, so its gap rows measure what production shows.

**Non-goals** (Victor, 2026-10-18)

- The temperature. It is one setting for every text call, the checker and judges should stay at 0,
  and changing it with this would make the eval's results unattributable. A higher temperature for
  session generation alone, for fresh sentences per session, is a possible phase of its own.
- The typed gap's weak sentences, rescuing other choice cards, and the batch prompt's wording.

**Anti-goals**

- Any change to the batch prompt as the session's main generation call sends it. A byte-for-byte
  difference re-rolls every task (above).
- Lowering `TIER2_THRESHOLD`, loosening an eval assertion, or skipping or deleting a case.
- A session that fails because the rescue failed, or waits for a failing rescue longer than the
  rescue's own short budget (D1).

## Design

### D1. The call sequence (placement B, Victor)

```
Today:  generation → word maps → checker

62c:    generation → word maps ───────────────────────────────┐
                   → gap check → [rewrite] → [validate] ───────┴→ checker
                                                              (+ the rewritten cards' word maps beside it)
```

- **The gap check** runs beside the word-map call (the context call), both started once the batch
  is validated. It is the checker's call, as `buildCheckPrompt` builds it today, with only the
  session's gap-to-choose items: the same `gap` item the final checker asks today (the sentence
  with `___`, `candidatesOf` the card, at most `ASKED_DISTRACTORS`). Its prompt is unchanged.
- **The rewrite** waits for the gap check, and runs only when a card needs it (D2). One call for
  every such card of the session.
- **The final checker** waits for the word-map call and the rewrite. Beside it runs a second,
  small word-map call for the rewritten cards only (D4).
- When no card needs a rewrite, the session waits for nothing new: the gap check (a few items) ends
  inside the word-map call (15–33 s on lane 0, 2026-10-18).
- **Budgets** (my call, from the builder check). The gap check and the rewrite each get a client
  and a timeout of their own (`composition.ts`, `config.ts` beside `checkerCallTimeoutMs`), not the
  checker's 60 s and the batch's 120 s: those would let a hung rescue hold a session for minutes. The
  builder measures both calls over the eval runs and sets each budget at about three times the
  slowest seen, between 20 and 60 s. The rewrite's client keeps the batch's thinking budget
  (`SESSION_GENERATION_THINKING`). Every call the attempt adds, the second word-map call included,
  adds its budget to `PREPARE_SESSION_CALL_BUDGETS_MS`, as `domain/jobs.ts` requires, so the job's
  expiry rises with them. Not a deadline tied to the word-map call's end: that would drop rescues at
  random, by another call's speed, and the eval could not measure it.

### D2. Which cards are rewritten

A `cloze_choice` card is rewritten once when, before the final checker:

- **validation refused it** (`validateDistractors`: an unusable sentence, a sentence it was told to
  avoid, fewer than three usable wrong options…), with validation's reason as the feedback (my call,
  agreed in the play-back: lane 0's log also shows a gap card dropped for repeating a sentence it was
  told to avoid); or
- **the gap check leaves it fewer than `KEPT_DISTRACTORS`** wrong options, with the options it called
  right as the feedback.

A card the gap check left unjudged (a miscount, phase 48 R3) is not rewritten: its gap item goes to
the final checker as today (my call: a miscount is no fault of the sentence).

### D3. The rewrite call

- **Kind:** a new `ModelCallKind`, `gap_rewrite`, on its own client (D1's budgets). The gap check is
  a new kind too, `gap_check`, on its own client. The second word-map call is the context call's
  `context` kind. `kind` is plain text in `model_calls`, so no migration.
- **Prompt:** `buildDistractorPrompt` with the rewritten cards' gap items. The rewrite's instruction
  is added to the system prompt **only when an item carries a rewrite**, so the main call's prompt is
  exactly today's (a unit test pins this, D7). Each item says:
  - its old sentence, which is also added to its `avoid`;
  - what was wrong: the wrong answers that fit its gap ("tavolo, amico, libro, gatto make 'Io ho un
    ___ qui ora.' correct"), or validation's reason;
  - R5's order, restated for this item: the sentence points to its word first, so that its wrong
    answers clash with it; then short; then the learner's words, kept wherever pointing allows them.
    It may add a word from outside the list where pointing needs it (lifting, for this item only, the
    "simple one" limit that *Why it happens* describes). It does not drop the list: *"Mio fratello è qui ora."* points
    (Italian drops the article only before a family noun, so *mio tavolo* is wrong) and is two-thirds
    list words.
- **Same input as the item had:** the session's learner words, `also_in_session` from the session's
  other rows and items, so the cross-item rules still hold.
- **Validation:** `validateDistractors` on the rewrite's answer, with the session's whole item set
  and `others` as the main call has them, so a rewrite's wrong answer cannot be another item's right
  one. Exact plumbing is the builder's.

### D4. After the rewrite

- **A rewrite that validates** replaces the card's generated content (sentence, wrong options,
  spares). Its gap is asked of the final checker, and its word-map item goes to the second word-map
  call (D1). Then it is judged as any card is today: fewer than three left is refused at the
  `checker` stage, and a short or question-types session keeps it as the ambiguous card (phase 48
  D3, phase 61 D5), with the rewritten content.
- **A rewrite that fails** (the call fails or is unreadable, or validation refuses the item) leaves
  the card as it was, with its original refusal and stage. It never fails the attempt (my call:
  the rescue is extra, and pg-boss retrying the attempt at temperature 0 would repeat it).
- **A gap card the gap check passed** keeps the gap check's finding and is not asked again by the
  final checker (Victor: "aren't asked again").
- **The gap check failing** (an error, a timeout, an unreadable answer) rescues no card it would
  have judged: its gap items go to the final checker exactly as today. Cards validation refused
  are rewritten all the same, since they never needed the gap check (my call, from the builder
  check).
- **The second word-map call failing** leaves the rewritten card without a map, as a failed
  word-map call leaves any card today.

### D5. What the logs say

- `gap_rewritten`, once per rewritten card, when the session is written (as the other card events
  are): `session_id`, `index`, `key`, `reason` (`validation` or `checker`, with the detail),
  `old_sentence`, and `new_sentence` or, when the rewrite did not rescue it, `failed` with why.
- `session_prepared` gains `gap_check_ms`, `rewrite_ms` and `rewrite_count` (zero when none).
- The `model_calls` rows carry the two new kinds, so a rewrite's prompt and answer can be read back.

### D6. The eval mirrors it

- `survivesChecker` (`tests/eval/run.ts`) runs the same rescue production runs, through the same
  domain functions (no copy of the logic): validate, check, rewrite once with feedback what
  validation refused or the check left short, validate, check again.
- **Tier 1 reads the first answer, exactly as today** (my call, from the builder check). The batch
  prompt is unchanged, so its output must still pass unaided: a validation refusal in the first
  answer still fails tier 1, rescued or not. A rewrite's answer must also pass the same tier-1 checks
  (every wrong option in the target's script). This only adds checks.
- Every tier-2 check of a gap row (the checker's survivors, the list share, the rest) reads the
  sentence the card would show: the rewritten one when there is one. An item left with no usable
  card after the rescue counts as a failed survivor check, where today it is skipped and the group's
  denominator shrinks below 16 (tightening, never loosening).
- The row prints both sentences when a rewrite happened, so a report shows what was rescued.
- Acceptance: the gap group at 14 of 16 or more in three local runs and in CI; the full suite run
  and compared row by row with master's report (memory `prompt-change-compare-master-report`); no
  tier-1 failure. If the rewrite trades the checker's failure for the list-share check's, bring it to
  Victor. Do not loosen either.

### D7. Tests

- **Unit (`domain/`):** `buildDistractorPrompt` with no rewrite items returns exactly today's
  prompt (a snapshot or a string pinned from master); with one, its system prompt adds the
  rewrite rule and the item carries the old sentence, the feedback and the old sentence in `avoid`.
  What turns a refusal or a gap finding into a rewrite item, as a pure function.
- **Service (`sessions.prepare.test.ts`, fakes):** the sequence (the gap check started beside the word
  maps, the final checker after the rewrite); a rescued card written with its new sentence and map;
  a rewrite that fails leaving the card refused as today; a gap check that fails sending its items to
  the final checker, while a card validation refused is still rewritten; no gap card, no gap check;
  a card the gap check passed not asked again; the expiry including the new budgets.
- **Integration (`sessions.test.ts`, MockServer):** one rescued card end to end, if the existing
  expectations can be extended without fragility (builder's call).

## Rulings

- **R1 (Victor, 2026-10-18).** Placement B: the gap check beside the word maps, the rewrite only when
  a card fails, the final checker after it.
- **R2 (Victor, 2026-10-18).** The temperature stays at 0 in this change.
- **R3 (Victor, 2026-10-18, play-back).** The scope of D2–D6 as played back, validation refusals
  included; a card that fails twice is refused as today.

## Left to the builder

- How `prepareSession` is split to run the two pairs of calls side by side (`Promise.all`, with no
  transaction open, ADR 0001 R8), and where the rescue's pure parts live in `domain/`.
- The rewrite rule's exact wording, within D3, judged by the evals (D6).
- The `gap_rewritten` event's field names beyond those in D5.
- Whether the integration test is extended (D7).
