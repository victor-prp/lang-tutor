# Phase 26 — Words from a Photo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A learner photographs a word list. The server reads it in the background into rows, each row a word or phrase with one chosen sense. The learner reviews the rows, unticking some or switching their sense, and saves them in one go.

**Architecture:** An upload creates a `photo_imports` row and enqueues `read-photo` in one transaction (ADR 0007). One vision call reads the photo into `photo_import_items`, and each row gets a `look-up-import-item` job. That job runs today's lookup unchanged, picks the sense, and writes the row. The app polls the import, sends each tick or sense change as it happens, and saves the whole import in one transaction. "Ready" is derived from the rows and never stored.

**Tech Stack:** TypeScript, Hono + `@hono/zod-openapi`, Drizzle + Postgres, pg-boss, Gemini over raw `fetch`, Expo SDK 57 (React Native + web), `expo-image-picker`, `expo-image-manipulator`, Jest, Playwright, MockServer.

**Spec:** `docs/superpowers/specs/2026-10-07-lang-tutor-phase-26-photo-import-design.md`. Read it before your task. It argues every decision here (D1–D15).

## Global Constraints

- Work only in `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-26-photo-import`. Never `cd` to, read from, or write into `/Users/victorprp/git/lang-tutor` outside `.claude/worktrees/`. Use absolute paths under the worktree.
- Never hardcode a port or a database name. Run database-backed commands through the lane wrapper: from the worktree root, `npm run test:integration`. For one file: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/<path>.test.ts`. Never pass `--selectProjects integration <path>` with a space: the path is swallowed and the whole suite runs.
- Never run `npm run eval`, because the session guard refuses it. Run the eval as `cd apps/server && npx tsx tests/eval/run.ts <filter>`.
- **The photo:** `mime_type: 'image/jpeg'` only, and `image` is 1 to 2 800 000 base64 characters. The app shrinks to at most 2048 px on the long edge and saves JPEG at compress 0.8.
- **The body limit:** the upload route answers 413 `{ error: 'photo too large' }` above 3 MB (3 145 728 bytes). No other route gets a body limit.
- **Budgets:**
  - `PHOTO_READ_TIMEOUT_MS` defaults to 120 000 and is capped at it;
  - `read-photo` expires at 240 s;
  - `look-up-import-item` expires at 180 s;
  - both queues: `retryLimit: 2`, `retryBackoff: true`, `deleteAfterSeconds: 86_400`, with a dead-letter queue each.
- **Concurrency per process:** `read-photo` 2, `look-up-import-item` 4.
- **Open** means status not `saved` or `discarded`, and `created_at` within 14 days. Creating an import deletes that enrollment's imports older than 14 days.
- **Prompt markers, verbatim:** `read the word list in this photo` (the reader) and `which numbered sense` (the match call).
- Every row with options starts ticked. There is no "already saved" check.
- No log event contains the photo or any Hebrew.
- **ADR 0001:**
  - `services/` imports `repo/` as types only;
  - `domain/` is pure: no `Date.now`, no `Math.random`, no imports from outside `domain/` except `@lang-tutor/core/*`;
  - `providers/` is imported only by `composition.ts`, `tests/support/` and `tests/eval/`.
- **ADR 0002:**
  - factories return objects of closures and their types are `ReturnType<typeof createX>`;
  - no optional or defaulted collaborator parameter (`rng`, `onError`, `randomUUID`, `logger`, `storage`, `fetch`);
  - `expo-image-picker` and `expo-image-manipulator` are imported only in `apps/mobile/src/app/_layout.tsx`.
- **ADR 0003:**
  - every endpoint is a `createRoute`, with its schemas in `packages/core/src/api/schemas.ts` and its types `z.infer` in `types.ts`, exported type-only from `index.ts`;
  - each `OpenAPIHono` keeps the `defaultHook` that answers 400 `{ error: 'invalid request' }`.
- **ADR 0004:** unit tests are `src/**/*.test.ts` and touch no database. Integration tests are `tests/integration/**/*.test.ts`.
- **ADR 0007:** jobs are enqueued only through `repos.jobs.enqueue` inside the use case's transaction, and `.work(` appears only in `worker.ts`. A handler calls one service method.
- Commit after each task with a message in the repo's style (`feat(server): …`, `test(server): …`, `feat(mobile): …`, `docs: …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are inputs the spec implies but no feature test would otherwise exercise. Each has its pinning test in the task named.

1. **A discard while row jobs are still queued:** the remaining jobs make no lookup call and write nothing. *(Task 6)*
2. **A tick or sense change sent for a row whose lookup has not landed:** 409, and the row is unchanged. *(Tasks 6, 8)*
3. **A save racing a discard:** exactly one wins. A save after a discard answers 409; a discard after a save answers 409. *(Task 8)*
4. **The reader returning an empty text, an item over 100 characters, or the same word twice:** the empty and long ones are dropped, the duplicate is merged, and none reaches a lookup. *(Task 2)*
5. **The web picker returning a `data:image/jpeg;base64,` URL instead of bare base64:** the prefix is stripped before the upload. *(Task 11)*

---

## File Structure

**Core (`packages/core/src/api/`)**
- `schemas.ts`: the wire schemas, plus the model's two answer schemas.
- `types.ts`, `index.ts`: their inferred types.

**Server (`apps/server/src/`)**
- `domain/photoReading.ts`: the reader's prompt, parse and merge.
- `domain/senseMatching.ts`: glosses, the free check, the match prompt and parse.
- `domain/photoImports.ts`: statuses, openness, PATCH refusals, entries to save, review counts, options from a lookup.
- `domain/jobs.ts`: queue names, payloads, budgets.
- `db/jobs.ts`: queue policies.
- `db/schema.ts` and `db/migrations/0017_photo_imports.sql`: the tables.
- `repo/photoImports.ts`: persistence primitives.
- `services/llm.ts`: `VisionClient`.
- `services/photoImports.ts`: every use case.
- `services/transaction.ts`: `Repos` gains `photoImport`.
- `providers/gemini.ts`: `createGeminiVisionClient`.
- `config.ts`: `photoReadTimeoutMs`.
- `composition.ts`, `index.ts`, `worker.ts`: wiring.
- `routes/photoImports.ts`, `app.ts`: transport.
- `errors.ts`: three classes.

**Server tests:**
- `tests/support/`: `serverDeps.ts`, `fakes.ts` and `mockServer.ts` gain photo support.
- `tests/integration/`: `repo/photoImports.test.ts`, `routes/photoImports.test.ts`, `jobs/photoImport.test.ts`, `db/jobs.test.ts`.
- `tests/eval/`: `photoCases.ts`, `askPhoto.ts`, `fixtures/photos/*`, and `run.ts`.

**Mobile (`apps/mobile/src/`)**
- `photos.ts`: `createPhotoPicker`.
- `photoImports.ts`: pure review logic.
- `api/client.ts`: six methods.
- `hooks/usePhotoImports.tsx`: provider and hook.
- `app/photo-imports/index.tsx`, `app/photo-imports/[id].tsx`: the screens.
- `app/index.tsx`: the home button and card.
- `strings.ts`, `app/_layout.tsx`: strings and wiring.

**E2E (`e2e/`)**
- `tests/support/mockServer.ts`: body-matched stubs.
- `fixtures/word-list.jpg`.
- `tests/photo-import.spec.ts`.

**Docs**
- the spec: deviations and POC findings;
- ADR 0002: R1 and R6;
- `scripts/check-adr-0002-di-with-closures.sh`.

---

### Task 1: The wire contract and the model's answer schemas

**Files:**
- Modify: `packages/core/src/api/schemas.ts`. Append after `LlmDistractorsSchema`, at the end of the file.
- Modify: `packages/core/src/api/types.ts`
- Modify: `packages/core/src/api/index.ts`
- Test: `packages/core/src/api/schemas.test.ts`

**Interfaces:**
- Produces:
  - schemas `PhotoImportCreateRequestSchema`, `PhotoImportStatusSchema`, `PhotoImportItemStatusSchema`, `PhotoImportItemReasonSchema`, `PhotoImportOptionSchema`, `PhotoImportItemSchema`, `PhotoImportSummarySchema`, `PhotoImportSchema`, `PhotoImportListSchema`, `PhotoImportItemUpdateSchema`, `LlmPhotoReadingSchema`, `LlmSenseMatchSchema`;
  - types `PhotoImportCreateRequest`, `PhotoImportStatus`, `PhotoImportItemStatus`, `PhotoImportItemReason`, `PhotoImportOption`, `PhotoImportItem`, `PhotoImportSummary`, `PhotoImport`, `PhotoImportItemUpdate`, `LlmPhotoReading`, `LlmSenseMatch`.
  - The save answer reuses `SaveVocabularyResponseSchema` / `SaveVocabularyResponse`.

- [ ] **Step 1: Write the failing tests.** Append to `packages/core/src/api/schemas.test.ts`, adding the new names to its import list from `./schemas`:

```ts
describe('phase 26 photo import schemas', () => {
  it('takes a JPEG as base64, and nothing larger than about 2 MB', () => {
    expect(PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: 'abc' }).success).toBe(true);
    expect(PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/png', image: 'abc' }).success).toBe(false);
    expect(PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: '' }).success).toBe(false);
    expect(
      PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: 'a'.repeat(2_800_001) }).success,
    ).toBe(false);
    expect(
      PhotoImportCreateRequestSchema.safeParse({ mime_type: 'image/jpeg', image: 'a'.repeat(2_800_000) }).success,
    ).toBe(true);
  });

  it('refuses an item update that changes nothing', () => {
    expect(PhotoImportItemUpdateSchema.safeParse({}).success).toBe(false);
    expect(PhotoImportItemUpdateSchema.safeParse({ ticked: false }).success).toBe(true);
    expect(PhotoImportItemUpdateSchema.safeParse({ sense_id: 's1' }).success).toBe(true);
    expect(PhotoImportItemUpdateSchema.safeParse({ sense_id: '' }).success).toBe(false);
  });

  it('parses a row and an import', () => {
    const item = {
      position: 0,
      text: 'gatto',
      hebrew: 'חתול',
      status: 'ready',
      corrected_form: null,
      options: [{ sense_id: 's1', variant_id: 'v1', translation: 'חתול', part_of_speech: 'noun' }],
      chosen_sense_id: 's1',
      ticked: true,
      hebrew_mismatch: false,
      reason: null,
    };
    expect(PhotoImportItemSchema.parse(item)).toEqual(item);
    const summary = { id: 'i1', status: 'looking_up', item_count: 3, settled_count: 1, created_at: '2026-10-07T10:00:00.000Z' };
    expect(PhotoImportSchema.parse({ ...summary, items: [item] }).items).toHaveLength(1);
    expect(PhotoImportStatusSchema.options).toEqual(['reading', 'looking_up', 'ready', 'failed', 'saved', 'discarded']);
  });

  it('reads the model answers: a list of items, and a whole sense number', () => {
    expect(LlmPhotoReadingSchema.parse({ items: [{ text: 'gatto', hebrew: '' }] }).items[0].text).toBe('gatto');
    expect(LlmSenseMatchSchema.safeParse({ sense: 2 }).success).toBe(true);
    expect(LlmSenseMatchSchema.safeParse({ sense: 1.5 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx jest packages/core/src/api/schemas.test.ts` from the worktree root. If the root has no jest config for core, use `cd packages/core && npx jest src/api/schemas.test.ts`.
Expected: FAIL. The new names are not exported from `./schemas`.

- [ ] **Step 3: Add the schemas.** Append to `packages/core/src/api/schemas.ts`:

```ts
// Phase 26. Words from a photo: an import is one photo of a word list, read in
// the background into rows, each a word or phrase with one chosen sense. The
// image is base64 JPEG, because the app re-encodes every photo. 2 800 000
// characters is about 2 MB decoded (spec D6).
export const PhotoImportCreateRequestSchema = z.object({
  mime_type: z.literal('image/jpeg'),
  image: z.string().min(1).max(2_800_000),
});

// `reading`, `failed`, `saved` and `discarded` are stored. `looking_up` and
// `ready` are worked out from the rows, so two rows finishing at once never
// race over a counter (spec D4).
export const PhotoImportStatusSchema = z.enum(['reading', 'looking_up', 'ready', 'failed', 'saved', 'discarded']);
export const PhotoImportItemStatusSchema = z.enum(['pending', 'ready', 'failed']);
// Why a ready row has no options (spec D7).
export const PhotoImportItemReasonSchema = z.enum(['sentence', 'no_meaning', 'not_in_language']);

// One saveable sense of a row's word: a snapshot of the lookup's answer.
export const PhotoImportOptionSchema = z.object({
  sense_id: z.string(),
  variant_id: z.string(),
  translation: z.string(),
  part_of_speech: z.string().optional(),
  example: z.object({ source: z.string(), target: z.string() }).optional(),
});

export const PhotoImportItemSchema = z.object({
  position: z.number().int().nonnegative(),
  // As read from the photo.
  text: z.string(),
  // As printed beside it, or null.
  hebrew: z.string().nullable(),
  status: PhotoImportItemStatusSchema,
  // Set when the lookup corrected the text (`gatlo` read, `gatto` looked up).
  corrected_form: z.string().nullable(),
  options: z.array(PhotoImportOptionSchema),
  chosen_sense_id: z.string().nullable(),
  ticked: z.boolean(),
  // The printed Hebrew names none of the options.
  hebrew_mismatch: z.boolean(),
  reason: PhotoImportItemReasonSchema.nullable(),
});

// `settled_count` counts the rows no longer pending, ready or failed: the
// "12 of 32" of the review's status line.
export const PhotoImportSummarySchema = z.object({
  id: z.string(),
  status: PhotoImportStatusSchema,
  item_count: z.number().int().nonnegative(),
  settled_count: z.number().int().nonnegative(),
  created_at: z.string(),
});

export const PhotoImportSchema = PhotoImportSummarySchema.extend({
  items: z.array(PhotoImportItemSchema),
});

export const PhotoImportListSchema = z.array(PhotoImportSummarySchema);

export const PhotoImportItemUpdateSchema = z
  .object({
    ticked: z.boolean().optional(),
    sense_id: z.string().min(1).optional(),
  })
  .refine((body) => body.ticked !== undefined || body.sense_id !== undefined, {
    message: 'nothing to update',
  });

// Phase 26. The reader's answer (spec D5). `hebrew` is an empty string when
// nothing is printed: a flat schema, far from the complexity limit the lookup's
// once hit.
export const LlmPhotoReadingSchema = z.object({
  items: z.array(z.object({ text: z.string(), hebrew: z.string() })),
});

// Phase 26. The match call's answer: a sense number counted from 1, 0 for none
// (spec D7).
export const LlmSenseMatchSchema = z.object({ sense: z.number().int() });
```

- [ ] **Step 4: Add the types.** In `packages/core/src/api/types.ts`, add the twelve schema names to the `import type { … } from './schemas'` list, and append:

```ts
export type PhotoImportCreateRequest = z.infer<typeof PhotoImportCreateRequestSchema>;
export type PhotoImportStatus = z.infer<typeof PhotoImportStatusSchema>;
export type PhotoImportItemStatus = z.infer<typeof PhotoImportItemStatusSchema>;
export type PhotoImportItemReason = z.infer<typeof PhotoImportItemReasonSchema>;
export type PhotoImportOption = z.infer<typeof PhotoImportOptionSchema>;
export type PhotoImportItem = z.infer<typeof PhotoImportItemSchema>;
export type PhotoImportSummary = z.infer<typeof PhotoImportSummarySchema>;
export type PhotoImport = z.infer<typeof PhotoImportSchema>;
export type PhotoImportItemUpdate = z.infer<typeof PhotoImportItemUpdateSchema>;
export type LlmPhotoReading = z.infer<typeof LlmPhotoReadingSchema>;
export type LlmSenseMatch = z.infer<typeof LlmSenseMatchSchema>;
```

  In `packages/core/src/api/index.ts`, add the eleven type names to the `export type { … } from './types'` list, keeping it alphabetical.

- [ ] **Step 5: Run the tests and confirm they pass.** Run the same command as Step 2. Expected: PASS. Then run `npm run typecheck` and `npm run lint:arch` from the worktree root. Expected: no errors, and every ADR check `ok`.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/api
git commit -m "feat(core): photo import wire contract and the reader's and matcher's answers"
```

---

### Task 2: Reading the photo: prompt, parse, merge

**Files:**
- Create: `apps/server/src/domain/photoReading.ts`
- Test: `apps/server/src/domain/photoReading.test.ts`

**Interfaces:**
- Consumes: `LlmPhotoReadingSchema` (Task 1); `LANGUAGES`, `stripStress`, `LanguageCode` from `./languages`; `normalizeForm` from `./dictionary`; `dropNulls`, `unfence` from `./translation`.
- Produces:
  - `PHOTO_READING_MARKER = 'read the word list in this photo'`;
  - `MAX_ITEM_LENGTH = 100`;
  - `type ReadItem = { text: string; hebrew: string | null }`;
  - `type PhotoReadingPrompt = { system: string; user: string; schema: typeof LlmPhotoReadingSchema }`;
  - `buildPhotoReadingPrompt(target: LanguageCode): PhotoReadingPrompt`;
  - `type PhotoReading = { items: ReadItem[]; mergedCount: number; droppedCount: number }`;
  - `parsePhotoReading(raw: string): PhotoReading | null`.

- [ ] **Step 1: Write the failing tests.** Create `apps/server/src/domain/photoReading.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import { LlmPhotoReadingSchema } from '@lang-tutor/core/api/schemas';

import { PHOTO_READING_MARKER, buildPhotoReadingPrompt, parsePhotoReading } from './photoReading';

const answer = (items: { text: string; hebrew: string }[]) => JSON.stringify({ items });

describe('buildPhotoReadingPrompt', () => {
  it('names the language, carries the marker MockServer matches, and asks for the reading schema', () => {
    const prompt = buildPhotoReadingPrompt('it');
    expect(prompt.system).toContain(PHOTO_READING_MARKER);
    expect(prompt.system).toContain('Italian');
    expect(prompt.system).toContain('crossed out');
    expect(prompt.system).toContain('il gatto -> gatto');
    expect(prompt.user).toBe('Language: Italian.');
    expect(prompt.schema).toBe(LlmPhotoReadingSchema);
  });
});

describe('parsePhotoReading', () => {
  it('keeps page order, and turns an empty Hebrew into null', () => {
    const reading = parsePhotoReading(
      answer([
        { text: 'gatto', hebrew: 'חתול' },
        { text: 'in bocca al lupo', hebrew: '  ' },
      ]),
    );
    expect(reading).toEqual({
      items: [
        { text: 'gatto', hebrew: 'חתול' },
        { text: 'in bocca al lupo', hebrew: null },
      ],
      mergedCount: 0,
      droppedCount: 0,
    });
  });

  it('merges the same word read twice, keeping the first one and its Hebrew', () => {
    const reading = parsePhotoReading(
      answer([
        { text: 'Gatto', hebrew: 'חתול' },
        { text: 'casa', hebrew: '' },
        { text: ' gatto ', hebrew: 'חתולה' },
      ]),
    );
    expect(reading?.items).toEqual([
      { text: 'Gatto', hebrew: 'חתול' },
      { text: 'casa', hebrew: null },
    ]);
    expect(reading?.mergedCount).toBe(1);
  });

  it('drops an empty text and one longer than a lookup takes, so neither reaches a lookup', () => {
    const reading = parsePhotoReading(
      answer([
        { text: '   ', hebrew: 'x' },
        { text: 'a'.repeat(101), hebrew: '' },
        { text: 'a'.repeat(100), hebrew: '' },
      ]),
    );
    expect(reading?.items.map((item) => item.text.length)).toEqual([100]);
    expect(reading?.droppedCount).toBe(2);
  });

  it('strips Russian stress marks and collapses spaces', () => {
    expect(parsePhotoReading(answer([{ text: 'молоко́', hebrew: 'חלב' }]))?.items).toEqual([
      { text: 'молоко', hebrew: 'חלב' },
    ]);
    expect(parsePhotoReading(answer([{ text: 'in  bocca\tal lupo', hebrew: '' }]))?.items[0].text).toBe(
      'in bocca al lupo',
    );
  });

  it('reads a fenced answer, and refuses one that is not the schema', () => {
    expect(parsePhotoReading('```json\n' + answer([{ text: 'casa', hebrew: '' }]) + '\n```')?.items).toHaveLength(1);
    expect(parsePhotoReading('not json')).toBeNull();
    expect(parsePhotoReading(JSON.stringify({ items: [{ text: 1 }] }))).toBeNull();
    expect(parsePhotoReading(JSON.stringify({ words: [] }))).toBeNull();
  });

  it('reads an empty list as an empty reading, not a failure', () => {
    expect(parsePhotoReading(answer([]))).toEqual({ items: [], mergedCount: 0, droppedCount: 0 });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `cd apps/server && npx jest --selectProjects=unit src/domain/photoReading.test.ts`
Expected: FAIL. Cannot find module `./photoReading`.

- [ ] **Step 3: Implement.** Create `apps/server/src/domain/photoReading.ts`:

```ts
import { LlmPhotoReadingSchema } from '@lang-tutor/core/api/schemas';

import { normalizeForm } from './dictionary';
import { LANGUAGES, stripStress, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 26 (spec D5). The pure half of reading a photo: what to ask the model,
 * and what its answer means. services/photoImports.ts sends the photo.
 *
 * The prompt lives here, not in the provider, so `npm run eval` scores exactly
 * what production sends, as it does for the lookup.
 */

/** In the instruction verbatim, so MockServer can tell this call from the
 *  others, as DISTRACTOR_MARKER does. */
export const PHOTO_READING_MARKER = 'read the word list in this photo';

/** The lookup refuses longer input (TranslationRequestSchema), and a longer
 *  item is a sentence, not a vocabulary item. */
export const MAX_ITEM_LENGTH = 100;

export type ReadItem = { text: string; hebrew: string | null };

export type PhotoReadingPrompt = {
  system: string;
  user: string;
  schema: typeof LlmPhotoReadingSchema;
};

export function buildPhotoReadingPrompt(target: LanguageCode): PhotoReadingPrompt {
  const name = LANGUAGES[target].name;
  const system = [
    `You ${PHOTO_READING_MARKER} for a Hebrew speaker learning ${name}.`,
    `Return every vocabulary item written in ${name}, in page order: top to bottom, and column by column when the list has several columns.`,
    'Return JSON only, matching the supplied schema.',
    'Rules:',
    `1. Only items in ${name}. Skip headings, titles, instructions, exercise text, example sentences, page numbers, exercise numbers, dates, and anything crossed out.`,
    '2. Write each item the way the learner would type it into a dictionary: drop a leading article or the infinitive marker "to" (il gatto -> gatto, to run -> run), unless the item is a fixed expression; drop grammar labels such as (m.), (f.), (pl.), (v.), (n.), (adj.), (conj.), sb, sth; drop stress marks over vowels; otherwise keep the item exactly as written.',
    '3. If Hebrew is written next to an item as its translation, copy that Hebrew whole, with all its glosses, into "hebrew". Otherwise "hebrew" is an empty string.',
    '4. When handwriting is unclear, give your best reading rather than leaving the item out.',
    '5. Never translate, explain, or add an item that is not on the page.',
  ].join('\n');
  return { system, user: `Language: ${name}.`, schema: LlmPhotoReadingSchema };
}

export type PhotoReading = { items: ReadItem[]; mergedCount: number; droppedCount: number };

/** `null` means unreadable: the job throws and pg-boss retries. An empty list
 *  is a photo with no words in the language, which is an answer. */
export function parsePhotoReading(raw: string): PhotoReading | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmPhotoReadingSchema.safeParse(dropNulls(json));
  if (!result.success) return null;

  const seen = new Set<string>();
  const items: ReadItem[] = [];
  let mergedCount = 0;
  let droppedCount = 0;
  for (const item of result.data.items) {
    const text = stripStress(item.text).replace(/\s+/g, ' ').trim();
    if (text === '' || text.length > MAX_ITEM_LENGTH) {
      droppedCount += 1;
      continue;
    }
    // The dictionary's own key, lower-cased: `Gatto` and ` gatto ` are one word.
    const key = normalizeForm(text).toLowerCase();
    if (seen.has(key)) {
      mergedCount += 1;
      continue;
    }
    seen.add(key);
    const hebrew = item.hebrew.trim();
    items.push({ text, hebrew: hebrew === '' ? null : hebrew });
  }
  return { items, mergedCount, droppedCount };
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command as Step 2. Expected: PASS (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/domain/photoReading.ts apps/server/src/domain/photoReading.test.ts
git commit -m "feat(server): the photo reader's prompt, and an answer merged and bounded for lookups"
```

---

### Task 3: Choosing a sense, and an import's rules

**Files:**
- Create: `apps/server/src/domain/senseMatching.ts`
- Create: `apps/server/src/domain/photoImports.ts`
- Test: `apps/server/src/domain/senseMatching.test.ts`
- Test: `apps/server/src/domain/photoImports.test.ts`

**Interfaces:**
- Consumes: `LlmSenseMatchSchema` (Task 1); `comparable` from `./distractors`, which is already exported and folds niqqud, stress, trailing punctuation and case; `LANGUAGES`, `LanguageCode`; `dropNulls`, `unfence`.
- Produces, from `senseMatching.ts`:
  - `SENSE_MATCH_MARKER = 'which numbered sense'`;
  - `type MatchOption = { translation: string; part_of_speech?: string }`;
  - `type MatchedBy = 'exact' | 'model' | 'none' | 'no_hebrew'`;
  - `type SenseChoice = { index: number; mismatch: boolean; matchedBy: MatchedBy }`;
  - `glossesOf(hebrew: string): string[]`;
  - `firstChoice(hebrew: string | null, options: readonly MatchOption[]): SenseChoice | 'ask_model'`;
  - `type SenseMatchPrompt = { system; user; schema: typeof LlmSenseMatchSchema }`;
  - `buildSenseMatchPrompt(input: { word: string; target: LanguageCode; hebrew: string; options: readonly MatchOption[] }): SenseMatchPrompt`;
  - `parseSenseMatch(raw: string, optionCount: number): number | 'none' | null`;
  - `choiceFromModel(answer: number | 'none'): SenseChoice`.
- Produces, from `photoImports.ts`:
  - `type StoredImportStatus = 'reading' | 'read' | 'failed' | 'saved' | 'discarded'`;
  - `type StoredItemStatus = 'pending' | 'ready' | 'failed'`;
  - `IMPORT_TTL_MS`;
  - `type ImportItemState`;
  - `deriveStatus(stored, pendingCount): PhotoImportStatus`;
  - `isOpen(stored, createdAt: Date, now: number): boolean`;
  - `type ItemUpdate = { ticked?: boolean; sense_id?: string }`;
  - `refuseItemUpdate(item, update): 'not_ready' | 'no_options' | 'unknown_sense' | null`;
  - `entriesToSave(items): VocabularyEntryInput[]`;
  - `reviewCounts(items): { unticked: number; changedSense: number }`;
  - `optionsFrom(senses: TranslationSense[]): PhotoImportOption[]`;
  - `reasonFor(response: { kind: TranslationKind; reason?: TranslationGuardReason }): PhotoImportItemReason`.

- [ ] **Step 1: Write the failing tests.** Create `apps/server/src/domain/senseMatching.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import { LlmSenseMatchSchema } from '@lang-tutor/core/api/schemas';

import {
  SENSE_MATCH_MARKER,
  buildSenseMatchPrompt,
  choiceFromModel,
  firstChoice,
  glossesOf,
  parseSenseMatch,
} from './senseMatching';

const options = [
  { translation: 'בנק', part_of_speech: 'noun' },
  { translation: 'גדה', part_of_speech: 'noun' },
];

describe('glossesOf', () => {
  it('splits at commas, slashes and semicolons, and folds niqqud and case', () => {
    expect(glossesOf('בַּנְק, גדה / שפה;  ')).toEqual(['בנק', 'גדה', 'שפה']);
  });
});

describe('firstChoice', () => {
  it('takes the first option when nothing is printed', () => {
    expect(firstChoice(null, options)).toEqual({ index: 0, mismatch: false, matchedBy: 'no_hebrew' });
  });

  it('takes the option whose translation equals one of the printed glosses, with no model call', () => {
    expect(firstChoice('שפת נהר, גדה', options)).toEqual({ index: 1, mismatch: false, matchedBy: 'exact' });
    expect(firstChoice('גָּדָה', options)).toEqual({ index: 1, mismatch: false, matchedBy: 'exact' });
  });

  it('prefers the earlier option when two match', () => {
    expect(firstChoice('בנק, גדה', options)).toEqual({ index: 0, mismatch: false, matchedBy: 'exact' });
  });

  it('asks the model when no gloss equals a translation', () => {
    expect(firstChoice('גדת נהר', options)).toBe('ask_model');
  });
});

describe('buildSenseMatchPrompt', () => {
  it('numbers the options from 1 and carries the marker', () => {
    const prompt = buildSenseMatchPrompt({ word: 'bank', target: 'en', hebrew: 'גדת נהר', options });
    expect(prompt.system).toContain(SENSE_MATCH_MARKER);
    expect(prompt.system).toContain('English');
    expect(JSON.parse(prompt.user)).toEqual({
      word: 'bank',
      printed_hebrew: 'גדת נהר',
      senses: [
        { number: 1, hebrew: 'בנק', part_of_speech: 'noun' },
        { number: 2, hebrew: 'גדה', part_of_speech: 'noun' },
      ],
    });
    expect(prompt.schema).toBe(LlmSenseMatchSchema);
  });
});

describe('parseSenseMatch', () => {
  it('turns a sense number into an index', () => {
    expect(parseSenseMatch('{"sense":2}', 2)).toBe(1);
  });

  it('reads 0, an out-of-range number and an empty answer as none', () => {
    expect(parseSenseMatch('{"sense":0}', 2)).toBe('none');
    expect(parseSenseMatch('{"sense":3}', 2)).toBe('none');
    expect(parseSenseMatch('{"sense":-1}', 2)).toBe('none');
    expect(parseSenseMatch('', 2)).toBe('none');
  });

  it('refuses an unreadable answer, so the job retries', () => {
    expect(parseSenseMatch('two', 2)).toBeNull();
    expect(parseSenseMatch('{"sense":"2"}', 2)).toBeNull();
  });
});

describe('choiceFromModel', () => {
  it('flags a mismatch and falls back to the first option on none', () => {
    expect(choiceFromModel('none')).toEqual({ index: 0, mismatch: true, matchedBy: 'none' });
    expect(choiceFromModel(1)).toEqual({ index: 1, mismatch: false, matchedBy: 'model' });
  });
});
```

  Create `apps/server/src/domain/photoImports.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import {
  IMPORT_TTL_MS,
  deriveStatus,
  entriesToSave,
  isOpen,
  optionsFrom,
  reasonFor,
  refuseItemUpdate,
  reviewCounts,
  type ImportItemState,
} from './photoImports';

const option = (n: number) => ({ sense_id: `s${n}`, variant_id: `v${n}`, translation: `t${n}` });
const row = (over: Partial<ImportItemState> = {}): ImportItemState => ({
  position: 0,
  status: 'ready',
  options: [option(1), option(2)],
  suggestedSenseId: 's1',
  chosenSenseId: 's1',
  ticked: true,
  ...over,
});

describe('deriveStatus', () => {
  it('works out looking_up and ready from the pending rows, and passes the rest through', () => {
    expect(deriveStatus('reading', 0)).toBe('reading');
    expect(deriveStatus('read', 3)).toBe('looking_up');
    expect(deriveStatus('read', 0)).toBe('ready');
    expect(deriveStatus('failed', 0)).toBe('failed');
    expect(deriveStatus('saved', 0)).toBe('saved');
    expect(deriveStatus('discarded', 2)).toBe('discarded');
  });
});

describe('isOpen', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  it('is open until saved, discarded or 14 days old', () => {
    expect(isOpen('read', created, created.getTime() + IMPORT_TTL_MS - 1)).toBe(true);
    expect(isOpen('read', created, created.getTime() + IMPORT_TTL_MS)).toBe(false);
    expect(isOpen('failed', created, created.getTime())).toBe(true);
    expect(isOpen('saved', created, created.getTime())).toBe(false);
    expect(isOpen('discarded', created, created.getTime())).toBe(false);
  });
});

describe('refuseItemUpdate', () => {
  it('refuses any change to a row whose lookup has not landed', () => {
    expect(refuseItemUpdate(row({ status: 'pending' }), { ticked: false })).toBe('not_ready');
    expect(refuseItemUpdate(row({ status: 'failed' }), { ticked: false })).toBe('not_ready');
  });
  it('refuses a sense that is not one of the options, and a tick on a row with none', () => {
    expect(refuseItemUpdate(row(), { sense_id: 's9' })).toBe('unknown_sense');
    expect(refuseItemUpdate(row({ options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false }), { ticked: true })).toBe('no_options');
  });
  it('lets an untick, a tick and a switch through', () => {
    expect(refuseItemUpdate(row(), { ticked: false })).toBeNull();
    expect(refuseItemUpdate(row({ ticked: false }), { ticked: true, sense_id: 's2' })).toBeNull();
  });
});

describe('entriesToSave', () => {
  it('takes the chosen option of every ready, ticked row, and nothing else', () => {
    expect(
      entriesToSave([
        row({ position: 0 }),
        row({ position: 1, chosenSenseId: 's2' }),
        row({ position: 2, ticked: false }),
        row({ position: 3, status: 'failed', ticked: false }),
        row({ position: 4, options: [], chosenSenseId: null, ticked: false }),
      ]),
    ).toEqual([
      { sense_id: 's1', variant_id: 'v1' },
      { sense_id: 's2', variant_id: 'v2' },
    ]);
  });
});

describe('reviewCounts', () => {
  it('counts unticked rows and changed senses among rows that had options', () => {
    expect(
      reviewCounts([
        row(),
        row({ ticked: false }),
        row({ chosenSenseId: 's2' }),
        row({ options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false }),
      ]),
    ).toEqual({ unticked: 1, changedSense: 1 });
  });
});

describe('optionsFrom', () => {
  it('keeps the saveable senses, in the lookup order, with what the list shows', () => {
    expect(
      optionsFrom([
        { translation: 'בנק', part_of_speech: 'noun', sense_id: 's1', variant_id: 'v1', saved: false },
        { translation: 'אין מזהה' },
        { translation: 'גדה', sense_id: 's2', variant_id: 'v1', example: { source: 'the bank', target: 'הגדה' } },
      ]),
    ).toEqual([
      { sense_id: 's1', variant_id: 'v1', translation: 'בנק', part_of_speech: 'noun' },
      { sense_id: 's2', variant_id: 'v1', translation: 'גדה', example: { source: 'the bank', target: 'הגדה' } },
    ]);
  });
});

describe('reasonFor', () => {
  it('says why a row has no options', () => {
    expect(reasonFor({ kind: 'word', reason: 'out_of_pair' })).toBe('not_in_language');
    expect(reasonFor({ kind: 'sentence' })).toBe('sentence');
    expect(reasonFor({ kind: 'word' })).toBe('no_meaning');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `cd apps/server && npx jest --selectProjects=unit src/domain/senseMatching.test.ts src/domain/photoImports.test.ts`
Expected: FAIL. The modules are missing.

- [ ] **Step 3: Implement `senseMatching.ts`.**

```ts
import { LlmSenseMatchSchema } from '@lang-tutor/core/api/schemas';

import { comparable } from './distractors';
import { LANGUAGES, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 26 (spec D7). Which of a word's senses the Hebrew printed beside it
 * names. A free check first: any printed gloss equal to a sense's translation.
 * Only when that finds nothing is the model asked, through LlmClient.
 */

/** In the instruction verbatim, so MockServer can tell this call apart. */
export const SENSE_MATCH_MARKER = 'which numbered sense';

export type MatchOption = { translation: string; part_of_speech?: string };
export type MatchedBy = 'exact' | 'model' | 'none' | 'no_hebrew';
export type SenseChoice = { index: number; mismatch: boolean; matchedBy: MatchedBy };

export type SenseMatchPrompt = {
  system: string;
  user: string;
  schema: typeof LlmSenseMatchSchema;
};

/** A printed translation's glosses: `בנק, גדה / שפה` is three. Folded with
 *  `comparable`, the session's own idea of "the same Hebrew". */
export function glossesOf(hebrew: string): string[] {
  return hebrew
    .split(/[,/;]/u)
    .map(comparable)
    .filter((gloss) => gloss.length > 0);
}

export function firstChoice(hebrew: string | null, options: readonly MatchOption[]): SenseChoice | 'ask_model' {
  if (hebrew === null) return { index: 0, mismatch: false, matchedBy: 'no_hebrew' };
  const glosses = new Set(glossesOf(hebrew));
  const index = options.findIndex((option) => glosses.has(comparable(option.translation)));
  return index === -1 ? 'ask_model' : { index, mismatch: false, matchedBy: 'exact' };
}

export function buildSenseMatchPrompt(input: {
  word: string;
  target: LanguageCode;
  hebrew: string;
  options: readonly MatchOption[];
}): SenseMatchPrompt {
  const name = LANGUAGES[input.target].name;
  const system = [
    `A word list printed the ${name} word below with a Hebrew translation. Decide ${SENSE_MATCH_MARKER} of the word the printed Hebrew names.`,
    'Return JSON only, matching the supplied schema.',
    "Answer with that sense's number. Answer 0 when the printed Hebrew names none of the senses.",
    'A sense matches when the printed Hebrew means the same thing, even in other words or another form: a synonym, another gender or number, a longer phrase, or with or without an article or a preposition.',
  ].join('\n');
  const user = JSON.stringify({
    word: input.word,
    printed_hebrew: input.hebrew,
    senses: input.options.map((option, index) => ({
      number: index + 1,
      hebrew: option.translation,
      ...(option.part_of_speech ? { part_of_speech: option.part_of_speech } : {}),
    })),
  });
  return { system, user, schema: LlmSenseMatchSchema };
}

/** An index into the options; `'none'` for 0, a number out of range, or the
 *  provider's empty "no content"; `null` when unreadable, which the job turns
 *  into a retry. */
export function parseSenseMatch(raw: string, optionCount: number): number | 'none' | null {
  if (raw === '') return 'none';
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmSenseMatchSchema.safeParse(dropNulls(json));
  if (!result.success) return null;
  const sense = result.data.sense;
  return sense >= 1 && sense <= optionCount ? sense - 1 : 'none';
}

/** "None" falls back to the most common sense, flagged (spec D7). */
export function choiceFromModel(answer: number | 'none'): SenseChoice {
  return answer === 'none'
    ? { index: 0, mismatch: true, matchedBy: 'none' }
    : { index: answer, mismatch: false, matchedBy: 'model' };
}
```

- [ ] **Step 4: Implement `photoImports.ts`.**

```ts
import type {
  PhotoImportItemReason,
  PhotoImportOption,
  PhotoImportStatus,
  TranslationGuardReason,
  TranslationKind,
  TranslationSense,
  VocabularyEntryInput,
} from '@lang-tutor/core/api';

/**
 * Phase 26. The rules of an import that need no database: its status as the
 * app sees it, whether it is still open, which changes a row accepts, and what
 * saving it writes (spec D4, D9–D11).
 */

export type StoredImportStatus = 'reading' | 'read' | 'failed' | 'saved' | 'discarded';
export type StoredItemStatus = 'pending' | 'ready' | 'failed';

/** Spec D10: an import nobody opens for 14 days is gone. */
export const IMPORT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** What the rules read from a row. The repository's row type has more. */
export type ImportItemState = {
  position: number;
  status: StoredItemStatus;
  options: PhotoImportOption[];
  suggestedSenseId: string | null;
  chosenSenseId: string | null;
  ticked: boolean;
};

/** "Ready to review" is never stored (spec D4). */
export function deriveStatus(stored: StoredImportStatus, pendingCount: number): PhotoImportStatus {
  if (stored === 'read') return pendingCount > 0 ? 'looking_up' : 'ready';
  return stored;
}

/** `now` is received: domain/ never reads a clock (ADR 0001 R3). */
export function isOpen(stored: StoredImportStatus, createdAt: Date, now: number): boolean {
  return stored !== 'saved' && stored !== 'discarded' && now - createdAt.getTime() < IMPORT_TTL_MS;
}

export type ItemUpdate = { ticked?: boolean; sense_id?: string };
export type ItemUpdateRefusal = 'not_ready' | 'no_options' | 'unknown_sense';

/** `not_ready` is a 409, because the row is still being looked up or failed.
 *  The other two are 400s. */
export function refuseItemUpdate(item: ImportItemState, update: ItemUpdate): ItemUpdateRefusal | null {
  if (item.status !== 'ready') return 'not_ready';
  if (update.sense_id !== undefined && !item.options.some((option) => option.sense_id === update.sense_id)) {
    return 'unknown_sense';
  }
  if (update.ticked === true && item.options.length === 0) return 'no_options';
  return null;
}

/** The ticked rows' chosen senses, as today's save takes them. */
export function entriesToSave(items: readonly ImportItemState[]): VocabularyEntryInput[] {
  return items.flatMap((item) => {
    if (item.status !== 'ready' || !item.ticked || item.chosenSenseId === null) return [];
    const option = item.options.find((candidate) => candidate.sense_id === item.chosenSenseId);
    return option ? [{ sense_id: option.sense_id, variant_id: option.variant_id }] : [];
  });
}

/** Spec D14: how often the default was changed, among rows that had one. */
export function reviewCounts(items: readonly ImportItemState[]): { unticked: number; changedSense: number } {
  const offered = items.filter((item) => item.status === 'ready' && item.options.length > 0);
  return {
    unticked: offered.filter((item) => !item.ticked).length,
    changedSense: offered.filter((item) => item.chosenSenseId !== item.suggestedSenseId).length,
  };
}

/** A lookup's saveable senses, in its order: the order a typed lookup lists. */
export function optionsFrom(senses: readonly TranslationSense[]): PhotoImportOption[] {
  return senses.flatMap((sense) =>
    sense.sense_id && sense.variant_id
      ? [
          {
            sense_id: sense.sense_id,
            variant_id: sense.variant_id,
            translation: sense.translation,
            ...(sense.part_of_speech ? { part_of_speech: sense.part_of_speech } : {}),
            ...(sense.example ? { example: sense.example } : {}),
          },
        ]
      : [],
  );
}

/** Why a looked-up row has no options. */
export function reasonFor(response: { kind: TranslationKind; reason?: TranslationGuardReason }): PhotoImportItemReason {
  if (response.reason) return 'not_in_language';
  if (response.kind === 'sentence') return 'sentence';
  return 'no_meaning';
}
```

- [ ] **Step 5: Run the tests and confirm they pass.** Run the same command as Step 2. Expected: PASS. Then `cd apps/server && npx tsc --noEmit` and `npm run lint:arch` from the root: both clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/domain/senseMatching.ts apps/server/src/domain/senseMatching.test.ts apps/server/src/domain/photoImports.ts apps/server/src/domain/photoImports.test.ts
git commit -m "feat(server): choosing a row's sense, and the rules of an import"
```

---

### Task 4: The vision client, the queues and the read budget

**Files:**
- Modify: `apps/server/src/services/llm.ts`
- Modify: `apps/server/src/providers/gemini.ts`, `apps/server/src/providers/gemini.test.ts`
- Modify: `apps/server/src/domain/jobs.ts`, `apps/server/src/domain/jobs.test.ts`
- Modify: `apps/server/src/db/jobs.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/config.test.ts`
- Test: `apps/server/tests/integration/db/jobs.test.ts`

**Interfaces:**
- Produces:
  - `type VisionJsonRequest = LlmJsonRequest & { image: { data: string; mimeType: string } }` and `type VisionClient = (request: VisionJsonRequest) => Promise<string>`, both in `services/llm.ts`;
  - `createGeminiVisionClient(deps: { fetch; baseUrl; apiKey; model; timeoutMs })`, with the same deps as `createGeminiClient`;
  - in `domain/jobs.ts`: `READ_PHOTO = 'read-photo'`, `READ_PHOTO_FAILED = 'read-photo-failed'`, `LOOK_UP_IMPORT_ITEM = 'look-up-import-item'`, `LOOK_UP_IMPORT_ITEM_FAILED = 'look-up-import-item-failed'`, `PHOTO_READ_BUDGET_MS = 120_000`, `READ_PHOTO_EXPIRY_SECONDS = 240`, `LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS = 180`, `ReadPhotoPayloadSchema` (`{ import_id }`) and `LookUpImportItemPayloadSchema` (`{ import_id, position }`), with their types `ReadPhotoPayload` and `LookUpImportItemPayload`;
  - `Config.photoReadTimeoutMs: number`.

- [ ] **Step 1: Write the failing provider tests.** Append to `apps/server/src/providers/gemini.test.ts`, importing `createGeminiVisionClient`:

```ts
describe('createGeminiVisionClient', () => {
  const visionRequest = {
    system: 'read the word list in this photo',
    user: 'Language: Italian.',
    schema: LlmTranslationSchema,
    image: { data: 'QUJD', mimeType: 'image/jpeg' },
  };
  const visionWith = (fetchImpl: typeof globalThis.fetch) =>
    createGeminiVisionClient({ fetch: fetchImpl, baseUrl: 'https://example.test', apiKey: 'secret', model: 'test-model', timeoutMs: 50 });

  it('sends the image as inlineData before the text, with the system instruction and the schema', async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const vision = visionWith(async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)) };
      return jsonResponse(geminiBody('{"items":[]}'));
    });
    expect(await vision(visionRequest)).toBe('{"items":[]}');
    expect(sent?.url).toBe('https://example.test/v1beta/models/test-model:generateContent');
    expect(sent?.body.contents).toEqual([
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }, { text: 'Language: Italian.' }] },
    ]);
    expect(sent?.body.systemInstruction).toEqual({ parts: [{ text: 'read the word list in this photo' }] });
    expect((sent?.body.generationConfig as Record<string, unknown>).responseMimeType).toBe('application/json');
  });

  it('answers an empty string when no candidate came back', async () => {
    const vision = visionWith(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    expect(await vision(visionRequest)).toBe('');
  });

  it('maps a non-2xx and a timeout to LlmUnavailable', async () => {
    await expect(visionWith(async () => jsonResponse({}, 400))(visionRequest)).rejects.toBeInstanceOf(LlmUnavailable);
    const hanging = visionWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(hanging(visionRequest)).rejects.toThrow('timed out after 50ms');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**
Run: `cd apps/server && npx jest --selectProjects=unit src/providers/gemini.test.ts`
Expected: FAIL. `createGeminiVisionClient` is not exported.

- [ ] **Step 3: Implement the provider.** In `apps/server/src/providers/gemini.ts`, move the body of the closure `createGeminiClient` returns into a module-private function that takes the user turn's parts, then build both clients on it:

```ts
type GeminiDeps = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

// One user turn's parts: text, and since phase 26 an inline image.
type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

async function generate(
  deps: GeminiDeps,
  request: { system: string; schema: ZodType },
  parts: Part[],
): Promise<string> {
  const endpoint = `${deps.baseUrl}/v1beta/models/${deps.model}:generateContent`;
  // … the existing body, unchanged, except that the request's
  // `contents: [{ role: 'user', parts: [{ text: request.user }] }]`
  // becomes `contents: [{ role: 'user', parts }]` …
}

export function createGeminiClient(deps: GeminiDeps) {
  return async (request: { system: string; user: string; schema: ZodType }): Promise<string> =>
    generate(deps, request, [{ text: request.user }]);
}

/**
 * Phase 26 (spec D5). The same call with a photo in the user turn: the image
 * part first, then the text. Its own factory, because widening LlmClient for an
 * image would widen it for every caller. Wired only in composition.ts, where
 * the `: VisionClient` annotation checks it.
 */
export function createGeminiVisionClient(deps: GeminiDeps) {
  return async (request: {
    system: string;
    user: string;
    schema: ZodType;
    image: { data: string; mimeType: string };
  }): Promise<string> =>
    generate(deps, request, [
      { inlineData: { mimeType: request.image.mimeType, data: request.image.data } },
      { text: request.user },
    ]);
}
```

  Keep every existing comment, the timeout, the error messages and the empty-string rule exactly as they are. Run Step 2's command. Expected: PASS, including every existing `createGeminiClient` test.

- [ ] **Step 4: Add the contract.** Append to `apps/server/src/services/llm.ts`:

```ts
/**
 * Phase 26 (spec D5). LlmClient's request plus one image, for the one call that
 * reads a photo. Its rules are LlmClient's: raw JSON text, an empty string for
 * "no content", and LlmUnavailable for every failure.
 */
export type VisionJsonRequest = LlmJsonRequest & { image: { data: string; mimeType: string } };
export type VisionClient = (request: VisionJsonRequest) => Promise<string>;
```

- [ ] **Step 5: Write the failing jobs and config tests.** Append to `apps/server/src/domain/jobs.test.ts`:

```ts
describe('phase 26 queues', () => {
  it('expires a read at twice its budget, and a row lookup after three lookup-sized calls with room to spare', () => {
    expect(READ_PHOTO_EXPIRY_SECONDS).toBe((2 * PHOTO_READ_BUDGET_MS) / 1000);
    expect(PHOTO_READ_BUDGET_MS).toBe(120_000);
    expect(LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS).toBe(180);
  });

  it('parses both payloads', () => {
    expect(ReadPhotoPayloadSchema.parse({ import_id: 'i1' })).toEqual({ import_id: 'i1' });
    expect(LookUpImportItemPayloadSchema.parse({ import_id: 'i1', position: 3 })).toEqual({ import_id: 'i1', position: 3 });
    expect(LookUpImportItemPayloadSchema.safeParse({ import_id: 'i1', position: -1 }).success).toBe(false);
  });
});
```

  Append to `apps/server/src/config.test.ts`, following its existing style:

```ts
it('caps the photo read budget at two minutes, and defaults to it', () => {
  expect(loadConfig({}).photoReadTimeoutMs).toBe(120_000);
  expect(loadConfig({ PHOTO_READ_TIMEOUT_MS: '5000' }).photoReadTimeoutMs).toBe(5_000);
  expect(loadConfig({ PHOTO_READ_TIMEOUT_MS: '999999' }).photoReadTimeoutMs).toBe(120_000);
});
```

  Run: `cd apps/server && npx jest --selectProjects=unit src/domain/jobs.test.ts src/config.test.ts`. Expected: FAIL.

- [ ] **Step 6: Implement the jobs and config.** Append to `apps/server/src/domain/jobs.ts`:

```ts
/** Phase 26. Reads one import's photo into rows. */
export const READ_PHOTO = 'read-photo';
export const READ_PHOTO_FAILED = 'read-photo-failed';
/** Phase 26. Looks up one row and chooses its sense. */
export const LOOK_UP_IMPORT_ITEM = 'look-up-import-item';
export const LOOK_UP_IMPORT_ITEM_FAILED = 'look-up-import-item-failed';

/** Phase 26 (spec D6). The most one read may take. A long handwritten list is a
 *  long answer. The environment may lower it (config.ts). */
export const PHOTO_READ_BUDGET_MS = 120_000;
/** Twice the budget, phase 19's rule. */
export const READ_PHOTO_EXPIRY_SECONDS = (2 * PHOTO_READ_BUDGET_MS) / 1000;
/** A row's longest chain is the lookup's main call, its reconciliation, then
 *  the match call, each within the lookup's 25 s: 75 s. 180 s leaves room, and
 *  a crashed worker's row is retried within three minutes. */
export const LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS = 180;

export const ReadPhotoPayloadSchema = z.object({ import_id: z.string().min(1) });
export type ReadPhotoPayload = z.infer<typeof ReadPhotoPayloadSchema>;

export const LookUpImportItemPayloadSchema = z.object({
  import_id: z.string().min(1),
  position: z.number().int().nonnegative(),
});
export type LookUpImportItemPayload = z.infer<typeof LookUpImportItemPayloadSchema>;
```

  Extend `JobPayloads` with the four names: each `READ_PHOTO*` maps to `ReadPhotoPayload`, and each `LOOK_UP_IMPORT_ITEM*` to `LookUpImportItemPayload`.

  In `apps/server/src/config.ts`, add `photoReadTimeoutMs: number` to `Config`, import `PHOTO_READ_BUDGET_MS`, and return:

```ts
    // Phase 26 (spec D6). A read's budget, capped like generation's: the
    // read-photo job expires at twice PHOTO_READ_BUDGET_MS.
    photoReadTimeoutMs: Math.min(
      Number(env.PHOTO_READ_TIMEOUT_MS) || PHOTO_READ_BUDGET_MS,
      PHOTO_READ_BUDGET_MS,
    ),
```

  In `apps/server/src/db/jobs.ts`, import the new names and append to `JOB_QUEUES`, keeping each dead-letter queue before the queue that names it:

```ts
  { name: READ_PHOTO_FAILED, options: { retryLimit: 2, deleteAfterSeconds: 86_400 } },
  {
    name: READ_PHOTO,
    options: {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: READ_PHOTO_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
      deadLetter: READ_PHOTO_FAILED,
    },
  },
  { name: LOOK_UP_IMPORT_ITEM_FAILED, options: { retryLimit: 2, deleteAfterSeconds: 86_400 } },
  {
    name: LOOK_UP_IMPORT_ITEM,
    options: {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS,
      deleteAfterSeconds: 86_400,
      deadLetter: LOOK_UP_IMPORT_ITEM_FAILED,
    },
  },
```

  Run Step 5's command. Expected: PASS.

- [ ] **Step 7: Add the integration check for the queues.** In `apps/server/tests/integration/db/jobs.test.ts`, add a test that queries `${JOB_SCHEMA}.queue` for the four new names, the same way `queues()` does for prepare-session, and asserts:
  - `read-photo`: `retry_limit 2`, `retry_backoff true`, `expire_seconds 240`, `deletion_seconds 86400`, `dead_letter 'read-photo-failed'`;
  - `look-up-import-item`: the same, with `expire_seconds 180` and `dead_letter 'look-up-import-item-failed'`.

  Run: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/db/jobs.test.ts`. Expected: PASS. The test template database migrates through `runMigrations`, which installs the queues.

- [ ] **Step 8: Typecheck, lint and commit.** Run `npm run typecheck` and `npm run lint:arch` from the root. Both should be clean.

```bash
git add apps/server/src/services/llm.ts apps/server/src/providers apps/server/src/domain/jobs.ts apps/server/src/domain/jobs.test.ts apps/server/src/db/jobs.ts apps/server/src/config.ts apps/server/src/config.test.ts apps/server/tests/integration/db/jobs.test.ts
git commit -m "feat(server): a vision client, the photo import queues and the read budget"
```

---

### Task 5: The tables and the repository

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0017_photo_imports.sql` and its `meta/` snapshot and journal entry, both generated
- Create: `apps/server/src/repo/photoImports.ts`
- Modify: `apps/server/src/services/transaction.ts`, `apps/server/src/composition.ts` (the `bind`), `apps/server/tests/support/fakes.ts` (`createFakeTransaction`)
- Test: `apps/server/tests/integration/repo/photoImports.test.ts`

**Interfaces:**
- Consumes: `StoredImportStatus`, `StoredItemStatus` (Task 3); `PhotoImportOption`, `PhotoImportItemReason` (Task 1).
- Produces, from `repo/photoImports.ts`:
  - `type PhotoImportRow = { id: string; enrollmentId: string; status: StoredImportStatus; photo: string | null; createdAt: Date }`;
  - `type PhotoImportListRow = { id: string; enrollmentId: string; status: StoredImportStatus; createdAt: Date; itemCount: number; settledCount: number; pendingCount: number }`;
  - `type PhotoImportItemRow = { importId: string; position: number; text: string; hebrew: string | null; status: StoredItemStatus; correctedForm: string | null; options: PhotoImportOption[]; suggestedSenseId: string | null; chosenSenseId: string | null; ticked: boolean; hebrewMismatch: boolean; reason: PhotoImportItemReason | null }`;
  - `type ItemResult = { correctedForm: string | null; options: PhotoImportOption[]; chosenSenseId: string | null; ticked: boolean; hebrewMismatch: boolean; reason: PhotoImportItemReason | null }`;
  - `createPhotoImportRepo(tx: Tx)`, with:
    - `insertImport({ enrollmentId, photo }) → { id, createdAt }`;
    - `deleteExpired({ enrollmentId, before: Date }) → number`;
    - `findImport(id) → PhotoImportRow | null`;
    - `listOpen({ enrollmentId, since: Date }) → PhotoImportListRow[]`;
    - `transition(id, from: StoredImportStatus[], to: StoredImportStatus) → boolean`, which always clears the photo;
    - `insertItems(importId, items: { position; text; hebrew }[]) → void`;
    - `listItems(importId) → PhotoImportItemRow[]`;
    - `findItem(importId, position) → PhotoImportItemRow | null`;
    - `writeItem(importId, position, result: ItemResult) → boolean`, conditional on `pending`;
    - `markItemFailed(importId, position) → boolean`, conditional on `pending`;
    - `updateItem(importId, position, update: { ticked?: boolean; chosenSenseId?: string }) → PhotoImportItemRow | null`;
  - `type PhotoImportRepo`;
  - `Repos.photoImport: PhotoImportRepo`.

- [ ] **Step 1: Write the failing integration test.** Create `apps/server/tests/integration/repo/photoImports.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createPhotoImportRepo } from '../../../src/repo/photoImports';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_1');
const repo = <T>(run: (r: ReturnType<typeof createPhotoImportRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => run(createPhotoImportRepo(tx)));

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await t.close();
});

const option = { sense_id: 's1', variant_id: 'v1', translation: 'חתול', part_of_speech: 'noun' };

describe('photo import repository', () => {
  it('creates an import reading with its photo, and clears the photo on every transition', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    expect(await repo((r) => r.findImport(id))).toMatchObject({ id, enrollmentId: E, status: 'reading', photo: 'QUJD' });

    expect(await repo((r) => r.transition(id, ['reading'], 'read'))).toBe(true);
    expect(await repo((r) => r.findImport(id))).toMatchObject({ status: 'read', photo: null });
    expect(await repo((r) => r.transition(id, ['reading'], 'failed'))).toBe(false);
  });

  it('refuses a photo on an import that is no longer reading', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    await repo((r) => r.transition(id, ['reading'], 'read'));
    await expect(t.db.execute(sql`update photo_imports set photo = 'x' where id = ${id}`)).rejects.toThrow(
      /photo_imports_photo_only_while_reading/,
    );
  });

  it('answers null, not an error, for an id that is not a uuid', async () => {
    expect(await repo((r) => r.findImport('nope'))).toBeNull();
  });

  it('writes rows pending, then a result once, and a failure only while pending', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    await repo((r) =>
      r.insertItems(id, [
        { position: 0, text: 'gatto', hebrew: 'חתול' },
        { position: 1, text: 'casa', hebrew: null },
      ]),
    );
    const result = { correctedForm: null, options: [option], chosenSenseId: 's1', ticked: true, hebrewMismatch: false, reason: null };
    expect(await repo((r) => r.writeItem(id, 0, result))).toBe(true);
    expect(await repo((r) => r.writeItem(id, 0, result))).toBe(false);
    expect(await repo((r) => r.markItemFailed(id, 0))).toBe(false);
    expect(await repo((r) => r.markItemFailed(id, 1))).toBe(true);

    const items = await repo((r) => r.listItems(id));
    expect(items.map((item) => [item.position, item.status])).toEqual([[0, 'ready'], [1, 'failed']]);
    expect(items[0]).toMatchObject({ options: [option], suggestedSenseId: 's1', chosenSenseId: 's1', ticked: true });
  });

  it('updates a tick and a sense, keeping the suggested sense', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    await repo((r) => r.insertItems(id, [{ position: 0, text: 'bank', hebrew: null }]));
    await repo((r) =>
      r.writeItem(id, 0, {
        correctedForm: null,
        options: [option, { ...option, sense_id: 's2', translation: 'גדה' }],
        chosenSenseId: 's1',
        ticked: true,
        hebrewMismatch: false,
        reason: null,
      }),
    );
    const updated = await repo((r) => r.updateItem(id, 0, { chosenSenseId: 's2', ticked: false }));
    expect(updated).toMatchObject({ chosenSenseId: 's2', suggestedSenseId: 's1', ticked: false });
    expect(await repo((r) => r.updateItem(id, 7, { ticked: false }))).toBeNull();
  });

  it('lists open imports newest first with their counts, and leaves out saved, discarded and old ones', async () => {
    const a = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'A' }));
    const b = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'B' }));
    const c = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'C' }));
    const d = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'D' }));
    await repo((r) => r.transition(a.id, ['reading'], 'read'));
    await repo((r) => r.insertItems(a.id, [{ position: 0, text: 'x', hebrew: null }, { position: 1, text: 'y', hebrew: null }]));
    await repo((r) => r.markItemFailed(a.id, 1));
    await repo((r) => r.transition(c.id, ['reading'], 'saved'));
    await repo((r) => r.transition(d.id, ['reading'], 'discarded'));
    await t.db.execute(sql`update photo_imports set created_at = now() - interval '1 minute' where id = ${a.id}`);

    const open = await repo((r) => r.listOpen({ enrollmentId: E, since: new Date(Date.now() - 60 * 60 * 1000) }));
    expect(open.map((row) => row.id)).toEqual([b.id, a.id]);
    expect(open[1]).toMatchObject({ status: 'read', itemCount: 2, settledCount: 1, pendingCount: 1 });
    expect(open[0]).toMatchObject({ status: 'reading', itemCount: 0, settledCount: 0, pendingCount: 0 });

    const later = await repo((r) => r.listOpen({ enrollmentId: E, since: new Date(Date.now() + 60 * 1000) }));
    expect(later).toEqual([]);
  });

  it('deletes an enrollment\'s imports older than a date, rows and all', async () => {
    const old = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'A' }));
    await repo((r) => r.insertItems(old.id, [{ position: 0, text: 'x', hebrew: null }]));
    const fresh = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'B' }));
    await t.db.execute(sql`update photo_imports set created_at = now() - interval '15 days' where id = ${old.id}`);

    expect(await repo((r) => r.deleteExpired({ enrollmentId: E, before: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }))).toBe(1);
    expect(await repo((r) => r.findImport(old.id))).toBeNull();
    expect(await repo((r) => r.listItems(old.id))).toEqual([]);
    expect(await repo((r) => r.findImport(fresh.id))).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/repo/photoImports.test.ts`
Expected: FAIL. The module and tables are missing.

- [ ] **Step 3: Add the tables.** Append to `apps/server/src/db/schema.ts`, importing `boolean` and `integer` from `drizzle-orm/pg-core` if they are not imported yet, and `PhotoImportOption` as a type from `@lang-tutor/core/api`:

```ts
/**
 * Phase 26. One photo of a word list (spec D4). `photo` is the base64 JPEG,
 * kept only until the read (spec D3): every transition clears it, and the
 * check below makes that a property of the table. `ready` is not a status: it
 * is `read` with no row pending.
 */
