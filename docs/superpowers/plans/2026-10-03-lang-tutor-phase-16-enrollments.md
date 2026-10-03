# Phase 16 — Learner Enrollments and Russian — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A learner holds several enrollments (a target language, explained in Hebrew), switches between them in the app, and can learn Russian — sessions, lookups and the dictionary all keyed by the enrollment's language pair.

**Architecture:** A new `enrollments` table owns the language pair; `sessions` and `questions` reference it through a composite `(user_id, enrollment_id)` foreign key. Translation drops direction detection: the client sends `from`/`to`, a pure script guard rejects mismatched input before any model call, and prompts are assembled from a per-language rule table. Dictionary freshness moves into `dict_variant_renderings`, keyed by explanation language. The mobile app holds the enrollment list plus a device-remembered active enrollment.

**Tech Stack:** Node + tsx, Hono + `@hono/zod-openapi`, Zod 4, Drizzle ORM 0.45 + drizzle-kit, Postgres 17, Jest 29, Expo 57 / React Native, Playwright, MockServer, Gemini.

**Spec:** `docs/superpowers/specs/2026-10-03-lang-tutor-phase-16-enrollments-design.md`. Read it before Task 1; this plan argues from it and cites its sections as "spec §N".

## Global Constraints

- **Branch and lane.** All work happens in a worktree on branch `phase-16-enrollments`. Never commit to `master`. Run `./scripts/setup-worktree.sh` in the worktree before anything else (CLAUDE.md).
- **Never hardcode a port or a database name** (ADR 0006). Use `npm run …` scripts, which run through `scripts/lane-env.sh`.
- **Read `docs/adr/` before touching `apps/server` or `apps/mobile`.** Every ADR is binding. `npm run lint:arch` must print nothing at the end of every task.
- **No `UNIQUE(user_id)` on `enrollments`.** Uniqueness is `UNIQUE(user_id, target_language)`. There is no `active_enrollment` column anywhere.
- **New enrollments have `source_language = 'he'`** (published as `EnrollmentSourceSchema = z.enum(['he'])`). The database still allows `'en'` so existing English-native users migrate.
- **Supported translation pairs are `{he,en}` and `{he,ru}`**, either direction. `en ↔ ru` is a 400.
- **Response language fields are plain `z.string()`**; request language fields are enums (existing `UserSchema` precedent).
- **`ё` is never folded to `е`.** U+0301 (combining acute) is stripped only when it follows a Cyrillic letter. Hebrew points and Latin accents are untouched. No `String.prototype.normalize` anywhere in key handling.
- **Prompt text must not contain the unquoted substrings `see`, `saw` or `saws`** — they are registered unquoted MockServer `matchText` values and would make every lookup match them (see the long comment in `buildPrompt`). Check every new rule string with `grep -E 'see|saw'` before committing.
- **Never lower `TIER2_THRESHOLD`.** A Russian eval case that fails is a prompt problem.
- **`content:generate` and `npm run eval` need a real `GEMINI_API_KEY` and `GEMINI_MODEL`.** If they are not available in the environment, stop at that step and ask Victor; do not hand-write a recording.
- **Commit after every task**, using the `git-commit` skill. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Expected intermediate red:** from Task 3 until Task 12, `npm run typecheck --workspace apps/mobile` and `--workspace e2e` fail because the wire contract moves first. Each task verifies its own workspace's tests and typecheck; the whole repo is green again at Task 12 and verified in Task 13.

### Two deliberate deviations from the spec

1. **Two migrations, not one.** `0008_variant_renderings` lands with Task 2 and `0009_enrollments` with Task 3, so each task is independently testable. The order of operations inside each matches spec §1.
2. **The stale read joins `dict_variant_renderings` with an INNER join, not a LEFT join.** A variant with no rendering row for a language also has no translations in that language, so it is never served in it and has nothing to repair from. Treating it as stale would send a repair call that is guaranteed to come back empty, then throw and log `dict_repair_failed`, on every lookup of that form. Every variant that has translations gets a rendering row: from the migration backfill, from `persistEntries`, and from `repairVariantRenderings`.

## Review Focus

The inputs the spec implies but no feature test would naturally exercise, most likely first. Each has a test in the task named.

1. **One device, two learners.** The remembered active enrollment is keyed per username, so learner B on learner A's phone never inherits A's Russian. → Task 9, `currentUser.test.ts`.
2. **A remembered enrollment id that no longer exists** (another device, a reseeded database): the app falls back to the newest enrollment instead of showing nothing. → Task 9, `enrollments.test.ts`.
3. **Case and marks through the guard and the key:** `ОКНО`, `Молоко́`, `Ёлка`, Hebrew with nikud `סֵפֶר` under `he → ru`. All pass the guard; only the stress mark is stripped. → Task 1.
4. **Double-tapping "enroll"**: the second request gets 409. The app treats it as success and adopts the existing enrollment. → Task 10, through `enroll` in `useCurrentUser`, plus an integration assertion in Task 4.
5. **A legacy English-native learner** (`en` source, `he` target, no seeded questions) starting a session gets a 409 `not enough questions`, not a 500. → Task 3, route test.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/server/src/domain/languages.ts` | The language table (name, letter script, prompt rules) and the pure script functions `guardScript`, `isInScript`, `stripStress`. |
| `apps/server/src/domain/languages.test.ts` | Unit tests for the above. |
| `apps/server/src/db/migrations/0008_variant_renderings.sql` | Renderings table, backfill, drop of the per-variant counter. |
| `apps/server/src/db/migrations/0009_enrollments.sql` | Enrollments table, backfill, session/question rekeys, drop of `users.target_language`. |
| `apps/server/src/repo/enrollments.ts` | Enrollment persistence primitives. |
| `apps/server/src/repo/pgErrors.ts` | `isUniqueViolation`, moved out of `repo/users.ts` so two repositories share it. |
| `apps/server/src/services/enrollments.ts` | `enroll` and `list` use cases. |
| `apps/server/src/routes/enrollments.ts` | `POST/GET /api/users/{id}/enrollments`. |
| `apps/server/tests/support/migrations.ts` | `migrationsUpTo(tag)`: a temp copy of the migrations folder truncated at a tag. |
| `apps/server/tests/integration/db/migrations.test.ts` | Data-carrying tests of 0008 and 0009. |
| `apps/server/tests/integration/repo/enrollments.test.ts` | Enrollment repo and constraint tests. |
| `apps/server/tests/integration/repo/dictionary.renderings.test.ts` | The per-language freshness defect, reproduced and fixed. |
| `apps/server/tests/integration/routes/enrollments.test.ts` | Enrollment route tests. |
| `apps/mobile/src/enrollments.ts` | Pure enrollment helpers: `chooseActive`, `availableTargets`, `lookupDirection`, `asLanguageCode`. |
| `apps/mobile/src/enrollments.test.ts` | Unit tests for the above. |
| `apps/mobile/src/app/enroll.tsx` | The enroll screen. |
| `e2e/tests/enrollments.spec.ts` | The Russian and switching flows. |

**Modified** (main ones; each task lists its full set)

| Path | Change |
|---|---|
| `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts` | Language, enrollment, session and translation contracts. |
| `apps/server/src/db/schema.ts` | `enrollments`, `dict_variant_renderings`; rekeys; `users` loses `target_language`. |
| `apps/server/src/db/migrate.ts` | Exports `MIGRATIONS_FOLDER` and `runMigrationsFrom`. |
| `apps/server/src/db/reseed.ts`, `seed.ts`, `content.ts`, `content.generated.ts` | Pair-aware seed; 10 Russian rows. |
| `apps/server/src/domain/dictionary.ts` | Stress stripping in `normalizeForm` and `mergeEntries`; `languagesFor` deleted. |
| `apps/server/src/domain/translation.ts` | Prompts assembled from the language table; `detectDirection` deleted; `resolveCorrection` takes `from`/`to`. |
| `apps/server/src/repo/dictionary.ts`, `users.ts`, `sessions.ts`, `questions.ts` | Renderings; enrollment-keyed sessions and pool. |
| `apps/server/src/services/*.ts`, `routes/*.ts`, `errors.ts`, `composition.ts`, `app.ts` | Enrollment use cases, the guard, the 409s, `from`/`to` throughout. |
| `apps/server/tests/support/seedUser.ts`, `fakes.ts` | Every seeded user gets an enrollment; fakes learn the enrollment repo. |
| `apps/server/tests/eval/*.ts` | `from`/`to`; pair-aware recorder; Russian cases. |
| `apps/mobile/src/api/client.ts`, `currentUser.ts`, `strings.ts`, `hooks/*.tsx`, `app/*.tsx` | Enrollment state, switcher, explicit direction. |
| `e2e/tests/support/users.ts`, `onboarding.spec.ts`, `translate.spec.ts` | Learners are enrolled; direction label regex covers Russian. |
| `docs/adr/adr-0002-di-with-closures.md` | R6's factory list. |

---

## Before Task 1: the worktree

- [ ] **Create the lane** (from the main checkout):

```bash
git worktree add ../lang-tutor-phase-16 -b phase-16-enrollments master
cd ../lang-tutor-phase-16
./scripts/setup-worktree.sh
npm run lane:list
```

Expected: `lane:list` shows the new lane with its own databases. If `db:up` is needed, run it from the main checkout (CLAUDE.md).

- [ ] **Baseline:** `npm run test:all && npm run lint:arch`. Expected: green. If not, stop and report; do not build on a red baseline.

---

### Task 1: The language table, the script guard and stress stripping

Pure domain code, no wire change. Everything later reads this table.

**Files:**
- Create: `apps/server/src/domain/languages.ts`
- Create: `apps/server/src/domain/languages.test.ts`
- Modify: `apps/server/src/domain/dictionary.ts` (`normalizeForm`, `mergeEntries`)
- Modify: `apps/server/src/domain/dictionary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`domain/languages.ts`):
  - `type LanguageCode = 'he' | 'en' | 'ru'`
  - `type Language = { code: LanguageCode; name: string; letters: RegExp; asSource: (targetName: string) => string[]; asTarget: string[]; writing: string[] }`
  - `const LANGUAGES: Record<LanguageCode, Language>`
  - `type ScriptVerdict = 'pass' | 'wrong_direction' | 'out_of_pair'`
  - `guardScript(text: string, from: LanguageCode, to: LanguageCode): ScriptVerdict`
  - `isInScript(text: string, code: LanguageCode): boolean`: true when every letter is in that language's script, or there are no letters.
  - `stripStress(text: string): string`
- Produces (`domain/dictionary.ts`): `normalizeForm` strips stress; `mergeEntries` strips stress from each `lemma`.

- [ ] **Step 1: Write the failing tests** — `apps/server/src/domain/languages.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { LANGUAGES, guardScript, isInScript, stripStress } from './languages';

describe('guardScript', () => {
  it('passes input with no letters at all', () => {
    expect(guardScript('100%', 'ru', 'he')).toBe('pass');
    expect(guardScript('9/11', 'en', 'he')).toBe('pass');
  });

  it("passes input whose letters are in from's script", () => {
    expect(guardScript('окно', 'ru', 'he')).toBe('pass');
    expect(guardScript('ОКНО', 'ru', 'he')).toBe('pass');
    expect(guardScript('window', 'en', 'he')).toBe('pass');
    expect(guardScript('חלון', 'he', 'ru')).toBe('pass');
  });

  it('passes mixed input as long as one letter is in from’s script', () => {
    expect(guardScript('ה-NBA', 'he', 'en')).toBe('pass');
  });

  it('passes Hebrew with nikud: points are marks, not letters', () => {
    expect(guardScript('סֵפֶר', 'he', 'ru')).toBe('pass');
  });

  it("calls input wholly in to's script a wrong direction", () => {
    expect(guardScript('חלון', 'ru', 'he')).toBe('wrong_direction');
    expect(guardScript('окно', 'he', 'ru')).toBe('wrong_direction');
    expect(guardScript('window', 'he', 'en')).toBe('wrong_direction');
  });

  it('calls any other script out of pair', () => {
    expect(guardScript('window', 'ru', 'he')).toBe('out_of_pair');
    expect(guardScript('окно', 'en', 'he')).toBe('out_of_pair');
    expect(guardScript('窓', 'ru', 'he')).toBe('out_of_pair');
  });
});

describe('isInScript', () => {
  it('is true when every letter belongs to the script', () => {
    expect(isInScript('ёлка', 'ru')).toBe(true);
    expect(isInScript('קיפוד', 'he')).toBe(true);
    expect(isInScript('café', 'en')).toBe(true);
  });

  it('is false when any letter does not', () => {
    expect(isInScript('окно window', 'ru')).toBe(false);
    expect(isInScript('ספר book', 'he')).toBe(false);
  });

  it('is true for input with no letters', () => {
    expect(isInScript('100%', 'he')).toBe(true);
  });
});

describe('stripStress', () => {
  it('removes a combining acute after a Cyrillic letter', () => {
    expect(stripStress('молоко́')).toBe('молоко');
    expect(stripStress('Молоко́')).toBe('Молоко');
    expect(stripStress('доро́га до́ма')).toBe('дорога дома');
  });

  it('keeps ё, which is a letter and not a stress mark', () => {
    expect(stripStress('ёлка')).toBe('ёлка');
    expect(stripStress('Ёлка')).toBe('Ёлка');
  });

  it('leaves a Latin accent and Hebrew points alone', () => {
    // "cafe" + U+0301, decomposed on purpose: only Cyrillic stress is stripped.
    expect(stripStress('café')).toBe('café');
    expect(stripStress('סֵפֶר')).toBe('סֵפֶר');
  });
});

describe('LANGUAGES', () => {
  it('names every language the wire knows', () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual(['en', 'he', 'ru']);
  });

  // The MockServer constraint in Global Constraints, as a test: an unquoted
  // matchText matches the whole request body, and these rules are in it.
  it('carries no rule text containing a registered unquoted matchText', () => {
    const text = Object.values(LANGUAGES)
      .flatMap((language) => [...language.asSource('X'), ...language.asTarget, ...language.writing])
      .join(' ');
    expect(text).not.toMatch(/see|saw/);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test --workspace apps/server -- src/domain/languages.test.ts`
Expected: FAIL, `Cannot find module './languages'`.

- [ ] **Step 3: Write `apps/server/src/domain/languages.ts`**

```ts
/**
 * Every language the server knows, in one table: what script its letters are
 * in, and what the model must be told about it. The script guard, the prompt
 * builders, the corrected-form guard and the seed's content tests all read
 * this table, so adding a language is one entry here.
 *
 * Pure data under ADR 0001 R3. `LanguageCode` is declared here rather than
 * imported from packages/core so this module has no dependency at all; the
 * wire's `LanguageCodeSchema` names the same three codes, and
 * services/translations.ts is where the two meet and the compiler checks them.
 *
 * Every rule string here goes into the prompt's system instruction, which is
 * part of the request body MockServer matches against. None may contain the
 * unquoted substrings `see` or `saw` — see the comment in `buildPrompt`, and
 * the test that enforces it.
 */
export type LanguageCode = 'he' | 'en' | 'ru';

export type Language = {
  code: LanguageCode;
  /** The English name, as the prompt says it. */
  name: string;
  /** Matches ONE letter of this language's script. Marks (nikud, stress) are
   *  not letters, so they never decide anything. */
  letters: RegExp;
  /** How to read input typed in this language: which headword a form belongs
   *  to. Takes the target language's name because a rule may say what it
   *  translates into. */
  asSource: (targetName: string) => string[];
  /** How to write a translation into this language. */
  asTarget: string[];
  /** How to write this language at all. It applies whenever the call writes
   *  it, which is both directions, because every example has both halves. */
  writing: string[];
};

export const LANGUAGES: Record<LanguageCode, Language> = {
  he: {
    code: 'he',
    name: 'Hebrew',
    letters: /\p{Script=Hebrew}/u,
    asSource: () => [],
    asTarget: [
      'For Hebrew past tense that citation form is third-person masculine singular.',
      'A Hebrew infinitive keeps its ל: להזמין, never הזמין.',
    ],
    // "citation form" reads to the model as "how a dictionary prints it", and
    // a printed Hebrew dictionary prints nikud. That cost a recording of סֵפֶר
    // where every consumer expects ספר.
    writing: ['Write Hebrew in plain unvocalised script, with no nikud: ספר, never סֵפֶר.'],
  },
  en: {
    code: 'en',
    name: 'English',
    letters: /\p{Script=Latin}/u,
    asSource: (targetName) => [
      `A bare or "to"-marked English verb — "book", "to book" — is the base form and takes the ${targetName} infinitive.`,
    ],
    asTarget: [],
    writing: [],
  },
  ru: {
    code: 'ru',
    name: 'Russian',
    letters: /\p{Script=Cyrillic}/u,
    // Aspect is the likeliest miss: a model "helpfully" returns the
    // imperfective. The eval case `прочитала` is aimed at exactly this.
    asSource: () => [
      'A Russian noun belongs to its nominative singular, an adjective to its masculine',
      'nominative singular, and a verb to the infinitive of the aspect typed: "прочитала"',
      'belongs to "прочитать", never to "читать".',
    ],
    asTarget: ['For Russian past tense that citation form is masculine singular.'],
    writing: [
      'Write Russian without stress marks: молоко, never молоко́.',
      'Write ё wherever the word has it: ёлка, never елка.',
    ],
  },
};

export type ScriptVerdict = 'pass' | 'wrong_direction' | 'out_of_pair';

const ANY_LETTER = /\p{L}/gu;

function lettersOf(text: string): string[] {
  return text.match(ANY_LETTER) ?? [];
}

/**
 * Whether a lookup's input belongs to its `from` side, decided before any read
 * or model call (spec §3). One letter of `from`'s script is enough to pass, so
 * mixed input such as `ה-NBA` reaches the model; input with no letters at all
 * (`100%`) passes too, because there is nothing to judge.
 */
export function guardScript(text: string, from: LanguageCode, to: LanguageCode): ScriptVerdict {
  const letters = lettersOf(text);
  if (letters.length === 0) return 'pass';
  if (letters.some((letter) => LANGUAGES[from].letters.test(letter))) return 'pass';
  if (letters.every((letter) => LANGUAGES[to].letters.test(letter))) return 'wrong_direction';
  return 'out_of_pair';
}

/** Every letter is in `code`'s script. Vacuously true with no letters. */
export function isInScript(text: string, code: LanguageCode): boolean {
  return lettersOf(text).every((letter) => LANGUAGES[code].letters.test(letter));
}

