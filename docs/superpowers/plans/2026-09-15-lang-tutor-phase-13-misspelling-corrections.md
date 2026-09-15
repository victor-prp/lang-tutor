# Phase 13 — Misspelling detection and corrections: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a learner types `thruot`, answer with `throat`'s translation *and say so* — a correction block naming `throat`, an alternative chip offering `throughout`, and a `dict_corrections` redirect row instead of a permanent `dict_variants` row for a string that is not a word.

**Architecture:** The model reports the correction (`correction.corrected_form` on its answer); nothing on the server detects a misspelling independently. One pure domain function, `resolveCorrection`, applies four guards to that field and rewrites the queried form **once**, at the top of the pipeline — so phase 12's reconciliation call, `persistEntries` and `resolveKind` all run verbatim on `throat` rather than on `thruot`. A new table, `dict_corrections`, maps `typed_form → corrected_form` plus up to three ranked alternatives, with no foreign key and no `id`. Phase 12's F5 hit path is extracted as `serveForm(f)` — read the form's rows beside its stale lexemes, repair where a lexeme is ahead, answer — and is called **three** times in one lookup: on the typed form (step 1), on a stored redirect's target (step 3), and on the corrected form before anything is written (the step 5b probe). Byte-identical stops being a hope about two code paths and becomes one function called with different arguments.

**Tech Stack:** TypeScript, Node 24, Hono on `@hono/node-server`, Drizzle ORM, Postgres 16, Zod 4, Jest (projects `unit` and `integration`), Playwright, MockServer, Expo/React Native, Gemini via `providers/gemini.ts`.

**Spec:** `docs/superpowers/specs/2026-09-13-lang-tutor-phase-13-misspelling-corrections-design.md`

## Global Constraints

- **Read the ADRs first.** `docs/adr/` are binding constraints, not suggestions. A Stop hook runs `scripts/check-adrs.sh` once per turn that touched `apps/server` or `apps/mobile`; CI runs the same as `npm run lint:arch`.
- **`npm run lint:arch` must keep reporting exactly 17 ADR 0001 checks** (plus 7 DI, 6 OpenAPI, 7 test topology, 3 identity). This phase adds **no** check and **no** script. R8 is amended in prose only.
- **`node`/`npm`/`docker`/`psql` are not on the default PATH.** Prefix every command that needs them with
  `export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"`. Shell state does not persist between tool calls.
- **Never run `npm run db:up` from a worktree** while another checkout's Postgres holds port 5432 — compose derives its project name from the directory and starts a second container that fails to bind. Reuse the running one; integration tests clone a per-test database off it either way.
- **Run `./scripts/setup-worktree.sh`** before running the app, the tests or the e2e suite in a fresh worktree. It is idempotent.
- **`npm test` / `npm run test:all` must make no network call and need no API key** (ADR 0004 R4). `npm run eval` is a fourth bucket, is in neither, and is the only code here that calls a real model.
- **Do NOT run the vocabulary backfill or any other paid bulk model job.** Build and verify the code; the operation is the user's to run gradually.
- **This phase's migration is `0007`.** `0006_sense_versions.sql` is on disk and shipped.
- **Every string cap is 100 characters** — `TranslationRequestSchema.text`, `LlmCorrectionSchema.corrected_form`, each alternative, `TranslationCorrectionSchema.corrected_form`, and the two `CHECK` constraints. One number, five places.
- **Alternatives: six on the model's schema, three on the wire.** `LlmCorrectionSchema.alternatives` is `.max(6).optional()`; `TranslationCorrectionSchema.alternatives` is `.max(3)`, required and un-defaulted. The asymmetry is deliberate — see Task 2.
- **`LlmCorrectionSchema.alternatives` must be `.optional()`, never `.default([])`.** Zod 4 emits a `"default": []` keyword into the JSON Schema, `toGeminiSchema` strips only `$schema` and `additionalProperties`, so the keyword would travel to Gemini inside `responseSchema` — a keyword this repository has never sent. A rejected `responseSchema` is a 400 on **every** translation call.
- **The system instruction must contain neither `saw` nor `see` as a substring.** MockServer expectations registered *unquoted* match a regex over the whole request body, and the system instruction is part of that body. A quoted expectation (`"banks"`) cannot be tripped by prose, because the body is `JSON.stringify`d and the instruction's quotes arrive escaped. **Re-derive the forbidden list from the registered `matchText` values before changing any illustration word.**
- **A correction is conditional on the model reporting one.** No edit distance, no dictionary probe, no string comparison runs anywhere on the server. An answer with entries and no `correction` writes a variant for the typed string, exactly as today.
- **Fail closed over polluting the dictionary.** Where a failure would mean writing a wrong row into a permanent, TTL-free dictionary, fail the request instead of degrading. The learner retries; a bad row is forever.
- **Integration and e2e tests treat the server as a black box.** No injected fakes inside a running server — stand in for Gemini with MockServer and a base-URL environment variable. Injecting a fake `fetch` into `providers/gemini.test.ts` is still fine; that is a unit test of an HTTP client.
- **Two log events, counts and `direction` only.** `dict_corrected` and `dict_redirect_hit`. **The learner's query text never enters a log.**

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/api/schemas.ts` | The wire and model contracts | **New** `LlmCorrectionSchema`, `TranslationCorrectionSchema`; one optional `correction` on each of `LlmTranslationSchema` and `TranslationResponseSchema` |
| `packages/core/src/api/types.ts` | Inferred types | **New** `LlmCorrection`, `TranslationCorrection` |
| `apps/server/src/domain/translation.ts` | Prompt, parse, pure decisions | One prompt rule **replaced**, four added; **new** `resolveCorrection` and `tidyAlternatives` |
| `apps/server/src/db/schema.ts` | Drizzle tables | **New** `dictCorrections` — no `id`, no FK, one expression unique index, three `CHECK`s |
| `apps/server/src/db/migrations/0007_dict_corrections.sql` | **New** | The table, the index, the constraints |
| `apps/server/src/db/migrate.ts` | Pre-migration SQL functions | **New** `correction_alternatives_valid`, beside `question_options_valid` |
| `apps/server/src/db/reseed.ts` | Clear and replay | `dict_corrections` joins the `TRUNCATE` list |
| `apps/server/src/repo/dictionary.ts` | Dictionary queries | **New** `findCorrectionByForm`, `persistCorrection` |
| `apps/server/src/services/translations.ts` | The `translate` use case | **New** module-private `serveForm`; the redirect read; the probe; the hop; two log events |
| `apps/server/src/db/dictExport.ts` / `dictImport.ts` | Logical backup | A sibling `corrections.jsonl` |
| `apps/server/src/db/cli.ts` | The CLI composition root | Derive the sibling path; report the correction counts |
| `apps/server/tests/support/fakes.ts` | Unit fixtures | `FakeDictRepo.hit` and `.stale` become records keyed by form; **new** `corrections` |
| `apps/server/tests/support/mockServer.ts` | Integration stubs | `expectGeminiJson` gains an optional `correction` |
| `e2e/tests/support/mockServer.ts` | e2e stubs | `expectGemini` gains an optional `correction` and a one-shot `{ once: true }` option |
| `apps/mobile/src/hooks/useTranslation.tsx` | The translate state | `submit` gains an optional `override?: string` |
| `apps/mobile/src/app/translate.tsx` | The translate screen | The correction banner, the alternative chips, two fixed `onPress` call sites |
| `apps/mobile/src/strings.ts` | Hebrew copy | Two strings |
| `apps/server/tests/eval/askModel.ts` / `cases.ts` / `run.ts` | The prompt scorecard | `askModel` goes through `resolveCorrection`; two new case fields; seven case changes |
| `data/backfill/en-he/corrections.jsonl` | **New**, empty | The restore's sibling file |
| `docs/adr/adr-0001-layered-architecture.md`, `README.md` | R8 | Already amended in the working tree — Task 1 confirms and commits |

**No build-red window.** Every task leaves `npm run typecheck` and the unit bucket green. Task 8 is the one that changes a shared fixture's shape, and it fixes the two call sites in the same commit.

---

## Task ordering, and why

Tasks 2–6 are independent of one another and of the service. Tasks 7–10 are strictly sequential: each builds on the `translate` shape the last one left. Tasks 11–14 are independent of one another once 10 lands. Task 15 is the sweep.

```
1 relabel ──┬─ 2 contract ──────────────┐                                       ┌─ 11 integration suite
            ├─ 3 prompt ────────────────┤                                       ├─ 12 export/restore
            ├─ 4 resolveCorrection ─────┼─ 7 serveForm ─ 8 redirect ─ 9 miss ─ 10 probe ─┤
            ├─ 5 table + migration ─────┤                                       ├─ 13 mobile + e2e
            └─ 6 repo functions ────────┘                                       └─ 14 evals
                                                                                      │
                                                                                 15 verify
```

Task 4 is the one Task 14 also depends on directly — `askModel` calls `resolveCorrection`, not
the service — so the eval work could in principle run earlier; it is placed last because a
scorecard read before the server behaves is a scorecard about nothing.

---

### Task 1: Relabel phase 12's follow-up comments, and land the R8 amendment

**Files:**
- Modify: `apps/server/src/domain/translation.ts`, `apps/server/src/domain/translation.test.ts`, `apps/server/src/domain/dictionary.ts`, `apps/server/src/domain/dictionary.test.ts`, `apps/server/src/repo/dictionary.ts`, `apps/server/tests/integration/repo/dictionary.test.ts`, `apps/server/tests/integration/services/translations.test.ts`, `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/run.ts`, `apps/server/tests/eval/askModel.ts`
- Confirm and commit: `docs/adr/adr-0001-layered-architecture.md`, `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task changes **no behaviour and no identifier** — only comment prose.

The committed code uses *"phase 13"* for phase 12's F1–F5 follow-ups, while `docs/` calls that
same work phase 12 tasks 9–13 and the phase 12 plan's own *Task 13* section is the F5 repair.
Migration `0007` is claimed under this phase's number, so the comments move rather than the
phase. Doing it **first** is the point: it must land before any file gains a *"phase 13"*
comment that means *this* phase, or the two meanings become unseparable. This is success
criterion 25.

- [ ] **Step 1: List every occurrence, so the count is a fact rather than a hope**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd /Users/vperepelitsky/git/vic-prp/lang-tutor-init
git grep -n -E 'phase 13|Phase 13|Task 13' -- 'apps/server/src/**/*.ts' 'apps/server/tests/**/*.ts'
```

Expected: 20 hits across exactly these ten files — `src/domain/translation.ts` (3),
`src/domain/translation.test.ts` (3), `src/domain/dictionary.ts` (1),
`src/domain/dictionary.test.ts` (1), `src/repo/dictionary.ts` (1, as *"Task 13"*),
`tests/integration/repo/dictionary.test.ts` (1, as *"Task 13"*),
`tests/integration/services/translations.test.ts` (1), `tests/eval/askModel.ts` (1),
`tests/eval/cases.ts` (4), `tests/eval/run.ts` (3).

If the count differs, stop and reconcile against the list above before editing — the point of
this task is that the label becomes unambiguous, and an unlisted hit is a label this task did
not disambiguate.

- [ ] **Step 2: Rewrite the labels**

Apply these substitutions **by hand, reading each comment**, not with a blanket `sed` — two of
them are *"Task 13"* and read differently:

| Before | After |
|---|---|
| `Phase 13, F2.` | `Phase 12 follow-up, F2.` |
| `Phase 13.` | `Phase 12 follow-up.` |
| `The phase 13 defect` | `The phase 12 follow-up defect` |
| `until phase 13` | `until the phase 12 follow-ups` |
| `Phase 13: \`burnt\` and \`burned\`` | `Phase 12 follow-up: \`burnt\` and \`burned\`` |
| `(Task 13)` in `src/repo/dictionary.ts` | `(phase 12, Task 13)` |
| `(Task 13 widened` in `tests/integration/repo/dictionary.test.ts` | `(phase 12, Task 13, widened` |

- [ ] **Step 3: Prove nothing but prose changed**

```bash
git diff --stat
git diff | grep -E '^[+-]' | grep -vE '^[+-]{3}' | grep -vE '^[+-][[:space:]]*(//|\*|/\*)'
```

Expected: the second command prints **nothing**. Every changed line is a comment line. If a
non-comment line appears, revert it — this task may not touch code.

- [ ] **Step 4: Confirm the label is gone and the new one is in place**

```bash
git grep -n -E 'phase 13|Phase 13' -- 'apps/server/src/**/*.ts' 'apps/server/tests/**/*.ts'
```

Expected: **no output**.

```bash
git grep -c -E 'phase 12 follow-up|Phase 12 follow-up|phase 12, Task 13' -- 'apps/server/src/**/*.ts' 'apps/server/tests/**/*.ts'
```

Expected: ten files listed.

- [ ] **Step 5: Confirm the ADR 0001 R8 amendment and the README correction are present**

Both are already in the working tree at the time this plan was written. Verify rather than
rewrite:

```bash
grep -c 'Amended four times' docs/adr/adr-0001-layered-architecture.md
grep -c 'independent and idempotent' docs/adr/adr-0001-layered-architecture.md
grep -c 'R8 revised 2026-09-15 (phase 13)' docs/adr/adr-0001-layered-architecture.md
grep -c 'as amended through phase 13' README.md
```

Expected: `1` from each. If any prints `0`, apply the spec's *ADR consequences* wording: R8 now
reads *a use case's **dependent** writes share one transaction; a write that is **independent
and idempotent** — correct on its own whether or not the others land, and a no-op when
repeated — may be its own; **reads** preceding third-party I/O may each be their own*, with the
repair-beside-redirect pair named as the independent example and steps 8/9 as the dependent
one; README's `services/` row and its transaction paragraph quote the amended rule.

Note what the amendment does **not** do: R8's detection command greps `\.transaction(` outside
`db/transaction.ts` and is indifferent to how many bare `transaction(...)` calls a service
makes. No check changes.

