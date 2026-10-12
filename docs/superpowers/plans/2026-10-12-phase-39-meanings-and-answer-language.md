# Phase 39 — One meaning at a time, answers in the right language: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A learner learns one meaning of an English word at a time (gloss families, a `new_meaning` intro card), and a typed answer in the wrong alphabet is asked again instead of graded.

**Architecture:** A pure `domain/glossFamilies.ts` derives families, known/current/waiting and introductions on every session creation; the session service records the result in three new tables (derive, then record) and feeds `chooseWords`. A new `new_meaning` question type is generated through the multiple-choice paths. A pure `packages/core/src/domain/script.ts` decides "wrong alphabet"; the app refuses to send such an answer, the server refuses it as a backstop (422), and typed instructions show the answer language in bold.

**Tech Stack:** TypeScript, Hono + Drizzle + Postgres (server), pg-boss jobs, Zod wire contract in `packages/core`, Expo/React Native (app), Jest, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-12-lang-tutor-phase-39-meanings-and-answer-language-design.md` — read it before your task. Decision numbers (D1–D12) below refer to it.

## Global Constraints

- Work only in `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-39-meanings-and-answer-language`. Never `cd` to, write to, or run commands in `/Users/victorprp/git/lang-tutor` (the main checkout, lane 0).
- Read `docs/adr/` before touching `apps/server` or `apps/mobile`. `npm run lint:arch` must print nothing. ADR 0001 R3: `domain/` imports only `@lang-tutor/core/*`, no `Date.now`, no `Math.random`.
- Never hardcode a port or a database name (ADR 0006). Run tests through the npm scripts.
- Never write to lane 0's database (`lang_tutor`). Reading it with `docker exec lang-tutor-db-1 psql -U postgres -d lang_tutor -At -c "select …"` is allowed (Task 8 only).
- Don't run `expo lint` in `apps/mobile`. Don't run `npm run eval`.
- `KNOWN_STABILITY = 7` (days). `API_LEVEL = 3`. Migration `0030_gloss_families`.
- Names: `gloss_families`, `gloss_family_members`, `gloss_family_events`; never "word family" or "sibling" for these.
- Match the surrounding code's comment style: a short doc comment citing "Phase 39 (spec Dn)".
- Commit after each task with a message in the repo's style (`feat(domain): … (phase 39 D3)`), ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test commands, all from the worktree root, one file at a time with `--runTestsByPath` (`--selectProjects` is variadic and swallows a bare path, running the whole suite):
  - server unit: `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/<file>.test.ts`
  - server integration (needs the lane): `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/<dir>/<file>.test.ts`
  - core: `npm exec -w packages/core -- jest --runTestsByPath src/<path>.test.ts`; mobile: `npm exec -w apps/mobile -- jest --runTestsByPath src/<path>.test.ts`; bots: `npm exec -w bots -- jest --runTestsByPath src/<file>.test.ts` (check `bots/package.json` for its runner)
  - typecheck `npm run typecheck`; architecture `npm run lint:arch`.
  Where a step below says "run <file>", use these forms.

## Review Focus

- **A gloss with no variants row for its lexeme** (forms empty): it must still join its lexeme's family by `lexemeId` and never crash. Test in Task 1.
- **A session whose every candidate is waiting or claimed except one family**: `chooseWords` must still return at least one pick (never an empty session while a word is saved). Test in Task 2.
- **An old job payload without `known_meanings`** must still parse and prepare as before. Test in Task 6.
- **A typed answer that is only digits, punctuation or whitespace** is not a wrong script; empty text still gives up. Test in Task 9.
- **The second try (phase 34 retry) answered in the wrong alphabet**: refused on the server and gated on the phone exactly like a first answer. Tests in Tasks 9 and 10.

---

### Task 1: `glossFamilies` — the pure families rule

**Files:**
- Create: `apps/server/src/domain/glossFamilies.ts`
- Create: `apps/server/src/domain/glossFamilies.test.ts`
- Modify: `apps/server/src/domain/chooseConstants.ts` (add `KNOWN_STABILITY`)

**Interfaces:**
- Produces (exact, used by Tasks 2, 4, 8):

```ts
export type FamilyGloss = {
  glossId: string;
  lexemeId: string;
  lemma: string;                     // vocabulary_entries.lemma: the family label is built from these
  key: string;
  savedAt: string;
  forms: readonly string[];          // its lexeme's variant spellings, lowercased
  order: readonly [number, number];  // [saved variant's entry_rank, lowest rendering rank on it]
  speakable: boolean;
  knownAt: string | null;
};
export type FamilyInput = {
  saved: readonly FamilyGloss[];
  memory: readonly { glossId: string; dimension: Dimension; state: MemoryState }[];
  live: readonly Dimension[];
};
export type GlossFamily = { glossIds: string[]; label: string };
export type FamilyState = 'known' | 'current' | 'waiting';
export type FamilyEvidence = { live: Dimension[]; stability: Partial<Record<Dimension, number>> };
export type Families = {
  families: GlossFamily[];
  familyOf: ReadonlyMap<string, number>;
  state: ReadonlyMap<string, FamilyState>;
  newlyKnown: ReadonlySet<string>;
  introductions: ReadonlyMap<string, string[]>;
  evidence: ReadonlyMap<string, FamilyEvidence>;
};
export function glossFamilies(input: FamilyInput): Families;
/** Every live skill at KNOWN_STABILITY; speaking only when speakable (spec D2). */
export function knownNow(glossId: string, speakable: boolean, memory: FamilyInput['memory'], live: readonly Dimension[]): boolean;
```

- `chooseConstants.ts`: `export const KNOWN_STABILITY = 7;` with a doc comment: phase 39 (spec D2), "a skill is known once remembered right on a later day: one right answer the next day lifts the first day's 2.3 to 7.3".

**Rules to implement** (spec D1–D3):
1. Union-find over saved glosses: same `lexemeId` joins; any shared `forms` entry joins (forms are already lowercased; compare as given). Only families of ≥ 2 glosses are returned.
2. `label`: the sorted distinct `lemma`s of the members, joined by `" / "` ("blow up", "saw / see").
3. Known: `knownAt !== null`, or `knownNow(...)` (then add to `newlyKnown`). `knownNow`: for every `d` in `live`, skipping `spoken_productive` when `!speakable`, a memory row exists with `state.stability >= KNOWN_STABILITY`.
4. Family order: practised (any memory row) first; then `order[0]`, then `order[1]`; then `savedAt` ascending; then `glossId`.
5. Current: first not-known gloss in family order. Waiting: every other not-known gloss. Known glosses: state `known`.
6. Introductions: the current gloss, when it has no memory row at all and the family has ≥ 1 known gloss → the known glosses' `key`s in family order.
7. Evidence for every member: `{ live: [...live], stability: { [d]: S } }` over the gloss's memory rows.

- [ ] **Step 1: Write the failing tests** in `glossFamilies.test.ts`. Build inputs with a helper `gloss(id, lexemeId, forms, overrides?)` and `mem(glossId, dimension, stability)` (`state: { stability, difficulty: 5, lastDay: '2026-10-01', reps: 2, lapses: 0, params: 'fsrs6-default' }`). Cases:
  - same lexeme → one family; different lexemes sharing `'saw'` → one family; `see`/`saw`(tool)/`saw`(cut) chain → one family of three; a one-gloss word → no family, absent from `familyOf` and `state`;
  - a gloss whose `forms` is `[]` still joins its lexeme's family (Review Focus);
  - known with `live = ORDER-without-SR-SK` needs WR, WP, spelling ≥ 7; adding `spoken_receptive` to `live` makes a gloss without SR memory unknown; `spoken_productive` is ignored when `speakable: false`;
  - stability 6.9 in one live skill → not known;
  - `knownAt` set with lapsed memory → `known`, not in `newlyKnown`; known by memory with `knownAt: null` → in `newlyKnown`;
  - order: a practised gloss with `order [0, 3]` comes before a never-asked one with `[0, 0]`; ties fall to `order`, then `savedAt`, then id;
  - degree case: three practised glosses all at 2.3 → `order[1]` 0 is current, other two waiting;
  - all known → no current, no waiting;
  - introductions: family with one known + one never-asked current → `introductions.get(current)` is `[knownKey]`; a practised current gets no introduction; a family with no known gloss gets none; two known → keys in family order;
  - evidence holds the live list and the stabilities.
- [ ] **Step 2: Run** `npm test --workspace apps/server -- src/domain/glossFamilies.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `glossFamilies.ts` (pure, imports only `@lang-tutor/core/domain` and `./chooseConstants`).
- [ ] **Step 4: Run** the test file — expect PASS. Run `npm run typecheck --workspace apps/server`.
- [ ] **Step 5: Commit** `feat(domain): gloss families — known, current, waiting, introductions (phase 39 D1–D3)`.