/**
 * Removes U+0301 (combining acute) after a Cyrillic letter: `молоко́` and
 * `молоко` are one dictionary key. Stress is a reading aid, not spelling, and
 * native text never writes it. Deliberately narrow: a Latin accent (`café`,
 * decomposed) and Hebrew points are spelling and survive, and `ё` is a letter,
 * not a stress mark — `елка` is a misspelling of `ёлка`, handled by phase 13's
 * correction path rather than folded here.
 */
export function stripStress(text: string): string {
  return text.replace(/(\p{Script=Cyrillic})́/gu, '$1');
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test --workspace apps/server -- src/domain/languages.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `normalizeForm`/`mergeEntries` tests.** Append to `apps/server/src/domain/dictionary.test.ts` (add `mergeEntries` and `normalizeForm` to its existing import from `./dictionary` if they are not already imported):

```ts
describe('normalizeForm and Russian stress', () => {
  it('strips a stress mark so both spellings are one key', () => {
    expect(normalizeForm('молоко́')).toBe('молоко');
    expect(normalizeForm('доро́га до́ма')).toBe('дорога дома');
  });

  it('keeps ё', () => {
    expect(normalizeForm('ёлка')).toBe('ёлка');
  });

  it('still strips trailing punctuation after stripping stress', () => {
    expect(normalizeForm('молоко́?')).toBe('молоко');
  });
});

describe('mergeEntries and Russian stress', () => {
  it('strips stress from a lemma, so a stray mark cannot make a second lexeme', () => {
    const merged = mergeEntries([
      { lemma: 'молоко́', part_of_speech: 'noun', senses: [{ sense_code: 'milk', translation: 'חלב' }] },
      { lemma: 'молоко', part_of_speech: 'noun', senses: [{ sense_code: 'milk_2', translation: 'חלב' }] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].lemma).toBe('молоко');
    expect(merged[0].senses).toHaveLength(2);
  });
});
```

- [ ] **Step 6: Run them to make sure they fail**

Run: `npm test --workspace apps/server -- src/domain/dictionary.test.ts`
Expected: FAIL on the four new tests (`молоко́` is returned unchanged; `mergeEntries` returns two entries).

- [ ] **Step 7: Implement.** In `apps/server/src/domain/dictionary.ts`, add `import { stripStress } from './languages';` to the imports. In `normalizeForm`, change the first line:

```ts
  const collapsed = stripStress(text.trim().replace(/\s+/g, ' '));
```

and add this comment immediately above it:

```ts
  // Phase 16. Stress first, before the single-token check, because a multi-word
  // expression returns early below and must lose its stress marks too.
```

In `mergeEntries`, replace the loop body's first two lines with:

```ts
  for (const raw of entries) {
    // Phase 16. The lemma becomes half of dict_lexemes' unique key, so a stress
    // mark the model added despite the prompt would be a second lexeme forever.
    const entry = { ...raw, lemma: stripStress(raw.lemma) };
    const key = `${entry.lemma} ${entry.part_of_speech}`;
```

(the rest of the loop is unchanged; it already reads `entry`).

- [ ] **Step 8: Run the whole unit bucket**

Run: `npm test --workspace apps/server && npm run typecheck --workspace apps/server && npm run lint:arch`
Expected: PASS, no type errors, `lint:arch` prints nothing.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/domain/languages.ts apps/server/src/domain/languages.test.ts apps/server/src/domain/dictionary.ts apps/server/src/domain/dictionary.test.ts
git commit -m "feat: add the language table, script guard and Russian stress stripping"
```

---

### Task 2: Dictionary freshness keyed by explanation language

`rendered_sense_version` moves from `dict_variants` into `dict_variant_renderings (variant_id, user_language_code)`. Spec §1 and §3, "Dictionary writes".

**Files:**
- Modify: `apps/server/src/db/schema.ts` (add `dictVariantRenderings`, drop `dictVariants.renderedSenseVersion`)
- Create: `apps/server/src/db/migrations/0008_variant_renderings.sql` (+ drizzle's `meta/0008_snapshot.json`, `meta/_journal.json`)
- Modify: `apps/server/src/db/migrate.ts`
- Modify: `apps/server/src/repo/dictionary.ts` (`findStaleLexemesByForm`, `persistEntries` step 5b, `repairVariantRenderings`)
- Modify: `apps/server/src/services/translations.ts` (one call site)
- Modify: `apps/server/src/db/reseed.ts`
- Modify: `apps/server/tests/support/fakes.ts` (`findStaleLexemesByForm` input type only)
- Create: `apps/server/tests/support/migrations.ts`
- Create: `apps/server/tests/integration/db/migrations.test.ts`
- Create: `apps/server/tests/integration/repo/dictionary.renderings.test.ts`
- Modify: `apps/server/tests/integration/db/reseed.test.ts`, `apps/server/tests/integration/db/schema.test.ts` (table list)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `dictVariantRenderings` table export in `db/schema.ts`.
  - `findStaleLexemesByForm(input: { form: string; languageCode: string; userLanguageCode: string }): Promise<StaleLexeme[]>`
  - `MIGRATIONS_FOLDER: string` and `runMigrationsFrom(db: Db, folder: string): Promise<void>` from `db/migrate.ts`; `runMigrations(db)` is unchanged for callers.
  - `migrationsUpTo(tag: string): string` from `tests/support/migrations.ts`.

- [ ] **Step 1: Write the failing freshness test.** Create `apps/server/tests/integration/repo/dictionary.renderings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/**
 * The defect spec §1 names: one counter per variant, while a rendering is per
 * (variant, user_language_code). A Hebrew variant rendered into both English
 * and Russian learns a sense; a repair in English must NOT mark the Russian
 * rendering current.
 *
 * `גזר` (carrot / he cut), not a seeded word, so first-writer-wins writes it.
 */

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const persist = (form: string, userLanguageCode: string, entries: unknown) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({
      form,
      languageCode: 'he',
      userLanguageCode,
      kind: 'word',
      entries: entries as never,
    }),
  );

const stale = (form: string, userLanguageCode: string) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).findStaleLexemesByForm({ form, languageCode: 'he', userLanguageCode }),
  );

const ONE_SENSE = (translation: string) => [
  { lemma: 'גזר', part_of_speech: 'noun', senses: [{ sense_code: 'root_vegetable', translation }] },
];

// A second form of the same lexeme that teaches it a second sense.
const PLURAL_TEACHES_A_SENSE = [
  {
    lemma: 'גזר',
    part_of_speech: 'noun',
    senses: [
      { sense_code: 'root_vegetable', translation: 'carrots' },
      { sense_code: 'reward_incentive', translation: 'incentives' },
    ],
  },
];

describe('per-language rendering freshness', () => {
  it('is level in every language a form was written in', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזר', 'ru', ONE_SENSE('морковь'));
    expect(await stale('גזר', 'en')).toEqual([]);
    expect(await stale('גזר', 'ru')).toEqual([]);
  });

  it('goes stale in every language when the lexeme learns a sense', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזר', 'ru', ONE_SENSE('морковь'));
    await persist('גזרים', 'en', PLURAL_TEACHES_A_SENSE);

    expect(await stale('גזר', 'en')).toHaveLength(1);
    expect(await stale('גזר', 'ru')).toHaveLength(1);
  });

  it('a repair in one language leaves the other language stale', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזר', 'ru', ONE_SENSE('морковь'));
    await persist('גזרים', 'en', PLURAL_TEACHES_A_SENSE);

    const [lexeme] = await stale('גזר', 'en');
    await withTx(t.db, async (tx) => {
      const repo = createDictRepo(tx);
      const senseVersion = await repo.findSenseVersion({ lexemeId: lexeme.lexemeId });
      const stored = await repo.findSensesByLexeme({
        lemma: 'גזר',
        partOfSpeech: 'noun',
        languageCode: 'he',
        userLanguageCode: 'en',
      });
      await repo.repairVariantRenderings({
        variantId: lexeme.variantId,
        userLanguageCode: 'en',
        senseVersion,
        senses: stored.map((sense, rank) => ({
          senseId: sense.senseId,
          rank,
          translation: sense.translation,
          exampleSource: null,
          exampleTarget: null,
        })),
      });
    });

    expect(await stale('גזר', 'en')).toEqual([]);
    // The bug this table exists to fix: under one counter per variant, this was [].
    expect(await stale('גזר', 'ru')).toHaveLength(1);
  });

  it('never calls a variant stale in a language it has no rendering in', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזרים', 'en', PLURAL_TEACHES_A_SENSE);
    // No Russian rendering exists, so nothing is served in Russian and there is
    // nothing to repair from: a repair call here could only come back empty.
    expect(await stale('גזר', 'ru')).toEqual([]);
  });
});
```

Before relying on the third test, open `apps/server/src/repo/dictionary.ts` and confirm what `findSensesByLexeme` returns: its field names (`senseId`, `translation`) and its argument names. If they differ, adjust the `stored.map(...)` above to match. The shape `repairVariantRenderings` takes is `RepairedRendering` in the same file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:integration --workspace apps/server -- tests/integration/repo/dictionary.renderings.test.ts`
Expected: FAIL. TypeScript rejects `userLanguageCode` on `findStaleLexemesByForm`, or, if run untyped, the third test sees `[]` for `ru`.

- [ ] **Step 3: Schema.** In `apps/server/src/db/schema.ts`:
  - delete the `renderedSenseVersion` column, and its long comment, from `dictVariants`;
  - add this table directly after `dictVarTranslations`:

```ts
/**
 * Phase 16. The lexeme's sense_version a form's translations were last written
 * against, PER EXPLANATION LANGUAGE. It replaces dict_variants'
 * rendered_sense_version, which was one counter for every language: a repair
 * rendering `en` stamped the variant level and left its `ru` rows behind with
 * nothing to record it (the caveat that column's comment carried since phase 12).
 *
 * A row exists exactly when the variant has translations in that language:
 * persistEntries and repairVariantRenderings upsert it, and migration 0008
 * backfilled it. The stale read therefore INNER-joins it — a language with no
 * row is one the form is never served in, so there is nothing to repair.
 *
 * NOT a count of translations, for the reason the old column gave: a form may
 * legitimately render fewer senses than its lexeme holds.
 */
export const dictVariantRenderings = pgTable(
  'dict_variant_renderings',
  {
    variantId: text('variant_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    renderedSenseVersion: integer('rendered_sense_version').notNull(),
  },
  (t) => [
    primaryKey({ name: 'dict_variant_renderings_pkey', columns: [t.variantId, t.userLanguageCode] }),
    foreignKey({
      name: 'dict_variant_renderings_variant_fk',
      columns: [t.variantId],
      foreignColumns: [dictVariants.id],
    }).onDelete('cascade'),
  ],
);
```

- [ ] **Step 4: Generate the migration, then hand-edit it**

Run: `npm run db:generate --workspace apps/server -- --name variant_renderings`
Expected: `src/db/migrations/0008_variant_renderings.sql` plus snapshot and journal changes.

Open the SQL file and make it exactly this. Keep drizzle's own DDL lines if their spelling differs cosmetically; the change you make is inserting the backfill `INSERT` between the table creation and the column drop.

```sql
-- Phase 16. One rendering counter per (variant, explanation language) instead
-- of one per variant. Backfilled before the old column is dropped: every
-- variant gets one row per language it has translations in, carrying the
-- version the single counter held — exact today, because before phase 16 every
-- variant was rendered in exactly one language.
CREATE TABLE "dict_variant_renderings" (
	"variant_id" text NOT NULL,
	"user_language_code" varchar(10) NOT NULL,
	"rendered_sense_version" integer NOT NULL,
	CONSTRAINT "dict_variant_renderings_pkey" PRIMARY KEY("variant_id","user_language_code")
);
--> statement-breakpoint
ALTER TABLE "dict_variant_renderings" ADD CONSTRAINT "dict_variant_renderings_variant_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."dict_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "dict_variant_renderings" ("variant_id", "user_language_code", "rendered_sense_version")
SELECT DISTINCT tr."variant_id", tr."user_language_code", v."rendered_sense_version"
FROM "dict_var_translations" tr
JOIN "dict_variants" v ON v."id" = tr."variant_id";--> statement-breakpoint
ALTER TABLE "dict_variants" DROP COLUMN "rendered_sense_version";
```

Then run: `npm run db:check --workspace apps/server`
Expected: no errors.

- [ ] **Step 5: Repository.** In `apps/server/src/repo/dictionary.ts`, add `dictVariantRenderings` to the `../db/schema` import. Replace `findStaleLexemesByForm` (doc comment included) with:

```ts
  /**
   * One row per lexeme this form belongs to that has been rendered in
   * `userLanguageCode`, carrying both versions. INNER join, not LEFT: a variant
   * with no rendering in this language is never served in it, so it has nothing
   * to repair from, and calling it stale would buy a model call that can only
   * come back empty (plan deviation 2).
   */
  const findStaleLexemesByForm = async (input: {
    form: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<StaleLexeme[]> =>
    staleLexemes(
      await tx
        .select({
          lexemeId: dictVariants.lexemeId,
          variantId: dictVariants.id,
          lemma: dictLexemes.lemma,
          partOfSpeech: dictLexemes.partOfSpeech,
          senseVersion: dictLexemes.senseVersion,
          renderedSenseVersion: dictVariantRenderings.renderedSenseVersion,
        })
        .from(dictVariants)
        .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
        .innerJoin(
          dictVariantRenderings,
          and(
            eq(dictVariantRenderings.variantId, dictVariants.id),
            eq(dictVariantRenderings.userLanguageCode, input.userLanguageCode),
          ),
        )
        .where(
          and(
            eq(dictVariants.languageCode, input.languageCode),
            sql`lower(${dictVariants.form}) = ${input.form.toLowerCase()}`,
          ),
        ),
    );
```

In `persistEntries`, replace step 5b's `update(dictVariants)` statement with:

```ts
      await tx
        .insert(dictVariantRenderings)
        .values({
          variantId: variant.id,
          userLanguageCode: input.userLanguageCode,
          renderedSenseVersion: versioned.senseVersion,
        })
        .onConflictDoUpdate({
          target: [dictVariantRenderings.variantId, dictVariantRenderings.userLanguageCode],
          set: { renderedSenseVersion: versioned.senseVersion },
        });
```

Keep step 5b's comment, and change its first line to: `// 5b — this form is now rendered against that version, in this language.`

In `repairVariantRenderings`, replace the final `update(dictVariants)` statement with:

```ts
    await tx
      .insert(dictVariantRenderings)
      .values({
        variantId: input.variantId,
        userLanguageCode: input.userLanguageCode,
        renderedSenseVersion: input.senseVersion,
      })
      .onConflictDoUpdate({
        target: [dictVariantRenderings.variantId, dictVariantRenderings.userLanguageCode],
        set: { renderedSenseVersion: input.senseVersion },
      });
```

Its doc comment already says "for one target language"; leave it.

- [ ] **Step 6: The one service call site.** In `apps/server/src/services/translations.ts` `serveForm`, change

```ts
    stale: await repos.dict.findStaleLexemesByForm({ form, languageCode: source }),
```

to

```ts
    stale: await repos.dict.findStaleLexemesByForm({
      form,
      languageCode: source,
      userLanguageCode: target,
    }),
```

In `apps/server/tests/support/fakes.ts`, if the fake's `findStaleLexemesByForm` declares its input type inline, add `userLanguageCode: string` to it. If it takes `{ form }` by destructuring, no change is needed.

- [ ] **Step 7: Reseed.** In `apps/server/src/db/reseed.ts`, change the statement to

```ts
  await db.execute(sql`TRUNCATE dict_lexemes, dict_variant_renderings, dict_corrections, sessions CASCADE`);
```

and add to its doc comment: `` `dict_variant_renderings` would be reached by the cascade through dict_variants; it is named anyway so the list states every dictionary table a reseed empties. ``

- [ ] **Step 8: Migration test support.** In `apps/server/src/db/migrate.ts`, export the folder and split the function:

```ts
export const MIGRATIONS_FOLDER = path.join(__dirname, 'migrations');

/** `folder` is a parameter so a migration test can stop at a chosen migration,
 *  insert rows shaped by the schema of that moment, then migrate the rest. */
export async function runMigrationsFrom(db: Db, folder: string): Promise<void> {
  await db.execute(OPTIONS_VALIDATION_FUNCTION);
  await db.execute(CORRECTION_ALTERNATIVES_FUNCTION);
  await migrate(db, { migrationsFolder: folder });
}

export async function runMigrations(db: Db): Promise<void> {
  await runMigrationsFrom(db, MIGRATIONS_FOLDER);
}
```

(delete the old `const MIGRATIONS_FOLDER` and the old body of `runMigrations`).

Create `apps/server/tests/support/migrations.ts`:

```ts
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MIGRATIONS_FOLDER } from '../../src/db/migrate';

/**
 * A copy of the migrations folder whose journal ends at `tag`. Drizzle's
 * migrator applies what the journal lists and nothing else, and applies only
 * migrations newer than the last one recorded — so migrating a database with
 * this folder, inserting rows, then migrating with the real folder runs exactly
 * the migrations after `tag` against those rows.
 */
export function migrationsUpTo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lang-tutor-migrations-'));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });

  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`no migration tagged ${tag}`);
  journal.entries = journal.entries.slice(0, index + 1);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return dir;
}
```