export const photoImports = pgTable(
  'photo_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrollmentId: text('enrollment_id').notNull(),
    status: text('status').notNull(),
    photo: text('photo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'photo_imports_enrollment_fk',
      columns: [t.enrollmentId],
      foreignColumns: [enrollments.id],
    }),
    check('photo_imports_status_known', sql`${t.status} in ('reading', 'read', 'failed', 'saved', 'discarded')`),
    check('photo_imports_photo_only_while_reading', sql`${t.photo} is null or ${t.status} = 'reading'`),
    // The list and the cleanup both read one enrollment's imports by age.
    index('photo_imports_enrollment_created_idx').on(t.enrollmentId, t.createdAt),
  ],
);

/**
 * Phase 26. One word or phrase read from an import's photo, with its lookup's
 * saveable senses as a snapshot (`options`), the sense the job chose
 * (`suggested_sense_id`, never changed after) and the learner's choice.
 */
export const photoImportItems = pgTable(
  'photo_import_items',
  {
    importId: uuid('import_id').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    hebrew: text('hebrew'),
    status: text('status').notNull(),
    correctedForm: text('corrected_form'),
    options: jsonb('options').$type<PhotoImportOption[]>().notNull().default(sql`'[]'::jsonb`),
    suggestedSenseId: text('suggested_sense_id'),
    chosenSenseId: text('chosen_sense_id'),
    ticked: boolean('ticked').notNull().default(false),
    hebrewMismatch: boolean('hebrew_mismatch').notNull().default(false),
    reason: text('reason'),
  },
  (t) => [
    primaryKey({ name: 'photo_import_items_pkey', columns: [t.importId, t.position] }),
    foreignKey({
      name: 'photo_import_items_import_fk',
      columns: [t.importId],
      foreignColumns: [photoImports.id],
    }).onDelete('cascade'),
    check('photo_import_items_status_known', sql`${t.status} in ('pending', 'ready', 'failed')`),
    check(
      'photo_import_items_reason_known',
      sql`${t.reason} is null or ${t.reason} in ('sentence', 'no_meaning', 'not_in_language')`,
    ),
    check('photo_import_items_tick_needs_sense', sql`not ${t.ticked} or ${t.chosenSenseId} is not null`),
  ],
);
```

- [ ] **Step 4: Generate the migration.**
Run: `cd apps/server && npx drizzle-kit generate --name photo_imports`
Expected: a new `src/db/migrations/0017_photo_imports.sql` holding exactly two `CREATE TABLE`s, their constraints and the index, plus `meta/0017_snapshot.json` and a new `meta/_journal.json` entry. Open the SQL and check it touches no existing table. Then `npm run db:migrate` from the worktree root. Expected: the lane's database is migrated.

- [ ] **Step 5: Implement the repository.** Create `apps/server/src/repo/photoImports.ts`:

```ts
import type { PhotoImportItemReason, PhotoImportOption } from '@lang-tutor/core/api';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { photoImportItems, photoImports } from '../db/schema';
import type { StoredImportStatus, StoredItemStatus } from '../domain/photoImports';

