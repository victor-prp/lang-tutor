# Phase 10 — Persisting and reusing vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A translation the model answers is written to a shared Postgres dictionary, and the next lookup of that string — by anyone — is served without reaching the provider.

**Architecture:** The model is asked for **entries** (one per headword), not for one flat sense list. `domain/vocabulary.ts` maps between model entries and database rows and stays pure; `repo/vocabulary.ts` owns one read (`findSensesByForm`) and one write (`persistEntries`); `services/translations.ts` becomes read → model on a miss → write, which is two short transactions with the provider call between them. The seed stops being a special case: `db/content.generated.ts` holds real recorded provider answers and `db/seed.ts` replays them through `persistEntries`, so seeded rows and looked-up rows are indistinguishable. Nothing on the wire changes and `apps/mobile` is not touched.

**Tech Stack:** TypeScript, Hono + `@hono/zod-openapi`, Zod 4, Drizzle ORM 0.45 + drizzle-kit, Postgres 17, Jest (two projects), Playwright, MockServer, Gemini `generateContent`, `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-09-lang-tutor-phase-10-vocabulary-persistence-design.md`

## Global Constraints

Every task's requirements implicitly include this section. Values are verbatim from the spec.

**Running anything.** This repo's shell has a stripped `PATH`. Prefix every command that needs `npm`, `node`, `npx` or `docker` with:

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
```

**Never run `npm run db:up` from a worktree** while another checkout's Postgres holds port 5432 — compose derives its project name from the directory and starts a second container that fails. Reuse the running one. In a fresh worktree run `./scripts/setup-worktree.sh` first.

**Contract**

- `LlmTranslationSchema` = `{ kind, entries }`. `entries` is `z.array(LlmEntrySchema).max(3)`.
- `LlmEntrySchema` = `{ lemma: z.string().min(1), senses: z.array(LlmSenseSchema).min(1).max(5) }`.
- `LlmSenseSchema` = `TranslationSenseSchema.extend({ sense_code: z.string().min(1).max(60) })`.
- `TranslationRequestSchema` and `TranslationResponseSchema` are **byte-identical to phase 9**. The published OpenAPI document must not move and `src/openapi.test.ts` must not change.
- `sense_code` must never reach a client. Every response sense is built **field by field**, never by spreading a model sense or a row.
- Response sense cap: **5**. The database stores every sense; only the response truncates.
- `entries: []` is the "no translation" answer — `200` with `senses: []`. An entry with **zero** senses fails the parse and is `TranslationUnreadable`.

**Behaviour**

- A sentence, an empty entry list, and any failure are **never written**. Repeat lookups of each keep costing.
- First writer wins on senses, permanently. A term that already has senses is never rewritten, merged, or refreshed. No TTL, no invalidation.
- A variant is written **only for the form that was actually queried**. No lemma alias is ever synthesized.
- The write ends by **re-reading** the by-form query, so the writer's response is the same merge the next reader gets.
- A write that throws is caught, logged at error level as `vocab_persist_failed`, and the parsed entries are flattened and served with `200`.
- `normalizeForm` = trim + collapse internal whitespace. **No lowercasing** — case is handled by `lower(form)` in the index. No nikud stripping, no punctuation rules.
- New log events: `vocab_cache_hit` (term count, sense count), `vocab_persisted` (entry count, terms created), `vocab_persist_failed` (error level). The existing `translated` line stays and keeps its exact shape.

**Ordering — the phase's most load-bearing rule**

```sql
ORDER BY s.rank,        -- round-robin across headwords
         v.entry_rank,  -- the model's own ranking, made with every reading in one context
         v.term_id      -- total; the first two cannot both tie across terms in practice
LIMIT 5
```

`vocab_term_senses.rank` orders senses **within one headword**; `term_variants.entry_rank` orders headwords **within one form**. They are not the same number and neither is a frequency score. Rank leads so the merge is round-robin, never block-per-entry.

**Database**

- Migration `0003` begins with `TRUNCATE vocab_terms, sessions CASCADE;` so every new column lands on empty tables — no backfills, no dropped defaults.
- The same statement is written a second time in `src/db/reseed.ts` rather than imported from the migration: the migration is frozen history, the command is live.
- `form` stores the string as it was written; matching is always `lower(form)`.
- `UNIQUE(language_code, lower(form), entry_rank)` on `term_variants` doubles as the lookup index.
- Sense ranks are contiguous `0..n`. `entry_rank` is `NOT NULL` and starts at 0 per write.

**ADRs**

- ADR 0001 R3: `apps/server/src/domain/` may import **only** `@lang-tutor/core/*`. Not `../errors`, not `../repo/*`. Row shapes it needs are declared locally.
- ADR 0001 R2: `services/` may import `repo/` **as types only**, and nothing under `db/`.
- ADR 0001 R8's detection grep matches the literal `.transaction(`. Write `transaction(...)` in the service (destructured), never `deps.transaction(...)`, and never `db.transaction(...)` outside `db/transaction.ts` — `db/seed.ts` goes through `createTransaction` for exactly this reason.
- ADR 0002: no `jest.mock`; no optional or defaulted collaborator parameters; `process.env` only in `index.ts`, `db/cli.ts`, `_layout.tsx`. **No new composition root** — `db:reseed` runs through the existing `db/cli.ts`.
- ADR 0004: folder decides the bucket. `src/**/*.test.ts` must run with Docker stopped and must not import `pg`, `drizzle-orm`, or `db/{client,migrate,seed,cli}`. Anything a unit test takes from `repo/` must be `import type`, or Jest will load `drizzle-orm` at runtime.
- **`npm run lint:arch` must still report seventeen ADR 0001 checks.** This phase adds no check and no script, so there is no planted-violation step — stated because phase 9 established that a check must be shown to fail before it is trusted, and the counterpart is that a phase adding none says so.

**Test words**

After Task 7 the seeded strings answer from Postgres. Any test that expects a provider call must use a string the seed does not contain. The sixteen seeded queries are: `window`, `book`, `water`, `friend`, `difficult`, `to remember`, `excuse me`, `good morning`, `thank you very much`, `How do you do?`, `see you later`, `I don't understand`, `What is your name?`, `Have a nice day!`, `Where is the station?`, `Nice to meet you`. Use `ladder`, `saw`, `saws`, `see`, `kite` or `anchor` instead.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/server/src/domain/vocabulary.ts` | `normalizeForm`, `languagesFor`, `mergeEntries`, `entriesToRows`, `rowsToSenses`, `flattenEntries`, and the locally-declared row shapes. Pure |
| `apps/server/src/domain/vocabulary.test.ts` | Unit tests for the above |
| `apps/server/src/repo/vocabulary.ts` | `createVocabRepo` — `findSensesByForm`, `persistEntries`. The only SQL this phase adds |
| `apps/server/src/db/content.generated.ts` | The recorded provider answers. Written by the recorder, reviewed by a human, committed |
| `apps/server/src/db/reseed.ts` | `reseedContent` — the truncate, then `seedContent` |
| `apps/server/src/db/migrations/0003_*.sql` | The delete and the new shape |
| `apps/server/tests/eval/askModel.ts` | Prompt → client → parse → merge, shared by the eval runner and the recorder |
| `apps/server/tests/eval/generate-content.ts` | The recorder. `npm run content:generate [-- <query>]` |
| `apps/server/tests/integration/repo/vocabulary.test.ts` | The read and the write against real Postgres |
| `apps/server/tests/integration/repo/vocabulary.order.test.ts` | The merge across headwords, with rows inserted directly |
| `apps/server/tests/integration/services/translations.test.ts` | The use case against a real database and MockServer |
| `apps/server/tests/integration/db/reseed.test.ts` | The operation that makes re-recording possible |

**Modified**

| File | Change |
|---|---|
| `packages/core/src/api/schemas.ts` | `LlmSenseSchema`, `LlmEntrySchema`, rewritten `LlmTranslationSchema` |
| `packages/core/src/api/types.ts`, `index.ts` | `LlmSense`, `LlmEntry` inferred and exported |
| `packages/core/src/api/schemas.test.ts` | The entries contract |
| `apps/server/src/db/schema.ts` | Part of speech moves to the sense; `rank`, `example_source`, `example_target`, `language_code`, `entry_rank`, the unique index, three id defaults |
| `apps/server/src/db/content.ts` | Split: quiz authoring and the strings to record |
| `apps/server/src/db/content.test.ts` | Rewritten around the split |
| `apps/server/src/db/seed.ts` | Replays the recording through `persistEntries` |
| `apps/server/src/db/cli.ts` | `--reseed` |
| `apps/server/src/domain/translation.ts` | The prompt asks for entries |
| `apps/server/src/domain/translation.test.ts` | Entries in the prompt and in the parse |
| `apps/server/src/services/transaction.ts` | `Repos` gains `vocab` |
| `apps/server/src/services/translations.ts` | Gains `transaction`; read → model on a miss → write |
| `apps/server/src/services/translations.test.ts` | The new use case |
| `apps/server/src/composition.ts` | Binds `createVocabRepo(tx)`, passes `transaction` to the service |
| `apps/server/tests/support/fakes.ts` | `createFakeTransaction` takes a partial `Repos`; `createFakeVocabRepo` |
| `apps/server/tests/support/mockServer.ts` | `entries` payloads; a request-count helper |
| `apps/server/tests/eval/run.ts` | Scores through `askModel`; tier 1 entry invariants |
| `apps/server/tests/eval/cases.ts` | `saw`, and entry expectations on `book` and `running` |
| `apps/server/tests/integration/db/schema.test.ts` | The new required columns |
| `apps/server/tests/integration/db/seed.test.ts` | Rewritten: the seed writes what the recording says |
| `apps/server/tests/integration/repo/questions.test.ts` | Term ids are server-issued now |
| `apps/server/tests/integration/routes/translations.test.ts` | Non-seeded words; reuse over HTTP; the recorded string |
| `apps/server/tests/integration/composition.test.ts` | The translations service receives a transaction |
| `e2e/tests/translate.spec.ts` | Non-seeded words; the reuse spec |
| `docs/adr/adr-0001-layered-architecture.md` | R8's second amendment and the `Query` seam; R4 gains `repo/*` for `db/` |
| `docs/adr/adr-0002-di-with-closures.md` | R6's factory list gains `createVocabRepo` |
| `docs/adr/adr-0004-test-topology.md` | R4's `tests/eval/` clause names the recorder |
| `README.md` | Phase index, data model, *Reading the API*, the two new commands, the migration warning |
| `package.json`, `apps/server/package.json` | `content:generate`, `db:reseed` |

**Deliberately unchanged:** `apps/server/src/routes/translations.ts`, `apps/server/src/openapi.test.ts`, everything under `apps/mobile/`, and `scripts/check-adr-*.sh`.

---

### Task 1: The model returns entries, and the wire response does not change

The contract swap, done in one commit because half of it does not compile. Nothing is
persisted yet: the service flattens the entries it parsed and answers exactly as phase 9
did.

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (the `LlmTranslationSchema` block at the end)
- Modify: `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Test: `packages/core/src/api/schemas.test.ts`
- Create: `apps/server/src/domain/vocabulary.ts`
- Test: `apps/server/src/domain/vocabulary.test.ts`
- Modify: `apps/server/src/domain/translation.ts` (`buildPrompt`)
- Test: `apps/server/src/domain/translation.test.ts`
- Modify: `apps/server/src/services/translations.ts`
- Test: `apps/server/src/services/translations.test.ts`
- Modify: `apps/server/tests/support/mockServer.ts`
- Test: `apps/server/tests/integration/routes/translations.test.ts`
- Modify: `e2e/tests/support/mockServer.ts`, `e2e/tests/translate.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LlmSenseSchema`, `LlmEntrySchema`, `LlmTranslationSchema` (values) and `LlmSense`,
    `LlmEntry`, `LlmTranslation` (types) from `@lang-tutor/core/api`.
    `LlmEntry = { lemma: string; senses: LlmSense[] }`;
    `LlmSense = { translation: string; part_of_speech?: string; example?: { source: string; target: string }; sense_code: string }`.
  - `mergeEntries(entries: LlmEntry[]): LlmEntry[]` and
    `flattenEntries(entries: LlmEntry[]): TranslationSense[]` from
    `apps/server/src/domain/vocabulary.ts`.
  - `expectGeminiJson(ns, { kind, entries, matchText? })` and
    `expectGeminiDelayedJson(ns, { kind, entries, delayMs })` in
    `apps/server/tests/support/mockServer.ts`.
  - `expectGemini(request, { kind, entries })` in `e2e/tests/support/mockServer.ts`.

- [ ] **Step 1: Write the failing core schema tests**

Replace the whole `describe('LlmTranslationSchema', …)` block at the end of
`packages/core/src/api/schemas.test.ts` with:

```ts
describe('LlmTranslationSchema', () => {
  const sense = { translation: 'ספר', part_of_speech: 'noun', sense_code: 'printed_book' };

  it('is a list of entries, each a lemma with its own ranked senses', () => {
    const result = LlmTranslationSchema.safeParse({
      kind: 'word',
      entries: [{ lemma: 'book', senses: [sense] }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts two entries — the reason the shape is nested at all', () => {
    const result = LlmTranslationSchema.safeParse({
      kind: 'word',
      entries: [
        { lemma: 'see', senses: [{ translation: 'לראות', sense_code: 'perceive' }] },
        { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('treats an empty entry list as the "no translation" answer, not as malformed', () => {
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [] }).success).toBe(true);
  });

  it('rejects an entry with no lemma', () => {
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: [{ senses: [sense] }] }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: [{ lemma: '', senses: [sense] }] })
        .success,
    ).toBe(false);
  });

  it('rejects an entry with an empty sense list — meaningless, not empty', () => {
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: [{ lemma: 'book', senses: [] }] })
        .success,
    ).toBe(false);
  });

  it('requires a sense_code on every sense', () => {
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ lemma: 'book', senses: [{ translation: 'ספר' }] }],
      }).success,
    ).toBe(false);
  });

  it('caps entries at three and senses at five within an entry', () => {
    const entry = { lemma: 'x', senses: [sense] };
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: Array(3).fill(entry) }).success,
    ).toBe(true);
    expect(
      LlmTranslationSchema.safeParse({ kind: 'word', entries: Array(4).fill(entry) }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [{ lemma: 'x', senses: Array(6).fill(sense) }],
      }).success,
    ).toBe(false);
  });

  it('keeps sense_code off the response shape, which is shared with the wire', () => {
    const result = TranslationResponseSchema.safeParse({
      text: 'book',
      direction: 'en_he',
      kind: 'word',
      senses: [{ translation: 'ספר', sense_code: 'printed_book' }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.senses[0]).not.toHaveProperty('sense_code');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w @lang-tutor/core
```

Expected: FAIL — `LlmTranslationSchema` still requires `senses`, so the first test's payload
does not parse.

- [ ] **Step 3: Replace `LlmTranslationSchema` in `packages/core/src/api/schemas.ts`**

Replace the final block (the phase 9 `LlmTranslationSchema`) with:

```ts
// What the model is asked to return. Phase 10 made it a list of **entries**,
// because a string can be more than one word: `saw` is the verb `see` and the
// noun `saw`, and an earlier single-lemma shape could only ever answer one of
// them. Deliberately still the response shape *minus* `text` and `direction`:
// both are decided in code before the call, so offering them to the model would
// only invite it to disagree with the server.
//
// `sense_code` goes on an extension rather than on TranslationSenseSchema,
// which is shared with the wire. It is model-supplied, has no functional role —
// senses are never merged within a term — and exists so a row reads as
// financial_institution rather than s0 during a play-test.
export const LlmSenseSchema = TranslationSenseSchema.extend({
  sense_code: z.string().min(1).max(60),
});

// min(1): an entry with no senses is meaningless, and a model returning one is
// malformed rather than empty — the empty answer is `entries: []`.
export const LlmEntrySchema = z.object({
  lemma: z.string().min(1),
  senses: z.array(LlmSenseSchema).min(1).max(5),
});

export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  // Ranked: the likeliest reading of the typed form first. Most strings have
  // one entry, so the typical answer is the size phase 9 already returned.
  entries: z.array(LlmEntrySchema).max(3),
});
```

- [ ] **Step 4: Infer and export the two new types**

In `packages/core/src/api/types.ts`, add `LlmEntrySchema,` and `LlmSenseSchema,` to the
`import type { … } from './schemas'` list (alphabetically, before `LlmTranslationSchema`),
and add beside the existing `LlmTranslation` line:

```ts
export type LlmSense = z.infer<typeof LlmSenseSchema>;
export type LlmEntry = z.infer<typeof LlmEntrySchema>;
```

In `packages/core/src/api/index.ts`, add `LlmEntry,` and `LlmSense,` to the exported type
list (alphabetically, beside `LlmTranslation`).

- [ ] **Step 5: Run the core tests to verify they pass**

```bash
npm test -w @lang-tutor/core
```

Expected: PASS.

- [ ] **Step 6: Write the failing `domain/vocabulary.ts` tests**

Create `apps/server/src/domain/vocabulary.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';

import { flattenEntries, mergeEntries } from './vocabulary';

const sense = (translation: string, sense_code: string): LlmEntry['senses'][number] => ({
  translation,
  sense_code,
});

describe('mergeEntries', () => {
  it('leaves distinct lemmas alone, in order', () => {
    const entries: LlmEntry[] = [
      { lemma: 'see', senses: [sense('לראות', 'perceive')] },
      { lemma: 'saw', senses: [sense('מסור', 'tool')] },
    ];
    expect(mergeEntries(entries)).toEqual(entries);
  });

  it('concatenates same-lemma entries in order, because the write cannot', () => {
    // Dictionaries publish `book` as book:1 and book:2, so a model may well
    // split by part of speech. Under UNIQUE(language_code, lemma) the second
    // entry would silently lose its senses.
    const merged = mergeEntries([
      { lemma: 'book', senses: [sense('ספר', 'printed_book')] },
      { lemma: 'book', senses: [sense('להזמין', 'reserve')] },
    ]);
    expect(merged).toEqual([
      {
        lemma: 'book',
        senses: [sense('ספר', 'printed_book'), sense('להזמין', 'reserve')],
      },
    ]);
  });

  it('does not mutate the entries it was given', () => {
    const first: LlmEntry = { lemma: 'book', senses: [sense('ספר', 'printed_book')] };
    mergeEntries([first, { lemma: 'book', senses: [sense('להזמין', 'reserve')] }]);
    expect(first.senses).toHaveLength(1);
  });

  it('handles an empty list', () => {
    expect(mergeEntries([])).toEqual([]);
  });
});

describe('flattenEntries', () => {
  it('interleaves by rank rather than by entry, so no headword is crowded out', () => {
    const flat = flattenEntries([
      {
        lemma: 'see',
        senses: [sense('לראות', 'a'), sense('להבין', 'b'), sense('לפגוש', 'c')],
      },
      { lemma: 'saw', senses: [sense('מסור', 'd'), sense('לנסר', 'e')] },
    ]);
    expect(flat.map((s) => s.translation)).toEqual([
      'לראות',
      'מסור',
      'להבין',
      'לנסר',
      'לפגוש',
    ]);
  });

  it('caps the flattened list at five', () => {
    const flat = flattenEntries([
      { lemma: 'a', senses: [1, 2, 3, 4].map((n) => sense(`a${n}`, `a${n}`)) },
      { lemma: 'b', senses: [1, 2, 3, 4].map((n) => sense(`b${n}`, `b${n}`)) },
    ]);
    expect(flat).toHaveLength(5);
    expect(flat.map((s) => s.translation)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('never emits sense_code, which must not reach a client', () => {
    const flat = flattenEntries([{ lemma: 'book', senses: [sense('ספר', 'printed_book')] }]);
    expect(flat[0]).toEqual({ translation: 'ספר' });
    expect(flat[0]).not.toHaveProperty('sense_code');
  });

  it('carries a part of speech and a complete example through', () => {
    const flat = flattenEntries([
      {
        lemma: 'book',
        senses: [
          {
            translation: 'ספר',
            part_of_speech: 'noun',
            example: { source: 'I read a book.', target: 'קראתי ספר.' },
            sense_code: 'printed_book',
          },
        ],
      },
    ]);
    expect(flat[0]).toEqual({
      translation: 'ספר',
      part_of_speech: 'noun',
      example: { source: 'I read a book.', target: 'קראתי ספר.' },
    });
  });

  it('handles an empty list', () => {
    expect(flattenEntries([])).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it to make sure it fails**

```bash
npm test -w apps/server -- domain/vocabulary
```

Expected: FAIL — `Cannot find module './vocabulary'`.

- [ ] **Step 8: Write `apps/server/src/domain/vocabulary.ts`**

```ts
import type { LlmEntry, LlmSense, TranslationSense } from '@lang-tutor/core/api';

/**
 * The pure core of the dictionary: how a model's entries become rows, how rows
 * become a response, and how a form is normalized before either happens.
 *
 * ADR 0001 R3 forbids every cross-layer import here — no Drizzle, no `../errors`,
 * no `../repo/*` — so the row shapes this module accepts are declared locally,
 * the same arrangement `domain/translation.ts` already uses for
 * `TranslationPrompt`. `repo/vocabulary.ts` imports these types; nothing here
 * imports it.
 */

// The response cap, and the only place five appears in this layer. The database
// stores every sense; only what a client sees is truncated.
const RESPONSE_SENSE_CAP = 5;

/**
 * Field by field, never a spread. `sense_code` is on the model's sense and must
 * not reach a client, and a spread is exactly how it would — silently, and
 * without failing a schema, because Zod strips unknown keys on parse rather
 * than on serialize.
 */
function toResponseSense(sense: LlmSense): TranslationSense {
  const result: TranslationSense = { translation: sense.translation };
  if (sense.part_of_speech) result.part_of_speech = sense.part_of_speech;
  if (sense.example) result.example = { source: sense.example.source, target: sense.example.target };
  return result;
}

/**
 * One entry per lemma, enforced rather than trusted. Merriam-Webster publishes
 * `book:1` and `book:2`, so a model pulled by that convention may split one
 * lemma by part of speech; under UNIQUE(language_code, lemma) the second such
 * entry would resolve to the same term, find senses already written, and be
 * silently dropped. The prompt asks for one entry per headword and this makes
 * it true regardless. Rejecting the answer instead would throw away content
 * over a formatting choice.
 *
 * Exact-string keys: `vocab_terms` is unique on the exact lemma, so anything
 * looser here would merge two rows the database keeps apart.
 */
export function mergeEntries(entries: LlmEntry[]): LlmEntry[] {
  const byLemma = new Map<string, LlmEntry>();
  for (const entry of entries) {
    const existing = byLemma.get(entry.lemma);
    if (existing) existing.senses = [...existing.senses, ...entry.senses];
    else byLemma.set(entry.lemma, { lemma: entry.lemma, senses: [...entry.senses] });
  }
  return [...byLemma.values()];
}

/**
 * The flat answer, ordered exactly as the by-form read orders it: by sense rank
 * first and entry order second. Round-robin, not block-per-entry — a five-sense
 * `see` ahead of `saw` would push `מסור` off the cap entirely, which is the
 * disappearance the entries model exists to prevent.
 *
 * Used on the paths that do not write (a failed write, and the fallback) so
 * those answers match what a later lookup will return.
 */
export function flattenEntries(entries: LlmEntry[]): TranslationSense[] {
  const flat: TranslationSense[] = [];
  const deepest = Math.max(0, ...entries.map((entry) => entry.senses.length));
  for (let rank = 0; rank < deepest; rank++) {
    for (const entry of entries) {
      const sense = entry.senses[rank];
      if (sense) flat.push(toResponseSense(sense));
    }
  }
  return flat.slice(0, RESPONSE_SENSE_CAP);
}
```

- [ ] **Step 9: Run it to verify it passes**

```bash
npm test -w apps/server -- domain/vocabulary
```

Expected: PASS.

- [ ] **Step 10: Write the failing prompt and parse tests**

In `apps/server/src/domain/translation.test.ts`, add to the `describe('buildPrompt', …)`
block:

```ts
  it('asks for entries, one per headword, ranked', () => {
    const { system } = buildPrompt({ text: 'saw', direction: 'en_he' });
    expect(system).toMatch(/entry per headword/i);
    expect(system).toMatch(/at most 3/i);
  });

  it('gives book as the worked example, since the nested shape invites splitting', () => {
    const { system } = buildPrompt({ text: 'book', direction: 'en_he' });
    expect(system).toContain('book');
    expect(system).toContain('ספר');
    expect(system).toContain('להזמין');
  });

  it('asks for a sense_code on every sense', () => {
    expect(buildPrompt({ text: 'bank', direction: 'en_he' }).system).toMatch(/sense_code/);
  });

  it('says senses belong to the headword, not to the typed form', () => {
    expect(buildPrompt({ text: 'running', direction: 'en_he' }).system).toMatch(/inflected/i);
  });
```

and replace the whole `describe('parseLlmTranslation', …)` block with:

```ts
describe('parseLlmTranslation', () => {
  const sense = { translation: 'ספר', sense_code: 'printed_book' };

  it('parses a well-formed response', () => {
    const raw = JSON.stringify({ kind: 'word', entries: [{ lemma: 'book', senses: [sense] }] });
    expect(parseLlmTranslation(raw)).toEqual({
      kind: 'word',
      entries: [{ lemma: 'book', senses: [sense] }],
    });
  });

  it('parses a two-entry payload — the answer the entries model exists for', () => {
    const raw = JSON.stringify({
      kind: 'word',
      entries: [
        { lemma: 'see', senses: [{ translation: 'לראות', sense_code: 'perceive' }] },
        { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
      ],
    });
    expect(parseLlmTranslation(raw)?.entries).toHaveLength(2);
  });

  it('treats null and absent identically, so an OpenAI-style response still parses', () => {
    const raw = JSON.stringify({
      kind: 'sentence',
      entries: [
        {
          lemma: 'I read a book',
          senses: [
            {
              translation: 'קראתי ספר.',
              part_of_speech: null,
              example: null,
              sense_code: 'the_sentence',
            },
          ],
        },
      ],
    });
    const parsed = parseLlmTranslation(raw);
    expect(parsed?.entries[0].senses[0]).not.toHaveProperty('part_of_speech');
  });

  it('treats an empty entry list as the empty answer rather than as unreadable', () => {
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [] }))).toEqual({
      kind: 'word',
      entries: [],
    });
  });

  it('returns null for output that is not JSON', () => {
    expect(parseLlmTranslation('I cannot help with that.')).toBeNull();
    expect(parseLlmTranslation('')).toBeNull();
  });

  it('returns null for JSON of the wrong shape', () => {
    expect(parseLlmTranslation(JSON.stringify({ entries: [] }))).toBeNull();
    expect(parseLlmTranslation(JSON.stringify({ kind: 'clause', entries: [] }))).toBeNull();
    // The phase 9 shape is now the wrong shape.
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', senses: [sense] }))).toBeNull();
  });

  it('returns null for an entry missing its lemma, or holding no senses', () => {
    expect(
      parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [{ senses: [sense] }] })),
    ).toBeNull();
    expect(
      parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [{ lemma: 'book', senses: [] }] })),
    ).toBeNull();
  });

  it('returns null when a sense carries no sense_code', () => {
    const raw = JSON.stringify({
      kind: 'word',
      entries: [{ lemma: 'book', senses: [{ translation: 'ספר' }] }],
    });
    expect(parseLlmTranslation(raw)).toBeNull();
  });

  it('returns null when the model exceeds the caps', () => {
    const many = Array(6).fill(sense);
    expect(
      parseLlmTranslation(JSON.stringify({ kind: 'word', entries: [{ lemma: 'x', senses: many }] })),
    ).toBeNull();
    const entries = Array(4).fill({ lemma: 'x', senses: [sense] });
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', entries }))).toBeNull();
  });

  it('accepts a fenced code block, which models emit even when told not to', () => {
    const raw =
      '```json\n{"kind":"word","entries":[{"lemma":"book","senses":[{"translation":"ספר","sense_code":"printed_book"}]}]}\n```';
    expect(parseLlmTranslation(raw)?.entries[0].lemma).toBe('book');
  });
});
```

- [ ] **Step 11: Run it to make sure it fails**

```bash
npm test -w apps/server -- domain/translation
```

Expected: FAIL — the prompt says nothing about entries, and the well-formed payload no
longer parses against the old schema import.

- [ ] **Step 12: Rewrite the prompt in `apps/server/src/domain/translation.ts`**

Replace the `const system = [...].join(' ');` array inside `buildPrompt` with:

```ts
  // Three of these rules exist because of a specific failure mode, and each has
  // an eval case: an imperative fixed expression misclassified as a sentence, an
  // idiom translated word by word, and a sentence padded into a list of
  // alternatives behind a `more` button that should not appear. Phase 10 added
  // the nesting rules, and `book` as a worked example — without it the nested
  // shape invites one sense per entry, which is the failure mirror-image to the
  // single-lemma shape it replaced.
  const system = [
    `You translate from ${from} to ${to} for a Hebrew-speaking learner of English.`,
    'Return JSON only, matching the supplied schema.',
    'Classify the input as "word", "phrase" or "sentence".',
    'A fixed dictionary expression is a "phrase" even when it is grammatically imperative:',
    '"break a leg" is a phrase, not a sentence.',
    'Translate an idiom by its meaning, never word by word.',
    'Return one entry per headword the input could belong to, most likely reading first,',
    'at most 3. An inflected form belongs to its headword and carries the headword\'s',
    'senses: "running" is one entry whose lemma is "run".',
    'Keep senses spanning parts of speech in ONE entry per headword: "book" is one entry',
    'whose senses are ספר (noun) and להזמין (verb) — never two entries for one lemma.',
    'Within an entry, rank its own senses with the most common first, at most 5.',
    `Give each sense a part_of_speech, one short natural example sentence in ${from}`,
    `together with its ${to} translation, and a short snake_case sense_code naming the`,
    'meaning (financial_institution as against river_bank).',
    'For a "sentence": return exactly one entry holding exactly one sense with the',
    'translation, and omit part_of_speech and example entirely — a sentence has no part',
    'of speech and needs no example of itself.',
    'If the input is not a word or expression in either language, return an empty entries',
    'array rather than inventing a translation.',
  ].join(' ');