- [ ] **Step 9: The migration test.** Create `apps/server/tests/integration/db/migrations.test.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import { runMigrations, runMigrationsFrom } from '../../../src/db/migrate';
import { ADMIN_URL, testDbName, urlFor } from '../../support/dbNames';
import { migrationsUpTo } from '../../support/migrations';

/**
 * Each test builds an EMPTY database (no template — the template is already
 * fully migrated), migrates it to just before the migration under test,
 * inserts rows the old schema allowed, then runs the rest. The name comes from
 * testDbName, so globalSetup's sweep reclaims it.
 */
const opened: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});

async function emptyDatabase() {
  const name = testDbName(expect.getState().currentTestName ?? 'migration', randomUUID().slice(0, 8));
  const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    await admin.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await admin.close();
  }
  const handle = createDb(urlFor(name), { onError: () => {} });
  opened.push(handle);
  return handle.db;
}

describe('0008_variant_renderings', () => {
  it('gives every rendered variant one row per language it has translations in', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0007_dict_corrections'));

    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech, sense_version)
        values ('lx-en', 'en', 'window', 'noun', 2), ('lx-he', 'he', 'חלון', 'noun', 1);
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank, rendered_sense_version)
        values ('v-en', 'lx-en', 'en', 'window', 'word', 0, 2),
               ('v-he', 'lx-he', 'he', 'חלון', 'word', 0, 1);
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s-en-1', 'lx-en', 'opening'), ('s-en-2', 'lx-en', 'period'),
               ('s-he-1', 'lx-he', 'opening');
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v-en', 's-en-1', 'he', 'חלון', 0), ('v-en', 's-en-2', 'he', 'חלון זמן', 1),
               ('v-he', 's-he-1', 'en', 'window', 0);
    `);

    await runMigrations(db);

    const rows = await db.execute<{ variant_id: string; user_language_code: string; rendered_sense_version: number }>(
      sql`select variant_id, user_language_code, rendered_sense_version
            from dict_variant_renderings order by variant_id`,
    );
    expect(rows.rows).toEqual([
      { variant_id: 'v-en', user_language_code: 'he', rendered_sense_version: 2 },
      { variant_id: 'v-he', user_language_code: 'en', rendered_sense_version: 1 },
    ]);

    const column = await db.execute(sql`
      select 1 from information_schema.columns
       where table_name = 'dict_variants' and column_name = 'rendered_sense_version'`);
    expect(column.rows).toHaveLength(0);
  });
});
```

Before running it, check the column lists in the inserts against `src/db/migrations/0005_lexemes_and_form_translations.sql` and `0006_sense_versions.sql`: column names, which ones are `NOT NULL`, and whether `dict_var_translations` needs `example_*`. Adjust the inserts to satisfy the schema as of 0007. That schema is the contract here, not today's `schema.ts`.

- [ ] **Step 10: The schema test's table list.** In `apps/server/tests/integration/db/schema.test.ts`, add `'dict_variant_renderings'` to `TABLES` after `'dict_var_translations'`.

- [ ] **Step 11: Reseed test.** In `apps/server/tests/integration/db/reseed.test.ts`, find the test asserting what a reseed leaves behind, and add an assertion in the same style: after a reseed, `select count(*) from dict_variant_renderings` equals `select count(distinct (variant_id, user_language_code)) from dict_var_translations`. Every seeded rendering has its counter row.

- [ ] **Step 12: Run everything that touches the dictionary**

Run: `npm run test:integration --workspace apps/server -- tests/integration/repo tests/integration/db tests/integration/services`
Expected: PASS, including all four renderings tests and the migration test.

Run: `npm test --workspace apps/server && npm run typecheck --workspace apps/server && npm run lint:arch`
Expected: PASS / clean.

- [ ] **Step 13: Commit**

```bash
git add apps/server
git commit -m "feat: key dictionary freshness by explanation language"
```

---

### Task 3: Enrollments in the data model; sessions belong to them

This adds the `enrollments` table and repository, rekeys `sessions` and `questions` onto it, removes `users.target_language`, and makes `POST /api/sessions` take `enrollment_id`, with the 404 and 409 from spec §2 and §4.

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts`, `schemas.test.ts`
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0009_enrollments.sql` (+ drizzle meta)
- Create: `apps/server/src/repo/enrollments.ts`, `apps/server/src/repo/pgErrors.ts`
- Modify: `apps/server/src/repo/users.ts`, `sessions.ts`, `questions.ts`
- Modify: `apps/server/src/errors.ts`
- Modify: `apps/server/src/services/transaction.ts`, `services/users.ts`, `services/sessions.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/src/routes/sessions.ts`, `routes/users.ts`
- Modify: `apps/server/src/openapi.test.ts`, `services/users.test.ts`
- Modify: `apps/server/tests/support/seedUser.ts`, `fakes.ts`
- Create: `apps/server/tests/integration/repo/enrollments.test.ts`
- Modify: `apps/server/tests/integration/db/migrations.test.ts`, `db/schema.test.ts`
- Modify (mechanical): `tests/integration/routes/sessions.test.ts`, `routes/users.test.ts`, `repo/sessions.test.ts`, `repo/questions.test.ts`, `repo/users.test.ts`, `services/sessions.test.ts`, `services/users.test.ts`, `session-flow.test.ts`, `app.test.ts`, `composition.test.ts`, `db/seed.test.ts`

**Interfaces:**
- Consumes: Task 2's `runMigrationsFrom`, `migrationsUpTo`.
- Produces (core, `@lang-tutor/core/api`):
  - `LanguageCodeSchema = z.enum(['he','en','ru'])`, `type LanguageCode`
  - `NativeLanguageSchema = z.enum(['he','en'])`, `EnrollmentSourceSchema = z.enum(['he'])`
  - `EnrollmentSchema` and `type Enrollment = { id: string; user_id: string; source_language: string; target_language: string; created_at: string }`
  - `EnrollmentListSchema = z.array(EnrollmentSchema)`
  - `CreateEnrollmentRequestSchema` and `type CreateEnrollmentRequest = { source_language: 'he'; target_language: LanguageCode }`
  - `CreateSessionRequestSchema = { enrollment_id: string }`
  - `UserSchema` / `CreateUserRequestSchema` without `target_language`
- Produces (server):
  - `createEnrollmentRepo(tx)` → `{ insertEnrollment(input: { userId: string; sourceLanguage: string; targetLanguage: string }): Promise<Enrollment>; listByUser(userId: string): Promise<Enrollment[]>; findById(id: string): Promise<Enrollment | undefined> }`, type `EnrollmentRepo`
  - `Repos.enrollment: EnrollmentRepo`
  - errors `EnrollmentNotFound(enrollmentId)`, `AlreadyEnrolled(userId, targetLanguage)`, `InsufficientQuestions(enrollmentId, available)`; `InvalidLanguagePair` deleted
  - `SessionService.startSession(enrollmentId: string)`
  - `SessionRepo.insertSession(userId: string, enrollmentId: string, picked: Question[]): Promise<string>`
  - `QuestionRepo.loadQuestionPool(targetLanguage: string, userLanguageCode: string, owner: { userId: string; enrollmentId: string }): Promise<Question[]>`
- Produces (test support): `seedUser(db, id)` now also seeds an `en` enrollment whose id is `enrollmentOf(id)`; `enrollmentOf(userId: string): string` returns `` `e_${userId}` ``; `seedEnrollment(db, { id, userId, targetLanguage }): Promise<void>`.

- [ ] **Step 1: Core contract.** In `packages/core/src/api/schemas.ts`:

Replace `LanguageCodeSchema` with:

```ts
// Every language the server knows. Request fields narrow to it; response fields
// stay plain strings (see UserSchema below).
export const LanguageCodeSchema = z.enum(['he', 'en', 'ru']);

// What a learner may name as their native language at sign-up. Russian is a
// target only in phase 16.
export const NativeLanguageSchema = z.enum(['he', 'en']);

// Phase 16's restriction, published rather than hidden: the app's UI is Hebrew
// only, so every new enrollment is explained in Hebrew. Widening this enum is
// non-breaking for every client that shipped before it.
export const EnrollmentSourceSchema = z.enum(['he']);
```

In `UserSchema`, delete `target_language`. In `CreateUserRequestSchema`, delete `target_language` and change `native_language` to `NativeLanguageSchema`.

Replace `CreateSessionRequestSchema` with:

```ts
export const CreateSessionRequestSchema = z.object({
  enrollment_id: z.string().min(1),
});
```

Add after `CreateUserRequestSchema`:

```ts
// A course of study: one target language, explained in one source language.
// Language fields are plain strings for the reason UserSchema's are.
export const EnrollmentSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  source_language: z.string(),
  target_language: z.string(),
  created_at: z.string(),
});

export const EnrollmentListSchema = z.array(EnrollmentSchema);

export const CreateEnrollmentRequestSchema = z
  .object({
    source_language: EnrollmentSourceSchema,
    target_language: LanguageCodeSchema,
  })
  .refine((request) => request.source_language !== request.target_language, {
    message: 'source and target language must differ',
  });
```

In `types.ts`, add `CreateEnrollmentRequestSchema`, `EnrollmentSchema` and `LanguageCodeSchema` to the import, and export:

```ts
export type Enrollment = z.infer<typeof EnrollmentSchema>;
export type CreateEnrollmentRequest = z.infer<typeof CreateEnrollmentRequestSchema>;
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;
```

In `index.ts`, add `CreateEnrollmentRequest`, `Enrollment` and `LanguageCode` to the `export type { … }` list.

In `packages/core/src/api/schemas.test.ts`:
- the `CreateSessionRequestSchema` block now tests `enrollment_id` (accepts a non-empty one, rejects missing and empty), replacing `user_id`;
- the `CreateUserRequestSchema` fixture loses `target_language`, and the test `'does not itself reject a matching language pair'` is deleted;
- the `UserSchema` fixture loses `target_language`.

Add:

```ts
describe('CreateEnrollmentRequestSchema', () => {
  it('accepts a Hebrew-explained enrollment in English or Russian', () => {
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'ru' }).success).toBe(true);
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'en' }).success).toBe(true);
  });

  it('rejects an English source in phase 16', () => {
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'en', target_language: 'ru' }).success).toBe(false);
  });

  it('rejects the same language twice and an unknown code', () => {
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'he' }).success).toBe(false);
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'fr' }).success).toBe(false);
  });
});
```

(add `CreateEnrollmentRequestSchema` to the file's import).

Run: `npm test --workspace packages/core`
Expected: PASS.

- [ ] **Step 2: Write the failing repository test.** Create `apps/server/tests/integration/repo/enrollments.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { AlreadyEnrolled } from '../../../src/errors';
import { createEnrollmentRepo } from '../../../src/repo/enrollments';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  // seedUser enrolls u_1 in English; these tests add Russian on top.
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createEnrollmentRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createEnrollmentRepo(tx)));

