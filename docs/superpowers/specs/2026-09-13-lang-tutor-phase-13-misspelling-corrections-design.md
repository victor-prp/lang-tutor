# Phase 13 — Misspelling detection and corrections

- **Status:** Draft, awaiting review
- **Date:** 2026-09-13
- **Source:** a play-test report — typing `thruot` returns the translation of `throat` with
  nothing said about the spelling, no second candidate offered, and a permanent dictionary row
  written for a string that is not a word.
- **Depends on:** phase 12
  (`docs/superpowers/specs/2026-09-13-lang-tutor-phase-12-dict-lexemes-design.md`), which must
  ship first. Every name, table and flow below is phase 12's, not phase 10's.

## Summary

A learner types `thruot`. The app answers `גרון` — the translation of `throat` — and says
nothing. Three defects are stacked in that one answer.

**The correction is silent.** The model *does* report that it read the input as `throat`: it
returns `lemma: "throat"`. The server discards it. `TranslationResponseSchema` has no field for
a headword, so the one signal that would let anyone notice `typed ≠ translated` never reaches a
client.

**Only one guess is offered.** `thruot` is as close to `throughout` as to `throat`. The prompt
already permits several entries, but the response flattens them into one ranked `senses` array
with every lemma stripped, and the client shows `senses[0]` by default — so even a two-candidate
answer renders as a single translation with nothing to distinguish the candidates.

**Nothing records that the string is not a word.** `persistEntries` writes a variant for the
form as typed, permanently, with no TTL. `questions.prompt_variant_id` references that table and
`questionFrom` prompts with `form`, so the machinery that would quiz a learner on `thruot` is
already built and already pointed at the row.

This phase adds a **correction**: the model reports the form it believes was intended, the
server rewrites the queried form to it, and a `dict_corrections` redirect records the mapping so
a misspelling is never a dictionary entry at all.

## The defect, measured

Reproduced before anything was designed, against the real model through the production prompt
and against a real database.

**The model silently corrects, and it is not specific to one string.** The production prompt,
the production Gemini client, `GEMINI_MODEL` as configured:

```
thruot      -> kind=word entries=1  lemma=throat      senses=גרון
throat      -> kind=word entries=1  lemma=throat      senses=גרון · צוואר
throughout  -> kind=word entries=1  lemma=throughout  senses=בכל רחבי · במשך כל
recieve     -> kind=word entries=1  lemma=receive     senses=לקבל ×3
zxqwbtl     -> kind=word entries=0
```

The existing prompt rule — *"If the input is not a word or expression in either language, return
an empty entries array rather than inventing a translation"* — fires only for `zxqwbtl`, a
string near nothing. A typo one edit from a real word never trips it. Note also that the model
commits to a single candidate: it did not offer `throughout` for `thruot`, because nothing asks
it to enumerate corrections.

**The misspelling becomes a permanent dictionary row.** An integration test against Postgres,
persisting the model's genuine `thruot` answer, passes today:

- `term_variants` holds `form='thruot'` pointing at the lexeme `throat`, with no column anywhere
  recording that the form is not a word.
- `findSensesByForm('thruot')` then hits, so the provider is never consulted about the string
  again — there is no TTL and no invalidation.
- `questionFrom` built from that variant produces `question: 'thruot'`.

The third point is latent rather than live: `questions` rows are written only by `db/seed.ts`
today, so no learner lookup generates a quiz item yet. The poisoned row is written now; the
machinery that reads it is built and points at the right column.

## What this adds

