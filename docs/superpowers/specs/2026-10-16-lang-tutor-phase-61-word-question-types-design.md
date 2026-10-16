# Phase 61 — Every question type for one word

- **Status:** Victor scoped it in a one-pager on 2026-10-16, then said "go till PR": every
  decision below is self-approved (CLAUDE.md, *Continue till PR*). Branch
  `phase-61-word-question-types`.
- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-16-word-question-types-session-one-pager.md` (main checkout).
- **Builds on:** phases 23, 24, 27 (question types), 35 (question choosing, `plan.ts`), 43 (stock
  and started sessions), 53 (stale stock replaced), 58 (word page).
- **Touches:** the users table and `/api/me`, core's wire schemas, a new domain module, the
  vocabulary and sessions routes and services, `prepareSession`, the db CLI, the app's word page,
  a new app screen, the results screen, e2e.

---

## Goal

Victor and other testers cannot see how a given word comes out in each question type: the picker
decides which types appear and when. This phase lets a tester start, from a word's page, a session
with one card of each question type they choose for that word, answered as usual, and see which
types the word cannot have and why.

**Done means** (one-pager): from a word's page a tester starts a session with one card of each
question type the word supports, goes over every card and answers it as usual; a type the word
cannot support is shown as skipped, not silently left out.

## Scope

**In:** a tester flag per account, set by a CLI command (D1); a read of which question types one
meaning of a word can have, with a reason for each that cannot (D2); a session built from the
chosen types (D3–D5); an app screen to choose them, reached from the word page (D6); generation
failures shown on the results screen (D5).

**Out** (one-pager): more than one word per session; a preview mode where answers do not count;
learners seeing the action.

## Decisions

**D1 — A tester is a flag on the user.** Migration adds `users.tester boolean not null default
false`. `UserSchema` gains `tester: boolean` (an added response field, so `API_LEVEL` stays, ADR
0012). It is turned on and off only by `npm run db:tester -- --email <address> [--off]` (db CLI,
like `db:claim-account`), run by Victor against prod with `DATABASE_URL="$PROD_DB"`. The flag is
global, not a grant role: ADR 0008's grants say what one learner lets another do on an enrollment;
this says what the account may do in the app. The two new endpoints check both: the enrollment's
`session.practice` (owner) through `authorizeEnrollment`, and then `tester`, else 403
`not_a_tester`.

**D2 — The unit is one meaning of the word.** The word page lists senses; a session needs one gloss
and one rendering per card. The action sits on each *saved* sense (gloss + variant): only a saved
gloss has progress for the answers to count against, which is what Victor asked for.

```
GET /api/enrollments/{id}/vocabulary/question-types?gloss_id=&variant_id=&listening=&speaking=
  200 { sense_id, types: [{ type: QuestionType, available: boolean, reason?: UnavailableReason }] }
```

*(Builder check, my call.)* A gloss can merge several dictionary senses, and the type rules read
one rendering (its `answer_form`, its example). So the read fixes one: the rendering of that
variant the picker ranks first (`askableRenderings`, lowest rank), chosen by one function both
calls use. It returns that `sense_id`, and D3 sends it back, so the read and the session cannot
disagree. A word page example from another member sense can therefore sit beside `no_example_gap`;
the reason's copy says "this meaning's example".

All 15 types, in one fixed order (D4). The rule is a pure domain function,
`questionTypesFor(word, devices)`, which reuses `plan.ts`'s per-pick flags (`tiles`, `speakable`,
`clozeGap`, `knownMeanings`) and drops the rules that exist for the picker's pacing, not for what a
word can be asked as:

| Type | Unavailable when | Reason |
|---|---|---|
| `listen_choice`, `dictation` | the device has no voice for the target | `no_voice` |
| `read_aloud`, `say_translation` | the device cannot record | `no_microphone` |
| `read_aloud`, `say_translation`, `cloze_typed`, `sentence_translation` | not speakable (more than 4 spoken words) | `too_long` |
| `letter_tiles` | `tileEligible` fails | `no_tiles` |
| `cloze_choice` | no dictionary example with exactly one gap | `no_example_gap` |
| `new_meaning` | no other gloss of the same word is saved in the enrollment | `no_other_meaning` |
| `matching` | always: a board needs 7 words | `needs_more_words` |

Dropped: `READ_ALOUD_MAX_LEVEL` (read aloud only at low levels), `speaking && picks.length > 1`,
`MAX_PER_TYPE`, and the forced multiple choice for a new word. *(Builder check, my call.)* The
picker's `introductions` (a never-practised gloss whose sibling is fully known) would make
`new_meaning` unavailable for almost every sense a tester opens; here the card lists the word's
other saved glosses' meanings, whatever their stability. `meet`, `multiple_choice`,
`reverse_choice`, `typed_translation`, `typed_meaning` are always available.

**D3 — Starting one.**

```
POST /api/enrollments/{id}/question-type-sessions
  { gloss_id, variant_id, sense_id, types: QuestionType[] (min 1, no repeats), listening, speaking }
  201 { session_id, status: 'preparing' }
  400 a type unavailable by D2, or the gloss not saved      403 not owner / not a tester
  404 no such enrollment or gloss
  409 a started session is open (SessionOpen), or the open stock is the seed