- [ ] **Step 6: Run the unit bucket and the architecture check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:unit && npm run lint:arch
```

Expected: green, and `lint:arch` ends with `Architecture check passed: 17 rules, no violations.`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: relabel phase 12's follow-up comments, and record R8's fourth amendment

The committed code used 'phase 13' for phase 12's F1-F5 follow-ups while docs/
called the same work phase 12 tasks 9-13. Migration 0007 is claimed under phase
13, so the comments move rather than the phase. No behaviour change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The contract — two correction schemas and two optional fields

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`
- Test: `packages/core/src/api/schemas.test.ts`, `apps/server/src/providers/gemini.test.ts`, `apps/server/src/openapi.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, for Tasks 4, 6, 9, 10, 12 and 13:
  - `LlmCorrectionSchema` — `{ corrected_form: string; alternatives?: string[] }`
  - `TranslationCorrectionSchema` — `{ corrected_form: string; alternatives: string[] }`
  - `LlmTranslationSchema` gains `correction?: LlmCorrection`
  - `TranslationResponseSchema` gains `correction?: TranslationCorrection`
  - types `LlmCorrection` and `TranslationCorrection`, exported from `@lang-tutor/core/api`

Two optional fields. Nothing is removed and no field changes type, so a client that ignores
`correction` behaves exactly as it does today. This is the phase that ends phase 12's
byte-identical OpenAPI document, deliberately and additively.

- [ ] **Step 1: Write the failing schema tests**

Append to `packages/core/src/api/schemas.test.ts`, and add
`LlmCorrectionSchema, TranslationCorrectionSchema` to the import list at the top of that file:

```ts
describe('the correction block', () => {
  const base = { text: 'thruot', direction: 'en_he', kind: 'word', senses: [] } as const;

  it('is optional on the wire, so today\'s responses still parse', () => {
    expect(TranslationResponseSchema.safeParse(base).success).toBe(true);
  });

  it('is optional on the model schema, so today\'s answers still parse', () => {
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [] }).success).toBe(true);
  });

  it('caps the wire at three alternatives and the model schema at six', () => {
    const alt = (n: number) => Array.from({ length: n }, (_, i) => `alt${i}`);
    const wire = (n: number) =>
      TranslationResponseSchema.safeParse({
        ...base,
        correction: { corrected_form: 'throat', alternatives: alt(n) },
      }).success;
    const model = (n: number) =>
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { corrected_form: 'throat', alternatives: alt(n) },
      }).success;

    expect(wire(3)).toBe(true);
    expect(wire(4)).toBe(false);
    // Six, not three: `maxItems` travels to Gemini inside responseSchema, so a
    // conforming provider never reaches it — but a provider that ignores it must
    // not 502 a good translation over one surplus decorative alternative.
    // `tidyAlternatives` truncates to three before the answer reaches the wire.
    expect(model(6)).toBe(true);
    expect(model(7)).toBe(false);
  });

  it('caps a form at 100 characters on both, the ceiling learner text already has', () => {
    const long = 'a'.repeat(101);
    expect(
      TranslationResponseSchema.safeParse({
        ...base,
        correction: { corrected_form: long, alternatives: [] },
      }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { corrected_form: long },
      }).success,
    ).toBe(false);
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { corrected_form: 'throat', alternatives: [long] },
      }).success,
    ).toBe(false);
  });

  it('requires alternatives on the wire — what this server publishes is never absent', () => {
    expect(
      TranslationResponseSchema.safeParse({ ...base, correction: { corrected_form: 'throat' } })
        .success,
    ).toBe(false);
  });

  it('rejects a correction with no corrected_form: that is not a correction', () => {
    expect(
      LlmTranslationSchema.safeParse({
        kind: 'word',
        entries: [],
        correction: { alternatives: ['throat'] },
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Write the two 502-trap tests**

These are the reason `alternatives` is `.optional()` rather than a bare array. They go in the
**server's** `domain/translation.test.ts` rather than in core, because `dropNulls` is what they
are about and it lives in `apps/server/src/domain/translation.ts`. Append to
`apps/server/src/domain/translation.test.ts`:

```ts
describe('parseLlmTranslation and an absent or null alternatives list', () => {
  const entry = {
    lemma: 'throat',
    part_of_speech: 'noun',
    senses: [{ translation: 'גרון', sense_code: 'body_part' }],
  };

  // A provider that simply omits the empty array. A bare (required) array would
  // fail the WHOLE parse here, and one decorative empty list would turn a correct
  // translation into a 502 by way of TranslationUnreadable.
  it('parses a correction whose alternatives key is absent', () => {
    const parsed = parseLlmTranslation(
      JSON.stringify({ kind: 'word', entries: [entry], correction: { corrected_form: 'throat' } }),
    );
    expect(parsed?.correction?.corrected_form).toBe('throat');
    // undefined, not []. The schema is `.optional()`; it is `tidyAlternatives` in
    // domain/ that produces the empty array — asserted there, not here.
    expect(parsed?.correction?.alternatives).toBeUndefined();
  });

  // How structured output spells "none". `dropNulls` runs BEFORE safeParse, so
  // the key is deleted — which is fatal for a field that is neither optional nor
  // defaulted. Asserted on raw JSON, never on a pre-built object, because
  // dropNulls is the thing under test.
  it('parses a correction whose alternatives key is null', () => {
    const parsed = parseLlmTranslation(
      `{"kind":"word","entries":[${JSON.stringify(entry)}],` +
        `"correction":{"corrected_form":"throat","alternatives":null}}`,
    );
    expect(parsed?.correction?.corrected_form).toBe('throat');
    expect(parsed?.correction?.alternatives).toBeUndefined();
  });
});
```

- [ ] **Step 3: Write the Gemini-schema regression lock**

Append to `apps/server/src/providers/gemini.test.ts`, inside the existing
`describe('toGeminiSchema', ...)`:

```ts
  // The regression lock on this phase's `.optional()` decision. `.default([])`
  // was the obvious spelling: Zod 4 emits a `"default": []` key into the JSON
  // Schema, `strip` removes only $schema and additionalProperties, so the key
  // would travel to Gemini inside responseSchema — a keyword this repository has
  // never sent. A responseSchema Gemini refuses is a 400 on EVERY translation
  // call: a total outage of the endpoint, arrived at through a field designed
  // never to be able to fail an answer.
  //
  // A test rather than a comment because the next person reaching for
  // `.default()` will reach for it in packages/core, nowhere near this reasoning.
  it('emits no default keyword anywhere, at any depth', () => {
    expect(JSON.stringify(toGeminiSchema(LlmTranslationSchema))).not.toContain('"default"');
  });

  it('leaves correction out of the root required list', () => {
    const schema = toGeminiSchema(LlmTranslationSchema) as Record<string, unknown>;
    expect(schema.required).toEqual(['kind', 'entries']);
    expect(schema.properties).toHaveProperty('correction');
  });
```

- [ ] **Step 4: Write the OpenAPI assertion**

`src/openapi.test.ts` is a **unit** test despite asserting the published document, because it
lives under `src/` and ADR 0004's rule is that the folder decides the bucket. Append inside
`describe('the translation endpoint in the published document', ...)`:

```ts
  // Phase 13 moves the wire for the first time since phase 9, additively. A
  // client that ignores `correction` behaves exactly as it does today, which is
  // what `optional` publishes.
  it('publishes the correction block as an optional property, and loses nothing', async () => {
    const doc = await openApiDocument();
    const schema = doc.paths['/api/translations'].post.responses['200']
      .content['application/json'].schema;

    expect(Object.keys(schema.properties).sort()).toEqual([
      'correction',
      'direction',
      'kind',
      'senses',
      'text',
    ]);
    expect(schema.required).not.toContain('correction');
    expect(schema.required.sort()).toEqual(['direction', 'kind', 'senses', 'text']);

    const correction = schema.properties.correction;
    expect(correction.properties).toHaveProperty('corrected_form');
    expect(correction.properties.alternatives.maxItems).toBe(3);
  });
```

- [ ] **Step 5: Run all four test files and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:unit
```

Expected: failures in `packages/core/src/api/schemas.test.ts` (`LlmCorrectionSchema` is not
exported), `apps/server/src/domain/translation.test.ts`, `apps/server/src/providers/gemini.test.ts`
and `apps/server/src/openapi.test.ts`. A TypeScript/module-resolution error naming
`LlmCorrectionSchema` is the expected shape of the first failure.

- [ ] **Step 6: Add the two schemas and the two fields**

In `packages/core/src/api/schemas.ts`, immediately **above** `TranslationResponseSchema`:

```ts
// Three, not six: every correction that reaches the wire has been through
// `tidyAlternatives`, applied by the guards on the model path and again by
// `persistCorrection` on the write — so this cap is an invariant the SERVER
// holds rather than a hope about a third party, which is exactly the kind of cap
// a published contract should state. Applying it in only one of those two places
// would leave `dict:restore` free to violate it: the restore reaches the
// repository without passing through `domain/` at all.
//
// `alternatives` is REQUIRED and un-defaulted here, unlike on the model schema
// below. The asymmetry is the point: what a third party sends may be absent,
// what this server publishes may not be.
export const TranslationCorrectionSchema = z.object({
  corrected_form: z.string().min(1).max(100),
  alternatives: z.array(z.string().min(1).max(100)).max(3),
});
```

Then `TranslationResponseSchema` becomes:

```ts
export const TranslationResponseSchema = z.object({
  // The string the learner typed, so the client can say "you typed thruot".
  text: z.string(),
  direction: TranslationDirectionSchema,
  // Both of these belong to the CORRECTED form when a correction is present, and
  // are byte-identical to what a direct lookup of it returns.
  kind: TranslationKindSchema,
  senses: z.array(TranslationSenseSchema).max(5),
  correction: TranslationCorrectionSchema.optional(),
});
```

Immediately **above** `LlmTranslationSchema`:

```ts
// What the model reports, phase 13. Present only when the typed string is not a
// word or expression in either language but is near one or more that are.
export const LlmCorrectionSchema = z.object({
  // A surface form, not a lemma: `bokked` corrects to `booked`, never to `book`.
  // `.max(100)` is the request schema's own ceiling on learner text — this is the
  // one untrusted string that does not come through it, and it becomes a
  // dictionary key. `min(1)` because a correction without one is not a correction.
  corrected_form: z.string().min(1).max(100),
  // Other plausible intended forms, ranked, no senses. Tapping one is an ordinary
  // lookup that misses.
  //
  // `.optional()`, NOT a bare array — a bare array would be REQUIRED, and this
  // field must never be able to fail a good answer. `parseLlmTranslation` runs
  // `dropNulls` BEFORE `safeParse`, because phase 9 made absent and null mean the
  // same thing, so a provider answering `alternatives: null` — which is how
  // structured output spells "none" — has the key deleted and would then fail a
  // required field. The whole parse fails with it, and one decorative empty list
  // turns a correct translation into a 502. A provider that simply omits the
  // empty array lands in the same place. `.optional()` makes both spellings mean
  // "absent", and `tidyAlternatives` turns absent into `[]`.
  //
  // `.default([])` was the obvious spelling and is deliberately NOT used. Zod 4
  // emits a `"default": []` key into the JSON Schema; `toGeminiSchema` strips only
  // `$schema` and `additionalProperties`, so the key would travel to Gemini inside
  // `responseSchema`, and no schema here has ever sent it. A rejected
  // `responseSchema` is `LlmUnavailable('responded 400')` on EVERY translation
  // call — a total outage, from a field designed never to fail an answer.
  // (`z.toJSONSchema` also defaults to output mode, where a defaulted field is
  // REQUIRED, so `.default([])` would have told Gemini the key is mandatory too.)
  //
  // Six here against three on the wire: `maxItems` travels to Gemini either way,
  // but a provider that ignores it would, under `.max(3)`, fail the WHOLE parse on
  // one surplus alternative. Six matches `entries`' own cap, chosen the same way.
  //
  // The rule all of this follows: `correction` is decorative, so NOTHING about it
  // may fail an answer the model otherwise got right.
  alternatives: z.array(z.string().min(1).max(100)).max(6).optional(),
});
```

And `LlmTranslationSchema` becomes:

```ts
export const LlmTranslationSchema = z.object({
  kind: TranslationKindSchema,
  // When `correction` is present these describe `corrected_form`, not the typed
  // text — and so does `kind`, which the prompt's fourth rule is what actually
  // secures. `resolveKind` only clamps a single token; it cannot rule on a
  // multi-token corrected form.
  entries: z.array(LlmEntrySchema).max(6),
  correction: LlmCorrectionSchema.optional(),
});
```

- [ ] **Step 7: Export the two inferred types**

In `packages/core/src/api/types.ts`, add `LlmCorrectionSchema` and `TranslationCorrectionSchema`
to the `import type { ... } from './schemas'` list (keep it alphabetical), and add beside the
other translation types:

```ts
export type TranslationCorrection = z.infer<typeof TranslationCorrectionSchema>;
export type LlmCorrection = z.infer<typeof LlmCorrectionSchema>;
```

Check `packages/core/src/api/index.ts` re-exports both the schema and the type barrels; if it
names exports individually rather than with `export *`, add the four new names.

- [ ] **Step 8: Run the unit bucket and the typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:unit
```

Expected: PASS. Nothing else in the tree should have moved — both fields are optional.

- [ ] **Step 9: Commit**

```bash
git add packages/core apps/server/src/providers/gemini.test.ts \
  apps/server/src/openapi.test.ts apps/server/src/domain/translation.test.ts
git commit -m "feat: add an optional correction block to the model and wire schemas

Two optional fields, nothing removed and no field retyped. alternatives is
.optional() rather than .default([]) so that no keyword this repo has never
sent reaches Gemini's responseSchema, and so that a provider spelling 'none'
as null cannot 502 a translation it got right. Six on the model schema, three
on the wire.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The prompt — one rule replaced, four added

**Files:**
- Modify: `apps/server/src/domain/translation.ts` (`buildPrompt` only)
- Test: `apps/server/src/domain/translation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new export. `buildPrompt`'s signature is unchanged; only its `system` string moves.

The existing *"not a word → empty entries"* rule is **replaced**, not supplemented. Left
standing beside a rule telling the model to answer such an input with entries for a *different*
form, it is a flat contradiction about exactly the input this phase exists for: `thruot` is not
a word in either language, so the old rule demands empty entries while the new one demands
entries describing `throat`. The model would be free to do either — the one outcome no test can
pin.

- [ ] **Step 1: Write the failing prompt tests**

Append to `apps/server/src/domain/translation.test.ts`, inside `describe('buildPrompt', ...)`:

```ts
  // Asserted as a NEGATIVE on the old wording, because the failure this prevents
  // is the old rule surviving BESIDE the new one — and an addition looks
  // identical to a replacement in every test that only checks the new text is
  // present.
  it('replaces the unconditional not-a-word rule rather than supplementing it', () => {
    const { system } = buildPrompt({ text: 'thruot', direction: 'en_he' });
    expect(system).not.toContain(
      'not a word or expression in either language, return an empty entries',
    );
    expect(system).toContain('no real word or expression was plausibly intended');
  });

  it('tells the model a correctly spelled inflected form is not a misspelling', () => {
    const { system } = buildPrompt({ text: 'booked', direction: 'en_he' });
    expect(system).toMatch(/inflected form is not a misspelling/i);
    expect(system).toContain('walks');
    expect(system).toContain('went');
  });

  it('asks for a surface form and up to three ranked alternatives', () => {
    const { system } = buildPrompt({ text: 'bokked', direction: 'en_he' });
    expect(system).toContain('correction.corrected_form');
    expect(system).toMatch(/surface form/i);
    // The distinction the whole feature turns on: `bokked` wants `booked`, whose
    // lemma is `book` — and phase 12 made that difference load-bearing, because
    // `booked` renders הזמין where `book` renders להזמין.
    expect(system).toContain('`bokked` corrects to `booked`');
    expect(system).toContain('correction.alternatives');
  });

  it('suspends the build-the-example-around-the-input rule when a correction is present', () => {
    const { system } = buildPrompt({ text: 'bokked', direction: 'en_he' });
    expect(system).toMatch(/build the example sentence around `?corrected_form`?/i);
  });

  // The fourth rule, and the one a reader will think redundant. `resolveKind`
  // clamps a single token to `word` and otherwise DEFERS to the model, so it
  // cannot rule on a multi-token corrected form; `kind` is then written onto
  // dict_variants.kind for that form, first-writer-wins, and read back by
  // `kindForForm` on every later hit — including the hit a learner who spells
  // `break a leg` correctly gets. Without this rule one mistyped lookup freezes
  // `kind: 'word'` on a real phrase for the life of the dictionary.
  it('tells the model to classify the corrected form, not the input as typed', () => {
    const { system } = buildPrompt({ text: 'breakaleg', direction: 'en_he' });
    expect(system).toMatch(/classify `?corrected_form`? rather than the input as typed/i);
    expect(system).toContain('breakaleg');
  });

  // The wording lock that keeps an illustration word from silently capturing the
  // integration bucket's MockServer expectations. The system instruction is part
  // of the request body those expectations match a regex against, so naming
  // `saws` here would make EVERY first call in that bucket match the `saw`
  // expectation and be answered with the wrong payload — a failure that looks
  // like a service bug and is a prompt edit. Phase 12 hit exactly this.
  //
  // Deliberately NOT asserted for the quoted expectations (`"bank"`, `"scan"`,
  // `"saw"`). The body is JSON.stringify'd, so a quoted word in the instruction
  // arrives as \"bank\" and the expectation's regex `"bank"` does not match it:
  // the closing quote is preceded by a backslash. What a quoted expectation
  // matches is the user part, "text":"bank". Forbidding those here would lock a
  // non-rule.
  //
  // RE-DERIVE THIS LIST from the registered `matchText` values before changing
  // any illustration word in any rule. It grows every time a test registers an
  // UNQUOTED matchText.
  it('names neither saw nor see, the two unquoted MockServer expectations', () => {
    for (const text of ['book', 'ספר', 'break a leg']) {
      for (const direction of ['en_he', 'he_en'] as const) {
        const { system } = buildPrompt({ text, direction });
        expect(system).not.toContain('saw');
        expect(system).not.toContain('see');
      }
    }
  });
```

- [ ] **Step 2: Run them and check *which* fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npx jest --selectProjects unit -t buildPrompt --workspace apps/server 2>/dev/null \
  || (cd apps/server && npx jest --selectProjects unit src/domain/translation.test.ts)
```

Expected: the six rule tests FAIL. The `saw`/`see` test is expected to **PASS already** — it is
a lock on the current prompt, not a change to it. If it fails now, the prompt already carries a
hazard: stop, find the word, and remove it before adding anything.

- [ ] **Step 3: Replace the existing rule**

In `apps/server/src/domain/translation.ts`, inside `buildPrompt`'s `system` array, replace these
two lines:

```ts
    'If the input is not a word or expression in either language, return an empty entries',
    'array rather than inventing a translation.',
```

with:

```ts
    // Phase 13. REPLACED, not supplemented. Left standing beside the correction
    // rules below it is a flat contradiction about exactly the input this phase
    // exists for: `thruot` is not a word in either language, so the old wording
    // demanded empty entries while the new one demands entries describing
    // `throat`. The added clause carries the whole difference.
    //
    // "in either language" is kept rather than narrowed to the source language,
    // and the rules below say it for the same reason: `direction` is detected
    // from the script and can be wrong, so a rule scoped to the detected source
    // would let a real English word typed under he_en be reported as a
    // misspelling of a Hebrew one.
    'If the input is not a word or expression in either language and no real word or',
    'expression was plausibly intended, return an empty entries array and omit `correction`,',
    'rather than inventing a translation.',
```

- [ ] **Step 4: Add the four rules**

Directly after the replaced rule, still inside the `system` array:

```ts
    // Phase 13, rule 1. The rule the whole feature turns on and the one most
    // likely to regress, because `lemma ≠ typed form` is true of an inflection
    // AND of a typo — which is precisely why detection cannot be a string
    // comparison and has to be asked for explicitly. `saws` is the obvious
    // illustration word and is FORBIDDEN: it is registered unquoted as a
    // MockServer matchText, and the system instruction is part of the body those
    // expectations match against. `running` and `booked` already appear above, so
    // they add no new exposure; `walks` and `went` are clear.
    'A correctly spelled inflected form is not a misspelling: "running", "booked", "walks"',
    'and "went" are real forms of real words — return them normally and omit `correction`.',
    // Phase 13, rule 2. `corrected_form` is a SURFACE form, never a lemma: a
    // learner typing `bokked` wants `booked`, whose lemma is `book`. Under phase
    // 10 the distinction was invisible; phase 12 made it load-bearing, because
    // `booked` renders הזמין and `book` renders להזמין on purpose.
    'When the input is not a word or expression in either language but one or more real ones',
    'were plausibly intended, set `correction.corrected_form` to the single most likely',
    'intended surface form — matching the grammatical form the learner appears to have typed,',
    'so `bokked` corrects to `booked` and not to `book` — and list up to three other plausible',
    'intended forms, ranked, in `correction.alternatives`. The `entries` then describe',
    '`corrected_form`.',
    // Phase 13, rule 3. Suspends, for this path only, the
    // "build the example sentence around the input as typed" rule above. Without
    // it the dictionary stores example sentences containing a misspelling —
    // permanently, since persistEntries writes exactly these examples.
    'When `correction` is present, build the example sentence around `corrected_form`, never',
    'around the input as typed.',
    // Phase 13, rule 4. The one a reader will think redundant, and the one with a
    // permanent consequence. `resolveKind` clamps a single token to `word` and
    // otherwise DEFERS to the model, so it cannot rule on a multi-token corrected
    // form; `kind` is then written onto dict_variants.kind for that form,
    // first-writer-wins, and read back by kindForForm on every later hit —
    // including the hit a learner who spells `break a leg` correctly gets.
    // Without this rule, one mistyped lookup freezes kind: 'word' on a real
    // phrase for the life of the dictionary. No server-side rule can repair it:
    // the mirror of the clamp does not exist, because a multi-token form can be a
    // phrase or a sentence and nothing in code can say which.
    //
    // The illustration reuses "break a leg", which the imperative-expression rule
    // above already names, so it adds no new exposure under the word constraint.
    'When `correction` is present, classify `corrected_form` rather than the input as typed:',
    '"breakaleg" is corrected to "break a leg", so its kind is "phrase" even though what was',
    'typed is a single token.',
```

- [ ] **Step 5: Correct `buildPrompt`'s standing note about the forbidden words**

The existing comment above the *"Choose each example so that it could not be read as any other
sense"* rule lists `see`, `saw`, `saws`, `bank`, `banks` and so **over-forbids**: a quoted
expectation cannot be tripped by prose. Replace its last sentences with the mechanism:

```ts
    // The illustration also avoids `saw` and `see`, the only two expectations
    // this instruction can trip. An UNQUOTED matchText matches a regex over the
    // whole request body, and the system instruction is in that body; a QUOTED one
    // (`"bank"`, `"scan"`) matches only the learner's text, because the body is
    // JSON-encoded and the instruction's own quotes arrive escaped — measured, not
    // reasoned: a body whose instruction reads `Rule: "banks" is plural` matches
    // the expectation `banks` and does not match `"banks"`. Re-derive the
    // forbidden pair from the registered expectations before changing any
    // illustration word here or in any other rule. An earlier draft said "We saw
    // the spring" and made every `see` lookup in that bucket match the `saw`
    // expectation instead.
```

- [ ] **Step 6: Run the unit bucket**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:unit
```

Expected: PASS, including the `saw`/`see` lock and the three pre-existing `buildPrompt` rule
tests. `buildRenderingPrompt` needs **no** correction rule — the substitution means it is never
handed a typed form — and its own `matchText` expectations are anchored on *"reusing its
sense_code EXACTLY"*, which only that prompt contains.

- [ ] **Step 7: Run the integration bucket, which is the other half of the same fact**

Criterion 18 is *"the system instruction contains neither `saw` nor `see`, **and** the
integration bucket is green"*. The database and MockServer must be up; reuse a running
container rather than starting a second one.

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
docker ps --format '{{.Names}}' | grep -E 'db|mockserver'   # confirm both are already up
npm run test:integration
```

Expected: PASS. A failure in `tests/integration/services/translations.test.ts`'s *saw sequence*
specifically means a prompt word captured an expectation — go back to Step 4 and change the
illustration word, not the test.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/domain/translation.ts apps/server/src/domain/translation.test.ts
git commit -m "feat: teach the prompt to report a misspelling, and replace the rule it contradicts

The unconditional 'not a word -> empty entries' rule is REPLACED: left beside a
rule asking for entries describing a different form it is a contradiction about
exactly the input this phase exists for. Four rules added, including the one
that classifies corrected_form rather than the input as typed - the only thing
standing between a mistyped lookup and a permanent kind: 'word' on a real phrase.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `tidyAlternatives` and `resolveCorrection` — the four guards in one pure function

**Files:**
- Modify: `apps/server/src/domain/translation.ts`
- Test: `apps/server/src/domain/translation.test.ts`

**Interfaces:**
- Consumes: `LlmTranslation`, `TranslationCorrection`, `TranslationDirection`, `TranslationKind` from `@lang-tutor/core/api` (Task 2); `normalizeForm` from `./dictionary`; `resolveKind` and `detectDirection` from this same file.
- Produces, for Tasks 6, 9, 10 and 13:

```ts
export function tidyAlternatives(
  alternatives: string[] | undefined,
  context: { correctedForm: string; typedForm: string },
): string[];

export type ResolvedCorrection = {
  /** Absent when the model sent none, or when a guard dropped it. */
  correction?: TranslationCorrection;
  /** What the rest of the pipeline treats as the queried form. */
  effectiveForm: string;
  /** Computed from `effectiveForm`, never from the typed text. */
  kind: TranslationKind;
};

export function resolveCorrection(
  parsed: LlmTranslation,
  context: { typedForm: string; direction: TranslationDirection },
): ResolvedCorrection | null;
```

`null` means *the answer cannot be used at all* — the fourth guard — and the service raises
`TranslationUnreadable`, exactly as it does for an answer that failed to parse. `domain/` cannot
throw (R3 forbids importing `../errors`), which is why the function returns `null`, the
arrangement `parseLlmTranslation` already uses.

**Why one function rather than a few lines in the service.** The guards, the empty-entries
clearing, the normalization of both forms, the tidy and `resolveKind` are one decision. Putting
half of it in the service makes the ordering trap below a property of a sequence of statements
in a use case rather than of a pure function, and leaves the eval harness with nothing to call
except a copy — and a copy is exactly what would let the eval bucket score a `kind` the service
never writes.

**The ordering trap.** The correction is cleared for `entries: []` **before** the effective form
is computed, not at the return. `kind` comes from `effectiveForm`, and phase 12's empty-entries
early return carries that `kind` — so a model answering `zxqwbtl` with `entries: []` and
`corrected_form: "zxq wbtl"` would return `kind: 'phrase'` for a single-token input: no
correction block, no rows written, and a `kind` that came from a correction the response denies
carrying. Clearing first makes the empty answer identical to an uncorrected one in every field.

- [ ] **Step 1: Write the failing tests for `tidyAlternatives`**

Append to `apps/server/src/domain/translation.test.ts`, and add `resolveCorrection,
tidyAlternatives` to the import list at the top:

```ts
describe('tidyAlternatives', () => {
  const ctx = { correctedForm: 'throat', typedForm: 'thruot' };

  it('turns an absent list into an empty one, which is what the wire schema requires', () => {
    expect(tidyAlternatives(undefined, ctx)).toEqual([]);
  });

  it('normalizes each entry the same way the corrected form is normalized', () => {
    expect(tidyAlternatives(['  Throughout.  ', 'thro   at'], ctx)).toEqual([
      'Throughout',
      'thro at',
    ]);
  });

  it('drops an entry with no letter or digit', () => {
    expect(tidyAlternatives(['???', '   ', 'throughout'], ctx)).toEqual(['throughout']);
  });

  it('removes duplicates of the corrected form, of the typed form, and of one another', () => {
    expect(
      tidyAlternatives(['Throat', 'THRUOT', 'throughout', 'Throughout'], ctx),
    ).toEqual(['throughout']);
  });

  it('truncates to three, keeping the model\'s ranking', () => {
    expect(tidyAlternatives(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'], ctx)).toEqual([
      'a1',
      'b2',
      'c3',
    ]);
  });

  // Idempotent by construction, which is what lets persistCorrection apply it a
  // second time on the way into the database without the two callers being able
  // to disagree.
  it('leaves an already-tidy list unchanged', () => {
    const tidy = tidyAlternatives(['throughout', 'throaty'], ctx);
    expect(tidyAlternatives(tidy, ctx)).toEqual(tidy);
  });
});
```

- [ ] **Step 2: Write the failing tests for `resolveCorrection`**

Append to the same file:

```ts
describe('resolveCorrection', () => {
  const entry = {
    lemma: 'throat',
    part_of_speech: 'noun' as const,
    senses: [{ translation: 'גרון', sense_code: 'body_part' }],
  };
  const answer = (over: Record<string, unknown> = {}) => ({
    kind: 'word' as const,
    entries: [entry],
    ...over,
  });
  const en = { typedForm: 'thruot', direction: 'en_he' as const };

  it('leaves an uncorrected answer on the typed form', () => {
    const resolved = resolveCorrection(answer(), en);
    expect(resolved).toEqual({ effectiveForm: 'thruot', kind: 'word' });
  });

  it('substitutes the corrected form and carries the tidied alternatives', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: 'throat', alternatives: ['throughout'] } }),
      en,
    );
    expect(resolved).toEqual({
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
      effectiveForm: 'throat',
      kind: 'word',
    });
  });

  // Guard 1. Removes a whole class of "did you mean throat? — showing results
  // for throat".
  it('drops a corrected form that normalizes to the typed form, case-insensitively', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: '  Thruot.  ' } }),
      en,
    );
    expect(resolved).toEqual({ effectiveForm: 'thruot', kind: 'word' });
  });

  // Guard 2, written as a content test rather than as "normalizes to the empty
  // string" — which is what an earlier revision specified and which does not do
  // the job. normalizeForm returns the input UNCHANGED whenever stripping would
  // empty it (`stripped === '' ? collapsed : stripped`), so normalizeForm('???')
  // is '???': it would clear an empty-string test, clear guard 1, become the
  // effective form, and be written as a dict_variants.form and as a redirect
  // target. Only a whitespace-only string normalizes to '' at all.
  it('drops a corrected form with no letter or digit, ??? included', () => {
    for (const corrected of ['???', '  ', '...']) {
      expect(resolveCorrection(answer({ correction: { corrected_form: corrected } }), en))
        .toEqual({ effectiveForm: 'thruot', kind: 'word' });
    }
  });

  // Guard 3. Detection is scoped to words and phrases, so a sentence carrying a
  // correction is the model ignoring its instructions rather than a case to
  // handle. The ENTRIES are kept — a sentence is never written to the dictionary,
  // so nothing is poisoned, and refusing the answer outright would fail a request
  // the model translated correctly over a field it was told not to send.
  it('drops a correction on a sentence but keeps the answer', () => {
    const resolved = resolveCorrection(
      answer({ kind: 'sentence', correction: { corrected_form: 'I have a sore throat' } }),
      { typedForm: 'I have a sore thruot', direction: 'en_he' },
    );
    expect(resolved).toEqual({ effectiveForm: 'I have a sore thruot', kind: 'sentence' });
  });

  // Guard 4, and the only one that is not a drop. The case is a transliteration —
  // `shalom` typed under en_he, which is not an English word and is plausibly the
  // Hebrew one, and the prompt's "either language" wording is what licenses the
  // model to name it. Dropping would not help: the entries describe the corrected
  // headword, so they are wrong in the same way. Left unchecked, `effectiveForm`
  // would be a Hebrew string written as an English variant, the redirect stored
  // under `en`, and the entries the product of an English-to-Hebrew prompt asked
  // about a Hebrew headword. A wrong row is permanent; a failed request costs one
  // retry.
  it('returns null when the corrected form is in the other script', () => {
    expect(
      resolveCorrection(answer({ correction: { corrected_form: 'שלום' } }), {
        typedForm: 'shalom',
        direction: 'en_he',
      }),
    ).toBeNull();
    expect(
      resolveCorrection(answer({ correction: { corrected_form: 'hello' } }), {
        typedForm: 'הלו',
        direction: 'he_en',
      }),
    ).toBeNull();
  });

  it('truncates a fourth alternative rather than rejecting the answer', () => {
    const resolved = resolveCorrection(
      answer({
        correction: { corrected_form: 'throat', alternatives: ['a1', 'b2', 'c3', 'd4'] },
      }),
      en,
    );
    expect(resolved?.correction?.alternatives).toEqual(['a1', 'b2', 'c3']);
  });

  it('collapses two identical alternatives to one', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: 'throat', alternatives: ['Throughout', 'throughout'] } }),
      en,
    );
    expect(resolved?.correction?.alternatives).toEqual(['Throughout']);
  });

  // THE ORDERING TRAP, and the assertion an implementation is most likely to
  // miss. Two things must be true of this answer, not one: it carries no
  // correction, AND its kind was not derived from the corrected form. Clearing at
  // the return instead of before the effective form passes the first and fails
  // the second.
  it('clears a correction on empty entries BEFORE the effective form is computed', () => {
    const resolved = resolveCorrection(
      { kind: 'phrase', entries: [], correction: { corrected_form: 'zxq wbtl' } },
      { typedForm: 'zxqwbtl', direction: 'en_he' },
    );
    expect(resolved?.correction).toBeUndefined();
    expect(resolved?.effectiveForm).toBe('zxqwbtl');
    expect(resolved?.kind).toBe('word');
  });

  it('normalizes the corrected form, so no .-suffixed key can reach the dictionary', () => {
    const resolved = resolveCorrection(
      answer({ correction: { corrected_form: 'Throat.', alternatives: ['Throughout!'] } }),
      en,
    );
    expect(resolved?.effectiveForm).toBe('Throat');
    expect(resolved?.correction?.corrected_form).toBe('Throat');
    expect(resolved?.correction?.alternatives).toEqual(['Throughout']);
  });

  // One fact read from both sides. The first half is the clamp firing on a
  // single-token corrected form — the half resolveKind handles. The second is
  // deliberately the uncomfortable one: it pins that the server CANNOT fix a
  // multi-token corrected form and that the fourth prompt rule is load-bearing.
  // An earlier revision asserted the opposite and would have passed only by
  // accident of the stub.
  it('runs resolveKind against the corrected form, clamping one token and deferring otherwise', () => {
    expect(
      resolveCorrection(answer({ kind: 'phrase', correction: { corrected_form: 'booked' } }), {
        typedForm: 'bokked',
        direction: 'en_he',
      })?.kind,
    ).toBe('word');

    expect(
      resolveCorrection(answer({ kind: 'word', correction: { corrected_form: 'break a leg' } }), {
        typedForm: 'breakaleg',
        direction: 'en_he',
      })?.kind,
    ).toBe('word');
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npx jest --selectProjects unit src/domain/translation.test.ts; cd -
```

Expected: FAIL — `resolveCorrection is not a function` / `tidyAlternatives is not a function`.

- [ ] **Step 4: Implement both**

In `apps/server/src/domain/translation.ts`. First extend the imports — `normalizeForm` comes
from the sibling module, which R3 permits (its detection command greps `from '../`, and this is
`from './`):

```ts
import type {
  LlmReconciliation,
  LlmTranslation,
  PartOfSpeech,
  TranslationCorrection,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';
import { LlmReconciliationSchema, LlmTranslationSchema } from '@lang-tutor/core/api/schemas';

import { normalizeForm } from './dictionary';
```

Then add, below `resolveKind`:

```ts
/**
 * A form is usable as a dictionary key only if it contains something to look up.
 *
 * Written as a CONTENT test and not as "normalizes to the empty string", which
 * would fire on almost nothing: `normalizeForm` returns its input unchanged
 * whenever stripping a trailing sentence mark would empty it (phase 12's F4
 * branch), so `normalizeForm('???')` is `'???'`. Only a whitespace-only string —
 * which `.min(1)` barely admits — normalizes to `''` at all. Letter-or-digit
 * covers whitespace, punctuation, and any mixture of them.
 */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * The alternatives, tidied rather than rejected. Truncating is deliberate: the
 * alternative was failing a whole answer over a decorative field.
 *
 * **Two callers, which is why it is a named function.** The guards call it so the
 * response the model's own answer produces is right, and `persistCorrection`
 * calls it again on the way into the database, so the three-item cap is a
 * property of the WRITE rather than of one caller — `dict:restore` reaches the
 * repository without passing through `domain/` at all, exactly as `dictImport`
 * already does. Idempotent by construction: tidying an already-tidy list returns
 * it unchanged, so the second application costs nothing and the two callers
 * cannot disagree.
 *
 * `undefined` is a real input, not defensiveness: `LlmCorrectionSchema.alternatives`
 * is `.optional()` rather than `.default([])`, so a model that omits the key hands
 * this function an `undefined`, and turning it into `[]` here is what keeps a
 * missing decorative field from reaching the wire schema, which requires the array.
 */
export function tidyAlternatives(
  alternatives: string[] | undefined,
  context: { correctedForm: string; typedForm: string },
): string[] {
  // Seeded with both forms, so an alternative that merely repeats one of them is
  // removed by the same pass that removes a repeat of another alternative.
  // Case-insensitive, and the FIRST occurrence is the one kept, so the model's
  // ranking survives.
  const seen = new Set([context.correctedForm.toLowerCase(), context.typedForm.toLowerCase()]);
  const tidied: string[] = [];

  for (const raw of alternatives ?? []) {
    const form = normalizeForm(raw);
    if (!HAS_CONTENT.test(form)) continue;
    const key = form.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tidied.push(form);
    if (tidied.length === 3) break;
  }

  return tidied;
}

/** What the service needs from a parsed answer before it touches a database:
 *  which form the rest of the pipeline is about, what `kind` that form is, and
 *  the correction block to attach to the response — if any survived. */
export type ResolvedCorrection = {
  correction?: TranslationCorrection;
  effectiveForm: string;
  kind: TranslationKind;
};

/**
 * The four guards, the empty-entries clearing, the normalization of both forms
 * and `resolveKind` — one pure function, applied to the parsed answer before
 * phase 12's early return, so a dropped correction costs no database read and no
 * second model call.
 *
 * **`null` means the answer is unusable**, which is the fourth guard and the only
 * one that is not a drop. `domain/` cannot throw `TranslationUnreadable` — R3
 * forbids importing `../errors` — so the caller raises, the arrangement
 * `parseLlmTranslation` already uses.
 *
 * **The clearing runs before the effective form is computed, and that ordering is
 * the point.** `kind` is computed from `effectiveForm`, and phase 12's
 * empty-entries early return carries that `kind` — so a correction the response
 * declines to report would already have changed the answer by the time the early
 * return runs. A model answering `zxqwbtl` with `entries: []` and
 * `corrected_form: "zxq wbtl"` would otherwise return `kind: 'phrase'` for a
 * single-token input: no correction block, no rows written, and a `kind` that came
 * from a correction the response denies carrying.
 *
 * Two callers: `services/translations.ts` at step 4 of the flow, and the eval
 * harness's `askModel`, which is what lets that bucket score the `kind` the server
 * would actually have written rather than a copy of the logic.
 */
export function resolveCorrection(
  parsed: LlmTranslation,
  context: { typedForm: string; direction: TranslationDirection },
): ResolvedCorrection | null {
  // The kind the answer has BEFORE any substitution. It is what the drop paths
  // return, and it is what the sentence guard reads: `resolveKind` against the
  // typed form is the clamp the request already earns, so a single token the
  // model called a sentence is a `word` here and keeps its correction, while a
  // genuine multi-token sentence loses it.
  const typedKind = resolveKind(context.typedForm, parsed.kind);
  const uncorrected: ResolvedCorrection = {
    effectiveForm: context.typedForm,
    kind: typedKind,
  };

  // The fifth rule, deliberately not listed as a guard: it is a test on the
  // ENTRIES, not on the correction's content, and where it runs matters more than
  // what it does — see the ordering note above.
  if (!parsed.correction || parsed.entries.length === 0) return uncorrected;

  // Guard 3, first because it is the cheapest and scopes the whole feature:
  // detection is words and phrases. "I have a sore thruot" is out of scope.
  if (typedKind === 'sentence') return uncorrected;

  // Never the model's string as it arrived. What `normalizeForm` returns IS the
  // dictionary key, and phase 12 added trailing-punctuation stripping to it
  // precisely because the dev database held `book` with three senses and `book?`
  // with four. A model answering `corrected_form: "Throat."` would otherwise write
  // exactly that as a dict_variants.form and as a redirect target.
  const correctedForm = normalizeForm(parsed.correction.corrected_form);

  // Guard 1 — "did you mean throat? showing results for throat".
  if (correctedForm.toLowerCase() === context.typedForm.toLowerCase()) return uncorrected;
  // Guard 2 — see HAS_CONTENT.
  if (!HAS_CONTENT.test(correctedForm)) return uncorrected;
  // Guard 4 — the answer is unusable, not merely uncorrected. `direction` was
  // detected from the typed script before call 1 and is fixed for the request.
  if (detectDirection(correctedForm) !== context.direction) return null;

  return {
    correction: {
      corrected_form: correctedForm,
      alternatives: tidyAlternatives(parsed.correction.alternatives, {
        correctedForm,
        typedForm: context.typedForm,
      }),
    },
    effectiveForm: correctedForm,
    // Against the CORRECTED form, which is what makes `bokked` → `booked` a
    // `word` even when the model answered `phrase`. It is not the whole of the
    // job: the clamp fires only on a single token, so a multi-token corrected
    // form is the model's call and the fourth prompt rule is what secures it.
    kind: resolveKind(correctedForm, parsed.kind),
  };
}
```

- [ ] **Step 5: Run the unit bucket and the architecture check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:unit && npm run lint:arch
```

Expected: PASS, and `lint:arch` still reports 17 ADR 0001 rules. R3's detection command greps
`from '\.\./` inside `apps/server/src/domain/`, so `from './dictionary'` is invisible to it —
which is correct, not a loophole: a same-directory import crosses no layer, and
`domain/dictionary.ts` imports nothing from `domain/translation.ts`, so there is no cycle.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/translation.ts apps/server/src/domain/translation.test.ts
git commit -m "feat: resolve a model's correction in one pure domain function

Four guards, the empty-entries clearing, normalization of both forms, the
alternatives tidy and resolveKind - one function returning { correction,
effectiveForm, kind } or null. The clearing runs BEFORE the effective form is
computed, so an answer with no entries is identical to an uncorrected one in
every field including kind. The fourth guard returns null rather than dropping:
a corrected form in the other script makes the entries wrong the same way.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `dict_corrections` — the table, migration 0007, the validator, and the reseed

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/migrate.ts`, `apps/server/src/db/reseed.ts`
- Create: `apps/server/src/db/migrations/0007_dict_corrections.sql`, and one entry in `apps/server/src/db/migrations/meta/_journal.json`
- Test: `apps/server/tests/integration/db/schema.test.ts`, `apps/server/tests/integration/db/reseed.test.ts`, `apps/server/tests/integration/repo/dictionary.corrections.test.ts` (**new**, the constraint half only — the repository half is Task 6)

**Interfaces:**
- Consumes: nothing.
- Produces, for Task 6: the Drizzle table `dictCorrections`, exported from `src/db/schema.ts`, with columns `languageCode`, `typedForm`, `correctedForm`, `alternatives`, `createdAt`, and the unique index `dict_corrections_form_key` on `(language_code, lower(typed_form))`.

**A misspelling is a routing fact, not a dictionary fact, so it gets its own table.** `thruot`
is not a form of `throat` — it is a string that should be *read as* one. Storing it as a variant
would mean inventing a per-form rendering, an example sentence and a rank ordering for a string
that is not a word. It is also the stronger answer to the reported defect:
`questions.prompt_variant_id` references `dict_variants`, so a misspelling that never becomes a
variant **cannot** be quizzed, and no present or future query has to remember to filter it out.

**It is the first table here with no `id` and no primary key.** Nothing can reference a
redirect: no foreign key points at one, `corrections.jsonl` keys a line by `typed_form`, and
`persistCorrection` addresses a row by `(language_code, lower(typed_form))` and never by id. An
id would be a column that exists only to look like the neighbours. The unique index is the row's
whole identity, which is why *proving it rejects a duplicate* is a test in its own right.

- [ ] **Step 1: Write the failing constraint tests**

Create `apps/server/tests/integration/repo/dictionary.corrections.test.ts`. This task fills in
the **constraints** describe block; Task 6 appends the repository blocks to the same file.

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

/** Raw SQL, deliberately — never `persistCorrection`, which tidies first and so
 *  could never produce these rows. This is the RESTORE path's backstop:
 *  `dict:restore` reaches the repository without passing through `domain/`,
 *  `router.openapi` does not validate responses at runtime, and a hand-edited
 *  `corrections.jsonl` is therefore the one way a row that violates the published
 *  contract could reach the wire with nothing noticing. It is also the reason
 *  criterion 9 can say `storable` rather than `sent`. */
async function insertRaw(values: {
  typedForm: string;
  correctedForm: string;
  alternatives: string[];
}): Promise<void> {
  const array = `{${values.alternatives.map((a) => `"${a}"`).join(',')}}`;
  await t.db.execute(sql`
    INSERT INTO dict_corrections (language_code, typed_form, corrected_form, alternatives)
    VALUES ('en', ${values.typedForm}, ${values.correctedForm}, ${array}::text[])
  `);
}

describe('the dict_corrections constraints', () => {
  const ok = { typedForm: 'thruot', correctedForm: 'throat', alternatives: [] as string[] };

  it('accepts a well-formed redirect', async () => {
    await expect(insertRaw(ok)).resolves.toBeDefined();
  });

  it('rejects a typed form over 100 characters', async () => {
    await expect(insertRaw({ ...ok, typedForm: 'a'.repeat(101) })).rejects.toThrow(
      /dict_corrections_typed_form_length/,
    );
  });

  it('rejects a corrected form over 100 characters', async () => {
    await expect(insertRaw({ ...ok, correctedForm: 'a'.repeat(101) })).rejects.toThrow(
      /dict_corrections_corrected_form_length/,
    );
  });

  it('rejects a fourth alternative', async () => {
    await expect(
      insertRaw({ ...ok, alternatives: ['a1', 'b2', 'c3', 'd4'] }),
    ).rejects.toThrow(/dict_corrections_alternatives_valid/);
  });

  it('rejects an alternative over 100 characters', async () => {
    await expect(insertRaw({ ...ok, alternatives: ['a'.repeat(101)] })).rejects.toThrow(
      /dict_corrections_alternatives_valid/,
    );
  });

  // The unique index IS this table's identity — there is no primary key. Proven
  // against raw SQL rather than through `persistCorrection`, whose whole contract
  // is that a second write for one typed form raises NOTHING.
  it('rejects a duplicate typed form, matched case-insensitively', async () => {
    await insertRaw(ok);
    await expect(insertRaw({ ...ok, typedForm: 'Thruot' })).rejects.toThrow(
      /dict_corrections_form_key/,
    );
  });

  // Stored as written, matched on lower() — the same rule dict_variants uses, so
  // a learner who typed `Thruot` is matched by one who typed `thruot` while the
  // row keeps the shape it arrived in.
  it('keeps the casing it was written with', async () => {
    await insertRaw({ ...ok, typedForm: 'Thruot' });
    const rows = await t.db.execute<{ typed_form: string }>(
      sql`SELECT typed_form FROM dict_corrections`,
    );
    expect(rows.rows[0].typed_form).toBe('Thruot');
  });
});
```

- [ ] **Step 2: Write the failing reseed test**

Append to `apps/server/tests/integration/db/reseed.test.ts`, and add `sql` to its `drizzle-orm`
import:

```ts
  // `TRUNCATE dict_lexemes, sessions CASCADE` cannot reach dict_corrections:
  // CASCADE follows FOREIGN KEYS, and this table has none by design. Left alone,
  // every `npm run db:reseed` would empty the dictionary and leave the WHOLE
  // redirect table pointing into it — which turns the "dangling redirect" risk
  // from a rare event into a routine one, because db:reseed is a supported
  // command phase 12 ran repeatedly while re-recording.
  //
  // This check is one word away from being a check that cannot fire, so watch it
  // FAIL against the current statement before adding the table name.
  it('leaves no redirect pointing into the dictionary it just emptied', async () => {
    await t.db.execute(sql`
      INSERT INTO dict_corrections (language_code, typed_form, corrected_form)
      VALUES ('en', 'thruot', 'throat')
    `);

    await reseedContent(t.db);

    const rows = await t.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM dict_corrections`,
    );
    expect(rows.rows[0].count).toBe('0');
  });
