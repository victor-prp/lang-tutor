# Phase 13 — Misspelling detection and corrections

- **Status:** Revised after review a fourth time, 2026-09-15. Ready to plan from. The second
  revision was entirely about phase 12's F5 repair, which landed between the first two reviews and
  which the first revision acknowledged only in the migration number — see *A redirect answers
  through the repair, not around it*.
- **The fourth revision is about the case none of the earlier ones traced: a correction whose
  target the dictionary already holds.** Once the backfill lands that is the ordinary corrected
  miss, and the flow as revised ran phase 12's write pipeline on a form that already had rows — a
  path the live flow had never taken — paying a reconciliation call to write nothing and, whenever
  the model's entry order differed from the stored variant's, failing the write on the entry-rank
  safety net and never writing the redirect. See *A corrected form the dictionary already holds is
  served, not rewritten*. The probe that fixes it goes through `serveForm` like steps 1 and 3,
  so one lookup can commit a repair and a redirect, and **ADR 0001 R8 is amended a fourth time**
  to say that a use case's independent, idempotent writes may be their own transactions — see
  *ADR consequences*. Seven smaller corrections travel with it:
  - a corrected form in the wrong script — a transliteration typed under `en_he` and corrected to
    a Hebrew word — was checked by nothing and would have been written as an English variant. A
    **fourth guard** fails the request;
  - the guards, the empty-entries clearing, the normalization and `resolveKind` are one pure
    domain function, `resolveCorrection`, which the service and the eval harness both call. The
    third revision put half of it in the service and then filed its tests under `domain/`;
  - the redirect-chain risk described the wrong outcome — not a permanent model tax but a
    `dict_variants` row for a string already recorded as a typo — and is now handled with one
    read rather than accepted;
  - the prompt-word rule forbade six quoted words the system instruction cannot in fact collide
    with, because the instruction travels JSON-encoded and a quoted expectation matches only the
    user part of the body. The rule is the two unquoted substrings;
  - the 100-character cap and the three-item cap are `CHECK` constraints as well as schema and
    tidy rules, because a restore reaches neither the schema nor the tidy of its own accord;
  - the no-correction eval cases gain `colour`, a real word a model may "correct" to `color`;
  - the numbering collision below is decided rather than left open.

  And three notes that change no decision: `serveForm` logs the repair events and not the hit,
  so a redirect hit is not also counted as a cache hit; the integration bucket's `expectGeminiJson`
  is named beside the e2e helper as needing the new field; and the data-model paragraph that
  promised a repeat typo *zero* provider calls is qualified for the repair, as criterion 2
  already was.
- **The third revision is about the model-facing half and three invariants the server did not
  actually hold.** Read against the shipped code, the second revision asserted four things that
  were not true of it, and each is corrected below rather than softened:
  - The prompt's existing *"not a word → empty entries"* rule was left standing beside a new rule
    telling the model to answer the same input with entries for a different form. It is now
    **replaced**, not supplemented — see *The prompt*.
  - Nothing told the model to classify `corrected_form` rather than the typed string, and `kind`
    is written permanently onto the corrected form's variant. A **fourth** prompt rule now says so;
    the previous revision claimed `resolveKind` covered it, and `resolveKind` only clamps a single
    token.
  - `reseedContent`'s `TRUNCATE … CASCADE` cannot reach a table with no foreign key, so a reseed
    would have left the whole redirect table pointing into an empty dictionary. `dict_corrections`
    is now named in that statement.
  - `alternatives`' three-item cap was described as an invariant the server holds; `dict:restore`
    writes through the repository and bypasses `domain/` entirely, exactly as `dictImport` already
    does. The cap moves into `persistCorrection`.

  Two smaller ones travel with them: `LlmCorrectionSchema.alternatives` becomes `.optional()`
  rather than `.default([])`, because `.default()` puts a JSON Schema keyword into Gemini's
  `responseSchema` that this repo has never sent; and the phase gains two log events, because its
  headline risk was otherwise unmeasurable in production.
- **Date:** 2026-09-13
- **Depends on:** phase 12
  (`docs/superpowers/specs/2026-09-13-lang-tutor-phase-12-dict-lexemes-design.md`), **including
  its F5 amendment** — the lazy repair that re-renders a form when its lexeme learns a new sense.
  Every name, table and flow below is phase 12's, not phase 10's, and the flow below is the
  *amended* one: a hit is no longer unconditionally an answer.
- **Source:** a play-test report — typing `thruot` returns the translation of `throat` with
  nothing said about the spelling, no second candidate offered, and a permanent dictionary row
  written for a string that is not a word.
- **This phase's migration is `0007`.** `0006_sense_versions.sql` — phase 12's F5 fix — is on
  disk and shipped; this phase is planned behind it.
- **A numbering collision, decided: this spec is phase 13 and the code comments are wrong.**
  The committed code uses *"phase 13"* for phase 12's F1–F5 follow-ups. Ten files carry the
  label today: `src/domain/translation.ts`, `src/domain/translation.test.ts`,
  `src/domain/dictionary.ts`, `src/domain/dictionary.test.ts`, `src/repo/dictionary.ts` and
  `tests/integration/repo/dictionary.test.ts` (as *"Task 13"*),
  `tests/integration/services/translations.test.ts`, `tests/eval/cases.ts`, `tests/eval/run.ts`
  and `tests/eval/askModel.ts` — while `docs/` calls that same work phase 12 tasks 9–13, and the
  phase 12 plan's own *Task 13* section is the F5 repair. The documents already agree with each
  other and migration `0007` is claimed under this phase's number, so the comments move rather
  than the phase: the first task of this phase's plan relabels all ten to *"phase 12 follow-up"*
  (and *"Task 13"* to *"phase 12, Task 13"*), with no behaviour change, before any file here
  gains a *"phase 13"* comment that means this phase.

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
server rewrites the queried form to it, and a `dict_corrections` redirect records the mapping, so
a misspelling the model reports is never a dictionary entry.

**That last clause is a conditional, and it is stated as one deliberately.** The server writes
`throat` instead of `thruot` because the *model said so*; nothing here detects a misspelling
independently, so an answer that carries entries and no `correction` still writes a variant for
the typed string, exactly as today. See *Detection is the model's job* and the matching risk —
the design narrows the defect to the cases the model reports and does not close it structurally.

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

- `dict_variants` holds `form='thruot'` pointing at the lexeme `throat`, with no column anywhere
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
| DB | Migration `0007` — `dict_corrections`, one table, one unique index, three `CHECK` constraints, no foreign key |
| DB | `db/migrate.ts` — `correction_alternatives_valid`, the `IMMUTABLE` function the third constraint calls, installed beside `question_options_valid` for the reason that one gives: drizzle-kit cannot generate `CREATE FUNCTION` |
| DB | `db/reseed.ts` — `dict_corrections` joins the `TRUNCATE` list, because no `CASCADE` can reach it |
| Core | `LlmCorrectionSchema` and `TranslationCorrectionSchema`, both capped at the 100 characters `TranslationRequestSchema` already caps learner input at; one optional field on each of `LlmTranslationSchema` and `TranslationResponseSchema` |
| Server | `domain/translation.ts` — **four** prompt rules (one of them replacing an existing rule); `resolveCorrection`, one pure function holding the four guards, the empty-entries clearing, the normalization of both forms and `resolveKind` against the corrected form; and `tidyAlternatives`, which it and the repository both call |
| Server | `services/translations.ts` — the redirect read; the one call to `resolveCorrection` that rewrites the queried form; the corrected-form probe, which serves a target the dictionary already holds instead of rewriting it and follows a known typo one hop; two log events; and `serveForm`: phase 12's F5 hit path extracted so step 1 and the redirect call the same function |
| Server | `repo/dictionary.ts` — `findCorrectionByForm` and `persistCorrection`, the second re-applying `tidyAlternatives` so the wire cap is a property of the write rather than of one caller |
| Server | `db/dictExport.ts` / `db/dictImport.ts` — a sibling `corrections.jsonl` |
| Tests | `tests/support/fakes.ts` — `FakeDictRepo` becomes **form-aware**; today `findSensesByForm` and `findStaleLexemesByForm` both ignore their argument, and every unit test of the three-step read needs them not to. It also gains the two correction primitives, backed by a map keyed by typed form |
| Tests | `tests/support/mockServer.ts` — `expectGeminiJson`'s payload gains an optional `correction`, without which no integration row below can drive a stub that corrects |
| Mobile | A correction banner and alternative chips on the translate screen; two strings; an optional override parameter on `useTranslation`'s `submit`, and the two `onPress={t.submit}` call sites it breaks |
| Data | `data/backfill/en-he/corrections.jsonl`, empty on arrival |
| Docs | ADR 0001 R8 amended a fourth time, in prose: a use case's dependent writes share one transaction; an independent, idempotent write may be its own. README's quotation of the rule, stale since phase 10, corrected with it |

**`tests/support/fakes.ts` is named here rather than left to the plan**, because it is the one
item on this list that is not obviously additive. `FakeDictRepo` today holds a single `hit:
SenseRow[]` and a single `stale: StaleLexeme[]`, and `findSensesByForm` returns `repo.hit`
whatever form it is handed. Steps 1, 3 and 5b of this phase's flow call that function with
**different forms in one lookup** and must get different answers, so both fields become maps keyed
by form. That touches every existing service unit test's fixture setup, and it is the reason the
unit rows in *Testing* are cheaper to read than to write.

No table removed, no endpoint added. One ADR amended, in prose only — ADR 0001 R8, a fourth
time, see *ADR consequences*. One optional property joins the published
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

**A redirect answers through the repair, not around it.** Phase 12's F5 amendment made a cache
hit conditional: `translate` reads the form's rows *and* its stale lexemes together, and where any
lexeme has learned a sense the form has never rendered, it re-renders that form before answering.
A redirect resolves `thruot` to `throat` and then reads `throat`'s rows — so unless the redirect
path runs that same staleness probe, `throat` repairs when typed directly and never repairs when
reached through the redirect.

That is not a cosmetic divergence. A redirect hit costs no provider call and nothing else ever
visits that read path, so the gap is permanent and one-directional: `thruot` would be frozen at
whatever `throat` rendered on the day the redirect was written, while `throat` itself keeps
converging. It would quietly break this phase's first success criterion, which is that a corrected
answer is **byte-identical** to typing the correct spelling.

So the redirect does not get a read of its own. Steps 1 and 3 of the flow below call **one
function** — resolve a form to its rows, repair it if any of its lexemes is ahead, answer — and
step 3 passes `corrected_form` where step 1 passes `form`. The correction block is then attached
to whatever that function returns. Byte-identical stops being a hope about two code paths staying
in step and becomes the same code path called twice, which is the only version of that criterion
a review can check.

**A corrected form the dictionary already holds is served, not rewritten.** The third revision
traced `bokked` only against a `booked` nobody had stored. Trace it against a `booked` that has
rows — which, once the backfill lands, is what a correction's target usually is, since
corrections resolve to common words — and the flow as it stood did the wrong thing twice. The
first `bokked` lookup misses at step 1, misses at step 2 because no redirect exists yet, and
call 1 reports the correction; the miss pipeline then runs on `booked`. Step 7 pays a
reconciliation call whose result the write is about to discard, because every insert in
`persistEntries` is `DO NOTHING` for a form that already has renderings. And step 8 runs
`persistEntries` on a form that already has rows, which phase 12's live flow never does — a hit
returns at step 1 before it can — so its consequences were never examined. If call 1 ranks the
entries differently from the stored variant, say adjective first where the stored `booked` has
the verb at `entry_rank 0`, the variant insert collides on `dict_variants_form_entry_rank_key`,
which the repository deliberately lets raise as its safety net; `translate`'s `catch` turns that
into a 200, and because steps 8 and 9 share one transaction the redirect is never written. Every
later `bokked` lookup repeats the two calls and the failed write, forever, as a log line. And if
the orders agree, step 5b of `persistEntries` stamps the existing variant level against the
lexeme's current version without having rewritten a rendering — so a `booked` that happened to
be stale is marked repaired without being repaired, which cancels the F5 promise for that form.

So a corrected miss probes its target before it writes anything. After `resolveCorrection` has
settled the effective form, and only when a correction is present, the flow calls `serveForm` on
it — the same function steps 1 and 3 call, staleness probe and repair included. On a hit the
lookup is over: one write transaction records the redirect, the answer is that hit's `kind` and
`senses` with the correction block attached, and neither the reconciliation call nor
`persistEntries` runs. Only when the corrected form has no rows of its own does the pipeline
continue to steps 6-9, which is the case the third revision traced and the only case in which
the reconciliation path is handed the corrected form; a repair on the probe hands
`buildRenderingPrompt` the same form for the same reason steps 1 and 3 do. The probe is the read
steps 1 and 3 already make, on a path that has just paid a provider call.