---

### Task 2: `chooseWords` with families

**Files:**
- Modify: `apps/server/src/domain/choose.ts`
- Modify: `apps/server/src/domain/choose.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at the type level (keep `choose.ts` independent).
- Produces: `ChoiceInput` gains

```ts
  /** Phase 39 (spec D5). Each family member's family (any stable id), and the glosses that wait. */
  families: { familyOf: ReadonlyMap<string, number | string>; waiting: ReadonlySet<string> };
```

  Callers that have no families pass `{ familyOf: new Map(), waiting: new Set() }`. Update every existing `chooseWords` call site in tests (`choose.test.ts`, `day.test.ts`) to pass the empty value so they compile.

**Behaviour** (spec D5):
- A gloss in `waiting` produces no candidate at all.
- A candidate's marks: its normalised key (existing `keys`) and, when it has one, its family (`families` set). `free()` refuses a candidate whose gloss is taken, whose key is taken, or whose family is taken or claimed by another gloss. `add()` takes the family.
- Before pass 1: for each return in `returns` order (earliest opened first), if its family is unclaimed, claim it for that gloss (`claims: Map<family, glossId>`).
- `n`: union-find over candidates joining equal keys and equal families; `n = Math.min(SESSION_LENGTH, groupCount)`.

- [ ] **Step 1: Write failing tests** in `choose.test.ts` (reuse the file's existing builders):
  - a waiting gloss that is due/new/a return is never picked, in any pass;
  - two new glosses of one family → only one picked; two due → one; a new and a due → one;
  - a return claims its family: family F has a return (gloss A) and a newer new gloss B → A picked, B not, even though new words come first in pass 1;
  - the speaking pick never takes a gloss of a family a return claimed;
  - two returns in one family → the earlier `opened` is picked;
  - a done gloss is never picked when its family is taken;
  - `n` with a list of 3 families of 4 glosses and 2 singletons is 5 (all fit), not 14;
  - Review Focus: a list where every gloss is in one family, none waiting → exactly 1 pick.
- [ ] **Step 2: Run** `npm test --workspace apps/server -- src/domain/choose.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Keep the existing pass order and comments; add the family mark next to `keys` and the claim pre-pass with a "Phase 39 (spec D5)" comment.
- [ ] **Step 4: Run** `choose.test.ts` and `day.test.ts` — PASS (day tests unchanged in behaviour with empty families).
- [ ] **Step 5: Commit** `feat(domain): one gloss per family per session, returns claim first (phase 39 D5)`.