```

- [ ] **Step 3: Add `dict_corrections` to the nine-tables test**

In `apps/server/tests/integration/db/schema.test.ts`, add `'dict_corrections'` to the `TABLES`
const and rename the test to `creates all ten tables`.

- [ ] **Step 4: Run them and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration
```

Expected: every new test FAILS with `relation "dict_corrections" does not exist`, and the
ten-tables test fails on the missing name. That is the only failure shape this step accepts —
if the reseed test *passes*, something already truncates the table and the check cannot fire.

- [ ] **Step 5: Install the validator function**

In `apps/server/src/db/migrate.ts`, beside `OPTIONS_VALIDATION_FUNCTION`:

```ts
// Beside question_options_valid and for the reason that one gives: drizzle-kit
// cannot generate CREATE FUNCTION, a hand-edit to a generated migration would be
// silently lost the next time anyone runs `db:generate`, and CREATE OR REPLACE
// before migrate() is idempotent and guarantees the function exists before the
// CHECK constraint that references it.
//
// `text[]` rather than `jsonb`, matching session_questions.option_order's use of
// a Postgres array for a homogeneous list. The count cap is here rather than in a
// column type because nothing in Postgres bounds an array's length.
const CORRECTION_ALTERNATIVES_FUNCTION = sql`
  create or replace function correction_alternatives_valid(alts text[]) returns boolean
    language sql immutable as $$
    select coalesce(array_length(alts, 1), 0) <= 3
       and not exists (select 1 from unnest(alts) a where length(a) not between 1 and 100)
    $$;
`;

export async function runMigrations(db: Db): Promise<void> {
  await db.execute(OPTIONS_VALIDATION_FUNCTION);
  await db.execute(CORRECTION_ALTERNATIVES_FUNCTION);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
```

- [ ] **Step 6: Add the Drizzle table**

In `apps/server/src/db/schema.ts`, after `dictVarTranslations`:

```ts
/**
 * Phase 13. `typed_form → corrected_form` plus ranked alternatives: a misspelling
 * is a ROUTING fact, not a dictionary fact. `thruot` is not a form of `throat` —
 * it is a string that should be read as one, and storing it as a variant would
 * mean inventing a per-form rendering, an example sentence and a rank ordering
 * for a string that is not a word.
 *
 * **No id and no primary key, which is deliberate.** Nothing can reference a
 * redirect: no foreign key points at one, corrections.jsonl keys a line by
 * typed_form, and persistCorrection addresses a row by
 * (language_code, lower(typed_form)). An id would be a column that exists only to
 * look like the neighbours. The unique index below is the row's whole identity.
 * Adding `id text PRIMARY KEY` later is an additive migration that changes no
 * query here.
 *
 * **`corrected_form` is a plain string, not a foreign key.** Referencing
 * dict_variants.id would couple the redirect to a row `TRUNCATE ... CASCADE` can
 * remove; as a string, a dangling redirect degrades into a miss and a model call
 * rather than raising.
 *
 * **Global, with no user_id.** That `thruot` is not an English word is a fact
 * about English. Phase 12 keeps "nothing records who asked" and ADR 0005 leaves
 * identity unauthenticated.
 *
 * The three CHECKs mirror TranslationCorrectionSchema, on the precedent `users`
 * set: the schema gives a 400 with a good message, the constraint is what
 * actually holds when something bypasses the route — and `dict:restore` reaches
 * persistCorrection without passing through either schema. On the live path they
 * can never fire, which is what the ON CONFLICT DO NOTHING contract depends on.
 */
export const dictCorrections = pgTable(
  'dict_corrections',
  {
    languageCode: varchar('language_code', { length: 10 }).notNull(),
    // Stored as written; matched on lower(). One rule for a learner who typed
    // `Thruot` and one who typed `thruot`.
    typedForm: text('typed_form').notNull(),
    // A SURFACE form, never a lemma: `bokked` corrects to `booked`, not `book`.
    correctedForm: text('corrected_form').notNull(),
    alternatives: text('alternatives')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('dict_corrections_typed_form_length', sql`length(${t.typedForm}) between 1 and 100`),
    check(
      'dict_corrections_corrected_form_length',
      sql`length(${t.correctedForm}) between 1 and 100`,
    ),
    // An IMMUTABLE SQL function, the mechanism question_options_valid already
    // uses, installed where that one is — see db/migrate.ts.
    check('dict_corrections_alternatives_valid', sql`correction_alternatives_valid(${t.alternatives})`),
    // Matching on an expression index is exactly what
    // dict_variants_form_entry_rank_key does.
    uniqueIndex('dict_corrections_form_key').on(t.languageCode, sql`lower(${t.typedForm})`),
  ],
);
```

