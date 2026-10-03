# Phase 16 — Learner enrollments, and Russian

- **Status:** Design approved section by section, 2026-10-03. Awaiting review of this written
  spec before planning.
- **Date:** 2026-10-03
- **Source:** [draft proposal](../../../drafts/2026-09-17-learner-enrollments-proposal.md), revised
  through two rounds of review questions, then refined in the design dialogue recorded here.
  Where the two disagree, this spec wins. It corrects three things the draft got wrong:
  - the prompts are hardcoded to one pair;
  - `to` is not always a source language;
  - the app's UI is Hebrew-only.
- **Touches:** ADR 0003 (wire contract), ADR 0002 R6 (factory list), the `users` table introduced
  under ADR 0005.

## Goal

One learner, several enrollments. An enrollment is a course of study in one language, explained
in another, and the learner switches between their enrollments in the app. Russian is added as a
language to learn.

**Done means:**

1. A Hebrew speaker signs up, enrolls in Russian, and after `npm run db:reseed` completes a
   10-question Russian session.
2. That learner looks up Russian words (`ru → he`) and Hebrew words (`he → ru`), and flips
   between the two directions.
3. The same learner adds English as a second enrollment and switches between the two. Sessions,
   lookups and the profile follow the active enrollment, and each enrollment's sessions stay
   attributed to it.
4. Every existing learner keeps working after the migration, with one enrollment carrying the
   pair they had, and can add another.
5. `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass,
   the last without lowering `TIER2_THRESHOLD`.

## Scope

**In:**
- the `enrollments` entity and API, with several enrollments per learner;
- an enrollment switcher and an "add a language" entry point in the app;
- `(user_id, enrollment_id)` keys on `sessions` and `questions`;
- explicit `from`/`to` on translations, with a script guard;
- prompts built from the language pair;
- `dict_variant_renderings`;
- Russian normalisation;
- a pair-aware seed with 10 `ru → he` questions;
- the enroll screen and a translate screen that shows the direction;
- Russian eval cases.

**Out:**
- **A proficiency `level`.** It was half of the original ask ("level B in English") and is
  deliberately not delivered here.
- per-sense progress;
- a bulk Russian backfill: `scripts/translation-backfills/` and `data/backfill/` stay en-he;
- deleting or editing an enrollment;
- an English UI;
- English as a source language for new enrollments;
- a new ADR or check script.

### Assumptions that hold only in this phase

The design leans on these facts. Each one ends when the restriction it names is lifted, and the
code that relies on it says so in a comment.

| Assumption | Lifted by |
|---|---|
| A new enrollment's source is `he`, so a learner holds at most two (`en`, `ru`) | an English UI |
| Every supported translation pair includes `he`, so the prompt's learner is a Hebrew speaker | an English UI or a non-Hebrew pair |

---

## 1. Data model and migration

### `enrollments`

```
enrollments
  id                text pk
  user_id           text not null → users.id
  source_language   varchar(10) not null   CHECK IN ('he','en')       -- explanations
  target_language   varchar(10) not null   CHECK IN ('he','en','ru')  -- the language learned
  created_at        timestamptz not null default now()

  CHECK  (source_language <> target_language)
  UNIQUE (user_id, target_language)      -- one enrollment per target, permanently
  UNIQUE (user_id, id)                   -- the composite FK target
```

There is no `UNIQUE(user_id)`: the switcher (§5) ships in this phase, so a second enrollment is
reachable and tested from the start. "Russian through Hebrew" alongside "Russian through English"
is not a supported state, now or later. A learner learns a language once.

There is no `active_enrollment` column either. Which enrollment is active is a fact about one
device's screen, not about the learner. A column would go stale across devices and invite
endpoints to read it implicitly, so every request names its enrollment or its pair explicitly.

The pair belongs to the enrollment, not the person. `users` keeps `username`, `display_name`,
`age` and `native_language`, and loses `target_language`. `native_language` becomes profile
information: nothing on the learning path reads it.

The database allows `en` as a source, so existing English-native users migrate unchanged. The
phase's "source must be `he`" restriction lives in the API (§2), not the schema.

Named `enrollments`, not `student_profile`. What is being modelled is a course of study. A
second person-shaped entity next to `users` would invite `display_name` and `age` to be
duplicated per language, and would muddy ADR 0005, where `users.username` is the one thing that
identifies a learner.

### What references an enrollment

```
FOREIGN KEY (user_id, enrollment_id) REFERENCES enrollments (user_id, id)
```

This is the pattern `answers` already uses against `session_questions`. It carries the full pair
and proves the row's user owns the enrollment.

- **`sessions`** gains `enrollment_id NOT NULL`.
- **`questions`** gains a nullable `enrollment_id`. Its existing nullable `user_id` joins it in
  the composite FK, with `CHECK ((user_id IS NULL) = (enrollment_id IS NULL))`. NULL still means
  "shared".

The dictionary tables take no user and no enrollment. *"That `thruot` is not an English word is
a fact about English."*

### `dict_variant_renderings`

```
dict_variant_renderings
  variant_id               text not null → dict_variants.id
  user_language_code       varchar(10) not null
  rendered_sense_version   integer not null
  PRIMARY KEY (variant_id, user_language_code)
