# Phase 22 — Italian as a target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Hebrew speaker can enroll in Italian and use it exactly as Russian is used: seeded first
session, lookups both ways, saving, list-built sessions.

**Architecture:** Italian is one entry in the server's language table plus one value in the wire
enum. Every prompt, guard and seed reader already reads that table. Beyond the entry, the phase is
data: a widened database check, ten seeded rows with real recordings, two map entries in the app,
and tests at every layer.

**Tech Stack:** TypeScript, Hono + zod-openapi, Drizzle + Postgres, Jest (unit and integration
projects), Gemini evals (`tests/eval/`), Expo / React Native, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-06-lang-tutor-phase-22-italian-design.md`

## Global Constraints

- Language code `it`, English name `Italian`, Hebrew name `איטלקית`.
- Italian is a target only: `NativeLanguageSchema` and `EnrollmentSourceSchema` do not change.
- No rule string in `domain/languages.ts` may contain the substrings `see` or `saw` (MockServer
  matches the request body). This also rules out words such as `seem`, `seen` and `seed`.
- No Italian rule may mention Russian, and no en/he prompt may mention Italian.
- `TIER2_THRESHOLD` is never lowered. A failing Italian eval case changes the Italian rule text.
- Never hardcode a port or a database name (ADR 0006).
- This worktree has no lane, because all nine slots are taken. Unit tests, typecheck, `lint:arch`
  and evals run locally. Integration and e2e run in CI only.

## Review Focus

1. **An unaccented spelling that is a real word** (`se`, `papa`) must not be "corrected" to its
   accented twin. A redirect would be permanent. Pinned by the counterweight eval cases in Task 3.
2. **An input made only of accented letters** (`è`) must pass the guard, because one Latin letter
   is enough. Pinned in Task 1.
3. **Accents must survive normalisation** (`perché`, `città`, and `perché?` → `perché`). Otherwise
   `perche` and `perché` would collapse into one key and the correction path could never fire.
   Pinned in Task 1.
4. **An English learner's session must never draw Italian seed rows.** Both are Latin script, so
   the existing script regex cannot tell them apart. Pinned in Task 5 with exact query sets.
5. **A `--pair`-only recorder run must not drop other pairs' recordings.** It would empty
   `content.generated.ts` outside the pair and break the seed. Fixed and exercised in Task 4.

---

### Task 1: Italian in the language table and on the wire

**Files:**
- Modify: `apps/server/src/domain/languages.ts`
- Modify: `packages/core/src/api/schemas.ts:189`
- Test: `apps/server/src/domain/languages.test.ts`, `apps/server/src/domain/translation.test.ts`,
  `apps/server/src/domain/dictionary.test.ts`, `apps/server/src/domain/distractors.test.ts`,
  `packages/core/src/api/schemas.test.ts`

**Interfaces:**
- Produces: `LanguageCode = 'he' | 'en' | 'ru' | 'it'` (server domain), and
  `LanguageCodeSchema = z.enum(['he', 'en', 'ru', 'it'])` (core). `LANGUAGES.it`.

- [ ] **Step 1: Write the failing tests**

`languages.test.ts`: add to `describe('guardScript')`:

```ts
  it('reads Italian as Latin script, accents included', () => {
    expect(guardScript('perché', 'it', 'he')).toBe('pass');
    expect(guardScript('città', 'it', 'he')).toBe('pass');
    // One accented letter alone is still one Latin letter.
    expect(guardScript('è', 'it', 'he')).toBe('pass');
    expect(guardScript('חלון', 'it', 'he')).toBe('wrong_direction');
    expect(guardScript('finestra', 'he', 'it')).toBe('wrong_direction');
    expect(guardScript('окно', 'it', 'he')).toBe('out_of_pair');
  });

  it('cannot tell English from Italian, and leaves that to the model (spec D2)', () => {
    expect(guardScript('window', 'it', 'he')).toBe('pass');
  });
