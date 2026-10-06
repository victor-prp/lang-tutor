# Phase 22 — Italian as a target

- **Status:** Implemented on branch `phase-22-italian-target`. The design was decided autonomously
  on 2026-10-06: Victor scoped the phase in the one-pager, then asked for the design to be made
  from the app's context without questions, planned and built. Every decision is recorded in §1
  with its reason, so each one can be overturned in review. Deviations found while building are
  folded in below: Italian's own English rule (D2), two eval cases changed or added (§3), and the
  recorder's pair-only run fixed (§2).
- **Date:** 2026-10-06
- **Source:** the one-pager `drafts/2026-10-06-italian-target-one-pager.md`. `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 16, which added Russian as a language to learn and made the language table
  (`apps/server/src/domain/languages.ts`) the single source for scripts and prompt rules. Phases
  18–21 (saved words, list-built sessions, progress, the list by lemma) are language-generic and
  need no change.
- **Touches:** ADR 0003 (the language enum on the wire). No new ADR and no new check script.

## Goal

Victor has started learning Italian, knows about 50 words, and wants to use the app with it.
Today a learner can enroll only in English or Russian. Italian becomes the third language to learn,
"just like Russian, nothing special for now".

**Done means:**

1. A Hebrew speaker enrolls in Italian from the enroll screen and completes the seeded
   10-question Italian first session.
2. That learner looks up Italian words (`it → he`) and Hebrew words (`he → it`), flips between the
   two directions, and saves Italian senses to an Italian list.
3. After saving, the next session is built from the Italian list, as for Russian since phase 19.
4. Italian sits beside English and Russian in the switcher, and switching works as it does today.
5. `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass, the
   last without lowering `TIER2_THRESHOLD`.

Victor then uses it with the words he knows and reports what needs fixing. That is the real
acceptance, and it happens after merge.

## Scope

**In:**
- `it` in the language table, with Italian citation, correction and writing rules;
- `it` in `LanguageCodeSchema`, so `{he, it}` becomes a supported translation pair;
- a migration that widens `enrollments_target_known` to accept `it`;
- ten `it → he` seed rows, recorded through `npm run content:generate`;
- the app offering Italian on the enroll screen and naming it **איטלקית**;
- Italian eval cases for the translation prompt and the distractor prompt;
- the published API descriptions naming Italian.

**Out:**
- anything Russian does not have;
- a bulk Italian backfill: `data/backfill/` stays en–he;
- learning Italian through English, and an English UI;
- noun gender and articles as something the app shows or teaches (*il libro*);
- practising verb conjugations;
- Unicode composition (NFC) of typed input, and folding the typographic apostrophe `’` into `'`
  (§1, D6);
- a new ADR or check script.

---

## 1. Decisions

**D1. Italian is one entry in the language table, and its script is Latin.** Phase 16 built the
table so that "adding a language means adding one entry", and every reader of it (the script
guard, both prompt builders, the corrected-form guard, the distractor prompt, the seed's content
test) picks the entry up. `letters` is `/\p{Script=Latin}/u`, the same as English, which also
covers `à è é ì ò ù`.

**D2. The script guard cannot tell Italian from English, and does not need to.** This answers the
one-pager's parked question about Latin script. Since phase 16 the client states the direction
from the active enrollment, so nothing is detected from the script. The guard's job is to catch a
wrong-script input before a model call. Under `it → he`, Hebrew input gets `wrong_direction` and
Cyrillic gets `out_of_pair` exactly as for Russian. English typed under `it → he` passes the
guard, like Ukrainian `дякую` under `ru → he`. It reaches the model, which returns empty entries,
and the screen shows the existing "no results" state. An eval case locks this in (§3).

The shared third-language rule was not enough on its own: `window` came back corrected to
`finestra` in 3 of 3 calls, because the correction rules read it as "plausibly intended". So
Italian's `asSource` names English as a third language, with `weekend` as a loanword Italian
really uses. The line is in Italian's entry, so the en/he and ru/he prompts are unchanged.

**D3. A missing accent is a misspelling, corrected through phase 13.** This answers the parked
question about *perche*. A learner on a phone keyboard will often type `perche`, `citta`, `piu`.
This is the same shape as Russian `елка` for `ёлка`, and it gets the same treatment: an `asSource`
rule says the unaccented spelling is a misspelling to correct, with an exception for an
unaccented spelling that is itself a different word (`se`/`sé`, `e`/`è`, `papa`/`papà`). The
correction then flows through phase 13's existing path. The model returns `corrected_form`, the
redirect is stored, and every later `perche` is served without a model call. Accents are never
stripped in `normalizeForm`. Unlike Russian stress marks, an Italian accent is spelling: `e` (and)
and `è` (is) are two words.