---

### Task 3: Migration 0030 and the repos

**Files:**
- Modify: `apps/server/src/db/schema.ts` (three tables; `questions.known_meanings`; `questions_type_known` gains `new_meaning`; shape checks)
- Create: `apps/server/src/db/migrations/0030_gloss_families.sql` (+ `meta/0030_snapshot.json`, `_journal.json`) via `npx drizzle-kit generate --name gloss_families` in `apps/server`; hand-edit the SQL only for check constraints drizzle cannot express, as earlier migrations do
- Modify: `apps/server/src/repo/vocabulary.ts` (`listSavedGlosses`)
- Modify: `apps/server/src/repo/dict.ts` (`findLexemeForms`)
- Create: `apps/server/src/repo/glossFamilies.ts`; wire it into the repos object the same way `memory`/`progress` repos are wired (find `createMemoryRepo` usage)
- Test: `apps/server/tests/integration/repo/glossFamilies.test.ts`, extend `apps/server/tests/integration/db/migrations.test.ts`, and the existing vocabulary/dict repo integration tests

**Interfaces:**
- `SavedGloss` (in `domain/session.ts` or wherever `SavedGloss` is declared) gains `lexemeId: string; lemma: string; form: string; order: [number, number]`. `order[0]` = `dict_variants.entry_rank` of `ve.variant_id`; `order[1]` = `min(tr.rank)` over `dict_var_translations tr` joined through `dict_sense_glosses m` (`m.gloss_id = ve.gloss_id`, `m.user_language_code = tr.user_language_code`) with `tr.variant_id = ve.variant_id` and `tr.user_language_code` = the enrollment's source language; `0` when none.
- `dict.findLexemeForms({ lexemeIds: string[] }): Promise<{ lexemeId: string; form: string }[]>` — every `dict_variants` row of those lexemes, `lower(form)`, plus each lexeme's `lower(lemma)`; distinct.
- `repo/glossFamilies.ts`:

```ts
export type StoredMember = { glossId: string; familyId: string; state: 'known' | 'current' | 'waiting'; position: number; knownAt: string | null };
export type StoredFamily = { id: string; label: string; createdAt: string; members: StoredMember[] };
export type FamilyWrite = {
  families: { id: string; label: string; isNew: boolean }[];   // upserted
  deleteFamilies: string[];
  members: { glossId: string; familyId: string; state: string; position: number; knownAt: string | null; sinceChanged: boolean }[]; // upserted
  deleteMembers: string[];                                      // gloss ids
  events: { familyId: string; glossId: string; fromState: string | null; toState: string | null; evidence: unknown }[];
};
createGlossFamiliesRepo(tx) => {
  load(enrollmentId: string): Promise<StoredFamily[]>;
  apply(enrollmentId: string, sessionId: string, write: FamilyWrite): Promise<void>;
}
```

  `apply` sets `since = now()` only when `sinceChanged`, `updated_at = now()` on upserted families, and inserts events with `at = now()`. Ids are generated in the repo with the same uuid helper other repos use.