// An id that is not a uuid is "no such import", not a Postgres type error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PhotoImportRow = {
  id: string;
  enrollmentId: string;
  status: StoredImportStatus;
  photo: string | null;
  createdAt: Date;
};

export type PhotoImportListRow = {
  id: string;
  enrollmentId: string;
  status: StoredImportStatus;
  createdAt: Date;
  itemCount: number;
  settledCount: number;
  pendingCount: number;
};

export type PhotoImportItemRow = {
  importId: string;
  position: number;
  text: string;
  hebrew: string | null;
  status: StoredItemStatus;
  correctedForm: string | null;
  options: PhotoImportOption[];
  suggestedSenseId: string | null;
  chosenSenseId: string | null;
  ticked: boolean;
  hebrewMismatch: boolean;
  reason: PhotoImportItemReason | null;
};

/** What a row's lookup decided (spec D7). */
export type ItemResult = {
  correctedForm: string | null;
  options: PhotoImportOption[];
  chosenSenseId: string | null;
  ticked: boolean;
  hebrewMismatch: boolean;
  reason: PhotoImportItemReason | null;
};

const itemColumns = {
  importId: photoImportItems.importId,
  position: photoImportItems.position,
  text: photoImportItems.text,
  hebrew: photoImportItems.hebrew,
  status: photoImportItems.status,
  correctedForm: photoImportItems.correctedForm,
  options: photoImportItems.options,
  suggestedSenseId: photoImportItems.suggestedSenseId,
  chosenSenseId: photoImportItems.chosenSenseId,
  ticked: photoImportItems.ticked,
  hebrewMismatch: photoImportItems.hebrewMismatch,
  reason: photoImportItems.reason,
};

const asItem = (row: typeof photoImportItems.$inferSelect | Record<keyof typeof itemColumns, unknown>) =>
  row as unknown as PhotoImportItemRow;

const itemKey = (importId: string, position: number) =>
  and(eq(photoImportItems.importId, importId), eq(photoImportItems.position, position));

/** Phase 26. Persistence primitives of an import and its rows (ADR 0001 R9). */
export function createPhotoImportRepo(tx: Tx) {
  return {
    insertImport: async (input: { enrollmentId: string; photo: string }): Promise<{ id: string; createdAt: Date }> => {
      const [row] = await tx
        .insert(photoImports)
        .values({ enrollmentId: input.enrollmentId, status: 'reading', photo: input.photo })
        .returning({ id: photoImports.id, createdAt: photoImports.createdAt });
      return row;
    },

    /** Spec D10's cleanup. The rows go with their import (ON DELETE CASCADE). */
    deleteExpired: async (input: { enrollmentId: string; before: Date }): Promise<number> => {
      const rows = await tx
        .delete(photoImports)
        .where(and(eq(photoImports.enrollmentId, input.enrollmentId), lt(photoImports.createdAt, input.before)))
        .returning({ id: photoImports.id });
      return rows.length;
    },

    findImport: async (id: string): Promise<PhotoImportRow | null> => {
      if (!UUID_RE.test(id)) return null;
      const [row] = await tx.select().from(photoImports).where(eq(photoImports.id, id));
      return row ? { ...row, status: row.status as StoredImportStatus } : null;
    },

    /** Open imports (not saved or discarded, made since `since`) with their row
     *  counts, newest first. One enrollment's, served by the enrollment index. */
    listOpen: async (input: { enrollmentId: string; since: Date }): Promise<PhotoImportListRow[]> => {
      const rows = await tx.execute<{
        id: string;
        enrollment_id: string;
        status: string;
        created_at: Date | string;
        item_count: number;
        settled_count: number;
      }>(sql`
        SELECT i.id, i.enrollment_id, i.status, i.created_at,
               count(it.position)::int AS item_count,
               (count(it.position) FILTER (WHERE it.status <> 'pending'))::int AS settled_count
        FROM photo_imports i
        LEFT JOIN photo_import_items it ON it.import_id = i.id
        WHERE i.enrollment_id = ${input.enrollmentId}
          AND i.status NOT IN ('saved', 'discarded')
          AND i.created_at >= ${input.since.toISOString()}::timestamptz
        GROUP BY i.id
        ORDER BY i.created_at DESC`);
      return rows.rows.map((row) => ({
        id: row.id,
        enrollmentId: row.enrollment_id,
        status: row.status as StoredImportStatus,
        createdAt: new Date(row.created_at),
        itemCount: row.item_count,
        settledCount: row.settled_count,
        pendingCount: row.item_count - row.settled_count,
      }));
    },

    /** Conditional, like a session's: false when the import was not in `from`.
     *  Always clears the photo, since no transition leads back to `reading`. */
    transition: async (id: string, from: StoredImportStatus[], to: StoredImportStatus): Promise<boolean> => {
      if (!UUID_RE.test(id)) return false;
      const rows = await tx
        .update(photoImports)
        .set({ status: to, photo: null })
        .where(and(eq(photoImports.id, id), inArray(photoImports.status, from)))
        .returning({ id: photoImports.id });
      return rows.length > 0;
    },

    insertItems: async (
      importId: string,
      items: { position: number; text: string; hebrew: string | null }[],
    ): Promise<void> => {
      if (items.length === 0) return;
      await tx
        .insert(photoImportItems)
        .values(items.map((item) => ({ importId, position: item.position, text: item.text, hebrew: item.hebrew, status: 'pending' })));
    },

    listItems: async (importId: string): Promise<PhotoImportItemRow[]> => {
      if (!UUID_RE.test(importId)) return [];
      const rows = await tx
        .select(itemColumns)
        .from(photoImportItems)
        .where(eq(photoImportItems.importId, importId))
        .orderBy(asc(photoImportItems.position));
      return rows.map(asItem);
    },

    findItem: async (importId: string, position: number): Promise<PhotoImportItemRow | null> => {
      if (!UUID_RE.test(importId)) return null;
      const [row] = await tx.select(itemColumns).from(photoImportItems).where(itemKey(importId, position));
      return row ? asItem(row) : null;
    },

    /** The job's write, once: only a pending row takes it. */
    writeItem: async (importId: string, position: number, result: ItemResult): Promise<boolean> => {
      const rows = await tx
        .update(photoImportItems)
        .set({
          status: 'ready',
          correctedForm: result.correctedForm,
          options: result.options,
          suggestedSenseId: result.chosenSenseId,
          chosenSenseId: result.chosenSenseId,
          ticked: result.ticked,
          hebrewMismatch: result.hebrewMismatch,
          reason: result.reason,
        })
        .where(and(itemKey(importId, position), eq(photoImportItems.status, 'pending')))
        .returning({ position: photoImportItems.position });
      return rows.length > 0;
    },

    markItemFailed: async (importId: string, position: number): Promise<boolean> => {
      if (!UUID_RE.test(importId)) return false;
      const rows = await tx
        .update(photoImportItems)
        .set({ status: 'failed', ticked: false })
        .where(and(itemKey(importId, position), eq(photoImportItems.status, 'pending')))
        .returning({ position: photoImportItems.position });
      return rows.length > 0;
    },

    /** The learner's change. The service has already checked it (domain
     *  refuseItemUpdate). */
    updateItem: async (
      importId: string,
      position: number,
      update: { ticked?: boolean; chosenSenseId?: string },
    ): Promise<PhotoImportItemRow | null> => {
      if (!UUID_RE.test(importId)) return null;
      const [row] = await tx
        .update(photoImportItems)
        .set({
          ...(update.ticked !== undefined ? { ticked: update.ticked } : {}),
          ...(update.chosenSenseId !== undefined ? { chosenSenseId: update.chosenSenseId } : {}),
        })
        .where(itemKey(importId, position))
        .returning(itemColumns);
      return row ? asItem(row) : null;
    },
  };
}

export type PhotoImportRepo = ReturnType<typeof createPhotoImportRepo>;
```

  `asItem` is a cast, because the text columns hold the checked status and reason values. If `tsc` refuses the union parameter, simplify it to `(row: Record<string, unknown>) => row as unknown as PhotoImportItemRow`.

- [ ] **Step 6: Bind it.**
  - In `apps/server/src/services/transaction.ts`, add `import type { PhotoImportRepo } from '../repo/photoImports';` and `photoImport: PhotoImportRepo;` to `Repos`.
  - In `apps/server/src/composition.ts`, add `photoImport: createPhotoImportRepo(tx),` to the `createTransaction` bind, importing `createPhotoImportRepo`.
  - In `apps/server/tests/support/fakes.ts`, add `photoImport: repos.photoImport ?? unreachableRepo('photo import repo'),` to `createFakeTransaction`.

- [ ] **Step 7: Run the tests and confirm they pass.**
Run Step 2's command. Expected: PASS (7 tests). Then from the root: `npm run typecheck`, `npm run lint:arch`, and `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/db/migrations.test.ts tests/integration/db/schema.test.ts`. Expected: PASS. If `schema.test.ts` lists every table, add the two new ones there.

- [ ] **Step 8: Commit.**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations apps/server/src/repo/photoImports.ts apps/server/src/services/transaction.ts apps/server/src/composition.ts apps/server/tests/support/fakes.ts apps/server/tests/integration/repo/photoImports.test.ts apps/server/tests/integration/db
git commit -m "feat(server): photo import tables, with the photo kept only while reading"
```

---
### Task 6: The learner's use cases: create, list, get, change a row, save, discard

**Files:**
- Modify: `apps/server/src/errors.ts`
- Create: `apps/server/src/services/photoImports.ts`
- Test: `apps/server/src/services/photoImports.test.ts`

**Interfaces:**
- Consumes:
  - Task 3: `deriveStatus`, `isOpen`, `refuseItemUpdate`, `entriesToSave`, `reviewCounts`, `IMPORT_TTL_MS`, `ItemUpdate`;
  - Task 4: `READ_PHOTO`;
  - Task 5: `PhotoImportRow`, `PhotoImportItemRow` and the repository;
  - `firstPerSense` from `domain/vocabulary`;
  - `Repos.vocabulary.findSaveable` and `insertEntries`, as `services/vocabulary.ts` uses them.
- Produces:
  - `createPhotoImportService({ transaction, vision, llm, lookup, now, logger })`, whose dependency types are `Transaction`, `VisionClient`, `LlmClient`, `lookup: (input: TranslationRequest) => Promise<TranslationResponse>`, `now: () => number` and `Logger`;
  - this task's methods:
    - `create(enrollmentId, request: PhotoImportCreateRequest) → PhotoImportSummary`;
    - `list(enrollmentId) → PhotoImportSummary[]`;
    - `get(importId) → PhotoImport`;
    - `updateItem(importId, position, update: ItemUpdate) → PhotoImportItem`;
    - `save(importId) → SaveVocabularyResponse`;
    - `discard(importId) → void`;
  - `type PhotoImportService = ReturnType<typeof createPhotoImportService>`;
  - in `errors.ts`:
    - `PhotoImportNotFound(importId, position?)`, which maps to 404;
    - `PhotoImportConflict(importId, reason)`, which maps to 409;
    - `InvalidPhotoImportItem(importId, position, reason)`, which maps to 400;
    - `PhotoUnreadable(importId)` and `SenseMatchUnreadable(importId, position)`, which a job throws to get a retry.

- [ ] **Step 1: Add the errors.** Append to `apps/server/src/errors.ts`, in its style:

```ts
// Phase 26. An import, or a row of one, that does not exist.
export class PhotoImportNotFound extends Error {
  constructor(readonly importId: string, readonly position?: number) {
    super(position === undefined ? `no photo import ${importId}` : `no row ${position} in photo import ${importId}`);
    this.name = 'PhotoImportNotFound';
  }
}

// Phase 26. The import is in the wrong state for the request: a row still
// being looked up, an import saved or discarded, a save before it is ready (409).
export class PhotoImportConflict extends Error {
  constructor(readonly importId: string, readonly reason: string) {
    super(`photo import ${importId}: ${reason}`);
    this.name = 'PhotoImportConflict';
  }
}

// Phase 26. A change a row cannot take: a sense that is not one of its options,
// or a tick on a row with none (400).
export class InvalidPhotoImportItem extends Error {
  constructor(readonly importId: string, readonly position: number, readonly reason: string) {
    super(`photo import ${importId} row ${position}: ${reason}`);
    this.name = 'InvalidPhotoImportItem';
  }
}

// Phase 26. The reader's answer was not the schema. Thrown inside a job, so
// pg-boss retries it.
export class PhotoUnreadable extends Error {
  constructor(readonly importId: string) {
    super(`the reading of photo import ${importId} was unreadable`);
    this.name = 'PhotoUnreadable';
  }
}

// Phase 26. The match call's answer was not the schema. A retry, like the above.
export class SenseMatchUnreadable extends Error {
  constructor(readonly importId: string, readonly position: number) {
    super(`the sense match for photo import ${importId} row ${position} was unreadable`);
    this.name = 'SenseMatchUnreadable';
  }
}
```

- [ ] **Step 2: Write the failing unit tests.** Create `apps/server/src/services/photoImports.test.ts`. Use the fakes in `apps/server/tests/support/fakes.ts`: `stub`, `createFakeTransaction`, `createFakeLogger`, `createFakeJobRepo`, `createFakeLlmClient`, `createFakeClock`. The repository is a `stub<PhotoImportRepo>` that records calls:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Enrollment } from '@lang-tutor/core/api';

import { IMPORT_TTL_MS } from '../domain/photoImports';
import { READ_PHOTO } from '../domain/jobs';
import { EnrollmentNotFound, InvalidPhotoImportItem, InvalidVocabularyEntry, PhotoImportConflict, PhotoImportNotFound } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { PhotoImportItemRow, PhotoImportRepo, PhotoImportRow } from '../repo/photoImports';
import type { VocabularyRepo } from '../repo/vocabulary';
import {
  createFakeClock,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  stub,
} from '../../tests/support/fakes';
import type { Repos } from './transaction';
import { createPhotoImportService } from './photoImports';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ENROLLMENT: Enrollment = { id: 'e1', source_language: 'he', target_language: 'it' } as Enrollment;
const ID = '11111111-1111-1111-1111-111111111111';

const importRow = (over: Partial<PhotoImportRow> = {}): PhotoImportRow => ({
  id: ID,
  enrollmentId: 'e1',
  status: 'read',
  photo: null,
  createdAt: new Date(NOW - 60_000),
  ...over,
});
const option = (n: number) => ({ sense_id: `s${n}`, variant_id: `v${n}`, translation: `t${n}` });
const itemRow = (over: Partial<PhotoImportItemRow> = {}): PhotoImportItemRow => ({
  importId: ID,
  position: 0,
  text: 'gatto',
  hebrew: null,
  status: 'ready',
  correctedForm: null,
  options: [option(1), option(2)],
  suggestedSenseId: 's1',
  chosenSenseId: 's1',
  ticked: true,
  hebrewMismatch: false,
  reason: null,
  ...over,
});

