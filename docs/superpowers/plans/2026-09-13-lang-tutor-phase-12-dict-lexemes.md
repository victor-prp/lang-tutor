# Phase 12 — Lexemes, per-form translations and the dict_* rename: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `booked` return the verb senses of `book` rendered in the past tense (`הזמין`), not the noun `ספר` in the infinitive — by making a term a lexeme and a translation a property of the form.

**Architecture:** Three changes in one phase because they touch the same four tables and each needs a destructive migration. (1) The four tables are renamed `dict_*`. (2) `part_of_speech` moves from the sense up to the lexeme and joins its unique key, so an inflected form attaches to the lexeme whose part of speech it realises. (3) The translation, its example **and its rank** move from the sense down to the `(variant, sense)` pairing, so a form both renders and orders its senses its own way. Senses stay first-writer-wins per lexeme; translations are written per variant. Because two lookups of one lexeme are two independent model calls that name the same sense differently, a **second, smaller model call** reconciles a new form's senses against the stored ones by meaning; if it fails, the lookup fails rather than writing known-wrong rows. The wire response does not change.

**Tech Stack:** TypeScript, Node, Fastify, Drizzle ORM, Postgres 16, Zod, Jest (projects `unit` and `integration`), Playwright, MockServer, Gemini via `providers/gemini.ts`.

**Spec:** `docs/superpowers/specs/2026-09-13-lang-tutor-phase-12-dict-lexemes-design.md`

## Global Constraints

- **Read the ADRs first.** `docs/adr/` are binding. A Stop hook runs `scripts/check-adrs.sh` when a turn touches `apps/server` or `apps/mobile`; CI runs `npm run lint:arch`.
- **`npm run lint:arch` must keep reporting exactly 17 ADR 0001 checks**, 7 DI, 6 OpenAPI, 7 test topology, 3 identity. This phase adds no check and no script.
- **The wire must not move.** `TranslationRequestSchema` and `TranslationResponseSchema` stay byte-identical; `src/openapi.test.ts` must pass unmodified; no file under `apps/mobile/` may change.
- **`part_of_speech` enum, exactly these ten:** `noun`, `verb`, `adjective`, `adverb`, `pronoun`, `preposition`, `conjunction`, `determiner`, `interjection`, `numeral`.
- **Entries cap 6** (was 3). Senses per entry stays 5. Response senses stays 5.
- **Two migrations:** `0004` renames, `0005` restructures and truncates first. Both run on a database whose vocabulary tables are empty or about to be.
- **`node`/`npm` are not on the default PATH.** `source ~/.zshrc` first in any non-interactive shell.
- **Never run `npm run db:up` from a worktree** while another checkout's Postgres holds 5432. Reuse the running one.
- **Run `./scripts/setup-worktree.sh`** before tests in a fresh worktree.
- **Do NOT run the vocabulary backfill.** The user runs it gradually after this ships. No task here starts it.
- **Gemini's daily quota is exhausted.** Tasks needing a real model set `GEMINI_MODEL` to a different Gemini model id — configuration, not code.
- **`npm test` / `npm run test:all` must make no network call** (ADR 0004 R4).
- **A failed reconciliation call fails the whole lookup.** Write nothing — no variant, no sense, no translation. This deliberately differs from the existing failed-*write* path, which still returns 200: that one protects a correct answer whose storage failed, this one prevents storing an answer known to be wrong into a dictionary with no TTL.
- **ADR 0001 R8 is amended by this phase** to permit more than one read preceding third-party I/O. Still exactly one write transaction.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/db/schema.ts` | Drizzle tables | Renamed consts; `partOfSpeech` to the lexeme; `exampleSource` and `rank` to the translation; `variantId` in the translation PK; `UNIQUE(lexeme_id, sense_code)`; `UNIQUE(variant_id, user_language_code, rank)` |
| `apps/server/src/db/migrations/0004_*.sql` | The rename | Tables, constraints, indexes, `term_id` → `lexeme_id` |
| `apps/server/src/db/migrations/0005_*.sql` | The restructure | TRUNCATE, then the three column moves and the widened key |
| `apps/server/src/repo/dictionary.ts` | Lookup and write | Read joins lexeme + per-variant translations; write matches senses by `sense_code` and writes translations per variant |
| `apps/server/src/domain/dictionary.ts` | Row/entry mapping. Pure | `mergeEntries` keys on the pair; the example travels with the translation |
| `apps/server/src/domain/translation.ts` | Prompt, parse, normalize. Pure | Entry-level part of speech; the form-agreement rule; cap 6; `buildRenderingPrompt` and `parseLlmReconciliation` for the second call |
| `apps/server/src/services/translations.ts` | The use case | The reconciliation branch: read stored senses, second call, fail closed |
| `packages/core/src/api/schemas.ts` | Wire + LLM shapes | `PartOfSpeechSchema`; `part_of_speech` sense → entry; cap 3 → 6; `LlmRenderingSchema`, `LlmReconciliationSchema` |
| `apps/server/src/db/dictExport.ts` / `dictImport.ts` | Logical backup | Follow both moves |
| `apps/server/tests/integration/repo/dictionary.pos.test.ts` | **New** | The reading regression |
| `apps/server/tests/integration/repo/dictionary.form.test.ts` | **New** | The rendering regression |
| `apps/server/tests/integration/services/translations.test.ts` | Modify | `bank` then `banks` leaves two senses on the lexeme, not three |

**Build-red window:** Task 3 changes types `repo/dictionary.ts` consumes, so `npm run typecheck` fails between Task 3 and Task 4. Stated rather than hidden. Task 3 verifies with `packages/core` and `domain/` unit tests only; Task 4 restores a clean typecheck. Do not "fix" Task 3's red by editing the repo early.

---

### Task 1: The `dict_*` rename, with no behaviour change

**Files:** ~40 across `apps/server/src`, `apps/server/tests`, `packages/core`, `package.json` (both), `README.md`, `docs/adr/adr-0002-di-with-closures.md`, plus a new `apps/server/src/db/migrations/0004_*.sql`.

**Interfaces:**
- Produces for every later task: `dictLexemes`, `dictVariants`, `dictSenses`, `dictVarTranslations`; `createDictRepo`, `DictRepo`, `Repos.dict`, `DictRecord`; `repo/dictionary.ts`, `domain/dictionary.ts`, `db/dictExport.ts`, `db/dictImport.ts`, `tests/support/dictRows.ts`

This task must change **no behaviour**. Every test that passed before must pass after, unmodified except for the names it references.

- [ ] **Step 1: Rename the files first, so imports break loudly**

```bash
cd apps/server/src && git mv repo/vocabulary.ts repo/dictionary.ts && git mv domain/vocabulary.ts domain/dictionary.ts && git mv domain/vocabulary.test.ts domain/dictionary.test.ts && git mv db/vocabExport.ts db/dictExport.ts && git mv db/vocabImport.ts db/dictImport.ts
cd ../tests && git mv support/vocabRows.ts support/dictRows.ts && git mv integration/repo/vocabulary.test.ts integration/repo/dictionary.test.ts && git mv integration/repo/vocabulary.order.test.ts integration/repo/dictionary.order.test.ts && git mv integration/db/vocabRoundTrip.test.ts integration/db/dictRoundTrip.test.ts
```

- [ ] **Step 2: Apply the identifier rename**

Order matters — longer names first, so no replacement eats a prefix of another.

Two names — `vocab:export` and `vocab:restore` — contain a colon and **must not** go through this loop: `${pair%%:*}` would read `vocab` as the search term and replace every occurrence of it with `export`, corrupting every file. They are done separately in the next step.

**Scope the sweep to live code, never to documents.** `git ls-files` over every `.md` would
rewrite twelve historical plans and specs plus both ADRs — inside a commit labelled "no
behaviour change". Phase 4's design would end up claiming it created `dict_lexemes`, and ADR
0001's R8 rationale, which cites `UNIQUE(term_id, form)` at line ~90 as the reason two
transactions race harmlessly, would silently read `UNIQUE(lexeme_id, form)`. Those documents
are frozen history: what they describe is what was true when they were written. The ADRs are
edited by hand — ADR 0002 in Step 7 of this task, ADR 0001 R8 in Task 8 — and the superseded
specs get a status note in Task 8 rather than a rewrite.

Success criterion 12 scopes to `apps/`, `packages/`, `scripts/` and `e2e/` for the same reason.
`README.md` is the one document in the sweep, because it documents live commands.

```bash
cd "$(git rev-parse --show-toplevel)"
FILES=$( { git ls-files 'apps' 'packages' 'scripts' 'e2e' | grep -E '\.(ts|tsx|mjs|json)$' \
             | grep -v 'db/migrations/' | grep -v '^apps/mobile/'; \
           echo README.md; \
           echo package.json; } )

for pair in \
  'term_sense_translations:dict_var_translations' \
  'termSenseTranslations:dictVarTranslations' \
  'vocab_term_senses:dict_senses' \
  'vocabTermSenses:dictSenses' \
  'term_variants:dict_variants' \
  'termVariants:dictVariants' \
  'vocab_terms:dict_lexemes' \
  'vocabTerms:dictLexemes' \
  'createVocabRepo:createDictRepo' \
  'VocabRepo:DictRepo' \
  'VocabRecord:DictRecord' \
  'vocabExport:dictExport' \
  'vocabImport:dictImport' \
  'vocabRows:dictRows' \
  'vocab_cache_hit:dict_cache_hit' \
  'vocab_persisted:dict_persisted' \
  'vocab_persist_failed:dict_persist_failed' \
  'term_id:lexeme_id' \
  'termId:lexemeId' \
  ; do
  FROM="${pair%%:*}"; TO="${pair##*:}"
  echo "$FILES" | xargs sed -i '' "s/${FROM}/${TO}/g"