**The probe repairs, and that costs an ADR amendment rather than a workaround.** A probe hit
that repaired the corrected form has already committed the repair's transaction inside
`serveForm`, and must then record the redirect: two write transactions in one lookup, where R8
as phase 12 left it permitted one. The first draft of this revision kept the wording by making
the probe a bare read that never repairs, serving a stale target as stored once and leaving step
3 to repair it on the next lookup. That protected the letter of the rule and not its reason. R8
exists so that a use case's writes cannot land partially — the answer row without the
session-complete flag, the dictionary rows without the redirect that points at them — and a
repair beside a redirect is not that shape: each is correct alone, each is idempotent, and a
failure between them leaves a correct dictionary and one more provider call. The workaround,
meanwhile, reintroduced a second read path for one form — the divergence the third revision had
just removed at step 3 — and a one-lookup lag on top. So R8 is amended instead; the wording is
under *ADR consequences*.

This also bounds a risk the third revision could only record. *A corrected miss can cost two
provider calls, disproportionately often* was true because corrections resolve to common words
and common words already own a lexeme. That is exactly the population the probe answers from
storage: the second call now fires only for a corrected form that has no rows while its lexeme
already has senses — an inflection nobody has typed of a word someone has — rather than for
every corrected miss whose target is known.

**A corrected form that is itself a known typo is followed one hop, and no further.** The probe
reads rows; a second read beside it, made only when the probe missed, asks whether the corrected
form has a redirect of its own. That is the chain case — the model names `throte` as the
correction of `thruot`, and `throte` was itself corrected to `throat` when someone typed it — and
without the read, step 8 would write rows for `throte`: a `dict_variants` row for a string this
very table records as not a word, which then shadows `throte`'s own redirect forever by the
*Correct spellings win over redirects* rule. So when the corrected form has no rows but has a
redirect, the flow serves the redirect's target instead, writes `thruot → throat` rather than
`thruot → throte`, and attaches a correction block naming `throat`; the model's entries, which
described `throte`, are discarded unwritten. One hop only: if `throat` has no rows either — a
chain *and* a truncated dictionary — the lookup fails with `TranslationUnreadable` and writes
nothing, so the number of reads a lookup makes never depends on data. Failing closed on the
first hop instead was considered and rejected: at `temperature: 0` the retry returns the same
`throte`, which turns one typo into a permanently failing request, whereas the hop answers with
a real word's stored answer and writes nothing that is not already true.

**A misspelling is a routing fact, not a dictionary fact, so it gets its own table.** `thruot`
is not a form of `throat` — it is a string that should be read as one. Phase 12 sharpened this:
a `dict_variants` row now *owns its own renderings*, and `rank` lives on
`dict_var_translations` under `UNIQUE(variant_id, user_language_code, rank)`. Storing a
misspelling as a variant would therefore mean inventing a per-form rendering, an example
sentence and a rank ordering for a string that is not a word.

`dict_corrections` maps `typed_form → corrected_form` plus ranked alternatives. The corrected
form is then served through the **ordinary by-form read**, so a corrected answer is byte-identical
to typing the correct spelling — no interleaving to truncate, no `entry_rank` to collide, and a
repeat typo costs no provider call unless the corrected form is due a repair, in which case it
costs the one call a direct lookup would have paid (criterion 2).

It is also the stronger answer to the reported defect. `questions.prompt_variant_id` references
`dict_variants`; a misspelling that never becomes a variant **cannot** be quizzed, and no present
or future query has to remember to filter it out, which is what a boolean flag on the variant
would have required. Note what that does and does not promise: it is unconditional about a
*reported* misspelling and silent about an unreported one, which still becomes a variant and is
still quizzable. See *Detection is the model's job*.

**The correction target is a surface form, not a lemma.** A learner typing `bokked` wants
`booked`, whose lemma is `book`. Under phase 10 the distinction was invisible; phase 12 makes it
load-bearing, because `booked` renders `הזמין` and `book` renders `להזמין` on purpose.
`corrected_form` is therefore its own field, carried beside — never derived from — the entries'
`lemma`.

**Detection is the model's job, and one call does all of it.** The answer carries
`corrected_form`, the alternative forms, and the entries for the corrected form together, so a
corrected miss costs the same number of first calls as any other miss.

**Which makes every guarantee in this phase conditional on the model reporting a correction, and
that limit is load-bearing rather than incidental.** No edit distance, no dictionary probe, no
string comparison runs anywhere on the server; if call 1 answers `thruot` with entries and no
`correction`, then `effectiveForm` is `thruot`, `persistEntries` writes a variant for it, and the
reported defect occurs in full. The measurements above are exactly that behaviour, taken before
the prompt rule existed.

This bounds two claims that would otherwise read as structural. *"A misspelling is never a
`dict_variants` row"* holds for misspellings the model reports, not for misspellings; and the
integration test that pins it drives a stubbed provider that always corrects, so it verifies the
server's half and can say nothing about the model's. The eval bucket is the only place the
model's half is measured, which is why the four no-correction cases — three inflections and one
spelling variant — and the Hebrew case matter more than their line count suggests — and it is why *Risks* names a missed correction beside a wrong
one. Closing the gap structurally would mean a spellchecker or a second model call on every
uncorrected miss, both of which are out of scope; narrowing the defect to the cases the model
does report is the whole of what this phase buys.

**A stored redirect is never used to rewrite a form the model declined to correct, and refusing
to is the decision rather than an omission.** The case is reachable and the flow has the data in
hand: step 2 found a redirect for `thruot`, step 3 missed because the target has no rows, and call
1 then answered with entries and **no** `correction`. Reusing `redirect.corrected_form` as the
effective form would look like a free mitigation for the risk above — the server already holds
written evidence that this string is not a word — and it is rejected.

The reason is the third prompt rule. When no `correction` is present the model has been told to
build its example sentences around *the input as typed*, and those examples are exactly what
`persistEntries` stores. Writing that answer under `throat` would file example sentences
containing `thruot` against the correctly spelled form, permanently — the defect the third rule
exists to prevent, reintroduced through the one path that bypasses the rule's precondition. The
entries describe `corrected_form` **only** when the model says they do, and that conditional is
load-bearing here rather than cautious.

So the behaviour is stated plainly instead: **a variant is written for the typed form, and the
redirect is shadowed from then on.** Step 1 precedes step 2 permanently, so once `thruot` has rows
of its own the redirect is never consulted again. That is the same rule that protects a real word
from being routed away from itself — *Correct spellings win over redirects* — doing something
unwelcome, and it is the price of having exactly one rule rather than two. It is recorded in
*Risks* beside the missed correction it follows from, and criterion 3 is qualified for it.

**An alternative is a name, not an answer, and tapping one costs a full miss.** `alternatives`
carry no senses, and the entries in the same response describe `corrected_form` *only* — so
nothing is written for `throughout` when `thruot` resolves to `throat`. Tapping it is an
ordinary lookup that misses, calls the model, and may pay the reconciliation call on top: 10–30
seconds, exactly like typing it. Prefetching them was rejected — up to three extra first calls
on every corrected miss, to populate candidates a learner usually does not tap — but the cost is
real and the banner should not pretend otherwise.

**A correctly spelled inflected form is not a misspelling.** `running`, `booked`, `walks` and
`went` are real forms of real words and must return no correction. This is the rule the whole
feature turns on and the one most likely to regress, because `lemma ≠ typed form` is true of
both an inflection and a typo — which is precisely why detection cannot be a string comparison
and has to be asked for explicitly. (The eval bucket scores this against `saw`, which the
*prompt* may not name — see *The prompt* for why the two lists differ.)

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
  UNIQUE INDEX (language_code, lower(typed_form))   -- dict_corrections_form_key
  CHECK (length(typed_form)     BETWEEN 1 AND 100)  -- dict_corrections_typed_form_length
  CHECK (length(corrected_form) BETWEEN 1 AND 100)  -- dict_corrections_corrected_form_length
  CHECK (correction_alternatives_valid(alternatives))
                                                    -- dict_corrections_alternatives_valid
```

```sql
-- db/migrate.ts, beside question_options_valid and for the same reason: drizzle-kit
-- cannot generate CREATE FUNCTION, and CREATE OR REPLACE before migrate() is idempotent.
create or replace function correction_alternatives_valid(alts text[]) returns boolean
  language sql immutable as $$
  select coalesce(array_length(alts, 1), 0) <= 3
     and not exists (select 1 from unnest(alts) a where length(a) not between 1 and 100)
  $$;

-- migration 0007
CREATE TABLE dict_corrections (
  language_code   varchar(10) NOT NULL,
  typed_form      text        NOT NULL,
  corrected_form  text        NOT NULL,
  alternatives    text[]      NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dict_corrections_typed_form_length
    CHECK (length(typed_form) BETWEEN 1 AND 100),
  CONSTRAINT dict_corrections_corrected_form_length
    CHECK (length(corrected_form) BETWEEN 1 AND 100),
  CONSTRAINT dict_corrections_alternatives_valid
    CHECK (correction_alternatives_valid(alternatives))
);
CREATE UNIQUE INDEX dict_corrections_form_key
  ON dict_corrections (language_code, lower(typed_form));