function setup(repos: Partial<Repos>) {
  const logger = createFakeLogger();
  const service = createPhotoImportService({
    transaction: createFakeTransaction(repos),
    vision: async () => {
      throw new Error('vision is not called by these use cases');
    },
    llm: createFakeLlmClient(''),
    lookup: async () => {
      throw new Error('lookup is not called by these use cases');
    },
    now: createFakeClock(NOW),
    logger,
  });
  return { service, logger };
}

const enrollmentRepo = (found: Enrollment | null) => stub<EnrollmentRepo>({ findById: async () => found });

describe('create', () => {
  it('stores the photo, clears expired imports and enqueues the read in the same transaction', async () => {
    const jobs = createFakeJobRepo();
    const calls: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      deleteExpired: async (input) => {
        calls.push(['deleteExpired', input]);
        return 0;
      },
      insertImport: async (input) => {
        calls.push(['insertImport', input]);
        return { id: ID, createdAt: new Date(NOW) };
      },
    });
    const { service, logger } = setup({ enrollment: enrollmentRepo(ENROLLMENT), photoImport, jobs });

    const summary = await service.create('e1', { mime_type: 'image/jpeg', image: 'QUJD' });

    expect(summary).toEqual({ id: ID, status: 'reading', item_count: 0, settled_count: 0, created_at: new Date(NOW).toISOString() });
    expect(calls).toEqual([
      ['deleteExpired', { enrollmentId: 'e1', before: new Date(NOW - IMPORT_TTL_MS) }],
      ['insertImport', { enrollmentId: 'e1', photo: 'QUJD' }],
    ]);
    expect(jobs.enqueued).toEqual([{ name: READ_PHOTO, data: { import_id: ID } }]);
    expect(logger.events).toContainEqual({ event: 'photo_import_created', import_id: ID, enrollment_id: 'e1', bytes: 4 });
    expect(JSON.stringify(logger.events)).not.toContain('QUJD');
  });

  it('refuses an unknown enrollment and enqueues nothing', async () => {
    const jobs = createFakeJobRepo();
    const { service } = setup({ enrollment: enrollmentRepo(null), photoImport: stub<PhotoImportRepo>({}), jobs });
    await expect(service.create('nope', { mime_type: 'image/jpeg', image: 'QUJD' })).rejects.toBeInstanceOf(EnrollmentNotFound);
    expect(jobs.enqueued).toEqual([]);
  });
});

describe('get', () => {
  it('derives looking_up while a row is pending, and counts settled rows', async () => {
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow(),
      listItems: async () => [itemRow(), itemRow({ position: 1, status: 'pending', options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false })],
    });
    const { service } = setup({ photoImport });
    const found = await service.get(ID);
    expect(found).toMatchObject({ id: ID, status: 'looking_up', item_count: 2, settled_count: 1 });
    expect(found.items[0]).toEqual({
      position: 0, text: 'gatto', hebrew: null, status: 'ready', corrected_form: null,
      options: [option(1), option(2)], chosen_sense_id: 's1', ticked: true, hebrew_mismatch: false, reason: null,
    });
  });

  it('answers PhotoImportNotFound for a missing import', async () => {
    const { service } = setup({ photoImport: stub<PhotoImportRepo>({ findImport: async () => null }) });
    await expect(service.get(ID)).rejects.toBeInstanceOf(PhotoImportNotFound);
  });
});

describe('updateItem', () => {
  const repoWith = (item: PhotoImportItemRow, row: PhotoImportRow = importRow()) => {
    const updates: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => row,
      findItem: async () => item,
      updateItem: async (_id, _position, update) => {
        updates.push(update);
        return { ...item, ...(update.ticked !== undefined ? { ticked: update.ticked } : {}), ...(update.chosenSenseId ? { chosenSenseId: update.chosenSenseId } : {}) };
      },
    });
    return { photoImport, updates };
  };

  it('switches the sense and unticks', async () => {
    const { photoImport, updates } = repoWith(itemRow());
    const { service } = setup({ photoImport });
    const item = await service.updateItem(ID, 0, { sense_id: 's2', ticked: false });
    expect(updates).toEqual([{ chosenSenseId: 's2', ticked: false }]);
    expect(item).toMatchObject({ chosen_sense_id: 's2', ticked: false });
  });

  it('refuses any change to a row whose lookup has not landed, and writes nothing (Review Focus 2)', async () => {
    const { photoImport, updates } = repoWith(itemRow({ status: 'pending' }));
    const { service } = setup({ photoImport });
    await expect(service.updateItem(ID, 0, { ticked: false })).rejects.toBeInstanceOf(PhotoImportConflict);
    expect(updates).toEqual([]);
  });

  it('refuses a sense outside the options as an invalid row change', async () => {
    const { photoImport } = repoWith(itemRow());
    const { service } = setup({ photoImport });
    await expect(service.updateItem(ID, 0, { sense_id: 's9' })).rejects.toBeInstanceOf(InvalidPhotoImportItem);
  });

  it('refuses a change to a discarded or expired import', async () => {
    for (const row of [importRow({ status: 'discarded' }), importRow({ createdAt: new Date(NOW - IMPORT_TTL_MS) })]) {
      const { photoImport } = repoWith(itemRow(), row);
      const { service } = setup({ photoImport });
      await expect(service.updateItem(ID, 0, { ticked: false })).rejects.toBeInstanceOf(PhotoImportConflict);
    }
  });

  it('answers PhotoImportNotFound for a row that does not exist', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImport: async () => importRow(), findItem: async () => null });
    const { service } = setup({ photoImport });
    await expect(service.updateItem(ID, 9, { ticked: false })).rejects.toBeInstanceOf(PhotoImportNotFound);
  });
});

describe('save', () => {
  const saveable = (n: number) => ({ senseId: `s${n}`, variantId: `v${n}`, lexemeId: `l${n}`, lemma: `w${n}` });

  it('saves the ticked rows’ chosen senses, marks the import saved, and logs how the review changed them', async () => {
    const inserted: unknown[] = [];
    const transitions: unknown[] = [];
    const items = [
      itemRow({ position: 0 }),
      itemRow({ position: 1, chosenSenseId: 's2' }),
      itemRow({ position: 2, ticked: false }),
    ];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow(),
      listItems: async () => items,
      transition: async (...args) => {
        transitions.push(args);
        return true;
      },
    });
    const vocabulary = stub<VocabularyRepo>({
      findSaveable: async () => [saveable(1), saveable(2)],
      insertEntries: async (input) => {
        inserted.push(input);
      },
    });
    const { service, logger } = setup({ photoImport, vocabulary, enrollment: enrollmentRepo(ENROLLMENT) });

    expect(await service.save(ID)).toEqual({ saved_sense_ids: ['s1', 's2'] });
    expect(inserted).toEqual([{ enrollmentId: 'e1', entries: [saveable(1), saveable(2)] }]);
    expect(transitions).toEqual([[ID, ['read'], 'saved']]);
    expect(logger.events).toContainEqual({ event: 'photo_import_saved', import_id: ID, saved_count: 2, unticked_count: 1, changed_sense_count: 1 });
  });

  it('answers a repeated save with the same ids and writes nothing', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImport: async () => importRow({ status: 'saved' }), listItems: async () => [itemRow()] });
    const { service } = setup({ photoImport, vocabulary: stub<VocabularyRepo>({}) });
    expect(await service.save(ID)).toEqual({ saved_sense_ids: ['s1'] });
  });

  it('refuses a save while a row is pending, or once discarded', async () => {
    for (const [row, items] of [
      [importRow(), [itemRow(), itemRow({ position: 1, status: 'pending' })]],
      [importRow({ status: 'discarded' }), [itemRow()]],
      [importRow({ status: 'reading' }), []],
    ] as const) {
      const photoImport = stub<PhotoImportRepo>({ findImport: async () => row, listItems: async () => [...items] });
      const { service } = setup({ photoImport, vocabulary: stub<VocabularyRepo>({}) });
      await expect(service.save(ID)).rejects.toBeInstanceOf(PhotoImportConflict);
    }
  });

  it('is all or nothing: a refused sense throws before anything is written', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImport: async () => importRow(), listItems: async () => [itemRow()] });
    const vocabulary = stub<VocabularyRepo>({ findSaveable: async () => [] });
    const { service } = setup({ photoImport, vocabulary, enrollment: enrollmentRepo(ENROLLMENT) });
    await expect(service.save(ID)).rejects.toBeInstanceOf(InvalidVocabularyEntry);
  });

  it('refuses when a discard won the race to the final transition', async () => {
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow(),
      listItems: async () => [itemRow()],
      transition: async () => false,
    });
    const vocabulary = stub<VocabularyRepo>({ findSaveable: async () => [saveable(1)], insertEntries: async () => undefined });
    const { service } = setup({ photoImport, vocabulary, enrollment: enrollmentRepo(ENROLLMENT) });
    await expect(service.save(ID)).rejects.toBeInstanceOf(PhotoImportConflict);
  });
});

describe('discard', () => {
  it('discards an open import, and a second discard changes nothing', async () => {
    const transitions: unknown[] = [];
    const repoFor = (row: PhotoImportRow) =>
      stub<PhotoImportRepo>({
        findImport: async () => row,
        transition: async (...args) => {
          transitions.push(args);
          return true;
        },
      });
    await setup({ photoImport: repoFor(importRow({ status: 'reading' })) }).service.discard(ID);
    await setup({ photoImport: repoFor(importRow({ status: 'discarded' })) }).service.discard(ID);
    expect(transitions).toEqual([[ID, ['reading', 'read', 'failed'], 'discarded']]);
  });

  it('refuses to discard a saved import', async () => {
    const { service } = setup({ photoImport: stub<PhotoImportRepo>({ findImport: async () => importRow({ status: 'saved' }) }) });
    await expect(service.discard(ID)).rejects.toBeInstanceOf(PhotoImportConflict);
  });
});
```

  `createFakeLogger()` records `info` events. Check its field name in `tests/support/fakes.ts`, which may be `events` or `infos`, and use it. If `createFakeTransaction` lacks `photoImport`, Task 5 Step 6 was skipped: do that first.

- [ ] **Step 3: Run the tests and confirm they fail.**
Run: `cd apps/server && npx jest --selectProjects=unit src/services/photoImports.test.ts`
Expected: FAIL. Cannot find module `./photoImports`.

- [ ] **Step 4: Implement.** Create `apps/server/src/services/photoImports.ts`:

```ts
import type {
  PhotoImport,
  PhotoImportCreateRequest,
  PhotoImportItem,
  PhotoImportSummary,
  SaveVocabularyResponse,
  TranslationRequest,
  TranslationResponse,
} from '@lang-tutor/core/api';

import { READ_PHOTO } from '../domain/jobs';
import {
  IMPORT_TTL_MS,
  deriveStatus,
  entriesToSave,
  isOpen,
  refuseItemUpdate,
  reviewCounts,
  type ItemUpdate,
} from '../domain/photoImports';
import { firstPerSense } from '../domain/vocabulary';
import {
  EnrollmentNotFound,
  InvalidPhotoImportItem,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
} from '../errors';
import type { Logger } from '../logger';
import type { PhotoImportItemRow, PhotoImportRow } from '../repo/photoImports';
import type { LlmClient, VisionClient } from './llm';
import type { Transaction } from './transaction';

function toItem(row: PhotoImportItemRow): PhotoImportItem {
  return {
    position: row.position,
    text: row.text,
    hebrew: row.hebrew,
    status: row.status,
    corrected_form: row.correctedForm,
    options: row.options,
    chosen_sense_id: row.chosenSenseId,
    ticked: row.ticked,
    hebrew_mismatch: row.hebrewMismatch,
    reason: row.reason,
  };
}

function toImport(row: PhotoImportRow, items: PhotoImportItemRow[]): PhotoImport {
  const pending = items.filter((item) => item.status === 'pending').length;
  return {
    id: row.id,
    status: deriveStatus(row.status, pending),
    item_count: items.length,
    settled_count: items.length - pending,
    created_at: row.createdAt.toISOString(),
    items: items.map(toItem),
  };
}

/**
 * Phase 26. Words from a photo: an import's use cases. The learner's are here.
 * The two the queues call (readPhoto, lookUpItem) and their dead-letter
 * handlers follow (spec D2).
 *
 * `lookup` is today's lookup use case, TranslationService['translate'], handed
 * over by the composition root as a closure (spec D7). Its dictionary writes
 * are its own independent, idempotent transactions (ADR 0001 R8). The one
 * dependent write a row job makes is the row itself.
 */