| Area | Addition |
|---|---|
| DB | Migration `0006` — `dict_corrections`, one table, one unique index, no foreign key |
| Core | `LlmCorrectionSchema` and `TranslationCorrectionSchema`; one optional field on each of `LlmTranslationSchema` and `TranslationResponseSchema` |
| Server | `domain/translation.ts` — three prompt rules, two guards, and `resolveKind` against the corrected form |
| Server | `services/translations.ts` — the redirect read, and the one-line substitution that rewrites the queried form |
| Server | `repo/dictionary.ts` — `findCorrectionByForm` and `persistCorrection` |
| Server | `db/dictExport.ts` / `db/dictImport.ts` — a sibling `corrections.jsonl` |
| Mobile | A correction banner and alternative chips on the translate screen; two strings |
| Data | `data/backfill/en-he/corrections.jsonl`, empty on arrival |

No table removed, no endpoint added, no ADR amended. One optional property joins the published
OpenAPI document.

## Decisions settled during design

**A correction rewrites the queried form once, and nothing downstream knows.** This is the
central decision and it is what keeps the phase small. On a miss the service parses the answer,
reads `correction.corrected_form`, and substitutes it for the queried form at the top of the
pipeline. Phase 12's reconciliation read, its second model call, its `persistEntries` and its
`resolveKind` then run **verbatim**, on `booked` rather than on `bokked`. The typed string
survives in exactly two places: the response's `text`, and the `dict_corrections` row.

The alternative — a parallel branch through the miss path — was rejected after tracing what
phase 12 does with the queried form. `buildRenderingPrompt` receives it and asks the model to
render every stored sense *in the grammatical form matching the input*, building examples around
it. Handing that prompt `bokked` produces renderings that agree with a misspelling, and phase
12 writes them permanently. Rewriting at `persistEntries` alone is not enough; rewriting once,
before the pipeline, covers every downstream use by construction.

**A misspelling is a routing fact, not a dictionary fact, so it gets its own table.** `thruot`
is not a form of `throat` — it is a string that should be read as one. Phase 12 sharpened this:
a `dict_variants` row now *owns its own renderings*, and `rank` lives on
`dict_var_translations` under `UNIQUE(variant_id, user_language_code, rank)`. Storing a
misspelling as a variant would therefore mean inventing a per-form rendering, an example
sentence and a rank ordering for a string that is not a word.

`dict_corrections` maps `typed_form → corrected_form` plus ranked alternatives. The corrected
form is then served through the **ordinary by-form read**, so a corrected answer is byte-identical
to typing the correct spelling — no interleaving to truncate, no `entry_rank` to collide, and a
repeat typo costs zero provider calls.

It is also the stronger answer to the reported defect. `questions.prompt_variant_id` references
`dict_variants`; a misspelling that is never a variant **cannot** be quizzed. A boolean flag on
the variant would have relied on every present and future query remembering to filter.

**The correction target is a surface form, not a lemma.** A learner typing `bokked` wants
`booked`, whose lemma is `book`. Under phase 10 the distinction was invisible; phase 12 makes it
load-bearing, because `booked` renders `הזמין` and `book` renders `להזמין` on purpose.
`corrected_form` is therefore its own field, carried beside — never derived from — the entries'
`lemma`.

**Detection is the model's job, and one call does all of it.** The answer carries
`corrected_form`, the alternative forms, and the entries for the corrected form together, so a
corrected miss costs the same number of first calls as any other miss. `alternatives` carry no
senses: tapping one is an ordinary lookup, usually a cache hit, because the same call already
wrote the dictionary rows.

**A correctly spelled inflected form is not a misspelling.** `running`, `booked`, `saws` and
`went` are real forms of real words and must return no correction. This is the rule the whole
feature turns on and the one most likely to regress, because `lemma ≠ typed form` is true of
both an inflection and a typo — which is precisely why detection cannot be a string comparison
and has to be asked for explicitly.

**Scope is words and phrases, both directions.** A sentence containing one typo still translates
correctly, and correcting inside a sentence needs per-token structure the single-sense sentence
response has nowhere to hang. `brake a leg` is in scope; *"I have a sore thruot"* is not.