```

and change the `LANGUAGES` key assertion to `['en', 'he', 'it', 'ru']`.

`translation.test.ts`, in `describe('prompts assembled from the language table')`: widen both
helpers' parameter types to `LanguageCode` (import `type LanguageCode` from `./languages`), then
add:

```ts
  it('names Italian as the learned language in both directions', () => {
    expect(system('it', 'he')).toContain(
      'You translate from Italian to Hebrew for a Hebrew-speaking learner of Italian.',
    );
    expect(system('he', 'it')).toContain(
      'You translate from Hebrew to Italian for a Hebrew-speaking learner of Italian.',
    );
  });

  it("carries Italian's rules exactly where they apply", () => {
    // Reading rules: only when Italian is the source.
    expect(system('it', 'he')).toContain('"scrivevo" belongs to "scrivere"');
    expect(system('it', 'he')).toContain('typed without its written accent is a misspelling');
    expect(system('he', 'it')).not.toContain('"scrivevo"');
    // The past-tense rule: only when Italian is the target.
    expect(system('he', 'it')).toContain('passato prossimo');
    expect(system('it', 'he')).not.toContain('passato prossimo');
    // Writing rules: both directions.
    expect(system('it', 'he')).toContain('grave or acute');
    expect(system('he', 'it')).toContain('grave or acute');
    expect(rendering('it', 'he')).toContain('"scrivevo" belongs to "scrivere"');
    expect(rendering('it', 'he')).toContain('grave or acute');
  });

  it('keeps Italian out of every other pair', () => {
    for (const prompt of [system('en', 'he'), system('he', 'en'), system('ru', 'he'), system('he', 'ru')]) {
      expect(prompt).not.toContain('Italian');
    }
    expect(system('it', 'he')).not.toContain('Russian');
  });
```

and add `system('it', 'he')`, `system('he', 'it')`, `rendering('it', 'he')` to the list in
`'never contains an unquoted registered matchText'`.

`dictionary.test.ts`: add

```ts
describe('normalizeForm and Italian accents', () => {
  it('keeps an accent: it is spelling, and e and è are two words', () => {
    expect(normalizeForm('perché')).toBe('perché');
    expect(normalizeForm('città')).toBe('città');
    expect(normalizeForm('è')).toBe('è');
  });

  it('strips trailing punctuation without touching the accent', () => {
    expect(normalizeForm('perché?')).toBe('perché');
  });
});
```

`distractors.test.ts`: add

```ts
describe('buildDistractorPrompt for Italian', () => {
  it('names Italian and Hebrew', () => {
    const prompt = buildDistractorPrompt({ items: ITEMS, from: 'it', to: 'he' });
    expect(prompt.system).toContain('Italian');
    expect(prompt.system).toContain('Hebrew');
  });
});
```

`schemas.test.ts`: in `'requires from and to, and accepts only pairs that include Hebrew'` add

```ts
    expect(ok('it', 'he')).toBe(true);
    expect(ok('he', 'it')).toBe(true);
    expect(ok('en', 'it')).toBe(false);
    expect(ok('ru', 'it')).toBe(false);
```

and rename `'accepts a Hebrew-explained enrollment in English or Russian'` to
`'accepts a Hebrew-explained enrollment in English, Russian or Italian'`, adding

```ts
    expect(CreateEnrollmentRequestSchema.safeParse({ source_language: 'he', target_language: 'it' }).success).toBe(true);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd apps/server && npx jest --selectProjects unit` and `cd packages/core && npx jest`
Expected: type errors and failures on `'it'`.

- [ ] **Step 3: Implement**

`packages/core/src/api/schemas.ts`:

```ts
export const LanguageCodeSchema = z.enum(['he', 'en', 'ru', 'it']);