export function createPhotoImportService({
  transaction,
  vision,
  llm,
  lookup,
  now,
  logger,
}: {
  transaction: Transaction;
  vision: VisionClient;
  llm: LlmClient;
  lookup: (input: TranslationRequest) => Promise<TranslationResponse>;
  now: () => number;
  logger: Logger;
}) {
  return {
    /** The upload: one transaction stores the photo and enqueues its read
     *  (ADR 0007). Creating also clears the enrollment's expired imports
     *  (spec D10). */
    create: async (enrollmentId: string, request: PhotoImportCreateRequest): Promise<PhotoImportSummary> => {
      const created = await transaction(async ({ enrollment, photoImport, jobs }) => {
        if (!(await enrollment.findById(enrollmentId))) throw new EnrollmentNotFound(enrollmentId);
        await photoImport.deleteExpired({ enrollmentId, before: new Date(now() - IMPORT_TTL_MS) });
        const row = await photoImport.insertImport({ enrollmentId, photo: request.image });
        await jobs.enqueue(READ_PHOTO, { import_id: row.id });
        return row;
      });
      logger.info({
        event: 'photo_import_created',
        import_id: created.id,
        enrollment_id: enrollmentId,
        bytes: request.image.length,
      });
      return {
        id: created.id,
        status: 'reading',
        item_count: 0,
        settled_count: 0,
        created_at: created.createdAt.toISOString(),
      };
    },

    list: async (enrollmentId: string): Promise<PhotoImportSummary[]> =>
      transaction(async ({ enrollment, photoImport }) => {
        if (!(await enrollment.findById(enrollmentId))) throw new EnrollmentNotFound(enrollmentId);
        const rows = await photoImport.listOpen({ enrollmentId, since: new Date(now() - IMPORT_TTL_MS) });
        return rows.map((row) => ({
          id: row.id,
          status: deriveStatus(row.status, row.pendingCount),
          item_count: row.itemCount,
          settled_count: row.settledCount,
          created_at: row.createdAt.toISOString(),
        }));
      }),

    get: async (importId: string): Promise<PhotoImport> =>
      transaction(async ({ photoImport }) => {
        const row = await photoImport.findImport(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        return toImport(row, await photoImport.listItems(importId));
      }),

    updateItem: async (importId: string, position: number, update: ItemUpdate): Promise<PhotoImportItem> =>
      transaction(async ({ photoImport }) => {
        const row = await photoImport.findImport(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        if (!isOpen(row.status, row.createdAt, now())) throw new PhotoImportConflict(importId, 'not open');
        const item = await photoImport.findItem(importId, position);
        if (!item) throw new PhotoImportNotFound(importId, position);
        const refusal = refuseItemUpdate(item, update);
        if (refusal === 'not_ready') throw new PhotoImportConflict(importId, `row ${position} is not ready`);
        if (refusal) throw new InvalidPhotoImportItem(importId, position, refusal);
        const updated = await photoImport.updateItem(importId, position, {
          ...(update.ticked !== undefined ? { ticked: update.ticked } : {}),
          ...(update.sense_id !== undefined ? { chosenSenseId: update.sense_id } : {}),
        });
        if (!updated) throw new PhotoImportNotFound(importId, position);
        return toItem(updated);
      }),

    /**
     * Spec D11. One transaction: the entries checked as today's save checks
     * them, inserted, and the import marked saved. These writes are dependent,
     * so a refused sense or a lost race rolls all of them back. A repeated save
     * answers the same ids and writes nothing, which covers a save whose
     * response was lost.
     */
    save: async (importId: string): Promise<SaveVocabularyResponse> => {
      const outcome = await transaction(async ({ photoImport, enrollment, vocabulary }) => {
        const row = await photoImport.findImport(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        const items = await photoImport.listItems(importId);
        const entries = firstPerSense(entriesToSave(items));
        if (row.status === 'saved') return { entries, items, repeated: true };
        const ready =
          row.status === 'read' &&
          isOpen(row.status, row.createdAt, now()) &&
          !items.some((item) => item.status === 'pending');
        if (!ready) throw new PhotoImportConflict(importId, 'not ready to save');

        const enrolled = await enrollment.findById(row.enrollmentId);
        if (!enrolled) throw new EnrollmentNotFound(row.enrollmentId);
        const saveable = await vocabulary.findSaveable({
          entries: entries.map((entry) => ({ senseId: entry.sense_id, variantId: entry.variant_id })),
          targetLanguage: enrolled.target_language,
          sourceLanguage: enrolled.source_language,
        });
        const passed = new Set(saveable.map((entry) => `${entry.senseId} ${entry.variantId}`));
        const refused = entries.find((entry) => !passed.has(`${entry.sense_id} ${entry.variant_id}`));
        if (refused) throw new InvalidVocabularyEntry(refused.sense_id);
        await vocabulary.insertEntries({ enrollmentId: row.enrollmentId, entries: saveable });
        // Conditional: a discard that landed first wins, and the throw rolls
        // the inserts back.
        if (!(await photoImport.transition(importId, ['read'], 'saved'))) {
          throw new PhotoImportConflict(importId, 'not ready to save');
        }
        return { entries, items, repeated: false };
      });
      if (!outcome.repeated) {
        const counts = reviewCounts(outcome.items);
        logger.info({
          event: 'photo_import_saved',
          import_id: importId,
          saved_count: outcome.entries.length,
          unticked_count: counts.unticked,
          changed_sense_count: counts.changedSense,
        });
      }
      return { saved_sense_ids: outcome.entries.map((entry) => entry.sense_id) };
    },

    /** Idempotent on a discarded import. A saved one is refused (409). */
    discard: async (importId: string): Promise<void> => {
      const discarded = await transaction(async ({ photoImport }) => {
        const row = await photoImport.findImport(importId);
        if (!row) throw new PhotoImportNotFound(importId);
        if (row.status === 'discarded') return false;
        if (row.status === 'saved') throw new PhotoImportConflict(importId, 'already saved');
        if (await photoImport.transition(importId, ['reading', 'read', 'failed'], 'discarded')) return true;
        // Lost a race: to another discard (fine), or to a save (refused).
        const after = await photoImport.findImport(importId);
        if (after?.status === 'discarded') return false;
        throw new PhotoImportConflict(importId, 'already saved');
      });
      if (discarded) logger.info({ event: 'photo_import_discarded', import_id: importId });
    },
  };
}

export type PhotoImportService = ReturnType<typeof createPhotoImportService>;
```

  `vision`, `llm` and `lookup` are unused until Task 7. If `tsc` or the linter complains about unused bindings, reference them in Task 7 and leave them destructured here.

- [ ] **Step 5: Run the tests and confirm they pass.** Run Step 3's command. Expected: PASS. Then `npm run typecheck` and `npm run lint:arch` from the root.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/errors.ts apps/server/src/services/photoImports.ts apps/server/src/services/photoImports.test.ts
git commit -m "feat(server): create, review and save a photo import"
```

---

### Task 7: The queue's use cases: read the photo, look up a row

**Files:**
- Modify: `apps/server/src/services/photoImports.ts`
- Test: `apps/server/src/services/photoImports.jobs.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `buildPhotoReadingPrompt`, `parsePhotoReading`, `PhotoReading`;
  - Task 3: `firstChoice`, `buildSenseMatchPrompt`, `parseSenseMatch`, `choiceFromModel`, `MatchedBy`, `optionsFrom`, `reasonFor`, `isOpen`;
  - Task 4: `ReadPhotoPayloadSchema`, `LookUpImportItemPayloadSchema`, `LOOK_UP_IMPORT_ITEM`;
  - Task 5: `ItemResult`;
  - Task 6: `PhotoUnreadable`, `SenseMatchUnreadable`.
- Produces the service methods `readPhoto(data: unknown)`, `failRead(data: unknown)`, `lookUpItem(data: unknown)` and `failItem(data: unknown)`, each returning `Promise<void>`.

- [ ] **Step 1: Write the failing tests.** Create `apps/server/src/services/photoImports.jobs.test.ts`, using the same fakes and builders as `photoImports.test.ts`. Copy the `importRow`, `itemRow` and `option` builders and the `ENROLLMENT`, `ID` and `NOW` constants. Each test builds the service with recording fakes for `vision`, `llm` and `lookup`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Enrollment, TranslationRequest, TranslationResponse } from '@lang-tutor/core/api';

import { LOOK_UP_IMPORT_ITEM } from '../domain/jobs';
import { PHOTO_READING_MARKER } from '../domain/photoReading';
import { SENSE_MATCH_MARKER } from '../domain/senseMatching';
import { PhotoUnreadable, SenseMatchUnreadable } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { ItemResult, PhotoImportItemRow, PhotoImportRepo, PhotoImportRow } from '../repo/photoImports';
import {
  createFakeClock,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  stub,
} from '../../tests/support/fakes';
import type { VisionJsonRequest } from './llm';
import { createPhotoImportService } from './photoImports';
import type { Repos } from './transaction';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ID = '11111111-1111-1111-1111-111111111111';
const ENROLLMENT = { id: 'e1', source_language: 'he', target_language: 'it' } as Enrollment;
// importRow, itemRow and option exactly as in photoImports.test.ts.

function setup(opts: {
  repos: Partial<Repos>;
  vision?: (request: VisionJsonRequest) => Promise<string>;
  llmReplies?: (string | Error)[];
  lookup?: (input: TranslationRequest) => Promise<TranslationResponse>;
  clock?: number[];
}) {
  const visionCalls: VisionJsonRequest[] = [];
  const lookups: TranslationRequest[] = [];
  const llm = createFakeLlmClient(...(opts.llmReplies ?? ['{"sense":0}']));
  const logger = createFakeLogger();
  const service = createPhotoImportService({
    transaction: createFakeTransaction(opts.repos),
    vision: async (request) => {
      visionCalls.push(request);
      return (opts.vision ?? (async () => '{"items":[]}'))(request);
    },
    llm,
    lookup: async (input) => {
      lookups.push(input);
      if (!opts.lookup) throw new Error('lookup was not expected');
      return opts.lookup(input);
    },
    now: createFakeClock(...(opts.clock ?? [NOW])),
    logger,
  });
  return { service, visionCalls, lookups, llm, logger };
}

const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
const sense = (n: number, translation: string) => ({ translation, part_of_speech: 'noun', sense_id: `s${n}`, variant_id: `v${n}` });
const response = (over: Partial<TranslationResponse>): TranslationResponse => ({ text: 'gatto', from: 'it', to: 'he', kind: 'word', senses: [], ...over });

describe('readPhoto', () => {
  it('reads the photo, writes its rows, clears it, and enqueues one lookup per row', async () => {
    const jobs = createFakeJobRepo();
    const transitions: unknown[] = [];
    const inserted: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow({ status: 'reading', photo: 'QUJD' }),
      transition: async (...args) => {
        transitions.push(args);
        return true;
      },
      insertItems: async (...args) => {
        inserted.push(args);
      },
    });
    const { service, visionCalls, logger } = setup({
      repos: { photoImport, enrollment, jobs },
      vision: async () => JSON.stringify({ items: [{ text: 'il gatto', hebrew: 'חתול' }, { text: 'casa', hebrew: '' }, { text: 'casa', hebrew: '' }] }),
      clock: [NOW, NOW + 4_200],
    });

    await service.readPhoto({ import_id: ID });

    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0].system).toContain(PHOTO_READING_MARKER);
    expect(visionCalls[0].image).toEqual({ data: 'QUJD', mimeType: 'image/jpeg' });
    expect(transitions).toEqual([[ID, ['reading'], 'read']]);
    expect(inserted).toEqual([[ID, [{ position: 0, text: 'il gatto', hebrew: 'חתול' }, { position: 1, text: 'casa', hebrew: null }]]]);
    expect(jobs.enqueued).toEqual([
      { name: LOOK_UP_IMPORT_ITEM, data: { import_id: ID, position: 0 } },
      { name: LOOK_UP_IMPORT_ITEM, data: { import_id: ID, position: 1 } },
    ]);
    expect(logger.events).toContainEqual({
      event: 'photo_read', import_id: ID, item_count: 2, hebrew_count: 1, merged_count: 1, dropped_count: 0, read_ms: 4_200,
    });
    expect(JSON.stringify(logger.events)).not.toContain('חתול');
  });

  it('does not read an import that is no longer reading', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImport: async () => importRow({ status: 'discarded' }) });
    const { service, visionCalls } = setup({ repos: { photoImport, enrollment } });
    await service.readPhoto({ import_id: ID });
    expect(visionCalls).toEqual([]);
  });

  it('throws on an unreadable answer, so pg-boss retries, and writes nothing', async () => {
    const photoImport = stub<PhotoImportRepo>({ findImport: async () => importRow({ status: 'reading', photo: 'QUJD' }) });
    const { service, logger } = setup({ repos: { photoImport, enrollment }, vision: async () => 'not json' });
    await expect(service.readPhoto({ import_id: ID })).rejects.toBeInstanceOf(PhotoUnreadable);
    expect(logger.events.map((event) => event.event)).toContain('photo_read_attempt_failed');
  });

  it('reads an empty answer as a photo with no words', async () => {
    const inserted: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => importRow({ status: 'reading', photo: 'QUJD' }),
      transition: async () => true,
      insertItems: async (...args) => {
        inserted.push(args);
      },
    });
    const { service } = setup({ repos: { photoImport, enrollment, jobs: createFakeJobRepo() }, vision: async () => '' });
    await service.readPhoto({ import_id: ID });
    expect(inserted).toEqual([[ID, []]]);
  });
});

describe('failRead', () => {
  it('marks a still-reading import failed, which clears its photo', async () => {
    const transitions: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      transition: async (...args) => {
        transitions.push(args);
        return true;
      },
    });
    await setup({ repos: { photoImport } }).service.failRead({ import_id: ID });
    expect(transitions).toEqual([[ID, ['reading'], 'failed']]);
  });
});

describe('lookUpItem', () => {
  const repoFor = (item: PhotoImportItemRow, row: PhotoImportRow = importRow()) => {
    const written: ItemResult[] = [];
    const photoImport = stub<PhotoImportRepo>({
      findImport: async () => row,
      findItem: async () => item,
      writeItem: async (_id, _position, result) => {
        written.push(result);
        return true;
      },
    });
    return { photoImport, written };
  };
  const pending = (over: Partial<PhotoImportItemRow> = {}) =>
    itemRow({ status: 'pending', options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false, ...over });

  it('looks the word up as typed, and starts a row with no Hebrew on its first sense, ticked', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'casa' }));
    const { service, lookups, llm } = setup({
      repos: { photoImport, enrollment },
      lookup: async () => response({ text: 'casa', senses: [sense(1, 'בית'), sense(2, 'משפחה')] }),
    });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(lookups).toEqual([{ text: 'casa', from: 'it', to: 'he', enrollment_id: 'e1' }]);
    expect(llm.calls).toEqual([]);
    expect(written).toEqual([
      {
        correctedForm: null,
        options: [
          { sense_id: 's1', variant_id: 'v1', translation: 'בית', part_of_speech: 'noun' },
          { sense_id: 's2', variant_id: 'v2', translation: 'משפחה', part_of_speech: 'noun' },
        ],
        chosenSenseId: 's1',
        ticked: true,
        hebrewMismatch: false,
        reason: null,
      },
    ]);
  });

  it('takes the sense whose translation the printed Hebrew names, with no model call', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'bank', hebrew: 'גדה' }));
    const { service, llm } = setup({ repos: { photoImport, enrollment }, lookup: async () => response({ senses: [sense(1, 'בנק'), sense(2, 'גדה')] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(llm.calls).toEqual([]);
    expect(written[0]).toMatchObject({ chosenSenseId: 's2', hebrewMismatch: false });
  });

  it('asks the model when no gloss matches, and takes its sense', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'bank', hebrew: 'גדת נהר' }));
    const { service, llm } = setup({
      repos: { photoImport, enrollment },
      llmReplies: ['{"sense":2}'],
      lookup: async () => response({ senses: [sense(1, 'בנק'), sense(2, 'גדה')] }),
    });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain(SENSE_MATCH_MARKER);
    expect(written[0]).toMatchObject({ chosenSenseId: 's2', hebrewMismatch: false, ticked: true });
  });

  it('falls back to the first sense, flagged, when the model says none matches', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'banca', hebrew: 'ספסל' }));
    const { service } = setup({ repos: { photoImport, enrollment }, llmReplies: ['{"sense":0}'], lookup: async () => response({ senses: [sense(1, 'בנק')] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(written[0]).toMatchObject({ chosenSenseId: 's1', hebrewMismatch: true, ticked: true });
  });

  it('keeps the lookup’s correction, and asks the model about the corrected word', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'gatlo', hebrew: 'חתולה' }));
    const { service, llm } = setup({
      repos: { photoImport, enrollment },
      llmReplies: ['{"sense":1}'],
      lookup: async () => response({ text: 'gatlo', senses: [sense(1, 'חתול')], correction: { corrected_form: 'gatto', alternatives: [] } }),
    });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(JSON.parse(llm.calls[0].user).word).toBe('gatto');
    expect(written[0]).toMatchObject({ correctedForm: 'gatto', chosenSenseId: 's1' });
  });

  it('writes a row with no options unticked, with the reason', async () => {
    const { photoImport, written } = repoFor(pending({ text: 'la casa è grande' }));
    const { service } = setup({ repos: { photoImport, enrollment }, lookup: async () => response({ kind: 'sentence', senses: [{ translation: 'הבית גדול' }] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(written).toEqual([{ correctedForm: null, options: [], chosenSenseId: null, ticked: false, hebrewMismatch: false, reason: 'sentence' }]);
  });

  it('spends no lookup on a discarded import or a row already settled (Review Focus 1)', async () => {
    for (const [row, item] of [
      [importRow({ status: 'discarded' }), pending()],
      [importRow(), itemRow()],
    ] as const) {
      const { photoImport, written } = repoFor(item, row);
      const { service, lookups } = setup({ repos: { photoImport, enrollment } });
      await service.lookUpItem({ import_id: ID, position: 0 });
      expect(lookups).toEqual([]);
      expect(written).toEqual([]);
    }
  });

  it('throws on an unreadable match, so pg-boss retries', async () => {
    const { photoImport } = repoFor(pending({ text: 'bank', hebrew: 'גדת נהר' }));
    const { service } = setup({ repos: { photoImport, enrollment }, llmReplies: ['nonsense'], lookup: async () => response({ senses: [sense(1, 'בנק')] }) });
    await expect(service.lookUpItem({ import_id: ID, position: 0 })).rejects.toBeInstanceOf(SenseMatchUnreadable);
  });

  it('logs how the sense was chosen, without any Hebrew', async () => {
    const { photoImport } = repoFor(pending({ text: 'bank', hebrew: 'גדה' }));
    const { service, logger } = setup({ repos: { photoImport, enrollment }, lookup: async () => response({ senses: [sense(1, 'בנק'), sense(2, 'גדה')] }) });
    await service.lookUpItem({ import_id: ID, position: 0 });
    expect(logger.events).toContainEqual({
      event: 'import_item_looked_up', import_id: ID, position: 0, matched_by: 'exact', corrected: false, option_count: 2, reason: null,
    });
    expect(JSON.stringify(logger.events)).not.toContain('גדה');
  });
});

describe('failItem', () => {
  it('marks a still-pending row failed', async () => {
    const marked: unknown[] = [];
    const photoImport = stub<PhotoImportRepo>({
      markItemFailed: async (...args) => {
        marked.push(args);
        return true;
      },
    });
    await setup({ repos: { photoImport } }).service.failItem({ import_id: ID, position: 3 });
    expect(marked).toEqual([[ID, 3]]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `cd apps/server && npx jest --selectProjects=unit src/services/photoImports.jobs.test.ts`
Expected: FAIL. `service.readPhoto is not a function`.

- [ ] **Step 3: Implement.** Add imports to `apps/server/src/services/photoImports.ts`:

```ts
import { LOOK_UP_IMPORT_ITEM, LookUpImportItemPayloadSchema, READ_PHOTO, ReadPhotoPayloadSchema } from '../domain/jobs';
import type { LanguageCode } from '../domain/languages';
import { buildPhotoReadingPrompt, parsePhotoReading, type PhotoReading } from '../domain/photoReading';
import { optionsFrom, reasonFor } from '../domain/photoImports';
import { buildSenseMatchPrompt, choiceFromModel, firstChoice, parseSenseMatch, type MatchedBy } from '../domain/senseMatching';
import { PhotoUnreadable, SenseMatchUnreadable } from '../errors';
import type { ItemResult } from '../repo/photoImports';
```

  Merge these into the existing import lines. Then add the four methods inside the returned object, after `discard`:

```ts
    /**
     * The read-photo job (spec D2, D5): read, call the model, write. No
     * transaction is held across the call (ADR 0001 R8). The rows, the photo
     * cleared and the row jobs enqueued are dependent writes in the last
     * transaction. Any throw is a failed attempt: pg-boss retries it, then
     * dead-letters to failRead.
     */
    readPhoto: async (data: unknown): Promise<void> => {
      const { import_id: importId } = ReadPhotoPayloadSchema.parse(data);
      const read = await transaction(async ({ photoImport, enrollment }) => {
        const row = await photoImport.findImport(importId);
        // Discarded, failed or gone: nothing to read, and not a failure.
        if (!row || row.status !== 'reading' || row.photo === null) return undefined;
        const enrolled = await enrollment.findById(row.enrollmentId);
        return enrolled ? { photo: row.photo, target: enrolled.target_language as LanguageCode } : undefined;
      });
      if (!read) {
        logger.info({ event: 'photo_read_dropped', import_id: importId, stage: 'read' });
        return;
      }

      const started = now();
      let reading: PhotoReading;
      try {
        const raw = await vision({
          ...buildPhotoReadingPrompt(read.target),
          image: { data: read.photo, mimeType: 'image/jpeg' },
        });
        // An empty string is the provider's "no content": no words, not a failure.
        const parsed = raw === '' ? { items: [], mergedCount: 0, droppedCount: 0 } : parsePhotoReading(raw);
        if (!parsed) throw new PhotoUnreadable(importId);
        reading = parsed;
      } catch (error) {
        logger.info({
          event: 'photo_read_attempt_failed',
          import_id: importId,
          read_ms: now() - started,
          reason: error instanceof Error ? error.name : 'unknown',
        });
        throw error;
      }
      const readMs = now() - started;

      const items = reading.items.map((item, position) => ({ position, text: item.text, hebrew: item.hebrew }));
      const written = await transaction(async ({ photoImport, jobs }) => {
        // Conditional: a discard during the call wins, and nothing is written.
        if (!(await photoImport.transition(importId, ['reading'], 'read'))) return false;
        await photoImport.insertItems(importId, items);
        for (const item of items) {
          await jobs.enqueue(LOOK_UP_IMPORT_ITEM, { import_id: importId, position: item.position });
        }
        return true;
      });
      logger.info({
        event: written ? 'photo_read' : 'photo_read_dropped',
        import_id: importId,
        item_count: items.length,
        hebrew_count: items.filter((item) => item.hebrew !== null).length,
        merged_count: reading.mergedCount,
        dropped_count: reading.droppedCount,
        read_ms: readMs,
        ...(written ? {} : { stage: 'write' }),
      });
    },

    /** The read's dead letter: retries spent or expired. Clears the photo
     *  (the transition always does), so a failed import keeps none. */
    failRead: async (data: unknown): Promise<void> => {
      const { import_id: importId } = ReadPhotoPayloadSchema.parse(data);
      const marked = await transaction(({ photoImport }) => photoImport.transition(importId, ['reading'], 'failed'));
      logger.info({ event: 'photo_read_failed', import_id: importId, marked });
    },

    /**
     * The look-up-import-item job (spec D7): the lookup exactly as if typed,
     * then the sense, then one write. An import no longer open, or a row
     * already settled, costs no lookup (spec D2).
     */
    lookUpItem: async (data: unknown): Promise<void> => {
      const { import_id: importId, position } = LookUpImportItemPayloadSchema.parse(data);
      const read = await transaction(async ({ photoImport, enrollment }) => {
        const row = await photoImport.findImport(importId);
        if (!row || row.status !== 'read' || !isOpen(row.status, row.createdAt, now())) return undefined;
        const item = await photoImport.findItem(importId, position);
        if (!item || item.status !== 'pending') return undefined;
        const enrolled = await enrollment.findById(row.enrollmentId);
        return enrolled ? { item, enrolled } : undefined;
      });
      if (!read) {
        logger.info({ event: 'import_item_dropped', import_id: importId, position, stage: 'read' });
        return;
      }
      const { item, enrolled } = read;
      const target = enrolled.target_language as LanguageCode;

      const response = await lookup({
        text: item.text,
        from: target,
        to: enrolled.source_language as LanguageCode,
        enrollment_id: enrolled.id,
      });
      const correctedForm = response.correction?.corrected_form ?? null;
      const options = optionsFrom(response.senses);

      let result: ItemResult;
      let matchedBy: MatchedBy | null = null;
      if (options.length === 0) {
        result = { correctedForm, options, chosenSenseId: null, ticked: false, hebrewMismatch: false, reason: reasonFor(response) };
      } else {
        let choice = firstChoice(item.hebrew, options);
        if (choice === 'ask_model') {
          const raw = await llm(
            buildSenseMatchPrompt({ word: correctedForm ?? item.text, target, hebrew: item.hebrew ?? '', options }),
          );
          const answer = parseSenseMatch(raw, options.length);
          if (answer === null) throw new SenseMatchUnreadable(importId, position);
          choice = choiceFromModel(answer);
        }
        matchedBy = choice.matchedBy;
        result = {
          correctedForm,
          options,
          chosenSenseId: options[choice.index].sense_id,
          ticked: true,
          hebrewMismatch: choice.mismatch,
          reason: null,
        };
      }

      const written = await transaction(({ photoImport }) => photoImport.writeItem(importId, position, result));
      logger.info({
        event: written ? 'import_item_looked_up' : 'import_item_dropped',
        import_id: importId,
        position,
        matched_by: matchedBy,
        corrected: correctedForm !== null,
        option_count: options.length,
        reason: result.reason,
        ...(written ? {} : { stage: 'write' }),
      });
    },

    /** The row's dead letter: the row is marked failed, the rest unaffected. */
    failItem: async (data: unknown): Promise<void> => {
      const { import_id: importId, position } = LookUpImportItemPayloadSchema.parse(data);
      const marked = await transaction(({ photoImport }) => photoImport.markItemFailed(importId, position));
      logger.info({ event: 'import_item_failed', import_id: importId, position, marked });
    },
```

  `firstChoice` returns `'ask_model'` only when `item.hebrew` is not null, so `item.hebrew ?? ''` never takes the fallback. It is there to satisfy the type.

- [ ] **Step 4: Run both service test files and confirm they pass.**
Run: `cd apps/server && npx jest --selectProjects=unit src/services/photoImports`
Expected: PASS. Then `npm run typecheck` and `npm run lint:arch` from the root.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/services/photoImports.ts apps/server/src/services/photoImports.jobs.test.ts
git commit -m "feat(server): read a photo into rows, and look up each row's sense"
```

---

### Task 8: Wiring and the routes

**Files:**
- Modify: `apps/server/src/composition.ts`, `apps/server/src/index.ts`, `apps/server/src/worker.ts`, `apps/server/src/app.ts`
- Create: `apps/server/src/routes/photoImports.ts`
- Modify: `apps/server/src/openapi.test.ts`
- Modify: `apps/server/tests/support/serverDeps.ts`, `apps/server/tests/support/fakes.ts` (`createFakeAppDeps`), `apps/server/tests/integration/jobs/prepareSession.test.ts` (the `registerWorkers` call)
- Create: `apps/server/tests/support/photoImportRows.ts`
- Test: `apps/server/tests/integration/routes/photoImports.test.ts`

**Interfaces:**
- Consumes: `PhotoImportService` (Tasks 6–7); `createGeminiVisionClient` and `VisionClient` (Task 4); `Config.photoReadTimeoutMs`.
- Produces:
  - `AppDeps.photoImports: PhotoImportService`;
  - `createServerDeps` io gains `photoReadTimeoutMs: number`;
  - `registerWorkers(boss, services: { sessions: SessionService; photoImports: PhotoImportService }, options)`;
  - `createPhotoImportsRouter(photoImports: PhotoImportService)`;
  - `PHOTO_BODY_LIMIT_BYTES = 3 * 1024 * 1024`;
  - in `tests/support/photoImportRows.ts`: `seedPhotoImport(db, { enrollmentId, status, createdAt?, items }) → id`.

- [ ] **Step 1: Wire composition and the entry points.**
  - In `apps/server/src/composition.ts`:
    - import `createGeminiVisionClient`, and `VisionClient` as a type from `./services/llm`;
    - import `createPhotoImportService` and `type PhotoImportService` from `./services/photoImports`;
    - add `photoImports: PhotoImportService;` to `AppDeps`;
    - add `photoReadTimeoutMs: number;` to `createServerDeps`'s `io`, with a comment in the existing style;
    - build the vision client and the translation service once, then the import service:

```ts
  // Phase 26 (spec D5). The same provider reading a photo, with a read's budget.
  // The annotation is what checks it satisfies the contract (ADR 0001 R11).
  const vision: VisionClient = createGeminiVisionClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.photoReadTimeoutMs,
  });

  const translations = createTranslationService({ llm, transaction, logger: io.logger });
```

    and in the returned object use `translations,` (replacing the inline `createTranslationService(...)`) plus:

```ts
    // Phase 26. Handed the lookup use case itself, so a row is looked up exactly
    // as a typed word is (spec D7). The match call shares the lookup's client
    // and budget.
    photoImports: createPhotoImportService({
      transaction,
      vision,
      llm,
      lookup: translations.translate,
      now: io.now,
      logger: io.logger,
    }),
```

  - In `apps/server/src/index.ts`, pass `photoReadTimeoutMs: config.photoReadTimeoutMs,` to `createServerDeps`, and change the worker call to `await registerWorkers(boss, deps, { pollingIntervalSeconds: 2 });`.
  - In `apps/server/src/worker.ts`, change the signature and add the four queues:

```ts
export async function registerWorkers(
  boss: PgBoss,
  services: { sessions: SessionService; photoImports: PhotoImportService },
  options: { pollingIntervalSeconds: number },
): Promise<void> {
  const { sessions, photoImports } = services;
  // … the two existing registrations, unchanged …

  // Phase 26 (spec D2). Two reads at once per process: each is one long call.
  await boss.work(
    READ_PHOTO,
    { localConcurrency: 2, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await photoImports.readPhoto(job.data);
    },
  );
  await boss.work(READ_PHOTO_FAILED, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await photoImports.failRead(job.data);
  });
  // Four rows at once, like session preparation: a lookup is one to six calls.
  await boss.work(
    LOOK_UP_IMPORT_ITEM,
    { localConcurrency: 4, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await photoImports.lookUpItem(job.data);
    },
  );
  await boss.work(LOOK_UP_IMPORT_ITEM_FAILED, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await photoImports.failItem(job.data);
  });
}
```

  - Update every other `registerWorkers(boss, deps.sessions, …)` call to `registerWorkers(boss, deps, …)`. Find them with `grep -rn "registerWorkers(" apps/server --include='*.ts'`. One is in `tests/integration/jobs/prepareSession.test.ts`, and a `src/worker.test.ts` may exist.
  - In `apps/server/tests/support/serverDeps.ts`, add `photoReadTimeoutMs?: number` to the io, with the comment "Phase 26. A read's budget; defaults to production's", and pass `photoReadTimeoutMs: io.photoReadTimeoutMs ?? PHOTO_READ_BUDGET_MS`.
  - In `apps/server/tests/support/fakes.ts` `createFakeAppDeps`, add a `photoImports: PhotoImportService` whose ten methods are all `unreachable`, and include it in the returned object.

  Run `npm run typecheck` from the root. Expected: clean.

- [ ] **Step 2: Write the route.** Create `apps/server/src/routes/photoImports.ts`:

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  PhotoImportCreateRequestSchema,
  PhotoImportItemSchema,
  PhotoImportItemUpdateSchema,
  PhotoImportListSchema,
  PhotoImportSchema,
  PhotoImportSummarySchema,
  SaveVocabularyResponseSchema,
} from '@lang-tutor/core/api/schemas';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import {
  EnrollmentNotFound,
  InvalidPhotoImportItem,
  InvalidVocabularyEntry,
  PhotoImportConflict,
  PhotoImportNotFound,
} from '../errors';
import type { PhotoImportService } from '../services/photoImports';

/** Spec D6: the upload alone has a body limit, the app's first. A 2 MB JPEG
 *  is about 2.7 MB of base64 inside its JSON. */
export const PHOTO_BODY_LIMIT_BYTES = 3 * 1024 * 1024;

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const enrollmentParams = z.object({ id: z.string() });
const importParams = z.object({ id: z.string() });
const itemParams = z.object({ id: z.string(), position: z.coerce.number().int().nonnegative() });
const NO_IMPORT = json(ErrorSchema, 'No photo import has this id.');
const CONFLICT = json(ErrorSchema, 'The import is in the wrong state: a row still being looked up, or an import already saved or discarded.');

const createImportRoute = createRoute({
  method: 'post',
  path: '/enrollments/{id}/photo-imports',
  tags: ['photo-imports'],
  summary: 'Upload a photo of a word list',
  description:
    'Stores the photo and starts reading it in the background. Poll GET /photo-imports/{id} until its ' +
    'status is ready or failed. The photo is kept only until it is read.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: PhotoImportCreateRequestSchema } } },
  },
  responses: {
    202: json(PhotoImportSummarySchema, 'The import exists and is reading.'),
    400: json(ErrorSchema, 'The body did not validate: a JPEG as base64, at most 2 800 000 characters.'),
    404: json(ErrorSchema, 'No enrollment has this id.'),
    413: json(ErrorSchema, 'The body is over 3 MB.'),
  },
});

const listImportsRoute = createRoute({
  method: 'get',
  path: '/enrollments/{id}/photo-imports',
  tags: ['photo-imports'],
  summary: "An enrollment's open photo imports",
  description: 'Not saved, not discarded, and less than 14 days old. Newest first.',
  request: { params: enrollmentParams },
  responses: {
    200: json(PhotoImportListSchema, 'The open imports, possibly none.'),
    404: json(ErrorSchema, 'No enrollment has this id.'),
  },
});

const getImportRoute = createRoute({
  method: 'get',
  path: '/photo-imports/{id}',
  tags: ['photo-imports'],
  summary: 'One photo import with its rows',
  request: { params: importParams },
  responses: { 200: json(PhotoImportSchema, 'The import and its rows, in page order.'), 404: NO_IMPORT },
});

const updateItemRoute = createRoute({
  method: 'patch',
  path: '/photo-imports/{id}/items/{position}',
  tags: ['photo-imports'],
  summary: "Tick, untick or change a row's sense",
  request: {
    params: itemParams,
    body: { required: true, content: { 'application/json': { schema: PhotoImportItemUpdateSchema } } },
  },
  responses: {
    200: json(PhotoImportItemSchema, 'The row as it now is.'),
    400: json(ErrorSchema, "The body did not validate, the sense is not one of the row's options, or the row has none to tick."),
    404: json(ErrorSchema, 'No photo import has this id, or it has no such row.'),
    409: CONFLICT,
  },
});

const saveImportRoute = createRoute({
  method: 'post',
  path: '/photo-imports/{id}/save',
  tags: ['photo-imports'],
  summary: "Save the ticked rows' senses",
  description:
    "All or nothing, in one transaction, and the import becomes saved. Saving a saved import answers the same ids and writes nothing.",
  request: { params: importParams },
  responses: {
    200: json(SaveVocabularyResponseSchema, 'Every ticked sense is now saved.'),
    400: json(ErrorSchema, 'A sense cannot be saved in this enrollment.'),
    404: NO_IMPORT,
    409: json(ErrorSchema, 'The import is not ready: still reading or looking up, failed, or discarded.'),
  },
});

const discardImportRoute = createRoute({
  method: 'post',
  path: '/photo-imports/{id}/discard',
  tags: ['photo-imports'],
  summary: 'Discard a photo import without saving',
  description: 'Idempotent on a discarded import. Its remaining lookups are skipped.',
  request: { params: importParams },
  responses: {
    204: { description: 'The import is discarded.' },
    404: NO_IMPORT,
    409: json(ErrorSchema, 'The import was already saved.'),
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createPhotoImportsRouter(photoImports: PhotoImportService) {
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.use(
    '/enrollments/:id/photo-imports',
    bodyLimit({ maxSize: PHOTO_BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'photo too large' }, 413) }),
  );

  router.openapi(createImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.create(id, c.req.valid('json')), 202);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(listImportsRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.list(id), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(getImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.get(id), 200);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      throw error;
    }
  });

  router.openapi(updateItemRoute, async (c) => {
    const { id, position } = c.req.valid('param');
    try {
      return c.json(await photoImports.updateItem(id, position, c.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      if (error instanceof InvalidPhotoImportItem) return c.json({ error: 'invalid row change' }, 400);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import conflict' }, 409);
      throw error;
    }
  });

  router.openapi(saveImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await photoImports.save(id), 200);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      if (error instanceof InvalidVocabularyEntry) return c.json({ error: 'invalid vocabulary entry' }, 400);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import conflict' }, 409);
      throw error;
    }
  });

  router.openapi(discardImportRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await photoImports.discard(id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof PhotoImportNotFound) return c.json({ error: 'photo import not found' }, 404);
      if (error instanceof PhotoImportConflict) return c.json({ error: 'photo import conflict' }, 409);
      throw error;
    }
  });

  return router;
}
```

  Check how the vocabulary router answers 204 (its unsave handler) and copy that exact expression if it differs from `c.body(null, 204)`. Mount it in `apps/server/src/app.ts` after the vocabulary router: `app.route('/api', createPhotoImportsRouter(deps.photoImports));`.

- [ ] **Step 3: Update the published document's test.** In `apps/server/src/openapi.test.ts`, rename `'contains all thirteen paths and nothing else'` to `'contains all eighteen paths and nothing else'`, and add `'/api/enrollments/{id}/photo-imports'`, `'/api/photo-imports/{id}'`, `'/api/photo-imports/{id}/discard'`, `'/api/photo-imports/{id}/items/{position}'` and `'/api/photo-imports/{id}/save'` to the sorted list. Add:

```ts
it('declares the photo upload as 202 with 400, 404 and 413', async () => {
  const doc = await openApiDocument();
  expect(Object.keys(doc.paths['/api/enrollments/{id}/photo-imports'].post.responses).sort()).toEqual(['202', '400', '404', '413']);
  expect(Object.keys(doc.paths['/api/photo-imports/{id}/items/{position}'].patch.responses).sort()).toEqual(['200', '400', '404', '409']);
});
```

  Run: `cd apps/server && npx jest --selectProjects=unit src/openapi.test.ts`. Expected: PASS.

- [ ] **Step 4: Add the seeding helper.** Create `apps/server/tests/support/photoImportRows.ts`. `tests/support/` is the test composition root, so it may write tables directly. Route tests may not (ADR 0001):

```ts
import type { PhotoImportOption } from '@lang-tutor/core/api';

import type { Db } from '../../src/db/client';
import { photoImportItems, photoImports } from '../../src/db/schema';

export type SeedItem = {
  text: string;
  hebrew?: string | null;
  status?: 'pending' | 'ready' | 'failed';
  options?: PhotoImportOption[];
  chosenSenseId?: string | null;
  ticked?: boolean;
  hebrewMismatch?: boolean;
};

/** An import in any state, with rows, for tests about reviewing and saving.
 *  A row with options defaults to ready, ticked, on its first option. */