```

In one transaction, under `lockNextSession`: a started session is a 409, as in
`createNextSession` (finish or leave it first). An open stock session is retired the way phase 53
replaces a stale one, and the test session is inserted in its place as the stock (`preparing`,
not started), with `kind = 'question_types'` (new column `sessions.kind text not null default
'practice'`, checked). `source` stays `'list'`: `source` is on the wire as an enum, and a new value
would break an older app that reads the session. Then `PREPARE_SESSION` is enqueued (ADR 0007)
with the picks and `question_types: true`. Answers, start, completion and progress are the existing
session calls, unchanged: answers count. Starting it asks for the next stock as usual.

**D4 — One card per chosen type, in a fixed order.** Each pick is the one gloss, with the type
fixed and the dimension and rung that type tests (`RUNGS`; `meet` and `new_meaning` as the ladder
and the family introduction build them). Order: `meet` first, then each dimension's recognition
type before its recall type, as the type list in `plan.ts` already reads (the builder fixes the
exact list once, in the domain module, and both the read and the session use it).
`PrepareSessionPayloadSchema` gains an optional per-pick `type` and a `question_types` flag; when
set, `prepareSession` skips `planCards` and builds exactly those cards, and the picks' maximum is
the number of types rather than `SESSION_LENGTH`. `dropLoneMeets` does not apply: a session of
`meet` alone is allowed (it grades nothing).

**D5 — A card that cannot be generated is dropped and named.** In a question-types session there
is no fallback: a `cloze_typed` or `sentence_translation` with no usable sentence, or whose
sentence the checker rejects, is not turned into `typed_translation`; a choice card short of
distractors is not kept; and `keepCards`'s `MIN_SESSION_CARDS` does not apply. *(Builder check, my
call.)* A choice card the checker finds ambiguous is kept as generated, other right options last,
as `keepCards` already keeps one: seeing it is what a tester is there for. The dropped types are stored on the session
(`sessions.skipped_types jsonb`, `[{type, reason: 'not_generated'}]`, null for every other
session) and returned as an optional `skipped_types` on the session read. If every card is
dropped, `prepareSession` marks the session `failed` at once (through `failPreparation`, with
`skipped_types` written), not by throwing: a throw would be retried, paying for the model calls
again, and leave the screen polling. A model or network error still throws and retries as today.
The question-types screen shows a failed session's `skipped_types` itself. The results screen lists them under a
"not generated" heading.

**D6 — The app.** On the word page, each saved sense shows a "test question types" link when
`me.user.tester`. It opens `vocabulary/question-types` (gloss and variant in the params), which
reads D2 with the device flags from `voicesRead`/`canRecord` and lists every type: available ones
ticked by default and untickable; unavailable ones greyed with their reason. "Start" posts D3,
waits for `ready` by polling the session read, then `enter`s it and pushes `/session`, as
`LearningSection` does. A 409 says a session is in progress. All copy is Hebrew (forceRTL), each
type with a short Hebrew name.

**D7 — While it waits as the stock.** *(Builder check, my call.)* It is the enrollment's stock
like any other, so the flows that retire a `'list'` stock (a target changed, a word unsaved or a
level removed) retire it too, and Home offers it as the next session if the tester backs out
before it is ready. Both are acceptable for testers and need no code outside the new paths. An
unstarted seed cannot be retired (`retireStock` refuses it), so D3 answers 409 and the app says to
play the first session first.

## Testing

- **Unit:** `questionTypesFor` — each reason in D2's table, and the dropped pacing rules.
- **Integration:** both endpoints — 403 for a non-tester and for a grantee, 400 for an unavailable
  type, 409 with a started session, the stock retired and replaced; `prepareSession` with
  `question_types` builds exactly the chosen cards in D4's order, drops a card that fails
  generation into `skipped_types`, and does not fall back; completing it records progress as any
  session does; the `db:tester` command turns the flag on and off.
- **e2e:** a tester saves a word, opens its page, sees the link (a non-tester does not), ticks the
  types, starts, answers every card, and the results screen shows them.
- No prompt changes, so no eval changes.

## Left to the builder

The Hebrew names and reason copy; the exact type order within D4's rule; how the screen polls.