```

Nothing else in this file changes: `parseLlmTranslation` validates against
`LlmTranslationSchema`, which Task 1 Step 3 already replaced, and `normalizeSenses` still
operates on the flattened response senses.

- [ ] **Step 13: Run it to verify it passes**

```bash
npm test -w apps/server -- domain/translation
```

Expected: PASS.

- [ ] **Step 14: Update the service's unit tests to the entries payload**

In `apps/server/src/services/translations.test.ts`, replace the `reply` helper and every
payload with the nested shape. The whole file's `reply({ kind, senses: […] })` calls become
`reply({ kind, entries: [{ lemma, senses: […] }] })`, each sense gaining a `sense_code`.
Concretely, replace the helper with:

```ts
const reply = (payload: unknown) => JSON.stringify(payload);

/** One entry, for the many tests that do not care about the nesting. */
const oneEntry = (lemma: string, senses: Record<string, unknown>[]) => ({
  entries: [{ lemma, senses }],
});
```

then rewrite the payloads:

| Test | New payload |
|---|---|
| detects the direction | `reply({ kind: 'word', ...oneEntry('book', [{ translation: 'ספר', sense_code: 'printed_book' }]) })` |
| honours an explicit direction | `reply({ kind: 'word', entries: [] })` |
| passes the prompt straight through | `reply({ kind: 'word', entries: [] })` |
| overrides the model for a single token | `reply({ kind: 'sentence', ...oneEntry('book', [{ translation: 'ספר', sense_code: 'printed_book' }]) })` |
| reduces a real sentence to one bare sense | `reply({ kind: 'sentence', ...oneEntry('I read a book', [{ translation: 'קראתי ספר.', part_of_speech: 'verb', example: { source: 'a', target: 'b' }, sense_code: 's' }, { translation: 'אחר', sense_code: 't' }]) })` |
| an empty sense list from the model | `reply({ kind: 'word', entries: [] })` |
| logs one event per successful translation | `reply({ kind: 'word', ...oneEntry('book', [{ translation: 'ספר', sense_code: 'printed_book' }]) })` |

and add one test, which is the reason the shape changed:

```ts
  it('flattens two entries into one ranked list, round-robin by rank', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'see',
            senses: [
              { translation: 'לראות', sense_code: 'perceive' },
              { translation: 'להבין', sense_code: 'understand' },
            ],
          },
          { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
        ],
      }),
    );

    const result = await service.translate({ text: 'saw' });

    expect(result.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור', 'להבין']);
    expect(result.senses[0]).not.toHaveProperty('sense_code');
  });
```

- [ ] **Step 15: Run it to make sure it fails**

```bash
npm test -w apps/server -- services/translations
```

Expected: FAIL — the service still reads `parsed.senses`, which no longer exists, so
`tsc`-free Jest reports `undefined` senses and the new test fails outright.

- [ ] **Step 16: Flatten in `apps/server/src/services/translations.ts`**

Add to the imports:

```ts
import { flattenEntries, mergeEntries } from '../domain/vocabulary';
```

and replace the two lines after `const kind = resolveKind(text, parsed.kind);`:

```ts
      const kind = resolveKind(text, parsed.kind);
      // mergeEntries before flattening, so a model that split one lemma across
      // two entries does not get its senses interleaved with its own.
      const senses = normalizeSenses(kind, flattenEntries(mergeEntries(parsed.entries)));
```

Everything else in the file is unchanged — including the `translation_no_content` branch,
which still answers `{ …, senses: [] }`.

- [ ] **Step 17: Run the whole unit bucket**

```bash
npm test
```

Expected: PASS across `@lang-tutor/core`, `apps/server` and `apps/mobile`.

- [ ] **Step 18: Move the test fixtures to entries**

`apps/server/tests/support/mockServer.ts` — change the two payload helpers to take
entries. Replace the import and both signatures:

```ts
import type { LlmEntry, TranslationKind } from '@lang-tutor/core/api';
```

```ts
export async function expectGeminiJson(
  ns: string,
  opts: { kind: TranslationKind; entries: LlmEntry[]; matchText?: string },
): Promise<void> {
  await expectation(ns, {
    match: opts.matchText
      ? { body: { type: 'REGEX', regex: `[\\s\\S]*${opts.matchText}[\\s\\S]*` } }
      : {},
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ kind: opts.kind, entries: opts.entries })),
      },
    },
  });
}
```

```ts
export async function expectGeminiDelayedJson(
  ns: string,
  opts: { kind: TranslationKind; entries: LlmEntry[]; delayMs: number },
): Promise<void> {
  await expectation(ns, {
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ kind: opts.kind, entries: opts.entries })),
        delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs },
      },
    },
  });
}
```

`geminiResponse` itself takes an opaque payload and does not change.

Then update every call in `apps/server/tests/integration/routes/translations.test.ts` the
same way — `{ kind, senses: [...] }` becomes `{ kind, entries: [{ lemma, senses: [...] }] }`
with a `sense_code` on each sense. The **expected response bodies do not change**: one
entry flattens to its senses in order. For example the first test becomes:

```ts
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'book',
          senses: [
            {
              translation: 'ספר',
              part_of_speech: 'noun',
              example: { source: 'I read a book.', target: 'קראתי ספר.' },
              sense_code: 'printed_book',
            },
            { translation: 'להזמין', part_of_speech: 'verb', sense_code: 'reserve' },
          ],
        },
      ],
    });
```

with its `expect(await res.json()).toEqual({ … })` left exactly as it is. The gibberish,
empty and header tests take `entries: []`; the sentence test takes one entry with one
sense carrying a `sense_code`.

- [ ] **Step 19: Move the e2e fixtures to entries**

In `e2e/tests/support/mockServer.ts`, change `expectGemini`'s payload type:

```ts
export async function expectGemini(
  request: APIRequestContext,
  payload: { kind: 'word' | 'phrase' | 'sentence'; entries: unknown[] },
): Promise<void> {
```

In `e2e/tests/translate.spec.ts`, wrap `BOOK_SENSES` in an entry and give each sense a
`sense_code`:

```ts
const BOOK_ENTRIES = [
  {
    lemma: 'book',
    senses: [
      {
        translation: 'ספר',
        part_of_speech: 'noun',
        example: { source: 'I read a book about space.', target: 'קראתי ספר על החלל.' },
        sense_code: 'printed_book',
      },
      {
        translation: 'להזמין',
        part_of_speech: 'verb',
        example: { source: "I'd like to book a table.", target: 'אני רוצה להזמין שולחן.' },
        sense_code: 'reserve',
      },
      {
        translation: 'לרשום',
        part_of_speech: 'verb',
        example: { source: 'The referee booked him.', target: 'השופט רשם לו כרטיס.' },
        sense_code: 'caution',
      },
    ],
  },
];
```

and change every `expectGemini(request, { kind: 'word', senses: BOOK_SENSES })` to
`expectGemini(request, { kind: 'word', entries: BOOK_ENTRIES })`, the sentence spec to one
entry with one sense plus a `sense_code`, and the gibberish spec to `entries: []`.

- [ ] **Step 20: Run the integration bucket**

```bash
npm run test:integration
```

Expected: PASS. (If Postgres or MockServer is not up: `npm run db:up` — but never from a
worktree while another checkout holds 5432.)

- [ ] **Step 21: Typecheck and the architecture checks**

```bash
npm run typecheck && npm run lint:arch
```

Expected: both clean; `lint:arch` reports 17 rules, no violations.

- [ ] **Step 22: Commit**

```bash
git add packages/core apps/server/src apps/server/tests e2e/tests
git commit -m "feat: the model answers with entries, one per headword

The wire response is unchanged: the service flattens the entries it parsed,
round-robin by sense rank, and sense_code is built out field by field so it
cannot reach a client."
```

---

### Task 2: The eval bucket scores entries, and stops going through the service

The eval runner builds a `TranslationService` today. Task 7 gives that service a
`transaction`, and the eval has no database — so the runner moves onto the prompt, the
client and `domain/` directly, which is also what lets it score **entries** instead of
only the flattened response. The same helper is what the recorder will call in Task 10.

**Files:**
- Create: `apps/server/tests/eval/askModel.ts`
- Modify: `apps/server/tests/eval/run.ts`
- Modify: `apps/server/tests/eval/cases.ts`

**Interfaces:**
- Consumes: `mergeEntries`, `flattenEntries` (Task 1); `buildPrompt`, `detectDirection`,
  `resolveKind`, `parseLlmTranslation`, `normalizeSenses` (existing).
- Produces: `askModel(llm: LlmClient, input: { text: string; direction?: TranslationDirection }): Promise<ModelAnswer>`
  where `ModelAnswer = { direction: TranslationDirection; kind: TranslationKind; entries: LlmEntry[]; senses: TranslationSense[] }`.

**Note on verification:** `npm run eval` calls the real paid API and needs `GEMINI_API_KEY`
and `GEMINI_MODEL`. It is **not** part of this task's verification — `npm run typecheck` is.
Run the eval only if a key is available; CI's `test-eval` job will run it on push.

- [ ] **Step 1: Write `apps/server/tests/eval/askModel.ts`**

```ts
import type {
  LlmEntry,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from '../../src/domain/translation';
import { flattenEntries, mergeEntries } from '../../src/domain/vocabulary';
import type { LlmClient } from '../../src/services/llm';

/**
 * The real prompt, the real client, the real parser — everything
 * `services/translations.ts` does to an answer *except* touch a database.
 *
 * It stops short of the service on purpose. As of phase 10 the service reads
 * Postgres before it calls the provider and writes to it afterwards, and this
 * bucket has neither a database nor any business having one: the object under
 * test is the prompt. Going through the service would mean handing it a fake
 * transaction that reimplemented the merge, which is the one piece of logic a
 * fake must never own.
 *
 * It also exposes `entries`, which the response deliberately flattens away —
 * and the entries are exactly what the phase 10 tiers score.
 */
export type ModelAnswer = {
  direction: TranslationDirection;
  kind: TranslationKind;
  entries: LlmEntry[];
  senses: TranslationSense[];
};

export async function askModel(
  llm: LlmClient,
  input: { text: string; direction?: TranslationDirection },
): Promise<ModelAnswer> {
  const text = input.text.trim();
  const direction = input.direction ?? detectDirection(text);

  const raw = await llm(buildPrompt({ text, direction }));
  // An empty string is the contract's "no content" — a safety block, or a
  // candidate with no text. The input was refused; nothing is broken.
  if (raw === '') return { direction, kind: resolveKind(text, 'word'), entries: [], senses: [] };

  const parsed = parseLlmTranslation(raw);
  if (!parsed) throw new Error('the model response did not match the expected shape');

  const kind = resolveKind(text, parsed.kind);
  const entries = mergeEntries(parsed.entries);
  return { direction, kind, entries, senses: normalizeSenses(kind, flattenEntries(entries)) };
}
```

- [ ] **Step 2: Point `run.ts` at it**

In `apps/server/tests/eval/run.ts`:

Replace the two imports

```ts
import type { TranslationResponse } from '@lang-tutor/core/api';
```
```ts
import { createTranslationService } from '../../src/services/translations';
```

with

```ts
import { askModel, type ModelAnswer } from './askModel';
```

(keep `loadGeminiConfig` and `createGeminiClient`), change `Row`'s field

```ts
  result?: ModelAnswer;
```

and in `main`, delete the `const service = createTranslationService({ … })` block and
change the call inside `scoreCase`:

```ts
      const result = await askModel(
        llm,
        kase.direction ? { text: kase.text, direction: kase.direction } : { text: kase.text },
      );
```

The scorecard's print line already reads `row.result.kind`, `.direction` and `.senses`, all
of which `ModelAnswer` carries, so it needs no change.

- [ ] **Step 3: Add the tier 1 entry invariants**

In `run.ts`, change `tier1`'s signature to `(kase: EvalCase, result: ModelAnswer)`, then:

In the `kase.expectEmpty` branch, add before the `return`:

```ts
    checks.push({
      name: 'no entries',
      ok: result.entries.length === 0,
      detail: `${result.entries.length}`,
    });
```

After the existing `at least one sense` check, add:

```ts
  checks.push({
    name: 'at least one entry',
    ok: result.entries.length >= 1,
    detail: `${result.entries.length}`,
  });
  // The schema already requires a non-empty lemma and sense_code, so this is
  // not a restatement of it: it catches a whitespace lemma, a sense_code that
  // is prose rather than a code, and two senses of one headword sharing a code
  // — all of which parse and all of which make a row unreadable in psql.
  checks.push({
    name: "every entry has a real lemma and distinct snake_case sense codes",
    ok: result.entries.every(
      (entry) =>
        entry.lemma.trim().length > 0 &&
        entry.senses.every((sense) => /^[a-z0-9]+(_[a-z0-9]+)*$/.test(sense.sense_code)) &&
        new Set(entry.senses.map((sense) => sense.sense_code)).size === entry.senses.length,
    ),
    detail: result.entries
      .map((entry) => `${entry.lemma}: ${entry.senses.map((s) => s.sense_code).join(',')}`)
      .join(' | '),
  });
```

Then **replace** the `every example names the queried term or an inflection of it` check,
which phase 10 makes wrong — `saw` returns `see`'s entry, whose example is built on `see`:

```ts
    checks.push({
      name: "every example names its entry's lemma or an inflection of it",
      // A stem check, not equality: "booked" and "running" must both count. It
      // is the *lemma* that is checked, not the queried string: senses belong
      // to the headword, so `saw`'s first entry carries `see`'s examples.
      ok: result.entries.every((entry) => {
        const stem = entry.lemma.trim().toLowerCase().slice(0, Math.max(4, entry.lemma.length - 3));
        return entry.senses.every((sense) => sense.example?.source.toLowerCase().includes(stem));
      }),
      detail: result.entries.map((entry) => entry.lemma).join(' | '),
    });
```

- [ ] **Step 4: Add the tier 2 axes**

In `run.ts`, change `tier2`'s signature to `(kase: EvalCase, result: ModelAnswer)` and add
after the `top sense is in the accepted set` check:

```ts
  if (kase.expectEntries !== undefined) {
    checks.push({
      name: `${kase.expectEntries} entr${kase.expectEntries === 1 ? 'y' : 'ies'}`,
      ok: result.entries.length === kase.expectEntries,
      detail: result.entries.map((entry) => entry.lemma).join(' | '),
    });
  }

  if (kase.expectEntrySenses !== undefined) {
    checks.push({
      name: `the first entry carries at least ${kase.expectEntrySenses} senses`,
      ok: (result.entries[0]?.senses.length ?? 0) >= kase.expectEntrySenses,
      detail: `${result.entries[0]?.senses.length ?? 0}`,
    });
  }

  if (kase.expectLemma) {
    checks.push({
      name: `the single entry's lemma is "${kase.expectLemma}"`,
      ok: result.entries[0]?.lemma.trim().toLowerCase() === kase.expectLemma,
      detail: result.entries[0]?.lemma,
    });
  }
```

- [ ] **Step 5: Add the three cases the nested shape can fail on**

In `apps/server/tests/eval/cases.ts`, add to `EvalCase`:

```ts
  /** Exactly this many entries. `saw` is 2 — the failure the entries model replaced. */
  expectEntries?: number;
  /** At least this many senses on the first entry. `book` is 2 — the failure
   *  the nested shape invites, where a model splits one lemma by part of speech. */
  expectEntrySenses?: number;
  /** The lemma the first entry must resolve to. `running` is `run`. */
  expectLemma?: string;
```

Extend `book`'s case with `expectEntries: 1, expectEntrySenses: 2`, extend `running`'s with
`expectEntries: 1, expectLemma: 'run'`, and add a new case:

```ts
  {
    label: 'one string, two headwords: the verb see and the noun saw',
    text: 'saw',
    expectKind: 'word',
    acceptTop: ['ראה', 'לראות'],
    expectAlso: ['מסור', 'לנסר'],
    expectEntries: 2,
  },
```

- [ ] **Step 6: Typecheck and run the unit bucket**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm test && npm run lint:arch
```

Expected: all clean. `lint:arch` still reports 17 rules — `tests/eval/` is already exempt
from R11 as a second test composition root, and `askModel.ts` is not a `*.test.ts`, so ADR
0004 R4's `find` has nothing new to report.

- [ ] **Step 7 (optional, needs a real key): score the new prompt**

```bash
GEMINI_API_KEY=<real key> GEMINI_MODEL=gemini-2.5-flash npm run eval
```

Expected: tier 1 clean, tier 2 at or above 85%. A tier 2 drop is answered by fixing the
prompt, **never** by lowering `TIER2_THRESHOLD`.

- [ ] **Step 8: Commit**

```bash
git add apps/server/tests/eval
git commit -m "test(eval): score entries, through the prompt rather than the service

The service is about to take a transaction, and this bucket has no database.
Going through domain/ directly is also what exposes entries, which is what the
saw/book/running cases are about."
```

---

### Task 3: The rest of the pure layer — normalization and row mapping

Everything `repo/vocabulary.ts` will need that does not touch a database. Pure, so it is
unit-tested with Docker stopped.

**Files:**
- Modify: `apps/server/src/domain/vocabulary.ts`
- Test: `apps/server/src/domain/vocabulary.test.ts`

**Interfaces:**
- Consumes: `LlmEntry`, `TranslationDirection`, `TranslationSense` from
  `@lang-tutor/core/api`.
- Produces, all from `apps/server/src/domain/vocabulary.ts`:
  - `normalizeForm(text: string): string`
  - `languagesFor(direction: TranslationDirection): { source: string; target: string }`
  - `type SenseRow = { termId: string; rank: number; entryRank: number; partOfSpeech: string | null; exampleSource: string | null; translation: string; exampleTarget: string | null }`
  - `type SenseToWrite = { rank: number; senseCode: string; partOfSpeech: string | null; exampleSource: string | null; translation: string; exampleTarget: string | null }`
  - `type EntryRows = { lemma: string; entryRank: number; senses: SenseToWrite[] }`
  - `entriesToRows(entries: LlmEntry[]): EntryRows[]`
  - `rowsToSenses(rows: SenseRow[]): TranslationSense[]`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/domain/vocabulary.test.ts` (and add
`entriesToRows, languagesFor, normalizeForm, rowsToSenses` to the import from
`./vocabulary`, plus `import type { SenseRow } from './vocabulary';`):

```ts
describe('normalizeForm', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeForm('  good   morning ')).toBe('good morning');
    expect(normalizeForm('book')).toBe('book');
  });

  it('leaves casing alone — lower(form) in the index handles matching', () => {
    expect(normalizeForm('BOOK')).toBe('BOOK');
    expect(normalizeForm('How do you do?')).toBe('How do you do?');
  });

  it('leaves a Hebrew string untouched, nikud and punctuation included', () => {
    expect(normalizeForm('שָׁלוֹם!')).toBe('שָׁלוֹם!');
  });

  it('collapses a tab and a newline the same way as a space', () => {
    expect(normalizeForm('see\tyou\nlater')).toBe('see you later');
  });
});