export async function seedPhotoImport(
  db: Db,
  input: {
    enrollmentId: string;
    status: 'reading' | 'read' | 'failed' | 'saved' | 'discarded';
    createdAt?: Date;
    items: SeedItem[];
  },
): Promise<string> {
  const [row] = await db
    .insert(photoImports)
    .values({
      enrollmentId: input.enrollmentId,
      status: input.status,
      photo: input.status === 'reading' ? 'QUJD' : null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: photoImports.id });
  if (input.items.length > 0) {
    await db.insert(photoImportItems).values(
      input.items.map((item, position) => {
        const options = item.options ?? [];
        const chosen = item.chosenSenseId !== undefined ? item.chosenSenseId : (options[0]?.sense_id ?? null);
        return {
          importId: row.id,
          position,
          text: item.text,
          hebrew: item.hebrew ?? null,
          status: item.status ?? (options.length > 0 ? 'ready' : 'pending'),
          options,
          suggestedSenseId: chosen,
          chosenSenseId: chosen,
          ticked: item.ticked ?? chosen !== null,
          hebrewMismatch: item.hebrewMismatch ?? false,
        };
      }),
    );
  }
  return row.id;
}
```

- [ ] **Step 5: Write the route integration tests.** Create `apps/server/tests/integration/routes/photoImports.test.ts`. Use `insertLexeme` to create real senses, so that save passes `findSaveable`. Use a started test boss so the upload can enqueue, and register no workers, so nothing runs behind the test:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PhotoImportOption } from '@lang-tutor/core/api';
import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { createPhotoImportsRouter } from '../../../src/routes/photoImports';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { countJobs, startTestBoss, stopTestBoss } from '../../support/jobs';
import { seedPhotoImport } from '../../support/photoImportRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;
const IT = 'e_it';

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: IT, userId: 'u_1', targetLanguage: 'it' });
  boss = await startTestBoss(t.db);
  deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), boss });
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

function app() {
  const hono = new Hono();
  hono.route('/api', createPhotoImportsRouter(deps.photoImports));
  return hono;
}
const send = (method: string, path: string, body?: unknown) =>
  app().request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });

/** An Italian word with two senses, each rendered in Hebrew by the lemma. */
async function word(lemma: string, translations: [string, string]): Promise<PhotoImportOption[]> {
  const ids = await insertLexeme(t.db, {
    lemma,
    languageCode: 'it',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'a' }, { senseCode: 'b' }],
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'a', rank: 0, translation: translations[0], exampleSource: null, exampleTarget: null },
          { senseCode: 'b', rank: 1, translation: translations[1], exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
  return ids.senseIds.map((senseId, index) => ({ sense_id: senseId, variant_id: ids.variantIds[0], translation: translations[index] }));
}

describe('POST /api/enrollments/{id}/photo-imports', () => {
  it('answers 202 reading, and enqueues the read', async () => {
    const res = await send('POST', `/enrollments/${IT}/photo-imports`, { mime_type: 'image/jpeg', image: 'QUJD' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'reading', item_count: 0, settled_count: 0 });
    expect(await countJobs(t.db, 'read-photo')).toBe(1);
  });

  it('answers 404 for an unknown enrollment, 400 for a PNG, and 413 above 3 MB', async () => {
    expect((await send('POST', '/enrollments/nope/photo-imports', { mime_type: 'image/jpeg', image: 'QUJD' })).status).toBe(404);
    expect((await send('POST', `/enrollments/${IT}/photo-imports`, { mime_type: 'image/png', image: 'QUJD' })).status).toBe(400);
    const huge = await send('POST', `/enrollments/${IT}/photo-imports`, { mime_type: 'image/jpeg', image: 'a'.repeat(3_200_000) });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: 'photo too large' });
  });
});

describe('GET', () => {
  it('lists the open imports newest first, and leaves out saved and discarded ones', async () => {
    const [cat] = await word('gatto', ['חתול', 'חתולה']);
    const open = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'gatto', options: [cat] }, { text: 'casa' }] });
    await seedPhotoImport(t.db, { enrollmentId: IT, status: 'saved', items: [] });
    await seedPhotoImport(t.db, { enrollmentId: IT, status: 'discarded', items: [] });
    const res = await send('GET', `/enrollments/${IT}/photo-imports`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([expect.objectContaining({ id: open, status: 'looking_up', item_count: 2, settled_count: 1 })]);
  });

  it('answers one import with its rows, and 404 for an unknown or malformed id', async () => {
    const options = await word('gatto', ['חתול', 'חתולה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'gatto', hebrew: 'חתול', options }] });
    const body = (await (await send('GET', `/photo-imports/${id}`)).json()) as { status: string; items: unknown[] };
    expect(body.status).toBe('ready');
    expect(body.items).toEqual([expect.objectContaining({ text: 'gatto', hebrew: 'חתול', chosen_sense_id: options[0].sense_id, ticked: true })]);
    expect((await send('GET', '/photo-imports/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await send('GET', '/photo-imports/nope')).status).toBe(404);
  });
});

describe('PATCH /api/photo-imports/{id}/items/{position}', () => {
  it('switches a sense and unticks', async () => {
    const options = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options }] });
    const res = await send('PATCH', `/photo-imports/${id}/items/0`, { sense_id: options[1].sense_id, ticked: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chosen_sense_id: options[1].sense_id, ticked: false });
  });

  it('answers 400 for an empty body, a foreign sense, and a tick on a row with no options', async () => {
    const options = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, {
      enrollmentId: IT,
      status: 'read',
      items: [{ text: 'casa', options }, { text: 'la casa è grande', status: 'ready', options: [] }],
    });
    expect((await send('PATCH', `/photo-imports/${id}/items/0`, {})).status).toBe(400);
    expect((await send('PATCH', `/photo-imports/${id}/items/0`, { sense_id: 'other' })).status).toBe(400);
    expect((await send('PATCH', `/photo-imports/${id}/items/1`, { ticked: true })).status).toBe(400);
  });

  it('answers 409 for a row still being looked up, and for a discarded import (Review Focus 2)', async () => {
    const options = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options }, { text: 'gatto' }] });
    expect((await send('PATCH', `/photo-imports/${id}/items/1`, { ticked: false })).status).toBe(409);
    expect((await send('POST', `/photo-imports/${id}/discard`)).status).toBe(204);
    expect((await send('PATCH', `/photo-imports/${id}/items/0`, { ticked: false })).status).toBe(409);
  });
});

describe('save and discard', () => {
  it('saves exactly the ticked rows’ chosen senses, and a repeated save answers the same', async () => {
    const casa = await word('casa', ['בית', 'משפחה']);
    const gatto = await word('gatto', ['חתול', 'חתולה']);
    const id = await seedPhotoImport(t.db, {
      enrollmentId: IT,
      status: 'read',
      items: [{ text: 'casa', options: casa }, { text: 'gatto', options: gatto }],
    });
    await send('PATCH', `/photo-imports/${id}/items/0`, { sense_id: casa[1].sense_id });
    await send('PATCH', `/photo-imports/${id}/items/1`, { ticked: false });

    const res = await send('POST', `/photo-imports/${id}/save`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_sense_ids: [casa[1].sense_id] });
    const page = await deps.vocabulary.listWords(IT, {});
    expect(page.items.map((item) => item.lemma)).toEqual(['casa']);

    const again = await send('POST', `/photo-imports/${id}/save`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ saved_sense_ids: [casa[1].sense_id] });
    expect((await (await send('GET', `/enrollments/${IT}/photo-imports`)).json()) as unknown[]).toEqual([]);
  });

  it('refuses a save while a row is pending', async () => {
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'gatto' }] });
    expect((await send('POST', `/photo-imports/${id}/save`)).status).toBe(409);
  });

  it('lets exactly one of a save and a discard win (Review Focus 3)', async () => {
    const casa = await word('casa', ['בית', 'משפחה']);
    const discardedFirst = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options: casa }] });
    expect((await send('POST', `/photo-imports/${discardedFirst}/discard`)).status).toBe(204);
    expect((await send('POST', `/photo-imports/${discardedFirst}/discard`)).status).toBe(204);
    expect((await send('POST', `/photo-imports/${discardedFirst}/save`)).status).toBe(409);

    const savedFirst = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options: casa }] });
    expect((await send('POST', `/photo-imports/${savedFirst}/save`)).status).toBe(200);
    expect((await send('POST', `/photo-imports/${savedFirst}/discard`)).status).toBe(409);
  });
});
```

  Run: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/routes/photoImports.test.ts`. Expected: PASS. If `deps.vocabulary.listWords` takes a different query shape, read `services/vocabulary.ts` and match it.

- [ ] **Step 6: Run the server suites.** From the root: `npm run typecheck`, `npm run lint:arch`, `npm test`, `npm run test:integration`. Expected: all pass. `prepareSession.test.ts` passes with its updated `registerWorkers` call.

- [ ] **Step 7: Commit.**

```bash
git add apps/server
git commit -m "feat(server): photo import routes and workers, wired at the composition root"
```

---

### Task 9: An import through the real queue

**Files:**
- Modify: `apps/server/tests/support/mockServer.ts`
- Test: `apps/server/tests/integration/jobs/photoImport.test.ts`

**Interfaces:**
- Consumes: everything above; `registerWorkers(boss, deps, …)`; `PHOTO_READING_MARKER`; `SENSE_MATCH_MARKER`.
- Produces, in `tests/support/mockServer.ts`:
  - `expectPhotoRead(ns, items: { text: string; hebrew: string }[], opts?: { delayMs?: number })`;
  - `expectPhotoReadFailure(ns, statusCode: number)`;
  - `expectSenseMatch(ns, sense: number)`.

- [ ] **Step 1: Add the MockServer helpers.** In `apps/server/tests/support/mockServer.ts`, beside `expectReconciliation`, using the module's own `expectation` and `geminiResponse`:

```ts
/** Phase 26. The reader's answer, matched by its marker, so it never answers a
 *  lookup. Register it before any broad expectation. */
export async function expectPhotoRead(
  ns: string,
  items: { text: string; hebrew: string }[],
  opts: { delayMs?: number } = {},
): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${PHOTO_READING_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ items })),
        ...(opts.delayMs ? { delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs } } : {}),
      },
    },
  });
}

/** Phase 26. A reader that always fails, for the dead-letter path. */
export async function expectPhotoReadFailure(ns: string, statusCode: number): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${PHOTO_READING_MARKER}[\\s\\S]*` } },
    action: { httpResponse: { statusCode, body: '{"error":{"message":"upstream"}}' } },
  });
}

/** Phase 26. The match call's answer: a sense number from 1, or 0 for none. */
export async function expectSenseMatch(ns: string, sense: number): Promise<void> {
  await expectation(ns, {
    match: { body: { type: 'REGEX', regex: `[\\s\\S]*${SENSE_MATCH_MARKER}[\\s\\S]*` } },
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(geminiResponse({ sense })),
      },
    },
  });
}
```

  Import `PHOTO_READING_MARKER` from `../../src/domain/photoReading` and `SENSE_MATCH_MARKER` from `../../src/domain/senseMatching`.

- [ ] **Step 2: Write the test.** Create `apps/server/tests/integration/jobs/photoImport.test.ts`. The words are seeded in the dictionary, so each lookup is a cache hit with no model call. MockServer answers only the read and the match:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { registerWorkers } from '../../../src/worker';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  expectPhotoRead,
  expectPhotoReadFailure,
  expectSenseMatch,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let deps: AppDeps;
let ns: string;
const IT = 'e_it';

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: IT, userId: 'u_1', targetLanguage: 'it' });
  ns = mockNamespace(expect.getState().currentTestName ?? 'photo-import');
  logger = createFakeLogger();
  boss = await startTestBoss(t.db);
  deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns) });
  await registerWorkers(boss, deps, { pollingIntervalSeconds: 0.5 });
});

afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

async function italian(lemma: string, translations: string[]) {
  return insertLexeme(t.db, {
    lemma,
    languageCode: 'it',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: translations.map((_, index) => ({ senseCode: `s${index}` })),
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 0,
        translations: translations.map((translation, index) => ({
          senseCode: `s${index}`,
          rank: index,
          translation,
          exampleSource: null,
          exampleTarget: null,
        })),
      },
    ],
  });
}

const statusOf = async (id: string) => (await deps.photoImports.get(id)).status;

describe('a photo import through the queue', () => {
  it('reads three rows, chooses each sense, and saves what the review kept', async () => {
    const gatto = await italian('gatto', ['חתול']);
    const banca = await italian('banca', ['בנק']);
    const casa = await italian('casa', ['בית', 'משפחה']);
    await expectPhotoRead(ns, [
      { text: 'gatto', hebrew: 'חתול' },
      { text: 'banca', hebrew: 'ספסל' },
      { text: 'casa', hebrew: '' },
    ]);
    await expectSenseMatch(ns, 0);

    const { id } = await deps.photoImports.create(IT, { mime_type: 'image/jpeg', image: 'QUJD' });
    await waitFor(async () => (await statusOf(id)) === 'ready');

    const { items } = await deps.photoImports.get(id);
    expect(items.map((item) => [item.text, item.chosen_sense_id, item.ticked, item.hebrew_mismatch])).toEqual([
      ['gatto', gatto.senseIds[0], true, false],
      ['banca', banca.senseIds[0], true, true],
      ['casa', casa.senseIds[0], true, false],
    ]);
    expect(logger.events.map((event) => event.event)).toEqual(expect.arrayContaining(['photo_read', 'import_item_looked_up']));

    await deps.photoImports.updateItem(id, 2, { sense_id: casa.senseIds[1] });
    await deps.photoImports.updateItem(id, 1, { ticked: false });
    expect(await deps.photoImports.save(id)).toEqual({ saved_sense_ids: [gatto.senseIds[0], casa.senseIds[1]] });
    const page = await deps.vocabulary.listWords(IT, {});
    expect(page.items.map((item) => item.lemma).sort()).toEqual(['casa', 'gatto']);
  });

  it('marks the import failed, with no photo kept, when every read fails', async () => {
    await expectPhotoReadFailure(ns, 500);
    const { id } = await deps.photoImports.create(IT, { mime_type: 'image/jpeg', image: 'QUJD' });
    await waitFor(async () => (await statusOf(id)) === 'failed', 60_000);
    expect(logger.events.map((event) => event.event)).toContain('photo_read_failed');
  }, 90_000);

  it('marks only the row whose lookup keeps failing, and leaves its siblings ready', async () => {
    await italian('gatto', ['חתול']);
    // `zzzq` is in no dictionary, so its lookup calls the model, and nothing
    // in this namespace answers a lookup.
    await expectPhotoRead(ns, [{ text: 'gatto', hebrew: '' }, { text: 'zzzq', hebrew: '' }]);
    const { id } = await deps.photoImports.create(IT, { mime_type: 'image/jpeg', image: 'QUJD' });
    await waitFor(async () => (await statusOf(id)) === 'ready', 60_000);
    const { items } = await deps.photoImports.get(id);
    expect(items.map((item) => item.status)).toEqual(['ready', 'failed']);
  }, 90_000);
});
```

  `listWords(IT, {})` must match `VocabularyService.listWords`'s real signature; read it and adjust. If the dead-letter tests take longer than 60 s because of retry backoff, read how `prepareSession.test.ts` handles its dead-letter path and copy that, for example a test-only queue update or a longer wait. Never shorten production's retry policy.

- [ ] **Step 3: Run it and confirm it passes.**
Run: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/jobs/photoImport.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit.**

```bash
git add apps/server/tests/support/mockServer.ts apps/server/tests/integration/jobs/photoImport.test.ts
git commit -m "test(server): a photo import through the queue, both dead letters included"
```

---

### Task 10: The eval: photo cases and sense-matching cases

**Files:**
- Create: `apps/server/tests/eval/fixtures/photos/` with the seven JPEGs listed below and a `README.md`
- Create: `apps/server/tests/eval/photoCases.ts`, `apps/server/tests/eval/askPhoto.ts`
- Modify: `apps/server/tests/eval/run.ts`

**Interfaces:**
- Consumes: `buildPhotoReadingPrompt`, `parsePhotoReading`, `ReadItem` (Task 2); `buildSenseMatchPrompt`, `parseSenseMatch`, `MatchOption` (Task 3); `createGeminiVisionClient` (Task 4); `comparable` from `src/domain/distractors`.
- Produces:
  - `PHOTO_CASES: PhotoCase[]` and `MATCH_CASES: MatchCase[]`;
  - `askPhoto(vision, { file, language }) → ReadItem[]`;
  - `askSenseMatch(llm, { word, target, hebrew, options }) → number | 'none'`.

- [ ] **Step 1: Add the fixtures.** Copy the seven JPEGs from `/private/tmp/claude-501/-Users-victorprp-git-lang-tutor/d2556056-3a71-4799-bc00-668eb6fe0369/scratchpad/photos/out/` into `apps/server/tests/eval/fixtures/photos/`:
  - `it-printed-hebrew.jpg`
  - `en-printed-plain.jpg`
  - `ru-printed-stress.jpg`
  - `it-whiteboard.jpg`
  - `en-handwritten-notebook.jpg`
  - `it-handwritten-plain.jpg`
  - `ru-page-noise.jpg`

  Write `README.md` there:

```markdown
# Photo fixtures

Synthetic stand-ins, made on 2026-10-07 for phase 26. The 1500 × 2000 pages were
rendered in Chromium and saved as JPEG: printed lists on tilted, shaded paper, and
handwriting in macOS's Noteworthy, Bradley Hand and Marker Felt. They prove the
path and the instruction, not accuracy on a real learner's photos. Victor's own
photos of class lists replace or join them; each needs a case in `photoCases.ts`,
and none may show a name or a face.

| File | What it holds |
|---|---|
| it-printed-hebrew.jpg | Italian textbook vocabulary with Hebrew, a heading, an exercise line and a page number |
| en-printed-plain.jpg | English list in two columns, no Hebrew, grammar labels |
| ru-printed-stress.jpg | Russian with stress marks and Hebrew |
| it-whiteboard.jpg | Italian with Hebrew in marker on a whiteboard, a date, one word crossed out |
| en-handwritten-notebook.jpg | English with Hebrew, handwritten on lined paper |
| it-handwritten-plain.jpg | Italian, handwritten in two columns, no Hebrew |
| ru-page-noise.jpg | Russian page: heading, reading text and exercise around a boxed list |
```

- [ ] **Step 2: Write the cases.** Create `apps/server/tests/eval/photoCases.ts`:

```ts
import type { LanguageCode } from '@lang-tutor/core/api';

import type { MatchOption } from '../../src/domain/senseMatching';

/**
 * Phase 26. A photo and what reading it must find. `text` lists every accepted
 * spelling, because "to" and "the" before a phrase are dropped inconsistently
 * (spec, POC findings). `hebrew` is checked when given. Tier 1 (clean printed
 * pages): every item found and nothing extra. Tier 2: one check per expected
 * item, plus one failing check per extra item.
 */
export type PhotoCase = {
  label: string;
  file: string;
  language: LanguageCode;
  tier: 1 | 2;
  expect: { text: string[]; hebrew?: string }[];
};

const one = (text: string, hebrew?: string) => ({ text: [text], ...(hebrew ? { hebrew } : {}) });
const any = (texts: string[], hebrew?: string) => ({ text: texts, ...(hebrew ? { hebrew } : {}) });

export const PHOTO_CASES: PhotoCase[] = [
  {
    label: 'photo: printed Italian with Hebrew, articles dropped, heading and exercise skipped',
    file: 'it-printed-hebrew.jpg',
    language: 'it',
    tier: 1,
    expect: [
      one('casa', 'בית'), one('gatto', 'חתול'), one('finestra', 'חלון'), one('libro', 'ספר'),
      one('cucina', 'מטבח'), one('tavolo', 'שולחן'), one('sedia', 'כיסא'), one('aprire', 'לפתוח'),
      one('chiudere', 'לסגור'), any(['camera da letto', 'la camera da letto'], 'חדר שינה'),
      one('in bocca al lupo', 'בהצלחה'),
    ],
  },
  {
    label: 'photo: printed English in two columns, grammar labels dropped',
    file: 'en-printed-plain.jpg',
    language: 'en',
    tier: 1,
    expect: [
      one('run'), one('bank'), any(['look after', 'to look after']), one('kitchen'), one('window'),
      any(['borrow', 'to borrow']), one('although'), any(['weather', 'the weather']),
      any(['give up', 'to give up']), one('break a leg'),
    ],
  },
  {
    label: 'photo: printed Russian with stress marks and Hebrew',
    file: 'ru-printed-stress.jpg',
    language: 'ru',
    tier: 1,
    expect: [
      one('молоко', 'חלב'), one('окно', 'חלון'), one('книга', 'ספר'), one('собака', 'כלב'),
      one('говорить', 'לדבר'), one('красивый', 'יפה'), any(['как дела?', 'как дела'], 'מה שלומך?'),
      one('лук', 'בצל'),
    ],
  },
  {
    label: 'photo: Italian whiteboard, crossed-out word and date skipped',
    file: 'it-whiteboard.jpg',
    language: 'it',
    tier: 2,
    expect: [
      one('mare', 'ים'), one('spiaggia', 'חוף'), one('nuotare', 'לשחות'), one('sole', 'שמש'),
      one('sabbia', 'חול'), one('abbronzarsi', 'להשתזף'), any(['costume da bagno', 'il costume da bagno'], 'בגד ים'),
    ],
  },
  {
    label: 'photo: handwritten English notebook with Hebrew',
    file: 'en-handwritten-notebook.jpg',
    language: 'en',
    tier: 2,
    expect: [
      any(['borrow', 'to borrow'], 'ללוות'), any(['lend', 'to lend'], 'להשאיל'), one('although', 'למרות ש'),
      one('crowded', 'צפוף'), any(['give up', 'to give up'], 'לוותר'), any(['weather', 'the weather'], 'מזג אוויר'),
      one('bank', 'גדה'), any(['look after', 'to look after'], 'לטפל ב'), one('tired', 'עייף'),
    ],
  },
  {
    label: 'photo: handwritten Italian in two columns, no Hebrew',
    file: 'it-handwritten-plain.jpg',
    language: 'it',
    tier: 2,
    expect: [
      one('mela'), one('pane'), one('formaggio'), one('mangiare'), one('bere'),
      one('forchetta'), one('coltello'), one('bicchiere'), one('conto'), one('buon appetito'),
    ],
  },
  {
    label: 'photo: Russian page, only the boxed list is vocabulary',
    file: 'ru-page-noise.jpg',
    language: 'ru',
    tier: 2,
    expect: [
      one('улица', 'רחוב'), one('автобус', 'אוטובוס'), one('работа', 'עבודה'), one('рынок', 'שוק'),
      one('идти пешком', 'ללכת ברגל'),
    ],
  },
];

/**
 * Phase 26. The match call, asked only when no printed gloss equals a sense's
 * translation, so every case here is one the free check cannot settle. `expect`
 * is the 0-based option index, or 'none'.
 */
export type MatchCase = {
  label: string;
  word: string;
  target: LanguageCode;
  hebrew: string;
  options: MatchOption[];
  expect: number | 'none';
  tier: 1 | 2;
};

const noun = (translation: string): MatchOption => ({ translation, part_of_speech: 'noun' });
const verb = (translation: string): MatchOption => ({ translation, part_of_speech: 'verb' });

export const MATCH_CASES: MatchCase[] = [
  { label: 'match: a longer phrase names the river sense', word: 'bank', target: 'en', hebrew: 'גדת נהר', options: [noun('בנק'), noun('גדה')], expect: 1, tier: 1 },
  { label: 'match: the article does not hide the sense', word: 'casa', target: 'it', hebrew: 'הבית', options: [noun('בית'), noun('משפחה')], expect: 0, tier: 1 },
  { label: 'match: another gender is the same sense', word: 'stanca', target: 'it', hebrew: 'עייפה', options: [{ translation: 'עייף', part_of_speech: 'adjective' }], expect: 0, tier: 1 },
  { label: 'match: a bench is not a bank', word: 'banca', target: 'it', hebrew: 'ספסל', options: [noun('בנק')], expect: 'none', tier: 1 },
  { label: 'match: a bow is not an onion', word: 'лук', target: 'ru', hebrew: 'קשת', options: [noun('בצל')], expect: 'none', tier: 1 },
  { label: 'match: a synonym of the money sense', word: 'bank', target: 'en', hebrew: 'מוסד כספי', options: [noun('בנק'), noun('גדה')], expect: 0, tier: 2 },
  { label: 'match: a near-synonym verb', word: 'give up', target: 'en', hebrew: 'להתייאש', options: [verb('לוותר'), verb('להפסיק')], expect: 0, tier: 2 },
  { label: 'match: "not heavy" is the weight sense', word: 'light', target: 'en', hebrew: 'לא כבד', options: [noun('אור'), { translation: 'קל', part_of_speech: 'adjective' }, { translation: 'בהיר', part_of_speech: 'adjective' }], expect: 1, tier: 2 },
];
```

- [ ] **Step 3: Write the askers.** Create `apps/server/tests/eval/askPhoto.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LanguageCode } from '@lang-tutor/core/api';

import { buildPhotoReadingPrompt, parsePhotoReading, type ReadItem } from '../../src/domain/photoReading';
import { buildSenseMatchPrompt, parseSenseMatch, type MatchOption } from '../../src/domain/senseMatching';
import type { LlmClient, VisionClient } from '../../src/services/llm';

/** Phase 26. The real reading prompt and parser, as readPhoto uses them,
 *  minus the database and the queue. */
export async function askPhoto(vision: VisionClient, input: { file: string; language: LanguageCode }): Promise<ReadItem[]> {
  const data = readFileSync(join(__dirname, 'fixtures', 'photos', input.file)).toString('base64');
  const raw = await vision({ ...buildPhotoReadingPrompt(input.language), image: { data, mimeType: 'image/jpeg' } });
  if (raw === '') return [];
  const reading = parsePhotoReading(raw);
  if (!reading) throw new Error(`unreadable reading: ${raw.slice(0, 200)}`);
  return reading.items;
}

/** Phase 26. The real match prompt and parser, as lookUpItem uses them. */
export async function askSenseMatch(
  llm: LlmClient,
  input: { word: string; target: LanguageCode; hebrew: string; options: MatchOption[] },
): Promise<number | 'none'> {
  const raw = await llm(buildSenseMatchPrompt(input));
  const answer = parseSenseMatch(raw, input.options.length);
  if (answer === null) throw new Error(`unreadable match: ${raw.slice(0, 200)}`);
  return answer;
}
```

- [ ] **Step 4: Score them in `run.ts`.** In `apps/server/tests/eval/run.ts`:
  1. Import `PHOTO_CASES`, `MATCH_CASES`, `PhotoCase` and `MatchCase` from `./photoCases`; `askPhoto` and `askSenseMatch` from `./askPhoto`; `createGeminiVisionClient` from `../../src/providers/gemini`; `comparable` from `../../src/domain/distractors`; `stripStress` from `../../src/domain/languages`; and `ReadItem` as a type.
  2. Add the photo timeout beside `TIMEOUT_MS`: `const PHOTO_TIMEOUT_MS = 120_000;` (a read's production budget).
  3. Add these scorers above `main`:

```ts
const sameText = (a: string, b: string) =>
  stripStress(a).replace(/\s+/g, ' ').trim().toLowerCase() === stripStress(b).replace(/\s+/g, ' ').trim().toLowerCase();

/** Phase 26. Each expected item is found when some read item has one of its
 *  spellings and, if Hebrew is expected, the same Hebrew after folding. Every
 *  read item no expectation claims is an extra. */
function photoChecks(kase: PhotoCase, items: ReadItem[]): Check[] {
  const claimed = new Set<number>();
  const checks: Check[] = kase.expect.map((expected) => {
    const index = items.findIndex(
      (item, i) =>
        !claimed.has(i) &&
        expected.text.some((text) => sameText(text, item.text)) &&
        (expected.hebrew === undefined || comparable(item.hebrew ?? '') === comparable(expected.hebrew)),
    );
    if (index !== -1) claimed.add(index);
    return {
      name: `found ${expected.text[0]}${expected.hebrew ? ` = ${expected.hebrew}` : ''}`,
      ok: index !== -1,
    };
  });
  items.forEach((item, i) => {
    if (!claimed.has(i)) checks.push({ name: `no extra item`, ok: false, detail: `${item.text}${item.hebrew ? ` = ${item.hebrew}` : ''}` });
  });
  return checks;
}