**Schema** (spec D4, D6): as the spec's table block. `gloss_family_members` FK `(enrollment_id, gloss_id)` → `vocabulary_entries` cascade, named `gloss_family_members_entry_fk`; `family_id` FK → `gloss_families` cascade. `gloss_family_events` FK `enrollment_id` → `enrollments` cascade only. `questions.known_meanings text[]`, with a check: `(type = 'new_meaning') = (known_meanings is not null and cardinality(known_meanings) > 0)`. Extend the existing per-type shape check so `new_meaning` has multiple choice's shape (options set, prompt null, …) — read the existing `questions_*` checks and add `new_meaning` wherever `multiple_choice` is listed.

- [ ] **Step 1: Write failing integration tests:** `glossFamilies.test.ts` (load empty; apply then load round-trips families, members, `known_at`; events written with the session id; deleting a vocabulary entry cascades its member row; deleting a family cascades its members); `migrations.test.ts` case for 0030 (tables exist; the `known_meanings` check rejects `new_meaning` without it and `multiple_choice` with it); `listSavedGlosses` returns `lexemeId`, `lemma`, `form`, `order`; `findLexemeForms` returns lowercased variant forms and the lemma.
- [ ] **Step 2: Run** them through the lane — FAIL.
- [ ] **Step 3: Implement** schema, generate the migration, repos.
- [ ] **Step 4: Run** the tests — PASS; `npm run typecheck`; `npm run lint:arch` (ADR 0011 R1 must still print nothing). Run `npm run db:migrate` from the worktree root to migrate the lane's own database; if the command is refused, note it in your report and continue — integration tests make their own databases.
- [ ] **Step 5: Commit** `feat(db): gloss family tables and a new_meaning column (phase 39 D4, D6)`.

---

### Task 4: Recording the refresh and wiring session creation

**Files:**
- Create: `apps/server/src/domain/glossFamilyRecord.ts` (+ `.test.ts`)
- Modify: `apps/server/src/services/sessions.ts` (`createNextSession`)
- Modify: `apps/server/src/domain/jobs.ts` (pick gains `known_meanings`)
- Test: `apps/server/tests/integration/services/` (find the existing createNextSession integration tests, e.g. grep `createNextSession` under `tests/integration`) — add a `glossFamilies` case file next to them

**Interfaces:**
- Consumes: Task 1 `glossFamilies`, `Families`; Task 3 `StoredFamily`, `FamilyWrite`, `load`, `apply`, `findLexemeForms`, new `SavedGloss` fields; Task 2 `ChoiceInput.families`.
- Produces:

```ts
/** Phase 39 (spec D4). What to write so the tables show `computed`: family ids kept by majority of
 *  stored members (ties: older createdAt), new ids as null (the repo makes them), events for every
 *  state or family change, known_at for newlyKnown. Pure. */
export function familyChanges(stored: readonly StoredFamilyView[], computed: Families, newId: () => string): FamilyWrite;
```

  where `StoredFamilyView` is a structural copy of `StoredFamily` declared in the domain file (domain must not import `repo/`; ADR 0001 R3 — import types from `repo` is not allowed in `domain/`, so declare the shape there and let `repo` satisfy it). Pass `newId` from the service (it has an id helper; check how services create uuids, e.g. `randomUUID` from `node:crypto` in the service layer).
- `PrepareSessionPayloadSchema` pick: `known_meanings: z.array(z.string()).optional()` with a comment "Phase 39 (spec D6). The known meanings a new_meaning card lists; absent before the deploy and on every other pick."

**Service order** (spec D5): read saved (+forms via `findLexemeForms`), memory, levels; `families.load`; compute `live` the way `chooseWords` does (`ORDER` filtered by listening/speaking — export a small `liveDimensions(listening, speaking)` from `choose.ts` and use it in both places); `glossFamilies({ saved: FamilyGloss[] (knownAt from stored members), memory, live })`; `dayState`; `chooseWords({ …, families: { familyOf, waiting: glosses with state 'waiting' } })`; renderings; `insertPreparingSession`; `families.apply(enrollmentId, sessionId, familyChanges(...))` only when the write is non-empty; enqueue with `known_meanings: introductions.get(glossId)` on picks that have it. `speakable` comes from core's `speakable(form)` on the saved form.

- [ ] **Step 1: Failing unit tests** for `familyChanges`: first refresh creates families, members and `joined` events (`from_state: null`); an unchanged refresh returns an empty write; a state change gives one event with evidence; a merge of two stored families keeps the one with more members and logs `joined` for the others; a family that dissolves deletes its members with `to_state: null` events; `newlyKnown` sets `knownAt`.
- [ ] **Step 2: Failing integration tests:** creating a session for an enrollment with a saved family writes `gloss_families`/members/events; a waiting gloss never appears in the job payload's picks; a never-asked current gloss with a known sibling (seed `gloss_memory` rows ≥ 7 in every live skill for the sibling) appears with `known_meanings`; a second creation with nothing changed writes no new events.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** unit + the integration file — PASS; run the existing `createNextSession` integration tests — PASS; typecheck; lint:arch.
- [ ] **Step 5: Commit** `feat(server): record gloss families at session creation, waiting glosses wait (phase 39 D4, D5)`.