describe('languagesFor', () => {
  it('reads an English term with Hebrew translations, and the mirror', () => {
    expect(languagesFor('en_he')).toEqual({ source: 'en', target: 'he' });
    expect(languagesFor('he_en')).toEqual({ source: 'he', target: 'en' });
  });
});

describe('entriesToRows', () => {
  it('numbers entries by their order and senses 0..n within an entry', () => {
    const rows = entriesToRows([
      {
        lemma: 'see',
        senses: [
          { translation: 'לראות', sense_code: 'perceive' },
          { translation: 'להבין', sense_code: 'understand' },
        ],
      },
      { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
    ]);

    expect(rows.map((row) => [row.lemma, row.entryRank])).toEqual([
      ['see', 0],
      ['saw', 1],
    ]);
    expect(rows[0].senses.map((sense) => sense.rank)).toEqual([0, 1]);
    expect(rows[1].senses.map((sense) => sense.rank)).toEqual([0]);
  });

  it('splits the example by what each half depends on, and nulls what is absent', () => {
    const [row] = entriesToRows([
      {
        lemma: 'book',
        senses: [
          {
            translation: 'ספר',
            part_of_speech: 'noun',
            example: { source: 'I read a book.', target: 'קראתי ספר.' },
            sense_code: 'printed_book',
          },
          { translation: 'להזמין', sense_code: 'reserve' },
        ],
      },
    ]);

    expect(row.senses[0]).toEqual({
      rank: 0,
      senseCode: 'printed_book',
      partOfSpeech: 'noun',
      exampleSource: 'I read a book.',
      translation: 'ספר',
      exampleTarget: 'קראתי ספר.',
    });
    expect(row.senses[1]).toEqual({
      rank: 1,
      senseCode: 'reserve',
      partOfSpeech: null,
      exampleSource: null,
      translation: 'להזמין',
      exampleTarget: null,
    });
  });
});

describe('rowsToSenses', () => {
  const row = (over: Partial<SenseRow>): SenseRow => ({
    termId: 't-see',
    rank: 0,
    entryRank: 0,
    partOfSpeech: null,
    exampleSource: null,
    translation: 'לראות',
    exampleTarget: null,
    ...over,
  });

  it('keeps the order it was handed — the read already sorted it', () => {
    const senses = rowsToSenses([row({ translation: 'לראות' }), row({ translation: 'מסור' })]);
    expect(senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור']);
  });

  it('builds example only when both halves are present', () => {
    expect(
      rowsToSenses([row({ exampleSource: 'I see.', exampleTarget: 'אני רואה.' })])[0].example,
    ).toEqual({ source: 'I see.', target: 'אני רואה.' });
    expect(rowsToSenses([row({ exampleSource: 'I see.' })])[0]).not.toHaveProperty('example');
    expect(rowsToSenses([row({ exampleTarget: 'אני רואה.' })])[0]).not.toHaveProperty('example');
  });

  it('omits an absent part of speech rather than emitting null', () => {
    expect(rowsToSenses([row({})])[0]).toEqual({ translation: 'לראות' });
    expect(rowsToSenses([row({ partOfSpeech: 'verb' })])[0].part_of_speech).toBe('verb');
  });

  it('never emits sense_code or any row-only field', () => {
    const [sense] = rowsToSenses([row({ partOfSpeech: 'verb' })]);
    expect(Object.keys(sense).sort()).toEqual(['part_of_speech', 'translation']);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- domain/vocabulary
```

Expected: FAIL — `normalizeForm`, `languagesFor`, `entriesToRows` and `rowsToSenses` are
not exported.

- [ ] **Step 3: Add them to `apps/server/src/domain/vocabulary.ts`**

Add `TranslationDirection` to the type import at the top, then append:

```ts
/**
 * The lookup key. Trim and collapse internal whitespace, and nothing else.
 *
 * Deliberately does **not** lowercase: `lower(form)` in the unique index does
 * the matching, so the stored string keeps the shape it was written in — a
 * recorded `How do you do?` stays a decent quiz prompt, and a learner typing
 * `BOOK` stores `BOOK` and is matched anyway.
 *
 * No nikud stripping and no punctuation rules either. Each would be a guess
 * about learner behaviour with no evidence behind it, and each wrong guess
 * turns a hit into a silent miss.
 */
export function normalizeForm(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Both codes come from `direction` alone. No user id is involved, which is why
 *  the request schema did not have to change. */
export function languagesFor(direction: TranslationDirection): {
  source: string;
  target: string;
} {
  return direction === 'en_he' ? { source: 'en', target: 'he' } : { source: 'he', target: 'en' };
}

/**
 * A row of the by-form read. Declared here rather than imported from Drizzle:
 * R3 forbids this layer knowing that Drizzle exists, and `repo/vocabulary.ts`
 * selects exactly these columns under exactly these names.
 */
export type SenseRow = {
  termId: string;
  rank: number;
  entryRank: number;
  partOfSpeech: string | null;
  exampleSource: string | null;
  translation: string;
  exampleTarget: string | null;
};

/** One sense as the write stores it, across two tables: `exampleSource` is in
 *  the term's own language and lives on the sense, `exampleTarget` is in the
 *  learner's and lives on the translation. */
export type SenseToWrite = {
  rank: number;
  senseCode: string;
  partOfSpeech: string | null;
  exampleSource: string | null;
  translation: string;
  exampleTarget: string | null;
};

export type EntryRows = { lemma: string; entryRank: number; senses: SenseToWrite[] };

/**
 * The two ranks, assigned in the one place that knows both. `entryRank` is this
 * term's position among the entries the model returned *for this form* — a
 * property of the pairing, which is why it ends up on the variant. `rank` is
 * the sense's position within its own headword. Contiguous 0..n with no gaps,
 * which is what lets the read sort on the raw rank rather than a computed
 * position.
 */
export function entriesToRows(entries: LlmEntry[]): EntryRows[] {
  return entries.map((entry, entryRank) => ({
    lemma: entry.lemma,
    entryRank,
    senses: entry.senses.map((sense, rank) => ({
      rank,
      senseCode: sense.sense_code,
      partOfSpeech: sense.part_of_speech ?? null,
      exampleSource: sense.example?.source ?? null,
      translation: sense.translation,
      exampleTarget: sense.example?.target ?? null,
    })),
  }));
}

/**
 * Rows to the wire, field by field. The order is the read's, untouched.
 *
 * A response carries `example` only when both halves are present: `example` is
 * legally optional, and half of one is not an example. Nothing here can emit
 * `sense_code`, because nothing here reads it.
 */
export function rowsToSenses(rows: SenseRow[]): TranslationSense[] {
  return rows.map((row) => {
    const sense: TranslationSense = { translation: row.translation };
    if (row.partOfSpeech) sense.part_of_speech = row.partOfSpeech;
    if (row.exampleSource && row.exampleTarget) {
      sense.example = { source: row.exampleSource, target: row.exampleTarget };
    }
    return sense;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w apps/server -- domain/vocabulary
```

Expected: PASS.

- [ ] **Step 5: Typecheck and check the layering**

```bash
npm run typecheck && npm run lint:arch
```

Expected: clean. R3 in particular — `domain/vocabulary.ts` must contain no `from '../'`
import at all.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/vocabulary.ts apps/server/src/domain/vocabulary.test.ts
git commit -m "feat(domain): normalization and row mapping for the vocabulary

Pure: the row shapes are declared locally, the same arrangement
TranslationPrompt already uses, because R3 forbids reaching into repo/."
```

---

### Task 4: Migration 0003 — the delete, and the shape it makes possible

The migration clears the seeded content and quiz tables first, so every new column lands
on empty tables: no backfills, no dropped defaults, and a migration that states the target
shape instead of negotiating with the old one.

**This deletes quiz history.** `answers`, `session_questions`, `sessions` and `questions`
go, along with the seeded dictionary they point at. `users` survives. That is the
deliberate price of one data shape instead of two.

The existing `seedContent` is adapted to the new columns in this task and rewritten
properly in Task 11 — three added fields, so the suite stays green while the recording is
still to come.

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0003_*.sql` (+ its `meta/` snapshot and journal
  entry, both generated)
- Modify: `apps/server/src/db/seed.ts`
- Test: `apps/server/tests/integration/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `vocabTerms` (no `partOfSpeech`, id defaulted), `termVariants`
  (`languageCode`, `entryRank`, id defaulted), `vocabTermSenses` (`partOfSpeech`, `rank`,
  `exampleSource`, id defaulted), `termSenseTranslations` (`exampleTarget`) in
  `apps/server/src/db/schema.ts`.

- [ ] **Step 1: Write the failing schema test**

In `apps/server/tests/integration/db/schema.test.ts`, replace `seedOneTerm` with the new
column set and add two assertions. First the helper:

```ts
// A minimal valid content chain, so the questions tests have something to hang
// off. Phase 10 moved part of speech onto the sense and made language_code,
// entry_rank and rank required.
async function seedOneTerm(db: Db): Promise<void> {
  await db.execute(sql`
    insert into vocab_terms (id, language_code, lemma) values ('vt-en-window', 'en', 'window');
    insert into term_variants (id, term_id, language_code, form, kind, entry_rank)
      values ('tv-en-window-base', 'vt-en-window', 'en', 'window', 'word', 0);
    insert into vocab_term_senses (id, term_id, sense_code, rank, part_of_speech, example_source)
      values ('sense-window-default', 'vt-en-window', 'window_opening', 0, 'noun',
              'I opened the window.');
    insert into term_sense_translations (sense_id, user_language_code, translation, example_target)
      values ('sense-window-default', 'he', 'חלון', 'פתחתי את החלון.');
  `);
}
```

then add these to the `describe('the migrated schema', …)` block:

```ts
  it('issues ids for the vocabulary tables, so no layer generates randomness', async () => {
    await db.execute(
      sql`insert into vocab_terms (language_code, lemma) values ('en', 'defaulted')`,
    );
    const result = await db.execute<{ id: string }>(
      sql`select id from vocab_terms where lemma = 'defaulted'`,
    );
    expect(result.rows[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('refuses two senses of one term at the same rank', async () => {
    await db.execute(sql`
      insert into vocab_terms (id, language_code, lemma) values ('vt-dup', 'en', 'dup');
      insert into vocab_term_senses (term_id, sense_code, rank) values ('vt-dup', 'a', 0);
    `);
    await expect(
      db.execute(sql`insert into vocab_term_senses (term_id, sense_code, rank)
                     values ('vt-dup', 'b', 0)`),
    ).rejects.toThrow();
  });

  it('refuses a negative rank or entry_rank', async () => {
    await expect(
      db.execute(sql`insert into vocab_term_senses (term_id, sense_code, rank)
                     values ('vt-dup', 'c', -1)`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into term_variants (term_id, language_code, form, kind, entry_rank)
                     values ('vt-dup', 'en', 'dup', 'word', -1)`),
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration -w apps/server -- db/schema
```

Expected: FAIL — `column "language_code" of relation "term_variants" does not exist`.

- [ ] **Step 3: Change `apps/server/src/db/schema.ts`**

Add `index`-family imports — `uniqueIndex` — to the `drizzle-orm/pg-core` import list, then
replace the three vocabulary tables and add one column to the fourth:

```ts
export const vocabTerms = pgTable(
  'vocab_terms',
  {
    // Server-issued from phase 10, as users.id has been since 0001: with the
    // dictionary now written at request time, a client-generated id would mean
    // randomness in a layer ADR 0002 R1 would have to police.
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    lemma: text('lemma').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('vocab_terms_language_lemma_key').on(t.languageCode, t.lemma)],
);

export const termVariants = pgTable(
  'term_variants',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    termId: text('term_id')
      .notNull()
      .references(() => vocabTerms.id, { onDelete: 'cascade' }),
    // Copied from the term so the unique index below can exist: the scope that
    // matters is one form in one language, but language lives on vocab_terms
    // and an index reads one table. A term's language never changes, so the
    // copy cannot go stale — and it earns its keep in the read, which no
    // longer joins vocab_terms at all.
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    // Stored as it was written; matching is always lower(form). One rule for a
    // recorded `How do you do?` and for a learner who typed `BOOK`.
    form: text('form').notNull(),
    kind: text('kind').notNull(),
    // Which reading of this form this term is, as the model ranked them. It
    // sits on the variant rather than the term because it is a property of the
    // pairing: `saw` ranks `see` first, while `saws` returns `saw` alone at 0.
    entryRank: integer('entry_rank').notNull(),
  },
  (t) => [
    // Per term, so one form may belong to several terms — `saw` is a variant of
    // `see` *and* of `saw`, which is what every lexical source does.
    unique('term_variants_term_form_key').on(t.termId, t.form),
    check('term_variants_entry_rank_nonneg', sql`${t.entryRank} >= 0`),
    // Two jobs in one index. Its (language_code, lower(form)) prefix is exactly
    // the read's predicate, so there is no separate lookup index; its third
    // column enforces that no two terms claim the same reading of one form.
    // That cannot currently happen — a written form thereafter hits, and ranks
    // within one write are distinct by construction — which is the point: a
    // safety net for a write bug, exactly like UNIQUE(term_id, rank).
    uniqueIndex('term_variants_form_entry_rank_key').on(
      t.languageCode,
      sql`lower(${t.form})`,
      t.entryRank,
    ),
  ],
);

export const vocabTermSenses = pgTable(
  'vocab_term_senses',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    termId: text('term_id')
      .notNull()
      .references(() => vocabTerms.id, { onDelete: 'cascade' }),
    // Model-supplied, and there for readability alone: senses are never merged
    // within a term, so it has no functional role. Three output tokens buys
    // financial_institution against river_bank when reading rows in psql.
    senseCode: text('sense_code').notNull(),
    // Part of speech describes a meaning, not a word: `book` is a noun (ספר)
    // and a verb (להזמין). It moved here from vocab_terms in phase 10.
    partOfSpeech: varchar('part_of_speech', { length: 50 }),
    // "Most common first", within a term. Contiguous 0..n, which is what lets
    // the read sort on the raw rank rather than a computed position.
    rank: integer('rank').notNull(),
    // The example in the term's own language. Its other half lives on the
    // translation, because that half is in the learner's language.
    exampleSource: text('example_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('vocab_term_senses_term_rank_key').on(t.termId, t.rank),
    check('vocab_term_senses_rank_nonneg', sql`${t.rank} >= 0`),
  ],
);
```

and in `termSenseTranslations`, after `definitionNotes`:

```ts
    exampleTarget: text('example_target'),
```

- [ ] **Step 4: Generate the migration**

```bash
npm run db:generate -w apps/server
```

Expected: a new `apps/server/src/db/migrations/0003_<two words>.sql`, a
`meta/0003_snapshot.json`, and a third entry in `meta/_journal.json`.

- [ ] **Step 5: Prepend the delete to the generated SQL by hand**

Open the generated `0003_*.sql` and put this at the very top, before every `ALTER`:

```sql
-- Phase 10 clears the seeded content and quiz tables so the new columns land on
-- empty tables: no backfills, no dropped defaults, and a migration that states
-- the target shape instead of negotiating with the old one.
--
-- CASCADE from vocab_terms reaches term_variants, vocab_term_senses,
-- term_sense_translations, questions, session_questions and answers. `sessions`
-- is named explicitly because nothing references it, so nothing would cascade
-- to it, and a session whose questions had vanished would be broken rather than
-- absent. `users` is untouched.
--
-- Without this, a developer's existing database keeps phase-4-shaped rows that
-- persistEntries refuses to overwrite — leaving that database permanently on
-- the old fixture while CI and every test template run on the new one.
--
-- The same statement is written again in src/db/reseed.ts rather than shared:
-- this file is frozen history, that command is live.
TRUNCATE vocab_terms, sessions CASCADE;
--> statement-breakpoint
```

Read the rest of the generated file and confirm it contains, in some order: the
`part_of_speech` drop on `vocab_terms`, the four added columns, the three `ALTER COLUMN id
SET DEFAULT`, the two check constraints, the `vocab_term_senses_term_rank_key` unique
constraint, and `CREATE UNIQUE INDEX "term_variants_form_entry_rank_key" … ("language_code",lower("form"),"entry_rank")`.
If any of those is missing, the schema edit is wrong — fix `schema.ts` and regenerate
rather than hand-writing the SQL.

- [ ] **Step 6: Prove the hand-edit will not be regenerated away**

```bash
npm run db:check -w apps/server && npm run db:generate -w apps/server && git status --porcelain apps/server/src/db/migrations
```

Expected: `db:check` passes and `git status` prints **only** the three files you already
have (`0003_*.sql`, `meta/0003_snapshot.json`, `meta/_journal.json`) as untracked/modified
— no fourth migration. `db:generate` compares `schema.ts` against the *snapshot*, not
against the SQL text, so the prepended `TRUNCATE` survives. This is the same check CI's
`test-integration` job runs.

- [ ] **Step 7: Adapt the existing seed to the new columns**

In `apps/server/src/db/seed.ts` — a three-field change that Task 11 replaces wholesale.
Remove `partOfSpeech: entry.part_of_speech,` from the `vocabTerms` values; add
`languageCode: TARGET_LANGUAGE,` and `entryRank: 0,` to the `termVariants` values; add
`rank: 0,` and `partOfSpeech: entry.part_of_speech,` to the `vocabTermSenses` values.

- [ ] **Step 8: Rebuild the templates and run the whole integration bucket**

```bash
npm run test:integration
```

Expected: PASS. `globalSetup` drops and rebuilds every worker template, so the new
migration and the adapted seed are exercised from scratch. If anything still holds the old
shape, that is a stale long-lived database (`lang_tutor`, `lang_tutor_e2e`) rather than a
template — `npm run db:migrate` and a fresh `npm run e2e` rebuild those.

- [ ] **Step 9: Typecheck, unit bucket, architecture**

```bash
npm test && npm run typecheck && npm run lint:arch
```

Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/db apps/server/tests/integration/db/schema.test.ts
git commit -m "feat(db): migration 0003 — part of speech on the sense, ranked variants

The migration truncates the content and quiz tables first, so every new column
lands on empty tables. It deletes quiz history; users survive."
```

---

### Task 5: `repo/vocabulary.ts` — the read, and the merge it performs

The by-form read, and the ordering rule the whole phase rests on. Rows are inserted
directly here so nothing about the ordering depends on a model.

**Files:**
- Create: `apps/server/src/repo/vocabulary.ts`
- Create: `apps/server/tests/support/vocabRows.ts`
- Create: `apps/server/tests/integration/repo/vocabulary.test.ts`
- Create: `apps/server/tests/integration/repo/vocabulary.order.test.ts`

**Interfaces:**
- Consumes: `SenseRow` from `domain/vocabulary` (Task 3); the schema tables (Task 4).
- Produces:
  - `createVocabRepo(tx: Tx)` and `type VocabRepo = ReturnType<typeof createVocabRepo>`
    in `apps/server/src/repo/vocabulary.ts`.
  - `findSensesByForm(input: { form: string; languageCode: string; userLanguageCode: string }): Promise<SenseRow[]>`
    — at most 5 rows, ordered `rank, entryRank, termId`.
  - `insertTerm(db, spec): Promise<{ termId: string; variantIds: string[]; senseIds: string[] }>`
    in `apps/server/tests/support/vocabRows.ts`.

- [ ] **Step 1: Write the row-inserting test helper**

Create `apps/server/tests/support/vocabRows.ts`:

```ts
import type { Db } from '../../src/db/client';
import {
  termSenseTranslations,
  termVariants,
  vocabTerms,
  vocabTermSenses,
} from '../../src/db/schema';

/**
 * Writes one headword's rows directly, without going through persistEntries.
 *
 * That is the point: the ordering rules this phase rests on must be provable
 * against rows a test chose, not against rows a model produced. tests/support/
 * is the test composition root, so reaching into db/schema.ts here is exactly
 * the carve-out ADR 0001 grants it.
 *
 * Every field is required. A defaulted language code is how a test ends up
 * asserting against a pair it never named.
 */
export type SeedSense = {
  rank: number;
  senseCode: string;
  translation: string;
  partOfSpeech: string | null;
  exampleSource: string | null;
  exampleTarget: string | null;
};

export type SeedTerm = {
  lemma: string;
  languageCode: string;
  userLanguageCode: string;
  variants: { form: string; kind: string; entryRank: number }[];
  senses: SeedSense[];
};

export async function insertTerm(
  db: Db,
  spec: SeedTerm,
): Promise<{ termId: string; variantIds: string[]; senseIds: string[] }> {
  const [term] = await db
    .insert(vocabTerms)
    .values({ languageCode: spec.languageCode, lemma: spec.lemma })
    .returning({ id: vocabTerms.id });

  const variants = await db
    .insert(termVariants)
    .values(
      spec.variants.map((variant) => ({
        termId: term.id,
        languageCode: spec.languageCode,
        form: variant.form,
        kind: variant.kind,
        entryRank: variant.entryRank,
      })),
    )
    .returning({ id: termVariants.id });

  const senseIds: string[] = [];
  for (const sense of spec.senses) {
    const [row] = await db
      .insert(vocabTermSenses)
      .values({
        termId: term.id,
        senseCode: sense.senseCode,
        rank: sense.rank,
        partOfSpeech: sense.partOfSpeech,
        exampleSource: sense.exampleSource,
      })
      .returning({ id: vocabTermSenses.id });
    await db.insert(termSenseTranslations).values({
      senseId: row.id,
      userLanguageCode: spec.userLanguageCode,
      translation: sense.translation,
      exampleTarget: sense.exampleTarget,
    });
    senseIds.push(row.id);
  }

  return { termId: term.id, variantIds: variants.map((v) => v.id), senseIds };
}
```

- [ ] **Step 2: Write the failing read tests**

Create `apps/server/tests/integration/repo/vocabulary.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createVocabRepo } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { insertTerm, type SeedSense } from '../../support/vocabRows';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

const sense = (rank: number, translation: string, over: Partial<SeedSense> = {}): SeedSense => ({
  rank,
  senseCode: `s${rank}`,
  translation,
  partOfSpeech: null,
  exampleSource: null,
  exampleTarget: null,
  ...over,
});

const find = (form: string, languageCode = 'en', userLanguageCode = 'he') =>
  withTx(t.db, (tx) =>
    createVocabRepo(tx).findSensesByForm({ form, languageCode, userLanguageCode }),
  );

describe('findSensesByForm', () => {
  it('matches case-insensitively, because the index is on lower(form)', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect((await find('Ladder')).map((row) => row.translation)).toEqual(['סולם']);
    expect((await find('LADDER')).map((row) => row.translation)).toEqual(['סולם']);
  });

  it('returns a term\'s senses in rank order', async () => {
    await insertTerm(t.db, {
      lemma: 'see',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'see', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'לראות'), sense(1, 'להבין'), sense(2, 'לפגוש')],
    });

    expect((await find('see')).map((row) => row.translation)).toEqual([
      'לראות',
      'להבין',
      'לפגוש',
    ]);
  });

  it('caps the read at five even though the database stores every sense', async () => {
    await insertTerm(t.db, {
      lemma: 'light',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'light', kind: 'word', entryRank: 0 }],
      senses: [0, 1, 2, 3, 4, 5, 6].map((n) => sense(n, `t${n}`)),
    });

    expect(await find('light')).toHaveLength(5);
  });

  it('carries the part of speech and both halves of the example', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [
        sense(0, 'סולם', {
          partOfSpeech: 'noun',
          exampleSource: 'She climbed the ladder.',
          exampleTarget: 'היא טיפסה על הסולם.',
        }),
      ],
    });

    expect(await find('ladder')).toEqual([
      {
        termId: expect.any(String),
        rank: 0,
        entryRank: 0,
        partOfSpeech: 'noun',
        exampleSource: 'She climbed the ladder.',
        translation: 'סולם',
        exampleTarget: 'היא טיפסה על הסולם.',
      },
    ]);
  });

  it('is a miss for a term with no translation in the language being asked for', async () => {
    // The inner join is the whole servability test: no column, no flag. An
    // earlier draft gated on the presence of an example, which would have made
    // an entry with a legally-absent example permanently unservable.
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect(await find('ladder', 'en', 'ru')).toEqual([]);
  });

  it('is a miss for a form nobody has queried, and for the wrong term language', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect(await find('ladders')).toEqual([]);
    expect(await find('ladder', 'he', 'en')).toEqual([]);
  });
});
```

- [ ] **Step 3: Write the failing ordering tests**

Create `apps/server/tests/integration/repo/vocabulary.order.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createVocabRepo } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { insertTerm, type SeedSense } from '../../support/vocabRows';
import { withTx } from '../../support/withTx';

// The merge across headwords: this phase's most load-bearing rule, and the one
// a reader is most likely to mistake for a bug. Rows are inserted directly so
// nothing here depends on what a model happened to return.

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

const sense = (rank: number, translation: string): SeedSense => ({
  rank,
  senseCode: `s${rank}`,
  translation,
  partOfSpeech: null,
  exampleSource: null,
  exampleTarget: null,
});

const find = (form: string) =>
  withTx(t.db, (tx) =>
    createVocabRepo(tx).findSensesByForm({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
    }),
  );

/** `saw` is a variant of `see` (entry 0) and of `saw` (entry 1). */
async function seedSawAndSee(seeEntryRank: number, sawEntryRank: number): Promise<void> {
  await insertTerm(t.db, {
    lemma: 'see',
    languageCode: 'en',
    userLanguageCode: 'he',
    variants: [
      { form: 'see', kind: 'word', entryRank: 0 },
      { form: 'saw', kind: 'word', entryRank: seeEntryRank },
    ],
    senses: [sense(0, 'לראות'), sense(1, 'להבין'), sense(2, 'לפגוש')],
  });
  await insertTerm(t.db, {
    lemma: 'saw',
    languageCode: 'en',
    userLanguageCode: 'he',
    variants: [{ form: 'saw', kind: 'word', entryRank: sawEntryRank }],
    senses: [sense(0, 'מסור'), sense(1, 'לנסר')],
  });
}

describe('the by-form merge', () => {
  it('returns both headwords, interleaved by rank rather than blocked by entry', async () => {
    await seedSawAndSee(0, 1);

    expect((await find('saw')).map((row) => row.translation)).toEqual([
      'לראות', // see rank 0
      'מסור', // saw rank 0
      'להבין', // see rank 1
      'לנסר', // saw rank 1
      'לפגוש', // see rank 2
    ]);
  });

  it('lets entry_rank decide which headword leads inside one rank', async () => {
    await seedSawAndSee(1, 0);

    expect((await find('saw')).map((row) => row.translation).slice(0, 2)).toEqual([
      'מסור',
      'לראות',
    ]);
  });

  it('cannot let a five-sense headword push another headword\'s top sense off the cap', async () => {
    await insertTerm(t.db, {
      lemma: 'see',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'saw', kind: 'word', entryRank: 0 }],
      senses: [0, 1, 2, 3, 4].map((n) => sense(n, `see${n}`)),
    });
    await insertTerm(t.db, {
      lemma: 'saw',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'saw', kind: 'word', entryRank: 1 }],
      senses: [sense(0, 'מסור')],
    });

    const translations = (await find('saw')).map((row) => row.translation);
    expect(translations).toHaveLength(5);
    expect(translations).toContain('מסור');
    expect(translations[1]).toBe('מסור');
  });

  it('answers identical queries identically, because the sort is total', async () => {
    await seedSawAndSee(0, 1);

    const first = await find('saw');
    const second = await find('saw');
    const third = await find('SAW');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('refuses a second term claiming an occupied entry_rank for one form', async () => {
    await seedSawAndSee(0, 1);

    await expect(
      insertTerm(t.db, {
        lemma: 'sawn',
        languageCode: 'en',
        userLanguageCode: 'he',
        variants: [{ form: 'saw', kind: 'word', entryRank: 1 }],
        senses: [sense(0, 'x')],
      }),
    ).rejects.toThrow();
  });

  it('scopes that index by language, so a Hebrew form does not collide', async () => {
    await seedSawAndSee(0, 1);

    await expect(
      insertTerm(t.db, {
        lemma: 'saw',
        languageCode: 'he',
        userLanguageCode: 'en',
        variants: [{ form: 'saw', kind: 'word', entryRank: 0 }],
        senses: [sense(0, 'x')],
      }),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 4: Run them to make sure they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration -w apps/server -- repo/vocabulary
```

Expected: FAIL — `Cannot find module '../../../src/repo/vocabulary'`.

- [ ] **Step 5: Write the read in `apps/server/src/repo/vocabulary.ts`**

```ts
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { termSenseTranslations, termVariants, vocabTermSenses } from '../db/schema';
import type { SenseRow } from '../domain/vocabulary';

// The response cap. The database has no five limit — `see` keeps all its
// senses and `saw` all of its — so this truncates the merge and nothing else,
// which is why a later lookup of `see` returns its full entry rather than
// whatever slice fitted alongside `saw`.
const READ_LIMIT = 5;

export function createVocabRepo(tx: Tx) {
  /**
   * Three tables, driven by the unique index's (language_code, lower(form))
   * prefix, with no join to `vocab_terms` at all — language and the ordering
   * key both live on the variant now.
   *
   * The inner join to `term_sense_translations` *is* the servability test: a
   * term with no translation in the language being asked for returns zero rows,
   * which the service reads as a miss. No column and no flag.
   *
   * `(s.rank, v.entry_rank)` is unique across one form's rows and `v.term_id`
   * closes it, so identical requests return identical answers — forever.
   */
  const findSensesByForm = async (input: {
    form: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<SenseRow[]> =>
    tx
      .select({
        termId: termVariants.termId,
        rank: vocabTermSenses.rank,
        entryRank: termVariants.entryRank,
        partOfSpeech: vocabTermSenses.partOfSpeech,
        exampleSource: vocabTermSenses.exampleSource,
        translation: termSenseTranslations.translation,
        exampleTarget: termSenseTranslations.exampleTarget,
      })
      .from(termVariants)
      .innerJoin(vocabTermSenses, eq(vocabTermSenses.termId, termVariants.termId))
      .innerJoin(
        termSenseTranslations,
        and(
          eq(termSenseTranslations.senseId, vocabTermSenses.id),
          eq(termSenseTranslations.userLanguageCode, input.userLanguageCode),
        ),
      )
      .where(
        and(
          eq(termVariants.languageCode, input.languageCode),
          // lower(form), matching the index expression exactly so the index is
          // usable. Hebrew has no case, so this is a no-op on that side.
          sql`lower(${termVariants.form}) = ${input.form.toLowerCase()}`,
        ),
      )
      // Rank leads, so the merge across headwords is round-robin rather than
      // block-per-entry: ordering by entry first would put all of `see`'s
      // senses ahead of `saw`'s, and a five-sense `see` would push `מסור` off
      // the cap entirely.
      .orderBy(asc(vocabTermSenses.rank), asc(termVariants.entryRank), asc(termVariants.termId))
      .limit(READ_LIMIT);

  return { findSensesByForm };
}

export type VocabRepo = ReturnType<typeof createVocabRepo>;
```

- [ ] **Step 6: Run them to verify they pass**

```bash
npm run test:integration -w apps/server -- repo/vocabulary
```

Expected: PASS, both files.

- [ ] **Step 7: Typecheck and the architecture checks**

```bash
npm run typecheck && npm run lint:arch
```

Expected: clean. R4 in particular: `repo/vocabulary.ts` imports `db/`, `drizzle-orm` and a
domain **type**, and reaches upward at nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/repo/vocabulary.ts apps/server/tests/support/vocabRows.ts \
        apps/server/tests/integration/repo/vocabulary.test.ts \
        apps/server/tests/integration/repo/vocabulary.order.test.ts
git commit -m "feat(repo): the by-form read, merged round-robin across headwords

Rank leads, entry_rank breaks the tie between headwords, term_id makes the sort
total. Tested against rows inserted directly, so nothing depends on a model."
```

---

### Task 6: `repo/vocabulary.ts` — the write, first-writer-wins

One transaction, ending by re-reading so the writer's answer is the same merge the next
reader gets.

**Files:**
- Modify: `apps/server/src/repo/vocabulary.ts`
- Test: `apps/server/tests/integration/repo/vocabulary.test.ts`

**Interfaces:**
- Consumes: `entriesToRows`, `rowsToSenses`, `SenseRow` (Task 3); `findSensesByForm`
  (Task 5).
- Produces, from `apps/server/src/repo/vocabulary.ts`:
  - `type PersistEntriesInput = { form: string; languageCode: string; userLanguageCode: string; kind: TranslationKind; entries: LlmEntry[] }`
  - `type PersistedEntry = { lemma: string; termId: string; variantId: string; senseIds: string[]; created: boolean }`
    — `senseIds` is the term's senses in rank order, whether this call wrote them or found
    them; `created` says whether this call inserted the term.
  - `persistEntries(input: PersistEntriesInput): Promise<{ written: PersistedEntry[]; senses: TranslationSense[] }>`

- [ ] **Step 1: Write the failing write tests**

Append to `apps/server/tests/integration/repo/vocabulary.test.ts` (adding
`import { eq } from 'drizzle-orm';`, `import { termVariants, vocabTermSenses } from '../../../src/db/schema';`
and `import type { LlmEntry } from '@lang-tutor/core/api';` at the top):

```ts
const entry = (lemma: string, translations: string[]): LlmEntry => ({
  lemma,
  senses: translations.map((translation, n) => ({ translation, sense_code: `c${n}` })),
});

const persist = (form: string, entries: LlmEntry[]) =>
  withTx(t.db, (tx) =>
    createVocabRepo(tx).persistEntries({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
      entries,
    }),
  );

describe('persistEntries', () => {
  it('writes a term per entry and a variant per entry carrying its entry_rank', async () => {
    const { written } = await persist('saw', [
      entry('see', ['לראות', 'להבין']),
      entry('saw', ['מסור']),
    ]);

    expect(written.map((row) => [row.lemma, row.created])).toEqual([
      ['see', true],
      ['saw', true],
    ]);

    const variants = await t.db.select().from(termVariants).where(eq(termVariants.form, 'saw'));
    expect(variants).toHaveLength(2);
    expect(variants.map((v) => v.entryRank).sort()).toEqual([0, 1]);
    expect(new Set(variants.map((v) => v.termId)).size).toBe(2);
  });

  it('returns ids that match the rows it wrote', async () => {
    const { written } = await persist('see', [entry('see', ['לראות', 'להבין'])]);
    const [row] = written;

    const [variant] = await t.db
      .select()
      .from(termVariants)
      .where(eq(termVariants.id, row.variantId));
    expect(variant.termId).toBe(row.termId);
    expect(variant.form).toBe('see');

    const senses = await t.db
      .select()
      .from(vocabTermSenses)
      .where(eq(vocabTermSenses.termId, row.termId));
    expect(senses.map((sense) => sense.rank).sort()).toEqual([0, 1]);
    expect([...row.senseIds].sort()).toEqual(senses.map((sense) => sense.id).sort());
    // senseIds is in rank order, which is what the seed hangs its questions off.
    expect(row.senseIds[0]).toBe(senses.find((sense) => sense.rank === 0)!.id);
  });

  it('answers with the same merge the next lookup would produce', async () => {
    const { senses } = await persist('saw', [
      entry('see', ['לראות', 'להבין', 'לפגוש']),
      entry('saw', ['מסור', 'לנסר']),
    ]);

    expect(senses.map((sense) => sense.translation)).toEqual([
      'לראות',
      'מסור',
      'להבין',
      'לנסר',
      'לפגוש',
    ]);
    expect(senses).toEqual(
      (await find('saw')).map((row) => ({ translation: row.translation })),
    );
  });

  it('keeps the first writer\'s senses when an entry names a lemma that exists', async () => {
    await persist('see', [entry('see', ['לראות', 'להבין', 'לפגוש'])]);

    const { written } = await persist('saw', [
      entry('see', ['משהו אחר לגמרי']),
      entry('saw', ['מסור']),
    ]);

    expect(written[0].created).toBe(false);
    expect((await find('see')).map((row) => row.translation)).toEqual([
      'לראות',
      'להבין',
      'לפגוש',
    ]);
    // Its contribution was the variant, and nothing else.
    expect((await find('saw')).map((row) => row.translation)).toContain('לראות');
  });

  it('is idempotent: the same call twice writes nothing the second time', async () => {
    const first = await persist('see', [entry('see', ['לראות'])]);
    const second = await persist('see', [entry('see', ['לראות'])]);

    expect(second.written[0].termId).toBe(first.written[0].termId);
    expect(second.written[0].variantId).toBe(first.written[0].variantId);
    expect(second.written[0].created).toBe(false);
    expect(await t.db.select().from(termVariants)).toHaveLength(1);
  });

  it('writes a variant only for the form that was queried — no lemma alias', async () => {
    // An alias is a guess about a string nobody looked up: synthesizing `saw`
    // here would make a later `saw` hit and return `מסור` alone, never asking
    // the model whether the bare string has other readings.
    await persist('saws', [entry('saw', ['מסור', 'לנסר'])]);

    expect(await find('saw')).toEqual([]);
    expect((await find('saws')).map((row) => row.translation)).toEqual(['מסור', 'לנסר']);
  });

  it('leaves two transactions racing on one new lemma with a single sense set', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withTx(t.db, async (tx) => {
      const out = await createVocabRepo(tx).persistEntries({
        form: 'kite',
        languageCode: 'en',
        userLanguageCode: 'he',
        kind: 'word',
        entries: [entry('kite', ['עפיפון'])],
      });
      await held; // keep the transaction open so the second one has to block
      return out;
    });

    // Long enough for the second transaction to reach the unique index and
    // block there. It cannot proceed until `first` commits.
    const second = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const out = persist('kite', [entry('kite', ['משהו אחר'])]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      return out;
    })();

    const [a, b] = await Promise.all([first, second]);

    expect(b.written[0].termId).toBe(a.written[0].termId);
    expect(b.written[0].created).toBe(false);
    expect(b.senses.map((sense) => sense.translation)).toEqual(['עפיפון']);
    expect(
      await t.db
        .select()
        .from(vocabTermSenses)
        .where(eq(vocabTermSenses.termId, a.written[0].termId)),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration -w apps/server -- repo/vocabulary.test
```

Expected: FAIL — `createVocabRepo(...).persistEntries is not a function`.

- [ ] **Step 3: Add the write to `apps/server/src/repo/vocabulary.ts`**

Extend the imports:

```ts
import type { LlmEntry, TranslationKind, TranslationSense } from '@lang-tutor/core/api';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import {
  termSenseTranslations,
  termVariants,
  vocabTerms,
  vocabTermSenses,
} from '../db/schema';
import { entriesToRows, rowsToSenses, type SenseRow } from '../domain/vocabulary';
```

and add inside `createVocabRepo`, before the `return`:

```ts
  /**
   * One write, first-writer-wins per term, ending in a re-read.
   *
   * Step 4 is the one condition that covers the cases that looked separate: a
   * brand-new headword writes its senses, and an entry naming a headword that
   * already exists contributes only its variant. A term that has senses is
   * never rewritten, merged or refreshed — there is no TTL and no
   * invalidation, which is what makes the concurrent case trivial and is also
   * why a poor answer for a new headword is served to everyone from then on.
   *
   * The concurrent double-miss is handled at step 1 rather than by retry logic:
   * the second transaction blocks on UNIQUE(language_code, lemma) until the
   * first commits, then finds the senses already there.
   */
  const persistEntries = async (
    input: PersistEntriesInput,
  ): Promise<{ written: PersistedEntry[]; senses: TranslationSense[] }> => {
    const written: PersistedEntry[] = [];

    for (const entry of entriesToRows(input.entries)) {
      // 1 — the term. DO NOTHING returns no row, which is exactly how "it was
      // already there" is detected; a concurrent request for the same new
      // lemma blocks here until the first commits.
      const [inserted] = await tx
        .insert(vocabTerms)
        .values({ languageCode: input.languageCode, lemma: entry.lemma })
        .onConflictDoNothing({ target: [vocabTerms.languageCode, vocabTerms.lemma] })
        .returning({ id: vocabTerms.id });

      let termId = inserted?.id;
      if (!termId) {
        const [existing] = await tx
          .select({ id: vocabTerms.id })
          .from(vocabTerms)
          .where(
            and(
              eq(vocabTerms.languageCode, input.languageCode),
              eq(vocabTerms.lemma, entry.lemma),
            ),
          );
        termId = existing.id;
      }

      // 2 — the variant, for the queried form only. The conflict target is
      // named rather than left bare: a bare DO NOTHING would also swallow a
      // collision on (language_code, lower(form), entry_rank), which is the
      // safety net and must be allowed to raise.
      await tx
        .insert(termVariants)
        .values({
          termId,
          languageCode: input.languageCode,
          form: input.form,
          kind: input.kind,
          entryRank: entry.entryRank,
        })
        .onConflictDoNothing({ target: [termVariants.termId, termVariants.form] });

      const [variant] = await tx
        .select({ id: termVariants.id })
        .from(termVariants)
        .where(and(eq(termVariants.termId, termId), eq(termVariants.form, input.form)));

      // 3 — this term's senses, in rank order. The seed hangs its questions
      // off senseIds[0], so the order is part of the contract.
      const existingSenses = await tx
        .select({ id: vocabTermSenses.id })
        .from(vocabTermSenses)
        .where(eq(vocabTermSenses.termId, termId))
        .orderBy(asc(vocabTermSenses.rank));

      let senseIds = existingSenses.map((sense) => sense.id);

      // 4 — first writer wins.
      if (senseIds.length === 0) {
        const rows = await tx
          .insert(vocabTermSenses)
          .values(
            entry.senses.map((sense) => ({
              termId,
              senseCode: sense.senseCode,
              rank: sense.rank,
              partOfSpeech: sense.partOfSpeech,
              exampleSource: sense.exampleSource,
            })),
          )
          .returning({ id: vocabTermSenses.id, rank: vocabTermSenses.rank });

        const idByRank = new Map(rows.map((row) => [row.rank, row.id]));
        senseIds = entry.senses.map((sense) => idByRank.get(sense.rank)!);

        await tx.insert(termSenseTranslations).values(
          entry.senses.map((sense) => ({
            senseId: idByRank.get(sense.rank)!,
            userLanguageCode: input.userLanguageCode,
            translation: sense.translation,
            exampleTarget: sense.exampleTarget,
          })),
        );
      }

      written.push({ lemma: entry.lemma, termId, variantId: variant.id, senseIds, created: !!inserted });
    }

    // 5 — the re-read. Returning only what was just written would give the
    // writer a different answer from the next reader whenever the queried form
    // was already a variant of another term. One query, and the invariant
    // becomes literal: the response is always the same merge the next lookup
    // would produce.
    const senses = rowsToSenses(
      await findSensesByForm({
        form: input.form,
        languageCode: input.languageCode,
        userLanguageCode: input.userLanguageCode,
      }),
    );

    return { written, senses };
  };
```

then change the return to `return { findSensesByForm, persistEntries };` and add the two
exported types above `createVocabRepo`:

```ts
export type PersistEntriesInput = {
  /** The queried string, already normalized. Stored as written; matched lower. */
  form: string;
  languageCode: string;
  userLanguageCode: string;
  kind: TranslationKind;
  entries: LlmEntry[];
};

/** What one entry became. `senseIds` is the term's senses in rank order —
 *  whether this call wrote them or found them already there. */
export type PersistedEntry = {
  lemma: string;
  termId: string;
  variantId: string;
  senseIds: string[];
  created: boolean;
};
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm run test:integration -w apps/server -- repo/vocabulary
```

Expected: PASS, both files.

- [ ] **Step 5: Run the whole suite and the checks**

```bash
npm test && npm run test:integration && npm run typecheck && npm run lint:arch
```

Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/repo/vocabulary.ts apps/server/tests/integration/repo/vocabulary.test.ts
git commit -m "feat(repo): persistEntries — first-writer-wins, ending in a re-read

One condition covers both cases: a new headword writes its senses, an entry
naming an existing headword contributes only its variant. The re-read is what
makes the writer's answer identical to the next reader's."
```

---

### Task 7: The use case — read, then the model on a miss, then write

Two short transactions with the provider call between them, never one held open across
it. This is the task that makes seeded strings answer from Postgres, so it also carries
the fixture-word changes that keep the route and e2e suites honest.

**Files:**
- Modify: `apps/server/src/services/transaction.ts`
- Modify: `apps/server/src/services/translations.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/tests/support/fakes.ts`
- Test: `apps/server/src/services/translations.test.ts`
- Modify: `apps/server/src/services/users.test.ts` (one call site)
- Test: `apps/server/tests/integration/composition.test.ts`
- Modify: `apps/server/tests/integration/routes/translations.test.ts` (fixture words)
- Modify: `e2e/tests/translate.spec.ts` (fixture words)

**Interfaces:**
- Consumes: `VocabRepo`, `PersistEntriesInput` (Task 6); `normalizeForm`, `languagesFor`,
  `rowsToSenses`, `mergeEntries`, `flattenEntries` (Tasks 1 and 3).
- Produces:
  - `Repos` gains `vocab: VocabRepo`.
  - `createTranslationService({ llm, transaction, logger })`.
  - `createFakeTransaction(repos: Partial<Repos>): Transaction` — **signature change**.
  - `createFakeVocabRepo(): FakeVocabRepo` in `tests/support/fakes.ts`.

- [ ] **Step 1: Widen the fakes**

In `apps/server/tests/support/fakes.ts`, add the imports:

```ts
import { flattenEntries, rowsToSenses, type SenseRow } from '../../src/domain/vocabulary';
import type { PersistEntriesInput, VocabRepo } from '../../src/repo/vocabulary';
```

`import type` on the repository is load-bearing: `repo/vocabulary.ts` imports `drizzle-orm`
at runtime, and `src/**/*.test.ts` takes this file. A value import here would drag Drizzle
into the unit bucket, which ADR 0004 R1 forbids.

Replace `createFakeTransaction` with:

```ts
/** Runs `run` immediately with whichever repositories the test named; every
 *  other one throws with the method that was reached for. No rollback, by
 *  design: a fake that pretended to roll back would be asserting a database
 *  behaviour it cannot actually provide. */
export function createFakeTransaction(repos: Partial<Repos>): Transaction {
  const bound: Repos = {
    user: repos.user ?? unreachableRepo('user repo'),
    session: repos.session ?? unreachableRepo('session repo'),
    question: repos.question ?? unreachableRepo('question repo'),
    vocab: repos.vocab ?? unreachableRepo('vocab repo'),
  };
  return (run) => run(bound);
}
```

and append:

```ts
export type FakeVocabRepo = VocabRepo & {
  /** What the next read answers with. Empty is a miss. */
  hit: SenseRow[];
  /** What the write's re-read answers with. Left empty, the fake answers with
   *  the entries it was handed, flattened by the real domain function — which
   *  is what the real re-read would produce for a form nobody else claims. */
  reread: SenseRow[];
  /** Set to make the write throw. */
  persistError: Error | null;
  persisted: PersistEntriesInput[];
  reads: { form: string; languageCode: string; userLanguageCode: string }[];
};

export function createFakeVocabRepo(): FakeVocabRepo {
  const repo: FakeVocabRepo = {
    hit: [],
    reread: [],
    persistError: null,
    persisted: [],
    reads: [],
    findSensesByForm: async (input) => {
      repo.reads.push(input);
      return repo.hit;
    },
    persistEntries: async (input) => {
      repo.persisted.push(input);
      if (repo.persistError) throw repo.persistError;
      return {
        written: input.entries.map((entry, index) => ({
          lemma: entry.lemma,
          termId: `t-${index}`,
          variantId: `v-${index}`,
          senseIds: entry.senses.map((_, rank) => `s-${index}-${rank}`),
          created: true,
        })),
        senses: repo.reread.length > 0 ? rowsToSenses(repo.reread) : flattenEntries(input.entries),
      };
    },
  };
  return repo;
}
```

In `apps/server/src/services/users.test.ts`, change the one call site to
`createFakeTransaction({ user: repo })`.

- [ ] **Step 2: Write the failing service tests**

In `apps/server/src/services/translations.test.ts`, replace `serviceWith`:

```ts
import { createFakeLlmClient, createFakeLogger, createFakeTransaction, createFakeVocabRepo } from '../../tests/support/fakes';

function serviceWith(...replies: (string | Error)[]) {
  const llm = createFakeLlmClient(...replies);
  const logger = createFakeLogger();
  const vocab = createFakeVocabRepo();
  const transaction = createFakeTransaction({ vocab });
  return { service: createTranslationService({ llm, transaction, logger }), llm, logger, vocab };
}

const row = (translation: string): SenseRow => ({
  termId: 't-1',
  rank: 0,
  entryRank: 0,
  partOfSpeech: null,
  exampleSource: null,
  translation,
  exampleTarget: null,
});
```

(with `import type { SenseRow } from '../domain/vocabulary';`), update the one log
assertion, and add the new tests:

```ts
  it('serves a hit from the database and calls the model zero times', async () => {
    const { service, llm, vocab, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    vocab.hit = [row('סולם')];

    const result = await service.translate({ text: 'ladder' });

    expect(llm.calls).toHaveLength(0);
    expect(result.senses).toEqual([{ translation: 'סולם' }]);
    expect(logger.events[0]).toEqual({
      event: 'vocab_cache_hit',
      direction: 'en_he',
      term_count: 1,
      sense_count: 1,
    });
  });

  it('reads with the normalized form and the direction\'s language pair', async () => {
    const { service, vocab } = serviceWith(reply({ kind: 'word', entries: [] }));

    await service.translate({ text: '  good   morning ' });

    expect(vocab.reads[0]).toEqual({
      form: 'good morning',
      languageCode: 'en',
      userLanguageCode: 'he',
    });
  });

  it('writes every entry on a miss, with the queried form and the resolved kind', async () => {
    const { service, llm, vocab } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          { lemma: 'see', senses: [{ translation: 'לראות', sense_code: 'perceive' }] },
          { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
        ],
      }),
    );

    await service.translate({ text: 'saw' });

    expect(llm.calls).toHaveLength(1);
    expect(vocab.persisted).toHaveLength(1);
    expect(vocab.persisted[0]).toMatchObject({
      form: 'saw',
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
    });
    expect(vocab.persisted[0].entries.map((entry) => entry.lemma)).toEqual(['see', 'saw']);
  });

  it('answers with what the write re-read, not with what the model replied', async () => {
    // The re-read is what makes the writer's answer identical to the next
    // reader's, so the service must not shortcut it.
    const { service, vocab } = serviceWith(
      reply({
        kind: 'word',
        entries: [{ lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] }],
      }),
    );
    vocab.reread = [row('לראות'), row('מסור')];

    const result = await service.translate({ text: 'saw' });

    expect(result.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור']);
  });

  it('merges two entries for one lemma before writing, so neither is dropped', async () => {
    const { service, vocab } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          { lemma: 'book', senses: [{ translation: 'ספר', sense_code: 'printed_book' }] },
          { lemma: 'book', senses: [{ translation: 'להזמין', sense_code: 'reserve' }] },
        ],
      }),
    );

    await service.translate({ text: 'book' });

    expect(vocab.persisted[0].entries).toHaveLength(1);
    expect(vocab.persisted[0].entries[0].senses).toHaveLength(2);
  });

  it('still answers 200 with the flattened entries when the write throws', async () => {
    const { service, vocab, logger } = serviceWith(
      reply({
        kind: 'word',
        entries: [{ lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] }],
      }),
    );
    vocab.persistError = new Error('deadlock detected');

    const result = await service.translate({ text: 'saw' });

    expect(result.senses).toEqual([{ translation: 'מסור' }]);
    expect(logger.errors.map((entry) => entry.message)).toContain('vocab_persist_failed');
  });

  it('writes nothing for a sentence, an empty entry list, or a provider failure', async () => {
    const sentence = serviceWith(
      reply({
        kind: 'sentence',
        entries: [
          { lemma: 'I read a book', senses: [{ translation: 'קראתי ספר.', sense_code: 's' }] },
        ],
      }),
    );
    await sentence.service.translate({ text: 'I read a book' });
    expect(sentence.vocab.persisted).toHaveLength(0);

    const empty = serviceWith(reply({ kind: 'word', entries: [] }));
    await empty.service.translate({ text: 'asdkjhasd' });
    expect(empty.vocab.persisted).toHaveLength(0);

    const blocked = serviceWith('');
    await blocked.service.translate({ text: 'asdkjhasd' });
    expect(blocked.vocab.persisted).toHaveLength(0);

    const down = serviceWith(new LlmUnavailable('responded 500'));
    await expect(down.service.translate({ text: 'saw' })).rejects.toBeInstanceOf(LlmUnavailable);
    expect(down.vocab.persisted).toHaveLength(0);
  });

  it('logs what it persisted', async () => {
    const { service, logger } = serviceWith(
      reply({
        kind: 'word',
        entries: [{ lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] }],
      }),
    );

    await service.translate({ text: 'saw' });

    expect(logger.events).toEqual([
      { event: 'vocab_persisted', entry_count: 1, terms_created: 1 },
      { event: 'translated', direction: 'en_he', kind: 'word', sense_count: 1 },
    ]);
  });
```

and change the existing `logs one event per successful translation` test to expect the same
two-event list (or delete it, since the test above supersedes it — deleting is the better
choice, and is what this step means by "update the one log assertion").

- [ ] **Step 3: Run them to make sure they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- services/translations
```

Expected: FAIL — `createTranslationService` does not take a `transaction`, and no read
happens, so the hit test still calls the model.

- [ ] **Step 4: Add `vocab` to `Repos`**

In `apps/server/src/services/transaction.ts`:

```ts
import type { VocabRepo } from '../repo/vocabulary';
```
```ts
export type Repos = {
  session: SessionRepo;
  question: QuestionRepo;
  user: UserRepo;
  vocab: VocabRepo;
};
```

- [ ] **Step 5: Rewrite `apps/server/src/services/translations.ts`**

```ts
import type { TranslationRequest, TranslationResponse } from '@lang-tutor/core/api';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from '../domain/translation';
import {
  flattenEntries,
  languagesFor,
  mergeEntries,
  normalizeForm,
  rowsToSenses,
} from '../domain/vocabulary';
import { TranslationUnreadable } from '../errors';
import type { Logger } from '../logger';
import type { LlmClient } from './llm';
import type { Transaction } from './transaction';

/**
 * One use case: translate a word, phrase or sentence, reusing what the
 * dictionary already holds.
 *
 * **Two transactions, not one.** ADR 0001 R8 is amended in this phase to say a
 * use case opens at most one *write* transaction, and a read preceding
 * third-party I/O may be its own. Holding one open across the provider call
 * was rejected outright: ten seconds of an idle pooled connection per lookup,
 * one per concurrent learner. The two race harmlessly, because the write is
 * idempotent against UNIQUE(language_code, lemma) and UNIQUE(term_id, form).
 *
 * Note the calls read `transaction(...)`, never `deps.transaction(...)`: R8's
 * detection command greps for the literal `.transaction(`.
 */
export function createTranslationService({
  llm,
  transaction,
  logger,
}: {
  llm: LlmClient;
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    translate: async (input: TranslationRequest): Promise<TranslationResponse> => {
      // The schema already trimmed this, but the service must not depend on the
      // order validators ran in.
      const text = input.text.trim();
      const direction = input.direction ?? detectDirection(text);
      const { source, target } = languagesFor(direction);
      const form = normalizeForm(text);

      const hit = await transaction((repos) =>
        repos.vocab.findSensesByForm({
          form,
          languageCode: source,
          userLanguageCode: target,
        }),
      );

      if (hit.length > 0) {
        const senses = rowsToSenses(hit);
        logger.info({
          event: 'vocab_cache_hit',
          direction,
          term_count: new Set(hit.map((row) => row.termId)).size,
          sense_count: senses.length,
        });
        // Derived, not stored: sentences are never written, so anything in the
        // dictionary is a word or a phrase.
        return { text, direction, kind: resolveKind(text, 'phrase'), senses };
      }

      const raw = await llm(buildPrompt({ text, direction }));

      // An empty string is the contract's "no content" — a safety block, or a
      // candidate with no text. The input was refused; nothing is broken, and
      // nothing is written.
      if (raw === '') {
        logger.info({ event: 'translation_no_content', direction });
        return { text, direction, kind: resolveKind(text, 'word'), senses: [] };
      }

      const parsed = parseLlmTranslation(raw);
      // `domain/` cannot throw this itself: R3 forbids it importing ../errors.
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      const kind = resolveKind(text, parsed.kind);
      const entries = mergeEntries(parsed.entries);
      const flattened = normalizeSenses(kind, flattenEntries(entries));

      // A sentence is not a vocabulary item, and caching "no translation" would
      // freeze a transient answer into a permanent dictionary. Both keep
      // costing on every repeat, deliberately.
      if (kind === 'sentence' || entries.length === 0) {
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        return { text, direction, kind, senses: flattened };
      }

      try {
        const { written, senses } = await transaction((repos) =>
          repos.vocab.persistEntries({
            form,
            languageCode: source,
            userLanguageCode: target,
            kind,
            entries,
          }),
        );
        logger.info({
          event: 'vocab_persisted',
          entry_count: written.length,
          terms_created: written.filter((entry) => entry.created).length,
        });
        logger.info({ event: 'translated', direction, kind, sense_count: senses.length });
        return { text, direction, kind, senses };
      } catch (error) {
        // A failed write must not lose a translation the learner already paid
        // for. A broken persistence path shows up as this log line and as every
        // lookup costing a provider call — not as a 502 on a request the model
        // answered.
        logger.error('vocab_persist_failed', error);
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        return { text, direction, kind, senses: flattened };
      }
    },
  };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
```

- [ ] **Step 6: Bind the repository in `apps/server/src/composition.ts`**

Add `import { createVocabRepo } from './repo/vocabulary';`, add `vocab: createVocabRepo(tx),`
to the `createTransaction` bind object, and pass the transaction to the service:

```ts
    translations: createTranslationService({ llm, transaction, logger: io.logger }),
```

- [ ] **Step 7: Run the unit bucket**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 8: Prove the wiring against a real database**

Add to `apps/server/tests/integration/composition.test.ts` (importing `insertTerm` from
`../support/vocabRows`):

```ts
  it('assembles a translations service that reads the database, not the provider', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [
        {
          rank: 0,
          senseCode: 'climbing_frame',
          translation: 'סולם',
          partOfSpeech: 'noun',
          exampleSource: null,
          exampleTarget: null,
        },
      ],
    });

    // createTestServerDeps defaults geminiBaseUrl to an unroutable namespace,
    // so an answer here can only have come from Postgres — which is the proof
    // that the service received a transaction at all.
    const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });

    await expect(deps.translations.translate({ text: 'Ladder' })).resolves.toMatchObject({
      kind: 'word',
      senses: [{ translation: 'סולם', part_of_speech: 'noun' }],
    });
  });
```

- [ ] **Step 9: Move the route fixtures off the seeded words**

The sixteen seeded strings now answer from Postgres, so a test that wants a provider call
must not use one. In `apps/server/tests/integration/routes/translations.test.ts` replace
every `text: 'book'` with `text: 'ladder'` and rewrite the first test's payload and
expectation around it:

```ts
  it('returns ranked senses for a word', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'ladder',
          senses: [
            {
              translation: 'סולם',
              part_of_speech: 'noun',
              example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
              sense_code: 'climbing_frame',
            },
            { translation: 'דירוג', part_of_speech: 'noun', sense_code: 'ranking' },
          ],
        },
      ],
    });

    const res = await translate({ text: 'ladder' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: 'ladder',
      direction: 'en_he',
      kind: 'word',
      senses: [
        {
          translation: 'סולם',
          part_of_speech: 'noun',
          example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
        },
        { translation: 'דירוג', part_of_speech: 'noun' },
      ],
    });
  });
```

Add a comment at the top of the file recording why:

```ts
// Every test here that expects a provider call uses a string the seed does not
// contain. As of phase 10 a seeded string answers from Postgres and never
// reaches MockServer — which is the whole point, and would otherwise turn the
// 502 and timeout tests into silent 200s.
```

- [ ] **Step 10: Move the e2e fixtures off the seeded words too**

In `e2e/tests/translate.spec.ts`, rename `BOOK_ENTRIES` to `LADDER_ENTRIES` with
`lemma: 'ladder'` and three ladder senses (`סולם` / `דירוג` / `להוביל`, each with a
`sense_code` and an example whose source names the lemma), and change the first spec's
input to `ladder`. Change the retry spec's input to `anchor` and give it its own one-entry
payload — a **different** word, because the first spec has already written `ladder` to the
long-lived e2e database and a second lookup of it would never reach MockServer, so the
failing-provider assertion would never fire. Add the same comment as above.

- [ ] **Step 11: Run everything**

```bash
npm test && npm run test:integration && npm run typecheck && npm run lint:arch
```

Expected: all clean. `lint:arch` must still say **17 rules** — in particular R8's check,
which greps for `.transaction(`, must still find only `db/transaction.ts`.

```bash
npm run e2e
```

Expected: PASS, all five specs.

- [ ] **Step 12: Commit**

```bash
git add apps/server/src apps/server/tests e2e/tests
git commit -m "feat: reuse a translation instead of asking the model twice

The use case reads the dictionary, calls the provider only on a miss, and
writes the whole answer back — two short transactions with the call between
them, never one held open across it. A failed write still returns 200."
```

---

### Task 8: The integration proof — the same string, one provider request

The assertion the phase exists for, against a real database and a real socket to
MockServer. Nothing is injected into the server: only the base URL differs from
production.

**Files:**
- Modify: `apps/server/tests/support/mockServer.ts`
- Create: `apps/server/tests/integration/services/translations.test.ts`
- Modify: `apps/server/tests/integration/routes/translations.test.ts`

**Interfaces:**
- Consumes: everything from Task 7.
- Produces: `countGeminiRequests(ns: string, matchText?: string): Promise<number>` in
  `apps/server/tests/support/mockServer.ts`.

- [ ] **Step 1: Add the request-count helper**

Append to `apps/server/tests/support/mockServer.ts`:

```ts
/**
 * How many generateContent requests this namespace actually received.
 *
 * `verify` answers matched/not-matched; a count is what "exactly one provider
 * request for two lookups" needs. `matchText` narrows to requests whose body
 * carries a given string, so one test's traffic cannot be confused with
 * another's inside the same namespace.
 */
export async function countGeminiRequests(ns: string, matchText?: string): Promise<number> {
  const res = await fetch(`${ADMIN_URL}/mockserver/retrieve?type=REQUESTS&format=JSON`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'POST',
      path: generateContentPath(ns),
      ...(matchText ? { body: { type: 'REGEX', regex: `[\\s\\S]*${matchText}[\\s\\S]*` } } : {}),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`MockServer retrieve returned ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as unknown[]).length;
}
```

- [ ] **Step 2: Write the failing service integration test**

Create `apps/server/tests/integration/services/translations.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  countGeminiRequests,
  expectGeminiJson,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Black-box: production's assembly with a per-test database and this test's own
// MockServer namespace. The real Gemini client makes a real HTTP request over a
// real socket, and nothing is faked inside the server.
//
// Every string here is one the seed does not contain — a seeded string answers
// from Postgres and never reaches MockServer.

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('services-translations');
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

function translations() {
  return createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    geminiBaseUrl: geminiBaseUrlFor(ns),
  }).translations;
}

const entry = (lemma: string, values: string[]) => ({
  lemma,
  senses: values.map((translation, n) => ({
    translation,
    part_of_speech: 'verb',
    example: { source: `A sentence about ${lemma}.`, target: 'משפט.' },
    sense_code: `${lemma}_${n}`,
  })),
});

describe('translate, against a real database', () => {
  it('asks the provider once for two lookups of the same string', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [entry('ladder', ['סולם', 'דירוג'])] });
    const service = translations();

    const first = await service.translate({ text: 'ladder' });
    const second = await service.translate({ text: 'ladder' });

    expect(second).toEqual(first);
    expect(await countGeminiRequests(ns, 'ladder')).toBe(1);
  });

  it('serves a different casing and spacing of the same string from the dictionary', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [entry('ladder', ['סולם'])] });
    const service = translations();

    await service.translate({ text: 'ladder' });
    const again = await service.translate({ text: '  LADDER  ' });

    expect(again.senses).toEqual([
      { translation: 'סולם', part_of_speech: 'verb', example: { source: 'A sentence about ladder.', target: 'משפט.' } },
    ]);
    expect(await countGeminiRequests(ns, 'LADDER')).toBe(0);
  });

  it('walks the saw sequence end to end', async () => {
    // Registration order matters: MockServer takes the first matching
    // expectation, and the body for `saws` also contains `saw`.
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [entry('saw', ['מסור', 'לנסר'])],
      matchText: 'saws',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [entry('see', ['לראות', 'להבין', 'לפגוש']), entry('saw', ['מסור', 'לנסר'])],
      matchText: 'saw',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [entry('see', ['לראות', 'להבין', 'לפגוש'])],
      matchText: 'see',
    });
    const service = translations();

    // 1 — `see` on an empty dictionary: its own three.
    const see = await service.translate({ text: 'see' });
    expect(see.senses.map((sense) => sense.translation)).toEqual(['לראות', 'להבין', 'לפגוש']);

    // 2 — `saw`: both headwords answered and both written, in one call.
    const saw = await service.translate({ text: 'saw' });
    expect(saw.senses.map((sense) => sense.translation)).toEqual([
      'לראות',
      'מסור',
      'להבין',
      'לנסר',
      'לפגוש',
    ]);

    // 3 — the same lookup again is free and identical.
    expect(await service.translate({ text: 'saw' })).toEqual(saw);
    expect(await countGeminiRequests(ns, '"saw"')).toBe(1);

    // 4 — `saws` is a second call, because no lemma alias was synthesized.
    const saws = await service.translate({ text: 'saws' });
    expect(saws.senses.map((sense) => sense.translation)).toEqual(['מסור', 'לנסר']);

    // 5 — `see` still answers with its own three. Correctly no מסור: `see` is
    // not ambiguous, even though `saw` is.
    expect(await service.translate({ text: 'see' })).toEqual(see);
  });

  it('keeps costing for a sentence, because a sentence is not a vocabulary item', async () => {
    await expectGeminiJson(ns, {
      kind: 'sentence',
      entries: [
        {
          lemma: 'I climbed the ladder',
          senses: [{ translation: 'טיפסתי על הסולם.', sense_code: 'the_sentence' }],
        },
      ],
    });
    const service = translations();

    await service.translate({ text: 'I climbed the ladder' });
    await service.translate({ text: 'I climbed the ladder' });

    expect(await countGeminiRequests(ns, 'climbed')).toBe(2);
  });

  it('keeps costing for an answer with no entries', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [] });
    const service = translations();

    await service.translate({ text: 'asdkjhasd' });
    await service.translate({ text: 'asdkjhasd' });

    expect(await countGeminiRequests(ns, 'asdkjhasd')).toBe(2);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails, then passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration -w apps/server -- services/translations
```

Expected on the first run: FAIL, because `countGeminiRequests` did not exist before Step 1
— run it once **before** Step 1 if you want to see that, otherwise expect PASS here. If
any case fails now, the defect is in Task 6 or 7, not in this file.

- [ ] **Step 4: Extend the route tests over HTTP**

Append to `apps/server/tests/integration/routes/translations.test.ts` (adding
`countGeminiRequests` to the `../../support/mockServer` import):

```ts
  it('answers the same string twice over HTTP with one provider request', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'ladder',
          senses: [
            {
              translation: 'סולם',
              part_of_speech: 'noun',
              example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
              sense_code: 'climbing_frame',
            },
          ],
        },
      ],
    });

    const first = await translate({ text: 'ladder' });
    const second = await translate({ text: 'ladder' });

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(await countGeminiRequests(ns, 'ladder')).toBe(1);
  });

  it('flattens a two-entry answer into one ranked list on the wire', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'see',
          senses: [
            { translation: 'לראות', part_of_speech: 'verb', sense_code: 'perceive' },
            { translation: 'להבין', part_of_speech: 'verb', sense_code: 'understand' },
          ],
        },
        {
          lemma: 'saw',
          senses: [{ translation: 'מסור', part_of_speech: 'noun', sense_code: 'tool' }],
        },
      ],
    });

    const res = await translate({ text: 'saw' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { senses: { translation: string }[] };
    // One flat list, with no sign that two headwords are in it — the per-sense
    // part_of_speech is the only hint. Grouping is out of scope for this phase.
    expect(body.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור', 'להבין']);
    expect(body.senses[0]).not.toHaveProperty('sense_code');
  });
```

- [ ] **Step 5: Run the whole integration bucket**

```bash
npm run test:integration
```

Expected: PASS.

- [ ] **Step 6: Typecheck and the architecture checks**

```bash
npm run typecheck && npm run lint:arch
```

Expected: clean. R2's two test commands matter here: the new service test must not import
`hono`, `drizzle-orm`, `pg` or anything under `src/db/`, and may reference `src/repo/`
modules only with `import type` — it imports neither.

- [ ] **Step 7: Commit**

```bash
git add apps/server/tests
git commit -m "test: the same string asked twice makes exactly one provider request

Against a real database and a real socket to MockServer, plus the saw sequence
end to end: two headwords written from one answer, and the re-ask free."
```

---

### Task 9: The e2e spec — the answer survives the expectation being deleted

Shaped to survive a database that already holds the string: register, look up, **clear
every expectation**, look up again. If the answer still appears it came from Postgres,
because there is nothing left for the provider to answer with. A "the second lookup makes
no request" assertion would not survive a re-run, since e2e shares one long-lived
database across specs and nothing truncates it between them.

**Files:**
- Modify: `e2e/tests/translate.spec.ts`

**Interfaces:**
- Consumes: `clearGemini`, `expectGemini` (existing); the `translate-*` test ids, which
  are unchanged — `apps/mobile` is not touched by this phase.

- [ ] **Step 1: Write the spec**

Append to `e2e/tests/translate.spec.ts`:

```ts
test('a word looked up twice is answered without the provider the second time', async ({
  page,
  request,
}) => {
  const KITE_ENTRIES = [
    {
      lemma: 'kite',
      senses: [
        {
          translation: 'עפיפון',
          part_of_speech: 'noun',
          example: { source: 'The kite flew over the beach.', target: 'העפיפון עף מעל החוף.' },
          sense_code: 'flying_toy',
        },
        {
          translation: 'דיה',
          part_of_speech: 'noun',
          example: { source: 'A kite circled above the field.', target: 'דיה חגה מעל השדה.' },
          sense_code: 'bird_of_prey',
        },
      ],
    },
  ];

  await expectGemini(request, { kind: 'word', entries: KITE_ENTRIES });
  await openTranslate(page, request, 'e2e_translate_reuse');

  await page.getByTestId('translate-input').fill('kite');
  await page.getByTestId('translate-submit').click();
  await expect(sense(page, 'עפיפון')).toBeVisible();

  // Choosing is what reveals the "new word" control. It records nothing — as of
  // phase 10 the rows were written when the answer arrived, so the tap confirms
  // something that already happened.
  await page.getByTestId('translate-choose').first().click();
  await expect(page.getByTestId('translate-chosen')).toHaveText('התרגום נשמר לאוצר המילים שלך');
  await page.getByTestId('translate-new-word').click();

  // Nothing is left for the provider to answer with. An answer now can only
  // have come from Postgres.
  await clearGemini(request);

  await page.getByTestId('translate-input').fill('kite');
  await page.getByTestId('translate-submit').click();

  await expect(sense(page, 'עפיפון')).toBeVisible();
  await expect(page.getByTestId('translate-more')).toContainText('1');
  await page.getByTestId('translate-more').click();
  await expect(sense(page, 'דיה')).toBeVisible();
  await expect(page.getByTestId('translate-error')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the e2e suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run e2e
```

Expected: PASS, all six specs. `globalSetup` drops and recreates `lang_tutor_e2e` per run,
so `kite` is absent at the start of every run.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/translate.spec.ts
git commit -m "test(e2e): the second lookup answers with every expectation cleared

Shaped to survive a database that already holds the string, which a
request-count assertion would not."
```

---

### Task 10: The recorder — `npm run content:generate`

> **This task needs `GEMINI_API_KEY` and `GEMINI_MODEL` and spends real money.** It is the
> only step in this plan that cannot run offline, and it is absent from every CI job. If
> no key is available, **stop here and ask** — Tasks 11 and 12 depend on the recording,
> and hand-writing `content.generated.ts` would defeat the point of the phase: seeded rows
> are indistinguishable from looked-up rows precisely because a model wrote them.

It lives in `tests/eval/` for one concrete reason: ADR 0001 R11 allows `providers/` to be
imported only from `composition.ts`, with `tests/support/` and `tests/eval/` exempt.
Putting it anywhere else means a third exemption in a grep whose whole value is being
short. It is a build tool under `tests/`, which is mildly odd, and the alternative —
`scripts/` plus two ADR edits — is worse.

**Files:**
- Create: `apps/server/src/db/content.generated.ts` (stub first, then recorded)
- Create: `apps/server/tests/eval/generate-content.ts`
- Modify: `package.json`, `apps/server/package.json`

**Interfaces:**
- Consumes: `askModel` (Task 2), `content` (existing `db/content.ts` — the recorder reads
  only `query`, which Task 11's rewrite keeps).
- Produces: `recorded: Record<string, LlmTranslation>` in
  `apps/server/src/db/content.generated.ts`, keyed by the query string.

- [ ] **Step 1: Add the `query` field to the authoring file**

Task 11 rewrites `db/content.ts` completely. The recorder needs its input now, so add one
field to each of the sixteen entries and to `ContentEntry`, leaving everything else alone:

```ts
  /** What a learner would type. The recorder's input, the variant's form, and
   *  the quiz prompt — one string doing all three, honestly. */
  query: string;
```

Its value is the entry's existing `prompt`, verbatim, for all sixteen.

- [ ] **Step 2: Create the empty recording**

Create `apps/server/src/db/content.generated.ts`:

```ts
// Written by `npm run content:generate`, reviewed by a human, committed.
// DO NOT EDIT BY HAND — re-record instead, and read the diff.
import type { LlmTranslation } from '@lang-tutor/core/api';

export const recorded: Record<string, LlmTranslation> = {};
```

It starts empty so the recorder, which merges into it, has something to import on its
first run.

- [ ] **Step 3: Write the recorder**

Create `apps/server/tests/eval/generate-content.ts`:

```ts
/**
 * Records a real provider answer per seeded string, so the seed is a recording
 * rather than a special case.
 *
 * It calls `buildPrompt` and `createGeminiClient` — the production prompt and
 * the production client, the same pair the eval runner uses — and writes
 * `src/db/content.generated.ts`. A developer reads the diff and commits it.
 * Seeded rows and looked-up rows are then indistinguishable, because they were
 * made the same way: `db/seed.ts` replays this through `persistEntries`.
 *
 * It lives here rather than in `scripts/` because ADR 0001 R11 exempts exactly
 * two directories from "providers/ is constructed only at the composition
 * root", and this bucket is already one of them — ADR 0004 R4 defines
 * `tests/eval/` as the opt-in real-model code, which describes a recorder
 * exactly. It is not an eval and is not scored; it shares the bucket because it
 * shares the provider client.
 *
 * Not named *.test.ts, so neither Jest project can pick it up.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LlmTranslation } from '@lang-tutor/core/api';

import { loadGeminiConfig } from '../../src/config';
import { content } from '../../src/db/content';
import { recorded } from '../../src/db/content.generated';
import { createGeminiClient } from '../../src/providers/gemini';
import { askModel } from './askModel';

const TIMEOUT_MS = 30_000;
const OUTPUT = join(__dirname, '..', '..', 'src', 'db', 'content.generated.ts');

const HEADER = `// Recorded provider answers, one per seeded string. Generated by
// \`npm run content:generate\` and reviewed by hand; db/seed.ts replays these
// through persistEntries, the same write path a lookup uses, which is why a
// seeded row and a looked-up row are indistinguishable.
//
// DO NOT EDIT BY HAND. Re-record one string with
// \`npm run content:generate -- <query>\`, read the diff, and commit it.
import type { LlmTranslation } from '@lang-tutor/core/api';

export const recorded: Record<string, LlmTranslation> = `;

async function main(): Promise<void> {
  const gemini = loadGeminiConfig(process.env);
  if (gemini.baseUrl.includes('localhost') || gemini.baseUrl.includes('127.0.0.1')) {
    throw new Error(
      `GEMINI_BASE_URL points at ${gemini.baseUrl}. A recording must come from the real ` +
        'API; unset it to use the default.',
    );
  }

  // A filter, and a merge rather than a replace. Without it every re-record
  // produces a sixteen-entry diff that nobody reads carefully — regeneration
  // is non-deterministic enough at temperature 0 that wording shifts across
  // the whole file, and a reviewer skimming noise is how a bad recording gets
  // committed. With no filter it re-records everything, which is the
  // deliberate act.
  const filter = process.argv[2];
  const queries = content
    .map((entry) => entry.query)
    .filter((query) => !filter || query === filter);

  if (queries.length === 0) {
    throw new Error(
      `no seeded query matches "${filter}". Known queries:\n  ` +
        content.map((entry) => entry.query).join('\n  '),
    );
  }

  const llm = createGeminiClient({
    fetch: globalThis.fetch,
    baseUrl: gemini.baseUrl,
    apiKey: gemini.apiKey,
    model: gemini.model,
    timeoutMs: TIMEOUT_MS,
  });

  // Sequential: sixteen calls at a few seconds each, against a modest quota.
  // A burst that trips a per-minute limit would poison the recording with a
  // 429 rather than merely slowing it down.
  const next: Record<string, LlmTranslation> = { ...recorded };
  for (const query of queries) {
    const answer = await askModel(llm, { text: query });
    next[query] = { kind: answer.kind, entries: answer.entries };
    const shape = answer.entries
      .map((entry) => `${entry.lemma}(${entry.senses.length})`)
      .join(' ');
    console.log(`  ${query} -> ${answer.kind} ${shape || '(no entries)'}`);
  }

  writeFileSync(OUTPUT, `${HEADER}${JSON.stringify(next, null, 2)};\n`);
  console.log(`\nrecorded ${queries.length} of ${content.length} into ${OUTPUT}`);
  console.log('Read the diff before committing.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 4: Wire the script**

In `apps/server/package.json`, beside `"eval"`:

```json
    "content:generate": "tsx tests/eval/generate-content.ts",
```

In the root `package.json`, beside `"eval"`:

```json
    "content:generate": "npm run content:generate --workspace apps/server",
```

- [ ] **Step 5: Check it refuses to run against MockServer**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
GEMINI_BASE_URL=http://localhost:1080/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev \
  npm run content:generate
```

Expected: exits non-zero with `GEMINI_BASE_URL points at …`. This is the one guard that can
be verified without spending anything.

- [ ] **Step 6: Record all sixteen strings**

```bash
GEMINI_API_KEY=<real key> GEMINI_MODEL=gemini-2.5-flash npm run content:generate
```

Expected: sixteen lines of `query -> kind lemma(n)`, then the output path. Roughly a
minute and a half.

- [ ] **Step 7: Review the diff, which is the point of the whole mechanism**

```bash
git diff apps/server/src/db/content.generated.ts | head -200
```

Read it against this checklist. A recording that fails any of these is re-recorded (with
`-- <query>`) or, if the model keeps getting it wrong, is a prompt problem — fix the
prompt, do not hand-edit the file:

- All sixteen queries are present as keys.
- Every entry has a plausible `lemma`. `to remember` must resolve to `remember`, not to
  `to remember`.
- `book` carries **one** entry with at least two senses, including `ספר` and a booking
  sense. This is success criterion 4 and the reason `book` is the prompt's worked example.
- Each first sense's translation is a sensible Hebrew answer, and — for each of the
  sixteen — is **not** one of that entry's three `distractors` in `db/content.ts`. The
  test added in Task 11 enforces this; catching it here saves a round trip.
- Every sense has a snake_case `sense_code`, a `part_of_speech`, and an `example` with
  both halves — except for anything the model classified `sentence`.
- The Hebrew reads naturally. This is the human half of "a model wrote them; a human
  reviewed them".

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck && npm test && npm run lint:arch
```

Expected: clean. `lint:arch` still reports 17 rules; `tests/eval/` is already exempt from
R11, and `generate-content.ts` is not a `*.test.ts`, so ADR 0004 R4's `find` and its
`grep -rn "tests/eval" apps/server/src` both stay silent — the recorder imports `src/`,
never the reverse.

```bash
git add apps/server/src/db/content.ts apps/server/src/db/content.generated.ts \
        apps/server/tests/eval/generate-content.ts package.json apps/server/package.json
git commit -m "feat: record real provider answers for the seeded strings

npm run content:generate takes an optional query filter and merges rather than
replaces, so re-recording one string leaves the other fifteen untouched."
```

---

### Task 11: The seed becomes a recording

`seedContent` stops writing rows itself and calls `persistEntries`, the same repository
function the translation service calls, once per query. Idempotence comes for free.

`db/seed.ts` importing `repo/vocabulary.ts` is a sideways import R4's "may import" list
does not currently mention — Task 13 fixes the prose. It reaches the transaction through
`createTransaction`, **not** `db.transaction(...)`, because R8's detection command greps
for the literal `.transaction(` and allows exactly one call site.

**Files:**
- Modify: `apps/server/src/db/content.ts`
- Modify: `apps/server/src/db/seed.ts`
- Test: `apps/server/src/db/content.test.ts`
- Test: `apps/server/tests/integration/db/seed.test.ts`
- Test: `apps/server/tests/integration/repo/questions.test.ts`
- Test: `apps/server/tests/integration/routes/translations.test.ts`

**Interfaces:**
- Consumes: `recorded` (Task 10), `persistEntries` (Task 6), `createTransaction`
  (existing).
- Produces, from `apps/server/src/db/content.ts`:
  - `type ContentEntry = { query: string; question_id: string; distractors: [string, string, string]; correct_option: number }`
  - `correctAnswerFor(entry: ContentEntry): string`
  - `optionsFor(entry: ContentEntry): QuestionOption[]`

- [ ] **Step 1: Write the failing content tests**

Replace `apps/server/src/db/content.test.ts` entirely:

```ts
import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { normalizeForm } from '../domain/vocabulary';
import { content, correctAnswerFor, optionsFor } from './content';
import { recorded } from './content.generated';

const LONG_PROMPT_LENGTH = 15;

describe('content', () => {
  it('holds more questions than one session needs, so repeat sessions vary', () => {
    expect(content.length).toBeGreaterThan(SESSION_LENGTH);
  });

  it('gives every question and every query a unique id', () => {
    expect(new Set(content.map((entry) => entry.question_id)).size).toBe(content.length);
    expect(new Set(content.map((entry) => entry.query)).size).toBe(content.length);
  });

  it('has a recording for every query', () => {
    for (const entry of content) {
      expect(recorded[entry.query]).toBeDefined();
    }
  });

  it('has at least one entry with at least one sense in every recording', () => {
    for (const entry of content) {
      const answer = recorded[entry.query];
      expect(answer.entries.length).toBeGreaterThanOrEqual(1);
      expect(answer.entries[0].senses.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every question three distinct distractors and an in-range correct option', () => {
    for (const entry of content) {
      expect(entry.distractors).toHaveLength(3);
      expect(new Set(entry.distractors).size).toBe(3);
      expect(entry.correct_option).toBeGreaterThanOrEqual(0);
      expect(entry.correct_option).toBeLessThanOrEqual(3);
    }
  });

  it('splices the recorded translation in, so the quiz cannot drift from the dictionary', () => {
    for (const entry of content) {
      const options = optionsFor(entry);
      expect(options).toHaveLength(4);
      expect(options[entry.correct_option].text).toBe(correctAnswerFor(entry));
      expect(options.filter((option) => option.is_correct)).toHaveLength(1);
      expect(options.map((option) => option.position)).toEqual([0, 1, 2, 3]);
    }
  });

  it('keeps the spliced answer distinct from every distractor', () => {
    // The guard on re-recording: a regeneration that turns ספר into a string a
    // distractor already holds fails the build rather than shipping an
    // ambiguous quiz question.
    for (const entry of content) {
      expect(entry.distractors).not.toContain(correctAnswerFor(entry));
      expect(new Set(optionsFor(entry).map((option) => option.text)).size).toBe(4);
    }
  });

  it('authors every query already normalized, since the seed stores it verbatim', () => {
    for (const entry of content) {
      expect(normalizeForm(entry.query)).toBe(entry.query);
    }
  });

  it('keeps the entry-0 lemmas distinct, so no two questions share a headword', () => {
    // A question points at its query's entry 0, sense 0. Two queries resolving
    // to one lemma would make the second question's correct option belong to
    // the first one's term, since senses are first-writer-wins.
    const lemmas = content.map((entry) => recorded[entry.query].entries[0].lemma);
    expect(new Set(lemmas).size).toBe(content.length);
  });

  it('includes enough long prompts to exercise text wrapping', () => {
    const long = content.filter((entry) => entry.query.length >= LONG_PROMPT_LENGTH);
    expect(long.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm test -w apps/server -- db/content
```

Expected: FAIL — `correctAnswerFor` and `optionsFor` are not exported, and `distractors`
does not exist.

- [ ] **Step 3: Rewrite `apps/server/src/db/content.ts`**

```ts
// Authoring source for the shared content the seed inserts, split by who
// writes it: the quiz is authored here by hand, the answers are recorded into
// ./content.generated.ts by `npm run content:generate`.
//
// Not runtime data: nothing reads this at request time — `repo/questions.ts`
// reads the database.

import type { QuestionOption } from './schema';
import { recorded } from './content.generated';

export type ContentEntry = {
  /** What a learner would type. The recorder's input, the variant's form,
   *  and the quiz prompt — one string doing all three, honestly. */
  query: string;
  question_id: string;
  /** Three wrong answers. The right one is the recorded sense's translation,
   *  spliced in at `correct_option`, so the two can never drift apart. */
  distractors: [string, string, string];
  correct_option: number;
};

/**
 * The right answer, derived rather than authored. It used to be a fourth
 * literal in `options`, duplicating the translation; splicing it in from the
 * recording removes the duplicate and the drift it invites — a regeneration
 * that changes ספר cannot leave a quiz asking for a word the dictionary no
 * longer holds.
 *
 * The question tests entry 0, sense 0 of its query's recording. Nothing selects
 * a different one today, and a field for it would be a guess about a need
 * nobody has.
 */
export function correctAnswerFor(entry: ContentEntry): string {
  const sense = recorded[entry.query]?.entries[0]?.senses[0];
  if (!sense) {
    throw new Error(
      `no recording for "${entry.query}". Run \`npm run content:generate -- ${entry.query}\`.`,
    );
  }
  return sense.translation;
}

export function optionsFor(entry: ContentEntry): QuestionOption[] {
  const texts: string[] = [...entry.distractors];
  texts.splice(entry.correct_option, 0, correctAnswerFor(entry));
  return texts.map((text, position) => ({
    position,
    text,
    is_correct: position === entry.correct_option,
  }));
}

export const content: ContentEntry[] = [
  { query: 'window', question_id: 'q-window', distractors: ['דלת', 'שולחן', 'קיר'], correct_option: 1 },
  { query: 'book', question_id: 'q-book', distractors: ['עיפרון', 'מחשב', 'כיסא'], correct_option: 0 },
  { query: 'water', question_id: 'q-water', distractors: ['לחם', 'חלב', 'קפה'], correct_option: 2 },
  { query: 'friend', question_id: 'q-friend', distractors: ['שכן', 'מורה', 'רופא'], correct_option: 3 },
  { query: 'difficult', question_id: 'q-difficult', distractors: ['קל', 'חשוב', 'מהיר'], correct_option: 1 },
  { query: 'to remember', question_id: 'q-remember', distractors: ['לשכוח', 'ללמוד', 'לחשוב'], correct_option: 1 },
  { query: 'excuse me', question_id: 'q-excuse-me', distractors: ['שלום', 'תודה', 'בבקשה'], correct_option: 2 },
  { query: 'good morning', question_id: 'q-good-morning', distractors: ['לילה טוב', 'ערב טוב', 'שבוע טוב'], correct_option: 1 },
  { query: 'thank you very much', question_id: 'q-thank-you-very-much', distractors: ['בבקשה רבה', 'סליחה רבה', 'שלום רב'], correct_option: 0 },
  { query: 'How do you do?', question_id: 'q-how-do-you-do', distractors: ['מה השעה?', 'מה קרה?', 'מה זה?'], correct_option: 1 },
  { query: 'see you later', question_id: 'q-see-you-later', distractors: ['נתראה מחר', 'ניפגש בבוקר', 'נדבר בהמשך'], correct_option: 1 },
  { query: "I don't understand", question_id: 'q-i-dont-understand', distractors: ['אני לא יודע', 'אני לא שומע', 'אני לא זוכר'], correct_option: 2 },
  { query: 'What is your name?', question_id: 'q-what-is-your-name', distractors: ['מאיפה אתה?', 'בן כמה אתה?', 'מה אתה עושה?'], correct_option: 1 },
  { query: 'Have a nice day!', question_id: 'q-have-a-nice-day', distractors: ['שיהיה לך בוקר טוב!', 'שיהיה לך שבוע טוב!', 'שיהיה לך לילה טוב!'], correct_option: 0 },
  { query: 'Where is the station?', question_id: 'q-where-is-the-station', distractors: ['איפה הבית?', 'איפה השוק?', 'איפה הרחוב?'], correct_option: 2 },
  { query: 'Nice to meet you', question_id: 'q-nice-to-meet-you', distractors: ['טוב לראות אותך', 'נתראה בקרוב', 'תודה שבאת'], correct_option: 0 },
];
```

`import type { QuestionOption }` is load-bearing: `schema.ts` imports `drizzle-orm` at
runtime, and `db/content.test.ts` is in the unit bucket. A value import here would pull
Drizzle into it, which ADR 0004 R1 and R2 exist to prevent.

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test -w apps/server -- db/content
```

Expected: PASS. A failure of *keeps the spliced answer distinct from every distractor* or
*keeps the entry-0 lemmas distinct* is a recording problem: re-record that one query with
`npm run content:generate -- <query>`, or adjust that entry's distractors if the model's
answer is right and the authored distractor is the collision.

- [ ] **Step 5: Write the failing seed test**

Replace `apps/server/tests/integration/db/seed.test.ts` entirely:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { content, correctAnswerFor, optionsFor } from '../../../src/db/content';
import { recorded } from '../../../src/db/content.generated';
import { questions, termVariants, vocabTerms, vocabTermSenses } from '../../../src/db/schema';
import { flattenEntries, mergeEntries, rowsToSenses } from '../../../src/domain/vocabulary';
import { seedContent } from '../../../src/db/seed';
import { createVocabRepo } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

// The template already ran seedContent via globalSetup, so a clone arrives
// seeded. That is exactly what the rest of the suite depends on.
describe('seedContent', () => {
  it('leaves every recorded string servable, as exactly the merge persistEntries produces', async () => {
    // This is where "the seed is a recording" is actually verified: the rows
    // the seed produced are the rows persistEntries produces, rather than a
    // shape authored twice.
    await withTx(t.db, async (tx) => {
      const vocab = createVocabRepo(tx);
      for (const entry of content) {
        const rows = await vocab.findSensesByForm({
          form: entry.query,
          languageCode: 'en',
          userLanguageCode: 'he',
        });
        expect(rowsToSenses(rows)).toEqual(
          flattenEntries(mergeEntries(recorded[entry.query].entries)),
        );
      }
    });
  });

  it('writes one question per content entry, and one term per distinct lemma', async () => {
    expect(await t.db.select().from(questions)).toHaveLength(content.length);

    const lemmas = new Set(
      content.flatMap((entry) => recorded[entry.query].entries.map((e) => e.lemma)),
    );
    expect(await t.db.select().from(vocabTerms)).toHaveLength(lemmas.size);
  });

  it('gives every variant its language and its entry rank', async () => {
    for (const variant of await t.db.select().from(termVariants)) {
      expect(variant.languageCode).toBe('en');
      expect(variant.entryRank).toBeGreaterThanOrEqual(0);
      expect(['word', 'phrase', 'sentence']).toContain(variant.kind);
    }
  });

  it('ranks every sense from zero and keeps the recorded part of speech and example', async () => {
    const [entry] = content;
    const [term] = await t.db
      .select()
      .from(vocabTerms)
      .where(eq(vocabTerms.lemma, recorded[entry.query].entries[0].lemma));
    const senses = await t.db
      .select()
      .from(vocabTermSenses)
      .where(eq(vocabTermSenses.termId, term.id));

    const recordedSenses = recorded[entry.query].entries[0].senses;
    expect(senses.map((sense) => sense.rank).sort()).toEqual(
      recordedSenses.map((_, rank) => rank),
    );
    const first = senses.find((sense) => sense.rank === 0)!;
    expect(first.senseCode).toBe(recordedSenses[0].sense_code);
    expect(first.partOfSpeech).toBe(recordedSenses[0].part_of_speech ?? null);
    expect(first.exampleSource).toBe(recordedSenses[0].example?.source ?? null);
  });

  it('points every question at the sense and variant its own recording wrote', async () => {
    for (const entry of content) {
      const [question] = await t.db
        .select()
        .from(questions)
        .where(eq(questions.id, entry.question_id));
      const [variant] = await t.db
        .select()
        .from(termVariants)
        .where(eq(termVariants.id, question.promptVariantId));
      const [sense] = await t.db
        .select()
        .from(vocabTermSenses)
        .where(eq(vocabTermSenses.id, question.senseId));

      expect(variant.form).toBe(entry.query);
      expect(sense.termId).toBe(variant.termId);
      expect(sense.rank).toBe(0);
    }
  });

  it('makes the correct option the recorded sense translation', async () => {
    for (const entry of content) {
      const [question] = await t.db
        .select()
        .from(questions)
        .where(eq(questions.id, entry.question_id));
      expect(question.options).toEqual(optionsFor(entry));
      expect(question.options.find((option) => option.is_correct)!.text).toBe(
        correctAnswerFor(entry),
      );
    }
  });

  it('marks every seeded question shared and Hebrew/English', async () => {
    for (const row of await t.db.select().from(questions)) {
      expect(row.userId).toBeNull();
      expect(row.targetLanguage).toBe('en');
      expect(row.userLanguageCode).toBe('he');
      expect(row.type).toBe('multiple_choice');
    }
  });

  it('is idempotent — a second run inserts nothing', async () => {
    const before = {
      terms: (await t.db.select().from(vocabTerms)).length,
      variants: (await t.db.select().from(termVariants)).length,
      senses: (await t.db.select().from(vocabTermSenses)).length,
      questions: (await t.db.select().from(questions)).length,
    };

    await seedContent(t.db);

    expect({
      terms: (await t.db.select().from(vocabTerms)).length,
      variants: (await t.db.select().from(termVariants)).length,
      senses: (await t.db.select().from(vocabTermSenses)).length,
      questions: (await t.db.select().from(questions)).length,
    }).toEqual(before);
  });

  it("stores to remember as the queried form, under the lemma the model gave it", async () => {
    const [variant] = await t.db
      .select()
      .from(termVariants)
      .where(eq(termVariants.form, 'to remember'));
    const [term] = await t.db.select().from(vocabTerms).where(eq(vocabTerms.id, variant.termId));

    expect(term.lemma).toBe(recorded['to remember'].entries[0].lemma);
    expect(term.lemma).not.toBe('to remember');
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

```bash
npm run test:integration -w apps/server -- db/seed
```

Expected: FAIL — the seed still writes its own rows, so `language_code`/`entry_rank` are
right but the terms, senses and options come from the old authored fields rather than from
the recording.

- [ ] **Step 7: Rewrite `apps/server/src/db/seed.ts`**

```ts
import type { Db } from './client';
import { content, optionsFor } from './content';
import { recorded } from './content.generated';
import { questions } from './schema';
import { createTransaction } from './transaction';
import { createVocabRepo } from '../repo/vocabulary';

const TARGET_LANGUAGE = 'en';
const USER_LANGUAGE = 'he';

/**
 * Replays the recorded provider answers through `persistEntries` — the same
 * repository function the translation service calls — and hangs one shared
 * question off each. Seeded rows and looked-up rows are then indistinguishable,
 * because they were made the same way, which is why nothing in this phase has
 * to ask which kind a row is.
 *
 * Idempotent for free: `persistEntries` is ON CONFLICT DO NOTHING on terms and
 * variants and first-writer-wins on senses, so a second run writes nothing.
 * That is also why re-recording has to be paired with clearing what is there —
 * see `db/reseed.ts`.
 *
 * The transaction comes from `createTransaction`, not `db.transaction(...)`:
 * ADR 0001 R8 gives that primitive exactly one call site, in db/transaction.ts.
 * Reaching `repo/` from here is the sideways import R4 allows within the
 * persistence layer.
 */
export async function seedContent(db: Db): Promise<void> {
  if (content.length === 0) return;

  const inTransaction = createTransaction(db, (tx) => tx);

  await inTransaction(async (tx) => {
    const vocab = createVocabRepo(tx);
    const rows = [];

    for (const entry of content) {
      const answer = recorded[entry.query];
      if (!answer || answer.entries.length === 0) {
        throw new Error(
          `no recording for "${entry.query}". Run \`npm run content:generate -- ${entry.query}\`.`,
        );
      }

      const { written } = await vocab.persistEntries({
        form: entry.query,
        languageCode: TARGET_LANGUAGE,
        userLanguageCode: USER_LANGUAGE,
        kind: answer.kind,
        entries: answer.entries,
      });

      // The question tests entry 0, sense 0 — the ids persistEntries just
      // reported, rather than ids this file invented.
      rows.push({
        id: entry.question_id,
        userId: null,
        senseId: written[0].senseIds[0],
        promptVariantId: written[0].variantId,
        targetLanguage: TARGET_LANGUAGE,
        userLanguageCode: USER_LANGUAGE,
        type: 'multiple_choice',
        options: optionsFor(entry),
      });
    }

    await tx.insert(questions).values(rows).onConflictDoNothing();
  });
}
```

- [ ] **Step 8: Run it to verify it passes**

```bash
npm run test:integration -w apps/server -- db/seed
```

Expected: PASS. The per-worker templates are rebuilt by `globalSetup` on every
integration run, so the new seed is exercised from scratch.

- [ ] **Step 9: Fix the two assertions that assumed authored ids**

In `apps/server/tests/integration/repo/questions.test.ts`, add
`import { content, optionsFor } from '../../../src/db/content';` (replacing the plain
`content` import) and replace two tests:

```ts
  it('returns options in canonical order with correct_option pointing at the right one', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u_1');
      const entry = content.find((row) => row.question_id === 'q-window')!;
      const question = pool.find((q) => q.id === 'q-window')!;
      expect(question.options).toEqual(optionsFor(entry).map((option) => option.text));
      expect(question.correct_option).toBe(entry.correct_option);
    });
  });

  it('exposes the vocabulary term id, which the database issues', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u_1');
      // Server-issued since phase 10 — no layer generates randomness, so the
      // authored `vt-en-window` is gone.
      expect(pool.find((q) => q.id === 'q-window')!.vocab_term_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });
```

- [ ] **Step 10: Prove a seeded string answers with no provider request**

Append to `apps/server/tests/integration/routes/translations.test.ts`:

```ts
  it('answers a recorded string from the seed, with no provider request at all', async () => {
    // No expectation is registered: this namespace has nothing to answer with,
    // so a 200 here can only have come from Postgres. `book` is the phase's
    // worked example — one entry, both ספר and a booking sense — so `more`
    // works from the seed exactly as it works from the model.
    const res = await translate({ text: 'book' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      senses: { translation: string; part_of_speech?: string; example?: unknown }[];
    };
    expect(body.kind).toBe('word');
    expect(body.senses[0].translation).toBe('ספר');
    expect(body.senses.length).toBeGreaterThanOrEqual(2);
    expect(body.senses[0].part_of_speech).toBeDefined();
    expect(body.senses[0].example).toBeDefined();
    expect(await countGeminiRequests(ns)).toBe(0);
  });
```

This file may not import `src/db/` (ADR 0001 R1's test command), which is why `ספר` is
written out here rather than read from the recording.

- [ ] **Step 11: Run everything**

```bash
npm test && npm run test:integration && npm run typecheck && npm run lint:arch && npm run e2e
```

Expected: all clean, 17 rules. In particular R4's `grep` over `src/db/` must stay silent —
`db/seed.ts` imports `repo/`, which is sideways, and the command only looks upward.

- [ ] **Step 12: Commit**

```bash
git add apps/server/src/db apps/server/tests
git commit -m "feat(db): the seed replays a recording through persistEntries

Seeded rows and looked-up rows are made the same way, so nothing in this phase
has to ask which kind a row is. The quiz's correct option is spliced in from
the recording rather than authored twice."
```

---

### Task 12: `npm run db:reseed` — what makes re-recording a supported operation

`persistEntries` is first-writer-wins, so running the seed against a database that already
holds a fixture writes **nothing**. Re-recording therefore has to be paired with clearing
what is there. Without this command a re-recorded `content.generated.ts` would silently
never reach any existing database.

**It drops looked-up words too, not only recorded ones.** The design deliberately cannot
tell them apart, so "re-record one word" is really "reset the dictionary and re-record".
The loss is provider calls rather than data, since the dictionary is a cache. It also
drops play-test session history.

It runs through the existing `db/cli.ts` rather than a new entry point: ADR 0002 names
three composition roots, and a fourth would mean an ADR edit for a five-line command.

**Files:**
- Create: `apps/server/src/db/reseed.ts`
- Modify: `apps/server/src/db/cli.ts`
- Modify: `package.json`, `apps/server/package.json`
- Create: `apps/server/tests/integration/db/reseed.test.ts`

**Interfaces:**
- Consumes: `seedContent` (Task 11).
- Produces: `reseedContent(db: Db): Promise<void>` in `apps/server/src/db/reseed.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/integration/db/reseed.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { content } from '../../../src/db/content';
import { reseedContent } from '../../../src/db/reseed';
import { seedContent } from '../../../src/db/seed';
import {
  termSenseTranslations,
  termVariants,
  users,
  vocabTerms,
} from '../../../src/db/schema';
import { createVocabRepo } from '../../../src/repo/vocabulary';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

/** A word a learner looked up, written the way a lookup writes it. */
async function lookUp(form: string, lemma: string, translation: string): Promise<void> {
  await withTx(t.db, (tx) =>
    createVocabRepo(tx).persistEntries({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
      entries: [{ lemma, senses: [{ translation, sense_code: 'only' }] }],
    }),
  );
}

describe('reseedContent', () => {
  it('leaves exactly the recording: the looked-up word is gone, users survive', async () => {
    await seedUser(t.db, 'u_keep');
    await lookUp('ladder', 'ladder', 'סולם');
    expect(await t.db.select().from(vocabTerms).where(eq(vocabTerms.lemma, 'ladder'))).toHaveLength(1);

    await reseedContent(t.db);

    expect(await t.db.select().from(vocabTerms).where(eq(vocabTerms.lemma, 'ladder'))).toHaveLength(0);
    expect(await t.db.select().from(termVariants).where(eq(termVariants.form, 'ladder'))).toHaveLength(0);
    // Every recorded string is back, and servable.
    for (const entry of content) {
      const rows = await withTx(t.db, (tx) =>
        createVocabRepo(tx).findSensesByForm({
          form: entry.query,
          languageCode: 'en',
          userLanguageCode: 'he',
        }),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }
    expect(await t.db.select().from(users).where(eq(users.id, 'u_keep'))).toHaveLength(1);
  });

  it('is what a bare re-seed cannot do: take a changed recording', async () => {
    // Stand in for a re-recording by changing what is stored. seedContent is
    // first-writer-wins, so it leaves the change in place; reseedContent is the
    // only thing that puts the recording back.
    const [question] = content;
    const rows = await withTx(t.db, (tx) =>
      createVocabRepo(tx).findSensesByForm({
        form: question.query,
        languageCode: 'en',
        userLanguageCode: 'he',
      }),
    );
    const original = rows[0].translation;
    await t.db
      .update(termSenseTranslations)
      .set({ translation: 'משהו שגוי' })
      .where(eq(termSenseTranslations.translation, original));

    await seedContent(t.db);
    const afterSeed = await withTx(t.db, (tx) =>
      createVocabRepo(tx).findSensesByForm({
        form: question.query,
        languageCode: 'en',
        userLanguageCode: 'he',
      }),
    );
    expect(afterSeed[0].translation).toBe('משהו שגוי');

    await reseedContent(t.db);
    const afterReseed = await withTx(t.db, (tx) =>
      createVocabRepo(tx).findSensesByForm({
        form: question.query,
        languageCode: 'en',
        userLanguageCode: 'he',
      }),
    );
    expect(afterReseed[0].translation).toBe(original);
  });

  it('is idempotent, so running it twice is not a way to lose the fixture', async () => {
    await reseedContent(t.db);
    const first = await t.db.select().from(vocabTerms);
    await reseedContent(t.db);
    expect(await t.db.select().from(vocabTerms)).toHaveLength(first.length);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration -w apps/server -- db/reseed
```

Expected: FAIL — `Cannot find module '../../../src/db/reseed'`.

- [ ] **Step 3: Write `apps/server/src/db/reseed.ts`**

```ts
import { sql } from 'drizzle-orm';

import type { Db } from './client';
import { seedContent } from './seed';

/**
 * Clears the dictionary and the quiz, then replays the recording.
 *
 * This exists because `persistEntries` is first-writer-wins: running the seed
 * against a database that already holds a fixture writes nothing, so a
 * re-recorded content.generated.ts would silently never reach it. This is what
 * makes re-recording a supported operation rather than an improvised
 * `docker compose down -v`.
 *
 * **It drops looked-up words too**, not only recorded ones — the design
 * deliberately cannot tell them apart, which is precisely what let the `source`
 * column and everything built on it be deleted. The loss is provider calls
 * rather than data, since the dictionary is a cache; the other cost is
 * play-test session history.
 *
 * CASCADE from vocab_terms reaches term_variants, vocab_term_senses,
 * term_sense_translations, questions, session_questions and answers. `sessions`
 * is named explicitly because nothing references it, so nothing would cascade
 * to it, and a session whose questions had vanished would be broken rather than
 * absent. `users` is untouched.
 *
 * The statement is written here and again in migration 0003 rather than shared
 * from one place: that migration is frozen history, this command is live.
 */
export async function reseedContent(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE vocab_terms, sessions CASCADE`);
  await seedContent(db);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm run test:integration -w apps/server -- db/reseed
```

Expected: PASS.

- [ ] **Step 5: Add the `--reseed` flag to the CLI**

In `apps/server/src/db/cli.ts`, add `import { reseedContent } from './reseed';` and
replace the body of the `try` block:

```ts
  // A flag rather than a second entry point: ADR 0002 names three composition
  // roots, and a fourth for a five-line command would be an ADR edit paying
  // for nothing. `process.argv` is not `process.env`, and this file is a
  // composition root either way.
  const reseed = process.argv.includes('--reseed');
  try {
    await runMigrations(db);
    if (reseed) {
      await reseedContent(db);
      console.log(`migrated and RESEEDED ${databaseUrl} — the dictionary was cleared first,`);
      console.log('so every looked-up word is gone as well as every recorded one.');
    } else {
      await seedContent(db);
      console.log(`migrated and seeded ${databaseUrl}`);
    }
  } finally {
    await close();
  }
```

- [ ] **Step 6: Wire the script**

In `apps/server/package.json`, beside `"db:migrate"`:

```json
    "db:reseed": "tsx src/db/cli.ts --reseed",
```

In the root `package.json`, beside `"db:migrate"`:

```json
    "db:reseed": "npm run db:reseed --workspace apps/server",
```

- [ ] **Step 7: Run it against the local development database**

```bash
npm run db:migrate && npm run db:reseed
```

Expected: the first prints `migrated and seeded …`; the second prints the RESEEDED lines
and its warning. Neither errors. (Requires Postgres on 5432 — reuse the running container,
never `npm run db:up` from a worktree.)

- [ ] **Step 8: Run everything and commit**

```bash
npm test && npm run test:integration && npm run typecheck && npm run lint:arch
```

Expected: all clean.

```bash
git add apps/server/src/db apps/server/tests/integration/db/reseed.test.ts \
        package.json apps/server/package.json
git commit -m "feat(db): npm run db:reseed, so a re-recording can reach a database

Clear and replay. It drops looked-up words as well as recorded ones, because
nothing distinguishes them — which is the same property that deleted the
source column."
```

---

### Task 13: The ADRs and the README catch up with the code

No new ADR, no new detection command, and no new check script. Nothing this phase adds is
expressible as a regex, so `scripts/check-adr-0001-layered-architecture.sh` stays at
seventeen checks and there is **no planted-violation step to run**. That is stated rather
than left silent: phase 9 established that a check must be shown to fail before it is
trusted, and the counterpart is that a phase adding none says so.

**Files:**
- Modify: `docs/adr/adr-0001-layered-architecture.md`
- Modify: `docs/adr/adr-0002-di-with-closures.md`
- Modify: `docs/adr/adr-0004-test-topology.md`
- Modify: `README.md`

- [ ] **Step 1: ADR 0001 — R4 gains `repo/*` for `db/`**

Change the header's date line to end with `; R4/R8 revised 2026-09-09 (phase 10)`.

In the rules table, change R4's "May import" cell to:

```
| R4 | `repo/` + `db/` | `drizzle-orm`, `pg`, `db/*`, **`repo/*`**, domain **types** | `routes/`, `services/`, `app.ts`, `composition.ts` |
```

and add a paragraph under the table, beside the existing R2 explanation:

```markdown
R4's diagram draws `repo/` and `db/` as **one** layer in one box under one rule, but its
"may import" list originally omitted the sibling — so `db/seed.ts` calling
`persistEntries` was uncovered prose rather than a violation, since the detection grep
only looks upward. Phase 10 added `repo/*` to the list, which makes the prose match the
diagram rather than granting anything new. No detection command changed, because the rule
that matters — *persistence must not reach upward* — is unaffected.
```

- [ ] **Step 2: ADR 0001 — R8's second amendment**

Replace the R8 bullet's qualifier paragraph (the one beginning "The qualifier matters as
of phase 9") with:

```markdown
  **Amended twice.** Phase 9 added *"that touches the database"*, because
  `services/translations.ts` was a use case with **zero** transactions. Phase 10 made that
  same use case have **two**: normalize, read, call the provider for one to three seconds,
  write, respond. The rule now reads: *a use case opens at most one **write** transaction;
  a read preceding third-party I/O may be its own.*

  Holding one transaction open across the provider call was rejected outright: ten seconds
  of an idle pooled connection per lookup, one per concurrent learner. Two short
  transactions with the call between them hold nothing and race harmlessly, because the
  write is idempotent against `UNIQUE(language_code, lemma)` and `UNIQUE(term_id, form)`.

  R8's detection command greps for `\.transaction(` — the mechanism, `db.transaction(`,
  which still has exactly one call site. The "how many per use case" half was never
  machine-checked and is not now. `db/seed.ts` reaches a transaction through
  `createTransaction` for exactly this reason.

  **A read-only `Query` seam is the alternative, recorded rather than taken.**
  `createQuery(db, bind)` beside `createTransaction`, bound to a read-only projection of
  the repositories, would keep this wording untouched and make "one write transaction per
  use case" a type-level guarantee rather than prose — the way `Transaction` already makes
  it impossible for a service to hold a `Db` — and would save a `BEGIN`/`COMMIT` round trip
  on a cache hit. Declined for simplicity while one use case needs it: a new type, factory,
  bind and read-only projection, plus a decision about `login`, a pure read that opens a
  transaction today. **Revisit it for the performance gain**, or the second time a use case
  wants a read outside its write.
```

- [ ] **Step 3: ADR 0002 — R6's factory list**

In R6's bullet, add `createVocabRepo` to the parenthesised list, after `createUserRepo`.

- [ ] **Step 4: ADR 0004 — R4's eval-bucket clause names the recorder**

Replace the sentence introducing the third bucket with:

```markdown
`apps/server/tests/eval/` is the third bucket: the opt-in real-model code. Two things live
there — `npm run eval`, which scores the prompt, and `npm run content:generate`, the
recorder that produces `src/db/content.generated.ts`. The bucket is defined by *calling a
real language model*, which describes both; the recorder is not an eval and is not scored,
it shares the bucket because it shares the provider client, and putting it in `scripts/`
instead would have meant a third exemption in [ADR 0001](adr-0001-layered-architecture.md)
R11's grep, whose whole value is being short.
```

and extend the paragraph beginning "Nothing in it is named `*.test.ts`" to name
`askModel.ts` and `generate-content.ts` alongside `run.ts` and `cases.ts`. Its two existing
checks are unchanged: neither new file is a `*.test.ts`, and neither is imported by `src/`.

Two more one-line accuracy fixes in the same table, neither of which changes a check:

- R2's "may import" cell reads `src/db/content.ts` (pure data). Make it
  `src/db/content.ts` and `src/db/content.generated.ts` (pure data) — `content.ts` now
  imports the recording, and `db/content.test.ts` reads both. Both stay free of a
  connection; the `import type { QuestionOption }` in `content.ts` is what keeps Drizzle
  out of the unit bucket.
- R2's "must not import" list stays `client`, `migrate`, `seed`, `cli`. `db/reseed.ts` is
  deliberately **not** added: the rule's grep is the enforcement and this phase adds no
  check, and reseed.ts opens no connection — it takes a `Db`. Add a parenthetical saying
  so, so its absence reads as a decision rather than an oversight.

- [ ] **Step 5: README — the phase paragraph and the index**

After the phase 9 paragraph, add:

```markdown
Phase 10 makes that dictionary real. A translation the model answers is written to
Postgres, and the next lookup of that string — by anyone — is served without reaching the
provider. The model is now asked for *entries*, one per headword, so typing `saw` returns
the verb `see` and the noun `saw` in one answer and writes both. The dictionary is shared
and records no learner: there is no `user_id` anywhere near it, so "my words" is not what
this builds — the second learner to ask a word benefits from the first. Nothing on the
wire changed, and `apps/mobile` has no changed file.
```

and to the list:

```markdown
- Phase 10: [design](docs/superpowers/specs/2026-09-09-lang-tutor-phase-10-vocabulary-persistence-design.md) · [plan](docs/superpowers/plans/2026-09-10-lang-tutor-phase-10-vocabulary-persistence.md)
```

- [ ] **Step 6: README — the data model**

In the *Data model* table, replace the three vocabulary rows and add the sentences after
it:

```markdown
| `vocab_terms` | A lemma in a language (e.g. English "run"), unique per `(language_code, lemma)`. The id is issued by the database. |
| `term_variants` | A surface form somebody actually queried — `run`, `running`, `saw` — with the language it is in and `entry_rank`, this term's position among the readings the model returned *for that form*. `UNIQUE(language_code, lower(form), entry_rank)` is both the lookup index and the guarantee that no two terms claim one reading. |
| `vocab_term_senses` | A distinct meaning of a term, with its `part_of_speech`, its source-language `example_source`, and `rank` — "most common first", within that term. |
| `term_sense_translations` | A sense's translation into a learner's native language, with the target half of the example, one row per `(sense, user_language_code)`. |
```

and replace the paragraph beginning "The vocabulary and sense tables are shared content,
seeded once and never written to at request time" with:

```markdown
Since phase 10 the vocabulary tables **are** written at request time: `POST
/api/translations` writes every entry the model returned, and the next lookup of that
string is served from Postgres. The dictionary is shared and records no learner — there is
no `user_id` near these tables — so a save enriches the global dictionary rather than
anybody's word list. It is first-writer-wins and permanent: a term that has senses is never
rewritten, there is no TTL, and the only supported way to change stored content is
`npm run db:reseed`.

Two ranks, two scopes, and they are not the same number. `vocab_term_senses.rank` orders
senses *within one headword*; `term_variants.entry_rank` orders headwords *within one
form*. A lookup sorts by rank first, so a form belonging to two headwords returns them
interleaved and neither one's top sense is crowded out.

`questions` is split down the middle by `user_id`: **`user_id IS NULL` means the question
is shared** — part of the common pool every learner can be given — while a non-null
`user_id` would mean a question generated for that learner alone. Nothing writes a
per-learner question yet; the column exists so a later phase can add them without a
migration.
```

- [ ] **Step 7: README — the two new commands and the migration warning**

In *Running it*, after the command block, add:

```markdown
> **Migration `0003` clears the dictionary and the quiz.** It runs `TRUNCATE vocab_terms,
> sessions CASCADE` before adding its columns, so applying it drops every seeded and
> looked-up word, every question, and all session history — `answers`, `session_questions`
> and `sessions`. `users` survives. That is the deliberate price of one data shape instead
> of two, and it happens once, the first time `npm run db:migrate` runs on an existing
> database.
```

and add a subsection after *Environment variables*:

~~~markdown
### The recorded seed

The sixteen seeded strings are real provider answers, generated once against Gemini and
reviewed by hand. `src/db/content.ts` holds the quiz authoring — the string to record,
three distractors, and where the right answer is spliced in — and
`src/db/content.generated.ts` holds the recordings. `db/seed.ts` replays them through
`persistEntries`, the same write path a lookup uses, so a seeded row and a looked-up row
are indistinguishable.

```bash
npm run content:generate            # re-record all sixteen. Needs a real key; spends money
npm run content:generate -- book    # re-record one, leaving the other fifteen untouched
npm run db:reseed                   # clear the dictionary and replay the recording
```

`content:generate` needs `GEMINI_API_KEY` and `GEMINI_MODEL` and refuses to run against
MockServer. It is absent from every CI job, so a stale `content.generated.ts` is invisible
until someone looks. Always read the diff before committing one: regeneration is
non-deterministic enough at `temperature: 0` that a filterless re-record produces a
sixteen-entry diff nobody reads carefully, which is why the filter exists.

`db:reseed` is needed because `persistEntries` is first-writer-wins — running the seed
alone against a populated database writes nothing, so a re-recording would never reach it.

> **`db:reseed` drops looked-up words as well as recorded ones**, and takes session history
> with them. Nothing distinguishes a recorded row from a written one — that is the whole
> point of recording the seed — so "re-record one word" is really "reset the dictionary and
> re-record". The loss is provider calls rather than data.

To remove one bad entry during a play-test without resetting everything, delete it by hand:
`DELETE FROM vocab_terms WHERE lemma = 'whatever';` cascades to its variants, senses and
translations.
~~~

- [ ] **Step 8: README — correct *Reading the API***

Replace the paragraph beginning "As of phase 9 one endpoint on this open API also costs
money to call" with:

```markdown
`POST /api/translations` reaches a paid third-party model **on a miss** — a string already
in the dictionary is answered from Postgres in milliseconds and costs nothing. Since phase
10 that is most repeat traffic, but there is still no authentication and no rate limit in
front of the endpoint, and every *new* string is a paid call. That is acceptable for a
play-test on a local network and **must not** reach a public host in this state.
```

- [ ] **Step 9: Verify the ADR documents and their scripts still agree**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run lint:arch
git diff --stat scripts/
```

Expected: `Architecture check passed: 17 rules, no violations.` and **no change under
`scripts/`** — this phase adds no check, which is what makes the "no planted-violation
step" claim above true rather than an omission.

- [ ] **Step 10: Commit**

```bash
git add docs/adr README.md
git commit -m "docs: R8's second amendment, R4's sibling import, and the recorded seed

Two transactions per lookup with the provider call between them; db/ may reach
repo/, which the diagram already said; the eval bucket names the recorder. No
new ADR and no new check — phase 10 adds nothing a regex can see."
```

---

### Task 14: Verify the phase against its own success criteria

Not new code — the pass that catches what task-by-task green does not. Run it in one
sitting, from a clean tree.

- [ ] **Step 1: The full suite, offline**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:all && npm run typecheck && npm run lint:arch && npm run e2e
```

Expected: green with **no network access and no API key set** — criterion 8. If any of
these needs `GEMINI_API_KEY` to be a real value, something reached a provider that should
not have. `lint:arch` must report 17 rules — criterion 9.

Then confirm the recorder is in no CI job, which is the other half of criterion 8:

```bash
grep -rn "content:generate" .github/workflows/
```

Expected: no output.

- [ ] **Step 2: The published document has not moved — criterion 7**

```bash
git diff master -- apps/server/src/openapi.test.ts apps/server/src/routes/translations.ts
git diff --stat master -- apps/mobile
```

Expected: all three empty. The wire contract, its three statuses, its published document
and every existing route test are untouched, because reuse and persistence are entirely a
property of how the use case is satisfied.

- [ ] **Step 3: Walk the worked example by hand**

Start the stack and drive the endpoint against a database that has never seen `saw`:

```bash
npm run db:reseed
GEMINI_BASE_URL=http://localhost:1080/manual GEMINI_API_KEY=dev GEMINI_MODEL=dev npm run server
```

In another terminal, register a two-entry answer for `saw` on MockServer's `/manual`
namespace (copy the body shape from
`apps/server/tests/integration/services/translations.test.ts`), then:

```bash
curl -s localhost:3001/api/translations -H 'content-type: application/json' \
  -d '{"text":"saw"}' | jq
curl -s localhost:3001/api/translations -H 'content-type: application/json' \
  -d '{"text":"saw"}' | jq
curl -s localhost:3001/api/translations -H 'content-type: application/json' \
  -d '{"text":"book"}' | jq
```

Expected — criteria 2, 3 and 4:
- The first `saw` returns **both** `see`'s and `saw`'s senses in one answer, interleaved.
- The second returns the identical ordered list, and the server log shows `vocab_cache_hit`
  rather than `translated` following a provider call.
- `book` answers from the recording with at least two senses including `ספר`, with no
  provider request at all.
- No response anywhere contains `sense_code`.

- [ ] **Step 4: Re-recording is a supported operation — criterion 6**

Only if a real key is available. Otherwise record here that it was not run, and say so
when reporting the phase complete.

```bash
GEMINI_API_KEY=<real key> GEMINI_MODEL=gemini-2.5-flash npm run content:generate -- book
git diff --stat apps/server/src/db/content.generated.ts
```

Expected: one file changed, and reading the diff shows only `book`'s entry moved — the
other fifteen recordings are byte-identical. Then `npm run db:reseed` makes a database
serve it, while `npm run db:migrate` alone (which runs the bare seed) would write nothing.

Revert the re-recording afterwards unless the new one is better:
`git checkout -- apps/server/src/db/content.generated.ts`.

- [ ] **Step 5: A failing write still answers — criterion 10**

Covered by `src/services/translations.test.ts`'s *still answers 200 with the flattened
entries when the write throws*. Confirm the assertion names the log line:

```bash
npm test -w apps/server -- services/translations -t 'write throws'
```

Expected: PASS, and the test asserts `vocab_persist_failed` is logged at error level.

- [ ] **Step 6: Report what is still open**

Three things this phase deliberately leaves carried rather than closed. Say them out loud
when reporting completion rather than letting them be discovered:

- `התרגום נשמר לאוצר המילים שלך` still overstates what happened. The save is real but
  shared; `שלך` was kept deliberately, because it reads as the app's vocabulary from the
  learner's point of view and becomes literally correct on the day ownership arrives. Phase
  9's risk is carried forward, and a play-test should still be read that way.
- The per-sense confirm button is now decoration. The rows were written when the answer
  arrived, so choosing a sense confirms something that already happened and records
  nothing.
- Reuse changes what a play-test measures. A string already in the dictionary answers in
  milliseconds, so latency findings now depend on which words a tester happens to try.