**The redirect is global, with no `user_id`.** That `thruot` is not an English word is a fact
about English. Phase 12 keeps "nothing records who asked" and ADR 0005 leaves identity
unauthenticated; a per-learner mistake history has no reader until a feature needs one, and
adding it later is additive.

## Data model

```sql
dict_corrections(language_code, typed_form, corrected_form, alternatives, created_at)
  UNIQUE INDEX (language_code, lower(typed_form))  -- dict_corrections_form_key
```

```sql
CREATE TABLE dict_corrections (
  language_code   varchar(10) NOT NULL,
  typed_form      text        NOT NULL,
  corrected_form  text        NOT NULL,
  alternatives    text[]      NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dict_corrections_form_key
  ON dict_corrections (language_code, lower(typed_form));
```

**Stored as written, matched on `lower()`** — the same rule `dict_variants` uses, so a learner
who typed `Thruot` is matched by one who typed `thruot` while the row keeps the shape it
arrived in. A unique index on an expression rather than a primary key, exactly as
`dict_variants_form_entry_rank_key` is.

**`corrected_form` is a plain string, not a foreign key.** Referencing `dict_variants.id` would
couple the redirect to a row that `TRUNCATE … CASCADE` can remove. As a string, a dangling
redirect degrades into a miss and a model call — it self-heals rather than raising.

**`text[]` rather than `jsonb`**, matching `session_questions.option_order`'s use of a Postgres
array for a homogeneous list. Capped at three by the schema before it reaches the database.

**Nothing references this table.** That is the point: `questions.prompt_variant_id` reaches
`dict_variants` only, so no row here can become a quiz prompt.

The migration is additive and runs on a database phase 12 has already truncated. Nothing
backfills.

## The flow

```
translate(text):
  form = normalizeForm(text)

  ── reads; each may be its own transaction, per R8 as amended by phase 12 ──
  1  findSensesByForm(form)                     hit  -> respond as today, no correction
  2  findCorrectionByForm(form)                 miss -> step 4
  3  findSensesByForm(redirect.corrected_form)  hit  -> respond: senses from the corrected
                                                        form, correction block from the row
                                               miss -> fall through to the model

  4  call 1 -> parse -> the two correction guards, in domain/

  5  effectiveForm = correction?.corrected_form ?? form        <- the substitution
     kind          = resolveKind(effectiveForm, parsed.kind)

  ── from here phase 12's miss pipeline runs verbatim, on effectiveForm ──
  6  the sentence / empty-entries early return
  7  read each entry's lexeme for stored senses; call 2 and reconcile if any has them;
     a failing call 2 throws and writes nothing
  ── one write transaction ──
  8  persistEntries(form: effectiveForm, ...)
  9  if correction: persistCorrection(typed_form: form, corrected_form, alternatives)
```

**The hot path is untouched.** A correctly spelled word hits at step 1 and pays nothing for this
phase. Steps 2 and 3 run only on a miss, which already costs a provider call measured in
seconds.

**Correct spellings win over redirects.** Step 1 precedes step 2, so a string that is a real
form in its own right is never routed away from itself, even if a redirect for it exists.

**Steps 8 and 9 share one write transaction**, which is what makes phase 12's fail-closed rule
cover this phase for free: a failed reconciliation call writes no entries *and* no redirect, so
a redirect can never point at a form that has no rows.

**R8 needs no amendment.** Phase 12 amended it to *"a use case opens at most one write
transaction; reads preceding third-party I/O may each be their own"*. Three reads and one write
are covered by that wording as it now stands, and the detection command greps `\.transaction(`
either way.

### The two guards

Both live in `domain/`, applied to the parsed answer before phase 12's early return, so a
dropped correction costs no database read and no second model call.

- **`corrected_form` equals the typed form**, compared case- and whitespace-insensitively → drop
  the correction. Removes a whole class of *"did you mean throat? — showing results for throat"*.
- **`kind === 'sentence'`** → drop the correction. Detection is scoped to words and phrases, so a
  sentence carrying one is the model ignoring its instructions rather than a case to handle.