describe('enrollments repository', () => {
  it('inserts an enrollment and returns it in wire shape', async () => {
    const created = await repo((r) =>
      r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'ru' }),
    );
    expect(created).toEqual({
      id: expect.any(String),
      user_id: 'u_1',
      source_language: 'he',
      target_language: 'ru',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('holds an English and a Russian enrollment for one learner, newest first', async () => {
    const ru = await repo((r) =>
      r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'ru' }),
    );
    const list = await repo((r) => r.listByUser('u_1'));
    expect(list.map((e) => e.target_language)).toEqual(['ru', 'en']);
    expect(list[0].id).toBe(ru.id);
  });

  it('refuses a second enrollment in the same target', async () => {
    await expect(
      repo((r) => r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'en' })),
    ).rejects.toBeInstanceOf(AlreadyEnrolled);
  });

  it('finds by id, and answers undefined for an unknown id', async () => {
    const [first] = await repo((r) => r.listByUser('u_2'));
    expect(await repo((r) => r.findById(first.id))).toEqual(first);
    expect(await repo((r) => r.findById('e_nobody'))).toBeUndefined();
  });

  it('rejects an unknown language and a same-language pair at the database', async () => {
    await expect(
      t.db.execute(sql`insert into enrollments (user_id, source_language, target_language) values ('u_2', 'he', 'fr')`),
    ).rejects.toThrow();
    await expect(
      t.db.execute(sql`insert into enrollments (user_id, source_language, target_language) values ('u_2', 'he', 'he')`),
    ).rejects.toThrow();
  });

  it('rejects a session whose user does not own the enrollment', async () => {
    const [ofU2] = await repo((r) => r.listByUser('u_2'));
    await expect(
      t.db.execute(sql`insert into sessions (user_id, enrollment_id) values ('u_1', ${ofU2.id})`),
    ).rejects.toThrow();
  });

  it('rejects a per-learner question carrying only half its owner', async () => {
    await expect(
      t.db.execute(sql`
        insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id,
                               target_language, user_language_code, type, options)
        select 'q-half', 'u_1', null, sense_id, prompt_variant_id, target_language,
               user_language_code, type, options
          from questions limit 1`),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm run test:integration --workspace apps/server -- tests/integration/repo/enrollments.test.ts`
Expected: FAIL, `Cannot find module '../../../src/repo/enrollments'`.

- [ ] **Step 4: Schema.** In `apps/server/src/db/schema.ts`:

In `users`, delete `targetLanguage`, delete the `users_languages_differ` check, and change the comment above `nativeLanguage` to:

```ts
    // No default: onboarding always supplies it, so a default could only mask a
    // bug. Profile information from phase 16 on — the pair a learner studies
    // lives on their enrollments, and nothing on the learning path reads this.
```

Add directly after `users`:

```ts
/**
 * Phase 16. A course of study: one target language, explained in one source
 * language. A learner holds several, at most one per target.
 *
 * No UNIQUE(user_id) — the app switches between enrollments — and no "active"
 * column anywhere: which one is active is a fact about one device's screen,
 * held client-side, so every request names its enrollment or its pair.
 *
 * `UNIQUE(user_id, id)` exists only to be the target of the composite foreign
 * keys below, the same pattern answers uses against session_questions: it
 * proves the referencing row's user owns the enrollment.
 *
 * The source CHECK allows `en` because English-native learners existed before
 * this phase and migrate unchanged; new enrollments are Hebrew-explained, a
 * restriction the API publishes (EnrollmentSourceSchema), not the schema.
 */
export const enrollments = pgTable(
  'enrollments',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text('user_id').notNull(),
    sourceLanguage: varchar('source_language', { length: 10 }).notNull(),
    targetLanguage: varchar('target_language', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'enrollments_user_fk', columns: [t.userId], foreignColumns: [users.id] }),
    unique('enrollments_user_target_key').on(t.userId, t.targetLanguage),
    unique('enrollments_user_id_id_key').on(t.userId, t.id),
    check('enrollments_languages_differ', sql`${t.sourceLanguage} <> ${t.targetLanguage}`),
    check('enrollments_source_known', sql`${t.sourceLanguage} in ('he', 'en')`),
    check('enrollments_target_known', sql`${t.targetLanguage} in ('he', 'en', 'ru')`),
  ],
);
```

In `questions`, add `enrollmentId: text('enrollment_id'),` after `userId`. Update the comment above `userId` to: `// Nullable: NULL means shared. A per-learner row carries both halves of its owner — user and enrollment — or neither; nothing writes one yet.` Change its extras to:

```ts
  (t) => [
    check('questions_options_valid', sql`question_options_valid(${t.options})`),
    foreignKey({
      name: 'questions_enrollment_fk',
      columns: [t.userId, t.enrollmentId],
      foreignColumns: [enrollments.userId, enrollments.id],
    }),
    check('questions_owner_complete', sql`(${t.userId} is null) = (${t.enrollmentId} is null)`),
  ],
```

Change `sessions` to:

```ts
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // Phase 16. The course this session belongs to. With user_id it references
    // enrollments (user_id, id), so a session can only be recorded against an
    // enrollment its own learner holds.
    enrollmentId: text('enrollment_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NULL = in progress. There is no separate `complete` column.
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'sessions_enrollment_fk',
      columns: [t.userId, t.enrollmentId],
      foreignColumns: [enrollments.userId, enrollments.id],
    }),
  ],
);
```

- [ ] **Step 5: Generate and hand-edit the migration**

Run: `npm run db:generate --workspace apps/server -- --name enrollments`

Make `src/db/migrations/0009_enrollments.sql` follow this order. Keep drizzle's DDL spelling. The edits are: add the backfills, add `sessions.enrollment_id` as nullable and only then set it `NOT NULL`, and drop the users check before the column.

```sql
-- Phase 16. Learners hold enrollments; sessions and per-learner questions
-- belong to one. Deterministic, because users.target_language was never
-- editable (routes/users.ts is create + login only): every user becomes exactly
-- one enrollment carrying the pair they had, and every session joins it.
CREATE TABLE "enrollments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"source_language" varchar(10) NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_user_target_key" UNIQUE("user_id","target_language"),
	CONSTRAINT "enrollments_user_id_id_key" UNIQUE("user_id","id"),
	CONSTRAINT "enrollments_languages_differ" CHECK ("enrollments"."source_language" <> "enrollments"."target_language"),
	CONSTRAINT "enrollments_source_known" CHECK ("enrollments"."source_language" in ('he', 'en')),
	CONSTRAINT "enrollments_target_known" CHECK ("enrollments"."target_language" in ('he', 'en', 'ru'))
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "enrollments" ("user_id", "source_language", "target_language")
SELECT "id", "native_language", "target_language" FROM "users";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "enrollment_id" text;--> statement-breakpoint
UPDATE "sessions" SET "enrollment_id" = e."id"
  FROM "enrollments" e WHERE e."user_id" = "sessions"."user_id";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "enrollment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_enrollment_fk" FOREIGN KEY ("user_id","enrollment_id") REFERENCES "public"."enrollments"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "enrollment_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_enrollment_fk" FOREIGN KEY ("user_id","enrollment_id") REFERENCES "public"."enrollments"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_complete" CHECK (("questions"."user_id" is null) = ("questions"."enrollment_id" is null));--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_languages_differ";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "target_language";
```

Run: `npm run db:check --workspace apps/server`
Expected: clean.

- [ ] **Step 6: Errors.** In `apps/server/src/errors.ts`, delete `InvalidLanguagePair` and add:

```ts
export class EnrollmentNotFound extends Error {
  constructor(readonly enrollmentId: string) {
    super(`no enrollment ${enrollmentId}`);
    this.name = 'EnrollmentNotFound';
  }
}

export class AlreadyEnrolled extends Error {
  constructor(
    readonly userId: string,
    readonly targetLanguage: string,
  ) {
    super(`user ${userId} is already enrolled in ${targetLanguage}`);
    this.name = 'AlreadyEnrolled';
  }
}

/** A session draws SESSION_LENGTH questions; a pool smaller than that cannot
 *  start one. Before phase 16 this surfaced as a plain Error from pickQuestions
 *  and a 500. */
export class InsufficientQuestions extends Error {
  constructor(
    readonly enrollmentId: string,
    readonly available: number,
  ) {
    super(`enrollment ${enrollmentId} has ${available} questions, too few for a session`);
    this.name = 'InsufficientQuestions';
  }
}
```

- [ ] **Step 7: Repositories.** Create `apps/server/src/repo/pgErrors.ts`, moving `isUniqueViolation` and its doc comment verbatim out of `repo/users.ts` and exporting it:

```ts
/**
 * Drizzle 0.45 wraps a driver error in a DrizzleQueryError whose `cause` is the
 * pg error carrying `code`; other paths throw the pg error directly. Walking the
 * chain is correct under both, and stays correct if another wrapper is added.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error; current != null; ) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
```

In `repo/users.ts`: import it from `./pgErrors` and delete the local copy. Delete `target_language: row.targetLanguage,` from `toUser` and `targetLanguage: input.target_language,` from `insertUser`.

Create `apps/server/src/repo/enrollments.ts`:

```ts
import type { Enrollment } from '@lang-tutor/core/api';
import { desc, eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { enrollments } from '../db/schema';
import { AlreadyEnrolled } from '../errors';
import { isUniqueViolation } from './pgErrors';

type EnrollmentRow = typeof enrollments.$inferSelect;

function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    user_id: row.userId,
    source_language: row.sourceLanguage,
    target_language: row.targetLanguage,
    created_at: row.createdAt.toISOString(),
  };
}

export function createEnrollmentRepo(tx: Tx) {
  return {
    /**
     * Inserts optimistically and lets UNIQUE(user_id, target_language) decide,
     * for the reason insertUser does: a check-then-insert races a double tap.
     */
    insertEnrollment: async (input: {
      userId: string;
      sourceLanguage: string;
      targetLanguage: string;
    }): Promise<Enrollment> => {
      try {
        const [row] = await tx
          .insert(enrollments)
          .values({
            userId: input.userId,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
          })
          .returning();
        return toEnrollment(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new AlreadyEnrolled(input.userId, input.targetLanguage);
        throw error;
      }
    },

    /** Newest first: the app falls back to the newest when it remembers none. */
    listByUser: async (userId: string): Promise<Enrollment[]> =>
      (
        await tx
          .select()
          .from(enrollments)
          .where(eq(enrollments.userId, userId))
          .orderBy(desc(enrollments.createdAt), desc(enrollments.id))
      ).map(toEnrollment),

    findById: async (id: string): Promise<Enrollment | undefined> => {
      const [row] = await tx.select().from(enrollments).where(eq(enrollments.id, id));
      return row ? toEnrollment(row) : undefined;
    },
  };
}

export type EnrollmentRepo = ReturnType<typeof createEnrollmentRepo>;
```

In `repo/sessions.ts`, change `insertSession`'s signature and insert:

```ts
    insertSession: async (
      userId: string,
      enrollmentId: string,
      picked: Question[],
    ): Promise<string> => {
```

```ts
      const [session] = await tx
        .insert(sessions)
        .values({ userId, enrollmentId })
        .returning({ id: sessions.id });
```

In `repo/questions.ts`, change `loadQuestionPool`:

```ts
    /**
     * The pool a session draws from: shared questions plus any belonging to
     * this learner's enrollment. Phase 4 only ever seeds shared ones; the
     * per-learner branch is keyed by the enrollment from phase 16, so a later
     * phase adds rows, not a migration.
     */
    loadQuestionPool: async (
      targetLanguage: string,
      userLanguageCode: string,
      owner: { userId: string; enrollmentId: string },
    ): Promise<Question[]> => {
```

and its predicate:

```ts
            or(
              isNull(questions.userId),
              and(eq(questions.userId, owner.userId), eq(questions.enrollmentId, owner.enrollmentId)),
            ),
```

- [ ] **Step 8: Wiring.** In `apps/server/src/services/transaction.ts`, add `import type { EnrollmentRepo } from '../repo/enrollments';` and `enrollment: EnrollmentRepo;` to `Repos`. In `composition.ts`, import `createEnrollmentRepo` and add `enrollment: createEnrollmentRepo(tx),` to the bound repos. In `tests/support/fakes.ts` `createFakeTransaction`, add `enrollment: repos.enrollment ?? unreachableRepo('enrollment repo'),`, and delete `target_language` from `createInMemoryUserRepo`'s user literal.

- [ ] **Step 9: Services.** In `services/users.ts`, delete the `native_language === target_language` check and the `InvalidLanguagePair` import. In `services/sessions.ts`, change the imports (drop `UserNotFound`, add `EnrollmentNotFound`, `InsufficientQuestions`, and `SESSION_LENGTH` from `../domain/session`) and replace `startSession`:

```ts
    startSession: (enrollmentId: string): Promise<{ sessionId: string; record: SessionRecord }> =>
      transaction(async ({ session, question, enrollment }) => {
        const enrolled = await enrollment.findById(enrollmentId);
        // No implicit creation, as before for users. The route turns this into a 404.
        if (!enrolled) throw new EnrollmentNotFound(enrollmentId);

        const pool = await question.loadQuestionPool(
          enrolled.target_language,
          enrolled.source_language,
          { userId: enrolled.user_id, enrollmentId },
        );
        // Checked here rather than left to pickQuestions, whose plain Error was a
        // 500: a language with no seeded questions is an answer, not a failure.
        if (pool.length < SESSION_LENGTH) throw new InsufficientQuestions(enrollmentId, pool.length);

        const record = newSessionRecord(enrolled.user_id, pool, rng);
        const sessionId = await session.insertSession(enrolled.user_id, enrollmentId, record.questions);
        return { sessionId, record };
      }),
```

In `services/users.test.ts` (unit), delete every test about a same-language pair and drop `target_language` from fixtures.

- [ ] **Step 10: Routes.** In `routes/users.ts`, delete the `InvalidLanguagePair` import and branch, and change the 400 description of `POST /users` to `'The request body did not validate.'`. In `routes/sessions.ts`:
  - import `EnrollmentNotFound` and `InsufficientQuestions`, and drop `UserNotFound`;
  - set `description` to `'Draws ten questions from the enrollment\'s language pair and returns the first one.'`;
  - change the 404 description to `'No enrollment has this \`enrollment_id\`.'`;
  - add the 409 response below;
  - replace the handler body.

```ts
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description:
        'The enrollment\'s language pair has fewer than ten questions, so no session can start.',
    },
```

```ts
  router.openapi(createSessionRoute, async (c) => {
    const { enrollment_id } = c.req.valid('json');
    try {
      const { sessionId, record } = await sessions.startSession(enrollment_id);
      return c.json(
        {
          session_id: sessionId,
          question: currentQuestion(record)!,
          position: positionOf(record),
        },
        200,
      );
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof InsufficientQuestions) {
        return c.json({ error: 'not enough questions' }, 409);
      }
      throw error;
    }
  });
```

In `src/openapi.test.ts`, the `'declares its 200, 400 and 404'` test for `/api/sessions` becomes `'declares its 200, 400, 404 and 409'` and expects `['200', '400', '404', '409']`.

- [ ] **Step 11: Test support.** Replace the body of `apps/server/tests/support/seedUser.ts` (keep its doc comment, adding the sentence about enrollments):

```ts
import type { Db } from '../../src/db/client';
import { enrollments, users } from '../../src/db/schema';

/** The id seedUser gives its learner's English enrollment. */
export function enrollmentOf(userId: string): string {
  return `e_${userId}`;
}

/**
 * Inserts a fully-formed user under an id the caller chooses — and, from phase
 * 16, that user's English enrollment under `enrollmentOf(id)`, because a
 * learner with no enrollment can start nothing and every test about sessions
 * would otherwise say so first.
 */
export async function seedUser(db: Db, id: string): Promise<void> {
  await db
    .insert(users)
    .values({ id, username: id, displayName: `test ${id}`, age: 30, nativeLanguage: 'he' })
    .onConflictDoNothing();
  await seedEnrollment(db, { id: enrollmentOf(id), userId: id, targetLanguage: 'en' });
}

/** A Hebrew-explained enrollment under an id the caller chooses. */
export async function seedEnrollment(
  db: Db,
  input: { id: string; userId: string; targetLanguage: string },
): Promise<void> {
  await db
    .insert(enrollments)
    .values({
      id: input.id,
      userId: input.userId,
      sourceLanguage: 'he',
      targetLanguage: input.targetLanguage,
    })
    .onConflictDoNothing();
}

/**
 * A learner as phase 8 onboarded them before phase 16: English-native, learning
 * Hebrew, so their enrollment is English-explained — a pair the seed holds no
 * questions for. Route tests may not reach the database themselves (ADR 0001),
 * which is why this lives here.
 */
export async function seedLegacyLearner(db: Db): Promise<{ enrollmentId: string }> {
  await db
    .insert(users)
    .values({ id: 'u_legacy', username: 'u_legacy', displayName: 'legacy', age: 40, nativeLanguage: 'en' })
    .onConflictDoNothing();
  await db
    .insert(enrollments)
    .values({ id: 'e_legacy', userId: 'u_legacy', sourceLanguage: 'en', targetLanguage: 'he' })
    .onConflictDoNothing();
  return { enrollmentId: 'e_legacy' };
}
```

- [ ] **Step 12: Mechanical test updates.** Apply exactly these rules, then grep to confirm nothing is left:
  - Every request body posted to `/api/sessions` (`postJson(app, '/api/sessions', { user_id: X })`, `postJson('/api/sessions', { user_id: X })`, and the raw `'{"user_id":"u1"}'` body in `app.test.ts` that targets `/api/sessions`) becomes `{ enrollment_id: enrollmentOf(X) }` or `'{"enrollment_id":"e_u1"}'`. **Next-step bodies keep their `user_id`.** `NextStepRequestSchema` is unchanged.
  - Every `startSession('<id>')` call becomes `startSession(enrollmentOf('<id>'))`.
  - In `repo/sessions.test.ts`'s helper: `loadQuestionPool('en', 'he', userId)` becomes `loadQuestionPool('en', 'he', { userId, enrollmentId: enrollmentOf(userId) })`, and `insertSession(userId, record.questions)` becomes `insertSession(userId, enrollmentOf(userId), record.questions)`.
  - In `repo/questions.test.ts`: every `loadQuestionPool(a, b, 'u_1')` becomes `loadQuestionPool(a, b, { userId: 'u_1', enrollmentId: enrollmentOf('u_1') })`.
  - Delete `target_language`/`targetLanguage` from user fixtures in `routes/users.test.ts`, `repo/users.test.ts`, `services/users.test.ts`, `db/schema.test.ts` and `db/seed.test.ts`, and delete any test asserting a same-language-pair 400.
  - The service test `startSession('u_nobody')` expecting `UserNotFound` now calls `startSession('e_nobody')` and expects `EnrollmentNotFound`. The route test `'returns 404 for a user id that was never onboarded'` becomes `'returns 404 for an enrollment that does not exist'`: it posts `{ enrollment_id: 'e_nobody' }` and expects `{ error: 'enrollment not found' }`. The test `'rejects a missing user_id'` becomes `'rejects a missing enrollment_id'`.
  - In `db/schema.test.ts`, add `'enrollments'` to `TABLES` after `'users'`.
  - Import `enrollmentOf` from `../../support/seedUser`, or `../support/seedUser`, wherever it is now used.

Run: `grep -rn "target_language\|targetLanguage" apps/server/src apps/server/tests --include='*.ts' | grep -v migrations`. Expected: only `questions.targetLanguage`, the `enrollments` columns, `seedEnrollment`, `loadQuestionPool`'s parameter, and the new enrollment code.

- [ ] **Step 13: Route tests for the new statuses** — append to `tests/integration/routes/sessions.test.ts` inside `describe('POST /api/sessions', …)` (add `enrollmentOf`, `seedEnrollment` and `seedLegacyLearner` to the seedUser import):

```ts
  it('returns 409 when the pair has too few questions — a legacy English-native learner', async () => {
    // native en, learning Hebrew: the seed holds no he/en questions. A 500 here
    // is what this phase replaced.
    const { enrollmentId } = await seedLegacyLearner(t.db);
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { enrollment_id: enrollmentId });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not enough questions' });
  });

  it('draws each enrollment\'s own pair for one learner holding two', async () => {
    await seedEnrollment(t.db, { id: 'e_u_1_ru', userId: 'u_1', targetLanguage: 'ru' });
    const app = buildTestApp();
    // Until Task 7 seeds Russian, the ru pool is empty: the 409 is the proof the
    // pool is keyed by the enrollment's pair and not by the learner.
    expect((await postJson(app, '/api/sessions', { enrollment_id: 'e_u_1_ru' })).status).toBe(409);
    expect((await postJson(app, '/api/sessions', { enrollment_id: enrollmentOf('u_1') })).status).toBe(200);
  });
```

Task 7 strengthens the second test to assert that every Russian session question is Cyrillic.

- [ ] **Step 14: Migration test for 0009** — append to `tests/integration/db/migrations.test.ts`:

```ts
describe('0009_enrollments', () => {
  it('gives every user one enrollment with the pair they had, and every session its enrollment', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0008_variant_renderings'));

    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language, target_language)
        values ('u_he', 'u_he', 'he native', 30, 'he', 'en'),
               ('u_en', 'u_en', 'en native', 40, 'en', 'he');
      insert into sessions (id, user_id) values
        ('00000000-0000-0000-0000-000000000001', 'u_he'),
        ('00000000-0000-0000-0000-000000000002', 'u_en');
    `);

    await runMigrations(db);

    const enrolled = await db.execute<{ user_id: string; source_language: string; target_language: string }>(
      sql`select user_id, source_language, target_language from enrollments order by user_id`,
    );
    expect(enrolled.rows).toEqual([
      { user_id: 'u_en', source_language: 'en', target_language: 'he' },
      { user_id: 'u_he', source_language: 'he', target_language: 'en' },
    ]);

    const orphans = await db.execute(sql`
      select s.id from sessions s
        left join enrollments e on e.id = s.enrollment_id and e.user_id = s.user_id
       where e.id is null`);
    expect(orphans.rows).toHaveLength(0);

    const column = await db.execute(sql`
      select 1 from information_schema.columns
       where table_name = 'users' and column_name = 'target_language'`);
    expect(column.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 15: Run the server suites**

Run: `npm test --workspace apps/server && npm run test:integration --workspace apps/server && npm run typecheck --workspace apps/server && npm test --workspace packages/core && npm run lint:arch`
Expected: all PASS, `lint:arch` clean. (`apps/mobile` and `e2e` typecheck are expected to fail from here until Task 12; see Global Constraints.)

- [ ] **Step 16: Commit**

```bash
git add packages/core apps/server
git commit -m "feat: sessions belong to enrollments; users lose target_language"
```

---

### Task 4: The enrollments API

`POST` and `GET /api/users/{id}/enrollments` (spec §2).

**Files:**
- Create: `apps/server/src/services/enrollments.ts`
- Create: `apps/server/src/routes/enrollments.ts`
- Modify: `apps/server/src/composition.ts`, `app.ts`, `openapi.test.ts`
- Modify: `apps/server/tests/support/fakes.ts` (`createFakeAppDeps`)
- Create: `apps/server/tests/integration/routes/enrollments.test.ts`

**Interfaces:**
- Consumes: Task 3's `EnrollmentRepo`, `UserRepo.findById`, `AlreadyEnrolled`, `UserNotFound`, the core enrollment schemas.
- Produces: `createEnrollmentService({ transaction, logger })` returning `{ enroll(userId: string, input: CreateEnrollmentRequest): Promise<Enrollment>; list(userId: string): Promise<Enrollment[]> }`, type `EnrollmentService`; `AppDeps.enrollments: EnrollmentService`; `createEnrollmentsRouter(enrollments: EnrollmentService)` mounted at `/api`.

- [ ] **Step 1: Write the failing route tests** — `apps/server/tests/integration/routes/enrollments.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createEnrollmentsRouter } from '../../../src/routes/enrollments';
import { createFakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1'); // enrolled in English
});
afterEach(async () => {
  await t.close();
});

function buildTestApp() {
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  const app = new Hono();
  app.route('/api', createEnrollmentsRouter(deps.enrollments));
  return app;
}

const post = (app: Hono, userId: string, body: unknown) =>
  app.request(`/api/users/${userId}/enrollments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/users/{id}/enrollments', () => {
  it('creates a second enrollment in another target', async () => {
    const res = await post(buildTestApp(), 'u_1', { source_language: 'he', target_language: 'ru' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      user_id: 'u_1',
      source_language: 'he',
      target_language: 'ru',
    });
  });

  it('answers 409 for a target the learner already holds — what a double tap sends', async () => {
    const app = buildTestApp();
    expect((await post(app, 'u_1', { source_language: 'he', target_language: 'ru' })).status).toBe(201);
    const again = await post(app, 'u_1', { source_language: 'he', target_language: 'ru' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'already enrolled' });
  });

  it('answers 400 with the standard body for an English source', async () => {
    const res = await post(buildTestApp(), 'u_1', { source_language: 'en', target_language: 'ru' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 404 for a user nobody registered', async () => {
    const res = await post(buildTestApp(), 'u_nobody', { source_language: 'he', target_language: 'ru' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'user not found' });
  });
});

describe('GET /api/users/{id}/enrollments', () => {
  it('lists every enrollment, newest first', async () => {
    const app = buildTestApp();
    await post(app, 'u_1', { source_language: 'he', target_language: 'ru' });
    const res = await app.request('/api/users/u_1/enrollments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target_language: string }[];
    expect(body.map((e) => e.target_language)).toEqual(['ru', 'en']);
  });

  it('answers 404 for a user nobody registered', async () => {
    const res = await buildTestApp().request('/api/users/u_nobody/enrollments');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:integration --workspace apps/server -- tests/integration/routes/enrollments.test.ts`
Expected: FAIL, `Cannot find module '../../../src/routes/enrollments'`.

- [ ] **Step 3: The service** — `apps/server/src/services/enrollments.ts`:

```ts
import type { CreateEnrollmentRequest, Enrollment } from '@lang-tutor/core/api';

import { UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * Enrolling and listing. One transaction each (ADR 0001 R8): the user check and
 * the write are dependent — an enrollment for a user that does not exist is
 * wrong — so they share it.
 */
export function createEnrollmentService({
  transaction,
  logger,
}: {
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    enroll: async (userId: string, input: CreateEnrollmentRequest): Promise<Enrollment> => {
      const created = await transaction(async ({ user, enrollment }) => {
        if (!(await user.findById(userId))) throw new UserNotFound(userId);
        return enrollment.insertEnrollment({
          userId,
          sourceLanguage: input.source_language,
          targetLanguage: input.target_language,
        });
      });
      logger.info({
        event: 'enrolled',
        user_id: userId,
        enrollment_id: created.id,
        source_language: created.source_language,
        target_language: created.target_language,
      });
      return created;
    },

    list: (userId: string): Promise<Enrollment[]> =>
      transaction(async ({ user, enrollment }) => {
        if (!(await user.findById(userId))) throw new UserNotFound(userId);
        return enrollment.listByUser(userId);
      }),
  };
}

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
```

- [ ] **Step 4: The route** — `apps/server/src/routes/enrollments.ts`:

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateEnrollmentRequestSchema,
  EnrollmentListSchema,
  EnrollmentSchema,
  ErrorSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { AlreadyEnrolled, UserNotFound } from '../errors';
import type { EnrollmentService } from '../services/enrollments';

const params = z.object({ id: z.string() });

const createEnrollmentRoute = createRoute({
  method: 'post',
  path: '/users/{id}/enrollments',
  tags: ['enrollments'],
  summary: 'Enroll a learner in a language',
  description:
    'Adds a course of study: one target language, explained in the source language. A learner ' +
    'holds at most one enrollment per target. In this version every enrollment is explained in ' +
    'Hebrew, so `source_language` must be `he`.',
  request: {
    params,
    body: {
      required: true,
      content: { 'application/json': { schema: CreateEnrollmentRequestSchema } },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: EnrollmentSchema } },
      description: 'The enrollment was created.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate: an unknown code, a source other than `he`, or the same language twice.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No user has this id.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The learner is already enrolled in this target language.',
    },
  },
});

const listEnrollmentsRoute = createRoute({
  method: 'get',
  path: '/users/{id}/enrollments',
  tags: ['enrollments'],
  summary: "List a learner's enrollments",
  description: 'Every enrollment the learner holds, newest first. Which one is active is the client\'s business.',
  request: { params },
  responses: {
    200: {
      content: { 'application/json': { schema: EnrollmentListSchema } },
      description: 'The enrollments, possibly none.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No user has this id.',
    },
  },
});

export function createEnrollmentsRouter(enrollments: EnrollmentService) {
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createEnrollmentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    try {
      return c.json(await enrollments.enroll(id, input), 201);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'user not found' }, 404);
      if (error instanceof AlreadyEnrolled) return c.json({ error: 'already enrolled' }, 409);
      throw error;
    }
  });

  router.openapi(listEnrollmentsRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await enrollments.list(id), 200);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'user not found' }, 404);
      throw error;
    }
  });

  return router;
}
```

- [ ] **Step 5: Wiring.**
  - In `composition.ts`, import `createEnrollmentService` and `type EnrollmentService`, add `enrollments: EnrollmentService;` to `AppDeps`, and add `enrollments: createEnrollmentService({ transaction, logger: io.logger }),` to the returned object.
  - In `app.ts`, import `createEnrollmentsRouter` and add `app.route('/api', createEnrollmentsRouter(deps.enrollments));` after the users router. Change the document description to `'Sessions of ten multiple-choice questions for Hebrew speakers learning English or Russian.'`.
  - In `tests/support/fakes.ts` `createFakeAppDeps`, add `const enrollments: EnrollmentService = { enroll: unreachable, list: unreachable };` (import the type) and include it in the returned object.

- [ ] **Step 6: OpenAPI test.**
  - In `src/openapi.test.ts`, `'contains all six paths and nothing else'` becomes `'contains all seven paths and nothing else'`, with `'/api/users/{id}/enrollments'` added to its expected list.
  - Add a `describe('the enrollment endpoints in the published document', …)` block asserting that the POST declares `['201', '400', '404', '409']` and the GET declares `['200', '404']`, following the shape of the `/api/users` tests in the same file.

- [ ] **Step 7: Run**

Run: `npm test --workspace apps/server && npm run test:integration --workspace apps/server -- tests/integration/routes && npm run typecheck --workspace apps/server && npm run lint:arch`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat: add the enrollments API"
```

---

### Task 5: The translation contract speaks `from` and `to`

This deletes `TranslationDirectionSchema`, `detectDirection` and `languagesFor`; assembles both prompts from the language table; and ports the evals mechanically (spec §2 "Translations", §3 "Prompts").

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts`, `schemas.test.ts`
- Modify: `apps/server/src/domain/translation.ts`, `translation.test.ts`
- Modify: `apps/server/src/domain/dictionary.ts` (delete `languagesFor`), `dictionary.test.ts`
- Modify: `apps/server/src/services/translations.ts`, `services/translations.test.ts`
- Modify: `apps/server/src/routes/translations.ts`, `src/openapi.test.ts`
- Modify: `apps/server/tests/eval/askModel.ts`, `cases.ts`, `run.ts`, `generate-content.ts`
- Modify (mechanical): `tests/integration/routes/translations.test.ts`, `services/translations.test.ts`, `services/translations.correction.test.ts`, `services/dictionary.corrections.variants.test.ts`, and any other file `grep -rln "direction" apps/server` lists

**Interfaces:**
- Consumes: Task 1's `LANGUAGES`, `guardScript`, `isInScript`, `type LanguageCode`.
- Produces:
  - core `TranslationRequest = { text: string; from: LanguageCode; to: LanguageCode }` (refined to the supported pairs); `TranslationGuardReasonSchema = z.enum(['wrong_direction','out_of_pair'])`; `TranslationResponse` gains `from: string`, `to: string`, `reason?` and loses `direction`; `TranslationDirection` deleted.
  - `buildPrompt(input: { text: string; from: LanguageCode; to: LanguageCode }): TranslationPrompt`
  - `buildRenderingPrompt(input: { form: string; from: LanguageCode; to: LanguageCode; lemma: string; partOfSpeech: PartOfSpeech; storedSenses: StoredSense[] }): RenderingPrompt`
  - `resolveCorrection(parsed, context: { typedForm: string; from: LanguageCode; to: LanguageCode })`
  - eval `askModel(llm, { text, from, to })` returning a `ModelAnswer` with `from`/`to` and no `direction`; `EvalCase.from?` / `EvalCase.to?` (default `en`/`he`)

- [ ] **Step 1: Core contract.** In `packages/core/src/api/schemas.ts`, delete `TranslationDirectionSchema` and its comment, and add in its place:

```ts
// Phase 16. Why an input came back empty without a model call: the script
// guard (apps/server/src/domain/languages.ts) found its letters in `to`'s
// script, or in neither language's.
export const TranslationGuardReasonSchema = z.enum(['wrong_direction', 'out_of_pair']);
```

Replace `TranslationRequestSchema`:

```ts
export const TranslationRequestSchema = z
  .object({
    // Trimmed before length is judged, so "   " is empty rather than three chars.
    // The 100-character ceiling is also the cap on how much untrusted text can
    // reach the model in one call.
    text: z.string().trim().min(1).max(100),
    // Phase 16. Always stated by the client: there is no detection. The client
    // reads the pair from the learner's active enrollment, so the endpoint
    // stays anonymous — it never learns who asked.
    from: LanguageCodeSchema,
    to: LanguageCodeSchema,
  })
  // Every supported pair includes Hebrew: {he,en} and {he,ru}. en↔ru is refused
  // here, before the model is ever called.
  .refine(({ from, to }) => from !== to && (from === 'he' || to === 'he'), {
    message: 'unsupported language pair',
  });
```

In `TranslationResponseSchema`, replace `direction: TranslationDirectionSchema,` with:

```ts
  // Echoed as plain strings, for the reason UserSchema's language fields are.
  from: z.string(),
  to: z.string(),
```

and add after `correction`:

```ts
  // Present only when the script guard emptied `senses` without a model call.
  reason: TranslationGuardReasonSchema.optional(),
```

In `types.ts`, delete `TranslationDirection` and its schema import, and add `TranslationGuardReasonSchema` and `export type TranslationGuardReason = z.infer<typeof TranslationGuardReasonSchema>;`. In `index.ts`, swap `TranslationDirection` for `TranslationGuardReason`.

In `schemas.test.ts`, replace `'treats direction as an optional override with two values'` with:

```ts
  it('requires from and to, and accepts only pairs that include Hebrew', () => {
    const ok = (from: string, to: string) =>
      TranslationRequestSchema.safeParse({ text: 'x', from, to }).success;
    expect(ok('en', 'he')).toBe(true);
    expect(ok('he', 'en')).toBe(true);
    expect(ok('ru', 'he')).toBe(true);
    expect(ok('he', 'ru')).toBe(true);
    expect(ok('en', 'ru')).toBe(false);
    expect(ok('he', 'he')).toBe(false);
    expect(TranslationRequestSchema.safeParse({ text: 'x' }).success).toBe(false);
  });
```

Add `from: 'en', to: 'he'` to every other `TranslationRequestSchema` and `TranslationResponseSchema` fixture in the file, and remove `direction` from them.

- [ ] **Step 2: Write the failing prompt tests.** In `apps/server/src/domain/translation.test.ts`, replace every `direction: 'en_he'` argument with `from: 'en', to: 'he'` and every `direction: 'he_en'` with `from: 'he', to: 'en'`, then delete every `describe`/`it` about `detectDirection`. Append:

```ts
describe('prompts assembled from the language table', () => {
  const system = (from: 'he' | 'en' | 'ru', to: 'he' | 'en' | 'ru') =>
    buildPrompt({ text: 'x', from, to }).system;
  const rendering = (from: 'he' | 'en' | 'ru', to: 'he' | 'en' | 'ru') =>
    buildRenderingPrompt({
      form: 'x',
      from,
      to,
      lemma: 'x',
      partOfSpeech: 'noun',
      storedSenses: [],
    }).system;

  it('names the pair and the learner', () => {
    expect(system('en', 'he')).toContain('You translate from English to Hebrew for a Hebrew-speaking learner of English.');
    expect(system('he', 'en')).toContain('You translate from Hebrew to English for a Hebrew-speaking learner of English.');
    expect(system('ru', 'he')).toContain('You translate from Russian to Hebrew for a Hebrew-speaking learner of Russian.');
    expect(system('he', 'ru')).toContain('You translate from Hebrew to Russian for a Hebrew-speaking learner of Russian.');
  });

  it('carries the source language\'s reading rules only when it is the source', () => {
    expect(system('en', 'he')).toContain('A bare or "to"-marked English verb');
    expect(system('he', 'en')).not.toContain('A bare or "to"-marked English verb');
    expect(system('ru', 'he')).toContain('"прочитала"');
    expect(system('he', 'ru')).not.toContain('"прочитала"');
  });

  it('carries the writing rules of both languages, because examples hold both', () => {
    for (const prompt of [system('en', 'he'), system('he', 'en'), system('ru', 'he'), system('he', 'ru')]) {
      expect(prompt).toContain('no nikud');
    }
    expect(system('ru', 'he')).toContain('without stress marks');
    expect(system('he', 'ru')).toContain('without stress marks');
    expect(system('en', 'he')).not.toContain('Russian');
  });

  it('says which language the input is meant to be', () => {
    expect(system('ru', 'he')).toContain('The input is meant to be Russian.');
  });

  it('applies the same rules to the rendering prompt', () => {
    expect(rendering('ru', 'he')).toContain('for a Hebrew-speaking learner of Russian.');
    expect(rendering('ru', 'he')).toContain('"прочитала"');
    expect(rendering('ru', 'he')).toContain('without stress marks');
    expect(rendering('en', 'he')).not.toContain('Russian');
  });

  it('never contains an unquoted registered matchText', () => {
    for (const prompt of [system('en', 'he'), system('ru', 'he'), rendering('ru', 'he')]) {
      expect(prompt).not.toMatch(/see|saw/);
    }
  });
});

describe('resolveCorrection guard 4 reads the language table', () => {
  it('rejects a corrected form in the other script', () => {
    const parsed = {
      kind: 'word' as const,
      entries: [{ lemma: 'ёлка', part_of_speech: 'noun' as const, senses: [{ sense_code: 'fir', translation: 'אשוח' }] }],
      correction: { corrected_form: 'אשוח', alternatives: [] },
    };
    expect(resolveCorrection(parsed, { typedForm: 'елка', from: 'ru', to: 'he' })).toBeNull();
  });

  it('accepts елка corrected to ёлка', () => {
    const parsed = {
      kind: 'word' as const,
      entries: [{ lemma: 'ёлка', part_of_speech: 'noun' as const, senses: [{ sense_code: 'fir', translation: 'אשוח' }] }],
      correction: { corrected_form: 'ёлка', alternatives: [] },
    };
    expect(resolveCorrection(parsed, { typedForm: 'елка', from: 'ru', to: 'he' })?.correction?.corrected_form).toBe('ёлка');
  });
});
```

Two checks before running:
- **The matchText test.** The prompt's comments mention `saw` and `see`, but comments never reach the prompt. Build the four system strings in a scratch `tsx` one-liner and grep them. If a rule string that already existed before this phase contains `see` or `saw`, phase 12's audit missed it. Report that to Victor rather than loosening the test.
- **The parsed fixtures.** If `LlmTranslation`'s entry type requires more fields than the literals in the `resolveCorrection` tests supply (e.g. `example`), add them.

- [ ] **Step 3: Run them to make sure they fail**

Run: `npm test --workspace apps/server -- src/domain/translation.test.ts`
Expected: FAIL, type errors on `from`/`to`, or missing strings.

- [ ] **Step 4: Rewrite the prompt builders.** In `apps/server/src/domain/translation.ts`:
  - the imports: drop `TranslationDirection`; add `import { LANGUAGES, guardScript, type Language, type LanguageCode } from './languages';`;
  - delete `HEBREW`, `detectDirection` and its comment, and `LANGUAGE_NAMES`;
  - add above `buildPrompt`:

```ts
/**
 * Phase 16. Who the prompt says the learner is. Every supported pair includes
 * Hebrew and every enrollment is Hebrew-explained (spec, "Assumptions that hold
 * only in this phase"), so the learner speaks Hebrew and learns the pair's other
 * language. Lifted when an English UI lands.
 */
function learnerLine(source: Language, target: Language): string {
  const learned = source.code === 'he' ? target : source;
  return `You translate from ${source.name} to ${target.name} for a Hebrew-speaking learner of ${learned.name}.`;
}

/** The middle of the grammatical-form rule: how to read the source, the
 *  citation-form rule, and how to write the target. */
function formRules(source: Language, target: Language): string[] {
  return [
    ...source.asSource(target.name),
    `Where ${target.name} offers several forms for one category, use its dictionary citation form for that category.`,
    ...target.asTarget,
  ];
}

/** Both languages' writing rules, source first, each once. */
function writingRules(source: Language, target: Language): string[] {
  return [...new Set([...source.writing, ...target.writing])];
}
```

In `buildPrompt`:
- change the signature to `input: { text: string; from: LanguageCode; to: LanguageCode }`;
- replace `const { from, to } = LANGUAGE_NAMES[input.direction];` with `const source = LANGUAGES[input.from]; const target = LANGUAGES[input.to]; const from = source.name; const to = target.name;`, which keeps every existing `${from}`/`${to}` interpolation in the rule list valid;
- replace the first array element with `learnerLine(source, target),`.

Replace the six-line block that starts `` `Translate into the grammatical form matching the input's: a past-tense input takes a`, `` and ends `'input as typed, not around its headword.',` with:

```ts
    "Translate into the grammatical form matching the input's: a past-tense input takes a",
    'past-tense translation.',
    ...formRules(source, target),
    'Build the example sentence around the input as typed, not around its headword.',
```

replace the line `'Write Hebrew in plain unvocalised script, with no nikud: ספר, never סֵפֶר.',` (and its comment, which moved to `languages.ts`) with `...writingRules(source, target),`, and insert immediately before `'If the input is not a word or expression in either language and no real word or',`:

```ts
    // Phase 16. The guard catches a wrong script for free; this is the case it
    // cannot see — Ukrainian `дякую` under ru → he shares Russian's script.
    `The input is meant to be ${source.name}. A word of another language is not a word in`,
    `either language, even when it is written in the ${source.name} script.`,
```

In `buildRenderingPrompt`, make the same changes:
- the signature takes `from: LanguageCode; to: LanguageCode` in place of `direction`;
- the same `source`/`target`/`from`/`to` consts;
- the first element is `learnerLine(source, target),`;
- the six-line grammatical block becomes the four lines below;
- the nikud line becomes `...writingRules(source, target),`.

```ts
    `Translate into the grammatical form matching "${input.form}": a past-tense form takes a`,
    'past-tense translation.',
    ...formRules(source, target),
    `Build each example sentence around "${input.form}" as typed, not around the headword.`,
```

`askRendering` in `tests/eval/askModel.ts` hands its input straight to `buildRenderingPrompt`, so its input type must carry the same `from`/`to` names (Step 8).

In `resolveCorrection`, change `context: { typedForm: string; direction: TranslationDirection }` to `context: { typedForm: string; from: LanguageCode; to: LanguageCode }`, and replace guard 4:

```ts
  // Guard 4 — the answer is unusable, not merely uncorrected: a corrected form
  // in the wrong script would be written as a `from` variant. The language
  // table decides, exactly as the request's own script guard does.
  if (guardScript(correctedForm, context.from, context.to) !== 'pass') return null;
```

In `apps/server/src/domain/dictionary.ts`, delete `languagesFor` and its doc comment (and the `TranslationDirection` import if it becomes unused). In `dictionary.test.ts`, delete its tests.

- [ ] **Step 5: The service.** In `apps/server/src/services/translations.ts`, apply these systematically, then confirm `grep -n "direction\|source\|target" apps/server/src/services/translations.ts` shows only comments and the `TranslationRequest`/`Response` types:
  - imports: drop `TranslationDirection`, `detectDirection` and `languagesFor`; add `LanguageCode` to the `@lang-tutor/core/api` type import;
  - in `reconcile`, `repairForm` and `serveForm`, replace the parameter `direction: TranslationDirection` with `from: LanguageCode; to: LanguageCode`, and delete their `source: string; target: string` parameters. Inside them, rename `source` → `from` and `target` → `to`, and pass `from, to` wherever `direction` or `source, target` were passed;
  - `buildRenderingPrompt({ form, direction, … })` becomes `buildRenderingPrompt({ form, from, to, … })` in both call sites;
  - every log object's `direction,` becomes `from, to,`;
  - the head of `translate` becomes:

```ts
    translate: async (input: TranslationRequest): Promise<TranslationResponse> => {
      const text = input.text.trim();
      const { from, to } = input;
      const form = normalizeForm(text);
```

  - every `languageCode: source` becomes `languageCode: from`, and every `userLanguageCode: target` becomes `userLanguageCode: to`;
  - every returned `{ text, direction, … }` becomes `{ text, from, to, … }`;
  - `buildPrompt({ text, direction })` becomes `buildPrompt({ text, from, to })`;
  - `resolveCorrection(parsed, { typedForm: form, direction })` becomes `resolveCorrection(parsed, { typedForm: form, from, to })`.

- [ ] **Step 6: The route description.** In `routes/translations.ts`, change the 200 description to:

```ts
      description:
        'The translation. `from` and `to` echo the request; `kind` describes the input. A ' +
        '`sentence` carries exactly one sense, with no part of speech and no example. An empty ' +
        '`senses` array with a `reason` means the input was refused before any model call: ' +
        "`wrong_direction` when its letters are in `to`'s script, `out_of_pair` when they are in " +
        'neither language\'s.',
```

and append to the operation `description` (before the NOTE): `'The client states the direction with `from` and `to`; supported pairs are Hebrew with English and Hebrew with Russian, either way. '`.

In `src/openapi.test.ts`, the response-schema test lists `'direction'`. Replace it with `'from'` and `'to'`, and add `'reason'` to the optional properties checked. `required` becomes `['from', 'kind', 'senses', 'text', 'to']`.

- [ ] **Step 7: Mechanical test port.** In every server test file `grep -rln "direction" apps/server/src apps/server/tests` lists (except `tests/eval`, which is the next step):
  - every `translate({ text: T })` and every request body `{ text: T }` gets `from: 'en', to: 'he'` when `T` is Latin script and `from: 'he', to: 'en'` when it is Hebrew;
  - every `direction: 'en_he'` becomes `from: 'en', to: 'he'`, and `'he_en'` becomes `from: 'he', to: 'en'`;
  - every expected response's `direction: …` becomes the matching `from`/`to` pair;
  - every logged-event expectation's `direction` becomes `from`/`to`;
  - a test whose whole point was detection, e.g. "a Hebrew input is detected as he_en", is deleted. A test that merely sent Hebrew is kept, with `from: 'he', to: 'en'`.

- [ ] **Step 8: Evals, mechanically.**
  - **`tests/eval/askModel.ts`:**
    - imports drop `TranslationDirection` and `detectDirection` and gain `LanguageCode`;
    - `ModelAnswer` has `from: LanguageCode; to: LanguageCode` and no `direction`;
    - `askModel(llm, input: { text: string; from: LanguageCode; to: LanguageCode })` uses `input.from` and `input.to` everywhere `direction` was used, and returns `from, to`;
    - `askRendering`'s input type has `from: LanguageCode; to: LanguageCode` in place of `direction`.
  - **`tests/eval/cases.ts`:**
    - in both `EvalCase` and `RenderingCase`, replace `direction?: TranslationDirection;` with `/** Defaults to en → he. */ from?: LanguageCode; to?: LanguageCode;`;
    - every `direction: 'he_en'` becomes `from: 'he', to: 'en'`;
    - relabel the case `'the reverse direction, and that script detection agreed'` as `'the reverse direction'` and give it `from: 'he', to: 'en'`. This keeps its he→en coverage and drops a claim about detection, which no longer exists.
  - **`tests/eval/run.ts`:**
    - `askModel(llm, { text: kase.text, from: kase.from ?? 'en', to: kase.to ?? 'he' })`;
    - `askRendering(llm, { …, from: kase.from ?? 'en', to: kase.to ?? 'he', … })`;
    - tier 1's `if (result.direction === 'en_he') { … HEBREW.test … }` becomes:

```ts
  checks.push({
    name: `translation is in ${result.to} script`,
    ok: senses.every((sense) => isInScript(sense.translation, result.to)),
  });
```

  and the rendering tier-1 block `if ((kase.direction ?? 'en_he') === 'en_he') { … }` becomes the same check against `kase.to ?? 'he'` over `rendered`. Import `isInScript` from `../../src/domain/languages`, and delete `HEBREW` if it becomes unused. The printed row line `direction=${row.result.direction}` becomes `${row.result.from}→${row.result.to}`.
  - **`tests/eval/generate-content.ts`:** `askModel(llm, { text: query })` becomes `askModel(llm, { text: query, from: 'en', to: 'he' })` for now; Task 7 makes it pair-aware.

- [ ] **Step 9: Run**

Run: `npm test --workspace packages/core && npm test --workspace apps/server && npm run test:integration --workspace apps/server && npm run typecheck --workspace apps/server && npm run lint:arch`
Expected: PASS / clean.

Run: `grep -rn "direction\|detectDirection\|languagesFor\|TranslationDirection" apps/server/src apps/server/tests packages/core/src`
Expected: only prose in comments. Reword any comment that still describes detection as current behaviour.

- [ ] **Step 10: Run the eval** (real model; see Global Constraints)

Run: `npm run eval`
Expected: tier 1 has 0 failures and tier 2 is at or above `TIER2_THRESHOLD`. If tier 2 dropped compared with `master` (run `npm run eval` on the main checkout to compare), the reassembled en/he prompt is the cause. Diff `buildPrompt({ text: 'x', from: 'en', to: 'he' }).system` against master's and restore wording until the score recovers. Never touch the threshold.

- [ ] **Step 11: Commit**

```bash
git add packages/core apps/server
git commit -m "feat: translations take an explicit from and to; prompts built per language"
```

---

### Task 6: The script guard and `reason`

Spec §3 "Script guard". Input whose letters belong to the wrong side is answered without a read or a model call.

**Files:**
- Modify: `apps/server/src/services/translations.ts`
- Modify: `apps/server/src/services/translations.test.ts`
- Modify: `apps/server/tests/integration/routes/translations.test.ts`

**Interfaces:**
- Consumes: Task 1's `guardScript`; Task 5's `TranslationResponse.reason`.
- Produces: the logged event `{ event: 'translation_guarded', from, to, reason }`.

- [ ] **Step 1: Write the failing unit tests.** Append to `apps/server/src/services/translations.test.ts`, following the existing service construction in that file (`createFakeLlmClient`, `createFakeDictRepo`, `createFakeTransaction`, `createFakeLogger`):

```ts
describe('the script guard', () => {
  function build() {
    const llm = createFakeLlmClient('must not be called');
    const dict = createFakeDictRepo();
    const logger = createFakeLogger();
    const service = createTranslationService({
      llm,
      transaction: createFakeTransaction({ dict }),
      logger,
    });
    return { llm, dict, logger, service };
  }

  it('answers Hebrew typed under ru → he as a wrong direction, with no read and no call', async () => {
    const { llm, dict, logger, service } = build();
    const answer = await service.translate({ text: 'חלון', from: 'ru', to: 'he' });
    expect(answer).toEqual({ text: 'חלון', from: 'ru', to: 'he', kind: 'word', senses: [], reason: 'wrong_direction' });
    expect(llm.calls).toHaveLength(0);
    expect(dict.reads).toHaveLength(0);
    expect(logger.events).toContainEqual({ event: 'translation_guarded', from: 'ru', to: 'he', reason: 'wrong_direction' });
  });

  it('answers Latin typed under ru → he as out of pair', async () => {
    const { llm, service } = build();
    const answer = await service.translate({ text: 'window', from: 'ru', to: 'he' });
    expect(answer.reason).toBe('out_of_pair');
    expect(answer.senses).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('lets letterless input through to the normal path', async () => {
    const { dict, service } = build();
    dict.hit['100%'] = [];
    await service.translate({ text: '100%', from: 'en', to: 'he' }).catch(() => undefined);
    expect(dict.reads.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test --workspace apps/server -- src/services/translations.test.ts`
Expected: FAIL. The service reads the dictionary and calls the fake model.

- [ ] **Step 3: Implement.** In `services/translations.ts`, import `guardScript` from `../domain/languages`, and insert directly after `const form = normalizeForm(text);`:

```ts
      // Phase 16, spec §3. Before any read or model call: input whose letters are
      // all in `to`'s script, or in neither language's, is answered here, so
      // nothing it could have provoked reaches the shared dictionary.
      const verdict = guardScript(form, from, to);
      if (verdict !== 'pass') {
        logger.info({ event: 'translation_guarded', from, to, reason: verdict });
        return { text, from, to, kind: resolveKind(text, 'word'), senses: [], reason: verdict };
      }
```

- [ ] **Step 4: Run them to make sure they pass**

Run: `npm test --workspace apps/server -- src/services/translations.test.ts`
Expected: PASS.

- [ ] **Step 5: Route test, zero provider calls.** Append to `tests/integration/routes/translations.test.ts` (it already imports `countGeminiRequests`; the request helper in that file may be named differently, so follow it):

```ts
describe('the script guard over the wire', () => {
  it.each([
    ['חלון', 'wrong_direction'],
    ['window', 'out_of_pair'],
  ])('answers %s under ru → he with reason %s and calls no model', async (text, reason) => {
    const { app } = buildTestApp();
    const res = await app.request('/api/translations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: 'ru', to: 'he' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'ru', to: 'he', senses: [], reason });
    expect(await countGeminiRequests(ns)).toBe(0);
  });

  it('refuses en ↔ ru with the standard 400 and calls no model', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/api/translations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'window', from: 'en', to: 'ru' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
    expect(await countGeminiRequests(ns)).toBe(0);
  });
});
```

Run: `npm run test:integration --workspace apps/server -- tests/integration/routes/translations.test.ts`
Expected: PASS.

- [ ] **Step 6: Run and commit**

Run: `npm test --workspace apps/server && npm run typecheck --workspace apps/server && npm run lint:arch`

```bash
git add apps/server
git commit -m "feat: refuse wrong-script lookups before any read or model call"
```

---

### Task 7: A pair-aware seed and ten Russian questions

Spec §4. The seed knows its pair, the recordings are keyed by pair, and 10 `ru → he` rows are recorded from the real model.

**Files:**
- Modify: `apps/server/src/db/content.ts`, `content.test.ts`, `content.generated.ts`, `seed.ts`
- Modify: `apps/server/tests/eval/generate-content.ts`
- Modify: `apps/server/tests/integration/db/seed.test.ts`, `tests/integration/routes/sessions.test.ts`

**Interfaces:**
- Consumes: Task 1's `isInScript`; Task 5's pair-aware `askModel`.
- Produces: `ContentEntry` gains `from: LanguageCode; to: LanguageCode`; `recordingKey(entry: Pick<ContentEntry, 'from' | 'to' | 'query'>): string` returns `` `${from}-${to}:${query}` ``.

- [ ] **Step 1: Write the failing content tests.** In `apps/server/src/db/content.test.ts`, add (merging with the file's existing imports):

```ts
import { SESSION_LENGTH } from '../domain/session';
import { isInScript } from '../domain/languages';
import { content, correctAnswerFor, recordingKey } from './content';
import { recorded } from './content.generated';

describe('the pair-aware seed', () => {
  it('records every entry under its own pair', () => {
    for (const entry of content) {
      expect(recorded[recordingKey(entry)]).toBeDefined();
    }
  });

  it('seeds at least a full session for every pair it seeds at all', () => {
    const counts = new Map<string, number>();
    for (const entry of content) {
      const pair = `${entry.from}-${entry.to}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['en-he', 'ru-he']);
    for (const count of counts.values()) expect(count).toBeGreaterThanOrEqual(SESSION_LENGTH);
  });

  it('never offers the correct answer as a distractor', () => {
    for (const entry of content) {
      expect(entry.distractors).not.toContain(correctAnswerFor(entry));
    }
  });

  it('writes every query in from’s script and every option in to’s', () => {
    for (const entry of content) {
      expect(isInScript(entry.query, entry.from)).toBe(true);
      for (const option of [...entry.distractors, correctAnswerFor(entry)]) {
        expect(isInScript(option, entry.to)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test --workspace apps/server -- src/db/content.test.ts`
Expected: FAIL, `recordingKey` is not exported.

- [ ] **Step 3: Make `content.ts` pair-aware.**
  - Add `import type { LanguageCode } from '../domain/languages';`.
  - Add to `ContentEntry`, above `query`:

```ts
  /** The lookup this recording answers: `from` is the language the query is in,
   *  `to` the language its options are in. A seeded question's
   *  target_language is `from`. */
  from: LanguageCode;
  to: LanguageCode;
```

  - Add below the type:

```ts
/** A recording's key: the pair and the query, because the same string may one
 *  day be seeded under two pairs, and a bare query would collide. */
export function recordingKey(entry: Pick<ContentEntry, 'from' | 'to' | 'query'>): string {
  return `${entry.from}-${entry.to}:${entry.query}`;
}
```

  - In `correctAnswerFor`, read `recorded[recordingKey(entry)]`, and make the error message mention `npm run content:generate -- ${entry.query}`.
  - Give each of the 13 existing rows `from: 'en', to: 'he',` as its first two fields.
  - Append the Russian rows:

```ts
  // Phase 16. ru → he. Hebrew distractors, hand-written; the right answer is
  // spliced in from the recording, as for English. Reviewed by Victor, who reads
  // both languages (spec §4).
  { from: 'ru', to: 'he', query: 'окно', question_id: 'q-ru-okno', distractors: ['דלת', 'קיר', 'תקרה'], correct_option: 2 },
  { from: 'ru', to: 'he', query: 'книга', question_id: 'q-ru-kniga', distractors: ['מחברת', 'עיתון', 'מכתב'], correct_option: 0 },
  { from: 'ru', to: 'he', query: 'вода', question_id: 'q-ru-voda', distractors: ['חלב', 'מיץ', 'תה'], correct_option: 1 },
  { from: 'ru', to: 'he', query: 'друг', question_id: 'q-ru-drug', distractors: ['שכן', 'אח', 'מורה'], correct_option: 3 },
  { from: 'ru', to: 'he', query: 'трудный', question_id: 'q-ru-trudnyj', distractors: ['קל', 'מהיר', 'חשוב'], correct_option: 0 },
  { from: 'ru', to: 'he', query: 'помнить', question_id: 'q-ru-pomnit', distractors: ['לשכוח', 'לחשוב', 'לדעת'], correct_option: 2 },
  { from: 'ru', to: 'he', query: 'извините', question_id: 'q-ru-izvinite', distractors: ['תודה', 'בבקשה', 'שלום'], correct_option: 1 },
  { from: 'ru', to: 'he', query: 'доброе утро', question_id: 'q-ru-dobroe-utro', distractors: ['ערב טוב', 'לילה טוב', 'צהריים טובים'], correct_option: 3 },
  { from: 'ru', to: 'he', query: 'спасибо большое', question_id: 'q-ru-spasibo-bolshoe', distractors: ['בבקשה', 'סליחה רבה', 'להתראות'], correct_option: 0 },
  // Not שלום as a distractor: it means goodbye too, so it would be a second right answer.
  { from: 'ru', to: 'he', query: 'до свидания', question_id: 'q-ru-do-svidaniya', distractors: ['ברוך הבא', 'תודה', 'בהצלחה'], correct_option: 2 },
```

- [ ] **Step 4: Re-key the 13 English recordings** (mechanical, no content change). Top-level keys in `content.generated.ts` are the only lines indented by exactly two spaces:

```bash
sed -i '' -E 's/^  "([^"]+)": \{$/  "en-he:\1": {/' apps/server/src/db/content.generated.ts
git diff --stat apps/server/src/db/content.generated.ts
```

Expected: 13 lines changed. Spot-check with `grep -c '^  "en-he:' apps/server/src/db/content.generated.ts`, which should print `13`. (On Linux, use `sed -i` without `''`.)

- [ ] **Step 5: `seed.ts`.**
  - Delete `TARGET_LANGUAGE` and `USER_LANGUAGE`, and import `recordingKey` from `./content`.
  - In the loop, `const answer = recorded[recordingKey(entry)];`.
  - `persistEntries({ form: entry.query, languageCode: entry.from, userLanguageCode: entry.to, … })`.
  - The question row's `targetLanguage: entry.from, userLanguageCode: entry.to,`.
  - Add `enrollmentId: null,` next to `userId: null,`.

- [ ] **Step 6: Make the recorder pair-aware.** In `tests/eval/generate-content.ts`:
  - import `recordingKey` from `../../src/db/content`;
  - replace the query selection with entry selection plus a `--pair` flag:

```ts
  const args = process.argv.slice(2);
  const pairIndex = args.indexOf('--pair');
  const pair = pairIndex >= 0 ? args[pairIndex + 1] : undefined;
  const filter = args.find((arg, index) => !arg.startsWith('--') && index !== pairIndex + 1);

  const matching = content.filter(
    (entry) =>
      (!filter || entry.query === filter) && (!pair || `${entry.from}-${entry.to}` === pair),
  );

  if (matching.length === 0) {
    throw new Error(
      `no seeded entry matches "${filter ?? ''}"${pair ? ` under ${pair}` : ''}. Known entries:\n  ` +
        content.map((entry) => recordingKey(entry)).join('\n  '),
    );
  }
  if (filter && !pair && new Set(matching.map((entry) => `${entry.from}-${entry.to}`)).size > 1) {
    throw new Error(`"${filter}" is seeded under more than one pair; add --pair <from>-<to>.`);
  }
```

  - In the recording loop, iterate `matching`:
    - `const answer = await askModel(llm, { text: entry.query, from: entry.from, to: entry.to });`
    - `next[recordingKey(entry)] = …`
    - use `entry.query` in the log lines.
  - Adjust the placeholder guard and the final count message to use `matching.length`.

- [ ] **Step 7: Record the ten Russian answers** (real model; see Global Constraints)

```bash
for q in окно книга вода друг трудный помнить извините "доброе утро" "спасибо большое" "до свидания"; do
  npm run content:generate -- "$q" || break
done
git diff apps/server/src/db/content.generated.ts | head -200
```

Expected: ten new `"ru-he:…"` keys, each with `kind` `word` or `phrase`, a Cyrillic `lemma` without stress marks, and Hebrew translations without nikud. Read every one. If a recording is classified `sentence`, or its entry-0/sense-0 translation equals one of that row's distractors, change the distractor in `content.ts` (never the recording) and re-run `npm test --workspace apps/server -- src/db/content.test.ts`.

- [ ] **Step 8: Run the content tests**

Run: `npm test --workspace apps/server -- src/db/content.test.ts`
Expected: PASS.

- [ ] **Step 9: Strengthen the integration tests.**
  - In `tests/integration/db/seed.test.ts`, add an assertion in the file's existing style: after seeding, `questions` holds exactly 10 rows with `target_language = 'ru' and user_language_code = 'he'`, and 13 with `'en'`/`'he'`.
  - In `tests/integration/routes/sessions.test.ts`, change the Task 3 test `"draws each enrollment's own pair for one learner holding two"`: the `ru` start now expects 200, and every question in a full walk of the Russian session (use the file's existing loop pattern that advances through next-step) has a Cyrillic prompt. Assert with `/\p{Script=Cyrillic}/u.test(question.question)`. The English session's prompts are Latin script.

- [ ] **Step 10: Run and commit**

Run: `npm test --workspace apps/server && npm run test:integration --workspace apps/server && npm run typecheck --workspace apps/server && npm run lint:arch`
Expected: PASS / clean.

```bash
git add apps/server
git commit -m "feat: seed ten Russian questions through a pair-aware recorder"
```

---

### Task 8: Russian eval cases

Spec §6, "Evals".

**Files:**
- Modify: `apps/server/tests/eval/cases.ts`

**Interfaces:**
- Consumes: Task 5's `EvalCase.from`/`to`; the existing fields `expectLemma`, `expectCorrection`, `expectEmpty`, `rejectAny`, `acceptTop`, `expectKind`.

- [ ] **Step 1: Add the cases.** Append to the `CASES` array in `cases.ts` (use the array's actual exported name):

```ts
  // Phase 16 — Russian, explained in Hebrew. Each stresses one rule the language
  // table added; spec §6 lists them.
  {
    label: 'ru: a verb keeps the aspect typed',
    text: 'прочитала',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['קרא', 'קראה'],
    expectLemma: 'прочитать',
  },
  {
    label: 'ru: a noun case form belongs to its nominative singular',
    text: 'книги',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['ספרים', 'ספר', 'של הספר'],
    expectLemma: 'книга',
  },
  {
    label: 'ru: an idiom by meaning, not word for word',
    text: 'как дела?',
    from: 'ru',
    to: 'he',
    expectKind: 'phrase',
    acceptTop: ['מה שלומך', 'מה שלומך?', 'מה נשמע', 'מה נשמע?', 'מה העניינים', 'מה העניינים?'],
    rejectAny: ['איך מעשים', 'איך דברים'],
  },
  {
    label: 'ru: a missing ё is a misspelling, corrected to the word',
    text: 'елка',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['עץ אשוח', 'אשוח', 'עץ חג המולד'],
    expectCorrection: 'ёлка',
  },
  {
    label: 'ru: a same-script word of another language is not Russian',
    text: 'дякую',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
  },
  {
    label: 'he → ru: a Hebrew word rendered in Russian',
    text: 'חלון',
    from: 'he',
    to: 'ru',
    expectKind: 'word',
    acceptTop: ['окно'],
  },
```

If `expectCorrection` or `expectEmpty` combine with `acceptTop` differently from how existing cases use them, read two existing cases of each kind first and mirror them exactly.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace apps/server`
Expected: clean.

- [ ] **Step 3: Run the eval**

Run: `npm run eval`
Expected: tier 1 has 0 failures and tier 2 is at or above `TIER2_THRESHOLD`. Read `eval-report`.
- If a Russian case fails, fix the prompt: the rule strings in `domain/languages.ts`, or the "meant to be" sentence in `buildPrompt`. Re-run Task 1's and Task 5's unit tests after any wording change.
- If the `дякую` case keeps returning a correction to a Russian word in place of empty senses, that is a prompt behaviour to fix in the "meant to be" sentence, not a case to delete.

- [ ] **Step 4: Commit**

```bash
git add apps/server
git commit -m "test: score the prompt on Russian"
```

---

### Task 9: Mobile — pure enrollment helpers, the remembered store, the API client

**Files:**
- Create: `apps/mobile/src/enrollments.ts`, `apps/mobile/src/enrollments.test.ts`
- Modify: `apps/mobile/src/currentUser.ts`, `currentUser.test.ts`
- Modify: `apps/mobile/src/api/client.ts`, `client.test.ts`

**Interfaces:**
- Consumes: core `Enrollment`, `CreateEnrollmentRequest`, `LanguageCode`, `TranslationRequest`, `CreateSessionRequest`.
- Produces:
  - `ENROLLABLE_TARGETS: readonly LanguageCode[]` (`['en','ru']`)
  - `chooseActive(list: Enrollment[], rememberedId: string | null): Enrollment | null`
  - `availableTargets(list: Enrollment[]): LanguageCode[]`
  - `asLanguageCode(code: string): LanguageCode` (throws on unknown)
  - `type LookupDirection = { from: LanguageCode; to: LanguageCode }`; `lookupDirection(enrollment: Enrollment): LookupDirection` (target → source); `flipped(direction: LookupDirection): LookupDirection`
  - `createRememberedEnrollmentStore({ storage })` → `{ read(username: string): Promise<string | null>; write(username: string, enrollmentId: string): Promise<void> }`, type `RememberedEnrollmentStore`
  - `ApiClient.listEnrollments(userId: string): Promise<Enrollment[]>`, `ApiClient.createEnrollment(userId: string, request: CreateEnrollmentRequest): Promise<Enrollment>`

- [ ] **Step 1: Write the failing tests** — `apps/mobile/src/enrollments.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Enrollment } from '@lang-tutor/core/api';

import { asLanguageCode, availableTargets, chooseActive, flipped, lookupDirection } from './enrollments';

const enrollment = (id: string, target: string, source = 'he'): Enrollment => ({
  id,
  user_id: 'u',
  source_language: source,
  target_language: target,
  created_at: '2026-10-03T00:00:00.000Z',
});

// The server lists newest first.
const ru = enrollment('e-ru', 'ru');
const en = enrollment('e-en', 'en');

describe('chooseActive', () => {
  it('takes the remembered enrollment when it is still held', () => {
    expect(chooseActive([ru, en], 'e-en')).toBe(en);
  });

  it('falls back to the newest when the remembered one is gone', () => {
    expect(chooseActive([ru, en], 'e-deleted-elsewhere')).toBe(ru);
  });

  it('falls back to the newest when nothing is remembered', () => {
    expect(chooseActive([ru, en], null)).toBe(ru);
  });

  it('is null with no enrollments, which routes to the enroll screen', () => {
    expect(chooseActive([], 'e-en')).toBeNull();
  });
});

describe('availableTargets', () => {
  it('offers every enrollable target not yet taken', () => {
    expect(availableTargets([])).toEqual(['en', 'ru']);
    expect(availableTargets([ru])).toEqual(['en']);
    expect(availableTargets([ru, en])).toEqual([]);
  });

  it('ignores a legacy target outside the enrollable set', () => {
    expect(availableTargets([enrollment('e-he', 'he', 'en')])).toEqual(['en', 'ru']);
  });
});

describe('lookupDirection', () => {
  it('opens on target → source', () => {
    expect(lookupDirection(ru)).toEqual({ from: 'ru', to: 'he' });
    expect(flipped(lookupDirection(ru))).toEqual({ from: 'he', to: 'ru' });
  });
});

describe('asLanguageCode', () => {
  it('narrows a known code and refuses an unknown one', () => {
    expect(asLanguageCode('ru')).toBe('ru');
    expect(() => asLanguageCode('fr')).toThrow();
  });
});
```

Append to `apps/mobile/src/currentUser.test.ts` (follow its existing in-memory storage fake):

```ts
describe('createRememberedEnrollmentStore', () => {
  it('remembers one enrollment per username, so two learners on one device never share one', async () => {
    const store = createRememberedEnrollmentStore({ storage: memoryStorage() });
    await store.write('dana', 'e-ru');
    await store.write('yoni', 'e-en');
    expect(await store.read('dana')).toBe('e-ru');
    expect(await store.read('yoni')).toBe('e-en');
    expect(await store.read('nobody')).toBeNull();
  });
});
```

(If the file has no `memoryStorage()` helper, define one at its top: a `Map` exposing `getItem`/`setItem`.)

Append to `apps/mobile/src/api/client.test.ts`:

```ts
  it('listEnrollments GETs the user\'s enrollments', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    const client = buildClient(mockFetch);
    expect(await client.listEnrollments('u1')).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/users/u1/enrollments',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('createEnrollment POSTs the request body', async () => {
    const created = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'ru', created_at: 'x' };
    const mockFetch = jest.fn(async () => ({ ok: true, status: 201, json: async () => created }));
    const client = buildClient(mockFetch);
    expect(await client.createEnrollment('u1', { source_language: 'he', target_language: 'ru' })).toEqual(created);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/users/u1/enrollments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source_language: 'he', target_language: 'ru' }),
      }),
    );
  });

  it('throws ApiError(409) when already enrolled', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }));
    await expect(
      buildClient(mockFetch).createEnrollment('u1', { source_language: 'he', target_language: 'ru' }),
    ).rejects.toEqual(new ApiError(409));
  });
```

Also update the existing `createSession` test to send and expect `{ enrollment_id: 'e1' }`, and any `translate` test to send `{ text, from: 'en', to: 'he' }`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test --workspace apps/mobile`
Expected: FAIL, missing modules and exports.

- [ ] **Step 3: Implement `apps/mobile/src/enrollments.ts`**

```ts
import type { Enrollment, LanguageCode } from '@lang-tutor/core/api';

/**
 * Pure enrollment rules for the app. Kept out of the hooks so they are tested
 * without rendering anything.
 */

/** What a learner can enroll in today: every enrollment is Hebrew-explained,
 *  so Hebrew itself is not on offer. */
export const ENROLLABLE_TARGETS: readonly LanguageCode[] = ['en', 'ru'];

const KNOWN: readonly LanguageCode[] = ['he', 'en', 'ru'];

/** The wire sends language codes as plain strings; requests need the enum. */
export function asLanguageCode(code: string): LanguageCode {
  if (!(KNOWN as readonly string[]).includes(code)) throw new Error(`unknown language ${code}`);
  return code as LanguageCode;
}

/**
 * The remembered enrollment if it is still held, else the newest. The list
 * arrives newest first. A remembered id that is gone — another device, a
 * reseeded server — is a convenience that expired, never an error.
 */
export function chooseActive(list: Enrollment[], rememberedId: string | null): Enrollment | null {
  return list.find((enrollment) => enrollment.id === rememberedId) ?? list[0] ?? null;
}

export function availableTargets(list: Enrollment[]): LanguageCode[] {
  const taken = new Set(list.map((enrollment) => enrollment.target_language));
  return ENROLLABLE_TARGETS.filter((code) => !taken.has(code));
}

export type LookupDirection = { from: LanguageCode; to: LanguageCode };

/** The translate screen opens on target → source: "I met this word". */
export function lookupDirection(enrollment: Enrollment): LookupDirection {
  return {
    from: asLanguageCode(enrollment.target_language),
    to: asLanguageCode(enrollment.source_language),
  };
}

export function flipped(direction: LookupDirection): LookupDirection {
  return { from: direction.to, to: direction.from };
}
```

- [ ] **Step 4: The remembered store.** Append to `apps/mobile/src/currentUser.ts`:

```ts
const ENROLLMENT_KEY_PREFIX = 'lang-tutor:enrollment:';

/**
 * Remembers which enrollment each username last had active on this device —
 * the one piece of enrollment state that belongs to the device, exactly as the
 * username does. Keyed per username so two learners sharing a phone never
 * inherit each other's language. The enrollment list itself is never stored:
 * it is a server fact, read fresh at every login.
 */
export function createRememberedEnrollmentStore({ storage }: RememberedUsernameStoreDeps) {
  return {
    read: (username: string): Promise<string | null> =>
      storage.getItem(`${ENROLLMENT_KEY_PREFIX}${username}`),
    write: async (username: string, enrollmentId: string): Promise<void> => {
      await storage.setItem(`${ENROLLMENT_KEY_PREFIX}${username}`, enrollmentId);
    },
  };
}

export type RememberedEnrollmentStore = ReturnType<typeof createRememberedEnrollmentStore>;
```

- [ ] **Step 5: The client.** In `apps/mobile/src/api/client.ts`, add `CreateEnrollmentRequest` and `Enrollment` to the type import, add a GET helper beside `postJson`:

```ts
  async function getJson<TResponse>(path: string): Promise<TResponse> {
    const res = await fetch(`${baseUrl}${path}`, { method: 'GET' });
    if (!res.ok) throw new ApiError(res.status);
    return (await res.json()) as TResponse;
  }
```

and add to the returned object:

```ts
    listEnrollments: (userId: string) =>
      getJson<Enrollment[]>(`/api/users/${encodeURIComponent(userId)}/enrollments`),
    createEnrollment: (userId: string, request: CreateEnrollmentRequest) =>
      postJson<Enrollment>(`/api/users/${encodeURIComponent(userId)}/enrollments`, request),
```

- [ ] **Step 6: Run them to make sure they pass**

Run: `npm test --workspace apps/mobile`
Expected: PASS for these files. (`typecheck` is still red until Task 11.)

- [ ] **Step 7: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): enrollment rules, remembered active enrollment, enrollment API calls"
```

---

### Task 10: Mobile — enrollment state, routing, the enroll screen and the switcher

Spec §5: current user, which enrollment is active, routing, the switcher, and session/profile/strings.

**Files:**
- Modify: `apps/mobile/src/hooks/useCurrentUser.tsx`, `hooks/useSession.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx`, `index.tsx`, `onboarding.tsx`, `profile.tsx`, `session.tsx`
- Create: `apps/mobile/src/app/enroll.tsx`
- Modify: `apps/mobile/src/strings.ts`

**Interfaces:**
- Consumes: Task 9's helpers, store and client.
- Produces: `useCurrentUser()` returns `{ user, enrollments: Enrollment[], active: Enrollment | null, rememberedUsername, login, register, signOut, enroll(target: LanguageCode): Promise<void>, switchTo(enrollmentId: string): void }`; `CurrentUserProvider` takes an `enrollmentStore` prop. Test IDs: `enrollment-switcher`, `enrollment-option-<code>`, `enrollment-add`, `enroll-<code>`, `enroll-submit`, `enroll-error`, `session-back`.

- [ ] **Step 1: Strings.** In `apps/mobile/src/strings.ts`:
  - move the language-name lookup above `strings` so other entries can use it;
  - give it Russian;
  - replace the entries `homeSetLabel`, `languageName` and `translateDirection`;
  - delete `onboardingSameLanguage`;
  - add the new keys.

```ts
const LANGUAGE_NAMES: Record<string, string> = { he: 'עברית', en: 'אנגלית', ru: 'רוסית' };
const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;
```

```ts
  homeSetLabel: (count: number, language: string) => `${count} מילים ב${language}`,
  languageName,
  translateDirection: (from: string, to: string) => `מ${languageName(from)} ל${languageName(to)}`,
  learningLabel: (language: string) => `לומד/ת: ${language}`,
  addLanguage: 'הוספת שפה',
  enrollTitle: 'בחירת שפה ללימוד',
  enrollExplanation: 'ההסברים יהיו בעברית',
  enrollSubmit: 'התחלה',
  enrollFailed: 'ההרשמה נכשלה, נסו שוב',
  sessionNoQuestions: 'אין עדיין שאלות בשפה הזו',
  translateWrongDirection: (language: string) => `נראה שזו מילה ב${language}`,
  translateFlipRetry: 'החלף כיוון',
  translateOutOfPair: (language: string) => `זו לא מילה ב${language}`,
```

- [ ] **Step 2: Current-user state.** In `apps/mobile/src/hooks/useCurrentUser.tsx`:
  - import `Enrollment` and `LanguageCode` types;
  - import `ApiError` from `@/api/client`;
  - import `type RememberedEnrollmentStore` from `@/currentUser`;
  - import `chooseActive` from `@/enrollments`;
  - extend `CurrentUserValue` per the Interfaces block.

Then change the provider:

```tsx
export function CurrentUserProvider({
  api,
  usernameStore,
  enrollmentStore,
  children,
}: {
  api: ApiClient;
  usernameStore: RememberedUsernameStore;
  enrollmentStore: RememberedEnrollmentStore;
  children: ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rememberedUsername, setRememberedUsername] = useState('');

  useEffect(() => {
    void usernameStore.read().then(setRememberedUsername);
  }, [usernameStore]);

  // The user is set LAST, after the enrollments are in: every screen routes on
  // `user` first, so setting it early would flash home before the enroll
  // screen for a learner with none.
  const adopt = useCallback(
    async (next: User) => {
      const [list, rememberedId] = await Promise.all([
        api.listEnrollments(next.id),
        enrollmentStore.read(next.username),
      ]);
      setEnrollments(list);
      setActiveId(chooseActive(list, rememberedId)?.id ?? null);
      setUser(next);
      setRememberedUsername(next.username);
      await usernameStore.write(next.username);
    },
    [api, usernameStore, enrollmentStore],
  );
```

Keep `login` and `register` as they are. Add:

```tsx
  // A 409 means the enrollment already exists — a double tap, or another
  // device — which is the outcome the learner asked for, so it is adopted
  // rather than shown as a failure.
  const enroll = useCallback(
    async (target: LanguageCode) => {
      if (!user) throw new Error('cannot enroll with no current user');
      let created: Enrollment | undefined;
      try {
        created = await api.createEnrollment(user.id, { source_language: 'he', target_language: target });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
      const list = await api.listEnrollments(user.id);
      const chosen = created ?? list.find((enrollment) => enrollment.target_language === target) ?? null;
      setEnrollments(list);
      if (chosen) {
        setActiveId(chosen.id);
        await enrollmentStore.write(user.username, chosen.id);
      }
    },
    [api, user, enrollmentStore],
  );

  const switchTo = useCallback(
    (enrollmentId: string) => {
      setActiveId(enrollmentId);
      if (user) void enrollmentStore.write(user.username, enrollmentId);
    },
    [user, enrollmentStore],
  );

  const signOut = useCallback(() => {
    setUser(null);
    setEnrollments([]);
    setActiveId(null);
  }, []);

  const active = useMemo(
    () => enrollments.find((enrollment) => enrollment.id === activeId) ?? null,
    [enrollments, activeId],
  );

  const value = useMemo(
    () => ({ user, enrollments, active, rememberedUsername, login, register, signOut, enroll, switchTo }),
    [user, enrollments, active, rememberedUsername, login, register, signOut, enroll, switchTo],
  );
```

Keep the existing comment on `signOut`.

- [ ] **Step 3: Layout.** In `apps/mobile/src/app/_layout.tsx`, import `createRememberedEnrollmentStore`, add `const enrollmentStore = createRememberedEnrollmentStore({ storage: AsyncStorage });` beside `usernameStore`, and pass `enrollmentStore={enrollmentStore}` to `CurrentUserProvider`.

- [ ] **Step 4: The enroll screen** — `apps/mobile/src/app/enroll.tsx`:

```tsx
import type { LanguageCode } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { availableTargets } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Reached from sign-up, from any login that finds no enrollment, and from the
 * switcher's "add a language". One screen for all three, so a sign-up whose
 * second call never landed is simply a learner who has not enrolled yet.
 */
export default function EnrollScreen() {
  const { user, enrollments, enroll } = useCurrentUser();
  const targets = availableTargets(enrollments);
  const [picked, setPicked] = useState<LanguageCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return <Redirect href="/login" />;
  if (targets.length === 0) return <Redirect href="/" />;

  const selected = picked && targets.includes(picked) ? picked : targets[0];

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await enroll(selected);
      router.replace('/');
    } catch {
      setError(strings.enrollFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.enrollTitle}</Text>
      <Text style={styles.hint}>{strings.enrollExplanation}</Text>

      <View style={styles.choiceRow}>
        {targets.map((code) => (
          <Pressable
            key={code}
            accessibilityRole="button"
            accessibilityState={{ selected: selected === code }}
            testID={`enroll-${code}`}
            onPress={() => setPicked(code)}
            style={[styles.choice, selected === code && styles.choiceSelected]}
          >
            <Text style={[styles.choiceLabel, selected === code && styles.choiceLabelSelected]}>
              {strings.languageName(code)}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <Text testID="enroll-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="enroll-submit"
        onPress={onSubmit}
        disabled={busy}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.enrollSubmit}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  hint: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  choiceRow: { flexDirection: 'row', gap: spacing.sm },
  choice: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  choiceSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceLabel: { fontSize: fontSizes.md, color: colors.text },
  choiceLabelSelected: { color: colors.onPrimary, fontWeight: '700' },
  error: { fontSize: fontSizes.md, color: colors.wrong, writingDirection: 'rtl' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
```

- [ ] **Step 5: Home — routing and the switcher.** In `apps/mobile/src/app/index.tsx`:

```tsx
export default function HomeScreen() {
  const { start } = useSession();
  const { user, enrollments, active, switchTo } = useCurrentUser();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  if (!user) return <Redirect href="/login" />;
  // Zero enrollments is a valid state (spec §5): sign-up, a login that finds
  // none, or a sign-up whose second call never landed all arrive here.
  if (!active) return <Redirect href="/enroll" />;

  const canAdd = availableTargets(enrollments).length > 0;
```

(import `useState` from `react` and `availableTargets` from `@/enrollments`).

Between the profile link and the card, add:

```tsx
      <Pressable
        accessibilityRole="button"
        testID="enrollment-switcher"
        onPress={() => setSwitcherOpen((open) => !open)}
        style={styles.switcher}
      >
        <Text style={styles.switcherLabel}>
          {strings.learningLabel(strings.languageName(active.target_language))}
        </Text>
      </Pressable>

      {switcherOpen ? (
        <View style={styles.switcherList}>
          {enrollments.map((enrollment) => (
            <Pressable
              key={enrollment.id}
              accessibilityRole="button"
              accessibilityState={{ selected: enrollment.id === active.id }}
              testID={`enrollment-option-${enrollment.target_language}`}
              onPress={() => {
                switchTo(enrollment.id);
                setSwitcherOpen(false);
              }}
              style={[styles.switcherItem, enrollment.id === active.id && styles.switcherItemActive]}
            >
              <Text style={styles.switcherItemLabel}>
                {strings.languageName(enrollment.target_language)}
              </Text>
            </Pressable>
          ))}
          {canAdd ? (
            <Pressable
              accessibilityRole="button"
              testID="enrollment-add"
              onPress={() => {
                setSwitcherOpen(false);
                router.push('/enroll');
              }}
              style={styles.switcherItem}
            >
              <Text style={styles.switcherAddLabel}>{strings.addLanguage}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
```

Change the card label to `strings.homeSetLabel(SESSION_LENGTH, strings.languageName(active.target_language))`, and add the styles:

```ts
  switcher: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  switcherLabel: { color: colors.text, fontSize: fontSizes.md, fontWeight: '700', writingDirection: 'rtl' },
  switcherList: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  switcherItem: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  switcherItemActive: { backgroundColor: colors.background },
  switcherItemLabel: { color: colors.text, fontSize: fontSizes.md, writingDirection: 'rtl' },
  switcherAddLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700', writingDirection: 'rtl' },
```

- [ ] **Step 6: Onboarding.** In `apps/mobile/src/app/onboarding.tsx`:
  - delete the `targetLanguage` state, the same-language check, the target `<Text>`/`<LanguageChoice>` pair, and `target_language` from the `register` call;
  - narrow `LanguageChoice`'s `prefix` type to `'native'`.

After `register`, the existing `if (user) return <Redirect href="/" />` lands on home, which redirects to `/enroll`.

- [ ] **Step 7: Profile.** In `apps/mobile/src/app/profile.tsx`, take `enrollments` from `useCurrentUser()`, and change the `profile-target` row's value to:

```tsx
          value={enrollments.map((enrollment) => strings.languageName(enrollment.target_language)).join(', ')}
```

- [ ] **Step 8: Session start.** In `apps/mobile/src/hooks/useSession.tsx`:
  - take `active` from `useCurrentUser()` and mirror it into an `activeRef`, as `userRef` is;
  - give `handleApiFailure` a message parameter: `function handleApiFailure(message: string = strings.errorMessage)`. This is not a collaborator, so ADR 0002 R5 does not apply;
  - in `start`, replace the user lookup and the request, and the `catch`:

```tsx
        const currentUser = userRef.current;
        const enrollment = activeRef.current;
        if (!currentUser || !enrollment) throw new Error('cannot start a session with no active enrollment');
        const userId = currentUser.id;
        const response = await api.createSession({ enrollment_id: enrollment.id });
```

```tsx
      } catch (error) {
        handleApiFailure(
          error instanceof ApiError && error.status === 409 ? strings.sessionNoQuestions : undefined,
        );
      }
```

(import `ApiError` from `@/api/client`).

In `apps/mobile/src/app/session.tsx`, add `testID="session-back"` to the header's back `Pressable`.

- [ ] **Step 9: Typecheck what this task touched**

Run: `npm test --workspace apps/mobile && npx tsc --noEmit -p apps/mobile 2>&1 | grep -v "useTranslation\|translate.tsx" | head -40`
Expected: unit tests PASS. The only remaining type errors are in `hooks/useTranslation.tsx` and `app/translate.tsx` (Task 11).

- [ ] **Step 10: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): enrollment state, the enroll screen and the switcher"
```

---

### Task 11: Mobile — the translate screen speaks `from` and `to`

Spec §5, "Translate".

**Files:**
- Modify: `apps/mobile/src/hooks/useTranslation.tsx`
- Modify: `apps/mobile/src/app/translate.tsx`

**Interfaces:**
- Consumes: Task 9's `lookupDirection`, `flipped`, `LookupDirection`; Task 10's `active`.
- Produces: `useTranslation()` gains `direction: LookupDirection | null` and `flipAndRetry(): void`. `flip()` now always swaps the direction; when a sense is on screen it also moves that sense into the box and looks it up. Test IDs: `translate-direction`, `translate-flip` (now always visible), `translate-flip-retry`, `translate-out-of-pair`.

- [ ] **Step 1: The hook.** In `apps/mobile/src/hooks/useTranslation.tsx`:
  - drop `TranslationDirection` from the import;
  - import `useEffect`, `useCurrentUser`, and `{ flipped, lookupDirection, type LookupDirection }` from `@/enrollments`;
  - add to `TranslationValue`, next to the `flip` doc:

```ts
  /** The lookup's direction; null only with no active enrollment. */
  direction: LookupDirection | null;
  /**
   * The `wrong_direction` answer's one-tap fix: the same text, the other way
   * round. Distinct from `flip`, which moves a SHOWN translation into the box —
   * here there is none, and the typed text is what was meant.
   */
  flipAndRetry: () => void;
```

  - update `flip`'s doc: `Swaps the direction. When a sense is on screen it also moves into the box and is looked up the other way round, so the label always describes the text that produced the results; with nothing on screen only the direction changes.`

In the provider:

```tsx
  const { active } = useCurrentUser();
  const [direction, setDirection] = useState<LookupDirection | null>(
    active ? lookupDirection(active) : null,
  );

  // A switch of enrollment is a new pair: start over on its target → source.
  useEffect(() => {
    setDirection(active ? lookupDirection(active) : null);
    setStatus('idle');
    setText('');
    setResult(undefined);
    setChosenIndex(null);
  }, [active]);

  const run = useCallback(
    async (query: string, along: LookupDirection | null) => {
      const trimmed = query.trim();
      if (!along || trimmed.length === 0 || trimmed.length > 100) return;

      setStatus('loading');
      setChosenIndex(null);
      try {
        const response = await api.translate({ text: trimmed, from: along.from, to: along.to });
        setResult(response);
        setStatus(response.senses.length === 0 ? 'empty' : 'answered');
      } catch (error) {
        void (error instanceof ApiError);
        setResult(undefined);
        setStatus('error');
      }
    },
    [api],
  );
```

(keep the existing comments inside `run`'s `catch`). In `value`:

```tsx
      direction,
      submit: (override?: string) => void run(override ?? text, direction),
      flip: () => {
        if (!direction) return;
        const next = flipped(direction);
        setDirection(next);
        const sense = result?.senses[chosenIndex ?? 0];
        if (result && sense) {
          setText(sense.translation);
          void run(sense.translation, next);
        }
      },
      flipAndRetry: () => {
        if (!direction) return;
        const next = flipped(direction);
        setDirection(next);
        void run(text, next);
      },
```

Add `direction` to the `useMemo` deps.

- [ ] **Step 2: The screen.** In `apps/mobile/src/app/translate.tsx`:
  - import `Redirect` from `expo-router`;
  - after `const t = useTranslation();`, return `<Redirect href="/" />` when `!t.direction`;
  - move the direction row out of the `answered` branch, to directly above the `TextInput`:

```tsx
      <View style={styles.directionRow}>
        <Text testID="translate-direction" style={styles.directionLabel}>
          {strings.translateDirection(t.direction.from, t.direction.to)}
        </Text>
        <Pressable accessibilityRole="button" testID="translate-flip" onPress={t.flip}>
          <Text style={styles.link}>{strings.translateFlip}</Text>
        </Pressable>
      </View>
```

  - delete the old copy inside the `answered` `ScrollView`;
  - replace the `empty` branch:

```tsx
      {t.status === 'empty' ? (
        <View testID="translate-empty" style={styles.notice}>
          {t.result?.reason === 'wrong_direction' ? (
            <>
              <Text style={styles.noticeText}>
                {strings.translateWrongDirection(strings.languageName(t.direction.to))}
              </Text>
              <Pressable accessibilityRole="button" testID="translate-flip-retry" onPress={t.flipAndRetry}>
                <Text style={styles.link}>{strings.translateFlipRetry}</Text>
              </Pressable>
            </>
          ) : t.result?.reason === 'out_of_pair' ? (
            <Text testID="translate-out-of-pair" style={styles.noticeText}>
              {strings.translateOutOfPair(strings.languageName(t.direction.from))}
            </Text>
          ) : (
            <Text style={styles.noticeText}>{strings.translateEmpty}</Text>
          )}
        </View>
      ) : null}
```

The `TextInput` stays unforced in direction: its existing comment explains why, and Cyrillic follows its content like Latin does.

- [ ] **Step 3: Typecheck and unit tests**

Run: `npm test --workspace apps/mobile && npm run typecheck --workspace apps/mobile && npm run lint --workspace apps/mobile && npm run lint:arch`
Expected: PASS, no type errors, lint clean.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): the translate screen states its direction and answers a refused lookup"
```

---

### Task 12: e2e — enrolled learners, the Russian flow and switching

Spec §6, "e2e".

**Files:**
- Modify: `e2e/tests/support/users.ts`
- Modify: `e2e/tests/onboarding.spec.ts`, `e2e/tests/translate.spec.ts`
- Create: `e2e/tests/enrollments.spec.ts`

**Interfaces:**
- Consumes: every test ID from Tasks 10–11; e2e `expectGemini`, `clearGemini`.
- Produces: `createLearner(request, username, targetLanguage?: 'en' | 'ru')`. It defaults to `en`, which ADR 0002's R5 does not scan in `e2e/`.

- [ ] **Step 1: Support.** In `e2e/tests/support/users.ts`:
  - `learnerFor` loses `target_language`;
  - `createLearner` becomes:

```ts
/** Creates a learner AND their enrollment over the endpoints the app uses. No
 *  fixture seed and no test-only route: this is the production path. */
export async function createLearner(
  request: APIRequestContext,
  username: string,
  targetLanguage: 'en' | 'ru' = 'en',
): Promise<User> {
  const res = await request.post(`${API_URL}/api/users`, { data: learnerFor(username) });
  if (!res.ok()) {
    throw new Error(`could not create ${username}: ${res.status()} ${await res.text()}`);
  }
  const user = (await res.json()) as User;
  const enrolled = await request.post(`${API_URL}/api/users/${user.id}/enrollments`, {
    data: { source_language: 'he', target_language: targetLanguage },
  });
  if (!enrolled.ok()) {
    throw new Error(`could not enroll ${username}: ${enrolled.status()} ${await enrolled.text()}`);
  }
  return user;
}
```

- [ ] **Step 2: Onboarding spec.** In `e2e/tests/onboarding.spec.ts`'s first test, delete `await page.getByTestId('target-en').click();` and, after `onboarding-submit`, add:

```ts
  // A new learner holds no enrollment yet, so the app asks for one first.
  await expect(page.getByTestId('enroll-en')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('enroll-en').click();
  await page.getByTestId('enroll-submit').click();
```

- [ ] **Step 3: Translate spec.** In `e2e/tests/translate.spec.ts`, widen the label locator so it covers Russian:

```ts
const directionLabel = (page: Page) => page.getByTestId('translate-direction');
```

The swap test's assertions (`'מאנגלית לעברית'`, then `'מעברית לאנגלית'`) stay as they are.

- [ ] **Step 4: The new spec** — `e2e/tests/enrollments.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';

import { clearGemini, expectGemini } from './support/mockServer';
import { createLearner, logIn } from './support/users';

test.setTimeout(120_000);

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

async function startSession(page: Page) {
  await expect(async () => {
    await page.getByTestId('start-button').click();
    await expect(page.getByTestId('progress-label')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function openTranslate(page: Page) {
  await expect(async () => {
    await page.getByTestId('translate-entry').click();
    await expect(page.getByTestId('translate-input')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('a Russian learner gets a Russian session', async ({ page, request }) => {
  await createLearner(request, 'e2e_ru_session', 'ru');
  await logIn(page, 'e2e_ru_session');

  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: רוסית');
  await startSession(page);
  await expect(page.getByTestId('question-prompt')).toHaveText(CYRILLIC);
});

test('a Russian lookup opens ru → he, is served from the seed, and flips to he → ru', async ({
  page,
  request,
}) => {
  // Only the flipped lookup reaches the model: окно is seeded.
  await expectGemini(request, {
    kind: 'word',
    entries: [
      {
        lemma: 'חלון',
        part_of_speech: 'noun',
        senses: [
          {
            translation: 'окно',
            example: { source: 'פתחתי את החלון.', target: 'Я открыл окно.' },
            sense_code: 'window_opening',
          },
        ],
      },
    ],
  });
  await createLearner(request, 'e2e_ru_lookup', 'ru');
  await logIn(page, 'e2e_ru_lookup');
  await openTranslate(page);

  await expect(page.getByTestId('translate-direction')).toHaveText('מרוסית לעברית');
  await page.getByTestId('translate-input').fill('окно');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-sense').first()).toBeVisible();

  await page.getByTestId('translate-flip').click();
  await expect(page.getByTestId('translate-direction')).toHaveText('מעברית לרוסית');
  await expect(page.getByTestId('translate-input')).not.toHaveValue('окно');
  await expect(page.getByText('окно', { exact: true })).toBeVisible();
});

test('Hebrew typed under ru → he offers a one-tap flip', async ({ page, request }) => {
  await expectGemini(request, {
    kind: 'word',
    entries: [
      {
        lemma: 'שלום',
        part_of_speech: 'interjection',
        senses: [
          {
            translation: 'привет',
            example: { source: 'שלום, מה נשמע?', target: 'Привет, как дела?' },
            sense_code: 'greeting',
          },
        ],
      },
    ],
  });
  await createLearner(request, 'e2e_ru_wrong_way', 'ru');
  await logIn(page, 'e2e_ru_wrong_way');
  await openTranslate(page);

  await page.getByTestId('translate-input').fill('שלום');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-flip-retry')).toBeVisible();

  await page.getByTestId('translate-flip-retry').click();
  await expect(page.getByTestId('translate-direction')).toHaveText('מעברית לרוסית');
  await expect(page.getByText('привет', { exact: true })).toBeVisible();
});

test('a learner adds English, switches both ways, and the choice survives signing in again', async ({
  page,
  request,
}) => {
  await createLearner(request, 'e2e_switcher', 'ru');
  await logIn(page, 'e2e_switcher');

  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-add').click();
  await page.getByTestId('enroll-en').click();
  await page.getByTestId('enroll-submit').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: אנגלית');

  await startSession(page);
  await expect(page.getByTestId('question-prompt')).toHaveText(LATIN);
  await page.getByTestId('session-back').click();

  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-option-ru').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: רוסית');
  await startSession(page);
  await expect(page.getByTestId('question-prompt')).toHaveText(CYRILLIC);
  await page.getByTestId('session-back').click();

  await openTranslate(page);
  await expect(page.getByTestId('translate-direction')).toHaveText('מרוסית לעברית');
  await page.getByTestId('translate-back').click();

  // Every adding of a language is remembered; the last switch was to Russian.
  await page.getByTestId('profile-button').click();
  await page.getByTestId('switch-user-button').click();
  await logIn(page, 'e2e_switcher');
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: רוסית');
});
```

- [ ] **Step 5: Run the e2e suite**

Run: `npm run typecheck --workspace e2e && npm run e2e`
Expected: every spec passes, old and new. If `logIn` fails in the last test because the login screen prefills the username, it still works: `fill` overwrites.

- [ ] **Step 6: Commit**

```bash
git add e2e
git commit -m "test(e2e): enrolled learners, the Russian flow and switching"
```

---

### Task 13: Documentation and the whole-branch check

**Files:**
- Modify: `docs/adr/adr-0002-di-with-closures.md` (R6's factory list)
- Modify: any README or doc that `grep` finds describing `target_language` on a user, or `direction` on a lookup, as current behaviour

- [ ] **Step 1: ADR 0002 R6.** In `docs/adr/adr-0002-di-with-closures.md`, add `createEnrollmentRepo` (after `createUserRepo`), `createEnrollmentService` (after `createUserService`) and `createRememberedEnrollmentStore` (after `createRememberedUsernameStore`) to R6's factory list.

- [ ] **Step 2: Stale docs.** Run:

```bash
grep -rn "target_language\|he_en\|en_he\|detectDirection\|TranslationDirection" README.md docs/adr apps/*/README.md 2>/dev/null
```

Update every hit that describes current behaviour. Leave historical specs and plans under `docs/superpowers/` untouched; they record their phase.

- [ ] **Step 3: Whole-repo verification**

```bash
npm run typecheck && npm run test:all && npm run lint:arch && npm run e2e && npm run eval
```

Expected: everything green; `lint:arch` prints nothing; tier 1 has 0 failures and tier 2 meets the threshold. Paste the summary lines into the PR description.

- [ ] **Step 4: Spec cross-check.** Open the spec's "Done means" list and tick each item against a test:
  1. Task 12's first Russian test, plus Task 7's seed, covers criterion 1;
  2. Task 12's lookup tests cover criterion 2;
  3. Task 12's switching test, plus Task 3's two-enrollment route test, covers criterion 3;
  4. Task 3's migration test covers criterion 4;
  5. Step 3 above covers criterion 5.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: phase 16 factories in ADR 0002; current-behaviour docs follow enrollments"
```

- [ ] **Step 6: Hand off.** Use `superpowers:finishing-a-development-branch`, then `git-create-pr` when Victor asks for the PR.
