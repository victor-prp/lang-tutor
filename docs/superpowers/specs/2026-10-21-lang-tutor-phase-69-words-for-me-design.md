# Phase 69 — Words for me

- **Status:** Scoped with Victor in a one-pager on 2026-10-21, then he said "go till PR" (CLAUDE.md,
  *Continue till PR*): the design is self-approved. Lines marked **(Victor)** are his; **(my call)**
  lines are mine; **(assumed)** lines are the one-pager's assumptions he did not strike.
- **Date:** 2026-10-21
- **Source:** `drafts/2026-10-21-words-for-me-one-pager.md` (main checkout).
- **Builds on:** phase 26 (a photo import's rows, their lookup job and review), phase 54 (a new word's
  meet card), phase 64 (מילים, the look), phase 27 (the meaning judge).
- **Touches:** three new tables, ten endpoints, one job, one prompt and its eval group; the app's
  מילים tab and one new screen; integration, unit and e2e tests.

---

## Goal

**(Victor)** An adult or a kid wants the app to add words for them: their list ran out, or adding words
one lookup at a time is too slow. Today a word reaches practice only when someone brings it: a lookup,
a photo, a tutor or a target's list.

The flow **(Victor)**: the app asks a few questions about the learner's level. It shows rounds of 10
cards, one word or phrase each in the target language; on each the learner taps "Don't know" or
types the Hebrew meaning. Each round follows the answers so far, until the app holds as many words the
learner didn't know as they asked for (15 by default). It then shows them as a list; the learner
unticks the ones they don't want and taps Continue, and the rest join their list.

**Done means:**

1. **(Victor)** His manual test: from a list that ran out, the words he keeps appear in מילים and come
   up in his next sessions with the meet card.