// What a learner may name as their native language at sign-up. Russian and
// Italian are targets only.
```

and update the pair comment to "Every supported pair includes Hebrew: {he,en}, {he,ru} and
{he,it}."

`apps/server/src/domain/languages.ts`: `export type LanguageCode = 'he' | 'en' | 'ru' | 'it';`,
the header comment's "names the same three codes" becomes "names the same codes", and a new
entry after `ru`:

```ts
  it: {
    code: 'it',
    name: 'Italian',
    // The same script as English. The guard cannot tell the two apart and
    // does not try: the client states the pair, and English typed under
    // it → he reaches the model's third-language rule (spec D2).
    letters: /\p{Script=Latin}/u,
    // The examples are deliberately not the eval cases (parlo, libri, bella,
    // perche, citta), so the eval measures the rule rather than the example.
    asSource: () => [
      'An Italian noun belongs to its singular, an adjective to its masculine singular, and a',
      'verb to its infinitive: "scrivevo" belongs to "scrivere", "case" to "casa", "rosse" to',
      '"rosso". A pronominal verb takes its -si infinitive: "mi chiamo" belongs to "chiamarsi".',
      // The counterpart of Russian's ё rule. Phone keyboards drop accents, and
      // phase 13's correction path is what turns `piu` into `più` for good.
      // The exception keeps `e` (and) from being "corrected" to `è` (is).
      'An Italian word typed without its written accent is a misspelling: correct "piu" to',
      '"più" and "gia" to "già". This does not apply when the unaccented spelling is itself a',
      'different word, as e is beside è and la beside là.',
    ],
    // Italian has several past tenses; the passato prossimo is the one of
    // everyday speech, which is what a beginner meets (spec D5).
    asTarget: [
      'For Italian past tense that citation form is the passato prossimo, third-person masculine',
      'singular: "ha scritto", "è partito".',
    ],
    writing: ['Write Italian with every accent its spelling has, grave or acute: però, così, più.'],
  },
```

- [ ] **Step 4: Run the tests to see them pass, and typecheck**

Run: `cd apps/server && npx jest --selectProjects unit && npx tsc --noEmit`, and
`cd packages/core && npx jest && npx tsc --noEmit`.
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain packages/core/src/api
git commit -m "feat: Italian in the language table and on the wire"
```

### Task 2: The database accepts an Italian enrollment; the API says so

**Files:**
- Modify: `apps/server/src/db/schema.ts:84`
- Create: `apps/server/src/db/migrations/0014_italian_target.sql` (drizzle-kit), plus its
  `meta/0014_snapshot.json` and the `_journal.json` entry
- Modify: `apps/server/src/app.ts:66`, `apps/server/src/routes/translations.ts:26-27`
- Test: `apps/server/src/openapi.test.ts`,
  `apps/server/tests/integration/repo/enrollments.test.ts`,
  `apps/server/tests/integration/routes/enrollments.test.ts`

- [ ] **Step 1: Write the failing tests**

`openapi.test.ts`, beside the existing translation-description tests:

```ts
  it('names every supported pair, Italian included', async () => {
    const doc = await loadDoc();
    expect(doc.paths['/api/translations'].post.description).toMatch(/Hebrew with Italian/);
    expect(doc.info.description).toMatch(/Italian/);
  });
```

(use the same doc-loading helper the neighbouring tests use).

`repo/enrollments.test.ts`:

```ts
  it('accepts an Italian enrollment at the database', async () => {
    const created = await repo((r) =>
      r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'it' }),
    );
    expect(created.target_language).toBe('it');
  });
```

`routes/enrollments.test.ts`:

```ts
  it('enrolls in Italian beside English, and only once', async () => {
    const app = buildTestApp();
    const res = await post(app, 'u_1', { source_language: 'he', target_language: 'it' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ source_language: 'he', target_language: 'it' });
    expect((await post(app, 'u_1', { source_language: 'he', target_language: 'it' })).status).toBe(409);
  });
```

- [ ] **Step 2: Run the unit test to see it fail**

Run: `cd apps/server && npx jest --selectProjects unit src/openapi.test.ts`
Expected: FAIL on `/Hebrew with Italian/`. The integration tests run in CI.

- [ ] **Step 3: Implement**

`schema.ts`: `check('enrollments_target_known', sql`${t.targetLanguage} in ('he', 'en', 'ru', 'it')`)`.
Run `cd apps/server && npx drizzle-kit generate --name italian_target`. It writes `0014_italian_target.sql`,
which drops and re-adds `enrollments_target_known`. Prepend this comment:

```sql
-- Phase 22. Italian is a language to learn: the enrollment target check widens.
-- No row changes, and no other column constrains a language code.
```

Then run `npx drizzle-kit check`.