```

**Stored as written, matched on `lower()`** — the same rule `dict_variants` uses, so a learner
who typed `Thruot` is matched by one who typed `thruot` while the row keeps the shape it
arrived in. Matching on an expression index is exactly what
`dict_variants_form_entry_rank_key` does.

**It is the first table in `db/schema.ts` with no `id` and no primary key, which is deliberate
and is not what the expression index buys.** The analogy above covers only the matching:
`dict_variants` carries a `text` `id` primary key *as well as* its expression index, and so does
every other table here. This one has no id because nothing can reference it — no foreign key
points at a redirect, `corrections.jsonl` keys a line by `typed_form`, and `persistCorrection`
addresses a row by `(language_code, lower(typed_form))` and never by id. An id would be a column
that exists only to look like the neighbours. The unique index is therefore the row's whole
identity, which is also why *proving it rejects a duplicate* is a test in its own right below.

If the preference is uniformity over minimalism, adding `id text PRIMARY KEY` later is an
additive migration and changes no query in this phase.

**`corrected_form` is a plain string, not a foreign key.** Referencing `dict_variants.id` would
couple the redirect to a row that `TRUNCATE … CASCADE` can remove. As a string, a dangling
redirect degrades into a miss and a model call rather than raising.

**Both forms are normalized before they are stored.** `typed_form` is the already-normalized
`form`, and `corrected_form` is `normalizeForm(correction.corrected_form)` — never the model's
string as it arrived. This is not cosmetic. What `normalizeForm` returns *is* the dictionary
key, and phase 12 added trailing-punctuation stripping to it (task 10, F4) precisely because
the dev database held `book` with three senses and `book?` with four. A model that answers
`corrected_form: "Throat."` would write exactly that as a `dict_variants.form` and as a redirect
target, reopening the defect through a path the learner's own input no longer takes. See also
the schema caps under *The contract change*: the request schema caps learner text at 100
characters, and an uncapped `corrected_form` would be the one untrusted string that escapes it.

**Normalizing is not by itself a validity check, which is why the guards below test the corrected
form's content rather than its length.** Phase 12's F4 rule strips a trailing sentence mark from
a single token *and returns the input unchanged when stripping would empty it* — the `stripped
=== '' ? collapsed : stripped` branch, which exists so that a learner typing `?` is not turned
into an empty dictionary key. The consequence here is that `normalizeForm('???')` is `'???'`, not
`''`: punctuation survives normalization intact and would become a `dict_variants.form` and a
redirect target unless something else rejects it.

**The caps are constraints, not only schema rules.** `TranslationCorrectionSchema` caps a form at
100 characters and the list at three, and `tidyAlternatives` holds the count and the duplicates
on the write — but `dict:restore` reaches `persistCorrection` without passing through either
schema, `router.openapi` does not validate responses at runtime, and a 101-character
`corrected_form` in a hand-edited `corrections.jsonl` would therefore reach the wire in violation
of the published contract without anything noticing. So the three caps are `CHECK` constraints
as well, on the precedent `users` set — *the schema gives a 400 with a good message, the
constraint is what actually holds when something bypasses the route* — and the array's element
rule is an `IMMUTABLE` SQL function, the mechanism `question_options_valid` already uses for
`questions.options`, installed where that one is. On the live path the constraints can never
fire: `LlmCorrectionSchema` bounds every string at 100 before it is parsed, `normalizeForm` only
ever shortens, and `tidyAlternatives` truncates to three — so `persistCorrection` still raises on
nothing a model can send, which the *first-writer-wins* paragraph below depends on. On a restore
a raise is the desired failure, exactly as restoring `vocabulary.jsonl` into a migrated database
was in phase 12.

**`persistCorrection` is `ON CONFLICT DO NOTHING` on the unique index — first-writer-wins, like
every other write in this dictionary.** Not a detail: three ordinary paths write a redirect for
a form that already has one, and a raise on any of them is silently destructive, because steps 8
and 9 share a transaction and `translate`'s existing `catch` turns a failed write into a
successful 200.

- Step 3 fell through — a redirect exists but its target has no rows — so the model is called
  and step 9 writes again.
- Two learners miss the same typo concurrently.
- `dict:restore` replays `corrections.jsonl` onto a database that already holds some of it,
  which is the normal production case and the one `dictImport` is already idempotent for.

A raise in any of those rolls `persistEntries` back with it, so the corrected form is *never*
written, so step 3 misses again on the next lookup, forever: a permanent two-call tax on one
typo, showing up as a log line rather than as an error. The unique index still has to be
*proven* to reject a duplicate — that is what makes the redirect single-valued — but it is
proven against raw SQL, not through `persistCorrection`, whose contract is that a second write
is a no-op.

**`text[]` rather than `jsonb`**, matching `session_questions.option_order`'s use of a Postgres
array for a homogeneous list. Capped at three and deduplicated — against `corrected_form`,
against the typed form, and against **each other**. Nothing in Postgres enforces the last of
those: `text[]` admits `{throughout, throughout}`, and two identical chips under *"did you mean"*
is a defect a learner sees.

**That tidying is `persistCorrection`'s job as well as the guards', and an earlier revision put it
only in the guards.** It described the wire's three-item cap as *"an invariant the SERVER holds
rather than a hope about a third party"*, which reads well and is false of this repository:
`dictImport` does not go through `domain/` at all. It calls `persistEntries` directly, with no
`mergeEntries` and no guard, and that is deliberate — a restored row and a looked-up row are
indistinguishable precisely because the restore replays through the *repository*. A corrections
restore does the same, so a `corrections.jsonl` holding four alternatives — hand-edited, or
written by some later revision with a different cap — would produce a row that violates the
published response schema on every redirect hit. `router.openapi` does not validate responses at
runtime, so it would ship silently.

So the tidy is a pure function in `domain/`, `tidyAlternatives`, and it is called **twice**: by
the guards, so the response the model's own answer produces is right, and by `persistCorrection`,
so the cap is a property of the write rather than of one caller. `repo/dictionary.ts` already
imports `entriesToRows`, `rowsToSenses` and `staleLexemes` from `domain/dictionary`, so this adds
no import direction ADR 0001 does not already permit.

**Nothing references this table, and nothing cascades to it either.** The first half is the
point: `questions.prompt_variant_id` reaches `dict_variants` only, so no row here can become a
quiz prompt. The second half is a consequence that has to be paid for explicitly.

**`reseedContent` gains `dict_corrections` in its `TRUNCATE`.** `db/reseed.ts` runs
`TRUNCATE dict_lexemes, sessions CASCADE`, and `CASCADE` follows foreign keys — of which this
table has none, by the decision two paragraphs above. Left alone, every `npm run db:reseed` would
empty the dictionary and leave the entire redirect table pointing into it. That is not a cosmetic
leftover: *Risks* below describes a dangling redirect as needing "a truncated dictionary and an
unstable model", and a reseed produces the truncated dictionary on demand — it is a supported
command, and phase 12 ran it repeatedly while re-recording.

The statement becomes `TRUNCATE dict_lexemes, dict_corrections, sessions CASCADE`, and
`dict_corrections` is named for the same reason `sessions` already is: nothing references it, so
nothing would cascade to it. This is also the symmetric choice rather than merely the safe one.
`reseedContent` already drops every looked-up word, on the reasoning that *"the loss is provider
calls rather than data, since the dictionary is a cache"*; a correction is the same kind of cache
of the same kind of paid answer, and it is recoverable the same way — `dict:export` before,
`dict:restore` after, now carrying both files.

The migration is additive and runs on a database phase 12 has already truncated. Nothing
backfills.

## The flow

`serveForm` below is phase 12's F5 hit path, lifted out of `translate` and given a parameter.
It is not new behaviour and not new machinery: `translate` already reads a form's rows beside its
stale lexemes, repairs where a lexeme is ahead, and answers. Naming it is what lets a redirect
reach the *same* path rather than a parallel one — see *A redirect answers through the repair*.

```
serveForm(f):                                   -- phase 12's F5 hit path, extracted verbatim
  one read transaction: rows  = findSensesByForm(f)
                        stale = findStaleLexemesByForm(f)
  rows empty            -> MISS                 -- checked FIRST: a variant with no renderings
                                                   in this target language is a miss, not a
                                                   repair, even if its lexeme is ahead
  stale non-empty       -> answerRows = repairForm(f, stale); log dict_repaired
                           on failure log dict_repair_failed and answerRows = rows
  otherwise             -> answerRows = rows
  return { kind: kindForForm(answerRows), senses: rowsToSenses(answerRows) }
                                                -- BOTH fields off the rows actually served,
                                                   so a repair re-ranks the answer it returns.
                                                   The repair events are logged HERE, because
                                                   they describe the repair whichever path
                                                   reached it; the hit is NOT — only the
                                                   caller knows which kind of hit it was

translate(text):
  form = normalizeForm(text)

  ── reads; each may be its own transaction, per R8 as amended by phase 12 ──
  1  serveForm(form)                            hit  -> log dict_cache_hit; respond as today,
                                                        no correction
  2  findCorrectionByForm(form, source)         miss -> step 4
  3  serveForm(redirect.corrected_form)         hit  -> log dict_redirect_hit; respond: that
                                                        answer's kind and senses UNCHANGED,
                                                        plus the correction block built from
                                                        the redirect row
                                               miss -> fall through to the model

  4  call 1 -> parse -> resolveCorrection(parsed, { typedForm: form, direction }), in domain/:
       the four guards; the empty-entries clearing; corrected_form and the alternatives
       normalized and tidied; effectiveForm; resolveKind against effectiveForm.
       It returns null when the answer cannot be used at all — the fourth guard — and the
       service raises TranslationUnreadable, exactly as for an answer that failed to parse.

  5  { correction, effectiveForm, kind } = that result
                    -- `correction` is the model's, never the redirect step 2 may have found.
                       A model that declined to correct is answered on its own terms; see
                       "A stored redirect is never used to rewrite a form the model declined
                       to correct"

  ── the corrected-form probe, only when correction is present ──
  5b serveForm(effectiveForm)                   -- the SAME function as steps 1 and 3, repair
                                                   included. A hit may therefore already have
                                                   committed the repair's transaction; the
                                                   redirect below is a second, INDEPENDENT
                                                   write, which R8 as amended by this phase
                                                   permits — see "R8 is amended"
       hit                -> one write transaction: persistCorrection(form -> effectiveForm)
                             log dict_corrected; respond: that answer's kind and senses
                             UNCHANGED, plus the correction block. No call 2, no
                             persistEntries: the target already holds its own renderings
       miss               -> hop = findCorrectionByForm(effectiveForm, source)
          found           -> the model named a known typo. ONE hop, no further:
                             serveForm(hop.corrected_form)
             hit          -> one write transaction: persistCorrection(form -> hop.corrected_form)
                             log dict_corrected; respond from that answer, the correction
                             block naming hop's target; the model's entries are discarded
             miss         -> throw TranslationUnreadable; nothing is written
          none            -> step 6

  ── from here phase 12's miss pipeline runs verbatim, on effectiveForm ──
  6  the sentence / empty-entries early return
  7  read each entry's lexeme for stored senses; call 2 and reconcile if any has them;
     a failing call 2 throws and writes nothing
  ── one write transaction ──
  8  persistEntries(form: effectiveForm, ...)
  9  if correction: persistCorrection(typed_form: form, corrected_form, alternatives)
                    ON CONFLICT DO NOTHING — a second write for one typed form is a no-op
                    log dict_corrected