- [ ] **Step 7: Generate and name migration 0007**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npm run db:generate; cd -
```

drizzle-kit names the file randomly (`0007_<two_random_words>.sql`). Rename it to
`0007_dict_corrections.sql` and change the matching `"tag"` in
`src/db/migrations/meta/_journal.json` from the generated name to `0007_dict_corrections` —
the same hand-rename 0004, 0005 and 0006 already carry. Change nothing else in the journal;
the `when` timestamp and `idx` stay as generated.

Read the generated SQL and confirm it is exactly this shape (0003 proves drizzle-kit *can*
emit an expression unique index, so no hand-edit should be needed):

```sql
CREATE TABLE "dict_corrections" (
	"language_code" varchar(10) NOT NULL,
	"typed_form" text NOT NULL,
	"corrected_form" text NOT NULL,
	"alternatives" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dict_corrections_typed_form_length" CHECK (length("dict_corrections"."typed_form") between 1 and 100),
	CONSTRAINT "dict_corrections_corrected_form_length" CHECK (length("dict_corrections"."corrected_form") between 1 and 100),
	CONSTRAINT "dict_corrections_alternatives_valid" CHECK (correction_alternatives_valid("dict_corrections"."alternatives"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dict_corrections_form_key" ON "dict_corrections" USING btree ("language_code",lower("typed_form"));
```

If drizzle-kit emitted anything else — a `PRIMARY KEY`, a different index form — fix `schema.ts`
and regenerate rather than hand-editing the migration. Add a one-line header comment to the
file explaining that the migration is additive and runs on a database phase 12 already
truncated; nothing backfills.

Then confirm the journal is consistent:

```bash
cd apps/server && npm run db:check; cd -
```

- [ ] **Step 8: Name the table in the reseed**

In `apps/server/src/db/reseed.ts`:

```ts
export async function reseedContent(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE dict_lexemes, dict_corrections, sessions CASCADE`);
  await seedContent(db);
}
```

and extend the doc comment's CASCADE paragraph:

```
 * `dict_corrections` is named for the same reason `sessions` already is: nothing
 * references it, so nothing would cascade to it. Left out, every reseed would
 * empty the dictionary and leave the entire redirect table pointing into it — and
 * a dangling redirect is described in the spec's risk register as needing "a
 * truncated dictionary", which a supported command would then produce on demand.
 * Symmetric rather than merely safe: a correction is the same kind of cache of
 * the same kind of paid answer the dictionary is, and it is recoverable the same
 * way — `dict:export` before, `dict:restore` after, now carrying both files.
```

- [ ] **Step 9: Run the integration bucket**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:integration
```

Expected: PASS. Every per-test database is cloned from a template that ran `runMigrations`, so
the new function and table arrive automatically.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/db apps/server/tests/integration
git commit -m "feat: add dict_corrections, a redirect table with no id and no foreign key

A misspelling is a routing fact, not a dictionary fact: nothing references a
redirect, so the expression unique index is the row's whole identity. The three
caps are CHECK constraints as well as schema rules, because dict:restore reaches
the repository without passing through either. The table is named in reseed's
TRUNCATE for the same reason sessions is - CASCADE cannot reach a table with no
foreign key, and a reseed would otherwise leave every redirect dangling at once.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `findCorrectionByForm` and `persistCorrection`

**Files:**
- Modify: `apps/server/src/repo/dictionary.ts`
- Test: `apps/server/tests/integration/repo/dictionary.corrections.test.ts` (append to Task 5's file)

**Interfaces:**
- Consumes: `dictCorrections` (Task 5); `tidyAlternatives` (Task 4).
- Produces, for Tasks 8, 9, 10, 11:

```ts
export type CorrectionRow = {
  typedForm: string;
  correctedForm: string;
  alternatives: string[];
};

findCorrectionByForm(input: { form: string; languageCode: string })
  : Promise<CorrectionRow | undefined>;

persistCorrection(input: {
  typedForm: string;
  correctedForm: string;
  alternatives: string[];
  languageCode: string;
}): Promise<void>;
```

Both join the existing `createDictRepo`, so `Repos` keeps its shape and ADR 0002's factory list
is unchanged.

**`persistCorrection` is `ON CONFLICT DO NOTHING` — first-writer-wins, like every other write in
this dictionary — and that is not a detail.** Three ordinary paths write a redirect for a form
that already has one: a step-3 fall-through (a redirect exists but its target has no rows, so
the model is called and the write runs again), two learners missing the same typo concurrently,
and `dict:restore` replaying `corrections.jsonl` onto a database that already holds some of it.
A raise on any of them rolls `persistEntries` back with it, so the corrected form is *never*
written, so the next lookup misses again — a permanent two-call tax on one typo, showing up as a
log line rather than as an error, because `translate`'s existing `catch` turns a failed write
into a successful 200.

- [ ] **Step 1: Write the failing repository tests**

Append to `apps/server/tests/integration/repo/dictionary.corrections.test.ts`, extending its
imports with `createDictRepo` and `withTx`:

```ts
const EN = { languageCode: 'en' };

const write = (input: { typedForm: string; correctedForm: string; alternatives: string[] }) =>
  withTx(t.db, (tx) => createDictRepo(tx).persistCorrection({ ...EN, ...input }));

const read = (form: string) =>
  withTx(t.db, (tx) => createDictRepo(tx).findCorrectionByForm({ ...EN, form }));

describe('persistCorrection and findCorrectionByForm', () => {
  it('round-trips a redirect', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: ['throughout'] });

    expect(await read('thruot')).toEqual({
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['throughout'],
    });
  });

  it('matches on lower(typed_form), so a differently-cased typo finds the row', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: [] });

    expect((await read('Thruot'))?.correctedForm).toBe('throat');
    expect((await read('THRUOT'))?.correctedForm).toBe('throat');
  });

  it('answers undefined for a form with no redirect', async () => {
    expect(await read('throat')).toBeUndefined();
  });

  it('scopes the lookup to the language', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: [] });
    const other = await withTx(t.db, (tx) =>
      createDictRepo(tx).findCorrectionByForm({ languageCode: 'he', form: 'thruot' }),
    );
    expect(other).toBeUndefined();
  });

  // The contract the whole flow depends on: a second write for one typed form is
  // a NO-OP that raises nothing, and leaves the FIRST target in place. Three
  // ordinary paths reach it — a step-3 fall-through, a concurrent double miss,
  // and a dict:restore replayed onto a database that already holds part of the
  // file. A raise on any of them would roll persistEntries back with it, so the
  // corrected form would never be written, so the next lookup would miss again,
  // forever.
  it('is a no-op on a second write for the same typed form', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: ['throughout'] });
    await expect(
      write({ typedForm: 'Thruot', correctedForm: 'throughout', alternatives: [] }),
    ).resolves.toBeUndefined();

    expect(await read('thruot')).toEqual({
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['throughout'],
    });
    const rows = await t.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM dict_corrections`,
    );
    expect(rows.rows[0].count).toBe('1');
  });

  // The cap belongs to the WRITE, not to one caller. This is the restore path's
  // shape exactly: no `domain/` guard anywhere in the call, because dictImport
  // does not go through domain/ at all — it calls the repository directly, and
  // that is deliberate, since a restored row and a looked-up row are
  // indistinguishable precisely because the restore replays through the
  // repository. A corrections.jsonl holding four alternatives would otherwise
  // produce a row that violates the published response schema on every redirect
  // hit, and router.openapi does not validate responses at runtime.
  it('stores at most three alternatives, deduplicated, with no domain guard in the call', async () => {
    await write({
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['Throughout', 'throughout', 'throaty', 'thruot', 'throat', 'thorough'],
    });

    expect((await read('thruot'))?.alternatives).toEqual([
      'Throughout',
      'throaty',
      'thorough',
    ]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration
```

Expected: FAIL with `createDictRepo(...).persistCorrection is not a function`. Watch the tidy
test specifically: it must be seen failing against a `persistCorrection` that does not yet
exist, and after Step 3 it must be seen failing against one that writes what it is given — so
implement the insert *without* the tidy first, run, watch that one test fail on four stored
alternatives, then add the tidy. A cap that cannot fire prints nothing exactly like a cap that
holds.

- [ ] **Step 3: Implement both**

In `apps/server/src/repo/dictionary.ts`. Extend the imports:

```ts
import {
  dictCorrections,
  dictVarTranslations,
  dictVariants,
  dictLexemes,
  dictSenses,
} from '../db/schema';
import { tidyAlternatives } from '../domain/translation';
```

`repo/` importing from `domain/` is an existing direction, not a new one: this file already
takes `entriesToRows`, `rowsToSenses` and `staleLexemes` from `domain/dictionary`, and ADR 0001
R4 forbids persistence reaching *upward* — into `services/`, `routes/` or `app.ts` — not into
the pure layer beneath it.

Add the exported row type beside `RepairedRendering`:

```ts
/** One stored redirect. `typedForm` comes back as it was written, so a caller
 *  that echoes it shows the learner what the dictionary actually holds. */
export type CorrectionRow = {
  typedForm: string;
  correctedForm: string;
  alternatives: string[];
};
```

Inside `createDictRepo`, beside `findSensesByForm`:

```ts
  /**
   * One indexed lookup on `(language_code, lower(typed_form))` — the same
   * matching rule `dict_variants` uses, and the same expression the unique index
   * is built on, so the index is usable.
   *
   * Read only on a MISS path, which is what makes it free: a correctly spelled
   * word resolves before this is ever called, and a lookup that reaches it is
   * already paying for a provider call measured in seconds.
   */
  const findCorrectionByForm = async (input: {
    form: string;
    languageCode: string;
  }): Promise<CorrectionRow | undefined> => {
    const [row] = await tx
      .select({
        typedForm: dictCorrections.typedForm,
        correctedForm: dictCorrections.correctedForm,
        alternatives: dictCorrections.alternatives,
      })
      .from(dictCorrections)
      .where(
        and(
          eq(dictCorrections.languageCode, input.languageCode),
          sql`lower(${dictCorrections.typedForm}) = ${input.form.toLowerCase()}`,
        ),
      )
      .limit(1);
    return row;
  };

  /**
   * First-writer-wins, like every other write in this dictionary.
   *
   * **The DO NOTHING is bare here, unlike the two in `persistEntries`, and that is
   * a decision rather than a shortcut.** Those two name their conflict target
   * because a bare clause would also swallow a collision on
   * `dict_variants_form_entry_rank_key` or on
   * `UNIQUE(variant_id, user_language_code, rank)` — safety nets that must be
   * allowed to raise. This table has exactly ONE unique index and no primary key,
   * so the only conflict a bare clause can swallow is the one it is meant to. A
   * CHECK violation is not a conflict and still raises, which is what makes the
   * three constraints a real backstop for `dict:restore`.
   *
   * Three ordinary paths write a redirect for a form that already has one: a
   * step-3 fall-through, two learners missing the same typo concurrently, and a
   * restore replayed onto a database that already holds part of the file. A raise
   * on any of them is silently destructive, because it rolls `persistEntries` back
   * with it and `translate`'s catch turns the failed write into a 200 — a
   * permanent two-call tax on one typo, appearing as a log line rather than an
   * error. A redirect that raised on a re-restore would also make `dict:restore`
   * non-idempotent for the first time since phase 11.
   *
   * **`tidyAlternatives` is applied AGAIN here**, so the three-item cap and the
   * dedupe are properties of the write rather than of one caller: `dict:restore`
   * reaches this function without passing through `domain/` at all. Idempotent, so
   * the second application costs nothing on the live path.
   */
  const persistCorrection = async (input: {
    typedForm: string;
    correctedForm: string;
    alternatives: string[];
    languageCode: string;
  }): Promise<void> => {
    await tx
      .insert(dictCorrections)
      .values({
        languageCode: input.languageCode,
        typedForm: input.typedForm,
        correctedForm: input.correctedForm,
        alternatives: tidyAlternatives(input.alternatives, {
          correctedForm: input.correctedForm,
          typedForm: input.typedForm,
        }),
      })
      .onConflictDoNothing();
  };
```

and add both to the returned object, keeping it alphabetical:

```ts
  return {
    findCorrectionByForm,
    findSenseVersion,
    findSensesByForm,
    findSensesByLexeme,
    findStaleLexemesByForm,
    persistCorrection,
    persistEntries,
    repairVariantRenderings,
  };
```

- [ ] **Step 4: Run the integration bucket and the architecture check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:integration && npm run lint:arch
```

Expected: PASS, 17 ADR 0001 rules.

**`FakeDictRepo` is typed as `DictRepo & {...}`, so adding two methods to the repository makes
the fake fail to typecheck until it has them too.** Do not build Task 8's recording versions
here — add the two minimal stubs, in `apps/server/tests/support/fakes.ts` inside
`createFakeDictRepo`, beside `findSenseVersion`:

```ts
    // Stubs until Task 8, which makes this fake form-aware and gives both of
    // these a backing map. Present now only because `DictRepo` names them.
    findCorrectionByForm: async () => undefined,
    persistCorrection: async () => {},
```

then run the unit bucket as well:

```bash
npm run test:unit
```

A red unit bucket between two tasks is not acceptable; two throwaway lines are.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repo/dictionary.ts apps/server/tests apps/server/src
git commit -m "feat: read and write a redirect, first-writer-wins

persistCorrection is bare ON CONFLICT DO NOTHING - this table has one unique
index and no primary key, so the only conflict a bare clause can swallow is the
one it is meant to, while a CHECK violation still raises. It re-applies
tidyAlternatives, so the three-item cap is a property of the write rather than
of one caller: dict:restore reaches the repository without passing through
domain/ at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Extract `serveForm`, with no behaviour change but one

**Files:**
- Modify: `apps/server/src/services/translations.ts`
- Test: `apps/server/src/services/translations.test.ts`

**Interfaces:**
- Consumes: `repairForm` (already module-private here); `kindForForm`, `rowsToSenses`, `SenseRow` from `domain/dictionary`.
- Produces, for Tasks 8, 9 and 10, a module-private function — **not exported**, because it is one step of one use case rather than a primitive (ADR 0001 R9), exactly as `reconcile` and `repairForm` already are:

```ts
type ServedForm = { kind: TranslationKind; senses: TranslationSense[]; rows: SenseRow[] };

