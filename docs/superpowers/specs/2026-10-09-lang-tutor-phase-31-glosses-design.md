# Phase 31 — Glosses: one target word, one card, one level

- **Status:** Designed on 2026-10-09. Victor scoped the phase in the one-pager, then settled the
  model in conversation: the learner's unit is the gloss, an explicit table keyed by the target
  word (D1, D2); one gloss per sense, the other target words as alternatives (D4, D5); the first
  rendering decides membership and glosses only ever merge (D6, D7); a definition per sense,
  stored and not shown (D9); sessions rotate over every rendering of a gloss (D12). Every decision
  is in §1 with its reason, so each one can be overturned in review.
- **Built:** on branch `phase-31-glosses`, 2026-10-09 to 2026-10-10, from the plan
  `docs/superpowers/plans/2026-10-09-phase-31-glosses.md`. Where the build departs from the
  letter of this spec, "As built" at the end says what was built instead, and why.
- **Date:** 2026-10-09
- **Source:** the one-pager `drafts/2026-10-08-merge-same-target-senses-one-pager.md`. `drafts/`
  is gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 21 (one list row per lemma), phase 20 (progress per saved item), phase 12
  (senses reconciled by code), phase 26 (the gloss splitter in the sense matcher).

## Goal

A looked-up word often has several senses whose translation is the same target word: `mouse` is
עכבר as a rodent and as a device, `difficult` is קשה twice, `development` is התפתחות twice and
פיתוח three times. The learner meets that duplicate three times. The word's page shows cards that
read as repeats, so they do not know which to save. A session asks the same answer several times,
one per sense. And one translation they know carries several levels and save marks.

Lane 0 today: 495 senses, 36 (lexeme, language, translation) groups with more than one sense, 24
of 159 saved entries inside such a group.

After this phase the learner's unit is the **gloss**: one target word for one headword in one
learner language. A gloss groups the senses that share that word, carries one save mark and one
level, and is practised once per session over every form and meaning it covers. The dictionary
keeps its senses untouched, so an Italian learner of `mouse`, for whom the two senses are `topo`
and `mouse`, still sees two.

**Done means** (from the one-pager, in Victor's words):

1. On a word's page, no two cards of one headword show the same target word. (Narrowed from the
   one-pager in review: a noun and a verb, or `più` as adverb and determiner, keep separate cards
   by the Out list below. D18 covers what the session does about them.)
2. A session never asks for the same target word twice as separate items, across headwords too
   (D18).
3. A merged sense has one level and one save mark, and the saved list counts it once.
4. After existing duplicates are folded, every saved word is still saved and keeps its highest
   level.
5. Added in the dialogue: a word saved from an inflected form (`fingers`) shows its citation form
   (אצבע) as its translation on the list and the word page, and sessions practise its other forms
   too, the standard one included.
6. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass; `npm run eval`
   passes with the new prompt cases. ADR 0011's check reports a planted violation.

## Scope

**In:**
- `dict_glosses` and `dict_sense_glosses`; `definition` on `dict_senses`; `alternatives` on
  `dict_var_translations`; `gloss_id` in place of `sense_id` on every learner table;
  `sense_progress` renamed `gloss_progress`;
- four new fields in both model prompts: `alternatives`, `gloss`, `gloss_alternatives`,
  `definition`; their eval cases;
- the gloss assignment rule at the lookup write, and the merge as the only regroup;
- the migration that creates glosses from stored translations and folds colliding saves;
- the automatic merge as a background job after each lookup, and a `dict:glosses:merge` script with
  the same tier plus a model-judged one, with a plan step;
- one card per gloss on the lookup, the word page, the tutor's screen and the photo import, with
  one example per member sense and the alternatives under the headline;
- the gloss key as the headline translation on the list and the detail;
- sessions picking a rendering at random over every form of every member, with the lemma form
  rendered on demand;
- ADR 0011 and its check.

**Out** (from the one-pager):
- merging across parts of speech: a noun and a verb with the same target word stay separate;
- merging senses whose target words differ but mean the same (synonyms).

**Also out**, decided here:
- splitting a gloss, ever (D7);
- a per-member level or any way to see "I know the rodent but not the device" (D3);
- showing definitions to the learner (D9);
- changing the dictionary's sense model, sense codes or the reconciliation call's job (D1);
- a redesign of the detail's save toggle, still deferred from phase 21.

---

## 1. Decisions

**D1. The learner's unit is the gloss, an explicit table, and senses stay the dictionary's.**
A sense is attached to the headword: `dict_senses` hangs off a lexeme and is pure identity, a
model-supplied code. The target word lives below it, per form and per learner language, on
`dict_var_translations`. So "same target word" is not a property of a sense but of a sense in one
language: the two senses of `mouse` collapse for Hebrew and not for Italian. Folding the sense
rows would leak one language's merge into every other. The group therefore lives beside the
senses, per language, and the learner's tables key on the group. Victor chose this over merging
`dict_senses` and over grouping at read time, which would have taught every reader the grouping
and fanned progress writes out to every member.

**D2. The gloss is its own row with its own id, not a member standing in for the group.** The
alternative, "the lowest-ranked member's sense id is the group's id", would have left every learner
table on `sense_id` and needed no re-keying. Victor judged the migration no concern and chose the
honest key: what a learner saves is a target word, and the table says so. The costs, accepted: the
learner tables are re-keyed (§2), a gloss of one must exist before a save (D8), and a gloss id
carries a language, so a write checks it against the enrollment (D14).

**D3. One level per gloss, and the members share it.** A correct answer about the computer mouse
raises עכבר. The learner loses a separate score for the two meanings; Victor chose that on the
one-pager and it is right for a word with one target word. Where a Hebrew speaker does distinguish
by context, as with `development`, the two target words still give two glosses.