function matchCheck(kase: MatchCase, answer: number | 'none'): Check[] {
  return [{ name: `chose ${kase.expect === 'none' ? 'none' : `sense ${kase.expect + 1}`}`, ok: answer === kase.expect, detail: `${answer === 'none' ? 'none' : `sense ${answer + 1}`}` }];
}
```

  4. In `Row`, add `photo?: ReadItem[];` and `match?: number | 'none';`.
  5. In `main`:
     - filter `PHOTO_CASES` by `matches(kase.label, kase.file)` and `MATCH_CASES` by `matches(kase.label, kase.word)`;
     - include their counts in the "matched no case" check and in the final summary line, as `+ N photo + N match`;
     - build `const vision = createGeminiVisionClient({ fetch: globalThis.fetch, baseUrl: gemini.baseUrl, apiKey: gemini.apiKey, model: gemini.model, timeoutMs: PHOTO_TIMEOUT_MS });`;
     - add two scorers with the same catch-and-score-as-tier-1 contract as `scoreDistractors`:

```ts
  const scorePhoto = async (kase: PhotoCase): Promise<Row> => {
    try {
      const items = await askPhoto(vision, { file: kase.file, language: kase.language });
      const checks = photoChecks(kase, items);
      return { label: kase.label, text: kase.file, tier1: kase.tier === 1 ? checks : [], tier2: kase.tier === 2 ? checks : [], photo: items };
    } catch (error) {
      return { label: kase.label, text: kase.file, tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }], tier2: [], error: (error as Error).message };
    }
  };

  const scoreMatch = async (kase: MatchCase): Promise<Row> => {
    const text = `${kase.word} ← ${kase.hebrew}`;
    try {
      const answer = await askSenseMatch(llm, { word: kase.word, target: kase.target, hebrew: kase.hebrew, options: kase.options });
      const checks = matchCheck(kase, answer);
      return { label: kase.label, text, tier1: kase.tier === 1 ? checks : [], tier2: kase.tier === 2 ? checks : [], match: answer };
    } catch (error) {
      return { label: kase.label, text, tier1: [{ name: 'the call succeeded', ok: false, detail: (error as Error).message }], tier2: [], error: (error as Error).message };
    }
  };
```

     - add `mapWithConcurrency(photoCases, CONCURRENCY, scorePhoto)` and `mapWithConcurrency(matchCases, CONCURRENCY, scoreMatch)` to the `Promise.all`, and append their rows to `rows`;
     - in the scorecard loop, print `row.photo` as `items=` followed by each `text=hebrew` joined with `' | '`, and `row.match` as `chose=`.

- [ ] **Step 5: Run the new cases against the real model.**
Run: `cd apps/server && npx tsx tests/eval/run.ts "photo:"`, then `npx tsx tests/eval/run.ts "match:"`.
Expected: tier 1 has 0 failures. Tier 2 is at or above 85%. Then run the whole eval with `npx tsx tests/eval/run.ts`, which needs the same `GEMINI_API_KEY` and `GEMINI_MODEL` the session already has. Expected: exit 0.
  - If a photo case fails, change the instruction in `domain/photoReading.ts`, never the threshold or the case. Rerun Task 2's unit tests after any prompt change.
  - If a match case fails, change `buildSenseMatchPrompt`'s instruction, not the case.
  - If, after two honest attempts, a tier 2 case is truly ambiguous, report it as a concern rather than deleting it.

- [ ] **Step 6: Typecheck and commit.** Run `npm run typecheck` and `npm run lint:arch` from the root. ADR 0001 R11 exempts `tests/eval/`.

```bash
git add apps/server/tests/eval
git commit -m "test(server): eval cases for reading photos and matching printed Hebrew to a sense"
```

---
### Task 11: The photo picker, and ADR 0002 widened for it

**Files:**
- Modify: `apps/mobile/package.json` and the root `package-lock.json` (two dependencies), `apps/mobile/app.json`
- Create: `apps/mobile/src/photos.ts`
- Test: `apps/mobile/src/photos.test.ts`
- Modify: `apps/mobile/src/app/_layout.tsx` (builds the engine)
- Modify: `docs/adr/adr-0002-di-with-closures.md`, `scripts/check-adr-0002-di-with-closures.sh`

**Interfaces:**
- Produces:
  - `type PhotoAsset = { uri: string; width: number; height: number }`;
  - `type PhotoEngine = { requestCameraPermission: () => Promise<boolean>; requestLibraryPermission: () => Promise<boolean>; launchCamera: () => Promise<PhotoAsset | null>; launchLibrary: () => Promise<PhotoAsset | null>; shrink: (uri: string, resize: { width: number } | { height: number } | null) => Promise<string> }`;
  - `type Photo = { base64: string; mimeType: 'image/jpeg' }`;
  - `type PickResult = { kind: 'photo'; photo: Photo } | { kind: 'cancelled' } | { kind: 'denied' }`;
  - `MAX_EDGE = 2048`;
  - `resizeFor(width, height)`;
  - `createPhotoPicker({ engine, platform }) → { take(): Promise<PickResult>; choose(): Promise<PickResult> }`;
  - `type PhotoPicker = ReturnType<typeof createPhotoPicker>`.

- [ ] **Step 1: Install the packages at the SDK's pinned ranges.** `npx expo install` fails in this repo with EALLOWSCRIPTS, so install the ranges `expo install` would choose:

```bash
node -p "require('./node_modules/expo/bundledNativeModules.json')['expo-image-picker']"
node -p "require('./node_modules/expo/bundledNativeModules.json')['expo-image-manipulator']"
npm install -w apps/mobile "expo-image-picker@<range printed above>" "expo-image-manipulator@<range printed above>"
```

  Both are part of Expo Go. Read `https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/` and `https://docs.expo.dev/versions/v57.0.0/sdk/imagemanipulator/` before Step 4, as `apps/mobile/AGENTS.md` asks.

- [ ] **Step 2: Write the failing tests.** Create `apps/mobile/src/photos.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { MAX_EDGE, createPhotoPicker, resizeFor, type PhotoAsset, type PhotoEngine } from './photos';

function fakeEngine(over: Partial<{ granted: boolean; asset: PhotoAsset | null; base64: string }> = {}) {
  const calls: string[] = [];
  const shrinks: unknown[] = [];
  const engine: PhotoEngine = {
    requestCameraPermission: async () => {
      calls.push('camera-permission');
      return over.granted ?? true;
    },
    requestLibraryPermission: async () => {
      calls.push('library-permission');
      return over.granted ?? true;
    },
    launchCamera: async () => {
      calls.push('camera');
      return over.asset === undefined ? { uri: 'file:///a.jpg', width: 4032, height: 3024 } : over.asset;
    },
    launchLibrary: async () => {
      calls.push('library');
      return over.asset === undefined ? { uri: 'file:///b.jpg', width: 1200, height: 1600 } : over.asset;
    },
    shrink: async (uri, resize) => {
      shrinks.push([uri, resize]);
      return over.base64 ?? 'QUJD';
    },
  };
  return { engine, calls, shrinks };
}

describe('resizeFor', () => {
  it('shrinks the long edge to 2048 and leaves a smaller photo alone', () => {
    expect(MAX_EDGE).toBe(2048);
    expect(resizeFor(4032, 3024)).toEqual({ width: 2048 });
    expect(resizeFor(3024, 4032)).toEqual({ height: 2048 });
    expect(resizeFor(2048, 1000)).toBeNull();
    expect(resizeFor(1200, 1600)).toBeNull();
  });
});

describe('createPhotoPicker', () => {
  it('asks for the camera, shrinks the photo and returns it as JPEG base64', async () => {
    const { engine, calls, shrinks } = fakeEngine();
    const picker = createPhotoPicker({ engine, platform: 'ios' });
    expect(await picker.take()).toEqual({ kind: 'photo', photo: { base64: 'QUJD', mimeType: 'image/jpeg' } });
    expect(calls).toEqual(['camera-permission', 'camera']);
    expect(shrinks).toEqual([['file:///a.jpg', { width: 2048 }]]);
  });

  it('chooses from the gallery, and passes a small photo through unresized', async () => {
    const { engine, calls, shrinks } = fakeEngine();
    const picker = createPhotoPicker({ engine, platform: 'android' });
    expect((await picker.choose()).kind).toBe('photo');
    expect(calls).toEqual(['library-permission', 'library']);
    expect(shrinks).toEqual([['file:///b.jpg', null]]);
  });

  it('answers denied, and opens nothing, without permission', async () => {
    const { engine, calls } = fakeEngine({ granted: false });
    expect(await createPhotoPicker({ engine, platform: 'ios' }).take()).toEqual({ kind: 'denied' });
    expect(calls).toEqual(['camera-permission']);
  });

  it('answers cancelled when the learner backs out', async () => {
    const { engine } = fakeEngine({ asset: null });
    expect(await createPhotoPicker({ engine, platform: 'ios' }).choose()).toEqual({ kind: 'cancelled' });
  });

  it('asks no permission on the web, where the file chooser is the permission', async () => {
    const { engine, calls } = fakeEngine();
    await createPhotoPicker({ engine, platform: 'web' }).choose();
    expect(calls).toEqual(['library']);
  });

  it('strips a data URL prefix, which the web returns, before the upload (Review Focus 5)', async () => {
    const { engine } = fakeEngine({ base64: 'data:image/jpeg;base64,QUJD' });
    expect(await createPhotoPicker({ engine, platform: 'web' }).choose()).toEqual({
      kind: 'photo',
      photo: { base64: 'QUJD', mimeType: 'image/jpeg' },
    });
  });
});
```

  Run: `cd apps/mobile && npx jest src/photos.test.ts`. Expected: FAIL. Cannot find module `./photos`.

- [ ] **Step 3: Implement.** Create `apps/mobile/src/photos.ts`:

```ts
/**
 * Phase 26 (spec D13). Taking or choosing a photo of a word list, shrunk to
 * what the server takes: at most 2048 px on the long edge, as JPEG base64.
 *
 * The engine is received, never imported: only the composition root names
 * expo-image-picker and expo-image-manipulator (ADR 0002 R1), which is what
 * lets this be tested with a fake.
 */

export type PhotoAsset = { uri: string; width: number; height: number };

export type PhotoEngine = {
  requestCameraPermission: () => Promise<boolean>;
  requestLibraryPermission: () => Promise<boolean>;
  /** null when the learner cancels. */
  launchCamera: () => Promise<PhotoAsset | null>;
  launchLibrary: () => Promise<PhotoAsset | null>;
  /** Resizes (or not) and saves as JPEG, answering its base64. */
  shrink: (uri: string, resize: { width: number } | { height: number } | null) => Promise<string>;
};

export type Photo = { base64: string; mimeType: 'image/jpeg' };
export type PickResult = { kind: 'photo'; photo: Photo } | { kind: 'cancelled' } | { kind: 'denied' };

export const MAX_EDGE = 2048;

export function resizeFor(width: number, height: number): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= MAX_EDGE) return null;
  return width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE };
}

// The web's manipulator can answer a data URL where native answers bare base64.
const bare = (base64: string) => base64.replace(/^data:[^;,]*;base64,/, '');

export function createPhotoPicker({ engine, platform }: { engine: PhotoEngine; platform: string }) {
  const pick = async (source: 'camera' | 'library'): Promise<PickResult> => {
    // On the web the browser's file chooser is the permission.
    if (platform !== 'web') {
      const granted =
        source === 'camera' ? await engine.requestCameraPermission() : await engine.requestLibraryPermission();
      if (!granted) return { kind: 'denied' };
    }
    const asset = source === 'camera' ? await engine.launchCamera() : await engine.launchLibrary();
    if (!asset) return { kind: 'cancelled' };
    const base64 = await engine.shrink(asset.uri, resizeFor(asset.width, asset.height));
    return { kind: 'photo', photo: { base64: bare(base64), mimeType: 'image/jpeg' } };
  };
  return {
    take: () => pick('camera'),
    choose: () => pick('library'),
  };
}

export type PhotoPicker = ReturnType<typeof createPhotoPicker>;
```

  Run Step 2's command. Expected: PASS (7 tests).

- [ ] **Step 4: Build the engine at the composition root.** In `apps/mobile/src/app/_layout.tsx`, beside `createSpeaker`, build the picker from the two packages. Check each call against the v57 docs read in Step 1. This is the shape:

```ts
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { createPhotoPicker, type PhotoAsset } from '@/photos';

const firstAsset = (result: ImagePicker.ImagePickerResult): PhotoAsset | null =>
  result.canceled || result.assets.length === 0
    ? null
    : { uri: result.assets[0].uri, width: result.assets[0].width, height: result.assets[0].height };

// Phase 26. The only file that names the image packages (ADR 0002 R1).
const photoPicker = createPhotoPicker({
  platform: Platform.OS,
  engine: {
    requestCameraPermission: async () => (await ImagePicker.requestCameraPermissionsAsync()).granted,
    requestLibraryPermission: async () => (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted,
    launchCamera: async () => firstAsset(await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })),
    launchLibrary: async () => firstAsset(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })),
    shrink: async (uri, resize) => {
      const context = ImageManipulator.manipulate(uri);
      if (resize) context.resize(resize);
      const image = await context.renderAsync();
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
      return saved.base64 ?? '';
    },
  },
});
```

  Task 12 hands `photoPicker` to a provider. Until then, export nothing new, and keep it referenced by Task 12 in the same PR.

  In `apps/mobile/app.json`, add to `plugins`:

```json
["expo-image-picker", {
  "photosPermission": "The app reads photos of your word lists to add their words.",
  "cameraPermission": "The app photographs your word lists to add their words."
}]
```

- [ ] **Step 5: Widen ADR 0002 R1, and prove the check fires.** Before changing the script, plant a violation and confirm the current check misses it:

```bash
printf "import * as ImagePicker from 'expo-image-picker';\nexport const x = ImagePicker;\n" > apps/mobile/src/plantedViolation.ts
bash scripts/check-adr-0002-di-with-closures.sh
```

  Expected: R1 still reports `ok`, because the check does not know the package. Now change the `r1_mobile` grep in `scripts/check-adr-0002-di-with-closures.sh` to:

```bash
  grep -rln "from '@react-native-async-storage/async-storage'\|from 'expo-crypto'\|from 'expo-speech'\|from 'expo-audio'\|from 'expo-image-picker'\|from 'expo-image-manipulator'" apps/mobile/src --include='*.ts' --include='*.tsx' \
```

  and its label to `"R1  AsyncStorage/expo-crypto/expo-speech/expo-audio/expo-image-picker/expo-image-manipulator imported only at _layout.tsx"`. Run the script again. Expected: R1 now FAILS, naming `apps/mobile/src/plantedViolation.ts`. Delete the planted file, run the script again, and expect every rule `ok`. Do not commit the planted file.

  In `docs/adr/adr-0002-di-with-closures.md`:
  - the Date line gains `; R1 widened 2026-10-07 (phase 26): expo-image-picker and expo-image-manipulator`;
  - R1's table row lists the two packages;
  - the R1 command in "How to detect a violation" matches the script verbatim;
  - R6's factory list gains `createPhotoImportRepo`, `createPhotoImportService`, `createGeminiVisionClient` and `createPhotoPicker`;
  - "Why" gains: "`expo-image-picker` and `expo-image-manipulator` joined R1 in phase 26. A camera and a photo library are I/O exactly as a speech engine is, and keeping them at the root is what lets `src/photos.ts` be tested with a fake engine."

- [ ] **Step 6: Run the checks and commit.** From the root: `npm run typecheck`, `npm run lint:arch`, `cd apps/mobile && npx jest`. Expected: all pass.

```bash
git add apps/mobile/package.json package-lock.json apps/mobile/app.json apps/mobile/src/photos.ts apps/mobile/src/photos.test.ts apps/mobile/src/app/_layout.tsx docs/adr/adr-0002-di-with-closures.md scripts/check-adr-0002-di-with-closures.sh
git commit -m "feat(mobile): a photo picker that shrinks to 2048 px, with ADR 0002 R1 widened for it"
```

---

### Task 12: The app's client, the review rules and the provider

**Files:**
- Modify: `apps/mobile/src/api/client.ts`, `apps/mobile/src/api/client.test.ts`
- Create: `apps/mobile/src/photoImports.ts`, `apps/mobile/src/photoImports.test.ts`
- Create: `apps/mobile/src/hooks/usePhotoImports.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx` (adds the provider)

**Interfaces:**
- Consumes: the core types (Task 1); `PhotoPicker`, `Photo` and `PickResult` (Task 11); `toggleOptimistically` from `src/vocabulary.ts`; `useCurrentUser().active`.
- Produces:
  - in `ApiClient`:
    - `createPhotoImport(enrollmentId, request: PhotoImportCreateRequest): Promise<PhotoImportSummary>`;
    - `listPhotoImports(enrollmentId): Promise<PhotoImportSummary[]>`;
    - `getPhotoImport(id): Promise<PhotoImport>`;
    - `updatePhotoImportItem(id, position, update: PhotoImportItemUpdate): Promise<PhotoImportItem>`;
    - `savePhotoImport(id): Promise<SaveVocabularyResponse>`;
    - `discardPhotoImport(id): Promise<void>`;
  - in `src/photoImports.ts`:
    - `IMPORT_POLL_INTERVAL_MS = 2_000`;
    - `isWorking(status)`;
    - `shouldPollImport(imp: PhotoImport | null)`;
    - `tickedCount(imp)`;
    - `canSave(imp)`;
    - `chosenOption(item)`;
    - `withChange(imp, position, change: PhotoImportItemUpdate)`;
    - `mergePolled(polled: PhotoImport, local: PhotoImport, inFlight: ReadonlySet<number>)`;
    - `type HomePhotoCard`;
    - `homePhotoCard(imports: PhotoImportSummary[]): HomePhotoCard`;
  - `PhotoImportsProvider({ api, picker, children })` and `usePhotoImports()`, which returns `{ imports, loadFailed, reload, pick, upload, fetchImport, updateItem, save, discard }`.

- [ ] **Step 1: Write the failing client tests.** Append to `apps/mobile/src/api/client.test.ts`, following its `buildClient(mockFetch)` style:

```ts
describe('photo imports', () => {
  it('uploads to the enrollment, patches a row, saves and discards', async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const mockFetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const status = url.endsWith('/discard') ? 204 : 200;
      return { ok: true, status, json: async () => ({}) };
    });
    const client = buildClient(mockFetch as unknown as jest.Mock);
    await client.createPhotoImport('e 1', { mime_type: 'image/jpeg', image: 'QUJD' });
    await client.listPhotoImports('e 1');
    await client.getPhotoImport('i1');
    await client.updatePhotoImportItem('i1', 3, { ticked: false });
    await client.savePhotoImport('i1');
    await client.discardPhotoImport('i1');
    expect(calls.map(({ url, method }) => [method ?? 'GET', url.replace('http://test.local', '')])).toEqual([
      ['POST', '/api/enrollments/e%201/photo-imports'],
      ['GET', '/api/enrollments/e%201/photo-imports'],
      ['GET', '/api/photo-imports/i1'],
      ['PATCH', '/api/photo-imports/i1/items/3'],
      ['POST', '/api/photo-imports/i1/save'],
      ['POST', '/api/photo-imports/i1/discard'],
    ]);
    expect(calls[3].body).toEqual({ ticked: false });
  });
});
```

  Adjust the `mockFetch` typing to match how the file's other tests build theirs.

- [ ] **Step 2: Implement the client.** In `apps/mobile/src/api/client.ts`:
  - add a `patchJson<TResponse>(path, body)` helper beside `postJson`, the same except `method: 'PATCH'`;
  - add a `postNoContent(path): Promise<void>` that POSTs `{}` as JSON and throws `await failureOf(res)` unless `res.ok`, reading no body;
  - add the methods:

```ts
    // Phase 26. Words from a photo.
    createPhotoImport: (enrollmentId: string, request: PhotoImportCreateRequest) =>
      postJson<PhotoImportSummary>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/photo-imports`, request),
    listPhotoImports: (enrollmentId: string) =>
      getJson<PhotoImportSummary[]>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/photo-imports`),
    getPhotoImport: (id: string) => getJson<PhotoImport>(`/api/photo-imports/${encodeURIComponent(id)}`),
    updatePhotoImportItem: (id: string, position: number, update: PhotoImportItemUpdate) =>
      patchJson<PhotoImportItem>(`/api/photo-imports/${encodeURIComponent(id)}/items/${position}`, update),
    savePhotoImport: (id: string) =>
      postJson<SaveVocabularyResponse>(`/api/photo-imports/${encodeURIComponent(id)}/save`, {}),
    discardPhotoImport: (id: string) => postNoContent(`/api/photo-imports/${encodeURIComponent(id)}/discard`),
```

  Run: `cd apps/mobile && npx jest src/api/client.test.ts`. Expected: PASS.

- [ ] **Step 3: Write the failing tests for the review rules.** Create `apps/mobile/src/photoImports.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { PhotoImport, PhotoImportItem, PhotoImportSummary } from '@lang-tutor/core/api';

import { canSave, chosenOption, homePhotoCard, mergePolled, shouldPollImport, tickedCount, withChange } from './photoImports';

const option = (n: number) => ({ sense_id: `s${n}`, variant_id: `v${n}`, translation: `t${n}` });
const item = (position: number, over: Partial<PhotoImportItem> = {}): PhotoImportItem => ({
  position, text: `w${position}`, hebrew: null, status: 'ready', corrected_form: null,
  options: [option(1), option(2)], chosen_sense_id: 's1', ticked: true, hebrew_mismatch: false, reason: null, ...over,
});
const imp = (items: PhotoImportItem[], status: PhotoImport['status'] = 'ready'): PhotoImport => ({
  id: 'i1', status, item_count: items.length, settled_count: items.length, created_at: '2026-10-07T10:00:00Z', items,
});
const summary = (id: string, status: PhotoImportSummary['status'], count = 3): PhotoImportSummary => ({
  id, status, item_count: count, settled_count: count, created_at: '2026-10-07T10:00:00Z',
});

describe('polling and saving', () => {
  it('polls only while reading or looking up', () => {
    expect(shouldPollImport(null)).toBe(false);
    expect(shouldPollImport(imp([], 'reading'))).toBe(true);
    expect(shouldPollImport(imp([], 'looking_up'))).toBe(true);
    expect(shouldPollImport(imp([], 'ready'))).toBe(false);
    expect(shouldPollImport(imp([], 'failed'))).toBe(false);
  });

  it('counts ticked ready rows, and saves only a ready import with something ticked', () => {
    const rows = [item(0), item(1, { ticked: false }), item(2, { status: 'pending', ticked: false })];
    expect(tickedCount(imp(rows))).toBe(1);
    expect(canSave(imp(rows))).toBe(true);
    expect(canSave(imp([item(0, { ticked: false })]))).toBe(false);
    expect(canSave(imp([item(0)], 'looking_up'))).toBe(false);
  });
});

describe('withChange', () => {
  it('applies a tick and a sense switch to one row', () => {
    const next = withChange(imp([item(0), item(1)]), 1, { ticked: false, sense_id: 's2' });
    expect(next.items[1]).toMatchObject({ ticked: false, chosen_sense_id: 's2' });
    expect(next.items[0]).toEqual(item(0));
    expect(chosenOption(next.items[1])).toEqual(option(2));
  });
});

describe('mergePolled', () => {
  it('takes the server’s rows, except those with a change still in flight', () => {
    const local = withChange(imp([item(0), item(1, { status: 'pending', options: [], chosen_sense_id: null, ticked: false })], 'looking_up'), 0, { ticked: false });
    const polled = imp([item(0), item(1)], 'ready');
    const merged = mergePolled(polled, local, new Set([0]));
    expect(merged.status).toBe('ready');
    expect(merged.items[0].ticked).toBe(false);
    expect(merged.items[1]).toEqual(item(1));
  });
});

describe('homePhotoCard', () => {
  it('shows nothing, one import, or a count of several', () => {
    expect(homePhotoCard([])).toBeNull();
    expect(homePhotoCard([summary('a', 'reading')])).toEqual({ kind: 'working', id: 'a' });
    expect(homePhotoCard([summary('a', 'ready', 32)])).toEqual({ kind: 'ready', id: 'a', count: 32 });
    expect(homePhotoCard([summary('a', 'failed')])).toEqual({ kind: 'failed', id: 'a' });
    expect(homePhotoCard([summary('a', 'ready'), summary('b', 'reading')])).toEqual({ kind: 'several', count: 2 });
  });
});
```

  Run: `cd apps/mobile && npx jest src/photoImports.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement the rules.** Create `apps/mobile/src/photoImports.ts`:

```ts
import type {
  PhotoImport,
  PhotoImportItem,
  PhotoImportItemUpdate,
  PhotoImportOption,
  PhotoImportStatus,
  PhotoImportSummary,
} from '@lang-tutor/core/api';

/** Phase 26 (spec D13). The review's rules, kept out of the screen so they are
 *  tested without rendering. */

export const IMPORT_POLL_INTERVAL_MS = 2_000;

export const isWorking = (status: PhotoImportStatus): boolean => status === 'reading' || status === 'looking_up';

export const shouldPollImport = (imp: PhotoImport | null): boolean => imp !== null && isWorking(imp.status);

export const tickedCount = (imp: PhotoImport): number =>
  imp.items.filter((item) => item.status === 'ready' && item.ticked).length;

export const canSave = (imp: PhotoImport): boolean => imp.status === 'ready' && tickedCount(imp) > 0;

export const chosenOption = (item: PhotoImportItem): PhotoImportOption | null =>
  item.options.find((option) => option.sense_id === item.chosen_sense_id) ?? null;

/** The optimistic copy of a change, before the server answers. */
export function withChange(imp: PhotoImport, position: number, change: PhotoImportItemUpdate): PhotoImport {
  return {
    ...imp,
    items: imp.items.map((item) =>
      item.position !== position
        ? item
        : {
            ...item,
            ...(change.ticked !== undefined ? { ticked: change.ticked } : {}),
            ...(change.sense_id !== undefined ? { chosen_sense_id: change.sense_id } : {}),
          },
    ),
  };
}

/** A poll's answer, minus the rows whose change has not landed yet, so a
 *  stale poll never undoes a tap. */
export function mergePolled(polled: PhotoImport, local: PhotoImport, inFlight: ReadonlySet<number>): PhotoImport {
  if (inFlight.size === 0) return polled;
  const mine = new Map(local.items.map((item) => [item.position, item]));
  return {
    ...polled,
    items: polled.items.map((item) => (inFlight.has(item.position) ? (mine.get(item.position) ?? item) : item)),
  };
}

export type HomePhotoCard =
  | { kind: 'working'; id: string }
  | { kind: 'ready'; id: string; count: number }
  | { kind: 'failed'; id: string }
  | { kind: 'several'; count: number }
  | null;

