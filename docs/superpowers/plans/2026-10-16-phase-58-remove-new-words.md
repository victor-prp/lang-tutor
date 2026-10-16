# Phase 58 — Remove every new word at once: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor said
> "continue till PR": inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `DELETE /api/enrollments/{id}/vocabulary?level=N` removes every saved sense of every word
at that level in one transaction, and the list screen offers it on the new filter.

**Architecture:** core schemas → repo primitives (vocabulary, targets) → service use case
`removeLevel` → route → app client, hook, list screen. Mirrors `unsave` once for the batch.

**Tech Stack:** Hono + zod-openapi, drizzle raw SQL, Jest integration on the lane DB, Expo Router,
Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-phase-58-remove-new-words-design.md`

## Global Constraints

- UI copy is Hebrew, exactly as spec D4.
- `API_LEVEL` does not change (spec D2).
- ADR 0001: route is transport only, service imports repo types only, one `transaction(...)`.
- ADR 0003: schemas live in `packages/core/src/api/schemas.ts`, types inferred.

## Review Focus

1. A word whose badge is 1 with one sense at level 2: the whole word goes (D1). Pinned in Task 1.
2. A word at level 2 sharing nothing with the removed ones stays. Task 1.
3. A target holding two removed words gets ONE event listing both. Task 1.
4. A repeat call after success answers 200 zeros, not an error. Task 1.
5. Pressing the button while the call runs fires one call only (disabled). Task 3.

---

### Task 1: Server endpoint

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`,
  `packages/core/src/api/index.ts`
- Modify: `apps/server/src/repo/vocabulary.ts`, `apps/server/src/repo/targets.ts`
- Modify: `apps/server/src/services/vocabulary.ts`, `apps/server/src/routes/vocabulary.ts`
- Test: `apps/server/tests/integration/routes/vocabulary.test.ts`,
  `apps/server/tests/integration/services/targets.test.ts`

**Interfaces:**
- Produces: `RemoveVocabularyLevelQuerySchema = z.object({ level: z.coerce.number().int().min(1).max(5) })`,
  `RemoveVocabularyLevelResponseSchema = z.object({ removed_words: z.number().int(), removed_glosses: z.number().int() })`,
  types `RemoveVocabularyLevelResponse`.
- Produces: `repos.vocabulary.findGlossIdsAtLevel({ enrollmentId, level, live }): Promise<{ lemma: string; glossId: string }[]>`,
  `repos.vocabulary.deleteEntries({ enrollmentId, glossIds }): Promise<void>`,
  `repos.target.removeGlossesFromTargets(enrollmentId, glossIds): Promise<Map<string, string[]>>`
  (target id → sorted gloss ids it lost).
- Produces: `vocabulary.removeLevel(actorUserId, enrollmentId, level): Promise<RemoveVocabularyLevelResponse>`.

- [ ] **Step 1: Failing route tests** — a `describe('DELETE /api/enrollments/{id}/vocabulary?level=')`:

```ts
const removeLevel = (enrollmentId: string, query: string, actor = 'u_1') =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary${query}`, { method: 'DELETE', headers: { [ACT_AS]: actor } });

```

Cases (each its own `it`): word A, two senses saved at level 1 (badge 1); word B, a noun with two
senses at 1 and a verb sense of the same lemma at 2 (mean 1.33, badge 1, so all three go); word C
at level 3, kept. Response `{ removed_words: 2, removed_glosses: 5 }`; list then holds
only C; `u_1`'s English enrollment untouched; repeat answers `{ 0, 0 }`; `it.each(['', '?level=0',
'?level=6', '?level=two'])` 400 `{ error: 'invalid request' }`; 404 for `e_nobody`; 403 for `u_2`
and for an accepted tutor (with `seedGrant`).

- [ ] **Step 2: Failing service test** in `targets.test.ts` `describe('remove a level (phase 58)')`:
two typed words in one target, both at level 1 → after `deps.vocabulary.removeLevel('u_1', E, 1)`
the target has no words and its log ends with one
`{ kind: 'words_removed', before: { gloss_ids: [sorted both] }, after: { reason: 'unsaved' } }`.

- [ ] **Step 3: Run, see both fail** —
`npm run test:integration -- --runTestsByPath tests/integration/routes/vocabulary.test.ts tests/integration/services/targets.test.ts`
(from `apps/server` via the lane wrapper; memory: `--selectProjects=integration --runTestsByPath`).

- [ ] **Step 4: Implement.** Schemas and types. Repo SQL, the level by the list's expression:

```ts
glossIdsAtLevel: (input: { enrollmentId: string; level: number; live: readonly Dimension[] }): SQL => sql`
  SELECT ve.lemma, ve.gloss_id
  FROM vocabulary_entries ve
  WHERE ve.enrollment_id = ${input.enrollmentId}
    AND ve.lemma IN (
      SELECT ve2.lemma
      FROM vocabulary_entries ve2
      JOIN gloss_progress p ON p.enrollment_id = ve2.enrollment_id AND p.gloss_id = ve2.gloss_id
                           AND p.dimension IN (${inList([...input.live])})
      WHERE ve2.enrollment_id = ${input.enrollmentId}
      GROUP BY ve2.lemma
      HAVING ${LEVEL_OF('p')} = ${input.level})
  ORDER BY ve.lemma, ve.gloss_id`,