`app.ts`: `'Practice sessions for Hebrew speakers learning English, Russian or Italian: …'`.
`routes/translations.ts`: `'English, Hebrew with Russian and Hebrew with Italian, either way. '`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/server && npx jest --selectProjects unit && npx tsc --noEmit && npx drizzle-kit check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db apps/server/src/app.ts apps/server/src/routes/translations.ts apps/server/src/openapi.test.ts apps/server/tests/integration/repo/enrollments.test.ts apps/server/tests/integration/routes/enrollments.test.ts
git commit -m "feat: the database and API accept an Italian enrollment"
```

### Task 3: Italian eval cases, run against the real model

**Files:**
- Modify: `apps/server/tests/eval/cases.ts`

- [ ] **Step 1: Add the cases**

After the `he → ru` case in `CASES`:

```ts
  // Phase 22 — Italian, explained in Hebrew. Each stresses one rule the Italian
  // entry added (spec §3). The prompt's own examples are different words, so
  // these measure the rules rather than recall of the examples.
  {
    label: 'it: a conjugated verb belongs to its infinitive',
    text: 'parlo',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['מדבר', 'אני מדבר', 'מדברת', 'אני מדברת', 'אני מדבר/ת', 'מדבר/ת'],
    expectLemma: 'parlare',
  },
  {
    label: 'it: a plural noun belongs to its singular',
    text: 'libri',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['ספרים', 'ספר'],
    expectLemma: 'libro',
  },
  {
    label: 'it: a feminine adjective belongs to its masculine singular',
    text: 'bella',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['יפה', 'יפהפייה', 'יפהפיה'],
    expectLemma: 'bello',
  },
  {
    label: 'it: an idiom by meaning, not word for word',
    text: 'in bocca al lupo',
    from: 'it',
    to: 'he',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה', 'בהצלחה!'],
    rejectAny: ['בפה של הזאב', 'בפי הזאב', 'בפה של זאב'],
  },
  {
    label: 'it: a missing accent is a misspelling, corrected to the word (perche)',
    text: 'perche',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['למה', 'מדוע', 'כי', 'מפני ש', 'מפני', 'בגלל ש', 'כיוון ש'],
    expectCorrection: 'perché',
  },
  {
    label: 'it: a missing accent is a misspelling, corrected to the word (citta)',
    text: 'citta',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['עיר'],
    expectCorrection: 'città',
  },
  // The counterweights, as все, берет and небо are to the ё rule: each is a real
  // word without its accent, so a misfiring rule writes a permanent redirect
  // away from a correctly spelled word.
  {
    label: 'it: an unaccented spelling that is itself a word is not a missing accent (se)',
    text: 'se',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['אם'],
    expectNoCorrection: true,
  },
  {
    label: 'it: an unaccented spelling that is itself a word is not a missing accent (papa)',
    text: 'papa',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['אפיפיור', 'האפיפיור', 'אבא'],
    expectNoCorrection: true,
  },
  {
    label: 'it: an English word is not Italian, though the guard passes it',
    text: 'window',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
  },
  {
    label: 'he → it: a Hebrew word rendered in Italian',
    text: 'חלון',
    from: 'he',
    to: 'it',
    expectKind: 'word',
    acceptTop: ['finestra'],
  },
  {
    label: 'he → it: a Hebrew past tense takes the passato prossimo',
    text: 'הלך',
    from: 'he',
    to: 'it',
    expectKind: 'word',
    acceptTop: ['è andato', 'ha camminato', 'è partito', "se n'è andato"],
    rejectTop: ['andò', 'andava', 'andare', 'camminò', 'camminare'],
  },
```

And in `DISTRACTOR_CASES`:

```ts
  {
    label: 'Italian words of four parts of speech',
    from: 'it',
    to: 'he',
    items: [
      { form: 'parlo', lemma: 'parlare', partOfSpeech: 'verb', translation: 'מדבר', synonyms: ['משוחח', 'אומר'] },
      { form: 'casa', lemma: 'casa', partOfSpeech: 'noun', translation: 'בית', synonyms: ['דירה', 'מעון'] },
      { form: 'sempre', lemma: 'sempre', partOfSpeech: 'adverb', translation: 'תמיד', synonyms: ['כל הזמן', 'לעולם'] },
      { form: 'bella', lemma: 'bello', partOfSpeech: 'adjective', translation: 'יפה', synonyms: ['נאה', 'יפהפייה'] },
    ],
  },