**D4. Citation forms follow Italian dictionaries.** A noun belongs to its singular, an adjective to
its masculine singular, and a verb to its infinitive (`parlo` → `parlare`). A pronominal verb takes
its `-si` infinitive (`mi chiamo` → `chiamarsi`). This is the Italian counterpart of Russian's
nominative-singular and infinitive rule.

**D5. Past tense into Italian is the passato prossimo, third-person masculine singular.** Phase
12's rule renders a past-tense input as a past-tense translation, "using the target's citation form
for that category". Hebrew names that form (third-person masculine singular), and so does Russian
(masculine singular). Italian has several past tenses, so it needs one named too. The passato
prossimo is the past tense of everyday speech, which is what a beginner meets: `הלך` → `è andato`,
`הזמין` → `ha prenotato`.

**D6. No new input normalisation.** Phone keyboards type precomposed `é`, so NFC would only change
keys for input nobody sends, and it could reorder Hebrew points in already-stored keys. The
typographic apostrophe (`po’` from iOS smart punctuation) already affects English contractions
today. It costs a repeat model call, never a wrong answer. Both stay as they are until the
dictionary shows a duplicate.

**D7. The Italian seed mirrors the Russian ten.** The first session of any enrollment is seeded
(phase 19), so Italian needs at least `SESSION_LENGTH` rows. They follow the Russian set's mix of
nouns, an adjective, a verb and set phrases, so the two first sessions are alike:
`finestra` · `libro` · `acqua` · `amico` · `difficile` · `ricordare` · `per favore` · `buongiorno` ·
`grazie mille` · `arrivederci`. Each row's Hebrew distractors are hand-written to be plausible but
wrong, avoiding a second right answer (no `שלום` beside `arrivederci` or `buongiorno`). The right
answer is spliced in from the recording, as for every other row.

**D8. No Italian-specific UI.** The app already composes every language-dependent string from
`languageName`. The enroll screen, the switcher, the direction label, the out-of-pair notice and
the list title all pick up **איטלקית** from one map entry.

---

## 2. Changes

### Wire (`packages/core/src/api/schemas.ts`)