**D4. One gloss per sense per language; the other target words are alternatives.** Some senses
render as several target words: `combination`'s lock_code is "קומבינציה, צירוף" in lane 0, `car`
is מכונית, אוטו or רכב, `happy` is שמח or מאושר. Lane 0 has 35 such comma-separated rows. Making
sense-to-gloss many-to-many would give "car" three cards and three levels, the split this phase
removes, on the other side. So the model names one main target word per sense and lists the others,
and the first word is the gloss. The others are shown on the card as "also …" and accepted by the
typed-meaning card's rule verdict (D13). They cannot serve the typed, spoken or tiles cards: those
expect the headword's form, and their alternatives are other forms in the language being learned. The learner never sees רכב
as a prompt; that is accepted.

**D5. Alternatives live at two levels with two jobs.** On the gloss, in citation form (מכונית: אוטו,
רכב): shown on the detail card, and a merge signal (D7). On the rendering, in the form's inflection
(`cars`: רכבים, אוטואים): shown on the lookup card for the typed form, and accepted by the
typed-meaning rule verdict of a card built on that form, so a learner asked the meaning of `fingers`
may answer אצבעות or any of its listed inflections. The lemma form's rendering list will usually
equal the gloss list; that is duplication of two things that can legitimately differ.

**D6. The first rendering decides membership, and membership never moves.** The grouping is a fact
about one model answer, not about the word: `difficult`'s second sense is קשה today and מסובך on
another day; `leaf`'s thin_sheet is עלה from `leaf` and could be דף from `leaves`; lane 0 renders
`grow`'s become_state as נהיה from `grew` and the misspelt ליהיות from `grow`. So a sense joins a
gloss the first time it is rendered in a language, and a later form that renders it differently
keeps its own translation and its own `gloss` field on the rendering row and does not regroup. This
mirrors senses: added, never removed. Two safeguards, raised in review. **Every rendering records the
citation form the model gave it**, so a rendering that disagrees with its gloss's key is visible.
**The lemma form renames the key.** When the lemma form is rendered after an inflected form decided
the membership and its citation form normalises differently, the gloss's key and spelling become
the lemma form's, provided no other gloss of the lexeme already holds that key; otherwise it is a
merge and the job of D7, and the survivor is the gloss whose key is the lemma form's citation form,
so the lemma form's rendering always agrees with its gloss. The rename repairs drift that an
inflected form introduced; the ליהיות typo above came from the lemma form itself, so the rename
cannot touch it, D12 serves it until the model tier of D7 re-keys it, and that is accepted. A rename is neither a split nor a merge: no learner row moves. The
assignment rule (§2, "assignGlosses") is pure and runs on both writers of renderings: the lookup
write and the stale-form repair. The repair is the live case for D9's any-language listing (lane 0
has Hebrew lexemes rendered in English and Russian): it can render a sense that has no membership in
this language yet, and then creates or joins one exactly as a lookup would; a repair of the lemma
form may rename under the same no-collision condition (review).

**D7. Glosses only ever merge, never split, and the lookup path never merges.** A split would take
one level and make two with no evidence about which answers were about which meaning. A merge is
the re-key operation the migration needs anyway (§2), so it is the one regroup, and it runs
outside the lookup: the migration's fold, a background job, and the `dict:glosses:merge` script (§2)
call the same function. The lookup write stays inserts with ON CONFLICT DO NOTHING under the lexeme
lock the sense upsert already takes. **One automatic merge signal: equal keys after
normalisation.** It is applied first inside `assignGlosses` to the answer's own senses, which
nothing references yet, so one answer never produces a pair the job would fold seconds later under
the learner's finger (review). Two glosses of one lexeme that each name the other's key among their
alternatives ("amazing → מדהים or נהדר") are **not** merged automatically: two glosses of one lexeme
always hold different senses, so that is a synonym merge, which the Out list excludes and which
cannot be undone; D3's promise that פיתוח and התפתחות stay apart would not survive it (review). The
mutual-alternatives pair is instead listed as a suggestion by the by-hand tier for the model-judged
pass. **The automatic tier runs as a job** enqueued inside the lookup transaction, per lexeme and
language, under ADR 0007, for equal-key drift between different answers, so such a duplicate lasts
seconds, not until someone runs a script. The job takes the lexeme's FOR UPDATE lock, the one `persistEntries` takes
at its step 1b, so a merge and a lookup serialise and no membership is cascaded away under a
rendering (review). **A merged gloss forwards rather than dies:** its row stays with `merged_into`
set, every learner-side write resolves an incoming id through it, and the gloss index and every read
skip forwarded rows. The learner who triggered the merge may still hold the old id on screen, and a
photo item's options snapshot holds ids for days; both keep working. Gender, plural and vowelled variants
are merged live, since the key is the citation form; what the job catches is drift between two
citation forms. A model-judged tier catches the rest, misspellings included; because a merge cannot
be undone it runs by hand only, prints its plan and changes nothing without `--yes`, as `lane:clean`
does.

**D8. A gloss exists for every rendered sense, written by the lookup.** Since the learner tables
key on gloss ids, a learner must be able to save any sense they are shown, so the lookup writes a
gloss (often of one member) and a membership for every sense it renders, in the same transaction as
the renderings, and a rendering is written only after its sense has a gloss. That is one row per
sense per language carrying no information on its own, accepted under D2.