done
```

Then the two colon-bearing names, by hand:

```bash
sed -i '' 's/vocab:export/dict:export/g; s/vocab:restore/dict:restore/g' \
  package.json apps/server/package.json README.md
```

Not `docs/` — the phase 11 spec documents `npm run vocab:export` as the command that existed
when it was written, and Task 8 adds a status note there saying the commands were renamed.

Then rename `Repos.vocab` → `Repos.dict` in `apps/server/src/services/transaction.ts` and every use site (`repos.vocab.` → `repos.dict.`):

```bash
echo "$FILES" | xargs sed -i '' 's/repos\.vocab\./repos.dict./g; s/^\( *\)vocab: /\1dict: /'
```

- [ ] **Step 3: Rename the data file**

```bash
git mv data/backfill/en-he/vocabulary.jsonl data/backfill/en-he/dictionary.jsonl
grep -rn 'vocabulary.jsonl' --include='*.ts' --include='*.mjs' --include='*.md' . | grep -v node_modules
```

Fix every hit the grep reports.

- [ ] **Step 4: Verify nothing was missed**

```bash
source ~/.zshrc && cd "$(git rev-parse --show-toplevel)"
git grep -n 'vocab\|Vocab\|term_id\|termId\|termVariants\|term_variants' -- 'apps/*' 'packages/*' 'scripts/*' 'e2e/*' ':!*db/migrations/*'
```

Expected: only the one prose comment in `apps/mobile/src/app/translate.tsx` (the English word "vocabulary", which is still correct and must NOT change — `apps/mobile` stays untouched). Anything else is a miss.

Then confirm the sweep did **not** touch frozen history:

```bash
git status --short -- docs/
```

Expected: empty. Any modified file under `docs/` means the sweep escaped its scope — revert it and narrow `FILES` before continuing.

- [ ] **Step 5: Write migration 0004**

```bash
source ~/.zshrc && cd apps/server && npm run db:generate
```

drizzle-kit cannot infer renames and will either prompt or emit drop-and-create. **If it prompts and the shell cannot answer interactively**, abort it and hand-write `src/db/migrations/0004_dict_rename.sql` instead, then re-run `npm run db:generate` once so the snapshot catches up:

```sql
ALTER TABLE vocab_terms             RENAME TO dict_lexemes;
ALTER TABLE term_variants           RENAME TO dict_variants;
ALTER TABLE vocab_term_senses       RENAME TO dict_senses;
ALTER TABLE term_sense_translations RENAME TO dict_var_translations;
--> statement-breakpoint
ALTER TABLE dict_variants RENAME COLUMN term_id TO lexeme_id;
ALTER TABLE dict_senses   RENAME COLUMN term_id TO lexeme_id;
--> statement-breakpoint
ALTER TABLE dict_lexemes  RENAME CONSTRAINT vocab_terms_language_lemma_key      TO dict_lexemes_language_lemma_key;
ALTER TABLE dict_variants RENAME CONSTRAINT term_variants_term_form_key         TO dict_variants_lexeme_form_key;
ALTER TABLE dict_variants RENAME CONSTRAINT term_variants_entry_rank_nonneg     TO dict_variants_entry_rank_nonneg;
ALTER TABLE dict_senses   RENAME CONSTRAINT vocab_term_senses_term_rank_key     TO dict_senses_lexeme_rank_key;
ALTER TABLE dict_senses   RENAME CONSTRAINT vocab_term_senses_rank_nonneg       TO dict_senses_rank_nonneg;
--> statement-breakpoint
ALTER INDEX term_variants_form_entry_rank_key RENAME TO dict_variants_form_entry_rank_key;
```

Drizzle-generated foreign keys (`*_term_id_vocab_terms_id_fk`, `questions_prompt_variant_id_term_variants_id_fk`) also carry old names; rename them with `ALTER TABLE … RENAME CONSTRAINT` to match what the new snapshot expects. Run `npm run db:check` and fix anything it reports.

- [ ] **Step 6: Migrate and run everything**

```bash
source ~/.zshrc && cd apps/server && npm run db:migrate
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm run test:all && npm run lint:arch
```

Expected: green, with the **same test count as before this task**. A changed count means the rename altered behaviour.

- [ ] **Step 7: Update ADR 0002 and the README**

In `docs/adr/adr-0001-layered-architecture.md`, amend R8 (line ~85) from *"a read preceding third-party I/O may be its own"* to *"reads preceding third-party I/O may each be their own"*, and add a fourth revision note to the header — the use case now reads the cache, calls the provider, reads the lexemes' stored senses, calls again, then writes. The detection command greps for `\.transaction(` and does not change.

In `docs/adr/adr-0002-di-with-closures.md` line ~54, `createVocabRepo` → `createDictRepo`. In `README.md`, update `npm run vocab:export` / `vocab:restore` to `dict:export` / `dict:restore` and the dataset path to `dictionary.jsonl`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: rename the vocabulary tables and modules to dict_*

A term is about to become a lexeme, so the names move first, on their own,
with no behaviour change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pin both defects as committed failing tests

**Files:**
- Create: `apps/server/tests/integration/repo/dictionary.pos.test.ts`
- Create: `apps/server/tests/integration/repo/dictionary.form.test.ts`

**Interfaces:**
- Consumes: `createDictRepo(tx)` from `src/repo/dictionary`, `createTestDb()`, `withTx(db, fn)`
- Produces: two test files Task 4 flips from `it.failing` to `it`

`it.failing` (Jest 29.3+) **passes while the body fails**, so both defects are pinned in a green build.

- [ ] **Step 1: Write the reading regression**

`dictionary.pos.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
beforeEach(async () => { t = await createTestDb(); });
afterEach(async () => { await t.close(); });

// Pre-Task-3 shape: senses still carry part_of_speech, entries do not.
const BOOK = [{
  lemma: 'book',
  senses: [
    { sense_code: 'printed_work', translation: 'N-BOOK', part_of_speech: 'noun' },
    { sense_code: 'make_reservation', translation: 'V-BOOK', part_of_speech: 'verb' },
  ],
}];

const BOOKED = [{
  lemma: 'book',
  senses: [{ sense_code: 'make_reservation', translation: 'V-BOOKED', part_of_speech: 'verb' }],
}];

const persist = (form: string, entries: unknown) =>
  withTx(t.db, (tx) => createDictRepo(tx).persistEntries({
    form, languageCode: 'en', userLanguageCode: 'he', kind: 'word', entries: entries as never,
  }));

const find = (form: string) =>
  withTx(t.db, (tx) => createDictRepo(tx).findSensesByForm({
    form, languageCode: 'en', userLanguageCode: 'he',
  }));

describe('an inflected form serves only its own part of speech', () => {
  it.failing('booked never serves the noun sense', async () => {
    await persist('book', BOOK);
    await persist('booked', BOOKED);

    const rows = await find('booked');
    expect(rows.map((r) => r.translation)).not.toContain('N-BOOK');
    expect(rows.every((r) => r.partOfSpeech === 'verb')).toBe(true);
  });
});
```

- [ ] **Step 2: Write the rendering regression**

`dictionary.form.test.ts` — same imports, `beforeEach`/`afterEach`, `persist` and `find` helpers as above (repeat them; do not import across test files):

```ts
describe('each form renders in its own grammatical form', () => {
  it.failing('book renders the infinitive and booked the past tense', async () => {
    await persist('book', [{
      lemma: 'book',
      senses: [{ sense_code: 'make_reservation', translation: 'INFINITIVE', part_of_speech: 'verb' }],
    }]);
    await persist('booked', [{
      lemma: 'book',
      senses: [{ sense_code: 'make_reservation', translation: 'PAST', part_of_speech: 'verb' }],
    }]);

    expect((await find('book'))[0].translation).toBe('INFINITIVE');
    expect((await find('booked'))[0].translation).toBe('PAST');
  });

  it.failing('writing a new form leaves an existing form untouched', async () => {
    await persist('book', [{
      lemma: 'book',
      senses: [{ sense_code: 'make_reservation', translation: 'INFINITIVE', part_of_speech: 'verb' }],
    }]);
    const before = await find('book');

    await persist('booked', [{
      lemma: 'book',
      senses: [{ sense_code: 'make_reservation', translation: 'PAST', part_of_speech: 'verb' }],
    }]);

    expect(await find('book')).toEqual(before);
  });
});
```

The second case is expected to **pass** its body today (nothing changes an existing form because nothing is written at all), so mark that one `it`, not `it.failing` — it is a property the phase must preserve, not a defect to fix. Run it and confirm before committing; if it fails today, leave it `it.failing` and note why.

- [ ] **Step 3: Run both and confirm they report what they should**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects integration -t 'form' 2>&1 | tail -20
```

Expected: all PASS. To see the real defects, flip an `it.failing` to `it` temporarily: the first reports `N-BOOK` present, the second reports `INFINITIVE` where `PAST` was expected.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/integration/repo
git commit -m "test: pin the wrong-reading and wrong-rendering defects

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Move `part_of_speech` to the entry and teach the prompt form agreement

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/schemas.test.ts`
- Modify: `apps/server/src/domain/dictionary.ts`, `apps/server/src/domain/dictionary.test.ts`
- Modify: `apps/server/src/domain/translation.ts`, `apps/server/src/domain/translation.test.ts`
- Modify: `apps/server/tests/support/mockServer.ts`, `apps/server/tests/support/fakes.ts`, `apps/server/src/services/translations.test.ts`

**Interfaces:**
- Produces for Task 4:
  - `PartOfSpeechSchema`, `type PartOfSpeech`
  - `LlmEntry` = `{ lemma: string; part_of_speech: PartOfSpeech; senses: LlmSense[] }`
  - `LlmSense` = `{ translation, example?, sense_code }` — no `part_of_speech`
  - `EntryRows` = `{ lemma, partOfSpeech, entryRank, senses: SenseToWrite[] }`
  - `SenseToWrite` = `{ rank, senseCode, translation, exampleSource, exampleTarget }` — the example halves travel together now, because both land on the translation row
  - `SenseRow` gains nothing; Task 4 fills `partOfSpeech` from the lexeme and the example halves from the translation

**`npm run typecheck` fails at the end of this task.** Expected — Task 4 fixes it.

- [ ] **Step 1: Write the failing core tests**

Append to `packages/core/src/api/schemas.test.ts`:

```ts
const aSense = { translation: 'X', sense_code: 'make_reservation' };

it('accepts the ten word classes and rejects spelling variants', () => {
  expect(PartOfSpeechSchema.safeParse('verb').success).toBe(true);
  expect(PartOfSpeechSchema.safeParse('numeral').success).toBe(true);
  expect(PartOfSpeechSchema.safeParse('verb phrase').success).toBe(false);
  expect(PartOfSpeechSchema.safeParse('verb_phrase').success).toBe(false);
  expect(PartOfSpeechSchema.safeParse('Verb').success).toBe(false);
  expect(PartOfSpeechSchema.safeParse('proper_noun').success).toBe(false);
});

it('requires part_of_speech on the entry and strips it from the sense', () => {
  expect(LlmEntrySchema.safeParse({ lemma: 'book', senses: [aSense] }).success).toBe(false);
  expect(LlmEntrySchema.safeParse({ lemma: 'book', part_of_speech: 'verb', senses: [aSense] }).success).toBe(true);

  const parsed = LlmEntrySchema.parse({
    lemma: 'book', part_of_speech: 'verb',
    senses: [{ ...aSense, part_of_speech: 'noun' }],
  });
  expect(parsed.senses[0]).not.toHaveProperty('part_of_speech');
});

it('keeps part_of_speech on the wire sense', () => {
  expect(TranslationSenseSchema.safeParse({ translation: 'X', part_of_speech: 'noun' }).success).toBe(true);
});

it('accepts six entries and rejects seven', () => {
  const entry = { lemma: 'x', part_of_speech: 'noun' as const, senses: [aSense] };
  const make = (n: number) => ({ kind: 'word' as const, entries: Array.from({ length: n }, () => entry) });
  expect(LlmTranslationSchema.safeParse(make(6)).success).toBe(true);
  expect(LlmTranslationSchema.safeParse(make(7)).success).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
source ~/.zshrc && npx jest --selectProjects unit -t 'part_of_speech' 2>&1 | tail -20
```

Expected: FAIL — `PartOfSpeechSchema` is not exported.

- [ ] **Step 3: Implement the core change**

In `packages/core/src/api/schemas.ts`, above `LlmSenseSchema`:

```ts
// A closed set, because part_of_speech is half of dict_lexemes' unique key from
// phase 12 on: free text would make (book,"verb phrase") and (book,"verb_phrase")
// two lexemes, and the pre-phase-12 data already held 80 spellings of ten ideas.
// It is handed to Gemini inside responseSchema, so an eleventh is not expressible.
// Phrase classes collapse to their head: `kind` already records phrase-ness.
export const PartOfSpeechSchema = z.enum([
  'noun', 'verb', 'adjective', 'adverb', 'pronoun',
  'preposition', 'conjunction', 'determiner', 'interjection', 'numeral',
]);
```

Replace the three LLM schemas:

```ts
export const LlmSenseSchema = TranslationSenseSchema
  .omit({ part_of_speech: true })
  .extend({ sense_code: z.string().min(1).max(60) });

// One entry per (lemma, part of speech) — a lexeme.
export const LlmEntrySchema = z.object({
  lemma: z.string().min(1),
  part_of_speech: PartOfSpeechSchema,
  senses: z.array(LlmSenseSchema).min(1).max(5),
});

export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  // Six, not three: `light` alone is noun, adjective and verb, and a competing
  // lemma still has to fit beside it.
  entries: z.array(LlmEntrySchema).max(6),
});
```

In `packages/core/src/api/types.ts`, add `PartOfSpeechSchema` to the import from `./schemas` and export `export type PartOfSpeech = z.infer<typeof PartOfSpeechSchema>;`.

- [ ] **Step 4: Run the core tests**

```bash
source ~/.zshrc && npx jest --selectProjects unit -t 'part_of_speech' 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Write the failing domain tests**

Append to `apps/server/src/domain/dictionary.test.ts`:

```ts
const s = (code: string, translation: string) => ({ sense_code: code, translation });

it('keeps two parts of speech of one lemma apart', () => {
  const merged = mergeEntries([
    { lemma: 'book', part_of_speech: 'noun', senses: [s('printed_work', 'N1')] },
    { lemma: 'book', part_of_speech: 'verb', senses: [s('make_reservation', 'V1')] },
  ]);
  expect(merged).toHaveLength(2);
  expect(merged.map((e) => e.part_of_speech)).toEqual(['noun', 'verb']);
});

it('still fuses two entries sharing a lemma AND a part of speech', () => {
  const merged = mergeEntries([
    { lemma: 'book', part_of_speech: 'noun', senses: [s('printed_work', 'N1')] },
    { lemma: 'book', part_of_speech: 'noun', senses: [s('volume', 'N2')] },
  ]);
  expect(merged).toHaveLength(1);
  expect(merged[0].senses).toHaveLength(2);
});

it('puts the part of speech on the entry row and both example halves on the sense row', () => {
  const [row] = entriesToRows([{
    lemma: 'book', part_of_speech: 'verb',
    senses: [{ sense_code: 'make_reservation', translation: 'V1',
               example: { source: 'I booked a table.', target: 'T' } }],
  }]);
  expect(row.partOfSpeech).toBe('verb');
  expect(row.senses[0]).not.toHaveProperty('partOfSpeech');
  expect(row.senses[0].exampleSource).toBe('I booked a table.');
  expect(row.senses[0].exampleTarget).toBe('T');
});

it('copies the entry part of speech onto every flattened sense', () => {
  const flat = flattenEntries([
    { lemma: 'book', part_of_speech: 'noun', senses: [s('printed_work', 'N1')] },
    { lemma: 'book', part_of_speech: 'verb', senses: [s('make_reservation', 'V1')] },
  ]);
  expect(flat.map((x) => x.part_of_speech)).toEqual(['noun', 'verb']);
});
```

Append to `apps/server/src/domain/translation.test.ts`:

```ts
it('asks for one entry per lemma and part of speech, with form agreement', () => {
  const { system } = buildPrompt({ text: 'booked', direction: 'en_he' });
  expect(system).toMatch(/one entry per headword AND part of speech/i);
  expect(system).toMatch(/grammatical form matching the input/i);
  expect(system).toMatch(/third-person masculine singular/i);
  expect(system).not.toMatch(/ONE entry per headword:/);
  expect(system).not.toMatch(/at most 3\./);
});
```

- [ ] **Step 6: Run and confirm failure**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects unit -t 'part of speech' 2>&1 | tail -20
```

Expected: FAIL.

- [ ] **Step 7: Implement the domain change**

In `apps/server/src/domain/dictionary.ts`:

```ts
/**
 * Key on the pair, not the lemma. A model returning (book,noun) and (book,verb)
 * is describing two lexemes, and phase 12 stores them as two rows; fusing them
 * here is what made an inflected verb form serve a noun sense.
 */
export function mergeEntries(entries: LlmEntry[]): LlmEntry[] {
  const byLexeme = new Map<string, LlmEntry>();
  for (const entry of entries) {
    const key = `${entry.lemma} ${entry.part_of_speech}`;
    const existing = byLexeme.get(key);
    if (existing) existing.senses = [...existing.senses, ...entry.senses];
    else byLexeme.set(key, { ...entry, senses: [...entry.senses] });
  }
  return [...byLexeme.values()];
}

function toResponseSense(sense: LlmSense, partOfSpeech: PartOfSpeech): TranslationSense {
  const result: TranslationSense = { translation: sense.translation, part_of_speech: partOfSpeech };
  if (sense.example) result.example = { source: sense.example.source, target: sense.example.target };
  return result;
}

// Both example halves live on the sense row now, because both land on the
// translation row, which is per (variant, sense) from phase 12 on.
export type SenseToWrite = {
  rank: number;
  senseCode: string;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

export type EntryRows = {
  lemma: string;
  partOfSpeech: PartOfSpeech;
  entryRank: number;
  senses: SenseToWrite[];
};

export function entriesToRows(entries: LlmEntry[]): EntryRows[] {
  return entries.map((entry, entryRank) => ({
    lemma: entry.lemma,
    partOfSpeech: entry.part_of_speech,
    entryRank,
    senses: entry.senses.map((sense, rank) => ({
      rank,
      senseCode: sense.sense_code,
      translation: sense.translation,
      exampleSource: sense.example?.source ?? null,
      exampleTarget: sense.example?.target ?? null,
    })),
  }));
}
```

`flattenEntries`' inner loop becomes `flat.push(toResponseSense(sense, entry.part_of_speech))`. Add `PartOfSpeech` to the type import from `@lang-tutor/core/api`.

In `apps/server/src/domain/translation.ts`, inside `buildPrompt`'s `system` array:

1. Delete the two lines beginning `'Keep senses spanning parts of speech in ONE entry per headword:'` and the line following.
2. Insert in their place:

```ts
    'Return one entry per headword AND part of speech: "book" is two entries, one noun and',
    'one verb. An inflected form belongs to the entry whose part of speech it realises:',
    '"booked" is the verb entry only, never the noun; "books" is legitimately both.',
```

3. Change the entry cap wording from `at most 3.` to `at most 6.`
4. Drop `a part_of_speech,` from the per-sense clause — the sense no longer carries one.
5. Add the form-agreement rule:

```ts
    `Translate into the grammatical form matching the input's: a past-tense input takes a`,
    `past-tense translation, an infinitive an infinitive. Where ${to} offers several such`,
    'forms, use its dictionary citation form for that category; for Hebrew past tense that is',
    'third-person masculine singular. Build the example sentence around the input as typed,',
    'not around its headword.',
```

Update the block comment above `system` so it no longer claims `book` is the worked example.

- [ ] **Step 8: Follow the shape through the shared fixtures**

Three files build `LlmEntry` literals and stop typechecking. Add `part_of_speech` to each **entry**; never to a sense.

- `apps/server/tests/support/mockServer.ts` — two helpers take `{ kind, entries: LlmEntry[] }` (~lines 66 and 90). The type follows; every **call site** passing an entry literal needs the field.
- `apps/server/tests/support/fakes.ts` — the fake dict repo maps `input.entries` (~line 167) and calls `flattenEntries` (~line 174).
- `apps/server/src/services/translations.test.ts` — its entry fixtures gain the field.

Where a fixture exercised "one entry whose senses span two parts of speech", split it into two entries. That shape is no longer representable and is the shape the phase exists to eliminate.

- [ ] **Step 9: Run all unit tests**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects unit 2>&1 | tail -20
```

Expected: PASS. `npm run typecheck` still fails on `repo/dictionary.ts` — that is Task 4.

- [ ] **Step 10: Add the reconciliation schema and prompt builder**

In `packages/core/src/api/schemas.ts`:

```ts
// One rendering of one stored sense for one new form. `translation: null` means
// the form does not admit that sense at all — adjectival `booked` has no
// record-a-charge reading — and the sense is then absent for this form.
export const LlmRenderingSchema = z.object({
  sense_code: z.string().min(1).max(60),
  translation: z.string().min(1).nullable(),
  example: z.object({ source: z.string().min(1), target: z.string().min(1) }).optional(),
});

export const LlmReconciliationSchema = z.object({
  // Ranked FOR THE QUERIED FORM. Stored codes reused where the meaning matches;
  // a new code only for a reading the stored list does not contain.
  senses: z.array(LlmRenderingSchema).max(5),
});
```

In `apps/server/src/domain/translation.ts`, a second pure builder beside `buildPrompt`:

```ts
export type StoredSense = {
  senseCode: string;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

/**
 * The second call. It exists because `sense_code` is model-invented per call:
 * `bank` names a sense river_bank and `banks` names the same sense river_edge,
 * so a string comparison would duplicate the meaning silently. Deciding whether
 * two glosses mean the same thing is a judgement, so the model makes it.
 *
 * Pure, like buildPrompt — it takes the stored senses as input rather than
 * reaching for them, which is what keeps it unit-testable and eval-scorable.
 */
export function buildRenderingPrompt(input: {
  form: string;
  direction: TranslationDirection;
  lemma: string;
  partOfSpeech: PartOfSpeech;
  storedSenses: StoredSense[];
}): TranslationPrompt { /* ... */ }
```

The system text must: name the headword, its part of speech and the queried form; list each stored sense as `code — translation — example`; ask for one entry per stored sense reusing its code where the meaning matches, with `translation: null` where the form does not admit it; ask for a new code only for a reading the list does not contain; carry over the same form-agreement rule as `buildPrompt`; and ask for the result ranked for the queried form.

Add `parseLlmReconciliation`, mirroring `parseLlmTranslation` — unfence, `dropNulls` must **not** strip `translation: null` here, so parse against the raw JSON and return `null` on a shape mismatch.

Tests to add in `domain/translation.test.ts`:

```ts
it('lists every stored sense with its gloss, and asks for null where inadmissible', () => {
  const { system, user } = buildRenderingPrompt({
    form: 'booked', direction: 'en_he', lemma: 'book', partOfSpeech: 'verb',
    storedSenses: [
      { senseCode: 'reserve', translation: 'INF-RESERVE', exampleSource: 'book a table', exampleTarget: 'T' },
    ],
  });
  expect(system).toMatch(/reserve/);
  expect(system).toMatch(/INF-RESERVE/);
  expect(system).toMatch(/null/);
  expect(user).toBe('booked');
});

it('keeps a null translation through the parse', () => {
  const parsed = parseLlmReconciliation('{"senses":[{"sense_code":"reserve","translation":null}]}');
  expect(parsed?.senses[0].translation).toBeNull();
});
```

- [ ] **Step 11: Commit**

```bash
git add packages/core apps/server/src/domain apps/server/tests/support apps/server/src/services
git commit -m "feat: key LLM entries on lemma and part of speech, and pin form agreement

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Lexemes and per-form translations — schema, migration 0005, repository

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0005_*.sql`
- Modify: `apps/server/src/repo/dictionary.ts`
- Modify: `apps/server/tests/support/dictRows.ts`
- Modify: the two regression tests from Task 2, plus `dictionary.test.ts` and `dictionary.order.test.ts`

**Interfaces:**
- Consumes from Task 3: `PartOfSpeech`, `LlmEntry.part_of_speech`, `EntryRows.partOfSpeech`, `SenseToWrite` with both example halves
- Produces: `findSensesByForm` returning `SenseRow[]` whose `partOfSpeech` comes from `dict_lexemes` and whose translation and example come from `dict_var_translations`; `persistEntries` unchanged in signature

This task restores a clean `npm run typecheck`.

- [ ] **Step 1: Update the Drizzle schema**

`dictLexemes` — add after `lemma`, and widen the unique key:

```ts
    // A lexeme: the pair of a lemma and a part of speech. It moved up from the
    // sense, where phase 10 put it. Part of speech does describe a meaning, but
    // it also decides which forms a headword has, and only the lexeme can carry
    // that — which is what stops `booked` reaching the noun's senses.
    partOfSpeech: varchar('part_of_speech', { length: 50 }).notNull(),
```

```ts
  (t) => [unique('dict_lexemes_language_lemma_pos_key').on(t.languageCode, t.lemma, t.partOfSpeech)],
```

`dictSenses` — delete `partOfSpeech`, `exampleSource` **and `rank`**, along with
`dict_senses_lexeme_rank_key` and `dict_senses_rank_nonneg`. The table becomes pure identity.
Add the code uniqueness:

```ts
    // Load-bearing from phase 12: it is how a later form's translations are
    // attached to senses this lexeme already has. Phase 10 called it decoration.
    unique('dict_senses_lexeme_code_key').on(t.lexemeId, t.senseCode),
```

`dictVarTranslations` — add `variantId` to the columns and to the primary key, and add `exampleSource`:

```ts
    variantId: text('variant_id').notNull().references(() => dictVariants.id, { onDelete: 'cascade' }),
    // Both halves of the example live here, because an example belongs to the
    // form that was typed: `booked` shows "I booked a table", not "I want to
    // book a table". The source half is duplicated per target language, which is
    // cheaper than a fifth table to normalise it.
    exampleSource: text('example_source'),
    // "Most common first", scoped to THIS form. It sits here rather than on the
    // sense so that a sense a later form introduces lands where that form ranked
    // it, instead of at max(rank)+1 — arrival order wearing a rank's clothes —
    // and so that the lexeme's order does not depend on which form was looked up
    // first. Values are the sense's position in the entry the model returned.
    rank: integer('rank').notNull(),
```

```ts
  (t) => [
    primaryKey({ columns: [t.variantId, t.senseId, t.userLanguageCode] }),
    unique('dict_var_translations_variant_rank_key').on(t.variantId, t.userLanguageCode, t.rank),
    check('dict_var_translations_rank_nonneg', sql`${t.rank} >= 0`),
  ],
```

- [ ] **Step 2: Generate and edit migration 0005**

```bash
source ~/.zshrc && cd apps/server && npm run db:generate
```

Prepend to the generated file, above everything:

```sql
-- Phase 12 changes what a row means twice over: a lexeme is not a lemma, and a
-- translation belongs to a form rather than to a meaning. Nothing in the old rows
-- records which part of speech a stored form realises, or how that form should be
-- rendered, so they cannot be migrated. Clearing first lets the statements below
-- state the target shape rather than negotiate with the old one, as 0003 did.
-- CASCADE reaches dict_variants, dict_senses, dict_var_translations, questions,
-- session_questions and answers. sessions is named because nothing references it.
-- users is untouched.
TRUNCATE dict_lexemes, sessions CASCADE;
--> statement-breakpoint
```

Confirm the generated body:

- `part_of_speech` added to `dict_lexemes` as `NOT NULL` with no default, dropped from `dict_senses`
- `dict_lexemes_language_lemma_key` replaced by `dict_lexemes_language_lemma_pos_key`
- `example_source` **and `rank`** moved from `dict_senses` to `dict_var_translations`
- `variant_id` added to `dict_var_translations` and its primary key rebuilt
- `dict_senses_lexeme_rank_key` and `dict_senses_rank_nonneg` dropped
- `dict_senses_lexeme_code_key`, `dict_var_translations_variant_rank_key` and
  `dict_var_translations_rank_nonneg` added

Fix nullability by hand if drizzle-kit hedged — the tables are empty.

- [ ] **Step 3: Apply and inspect**

```bash
source ~/.zshrc && cd apps/server && npm run db:migrate
psql "$DATABASE_URL" -c '\d dict_lexemes' -c '\d dict_senses' -c '\d dict_var_translations'
```

- [ ] **Step 4: Update the test support helper**

In `tests/support/dictRows.ts`: `SeedTerm` (rename to `SeedLexeme`) gains `partOfSpeech`; `SeedSense` loses `partOfSpeech`, `exampleSource` **and `rank`** — it is reduced to `{ senseCode }`. Translations are inserted per variant and now carry the rank, so `insertLexeme` needs to know which variant each belongs to. Give it the shape the tests need:

```ts
export type SeedLexeme = {
  lemma: string;
  languageCode: string;
  partOfSpeech: string;
  senses: { senseCode: string }[];          // identity only, order here is not a rank
  variants: {
    form: string;
    kind: string;
    entryRank: number;
    // one per sense this form serves; `senseCode` picks which, `rank` orders them
    translations: { senseCode: string; rank: number; translation: string;
                    exampleSource: string | null; exampleTarget: string | null }[];
  }[];
};
```

Note what this shape makes expressible and the old one did not: two variants of one lexeme can rank the same senses differently, which is exactly what Step 5's new test needs.

- [ ] **Step 5: Write the failing repository tests**

Append to `tests/integration/repo/dictionary.test.ts`:

```ts
const entry = (pos: string, code: string, translation: string) =>
  ({ lemma: 'book', part_of_speech: pos, senses: [{ sense_code: code, translation }] });

const persist = (form: string, entries: unknown) =>
  withTx(t.db, (tx) => createDictRepo(tx).persistEntries({
    form, languageCode: 'en', userLanguageCode: 'he', kind: 'word', entries: entries as never,
  }));

it('stores one lemma with two parts of speech as two lexemes', async () => {
  const res = await persist('book', [entry('noun', 'printed_work', 'N1'), entry('verb', 'make_reservation', 'V1')]);
  expect(res.written).toHaveLength(2);
  expect(new Set(res.written.map((e) => e.lexemeId)).size).toBe(2);
});

it('returns the lexeme part of speech on every sense', async () => {
  await persist('book', [entry('verb', 'make_reservation', 'V1')]);
  const rows = await withTx(t.db, (tx) => createDictRepo(tx).findSensesByForm({
    form: 'book', languageCode: 'en', userLanguageCode: 'he',
  }));
  expect(rows[0].partOfSpeech).toBe('verb');
});

it('rejects a second lexeme with the same lemma and part of speech', async () => {
  const ins = () => t.db.insert(dictLexemes).values({ languageCode: 'en', lemma: 'book', partOfSpeech: 'verb' });
  await ins();
  await expect(ins()).rejects.toThrow(/dict_lexemes_language_lemma_pos_key/);
});

it('adds an incoming sense whose code matches nothing', async () => {
  await persist('book', [entry('verb', 'make_reservation', 'V1')]);
  await persist('booked', [entry('verb', 'record_charge', 'V2')]);

  const senses = await t.db.select().from(dictSenses);
  expect(senses.map((s) => s.senseCode).sort()).toEqual(['make_reservation', 'record_charge']);
});

// The reason `rank` sits on the translation. A form that ranks a brand-new sense
// FIRST must serve it first — under a lexeme-scoped rank it would have been
// appended at max(rank)+1 and served last.
it('ranks a new sense where THIS form put it, not where it arrived', async () => {
  await persist('book', [{
    lemma: 'book', part_of_speech: 'verb',
    senses: [
      { sense_code: 'reserve', translation: 'INF-RESERVE' },
      { sense_code: 'secure_in_advance', translation: 'INF-SECURE' },
    ],
  }]);

  await persist('booked', [{
    lemma: 'book', part_of_speech: 'verb',
    senses: [
      { sense_code: 'charge_by_police', translation: 'PAST-CHARGE' },   // new, and first
      { sense_code: 'reserve', translation: 'PAST-RESERVE' },
      { sense_code: 'secure_in_advance', translation: 'PAST-SECURE' },
    ],
  }]);

  const booked = await withTx(t.db, (tx) => createDictRepo(tx).findSensesByForm({
    form: 'booked', languageCode: 'en', userLanguageCode: 'he',
  }));
  expect(booked.map((r) => r.translation))
    .toEqual(['PAST-CHARGE', 'PAST-RESERVE', 'PAST-SECURE']);

  // ...and book is untouched, still without the new sense
  const book = await withTx(t.db, (tx) => createDictRepo(tx).findSensesByForm({
    form: 'book', languageCode: 'en', userLanguageCode: 'he',
  }));
  expect(book.map((r) => r.translation)).toEqual(['INF-RESERVE', 'INF-SECURE']);
});

// Neither order of arrival may fix an ordering for the other form.
it('gives the same two answers whichever form is looked up first', async () => {
  const bookEntry = {
    lemma: 'book', part_of_speech: 'verb',
    senses: [{ sense_code: 'reserve', translation: 'INF-RESERVE' }],
  };
  const bookedEntry = {
    lemma: 'book', part_of_speech: 'verb',
    senses: [
      { sense_code: 'charge_by_police', translation: 'PAST-CHARGE' },
      { sense_code: 'reserve', translation: 'PAST-RESERVE' },
    ],
  };

  await persist('booked', [bookedEntry]);
  await persist('book', [bookEntry]);

  const booked = await withTx(t.db, (tx) => createDictRepo(tx).findSensesByForm({
    form: 'booked', languageCode: 'en', userLanguageCode: 'he',
  }));
  const book = await withTx(t.db, (tx) => createDictRepo(tx).findSensesByForm({
    form: 'book', languageCode: 'en', userLanguageCode: 'he',
  }));

  expect(booked.map((r) => r.translation)).toEqual(['PAST-CHARGE', 'PAST-RESERVE']);
  expect(book.map((r) => r.translation)).toEqual(['INF-RESERVE']);
});
```

Import `dictLexemes` and `dictSenses` from `../../../src/db/schema` — the integration bucket is the carve-out ADR 0001 grants for reaching into the schema.

- [ ] **Step 6: Run and confirm failure**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects integration -t 'lexeme' 2>&1 | tail -30
```

Expected: FAIL.

- [ ] **Step 7: Implement the read**

In `src/repo/dictionary.ts`:

```ts
      .select({
        lexemeId: dictVariants.lexemeId,
        rank: dictVarTranslations.rank,
        entryRank: dictVariants.entryRank,
        partOfSpeech: dictLexemes.partOfSpeech,
        exampleSource: dictVarTranslations.exampleSource,
        translation: dictVarTranslations.translation,
        exampleTarget: dictVarTranslations.exampleTarget,
        kind: sql<TranslationKind>`${dictVariants.kind}`,
      })
      .from(dictVariants)
      .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
      .innerJoin(dictSenses, eq(dictSenses.lexemeId, dictVariants.lexemeId))
      .innerJoin(
        dictVarTranslations,
        and(
          eq(dictVarTranslations.variantId, dictVariants.id),
          eq(dictVarTranslations.senseId, dictSenses.id),
          eq(dictVarTranslations.userLanguageCode, input.userLanguageCode),
        ),
      )
```

`WHERE` is unchanged except `v.term_id` → `dictVariants.lexemeId`. `ORDER BY` now leads with the translation's rank:

```ts
      .orderBy(asc(dictVarTranslations.rank), asc(dictVariants.entryRank), asc(dictVariants.lexemeId))
```

Rank still leads, so the merge across lexemes is still round-robin — `book` answers `ספר · להזמין · כרך · לשריין`, not both noun senses first. What changed is only that the rank is this form's own. Update the block comment: the lexeme join is back (phase 10 removed it and `part_of_speech` now lives there), and the translation join carries `variantId`, which is what makes the answer form-specific and makes servability mean *this form has its own renderings*.

- [ ] **Step 8: Implement the write**

Step 1's insert and conflict target gain `partOfSpeech`, and the fallback `SELECT` gains `eq(dictLexemes.partOfSpeech, entry.partOfSpeech)`. Then replace steps 3–4 with sense matching and per-variant translations:

```ts
      // 3 — the lexeme's senses, by code. `sense_code` is the only key that can
      // attach a new form's translations to senses this lexeme already has; phase
      // 12 is where it stops being decoration.
      const existing = await tx
        .select({ id: dictSenses.id, senseCode: dictSenses.senseCode })
        .from(dictSenses)
        .where(eq(dictSenses.lexemeId, lexemeId));

      const idByCode = new Map(existing.map((row) => [row.senseCode, row.id]));

      // 4 — an idempotent upsert, not a match. By the time entries reach the
      // repository, Task 5's reconciliation call has already decided which codes
      // are reused and which are new, so this only has to be safe under
      // concurrency. No rank is assigned here: a sense has no order of its own,
      // only a position within a given form's answer.
      const senseIds: string[] = [];
      for (const sense of entry.senses) {
        let id = idByCode.get(sense.senseCode);
        if (!id) {
          await tx.insert(dictSenses)
            .values({ lexemeId, senseCode: sense.senseCode })
            .onConflictDoNothing({ target: [dictSenses.lexemeId, dictSenses.senseCode] });
          const [row] = await tx.select({ id: dictSenses.id }).from(dictSenses)
            .where(and(eq(dictSenses.lexemeId, lexemeId), eq(dictSenses.senseCode, sense.senseCode)));
          id = row.id;
          idByCode.set(sense.senseCode, id);
        }
        senseIds.push(id);
      }

      // 5 — this variant's own renderings. DO NOTHING because a form written
      // twice keeps the answer it already gave: phase 10's guarantee, now held at
      // the level that actually decides an answer.
      await tx.insert(dictVarTranslations).values(
        entry.senses.map((sense, i) => ({
          variantId: variant.id,
          senseId: senseIds[i],
          userLanguageCode: input.userLanguageCode,
          // This form's own ordering, straight from the entry the model returned
          // for it — `entriesToRows` set it from the sense's array position.
          rank: sense.rank,
          translation: sense.translation,
          exampleSource: sense.exampleSource,
          exampleTarget: sense.exampleTarget,
        })),
      ).onConflictDoNothing({
        // Named, never bare. `repo/dictionary.ts` already carries this rule for
        // the variant insert, for the same reason: a bare DO NOTHING would also
        // swallow a collision on UNIQUE(variant_id, user_language_code, rank),
        // the safety net Task 4 adds, which must be allowed to raise.
        target: [dictVarTranslations.variantId, dictVarTranslations.senseId,
                 dictVarTranslations.userLanguageCode],
      });
```

`PersistedEntry` renames `termId` → `lexemeId`. Update the `persistEntries` block comment: first-writer-wins splits in two — senses once per lexeme, translations once per (variant, sense).

- [ ] **Step 9: Run the repository tests**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects integration -t 'lexeme' 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 10: Flip both regressions**

In `dictionary.pos.test.ts` and `dictionary.form.test.ts`: change `it.failing(` to `it(`, and move `part_of_speech` from each sense onto its entry, splitting `BOOK` into two entries:

```ts
const BOOK = [
  { lemma: 'book', part_of_speech: 'noun', senses: [{ sense_code: 'printed_work', translation: 'N-BOOK' }] },
  { lemma: 'book', part_of_speech: 'verb', senses: [{ sense_code: 'make_reservation', translation: 'V-BOOK' }] },
];
const BOOKED = [
  { lemma: 'book', part_of_speech: 'verb', senses: [{ sense_code: 'make_reservation', translation: 'V-BOOKED' }] },
];
```

`dictionary.pos.test.ts` additionally asserts `expect(rows[0].translation).toBe('V-BOOKED')` — the form's own rendering, not the one `book` wrote. That single assertion is where both defects are proved fixed at once.

- [ ] **Step 11: Extend the ordering test**

In `dictionary.order.test.ts`, add a case proving round-robin interleaves two lexemes of one lemma: seed `(book,noun)` with senses `N1, N2` at entry_rank 0 and `(book,verb)` with `V1, V2` at entry_rank 1, both variants on the form `book`, then assert `find('book')` returns `['N1', 'V1', 'N2', 'V2']` — not `['N1','N2','V1','V2']`.

- [ ] **Step 12: Full verification**

```bash
source ~/.zshrc && npm run typecheck && npm run test:all && npm run lint:arch
```

Expected: typecheck clean, all green, `lint:arch` reporting 17 ADR 0001 rules.

- [ ] **Step 13: Commit**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat: a lexeme is not a lemma, and a translation belongs to a form

booked now reaches only the verb's senses and renders them in the past
tense, instead of inheriting the noun's ranking and the infinitive.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The reconciliation call

**Files:**
- Modify: `apps/server/src/repo/dictionary.ts` (add `findSensesByLexeme`)
- Modify: `apps/server/src/services/translations.ts`
- Modify: `apps/server/src/services/llm.ts` if the client type needs a second schema shape
- Test: `apps/server/src/services/translations.test.ts`, `apps/server/tests/integration/services/translations.test.ts`

**Interfaces:**
- Consumes: `buildRenderingPrompt`, `LlmReconciliationSchema`, `parseLlmReconciliation` (Task 3); `createDictRepo` (Task 4)
- Produces: `findSensesByLexeme({ lemma, partOfSpeech, languageCode, userLanguageCode })` returning `{ senseCode, translation, exampleSource, exampleTarget }[]` — the stored senses the second prompt is built from

This is the phase's only change to `services/`. Reconciliation lives here, not in the repository: it makes a provider call, and the repository must stay a pure write.

- [ ] **Step 1: Add the repository read**

In `src/repo/dictionary.ts`, beside `findSensesByForm`:

```ts
  /**
   * The stored senses of one lexeme, for the reconciliation prompt. Keyed by
   * (lemma, part_of_speech) rather than by id because the service has only what
   * the first model call returned — it does not know the lexeme id, and may find
   * there is no such lexeme at all.
   *
   * **One gloss per sense, taken from whichever variant has one — never from a
   * chosen variant.** Two traps here, and both are silent:
   *
   * `entry_rank` is NOT a property of the lexeme. `entriesToRows` assigns it from
   * the entry's index in the answer for one queried form, so the verb lexeme of
   * `book` sits at entry_rank 1 and owns no entry_rank 0 variant at all.
   * Filtering on `entryRank = 0` would return zero rows for it, the service would
   * conclude the lexeme has no senses, and reconciliation would be skipped for
   * exactly the lexemes it exists for — verbs, which is what inflections mostly
   * are.
   *
   * And because a rendering may be absent for a form (the reconciliation call
   * returns `translation: null` for a sense a form does not admit), no single
   * variant is guaranteed to carry a gloss for every sense. A sense missing from
   * the prompt gets a freshly invented code — the same duplication by another
   * route.
   */
  const findSensesByLexeme = async (input: {
    lemma: string;
    partOfSpeech: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<{ senseCode: string; translation: string;
                exampleSource: string | null; exampleTarget: string | null }[]> => { /* ... */ };
```

Implement it as a join `dict_lexemes → dict_senses → dict_var_translations → dict_variants` filtered on the two language codes and **no variant predicate**, taking one row per sense:

```sql
SELECT DISTINCT ON (s.id)
       s.id, s.sense_code, tr.translation, tr.example_source, tr.example_target
FROM dict_lexemes l
JOIN dict_senses s            ON s.lexeme_id = l.id
JOIN dict_var_translations tr ON tr.sense_id = s.id AND tr.user_language_code = $4
JOIN dict_variants v          ON v.id = tr.variant_id
WHERE l.language_code = $3 AND l.lemma = $1 AND l.part_of_speech = $2
ORDER BY s.id, tr.rank, v.id          -- deterministic pick: the form that ranked it highest
```

then order the result for the prompt in the outer query or in the repository, by `tr.rank` and `sense_code`. Drizzle has no first-class `DISTINCT ON`, so express it with `sql` — or as a `SELECT ... WHERE tr.rank = (SELECT min(...))` subquery if that reads better in this codebase; either is acceptable, the invariant is **one row per sense, chosen deterministically, over all variants**.

Add it to the returned object beside `findSensesByForm` and `persistEntries`.

- [ ] **Step 1b: Write the repository test that pins the entry_rank trap**

In `apps/server/tests/integration/repo/dictionary.test.ts`:

```ts
// The verb lexeme of an ambiguous lemma is entry 1, never entry 0. A lookup of
// `book` gives (book,noun) entry_rank 0 and (book,verb) entry_rank 1, so the
// verb lexeme owns no entry_rank 0 variant. findSensesByLexeme must still see
// its senses, or reconciliation silently never runs for verbs.
it('finds a lexeme that owns no entry_rank 0 variant', async () => {
  await persist('book', [
    entry('noun', 'printed_work', 'N1'),
    entry('verb', 'make_reservation', 'V1'),
  ]);

  const senses = await withTx(t.db, (tx) => createDictRepo(tx).findSensesByLexeme({
    lemma: 'book', partOfSpeech: 'verb', languageCode: 'en', userLanguageCode: 'he',
  }));

  expect(senses.map((x) => x.senseCode)).toEqual(['make_reservation']);
});

// A sense whose only rendering lives on a form other than the first must still
// reach the prompt, or it gets a freshly invented code on the next lookup.
it('returns one gloss per sense, across all variants', async () => {
  await persist('book', [entry('verb', 'make_reservation', 'V1')]);
  await persist('booked', [entry('verb', 'record_charge', 'V2')]);

  const senses = await withTx(t.db, (tx) => createDictRepo(tx).findSensesByLexeme({
    lemma: 'book', partOfSpeech: 'verb', languageCode: 'en', userLanguageCode: 'he',
  }));

  expect(senses.map((x) => x.senseCode).sort())
    .toEqual(['make_reservation', 'record_charge']);
});
```

Run them, watch them fail, then implement Step 1's query until they pass.

- [ ] **Step 2: Write the failing service tests**

Append to `apps/server/src/services/translations.test.ts`:

```ts
it('makes one client call when the lexeme is new', async () => {
  const llm = createFakeLlmClient([JSON.stringify(ONE_NEW_ENTRY)]);
  const service = createTranslationService({ llm: llm.client, transaction: emptyDb, logger });

  await service.translate({ text: 'book' });
  expect(llm.calls).toHaveLength(1);
});

it('makes a second call when the lexeme already has senses', async () => {
  const llm = createFakeLlmClient([
    JSON.stringify(ONE_NEW_ENTRY),
    JSON.stringify({ senses: [{ sense_code: 'reserve', translation: 'PAST-RESERVE' }] }),
  ]);
  const service = createTranslationService({
    llm: llm.client, transaction: dbWithStoredSenses, logger,
  });

  const result = await service.translate({ text: 'booked' });
  expect(llm.calls).toHaveLength(2);
  expect(result.senses[0].translation).toBe('PAST-RESERVE');
});

it('writes nothing and propagates the error when the second call fails', async () => {
  const llm = createFakeLlmClient([JSON.stringify(ONE_NEW_ENTRY), new LlmUnavailable('network failure')]);
  const persisted: unknown[] = [];
  const service = createTranslationService({
    llm: llm.client, transaction: recordingDb(persisted), logger,
  });

  await expect(service.translate({ text: 'booked' })).rejects.toThrow(LlmUnavailable);
  expect(persisted).toHaveLength(0);
});
```

`createFakeLlmClient` currently returns one canned response; widen it to take an array and to throw an entry that is an `Error`. `dbWithStoredSenses` is a fake transaction whose `findSensesByLexeme` returns one stored sense; `recordingDb` pushes every `persistEntries` call into the array so the third test can assert nothing was written.

- [ ] **Step 3: Write the integration proof — before the fix, not after**

This is the phase's most important test and it must be seen to fail. CLAUDE.md's rule for ADR
checks applies exactly: *a check that cannot fire prints nothing, exactly like a check that
passes.* Writing it after Step 4 would mean stashing the implementation to honour that.

In `apps/server/tests/integration/services/translations.test.ts`, against real Postgres and
MockServer:

```ts
it('reconciles a renamed sense instead of duplicating it', async () => {
  // call 1 for 'bank' — two senses, one of them named river_bank
  expectTranslation({ kind: 'word', entries: [BANK_NOUN_RIVER_BANK], matchText: 'bank' });
  await request('bank');

  // call 1 for 'banks' names the SAME sense river_edge; call 2 maps it back
  expectTranslation({ kind: 'word', entries: [BANKS_NOUN_RIVER_EDGE], matchText: 'banks' });
  expectReconciliation({ senses: [
    { sense_code: 'financial_institution', translation: 'BANKS-FIN' },
    { sense_code: 'river_bank', translation: 'BANKS-RIVER' },   // stored code reused
  ] });
  const answer = await request('banks');

  const senses = await db.select().from(dictSenses);
  expect(senses).toHaveLength(2);                               // not three
  expect(senses.map((x) => x.senseCode).sort())
    .toEqual(['financial_institution', 'river_bank']);
  expect(answer.senses.map((x) => x.translation))
    .toEqual(['BANKS-FIN', 'BANKS-RIVER']);
});
```

`expectReconciliation` is a new MockServer helper beside the existing one, matching the second
prompt and returning an `LlmReconciliationSchema` body. Add it to `tests/support/mockServer.ts`.

- [ ] **Step 4: Run everything and confirm it fails**

```bash
source ~/.zshrc && cd apps/server \
  && npx jest --selectProjects unit -t 'second call' 2>&1 | tail -25 \
  && npx jest --selectProjects integration -t 'reconciles a renamed sense' 2>&1 | tail -25
```

Expected: the unit tests FAIL — the service makes one call unconditionally. The integration
test FAILS with **three** senses, which is the duplication this task exists to prevent. Record
that output; it is the evidence the test can fire.

- [ ] **Step 5: Implement the branch**

In `services/translations.ts`. **Placement matters twice over.**

The branch goes **after** the `kind === 'sentence' || entries.length === 0` guard at
`translations.ts:99-102`, not straight after `mergeEntries`. A sentence is never written to the
dictionary, so putting the branch above the guard makes every sentence lookup pay a database
round trip and possibly a second model call for an answer that is then discarded.

And `flattened` is computed at `translations.ts:95` and returned by **two** paths — the guard at
line 102 and the failed-write catch at line 129. If `entries` is reassigned by reconciliation
after `flattened` was computed, the degraded path serves call 1's un-reconciled renderings while
the normal path serves the reconciled ones. **Recompute `flattened` after reconciliation.**

```ts
      const kind = resolveKind(text, parsed.kind);
      let entries = mergeEntries(parsed.entries);
      let flattened = normalizeSenses(kind, flattenEntries(entries));   // was `const`

      // ... the existing sentence / empty-entries guard returns here, unchanged ...

      // Two independent calls name the same sense differently — `bank` returns
      // river_bank where `banks` returns river_edge — so matching on sense_code
      // alone would silently duplicate a meaning. Where a lexeme already has
      // senses, a second, smaller call reconciles by meaning instead. R8 permits
      // this read: it precedes third-party I/O and opens no write.
      const stored = await transaction((repos) =>
        Promise.all(entries.map((entry) =>
          repos.dict.findSensesByLexeme({
            lemma: entry.lemma,
            partOfSpeech: entry.part_of_speech,
            languageCode: source,
            userLanguageCode: target,
          }),
        )),
      );

      if (stored.some((senses) => senses.length > 0)) {
        // A failure here is NOT degraded into a partial write. The dictionary has
        // no TTL, so a known-wrong row is permanent while a failed request costs
        // the learner one retry. This deliberately differs from the failed-write
        // path below, which protects a correct answer whose storage failed.
        entries = await reconcile({ llm, text, direction, entries, stored, logger });
        // Both return paths below read `flattened`; a stale one would serve the
        // un-reconciled renderings on the failed-write path only.
        flattened = normalizeSenses(kind, flattenEntries(entries));
      }
```

Write `reconcile` as a small module-private function in the same file: for each entry with stored senses, build the rendering prompt, call the client, parse with `parseLlmReconciliation`, drop renderings whose `translation` is `null`, **dedupe by `sense_code` keeping the first**, and rebuild the entry's senses in the returned order with ranks re-sequenced `0..n`. Entries with no stored senses pass through untouched. Let any thrown `LlmUnavailable` propagate — do not catch it.

The dedupe is not defensive tidying. Two renderings sharing a `sense_code` resolve to one sense id, so they become two rows with the same `(variant_id, sense_id, user_language_code)` — a primary-key collision that `DO NOTHING` swallows, losing a sense and leaving a hole in the rank sequence that `UNIQUE(variant_id, user_language_code, rank)` then rejects. Re-sequencing after the dedupe is what keeps ranks contiguous.

Log `dict_reconciled` with the entry count and the number of senses reused versus newly named, so drift is visible without reading rows.

- [ ] **Step 6: Run the service tests**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects unit -t 'second call' 2>&1 | tail -25
```

Expected: PASS.

- [ ] **Step 7: Run the integration proof and confirm it now passes**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects integration -t 'reconciles a renamed sense' 2>&1 | tail -25
```

Expected: PASS, with **two** senses where Step 4 recorded three.

- [ ] **Step 8: Full verification**

```bash
source ~/.zshrc && npm run typecheck && npm run test:all && npm run lint:arch
```

- [ ] **Step 9: Commit**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat: reconcile a new form's senses against the lexeme's by asking the model

Two lookups of one lexeme are two independent calls that name the same
sense differently, so matching on sense_code silently duplicated meanings.
A second, smaller call reconciles by meaning. If it fails, the lookup fails
rather than writing known-wrong rows into a dictionary with no TTL.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Carry both moves through export, restore and the seed

**Files:**
- Modify: `apps/server/src/db/dictExport.ts`, `apps/server/src/db/dictImport.ts`
- Modify: `apps/server/src/db/content.generated.ts` (regenerated, never hand-edited)
- Test: `apps/server/tests/integration/db/dictRoundTrip.test.ts`, `apps/server/tests/integration/db/seed.test.ts`

**Interfaces:**
- Consumes: `LlmEntry.part_of_speech` (Task 3); `persistEntries` writing per-variant translations (Task 4)
- Produces: a `DictRecord` whose entries carry `part_of_speech`, round-tripping byte-identically

- [ ] **Step 1: Write the failing round-trip test**

```ts
it('round-trips one lemma held as two lexemes', async () => {
  const record = {
    form: 'book',
    kind: 'word' as const,
    entries: [
      { lemma: 'book', part_of_speech: 'noun' as const, senses: [{ sense_code: 'printed_work', translation: 'N1' }] },
      { lemma: 'book', part_of_speech: 'verb' as const, senses: [{ sense_code: 'make_reservation', translation: 'V1' }] },
    ],
  };

  await importDictionary(t.db, {
    records: [record], languageCode: 'en', userLanguageCode: 'he',
    chunkSize: 100, onProgress: () => {},
  });
  const exported = await exportDictionary(t.db, { languageCode: 'en', userLanguageCode: 'he' });

  expect(exported).toEqual([record]);
});
```

The two functions are `importDictionary(db, { records, languageCode, userLanguageCode, chunkSize, onProgress })` and `exportDictionary(db, { languageCode, userLanguageCode })` — renamed from `importVocabulary`/`exportVocabulary` in Task 1. `dictExport.ts` also exports `toJsonl` and `fromJsonl`.

- [ ] **Step 2: Run and confirm failure**

```bash
source ~/.zshrc && cd apps/server && npx jest --selectProjects integration -t 'round-trips one lemma' 2>&1 | tail -25
```

- [ ] **Step 3: Update the exporter**

`FlatRow` gains `partOfSpeech: PartOfSpeech` selected from `dictLexemes`; its `exampleSource` **and `rank`** now come from `dictVarTranslations`. Add the `dictLexemes` join and put `dictVarTranslations` on `(variantId, senseId)`. In `groupRows`, set `part_of_speech` when the entry is first created and stop emitting it per sense. Update the block comment that explains omitting a null `part_of_speech` — it can no longer be null.

- [ ] **Step 4: Confirm the importer**

`dictImport.ts` replays through `persistEntries`, so it likely needs no change. Read it and confirm; if it reshapes entries, follow the moved field.

- [ ] **Step 5: Run the round-trip test**

Expected: PASS.

- [ ] **Step 6: Re-record the seed fixture**

The daily Gemini quota is exhausted, so use a different model id. Configuration only.

```bash
source ~/.zshrc && cd apps/server && GEMINI_MODEL=gemini-2.5-flash-lite npm run content:generate
```

**Read the diff.** Every entry must carry a `part_of_speech` from the ten-value enum, and `book` must appear as two entries. If any recording still shows one entry spanning two parts of speech, the Task 3 prompt change is incomplete — go back rather than hand-editing the fixture.

- [ ] **Step 7: Reseed and run the seed tests**

```bash
source ~/.zshrc && cd apps/server && npm run db:reseed && npx jest --selectProjects integration -t 'seed' 2>&1 | tail -25
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/db apps/server/tests
git commit -m "feat: carry the lexeme and per-form translation through export and the seed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Score both defects in the eval bucket

**Files:**
- Modify: `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/run.ts`

**Interfaces:**
- Consumes: `LlmEntry.part_of_speech` (Task 3); `askModel` returning `entries`

This task calls a real model. `npm run eval` is in neither `npm test` nor `npm run test:all`; CI runs it as its own `test-eval` job. Quota is exhausted, so set `GEMINI_MODEL` to a different Gemini model id.

- [ ] **Step 1: Extend the case type**

In `cases.ts`:

```ts
  /** Every entry's part_of_speech must be one of these. `booked` is a verb form,
   *  so a noun entry is the reading defect returning. */
  expectEntryPos?: string[];
  /** Exactly these parts of speech, in this order, one entry each. */
  expectPosOrder?: string[];
  /** The top translation must NOT be any of these — the rendering defect:
   *  `booked` answering with an infinitive rather than a past tense. */
  rejectTop?: string[];
```

- [ ] **Step 2: Invert `book` and add two cases**

Replace the existing `book` case (it currently asserts `expectEntries: 1` and `expectEntrySenses: 2`, which encodes the bug — delete `expectEntrySenses`):

```ts
  {
    label: 'one lemma, two parts of speech, two entries',
    text: 'book',
    expectKind: 'word',
    acceptTop: ['ספר'],
    expectAlso: ['להזמין', 'הזמנה', 'לשריין'],
    expectEntries: 2,
    expectPosOrder: ['noun', 'verb'],
  },
```

Add:

```ts
  {
    label: 'an inflected form: its own part of speech, in its own tense',
    text: 'booked',
    expectKind: 'word',
    acceptTop: ['הזמין', 'תפוס'],
    rejectAny: ['ספר'],
    rejectTop: ['להזמין'],
    expectEntryPos: ['verb', 'adjective'],
  },
  {
    label: 'three parts of speech of one lemma, under the raised cap',
    text: 'light',
    expectKind: 'word',
    acceptTop: ['אור'],
    expectAlso: ['קל', 'בהיר', 'להדליק'],
    expectEntries: 3,
  },
```

`booked` scores both halves of the reported defect in one case: `rejectAny: ['ספר']` is the reading, `rejectTop: ['להזמין']` is the rendering. Leave `saw` (two entries) and `running` (lemma `run`) exactly as they are — both must still hold.

- [ ] **Step 3: Enforce the new fields in the runner**

Tier 1 gains: every entry carries a `part_of_speech` that `PartOfSpeechSchema` accepts. Tier 2 gains:

```ts
if (evalCase.expectEntryPos) {
  const offenders = result.entries
    .map((e) => e.part_of_speech)
    .filter((pos) => !evalCase.expectEntryPos!.includes(pos));
  tier2.push({
    name: 'entry parts of speech',
    ok: offenders.length === 0,
    detail: offenders.length ? `unexpected: ${offenders.join(', ')}` : undefined,
  });
}

if (evalCase.expectPosOrder) {
  const actual = result.entries.map((e) => e.part_of_speech);
  tier2.push({
    name: 'part of speech order',
    ok: JSON.stringify(actual) === JSON.stringify(evalCase.expectPosOrder),
    detail: `got ${actual.join(', ')}`,
  });
}

if (evalCase.rejectTop) {
  const top = result.senses[0]?.translation ?? '';
  tier2.push({
    name: 'top translation form',
    ok: !evalCase.rejectTop.includes(top),
    detail: `top was ${top}`,
  });
}
```

- [ ] **Step 4: Run the evals**

```bash
source ~/.zshrc && cd apps/server && GEMINI_MODEL=gemini-2.5-flash-lite npm run eval 2>&1 | tail -40
```

Expected: tier 1 fully green; tier 2 at or above `TIER2_THRESHOLD` (0.85). The `booked` case must pass — it is the phase's reason for existing.

**If tier 2 drops below threshold, do not lower `TIER2_THRESHOLD`.** Read the `eval-report` artifact and fix the prompt. If the drop is confined to cases unrelated to part of speech or tense, suspect the model swap rather than the diff, and re-run against the original `GEMINI_MODEL` once quota allows.

- [ ] **Step 5: Commit**

```bash
git add apps/server/tests/eval
git commit -m "test: score the inflected-form reading and rendering in the eval bucket

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Documentation, and handing the backfill over

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-13-lang-tutor-phase-11-vocabulary-backfill-sourcing.md` (status note only)
- Keep: `data/backfill/en-he/dictionary.jsonl` — stale, but kept until the user's re-run replaces it

- [ ] **Step 1: Update the README**

Add phase 12 to the phase index. Under the dictionary section:

> **Migration `0005` clears the dictionary, the quiz tables and session history.** A row in
> `dict_lexemes` is now a lexeme — a lemma together with a part of speech — and a translation
> belongs to a form rather than to a meaning. The old rows record neither, so they cannot be
> migrated. `users` survives.

Beside `npm run dict:restore`:

> **`data/backfill/en-he/dictionary.jsonl` predates migration `0005` and will not restore.**
> Its entries carry no `part_of_speech`, and the renderings it holds were stored per meaning
> rather than per form, so restoring it would reintroduce both defects phase 12 fixes. The file
> is kept until a fresh backfill replaces it.

Confirm the README no longer says `vocab:export` or `vocab:restore` anywhere (Task 1 should have caught it).

- [ ] **Step 2: Add a status note to the phase 11 spec**

Under **Status**, append:

> Superseded in part by phase 12: migration `0005` changed what a row means twice over, so the
> dataset this phase produced is invalid and the backfill restarts from the CSVs. The sourcing
> scripts, the resumable runner and the export/restore mechanism are unaffected and are what the
> re-run uses; the commands are now `dict:export` and `dict:restore`.

- [ ] **Step 3: Record the hand-over, and stop**

Beside `run-backfill-daily.mjs` in the README:

> After phase 12 the backfill starts over from the full CSVs rather than from a `-remaining-`
> file. At Gemini's 10K/day quota the ~89K set takes roughly nine days of gradual runs, so it is
> run deliberately and is not part of any phase's build.

**Do not run the backfill.** The phase ends here.

- [ ] **Step 4: Final verification**

```bash
source ~/.zshrc && npm run typecheck && npm run test:all && npm run lint:arch && npm run e2e
git grep -n 'vocab\|Vocab' -- 'apps/*' 'packages/*' 'scripts/*' 'e2e/*' ':!*db/migrations/*'
git status --short -- apps/mobile
```

Expected: all green; `lint:arch` reports 17 / 7 / 6 / 7 / 3 rules. The `git grep` returns only the prose comment in `apps/mobile/src/app/translate.tsx`. `git status` on `apps/mobile` is empty. Confirm `src/openapi.test.ts` passed without modification.

- [ ] **Step 5: Commit**

```bash
git add README.md docs
git commit -m "docs: record phase 12's migrations, the invalidated dataset and the re-run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verification summary

Criterion numbers match the spec's *Success criteria* list.

| Success criterion (spec) | Task | How it is proved |
|---|---|---|
| 1. `booked` serves no noun sense | 2, 4 | `dictionary.pos.test.ts`, seen to fail first |
| 2. `booked` renders past, `book` infinitive | 2, 4 | `dictionary.form.test.ts`, seen to fail first |
| 3. Writing `booked` leaves `book` unchanged | 2, 4 | `dictionary.form.test.ts` second case |
| 4. Second call fires only when the lexeme has senses; a mapped sense reuses its row | 5 | `translations.test.ts` call-count tests; integration `bank`/`banks` leaves two senses |
| 5. A failed second call writes nothing and surfaces the error | 5 | `translations.test.ts` "writes nothing and propagates" |
| 6. A genuinely new sense is added and ranked by this form | 4, 5 | `dictionary.test.ts` "ranks a new sense where THIS form put it" |
| 7. Either arrival order gives the same two answers | 4 | `dictionary.test.ts` "same two answers whichever form is looked up first" |
| 8. `book` is two entries, interleaved | 4, 7 | `dictionary.order.test.ts`; eval `expectPosOrder` |
| 9. Two lexemes per lemma; duplicate pair and duplicate `sense_code` rejected | 4 | `dictionary.test.ts` unique-key assertions |
| 10. `light` returns three entries; seven rejected | 3, 7 | `schemas.test.ts` cap test; eval `light` case |
| 11. Every stored part of speech is one of ten | 3 | `PartOfSpeechSchema` in `responseSchema` + `schemas.test.ts` |
| 12. No `vocab`/`term_` name survives | 1, 8 | `git grep` in both tasks |
| 13. OpenAPI byte-identical, no mobile change | 8 | `openapi.test.ts` unmodified; `git status` check |
| 14. `test:all` and `e2e` green with no network | 8 | Final verification step |
| 15. `lint:arch` still 17 ADR 0001 checks | 1, 4, 8 | Run in three tasks |
| 16. Seed answers with no provider request | 6 | `db:reseed` then `seed.test.ts` |