A `correction` arriving with `entries: []` needs no guard: it falls into phase 12's existing
empty-entries return, and no redirect is written.

### Worked through, end to end

```
1  'thruot'  miss on the form, miss on corrections
             call 1 -> correction { corrected_form: 'throat',
                                    alternatives: ['throughout'] }
                       entries    [(throat, noun)]      <- describing THROAT
             effectiveForm = 'throat'
             (throat,noun) is new, so no call 2
             persistEntries(form: 'throat', ...)        <- the correct spelling
             persistCorrection('thruot' -> 'throat', ['throughout'])
             -> senses [גרון, צוואר]
                correction { corrected_form: 'throat', alternatives: ['throughout'] }

2  'thruot'  miss on the form, HIT on corrections -> read 'throat' -> the same answer.
             No provider call. Zero rows written.

3  'throat'  HIT on the form at step 1. No correction block. The redirect is never consulted.

4  tap 'throughout' -> an ordinary lookup of 'throughout'. Miss the first time, then a
             normal cached word. It is not a correction and holds no redirect.

5  'bokked'  call 1 -> correction { corrected_form: 'booked', alternatives: [] }
                       entries [(book, verb)]
             effectiveForm = 'booked'
             (book,verb) already HAS senses -> call 2, handed the form 'booked'
                                               NOT 'bokked'
             -> renderings agree with 'booked': הזמין, not a rendering of a typo
             persistEntries(form: 'booked', ...)
             persistCorrection('bokked' -> 'booked', [])
```

Step 5 is the case to check in review: the substitution happens once, at step 5 of the flow, and
the reconciliation call that phase 12 added never sees the typed string.

Two rows exist for `thruot` after any number of lookups: one in `dict_corrections`, none in
`dict_variants`.

## The contract change

Two optional fields, one on the model's schema and one on the wire. Nothing is removed and no
field changes type.

```ts
// What the model reports. Present only when the typed string is not a word or expression
// in the source language but is near one or more that are.
export const LlmCorrectionSchema = z.object({
  // A surface form, not a lemma: `bokked` corrects to `booked`, never to `book`.
  corrected_form: z.string().min(1),
  // Other plausible intended forms, ranked, no senses. Tapping one is an ordinary lookup.
  alternatives: z.array(z.string().min(1)).max(3),
});

export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  // When `correction` is present these describe `corrected_form`, not the typed text.
  entries: z.array(LlmEntrySchema).max(6),
  correction: LlmCorrectionSchema.optional(),
});
```

```ts
export const TranslationCorrectionSchema = z.object({
  corrected_form: z.string().min(1),
  alternatives: z.array(z.string().min(1)).max(3),
});

export const TranslationResponseSchema = z.object({
  // The string the learner typed, so the client can say "you typed thruot".
  text: z.string(),
  direction: TranslationDirectionSchema,
  // Both of these belong to the CORRECTED form, and are byte-identical to what a
  // direct lookup of it returns.
  kind: TranslationKindSchema,
  senses: z.array(TranslationSenseSchema).max(5),
  correction: TranslationCorrectionSchema.optional(),
});
```

`TranslationRequestSchema` is unchanged. This is the phase that ends phase 12's byte-identical
OpenAPI document, deliberately and additively — a client that ignores `correction` behaves
exactly as it does today.

`dropNulls` already strips a `null` optional under structured output, so the parser needs no
change beyond the new schema.

### The prompt

The existing rule — *"If the input is not a word or expression in either language, return an
empty entries array rather than inventing a translation"* — becomes a three-way split:

| Typed | Outcome |
|---|---|
| `throat`, `booked`, `running` | a real word or form → entries as today, **no** correction |
| `thruot`, `recieve`, `brake a leg` | not a word, but near one or more → **correction** |
| `zxqwbtl` | near nothing → empty entries, no correction |