**D9. A definition per sense, in the headword's language, stored and not shown.** `dict_senses` gains
`definition text`, nullable, written by the first call that creates the sense, in the lexeme's language (the enrollment's `target_language`; the codebase's `source_language` is the learner's own, so this spec says "headword's language" and "learner's language", never "source"). Two reasons. The
merged card needs the members' meanings for its matching and typed-meaning cards. And senses fork
across learner languages today: the rendering call lists stored senses by their gloss in the
learner's language, and for the first learner of a new language there are none, so the service
skips reconciliation (`reconcile` returns the entry untouched when `storedSenses` is empty), the
model invents codes, and the lexeme grows a second set of senses. A definition in the headword's language is a
handle every language can reconcile against, so the rendering call lists code, definition and gloss
and runs even when the learner's language has no renderings yet. Both calls return a definition for
every sense they name that has none, the rendering call included, since it too creates senses; the
write stores it, so an old sense is backfilled by the next lookup that touches it. And a stored
sense is never listed as a bare code: where it has no definition and no gloss in the learner's
language, it is listed with its gloss and example in whatever language it has, which the model reads
(review). Victor: the definition is not shown, because a gloss has several. `definition_notes` on renderings is empty in every row on lane
0 and nothing reads it; the migration drops it.

**D10. Examples stay on the rendering, one per form per sense per language.** Half an example is
per language and the form matters to cloze and sentence cards (`booked` gets "I booked a table").
A gloss owns no example; its examples are those of its members' renderings, reached through the
memberships. The card reads one per member, the lemma form's where it exists, otherwise the
representative form as the detail picks today; the lookup card reads the typed form's. All of them
are shown, uncapped: a gloss rarely has more than three members and a cap would hide exactly the
meaning the learner has not met.

**D11. The headline translation of a saved word is its gloss key, never a rendering.** Today the
list shows `finger` beside אצבעות when the learner saved from `fingers`. The list's headline
sub-select and the detail card read the key. The saved form stays on the entry (`variant_id`, first
form wins, per learner) and is shown as "saved from fingers: אצבעות" under the headline.