2. **(assumed)** Unit, integration and e2e tests prove D1–D10; the eval group `discover ` passes;
   `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Non-goals (the one-pager's Out)

- Picking a topic; adding to a homework or test target; adding words the learner translated right;
  sound on the cards; a tutor running it for a student.
- Measuring whether the words fit the level **(Victor: "we can't know now")**. The eval checks shape,
  not level.
- Using the stored answers beyond this flow **(Victor: "we will use it in the future")**.
- Changing a remembered level **(assumed)**: the profile is written once; only the flow's own level
  moves it (D3).

**Anti-goals** (my call): a known word on the list because the check was strict without a judge; a
proposed word the learner already has or already answered; a round that waits on lookups.

## Decisions

### D1. Where it starts **(assumed: any time from מילים)**

A pale button under מילים's title, "מילים חדשות בשבילי", and the same button in the empty list's
state. It opens one full screen, `app/discover.tsx`, over the tabs (no bar), with `ScreenHeader`'s ✕.
The screen's steps: questions (first time only) → how many → cards → list. Leaving with ✕ keeps the
run; opening the screen again resumes it at its step (D8).

### D2. The questions **(Victor: a few questions about the level; the answers kept in the DB)**

Asked once per enrollment, stored in `discovery_profiles` (D9). Two questions, one screen each, as a
column of `OptionButton`-like rows (my call: two, and age taken from the profile, `users.age`, rather
than asked again):

1. **"כמה {שפה} אתם כבר יודעים?"** → `self_level`:
   `none` "כמעט כלום", `basic` "מילים בסיסיות", `simple` "שיחה פשוטה", `everyday` "רוב שיחות היומיום",
   `fluent` "מדברים בחופשיות".
2. **"איפה אתם לומדים {שפה}?"** → `learning_context`:
   `school` "בבית הספר", `course` "בקורס או עם מורה", `self` "לבד", `family` "בבית או עם המשפחה".

Both shape the prompt (D4): the level its band, the context and the age which words.

### D3. The level, and how a round moves it (my call)

A level is an integer 1–12, two per CEFR band: 1–2 A1, 3–4 A2, 5–6 B1, 7–8 B2, 9–10 C1, 11–12 C2, the
odd one "the lower half of" the band and the even one "the upper half". The first level comes from
`self_level`: none 1, basic 2, simple 3, everyday 5, fluent 7.

When a round closes, from the share of its answered cards the learner knew: ≥ 0.8 → +2, ≥ 0.6 → +1,
> 0.2 → 0, > 0 → −1, 0 → −2, clamped to 1–12. Aim: about half known, the edge of what they know.
Fewer than **4** answered cards keep the level: a round cut short after two cards says too little.
Pure, in `domain/discovery.ts`.

A round closes when the next round is written, or when the run moves to its list (the goal reached
mid-round, לרשימה, or the round cap), whichever comes first (builder check). The new level is written to
the profile in that transaction, and the run records the round it settled (`settled_round`), so a
round moves the level once. The next run starts there and skips the questions **(Victor: the level
is remembered)**.

### D4. A round: what the model is asked (my call)

`buildDiscoveryPrompt({ target, level, age, learningContext, exclude })` in `domain/discovery.ts`,
with the marker `propose new words for a learner` for MockServer. It asks for **14** words or short
fixed expressions (mostly single words, in dictionary form, no article) at the level's CEFR half-band,
fit for the age and the context, none in `exclude`, each with:
`{ word, part_of_speech (enum, the dictionary's), hebrew (the main meaning), alternatives (other right
Hebrew meanings, possibly empty) }`. Every field required, no optional strings (memory: they hang).

`exclude` is every word the enrollment's learner answered in any run **(assumed: a later run never
proposes a word already answered)**, every word of this run, and the lemmas of its saved words, newest
first, at most 400 in the prompt. A word a run proposed but never showed (it ended mid-round) may come
again (builder check, my call).
`parseDiscovery` drops a word in Hebrew script, an empty or over-long one (`MAX_ITEM_LENGTH`), a
duplicate, and any match of the whole exclude set (lower-cased `normalizeForm`), then keeps the first
**10**. Fewer than 10 is a shorter round; none ends the run (D8).

A client of its own in `composition.ts` (`discover`), thinking budget measured in the plan (0 or 512),
timeout 20 s; `ModelCallKind` gains `discovery`. Unreadable → `LlmUnavailable` (503), and the app
offers נסו שוב.

### D5. A card's answer **(Victor: "Don't know" or the Hebrew)**

- **"אין לי מושג"** (a neutral "Don't know"): unknown.
- **Typed:** `wrongScript(text, source)` first, a 422 as a session's, nothing recorded. Then
  `meaningRuleVerdict(hebrew, text, alternatives)`: `exact` is known. Else the meaning judge
  (`buildMeaningJudgePrompt`, the session's `judge` client, kind `judge`) with the word, its part of
  speech and `hebrew` as the meaning, no example: `exact` or `alternative` known, `wrong` unknown.
  **(assumed)** A wrong translation counts as "Don't know". A judge that fails counts as unknown and
  is logged (my call): the list's untick is the way back.
- The answer, the typed text, the verdict and who gave it (`rule`, `model`, `unavailable`) are written
  on the card **(Victor: kept in the DB)**. A card answered twice answers the first verdict again.
- An unknown card enqueues its lookup (D7) in the answer's transaction. When the unknown count reaches
  the goal the run moves to its list (D8), mid-round if so **(Victor: once it has 15, it shows the
  list)**.

What the app shows (my call): after a typed answer, the verdict line ("✓ נכון" green, or "לא בדיוק —
{hebrew}" orange) and a big הבא; after "אין לי מושג", the next card at once. Above the card: "נמצאו
{n} מתוך {goal} מילים". While a round is fetched: "מחפשים מילים בשבילכם…".

### D6. How many **(Victor: the learner chooses, 15 by default)**

Before the first round of a run: "כמה מילים חדשות?" with chips 5, 10, 15, 20, 30, 15 picked, and
התחלה. The goal is stored on the run (1–30).

### D7. A word's lookup (my call: progressive, as a photo row's)

Job `look-up-discovered-word {run_id, position}`: the lookup exactly as if typed (the photo import's
`lookup` closure), then the gloss from the options by the card's `hebrew` (`firstChoice`, else the
sense-match model), then one write of the photo row's fields on the card. By the list step most words
are ready. The photo service's row lookup is extracted to one shared function both jobs call (no
behaviour change there). Dead letter: the row is marked failed.

### D8. A run's life

Statuses: `asking` → `listing` → `saved` | `discarded`. One open run (`asking`/`listing`) per
enrollment, a partial unique index. Starting while one is open answers the open one (resume).

- **Next round** (`POST …/rounds`): when `asking` and no card of the run is unanswered. Reads in one
  transaction, calls the model outside it, then one transaction locks the run, checks nothing changed
  (else answers the run as it is), writes the cards and the profile's new level. At **8 rounds**, or a
  round with no word left, the run moves to `listing` instead (my call).
- **End now** (`POST …/end`): "לרשימה" on the cards step, shown from one unknown word (my call).
- **The list:** the unknown cards in order, in the photo row's shape (`PhotoImportItem`), ticked when
  their lookup found a gloss. A tick or a meaning changes as a photo row's does (`refuseItemUpdate`).
- **Save** (Continue, "הוספת {n} מילים"): one transaction: the run locked, no row still looked up
  (else 409), the ticked rows' entries saved by `saveEntriesInTx` to My words, the run marked saved.
  Dependent writes, one transaction. A repeated save answers the same ids. Then home, with phase 26's
  "{n} מילים נשמרו".
- **Discard** ("ביטול", behind a confirm): `discarded`; the answers stay.

### D9. Storage (my call; migration `0049_discovery`: phase 68 took 0048)

- `discovery_profiles`: `enrollment_id` (PK, FK), `self_level`, `learning_context` (checks),
  `level` smallint 1–12, `created_at`, `updated_at`.
- `discovery_runs`: `id`, `enrollment_id` (FK), `goal` smallint 1–30, `status` (check),
  `settled_round` smallint (0 until a round moves the level, D3), `created_at`, `ended_at`; partial
  unique index on `enrollment_id` where status in (`asking`, `listing`).
- `discovery_cards`: PK (`run_id`, `position`), FK cascade; `round`, `level`, `word`,
  `part_of_speech`, `hebrew`, `alternatives` jsonb; `answer` (`unknown` | `typed` | null),
  `typed_text`, `verdict` (`exact` | `alternative` | `wrong` | null), `known`, `judged_by`,
  `answered_at`; the photo row's lookup fields: `lookup_status`
  (null until unknown, then `pending` | `ready` | `failed`), `corrected_form`, `options`,
  `suggested_gloss_id`, `chosen_gloss_id`, `ticked`, `hebrew_mismatch`, `reason`, with the photo
  row's checks. Gloss ids are snapshots, no keys (ADR 0011 R1 holds).

The cards are the log: every answer with its time and the level it was asked at (memory: derive,
then record). Log events: `discovery_round` (level before and after, words asked, dropped),
`discovery_answered` (judged_by, known), `discovery_saved`, `discovery_discarded`.

### D10. The wire and access

New permission `discovery.manage`, in no role (the owner's alone, as photo imports'). Endpoints, each
in the auth matrix with a STRANGER fixture:

| Method and path | Does |
|---|---|
| `GET /enrollments/{id}/discovery` | `{ profile, run }`, each null when none |
| `POST /enrollments/{id}/discovery/profile` | the two answers; 201, 409 when one exists |
| `POST /enrollments/{id}/discovery/runs` | `{ goal }`; 201 a new run, 200 the open one |
| `GET /discovery/runs/{id}` | the run |
| `POST /discovery/runs/{id}/rounds` | the next round (D8) |
| `POST /discovery/runs/{id}/cards/{position}/answer` | `{kind:'unknown'}` or `{kind:'typed', text}`; `{ known, meaning, run }` |
| `POST /discovery/runs/{id}/end` | to the list |
| `PATCH /discovery/runs/{id}/items/{position}` | `{ ticked?, gloss_id? }`, as a photo row |
| `POST /discovery/runs/{id}/save` | `SaveVocabularyResponse` |
| `POST /discovery/runs/{id}/discard` | 204 |

A run on the wire: `{ id, goal, status, unknown_count, round, cards: [{ position, word }] (the
unanswered cards, in order), items: PhotoImportItem[] }`. Additive only: `API_LEVEL` stays.

## Testing

- **Domain:** the first level, the level rule's bands, the prompt (marker, level, age, context,
  exclude cap), the parser's drops and its cap, the run's done rule.
- **Service and integration:** a run from profile to save through the routes with fake model answers;
  resume; a round racing a round; an answer replayed; a judge that fails; the goal reached mid-round;
  the save refused while a row is looked up; the job's write; discard. The auth matrix's fixtures and
  `written()` gain the new tables.
- **Eval:** group `discover ` (it, en, ru; A1 to B2; a child and an adult; with an exclude list):
  tier 1 parses with at least 10 words; tier 2 at most one excluded word in the raw answer (the parser
  drops it, R5), none repeated, words in the target's script, `hebrew` in Hebrew.
- **e2e:** `discover.spec.ts`: questions, a goal of 5, "אין לי מושג", a typed right answer and a
  typed wrong one, the list, one untick, Continue, the words in the vocabulary.

## Left to the builder

The exact prompt wording, measured by the eval; the thinking budget; the app's component split; the
job's queue options (copy the photo row's). The builder check named more it could settle alone, and
these are settled so (my call): an empty list shows only ביטול; `POST runs` before a profile is a
409; the entry shows for the owner only (a tutor never sees מילים of another's list); the run polls its
items every 2 s while a row is looked up, as `ImportsReview` does.

## Rulings (the build, 2026-10-21)

Made while building, with Victor's "go till PR"; each says what it costs if wrong.

- **R1.** A model that cannot propose words answers 502 `words unavailable`, as every other model
  failure in `routes/` does, not D4's 503. Cost: one status code; the app treats any failure alike.
- **R2.** An empty model answer (a refusal) is unavailable too, never "no word left": the learner
  gets נסו שוב, not a run ended with an empty list (final review). Cost: none.
- **R3.** A round's thinking budget is 0, measured on the `discover ` eval group: 1.8–3.1 s a round,
  every check passed in two runs of five cases. Cost: a re-measure if a model update degrades it.
- **R4.** A tick or meaning change is allowed only while the run lists. Cost: none; the app shows the
  list only then.
- **R5.** The eval allows one excluded word in the raw answer, where Testing said none: the parser drops
  it, so a learner never sees it. Cost: an eval that misses a prompt drifting toward excluded words.
- **R6.** The list is its own small review (`DiscoverList`), reusing `PhotoImportRow`, not
  `ImportsReview`, which reads photo imports by id. Cost: a second review to keep in step.
- **R7.** Two races are pinned on Postgres, not only a fake: two rounds at once write one, and two
  answers at once that reach the goal list the run and settle its round once (final review).