async function serveForm(input: {
  llm: LlmClient;
  transaction: Transaction;
  form: string;
  direction: TranslationDirection;
  source: string;
  target: string;
  logger: Logger;
}): Promise<ServedForm | null>;   // null is a MISS
```

**Why this exists at all.** Phase 12's F5 amendment made a cache hit conditional: `translate`
reads the form's rows *and* its stale lexemes together, and where any lexeme has learned a sense
the form has never rendered, it re-renders before answering. A redirect resolves `thruot` to
`throat` and then reads `throat`'s rows — so unless the redirect path runs that same staleness
probe, `throat` repairs when typed directly and **never** repairs when reached through the
redirect. That is not cosmetic: a redirect hit costs no provider call and nothing else ever
visits that read path, so the gap would be permanent and one-directional. Naming this function
is what lets a redirect reach the *same* path rather than a parallel one, and it turns
"byte-identical" from a hope about two code paths staying in step into the same code path called
twice — the only version of that claim a review can check.

**The one behaviour change, stated rather than hidden.** Today, a hit whose repair *succeeded*
returns without logging `dict_cache_hit`, while a hit whose repair *failed* falls through and
logs it. After the extraction the hit log lives in `translate` and fires for every step-1 hit,
repaired or not. That is what the spec's flow asks for, and it is what makes the
`dict_redirect_hit` / `dict_cache_hit` ratio meaningful: `serveForm` logs the repair events,
because they describe the repair whichever path reached it, and never the hit, because only the
caller knows which kind of hit it was.

- [ ] **Step 1: Write the failing test for the normalized hit log**

Append to `apps/server/src/services/translations.test.ts`:

```ts
  // After the extraction the hit log lives in `translate` and fires for every
  // step-1 hit, repaired or not: `serveForm` logs the repair events — they
  // describe the repair whichever path reached it — and never the hit, because
  // only the caller knows whether it was a cache hit or a redirect hit. Before
  // the extraction a SUCCESSFUL repair returned without logging dict_cache_hit
  // while a FAILED one fell through and logged it, which is the inconsistency
  // this pins away.
  it('logs a cache hit whether or not the hit needed a repair', async () => {
    const { service, dict, logger } = serviceWith(
      reply({ senses: [{ sense_code: 'rung', translation: 'שלב' }] }),
    );
    dict.hit = [row('סולם', { lexemeId: 't-1' })];
    dict.stale = [
      { lexemeId: 't-1', variantId: 'v-1', lemma: 'ladder', partOfSpeech: 'noun' },
    ];

    await service.translate({ text: 'ladder' });

    const events = logger.events.map((event) => event.event);
    expect(events).toContain('dict_repaired');
    expect(events).toContain('dict_cache_hit');
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npx jest --selectProjects unit src/services/translations.test.ts; cd -
```

Expected: FAIL — `dict_cache_hit` is absent, because today the successful-repair branch returns
first. (`dict.stale` is a plain array at this point; Task 8 turns it into a record and updates
this test with the rest.)

- [ ] **Step 3: Extract the function**

In `apps/server/src/services/translations.ts`, between `repairForm` and
`createTranslationService`:

```ts
/** What one form resolves to. `rows` travels with the answer because the hit log
 *  counts distinct lexemes, and only the CALLER logs the hit. */
type ServedForm = {
  kind: TranslationKind;
  senses: TranslationSense[];
  rows: SenseRow[];
};

/**
 * Resolve one form to an answer: read its rows beside its stale lexemes, repair
 * it where a lexeme is ahead, and answer from the rows actually served. `null` is
 * a MISS.
 *
 * This is phase 12's F5 hit path, lifted out of `translate` and given a parameter.
 * It is not new behaviour and not new machinery — naming it is what lets a
 * redirect reach the SAME path rather than a parallel one. Steps 1, 3 and 5b of
 * the flow all call it, with `form`, with a stored redirect's target, and with the
 * corrected form; "byte-identical to typing the correct spelling" is then the same
 * code path called twice rather than a hope about two staying in step.
 *
 * Module-private, like `reconcile` and `repairForm` above: one step of one use
 * case, not a primitive (ADR 0001 R9).
 *
 * **The repair events are logged HERE and the hit is NOT.** `dict_repaired` and
 * `dict_repair_failed` describe the repair whichever path reached it. The hit
 * belongs to the caller, which is the only place that knows whether it was a cache
 * hit or a redirect hit — and the ratio between those two is precisely what
 * `dict_redirect_hit` exists to show. Extracted with the hit log still inside,
 * every redirect hit would be counted as a cache hit as well.
 *
 * **Its own read transaction**, which is exactly what makes it reusable, and the
 * reason step 2's redirect lookup is NOT folded into it: that would mean passing a
 * redirect lookup through a function that knows nothing about redirects. R8 permits
 * these reads — each precedes third-party I/O.
 */
async function serveForm({
  llm,
  transaction,
  form,
  direction,
  source,
  target,
  logger,
}: {
  llm: LlmClient;
  transaction: Transaction;
  form: string;
  direction: TranslationDirection;
  source: string;
  target: string;
  logger: Logger;
}): Promise<ServedForm | null> {
  const { rows, stale } = await transaction(async (repos) => ({
    rows: await repos.dict.findSensesByForm({
      form,
      languageCode: source,
      userLanguageCode: target,
    }),
    stale: await repos.dict.findStaleLexemesByForm({ form, languageCode: source }),
  }));

  // Checked FIRST: a variant with no renderings in this target language is a
  // MISS, not a repair, even if its lexeme is ahead. It has never been looked up.
  if (rows.length === 0) return null;

  let answerRows = rows;
  if (stale.length > 0) {
    // The repair reuses buildRenderingPrompt verbatim: "here is everything this
    // lexeme knows, render it for THIS form and rank it for THIS form" is exactly
    // what a repair needs, and that prompt is eval-scored.
    try {
      answerRows = await repairForm({ llm, transaction, form, direction, stale, source, target });
      // Counts and direction, like every other event in this file. The learner's
      // query text stays out of the log.
      logger.info({ event: 'dict_repaired', direction, lexeme_count: stale.length });
    } catch (error) {
      // Deliberately NOT the fail-closed path. A failed repair writes nothing, so
      // the stored rows stand — correct when written, merely incomplete. Failing
      // the request would deny a learner an answer the dictionary already holds,
      // to protect them from an answer that is not wrong.
      logger.error('dict_repair_failed', error);
      answerRows = rows;
    }
  }

  // BOTH fields off the rows actually served, so a repair re-ranks the answer it
  // returns. `kind` is read, never guessed: it is written by the persisting call
  // onto the entry_rank 0 variant and read back by `kindForForm`, so a hit answers
  // with what was actually stored rather than a re-derived guess that can disagree.
  return { kind: kindForForm(answerRows), senses: rowsToSenses(answerRows), rows: answerRows };
}
```

Add `TranslationKind` to the `@lang-tutor/core/api` type import and `SenseRow` is already
imported from `domain/dictionary`; add `TranslationSense` if it is not.

- [ ] **Step 4: Replace the hit path in `translate`**

Delete the `const { hit, stale } = await transaction(...)` read, the `if (hit.length > 0 &&
stale.length > 0)` block and the `if (hit.length > 0)` block, and put in their place:

```ts
      // Step 1 of the flow. The hot path: a correctly spelled word resolves here
      // exactly as it does today, repair included, and pays nothing for this phase.
      const direct = await serveForm({ llm, transaction, form, direction, source, target, logger });
      if (direct) {
        logger.info({
          event: 'dict_cache_hit',
          direction,
          term_count: new Set(direct.rows.map((r) => r.lexemeId)).size,
          sense_count: direct.senses.length,
        });
        return { text, direction, kind: direct.kind, senses: direct.senses };
      }
```

- [ ] **Step 5: Run the unit and integration buckets**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:unit && npm run test:integration
```

Expected: PASS, including the new hit-log test and every existing repair test in
`tests/integration/services/translations.test.ts` (the `dict_repair_failed` assertions, the
re-render, the stale-during-repair case and the drop-a-sense refusal). This task must change no
other behaviour: if an existing test moves, the extraction is wrong, not the test.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/translations.ts apps/server/src/services/translations.test.ts
git commit -m "refactor: extract serveForm, phase 12's hit path, so a redirect can reuse it

Read a form's rows beside its stale lexemes, repair where a lexeme is ahead,
answer from the rows served. The repair events are logged inside it because they
describe the repair whichever path reached it; the hit is logged by the caller,
the only place that knows whether it was a cache hit or a redirect hit. One
normalisation: a step-1 hit now logs dict_cache_hit whether or not its repair
succeeded, where before only a FAILED repair fell through to that log.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The redirect — steps 2 and 3, a form-aware fake, and `dict_redirect_hit`

**Files:**
- Modify: `apps/server/src/services/translations.ts`, `apps/server/tests/support/fakes.ts`
- Test: `apps/server/src/services/translations.test.ts`

**Interfaces:**
- Consumes: `serveForm` (Task 7); `findCorrectionByForm` (Task 6).
- Produces, for Tasks 9 and 10, the changed `FakeDictRepo`:

```ts
export type FakeDictRepo = DictRepo & {
  /** What `findSensesByForm` answers with, KEYED BY FORM. An absent or empty
   *  entry is a miss. */
  hit: Record<string, SenseRow[]>;
  /** What `findStaleLexemesByForm` answers with, keyed by form. */
  stale: Record<string, StaleLexeme[]>;
  /** The redirect table, keyed by TYPED form. `persistCorrection` appends here. */
  corrections: Record<string, CorrectionRow>;
  correctionsWritten: { typedForm: string; correctedForm: string; alternatives: string[] }[];
  repaired: { variantId: string; senseVersion: number }[];
  /* ...stored, lexemeReads, reread, persistError, persisted, reads unchanged */
};
```

**The fixture change is the bulk of this task, and it is fixture work rather than test work.**
`createFakeDictRepo` holds one `hit: SenseRow[]` and one `stale: StaleLexeme[]`, and
`findSensesByForm` returns `repo.hit` *whatever form it is handed* — exactly right while every
lookup read one form. Steps 1, 3 and 5b call it with **different forms in a single lookup** and
must get different answers, so both fields become records. `corrections` is a record for the
same reason: the probe reads it for two different forms in one lookup.

- [ ] **Step 1: Make the fake form-aware**

In `apps/server/tests/support/fakes.ts`, replace the `FakeDictRepo` type and
`createFakeDictRepo` body's dictionary halves:

```ts
export type FakeDictRepo = DictRepo & {
  /**
   * What the by-form read answers with, KEYED BY FORM and matched
   * case-insensitively, the way the real index is. An absent key is a miss.
   *
   * A record rather than a single array since phase 13: steps 1, 3 and 5b of the
   * lookup call `findSensesByForm` with different forms in ONE lookup and must
   * get different answers. Before phase 13 every lookup read one form, and a
   * single array was exactly right.
   */
  hit: Record<string, SenseRow[]>;
  /** What `findStaleLexemesByForm` answers with, keyed by form. An absent key is
   *  level — the default, so a test that never mentions staleness keeps taking the
   *  plain-hit branch. */
  stale: Record<string, StaleLexeme[]>;
  /** The redirect table, keyed by TYPED form, matched case-insensitively. */
  corrections: Record<string, CorrectionRow>;
  /** Every `persistCorrection` call, in order. */
  correctionsWritten: {
    typedForm: string;
    correctedForm: string;
    alternatives: string[];
    languageCode: string;
  }[];
  /** Every `repairVariantRenderings` call, in order — no longer unreachable from
   *  phase 13 on, because the redirect-and-repair tests drive it. */
  repaired: { variantId: string; senseVersion: number }[];
  stored: Record<string, StoredSense[]>;
  lexemeReads: { lemma: string; partOfSpeech: string }[];
  reread: SenseRow[];
  persistError: Error | null;
  persisted: PersistEntriesInput[];
  reads: { form: string; languageCode: string; userLanguageCode: string }[];
};

export function createFakeDictRepo(): FakeDictRepo {
  // One lookup rule for all three maps, matching the real index's
  // (language_code, lower(form)) exactly — so a test that writes `Thruot` and
  // reads `thruot` behaves the way Postgres does.
  const at = <T>(map: Record<string, T>, form: string): T | undefined =>
    map[form] ?? map[Object.keys(map).find((key) => key.toLowerCase() === form.toLowerCase()) ?? ''];

  const repo: FakeDictRepo = {
    hit: {},
    stale: {},
    corrections: {},
    correctionsWritten: [],
    repaired: [],
    stored: {},
    lexemeReads: [],
    reread: [],
    persistError: null,
    persisted: [],
    reads: [],
    findSensesByForm: async (input) => {
      repo.reads.push(input);
      return at(repo.hit, input.form) ?? [];
    },
    findStaleLexemesByForm: async (input) => at(repo.stale, input.form) ?? [],
    findCorrectionByForm: async (input) => at(repo.corrections, input.form),
    persistCorrection: async (input) => {
      repo.correctionsWritten.push(input);
      // First-writer-wins, like the real one: a second write for one typed form
      // is a no-op that leaves the first target in place.
      const existing = at(repo.corrections, input.typedForm);
      if (!existing) {
        repo.corrections[input.typedForm] = {
          typedForm: input.typedForm,
          correctedForm: input.correctedForm,
          alternatives: input.alternatives,
        };
      }
    },
    findSensesByLexeme: async (input) => {
      /* unchanged */
    },
    findSenseVersion: async () => 0,
    repairVariantRenderings: async (input) => {
      repo.repaired.push({ variantId: input.variantId, senseVersion: input.senseVersion });
    },
    persistEntries: async (input) => {
      /* unchanged */
    },
  };
  return repo;
}
```

Import `CorrectionRow` from `../../src/repo/dictionary` beside `PersistEntriesInput`.

Note `repairVariantRenderings` stops being a bare stub and becomes a recorder, because Task 10's
probe-repairs test reads it. `findSenseVersion` stays `async () => 0` — a unit test asserts that
a repair *happened*, not which version it stamped; that is the integration bucket's job.

- [ ] **Step 2: Update the two existing fixture call sites**

In `apps/server/src/services/translations.test.ts`, `dict.hit = [row('סולם')]` becomes
`dict.hit = { ladder: [row('סולם')] }` and `dict.hit = [row('לזכור', { kind: 'word' })]` becomes
`dict.hit = { 'to remember': [row('לזכור', { kind: 'word' })] }` — keyed by the **normalized**
form each of those tests looks up. Read each test to get the key right rather than guessing;
`grep -n 'translate({ text' ` around each one gives it.

Task 7's new hit-log test becomes:

```ts
    dict.hit = { ladder: [row('סולם', { lexemeId: 't-1' })] };
    dict.stale = {
      ladder: [{ lexemeId: 't-1', variantId: 'v-1', lemma: 'ladder', partOfSpeech: 'noun' }],
    };
```

- [ ] **Step 3: Write the failing redirect tests**

Append to `apps/server/src/services/translations.test.ts`:

```ts
describe('the stored redirect', () => {
  const redirect = (over: Partial<CorrectionRow> = {}): CorrectionRow => ({
    typedForm: 'thruot',
    correctedForm: 'throat',
    alternatives: ['throughout'],
    ...over,
  });

  it('answers a known typo from the corrected form, with NO provider call', async () => {
    const { service, llm, dict, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.corrections = { thruot: redirect() };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    const result = await service.translate({ text: 'thruot' });

    expect(llm.calls).toHaveLength(0);
    expect(result.senses).toEqual([{ translation: 'גרון' }]);
    expect(result.kind).toBe('word');
    // The typed string survives in exactly two places: the response's `text`, and
    // the dict_corrections row.
    expect(result.text).toBe('thruot');
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throughout'] });
    const events = logger.events.map((event) => event.event);
    expect(events).toContain('dict_redirect_hit');
    // A redirect hit is NOT also a cache hit. The ratio between the two events is
    // precisely what the second one exists to show.
    expect(events).not.toContain('dict_cache_hit');
  });

  // Step 1 precedes step 2, permanently. A string that is a real form in its own
  // right is never routed away from itself, even if a redirect for it exists —
  // which is the same rule that makes a typo shadow its own redirect once a
  // variant is written for it.
  it('never consults a redirect for a form that has rows of its own', async () => {
    const { service, dict, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.corrections = { throat: redirect({ typedForm: 'throat', correctedForm: 'throughout' }) };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    const result = await service.translate({ text: 'throat' });

    expect(result.correction).toBeUndefined();
    expect(result.senses).toEqual([{ translation: 'גרון' }]);
    expect(logger.events.map((event) => event.event)).toContain('dict_cache_hit');
  });

  it('falls through to the model when the redirect target has no rows', async () => {
    const { service, llm, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('thruot', [{ translation: 'גרון', sense_code: 'body_part' }]),
      }),
    );
    dict.corrections = { thruot: redirect() };
    dict.hit = {};

    await service.translate({ text: 'thruot' });

    expect(llm.calls).toHaveLength(1);
  });

  // Step 3 goes through serveForm, staleness probe and repair included. Read the
  // rows directly here instead and `thruot` would serve two senses forever while
  // `throat` kept converging on three — permanently, since a redirect hit makes no
  // provider call and nothing else visits that path.
  //
  // What this asserts is that the repair RAN, not what it produced. `repairForm`
  // closes with `findSensesByForm(form)`, which in this fake reads `dict.hit`
  // again and so returns the same rows before and after — `dict.reread` feeds
  // `persistEntries`, not the repair. Proving the repair CHANGED the answer needs
  // real rows, and that is the integration bucket's job (Task 11's byte-identical
  // case).
  it('repairs a stale redirect target, with exactly one provider call', async () => {
    const { service, llm, dict } = serviceWith(
      reply({ senses: [{ sense_code: 'body_part', translation: 'צוואר' }] }),
    );
    dict.corrections = { thruot: redirect() };
    dict.hit = { throat: [row('גרון', { lexemeId: 't-1', kind: 'word' })] };
    dict.stale = {
      throat: [{ lexemeId: 't-1', variantId: 'v-1', lemma: 'throat', partOfSpeech: 'noun' }],
    };
    dict.stored['throat:noun'] = [
      { senseCode: 'body_part', translation: 'גרון', exampleSource: null, exampleTarget: null },
    ];

    const result = await service.translate({ text: 'thruot' });

    // The repair call, and only it — a redirect hit pays no call 1.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain('reusing its sense_code EXACTLY');
    expect(llm.calls[0].user).toBe('throat');
    expect(dict.repaired).toEqual([{ variantId: 'v-1', senseVersion: 0 }]);
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throughout'] });
  });

  // The convention every other event in this file holds to, and the one a new
  // event is most likely to break.
  it('keeps the learner\'s text out of both new events', async () => {
    const { service, dict, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    dict.corrections = { thruot: redirect() };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    await service.translate({ text: 'thruot' });

    const serialized = JSON.stringify(logger.events);
    expect(serialized).not.toContain('thruot');
    expect(serialized).not.toContain('throat');
  });
});
```

Import `CorrectionRow` at the top of the test file from `../repo/dictionary`.

`dict.stored['throat:noun']` is what makes the repair test's model call happen at all:
`repairForm` reads each stale lexeme's senses through `findSensesByLexeme` before it prompts, and
a lexeme with no stored senses produces an empty prompt and a repair that cannot reconcile.
`findSenseVersion` stays `async () => 0` in the fake, which is why the expected `senseVersion` is
`0` — a unit test asserts that a repair happened and against which variant, never which version
it stamped; that is the integration bucket's assertion.

- [ ] **Step 4: Run and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npx jest --selectProjects unit src/services/translations.test.ts; cd -
```

Expected: the four redirect tests FAIL (`llm.calls` has length 1 where 0 was expected;
`result.correction` is undefined). The two migrated fixture tests and Task 7's log test PASS.

- [ ] **Step 5: Add steps 2 and 3 to `translate`**

Directly after the step-1 block, before `const raw = await llm(buildPrompt(...))`:

```ts
      // Step 2. One indexed lookup, its own read — R8 permits it, and it is
      // reached ONLY when the typed form has no rows, a path that otherwise costs
      // a provider call measured in seconds.
      //
      // NOT folded into `serveForm`: that function owns its own read transaction,
      // which is exactly what makes it reusable, and folding this in would mean
      // passing a redirect lookup through a function that knows nothing about
      // redirects.
      const redirect = await transaction((repos) =>
        repos.dict.findCorrectionByForm({ form, languageCode: source }),
      );

      if (redirect) {
        // Step 3 is step 1 with a different argument, and that is the whole of the
        // fix. A redirect hit is byte-identical to typing the correct spelling
        // because the SAME function produces both, staleness probe and repair
        // included. The correction block is attached AFTER serveForm returns and
        // changes neither field it produced.
        const served = await serveForm({
          llm,
          transaction,
          form: redirect.correctedForm,
          direction,
          source,
          target,
          logger,
        });
        if (served) {
          logger.info({
            event: 'dict_redirect_hit',
            direction,
            alternative_count: redirect.alternatives.length,
          });
          return {
            text,
            direction,
            kind: served.kind,
            senses: served.senses,
            correction: {
              corrected_form: redirect.correctedForm,
              alternatives: redirect.alternatives,
            },
          };
        }
        // A miss falls through to the model with the redirect DISCARDED. It is
        // deliberately not reused to rewrite the query: see Task 9's
        // "the model declines" note.
      }
```

- [ ] **Step 6: Run both buckets and the architecture check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:unit && npm run test:integration && npm run lint:arch
```

Expected: PASS, 17 ADR 0001 rules.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/translations.ts apps/server/src/services/translations.test.ts \
  apps/server/tests/support/fakes.ts
git commit -m "feat: answer a known typo through the same path that answers the word

Step 3 is step 1 with a different argument: the redirect's target goes through
serveForm, so a corrected answer is byte-identical to typing the correct
spelling - including the staleness probe, without which throat would repair when
typed and never when reached through thruot, permanently. FakeDictRepo's hit and
stale become records keyed by form, because one lookup now reads three of them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The correction on the miss path — steps 4, 5, 8 and 9

**Files:**
- Modify: `apps/server/src/services/translations.ts`
- Test: `apps/server/src/services/translations.test.ts`

**Interfaces:**
- Consumes: `resolveCorrection` (Task 4); `persistCorrection` (Task 6); `serveForm` (Task 7).
- Produces: nothing new. `translate`'s signature is unchanged; the response may now carry `correction`.

**The central decision: a correction rewrites the queried form once, and nothing downstream
knows.** The service reads `correction.corrected_form` and substitutes it for the queried form at
the top of the pipeline. Phase 12's reconciliation read, its second model call, its
`persistEntries` and its `resolveKind` then run **verbatim** on `booked` rather than on `bokked`.
A parallel branch was rejected after tracing what phase 12 does with the queried form:
`buildRenderingPrompt` receives it and asks the model to render every stored sense *in the
grammatical form matching the input*, building examples around it — so handing that prompt
`bokked` produces renderings that agree with a misspelling, which phase 12 writes permanently.
Rewriting at `persistEntries` alone is not enough; rewriting once, before the pipeline, covers
every downstream use by construction.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/services/translations.test.ts`:

```ts
describe('a correction on the miss path', () => {
  const corrected = (over: Record<string, unknown> = {}) =>
    reply({
      kind: 'word',
      entries: [
        {
          lemma: 'book',
          part_of_speech: 'verb',
          senses: [{ translation: 'הזמין', sense_code: 'make_reservation' }],
        },
      ],
      correction: { corrected_form: 'booked', alternatives: ['booted'] },
      ...over,
    });

  // Criterion 4. The substitution happens ONCE, inside resolveCorrection, and
  // every downstream use is covered by construction.
  it('hands persistEntries the corrected form, never the typed one', async () => {
    const { service, dict } = serviceWith(corrected());

    const result = await service.translate({ text: 'bokked' });

    expect(dict.persisted).toHaveLength(1);
    expect(dict.persisted[0].form).toBe('booked');
    expect(result.text).toBe('bokked');
    expect(result.correction).toEqual({ corrected_form: 'booked', alternatives: ['booted'] });
  });

  // The reconciliation call phase 12 added never sees the typed string. Hand that
  // prompt `bokked` and it renders a misspelling, permanently.
  it('hands buildRenderingPrompt the corrected form when the lexeme already has senses', async () => {
    const { service, llm, dict } = serviceWith(
      corrected(),
      reply({ senses: [{ sense_code: 'make_reservation', translation: 'הזמין' }] }),
    );
    dict.stored['book:verb'] = [
      { senseCode: 'make_reservation', translation: 'להזמין', exampleSource: null, exampleTarget: null },
    ];

    await service.translate({ text: 'bokked' });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].user).toBe('booked');
    expect(llm.calls[1].system).toContain('"booked"');
    expect(llm.calls[1].system).not.toContain('bokked');
  });

  it('writes the redirect beside the entries, and logs dict_corrected', async () => {
    const { service, dict, logger } = serviceWith(corrected());

    await service.translate({ text: 'bokked' });

    expect(dict.correctionsWritten).toEqual([
      expect.objectContaining({
        typedForm: 'bokked',
        correctedForm: 'booked',
        alternatives: ['booted'],
      }),
    ]);
    expect(logger.events.map((event) => event.event)).toContain('dict_corrected');
    expect(JSON.stringify(logger.events)).not.toContain('bokked');
  });

  // Criterion 8's fourth guard, at the service level: the same path an unparseable
  // answer takes. Nothing is written and no second call is made — the entries
  // describe the corrected headword, so they are wrong in the same way the form is.
  it('raises TranslationUnreadable when the corrected form is in the other script', async () => {
    const { service, llm, dict } = serviceWith(
      corrected({ correction: { corrected_form: 'שלום' } }),
    );

    await expect(service.translate({ text: 'shalom' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
    expect(llm.calls).toHaveLength(1);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // Criterion 7. Both halves: no correction block, AND a kind that did not come
  // from the corrected form.
  it('reports no correction and no derived kind for an answer with no entries', async () => {
    const { service, dict } = serviceWith(
      reply({ kind: 'phrase', entries: [], correction: { corrected_form: 'zxq wbtl' } }),
    );

    const result = await service.translate({ text: 'zxqwbtl' });

    expect(result.correction).toBeUndefined();
    expect(result.kind).toBe('word');
    expect(result.senses).toEqual([]);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // Criterion 14, and the decision this is one `if` away from reversing. A
  // redirect exists, its target has no rows, and call 1 answers with entries and
  // NO correction. Reusing redirect.correctedForm as the effective form would look
  // like a free mitigation and is rejected: when no correction is present the model
  // has been told to build its examples around the input AS TYPED, and those
  // examples are exactly what persistEntries stores. Writing that answer under
  // `throat` would file example sentences containing `thruot` against the correctly
  // spelled form, permanently — the defect the third prompt rule exists to prevent,
  // reintroduced through the one path that bypasses the rule's precondition.
  it('answers the model on its own terms when it declines to correct', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('thruot', [{ translation: 'גרון', sense_code: 'body_part' }]),
      }),
    );
    dict.corrections = {
      thruot: { typedForm: 'thruot', correctedForm: 'throat', alternatives: [] },
    };
    dict.hit = {};

    const result = await service.translate({ text: 'thruot' });

    expect(dict.persisted[0].form).toBe('thruot');
    expect(result.correction).toBeUndefined();
  });

  // Criterion 5, unit half. A failing reconciliation call writes nothing — no
  // entries AND no redirect — because steps 8 and 9 share one transaction. Those
  // two are DEPENDENT: a redirect must not point at a form with no rows.
  it('writes neither entries nor a redirect when the reconciliation call fails', async () => {
    const { service, dict } = serviceWith(corrected(), 'not json at all');
    dict.stored['book:verb'] = [
      { senseCode: 'make_reservation', translation: 'להזמין', exampleSource: null, exampleTarget: null },
    ];

    await expect(service.translate({ text: 'bokked' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // A sentence carrying a correction is answered SILENTLY: the notice is
  // suppressed and the entries kept. A judgement, not an oversight — a sentence is
  // never written to the dictionary so nothing is poisoned, and refusing the answer
  // would fail a request the model translated correctly over a field it was told
  // not to send.
  it('suppresses the notice on a sentence but keeps the translation', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'sentence',
        ...oneEntry('I have a sore throat', [{ translation: 'יש לי כאב גרון.', sense_code: 's' }], 'verb'),
        correction: { corrected_form: 'I have a sore throat' },
      }),
    );

    const result = await service.translate({ text: 'I have a sore thruot' });

    expect(result.kind).toBe('sentence');
    expect(result.senses).toEqual([{ translation: 'יש לי כאב גרון.' }]);
    expect(result.correction).toBeUndefined();
    expect(dict.persisted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npx jest --selectProjects unit src/services/translations.test.ts; cd -
```

Expected: FAIL — `dict.persisted[0].form` is `'bokked'`, `result.correction` is undefined,
`dict.correctionsWritten` is empty, and the script-guard test resolves rather than rejecting.

- [ ] **Step 3: Replace `resolveKind` with `resolveCorrection` at step 4**

In `translate`, replace:

```ts
      const kind = resolveKind(text, parsed.kind);
```

with:

```ts
      // Step 4. One call, in domain/: the four guards, the empty-entries clearing,
      // both forms normalized and tidied, the effective form, and resolveKind
      // against that form. `null` means the answer cannot be used at all — the
      // fourth guard — and costs the same as an answer that failed to parse.
      const resolved = resolveCorrection(parsed, { typedForm: form, direction });
      if (!resolved) throw new TranslationUnreadable(raw.slice(0, 200));

      // Step 5. `correction` is the MODEL's, never the redirect step 2 may have
      // found: a model that declined to correct is answered on its own terms,
      // because its examples were built around the input as typed and filing them
      // under the correct spelling would be worse than a variant for the typo.
      const { correction, effectiveForm, kind } = resolved;
```

`resolveKind` changing its argument is a simplification rather than a behaviour change on the
uncorrected path, and it is worth the comment because the diff touches it: `effectiveForm` is
`normalizeForm(text)` when nothing was corrected, `normalizeForm` collapses internal whitespace
and strips a trailing sentence mark from a *single token* — neither of which adds or removes
whitespace from a multi-token string — and `resolveKind` asks exactly one question, *does this
contain whitespace*. Add that as a comment above the `resolved` call. Leave the
`raw === ''` early return's `resolveKind(text, 'word')` alone: there is no parsed answer there,
and the two agree for every input the request schema admits.

Import `resolveCorrection` from `../domain/translation`; `resolveKind` stays imported for the
no-content path.

- [ ] **Step 4: Carry `effectiveForm` through the pipeline**

Three call sites below step 5 change from `form` to `effectiveForm`:

1. the reconciliation call — `entries = await reconcile({ llm, form: effectiveForm, direction, entries, stored, logger })`
2. the write — `repos.dict.persistEntries({ form: effectiveForm, ... })`
3. nothing else. `text` stays the typed string on every response, and `form` stays the typed,
   normalized string, because step 9's redirect is keyed by it.

- [ ] **Step 5: Add step 9 to the write transaction, and the correction to the responses**

The write block becomes:

```ts
      try {
        const { written, senses } = await transaction(async (repos) => {
          const result = await repos.dict.persistEntries({
            form: effectiveForm,
            languageCode: source,
            userLanguageCode: target,
            kind,
            entries,
          });
          // Step 9, in the SAME transaction as step 8. These two are DEPENDENT —
          // a redirect must not point at a form with no rows — which is what makes
          // phase 12's fail-closed rule cover this phase for free: a failed
          // reconciliation call writes no entries AND no redirect. (Contrast the
          // probe at step 5b, where a repair and a redirect are independent and
          // idempotent and may be two transactions; ADR 0001 R8, fourth amendment.)
          if (correction) {
            await repos.dict.persistCorrection({
              typedForm: form,
              correctedForm: correction.corrected_form,
              alternatives: correction.alternatives,
              languageCode: source,
            });
          }
          return result;
        });
        logger.info({
          event: 'dict_persisted',
          entry_count: written.length,
          lexemes_created: written.filter((entry) => entry.created).length,
        });
        if (correction) {
          logger.info({
            event: 'dict_corrected',
            direction,
            alternative_count: correction.alternatives.length,
          });
        }
        logger.info({ event: 'translated', direction, kind, sense_count: senses.length });
        return { text, direction, kind, senses, ...(correction ? { correction } : {}) };
      } catch (error) {
        logger.error('dict_persist_failed', error);
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        // The correction block is still attached: it describes the MODEL's answer,
        // which is true whether or not storage succeeded — the same reasoning that
        // keeps this path answering 200 with the senses the learner already paid
        // for. Only the redirect ROW is lost, and the next lookup writes it.
        return { text, direction, kind, senses: flattened, ...(correction ? { correction } : {}) };
      }
```

The sentence / empty-entries early return above it is left **exactly as it is**: `correction` is
already `undefined` on both of those paths — the sentence guard dropped it and the empty-entries
clearing cleared it — so the early return builds a fresh object with no `correction` key and
needs no `if`. An implementer who adds `correction` to *"every response path"* breaks criterion 7
in a way no response field reveals.

- [ ] **Step 6: Run both buckets and the architecture check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:unit && npm run test:integration && npm run lint:arch
```

Expected: PASS, 17 ADR 0001 rules.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/translations.ts apps/server/src/services/translations.test.ts
git commit -m "feat: rewrite the queried form once, and record the redirect beside the entries

resolveCorrection settles the effective form before the pipeline, so phase 12's
reconciliation call, persistEntries and resolveKind all run verbatim on `booked`
rather than on `bokked` - buildRenderingPrompt never sees a misspelling to build
examples around. Steps 8 and 9 share one transaction because they are dependent:
a redirect must not point at a form with no rows.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The corrected-form probe and the one hop — step 5b

**Files:**
- Modify: `apps/server/src/services/translations.ts`
- Test: `apps/server/src/services/translations.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4, 6, 7, 8, 9.
- Produces: nothing new.

**Why the probe exists.** Once the backfill lands, a correction's target is *usually* a word the
dictionary already holds — corrections resolve to common words, and common words are exactly
what a backfill contains. Trace `bokked` against a stored `booked` and the flow without a probe
does the wrong thing twice. Step 7 pays a reconciliation call whose result the write is about to
discard, because every insert in `persistEntries` is `DO NOTHING` for a form that already has
renderings. And step 8 runs `persistEntries` on a form that already has rows, which phase 12's
live flow never does — a hit returns at step 1 before it can — so its consequences were never
examined: if call 1 ranks the entries differently from the stored variant, the variant insert
collides on `dict_variants_form_entry_rank_key`, the safety net the repository deliberately lets
raise; `translate`'s `catch` turns that into a 200, and because steps 8 and 9 share one
transaction **the redirect is never written**. Every later `bokked` lookup repeats the two calls
and the failed write, forever, as a log line. And if the orders agree, step 5b of
`persistEntries` stamps the existing variant level against the lexeme's current version without
having rewritten a rendering — so a `booked` that happened to be stale is marked repaired
without being repaired, cancelling the F5 promise for that form.

**Why it may commit two transactions.** A probe hit that repaired the corrected form has already
committed the repair's transaction inside `serveForm`, and must then record the redirect. Those
two writes are **independent and idempotent**: the repair is correct whether or not
`thruot → throat` lands, the redirect is correct whether or not `throat` was just repaired, and
a failure between them leaves a correct dictionary and one more provider call. That is the pair
ADR 0001 R8's fourth amendment admits by name. The workaround that would have kept the old
wording — a bare read that never repairs — protected the letter of the rule and not its reason,
and reintroduced a second read path for one form, the divergence Task 7 exists to remove.

**Why the hop stops after one link.** If the model names `throte` as the correction of `thruot`
and `throte` is itself a known typo, writing rows for `throte` would put a `dict_variants` row
under a string *this very table records as not a word* — which then shadows `throte`'s own
redirect forever by the *correct spellings win* rule. One hop fixes it; a second would make the
number of reads a lookup performs depend on data, so a chain whose second target also has no
rows fails the lookup instead. Failing closed on the first hop was considered and rejected: at
`temperature: 0` the retry returns the same `throte`, turning one typo into a permanently
failing request, where the hop answers with a real word's stored answer and writes nothing that
is not already true.

- [ ] **Step 1: Write the failing probe tests**

Append to `apps/server/src/services/translations.test.ts`:

```ts
describe('the corrected-form probe', () => {
  const correctingReply = reply({
    kind: 'word',
    entries: [
      // Deliberately ADJECTIVE FIRST, where the stored `booked` below has the verb
      // at entry_rank 0. That is the shape that made the un-probed flow collide on
      // dict_variants_form_entry_rank_key, answer 200 from the catch, and roll the
      // redirect back with the write — forever.
      { lemma: 'book', part_of_speech: 'adjective', senses: [{ translation: 'מוזמן', sense_code: 'reserved' }] },
      { lemma: 'book', part_of_speech: 'verb', senses: [{ translation: 'הזמין', sense_code: 'make_reservation' }] },
    ],
    correction: { corrected_form: 'booked', alternatives: [] },
  });

  // Criterion 23, and the ordinary corrected miss once the backfill lands.
  it('serves a target the dictionary already holds, with one call and no write to it', async () => {
    const { service, llm, dict, logger } = serviceWith(correctingReply);
    dict.hit = { booked: [row('הזמין', { kind: 'word', lexemeId: 't-verb' })] };

    const result = await service.translate({ text: 'bokked' });

    expect(llm.calls).toHaveLength(1);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toEqual([
      expect.objectContaining({ typedForm: 'bokked', correctedForm: 'booked' }),
    ]);
    // The target's stored answer, unchanged, plus the correction block.
    expect(result.kind).toBe('word');
    expect(result.senses).toEqual([{ translation: 'הזמין' }]);
    expect(result.correction).toEqual({ corrected_form: 'booked', alternatives: [] });
    expect(logger.events.map((event) => event.event)).toContain('dict_corrected');
  });

  // The R8 amendment's "independent" claim, as a test: two writes, in this order.
  it('repairs a stale target inside serveForm and still writes the redirect after', async () => {
    const { service, llm, dict } = serviceWith(
      correctingReply,
      reply({ senses: [{ sense_code: 'make_reservation', translation: 'הזמין' }] }),
    );
    dict.hit = { booked: [row('להזמין', { kind: 'word', lexemeId: 't-verb' })] };
    dict.stale = {
      booked: [{ lexemeId: 't-verb', variantId: 'v-booked', lemma: 'book', partOfSpeech: 'verb' }],
    };

    const result = await service.translate({ text: 'bokked' });

    // Call 1 and the repair. NOT a reconciliation for the miss pipeline — that
    // pipeline never runs.
    expect(llm.calls).toHaveLength(2);
    expect(dict.repaired).toHaveLength(1);
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(1);
    expect(result.correction).toEqual({ corrected_form: 'booked', alternatives: [] });
  });

  // The case the third revision traced, and the only one in which the
  // reconciliation path is handed the corrected form.
  it('falls through to the pipeline when the corrected form has no rows of its own', async () => {
    const { service, dict } = serviceWith(correctingReply);
    dict.hit = {};

    await service.translate({ text: 'bokked' });

    expect(dict.persisted).toHaveLength(1);
    expect(dict.persisted[0].form).toBe('booked');
    expect(dict.correctionsWritten).toHaveLength(1);
  });

  // Criterion 24. The model's entries described `throte`; they are discarded
  // unwritten, and the redirect points straight at `throat`.
  it('follows a corrected form that is itself a known typo, one hop', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('throte', [{ translation: 'גרון', sense_code: 'body_part' }]),
        correction: { corrected_form: 'throte', alternatives: [] },
      }),
    );
    dict.corrections = {
      throte: { typedForm: 'throte', correctedForm: 'throat', alternatives: ['throaty'] },
    };
    dict.hit = { throat: [row('גרון', { kind: 'word' })] };

    const result = await service.translate({ text: 'thruot' });

    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toEqual([
      expect.objectContaining({ typedForm: 'thruot', correctedForm: 'throat' }),
    ]);
    // The correction block names the HOP's target, and carries the hop's own
    // alternatives — the model's described `throte`, which nothing is written for.
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throaty'] });
    expect(result.senses).toEqual([{ translation: 'גרון' }]);
  });

  // One hop, no further. A chain AND a truncated dictionary: accepted, and it
  // fails the lookup rather than reading on, so the number of reads never depends
  // on data.
  it('fails the lookup and writes nothing when the hop target has no rows either', async () => {
    const { service, dict } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('throte', [{ translation: 'גרון', sense_code: 'body_part' }]),
        correction: { corrected_form: 'throte', alternatives: [] },
      }),
    );
    dict.corrections = {
      throte: { typedForm: 'throte', correctedForm: 'throat', alternatives: [] },
    };
    dict.hit = {};

    await expect(service.translate({ text: 'thruot' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
    expect(dict.persisted).toHaveLength(0);
    expect(dict.correctionsWritten).toHaveLength(0);
  });

  // The probe runs ONLY when a correction is present. An uncorrected miss must
  // pay no extra read.
  it('does not probe when the model reported no correction', async () => {
    const { service, dict } = serviceWith(
      reply({ kind: 'word', ...oneEntry('kite', [{ translation: 'עפיפון', sense_code: 'toy' }]) }),
    );

    await service.translate({ text: 'kite' });

    expect(dict.persisted[0].form).toBe('kite');
    expect(dict.correctionsWritten).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npx jest --selectProjects unit src/services/translations.test.ts; cd -
```

Expected: the probe tests FAIL — one provider call becomes two, `dict.persisted` has a row where
none was expected, and the chain test writes a redirect to `throte`. The last two tests
(fall-through, no-probe) PASS already; they are the fence around the change.

- [ ] **Step 3: Insert step 5b**

In `translate`, directly after the `const { correction, effectiveForm, kind } = resolved;` line
and **before** `let entries = mergeEntries(...)`:

```ts
      // Step 5b — the corrected-form probe, only when a correction is present.
      //
      // The SAME function steps 1 and 3 call, repair included. Once the backfill
      // lands this is the ordinary corrected miss: corrections resolve to common
      // words, and common words already have rows. Without it, step 7 pays a
      // reconciliation call whose result the write discards (every insert in
      // persistEntries is DO NOTHING for a form that already has renderings), and
      // step 8 runs persistEntries on a form that already has rows — a path phase
      // 12's live flow never takes, because a hit returns at step 1 first. If call
      // 1 ranks the entries differently from the stored variant, the variant insert
      // collides on dict_variants_form_entry_rank_key — the safety net, which must
      // raise — the catch answers 200, and the redirect is rolled back with the
      // write. Two calls and a failed write on every lookup of that typo, forever.
      if (correction) {
        const probe = await serveForm({
          llm,
          transaction,
          form: effectiveForm,
          direction,
          source,
          target,
          logger,
        });

        if (probe) {
          // A SECOND, INDEPENDENT write: the probe may already have committed the
          // repair's transaction inside serveForm. Each is correct alone, each is
          // idempotent, and a failure between them leaves a correct dictionary and
          // one more provider call — ADR 0001 R8, fourth amendment. Contrast steps
          // 8 and 9, which are dependent and share one transaction.
          await transaction((repos) =>
            repos.dict.persistCorrection({
              typedForm: form,
              correctedForm: correction.corrected_form,
              alternatives: correction.alternatives,
              languageCode: source,
            }),
          );
          logger.info({
            event: 'dict_corrected',
            direction,
            alternative_count: correction.alternatives.length,
          });
          // No call 2 and no persistEntries: the target already holds its own
          // renderings.
          return { text, direction, kind: probe.kind, senses: probe.senses, correction };
        }

        // The chain. Made ONLY when the probe missed. Without it, step 8 would
        // write a dict_variants row for a string this very table records as not a
        // word — which then shadows that string's own redirect forever by the
        // "correct spellings win over redirects" rule: this phase's central defect
        // arriving by its own machinery.
        const hop = await transaction((repos) =>
          repos.dict.findCorrectionByForm({ form: effectiveForm, languageCode: source }),
        );
        if (hop) {
          const hopped = await serveForm({
            llm,
            transaction,
            form: hop.correctedForm,
            direction,
            source,
            target,
            logger,
          });
          // ONE hop, no further: a chain whose second target has no rows fails the
          // lookup rather than reading on, so the number of reads a lookup makes
          // never depends on data. It needs a chain AND a truncated dictionary.
          if (!hopped) throw new TranslationUnreadable(raw.slice(0, 200));

          const hopCorrection = {
            corrected_form: hop.correctedForm,
            alternatives: hop.alternatives,
          };
          await transaction((repos) =>
            repos.dict.persistCorrection({
              typedForm: form,
              // Straight to the hop's target, never to the typo the model named.
              correctedForm: hop.correctedForm,
              alternatives: hop.alternatives,
              languageCode: source,
            }),
          );
          logger.info({
            event: 'dict_corrected',
            direction,
            alternative_count: hop.alternatives.length,
          });
          // The model's entries described the intermediate typo. Discarded unwritten.
          return {
            text,
            direction,
            kind: hopped.kind,
            senses: hopped.senses,
            correction: hopCorrection,
          };
        }
      }
```

- [ ] **Step 4: Run both buckets and the architecture check**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:unit && npm run test:integration && npm run lint:arch
```

Expected: PASS, 17 ADR 0001 rules. R8's detection command counts call sites of the
**mechanism** (`\.transaction(` outside `db/transaction.ts`), not transactions per use case, so
the two new bare `transaction(...)` calls are invisible to it — which is exactly what the
amendment's prose says, and why no check changed.

- [ ] **Step 5: Re-read `translate` end to end against the spec's flow**

Open the spec's *The flow* block beside the function and walk steps 1, 2, 3, 4, 5, 5b, 6, 7, 8,
9 in order. Four cases to check by eye, the four the spec names for review:

- **step 5** — the substitution happens once, inside `resolveCorrection`, and the reconciliation
  call never sees the typed string;
- **step 3b** — the repair reached through a redirect, which an implementation gets wrong by
  reading the corrected form's rows directly;
- **step 6** — the probe, which an implementation gets wrong by not having one;
- **step 7** — the hop, one link and no more.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/translations.ts apps/server/src/services/translations.test.ts
git commit -m "feat: serve a corrected form the dictionary already holds, and follow one hop

The ordinary corrected miss after the backfill: the target is a common word that
already has rows. Probing it first costs one read on a path that has just paid
for a model call, and saves a reconciliation whose result the write would
discard plus a persistEntries that can collide on the entry-rank safety net and
roll the redirect back with it. A probe hit may commit two transactions - the
repair and the redirect - which are independent and idempotent, per R8's fourth
amendment. A corrected form that is itself a known typo is followed one hop and
no further.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: The integration suite — the server as a black box

**Files:**
- Modify: `apps/server/tests/support/mockServer.ts`, `apps/server/tests/integration/routes/translations.test.ts`
- Create: `apps/server/tests/integration/services/translations.correction.test.ts`, `apps/server/tests/integration/repo/dictionary.corrections.variants.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces: `expectGeminiJson(ns, { kind, entries, correction?, matchText? })`.

Production's assembly with a per-test database and this test's own MockServer namespace. The
real Gemini client makes a real HTTP request over a real socket; **nothing is faked inside the
server**. Every string used here must be one the seed does not contain — a seeded string answers
from Postgres and never reaches MockServer, which would turn these assertions into silent
passes. `throat`, `throughout`, `throte`, `bokked` and `booked` are all safe; re-check against
`src/db/content.generated.ts` before substituting any word.

**What these can and cannot say.** The stub always corrects when the test tells it to, so this
bucket verifies the *server's* half and can say nothing about the model's. That half is the eval
bucket's (Task 13), and it is why the spec's risk register names a *missed* correction beside a
wrong one.

- [ ] **Step 1: Teach `expectGeminiJson` about corrections**

In `apps/server/tests/support/mockServer.ts`:

```ts
export async function expectGeminiJson(
  ns: string,
  opts: {
    kind: TranslationKind;
    entries: LlmEntry[];
    /** Phase 13. Without this no integration row can drive a stub that corrects. */
    correction?: { corrected_form: string; alternatives?: string[] };
    matchText?: string;
  },
): Promise<void> {
  await expectation(ns, {
    match: opts.matchText
      ? { body: { type: 'REGEX', regex: `[\\s\\S]*${opts.matchText}[\\s\\S]*` } }
      : {},
    action: {
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: JSON.stringify(
          geminiResponse({
            kind: opts.kind,
            entries: opts.entries,
            ...(opts.correction ? { correction: opts.correction } : {}),
          }),
        ),
      },
    },
  });
}
```

`geminiResponse` takes an `unknown` payload and needs no change.

- [ ] **Step 2: Write the variants characterisation test**

Create `apps/server/tests/integration/repo/dictionary.corrections.variants.test.ts`. This is the
defect's own characterisation test, inverted — and the file that makes the phase's central claim
checkable. It lives under `repo/` because what it asserts is a property of the rows, not of a
response.

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { dictCorrections, dictVariants } from '../../../src/db/schema';
import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  expectGeminiJson,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('corrections-variants');
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const translations = () =>
  createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    geminiBaseUrlFor: geminiBaseUrlFor(ns),
  }).translations;

describe('a reported misspelling never becomes a dictionary variant', () => {
  // The qualifier is not hedging. The stub always corrects, so this pins the
  // SERVER's half — "a misspelling the model REPORTS is never a dict_variants
  // row" — and says nothing about the model's half, which is the eval bucket's.
  //
  // It is also the stronger answer to the reported defect:
  // questions.prompt_variant_id references dict_variants, so a string that never
  // becomes a variant CANNOT be quizzed, and no present or future query has to
  // remember to filter it out.
  it('leaves zero dict_variants rows for the typed form after any number of lookups', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'throat',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'גרון',
              example: { source: 'She had a sore throat.', target: 'היה לה כאב גרון.' },
              sense_code: 'body_part',
            },
          ],
        },
      ],
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
    });
    const service = translations();

    await service.translate({ text: 'thruot' });
    await service.translate({ text: 'thruot' });
    await service.translate({ text: 'Thruot' });

    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'thruot')))
      .toHaveLength(0);
    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'Thruot')))
      .toHaveLength(0);
    // The correct spelling IS a variant, and there is exactly one redirect.
    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'throat')))
      .toHaveLength(1);
    expect(await t.db.select().from(dictCorrections)).toHaveLength(1);
  });
});
```

Check `createTestServerDeps`'s actual parameter name — the existing integration tests pass
`geminiBaseUrl: geminiBaseUrlFor(ns)`; use whatever that file declares, not the spelling above
if they differ.

- [ ] **Step 3: Run it and watch it fail**

Temporarily comment out the step-5b probe *and* step 9's `persistCorrection` in
`services/translations.ts`, run this file, and confirm it fails with a `thruot` variant present.
Then restore both and confirm it passes. A check that cannot fire prints nothing exactly like a
check that passes, and this is the phase's headline claim.

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npx jest --selectProjects integration tests/integration/repo/dictionary.corrections.variants.test.ts; cd -
```

- [ ] **Step 4: Write the service-level correction suite**

Create `apps/server/tests/integration/services/translations.correction.test.ts`. Its header,
`beforeEach`/`afterEach` and `translations()` helper are the ones in
`tests/integration/services/translations.test.ts` — copy them, with
`mockNamespace('translations-correction')` and `createTestServerDeps({ db: t.db, logger:
createFakeLogger(), rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) })`.

Two registration rules, both learned the hard way in phase 12 and both load-bearing here:
MockServer takes the **first matching** expectation, so every `expectReconciliation` is
registered **before** any `expectGeminiJson` whose `matchText` could also appear in a repair
body; and every `matchText` is the **quoted** form (`'"bokked"'`), which anchors on the request's
user part and cannot be tripped by the instruction's prose.

```ts
const entries = (
  lemma: string,
  partOfSpeech: PartOfSpeech,
  senses: { translation: string; sense_code: string }[],
) => [
  {
    lemma,
    part_of_speech: partOfSpeech,
    senses: senses.map((sense) => ({
      ...sense,
      example: { source: `A sentence about ${lemma}.`, target: 'משפט.' },
    })),
  },
];

describe('a corrected lookup, against a real database', () => {
  // Criterion 5. Phase 12's fail-closed rule, asserted for this table: steps 8
  // and 9 share one transaction, so a failed reconciliation call writes no
  // entries AND no redirect. A redirect can never point at a form with no rows.
  //
  // `pledge` and its forms are in neither the seed nor any other test's
  // namespace. The lexeme is given senses first so that call 2 actually fires —
  // without that the reconciliation branch is skipped and this test passes
  // vacuously.
  it('writes no redirect and no dictionary row when the reconciliation call fails', async () => {
    // An empty reconciliation is an unreadable one: `reconcile` raises
    // "reconciliation returned no usable sense" rather than falling back to
    // call 1's entry, which would write exactly the un-reconciled codes the
    // second call exists to prevent.
    await expectReconciliation(ns, { senses: [], matchText: '"pledged"' });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('pledge', 'verb', [{ translation: 'להתחייב', sense_code: 'promise' }]),
      matchText: '"pledge"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('pledge', 'verb', [{ translation: 'התחייב', sense_code: 'promise' }]),
      correction: { corrected_form: 'pledged', alternatives: [] },
      matchText: '"pledeg"',
    });
    const service = translations();
    await service.translate({ text: 'pledge' });

    await expect(service.translate({ text: 'pledeg' })).rejects.toThrow();

    expect(await t.db.select().from(dictCorrections)).toHaveLength(0);
    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'pledged')))
      .toHaveLength(0);
    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'pledeg')))
      .toHaveLength(0);
  });

  // The dangling redirect, seen to RECOVER rather than to wedge. It needs the
  // target's rows to be gone, which `dict_corrections` joining the reseed
  // TRUNCATE is what keeps rare — a reseed would otherwise produce this shape for
  // every redirect at once.
  it('falls through a redirect whose target rows are gone, then hits again', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [{ translation: 'גרון', sense_code: 'body_part' }]),
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
      matchText: '"thruot"',
    });
    const service = translations();

    await service.translate({ text: 'thruot' });
    // The dictionary is truncated under the redirect's feet. CASCADE reaches the
    // variant, the senses and the translations; the redirect survives, because
    // nothing references it.
    await t.db.delete(dictLexemes).where(eq(dictLexemes.lemma, 'throat'));

    const recovered = await service.translate({ text: 'thruot' });
    const third = await service.translate({ text: 'thruot' });

    expect(recovered.senses).toEqual(third.senses);
    // Two model calls, not three: the first lookup and the recovery. The third is
    // a redirect hit.
    expect(await countGeminiRequests(ns, '"thruot"')).toBe(2);
    expect(await t.db.select().from(dictCorrections)).toHaveLength(1);
  });

  // Criterion 23, at the level that can make it. The stub's entry order
  // DELIBERATELY differs from the stored variant's — adjective first where
  // `booked` has the verb at entry_rank 0 — which is the shape that made the
  // un-probed flow collide on dict_variants_form_entry_rank_key, answer 200 from
  // the catch, and roll the redirect back with the write.
  //
  // Seen to fail first: against the un-probed flow this fails on the request
  // count (2, not 1) AND on the missing redirect.
  it('answers a corrected miss whose target is stored with exactly one request', async () => {
    const booked = [
      ...entries('book', 'verb', [{ translation: 'הזמין', sense_code: 'make_reservation' }]),
      ...entries('book', 'adjective', [{ translation: 'מוזמן', sense_code: 'reserved' }]),
    ];
    await expectGeminiJson(ns, { kind: 'word', entries: booked, matchText: '"booked"' });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [booked[1], booked[0]], // adjective first — the colliding order
      correction: { corrected_form: 'booked', alternatives: [] },
      matchText: '"bokked"',
    });
    const service = translations();
    const direct = await service.translate({ text: 'booked' });

    const variantsBefore = await t.db.select().from(dictVariants);
    const sensesBefore = await t.db.select().from(dictSenses);
    const translationsBefore = await t.db.select().from(dictVarTranslations);

    const corrected = await service.translate({ text: 'bokked' });

    expect(await countGeminiRequests(ns, '"bokked"')).toBe(1);
    expect(await t.db.select().from(dictVariants)).toHaveLength(variantsBefore.length);
    expect(await t.db.select().from(dictSenses)).toHaveLength(sensesBefore.length);
    expect(await t.db.select().from(dictVarTranslations))
      .toHaveLength(translationsBefore.length);
    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'bokked')))
      .toHaveLength(0);
    expect(await t.db.select().from(dictCorrections)).toHaveLength(1);

    expect(corrected.kind).toEqual(direct.kind);
    expect(corrected.senses).toEqual(direct.senses);
    expect(corrected.correction).toEqual({ corrected_form: 'booked', alternatives: [] });
    expect(corrected.text).toBe('bokked');
  });

  // The other half of criterion 23, and what makes R8's fourth amendment's
  // "independent" claim a tested fact rather than an argument: the repair's
  // transaction commits inside serveForm, the redirect's commits after it, and
  // the answer is still byte-identical to a direct lookup made afterwards.
  it('answers a corrected miss whose target is STALE with exactly two requests', async () => {
    // Registered first: a repair body carries the quoted form too, so a broad
    // expectGeminiJson on '"minted"' would answer the repair with a call-1 payload.
    await expectReconciliation(ns, {
      // The `mint` lookup, reconciling against the two senses `minted` stored and
      // naming a third — which bumps the lexeme's sense_version and leaves
      // `minted` behind it.
      senses: [
        { sense_code: 'coin_money', translation: 'MINT-COIN' },
        { sense_code: 'create_new', translation: 'MINT-CREATE' },
        { sense_code: 'issue_stamp', translation: 'MINT-STAMP' },
      ],
      matchText: '"mint"',
    });
    await expectReconciliation(ns, {
      // The REPAIR of `minted`, triggered from inside the probe.
      senses: [
        { sense_code: 'coin_money', translation: 'MINTED-COIN' },
        { sense_code: 'create_new', translation: 'MINTED-CREATE' },
        { sense_code: 'issue_stamp', translation: 'MINTED-STAMP' },
      ],
      matchText: '"minted"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('mint', 'verb', [
        { translation: 'MINTED-COIN', sense_code: 'coin_money' },
        { translation: 'MINTED-CREATE', sense_code: 'create_new' },
      ]),
      matchText: '"minted"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('mint', 'verb', [{ translation: 'MINT-COIN', sense_code: 'coin_money' }]),
      matchText: '"mint"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('mint', 'verb', [{ translation: 'MINTED-COIN', sense_code: 'coin_money' }]),
      correction: { corrected_form: 'minted', alternatives: [] },
      matchText: '"mintd"',
    });
    const service = translations();
    await service.translate({ text: 'minted' });
    await service.translate({ text: 'mint' }); // teaches the lexeme a third sense

    const corrected = await service.translate({ text: 'mintd' });
    const direct = await service.translate({ text: 'minted' });

    // Call 1 for `mintd`, and the repair — whose prompt's user part is `minted`,
    // so it is not counted here.
    expect(await countGeminiRequests(ns, '"mintd"')).toBe(1);
    expect(await countGeminiRequests(ns, 'reusing its sense_code EXACTLY')).toBe(2);
    // The repair really rewrote `minted`'s renderings.
    expect(corrected.senses.map((sense) => sense.translation)).toContain('MINTED-STAMP');
    // Both writes landed, and neither wrote a variant for the typo.
    expect(await t.db.select().from(dictCorrections)).toHaveLength(1);
    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'mintd')))
      .toHaveLength(0);
    // And the corrected answer is the direct answer, to the byte.
    expect(corrected.kind).toEqual(direct.kind);
    expect(corrected.senses).toEqual(direct.senses);
  });

  // Criterion 24, against real rows. Without the hop, step 8 writes a
  // dict_variants row for `throte` — a string this very table records as not a
  // word — which then shadows `throte`'s own redirect forever by the "correct
  // spellings win" rule: this phase's central defect arriving by its own
  // machinery.
  it('writes a redirect straight to the hop target, and no variant for the intermediate typo', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [{ translation: 'גרון', sense_code: 'body_part' }]),
      matchText: '"throat"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throte', 'noun', [{ translation: 'גרון', sense_code: 'body_part' }]),
      correction: { corrected_form: 'throte', alternatives: [] },
      matchText: '"thruot"',
    });
    const service = translations();
    await service.translate({ text: 'throat' });
    await withTx(t.db, (tx) =>
      createDictRepo(tx).persistCorrection({
        languageCode: 'en',
        typedForm: 'throte',
        correctedForm: 'throat',
        alternatives: ['throaty'],
      }),
    );

    const result = await service.translate({ text: 'thruot' });

    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'throte')))
      .toHaveLength(0);
    const redirects = await t.db.select().from(dictCorrections);
    expect(redirects.map((row) => [row.typedForm, row.correctedForm]).sort()).toEqual([
      ['throte', 'throat'],
      ['thruot', 'throat'],
    ]);
    // The correction block names the hop's target, and carries the hop's own
    // alternatives. The model's entries, which described `throte`, are discarded.
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throaty'] });
  });

  // Criterion 1, at the level that can make it: after a redirect is written AND
  // the corrected form's lexeme has learned a sense, the typo lookup and the
  // direct lookup return deep-equal kind and senses. Fails against a step 3 that
  // reads the rows directly — which is the whole point of writing it.
  it('answers a typo byte-identically to the correct spelling, after the lexeme grows', async () => {
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'body_part', translation: 'THROATS-BODY' },
        { sense_code: 'narrow_passage', translation: 'THROATS-PASSAGE' },
      ],
      matchText: '"throats"',
    });
    await expectReconciliation(ns, {
      // The repair of `throat`, reached through the redirect at step 3.
      senses: [
        { sense_code: 'body_part', translation: 'THROAT-BODY' },
        { sense_code: 'narrow_passage', translation: 'THROAT-PASSAGE' },
      ],
      matchText: '"throat"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [{ translation: 'THROAT-BODY', sense_code: 'body_part' }]),
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
      matchText: '"thruot"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [
        { translation: 'THROATS-BODY', sense_code: 'body_part' },
        { translation: 'THROATS-PASSAGE', sense_code: 'narrow_passage' },
      ]),
      matchText: '"throats"',
    });
    const service = translations();
    await service.translate({ text: 'thruot' }); // writes `throat` and the redirect
    await service.translate({ text: 'throats' }); // teaches the lexeme a second sense

    const viaTypo = await service.translate({ text: 'thruot' });
    const viaWord = await service.translate({ text: 'throat' });

    expect(viaTypo.kind).toEqual(viaWord.kind);
    expect(viaTypo.senses).toEqual(viaWord.senses);
    expect(viaTypo.senses.map((sense) => sense.translation)).toContain('THROAT-PASSAGE');
    expect(viaTypo.correction).toEqual({
      corrected_form: 'throat',
      alternatives: ['throughout'],
    });
    expect(viaWord.correction).toBeUndefined();
  });
});
```

Imports this file needs: `eq` from `drizzle-orm`; `PartOfSpeech` from `@lang-tutor/core/api`;
`dictCorrections, dictLexemes, dictSenses, dictVariants, dictVarTranslations` from
`../../../src/db/schema`; `createDictRepo` from `../../../src/repo/dictionary`;
`createFakeLogger` from `../../support/fakes`; `clearNamespace, countGeminiRequests,
expectGeminiJson, expectReconciliation, geminiBaseUrlFor, mockNamespace` from
`../../support/mockServer`; `createTestServerDeps`, `createTestDb`, `testRng`, `withTx` from
their respective support modules.

**Each case must be seen to fail first.** Comment out the piece it covers, run the file, read the
failure, restore. The probe case fails on the request count and the missing redirect; the
byte-identical case fails on the senses once step 3 reads rows directly; the hop case fails with
a `throte` variant present; the fail-closed case fails with a `dict_corrections` row present.

- [ ] **Step 5: Add the wire-level row**

Append to `apps/server/tests/integration/routes/translations.test.ts`:

```ts
  it('carries the correction block to the wire, with the typed string in text', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'throat',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'גרון',
              example: { source: 'She had a sore throat.', target: 'היה לה כאב גרון.' },
              sense_code: 'body_part',
            },
          ],
        },
      ],
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
    });

    const res = await app.request('/api/translations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'thruot' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('thruot');
    expect(body.correction).toEqual({ corrected_form: 'throat', alternatives: ['throughout'] });
    expect(body.senses[0].translation).toBe('גרון');
  });