Three rules are added:

> A correctly spelled inflected form is not a misspelling: `running`, `booked`, `saws` and
> `went` are real forms of real words — return them normally and omit `correction`.
>
> When the input is not a word or expression in the source language but one or more real ones
> were plausibly intended, set `correction.corrected_form` to the single most likely intended
> **surface form** — matching the grammatical form the learner appears to have typed, so
> `bokked` corrects to `booked` and not to `book` — and list up to three other plausible
> intended forms, ranked, in `correction.alternatives`. The `entries` then describe
> `corrected_form`.
>
> When `correction` is present, build the example sentence around `corrected_form`, never around
> the input as typed.

The third suspends, for this path only, phase 12's *"build the example sentence around the input
as typed"*. Without it the dictionary stores example sentences containing a misspelling.

`buildRenderingPrompt` — phase 12's second prompt — needs **no** rule about corrections, because
the substitution means it is never handed a typed form.

## Mobile

One banner above the results, with the alternatives as buttons beneath it.

```
┌────────────────────────────────────┐
│  thruot                      [→]   │
├────────────────────────────────────┤
│ ⚠ לא מצאנו את thruot               │
│   מציגים תוצאות עבור throat        │
│                                    │
│   האם התכוונת ל:  [ throughout ]   │
├────────────────────────────────────┤
│  [המשמעות הנפוצה]                  │
│  גרון                       noun   │
│  ...                               │
└────────────────────────────────────┘
```

`testID="translate-correction"` on the banner and `translate-alternative-{i}` on each button.
Tapping an alternative calls `useTranslation`'s existing `submit` with that text — an ordinary
lookup, no new endpoint, and usually a cache hit because the same model call already wrote the
dictionary rows for it.

The banner renders whenever `correction` is present and sits above the existing sense cards. It
does not change the `more` / reveal behaviour, the chosen-sense behaviour, or the empty state:
`zxqwbtl` still shows `translateEmpty`.

**The forms need bidi isolation.** In the `en_he` direction the banner embeds a Latin word inside
a Hebrew RTL sentence, and without an isolate the reordering places it against the wrong clause.
Each form is wrapped in `⁨ … ⁩` (FSI/PDI) or given its own `<Text>` with an explicit
`writingDirection`. The `he_en` direction has no such problem. `translate.tsx` already reasons
about direction for the input field, which is the precedent this follows.

Two strings join `strings.ts`: `translateCorrectionNotice(typed, corrected)` and
`translateDidYouMean`.

## Export and restore

`dictionary.jsonl` keeps its invariant — one line is one lookup, replayable through
`persistEntries` — and corrections go to a sibling `corrections.jsonl`, written and read by the
same `dict:export` and `dict:restore` commands. A correction is a paid model answer and would
otherwise be lost on every database reset.

The file arrives empty and stays near-empty: the backfill word list is correctly spelled, so
corrections accumulate only from real learners. Restore replays them through
`persistCorrection`, the same function a live lookup calls, so a restored row and a looked-up
row are indistinguishable — the guarantee `dictImport` already provides for the dictionary.

## Testing

Placement follows ADR 0004 — the folder decides the bucket — and no bucket is added.

### Unit

| File | Covers |
|---|---|
| `domain/translation.test.ts` | the prompt states the three rules and names `corrected_form` as a surface form; the parser accepts and rejects the `correction` shape; `alternatives` caps at three |
| `domain/translation.test.ts` (guards) | `corrected_form` equal to the typed form is dropped, case- and whitespace-insensitively; a correction on `kind: 'sentence'` is dropped; a correction with `entries: []` leaves the empty return intact |
| `domain/translation.test.ts` (kind) | `resolveKind` runs against the corrected form, so `breakaleg` → `break a leg` is a phrase rather than a single-token word |
| `services/translations.test.ts` | the three-step read; a redirect hit answers with **no** provider call; a redirect whose target missed falls through to the model; `persistEntries` and `buildRenderingPrompt` both receive `corrected_form` and never the typed form |
| `packages/core/src/api/schemas.test.ts` | `correction` is optional on both schemas; a response without it parses unchanged; `alternatives` rejects a fourth entry |