```

It replaces `dict_variants.rendered_sense_version`, which is dropped. A variant with no row for
a language is stale for that language. That is the correct answer for a first lookup in that
language.

**Why this phase needs it.** A Hebrew speaker learning Russian (`ru → he`) and a Hebrew speaker
looking up Hebrew words in Russian (`he → ru`) do not share variants. But `he → ru` and `he → en`
do: both write Hebrew variants, rendered into different languages. With one counter per variant,
a repair rendering `en` stamps the variant current and leaves its `ru` rows permanently behind.
The comment at `db/schema.ts:108-115` predicted exactly this. It takes two lookups of one Hebrew
word into two languages: `he → ru` and `he → en`, by two learners or by one learner with both
enrollments.

### Migration

One Drizzle migration, in this order:

1. Create `enrollments`. Insert one row per user: `source_language = native_language`,
   `target_language = target_language`.
2. `sessions`: add `enrollment_id`, backfill it from the user's enrollment, set it `NOT NULL`,
   add the composite FK.
3. `questions`: add `enrollment_id`, the composite FK and the both-or-neither check. Every
   existing row is shared, so there is nothing to backfill.
4. Create `dict_variant_renderings`. Backfill one row per (variant, `user_language_code` present
   in `dict_var_translations` for it), copying `rendered_sense_version`. Drop the old column.
5. Drop `users.target_language` and the `users_languages_differ` check, which moves to
   `enrollments`.

The migration is deterministic, because `target_language` has never been editable:
`routes/users.ts` is create + login only.

`reseedContent`'s `TRUNCATE … CASCADE` names `dict_variant_renderings` explicitly. Phase 13
found that a table with no FK path from the truncated set is left behind.

**Tripwire: an enrollment's pair is immutable.** There is no endpoint to edit one. Changing
`target_language` in place would misattribute every session already recorded against it. A
learner who wants another language adds an enrollment, which is what the switcher is for.

---

## 2. Wire contract and API (ADR 0003)

### Language schemas (`packages/core/src/api/schemas.ts`)

| Schema | Values | Used by |
|---|---|---|
| `LanguageCodeSchema` | `he`, `en`, `ru` | translation `from` / `to` |
| `NativeLanguageSchema` | `he`, `en` | `CreateUserRequest.native_language` |
| `EnrollmentSourceSchema` | `he` | `CreateEnrollmentRequest.source_language`. A phase restriction, published, so widening it is non-breaking |

Response language fields stay plain `z.string()`, following the existing `UserSchema` comment. A
client that shipped before a new language must not fail validation on it.

### Users

`CreateUserRequestSchema` and `UserSchema` lose `target_language`. `services/users.ts` loses its
native ≠ target check, which moves to the enrollment. Login is unchanged apart from the profile
shape.

### Enrollments (new: `routes/enrollments.ts`, `services/enrollments.ts`, `repo/enrollments.ts`)

```
POST /api/users/{id}/enrollments   { source_language: 'he', target_language }
  201  Enrollment { id, user_id, source_language, target_language, created_at }
  400  { error: 'invalid request' }    source ≠ 'he', source = target, unknown code
  404  { error: 'user not found' }
  409  { error: 'already enrolled' }   UNIQUE(user_id, target_language)

GET  /api/users/{id}/enrollments
  200  Enrollment[]                    ordered by created_at, newest first
  404  { error: 'user not found' }