```

Match the file's existing request-building helper rather than the shape above if it has one.

- [ ] **Step 6: Run the whole integration bucket**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run test:integration
```

Expected: PASS. If the *saw sequence* in `tests/integration/services/translations.test.ts`
fails, a prompt word is capturing an expectation — go back to Task 3 Step 4.

- [ ] **Step 7: Commit**

```bash
git add apps/server/tests
git commit -m "test: pin the correction flow against a real database and a real socket

The variants test is the reported defect's characterisation test inverted: zero
dict_variants rows for a typed form the model corrected, so questionFrom can
never be built from it. The probe case drives a stub whose entry order differs
from the stored variant's, which is the shape that made the un-probed flow raise
on the entry-rank safety net and lose the redirect with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Export and restore — a sibling `corrections.jsonl`

**Files:**
- Modify: `apps/server/src/db/dictExport.ts`, `apps/server/src/db/dictImport.ts`, `apps/server/src/db/cli.ts`
- Create: `data/backfill/en-he/corrections.jsonl` (empty)
- Test: `apps/server/tests/integration/db/dictRoundTrip.test.ts`

**Interfaces:**
- Consumes: `dictCorrections` (Task 5), `persistCorrection` (Task 6).
- Produces:

```ts
export type CorrectionRecord = {
  typed_form: string;
  corrected_form: string;
  alternatives: string[];
};