---

### Task 5: `new_meaning` on the wire, in grading and in the plan

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`NewMeaningQuestionSchema`, add to `QuestionSchema`), `packages/core/src/api/types.ts` (`NewMeaningQuestion`), `packages/core/src/domain/quiz.ts` (`isChoice`, `evaluate`, any switch over `Question['type']`), `packages/core/src/domain/memoryGrades.ts` (`new_meaning` grades as `multiple_choice`), `packages/core/src/apiLevel.ts` (`API_LEVEL = 3`, comment naming both phase 39 reasons per spec D11)
- Modify: `apps/server/src/domain/progress.ts` (`ChoiceAnswerType` and the evidence switch: as `multiple_choice`), `apps/server/src/domain/plan.ts` (`PlanPick.knownMeanings?`, `cardFor`, `FOUR_OPTION`)
- Tests: the matching `*.test.ts` next to each file (`schemas.test.ts`, `quiz.test.ts`, `memoryGrades.test.ts`, `progress.test.ts`, `plan.test.ts`)

**Interfaces:**
- `NewMeaningQuestionSchema` exactly as spec D6 (`id, type: 'new_meaning', vocab_term_id, question, known_meanings, options, correct_option, context: ContextSchema.nullable()`).
- `plan.ts`: `cardFor` returns `{ type: 'new_meaning', p: expectedSuccess(pick.r, true, 1), chosen: false }` first when `pick.knownMeanings?.length`. `FOUR_OPTION` includes `'new_meaning'`. Boards are built only from `multiple_choice` cards, so it is never on one — assert it.

- [ ] **Step 1: Failing tests:** schema parses a `new_meaning` question and rejects one without `known_meanings`; `isChoice` true; `evaluate` with `option_index` gives `correct` like multiple choice; `gradesFor({ type: 'new_meaning', correct })` equals multiple choice's; level evidence equals multiple choice's; `planCards` turns a pick with `knownMeanings` into `new_meaning`, does not count it toward `MAX_PER_TYPE` (five such picks plus four ordinary WR rung-1 picks still give the ordinary ones `multiple_choice` where they would have), and never puts it on a board in a 10-pick session.
- [ ] **Step 2: Run** the core and server unit tests — FAIL.
- [ ] **Step 3: Implement.** Then run `npm run typecheck` at the root: every exhaustive `switch` over question types in server, mobile, bots and e2e will now fail to compile. Fix only the server/core ones here with the multiple-choice behaviour; leave `apps/mobile`, `bots` and `e2e` compile errors for Task 7 (list them in your report).
- [ ] **Step 4: Run** core + server unit suites — PASS; `npm run typecheck --workspace apps/server`; `--workspace packages/core`.
- [ ] **Step 5: Commit** `feat(core): the new_meaning question type, graded as a multiple choice; API level 3 (phase 39 D6, D11)`.

---

### Task 6: Preparing and storing a `new_meaning` card