```

**Two log events, and they are the phase's only production instrument.** Every other test in
this document drives a stub that corrects whenever the test says so; the eval bucket asks a real
model but runs in CI against fourteen fixed strings. Neither can answer *is this working for
learners*, and the register below opens with a risk — a correction the model simply does not
report — whose entire failure mode is that everything stays green. `dict_corrected` (on either write
of a redirect — the probe's at step 5b and the miss path's at step 9) and `dict_redirect_hit`
(on step 3) make the mechanism countable: a rate that falls to zero after
a model update is the signal that nothing else in this design produces.

Both follow the conventions the file already holds to. Counts and `direction` only — **the
learner's query text stays out of the log**, which is why `dict_corrected` carries
`alternative_count` and not the forms — and both sit beside `dict_persisted`, `dict_cache_hit`,
`dict_reconciled`, `dict_repaired` and `dict_repair_failed` rather than introducing a second
logging style. `dict_repaired` and `dict_repair_failed` fire from inside `serveForm`, because
they describe the repair whichever path reached it, and need no change. The two hit events are
logged by `translate`, which is the only place that knows whether a hit was direct or redirected:
extracted with the hit log still inside it, `serveForm` would count every redirect hit as a cache
hit as well, and the ratio between the two is precisely what the second event exists to show.

**Step 3 is step 1 with a different argument, and that is the whole of the fix.** A redirect
hit is byte-identical to typing the correct spelling because it is produced by the same
function, including the staleness probe and the repair. Had step 3 read the rows directly, a
`throat` whose lexeme later grew would repair when typed and never repair when reached through
`thruot` — permanently, since a redirect hit makes no provider call and nothing else visits that
path. The correction block is attached *after* `serveForm` returns and changes neither field it
produced.

**Every path through `translate` keeps its dependent writes in one transaction, and step 5b is
where that wording matters.** `serveForm` either repairs and returns, or does not repair — and
when step 3 repairs, `translate` returns at step 3 and never reaches step 8. Step 5b is the one
place a lookup can commit two transactions: a probe hit may have repaired the corrected form
inside `serveForm`, and then records the redirect. Those two writes are independent — the repair
is correct whether or not `thruot → throat` lands, and the redirect is correct whether or not
`throat` was just repaired — and each is idempotent, so a failure between them leaves a correct
dictionary and one more provider call on the next lookup. That is the case R8's fourth amendment
admits by name; see *R8 is amended* below. Steps 8 and 9 are dependent — a redirect must not
point at a form with no rows — and stay in one transaction.

**The hot path is untouched.** A correctly spelled word resolves at step 1 exactly as it does
today, repair included, and pays nothing for this phase. Steps 2 and 3 are reached only when the
typed form has no rows — a path that otherwise costs a provider call measured in seconds, against
which two indexed lookups are noise.

**Correct spellings win over redirects.** Step 1 precedes step 2, so a string that is a real
form in its own right is never routed away from itself, even if a redirect for it exists.

**Step 2 is one read and step 3 is a `serveForm` call, so they are not merged.** An earlier
revision had them share a transaction, on the reasoning that *is this string a redirect, and does
its target have rows?* is one question. That stops being true once step 3 has to probe staleness
and may open a write: `serveForm` owns its own read transaction, which is exactly what makes it
reusable, and folding step 2 into it would mean passing a redirect lookup through a function that
knows nothing about redirects. Step 2 stays its own read — a single indexed lookup on a miss path
that already costs seconds — and step 3 is an ordinary call.

**`resolveKind` changes its argument on every path, not only the corrected one.** Today it is
called on `text`; from this phase it is called on `effectiveForm`, which is `normalizeForm(text)`
when nothing was corrected. The two agree for every input the request schema admits —
`normalizeForm` collapses internal whitespace and strips a trailing sentence mark from a single
token, neither of which adds or removes whitespace from a multi-token string, and `resolveKind`
asks one question, *does this contain whitespace* — so this is a simplification rather than a
behaviour change. It is called out because the diff touches the uncorrected path and a reader
would otherwise have to re-derive that it is safe.

**`resolveKind` is not, however, enough to make `kind` describe the corrected form, and an earlier
revision of this document claimed it was.** Read what the function actually does:
`/\s/.test(text.trim()) ? modelKind : 'word'`. It **clamps a single token to `word`** and
otherwise **defers to the model**. So `resolveKind('break a leg', 'word')` returns `'word'` — the
clamp does not fire, and the model's answer stands unexamined.

That matters because `kind` is not a property of the response alone. `persistEntries` writes it
onto `dict_variants.kind` for the **corrected** form, first-writer-wins, and `kindForForm` reads
it straight back on every later hit. A model handed the single token `breakaleg` will classify
*that* — a word — and the server then stores `kind: 'word'` against the variant `break a leg`. A
later *direct* lookup of `break a leg` hits that row and is answered `word` forever, having never
been mistyped by anyone. A corrected lookup can freeze the wrong `kind` on a legitimate phrase.

No server-side rule can repair it, because the mirror of the clamp does not exist: a multi-token
form can be a phrase or a sentence, and nothing in code can say which. So this is a **prompt**
obligation, and *The prompt* below carries a fourth rule for it — when `correction` is present,
`kind` classifies `corrected_form`. `resolveKind` against `effectiveForm` remains correct and
remains necessary; it is the half that handles `bokked` → `booked`, where the clamp does fire.
It is simply not the whole of the job.

**A dropped correction must be dropped before `effectiveForm`, not after it.** This is the reason
`resolveCorrection` clears `correction` when `entries` is empty before it computes the effective
form, and it is the one ordering trap in the flow. `kind` is computed from `effectiveForm`, and the empty-entries early return at step 6
carries that `kind` — so a correction that step 6 declines to report has *already* changed the
answer by the time step 6 runs. A model answering `zxqwbtl` with `entries: []` and
`corrected_form: "zxq wbtl"` would return `kind: 'phrase'` for a single-token input: no
correction block, no rows written, and a `kind` that came from a correction the response denies
carrying. Clearing the correction first makes the empty answer identical to an uncorrected one in
every field, which is what success criterion 7 actually asks for.

**Steps 8 and 9 share one write transaction**, which is what makes phase 12's fail-closed rule
cover this phase for free: a failed reconciliation call writes no entries *and* no redirect, so
a redirect can never point at a form that has no rows.

**R8 is amended, a fourth time, and by this phase.** Phase 12 left it at *"a use case opens at
most one write transaction; reads preceding third-party I/O may each be their own"*, and this
use case's reads still fit that clause: `serveForm`'s combined rows-and-staleness read (up to
three times — steps 1, 3 and 5b), the redirect lookups, `repairForm`'s own per-lexeme read
where a repair fires, and phase 12's stored-senses read before call 2. What no longer fits is
the write side at step 5b: a probe hit can have repaired the corrected form — one transaction,
inside `serveForm` — and must then record the redirect, a second. The rule now reads: *a use
case's **dependent** writes share one transaction; a write that is **independent and
idempotent** — correct on its own whether or not the others land, and a no-op when repeated —
may be its own; **reads** preceding third-party I/O may each be their own.* The repair and the
redirect are the case it names: the repair is stamped against the sense version it rendered,
the redirect is `ON CONFLICT DO NOTHING`, and neither is wrong without the other. Steps 8 and 9
are the other kind — a redirect must not point at a form with no rows — and stay in one
transaction. The amendment is prose: the detection command greps `\.transaction(` outside
`db/transaction.ts` and is indifferent to how many bare `transaction(...)` calls a service
makes, so no check changes and the architecture check stays at seventeen rules. The
dependent/independent judgement is made here, in the design doc, and enforced by review, like
R9 and R12.

### The four guards, in one function

All four live in `domain/`, inside one pure function — `resolveCorrection(parsed, { typedForm,
direction })`, returning `{ correction, effectiveForm, kind }` or `null` — applied to the parsed
answer before phase 12's early return, so a dropped correction costs no database read and no
second model call. The first three drop the whole `correction` and leave the entries alone: the
answer then behaves exactly as an uncorrected one. The fourth is different in kind.

- **`corrected_form` normalizes to the typed form** — `normalizeForm` on both, compared
  case-insensitively — → drop. Removes a whole class of *"did you mean throat? — showing results
  for throat"*.
- **The normalized `corrected_form` contains no letter or digit** → drop. Written as a content
  test, `/[\p{L}\p{N}]/u`, and **not** as *"normalizes to the empty string"*, which an earlier
  revision specified and which does not do the job. `normalizeForm` returns the input unchanged
  whenever stripping would empty it (phase 12's F4 branch, `stripped === '' ? collapsed :
  stripped`), so `normalizeForm('???')` is `'???'`: a `corrected_form` of `???` clears an
  empty-string test, clears the identity test above, becomes the effective form, and is written
  as a `dict_variants.form` and as a redirect target. Only a whitespace-only string — which
  `.min(1)` barely admits — normalizes to `''` at all, so an empty-string test fires on almost
  nothing. The letter-or-digit test covers both: whitespace, punctuation, and any mixture of them.
- **`kind === 'sentence'`** → drop. Detection is scoped to words and phrases, so a sentence
  carrying a correction is the model ignoring its instructions rather than a case to handle.
- **The corrected form is in the wrong script** — `detectDirection(effectiveForm) !== direction`
  — → **the answer is unusable and `resolveCorrection` returns `null`**; the service raises
  `TranslationUnreadable`, exactly as it does for an answer that failed to parse, and nothing is
  written. Not a drop, because dropping would not help: the entries describe the corrected
  headword, so they are wrong in the same way. The case is a transliteration — `shalom` typed
  under `en_he` — which is not an English word and is plausibly the Hebrew one, and the prompt's
  *"either language"* wording, kept above for a good reason, is what licenses the model to name
  it. `direction` was detected from the typed script before call 1 and is fixed for the request,
  so left unchecked `effectiveForm` would be a Hebrew string written as an English variant, the
  redirect stored under `en`, and the entries the product of an English-to-Hebrew prompt asked
  about a Hebrew headword. A wrong row is permanent and a failed request costs one retry: this is
  phase 12's fail-closed rule applied to call 1. `domain/` cannot throw — R3 — which is why the
  function returns `null` rather than raising, the arrangement `parseLlmTranslation` already
  uses.

A fifth rule sits inside the same function and is deliberately **not** listed as a guard: a
correction on an answer with `entries: []` is cleared before the effective form is computed. It
is separate because the guards are content tests on the correction while that one is a test on
the *entries*, and because where it runs matters more than what it does — see the last paragraph
of this section. An earlier revision put it in the service, at step 5 of the flow, and then filed
its tests under `domain/translation.test.ts`, which could only test it if it lived in `domain/`.
One function holding the guards, the clearing, the normalization of both forms, the tidy and
`resolveKind` is what makes the service one call, makes the ordering trap below a property of a
pure function rather than of a sequence of statements in a use case, and gives the eval harness
something to call instead of copy — see *Evals*.

Alongside the guards, the alternatives are **tidied rather than rejected**, by a pure function
`tidyAlternatives(alternatives, { correctedForm, typedForm })` in `domain/`: an absent list
becomes `[]`; each entry is normalized; any that now contains no letter or digit is removed, by
the same test the guard uses; duplicates of `corrected_form`, of the typed form, and **of one
another** are removed, case-insensitively and keeping the first occurrence so the model's ranking
survives; and the result is truncated to three. Truncating is deliberate — see *The contract
change* for why a fourth alternative must not be allowed to fail the parse.

It is a named function rather than a few lines inside the guard because it has **two callers**.
`persistCorrection` applies it again on the way into the database, so the three-item cap survives
a `dict:restore`, which reaches the repository without passing through `domain/` at all — see
*Data model*. Idempotent by construction: tidying an already-tidy list returns it unchanged, so
the second application costs nothing and the two callers cannot disagree.

**The absent-list case is where `LlmCorrectionSchema.alternatives` being `.optional()` is paid
for.** The schema does not default it (see *The contract change*), so a model that omits the key
hands `domain/` an `undefined`, and `tidyAlternatives` turning that into `[]` is what keeps a
missing decorative field from reaching the wire schema, which requires the array. One line, in
the one function every correction already passes through.

**The sentence guard suppresses the notice but keeps the entries, and that is a judgement, not
an oversight.** Under the prompt contract the entries describe `corrected_form` whenever a
correction is present, so dropping only the notice means a sentence carrying one is answered
silently — the reported defect in miniature. It is accepted because the alternative is worse: a
sentence is never written to the dictionary, so nothing is poisoned, and refusing the answer
outright would fail a request the model has translated correctly on the strength of a field it
was told not to send. The narrow scope is what makes this rare; the eval bucket's sentence cases
are what would show it becoming common.

**A `correction` arriving with `entries: []` is cleared inside `resolveCorrection`, and that is a
rule rather than an accident.** Two things have to be true of that answer, not one. The response
must carry no `correction` — phase 12's early return builds a fresh object, so the field must
simply not be added there — *and* its `kind` must not have been derived from the corrected form,
which is why `resolveCorrection` clears the correction before computing `effectiveForm` rather
than relying on the return to omit a field. No redirect is written either way, and `zxqwbtl`
keeps answering with the empty state and nothing else. Stated explicitly because both halves are
one line each, and an implementer who adds `correction` to *"every response path"*, or who
clears it at the return instead of before the effective form, breaks success criterion 7 in a
way no response field reveals.

### Worked through, end to end

```
1  'thruot'  miss on the form, miss on corrections
             call 1 -> correction { corrected_form: 'throat',
                                    alternatives: ['throughout'] }
                       entries    [(throat, noun)]      <- describing THROAT
             effectiveForm = 'throat'
             the probe: 'throat' has no rows and no redirect of its own -> the pipeline
             (throat,noun) is new, so no call 2
             persistEntries(form: 'throat', ...)        <- the correct spelling
             persistCorrection('thruot' -> 'throat', ['throughout'])
             -> senses [גרון, צוואר]
                correction { corrected_form: 'throat', alternatives: ['throughout'] }

2  'thruot'  miss on the form, HIT on corrections -> serveForm('throat') -> the same answer.
             No provider call. Zero rows written.

3  'throat'  HIT on the form at step 1. No correction block. The redirect is never consulted.

3b later, a lookup of 'throats' teaches (throat,noun) a third sense, so the variant
             'throat' is now behind its lexeme.
   'thruot'  miss on the form, HIT on corrections -> serveForm('throat') finds the variant
             stale, makes ONE reconciliation call, rewrites 'throat''s renderings and
             answers from them — the same answer, to the byte, that typing 'throat'
             returns, and for the same reason: the same function produced both.
             The correction block is attached afterwards and changes neither field.
             Read the rows directly here instead and 'thruot' would serve two senses
             forever while 'throat' serves three.

4  tap 'throughout' -> an ordinary lookup of 'throughout'. A full MISS the first time —
             nothing was written for it above — so a model call, possibly two, and 10-30s.
             A normal cached word from then on. It is not a correction and holds no redirect.

5  'bokked'  where 'book' has been looked up but 'booked' never has — so the verb lexeme
             holds senses and the form 'booked' has no rows of its own.
             call 1 -> correction { corrected_form: 'booked', alternatives: [] }
                       entries [(book, verb)]
             effectiveForm = 'booked'
             the probe: 'booked' has no rows and no redirect -> the pipeline
             (book,verb) already HAS senses -> call 2, handed the form 'booked'
                                               NOT 'bokked'
             -> renderings agree with 'booked': הזמין, not a rendering of a typo
             persistEntries(form: 'booked', ...)
             persistCorrection('bokked' -> 'booked', [])

6  'bokked'  the same lookup against a dictionary that already holds 'booked' — which,
             once the backfill lands, is the ordinary case.
             miss on the form, miss on corrections (the first time)
             call 1 -> correction { corrected_form: 'booked' }, entries [(book, adjective),
                                                                          (book, verb)]
             effectiveForm = 'booked'
             the probe: serveForm('booked') HITS -> persistCorrection('bokked' -> 'booked'), and
             the answer is serveForm's — 'booked''s stored rows, repaired first if the
             lexeme is ahead — plus the correction block. No call 2, no persistEntries.
             ONE provider call, two if the repair fired.
             Without the probe: call 2 for 'booked', then persistEntries('booked') on a form
             that already has rows. The stored variant has the verb at entry_rank 0 and this
             answer leads with the adjective, so the adjective's variant insert collides on
             dict_variants_form_entry_rank_key — the safety net, which raises — the catch
             answers 200, and the redirect is rolled back with the write. Then the same two
             calls and the same failed write on every 'bokked' lookup, forever.

7  'thruot'  where 'throte' was typed by someone earlier and corrected to 'throat', and the
             model now corrects 'thruot' to 'throte' — a chain. Contrived: the prompt asks
             for a real surface form. Nothing enforces it.
             call 1 -> corrected_form: 'throte'
             the probe: serveForm('throte') misses, a redirect 'throte' -> 'throat' exists,
             and serveForm('throat') hits -> persistCorrection('thruot' -> 'throat'); the
             answer is 'throat''s and the correction block names 'throat'. The model's entries,
             which described 'throte', are discarded unwritten.
             Without the hop: persistEntries('throte') writes a variant for a string the
             redirect table already records as a typo, and from then on 'throte' hits at
             step 1 and its own redirect is never consulted again.
```

Four cases to check in review. **Step 5** is the substitution: it happens once, inside
`resolveCorrection`, and the reconciliation call phase 12 added never sees the typed string.
**Step 3b** is the repair reached through a redirect, which is the case an implementation is most
likely to get wrong by reading the corrected form's rows directly. **Step 6** is the probe, and
the case an implementation is most likely to get wrong by not having one: it is the ordinary
corrected miss after the backfill, and without it the correction never gets written. **Step 7**
is the hop, one link and no more.

Exactly one row exists for `thruot` across all of this — a `dict_corrections` row — and none at
all in `dict_variants`. That holds for as long as every call 1 for `thruot` reports a correction;
an answer that reports none writes a `thruot` variant like any other miss, which is the limit
recorded under *Detection is the model's job* and in *Risks*.

## The contract change

Two optional fields, one on the model's schema and one on the wire. Nothing is removed and no
field changes type.

```ts
// What the model reports. Present only when the typed string is not a word or expression
// in either language but is near one or more that are.
export const LlmCorrectionSchema = z.object({
  // A surface form, not a lemma: `bokked` corrects to `booked`, never to `book`.
  // `.max(100)` is the request schema's own ceiling on learner text: this is the one
  // untrusted string that does not come through it, and it becomes a dictionary key.
  corrected_form: z.string().min(1).max(100),
  // Other plausible intended forms, ranked, no senses. Tapping one is an ordinary lookup
  // that misses.
  //
  // `.optional()`, NOT a bare array — a bare array would be REQUIRED, and this field must
  // never be able to fail a good answer. `parseLlmTranslation` runs `dropNulls` BEFORE
  // `safeParse`, because phase 9 made absent and null mean the same thing, so a provider
  // answering `alternatives: null` — which is how structured output spells "none" — has
  // the key deleted and would then fail a required field. The whole `LlmTranslationSchema`
  // parse fails with it, and one decorative empty list turns a correct translation into a
  // 502 by way of `TranslationUnreadable`. A provider that simply omits the empty array
  // lands in exactly the same place. `.optional()` makes both spellings mean "absent", and
  // `tidyAlternatives` turns absent into `[]` — see *The four guards, in one function*.
  //
  // `.default([])` was the obvious spelling and is deliberately NOT used. Zod 4 emits a
  // `"default": []` key into the JSON Schema, `toGeminiSchema` strips only `$schema` and
  // `additionalProperties`, so the key would travel to Gemini inside `responseSchema` —
  // and no schema in this repository has ever sent it. If Gemini rejected it the provider
  // would raise LlmUnavailable('responded 400') on EVERY translation call: a total outage
  // of the endpoint rather than a degraded correction, which is the precise opposite of
  // what this field's whole design is for. `.optional()` is the mechanism already proven
  // in production here — `LlmSenseSchema.example` and `LlmRenderingSchema.example` are
  // both optional and both work — so it costs one `?? []` in a function that is already
  // normalizing this list, in exchange for adding no new schema surface at all.
  //
  // (Worth knowing if `.default()` is ever revisited: `z.toJSONSchema` defaults to output
  // mode, where a defaulted field is REQUIRED. So `.default([])` would also have told
  // Gemini the key is mandatory, which is a second behaviour change hiding inside what
  // looks like a parser-side convenience.)
  //
  // Six here against three on the wire, and the difference is the same point again.
  // `maxItems` travels to Gemini inside `responseSchema`, so the model is bounded either
  // way — but a provider that ignores it would, under `.max(3)`, fail the WHOLE parse on
  // one surplus alternative. `tidyAlternatives` truncates to three instead. Six matches
  // `entries`' own cap, chosen the same way: wide enough that a conforming provider never
  // reaches it.
  //
  // The rule all of this follows: `correction` is decorative, so NOTHING about it may
  // fail an answer the model otherwise got right. Only `corrected_form` is load-bearing,
  // and it is `min(1)` because a correction without one is not a correction.
  alternatives: z.array(z.string().min(1).max(100)).max(6).optional(),
});

export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  // When `correction` is present these describe `corrected_form`, not the typed text —
  // and so does `kind`, which the prompt's fourth rule is what actually secures.
  entries: z.array(LlmEntrySchema).max(6),
  correction: LlmCorrectionSchema.optional(),
});
```

```ts
// Three, not six: every correction that reaches the wire has been through
// `tidyAlternatives`, applied by the guards on the model path and again by
// `persistCorrection` on the write — so this cap is an invariant the SERVER holds rather
// than a hope about a third party, which is exactly the kind of cap a published contract
// should state. Applying it in only one of those two places was an earlier revision's
// mistake: `dict:restore` reaches the repository without passing through `domain/`.
export const TranslationCorrectionSchema = z.object({
  corrected_form: z.string().min(1).max(100),
  alternatives: z.array(z.string().min(1).max(100)).max(3),
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
change beyond the new schema — **provided every field inside `correction` tolerates being
stripped**, which is what `alternatives`' `.optional()` is for. `dropNulls` is the reason this is
required rather than merely tidy: it turns `null` into *absent*, and absent is fatal for a field
that is neither optional nor defaulted. `domain/` then turns absent into `[]`, one `?? []` inside
`tidyAlternatives`, which is the same place the list is already being deduplicated and truncated.

On the wire side `alternatives` stays **required and un-defaulted**, because by then the server
has built it and an empty array is written literally. The asymmetry is the point: what a third
party sends may be absent, what this server publishes may not be.

### The prompt

The existing rule becomes a three-way split:

| Typed | Outcome |
|---|---|
| `throat`, `booked`, `running` | a real word or form → entries as today, **no** correction |
| `thruot`, `recieve`, `brake a leg` | not a word, but near one or more → **correction** |
| `zxqwbtl` | near nothing → empty entries, no correction |

**The existing rule is REPLACED, not supplemented, and an earlier revision of this section left
that ambiguous in the one way that matters.** It reads today:

> If the input is not a word or expression in either language, return an empty entries array
> rather than inventing a translation.

Left standing beside a new rule telling the model to answer such an input with entries for a
different form, it is a flat contradiction, and it is a contradiction about **exactly the input
this phase exists for**. `thruot` satisfies its antecedent — it is not a word in either language —
so the old rule demands empty entries while the new one demands entries describing `throat`. The
model would be free to do either, which is the worst of the three possible outcomes, because it
is the one no test can pin. The measurements at the top of this document were taken against that
rule and show it already misfiring: it fires for `zxqwbtl` and for nothing else.

It becomes, with the added clause carrying the whole difference:

> If the input is not a word or expression in either language **and no real word or expression
> was plausibly intended, return an empty entries array and omit `correction`**, rather than
> inventing a translation.

*"In either language"* is kept rather than narrowed to the source language, and the new rules
below say "either language" for the same reason: `direction` is detected from the script and can
be wrong, so a rule scoped to the detected source would let a real English word typed under
`he_en` be reported as a misspelling of a Hebrew one. The schema comment above is worded to
match; an earlier revision had the schema say *"source language"* and the prompt say *"either"*,
which is the same bug one layer up.

**Four rules are added** — three about the correction itself, and one about `kind`:

> A correctly spelled inflected form is not a misspelling: `running`, `booked`, `walks` and
> `went` are real forms of real words — return them normally and omit `correction`.
>
> When the input is not a word or expression in either language but one or more real ones
> were plausibly intended, set `correction.corrected_form` to the single most likely intended
> **surface form** — matching the grammatical form the learner appears to have typed, so
> `bokked` corrects to `booked` and not to `book` — and list up to three other plausible
> intended forms, ranked, in `correction.alternatives`. The `entries` then describe
> `corrected_form`.
>
> When `correction` is present, build the example sentence around `corrected_form`, never around
> the input as typed.
>
> When `correction` is present, classify `corrected_form` rather than the input as typed:
> `breakaleg` is corrected to `break a leg`, so its kind is "phrase" even though what was typed
> is a single token.

The third suspends, for this path only, phase 12's *"build the example sentence around the input
as typed"*. Without it the dictionary stores example sentences containing a misspelling.

**The fourth is the one a reader will think redundant, and it is the one with a permanent
consequence.** `resolveKind` clamps a single token to `word` and otherwise defers to the model, so
it cannot rule on a multi-token corrected form; `kind` is then written onto
`dict_variants.kind` for that form, first-writer-wins, and read back by `kindForForm` on every
later hit — including the hit a learner who spells `break a leg` correctly gets. Without this
rule, one mistyped lookup freezes `kind: 'word'` on a real phrase for the life of the dictionary.
The full argument is under *The flow*; it is stated here too because the rule looks decorative
sitting next to the other three.

Its illustration reuses `break a leg`, which `buildPrompt` already names in the
imperative-expression rule, so it adds no new exposure under the constraint below.

**The first rule's illustration words are constrained, and `saws` — the obvious choice — is
forbidden.** The system instruction is part of the request body, and the integration bucket's
MockServer expectations match on a regex over that whole body. Naming `saws` in the prompt would
put it in *every* first call's body, so a lookup of any word would match the `saws` expectation
and be answered with the wrong payload — a failure that looks like a service bug and is a prompt
edit. Phase 12 hit exactly this in task 11.

**The forbidden set is what is registered today, read with the encoding in mind.** Every
`matchText` currently registered across `apps/server/tests/` is one of two kinds:

| Registered as | Where | Matches a body containing |
|---|---|---|
| `saws`, `saw`, `see` — **unquoted** | the saw sequence in `tests/integration/services/translations.test.ts` | the bare substring, anywhere in the body |
| `"saw"`, `"saws"`, `"scan"`, `"scans"`, `"scanned"`, `"bank"`, `"banks"`, `"banked"` — **quoted** | the reconciliation, staleness and repair tests | the word between two literal double quotes |

Only the first kind can be tripped by the system instruction, and an earlier revision of this
section said the opposite of the second. The request body is `JSON.stringify` of the whole
request, so a quoted word in the instruction — `"booked"`, `"burnt"`, `"spring"` — arrives as
`\"booked\"`, and the expectation's regex `"booked"` does not match it: the closing quote is
preceded by a backslash. Measured rather than reasoned: a body whose instruction reads
`Rule: "banks" is plural` matches the expectation `banks` and does not match `"banks"`. What a
quoted expectation matches is the **user part**, `"text":"banks"`, which is exactly why the
integration bucket quotes its forms — the unquoted `bank` would capture `banks` and `banked` as
well. So the quoted eight are anchored on the learner's text and cannot be reached by prose,
while any occurrence of `saw` anywhere in the instruction captures every lookup in that test's
namespace.

So the rule is: **the system instruction must contain neither `saw` (which covers `saws`) nor
`see` as a substring.** `walks` and `went` are clear; `running` and `booked` already appear in
the prompt, so they add no new exposure; and a quoted `"banks"` in a rule would be safe, though
there is no reason to write one. The unit test named below asserts exactly this pair, and
`buildPrompt`'s standing note — which lists `bank` and `banks` beside the three real hazards and
so over-forbids — is corrected in the same change to name the mechanism instead of a word list:
*an unquoted expectation matches the instruction; a quoted one matches only the learner's text*.
**Re-derive the list from the registered expectations before changing any illustration word**,
in this rule or any other; it grows every time a test registers an **unquoted** `matchText`.

`buildRenderingPrompt` — phase 12's second prompt — needs **no** rule about corrections, because
the substitution means it is never handed a typed form. It is also unaffected by the constraint
above, since its `matchText` expectations are anchored on *"reusing its sense_code EXACTLY"*,
which only that prompt contains.

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
Tapping an alternative is an ordinary lookup of that text, with no new endpoint — but it is a
full miss, so it shows the loading skeleton for as long as any other new word does.

**`submit` has to grow an optional override, which is the one contract change on this side.**
Today it is `submit: () => void run(text, undefined)`, closing over the provider's `text` state,
so `setText(alt)` followed by `submit()` would re-run the *typed* string: the closure captured
the old value and the state update has not landed. `submit` becomes
`submit: (override?: string) => void run(override ?? text, undefined)` and the handler calls
`setText(alt)` beside it so the input field agrees with the results it is showing. That is a
change to `TranslationValue` — a context type the composition root and the hook's own tests both
touch — and it is the reason this phase's mobile work is not only presentational.

**And it breaks the two existing call sites, which is the rest of that change rather than a
detail.** `translate.tsx` passes the handler bare in two places — `onPress={t.submit}` on the
submit button and on the retry link — and a bare `onPress` handler is called with the press
event. Once `submit` takes a `string`, `apps/mobile/tsconfig.json`'s `"strict": true` turns that
into a compile error (`strictFunctionTypes` checks the parameter contravariantly, and a
`GestureResponderEvent` is not a `string`), so `npm run typecheck` fails rather than anything
subtle happening. Loosen the signature to get past it and the failure becomes the subtle one
instead: the event object arrives as `override`, and `run(event)` throws on `query.trim()` inside
an unawaited promise, leaving the screen on its previous state with nothing logged.

Both sites become `onPress={() => t.submit()}`. `onSubmitEditing` already wraps its call and is
unaffected. Worth spelling out because the type error names the JSX prop rather than the hook,
and an implementer reading only this section would expect the change to be confined to
`useTranslation.tsx`.

The banner renders whenever `correction` is present and sits above the existing sense cards. It
does not change the `more` / reveal behaviour, the chosen-sense behaviour, or the empty state:
`zxqwbtl` still shows `translateEmpty`. It lives *inside* the `answered` branch, which makes that
last point structural rather than a promise — `status` is `empty` whenever `senses` is empty, so
an empty answer cannot render a banner even if one reached the wire.

**The forms need bidi isolation.** In the `en_he` direction the banner embeds a Latin word inside
a Hebrew RTL sentence, and without an isolate the reordering places it against the wrong clause.
Each form is wrapped in `⁨ … ⁩` (FSI/PDI) or given its own `<Text>` with an explicit
`writingDirection`. The `he_en` direction has no such problem.

The precedent is the screen's Hebrew-bearing text styles, which pin `writingDirection: 'rtl'`
explicitly — `title`, `noticeText`, `translation`, `partOfSpeech` and the rest. It is *not* the
input field: that one deliberately pins nothing, because it takes either script and forcing a
direction there puts the caret on the wrong side for every Hebrew lookup. The banner is fixed
Hebrew chrome with a Latin form embedded in it, so it follows the styles rather than the field.

Two strings join `strings.ts`: `translateCorrectionNotice(typed, corrected)` and
`translateDidYouMean`.

**The alternative buttons carry the same `run` guard the input does**, so nothing has to be added
for them: `run` returns early on a trimmed length of 0 or over 100, and `corrected_form` and every
alternative are capped at 100 by `TranslationCorrectionSchema`. A chip can therefore never submit
a string the typed field would have rejected.

## Export and restore

`dictionary.jsonl` keeps its invariant — one line is one lookup, replayable through
`persistEntries` — and corrections go to a sibling `corrections.jsonl`, written and read by the
same `dict:export` and `dict:restore` commands. A correction is a paid model answer and would
otherwise be lost on every database reset.

The file arrives empty and stays near-empty: the backfill word list is correctly spelled, so
corrections accumulate only from real learners. Restore replays them through
`persistCorrection`, the same function a live lookup calls, so a restored row and a looked-up
row are indistinguishable — the guarantee `dictImport` already provides for the dictionary.

That guarantee is what forces `persistCorrection` to be `ON CONFLICT DO NOTHING` rather than a
plain insert: `dictImport`'s whole safety argument is that replaying a file onto a database that
already holds part of it keeps the live content and raises nothing. A redirect that raised on a
re-restore would make `dict:restore` non-idempotent for the first time since phase 11.

**"Sibling" is a path derivation, not a fixed location.** `db/cli.ts` accepts an explicit path
after `--export-dict` / `--import-dict` and falls back to `data/backfill/en-he/dictionary.jsonl`
only when none is given, so the corrections file is
`join(dirname(<the dictionary path actually used>), 'corrections.jsonl')`. Hard-coding the
default's directory would write a developer's ad-hoc export back into the repo's dataset folder.
A restore whose sibling file is absent restores the dictionary and reports zero corrections,
rather than failing: the file is genuinely optional, and it is empty on arrival.

## Testing

Placement follows ADR 0004 — the folder decides the bucket — and no bucket is added.

### Unit

| File | Covers |
|---|---|
| `domain/translation.test.ts` | the prompt states all **four** rules and names `corrected_form` as a surface form; the parser accepts and rejects the `correction` shape |
| `domain/translation.test.ts` (the replaced rule) | the system instruction does **not** contain the old unconditional sentence *"not a word or expression in either language, return an empty entries array"*, and does contain the clause that narrows it to *"and no real word or expression was plausibly intended"*. Asserted as a **negative** on the old wording, because the failure this prevents is the old rule surviving beside the new one — an addition looks identical to a replacement in every test that only checks the new text is present |
| `domain/translation.test.ts` (the kind rule) | the instruction tells the model to classify `corrected_form` rather than the input as typed. A prompt-wording lock, and the only mechanism that secures `kind` for a multi-token corrected form — see the `(kind)` row below for why `resolveKind` cannot |
| `domain/translation.test.ts` (prompt words) | the system instruction contains neither `saw` nor `see` as a substring — the two unquoted expectations, which are the only kind prose can trip. The wording lock that keeps an illustration word from silently capturing the integration bucket's MockServer expectations. Deliberately **not** asserted for the quoted words: the instruction is JSON-encoded on the wire and cannot match a quoted expectation, so a test forbidding `"bank"` would lock a non-rule |
| `domain/translation.test.ts` (guards) | all three drops: `corrected_form` normalizing to the typed form, case-insensitively; one containing no letter or digit — asserted for `'???'` specifically, because that is the case an empty-string test misses and `normalizeForm` returns unchanged; a correction on `kind: 'sentence'`. The fourth guard: a Hebrew `corrected_form` under `en_he` makes `resolveCorrection` return `null` rather than drop, and a Latin one under `he_en` likewise. Plus: a fourth alternative is **truncated, not rejected** — the answer survives; two identical alternatives collapse to one |
| `domain/translation.test.ts` (empty entries) | a correction on `entries: []` is cleared **before** the effective form is computed: the answer carries no `correction` **and** `kind` is `'word'` for a single-token input whose `corrected_form` contained a space. The second assertion is the one an implementation is likely to miss |
| `domain/translation.test.ts` (normalization) | `corrected_form: 'Throat.'` yields the effective form `Throat`, so no `.`-suffixed key can reach the dictionary; the alternatives are normalized the same way |
| `domain/translation.test.ts` (kind) | `resolveKind` runs against the corrected form, so `bokked` → `booked` stays `'word'` **even when the model answered `'phrase'`** — the clamp firing on a single-token corrected form. And, in the same row because they are one fact read from both sides: `breakaleg` → `break a leg` with a model `kind` of `'word'` yields `'word'`, because `resolveKind` **defers** to the model once the form contains whitespace. That second assertion is deliberately the uncomfortable one — it pins that the server cannot fix this and that the prompt rule is load-bearing, where an earlier revision asserted the opposite and would have passed only by accident of the stub |
| `services/translations.test.ts` | the three-step read; a redirect hit answers with **no** provider call; a redirect whose target missed falls through to the model; `persistEntries` and `buildRenderingPrompt` both receive `corrected_form` and never the typed form, when the corrected form has no rows of its own — the probe row below covers the case where it has |
| `services/translations.test.ts` (the probe) | a correction whose target already has rows: exactly **one** provider call, `persistEntries` never called, `persistCorrection` called once with the typed form and the corrected form, and the answer's `kind` and `senses` equal to the target's rows. The chain: a corrected form with no rows but a redirect of its own is followed one hop — `persistCorrection` receives the hop's target and the model's entries are never persisted — while a hop whose target also has no rows raises `TranslationUnreadable` and persists nothing. And the probe repairs: a stale target makes exactly one reconciliation call, reaches `repairVariantRenderings`, and the redirect is still written afterwards — two writes, in that order |
| `services/translations.test.ts` (the fourth guard) | `resolveCorrection` returning `null` becomes a `TranslationUnreadable` from `translate`, with no repository write and no second call — the same path an unparseable answer takes |
| `services/translations.test.ts` (redirect + repair) | a redirect whose target is **stale** makes exactly one reconciliation call and answers from the repaired rows — the same call count and the same answer a direct lookup of the corrected form makes. Pins that step 3 goes through `serveForm` rather than reading the rows itself |
| `services/translations.test.ts` (the model declines) | a redirect exists, its target has no rows, and call 1 answers with entries and **no** correction: `persistEntries` receives the **typed** form, the response carries no correction block, and nothing rewrites the query from the stored redirect. The decision under *A stored redirect is never used to rewrite a form the model declined to correct*, pinned — it is one `if` away from the opposite behaviour, and the opposite behaviour files examples containing the typo against the correct spelling |
| `services/translations.test.ts` (logging) | `dict_corrected` is logged on either write of a redirect, `dict_redirect_hit` on a step-3 hit and `dict_cache_hit` on a step-1 hit only — a redirect hit does not also count as a cache hit — and **none carries the learner's text** — the convention every other event in this file holds to, and the one a new event is most likely to break |
| `openapi.test.ts` | the published document gains `correction` on the translation response, declares it **optional**, and loses nothing. Here rather than in the integration bucket because this file is the one that asserts the published document, and it lives under `src/` — ADR 0004's folder rule puts it in unit |
| `packages/core/src/api/schemas.test.ts` | `correction` is optional on both schemas; a response without it parses unchanged; the **wire** schema rejects a fourth alternative, while `LlmCorrectionSchema` accepts up to six — the asymmetry that keeps a chatty provider from 502ing a good translation; both cap a form at 100 characters |
| `packages/core/src/api/schemas.test.ts` (the 502 traps) | `LlmTranslationSchema` parses a `correction` whose `alternatives` is **absent**, and one whose `alternatives` is `null`, and neither fails. Asserted through `parseLlmTranslation` on raw JSON containing `"alternatives": null`, not on a pre-built object, since `dropNulls` is what the test is about. It yields `undefined`, not `[]` — the schema is `.optional()`, and it is `tidyAlternatives` in `domain/` that produces the `[]`, which is where that half is asserted |
| `providers/gemini.test.ts` | `toGeminiSchema(LlmTranslationSchema)` emits **no `default` key anywhere**, and `correction` is absent from the root `required` list. The first is the regression lock on this revision's decision: `.default([])` would put a JSON Schema keyword into `responseSchema` that this repo has never sent, and a rejected `responseSchema` is a 400 on every translation call rather than a degraded correction. A test rather than a comment because the next person reaching for `.default()` will reach for it in `packages/core`, nowhere near this reasoning |

**Every `services/translations.test.ts` row above needs a form-aware `FakeDictRepo` first, and
that is fixture work rather than test work.** `createFakeDictRepo` holds one `hit: SenseRow[]`
and one `stale: StaleLexeme[]`, and `findSensesByForm` returns `repo.hit` whatever it is handed —
which was exactly right while every lookup read one form. This phase's steps 1, 3 and 5b call it
with different forms in a single lookup and must get different answers, so both fields become
records keyed by form and the two reads index into them. The fake also gains `corrections`, a
record keyed by typed form that `findCorrectionByForm` reads and `persistCorrection` appends to,
because the probe row reads it for two different forms in one lookup as well. That touches the fixture setup of every
existing service unit test, and it is why *What this adds* names `tests/support/fakes.ts`
explicitly. The two repair-path stubs (`findSenseVersion`, `repairVariantRenderings`) stay stubs
for the plain-hit tests but stop being unreachable, since the redirect + repair row above drives
them.

### Integration

| File | Covers |
|---|---|
| `repo/dictionary.corrections.test.ts` **new** | write/read round trip; `Thruot` finds the row written as `thruot`; a **second `persistCorrection` for the same form is a no-op that raises nothing** and leaves the first row's target in place; the unique index itself rejects a duplicate — asserted against raw SQL, because `persistCorrection` is the thing that must not raise |
| `repo/dictionary.corrections.test.ts` (the constraints) | raw SQL — never `persistCorrection`, which tidies first — inserting a 101-character `typed_form`, a 101-character `corrected_form`, four alternatives, or one 101-character alternative is rejected by the named constraint. Seen to fail first against a table without them. This is the restore path's backstop, and the reason criterion 9 can say *storable* rather than *sent* |
| `repo/dictionary.corrections.test.ts` (the cap belongs to the write) | `persistCorrection` handed **four** alternatives, or two that differ only in case, stores three and stores them deduplicated — with no `domain/` guard anywhere in the call. This is the restore path's shape exactly, and the assertion that makes `TranslationCorrectionSchema.max(3)` an invariant of the server rather than of one caller. Seen to fail first against a `persistCorrection` that writes what it is given |
| `db/reseed.test.ts` | a reseed leaves **zero** `dict_corrections` rows. Seen to fail first — and it will fail loudly against the current statement, because `CASCADE` cannot reach a table with no foreign key, which is the whole reason the table has to be named. A check that cannot fire prints nothing exactly like a check that passes, and this one is one word away from being that |
| `repo/dictionary.corrections.variants.test.ts` **new** | the characterisation test inverted: after any number of corrected lookups **that report a correction**, **zero** `dict_variants` rows exist for the typed form, so `questionFrom` can never be built from it. Seen to fail first. The qualifier is not hedging: the stub always corrects, so this pins the server's half and says nothing about the model's — that half is the eval bucket's |
| `services/translations.correction.test.ts` **new** | a failing reconciliation call leaves **no** `dict_corrections` row and no dictionary row — phase 12's fail-closed rule, asserted for this table. Plus the dangling redirect, seen to recover: a redirect whose target rows are gone falls through to the model, writes the entries, and the next lookup is a redirect hit again rather than a third model call |
| `services/translations.correction.test.ts` (the probe) | with `booked` already stored, the first `bokked` lookup makes exactly one provider request, writes no `dict_variants`, `dict_senses` or `dict_var_translations` row, writes the redirect, and answers deep-equal to a direct `booked` lookup — with the stub's entry order **differing** from the stored variant's, which is the shape that made the un-probed flow raise on `dict_variants_form_entry_rank_key`. Seen to fail first: against that flow it fails on the request count and on the missing redirect. Plus the chain, against real rows: a redirect written for `throte → throat`, then a stub correcting `thruot` to `throte`, leaves zero `dict_variants` rows for `throte` and a redirect `thruot → throat`. And the stale target: with `booked` behind its lexeme, the same first `bokked` lookup makes exactly two provider requests — call 1 and the repair — rewrites `booked`'s renderings, writes the redirect, and still answers deep-equal to a direct `booked` lookup made afterwards, which is what makes the R8 amendment's *independent* claim a tested fact rather than an argument |
| `services/translations.correction.test.ts` (byte-identical) | the criterion-1 assertion, at the level that can make it: after a redirect is written **and** the corrected form's lexeme has learned a sense, the typo lookup and the direct lookup return **deep-equal** `kind` and `senses`. Fails against a step 3 that reads the rows directly, which is the whole point of writing it |
| `routes/translations.test.ts` | the correction block reaches the wire, with `alternatives` present and the typed string in `text` |
| `db/dictRoundTrip.test.ts` | `corrections.jsonl` round-trips; a restored correction serves the same answer a looked-up one does; a restore with **no** sibling file succeeds and reports zero corrections |

### e2e

`translate.spec.ts` gains one flow against MockServer: type `thruot`, see the banner naming both
forms, tap `throughout`, see its translation. Phase 12 left this file alone because the wire did
not move; this phase moves the wire, so it is the first bucket to notice. It is also the **only**
coverage of the mobile change — `apps/mobile` has three unit tests and none of them touch the
screen or the hook — so the `submit` override is verified here or nowhere.

**That flow needs something this bucket has never had: two different provider answers in one
test.** `e2e/tests/support/mockServer.ts`'s `expectGemini` registers an expectation with *no*
request matching at all, so every Gemini call in a test gets the same payload; the existing tests
each register exactly one. Tapping an alternative makes a second, different call. So the helper
grows either body matching — inheriting the substring trap described under *The prompt*, which
argues for anchoring on the quoted form as the integration bucket learned to — or MockServer's
`times: { remainingTimes: 1 }`, consuming one-shot expectations in registration order. The
one-shot form is preferable: it needs no knowledge of what is inside the body, which is exactly
the coupling that has cost this repo twice. Either way it is helper work, not a test that drops
into the existing shape.

**Two expectations is the right count, and it is worth knowing why rather than discovering it.**
One-shot expectations are consumed in registration order, so the count has to match the calls
exactly. `thruot` makes one call because the corrected form `throat` is a lexeme nobody has
stored, so phase 12's reconciliation never fires; tapping `throughout` makes one for the same
reason. Both hold because neither word is among the thirteen strings in `content.generated.ts`
and `globalSetup.ts` drops and rebuilds `lang_tutor_e2e` every run — so the flow starts from the
seed and nothing else. **Choose any replacement word the same way**: a corrected form whose
lexeme the seed already holds would make a second call and silently consume the expectation meant
for the tap.

`expectGemini`'s payload parameter is typed `{ kind, entries }` and gains an optional
`correction`, which is the only other change the helper needs.

### Evals

`EvalCase` gains `expectCorrection?: string` and `expectNoCorrection?: true`. `expectKind` already
exists and is what scores the fourth prompt rule — but **only once `askModel` applies the
substitution**, which is a change to the harness and not just to the cases.

`askModel` computes `kind` as `resolveKind(text, parsed.kind)` on the **typed** text, so
`breakaleg` clamps to `'word'` before any prompt rule can be scored and `expectKind: 'phrase'`
would fail whatever the model answered. It calls `resolveCorrection` instead — the same pure
function the service calls at step 4, guards and all — and takes `kind` and `correction` from its
result, which is what its own docstring already promises: *"everything
`services/translations.ts` does to an answer except touch a database"*. One function with two
callers rather than three lines copied into the harness: an earlier revision asked for the copy,
and a copy is exactly what would let this bucket score a `kind` the service never writes.
Added:

- `thruot` → `corrected_form: 'throat'`, `alternatives` containing `throughout`
- `recieve` → `receive`
- `brake a leg` → `break a leg`, `kind: 'phrase'`
- **`breakaleg` → `break a leg`, `kind: 'phrase'`** — the fourth prompt rule, and the only case in
  the set where a **single token** must be classified as a phrase. `brake a leg` above cannot
  score it: what was typed already contains whitespace, so the model would answer `phrase` with or
  without the rule. This one is the case where a model classifying the input as typed answers
  `word`, the server's `resolveKind` defers to it because the corrected form has whitespace, and
  `kind: 'word'` is written onto the variant `break a leg` permanently. Worth its own call for the
  same reason the inflection cases are: nothing else can measure it. It is also the case that
  forces the `askModel` change above — score it against the typed text and it clamps to `'word'`
  and can never pass
- **`running`, `booked` and `saw` → no correction at all** — the inflection trap, and the most
  important cases in the set. All three are already in the set — `running` and `saw` since phase
  10, `booked` added by phase 12 — so this is an added assertion on existing calls rather than
  three new ones.
- **`colour` → no correction** — a real word in one standard of English that a model may
  "correct" to `color`. Phase 12 met this shape with `burnt`/`burned` and pinned a lemma rule for
  it; here the rule is the first one, *a correctly spelled form is not a misspelling*, and this is
  the case that scores its spelling-variant half. One new call.
- `asdkjhasd`, the set's existing nonsense case → empty entries and **no** correction, which is
  what separates "near nothing" from "near a word"
- one Hebrew misspelling, for symmetry across directions

`askModel` exposes `correction` alongside `entries`, as it already exposes the entries the wire
flattens away — and, per above, applies the correction to `effectiveForm` before computing `kind`,
so its `kind` is the one the server would have written.

**This bucket is the only place the feature's central claim is measured.** Every other test drives
a stub that reports whatever the test wants; only these cases ask a real model whether `thruot` is
a misspelling and whether `booked` is not. A regression here is the whole feature regressing, not
one assertion — and, per the repo's standing rule, a `test-eval` failure on these cases is read
against the run's `eval-report` artifact before the diff is blamed, because a model update alone
can move them.

## ADR consequences

**One ADR amended in prose, no new ADR, no new detection command.** Stated rather than left
silent, because phase 9 established that a check must be shown to fail before it is trusted, and
the counterpart is that a phase adding none should say so — and that a phase changing a rule's
wording without changing its check should say that too.

- **ADR 0003** — the wire moves for the first time since phase 9, additively: one optional
  property on the response, nothing removed and no field retyped. The schema stays single-homed
  in `packages/core`, the route stays a `createRoute`, and `src/openapi.test.ts` is updated to
  assert the new property. That file is a **unit** test despite asserting the published document,
  because it lives under `src/` and ADR 0004's rule is that the folder decides the bucket — the
  Testing tables above place it accordingly. No rule is violated and no check changes. This is
  the ADR the phase touches and the reason the field is optional rather than required.
- **ADR 0001** — no layer moves, and R8 is amended a fourth time, in prose. Phase 12 left it at
  *"a use case opens at most one **write** transaction; **reads** preceding third-party I/O may
  each be their own"*. The reads here all fit that clause — `serveForm`'s combined
  rows-and-staleness read (up to three times), the redirect lookups, `repairForm`'s per-lexeme
  read where a repair fires, and phase 12's stored-senses read — and the wording covers them
  without a number, which is what makes it robust to this phase, since phase 12's F5 fix already
  changed the count once after this document's first revision quoted it as four. **The write side
  is what R8 bounds, and step 5b can commit two**: a probe hit may have repaired the corrected
  form inside `serveForm` and then records the redirect. The rule now reads *a use case's
  **dependent** writes share one transaction; a write that is **independent and idempotent** may
  be its own; **reads** preceding third-party I/O may each be their own*, with the repair and the
  redirect as the named example of an independent pair and steps 8 and 9 — a redirect must not
  point at a form with no rows — as a dependent one. Why the amendment beats the workaround that
  would have kept the old wording is under *A corrected form the dictionary already holds is
  served, not rewritten*. R8's detection command greps `\.transaction(` outside
  `db/transaction.ts` and is indifferent to how many bare `transaction(...)` calls a service
  makes, so no check changes; the ADR's date line, its R8 paragraph and its `Query`-seam note are
  edited, and README's quotation of the rule — stale since phase 10, which already made a use
  case two transactions — is corrected with it. Two functions join the existing dict repo rather
  than a new one, so `Repos` keeps its shape. The architecture check stays at seventeen rules.
- **ADR 0002** — `createDictRepo` gains two functions; the factory list is unchanged. On the
  mobile side `TranslationValue.submit` gains an optional parameter, which is a change to a
  context *value* and not to how the provider is constructed — `TranslationProvider` still takes
  its api client at the composition root and reaches for no singleton. **R5's "no optional
  collaborator parameter" is not engaged, and this was checked rather than assumed**: its
  detection command greps a closed list of collaborator names — `rng`, `onError`, `randomUUID`,
  `logger`, `storage`, `fetch` — followed by `?:`. `override?: string` is a query rather than a
  dependency and matches none of them, so the one optional parameter this phase adds is invisible
  to the rule that sounds like it would object.
- **ADR 0004** — no new bucket. Two existing unit files gain rows —
  `src/providers/gemini.test.ts` and `tests/support/fakes.ts` — and neither moves: the provider
  test asserts a pure schema conversion and imports no database, and `fakes.ts` is already the one
  support module R3 permits a unit test to take.
- **ADR 0005** — untouched. `dict_corrections` has no `user_id`; nothing here records a learner,
  and the two new log events carry counts and `direction` only, never the learner's text.

**`tidyAlternatives` living in `domain/` and being called from `repo/` is an existing import
direction, not a new one.** `repo/dictionary.ts` already imports `entriesToRows`, `rowsToSenses`
and `staleLexemes` from `domain/dictionary`, and ADR 0001's R4 forbids persistence reaching
*upward* — into `services/`, `routes/` or `app.ts` — not into the pure layer beneath it. So the
decision that the alternatives cap is a property of the write costs no ADR text and no check.

**A judgement call left open for review**, in the same terms phase 12 left its own: *"a
misspelling the model reports is never a `dict_variants` row"* is a durable structural invariant,
and `docs/adr/` is where this repo records those. It is not recorded as an ADR here for two
reasons. Every existing ADR pairs its rule with a grep-able detection command, and this is a
data-model fact no regex can check — it is enforced by
`repo/dictionary.corrections.variants.test.ts` instead. And the invariant is conditional on the
model, which is weaker than anything `docs/adr/` currently holds. If the preference is to record
it anyway, `create-adr` should run before implementation, and the wording should carry the
condition rather than drop it.

## Out of scope

- **Typos inside sentences.** The whole typed string is judged, or nothing is.
- **Per-learner mistake history.** The redirect is global; no table records who typed what.
- **Correcting the correction.** There is no "no, I meant X" affordance beyond tapping a listed
  alternative, and nothing learns from a learner who taps one.
- **Prefetching the alternatives.** Tapping one stays a full miss. Writing them eagerly would
  cost up to three extra first calls on every corrected miss, to populate candidates a learner
  usually never taps.
- **Any edit-distance or spellchecker implementation.** The model does the judging; the server
  stores the verdict.
- **TTL, invalidation or refresh of a redirect.** A correction is permanent, like every other
  row in this dictionary.
- **Correcting a form the dictionary already holds.** Step 1 precedes step 2, permanently.
- **A third language.** `direction` still has two values.

## Risks

- **A missed correction leaves the reported defect exactly as it is today, and it is the risk this
  phase does not reduce at all.** Everything here fires on `correction` being present; an answer
  that translates `thruot` as `throat` and reports nothing writes a `thruot` variant, hits from
  then on, and is quizzable — the original play-test report, unchanged. This is the mirror of the
  wrong-redirect risk below and the more likely of the two, because a model omitting an optional
  field is a softer failure than a model inventing a wrong value. It is also the one risk with no
  server-side mitigation in this design: nothing measures it except the eval bucket's `thruot`,
  `recieve` and `brake a leg` cases, and a drop there means the feature has quietly stopped
  working while every other test stays green. **`dict_corrected`'s rate is the only production
  signal**, and it exists because of this bullet rather than for tidiness — a rate that falls to
  zero after a model update is the same event the eval bucket would catch, seen a release earlier
  and on real traffic.
- **A typo that has already been corrected once can still become a `dict_variants` row**, and this
  is the missed correction above meeting this phase's own redirect table. The shape: `thruot` has a
  redirect, its target has no rows (a reseed, a `TRUNCATE`), step 3 falls through, and call 1 this
  time reports no correction. The server holds written evidence that `thruot` is not a word and
  writes a variant for it anyway, because the entries and their examples were built around the
  typed string and filing them under `throat` would be worse — the reasoning is under *A stored
  redirect is never used to rewrite a form the model declined to correct*. From then on step 1 hits
  and the redirect is shadowed forever, by the same rule that protects real words from being routed
  away from themselves. Bounded rather than fixed: it needs the redirect's target to be missing,
  which `dict_corrections` joining the reseed `TRUNCATE` makes rare, and it is one typo rather than
  a class. Criterion 3 is qualified for it.
- **A wrong redirect for a real word is permanent.** If the model calls `booked` a misspelling of
  `book`, that row never expires. Partially self-limiting: the redirect is consulted only *after*
  the by-form read misses, so once `booked` is legitimately written the bad row is shadowed and
  inert. It bites only for a form never looked up correctly first. The three inflection eval
  cases exist for exactly this, and they are the ones to watch when a model version changes.
- **A corrected miss can still cost two provider calls, but only for an unstored inflection of a
  stored word.** Phase 12 measured reconciliation firing on ~16% of misses — those whose lexeme
  already has senses — and corrections resolve to *common* words, the likeliest to own a lexeme,
  so an earlier revision expected the correction path to pay the second call at a higher rate
  than that. The probe answers that population from storage: a corrected form that already has
  rows costs call 1 and nothing else. What remains is a corrected form with no rows whose lexeme
  has senses — `bokked → booked` where `book` has been looked up and `booked` never has — and
  that is a corrected miss of 10–30s. The redirect cache bounds it further: the second lookup of
  the same typo costs nothing.
- **A probe hit can commit two transactions, and the second can fail after the first landed.**
  A stale corrected form is repaired inside `serveForm`, and the redirect is then written on its
  own. If the redirect write fails, the repair stands — correct rows, honestly stamped — and the
  next lookup of the typo pays call 1 again and writes the redirect then. Nothing partial and
  nothing wrong, which is the whole content of the R8 amendment; recorded because this is the
  first use case in the tree that commits twice, and a reader of `translate` should not have to
  rediscover why that is allowed.
- **Hebrew spelling is legitimately variable.** Ktiv male against ktiv haser, and optional nikud,
  mean many valid Hebrew spellings differ from each other, and `normalizeForm` deliberately
  strips neither. The model may report a valid alternative spelling as a misspelling and write a
  permanent redirect away from it. This is the Hebrew-side risk with no clean answer, and the
  reason the Hebrew eval case matters more than its single line suggests.
- **English spelling variants are the Latin-script counterpart of ktiv male.** `colour`,
  `travelling` and `grey` are real words the model may report as misspellings of their American
  forms, writing a permanent redirect away from a correct spelling. The first prompt rule covers
  it only by implication, the `colour` eval case is what measures it, and a redirect written this
  way is shadowed the moment the variant spelling is stored by a direct lookup — the same partial
  self-limiting the wrong-redirect bullet above describes.
- **Proper nouns, brand names and slang will be corrected.** A learner typing a name is told it
  is not a word and shown something else. Phase 12 already collapses `proper_noun` into `noun`,
  so nothing downstream can distinguish the case either.
- **Model instability across versions.** The same typo may correct differently after a model
  update, and first-writer-wins freezes whichever arrived first — consistent with how the rest of
  the dictionary already behaves, and the reason `test-eval` can go red with nothing in the diff.
- **`alternatives` truncates to three**, so a badly mangled input silently loses candidates.
  Truncating rather than rejecting is deliberate — the alternative was failing the whole answer
  over a decorative field — but the loss is silent either way.
- **A corrected lookup can freeze the wrong `kind` on a correctly spelled form, and only a prompt
  rule stands between it and the dictionary.** `kind` is written onto `dict_variants.kind` for the
  corrected form, first-writer-wins, and every later hit reads it back — so a model that classifies
  `breakaleg` rather than `break a leg` stores `kind: 'word'` against a real phrase, permanently,
  and a learner who spells it correctly is answered from that row having mistyped nothing. The
  fourth prompt rule is the whole mitigation; `resolveKind` cannot help, because the clamp it
  applies only fires on a single token and the corrected form here is not one. Scored by the
  `breakaleg` eval case, and it is the case most likely to move on a model update. Narrow — it
  needs the typo and the corrected form to differ in token count, which is a small slice of
  corrections, and after the probe it also needs the corrected form to have no rows of its own,
  since a target already stored keeps its stored `kind` — but each instance is permanent.
- **`toGeminiSchema` passes through every JSON Schema keyword Zod emits except two**, and a schema
  change that introduces a new one reaches `responseSchema` unexamined. This phase nearly shipped
  that: `.default([])` emits a `"default"` key, `strip` removes only `$schema` and
  `additionalProperties`, and a `responseSchema` Gemini refuses is a 400 on **every** translation
  call — a total outage of the endpoint, arrived at through a field designed never to be able to
  fail an answer. Avoided by using `.optional()`, which is already in production here, and locked
  by the `providers/gemini.test.ts` row above. Recorded as a risk rather than a closed question
  because the next schema change faces the same trapdoor and the assertion only covers this one.
- **A redirect is written once and never re-pointed.** `persistCorrection` is first-writer-wins,
  so if the model's `corrected_form` for a given typo changes between lookups, the first answer
  stands forever. Combined with the step-3 fall-through this has one bad shape: a redirect whose
  target has no rows, where the model now answers with a *different* target. The write then
  stores rows for the new target while the redirect still points at the old one, and every
  lookup of that typo pays the model again. It needs a truncated dictionary and an unstable
  model to occur, self-heals the moment the model repeats its original answer, and is bounded by
  being one typo rather than a class — which is why it is accepted rather than designed against.
  Re-pointing on a dangling target was considered and rejected: it makes a permanent row mutable
  to fix a case that resolves itself. **"A truncated dictionary" was the cheap half of that
  sentence and an earlier revision was wrong to lean on it**: `npm run db:reseed` empties the
  dictionary on demand and is a supported command phase 12 ran repeatedly while re-recording. With
  `dict_corrections` outside the `TRUNCATE` — which is where a table with no foreign key sits by
  default — a reseed would have put *every* redirect into this shape at once. Naming the table in
  that statement is what keeps this bullet describing a rare event rather than a routine one.
- **A redirect chain is followed one hop, and a two-link chain fails closed.** If the model names
  a typo `b` as the correction of `a`, and `b` already has a redirect of its own, the probe serves
  `b`'s target and writes `a` straight to it. An earlier revision described this case as a
  permanent model tax on `a` and accepted it; traced properly, the un-hopped flow wrote rows for
  `b` at step 8 — a `dict_variants` row for a string the redirect table already records as not a
  word — and those rows then shadowed `b`'s own redirect forever by the *Correct spellings win*
  rule, which is this phase's central defect arriving by its own machinery. The hop costs one read
  on the rarest path and stops after one link: a chain whose second target has no rows either
  fails the lookup rather than reading on, so the number of reads never depends on data. That
  last case needs a chain *and* a truncated dictionary, and is accepted. Step 3 still follows
  nothing: a stored redirect points at a real word by construction, since the hop is applied
  before it is written.
- **A repair can now be paid on a redirect hit, which was previously free.** Step 3 going through
  `serveForm` is what makes a corrected answer byte-identical, and the price is that the second
  lookup of a typo is no longer unconditionally zero-cost: if the corrected form's lexeme has grown
  since, that lookup buys one reconciliation call. It is the same cost the direct lookup would
  have paid, it is paid once per growth event rather than per lookup, and a failed repair still
  answers 200 from the stored rows — phase 12's F5 rule, inherited unchanged. Success criterion 2
  is worded around it.
- **Tapping an alternative costs a full miss** — up to two provider calls and 10–30 seconds —
  because nothing is written for the alternatives. A learner who mistypes and then picks the
  second candidate waits twice.
- **The wire moves, so a mobile client older than this server sees a correction it cannot
  render** — it will show the corrected form's translation with no notice, which is exactly
  today's behaviour rather than a regression.

## Success criteria

Every criterion below that names a correction presumes the model reported one; that condition is
the subject of criteria 6 and 7 and of the risk register, and it is not restated in each line.

1. `thruot` returns `throat`'s senses, byte-identical to a direct `throat` lookup, plus a
   correction block naming `throat` and offering `throughout` — and it stays byte-identical
   **after `throat`'s lexeme has learned a sense**, through the redirect at step 3 and through
   the probe at step 5b alike, which is the case that distinguishes a path routed through
   `serveForm` from one that reads the rows itself.
2. A second `thruot` lookup makes **no** provider call and writes no row — unless the corrected
   form is stale, in which case it makes exactly **one** (the repair) and writes only that repair's
   renderings, never a `dict_variants` row for `thruot`.
3. **Zero** `dict_variants` rows exist for `thruot` after any number of lookups that report a
   correction, so no question can be built from it.
4. `bokked` hands `booked` — never `bokked` — to `buildRenderingPrompt` and to `persistEntries`
   when `booked` has no rows of its own, and the stored renderings agree with `booked`; when it
   has, neither is called (criterion 23).
5. A failing reconciliation call on a corrected lookup leaves the database byte-identical: no
   lexeme, no variant, no translation and **no** `dict_corrections` row.
6. `running`, `booked`, `saw` and `colour` return no correction, measured against the real model.
7. `asdkjhasd` still returns the empty state, not a correction — and its `kind` is `word`, so a
   correction dropped for empty entries has changed nothing about the answer.
8. All four guards fire before any database read or second model call: a `corrected_form` equal
   to the typed form, one containing no letter or digit — `???` included, not only whitespace —
   and one on a sentence are dropped; one in the other script fails the request with nothing
   written.
9. No corrected form reaches `dict_variants` or `dict_corrections` un-normalized: `Throat.`
   stores `Throat`, and nothing over 100 characters is storable at all — by `CHECK` constraints
   as well as by the schema, so a restore is bound the same way a lookup is.
10. A fourth alternative is truncated away, two identical alternatives collapse to one, and an
    answer whose `alternatives` is absent or `null` parses and reaches the wire as `[]` — each of
    them a 200 rather than a 502. The truncation and the dedupe hold **through
    `persistCorrection`** as well as through the guards, so a `corrections.jsonl` carrying four
    alternatives cannot produce a row that violates the published response schema.
11. `toGeminiSchema(LlmTranslationSchema)` emits no `default` key, so `responseSchema` gains no
    keyword this repository has not already sent Gemini successfully.
12. `breakaleg` returns `corrected_form: 'break a leg'` **and `kind: 'phrase'`**, measured against
    the real model — the single-token-to-phrase case, which `resolveKind` cannot decide and only
    the fourth prompt rule secures. A correctly spelled `break a leg` looked up afterwards is still
    answered `phrase`.
13. A reseed leaves **zero** `dict_corrections` rows, so no redirect outlives the dictionary it
    points into.
14. With a redirect present but its target rows gone, a call 1 that reports **no** correction
    writes a variant for the **typed** form and no correction block reaches the wire — the model is
    answered on its own terms, and nothing rewrites the query from a stored redirect.
15. Tapping `throughout` returns `throughout`'s own translation, and writes no redirect for it.
16. A correctly spelled form that also has a redirect row resolves to itself; the redirect is
    never consulted.
17. A second `persistCorrection` for one typed form raises nothing, writes nothing, and leaves
    the first target in place — so `dict:restore` is still idempotent and a concurrent double
    miss still writes its entries.
18. The system instruction contains neither `saw` nor `see` as a substring, and the integration
    bucket is green. The two halves of the same fact.
19. The published OpenAPI document gains exactly one optional property and loses nothing,
    asserted in `src/openapi.test.ts`.
20. `corrections.jsonl` round-trips; a restored correction serves the same answer a looked-up one
    does; and a restore with no sibling file succeeds.
21. `npm run typecheck`, `npm run test:all` and `npm run e2e` are green with no network access and
    no API key — `typecheck` named explicitly because the `submit` signature change breaks two
    call sites that no test executes.
22. `npm run lint:arch` passes and still reports seventeen ADR 0001 checks.
23. A correction whose target already has rows makes exactly one provider call, writes no
    `dict_variants`, `dict_senses` or `dict_var_translations` row, writes the redirect, and
    answers deep-equal to a direct lookup of the target — including when the model's entry order
    differs from the stored variant's. When the target is stale it makes one repair call as well,
    rewrites the target's renderings, and still answers deep-equal to a direct lookup.
24. A correction whose target is itself a known typo writes a redirect to that typo's own target
    and never a `dict_variants` row for the typo; one whose hop target also has no rows fails with
    nothing written.
25. The ten *"phase 13"* and *"Task 13"* comments that describe phase 12's follow-ups are
    relabelled before any comment in this phase uses the label for itself.