```

- [ ] **Step 2: Run the Italian cases against the real model, three times**

Run: `cd apps/server && npx tsx tests/eval/run.ts "it:"` and `npx tsx tests/eval/run.ts italian`
Expected: every Italian case passes tier 1. Tier 2 passes on all three runs, apart from a case
whose acceptTop set is too narrow for a correct answer. Widen that set only with a correct Hebrew
rendering. A wrong answer changes the rule text in `languages.ts` and re-runs the Task 1 tests.

- [ ] **Step 3: Run the full eval once**

Run: `cd apps/server && npx tsx tests/eval/run.ts`
Expected: exit 0, tier 2 ≥ 85%, with no existing case newly failing because of the Italian entry.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/eval/cases.ts apps/server/src/domain/languages.ts
git commit -m "test(eval): Italian translation and distractor cases"
```

### Task 4: The Italian seed

**Files:**
- Modify: `apps/server/tests/eval/generate-content.ts:120`
- Modify: `apps/server/src/db/content.ts`
- Modify: `apps/server/src/db/content.generated.ts` (by the recorder only)
- Test: `apps/server/src/db/content.test.ts`

- [ ] **Step 1: Fix the recorder's pair-only run**

`generate-content.ts`: a `--pair` run with no query must merge, not replace:

```ts
  // A pair narrows the run exactly as a query does, so it merges too: starting
  // empty would write the pair's recordings alone and drop every other pair's.
  const next: Record<string, LlmTranslation> = filter || pair ? { ...recorded } : {};
```

and update the comment above it to say "A filtered run (by query or by pair)".

- [ ] **Step 2: Write the failing test**

`content.test.ts`: the pair list becomes `['en-he', 'it-he', 'ru-he']`.

- [ ] **Step 3: Add the rows**

After the Russian rows in `content.ts`:

```ts
  // Phase 22. it → he, the Russian set's mix again: nouns, an adjective, a verb
  // and set phrases. Hebrew distractors are hand-written; no שלום beside
  // buongiorno or arrivederci, where it would be a second right answer.
  { from: 'it', to: 'he', query: 'finestra', question_id: 'q-it-finestra', distractors: ['דלת', 'קיר', 'תקרה'], correct_option: 1 },
  { from: 'it', to: 'he', query: 'libro', question_id: 'q-it-libro', distractors: ['מחברת', 'עיתון', 'מכתב'], correct_option: 3 },
  { from: 'it', to: 'he', query: 'acqua', question_id: 'q-it-acqua', distractors: ['חלב', 'מיץ', 'יין'], correct_option: 0 },
  { from: 'it', to: 'he', query: 'amico', question_id: 'q-it-amico', distractors: ['שכן', 'אח', 'מורה'], correct_option: 2 },
  { from: 'it', to: 'he', query: 'difficile', question_id: 'q-it-difficile', distractors: ['קל', 'מהיר', 'חשוב'], correct_option: 1 },
  { from: 'it', to: 'he', query: 'ricordare', question_id: 'q-it-ricordare', distractors: ['לשכוח', 'לחשוב', 'לדעת'], correct_option: 0 },
  { from: 'it', to: 'he', query: 'per favore', question_id: 'q-it-per-favore', distractors: ['תודה', 'סליחה', 'להתראות'], correct_option: 2 },
  { from: 'it', to: 'he', query: 'buongiorno', question_id: 'q-it-buongiorno', distractors: ['ערב טוב', 'לילה טוב', 'להתראות'], correct_option: 0 },
  { from: 'it', to: 'he', query: 'grazie mille', question_id: 'q-it-grazie-mille', distractors: ['בבקשה', 'סליחה רבה', 'להתראות'], correct_option: 3 },
  { from: 'it', to: 'he', query: 'arrivederci', question_id: 'q-it-arrivederci', distractors: ['ברוך הבא', 'תודה', 'בהצלחה'], correct_option: 1 },
```