**Files:**
- Modify: `apps/server/src/services/sessions.ts` (prepare job: `generatedAs`, stored row), `apps/server/src/repo/questions.ts` (insert `known_meanings`; load `new_meaning` → wire; `findRecentContexts`' `q.type IN (...)` gains `new_meaning`), `apps/server/src/domain/distractors.ts` / `domain/context.ts` only if a type switch there needs the case after `generatedAs` (prefer mapping in the service so these stay untouched)
- Modify: `apps/server/src/routes/sessions.ts` OpenAPI descriptions mentioning card types (add `new_meaning`: answered with `option_index`)
- Test: `apps/server/src/services/sessions.prepare.test.ts`; an integration test under `tests/integration/` that prepares a session whose payload pick carries `known_meanings` and loads it back

**Interfaces:**
- `const generatedAs = (type: QuestionType): QuestionType => (type === 'new_meaning' ? 'multiple_choice' : type);` in `services/sessions.ts`. Every generation step (`tasksFor`/`taskFor`, `distractorItems`, `contextItemFor`, checker items, `CHOSEN`, `generatedContent`) sees `generatedAs(type)`; the stored question row keeps `type: 'new_meaning'` and `knownMeanings: pick.known_meanings`.
- `plan` input: `knownMeanings: read.picked[index].known_meanings` on each `PlanPick`.

- [ ] **Step 1: Failing tests:** `sessions.prepare.test.ts` — a payload pick with `known_meanings: ['להרים']` produces a stored `new_meaning` question with the multiple-choice options, its context, and `known_meanings`; a payload without the field (Review Focus) prepares exactly as before. Integration: the prepared session's `GET` returns the `new_meaning` question on the wire with `known_meanings`, and answering it by `option_index` records a correct/incorrect answer.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit file, the integration file, and the existing prepare integration tests — PASS; typecheck server.
- [ ] **Step 5: Commit** `feat(server): prepare a new_meaning card through the multiple-choice paths (phase 39 D6)`.

---

### Task 7: `new_meaning` in the app, the bots and e2e

**Files:**
- Create: `apps/mobile/src/components/NewMeaningPrompt.tsx` (the prompt block: word, known meanings line, context line, question line)
- Modify: `apps/mobile/src/app/session.tsx` (`renderQuestion` case: `MultipleChoiceView` with `instruction={strings.questionInstructionNewMeaning}` and `prompt={<NewMeaningPrompt …/>}`, root test id `new-meaning-card`), `apps/mobile/src/strings.ts` (`questionInstructionNewMeaning: 'פירוש חדש למילה שאתם מכירים'`, `knownMeanings: (meanings: readonly string[]) => \`כבר למדתם: ${meanings.join(', ')}\``, `newMeaningQuestion: 'מה עוד זה אומר?'`), `apps/mobile/src/progress.ts` and any other mobile switch the typecheck flags (treat as multiple choice), `apps/mobile/src/feedback.ts` if it switches on type
- Modify: `bots/src/answer.ts`, `bots/src/analysis.ts` (`CHOICE_TYPES`), any bots switch the typecheck flags
- Modify: `e2e/tests/support/cards.ts` (`CardKind` gains `'new-meaning'`, `readCard` recognises `new-meaning-card`), `e2e/tests/support/sessions.ts` (prompt of a `new_meaning` question is `question.question`)
- Create: `e2e/tests/new-meaning.spec.ts`
- Tests: `apps/mobile/src/strings.test.ts`, a mobile test for the session screen's new case if one exists for other cases (grep `renderQuestion`/`session.test`), bots tests next to `answer.ts`

**Interfaces:**
- Consumes: Task 5 `NewMeaningQuestion` (`question`, `known_meanings`, `options`, `correct_option`, `context`).
- Look at how `MultipleChoiceView` draws `question.question` and `context` today: the new prompt replaces that block (pass `prompt`), and `ContextLine` is reused for the context sentence.

- [ ] **Step 1: Failing tests:** strings (`knownMeanings(['להרים','לאסוף'])` → `'כבר למדתם: להרים, לאסוף'`); bots answer a `new_meaning` card with an option index (right → `correct_option`); bots analysis counts it as a choice.
- [ ] **Step 2: Run** mobile + bots tests — FAIL.
- [ ] **Step 3: Implement** app, bots, e2e helpers. `npm run typecheck` at the root must pass now.
- [ ] **Step 4: e2e spec** `new-meaning.spec.ts`: sign up a learner, save two glosses of one word (follow `ambiguous-questions.spec.ts` / `meaning-recall.spec.ts` for how a spec saves words and seeds memory with `seedMemory` from `support/memory.ts`), seed the first gloss's memory at stability 30 in every live skill, start a list session, find the `new-meaning-card`, assert the known-meanings line shows the first gloss's meaning and the context line is present, answer it right. Run `npm run e2e -- new-meaning.spec.ts` from the worktree root. If the lane's e2e stack cannot start, say so in the report; CI runs it.
- [ ] **Step 5: Run** mobile unit, bots unit, root typecheck — PASS. **Commit** `feat(mobile): the new_meaning card; bots and e2e learn it (phase 39 D6)`.

---

### Task 8: Day tests with families

**Files:**
- Modify: `apps/server/src/domain/day.fixture.ts` (per saved gloss: `lexemeId`, `lemma`, `forms`, `order`, `speakable`, all anonymised)
- Modify: `apps/server/src/domain/day.test.ts`

**Fixture data** (read-only from lane 0; enrollment `a2d34128-01af-441b-bb68-8070695d1406`, source language `he`):
- Match the fixture's glosses to lane 0's: order lane 0's saved glosses by `created_at, gloss_id` within each save time; the fixture's `g001…` follow the same order (save times and key-equality classes were verified to match on 2026-10-12). Verify further: for glosses whose lane 0 `gloss_memory` rows all have `last_day < '2026-10-11'`, the fixture's memory rows must equal lane 0's (stability to 3 decimals). If the check fails for any gloss, stop and report.
- For each gloss read `ve.lexeme_id`, `ve.lemma`, the lexeme's variant forms (`lower(form)`) plus `lower(lemma)`, `order` as Task 3 defines it, and `speakable` (core `speakable(form)` on the saved form). Anonymise: lexeme ids → `x001…` in first-appearance order; every distinct form → `f001…`; lemmas → the lexeme's `x…` id (so equal lemmas stay equal). Write a scratch script under the session scratchpad, not in the repo.

**Runner changes:** before each session, build `FamilyGloss[]` from the fixture plus the runner's `knownAt` map, call `glossFamilies` with `live = all five`, record `newlyKnown` into `knownAt`, pass `{ familyOf, waiting }` to `chooseWords`, and give picks in `introductions` `knownMeanings` in the `PlanPick`. `FRESH` gets single-gloss lexemes (`x` per gloss, one form each).

- [ ] **Step 1: Write failing assertions** in every existing run: **6.** no session's picks hold two glosses with the same family; **7.** no waiting gloss is ever picked. Add the run **families over days**: a 12-gloss list (a five-meaning lexeme, a homograph pair sharing `f-saw`, five singletons), 10 days × 6 sessions, memory carried across days (advance `today` per day; reset the day's answers/introduced each day), and assert: the five-meaning word's second meaning is first picked only on or after the session where its first became known, and that first pick's planned type is `new_meaning` with the first's key in `knownMeanings`. If the second meaning never becomes current within 10 days, raise the days to 20 and say so in the report.
- [ ] **Step 2: Run** `npm test --workspace apps/server -- src/domain/day.test.ts` — FAIL until the runner computes families.
- [ ] **Step 3: Implement** fixture fields and runner changes.
- [ ] **Step 4: Run** — PASS, with outcomes 1–5 still passing. If outcome 1 or 4 breaks because waiting glosses shrink the lane-0 list, report which session and why before changing any assertion.
- [ ] **Step 5: Commit** `test(domain): day tests with gloss families, and a families-over-days run (phase 39 D12)`.