/** What home's card says (spec D13): nothing, the one import, or how many. */
export function homePhotoCard(imports: readonly PhotoImportSummary[]): HomePhotoCard {
  if (imports.length === 0) return null;
  if (imports.length > 1) return { kind: 'several', count: imports.length };
  const [only] = imports;
  if (isWorking(only.status)) return { kind: 'working', id: only.id };
  if (only.status === 'failed') return { kind: 'failed', id: only.id };
  return { kind: 'ready', id: only.id, count: only.item_count };
}
```

  Run Step 3's command. Expected: PASS.

- [ ] **Step 5: Write the provider.** Create `apps/mobile/src/hooks/usePhotoImports.tsx`, shaped like the other providers: `useMemo` value, a `generation` ref for stale answers, a throw guard, and a reset on `[active]`:

```tsx
import type {
  PhotoImport,
  PhotoImportItem,
  PhotoImportItemUpdate,
  PhotoImportSummary,
  SaveVocabularyResponse,
} from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { Photo, PhotoPicker, PickResult } from '@/photos';

type PhotoImportsValue = {
  /** The active enrollment's open imports, newest first. */
  imports: PhotoImportSummary[];
  loadFailed: boolean;
  reload: () => void;
  pick: (source: 'camera' | 'gallery') => Promise<PickResult>;
  upload: (photo: Photo) => Promise<PhotoImportSummary>;
  fetchImport: (id: string) => Promise<PhotoImport>;
  updateItem: (id: string, position: number, update: PhotoImportItemUpdate) => Promise<PhotoImportItem>;
  save: (id: string) => Promise<SaveVocabularyResponse>;
  discard: (id: string) => Promise<void>;
};

const PhotoImportsContext = createContext<PhotoImportsValue | null>(null);

export function PhotoImportsProvider({ api, picker, children }: { api: ApiClient; picker: PhotoPicker; children: ReactNode }) {
  const { active } = useCurrentUser();
  const [imports, setImports] = useState<PhotoImportSummary[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setImports([]);
    setLoadFailed(false);
  }, [active]);

  const reload = useCallback(() => {
    if (!active) return;
    const mine = ++generation.current;
    api
      .listPhotoImports(active.id)
      .then((list) => {
        if (mine !== generation.current) return;
        setImports(list);
        setLoadFailed(false);
      })
      .catch(() => {
        if (mine === generation.current) setLoadFailed(true);
      });
  }, [api, active]);

  const value = useMemo<PhotoImportsValue>(
    () => ({
      imports,
      loadFailed,
      reload,
      pick: (source) => (source === 'camera' ? picker.take() : picker.choose()),
      upload: async (photo) => {
        if (!active) throw new Error('no active enrollment');
        return api.createPhotoImport(active.id, { mime_type: photo.mimeType, image: photo.base64 });
      },
      fetchImport: (id) => api.getPhotoImport(id),
      updateItem: (id, position, update) => api.updatePhotoImportItem(id, position, update),
      save: (id) => api.savePhotoImport(id),
      discard: (id) => api.discardPhotoImport(id),
    }),
    [api, picker, active, imports, loadFailed, reload],
  );

  return <PhotoImportsContext.Provider value={value}>{children}</PhotoImportsContext.Provider>;
}

export function usePhotoImports(): PhotoImportsValue {
  const value = useContext(PhotoImportsContext);
  if (!value) throw new Error('usePhotoImports must be used inside a PhotoImportsProvider');
  return value;
}
```

  Check `useCurrentUser`'s import path and the `@/` alias against existing hooks, and match them. In `apps/mobile/src/app/_layout.tsx`, nest `<PhotoImportsProvider api={api} picker={photoPicker}>` inside `VocabularyProvider`, wrapping what it wraps today.

- [ ] **Step 6: Run the checks and commit.** From the root: `npm run typecheck`, `npm run lint:arch`, `cd apps/mobile && npx jest`. Expected: all pass.

```bash
git add apps/mobile/src/api apps/mobile/src/photoImports.ts apps/mobile/src/photoImports.test.ts apps/mobile/src/hooks/usePhotoImports.tsx apps/mobile/src/app/_layout.tsx
git commit -m "feat(mobile): the photo import client, its review rules and provider"
```

---

### Task 13: The screens

**Files:**
- Modify: `apps/mobile/src/strings.ts`, `apps/mobile/src/strings.test.ts` (if it lists keys)
- Create: `apps/mobile/src/app/photo-imports/index.tsx`, `apps/mobile/src/app/photo-imports/[id].tsx`
- Modify: `apps/mobile/src/app/index.tsx` (home)

**Interfaces:**
- Consumes: `usePhotoImports()` (Task 12); `homePhotoCard`, `shouldPollImport`, `IMPORT_POLL_INTERVAL_MS`, `withChange`, `mergePolled`, `canSave`, `tickedCount`, `chosenOption` (Task 12); `toggleOptimistically` if it fits, otherwise the same apply, request, revert shape inline; `confirm` from `src/confirm.ts`; `useCurrentUser().active`; `strings`, `isolateLtr`.
- Produces these testIDs, which e2e (Task 14) depends on:
  - home: `photo-import-entry` (button), `home-photo-card` (card), `home-photo-saved` (notice after a save);
  - list screen: `photo-import-take`, `photo-import-choose`, `photo-import-open` (each open import), `photo-import-error`, `photo-import-back`;
  - review: `photo-import-status`, `photo-import-row` (each row), `photo-import-tick` (each row's tick), `photo-import-word`, `photo-import-meaning` (the pressable chosen meaning), `photo-import-option` (each option while the list is open), `photo-import-note` (each note), `photo-import-save`, `photo-import-discard`, `photo-import-empty`, `photo-import-review-back`.

- [ ] **Step 1: Add the strings.** In `apps/mobile/src/strings.ts`, inside `strings`, in its style. Numbers go through `isolateLtr`, as `vocabularyMark` does:

```ts
  // Phase 26. Words from a photo.
  photoImportEntry: 'מילים מתמונה',
  photoImportTitle: 'מילים מתמונה',
  photoImportTake: 'צילום רשימה',
  photoImportChoose: 'בחירה מהגלריה',
  photoImportOpenTitle: 'רשימות פתוחות',
  photoImportDenied: 'אין הרשאה למצלמה או לגלריה. אפשר לאשר אותה בהגדרות.',
  photoImportUploadFailed: 'שליחת התמונה נכשלה. נסו שוב.',
  photoImportReading: 'קוראים את התמונה…',
  photoImportLookingUp: (done: number, total: number) => `מחפשים מילים: ${isolateLtr(`${done}/${total}`)}`,
  photoImportReady: 'מוכן לסקירה',
  photoImportFailed: 'לא הצלחנו לקרוא את התמונה',
  photoImportNoWords: (language: string) => `לא נמצאו מילים ב${language} בתמונה`,
  photoImportReadAs: (text: string) => `נקרא כ: ${text}`,
  photoImportListSays: (hebrew: string) => `ברשימה כתוב: ${hebrew}`,
  photoImportReasonSentence: 'משפט שלם — אי אפשר לשמור',
  photoImportReasonNoMeaning: 'לא נמצאה משמעות',
  photoImportReasonNotInLanguage: 'לא בשפה הנלמדת',
  photoImportRowFailed: 'החיפוש נכשל',
  photoImportPending: 'מחפשים…',
  photoImportSave: (count: number) => `שמירת ${isolateLtr(String(count))} מילים`,
  photoImportDiscard: 'ביטול הרשימה',
  photoImportDiscardTitle: 'לבטל את הרשימה?',
  photoImportDiscardMessage: 'המילים שבה לא יישמרו.',
  photoImportDiscardConfirm: 'ביטול הרשימה',
  photoImportDiscardCancel: 'חזרה',
  photoImportSaved: (count: number) => `${isolateLtr(String(count))} מילים נשמרו`,
  homePhotoWorking: 'קוראים את התמונה שלך…',
  homePhotoReady: (count: number) => `רשימה מתמונה: ${isolateLtr(String(count))} מילים לסקירה`,
  homePhotoFailed: 'לא הצלחנו לקרוא את התמונה ששלחת',
  homePhotoSeveral: (count: number) => `${isolateLtr(String(count))} רשימות מתמונות מחכות לסקירה`,
```

- [ ] **Step 2: Write the list screen.** Create `apps/mobile/src/app/photo-imports/index.tsx`. Copy the structure and `StyleSheet` conventions of `app/vocabulary/index.tsx`: SafeAreaView, a back Pressable, a title, `useFocusEffect(reload)`, a `Redirect` when there is no active enrollment, and styles at the bottom from `@/theme`. Behaviour:
  - Two buttons, `photo-import-take` and `photo-import-choose`. Each calls `pick('camera' | 'gallery')`:
    - `denied` shows `strings.photoImportDenied` in `photo-import-error`;
    - `cancelled` does nothing;
    - `photo` sets a busy flag, which disables both buttons and shows an `ActivityIndicator`, then calls `upload(photo)`. On success: `router.replace(\`/photo-imports/${summary.id}\`)`. On failure: `strings.photoImportUploadFailed` in `photo-import-error`, and the photo is kept in state so the same button retries it without re-picking. Keep it simple: a "try again" Pressable that re-uploads the kept photo, with testID `photo-import-retry`.
  - Under `strings.photoImportOpenTitle`, one `photo-import-open` Pressable per `imports` entry, showing its status text:
    - `reading`: `photoImportReading`;
    - `looking_up`: `photoImportLookingUp(settled, total)`;
    - `ready`: `photoImportReady` with the count;
    - `failed`: `photoImportFailed`.

    It opens `/photo-imports/{id}`.

- [ ] **Step 3: Write the review screen.** Create `apps/mobile/src/app/photo-imports/[id].tsx`. The state and effects are below; render with the vocabulary screen's components and styles:

```tsx
const { id } = useLocalSearchParams<{ id: string }>();
const { fetchImport, updateItem, save, discard } = usePhotoImports();
const { active } = useCurrentUser();
const [imp, setImp] = useState<PhotoImport | null>(null);
const [loadFailed, setLoadFailed] = useState(false);
const [open, setOpen] = useState<number | null>(null);      // the row whose options are showing
const [busy, setBusy] = useState(false);                     // a save or discard in flight
const inFlight = useRef(new Set<number>());
const latest = useRef<PhotoImport | null>(null);
latest.current = imp;

const load = useCallback(() => {
  fetchImport(id)
    .then((polled) => {
      setImp((local) => (local ? mergePolled(polled, local, inFlight.current) : polled));
      setLoadFailed(false);
    })
    .catch(() => setLoadFailed(true));
}, [fetchImport, id]);

useFocusEffect(useCallback(() => load(), [load]));
const polling = shouldPollImport(imp);
useFocusEffect(
  useCallback(() => {
    if (!polling) return undefined;
    const timer = setInterval(load, IMPORT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, load]),
);

const change = async (position: number, update: PhotoImportItemUpdate) => {
  const before = latest.current;
  if (!before) return;
  inFlight.current.add(position);
  setImp(withChange(before, position, update));
  try {
    const item = await updateItem(id, position, update);
    setImp((current) => (current ? { ...current, items: current.items.map((row) => (row.position === position ? item : row)) } : current));
  } catch {
    setImp((current) => {
      const original = before.items.find((row) => row.position === position);
      return current && original
        ? { ...current, items: current.items.map((row) => (row.position === position ? original : row)) }
        : current;
    });
  } finally {
    inFlight.current.delete(position);
  }
};

const onSave = async () => {
  if (!imp) return;
  setBusy(true);
  try {
    const { saved_sense_ids } = await save(id);
    router.replace({ pathname: '/', params: { photoSaved: String(saved_sense_ids.length) } });
  } catch {
    setBusy(false);
    load();
  }
};

const onDiscard = async () => {
  const sure = await confirm({
    title: strings.photoImportDiscardTitle,
    message: strings.photoImportDiscardMessage,
    confirm: strings.photoImportDiscardConfirm,
    cancel: strings.photoImportDiscardCancel,
  });
  if (!sure) return;
  setBusy(true);
  try {
    await discard(id);
    router.replace('/');
  } catch {
    setBusy(false);
  }
};
```

  Render:
  - **Header:** `photo-import-review-back`, which calls `router.back()`, and the title.
  - **The status line,** `photo-import-status`:
    - `reading`: `photoImportReading`;
    - `looking_up`: `photoImportLookingUp(imp.settled_count, imp.item_count)`;
    - `ready`: `photoImportReady`;
    - `failed`: `photoImportFailed`.
  - **An empty import:** `ready` with no items shows `photo-import-empty` with `strings.photoImportNoWords(strings.languageName(active.target_language))`.
  - **A FlatList of `imp.items`.** Each row is a `View` with testID `photo-import-row`, holding:
    - **The tick:** a Pressable with testID `photo-import-tick`, `accessibilityRole="checkbox"`, `accessibilityState={{ checked: item.ticked, disabled }}` and `aria-checked={item.ticked}`. It is disabled unless `item.status === 'ready' && item.options.length > 0`. `onPress` calls `change(item.position, { ticked: !item.ticked })`.
    - `photo-import-word`, showing `item.text`.
    - **For a ready row with options,** `photo-import-meaning`: a Pressable showing `chosenOption(item)?.translation` and its part of speech. Pressing it toggles `open` for this position. While open, one `photo-import-option` Pressable per option shows its translation, part of speech and example. Pressing one calls `change(item.position, { sense_id: option.sense_id })` and closes the list. The chosen option has `aria-selected` and `accessibilityState={{ selected }}`.
    - **Notes,** each a `Text` with testID `photo-import-note`:
      - `corrected_form`: `photoImportReadAs(item.text)`;
      - `hebrew_mismatch`: `photoImportListSays(item.hebrew)`;
      - `reason`: `sentence` gives `photoImportReasonSentence`, `no_meaning` gives `photoImportReasonNoMeaning`, and `not_in_language` gives `photoImportReasonNotInLanguage`;
      - `status === 'failed'`: `photoImportRowFailed`.
    - **A pending row** shows `strings.photoImportPending` and an `ActivityIndicator` instead of the meaning.
  - **The footer:**
    - `photo-import-save`, labelled `strings.photoImportSave(tickedCount(imp))`, disabled unless `canSave(imp) && !busy`;
    - `photo-import-discard`, disabled while `busy`.
    - A failed import shows only discard. An empty import shows only discard.
  - Hebrew text styles use `writingDirection: 'rtl'`, as the other screens do. Item texts are in the target language, so give them `writingDirection: textDirection(active.target_language)` where the vocabulary screen does the same.

- [ ] **Step 4: Change home.** In `apps/mobile/src/app/index.tsx`:
  - Read `const { imports, reload: reloadPhotos } = usePhotoImports();`. Reload it on focus, beside `reload()`. While any import is reading or looking up, also reload every `POLL_INTERVAL_MS` (3 s), with the same `useFocusEffect` and `setInterval` shape as the session poll, keyed on `imports.some((i) => isWorking(i.status))`.
  - Read `const { photoSaved } = useLocalSearchParams<{ photoSaved?: string }>();`. When present, show a notice `<Text testID="home-photo-saved">{strings.photoImportSaved(Number(photoSaved))}</Text>` above the card.
  - Compute `const card = homePhotoCard(imports);`. When it is not null, render a card Pressable, testID `home-photo-card`, above the buttons, styled like the existing `styles.card`:
    - `working`: `strings.homePhotoWorking`;
    - `ready`: `strings.homePhotoReady(count)`;
    - `failed`: `strings.homePhotoFailed`;
    - `several`: `strings.homePhotoSeveral(count)`.

    Pressing it opens `/photo-imports/{id}` for one import, or `/photo-imports` for several.
  - Add a third secondary button after `vocabulary-entry`: testID `photo-import-entry`, label `strings.photoImportEntry`, `onPress={() => router.push('/photo-imports')}`.

- [ ] **Step 5: Check it builds and renders.** From the root: `npm run typecheck`, `npm run lint:arch`, `cd apps/mobile && npx jest`. Then `npm run build:web -w apps/mobile`. Expected: the web export succeeds. Typed routes accept `/photo-imports/[id]` once the files exist, so rerun typecheck after the build if `expo-router`'s generated types lag.

- [ ] **Step 6: Commit.**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): take or choose a photo, review its rows, save them in one go"
```

---

### Task 14: E2E: a photo through to the saved list

**Files:**
- Modify: `e2e/tests/support/mockServer.ts`
- Create: `e2e/fixtures/word-list.jpg` (copied from `apps/server/tests/eval/fixtures/photos/it-printed-hebrew.jpg`)
- Create: `e2e/tests/photo-import.spec.ts`

**Interfaces:**
- Consumes: the testIDs of Task 13; `createLearner`, `logIn`, `tapUntil` from `e2e/tests/support/`; the markers `read the word list in this photo` and `which numbered sense`.
- Produces: `expectGeminiMatching(request, bodyRegex: string, payload: unknown, opts?: { delayMs?: number })`.

- [ ] **Step 1: Add a body-matched stub.** Append to `e2e/tests/support/mockServer.ts`:

```ts
/**
 * Phase 26. A model answer for the one call whose request body matches
 * `bodyRegex`. A photo import makes several calls at once (the read, a lookup
 * per row, a match call) whose order is not fixed, so each answer is matched by
 * what is in its request rather than by order. MockServer answers with the
 * first expectation that matches, so register the narrowest first.
 */
export async function expectGeminiMatching(
  request: APIRequestContext,
  bodyRegex: string,
  payload: unknown,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path, body: { type: 'REGEX', regex: `[\\s\\S]*${bodyRegex}[\\s\\S]*` } },
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: envelope(payload),
        ...(opts.delayMs ? { delay: { timeUnit: 'MILLISECONDS', value: opts.delayMs } } : {}),
      },
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}
```

  A lookup's request carries the typed word as the user part's whole text, so `"text":"gatto"` matches the lookup of `gatto` and nothing else. The match call's user text is a JSON string starting with `{`, and the read's is `Language: Italian.`.

- [ ] **Step 2: Copy the fixture.**

```bash
mkdir -p e2e/fixtures && cp apps/server/tests/eval/fixtures/photos/it-printed-hebrew.jpg e2e/fixtures/word-list.jpg
```

- [ ] **Step 3: Write the spec.** Create `e2e/tests/photo-import.spec.ts`. MockServer reads nothing from the photo, so the fixture only has to be a JPEG:

```ts
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { tapUntil } from './support/interactions';
import { clearGemini, expectGeminiMatching } from './support/mockServer';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);
test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

const PHOTO = join(__dirname, '..', 'fixtures', 'word-list.jpg');

const lookupOf = (lemma: string, senses: { translation: string; sense_code: string }[]) => ({
  kind: 'word',
  entries: [{ lemma, part_of_speech: 'noun', senses }],
});

/** The read answers three rows; each row's lookup and the one match call are
 *  matched by their bodies, because the jobs run four at a time. */
async function stubImport(request: APIRequestContext, opts: { readDelayMs?: number } = {}) {
  await expectGeminiMatching(
    request,
    'read the word list in this photo',
    {
      items: [
        { text: 'gatto', hebrew: 'חתול' },
        { text: 'banca', hebrew: 'ספסל' },
        { text: 'casa', hebrew: '' },
      ],
    },
    { delayMs: opts.readDelayMs },
  );
  await expectGeminiMatching(request, 'which numbered sense', { sense: 0 });
  await expectGeminiMatching(request, '"text":"gatto"', lookupOf('gatto', [{ translation: 'חתול', sense_code: 'cat' }]));
  await expectGeminiMatching(request, '"text":"banca"', lookupOf('banca', [{ translation: 'בנק', sense_code: 'bank' }]));
  await expectGeminiMatching(
    request,
    '"text":"casa"',
    lookupOf('casa', [
      { translation: 'בית', sense_code: 'house' },
      { translation: 'משפחה', sense_code: 'family' },
    ]),
  );
}

async function uploadFromGallery(page: Page) {
  await tapUntil(page, 'photo-import-entry', 'photo-import-choose');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('photo-import-choose').click();
  await (await chooser).setFiles(PHOTO);
}

test('a photo of an Italian list becomes three rows, and the review decides what is saved', async ({ page, request }) => {
  await createLearner(request, 'e2e_photo_it', 'it');
  await logIn(page, 'e2e_photo_it');
  await stubImport(request);
  await uploadFromGallery(page);

  const rows = page.getByTestId('photo-import-row');
  await expect(page.getByTestId('photo-import-status')).toHaveText('מוכן לסקירה', { timeout: 60_000 });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByTestId('photo-import-meaning')).toContainText('חתול');
  await expect(rows.nth(1).getByTestId('photo-import-note')).toContainText('ספסל');
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('בית');

  await rows.nth(2).getByTestId('photo-import-meaning').click();
  await rows.nth(2).getByTestId('photo-import-option').filter({ hasText: 'משפחה' }).click();
  await expect(rows.nth(2).getByTestId('photo-import-meaning')).toContainText('משפחה');
  await rows.nth(1).getByTestId('photo-import-tick').click();
  await expect(rows.nth(1).getByTestId('photo-import-tick')).toHaveAttribute('aria-checked', 'false');

  await page.getByTestId('photo-import-save').click();
  await expect(page.getByTestId('home-photo-saved')).toBeVisible();
  await expect(page.getByTestId('home-photo-card')).toHaveCount(0);

  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(page.getByText('banca')).toHaveCount(0);
});

test('leaving before the read finishes loses nothing: home shows the import, and it can be discarded', async ({ page, request }) => {
  await createLearner(request, 'e2e_photo_leave', 'it');
  await logIn(page, 'e2e_photo_leave');
  await stubImport(request, { readDelayMs: 5_000 });
  await uploadFromGallery(page);

  await expect(page.getByTestId('photo-import-status')).toHaveText('קוראים את התמונה…');
  await page.getByTestId('photo-import-review-back').click();
  const card = page.getByTestId('home-photo-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('3', { timeout: 60_000 });

  await card.click();
  await expect(page.getByTestId('photo-import-row')).toHaveCount(3);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('photo-import-discard').click();
  await expect(page.getByTestId('home-photo-card')).toHaveCount(0);
});
```

  Adjust the helper names if `createLearner`, `logIn` and `tapUntil` live in other files under `e2e/tests/support/`. The first test's "saved list" check asserts two words. If the vocabulary row's testIDs show the lemma differently, assert with `toContainText` on `words` as `vocabulary.spec.ts` does.

- [ ] **Step 4: Run the spec, then the whole e2e suite.**
Run: `bash scripts/lane-env.sh npm run e2e --workspace e2e -- tests/photo-import.spec.ts`
Expected: PASS (2 tests). If the file chooser never fires, `launchImageLibraryAsync` on the web may need a user gesture Playwright did not give. Click the button with `page.getByTestId(...).click()`, never `dispatchEvent`, and read `e2e/tests/support/diagnostics.ts` for the console capture.
Then: `npm run e2e`. Expected: every spec passes.

- [ ] **Step 5: Commit.**

```bash
git add e2e
git commit -m "test(e2e): a photo import from the gallery to the saved list, and one left and discarded"
```

---

### Task 15: The spec records what was built, and the full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-lang-tutor-phase-26-photo-import-design.md`

- [ ] **Step 1: Update the spec's status and record the deviations.** In the Status bullet, replace "Not yet planned or built." with:

  "Planned in `docs/superpowers/plans/2026-10-07-phase-26-photo-import.md` and built on branch `phase-26-photo-import`. Victor asked for the plan to be built and one PR opened in one go ('I trust your decisions'). These deviations were found while planning and building:"

  Then list, as sub-bullets:
  - **One PR, not two (D15).** Victor asked for one PR. D15's gate still held: the eval ran against the real model before any app task began.
  - **The eval photos are synthetic.** Victor's photos were not available. Seven pages were rendered in Chromium, printed and in handwriting fonts. They are listed in `tests/eval/fixtures/photos/README.md`, where his own photos can join them.
  - **The wire's status adds `saved` and `discarded`,** because `GET` answers any import that still exists (D10). The summary's count is `settled_count`, the rows no longer pending, rather than `ready_count`.
  - **The repository has no `clearPhoto`.** Every transition clears the photo, and a table check enforces it (`photo_imports_photo_only_while_reading`).
  - **Rows store `suggested_sense_id`,** the job's choice, so `photo_import_saved` can count changed senses (D14).
  - **The reader drops items that are empty or over 100 characters,** the lookup's own cap. They are counted in `photo_read.dropped_count`.
  - **The picker answers a `PickResult`** (`photo`, `cancelled` or `denied`) rather than `null` with a `denied` flag.
  - **Mobile logic is tested as a pure module** (`src/photoImports.ts`), because the app has no hook tests (D13's "usePhotoImport" tests became `photoImports.test.ts`).
  - **e2e matches model answers by request body** (`expectGeminiMatching`), because row lookups run four at a time.
  - Any further deviation found during the build, one line each.

- [ ] **Step 2: Add the POC findings,** as a `## POC findings` section before `## Build order`:

```markdown
## POC findings

Run on 2026-10-07, before the plan, to test D5's and D6's assumptions. Seven synthetic
photos (the eval fixtures) were each sent to `gemini-2.5-flash` with D5's instruction from
a scratch script: once with thinking at the model's default, once with `thinkingBudget: 0`.

| Question | Answer |
|---|---|
| Does the reader find every item, in order, and skip the rest? | With default thinking, yes, on all seven. It skipped headings, the exercise line, page numbers, the whiteboard's date and a crossed-out word, and dropped articles and stress marks. |
| Does it copy the printed Hebrew? | Yes, whole, including two-word glosses (`חדר שינה`, `מזג אוויר`). |
| Thinking off? | Faster, 1.6–1.8 s against 3–6 s, but it dropped every Hebrew gloss on the printed Italian page, kept the crossed-out word and kept `sb`/`sth`. D5's default thinking stands. |
| Is "to" or "the" before a phrase dropped consistently? | No: `to look after` and `the weather` were sometimes kept. The eval accepts both spellings, and a lookup handles both. |
| How long is a read? | 3–6 s for 5–11 items at 1500 × 2000, well inside D6's 120 s. |
```

- [ ] **Step 3: Run the full verification.** From the worktree root, each must pass:

```bash
npm run typecheck
npm run lint:arch
npm test
npm run test:integration
npm run e2e
cd apps/server && npx tsx tests/eval/run.ts
```

  Then check the main checkout for stray writes. This must print nothing:

```bash
find /Users/victorprp/git/lang-tutor -path /Users/victorprp/git/lang-tutor/.claude/worktrees -prune -o -path '*/node_modules' -prune -o -path /Users/victorprp/git/lang-tutor/.git -prune -o -type f -newer /private/tmp/claude-501/-Users-victorprp-git-lang-tutor/d2556056-3a71-4799-bc00-668eb6fe0369/scratchpad/main-checkout-marker -print
```

- [ ] **Step 4: Commit.**

```bash
git add docs/superpowers/specs/2026-10-07-lang-tutor-phase-26-photo-import-design.md
git commit -m "docs: phase 26 spec records what was built, and its POC findings"
```