- `LanguageCodeSchema` becomes `['he', 'en', 'ru', 'it']`. The pair refinement ("every supported
  pair includes Hebrew") is unchanged and already admits `{he, it}` and refuses `en ↔ it`.
- `NativeLanguageSchema` and `EnrollmentSourceSchema` are unchanged: Italian is a target only.
- Response language fields are already plain strings, so no shipped client breaks.

### Database

`enrollments_target_known` becomes `in ('he', 'en', 'ru', 'it')`, through migration
`0014_italian_target.sql`, generated by drizzle-kit from `schema.ts`. No other column constrains a
language code.

### Server

- **`domain/languages.ts`:** `LanguageCode` gains `'it'`, and `LANGUAGES` gains the entry below.
  Every rule string obeys the file's existing constraint: no unquoted `see` or `saw`.

  | field | content |
  |---|---|
  | `name` | `Italian` |
  | `letters` | `/\p{Script=Latin}/u` |
  | `asSource` | the citation rule (D4); the missing-accent rule with its exception (D3); English as a third language (D2) |
  | `asTarget` | the passato prossimo rule (D5) |
  | `writing` | write every accent the word has, grave or acute: `però`, `così`, `più` |

  The rules' own examples are deliberately different words from the eval cases (§3), so the
  evals measure the rules rather than recall of the examples.

- **`app.ts`** and **`routes/translations.ts`:** the published descriptions name Italian beside
  Russian.

### Seed (`db/content.ts`, `db/content.generated.ts`)

Ten `it → he` rows (D7), with `question_id`s `q-it-<query>`. `content.generated.ts` gains their
recordings from a real `npm run content:generate -- --pair it-he` run, read before committing.
`seed.ts` needs no change: it is pair-aware since phase 16.

The recorder had a latent defect. A `--pair` run with no query started from an empty map, so it
wrote that pair's recordings and dropped every other pair's. A run narrowed by a query or by a
pair now merges, through `recordingBase` in `db/content.ts`, which is unit-tested beside
`parseRecordArgs`.

### Mobile

- `enrollments.ts`: `ENROLLABLE_TARGETS` and `KNOWN` gain `it`.
- `strings.ts`: `LANGUAGE_NAMES` gains `it: 'איטלקית'`.

---

## 3. Testing

### Unit

- **`languages.test.ts`:** `LANGUAGES` holds `en`, `he`, `it`, `ru`. Under `it → he`, Italian with
  accents passes (`perché`, `città`), Hebrew is `wrong_direction`, Cyrillic is `out_of_pair`, and
  an English word passes (D2). `è` alone passes, because one Latin letter is enough.
- **`translation.test.ts`:** the learner line reads "for a Hebrew-speaking learner of Italian" in
  both directions. Italian's source rules appear only when Italian is the source, its target rule
  only when it is the target, its writing rule in both. No Italian rule appears in an en/he or
  ru/he prompt. The rendering prompt carries the same rules.
- **`dictionary.test.ts`:** `normalizeForm` leaves `perché` and `città` untouched (D3).
- **`distractors.test.ts`:** an `it → he` prompt names Italian.
- **`content.test.ts`:** seeded pairs are `en-he`, `it-he`, `ru-he`. The existing checks (a
  recording per entry, `SESSION_LENGTH` per pair, no distractor equal to the answer, queries in
  their language's script) cover the new rows unchanged.
- **`schemas.test.ts`:** `{it, he}` and `{he, it}` are accepted, `{en, it}` refused, and an Italian
  enrollment accepted.
- **Mobile `enrollments.test.ts`:** `availableTargets` offers `en`, `ru`, `it`; `lookupDirection`
  of an Italian enrollment is `it → he`; `asLanguageCode('it')` is `it`.

### Integration

- **Enrollments route:** a learner enrolls in `it` (201) beside an `en` enrollment, and a second
  `it` is a 409.
- **Repo:** the database accepts an `it` enrollment, so the widened check is proven against a real
  migration.
- **Seed:** ten `it` questions, and seeded variants and question rows are in `en`, `ru` or `it`.
- **Sessions:** a learner holding `en` and `it` starts a session on the Italian enrollment and gets
  only Italian seed prompts.

### Evals

Italian cases join `CASES`, counted toward tier 2 like every other. Each locks one rule:

| case | pair | expectation |
|---|---|---|
| `parlo` | it → he | lemma `parlare` |
| `libri` | it → he | lemma `libro` |
| `bella` | it → he | lemma `bello` |
| `in bocca al lupo` | it → he | phrase, `בהצלחה`, never word for word |
| `perche` | it → he | `correction.corrected_form` = `perché` |
| `citta` | it → he | `correction.corrected_form` = `città` |
| `se` | it → he | `אם`, no correction: an unaccented word is not a missing accent |
| `papa` | it → he | no correction: `papa` is itself a word |
| `window` | it → he | empty: an English word is not Italian (D2) |
| `computer` | it → he | `מחשב`, no correction: a loanword Italian uses is Italian (D2's counterweight) |
| `חלון` | he → it | `finestra` |
| `הלכנו` | he → it | `siamo andati`, never `andammo` or `andare` (D5) |

`הלכנו`, not `הלך`: `הלך` is also the Hebrew dictionary headword of the verb, so `andare` is a fair
answer to it. The `הלכנו` case always loses the tier 2 stem check, because the Hebrew lemma `ללכת`
is not a substring of an example built around `הלכנו`. That is a limit of the heuristic for
Hebrew inflections.

`DISTRACTOR_CASES` gains "Italian words of four parts of speech". An Italian case that scores
poorly is a prompt problem to fix, never a reason to lower `TIER2_THRESHOLD`.

### e2e (`e2e/tests/enrollments.spec.ts`)

1. **An Italian learner gets an Italian session.** A learner enrolled in English adds Italian from
   the switcher (`enroll-it`), the switcher reads **לומד/ת: איטלקית**, and the first question's
   prompt is one of the ten Italian seed queries.
2. **An Italian lookup opens `it → he` and is served from the seed.** The direction label reads
   **מאיטלקית לעברית**, a flip with nothing looked up reads **מעברית לאיטלקית** and makes no
   request, and `finestra` answers with no Gemini expectation registered.

`createLearner` accepts `it`.

### Architecture

`npm run lint:arch` passes with no new file outside its layer. No ADR changes.

---

## Build order

1. The wire enum, the language table entry and its unit tests, the migration, the descriptions.
2. The Italian eval cases, run against the real model until they pass reliably. A failing case
   changes the Italian rule text, never the threshold.
3. The seed rows and their recordings.
4. The mobile map entries, then the integration and e2e tests.

## Risks

- **Italian rule text is new prompt text.** The missing-accent rule is the likeliest to misfire,
  "correcting" a real unaccented word. That is why there are two counterweight cases (`se`,
  `papa`), the way `все`, `берет` and `небо` back the `ё` rule.
- **Recordings come from the model.** Phase 16's Russian recordings and distractors were reviewed
  by Victor before merge. This phase's ten are read by Claude and listed in the PR for Victor to
  check with his own Italian.
- **Shared Latin script.** An English word typed under the Italian enrollment depends on the model
  to come back empty, not on the guard. A loanword Italian really uses (`computer`, `weekend`) is
  translated, which is right.