**D12. Sessions practise every rendering of a gloss, the standard form rendered by the save.** When
a gloss is saved and its lexeme has no lemma-form rendering in the learner's language, the save
enqueues a `render_lemma` job (ADR 0007) for that lexeme and language. The job looks at the lemma
form. **If the form is a miss**, it runs the ordinary lookup of the lemma, two model calls in the
background that the first learner to type it would have paid anyway: a lookup serves any form with
renderings as a hit and thereafter only repairs the headwords already on it, so a lemma written for
one headword alone would stay partial for every learner forever, `spike` answering with the verb and
never the noun, `see` with one sense (review; lane 0 has seven saved forms in this state). **If the
form is already a hit** without the gloss's headword, it uses the rendering call scoped to that
lexeme to add it, one call. **If the answer has no entry for the gloss's headword**, or the lookup
lands on a correction, it logs `lemma_render_skipped` with the reason and stops: the saved form still
serves. A failure is logged as `lemma_render_failed` and retried by pg-boss; no session ever waits on
it or fails for it (the draft rendered in preparation, which put up to twenty model calls and a
`TranslationUnreadable` inside the session job). Preparation calls no model for forms. It picks one
rendering uniformly at random over every form of every member **whose own `gloss` field normalises
to the gloss's key**. A rendering that disagrees with its gloss, a drifted or misspelt citation
form, is never a card, so a learner is not prompted with a word that was never on their card
(review). The saved form's rendering is always in the set, the lemma form's joins it once its job
has landed. Picking a rendering picks a form and a member in one step, which is
how the rodent and the device take turns. A gloss is picked at most once per session, so forms rotate
across sessions. Cards stay generated per enrollment, as today; nothing is shared between learners
(review struck a sharing sentence from the draft: a generated card bakes in its session's other
answers and its enrollment's recent sentences, and a null-owner row is the seed pool).

**D13. The typed-meaning rule verdict accepts the stored alternatives.** Today the rule compares
the learner's text to the rendering's translation and sends anything else to the judge, so רכב for
מכונית costs a model call. The rule now also accepts the rendering's alternatives and the gloss's,
compared the way the meaning is compared today. The typed, spoken and tiles cards are unchanged:
their alternatives are words in the language being learned, which the generation call still supplies.

**D14. A write resolves a forwarded gloss and refuses one whose language is not the enrollment's.**
Resolution follows `merged_into` to the survivor (one hop: the merge re-points forwarded rows to the
new survivor, so chains never form). Resolving is not a plain read: every write to learner data (the
save, the tutor's add, the photo choice, the session's completion writing progress) first takes a
`FOR SHARE` lock on the lexeme row of each gloss it names, then resolves, then writes, all in its
transaction. The merge job holds that row `FOR UPDATE` (D7), so a save and a merge run one after the
other and an entry can never land on a gloss forwarded a moment earlier (review). A gloss never
changes lexeme, so the row is known before the resolve. The language check is the one new invariant
the explicit key brings. Checked in the save, the tutor's add, the photo import's choice and question
generation, as a 400 with the error family `errors.ts` already has for a foreign sense.

**D15. `sense_id` leaves the wire; `gloss_id` replaces it.** Cards, saves, picks, results and photo
items. ADR 0003 makes the OpenAPI file the contract, so this is a visible change on several
endpoints; the app is ours, so the cost is coordination.

**D16. `sense_progress` is renamed `gloss_progress`;** every row is now about a gloss.
`session_progress` keeps its name.

**D17. ADR 0011, "The learner's unit is the gloss".** Records D1, D2 and D8. Its checkable rule: no
table outside the `dict_` prefix references `dict_senses` or `dict_var_translations`; learner tables
reference `dict_glosses`. The check scans `schema.ts` for foreign keys and gets its planted
violation.

**D18. The same key across headwords is a session guard, not a merge.** A gloss is scoped to one
lexeme, and merging across parts of speech is out, so `book`/verb and `order`/verb both keep להזמין,
as do `più`'s adverb and determiner for יותר and Russian aspect pairs such as читать/прочитать for one
Hebrew verb. Lane 0 has 11 such keys. Two cheap guards in session preparation, both reads on the
gloss index: a session picks at most one gloss per normalised key, and a gloss's **siblings**, the
other glosses of the enrollment's language pair with the same normalised key, supply their forms as
accepted alternatives on a typed or spoken card and as forbidden wrong options on a reverse card,
through the sibling rule `badChoice` already applies to the session's own rows. Siblings also
reach the generation prompt's off-limits list, as the session's other rows do today, since a word
the validator refuses but the prompt never names can fail every retry and end the session failed;
and a typed or spoken card's alternatives are cut to five after siblings join, as the column check
requires (review). A learner who answers "book" to להזמין is right, and never sees "book" offered
as wrong. Review raised this;
the one-pager's two criteria are narrowed accordingly.

**D19. Logs.** `dict_glosses_assigned` on the lookup write with `created`, `joined` and `members`;
`gloss_merged` with both ids and the counts of rows re-keyed; `lemma_rendered`,
`lemma_render_skipped` and `lemma_render_failed` with the reason from D12's job.

---

## 2. Changes

### Data (migration `0022_glosses.sql`)

New tables:

```
dict_glosses
  id                   text        pk, default gen_random_uuid()::text
  lexeme_id            text        not null -> dict_lexemes(id) cascade
  user_language_code   varchar(10) not null
  key                  text        not null   -- citation form, as the model wrote it
  alternatives         text[]      not null default '{}'   -- citation forms
  merged_into          text        null -> dict_glosses(id)   -- D7: a forwarded gloss
  created_at           timestamptz not null default now()
  unique (id, lexeme_id)                                     -- FK target, phase 21's trick
  unique index on (lexeme_id, user_language_code, normalise(key)) where merged_into is null

dict_sense_glosses
  sense_id             text        not null
  lexeme_id            text        not null
  user_language_code   varchar(10) not null
  gloss_id             text        not null
  pk (sense_id, user_language_code)
  fk (sense_id, lexeme_id) -> dict_senses(id, lexeme_id)   cascade
  fk (gloss_id, lexeme_id) -> dict_glosses(id, lexeme_id)  cascade
```

`normalise(key)` is `normaliseGloss` (§2 `packages/core`) as an immutable SQL function, so the unique
index can use it. Glosses exist in every explanation language (lane 0 holds Hebrew lexemes rendered
in English and Russian from reverse lookups), so the rule is language-agnostic, not Hebrew-only. The composite foreign keys make Postgres hold "a sense and its gloss
share a lexeme" (never across parts of speech). `dict_senses` gains `unique (id, lexeme_id)` as the
FK target.

Changed tables:
- `dict_senses`: `definition text` nullable.
- `dict_var_translations`: `gloss text not null` (the citation form the model gave this rendering;
  the migration fills it from the cleaned translation); `alternatives text[] not null default '{}'`; `translation` becomes one
  translation, not a list, and may be several words (בית קפה, בלתי אפשרי, "ha scritto"; lane 0 has
  71 such rows); `definition_notes` dropped.
- Re-keyed, `sense_id` → `gloss_id` referencing `dict_glosses(id)`, every other column, index and
  check kept with the gloss in the sense's place: `vocabulary_entries` (pk enrollment, gloss),
  `sense_progress` → `gloss_progress` (pk enrollment, gloss, dimension; FK into the entry),
  `session_progress`, `questions`, `photo_import_items` (`suggested_gloss_id`, `chosen_gloss_id`).
  `questions.prompt_variant_id` is unchanged: a card is still built from one form's rendering of one
  member.

Invariants held by code and asserted by tests: a sense has at most one gloss per language; a gloss
has at least one member; memberships and glosses are only added or merged; a question's prompt
variant renders a member of its gloss.

Migration order, one transaction:
1. create the tables, the function, the new columns;
2. strip every parenthetical from `translation` ("בסיס (צבאי)" → בסיס; lane 0 has 8 such rows,
   and the text inside is a disambiguator that belongs to the definition, D9), then split the
   comma-separated rest with the sense matcher's gloss splitter: first item to `translation`, the
   rest to `alternatives`, each stripped the same way; `gloss` is set to the cleaned `translation`;
3. one gloss per (lexeme, language, normalised translation of the sense's lemma-form rendering,
   else its lowest-ranked rendering), one membership per rendered sense, gloss alternatives as the
   union of the members' lemma-form alternatives;
4. add `gloss_id` beside each `sense_id`, fill it through the membership;
5. fold colliding rows with the merge rule (§2 Server): entries, `gloss_progress`, questions, and
   `session_progress`, where a session that practised two senses of one gloss has two rows per
   dimension that collide on the new key and are folded by `mergeSnapshots` (lowest before,
   highest after, which keeps the table's check true). On lane 0 that is 24 entries and 16
   sessions (`con`/עם alone has 9);
6. drop `sense_id`, rebuild keys and indexes, rename `sense_progress`.

Old senses get a null definition, which the next lookup that touches them or the script's model
tier fills. Old glosses keyed from an inflected rendering (lane 0's `fingers`/אצבעות, `saw`/ראה)
are renamed by D6 once the lemma form is rendered, and nothing renders it unprompted after a
migration: so `npm run dict:lemmas:render`, run once after `db:migrate` on each database, enqueues
D12's job for every saved gloss whose lexeme has no lemma-form rendering in the enrollment's
language, through `repo/jobs.ts` inside a transaction (ADR 0007), which is why it is a script and
not a statement in the migration (review: without it done-means 5 fails for every existing word).
Nothing live depends on either.

### `packages/core`

- `normaliseGloss(text)`: NFC, maqaf (U+05BE) to a space as the Hebrew answer rule already does,
  then strip Hebrew points and cantillation (U+0591 to U+05C7) and the combining acute that marks
  Russian stress (U+0301), drop parentheticals, collapse whitespace to one space, trim, lowercase.
  So "בית-ספר" and "בית ספר" are one key. The one rule the SQL index, the assignment function, the merge signals, D18's
  siblings and the sense matcher share. Review found four rules for "the same text" in flight
  (`comparable`, the Hebrew answer rule, and two the draft added); this replaces the two the draft
  added. `comparable` and the typed-meaning rule stay, since they compare answers rather than keys.
- Schemas: `TranslationSense` and the detail's sense become a gloss card: `gloss_id`,
  `translation`, `alternatives`, `key` (present when it differs from `translation`),
  `part_of_speech`, `examples[]` (one per member, source and target), `saved`, `added_by`,
  `saved_from` (form and translation, when the saved form is not the lemma), `progress`.
  `VocabularyEntryInput`, picks, snapshot rows and photo items carry `gloss_id`. `sense_id` is
  removed. The list row's `sense_count` becomes `gloss_count`. The OpenAPI file follows.
- `domain/senseMatching.ts` (server): the exact match compares with `normaliseGloss` and reads the
  card's `alternatives` as well as its `translation`, so a printed רכב finds the מכונית card without a
  model call.

### Server

- `domain/translation.ts`: both LLM schemas gain `alternatives`, `gloss`, `gloss_alternatives` and
  `definition` per sense; the rendering call asks for `definition` on every stored sense that lacks
  one and on every new code. The rendering prompt lists stored senses as
  `code — definition — gloss — example`, falling back to any language's gloss and example when the
  learner's has none, and is built even when the learner's language has no renderings yet (D9). Prompt text: one main translation per sense, never a list and never a
  parenthetical disambiguator (that goes in the definition), the other target words as alternatives,
  citation forms uninflected, the definition one short phrase in the headword's language. A translation
  may be several words where the language needs them; the Italian "ha scritto" rule stands.
- `domain/glosses.ts` (new, pure): `assignGlosses(answerSenses, existingGlosses, existingMemberships)`
  → glosses to create, memberships to add, alternatives to union. Rules in D6 order: existing
  membership kept; else join the gloss with the equal normalised key; else senses of this answer with
  equal keys share one new gloss named by the lowest-ranked; alternatives unioned minus the key;
  the lemma form's answer renames a key that no other gloss holds (D6). Returns the lexeme-and-language
  pairs that need D7's merge job; the service enqueues them.
  `mergeLevels(a, b)`: the higher level, the later dates. `mergeSnapshots(a, b)`, for two
  `session_progress` rows of one session that collide: the lowest `level_before`, the highest
  `level_after`.
- `repo/dictionary.ts`: `persistEntries` writes lexeme, variant, senses with definitions, sense
  version, then glosses and memberships (and D6's rename), then renderings with their gloss and
  alternatives, and returns the lexeme-and-language pairs `assignGlosses` flagged.
  `repairVariantRenderings` takes the same per-sense fields, runs the same gloss step before its
  delete-and-insert (its `RepairWouldDropSense` guard unchanged), and returns the same pairs.
  `services/translations.ts` enqueues D7's job for those pairs through `repo/jobs.ts` inside the same
  transaction, for the lookup and for `repairForm` alike: the repository exposes the primitive, the
  service the use case (ADR 0001 R9). `findSensesByLexeme`
  returns definition and gloss and no longer inner-joins the learner's language: it prefers the
  learner's rendering and falls back to the lowest-ranked rendering in any language. `persistEntries`
  stores a definition for a new sense from either call and fills a null one on an existing sense. New
  `findGlossRenderings(glossId)`: every rendering of every member, with form and lexeme.
  `mergeGlosses(survivor, other)` as D7 describes, in one transaction under the lexeme lock,
  idempotent, leaving `other` forwarded. `resolveGlosses(ids)`: share-locks the lexeme rows, then
  returns each id's survivor, one hop; every learner-data write calls it first.
- `repo/vocabulary.ts`, `repo/progress.ts`, `repo/questions.ts`, `repo/sessions.ts`,
  `repo/photoImports.ts`: `gloss_id` in the sense's place; the list's headline sub-select reads
  `dict_glosses.key` and drops the join on the saved variant's translation; the list's two counts
  both count glosses, `saved_count` the enrollment's saved glosses of the lemma and `gloss_count`
  (was `sense_count`) the lemma's glosses in the enrollment's language, so `mouse` reads 1/1 once
  saved (review); the detail reads glosses of the lemma's lexemes with their members' lemma-form
  renderings.
- `domain/vocabulary.ts`: `buildWordDetail` groups by gloss, one card each, examples per member,
  the saved form as `saved_from`.
- `services/translations.ts`: `reconcile` runs with definitions when the learner's language has no
  renderings; the lookup response is one card per gloss. The response cap of five moves from rows to
  cards: `findSensesByForm` reads every rendering of the form and the cap is applied after grouping,
  so `stream`'s seven rows show five cards instead of three (review).
- `services/sessions.ts`: random agreeing rendering per picked gloss (D12), D14's language check,
  D18's one-pick-per-key and the siblings read. No model call for forms.
- `services/vocabulary.ts` and `services/photoImports.ts`: every save of entries, the learner's,
  the tutor's and the photo import's, enqueues D12's `render_lemma` job when the lemma form has no
  rendering for the gloss's lexeme; `domain/jobs.ts` / `worker.ts`: the job, through the translation
  service's ordinary lookup on a miss and its scoped rendering on a hit, idempotent.
- `domain/session.ts`: `pickSenses` becomes `pickGlosses`, uniform over saved rows with at most one
  per key. `domain/distractors.ts`: siblings' forms join the prompt's off-limits rows, a typed item's
  alternatives (cut to five) and a word item's forbidden set.
- `domain/judge.ts`: D13, the meaning rule verdict over the rendering's and the gloss's alternatives;
  the judge context carries both lists.
- `services/vocabulary.ts` (the save and the tutor's add), `services/photoImports.ts`: D14.
- `db/dictExport.ts` / `dictImport.ts`: the four new fields per sense, the definition per sense;
  restore replays through `persistEntries` as today, ids regenerated as for senses.
- `db/progressRecompute.ts`: keys on gloss.
- `domain/jobs.ts` / `worker.ts`: the `merge_glosses` job (lexeme, language): tier 1, equal
  normalised keys only, calling `mergeGlosses`. Idempotent, so a retry is safe.
- `db/lemmasRender.ts` + `npm run dict:lemmas:render` (through `lane-env.sh`): enqueues the
  `render_lemma` job for every saved gloss whose lexeme lacks a lemma-form rendering; idempotent, a
  job already queued or a lemma already rendered is skipped. Run once after the migration; safe any
  time.
- `db/glossMerge.ts` + `npm run dict:glosses:merge` (through `lane-env.sh`): tier 1 over the whole
  dictionary, and tier 2 `--model` (one prompt per lexeme and language with more than one gloss:
  which are forms of one word, with mutual-alternative pairs listed to the operator as suggestions;
  also backfills null definitions). Both print the plan and act only
  with `--yes`. Tier 2 is never called by the server.
- `errors.ts`: `GlossLanguageMismatch`.
- Logs per D19.

### Mobile

- `app/vocabulary/word.tsx`, `components/LookupPanel.tsx`: the gloss card: headline (key on the
  detail, typed form's rendering on the lookup with the key beneath), "also …" from the gloss
  alternatives, part of speech, one example line per member, "saved from …", added by, level, the
  toggle sending `gloss_id`.
- `app/vocabulary/index.tsx`: unchanged in shape; the headline is the key and the mark reads
  `saved_count` of `gloss_count`.
- `app/results.tsx`: practised glosses by key.
- `app/students/words.tsx`, `app/photo-imports/[id].tsx`: the same card, `gloss_id`.
- `strings.ts`: `also`, `savedFrom`, both languages.

### MockServer and eval

- E2E stubs gain the four fields and the definition.
- `tests/eval`: cases that `translation` is one translation with no comma list and no
  parenthetical, that a compound such as בית קפה survives whole, that the citation forms are
  uninflected, the alternatives in the same language, and the definition in the headword's language; a reconciliation
  case with a definition and no gloss in the learner's language that reuses the code. Added to the
  existing tier that tolerates a model update.

---

## 3. Testing

### Unit
- `assignGlosses`: existing membership kept against a different gloss field; join by key; two new
  senses sharing a key; two new senses naming each other among alternatives stay two glosses; three glosses out of five senses (`development`); alternatives unioned; the
  lemma form renaming a key; the lemma form colliding with another gloss's key yields a job, not a
  rename.
- the rendering filter for D12: a drifted rendering excluded, the saved form always included, the
  lemma form included once rendered.
- `mergeLevels`, `mergeSnapshots` and the merge's entry rule (earliest save, its form, its adder).
- the meaning rule verdict accepting a rendering alternative and a gloss alternative, and still
  sending an unlisted word to the judge.
- `normaliseGloss` on a shared case list: vowelled Hebrew, a stressed Russian word, a parenthetical,
  double spaces, mixed case, a maqaf; the SQL function run over the same list in an integration test
  and required to agree.
- the sense matcher finding a card by an alternative.
- the lookup's card cap: seven rows over two lexemes group to five cards, none hidden by a row cap.
- the migration's translation cleaner on the shapes lane 0 has: 35 comma lists, 8 parentheticals
  including one with a slash inside, 71 compounds that must survive whole, and "א, ב / ג".
- `buildWordDetail` by gloss: card order, examples per member, `saved_from`, `key` only when it
  differs.
- the list assembly reading the key, and the mark counting glosses on both sides: `mouse` with both
  senses saved is 1 of 1.
- `pickGlosses` with two saved glosses of one key: one picked, uniform over the rest; a typed item
  accepting a sibling's form and holding at most five alternatives; a word item refusing it as a
  wrong option; the prompt naming it as off limits.

### Integration (real Postgres)
- migration on a fixture with lane 0's 24 colliding entries and its 16 sessions whose snapshots
  collide: every saved gloss survives, highest level per dimension, questions re-pointed, snapshots
  folded, the check still true, counts match. Without the snapshot rule the key rebuild raises and
  the whole migration rolls back, and the merge job would fail on every retry for the same sessions
  (review).
- `persistEntries` under two concurrent lookups of one form: one gloss, two memberships, no 40P01.
- a repair of a form in a language where one of the lexeme's senses has no membership: the
  membership is created, the rendering carries gloss and alternatives; a repair of the lemma form
  renames a key that no other gloss holds, and does not rename one that another holds.
- `mergeGlosses` on two enrollments, each with generated questions on both glosses; run twice,
  same result; the merged id resolves to the survivor and a save by it lands on the survivor.
- a lookup that joins a sense to a gloss while the job merges that gloss: both commit, the
  membership lands on the survivor, no rendering is left without a gloss.
- a save racing a merge of the gloss it names: the entry lands on the survivor, one row.
- a session completing during a merge of a practised gloss: its progress and snapshot land on the
  survivor.
- the `merge_glosses` job: enqueued only inside the lookup transaction (ADR 0007's check), merging
  an equal-key pair, leaving a mutual-alternatives pair alone, no-op on a lexeme with one gloss per
  key.
- `dict:lemmas:render` over the migration fixture enqueues one job per lane 0's seven unrendered
  lemmas and none for a rendered one; after the jobs run the list reads `finger`/אצבע.
- the `render_lemma` job: enqueued by a save of an inflected form and not by one of the lemma; on a
  miss it writes every headword of the lemma, not only the gloss's (`spike` gains its noun); on a hit
  lacking the headword it adds that headword; with no entry for the headword it skips; a failed
  rendering leaves the session able to prepare on the saved form.
- the rendering call for a language with no renderings reuses the sense by definition; and, with
  no definition either, by the other language's gloss and example; a null definition is filled from
  the answer.
- D14's refusal.
- the list page's headline read within phase 21's 50 ms budget at the plan test's volume.

### E2E
- look up `mouse`: one card, two examples; save; session has it once; the word page shows one
  level.
- look up `fingers`, save: the list says `finger` / אצבע; the card says "saved from fingers".
- a session card prompts with `finger` for a word saved from `fingers`, after the job has run.

### Architecture
- ADR 0011's check: plant a foreign key from a non-`dict_` table to `dict_senses` and confirm the
  report.

## Build order

1. `packages/core`: normalise rule, schemas, OpenAPI.
2. Migration and schema, with the fold; integration tests for it.
3. `domain/glosses.ts`, `persistEntries` and the repair; the `merge_glosses` job; prompts, stubs,
   eval cases.
4. Repos and services on `gloss_id`; D14; the judge's rule for D13.
5. The `render_lemma` job and its enqueue on every save; sessions: D12's rendering choice, D18's
   pick and siblings.
6. Mobile cards and strings; E2E.
7. `dict:lemmas:render`, `dict:glosses:merge`, export and import, recompute.
8. ADR 0011 and its check.

## Risks

- **The model inflects a citation form.** Then one word gets two glosses that the automatic tier
  cannot see. The eval guards the prompt; the model tier is the remedy. Accepted: it costs a
  duplicate card until the script runs, never a lost save.
- **Migration numbering.** Phases 29 and 30 are open on their branches; if either lands a migration
  first this one is renumbered at merge, as phase 28's was.
- **Reconciliation with definitions changes the second call's behaviour** for every new form,
  not only for new languages. The eval's reconciliation case and the existing stale-form tests cover
  it; the first lookups after deploy are watched through `dict_reconciled`'s `reused` count.

## As built

Built on branch `phase-31-glosses`. Where the build departs from the letter of the sections
above, it is listed here with its reason; everything else was built as written.

**Decided while planning**

1. **This phase's ADR is 0011.** Phase 29 holds `adr-0009-sign-in.md` and phase 30
   `adr-0010-single-container-migrations.md`.
2. **Three migrations, `0024_glosses`, `0025_glosses_rekey` and `0026_lemma_renders`, where §2
   names one `0022_glosses`.** Phase 29 merged first with `0022_auth` and `0023_users_auth_fk`,
   and drizzle applies every pending migration in one transaction, so a deploy still migrates
   atomically.
3. **The lemma backfill runs at every start of the CLI's default path, after migrate and seed,
   and on demand as `npm run dict:lemmas:render`; `dict_lemma_renders` records each lexeme and
   learner language asked for.** The container's start command is the one step every deploy runs
   (ADR 0010), and without the record a lemma the job skipped would cost model calls on every
   start.
4. **The merge job's one signal is a blocked rename: a lemma form whose citation form another live
   gloss of the lexeme already holds.** The unique index on live keys makes two live glosses with
   one key impossible, so that is the only equal-key drift left for D7.
5. **`sense_id` left the wire in one change across the server, the app and the e2e suite (D15).**
   A contract renamed halfway would have had an endpoint speaking both.
6. **`normaliseGloss` and `gloss_key` map a hyphen as well as a maqaf to a space.** The spec's own
   example, "בית-ספר", is written with a hyphen.
7. **`0025` rewrites a photo import's stored options into one card per gloss, and a merge leaves
   photo rows alone.** Options are a snapshot, and a stale gloss id in one resolves through
   `merged_into` when the import is saved.
8. **The results name a practised gloss by its key, beside the form the session asked.** The
   asked form is what the row's speak button says; the missed list still shows each card as it
   was asked.
9. **The list's headline is the learner's earliest saved gloss of the lemma.** D11's headline is
   the key, which reads no rendering, so the rendering rank that used to pick it is gone.
10. **ADR 0001 R4 lets `db/cli.ts` import the composition root.** The merge tool's model tier
    needs a Gemini client, only `composition.ts` may build one (R11), and the CLI is an entry
    point (R7).

**Ruled during the build**

- **The first call returns at most three headwords (`LlmTranslationSchema.entries` is capped at
  3, five senses each).** With the four new sense fields Gemini refused five by five as having
  too many states; three by five keeps every headword's sense depth, and the cap stayed when the
  first call later lost one field.
- **The first call asks for no citation alternatives; the rendering call still does, and a
  lemma-form write's own alternatives feed its gloss's, as `0024` built them, in the lookup and
  the repair alike.** With `gloss_alternatives` in its response schema the first call answered
  `pour`, English though French has the word, with no entries in four to seven calls of ten,
  where the schema before phase 31 never did. A lemma form's alternatives are citation forms
  already, so D5's list stays filled, while an inflected form's never join it.
- **The first call's citation sentence is worded as measured, because `pour` tips on it too.**
  Without the field but with the sentence as first written, `pour` was still empty in 11 of 20
  calls, and two harmless rewordings made it 20 of 20; as built it was empty in none of 40 probe
  calls, five runs of the case alone and two full runs. `glossRules` records each variant.
- **An answer's senses that already have a membership are assigned before its new ones, each
  group in rank order, and a sense code repeated in one answer counts once.** Renames then land
  before a new sense looks up a key, so one answer never leaves a pair for the merge job (D7).
- **Only a gloss's first member in the write, by rank, can rename it; a later member that drifts
  never does, and the merge job's finder reads the same member.** D6 records drift on the
  rendering and never moves a membership, and the finder must not fold glosses this rule keeps
  apart.
- **`gloss_key` spells out the whitespace JavaScript's `\s` matches and lowercases with the
  database's `lower()`.** That makes it `normaliseGloss`'s twin except on dotted capital I and
  Greek final sigma, which none of the app's languages use.
- **A sentence's translation is never split into alternatives; a word's or a phrase's is.** A
  sentence's comma is punctuation, while lane 0's comma phrases are real lists.
- **The lookup card and the word page's card are two shapes.** The lookup card is the typed form's
  rendering, with `key` only when the key normalises differently, the typed form's alternatives
  and one example per member; the word page's card is headlined by the key and adds the gloss's
  alternatives, `form`, `saved_from`, `added_by` and `progress`, because a lookup answers for the
  form typed and the page for the saved word.
- **The word page takes each member's example from that member's renderings that have a whole
  example, the lemma form first, then the representative form.** D10 shows every member's
  example, and picking the lemma form before checking for an example lost some.
- **A photo option carries the gloss key, and the photo review shows the key and "also …" on its
  collapsed row too.** §2 calls the photo review the same card as the lookup's.
- **The photo import's exact match trims a trailing mark before `normaliseGloss`, compares a
  card's translation, key and alternatives, and ranks a card's own translation or key above
  another card's alternatives, ties in lookup order.** A printed gloss often ends in a mark or
  prints a citation form beside an inflected word, and a word one card lists as an alternative
  can be another card's own.
- **A render whose retries are spent goes to a dead-letter queue that releases its claim, so the
  next save or start asks again; a skip keeps its claim, and a sentence answer is a skip.** A
  provider outage during a deploy's backfill would otherwise lose every render it touched.
- **The CLI's start-up request is best-effort, and claims are inserted in key order.** A failure
  logs one line and the server starts, since the claim rolled back and the next start asks
  again; key order is `lockLexemes`' order, so two saves sharing lexemes cannot deadlock.
- **The render job's closing check that the lemma now renders is a read-only transaction of its
  own, after the model call and the lookup's write.** ADR 0001 R8 lets only reads before
  third-party I/O stand alone, but this read changes nothing and only chooses between
  `lemma_rendered` and `lemma_render_skipped`.
- **The failed-render test checks the word page on the saved form, not session preparation.**
  Preparation never reads lemma renders, so it cannot wait on one.
- **A dictionary restore carries no merge, so the README and the hosting runbook follow it with
  `dict:glosses:merge`, tier 1 then `-- --model`, and a round-trip test pins the gap.** The
  export holds renderings and not memberships, so a restore rebuilds glosses from renderings.
- **`dict:glosses:merge` runs wherever `DATABASE_URL` points, production included from the laptop
  (PR #113); tier 1 needs no Gemini settings, and a tier 2 lexeme whose call fails is logged,
  skipped and counted in the plan.** Production's database is no longer reachable from the
  container alone, and one provider failure should not throw away a reviewed plan.
- **Tier 2 asks the model about the headwords with more than one live gloss, as §2 selects them,
  and fills their senses' missing definitions on the way; `--definitions` extends it to every
  headword with a sense that has no definition, and is refused without `--model`. Tier 2 prints
  how many headwords it will ask before the first call, then one line per headword, and the
  "Nothing changed" hint repeats every flag given.** After the deploy nearly every sense lacks a
  definition, so asking about each such headword would cost a model call per headword in the
  dictionary, silently, and again on `--yes`, which still plans again before applying. A
  definition that waits for `--definitions` is filled meanwhile by the next lookup whose model
  call names its sense.
- **A typed or spoken card accepts at most three sibling headwords before the model's
  alternatives, then any remaining siblings, five in all (D18).** Siblings are lemmas while the
  model's alternatives are inflected to the card's form, so five siblings filling every slot
  marked a right inflected synonym wrong while a sibling lemma was accepted.
- **The meaning card's rule accepts the gloss key too (D13), unless it is the stored meaning
  itself.** The list and the word page head a saved word with its key (D11), so a learner asked
  the meaning of `fingers` who types אצבע is right without a judge call.
- **No gloss key normalises to nothing.** `renderingOf` takes the translation as the citation form
  when the model's normalises to '' ("-", a bare parenthetical, blank text), and `assignGlosses`
  keys such a sense by its translation, whichever writer calls it, and never renames a gloss to
  such a key. One key of '' would gather every such sense of a headword into one gloss and head
  its card with nothing.
- **`also` and `savedFrom` are Hebrew only.** The app's strings have one language, so "both
  languages" had nothing to fill.
- **`0025`'s snapshot was made with drizzle-kit's `generateDrizzleJson`.** `db:generate --custom`
  in drizzle-kit 0.31.10 copies the previous snapshot rather than snapshotting `schema.ts`.
- **ADR 0007 names the CLI's queue (`withJobQueue`, in `db/lemmaRenders.ts`), ADR 0006 R3 checks
  the two new root scripts, ADR 0002 R6 lists the three new factories, and ADR 0010 carries a
  dated note that production's database is reachable from the laptop.** Every ADR binds, so
  each new entry point is written into the one that governs it.

**Consequences worth knowing**

- **A key with more than three sibling headwords may leave some of them unaccepted.** Three come
  first, alphabetically, and the rest only fill the slots the model's alternatives leave of five.
- **A translation that itself normalises to nothing still keys its gloss.** The fallback is the
  translation, and nothing stands behind it; the model's schema refuses an empty translation, so
  only a translation that is nothing but a parenthetical or a dash can reach it.
- **Siblings are lemmas only.** A sibling's inflected form is accepted only when the model listed
  it, and kept off a reverse card's wrong options by the prompt alone.
- **The judge context reads one rendering per card, the lowest-ranked.** A form that renders two
  members of one gloss contributes only the first member's inflected alternatives.
- **Known limitation: a slash splits a translation as a comma does.** The splitter is the sense
  matcher's, as §2 says, so `and/or` comes back as ו with או as an alternative, and a gender form
  such as "חבר/ה" splits the same way.
- **A `merge-glosses` job has no dead letter.** A merge that keeps failing leaves two glosses,
  which `dict:glosses:merge` also finds.
- **A prepare-session job queued by the old container fails once after the deploy**, on the new
  picks schema, and its session is marked failed; deploying while no session is being prepared
  avoids it.