```

The switcher reads this list. A 400 for an invalid request keeps
ADR 0003 R7's `{ error: 'invalid request' }` body. New factories `createEnrollmentRepo`,
`createEnrollmentService` and, on mobile, `createRememberedEnrollmentStore` (§5) join ADR 0002
R6's list.

### Sessions

`POST /api/sessions` takes `{ enrollment_id }` in place of `{ user_id }`.

- **404 `{ error: 'enrollment not found' }`**: no such enrollment.
- **409 `{ error: 'not enough questions' }`**: the pool holds fewer than `SESSION_LENGTH`. Today
  `pickQuestions` throws a plain `Error` and the request returns a 500. That already happens to
  English-native learners, whose `he`/`en` pool is empty.

### Translations

```
request    { text, from, to }       both required, LanguageCodeSchema
           refine: from ≠ to, and {from, to} ∈ { {he,en}, {he,ru} }
response   { text, from, to, kind, senses, correction?, reason? }
           reason: 'wrong_direction' | 'out_of_pair'
           present only when the script guard (§3) emptied senses
```

`TranslationDirectionSchema` and `detectDirection` are deleted.

- **The client always states the direction.** That includes en/he, so existing learners see a
  deliberate UX change: the screen shows the direction and they flip it.
- **An unsupported pair (`en ↔ ru`) is a 400.** The model is never called.
- **The published `description` is rewritten** to cover `from`/`to`, the guard and `reason`.

The fields are `from`/`to`, not `source`/`target`. The latter would collide with the enrollment's
`source_language`, which means something else: in a `he → ru` lookup, the enrollment's source is
the lookup's `from`.

**The endpoint stays anonymous.** It takes no user and no enrollment. The client sends the active
enrollment's pair, so switching enrollments changes what the client sends, not the endpoint.

---

## 3. The translation pipeline

### The language table (`apps/server/src/domain/languages.ts`)

This is pure data under ADR 0001 R3, and the single source for scripts and prompt rules.

| code | name | script | `writingRules` | `citationRules` |
|---|---|---|---|---|
| `he` | Hebrew | `֐-׿` | plain unvocalised script, no nikud | today's Hebrew citation-form rule |
| `en` | English | `A-Za-z` | — | today's English verb rules: past-tense forms, bare / "to"-marked verbs |
| `ru` | Russian | `Ѐ-ӿ` | no stress marks; `ё` written wherever it belongs, never replaced by `е` | nouns: nominative singular; adjectives: masculine nominative singular; verbs: the infinitive *of the aspect typed* (`прочитала` → `прочитать`, not `читать`) |

Adding a language means adding one entry. Everything below reads this table.

### Script guard

`guardScript(text, from, to)` is a pure domain function. It runs after normalisation and before
any read or model call.

| Letters in the input | Outcome |
|---|---|
| none (`100%`, `9/11`) | pass |
| at least one in `from`'s script (mixed input such as `ה-NBA` included) | pass |
| all in `to`'s script | 200, empty `senses`, `reason: 'wrong_direction'` |
| otherwise | 200, empty `senses`, `reason: 'out_of_pair'` |

No model call is made on a guard outcome, so nothing reaches the shared dictionary. Empty `senses`
keeps the endpoint's precedent: it is an answer, not a failure.

Phase 13's guard on a corrected form in the wrong script becomes "the corrected form must be in
`from`'s script", read from the same table. `resolveCorrection` takes `{ from, to }` in place of
`direction`.

The model remains the fallback for what the guard cannot see: an input in `from`'s script that is
not `from`'s language, such as Ukrainian `дякую` under `ru → he`. The prompt names the expected
language, and the existing empty-entries answer covers it.

### Prompts

`buildPrompt` and `buildRenderingPrompt` take `{ text, from, to }` and are assembled in this
order:

1. the shared rules, as today;
2. `citationRules` for `from`;
3. `writingRules` for both `from` and `to`, because example sentences contain both.

The opening line becomes *"You translate from {from.name} to {to.name} for a Hebrew-speaking
learner of {the pair's non-Hebrew language}."* This relies on the phase assumption that every pair
includes `he`.

For en/he the assembled prompt holds the same rules as today, in a fixed order. The ported eval
suite is what proves the reorder costs nothing.

### Normalisation

`normalizeForm` removes U+0301 (combining acute) when it follows a Cyrillic letter, so `молоко́`
and `молоко` are one key. Accents on Latin letters (`café`) and Hebrew points are untouched.

Every form the model returns (lemma, variant form, `corrected_form`) passes through the same
stripping before it becomes a key, so a stress mark in the model's output cannot create a second
copy of a word.

`ё` and `е` stay distinct. `ёлка` is the word, and `елка` is a misspelling: it reaches the model,
comes back as a phase 13 correction to `ёлка`, and the redirect serves every later `елка` without
a model call.

### Dictionary writes

The mechanism is unchanged: lexeme `language_code = from`, `user_language_code = to`. A `he → ru`
lookup writes Hebrew lexemes rendered in Russian, as `he_en` does with English today. Russian is
target-only for enrollments, not for the dictionary.

| Function | Change |
|---|---|
| `findStaleLexemesByForm` | takes `userLanguageCode`; joins `dict_variant_renderings` with a left join, so a missing row reads as stale |
| `staleLexemes` | unchanged signature; its rows now carry the per-language version |
| `persistEntries` | upserts `(variant_id, to)` into `dict_variant_renderings` |
| `repairVariantRenderings` | stamps `(variant_id, to)` only |
| `dict:restore` | writes one rendering row per variant and translation language present |

The dataset format is unchanged, and `data/backfill/en-he/` restores as before. Nothing Russian is
exported this phase.

### Logs

Every event that carries `direction` (`dict_repaired`, `translation_no_content`, the correction
events) carries `from` and `to` instead. A guard outcome logs `translation_guarded` with `from`,
`to` and `reason`, so the guard's hit rate is measurable.

---

## 4. Sessions and the Russian seed

### Starting a session

`startSession(enrollmentId)` stays one transaction (ADR 0001 R8):

1. Load the enrollment, or throw `EnrollmentNotFound` → 404.
2. Load the pool with `loadQuestionPool(target_language, source_language, userId, enrollmentId)`.
   The per-learner branch becomes `user_id = $user AND enrollment_id = $enrollment`.
3. If the pool holds fewer than `SESSION_LENGTH`, throw `InsufficientQuestions` → 409, before
   `newSessionRecord`.
4. Call `insertSession(userId, enrollmentId, questions)`.

The guarantee that a session's questions match its enrollment's pair comes from that query and
an integration test seeding two pairs. It is not enforced in the database.

### The seed is pair-aware

- **`content.ts`.** `ContentEntry` gains `from` and `to`. The 13 existing rows become
  `en → he`; 10 `ru → he` rows are added.
- **`content.generated.ts`.** Recordings are keyed by pair and query: `"en-he:window"`,
  `"ru-he:окно"`. Re-keying the 13 existing recordings is mechanical and changes no content.
- **`npm run content:generate -- <query>`.** Finds the entry by query and records it with that
  entry's `from`/`to`. If the same query exists under two pairs, it refuses until given
  `--pair <from>-<to>`.
- **`seed.ts`.** Drops `TARGET_LANGUAGE` / `USER_LANGUAGE`. Per entry, it calls `persistEntries`
  with `languageCode = from` and `userLanguageCode = to`, and writes question rows with
  `target_language = from` and `user_language_code = to`.

### The 10 Russian rows

Each row is a hand-written query, `question_id` and three Hebrew distractors. The correct answer
is spliced in from the recording's entry 0, sense 0, as for English.

`окно` · `книга` · `вода` · `друг` · `трудный` · `помнить` · `извините` · `доброе утро` ·
`спасибо большое` · `до свидания`

Ten is exactly `SESSION_LENGTH`: every Russian session draws all ten, in shuffled order.

**Review.** The recordings and the Hebrew distractors are reviewed by Victor before merge. A
distractor has to be plausible but wrong for a Hebrew speaker reading Russian, which needs
someone who reads both.

---

## 5. The mobile app

### API client (`api/client.ts`)

- gains `getJson` (every call is a POST today), `listEnrollments(userId)` and
  `createEnrollment(userId, body)`;
- `createSession` sends `{ enrollment_id }`;
- `translate` sends `{ text, from, to }`.

### Current user (`hooks/useCurrentUser.tsx`)

- It holds `enrollments: Enrollment[]` and `active: Enrollment | null` next to `user`.
- `adopt`, which login and register share, calls `listEnrollments` after setting the user, then
  picks the active enrollment (see below).
- `enroll({ target_language })` posts with `source_language: 'he'`, appends the result, and
  makes it active.
- `switchTo(enrollmentId)` sets the active enrollment and remembers it.
- The enrollment list itself is never persisted on the device. It is a server fact, read fresh
  at every login, which is the existing reasoning for the profile.

### Which enrollment is active

The active enrollment is the one piece of enrollment state that belongs to the device, exactly as
the remembered username does. `createRememberedEnrollmentStore({ storage })`, beside
`createRememberedUsernameStore` in `currentUser.ts`, stores one enrollment id per username. It
receives `storage` from `_layout.tsx` (ADR 0002).

On adopt, the active enrollment is chosen in this order:

1. the remembered id, if it is still in the list;
2. otherwise the newest enrollment;
3. otherwise `null`, which routes to the enroll screen.

A remembered id that is no longer in the list is simply ignored. It is a convenience, never a
source of truth, and the server never sees it.

### Routing

A signed-in user with `active === null`, meaning no enrollments, is sent to `app/enroll.tsx`
before any other screen. That one rule covers three cases:

- a new sign-up;
- a login that finds no enrollment;
- a sign-up whose second call never landed.

Zero enrollments is a valid state, not a corrupt one.

- **`onboarding.tsx`** keeps the native-language picker and loses the target picker.
- **`enroll.tsx`** offers every target the learner is not already enrolled in, from `en` and
  `ru`, and states that explanations are in Hebrew. `he` is not offered, because the source is
  `he`. When every target is taken, the screen is not reachable.

### The switcher (`app/index.tsx`)

- The home screen shows the active enrollment's target, e.g. **לומד/ת: רוסית**, as a control.
- Tapping it opens a list of the learner's enrollments, the active one marked, plus **הוספת שפה**
  while a target remains. That entry opens `enroll.tsx`.
- Choosing an enrollment calls `switchTo` and returns to the home screen.
- Switching is client-only: no request is made. The next session start and the next lookup carry
  the new enrollment.
- An in-progress session belongs to its enrollment, and switching does not touch it.

### Translate (`app/translate.tsx`, `hooks/useTranslation.tsx`)

- It opens on **target → source**: `from = active.target_language`,
  `to = active.source_language`.
- The direction label is always visible, e.g. `מרוסית לעברית`.
- The flip swaps `from`/`to` and keeps `bea1f79`'s text swap.
- `reason: 'wrong_direction'` shows the "no results" state plus a one-tap **החלף כיוון**, which
  flips and repeats the same text.
- `reason: 'out_of_pair'` shows **זו לא מילה ב{languageName(from)}**.

### Session, profile and strings

- Session start sends `active.id`. A 409 shows **אין עדיין שאלות בשפה הזו**.
- Profile lists every enrollment's target language.
- `languageName` gains `ru → 'רוסית'`. `translateDirection(from, to)` is composed from
  `languageName`, so a new pair adds no string.

---

## 6. Testing

### Unit bucket (`apps/server/src/**/*.test.ts`, `packages/core`, `apps/mobile`)

- **`guardScript`:** every row of the guard table: `100%`, `ה-NBA`, Hebrew under `ru → he`,
  Latin under `ru → he`, Cyrillic under `ru → he`.
- **`normalizeForm`:** `молоко́` → `молоко`. `café`, nikud and `ёлка` are unchanged.
- **Prompt builders:** each language's rules appear exactly when that language is written. No
  Russian rule appears in an en/he prompt. The learner line names the pair's non-Hebrew language.
- **`staleLexemes`:** per language.
- **Session start:** a pool below `SESSION_LENGTH` yields `InsufficientQuestions`.
- **`content.test.ts`** checks four things:
  - every entry has a recording under its pair;
  - every seeded pair has at least `SESSION_LENGTH` entries;
  - no distractor equals the correct answer;
  - queries and distractors are in their language's script, read from the language table.
- **Mobile:**
  - the enroll routing rule;
  - choosing the active enrollment: remembered id, then a stale remembered id falling back to
    the newest, then none;
  - `switchTo` persisting per username;
  - the enroll screen hiding taken targets;
  - the `reason` handling and the direction label.

### Integration bucket (`apps/server/tests/integration/`)

- **Migration:** a database populated before the migration runs, holding users of both native
  languages, sessions, and a variant rendered in two languages. After it there is one enrollment
  per user, `sessions.enrollment_id` is filled, and there is one rendering row per variant and
  language.
- **Constraints:**
  - the composite FK rejects a session whose user does not own the enrollment;
  - a learner can hold an `en` and a `ru` enrollment, but not two `ru` ones;
  - the both-or-neither check on `questions` holds;
  - unknown language codes are rejected.
- **The freshness defect, reproduced and fixed:** a Hebrew variant rendered into `en` and `ru`
  learns a sense. A repair in `en` must leave the `ru` rendering stale, and the next `ru` lookup
  repairs it.
- **Routes:**
  - enrollments: 201 for a first and a second target, 400 (source `en`), 404, 409 (same target
    twice), and `GET` returning both, newest first;
  - sessions: 404, 409, and pair isolation. One learner holding `en` and `ru` enrollments starts
    a session on each and gets only that pair's questions, each session attributed to its own
    enrollment;
  - translations: 400 for `en ↔ ru`, and both `reason`s with zero MockServer calls recorded.
- **`openapi.test.ts`:** the rewritten translation `description` and the enrollment routes.

### Evals (`apps/server/tests/eval/`)

The cases and `run.ts` move from `direction` to `from`/`to`, and the case asserting that script
detection agreed is deleted. New cases, counted toward tier 2 like every other:

| case | pair | expectation |
|---|---|---|
| `прочитала` | ru → he | lemma `прочитать`, not `читать` |
| `книги` | ru → he | lemma `книга` |
| `как дела?` | ru → he | not rendered word for word |
| `елка` | ru → he | `correction.corrected_form` = `ёлка` |
| `дякую` | ru → he | empty senses: the same-script case the guard cannot catch |
| `חלון` | he → ru | `окно` |

A Russian case that scores poorly is a prompt problem to fix, never a reason to lower
`TIER2_THRESHOLD`. `content:generate` lives in this bucket (ADR 0004) and moves to `from`/`to`
in the same change.

### e2e

- The sign-up flow gains the enroll step.
- A new flow: enroll in `ru`, take the seeded session, look up `окно`, flip.
- A switching flow:
  1. A learner enrolled in `ru` adds `en` from the switcher.
  2. They take an English session, switch back to Russian, and take a Russian session.
  3. A lookup opens on `ru → he`.
  4. After signing out and back in, Russian is still active.
- Gemini replies for it are registered under `E2E_MOCK_NAMESPACE` through the existing MockServer
  helper.

### Architecture

`npm run lint:arch` passes:

- new files sit in their layers (ADR 0001);
- factories receive their collaborators (ADR 0002);
- routes use `createRoute` (ADR 0003);
- `insert(users)` stays in `repo/users.ts` (ADR 0005);
- nothing hardcodes a port or database (ADR 0006).

No ADR or check script is added this phase.

---

## Build order

The phase ships as one unit, landed in this order so that each step is testable:

1. `enrollments`, both rekeys, migration steps 1–3 and 5, the enrollments API, and sessions on
   `enrollment_id` with the 409.
2. `dict_variant_renderings` (migration step 4) and its readers and writers.
3. The language table, `from`/`to` on the wire, the guard and `reason`, pair-aware prompts, Russian
   normalisation, and the evals ported.
4. The mobile changes: client, enrollment state and the remembered active id, routing, the enroll
   screen, the switcher, the translate screen.
5. `ru` in the schemas, the pair-aware seed with the 10 Russian rows, Russian eval cases, and the
   Russian e2e flow.

## Risks

- **The en/he prompt is reassembled.** It holds the same rules, but they come from the language
  table, so their order and wording may shift. The eval suite is the measure. A tier 2 drop here
  means the assembly is wrong, not the threshold.
- **Russian citation rules are new prompt text.** Aspect is the likeliest miss: the model may
  "helpfully" return the imperfective. The `прочитала` case is aimed at it.
- **Every request must carry the active enrollment.** With several enrollments, a screen that
  reads "the first enrollment" instead of `active` is a silent bug: it works for every learner
  with one. The mobile tests and the switching e2e flow use a learner with two enrollments for
  exactly this reason.
- **Ten Russian questions is the floor.** A removed or broken recording takes the Russian pool
  below `SESSION_LENGTH`, and every Russian session then returns 409. `content.test.ts` turns that
  into a failing unit test rather than a production symptom.