### Integration

| File | Covers |
|---|---|
| `repo/corrections.test.ts` **new** | write/read round trip; `Thruot` finds the row written as `thruot`; the unique index rejects a second row for one form in one language |
| `repo/corrections.variants.test.ts` **new** | the characterisation test inverted: after any number of corrected lookups, **zero** `dict_variants` rows exist for the typed form, so `questionFrom` can never be built from it. Seen to fail first |
| `services/translations.correction.test.ts` **new** | a failing reconciliation call leaves **no** `dict_corrections` row and no dictionary row — phase 12's fail-closed rule, asserted for this table |
| `routes/translations.test.ts` | the correction block reaches the wire; the published document declares it optional |
| `db/dictRoundTrip.test.ts` | `corrections.jsonl` round-trips; a restored correction serves the same answer a looked-up one does |

### e2e

`translate.spec.ts` gains one flow against MockServer: type `thruot`, see the banner naming both
forms, tap `throughout`, see its translation. Phase 12 left this file alone because the wire did
not move; this phase moves the wire, so it is the first bucket to notice.

### Evals

`EvalCase` gains `expectCorrection?: string` and `expectNoCorrection?: true`. Added:

- `thruot` → `corrected_form: 'throat'`, `alternatives` containing `throughout`
- `recieve` → `receive`
- `brake a leg` → `break a leg`, `kind: 'phrase'`
- **`running`, `booked` and `saw` → no correction at all** — the inflection trap, and the most
  important cases in the set. All three are already in the set — `running` and `saw` since phase
  10, `booked` added by phase 12 — so this is an added assertion on existing calls rather than
  three new ones.
- `asdkjhasd`, the set's existing nonsense case → empty entries and **no** correction, which is
  what separates "near nothing" from "near a word"
- one Hebrew misspelling, for symmetry across directions

`askModel` exposes `correction` alongside `entries`, as it already exposes the entries the wire
flattens away.

## ADR consequences

**No ADR amended, no new ADR, no new detection command.** Stated rather than left silent,
because phase 9 established that a check must be shown to fail before it is trusted, and the
counterpart is that a phase adding none should say so.

- **ADR 0003** — the wire moves for the first time since phase 9, additively: one optional
  property on the response, nothing removed and no field retyped. The schema stays single-homed
  in `packages/core`, the route stays a `createRoute`, and `openapi.test.ts` is updated to assert
  the new property. No rule is violated and no check changes. This is the ADR the phase touches
  and the reason the field is optional rather than required.
- **ADR 0001** — no layer moves. R8 was amended by phase 12 to *"reads preceding third-party I/O
  may each be their own"*, which already covers this phase's three reads; the write count is
  unchanged at one. Two functions join the existing dict repo rather than a new one, so `Repos`
  keeps its shape. The architecture check stays at seventeen rules.
- **ADR 0002** — `createDictRepo` gains two functions; the factory list is unchanged.
- **ADR 0004** — no new bucket.
- **ADR 0005** — untouched. `dict_corrections` has no `user_id`; nothing here records a learner.

**A judgement call left open for review**, in the same terms phase 12 left its own: *"a
misspelling is never a `dict_variants` row"* is a durable structural invariant, and `docs/adr/`
is where this repo records those. It is not recorded as an ADR here because every existing ADR
pairs its rule with a grep-able detection command, and this is a data-model fact no regex can
check — it is enforced by `repo/corrections.variants.test.ts` instead. If the preference is to
record it anyway, `create-adr` should run before implementation.

## Out of scope