- [ ] **Step 4: Record, and read the diff**

Run: `cd apps/server && npx tsx tests/eval/generate-content.ts --pair it-he`
Then `git diff --stat apps/server/src/db/content.generated.ts` shows insertions only (no `en-he:`
or `ru-he:` key removed), and `git diff` shows ten `it-he:` keys. For each, check that entry 0,
sense 0 is the expected meaning (חלון, ספר, מים, חבר, קשה, לזכור, בבקשה, בוקר טוב/שלום,
תודה רבה, להתראות), that no distractor equals it, and that no recording is a `sentence`. If one is
off, re-record that query alone (`… generate-content.ts <query>`), or adjust its distractors.

- [ ] **Step 5: Run the tests**

Run: `cd apps/server && npx jest --selectProjects unit && npx tsc --noEmit`
Expected: PASS. `content.test.ts` now covers the Italian rows (a recording each, ≥ 10 for the pair,
no distractor equal to the answer, queries Latin and options Hebrew).

- [ ] **Step 6: Commit**

```bash
git add apps/server/tests/eval/generate-content.ts apps/server/src/db/content.ts apps/server/src/db/content.generated.ts apps/server/src/db/content.test.ts
git commit -m "feat: seed ten Italian questions"
```

### Task 5: Integration — seed counts and session pair isolation

**Files:**
- Modify: `apps/server/tests/integration/db/seed.test.ts`
- Modify: `apps/server/tests/integration/routes/sessions.test.ts`

- [ ] **Step 1: Update the seed test**

Rename `'seeds ten ru → he questions and thirteen en → he'` to
`'seeds ten ru → he, ten it → he and thirteen en → he questions'`, adding
`expect(count('it')).toBe(10);`. In `'gives every variant its language…'` and
`'marks every seeded question shared…'`, `['en', 'ru']` becomes `['en', 'ru', 'it']`.

- [ ] **Step 2: Add the Italian isolation test**

`sessions.test.ts`, inside the describe holding `"draws each enrollment's own pair…"`. Import
`content` from `../../../src/db/content`. English and Italian share a script, so this test
compares against exact query sets, not scripts:

```ts
  it('draws Italian, never English, for a learner holding both', async () => {
    await seedEnrollment(t.db, { id: 'e_u_1_it', userId: 'u_1', targetLanguage: 'it' });
    const app = buildTestApp();
    const queriesOf = (from: string) =>
      new Set(content.filter((entry) => entry.from === from).map((entry) => entry.query));
    const walk = async (enrollmentId: string, expected: Set<string>) => {
      let current = await startSeed(app, enrollmentId);
      for (let i = 0; i < 10; i++) {
        expect(expected.has(current.question.question)).toBe(true);
        current = await (
          await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
            user_id: 'u_1',
            question_id: current.question.id,
            option_index: current.question.correct_option,
          })
        ).json();
      }
      expect(current.complete).toBe(true);
    };

    await walk('e_u_1_it', queriesOf('it'));
    await walk(enrollmentOf('u_1'), queriesOf('en'));
  });
```

- [ ] **Step 3: Typecheck, then commit**

Run: `cd apps/server && npx tsc --noEmit`. The integration bucket runs in CI.

```bash
git add apps/server/tests/integration/db/seed.test.ts apps/server/tests/integration/routes/sessions.test.ts
git commit -m "test(integration): Italian seed counts and session pair isolation"
```

### Task 6: The app offers Italian; e2e

**Files:**
- Modify: `apps/mobile/src/enrollments.ts:10-12`, `apps/mobile/src/strings.ts:14`
- Test: `apps/mobile/src/enrollments.test.ts`, create `apps/mobile/src/strings.test.ts`
- Modify: `e2e/tests/support/users.ts:20`, `e2e/tests/enrollments.spec.ts`

- [ ] **Step 1: Write the failing unit tests**

`enrollments.test.ts`: `availableTargets([])` and the legacy case expect `['en', 'ru', 'it']`, and
`availableTargets([ru])` expects `['en', 'it']`. `availableTargets([ru, en])` expects `['it']`.
Add:

```ts
const it_ = enrollment('e-it', 'it');
…
  it('opens an Italian enrollment on it → he', () => {
    expect(lookupDirection(it_)).toEqual({ from: 'it', to: 'he' });
  });
…
    expect(asLanguageCode('it')).toBe('it');
```

`strings.test.ts` (new):

```ts
import { describe, expect, it } from '@jest/globals';

import { strings } from './strings';

describe('language names', () => {
  it('names Italian in every composed string', () => {
    expect(strings.languageName('it')).toBe('איטלקית');
    expect(strings.translateDirection('it', 'he')).toBe('מאיטלקית לעברית');
    expect(strings.translateDirection('he', 'it')).toBe('מעברית לאיטלקית');
    expect(strings.translateOutOfPair(strings.languageName('it'))).toBe('זו לא מילה באיטלקית');
  });
});
```

(Use the module's actual export name for `strings`.)

- [ ] **Step 2: Run to see them fail**

Run: `cd apps/mobile && npx jest src/enrollments.test.ts src/strings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`enrollments.ts`: `ENROLLABLE_TARGETS = ['en', 'ru', 'it']`, `KNOWN = ['he', 'en', 'ru', 'it']`.
`strings.ts`: `{ he: 'עברית', en: 'אנגלית', ru: 'רוסית', it: 'איטלקית' }`.

- [ ] **Step 4: Run the mobile tests and typecheck**

Run: `cd apps/mobile && npx jest && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Add the e2e flows**

`users.ts`: `targetLanguage: 'en' | 'ru' | 'it' = 'en'`.

`enrollments.spec.ts`:

```ts
// Latin like English, so the Italian prompt is checked against the seeded
// queries themselves rather than a script.
const ITALIAN_SEED =
  /^(finestra|libro|acqua|amico|difficile|ricordare|per favore|buongiorno|grazie mille|arrivederci)$/;

test('a learner adds Italian from the switcher and gets an Italian session', async ({ page, request }) => {
  await createLearner(request, 'e2e_it_session', 'en');
  await logIn(page, 'e2e_it_session');

  await page.getByTestId('enrollment-switcher').click();
  await page.getByTestId('enrollment-add').click();
  await page.getByTestId('enroll-it').click();
  await page.getByTestId('enroll-submit').click();
  await expect(page.getByTestId('enrollment-switcher')).toHaveText('לומד/ת: איטלקית');

  await startSession(page);
  await expect(page.getByTestId('question-prompt')).toHaveText(ITALIAN_SEED);
});

test('an Italian lookup opens it → he and is served from the seed', async ({ page, request }) => {
  // No Gemini expectation is registered: finestra is seeded, and a flip with
  // nothing looked up changes the direction without a request.
  await createLearner(request, 'e2e_it_lookup', 'it');
  await logIn(page, 'e2e_it_lookup');
  await openTranslate(page);

  await expect(page.getByTestId('translate-direction')).toHaveText('מאיטלקית לעברית');
  await page.getByTestId('translate-flip').click();
  await expect(page.getByTestId('translate-direction')).toHaveText('מעברית לאיטלקית');
  await page.getByTestId('translate-flip').click();
  await expect(page.getByTestId('translate-direction')).toHaveText('מאיטלקית לעברית');

  await page.getByTestId('translate-input').fill('finestra');
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-sense').first()).toBeVisible();
});
```

- [ ] **Step 6: Typecheck e2e, then commit**

Run: `cd e2e && npx tsc --noEmit` (if it has a tsconfig), then:

```bash
git add apps/mobile/src e2e/tests
git commit -m "feat(mobile): offer Italian; e2e for an Italian learner"
```

### Task 7: Whole-branch checks, PR, CI

- [ ] `npm run lint:arch` from the worktree root.
- [ ] Unit suites of every workspace pass, and typecheck is clean.
- [ ] Update the spec's Status line to "Implemented on branch `phase-22-italian-target`", folding in
  any deviation (rule wording changed by evals, recordings re-recorded) as a note.
- [ ] Open the PR via `git-create-pr`, then `ci-green` until every job is green, the integration,
  e2e and eval jobs included.