deleteEntries: DELETE … WHERE enrollment_id = $1 AND gloss_id IN (inList(glossIds))
```

(`LEVEL` is already `floor(avg(p.level) + 0.5)::int` over alias `p`; reuse it as is.) Targets:
`removeGlossesFromTargets` is `removeGlossFromTargets` with `inArray`, returning
`{ targetId, glossId }` rows grouped into a sorted map. Service `removeLevel`, inside one
transaction: `enrollmentOrThrow` → `authorize(…'vocabulary.remove')` → `lockNextSession` →
`findGlossIdsAtLevel` → if none, return zeros → `resolveGlosses(ids)` → survivors (deduped) →
`deleteEntries` → `removeGlossesFromTargets` → one `insertEvent` per target → restock once if any;
then log `vocabulary_level_removed` `{ enrollment_id, level, word_count, gloss_count }` and
`logTargetRetired`. Route: `createRoute({ method: 'delete', path: BASE, request: { params, query:
RemoveVocabularyLevelQuerySchema }, responses: 200/400/404/403 + learnerResponses })`, errors
mapped as `unsave` maps them.

- [ ] **Step 5: Run both files, PASS; `npm run typecheck`; `npm run lint:arch`.**
- [ ] **Step 6: Commit** `feat(server): remove every word at one level in one call`.

### Task 2: Auth matrix and OpenAPI

**Files:** `apps/server/tests/integration/auth/matrix.test.ts`, `apps/server/src/openapi.test.ts`

- [ ] Add `'delete /api/enrollments/{id}/vocabulary': () => ({ url: \`/api/enrollments/${ids.enrollment}/vocabulary?level=1\` })`
  to the matrix's operation map; run it and `openapi.test.ts`; fix any operation count they assert
  (the path count stays thirty-eight). Commit `test(server): the auth matrix covers removing a level`.

### Task 3: App

**Files:** `apps/mobile/src/api/client.ts` (+ `client.test.ts`), `apps/mobile/src/hooks/useVocabulary.tsx`,
`apps/mobile/src/app/vocabulary/index.tsx`, `apps/mobile/src/strings.ts` (+ `strings.test.ts`)

**Interfaces:** `api.removeVocabularyLevel(enrollmentId: string, level: number): Promise<RemoveVocabularyLevelResponse>`;
hook `removeLevel(level: number): Promise<void>` (calls, then `reload()`).

- [ ] **Step 1: Failing client test:** `removeVocabularyLevel('e 1', 1)` sends `DELETE
  /api/enrollments/e%201/vocabulary?level=1` and returns the parsed body (copy the shape of the
  existing `unsaveVocabulary` test).
- [ ] **Step 2: Implement** the client (a `send('DELETE', …)` that parses JSON), the hook, the
  strings (`vocabularyRemoveNew`, `vocabularyRemoveNewTitle`, `vocabularyRemoveNewMessage`,
  `vocabularyRemoveNewConfirm`, `vocabularyRemoveNewFailed`, text as spec D4, pinned in
  `strings.test.ts`), and the button: shown when `v.query.level === 1 && v.words.length > 0`,
  `testID="vocabulary-remove-new"`, disabled while busy, `confirm({...})` then `removeLevel(1)`;
  on throw set the failure text (`testID="vocabulary-remove-failed"`).
- [ ] **Step 3:** `npm test` (mobile project) and `npm run typecheck`, PASS. Commit
  `feat(mobile): remove every new word from the list's new filter`.

### Task 4: e2e

**Files:** `e2e/tests/vocabulary.spec.ts`

- [ ] A test: seed (as the spec's other tests do) two words at level 1 and one at level 2; open the
  list, tap `vocabulary-level-1`, `page.once('dialog', (d) => d.accept())`, tap
  `vocabulary-remove-new`; expect `vocabulary-empty-level` visible; tap `vocabulary-level-all`;
  expect exactly one `vocabulary-word`, the level 2 one.
- [ ] `npm run e2e -- e2e/tests/vocabulary.spec.ts` PASS, then the full `npm run e2e`. Commit
  `test(e2e): a learner removes every new word at once`.