export async function exportCorrections(
  db: Db,
  input: { languageCode: string },
): Promise<CorrectionRecord[]>;

export function correctionsToJsonl(records: CorrectionRecord[]): string;
export function correctionsFromJsonl(text: string): CorrectionRecord[];

export async function importCorrections(
  db: Db,
  input: { records: CorrectionRecord[]; languageCode: string },
): Promise<{ records: number }>;
```

`dictionary.jsonl` keeps its invariant — one line is one lookup, replayable through
`persistEntries` — and corrections go to a sibling file written and read by the same
`dict:export` and `dict:restore` commands. A correction is a paid model answer and would
otherwise be lost on every database reset. The file arrives **empty** and stays near-empty: the
backfill word list is correctly spelled, so corrections accumulate only from real learners.

**"Sibling" is a path derivation, not a fixed location.** `db/cli.ts` accepts an explicit path
after `--export-dict` / `--import-dict` and falls back to the repo dataset only when none is
given, so the corrections file is `join(dirname(<the dictionary path actually used>),
'corrections.jsonl')`. Hard-coding the default's directory would write a developer's ad-hoc
export back into the repo's dataset folder.

- [ ] **Step 1: Write the failing round-trip tests**

Append to `apps/server/tests/integration/db/dictRoundTrip.test.ts`:

```ts
describe('corrections.jsonl', () => {
  const write = (t: TestDb, input: { typedForm: string; correctedForm: string; alternatives: string[] }) =>
    withTx(t.db, (tx) => createDictRepo(tx).persistCorrection({ languageCode: 'en', ...input }));

  it('round-trips a redirect, and the restored row serves the same answer', async () => {
    await write(source, {
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['throughout'],
    });

    const records = await exportCorrections(source.db, { languageCode: 'en' });
    expect(records).toEqual([
      { typed_form: 'thruot', corrected_form: 'throat', alternatives: ['throughout'] },
    ]);

    const result = await importCorrections(target.db, { records, languageCode: 'en' });
    expect(result.records).toBe(1);
    expect(
      await withTx(target.db, (tx) =>
        createDictRepo(tx).findCorrectionByForm({ languageCode: 'en', form: 'Thruot' }),
      ),
    ).toEqual({ typedForm: 'thruot', correctedForm: 'throat', alternatives: ['throughout'] });
  });

  it('survives the JSONL encoding it is stored as', async () => {
    await write(source, { typedForm: 'שולחם', correctedForm: 'שולחן', alternatives: [] });

    const records = await exportCorrections(source.db, { languageCode: 'en' });
    expect(correctionsFromJsonl(correctionsToJsonl(records))).toEqual(records);
  });

  // The guarantee dictImport already provides for the dictionary, extended to
  // this table: replaying a file onto a database that already holds part of it
  // keeps the live content and raises nothing. persistCorrection being
  // ON CONFLICT DO NOTHING is what makes it true, and a redirect that raised on a
  // re-restore would make dict:restore non-idempotent for the first time since
  // phase 11.
  it('is idempotent: a re-restore keeps the live target and raises nothing', async () => {
    await write(target, { typedForm: 'thruot', correctedForm: 'throat', alternatives: [] });

    await importCorrections(target.db, {
      languageCode: 'en',
      records: [{ typed_form: 'Thruot', corrected_form: 'throughout', alternatives: [] }],
    });

    expect(
      (
        await withTx(target.db, (tx) =>
          createDictRepo(tx).findCorrectionByForm({ languageCode: 'en', form: 'thruot' }),
        )
      )?.correctedForm,
    ).toBe('throat');
  });

  // The file is genuinely optional, and it is empty on arrival — so a restore
  // that cannot find it restores the dictionary and reports zero corrections
  // rather than failing.
  it('restores zero corrections from an empty or absent file', async () => {
    expect(correctionsFromJsonl('')).toEqual([]);
    expect(await importCorrections(target.db, { records: [], languageCode: 'en' }))
      .toEqual({ records: 0 });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd apps/server && npx jest --selectProjects integration tests/integration/db/dictRoundTrip.test.ts; cd -
```

Expected: FAIL — `exportCorrections is not a function`.

- [ ] **Step 3: Add the export side**

In `apps/server/src/db/dictExport.ts`, beside `DictRecord` and its helpers:

```ts
/**
 * One exported line is one redirect. snake_case keys, matching `DictRecord`'s
 * own and the shape the repository is handed back on restore.
 *
 * A separate file from `dictionary.jsonl` rather than a section inside it,
 * because that file's invariant is "one line is one lookup, replayable through
 * persistEntries" — and a redirect is replayed through a different function.
 */
export type CorrectionRecord = {
  typed_form: string;
  corrected_form: string;
  alternatives: string[];
};

export async function exportCorrections(
  db: Db,
  input: { languageCode: string },
): Promise<CorrectionRecord[]> {
  const rows = await db
    .select({
      typedForm: dictCorrections.typedForm,
      correctedForm: dictCorrections.correctedForm,
      alternatives: dictCorrections.alternatives,
    })
    .from(dictCorrections)
    .where(eq(dictCorrections.languageCode, input.languageCode));

  const records = rows.map((row) => ({
    typed_form: row.typedForm,
    corrected_form: row.correctedForm,
    alternatives: row.alternatives,
  }));
  // Sorted in JS by UTF-16 code unit, not by SQL ORDER BY, for the reason
  // groupRows gives: Postgres' text ordering depends on the database's collation,
  // so the same data could export in a different order on another machine and
  // show up as a whole-file diff.
  records.sort((a, b) =>
    a.typed_form < b.typed_form ? -1 : a.typed_form > b.typed_form ? 1 : 0,
  );
  return records;
}

export function correctionsToJsonl(records: CorrectionRecord[]): string {
  if (records.length === 0) return '';
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

export function correctionsFromJsonl(text: string): CorrectionRecord[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return trimmed.split('\n').map((line) => JSON.parse(line) as CorrectionRecord);
}
```

Add `dictCorrections` to the `./schema` import.

- [ ] **Step 4: Add the import side**

In `apps/server/src/db/dictImport.ts`:

```ts
/**
 * Replays exported redirects through `persistCorrection` — the same repository
 * function a live lookup calls — so a restored row and a looked-up one are
 * indistinguishable, the guarantee `importDictionary` already provides for the
 * dictionary.
 *
 * **Not chunked**, unlike `importDictionary`. That one is chunked because the
 * backfill is ~89k records; this file arrives empty and stays near-empty, since
 * the backfill word list is correctly spelled and corrections accumulate only
 * from real learners. One transaction is the simpler shape while that is true.
 *
 * Safe against a database that already holds part of the file:
 * `persistCorrection` is ON CONFLICT DO NOTHING, so a redirect already written
 * keeps the target it has.
 */
export async function importCorrections(
  db: Db,
  input: { records: CorrectionRecord[]; languageCode: string },
): Promise<{ records: number }> {
  if (input.records.length === 0) return { records: 0 };

  const inTransaction = createTransaction(db, (tx) => tx);
  await inTransaction(async (tx) => {
    const dict = createDictRepo(tx);
    for (const record of input.records) {
      await dict.persistCorrection({
        languageCode: input.languageCode,
        typedForm: record.typed_form,
        correctedForm: record.corrected_form,
        alternatives: record.alternatives,
      });
    }
  });

  return { records: input.records.length };
}
```

Add `CorrectionRecord` to the `./dictExport` type import.

- [ ] **Step 5: Wire both into the CLI**

In `apps/server/src/db/cli.ts`, add the derivation helper next to `pathAfter`:

```ts
/** The corrections file sits beside whichever dictionary path was actually used,
 *  never beside the default's: `--export-dict /tmp/mine.jsonl` must not write a
 *  developer's ad-hoc export back into the repo's dataset folder. */
function correctionsPathFor(dictionaryPath: string): string {
  return join(dirname(dictionaryPath), 'corrections.jsonl');
}
```

In the export branch, after the dictionary is written:

```ts
      const corrections = await exportCorrections(db, { languageCode: TARGET_LANGUAGE });
      const correctionsPath = correctionsPathFor(exportTo);
      writeFileSync(correctionsPath, correctionsToJsonl(corrections));
      console.log(`exported ${corrections.length} corrections`);
      console.log(`written to ${correctionsPath}`);
```

In the import branch, after `importDictionary` returns:

```ts
      // A restore whose sibling file is absent restores the dictionary and reports
      // zero corrections rather than failing: the file is genuinely optional, and
      // it is empty on arrival.
      const correctionsPath = correctionsPathFor(importFrom);
      const correctionRecords = existsSync(correctionsPath)
        ? correctionsFromJsonl(readFileSync(correctionsPath, 'utf8'))
        : [];
      const restored = await importCorrections(db, {
        records: correctionRecords,
        languageCode: TARGET_LANGUAGE,
      });
      console.log(
        `restored ${restored.records} corrections from ${correctionsPath} ` +
          '(persistCorrection is first-writer-wins, so nothing was re-pointed).',
      );
```

Add `existsSync` to the `node:fs` import and the four new names to the `./dictExport` /
`./dictImport` imports.

- [ ] **Step 6: Create the empty dataset file**

```bash
cd /Users/vperepelitsky/git/vic-prp/lang-tutor-init
: > data/backfill/en-he/corrections.jsonl
git add -f data/backfill/en-he/corrections.jsonl
```

Check `.gitignore` does not exclude `data/backfill/` — `git status --short data/backfill` should
show the file staged. If the directory is ignored, add an explicit negation rather than dropping
the `-f`, so the file is tracked the way `dictionary.jsonl` is.

- [ ] **Step 7: Run the integration bucket and exercise the CLI by hand**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck && npm run test:integration
# Against the running dev database, into a scratch directory — never the repo dataset.
npm run dict:export -- /tmp/claude-scratch/dict.jsonl
ls -l /tmp/claude-scratch/corrections.jsonl
npm run dict:restore -- /tmp/claude-scratch/dict.jsonl
```

Expected: the export writes both files side by side, and the restore reports a correction count
and raises nothing. Run the restore **twice** — the second run must report the same count and
still raise nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/db apps/server/tests/integration/db/dictRoundTrip.test.ts \
  data/backfill/en-he/corrections.jsonl
git commit -m "feat: export and restore corrections as a sibling jsonl

A correction is a paid model answer and would otherwise be lost on every
database reset. Replayed through persistCorrection - the same function a live
lookup calls - so a restored row and a looked-up row are indistinguishable, and
a re-restore raises nothing. The path is derived from the dictionary path
actually used, so an ad-hoc export does not write back into the repo dataset.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Mobile — the banner, the chips, the `submit` override, and the e2e flow

**Files:**
- Modify: `apps/mobile/src/strings.ts`, `apps/mobile/src/hooks/useTranslation.tsx`, `apps/mobile/src/app/translate.tsx`, `e2e/tests/support/mockServer.ts`, `e2e/tests/translate.spec.ts`

**Interfaces:**
- Consumes: `TranslationResponse.correction` (Task 2); the server behaviour from Tasks 8–10.
- Produces: `TranslationValue.submit: (override?: string) => void`; `expectGemini(request, payload, opts?)` where `payload` gains an optional `correction` and `opts` is `{ once?: boolean }`.

**`submit` has to grow an optional override, and that is the one contract change on this side.**
Today it is `submit: () => void run(text, undefined)`, closing over the provider's `text` state —
so `setText(alt)` followed by `submit()` would re-run the **typed** string: the closure captured
the old value and the state update has not landed. That is a change to `TranslationValue`, a
context type the composition root and the hook's own tests both touch, which is why this phase's
mobile work is not only presentational.

**And it breaks the two existing call sites, which is the rest of that change rather than a
detail.** `translate.tsx` passes the handler bare in two places — `onPress={t.submit}` on the
submit button and on the retry link — and a bare `onPress` handler is called with the press
event. Once `submit` takes a `string`, `apps/mobile/tsconfig.json`'s `"strict": true` turns that
into a **compile error** (`strictFunctionTypes` checks the parameter contravariantly, and a
`GestureResponderEvent` is not a `string`), so `npm run typecheck` fails rather than anything
subtle happening. Loosening the signature to get past it makes the failure the subtle one
instead: the event object arrives as `override`, and `run(event)` throws on `query.trim()` inside
an unawaited promise, leaving the screen on its previous state with nothing logged. Both sites
become `onPress={() => t.submit()}`. `onSubmitEditing` already wraps its call and is unaffected.

**ADR 0002 R5 is not engaged, and this was checked rather than assumed.** Its detection command
greps a closed list of collaborator names — `rng`, `onError`, `randomUUID`, `logger`, `storage`,
`fetch` — followed by `?:`. `override?: string` is a **query**, not a dependency, and matches
none of them.

- [ ] **Step 1: Add the two strings**

In `apps/mobile/src/strings.ts`, beside the other `translate*` entries:

```ts
  // U+2068 FSI and U+2069 PDI around each form. In the en_he direction this
  // banner embeds a Latin word inside a Hebrew RTL sentence, and without an
  // isolate the bidi algorithm reorders it against the wrong clause. The he_en
  // direction has no such problem, and one rule for both is cheaper than a
  // conditional.
  translateCorrectionNotice: (typed: string, corrected: string) =>
    `לא מצאנו את ⁨${typed}⁩ — מציגים תוצאות עבור ⁨${corrected}⁩`,
  translateDidYouMean: 'האם התכוונת ל:',
```

- [ ] **Step 2: Give `submit` an override**

In `apps/mobile/src/hooks/useTranslation.tsx`:

```ts
export type TranslationValue = {
  /* ...unchanged... */
  /**
   * `override` exists for the correction banner's alternative chips. `submit()`
   * closes over the provider's `text` state, so `setText(alt)` followed by a bare
   * `submit()` would re-run the TYPED string: the closure captured the old value
   * and the state update has not landed yet. The handler calls both, so the input
   * field agrees with the results it is showing.
   */
  submit: (override?: string) => void;
  /* ... */
};
```

and in the memoized value:

```ts
      submit: (override?: string) => void run(override ?? text, undefined),
```

- [ ] **Step 3: Fix the two broken call sites and add the banner**

In `apps/mobile/src/app/translate.tsx`, change `onPress={t.submit}` to `onPress={() => t.submit()}`
on **both** the submit `Pressable` and the `translate-retry` `Pressable`.

Then, inside the `t.status === 'answered' && t.result ?` branch, directly **above** the
`visible.map(...)` sense cards and below the direction row:

```tsx
          {/* Inside the `answered` branch, which makes one promise structural
              rather than a hope: `status` is `empty` whenever `senses` is empty,
              so an empty answer cannot render a banner even if one reached the
              wire. `zxqwbtl` still shows translateEmpty. */}
          {t.result.correction ? (
            <View testID="translate-correction" style={styles.correction}>
              <Text style={styles.correctionText}>
                {strings.translateCorrectionNotice(
                  t.result.text,
                  t.result.correction.corrected_form,
                )}
              </Text>

              {t.result.correction.alternatives.length > 0 ? (
                <View style={styles.alternatives}>
                  <Text style={styles.correctionText}>{strings.translateDidYouMean}</Text>
                  {t.result.correction.alternatives.map((alternative, index) => (
                    <Pressable
                      key={alternative}
                      accessibilityRole="button"
                      testID={`translate-alternative-${index}`}
                      // Both, and in this order: setText so the field agrees with
                      // the results, and the override so the request does not use
                      // the state value this render still holds.
                      onPress={() => {
                        t.setText(alternative);
                        t.submit(alternative);
                      }}
                      style={styles.alternativeChip}
                    >
                      <Text style={styles.alternativeLabel}>{alternative}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
```

Nothing has to be added for the chips' own validation: `run` returns early on a trimmed length
of 0 or over 100, and `corrected_form` and every alternative are capped at 100 by
`TranslationCorrectionSchema`, so a chip can never submit a string the typed field would have
rejected.

Add the four styles beside the existing ones, following the screen's conventions — the
Hebrew-bearing text style pins `writingDirection: 'rtl'` the way `noticeText` and `title` do; the
input field deliberately pins nothing, and the banner is fixed Hebrew chrome with a Latin form
embedded in it, so it follows the styles rather than the field:

```ts
  correction: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  correctionText: { color: colors.text, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  alternatives: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  alternativeChip: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  alternativeLabel: { color: colors.primary, fontSize: fontSizes.sm, fontWeight: '700' },
```

The banner does **not** change the `more` / reveal behaviour, the chosen-sense behaviour, or the
empty state.

- [ ] **Step 4: Typecheck, which is where the two call sites announce themselves**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck
```

Expected: PASS. If you see `Type '(event: GestureResponderEvent) => void' is not assignable`,
Step 3's first paragraph was not applied — fix the call site, never the signature.

- [ ] **Step 5: Teach the e2e helper two different answers in one test**

`e2e/tests/support/mockServer.ts`'s `expectGemini` registers an expectation with **no** request
matching at all, so every Gemini call in a test gets the same payload; each existing test
registers exactly one. Tapping an alternative makes a second, *different* call.

One-shot expectations rather than body matching: they need no knowledge of what is inside the
body, which is exactly the coupling that has cost this repo twice.

```ts
export async function expectGemini(
  request: APIRequestContext,
  payload: {
    kind: 'word' | 'phrase' | 'sentence';
    entries: unknown[];
    /** Phase 13. Absent on every existing call site. */
    correction?: { corrected_form: string; alternatives?: string[] };
  },
  /**
   * `once` makes this a ONE-SHOT expectation, consumed in registration order.
   * The correction flow needs two different answers in one test, and MockServer
   * consumes one-shots in the order they were registered — so the count has to
   * match the calls exactly. Opt-in rather than the default, so the existing
   * specs (one expectation, one or more calls) are untouched.
   */
  opts: { once?: boolean } = {},
): Promise<void> {
  const res = await request.put(`${MOCKSERVER_URL}/mockserver/expectation`, {
    data: {
      httpRequest: { method: 'POST', path },
      httpResponse: {
        statusCode: 200,
        headers: { 'content-type': ['application/json'] },
        body: envelope(payload),
      },
      ...(opts.once ? { times: { remainingTimes: 1, unlimited: false } } : {}),
    },
  });
  if (!res.ok()) throw new Error(`MockServer expectation failed: ${res.status()}`);
}
```

- [ ] **Step 6: Write the e2e flow**

This is the **only** coverage of the mobile change — `apps/mobile` has three unit tests and none
of them touch the screen or the hook — so the `submit` override is verified here or nowhere.

Append to `e2e/tests/translate.spec.ts`:

```ts
// Two one-shot expectations, and the count has to match the calls exactly.
// `thruot` makes ONE call because its corrected form `throat` is a lexeme nobody
// has stored, so phase 12's reconciliation never fires; tapping `throughout`
// makes one for the same reason. Both hold because neither word is among the
// thirteen strings in content.generated.ts and globalSetup drops and rebuilds
// lang_tutor_e2e every run — so the flow starts from the seed and nothing else.
//
// CHOOSE ANY REPLACEMENT WORD THE SAME WAY: a corrected form whose lexeme the
// seed already holds would make a second call and silently consume the
// expectation meant for the tap.
test('a misspelling shows the correction, and an alternative can be tapped', async ({
  page,
  request,
}) => {
  await expectGemini(
    request,
    {
      kind: 'word',
      entries: [
        {
          lemma: 'throat',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'גרון',
              example: { source: 'She had a sore throat.', target: 'היה לה כאב גרון.' },
              sense_code: 'body_part',
            },
          ],
        },
      ],
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
    },
    { once: true },
  );
  await expectGemini(
    request,
    {
      kind: 'word',
      entries: [
        {
          lemma: 'throughout',
          part_of_speech: 'preposition',
          senses: [
            {
              translation: 'בכל רחבי',
              example: { source: 'It rained throughout the day.', target: 'ירד גשם כל היום.' },
              sense_code: 'all_through',
            },
          ],
        },
      ],
    },
    { once: true },
  );
  await openTranslate(page, request, 'e2e_translate_correction');

  await page.getByTestId('translate-input').fill('thruot');
  await page.getByTestId('translate-submit').click();

  // The banner names both forms, and the answer is the corrected form's.
  const banner = page.getByTestId('translate-correction');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('thruot');
  await expect(banner).toContainText('throat');
  await expect(sense(page, 'גרון')).toBeVisible();

  // Tapping the chip is an ordinary lookup of that text — a FULL miss, so it
  // shows the loading skeleton for as long as any other new word does.
  await page.getByTestId('translate-alternative-0').click();
  await expect(sense(page, 'בכל רחבי')).toBeVisible();
  // And nothing is written for an alternative, so it carries no banner of its own.
  await expect(page.getByTestId('translate-correction')).toHaveCount(0);
  // The field agrees with the results it is showing — the setText half of the
  // handler, which is the half a bare submit() would have left stale.
  await expect(page.getByTestId('translate-input')).toHaveValue('throughout');
});
```

- [ ] **Step 7: Run the e2e suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run e2e
```

Expected: PASS, including the four existing translate specs — which is what confirms the
`{ once: true }` option changed nothing for them.

If the tap's assertion sees `גרון` instead of `בכל רחבי`, the second expectation was not
consumed in the order assumed: check that the first is registered `{ once: true }` too, since a
non-one-shot first expectation answers every call forever.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile e2e
git commit -m "feat: show the correction banner and let a learner tap an alternative

submit grows an optional override because it closes over the provider's text
state: setText(alt) followed by a bare submit() would re-run the typed string,
since the state update has not landed. That breaks the two bare onPress={t.submit}
call sites at compile time, which is the good failure - loosening the signature
would instead pass a GestureResponderEvent into run() and throw inside an
unawaited promise. The forms are bidi-isolated: the banner embeds a Latin word
in a Hebrew RTL sentence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Evals — `askModel` through `resolveCorrection`, and the cases

**Files:**
- Modify: `apps/server/tests/eval/askModel.ts`, `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/run.ts`

**Interfaces:**
- Consumes: `resolveCorrection` (Task 4); `normalizeForm` from `domain/dictionary`.
- Produces: `ModelAnswer` gains `correction?: TranslationCorrection`; `EvalCase` gains `expectCorrection?: string`, `expectAlternative?: string`, `expectNoCorrection?: true`.

**This bucket is the only place the feature's central claim is measured.** Every other test in
this phase drives a stub that reports whatever the test wants; only these cases ask a real model
whether `thruot` is a misspelling and whether `booked` is not. A regression here is the whole
feature regressing, not one assertion.

**It needs `GEMINI_API_KEY` and `GEMINI_MODEL`, refuses to run against MockServer, and is in
neither `npm test` nor `npm run test:all`.** Per the repo's standing rule, a `test-eval` failure
on these cases is read against the run's `eval-report` artifact before the diff is blamed — a
model update alone can move them — and a tier 2 drop is **never** answered by lowering
`TIER2_THRESHOLD`.

- [ ] **Step 1: Put `askModel` through `resolveCorrection`**

`askModel` computes `kind` as `resolveKind(text, parsed.kind)` on the **typed** text, so
`breakaleg` clamps to `'word'` before any prompt rule can be scored and `expectKind: 'phrase'`
would fail whatever the model answered. It calls `resolveCorrection` instead — the same pure
function the service calls at step 4, guards and all — which is what its own docstring already
promises: *"everything `services/translations.ts` does to an answer except touch a database"*.
One function with two callers rather than three lines copied into the harness; a copy is exactly
what would let this bucket score a `kind` the service never writes.

```ts
export type ModelAnswer = {
  direction: TranslationDirection;
  kind: TranslationKind;
  entries: LlmEntry[];
  senses: TranslationSense[];
  /** Phase 13. Exposed alongside `entries`, which the wire flattens away, and for
   *  the same reason: it is what the correction cases score. */
  correction?: TranslationCorrection;
};

export async function askModel(
  llm: LlmClient,
  input: { text: string; direction?: TranslationDirection },
): Promise<ModelAnswer> {
  const text = input.text.trim();
  const direction = input.direction ?? detectDirection(text);

  const raw = await llm(buildPrompt({ text, direction }));
  if (raw === '') return { direction, kind: resolveKind(text, 'word'), entries: [], senses: [] };

  const parsed = parseLlmTranslation(raw);
  if (!parsed) throw new Error('the model response did not match the expected shape');

  // The service's step 4, verbatim. `kind` comes out of here computed against the
  // EFFECTIVE form, so it is the kind the server would actually have written onto
  // dict_variants — which is the only version of it worth scoring.
  const resolved = resolveCorrection(parsed, { typedForm: normalizeForm(text), direction });
  if (!resolved) throw new Error('the correction named a form in the other script');
  const { correction, kind } = resolved;

  const entries = mergeEntries(parsed.entries);
  return {
    direction,
    kind,
    entries,
    senses: normalizeSenses(kind, flattenEntries(entries)),
    ...(correction ? { correction } : {}),
  };
}
```

Import `resolveCorrection` from `../../src/domain/translation`, `normalizeForm` from
`../../src/domain/dictionary`, and `TranslationCorrection` from `@lang-tutor/core/api`.

- [ ] **Step 2: Add the three case fields**

In `apps/server/tests/eval/cases.ts`, on `EvalCase`:

```ts
  /** Phase 13. The corrected_form the model must report, matched
   *  case-insensitively. */
  expectCorrection?: string;
  /** Must appear somewhere in `correction.alternatives`. */
  expectAlternative?: string;
  /** No correction at all. The inflection trap, and the most important assertion
   *  in the set: `lemma ≠ typed form` is true of an inflection AND of a typo, so
   *  a model that starts "correcting" real forms writes permanent redirects away
   *  from correctly spelled words. */
  expectNoCorrection?: true;
```

- [ ] **Step 3: Score them in `tier2`**

In `apps/server/tests/eval/run.ts`'s `tier2`, **above** the `if (kase.expectEmpty) return checks;`
line — `asdkjhasd` is an `expectEmpty` case and must still be scored for the absence of a
correction, which is what separates "near nothing" from "near a word":

```ts
  if (kase.expectNoCorrection) {
    checks.push({
      name: 'reports no correction',
      ok: !result.correction,
      detail: result.correction?.corrected_form ?? 'none',
    });
  }

  if (kase.expectCorrection) {
    checks.push({
      name: `corrects to ${kase.expectCorrection}`,
      ok:
        result.correction?.corrected_form.toLowerCase() === kase.expectCorrection.toLowerCase(),
      detail: result.correction?.corrected_form ?? 'none',
    });
  }

  if (kase.expectAlternative) {
    checks.push({
      name: `offers ${kase.expectAlternative} as an alternative`,
      ok: (result.correction?.alternatives ?? []).some(
        (alternative) => alternative.toLowerCase() === kase.expectAlternative!.toLowerCase(),
      ),
      detail: (result.correction?.alternatives ?? []).join(', ') || 'none',
    });
  }
```

Check the scorecard printer prints `row.result.correction` — if it prints fields individually
rather than the whole answer, add the corrected form and the alternatives beside the entries, so
a failing run says *what* the model corrected to rather than only that it was wrong.

- [ ] **Step 4: Add the assertions to the three existing inflection cases**

`running`, `booked` and `saw` are already in `CASES` — `running` and `saw` since phase 10,
`booked` added by phase 12 — so this is an **added assertion on existing calls**, not three new
ones. Add `expectNoCorrection: true` to each, with:

```ts
    // Phase 13. The inflection trap. A model that calls `booked` a misspelling of
    // `book` writes a redirect that never expires — partially self-limiting, since
    // the redirect is consulted only AFTER the by-form read misses, so once
    // `booked` is legitimately written the bad row is shadowed and inert. It bites
    // for a form never looked up correctly first. These three are the cases to
    // watch when a model version changes.
```

Add the same field to the existing `asdkjhasd` case, with:

```ts
    // Near NOTHING, as against near a word: the empty-entries answer and no
    // correction. Its `kind` must also be `word` — a correction dropped for empty
    // entries has changed nothing about the answer (criterion 7).
```

- [ ] **Step 5: Add the six new cases**

Append to `CASES`:

```ts
  // Phase 13. The reported defect itself, measured against the real model: the
  // model already reads `thruot` as `throat` and says so in `lemma`; what this
  // scores is that it now says so in `correction` instead of silently.
  {
    label: 'a misspelling one edit from a real word',
    text: 'thruot',
    expectKind: 'word',
    acceptTop: ['גרון'],
    expectCorrection: 'throat',
    // `thruot` is as close to `throughout` as to `throat`, and nothing asked the
    // model to enumerate corrections before this phase — it committed to one.
    expectAlternative: 'throughout',
  },
  {
    label: 'the classic transposition',
    text: 'recieve',
    expectKind: 'word',
    acceptTop: ['לקבל'],
    expectCorrection: 'receive',
  },
  // A phrase, not a word: scope is words and phrases, both directions.
  {
    label: 'a misspelled word inside a fixed expression',
    text: 'brake a leg',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה'],
    rejectAny: ['לשבור רגל'],
    expectCorrection: 'break a leg',
  },
  // The fourth prompt rule, and the ONLY case in the set where a SINGLE TOKEN
  // must be classified as a phrase. `brake a leg` above cannot score it: what was
  // typed already contains whitespace, so the model answers `phrase` with or
  // without the rule. This is the case where a model classifying the input as
  // typed answers `word`, the server's resolveKind DEFERS to it because the
  // corrected form has whitespace, and `kind: 'word'` is written onto the variant
  // `break a leg` permanently. It is also the case that forces the askModel
  // change: scored against the typed text it clamps to `word` and can never pass.
  {
    label: 'a single token corrected to a phrase',
    text: 'breakaleg',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה'],
    expectCorrection: 'break a leg',
  },
  // The Latin-script counterpart of ktiv male: a real word in one standard of
  // English that a model may "correct" to the American form, writing a permanent
  // redirect away from a correct spelling. Phase 12 met this shape with
  // `burnt`/`burned` and pinned a lemma rule for it; here the rule is the first
  // one — a correctly spelled form is not a misspelling — and this is the case
  // that scores its spelling-variant half.
  {
    label: 'a real spelling variant is not a misspelling',
    text: 'colour',
    expectKind: 'word',
    acceptTop: ['צבע'],
    expectNoCorrection: true,
  },
  // Symmetry across directions, and the Hebrew-side risk with no clean answer:
  // ktiv male against ktiv haser and optional nikud mean many valid Hebrew
  // spellings differ from each other, and normalizeForm deliberately strips
  // neither — so the model may report a VALID alternative spelling as a
  // misspelling and write a permanent redirect away from it. This single line
  // matters more than its length suggests.
  {
    label: 'a Hebrew misspelling, for symmetry across directions',
    text: 'שולחם',
    direction: 'he_en',
    expectKind: 'word',
    acceptTop: ['table'],
    expectCorrection: 'שולחן',
  },
```

Before running, re-check each new string against `src/db/content.generated.ts` — a seeded string
is fine here (this bucket has no database) but a **prompt** word is not, and none of these
appears in `buildPrompt`.

- [ ] **Step 6: Typecheck, then run the eval bucket once**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
npm run typecheck
GEMINI_API_KEY=... GEMINI_MODEL=... npm run eval
```

Expected: tier 1 at zero failures, tier 2 at or above `TIER2_THRESHOLD` (0.85). Read the
scorecard, not just the exit code.

**Sample several words and several runs before drawing a conclusion about the prompt.** A single
run of a single case says nothing about whether a rule works — if a correction case fails, run
the bucket two or three more times and look at whether it fails consistently or intermittently
before changing any wording. And if tier 2 drops, the answer is a prompt change or a recorded
finding, **never** a lower `TIER2_THRESHOLD`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/tests/eval
git commit -m "test: score the correction against the real model

askModel goes through resolveCorrection rather than resolveKind, so the kind it
scores is the one the server would have written - without it `breakaleg` clamps
to 'word' on the typed text and expectKind: 'phrase' could never pass whatever
the model answered. Six new cases plus four added no-correction assertions on
existing calls: the inflection trap is the most important of them, because a
model that starts correcting real forms writes permanent redirects away from
correctly spelled words.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Final verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Every bucket, in order**

```bash
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:/opt/homebrew/bin:$PATH"
cd /Users/vperepelitsky/git/vic-prp/lang-tutor-init
npm run typecheck
npm run test:all
npm run e2e
npm run lint:arch
```

Expected: all four green, with `lint:arch` reporting
`Architecture check passed: 17 rules, no violations.` — criteria 21 and 22.

`typecheck` is named explicitly in criterion 21 because the `submit` signature change breaks two
call sites that **no test executes**.

- [ ] **Step 2: Confirm the buckets stayed offline**

`npm run test:all` must make no network call and need no API key (ADR 0004 R4). Confirm by
running it with no `GEMINI_API_KEY` in the environment — MockServer and Postgres are local and
are not "the network" in this sense, but a real provider call would fail loudly without a key.

```bash
env -u GEMINI_API_KEY npm run test:all
```

- [ ] **Step 3: Confirm the label sweep held**

```bash
git grep -n -E 'phase 13|Phase 13' -- 'apps/server/src/**/*.ts' 'apps/server/tests/**/*.ts' \
  | grep -vE 'Phase 13[.,]? (rule|F)?' | head
```

Every remaining hit must be a comment this phase wrote about *itself* — the prompt rules, the
schemas, the table, `serveForm`, the probe. There must be none that describes phase 12's
follow-ups. Criterion 25.

- [ ] **Step 4: Walk the success criteria**

Read the spec's *Success criteria* list against the table at the end of this plan and tick each
one off against the test that proves it. Any criterion with no test is a gap to close now, not
a note to file.

- [ ] **Step 5: Report, honestly**

Say which buckets ran and what they reported. If `npm run eval` was not run because no API key
was available, say so explicitly rather than implying it passed — it is the only bucket that
measures the model's half, and its absence is the phase's largest remaining unknown.

Do **not** run the vocabulary backfill or any other paid bulk job. Hand the operation to the
user.

---

## Verification summary

Criterion numbers match the spec's *Success criteria* list.

| Success criterion (spec) | Task | How it is proved |
|---|---|---|
| 1. `thruot` is byte-identical to `throat`, before and after the lexeme grows | 7, 8, 11 | `serveForm` is one function called three times; `translations.correction.test.ts` byte-identical case, seen to fail against a direct row read |
| 2. A second `thruot` makes no call, or exactly one if the target is stale | 8, 11 | Redirect-hit unit test (`llm.calls` is 0); the repair-through-redirect unit and integration cases |
| 3. **Zero** `dict_variants` rows for `thruot` after any number of corrected lookups | 9, 11 | `repo/dictionary.corrections.variants.test.ts`, seen to fail first |
| 4. `bokked` hands `booked` to `buildRenderingPrompt` and `persistEntries`; neither when the target has rows | 9, 10 | `llm.calls[1].user === 'booked'`; the probe's `dict.persisted` assertions |
| 5. A failing reconciliation leaves no lexeme, variant, translation **or** redirect | 9, 11 | Steps 8 and 9 in one transaction; unit + integration fail-closed cases |
| 6. `running`, `booked`, `saw`, `colour` return no correction, against the real model | 14 | `expectNoCorrection` on four eval cases |
| 7. `asdkjhasd` keeps the empty state and `kind: 'word'` | 4, 9, 14 | The ordering-trap unit test; the service's empty-entries test; the eval case |
| 8. All four guards fire before any read or second call | 4, 9 | `resolveCorrection` unit tests, incl. `'???'`; the service's script-guard test |
| 9. Nothing un-normalized or over 100 characters is **storable** | 2, 4, 5 | `Throat.` → `Throat`; the schema caps; the three `CHECK`s against raw SQL |
| 10. Truncation, dedupe and absent/null alternatives all reach the wire as a 200 | 2, 4, 6 | The 502-trap parser tests; `tidyAlternatives`; `persistCorrection`'s own tidy |
| 11. `toGeminiSchema` emits no `default` key | 2 | `providers/gemini.test.ts`, at any depth |
| 12. `breakaleg` → `break a leg` **and** `kind: 'phrase'`, against the real model | 3, 4, 14 | The fourth prompt rule; the `resolveKind`-defers unit test; the `breakaleg` eval case |
| 13. A reseed leaves zero `dict_corrections` rows | 5 | `db/reseed.test.ts`, seen to fail first against the un-named table |
| 14. A redirect is never used to rewrite a form the model declined to correct | 9 | The "answers the model on its own terms" unit test |
| 15. Tapping `throughout` returns its own translation and writes no redirect | 13 | The e2e correction flow |
| 16. A correctly spelled form with a redirect row resolves to itself | 8 | The "never consults a redirect" unit test |
| 17. A second `persistCorrection` raises nothing and keeps the first target | 6, 12 | The repo no-op test; the restore idempotency test |
| 18. Neither `saw` nor `see` in the instruction, **and** the integration bucket green | 3 | The prompt-word lock plus `npm run test:integration` |
| 19. The OpenAPI document gains exactly one optional property | 2 | `src/openapi.test.ts` |
| 20. `corrections.jsonl` round-trips; a restore with no sibling file succeeds | 12 | `db/dictRoundTrip.test.ts` |
| 21. `typecheck`, `test:all` and `e2e` green with no network and no key | 13, 15 | Final verification, with `typecheck` catching the two `submit` call sites |
| 22. `lint:arch` passes and still reports seventeen ADR 0001 checks | 1, 4, 6, 10, 15 | Run in five tasks |
| 23. A correction whose target has rows: one call, no dictionary write, deep-equal answer | 10, 11 | The probe unit tests; the integration probe case with a differing entry order |
| 24. A correction whose target is itself a typo: one hop, or fail closed | 10, 11 | The hop unit tests; the integration chain case |
| 25. The ten phase-12 follow-up comments are relabelled first | 1, 15 | The grep in Task 1 and the sweep in Task 15 |

## What this plan does not do

Recorded so a reviewer does not go looking for it. Each is out of scope **by decision**, and the
spec argues each one:

- **No independent misspelling detection.** No edit distance, no dictionary probe, no string
  comparison. An answer with entries and no `correction` writes a variant for the typed string,
  exactly as today — the reported defect, narrowed to the cases the model reports rather than
  closed structurally.
- **No typos inside sentences**, no per-learner mistake history, no re-pointing or TTL on a
  redirect, no prefetching of the alternatives, and no third language.
- **No new ADR.** *"A misspelling the model reports is never a `dict_variants` row"* is a durable
  structural invariant and `docs/adr/` is where this repo records those, but every existing ADR
  pairs its rule with a grep-able detection command and this is a data-model fact no regex can
  check — it is enforced by `repo/dictionary.corrections.variants.test.ts` instead, and the
  invariant is conditional on the model, which is weaker than anything `docs/adr/` currently
  holds. **If the preference is to record it anyway, run `create-adr` before Task 5**, and word
  it to carry the condition rather than drop it.
- **No backfill run.** The code ships; the operation is the user's.