- **Typos inside sentences.** The whole typed string is judged, or nothing is.
- **Per-learner mistake history.** The redirect is global; no table records who typed what.
- **Correcting the correction.** There is no "no, I meant X" affordance beyond tapping a listed
  alternative, and nothing learns from a learner who taps one.
- **Any edit-distance or spellchecker implementation.** The model does the judging; the server
  stores the verdict.
- **TTL, invalidation or refresh of a redirect.** A correction is permanent, like every other
  row in this dictionary.
- **Correcting a form the dictionary already holds.** Step 1 precedes step 2, permanently.
- **A third language.** `direction` still has two values.

## Risks

- **A wrong redirect for a real word is permanent.** If the model calls `booked` a misspelling of
  `book`, that row never expires. Partially self-limiting: the redirect is consulted only *after*
  the by-form read misses, so once `booked` is legitimately written the bad row is shadowed and
  inert. It bites only for a form never looked up correctly first. The three inflection eval
  cases exist for exactly this, and they are the ones to watch when a model version changes.
- **A corrected miss can cost two provider calls, disproportionately often.** Phase 12 measured
  reconciliation firing on ~16% of misses — those whose lexeme already has senses. Corrections
  resolve to *common* words, which are the likeliest to already own a lexeme, so the correction
  path probably triggers the second call at a **higher** rate than 16%. A corrected miss is
  10–30s. The redirect cache is what bounds this: the second lookup of the same typo costs
  nothing.
- **Hebrew spelling is legitimately variable.** Ktiv male against ktiv haser, and optional nikud,
  mean many valid Hebrew spellings differ from each other, and `normalizeForm` deliberately
  strips neither. The model may report a valid alternative spelling as a misspelling and write a
  permanent redirect away from it. This is the Hebrew-side risk with no clean answer, and the
  reason the Hebrew eval case matters more than its single line suggests.
- **Proper nouns, brand names and slang will be corrected.** A learner typing a name is told it
  is not a word and shown something else. Phase 12 already collapses `proper_noun` into `noun`,
  so nothing downstream can distinguish the case either.
- **Model instability across versions.** The same typo may correct differently after a model
  update, and first-writer-wins freezes whichever arrived first — consistent with how the rest of
  the dictionary already behaves, and the reason `test-eval` can go red with nothing in the diff.
- **`alternatives` caps at three**, so a badly mangled input silently loses candidates.
- **The wire moves, so a mobile client older than this server sees a correction it cannot
  render** — it will show the corrected form's translation with no notice, which is exactly
  today's behaviour rather than a regression.

## Success criteria

1. `thruot` returns `throat`'s senses, byte-identical to a direct `throat` lookup, plus a
   correction block naming `throat` and offering `throughout`.
2. A second `thruot` lookup makes **no** provider call and writes no row.
3. **Zero** `dict_variants` rows exist for `thruot` after any number of lookups, so no question
   can be built from it.
4. `bokked` hands `booked` — never `bokked` — to `buildRenderingPrompt` and to `persistEntries`,
   and the stored renderings agree with `booked`.
5. A failing reconciliation call on a corrected lookup leaves the database byte-identical: no
   lexeme, no variant, no translation and **no** `dict_corrections` row.
6. `running`, `booked` and `saw` return no correction.
7. `asdkjhasd` still returns the empty state, not a correction.
8. A correction whose `corrected_form` equals the typed form, and one on a sentence, are both
   dropped before any database read or second model call.
9. Tapping `throughout` returns `throughout`'s own translation, and writes no redirect for it.
10. A correctly spelled form that also has a redirect row resolves to itself; the redirect is
    never consulted.
11. The published OpenAPI document gains exactly one optional property and loses nothing.
12. `corrections.jsonl` round-trips; a restored correction serves the same answer a looked-up one
    does.
13. `npm run test:all` and `npm run e2e` are green with no network access and no API key.
14. `npm run lint:arch` passes and still reports seventeen ADR 0001 checks.