---

### Task 9: Wrong alphabet — the rule and the server's backstop

**Files:**
- Create: `packages/core/src/domain/script.ts` (+ `script.test.ts`); export from `packages/core/src/domain/index.ts`
- Modify: `apps/server/src/domain/session.ts` (`step` options gain `languages`, outcome `wrong_script`), `apps/server/src/errors.ts` (`WrongScript`), `apps/server/src/services/sessions.ts` (`submitAnswer`, `answerJudged`, and `answerBySpeech`'s call into `submitAnswer` passes languages), `apps/server/src/routes/sessions.ts` (422 mapping on next-step and judged-answer routes, OpenAPI response declared)
- Tests: `apps/server/src/domain/session.test.ts`, `apps/server/src/services/sessions.judge.test.ts`, an integration routes test under `tests/integration/routes/`

**Interfaces** (spec D7, D10):

```ts
export const SCRIPTS: Record<LanguageCode, 'Latin' | 'Hebrew' | 'Cyrillic'>;
export type TypedAnswerType = 'typed_translation' | 'cloze_typed' | 'sentence_translation' | 'dictation' | 'say_translation' | 'typed_meaning';
export function isTypedAnswerType(type: QuestionType): type is TypedAnswerType;
export function answerLanguage(type: TypedAnswerType, target: LanguageCode, learner: LanguageCode): LanguageCode;
export function wrongScript(text: string, language: LanguageCode): boolean; // /\p{L}/u present and none matches \p{Script=<SCRIPTS[language]>}
```

- `step(record, questionId, answer, { retry, languages })` with `languages: { target: LanguageCode; learner: LanguageCode }` (required). In `refusal`: when `'text' in answer` and `isTypedAnswerType(question.type)` and `wrongScript(answer.text, answerLanguage(...))` → `{ status: 'wrong_script' }`. Applies to first answers and retries alike.
- `export class WrongScript extends Error { constructor(readonly questionId: string, readonly language: string) }`.
- Route body: `{ error: \`the answer is not written in ${language}'s alphabet\` }`, status 422.
- `answerJudged`: check before `ruleVerdict`; throw `WrongScript`; log `{ event: 'answer_wrong_script', session_id, question_type }`. `submitAnswer` logs the same when `step` refuses.

- [ ] **Step 1: Failing tests:** `script.test.ts` — `wrongScript('מציצה','en')` true; `('blow up','en')` false; `('blow up להתפוצץ','en')` false (mixed); `('saw','he')` true; `('DNA מולקולה','he')` false; `('книга','en')` true; `('book','ru')` true; `('1990','en')` false; `('...', 'en')` false; `('', 'en')` false; `('  ', 'en')` false; `answerLanguage('typed_meaning','en','he')` = `'he'`, `('dictation','en','he')` = `'en'`. `session.test.ts` — `wrong_script` for each `TypedAnswerType` answered in Hebrew (Latin on typed meaning), on a first answer and on a pending retry (Review Focus); empty text records `gave_up`; a choice card ignores it. `sessions.judge.test.ts` — a typed meaning answered `'degree'` throws `WrongScript` and the judge stub is never called. Integration — `POST next-step` with a Hebrew dictation answer → 422 and no `answers` row; judged route with Latin on a typed meaning → 422.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Pass `languages` from `enrolled.target_language` / `enrolled.source_language` (both `LanguageCode`) wherever `step` is called.
- [ ] **Step 4: Run** core, server unit, the integration test — PASS; typecheck; lint:arch.
- [ ] **Step 5: Commit** `feat(server): refuse a typed answer in the wrong alphabet, ungraded (phase 39 D7, D10)`.

---

### Task 10: Ask again and the bold language, on the phone

**Files:**
- Modify: `apps/mobile/src/strings.ts` (`Instruction` type; typed instruction functions return `Instruction`; `questionInstructionMeaning(learner)`; `wrongScriptNotice(language)`), `apps/mobile/src/components/TypedAnswerView.tsx` (`instruction: Instruction`, `answerLanguage: LanguageCode`, gate, notice), `apps/mobile/src/app/session.tsx` (pass `answerLanguage`; the learner language from the enrollment the screen already reads — grep how `language` reaches `renderQuestion` and add the source language beside it)
- Tests: `apps/mobile/src/strings.test.ts`; a component test for the gate if the mobile workspace has component tests (grep `@testing-library/react-native` in `apps/mobile`), otherwise extract the gate decision into a pure `typedSubmit(text, language): 'send' | 'wrong_script' | 'empty'` in `apps/mobile/src/typedSubmit.ts` with a unit test
- Create: `e2e/tests/answer-language.spec.ts`

**Interfaces** (spec D8, D9):

```ts
export type Instruction = { before: string; language: string; after: string };
questionInstructionTyped: (language: string) => Instruction;          // { before: 'כתבו את המילה ב', language: name, after: '' }
questionInstructionDictation: (language: string) => Instruction;      // 'הקשיבו וכתבו ב'
questionInstructionClozeTyped: (language: string) => Instruction;     // 'השלימו את המילה החסרה ב'
questionInstructionTranslate: (language: string) => Instruction;      // 'תרגמו ל'
questionInstructionMeaning: (learner: string) => Instruction;         // 'כתבו את הפירוש ב' + languageName(learner)
wrongScriptNotice: (language: string) => Instruction;                 // 'התשובה צריכה להיות ב'
```

  Keep these strings' wording exactly (only the split is new); check `languageName('he')` returns `'עברית'` and add it to `LANGUAGE_NAMES` if missing. Phase 38's typed-cloze changes in `TypedAnswerView` stay intact.
- Gate in `TypedAnswerView.submit(value)`: if `value.trim() !== ''` and `wrongScript(value, answerLanguage)` → set `wrongScriptShown = true`, do not call `Keyboard.dismiss()` or `onSubmit`; the text stays. `onChangeText` clears `wrongScriptShown`. The notice renders under the input with test id `wrong-script`, its language part bold. "Show the answer" (`submit('')`) is unaffected.
- Instruction render: `<Text style={answerStyles.instruction}>{i.before}<Text style={styles.instructionLanguage /* fontWeight '700' */} testID="instruction-language">{i.language}</Text>{i.after}</Text>`.

- [ ] **Step 1: Failing tests:** strings return the parts with the exact text; the gate decision (Hebrew on `en` → wrong_script; empty → empty; mixed → send; Latin on `he` → wrong_script).
- [ ] **Step 2: Run** `npm test --workspace apps/mobile` — FAIL.
- [ ] **Step 3: Implement**; root `npm run typecheck` passes.
- [ ] **Step 4: e2e** `answer-language.spec.ts`: reach a dictation card (follow `listening-variety.spec.ts` for forcing a dictation) and type `'מציצה'`: `wrong-script` is visible, `typed-input` still holds the text, no banner; clear and type the right word: the card is answered. Reach a typed-meaning card (follow `meaning-recall.spec.ts`) and type the English word: notice shown. Assert `instruction-language` has `font-weight: 700` (computed style on web). Run `npm run e2e -- answer-language.spec.ts`; if the stack cannot start, say so.
- [ ] **Step 5: Run** mobile unit + typecheck — PASS. **Commit** `feat(mobile): ask again on a wrong alphabet, and the answer language in bold (phase 39 D8, D9)`.

---

### Task 11: Whole-branch check and the spec's "As built"

**Files:** `docs/superpowers/specs/2026-10-12-lang-tutor-phase-39-meanings-and-answer-language-design.md`

- [ ] **Step 1:** `git fetch origin && git merge origin/master` if master moved (resolve; renumber migration if 0030 collides; `npm install`).
- [ ] **Step 2:** Run `npm test`, `npm run test:all`, `npm run typecheck`, `npm run lint:arch`, `npm run e2e` from the worktree root. Report any failure with its output.
- [ ] **Step 3:** Fill "As built" with the rulings made during Tasks 1–10 (each one line: what changed from the spec and why).
- [ ] **Step 4: Commit** `docs(spec): phase 39 as built`.
