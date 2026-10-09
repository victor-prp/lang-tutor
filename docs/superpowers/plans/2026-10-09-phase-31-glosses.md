# Phase 31 — Glosses: one target word, one card, one level: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The learner's unit becomes the gloss, one target word for one headword in one learner language, so a word's page, a session and a level never repeat one target word while the dictionary keeps its senses.

**Architecture:**
- Two dictionary tables beside the senses: `dict_glosses` (one target word of one lexeme in one learner language) and `dict_sense_glosses` (which senses it groups). Both writers of renderings, the lookup's `persistEntries` and the stale-form repair, run one pure rule, `assignGlosses`, so every rendered sense has a gloss before its rendering is written.
- Every learner table is re-keyed from `sense_id` to `gloss_id`, and `sense_progress` becomes `gloss_progress`. The migration folds saves, levels and session snapshots that collide on the new key.
- The lookup, the word page, the tutor's screen and the photo import show one card per gloss. The list's headline is the gloss key.
- A merge is the only regroup. A background job merges when the lemma form's citation form names another live gloss's key. A merged gloss forwards to its survivor, and every learner write resolves ids under a share lock on the lexeme.
- A `render-lemma` job renders a saved word's lemma form, so sessions rotate over every form of every member. Saves enqueue it, and the CLI's start-up path requests it for words saved before this phase.
- Prompts ask for one translation, alternatives, a citation form and a definition. Reconciliation lists definitions, so the first learner of a new language reuses sense codes.
- ADR 0011 records the gloss as the learner's unit.

**Tech Stack:**
- Server: TypeScript, Hono + `@hono/zod-openapi`, zod 4, Drizzle ORM 0.45 and drizzle-kit 0.31 on Postgres 17, pg-boss 12, Jest (unit and integration projects).
- App: Expo Router (Expo SDK 57, React Native).
- E2E: Playwright against the web export, with MockServer for Gemini.

**Spec:** `docs/superpowers/specs/2026-10-09-lang-tutor-phase-31-glosses-design.md`. Read it before any task. Decisions are cited as D1–D19.

## Decided while planning

Each of these departs from the spec's letter for a reason found in the code. Task 17 writes them back into the spec.

1. **ADR 0011, not 0009.** Phase 29's open branch holds `adr-0009-sign-in.md`, and phase 30 merged `adr-0010-single-container-migrations.md`.
2. **Three migration files, applied as one.** `0022_glosses` (dictionary side, Task 2), `0023_glosses_rekey` (learner tables, Task 6) and `0024_lemma_renders` (Task 10). Drizzle's pg migrator applies every pending migration inside one transaction (`node_modules/drizzle-orm/pg-core/dialect.js`, `migrate()`), so a deploy still migrates atomically. If phase 29 lands first with `0022_auth` and `0023_users_auth_fk`, these become `0024`–`0026` (see Global Constraints).
3. **The lemma backfill runs in the CLI's start-up path.** ADR 0010 makes the container's `node dist/cli.js` the only process that reaches production's database, so a separate `dict:lemmas:render` script could never run there. The CLI's default path (migrate, seed) now also requests lemma renders, and `npm run dict:lemmas:render` runs the same step on demand. A small table, `dict_lemma_renders`, records each (lexeme, learner language) render requested, so neither a second save nor the next restart requests it again: without it, a lemma the job skipped would cost model calls on every start.
4. **The merge job's signal is the blocked rename.** The unique index on live glosses makes two live glosses with equal keys impossible, so the only equal-key drift D7 can meet is D6's: the lemma form's citation form equals another live gloss's key. The job looks for exactly that.
5. **The re-key ships the wire's field renames, and the cards follow.** Task 6 renames `sense_id` to `gloss_id` everywhere, including the app and e2e, with lookup and detail cards still one per sense. Task 7 groups them into one card per gloss.
6. **`normaliseGloss` maps a hyphen as well as a maqaf to a space.** The spec's own example, "בית-ספר", uses U+002D.
7. **A photo import's stored options are rewritten to gloss cards by `0023`, and merges leave photo rows alone.** Options are a snapshot; a stale id resolves through `merged_into` when the import is saved.
8. **The results name a practised gloss by its key.** The spec's mobile section says "practised glosses by key", and D11 makes the key a saved word's headline everywhere. A practised row keeps the form the session asked, which its speak button says and `meaning-recall.spec.ts` matches on, and shows the gloss key beside it (Task 7). The missed list still shows each card as it was asked.
9. **The list's headline is the earliest saved gloss.** D11 fixes what the headline shows, the key. Which saved gloss heads a word used to follow the saved rendering's rank, but the new headline reads no rendering, so there is no rank to sort by: the earliest save heads it (Task 7).
10. **ADR 0001's R4 lets `db/cli.ts` import the composition root.** The merge tool's model tier needs a Gemini client, R11 lets only `composition.ts` construct one, and R4 forbids `src/db/` from importing it. The CLI is an entry point, as R7 already says, so R4 gains that one exception (Task 14). A second entry point beside `index.ts` would have needed R7's console exception instead.

## Global Constraints

- **Worktree only.** Work in `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-31-glosses` on branch `phase-31-glosses`, created from `origin/master`, with absolute paths.
  - Never `cd` to or write to `/Users/victorprp/git/lang-tutor` itself (the main checkout).
  - Run `./scripts/setup-worktree.sh` in the worktree before anything else.
  - The spec and this plan are untracked in the main checkout, so a worktree made from `origin/master` lacks them. Copy both into the worktree's `docs/superpowers/specs/` and `docs/superpowers/plans/`, and commit them first, as phase 30 did: `docs(spec): phase 31 glosses design`, then `docs(plan): phase 31 glosses implementation plan`. From then on, read and edit the worktree's copies.
  - Before the first task, create an empty marker file in your scratchpad directory, `<scratchpad>/phase31.marker`. Here and below, `<scratchpad>` is that directory's absolute path, spelled out.
  - After each task, list what changed in the main checkout since the marker: `find /Users/victorprp/git/lang-tutor -path /Users/victorprp/git/lang-tutor/.claude/worktrees -prune -o -name node_modules -prune -o -name .git -prune -o -type f -newer <scratchpad>/phase31.marker -print`. Treat any file it lists as an incident to report. A pull of master in the main checkout lists files too: compare one with `git show origin/master:<path>` and `cmp` before calling it a stray write.
- **This lane has its own ports and database.** Never hardcode a port or a database name (ADR 0006).
  - `npm run test:integration`, `npm run e2e`, `npm run db:migrate` and `npm run server` already go through `scripts/lane-env.sh`.
  - To run ONE integration file, from the worktree root: `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/<path>.test.ts`. Use the `=` form: `--selectProjects integration <file>` swallows the path and runs the whole suite.
  - To run ONE unit file, from the worktree root: `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/<path>.test.ts` (or `-w packages/core`, `-w apps/mobile` with that workspace's path).
  - If `setup-worktree.sh` reports every lane taken, do not free one. Run unit tests, `npm run typecheck`, `npm run lint:arch` and evals locally, leave integration and e2e to CI, and say so in the task report.
- **`node` may be missing from PATH** in a non-interactive shell. Run `export PATH="/opt/homebrew/bin:$PATH"` first.
- **The worktree guard.** A session isolated in a worktree runs under a guard that refuses some shell forms. Write code with the Write and Edit tools, and any script to `<scratchpad>`. The guard refuses:
  - sourcing a file, so call `gh` as `/opt/homebrew/bin/gh` with no `source ~/.zshrc` first;
  - `git -C` on the main checkout;
  - a heredoc whose body holds `${…}` or backticks;
  - a shell variable holding a path, so spell paths out, relative to the worktree root where you can;
  - `npm run eval`, read as shell `eval`: run `npx tsx tests/eval/run.ts <filter>` from `apps/server` instead, with no filter for the whole set. `GEMINI_API_KEY` and `GEMINI_MODEL` come from the login shell;
  - a `git commit` whose paths or message hold the word "eval": `git add` the parent directory and commit with `-F <scratchpad>/message.txt`;
  - `sleep N; …` chains: wait with an `until …; do sleep 5; done` loop run in the background.
- **Master moves.** Before each task, `git fetch origin` and compare `origin/master` with the branch's merge base. If master moved, merge it before the task. If master added a migration whose number one of ours uses: keep master's file and snapshot, delete ours (`.sql`, `meta/00NN_snapshot.json`, its `_journal.json` entry), regenerate ours with the same `npm run db:generate` command its task used, re-apply that task's hand edits, and update the tags in `tests/integration/db/migrations.test.ts`. Then repair the lane database: drop this phase's tables and the stale `drizzle.__drizzle_migrations` rows, and run `npm run db:migrate`. Run `npm install` after any merge.
- **Every ADR in `docs/adr/` binds.** `npm run lint:arch` passes at the end of every task. In particular:
  - ADR 0001: `domain/` is pure; services never import `db/` and import `repo/` as types only; routes never import `db/` or `repo/`; providers are constructed only in `composition.ts` (R11).
  - ADR 0002: factories return closures; no `jest.mock`; no module-level singleton; `process.env` only at a composition root.
  - ADR 0003: every endpoint is a `createRoute`; wire schemas live only in `packages/core/src/api/schemas.ts`; `types.ts` only `z.infer`s.
  - ADR 0007: a job is enqueued only through `repo/jobs.ts`, inside the transaction of the write that makes it necessary; handlers are registered only in `worker.ts`.
- **Migrations.**
  - Generated: `npm run db:generate -w apps/server -- --name <name>`. Hand-written: `npm run db:generate -w apps/server -- --custom --name <name>`, which writes an empty `.sql` and a snapshot of `schema.ts` without asking about renames.
  - After either: `npm run db:check -w apps/server`, then a second `npm run db:generate -w apps/server` must report nothing to generate, and `git status --porcelain apps/server/src/db/migrations` lists only the three files of the first run.
  - SQL functions live in `apps/server/src/db/migrate.ts`, installed with `create or replace` before `migrate()`, never in a migration file.
- **Prompt text.**
  - Keep every marker MockServer matches on: "reusing its sense_code EXACTLY", "which numbered sense", "three wrong answers", "judge the learner's answer", "transcribe the spoken audio".
  - Never add the unquoted substrings `see` or `saw` (`seen`, `seed`, `saws` included). Before adding any illustration word, `grep -rn "matchText\|expectGeminiMatching" apps/server/tests e2e/tests` and make sure no registered pattern occurs in it.
- **Gemini response schemas.** A new field on an LLM schema is `.optional()`, never `.default()`, with no `maxItems`; code caps lists after parsing. After changing an LLM schema, run the live eval for that call before building on it: the provider refuses a response schema with too many states, and MockServer cannot notice (see the comment on `LlmTranslationSchema.entries`).
- **Words.** "Headword's language" is the enrollment's `target_language`; "learner's language" is its `source_language`. New comments never say "source" for the headword's language.
- **No `jest.mock`.** Server fakes go through `apps/server/tests/support/fakes.ts` (`createFakeTransaction`, `stub`, `createFakeDictRepo`, `createFakeJobRepo`); the app takes injected deps.
- **App strings are Hebrew** and live in `apps/mobile/src/strings.ts` only. App code follows `apps/mobile/AGENTS.md`: check any Expo API you have not seen in this repo against https://docs.expo.dev/versions/v57.0.0/.
- **Commits:** conventional style as in `git log` (`feat(server): …`, `test(e2e): …`, `docs: …`). End every commit message with the `Co-Authored-By` line your session's attribution instructions give; today that is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A word saved from an inflected form whose lemma nobody looked up**, such as `to spike`: every later lookup of `spike` must still list every headword, noun and verb. A lemma written for one headword would be a hit forever (D12). Pinned in Task 10: the job's miss path writes the noun and the verb.
2. **A card still on screen after a background merge**, with the old gloss id, or a photo import's snapshot holding one for days: save and unsave must act on the survivor and leave one row. Pinned in Task 9: a save by a forwarded id, and a save racing a merge.
3. **A learner who saved two senses of one gloss before the deploy**, like lane 0's `con`/עם with four senses practised in nine sessions: after the migration they hold one save at each dimension's highest level, and every past session's results still read. Pinned in Task 6's migration test.
4. **Two headwords that share a Hebrew main word, both saved**, like `book` and `order` under להזמין: one session must not ask להזמין twice, and typing `order` on `book`'s typed card is right. Pinned in Task 11.
5. **A model that ignores "one translation"** and returns "קומבינציה, צירוף" or "בסיס (צבאי)" on a new lookup: the write must store a clean translation with the rest as alternatives, so no card or key ever shows a list. Pinned in Task 2's `entriesToRows` test and Task 4's eval case.

---

## File Structure

**packages/core**
- `src/domain/gloss.ts` (+ test): `normaliseGloss` (Task 1). `src/domain/index.ts` exports it.
- `src/api/schemas.ts`, `types.ts`, `index.ts`: the LLM sense and rendering fields (Task 4); every `sense_id` becomes `gloss_id`, and `SenseProgress` becomes `GlossProgress` (Task 6); the gloss cards and `gloss_count` (Task 7).

**apps/server**
- `src/db/migrate.ts`: the `gloss_key` SQL function (Task 2).
- `src/db/schema.ts`: `dictGlosses`, `dictSenseGlosses`, `dictSenses.definition`, `dictVarTranslations.gloss` and `.alternatives` (Task 2); the re-key and `glossProgress` (Task 6); `dictLemmaRenders` (Task 10).
- `src/db/migrations/0022_glosses.sql`, `0023_glosses_rekey.sql`, `0024_lemma_renders.sql`, with `meta/*` (Tasks 2, 6, 10).
- `src/domain/glosses.ts` (+ test): `splitTranslation`, `tidyGlossList` (Task 1); `assignGlosses` (Task 3); `mergeLevels`, `mergeSnapshots`, `keptEntry` (Task 9).
- `src/domain/dictionary.ts`: `entriesToRows` fields (Tasks 2, 4); `SenseRow.glossId` (Task 6); `rowsToCards`, `flattenEntries` by gloss (Task 7).
- `src/domain/translation.ts`: both prompts (Tasks 4, 5).
- `src/domain/vocabulary.ts`: gloss keys (Task 6); `buildWordDetail` by gloss, `gloss_count` (Task 7).
- `src/domain/progress.ts`, `photoImports.ts`, `distractors.ts`, `jobs.ts`, `session.ts`: gloss keys (Task 6); jobs (Tasks 9, 10); `pickGlosses`, `askableRenderings`, siblings (Task 11).
- `src/domain/judge.ts`: D13 (Task 12). `src/domain/senseMatching.ts`: match by key and alternatives (Task 13).
- `src/domain/glossMerge.ts` (+ test): the model tier's prompt and parse (Task 14).
- `src/repo/dictionary.ts`: renderings' fields (Task 2); `writeGlosses`, `lockLexemes` (Task 3); definitions (Tasks 4, 5); `glossId` on rows (Task 6); no row cap, card reads (Task 7); merges and resolution (Task 9); lemma renders (Task 10); renderings and siblings for sessions (Task 11).
- `src/repo/vocabulary.ts`, `progress.ts`, `questions.ts`, `photoImports.ts`: gloss keys (Task 6); list headline and counts, and the results' key (Task 7); judge alternatives (Task 12).
- `src/services/translations.ts`: repair fields (Tasks 2, 3); reconciliation (Task 5); gloss ids (Task 6); cards (Task 7); merge enqueue (Task 9); `renderLemma` (Task 10).
- `src/services/glosses.ts` (new): the merge job (Task 9); the merge tool (Task 14).
- `src/services/vocabulary.ts`, `sessions.ts`, `photoImports.ts`: gloss keys (Task 6); resolution and D14 (Task 9); lemma enqueue (Task 10); D12 and D18 (Task 11).
- `src/db/jobs.ts`, `src/worker.ts`, `src/composition.ts`, `src/db/cli.ts`, `src/db/lemmaRenders.ts` (new): queues, workers, backfill, tools (Tasks 9, 10, 14).
- `src/db/seed.ts`, `progressRecompute.ts` (Task 6); `dictExport.ts`, `dictImport.ts` (Task 14).
- `src/errors.ts`: `GlossLanguageMismatch` (Task 9). `src/routes/*.ts`: gloss fields (Task 6).
- `tests/support/*`: fixtures write glosses (Tasks 2, 3, 6); `holdOpen`, `waitForBlockedQuery` (Task 9).
- `tests/eval/cases.ts`, `run.ts`: new cases (Tasks 4, 5).

**apps/mobile**
- Every `sense_id` becomes `gloss_id` (Task 6). `components/LookupPanel.tsx`, `app/vocabulary/word.tsx`, `app/vocabulary/index.tsx`, `app/photo-imports/[id].tsx`, `src/vocabulary.ts`, `src/strings.ts`: the gloss cards (Tasks 7, 8).

**e2e**
- Three specs' saves (Task 6). `tests/support/mockServer.ts` and `interactions.ts`: a lookup's stub answers only its own text (Task 10). `tests/glosses.spec.ts` (new), `tests/support/lexemes.ts`, `tests/support/sessions.ts` (new) (Task 15).

**docs and scripts**
- `docs/adr/adr-0011-learner-unit-is-the-gloss.md`, `scripts/check-adr-0011-learner-unit-is-the-gloss.sh`, `README.md` (Task 16). The spec (Task 17).
- `package.json` (root and server): `dict:lemmas:render`, `dict:glosses:merge` (Tasks 10, 14).

---

## Part A — The dictionary learns glosses

### Task 1: The two text rules — `normaliseGloss` and `splitTranslation`

**Files:**
- Create: `packages/core/src/domain/gloss.ts`, `packages/core/src/domain/gloss.test.ts`
- Modify: `packages/core/src/domain/index.ts`
- Create: `apps/server/src/domain/glosses.ts`, `apps/server/src/domain/glosses.test.ts`

**Interfaces:**
- Produces: `normaliseGloss(text: string): string`, exported from `@lang-tutor/core/domain`.
- Produces, from `apps/server/src/domain/glosses.ts`: `MAX_GLOSS_ALTERNATIVES = 5`; `splitTranslation(text: string): { translation: string; alternatives: string[] }`; `tidyGlossList(items: readonly string[], main: string, cap?: number): string[]`.

- [ ] **Step 1: Write the failing core test.** Create `packages/core/src/domain/gloss.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { normaliseGloss } from './gloss';

describe('normaliseGloss', () => {
  it.each([
    ['vowelled Hebrew', 'סֵפֶר', 'ספר'],
    ['cantillation and points', 'בְּרֵאשִׁ֖ית', 'בראשית'],
    ['a stressed Russian word', 'молоко́', 'молоко'],
    ['a parenthetical', 'בסיס (צבאי)', 'בסיס'],
    ['double spaces', 'בית   קפה', 'בית קפה'],
    ['mixed case', 'Città', 'città'],
    ['Cyrillic capitals', 'ДОМ', 'дом'],
    ['a maqaf', 'בית־ספר', 'בית ספר'],
    ['a hyphen', 'בית-ספר', 'בית ספר'],
    ['surrounding spaces', '  עכבר ', 'עכבר'],
    ['a decomposed Latin accent, which NFC composes and keeps', 'café', 'café'],
  ])('%s', (_, input, expected) => {
    expect(normaliseGloss(input)).toBe(expected);
  });

  it('makes two spellings of one word one key', () => {
    expect(normaliseGloss('עַכְבָּר')).toBe(normaliseGloss('עכבר'));
  });
});
```

- [ ] **Step 2: Run it and see it fail.** `npm exec -w packages/core -- jest --runTestsByPath src/domain/gloss.test.ts`. Expected: FAIL, `Cannot find module './gloss'`.

- [ ] **Step 3: Write `normaliseGloss`.** Create `packages/core/src/domain/gloss.ts`:

```ts
/**
 * Phase 31 (spec §2, packages/core). When two target words are one key: NFC; a
 * maqaf or a hyphen read as a space; Hebrew points, cantillation and the
 * combining acute of Russian stress removed; a parenthetical dropped; single
 * spaces; trimmed; lower case.
 *
 * One rule for every place that asks: the SQL index (gloss_key in
 * apps/server/src/db/migrate.ts, which must stay character for character the
 * same), the assignment of senses to glosses, the merge signal, a session's
 * siblings and the photo import's sense matcher. The schema integration test
 * runs both over one list. normaliseHebrew and the distractors' `comparable`
 * stay: they compare answers, not keys.
 *
 * The maqaf goes before the point range is stripped, because U+05BE is inside it.
 */
export function normaliseGloss(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[־-]/gu, ' ')
    .replace(/[֑-ׇ́]/gu, '')
    .replace(/\([^)]*\)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}
```

Add to `packages/core/src/domain/index.ts`, beside the other exports:

```ts
export { normaliseGloss } from './gloss';
```

- [ ] **Step 4: Run it and see it pass.** The command of Step 2. Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing server test.** Create `apps/server/src/domain/glosses.test.ts`. The comma lists and parentheticals are every such row on lane 0 (2026-10-09); the compounds are a sample of its 71.

```ts
import { describe, expect, it } from '@jest/globals';

import { splitTranslation, tidyGlossList } from './glosses';

// [stored translation, translation, alternatives]
const COMMA_LISTS: [string, string, string[]][] = [
  ['להימנע מ-, להתחמק מ-', 'להימנע מ-', ['להתחמק מ-']],
  ['שפל, נחות', 'שפל', ['נחות']],
  ['לבסס, להשתית', 'לבסס', ['להשתית']],
  ['בסיס, יסוד', 'בסיס', ['יסוד']],
  ['מאוד, נורא', 'מאוד', ['נורא']],
  ['ארור, מקולל', 'ארור', ['מקולל']],
  ['עקוב מדם, אלים', 'עקוב מדם', ['אלים']],
  ['מדמם, מלא דם', 'מדמם', ['מלא דם']],
  ['קומבינציה, צירוף', 'קומבינציה', ['צירוף']],
  ['שילוב, צירוף', 'שילוב', ['צירוף']],
  ['לשלב, לאחד', 'לשלב', ['לאחד']],
  ['לשלב, להכיל', 'לשלב', ['להכיל']],
  ['להלחין, לחבר', 'להלחין', ['לחבר']],
  ['להרכיב, להוות', 'להרכיב', ['להוות']],
  ['לפתח, לבנות', 'לפתח', ['לבנות']],
  ['לפתח, לרכוש', 'לפתח', ['לרכוש']],
  ['לפתח, ליצור', 'לפתח', ['ליצור']],
  ['רם, חזק', 'רם', ['חזק']],
  ['ראשי, עיקרי', 'ראשי', ['עיקרי']],
  ['צינור ראשי, קו ראשי', 'צינור ראשי', ['קו ראשי']],
  ['להורות, לפקוד', 'להורות', ['לפקוד']],
  ['להשתפר, להתאושש', 'להשתפר', ['להתאושש']],
  ['לקלוט, ללמוד', 'לקלוט', ['ללמוד']],
  ['ראוותנות, מהומה, בלבול', 'ראוותנות', ['מהומה', 'בלבול']],
  ['לבלבל, להרשים בראוותנות', 'לבלבל', ['להרשים בראוותנות']],
  ['לזנק, לעלות בחדות', 'לזנק', ['לעלות בחדות']],
  ['לקבע במסמרים, לתקוע יתד', 'לקבע במסמרים', ['לתקוע יתד']],
  ['לסרב, לדחות', 'לסרב', ['לדחות']],
  ['להנמיך, להפחית', 'להנמיך', ['להפחית']],
  ['טוב, בסדר', 'טוב', ['בסדר']],
];

const PARENTHETICALS: [string, string, string[]][] = [
  ['בסיס (צבאי)', 'בסיס', []],
  ['בסיס (כימיה)', 'בסיס', []],
  ['אח (במסדר דתי)', 'אח', []],
  ['להנחית (כדור בווֹליבול)', 'להנחית', []],
  ['כבד, עשיר (בטעמים)', 'כבד', ['עשיר']],
  // A slash inside the parenthetical must not split.
  ['עמוק, עשיר (בגוון/צליל)', 'עמוק', ['עשיר']],
  ['לסמם (משקה), להוסיף חומר (למשקה)', 'לסמם', ['להוסיף חומר']],
  // A comma inside the parenthetical must not split either.
  ['אח (חבר, רע)', 'אח', []],
];

const WHOLE = ['בית קפה', 'עיר בירה', 'כלי נגינה', 'בלתי אפשרי', 'כיכר תנועה', 'תות שדה', 'בוקר טוב', 'יש לי', 'חסר השכלה', 'לרדת גשם זלעפות', 'to deposit', 'ha scritto'];

describe('splitTranslation', () => {
  it.each([...COMMA_LISTS, ...PARENTHETICALS])('%s', (stored, translation, alternatives) => {
    expect(splitTranslation(stored)).toEqual({ translation, alternatives });
  });

  it.each(WHOLE)('keeps the compound %s whole', (stored) => {
    expect(splitTranslation(stored)).toEqual({ translation: stored, alternatives: [] });
  });

  it('splits on a slash and a semicolon as the sense matcher does', () => {
    expect(splitTranslation('א, ב / ג')).toEqual({ translation: 'א', alternatives: ['ב', 'ג'] });
    expect(splitTranslation('א; ב')).toEqual({ translation: 'א', alternatives: ['ב'] });
  });

  it('drops a repeat of the translation or of another alternative', () => {
    expect(splitTranslation('רם, רָם, חזק, חזק')).toEqual({ translation: 'רם', alternatives: ['חזק'] });
  });

  it('never returns an empty translation', () => {
    expect(splitTranslation('(הערה)')).toEqual({ translation: '(הערה)', alternatives: [] });
  });
});

describe('tidyGlossList', () => {
  it('keeps the first of each key, never the main word, at most the cap', () => {
    expect(tidyGlossList([' רכב ', 'אוטו', 'מכונית', 'רֶכֶב', 'א', 'ב', 'ג', 'ד'], 'מכונית')).toEqual(['רכב', 'אוטו', 'א', 'ב', 'ג']);
  });
});
```

- [ ] **Step 6: Run it and see it fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/glosses.test.ts`. Expected: FAIL, `Cannot find module './glosses'`.

- [ ] **Step 7: Write the two functions.** Create `apps/server/src/domain/glosses.ts`:

```ts
import { normaliseGloss } from '@lang-tutor/core/domain';

/**
 * Phase 31. The pure rules of glosses (spec D4–D7): how a stored translation
 * reads as one translation and its alternatives, which senses of one write share
 * a gloss, and how two glosses fold into one. No I/O (ADR 0001 R3).
 */

/** How many alternatives a rendering or a gloss keeps: enough for "also …" and
 *  the typed-meaning rule, few enough for one line on a card. */
export const MAX_GLOSS_ALTERNATIVES = 5;

const PARENTHETICAL = /\([^)]*\)/gu;
// The marks the photo import's glossesOf splits a printed translation on.
const LIST_MARKS = /[,/;]/u;

const tidy = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * Spec §2, migration step 2, and every write after it. The parentheticals go
 * first, so a comma or a slash inside one never splits: "אח (חבר, רע)" is אח.
 * What is left splits on the list marks; the first item is the translation and
 * the rest are its alternatives. Text that is nothing but a parenthetical stays
 * as it was, so a translation is never empty. 0022_glosses.sql holds the same
 * rule in SQL, and the migration test runs lane 0's shapes through both.
 */
export function splitTranslation(text: string): { translation: string; alternatives: string[] } {
  const items = text
    .replace(PARENTHETICAL, '')
    .split(LIST_MARKS)
    .map(tidy)
    .filter((item) => item.length > 0);
  if (items.length === 0) return { translation: tidy(text), alternatives: [] };
  const [translation, ...rest] = items;
  return { translation, alternatives: tidyGlossList(rest, translation) };
}

/** Distinct by normaliseGloss, never the main word, the first spelling kept, at
 *  most `cap`. */
export function tidyGlossList(items: readonly string[], main: string, cap = MAX_GLOSS_ALTERNATIVES): string[] {
  const seen = new Set([normaliseGloss(main)]);
  const kept: string[] = [];
  for (const raw of items) {
    const item = tidy(raw);
    const key = normaliseGloss(item);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
    if (kept.length === cap) break;
  }
  return kept;
}
```

- [ ] **Step 8: Run it and see it pass.** The command of Step 6. Expected: PASS.

- [ ] **Step 9: Check and commit.** From the worktree root: `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.

```bash
git add packages/core/src/domain/gloss.ts packages/core/src/domain/gloss.test.ts packages/core/src/domain/index.ts apps/server/src/domain/glosses.ts apps/server/src/domain/glosses.test.ts
git commit -m "feat(core): normaliseGloss and splitTranslation, the two text rules of a gloss"
```

---

### Task 2: The dictionary migration — glosses, memberships, clean translations

**Files:**
- Modify: `apps/server/src/db/migrate.ts` (a third SQL function beside `correction_alternatives_valid`)
- Modify: `apps/server/src/db/schema.ts` (`dictSenses`, `dictVarTranslations`; new `dictGlosses`, `dictSenseGlosses` right after `dictVarTranslations`)
- Create: `apps/server/src/db/migrations/0022_glosses.sql` (+ `meta/0022_snapshot.json`, `meta/_journal.json`)
- Modify: `apps/server/src/domain/dictionary.ts` (`SenseToWrite`, `entriesToRows`, `toResponseSense`) and `dictionary.test.ts`
- Modify: `apps/server/src/repo/dictionary.ts` (`RepairedRendering`, step 5 of `persistEntries`, the insert in `repairVariantRenderings`)
- Modify: `apps/server/src/services/translations.ts` (`repairForm` builds its renderings with `renderingOf`)
- Modify: `apps/server/tests/support/dictRows.ts` (`SeedTranslation.gloss`, `.alternatives`)
- Modify: `apps/server/tests/integration/db/migrations.test.ts`, `tests/integration/db/schema.test.ts`, `tests/integration/repo/vocabulary.plan.test.ts`
- Modify: `apps/server/tests/integration/repo/dictionary.stale.test.ts`, `tests/integration/repo/dictionary.renderings.test.ts`, `tests/integration/repo/vocabulary.test.ts` (their `repairVariantRenderings` senses carry the new fields)

**Interfaces:**
- Consumes: `normaliseGloss` (core), `splitTranslation` (Task 1).
- Produces: the SQL function `gloss_key(text) returns text`, immutable, the twin of `normaliseGloss`.
- Produces, in `schema.ts`: `dictGlosses` (`id`, `lexemeId`, `userLanguageCode`, `key`, `alternatives`, `mergedInto`, `createdAt`), `dictSenseGlosses` (`senseId`, `lexemeId`, `userLanguageCode`, `glossId`), `dictSenses.definition`, `dictVarTranslations.gloss` (NOT NULL) and `.alternatives`.
- Produces, in `domain/dictionary.ts`: `SenseToWrite` gains `alternatives: string[]`, `gloss: string`, `glossAlternatives: string[]`, `definition: string | null`; `type Rendering = Omit<SenseToWrite, 'senseCode'>`; `renderingOf(sense: { translation: string; example?: { source: string; target: string } }, rank: number): Rendering`.
- Produces, in `repo/dictionary.ts`: `RepairedRendering = Rendering & { senseId: string }`.
- Produces, in `tests/support/dictRows.ts`: `SeedTranslation` gains optional `gloss?: string` and `alternatives?: string[]`.

- [ ] **Step 1: Write the failing migration tests.** Append to `apps/server/tests/integration/db/migrations.test.ts`, and add `import { splitTranslation } from '../../../src/domain/glosses';` to its imports:

```ts
// Lane 0's shapes (Task 1's unit test holds their expected values): every comma
// list, every parenthetical, a sample of compounds, and the edge cases.
const TRANSLATION_SHAPES = [
  'להימנע מ-, להתחמק מ-', 'שפל, נחות', 'לבסס, להשתית', 'בסיס, יסוד', 'מאוד, נורא', 'ארור, מקולל',
  'עקוב מדם, אלים', 'מדמם, מלא דם', 'קומבינציה, צירוף', 'שילוב, צירוף', 'לשלב, לאחד', 'לשלב, להכיל',
  'להלחין, לחבר', 'להרכיב, להוות', 'לפתח, לבנות', 'לפתח, לרכוש', 'לפתח, ליצור', 'רם, חזק', 'ראשי, עיקרי',
  'צינור ראשי, קו ראשי', 'להורות, לפקוד', 'להשתפר, להתאושש', 'לקלוט, ללמוד', 'ראוותנות, מהומה, בלבול',
  'לבלבל, להרשים בראוותנות', 'לזנק, לעלות בחדות', 'לקבע במסמרים, לתקוע יתד', 'לסרב, לדחות',
  'להנמיך, להפחית', 'טוב, בסדר', 'בסיס (צבאי)', 'בסיס (כימיה)', 'אח (במסדר דתי)', 'להנחית (כדור בווֹליבול)',
  'כבד, עשיר (בטעמים)', 'עמוק, עשיר (בגוון/צליל)', 'לסמם (משקה), להוסיף חומר (למשקה)', 'אח (חבר, רע)',
  'בית קפה', 'בלתי אפשרי', 'to deposit', 'ha scritto', 'א, ב / ג', 'רם, רָם, חזק, חזק', '(הערה)',
];

describe('0022_glosses', () => {
  it('cleans every rendering and gives every rendered sense one gloss per learner language', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0021_enrollment_grants'));
    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech) values
        ('l_mouse', 'en', 'mouse', 'noun'), ('l_car', 'en', 'car', 'noun'), ('l_finger', 'en', 'finger', 'noun'),
        ('l_base', 'en', 'base', 'noun'), ('l_comb', 'en', 'combination', 'noun'), ('l_window', 'he', 'חלון', 'noun');
      insert into dict_senses (id, lexeme_id, sense_code) values
        ('s_rodent', 'l_mouse', 'rodent'), ('s_device', 'l_mouse', 'device'), ('s_vehicle', 'l_car', 'vehicle'),
        ('s_body', 'l_finger', 'body_part'), ('s_military', 'l_base', 'military'), ('s_chemistry', 'l_base', 'chemistry'),
        ('s_lock', 'l_comb', 'lock_code'), ('s_mix', 'l_comb', 'mixture'), ('s_window', 'l_window', 'opening');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank) values
        ('v_mouse', 'l_mouse', 'en', 'mouse', 'word', 0), ('v_car', 'l_car', 'en', 'car', 'word', 0),
        ('v_cars', 'l_car', 'en', 'cars', 'word', 0), ('v_fingers', 'l_finger', 'en', 'fingers', 'word', 0),
        ('v_base', 'l_base', 'en', 'base', 'word', 0), ('v_comb', 'l_comb', 'en', 'combination', 'word', 0),
        ('v_window', 'l_window', 'he', 'חלון', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank) values
        ('v_mouse', 's_rodent', 'he', 'עכבר', 0), ('v_mouse', 's_device', 'he', 'עַכְבָּר', 1),
        ('v_car', 's_vehicle', 'he', 'מכונית, רכב', 0), ('v_cars', 's_vehicle', 'he', 'מכוניות, רכבים', 0),
        ('v_fingers', 's_body', 'he', 'אצבעות', 0),
        ('v_base', 's_military', 'he', 'בסיס (צבאי)', 0), ('v_base', 's_chemistry', 'he', 'בסיס (כימיה)', 1),
        ('v_comb', 's_lock', 'he', 'קומבינציה, צירוף', 0), ('v_comb', 's_mix', 'he', 'שילוב, צירוף', 1),
        ('v_window', 's_window', 'en', 'window', 0), ('v_window', 's_window', 'ru', 'окно', 0);
    `);

    await runMigrations(db);

    const renderings = await db.execute<{ variant_id: string; sense_id: string; translation: string; gloss: string; alternatives: string[] }>(sql`
      select variant_id, sense_id, translation, gloss, alternatives from dict_var_translations
      where user_language_code = 'he' and variant_id in ('v_car', 'v_cars', 'v_base') order by variant_id, sense_id`);
    expect(renderings.rows).toEqual([
      { variant_id: 'v_base', sense_id: 's_chemistry', translation: 'בסיס', gloss: 'בסיס', alternatives: [] },
      { variant_id: 'v_base', sense_id: 's_military', translation: 'בסיס', gloss: 'בסיס', alternatives: [] },
      { variant_id: 'v_car', sense_id: 's_vehicle', translation: 'מכונית', gloss: 'מכונית', alternatives: ['רכב'] },
      { variant_id: 'v_cars', sense_id: 's_vehicle', translation: 'מכוניות', gloss: 'מכוניות', alternatives: ['רכבים'] },
    ]);

    const glosses = await db.execute<{ lemma: string; lang: string; key: string; alternatives: string[]; members: string[] }>(sql`
      select l.lemma, g.user_language_code as lang, g.key, g.alternatives,
             array_agg(m.sense_id order by m.sense_id) as members
      from dict_glosses g join dict_lexemes l on l.id = g.lexeme_id
      join dict_sense_glosses m on m.gloss_id = g.id
      group by l.lemma, g.user_language_code, g.key, g.alternatives
      order by l.lemma, g.user_language_code, g.key`);
    expect(glosses.rows).toEqual([
      // The parenthetical was the only difference: one target word, one gloss (D3).
      { lemma: 'base', lang: 'he', key: 'בסיס', alternatives: [], members: ['s_chemistry', 's_military'] },
      // Keyed from the lemma form, whose alternative it keeps; `cars`' plural is not a citation form.
      { lemma: 'car', lang: 'he', key: 'מכונית', alternatives: ['רכב'], members: ['s_vehicle'] },
      { lemma: 'combination', lang: 'he', key: 'קומבינציה', alternatives: ['צירוף'], members: ['s_lock'] },
      { lemma: 'combination', lang: 'he', key: 'שילוב', alternatives: ['צירוף'], members: ['s_mix'] },
      // Only an inflected form was ever rendered: the key is inflected until D6 renames it.
      { lemma: 'finger', lang: 'he', key: 'אצבעות', alternatives: [], members: ['s_body'] },
      // Spelled as the lowest-ranked member wrote it.
      { lemma: 'mouse', lang: 'he', key: 'עכבר', alternatives: [], members: ['s_device', 's_rodent'] },
      // One sense, two learner languages, two glosses (D1).
      { lemma: 'חלון', lang: 'en', key: 'window', alternatives: [], members: ['s_window'] },
      { lemma: 'חלון', lang: 'ru', key: 'окно', alternatives: [], members: ['s_window'] },
    ]);

    const counts = await db.execute<{ rendered: number; memberships: number }>(sql`
      select (select count(distinct (sense_id, user_language_code)) from dict_var_translations)::int as rendered,
             (select count(*) from dict_sense_glosses)::int as memberships`);
    expect(counts.rows[0].memberships).toBe(counts.rows[0].rendered);
  });

  it("cleans lane 0's translation shapes exactly as splitTranslation does", async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0021_enrollment_grants'));
    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech) values ('l_shapes', 'en', 'shapes', 'noun');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v_shapes', 'l_shapes', 'en', 'shapes', 'word', 0);
    `);
    for (const [rank, shape] of TRANSLATION_SHAPES.entries()) {
      await db.execute(sql`insert into dict_senses (id, lexeme_id, sense_code) values (${`s${rank}`}, 'l_shapes', ${`code_${rank}`})`);
      await db.execute(sql`insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v_shapes', ${`s${rank}`}, 'he', ${shape}, ${rank})`);
    }

    await runMigrations(db);

    const rows = await db.execute<{ sense_id: string; translation: string; alternatives: string[] }>(
      sql`select sense_id, translation, alternatives from dict_var_translations where variant_id = 'v_shapes'`,
    );
    for (const [rank, shape] of TRANSLATION_SHAPES.entries()) {
      const row = rows.rows.find((r) => r.sense_id === `s${rank}`)!;
      expect({ shape, translation: row.translation, alternatives: row.alternatives }).toEqual({ shape, ...splitTranslation(shape) });
    }
  });
});
```

- [ ] **Step 2: Write the failing schema tests.** In `apps/server/tests/integration/db/schema.test.ts`, add `'dict_glosses'` and `'dict_sense_glosses'` to `TABLES`, add `import { normaliseGloss } from '@lang-tutor/core/domain';`, and append inside `describe('the migrated schema', …)`:

```ts
  // Phase 31. The SQL twin of normaliseGloss is what the unique index runs on,
  // so a disagreement would let the database and the domain call two keys equal
  // differently. The list is the core test's, plus a tab.
  it('runs gloss_key exactly as normaliseGloss', async () => {
    const cases = ['סֵפֶר', 'בְּרֵאשִׁ֖ית', 'молоко́', 'בסיס (צבאי)', 'בית   קפה', 'Città', 'ДОМ', 'בית־ספר', 'בית-ספר', '  עכבר ', 'café', 'עַכְבָּר', 'Tab\there'];
    for (const text of cases) {
      const rows = await db.execute<{ key: string }>(sql`select gloss_key(${text}) as key`);
      expect({ text, key: rows.rows[0].key }).toEqual({ text, key: normaliseGloss(text) });
    }
  });

  it('refuses a second live gloss with one normalised key, and allows it once the first is forwarded', async () => {
    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech) values ('gl-mouse', 'en', 'mouse', 'noun');
      insert into dict_glosses (id, lexeme_id, user_language_code, key) values ('gl-1', 'gl-mouse', 'he', 'עכבר'), ('gl-2', 'gl-mouse', 'he', 'חולדה');
    `);
    const second = sql`insert into dict_glosses (id, lexeme_id, user_language_code, key) values ('gl-3', 'gl-mouse', 'he', 'עַכְבָּר')`;
    await expect(db.execute(second)).rejects.toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('dict_glosses_live_key') }) }),
    );
    await db.execute(sql`update dict_glosses set merged_into = 'gl-2' where id = 'gl-1'`);
    await db.execute(second);
  });

  it("refuses a membership in another lexeme's gloss", async () => {
    await db.execute(sql`
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('gm-noun', 'en', 'stream', 'noun'), ('gm-verb', 'en', 'stream', 'verb');
      insert into dict_senses (id, lexeme_id, sense_code) values ('gm-s', 'gm-noun', 'current');
      insert into dict_glosses (id, lexeme_id, user_language_code, key) values ('gm-g', 'gm-verb', 'he', 'לזרום');
    `);
    await expect(
      db.execute(sql`insert into dict_sense_glosses (sense_id, lexeme_id, user_language_code, gloss_id) values ('gm-s', 'gm-noun', 'he', 'gm-g')`),
    ).rejects.toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('dict_sense_glosses_gloss_fk') }) }),
    );
  });
```

Every raw `insert into dict_var_translations` already in this file gains a `gloss` column with the same value as `translation`.

- [ ] **Step 3: Run them and see them fail.** `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/db/migrations.test.ts tests/integration/db/schema.test.ts`. Expected: FAIL, with `function gloss_key(unknown) does not exist` and `relation "dict_glosses" does not exist`.

- [ ] **Step 4: Add `gloss_key` to `migrate.ts`.** Below `CORRECTION_ALTERNATIVES_FUNCTION`:

```ts
// Phase 31 (spec §2). The SQL twin of normaliseGloss in packages/core, which the
// unique index on live glosses and the migrations run on. Here for the reason the
// two above give. String.raw keeps the regex backslashes for Postgres: a template
// literal would turn ־ into the character and \s into a bare s.
//
// It must stay character for character the same as normaliseGloss: the schema
// integration test runs both over one list. Changing it needs a migration that
// REINDEXes dict_glosses_live_key and dict_glosses_language_key_idx.
const GLOSS_KEY_FUNCTION = sql.raw(String.raw`
  create or replace function gloss_key(t text) returns text
    language sql immutable parallel safe as $$
    select lower(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
             normalize(t, NFC),
             '[־-]', ' ', 'g'),
             '[֑-ׇ́]', '', 'g'),
             '\([^)]*\)', '', 'g'),
             '\s+', ' ', 'g')))
  $$;
`);
```

and in `runMigrationsFrom`, after the second `db.execute`: `await db.execute(GLOSS_KEY_FUNCTION);`.

- [ ] **Step 5: The schema.** In `apps/server/src/db/schema.ts`:

`dictSenses` gains a column and a unique key:

```ts
    // Phase 31 (spec D9). One short phrase in the headword's language: the handle
    // a learner language with no renderings yet reconciles against. Written by
    // the call that names the sense; null for a sense written before the phase
    // until a lookup touches it. Never shown to a learner.
    definition: text('definition'),
```

```ts
  (t) => [
    unique('dict_senses_lexeme_code_key').on(t.lexemeId, t.senseCode),
    // Phase 31. The target of dict_sense_glosses' composite foreign key, which is
    // what makes Postgres hold "a sense and its gloss share a lexeme".
    unique('dict_senses_id_lexeme_key').on(t.id, t.lexemeId),
  ],
```

`dictVarTranslations` gains two columns, after `translation`:

```ts
    // Phase 31 (spec D6). The citation form the model gave this rendering's
    // sense, uninflected: `fingers` renders אצבעות and records אצבע here. A
    // session asks this form only while it agrees with its gloss's key (D12).
    gloss: text('gloss').notNull(),
    // Phase 31 (spec D5). The sense's other target words in this form's
    // inflection: the lookup card's "also …", and right answers to a meaning
    // card built on this form (D13). Never more than five (tidyGlossList).
    alternatives: text('alternatives').array().notNull().default(sql`'{}'::text[]`),
```

Two new tables, right after `dictVarTranslations`:

```ts
/**
 * Phase 31 (spec D1, D2, D7). A gloss: one target word of one lexeme in one
 * learner language, and what a learner saves, levels and practises. Its senses
 * are in dict_sense_glosses; a sense has one gloss per language, so `mouse`'s two
 * senses are one gloss for Hebrew and would be two for Italian.
 *
 * `key` is the target word's citation form as the model wrote it. Two live
 * glosses of one lexeme and language never share a normalised key
 * (dict_glosses_live_key, on gloss_key(), the SQL twin of normaliseGloss).
 * `alternatives` are the sense's other target words, in citation form.
 *
 * `merged_into` is set when a merge folded this gloss into another (D7). The row
 * stays, so an id still on a learner's screen or in a photo import's snapshot
 * resolves to its survivor, and every read of live glosses skips it.
 */
export const dictGlosses = pgTable(
  'dict_glosses',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    lexemeId: text('lexeme_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    key: text('key').notNull(),
    alternatives: text('alternatives').array().notNull().default(sql`'{}'::text[]`),
    mergedInto: text('merged_into'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'dict_glosses_lexeme_fk', columns: [t.lexemeId], foreignColumns: [dictLexemes.id] }).onDelete('cascade'),
    foreignKey({ name: 'dict_glosses_merged_into_fk', columns: [t.mergedInto], foreignColumns: [t.id] }),
    // The target of the composite keys that tie a membership and an entry to
    // their gloss's lexeme: phase 21's dict_lexemes_id_lemma_key trick.
    unique('dict_glosses_id_lexeme_key').on(t.id, t.lexemeId),
    uniqueIndex('dict_glosses_live_key')
      .on(t.lexemeId, t.userLanguageCode, sql`gloss_key(${t.key})`)
      .where(sql`${t.mergedInto} is null`),
    // Spec D18: a session's siblings are the live glosses of other lexemes with
    // one key in one language. Without it that read scans the table.
    index('dict_glosses_language_key_idx')
      .on(t.userLanguageCode, sql`gloss_key(${t.key})`)
      .where(sql`${t.mergedInto} is null`),
    check('dict_glosses_not_self', sql`${t.mergedInto} is null or ${t.mergedInto} <> ${t.id}`),
  ],
);

/**
 * Phase 31 (spec D1, D6, D8). Which gloss a sense belongs to in one learner
 * language. Written by the lookup and the repair in the transaction of the
 * rendering it comes with, and before that rendering (D8). The first rendering in
 * a language decides, and only a merge moves a membership (D6, D7).
 *
 * `lexeme_id` is here so both composite keys can hold "a sense and its gloss
 * share a lexeme": a noun's sense never joins a verb's gloss.
 */
export const dictSenseGlosses = pgTable(
  'dict_sense_glosses',
  {
    senseId: text('sense_id').notNull(),
    lexemeId: text('lexeme_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    glossId: text('gloss_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'dict_sense_glosses_pkey', columns: [t.senseId, t.userLanguageCode] }),
    foreignKey({
      name: 'dict_sense_glosses_sense_fk',
      columns: [t.senseId, t.lexemeId],
      foreignColumns: [dictSenses.id, dictSenses.lexemeId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'dict_sense_glosses_gloss_fk',
      columns: [t.glossId, t.lexemeId],
      foreignColumns: [dictGlosses.id, dictGlosses.lexemeId],
    }).onDelete('cascade'),
    // A gloss's members, for a session's renderings (D12) and a merge.
    index('dict_sense_glosses_gloss_idx').on(t.glossId),
    // A lexeme's memberships in one language, for the write's gloss step.
    index('dict_sense_glosses_lexeme_idx').on(t.lexemeId, t.userLanguageCode),
  ],
);
```

- [ ] **Step 6: Generate the migration, then make it backfill.** From the worktree root: `npm run db:generate -w apps/server -- --name glosses`. Expected: `0022_glosses.sql`, `meta/0022_snapshot.json` and a `_journal.json` entry. Open the SQL and make four edits, keeping drizzle's `--> statement-breakpoint` separators:

1. Put this comment at the top:

```sql
-- Phase 31 (spec §2, migration steps 1-3). The dictionary side of glosses:
-- one gloss per (lexeme, learner language, target word), one membership per
-- rendered sense, and one translation per rendering. Learner tables are
-- re-keyed in 0023_glosses_rekey; drizzle applies both in one transaction.
```

2. Replace `ALTER TABLE "dict_var_translations" ADD COLUMN "gloss" text NOT NULL;` with `ALTER TABLE "dict_var_translations" ADD COLUMN "gloss" text;`.
3. Make sure `ALTER TABLE "dict_senses" ADD CONSTRAINT "dict_senses_id_lexeme_key" UNIQUE("id","lexeme_id");` comes **before** the statement adding `dict_sense_glosses_sense_fk`, which needs it. Move it up if drizzle put it later.
4. Append, after drizzle's last statement:

```sql
--> statement-breakpoint
-- Step 2. One translation per rendering. Parentheticals go first, then the list
-- marks split; the first item is the translation and the gloss, the next five
-- distinct by gloss_key the alternatives. The SQL twin of splitTranslation in
-- domain/glosses.ts; the migration test runs lane 0's shapes through both.
UPDATE "dict_var_translations" tr
SET "translation" = c."items"[1],
    "gloss" = c."items"[1],
    "alternatives" = ARRAY(
      SELECT d."item" FROM (
        SELECT DISTINCT ON (gloss_key(x."item")) x."item", x."n"
        FROM unnest(c."items"[2:]) WITH ORDINALITY AS x("item", "n")
        WHERE gloss_key(x."item") <> gloss_key(c."items"[1]) AND gloss_key(x."item") <> ''
        ORDER BY gloss_key(x."item"), x."n"
      ) d
      ORDER BY d."n"
      LIMIT 5
    )
FROM (
  SELECT t."variant_id", t."sense_id", t."user_language_code",
         ARRAY(
           SELECT btrim(regexp_replace(u."item", '\s+', ' ', 'g'))
           FROM unnest(regexp_split_to_array(regexp_replace(t."translation", '\([^)]*\)', '', 'g'), '[,/;]'))
                WITH ORDINALITY AS u("item", "n")
           WHERE btrim(regexp_replace(u."item", '\s+', ' ', 'g')) <> ''
           ORDER BY u."n"
         ) AS "items"
  FROM "dict_var_translations" t
) c
WHERE tr."variant_id" = c."variant_id" AND tr."sense_id" = c."sense_id"
  AND tr."user_language_code" = c."user_language_code" AND cardinality(c."items") > 0;--> statement-breakpoint
-- A translation that was nothing but a parenthetical stays, tidied.
UPDATE "dict_var_translations"
SET "translation" = btrim(regexp_replace("translation", '\s+', ' ', 'g')),
    "gloss" = btrim(regexp_replace("translation", '\s+', ' ', 'g'))
WHERE "gloss" IS NULL;--> statement-breakpoint
ALTER TABLE "dict_var_translations" ALTER COLUMN "gloss" SET NOT NULL;--> statement-breakpoint
-- Step 3. One gloss per (lexeme, learner language, key). A sense's key is the
-- translation of its lemma-form rendering in that language, else of its
-- lowest-ranked rendering; the gloss is spelled as its lowest-ranked member wrote it.
INSERT INTO "dict_glosses" ("lexeme_id", "user_language_code", "key")
SELECT DISTINCT ON (k."lexeme_id", k."user_language_code", gloss_key(k."key"))
       k."lexeme_id", k."user_language_code", k."key"
FROM (
  SELECT DISTINCT ON (s."id", tr."user_language_code")
         s."id" AS "sense_id", s."lexeme_id", tr."user_language_code", tr."translation" AS "key", tr."rank"
  FROM "dict_senses" s
  JOIN "dict_var_translations" tr ON tr."sense_id" = s."id"
  JOIN "dict_variants" v ON v."id" = tr."variant_id"
  JOIN "dict_lexemes" l ON l."id" = s."lexeme_id"
  ORDER BY s."id", tr."user_language_code", (lower(v."form") = lower(l."lemma")) DESC, tr."rank", v."id"
) k
ORDER BY k."lexeme_id", k."user_language_code", gloss_key(k."key"), k."rank", k."sense_id";--> statement-breakpoint
INSERT INTO "dict_sense_glosses" ("sense_id", "lexeme_id", "user_language_code", "gloss_id")
SELECT k."sense_id", k."lexeme_id", k."user_language_code", g."id"
FROM (
  SELECT DISTINCT ON (s."id", tr."user_language_code")
         s."id" AS "sense_id", s."lexeme_id", tr."user_language_code", tr."translation" AS "key"
  FROM "dict_senses" s
  JOIN "dict_var_translations" tr ON tr."sense_id" = s."id"
  JOIN "dict_variants" v ON v."id" = tr."variant_id"
  JOIN "dict_lexemes" l ON l."id" = s."lexeme_id"
  ORDER BY s."id", tr."user_language_code", (lower(v."form") = lower(l."lemma")) DESC, tr."rank", v."id"
) k
JOIN "dict_glosses" g ON g."lexeme_id" = k."lexeme_id" AND g."user_language_code" = k."user_language_code"
                     AND gloss_key(g."key") = gloss_key(k."key");--> statement-breakpoint
-- A gloss's alternatives: its members' lemma-form alternatives, distinct by
-- gloss_key, never its key, at most five (spec §2, step 3).
UPDATE "dict_glosses" g
SET "alternatives" = ARRAY(
  SELECT d."alt" FROM (
    SELECT DISTINCT ON (gloss_key(a."alt")) a."alt", a."rank"
    FROM (
      SELECT x."alt", tr."rank"
      FROM "dict_sense_glosses" m
      JOIN "dict_var_translations" tr ON tr."sense_id" = m."sense_id" AND tr."user_language_code" = m."user_language_code"
      JOIN "dict_variants" v ON v."id" = tr."variant_id"
      JOIN "dict_lexemes" l ON l."id" = v."lexeme_id" AND lower(v."form") = lower(l."lemma")
      CROSS JOIN LATERAL unnest(tr."alternatives") AS x("alt")
      WHERE m."gloss_id" = g."id"
    ) a
    WHERE gloss_key(a."alt") <> gloss_key(g."key")
    ORDER BY gloss_key(a."alt"), a."rank"
  ) d
  ORDER BY d."rank"
  LIMIT 5
);
```

Then `npm run db:check -w apps/server` (expected: no errors), `npm run db:generate -w apps/server` (expected: nothing to generate) and `git status --porcelain apps/server/src/db/migrations` (expected: the three files only).

- [ ] **Step 7: Make every writer of renderings write `gloss` and `alternatives`.**

In `apps/server/src/domain/dictionary.ts`, import `{ splitTranslation } from './glosses'`, replace `SenseToWrite` and `entriesToRows`, and add `Rendering` and `renderingOf`:

```ts
export type SenseToWrite = {
  rank: number;
  senseCode: string;
  /** Phase 31. One translation, never a list (splitTranslation). */
  translation: string;
  /** Phase 31 (spec D5). The sense's other target words in this form's inflection. */
  alternatives: string[];
  /** Phase 31 (spec D6). The translation's citation form: the translation itself
   *  until the prompt asks the model for one. */
  gloss: string;
  /** Phase 31 (spec D5). The alternatives' citation forms, for the gloss. */
  glossAlternatives: string[];
  /** Phase 31 (spec D9). */
  definition: string | null;
  exampleSource: string | null;
  exampleTarget: string | null;
};

/** One rendering as every writer stores it; the lookup adds the sense code. */
export type Rendering = Omit<SenseToWrite, 'senseCode'>;

/**
 * Phase 31. A model's sense as every writer stores it: one clean translation and
 * the rest of any list as alternatives, so a model that ignores "one
 * translation" still never puts a list on a card (Review Focus 5). The lookup
 * and the repair both call it.
 */
export function renderingOf(
  sense: { translation: string; example?: { source: string; target: string } },
  rank: number,
): Rendering {
  const { translation, alternatives } = splitTranslation(sense.translation);
  return {
    rank,
    translation,
    alternatives,
    gloss: translation,
    glossAlternatives: [],
    definition: null,
    exampleSource: sense.example?.source ?? null,
    exampleTarget: sense.example?.target ?? null,
  };
}

export function entriesToRows(entries: LlmEntry[]): EntryRows[] {
  return entries.map((entry, entryRank) => ({
    lemma: entry.lemma,
    partOfSpeech: entry.part_of_speech,
    entryRank,
    senses: entry.senses.map((sense, rank) => ({ senseCode: sense.sense_code, ...renderingOf(sense, rank) })),
  }));
}
```

Keep the existing comment above `entriesToRows`. In `toResponseSense`, write `translation: splitTranslation(sense.translation).translation`, so the paths that do not write answer as the write would.

In `apps/server/src/repo/dictionary.ts`, import `type Rendering` from `../domain/dictionary`, and replace `RepairedRendering`:

```ts
/** One rendering a repair produces: what the lookup writes, by sense id. */
export type RepairedRendering = Rendering & { senseId: string };
```

The three test files that call `repairVariantRenderings` directly (`tests/integration/repo/dictionary.stale.test.ts`, `dictionary.renderings.test.ts` and `vocabulary.test.ts`) build its senses as literals: give each the four new fields, `alternatives: []`, `gloss` equal to its `translation`, `glossAlternatives: []` and `definition: null`.

In `persistEntries` step 5 and in `repairVariantRenderings`' insert, add to each row:

```ts
            gloss: sense.gloss,
            alternatives: sense.alternatives,
```

In `apps/server/src/services/translations.ts`, `repairForm` builds each rendering with the domain function instead of field by field (import `renderingOf` from `../domain/dictionary`):

```ts
        senses.push({
          senseId: idByCode.get(rendering.sense_code)!,
          // Re-sequenced from 0 and contiguous, never the model's index:
          // UNIQUE(variant_id, user_language_code, rank) rejects a hole.
          // The spread restates the narrowing the null filter above made.
          ...renderingOf({ ...rendering, translation: rendering.translation }, senses.length),
        });
```

In `apps/server/tests/support/dictRows.ts`, `SeedTranslation` gains two optional fields:

```ts
  /** Phase 31. The citation form; the translation when omitted. */
  gloss?: string;
  /** Phase 31. The rendering's alternatives; none when omitted. */
  alternatives?: string[];
```

and its insert writes them:

```ts
          gloss: translation.gloss ?? translation.translation,
          alternatives: translation.alternatives ?? [],
```

In `apps/server/tests/integration/repo/vocabulary.plan.test.ts`, the renderings statement of `LOAD` becomes:

```ts
    `insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, gloss, rank)
       select 'pv' || g, 'ps' || g, 'he', 'מילה' || g, 'מילה' || g, 0 from generate_series(1, 20000) g`,
```

- [ ] **Step 8: Pin the write's cleaning (Review Focus 5).** Append to `apps/server/src/domain/dictionary.test.ts` (import `entriesToRows` if it is not imported yet):

```ts
describe('entriesToRows (phase 31)', () => {
  it('writes one clean translation and keeps the rest of a list as alternatives', () => {
    const [row] = entriesToRows([
      {
        lemma: 'combination',
        part_of_speech: 'noun',
        senses: [
          { translation: 'קומבינציה, צירוף', sense_code: 'lock_code' },
          { translation: 'שילוב (של דברים)', sense_code: 'mixture' },
        ],
      },
    ]);
    expect(row.senses.map(({ translation, alternatives, gloss }) => ({ translation, alternatives, gloss }))).toEqual([
      { translation: 'קומבינציה', alternatives: ['צירוף'], gloss: 'קומבינציה' },
      { translation: 'שילוב', alternatives: [], gloss: 'שילוב' },
    ]);
  });
});
```

- [ ] **Step 9: Run everything this task touched.** From the worktree root: `npm run typecheck`, then `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/dictionary.test.ts src/domain/glosses.test.ts`, then `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/db/migrations.test.ts tests/integration/db/schema.test.ts tests/integration/repo/dictionary.test.ts tests/integration/repo/dictionary.stale.test.ts tests/integration/repo/dictionary.renderings.test.ts`. Expected: PASS. Then `npm test && npm run test:integration && npm run lint:arch`. Expected: PASS.

- [ ] **Step 10: Migrate the lane and commit.** `npm run db:migrate`. Expected: `migrated and seeded`.

```bash
git add apps/server/src/db apps/server/src/domain/dictionary.ts apps/server/src/domain/dictionary.test.ts apps/server/src/repo/dictionary.ts apps/server/src/services/translations.ts apps/server/tests
git commit -m "feat(server): glosses beside senses — one gloss per target word, and one translation per rendering"
```

---

### Task 3: `assignGlosses` — every rendered sense gets its gloss, from both writers

**Files:**
- Modify: `apps/server/src/domain/glosses.ts`, `glosses.test.ts`
- Modify: `apps/server/src/repo/dictionary.ts` (`lockLexemes`, `writeGlosses`, `persistEntries`, `repairVariantRenderings`)
- Modify: `apps/server/src/services/translations.ts` (`repairForm`'s write)
- Modify: `apps/server/tests/support/dictRows.ts` (`insertLexeme` writes glosses), `apps/server/tests/support/fakes.ts`
- Create: `apps/server/tests/integration/repo/dictionary.glosses.test.ts`
- Modify: `apps/server/tests/integration/repo/dictionary.stale.test.ts`, `tests/integration/repo/dictionary.renderings.test.ts`, `tests/integration/repo/vocabulary.test.ts` (their repairs pass the new input and hold the lock)

**Interfaces:**
- Consumes: `normaliseGloss`, `tidyGlossList`, the tables of Task 2.
- Produces, in `domain/glosses.ts`:
  - `type AnswerSense = { senseId: string; gloss: string; glossAlternatives: readonly string[] }`
  - `type LiveGloss = { id: string; key: string; alternatives: readonly string[] }`
  - `type GlossPlan = { create: { key: string; alternatives: string[]; senseIds: string[] }[]; join: { senseId: string; glossId: string }[]; alternatives: { glossId: string; alternatives: string[] }[]; rename: { glossId: string; key: string }[]; needsMerge: boolean }`
  - `assignGlosses(input: { senses: readonly AnswerSense[]; lemmaForm: boolean; glosses: readonly LiveGloss[]; memberships: ReadonlyMap<string, string> }): GlossPlan`
- Produces, in `repo/dictionary.ts`:
  - `type MergePair = { lexemeId: string; userLanguageCode: string }`
  - `lockLexemes(lexemeIds: string[]): Promise<void>`
  - `PersistedEntry.glossIds: string[]` (aligned with `senseIds`)
  - `persistEntries(...)` returns `{ written: PersistedEntry[]; senses: TranslationSense[]; mergePairs: MergePair[] }`
  - `repairVariantRenderings(input: { variantId: string; lexemeId: string; userLanguageCode: string; senseVersion: number; lemmaForm: boolean; senses: RepairedRendering[] }): Promise<{ needsMerge: boolean }>`; the caller holds `lockLexemes`.
- Produces, in `tests/support/dictRows.ts`: `insertLexeme` returns `glossIds: string[]` aligned with `senseIds` (`''` for a sense with no rendering).
- Produces, in `tests/support/fakes.ts`: `FakeDictRepo.mergePairs: MergePair[]` (default `[]`), returned by `persistEntries`.

- [ ] **Step 1: Write the failing unit tests.** Append to `apps/server/src/domain/glosses.test.ts`, and import `assignGlosses`:

```ts
const sense = (senseId: string, gloss: string, glossAlternatives: string[] = []) => ({ senseId, gloss, glossAlternatives });
const none = new Map<string, string>();

describe('assignGlosses (spec D6, D7)', () => {
  it('keeps an existing membership whatever this form says the sense is', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'מכרסם')],
      lemmaForm: false,
      glosses: [{ id: 'g1', key: 'עכבר', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan).toEqual({ create: [], join: [], alternatives: [], rename: [], needsMerge: false });
  });

  it('joins the gloss whose key is equal once normalised', () => {
    const plan = assignGlosses({ senses: [sense('s2', 'עַכְבָּר')], lemmaForm: false, glosses: [{ id: 'g1', key: 'עכבר', alternatives: [] }], memberships: none });
    expect(plan.join).toEqual([{ senseId: 's2', glossId: 'g1' }]);
    expect(plan.create).toEqual([]);
  });

  it('gives new senses with one key one new gloss, named by the lowest-ranked', () => {
    const plan = assignGlosses({ senses: [sense('s1', 'עכבר'), sense('s2', 'עַכְבָּר')], lemmaForm: true, glosses: [], memberships: none });
    expect(plan.create).toEqual([{ key: 'עכבר', alternatives: [], senseIds: ['s1', 's2'] }]);
  });

  it('keeps two senses that name each other among their alternatives apart: that would be a synonym merge', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'מדהים', ['נהדר']), sense('s2', 'נהדר', ['מדהים'])],
      lemmaForm: true,
      glosses: [],
      memberships: none,
    });
    expect(plan.create.map((g) => g.key)).toEqual(['מדהים', 'נהדר']);
  });

  it('makes three glosses out of five senses', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'פיתוח'), sense('s2', 'התפתחות'), sense('s3', 'פיתוח'), sense('s4', 'אירוע'), sense('s5', 'התפתחות')],
      lemmaForm: true,
      glosses: [],
      memberships: none,
    });
    expect(plan.create).toEqual([
      { key: 'פיתוח', alternatives: [], senseIds: ['s1', 's3'] },
      { key: 'התפתחות', alternatives: [], senseIds: ['s2', 's5'] },
      { key: 'אירוע', alternatives: [], senseIds: ['s4'] },
    ]);
  });

  it('unions alternatives into a gloss, never its key and never twice', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'מכונית', ['אוטו', 'מכונית', 'רֶכֶב'])],
      lemmaForm: false,
      glosses: [{ id: 'g1', key: 'מכונית', alternatives: ['רכב'] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.alternatives).toEqual([{ glossId: 'g1', alternatives: ['רכב', 'אוטו'] }]);
  });

  it('lets the lemma form rename a key that no other gloss holds', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע')],
      lemmaForm: true,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.rename).toEqual([{ glossId: 'g1', key: 'אצבע' }]);
    expect(plan.needsMerge).toBe(false);
  });

  it('never lets another form rename a key', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע')],
      lemmaForm: false,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.rename).toEqual([]);
  });

  it('asks for a merge, not a rename, when another gloss holds the key', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע')],
      lemmaForm: true,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }, { id: 'g2', key: 'אצבע', alternatives: [] }],
      memberships: new Map([['s1', 'g1'], ['s2', 'g2']]),
    });
    expect(plan.rename).toEqual([]);
    expect(plan.needsMerge).toBe(true);
  });

  it('joins a new sense to a gloss this same write renamed', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע'), sense('s3', 'אצבע')],
      lemmaForm: true,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.rename).toEqual([{ glossId: 'g1', key: 'אצבע' }]);
    expect(plan.join).toEqual([{ senseId: 's3', glossId: 'g1' }]);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/glosses.test.ts`. Expected: FAIL, `assignGlosses is not a function`.

- [ ] **Step 3: Write `assignGlosses`.** Append to `apps/server/src/domain/glosses.ts`:

```ts
/** One sense of one write, for one lexeme, in the order the answer ranked them. */
export type AnswerSense = { senseId: string; gloss: string; glossAlternatives: readonly string[] };

/** A live gloss of the lexeme in the write's learner language. */
export type LiveGloss = { id: string; key: string; alternatives: readonly string[] };

export type GlossPlan = {
  /** New glosses, each named by its lowest-ranked sense, with the senses that form it. */
  create: { key: string; alternatives: string[]; senseIds: string[] }[];
  /** Senses joining a gloss that already exists. */
  join: { senseId: string; glossId: string }[];
  /** Existing glosses whose alternatives grew: the whole new list. */
  alternatives: { glossId: string; alternatives: string[] }[];
  /** Spec D6: the lemma form's citation form renamed a gloss. */
  rename: { glossId: string; key: string }[];
  /** Spec D6, D7: a rename another gloss's key blocked. The merge job decides. */
  needsMerge: boolean;
};

/**
 * Spec D6 and D7, in their order. A sense with a membership keeps it: the first
 * rendering in a language decided, and a later form's different word stays on
 * its own rendering. Else it joins the live gloss whose key is equal once
 * normalised. Else senses of this write with one key share one new gloss,
 * spelled as the lowest-ranked wrote it. Only equal keys group: two senses that
 * name each other among their alternatives are a synonym merge, which is out.
 *
 * The lemma form may rename its sense's gloss to its own citation form, once per
 * gloss per write, when no other live gloss holds that key; when one does, that
 * is a merge, which this never does (D7) and only asks for.
 */
export function assignGlosses(input: {
  senses: readonly AnswerSense[];
  lemmaForm: boolean;
  glosses: readonly LiveGloss[];
  memberships: ReadonlyMap<string, string>;
}): GlossPlan {
  // Working copies, so a rename made for one sense is what the next one joins.
  const byId = new Map(input.glosses.map((gloss) => [gloss.id, { ...gloss, alternatives: [...gloss.alternatives] }]));
  const byKey = new Map([...byId.values()].map((gloss) => [normaliseGloss(gloss.key), gloss.id]));
  const created = new Map<string, { key: string; alternatives: string[]; senseIds: string[] }>();
  const plan: GlossPlan = { create: [], join: [], alternatives: [], rename: [], needsMerge: false };
  const renamed = new Set<string>();
  const widened = new Set<string>();

  const widen = (glossId: string, extra: readonly string[]) => {
    const gloss = byId.get(glossId)!;
    const next = tidyGlossList([...gloss.alternatives, ...extra], gloss.key);
    if (next.length !== gloss.alternatives.length || next.some((item, i) => item !== gloss.alternatives[i])) {
      gloss.alternatives = next;
      widened.add(glossId);
    }
  };

  for (const sense of input.senses) {
    const key = normaliseGloss(sense.gloss);
    const current = input.memberships.get(sense.senseId);
    if (current !== undefined) {
      const gloss = byId.get(current);
      if (gloss) {
        if (input.lemmaForm && !renamed.has(current) && key !== normaliseGloss(gloss.key)) {
          const holder = byKey.get(key);
          if (holder === undefined && !created.has(key)) {
            byKey.delete(normaliseGloss(gloss.key));
            byKey.set(key, current);
            gloss.key = sense.gloss;
            renamed.add(current);
            plan.rename.push({ glossId: current, key: sense.gloss });
          } else if (holder !== current) {
            plan.needsMerge = true;
          }
        }
        widen(current, sense.glossAlternatives);
      }
      continue;
    }
    const existing = byKey.get(key);
    if (existing !== undefined) {
      plan.join.push({ senseId: sense.senseId, glossId: existing });
      widen(existing, sense.glossAlternatives);
      continue;
    }
    const fresh = created.get(key);
    if (fresh) {
      fresh.senseIds.push(sense.senseId);
      fresh.alternatives = tidyGlossList([...fresh.alternatives, ...sense.glossAlternatives], fresh.key);
      continue;
    }
    created.set(key, {
      key: sense.gloss,
      alternatives: tidyGlossList(sense.glossAlternatives, sense.gloss),
      senseIds: [sense.senseId],
    });
  }

  plan.create = [...created.values()];
  plan.alternatives = [...widened].map((glossId) => ({ glossId, alternatives: byId.get(glossId)!.alternatives }));
  return plan;
}
```

- [ ] **Step 4: Run them and see them pass.** The command of Step 2. Expected: PASS.

- [ ] **Step 5: Write the failing repository tests.** Create `apps/server/tests/integration/repo/dictionary.glosses.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';

import type { RepairedRendering } from '../../../src/repo/dictionary';
import { createDictRepo } from '../../../src/repo/dictionary';
import { insertLexeme } from '../../support/dictRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const persist = (form: string, entries: LlmEntry[]) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({ form, languageCode: 'en', userLanguageCode: 'he', kind: 'word', entries }),
  );

const MOUSE: LlmEntry = {
  lemma: 'mouse',
  part_of_speech: 'noun',
  senses: [
    { translation: 'עכבר', sense_code: 'rodent' },
    { translation: 'עַכְבָּר', sense_code: 'computer_device' },
  ],
};

const finger = (...senses: [string, string][]): LlmEntry => ({
  lemma: 'finger',
  part_of_speech: 'noun',
  senses: senses.map(([sense_code, translation]) => ({ sense_code, translation })),
});

async function glossesOf(lemma: string) {
  const rows = await t.db.execute<{ key: string; members: string[] }>(sql`
    select g.key, array_agg(s.sense_code order by s.sense_code) as members
    from dict_glosses g
    join dict_lexemes l on l.id = g.lexeme_id
    join dict_sense_glosses m on m.gloss_id = g.id
    join dict_senses s on s.id = m.sense_id
    where l.lemma = ${lemma} and g.merged_into is null
    group by g.id, g.key order by g.key`);
  return rows.rows;
}

const rendering = (senseId: string, rank: number, translation: string, gloss: string): RepairedRendering => ({
  senseId,
  rank,
  translation,
  alternatives: [],
  gloss,
  glossAlternatives: [],
  definition: null,
  exampleSource: null,
  exampleTarget: null,
});

describe('persistEntries writes glosses (spec D6, D8)', () => {
  it('gives two senses with one target word one gloss, and every rendered sense a membership', async () => {
    const { written } = await persist('mouse', [MOUSE]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
    expect(written[0].glossIds).toHaveLength(2);
    expect(new Set(written[0].glossIds).size).toBe(1);
  });

  it('keeps a later form on the gloss the first one decided', async () => {
    await persist('mouse', [MOUSE]);
    await persist('mice', [{ ...MOUSE, senses: [{ translation: 'עכברים', sense_code: 'rodent' }] }]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
  });

  it('joins a new sense to the gloss with its key', async () => {
    await persist('mouse', [{ ...MOUSE, senses: [MOUSE.senses[0]] }]);
    await persist('mouse', [{ ...MOUSE, senses: [MOUSE.senses[0], { translation: 'עכבר', sense_code: 'computer_device' }] }]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
  });

  it('lets the lemma form rename a key an inflected form set', async () => {
    await persist('fingers', [finger(['body_part', 'אצבעות'])]);
    expect(await glossesOf('finger')).toEqual([{ key: 'אצבעות', members: ['body_part'] }]);
    await persist('finger', [finger(['body_part', 'אצבע'])]);
    expect(await glossesOf('finger')).toEqual([{ key: 'אצבע', members: ['body_part'] }]);
  });

  it('returns a merge pair, and renames nothing, when another gloss holds the key', async () => {
    await persist('fingers', [finger(['body_part', 'אצבעות'])]);
    await persist('finger', [finger(['digit', 'אצבע'])]);
    const { mergePairs } = await persist('finger', [finger(['digit', 'אצבע'], ['body_part', 'אצבע'])]);
    expect(mergePairs).toEqual([{ lexemeId: expect.any(String), userLanguageCode: 'he' }]);
    expect(await glossesOf('finger')).toEqual([
      { key: 'אצבע', members: ['digit'] },
      { key: 'אצבעות', members: ['body_part'] },
    ]);
  });

  it('writes one gloss for one key when two lookups of one new form race', async () => {
    await Promise.all([persist('mouse', [MOUSE]), persist('mouse', [MOUSE])]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
  });
});

describe('repairVariantRenderings writes glosses (spec D6)', () => {
  it("gives a sense its first membership in the repair's language", async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'bank',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'money' }, { senseCode: 'river' }],
      variants: [
        {
          form: 'banks',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'money', rank: 0, translation: 'בנקים', gloss: 'בנק', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([word.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: word.variantIds[0],
        lexemeId: word.lexemeId,
        userLanguageCode: 'he',
        senseVersion: 2,
        lemmaForm: false,
        senses: [rendering(word.senseIds[0], 0, 'בנקים', 'בנק'), rendering(word.senseIds[1], 1, 'גדות', 'גדה')],
      });
    });
    expect(await glossesOf('bank')).toEqual([
      { key: 'בנק', members: ['money'] },
      { key: 'גדה', members: ['river'] },
    ]);
  });

  it('renames on a repair of the lemma form, and asks for a merge where another gloss holds the key', async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'finger',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'body_part' }, { senseCode: 'digit' }],
      variants: [
        { form: 'fingers', kind: 'word', entryRank: 0, translations: [{ senseCode: 'body_part', rank: 0, translation: 'אצבעות', exampleSource: null, exampleTarget: null }] },
        { form: 'finger', kind: 'word', entryRank: 0, translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null }] },
      ],
    });
    const repaired = await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([word.lexemeId]);
      return dict.repairVariantRenderings({
        variantId: word.variantIds[1],
        lexemeId: word.lexemeId,
        userLanguageCode: 'he',
        senseVersion: 2,
        lemmaForm: true,
        senses: [rendering(word.senseIds[1], 0, 'אצבע', 'אצבע'), rendering(word.senseIds[0], 1, 'אצבע', 'אצבע')],
      });
    });
    expect(repaired).toEqual({ needsMerge: true });
    expect(await glossesOf('finger')).toEqual([
      { key: 'אצבע', members: ['digit'] },
      { key: 'אצבעות', members: ['body_part'] },
    ]);
  });
});
```

- [ ] **Step 6: Run them and see them fail.** `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/repo/dictionary.glosses.test.ts`. Expected: FAIL; `lockLexemes` is not a function and no gloss is written.

- [ ] **Step 7: Write the gloss step in the repository.** In `apps/server/src/repo/dictionary.ts`, import `dictGlosses`, `dictSenseGlosses` from `../db/schema`, `isNull` from `drizzle-orm`, and `assignGlosses`, `type AnswerSense` from `../domain/glosses`. Add, inside `createDictRepo` before `persistEntries`:

```ts
  /** Phase 31. FOR UPDATE on these lexemes, in id order, in one statement. The
   *  lock step 1b of persistEntries takes, for the repair and the merge too, so a
   *  lookup, a repair and a merge of one lexeme run one after the other (spec D7).
   *  One ordered statement, for the deadlock reason step 1b gives. */
  const lockLexemes = async (lexemeIds: string[]): Promise<void> => {
    const ids = [...new Set(lexemeIds)];
    if (ids.length === 0) return;
    await tx
      .select({ id: dictLexemes.id })
      .from(dictLexemes)
      .where(inArray(dictLexemes.id, ids))
      .orderBy(asc(dictLexemes.id))
      .for('update');
  };

  /**
   * Phase 31 (spec D6, D8). The lexeme's live glosses and memberships in one
   * language, the plan assignGlosses makes from them, and that plan written. Each
   * sense's gloss id comes back in the order given. The caller holds
   * lockLexemes, so no other writer of this lexeme is between the read and the
   * writes.
   */
  const writeGlosses = async (input: {
    lexemeId: string;
    userLanguageCode: string;
    lemmaForm: boolean;
    senses: AnswerSense[];
  }): Promise<{ glossIds: string[]; needsMerge: boolean }> => {
    const glosses = await tx
      .select({ id: dictGlosses.id, key: dictGlosses.key, alternatives: dictGlosses.alternatives })
      .from(dictGlosses)
      .where(
        and(
          eq(dictGlosses.lexemeId, input.lexemeId),
          eq(dictGlosses.userLanguageCode, input.userLanguageCode),
          isNull(dictGlosses.mergedInto),
        ),
      );
    const members = await tx
      .select({ senseId: dictSenseGlosses.senseId, glossId: dictSenseGlosses.glossId })
      .from(dictSenseGlosses)
      .where(
        and(eq(dictSenseGlosses.lexemeId, input.lexemeId), eq(dictSenseGlosses.userLanguageCode, input.userLanguageCode)),
      );
    const memberships = new Map(members.map((member) => [member.senseId, member.glossId]));
    const plan = assignGlosses({ senses: input.senses, lemmaForm: input.lemmaForm, glosses, memberships });

    // Renames first, so a key a rename frees is free for a new gloss of this write.
    for (const rename of plan.rename) {
      await tx.update(dictGlosses).set({ key: rename.key }).where(eq(dictGlosses.id, rename.glossId));
    }
    for (const widened of plan.alternatives) {
      await tx.update(dictGlosses).set({ alternatives: widened.alternatives }).where(eq(dictGlosses.id, widened.glossId));
    }
    const glossBySense = new Map(memberships);
    const added: { senseId: string; glossId: string }[] = [...plan.join];
    for (const fresh of plan.create) {
      const [row] = await tx
        .insert(dictGlosses)
        .values({ lexemeId: input.lexemeId, userLanguageCode: input.userLanguageCode, key: fresh.key, alternatives: fresh.alternatives })
        .returning({ id: dictGlosses.id });
      for (const senseId of fresh.senseIds) added.push({ senseId, glossId: row.id });
    }
    for (const { senseId, glossId } of added) glossBySense.set(senseId, glossId);
    if (added.length > 0) {
      await tx
        .insert(dictSenseGlosses)
        .values(added.map(({ senseId, glossId }) => ({ senseId, glossId, lexemeId: input.lexemeId, userLanguageCode: input.userLanguageCode })))
        .onConflictDoNothing({ target: [dictSenseGlosses.senseId, dictSenseGlosses.userLanguageCode] });
    }
    return { glossIds: input.senses.map((sense) => glossBySense.get(sense.senseId)!), needsMerge: plan.needsMerge };
  };
```

Then, in `persistEntries`:
- Export `type MergePair = { lexemeId: string; userLanguageCode: string };` beside `PersistedEntry`, and add `glossIds: string[];` to `PersistedEntry` with the comment `/** Phase 31. Each sense's gloss in this write's language, aligned with senseIds. */`.
- Step 1b becomes `await lockLexemes(resolved.map((row) => row.lexemeId));`, keeping its comment.
- Declare `const mergePairs: MergePair[] = [];` beside `written`.
- Between step 4b and step 5, add step 4c:

```ts
      // 4c — Phase 31 (spec D6, D8). Every sense this form renders has a gloss in
      // this language before its rendering is written: kept, joined by key, or
      // new. Under 1b's lock, so two writers of one lexeme cannot both create a
      // gloss for one key.
      const { glossIds, needsMerge } = await writeGlosses({
        lexemeId,
        userLanguageCode: input.userLanguageCode,
        lemmaForm: input.form.toLowerCase() === entry.lemma.toLowerCase(),
        senses: entry.senses.map((sense, i) => ({
          senseId: senseIds[i],
          gloss: sense.gloss,
          glossAlternatives: sense.glossAlternatives,
        })),
      });
      if (needsMerge) mergePairs.push({ lexemeId, userLanguageCode: input.userLanguageCode });
```

- `written.push` gains `glossIds`, and the function returns `{ written, senses, mergePairs }` with the return type to match.

`repairVariantRenderings` takes the new input and returns `{ needsMerge }`: after its `RepairWouldDropSense` check and before its delete, add

```ts
    // Phase 31 (spec D6, D8). The repair is the second writer of renderings: a
    // sense it renders in this language for the first time gets its gloss here,
    // and a repair of the lemma form may rename. The caller holds lockLexemes.
    const { needsMerge } = await writeGlosses({
      lexemeId: input.lexemeId,
      userLanguageCode: input.userLanguageCode,
      lemmaForm: input.lemmaForm,
      senses: input.senses.map((sense) => ({
        senseId: sense.senseId,
        gloss: sense.gloss,
        glossAlternatives: sense.glossAlternatives,
      })),
    });
```

and end with `return { needsMerge };`. Add `lockLexemes` to the returned object.

Every direct caller now passes `lexemeId` and `lemmaForm` and holds the lock first. In `tests/integration/repo/dictionary.stale.test.ts`, `dictionary.renderings.test.ts` and `vocabulary.test.ts`, each `repairVariantRenderings` call gains `lexemeId` (the repaired lexeme's id) and `lemmaForm` (whether the repaired form equals the lemma, ignoring case), and is preceded, on the same transaction's dictionary repository, by `await dict.lockLexemes([lexemeId])`.

- [ ] **Step 8: Lock in the repair's write.** In `apps/server/src/services/translations.ts`, `repairForm`'s last transaction becomes:

```ts
  return transaction(async (repos) => {
    // Phase 31. The lexemes' FOR UPDATE lock, in id order, before any gloss is
    // written: the lock persistEntries takes, so a repair and a lookup of one
    // lexeme cannot both create a gloss for one key (spec D7).
    await repos.dict.lockLexemes(rendered.map(({ lexeme }) => lexeme.lexemeId));
    for (const { lexeme, senseVersion, senses } of rendered) {
      await repos.dict.repairVariantRenderings({
        variantId: lexeme.variantId,
        lexemeId: lexeme.lexemeId,
        userLanguageCode: to,
        // The version read above, before the model call — never re-read here.
        senseVersion,
        lemmaForm: form.toLowerCase() === lexeme.lemma.toLowerCase(),
        senses,
      });
    }
    return repos.dict.findSensesByForm({ form, languageCode: from, userLanguageCode: to });
  });
```

- [ ] **Step 9: Fixtures write glosses too (spec D8).** In `apps/server/tests/support/dictRows.ts`, import `normaliseGloss` from `@lang-tutor/core/domain` and `dictGlosses`, `dictSenseGlosses` from the schema. At the end of `insertLexeme`, before its `return`:

```ts
  // Phase 31 (spec D8). Every rendered sense has a gloss, by the migration's
  // rule: the lemma form's rendering names it, else the lowest-ranked one, and
  // senses with one normalised key share it.
  const chosen = new Map<string, { key: string; lemmaForm: boolean; rank: number }>();
  for (const variant of spec.variants) {
    const lemmaForm = variant.form.toLowerCase() === spec.lemma.toLowerCase();
    for (const translation of variant.translations) {
      const senseId = idByCode.get(translation.senseCode)!;
      const key = translation.gloss ?? translation.translation;
      const current = chosen.get(senseId);
      const better =
        !current || (lemmaForm && !current.lemmaForm) || (lemmaForm === current.lemmaForm && translation.rank < current.rank);
      if (better) chosen.set(senseId, { key, lemmaForm, rank: translation.rank });
    }
  }
  const glossByKey = new Map<string, string>();
  const glossBySense = new Map<string, string>();
  for (const [senseId, { key }] of chosen) {
    let glossId = glossByKey.get(normaliseGloss(key));
    if (glossId === undefined) {
      const [row] = await db
        .insert(dictGlosses)
        .values({ lexemeId: lexeme.id, userLanguageCode: spec.userLanguageCode, key })
        .returning({ id: dictGlosses.id });
      glossId = row.id;
      glossByKey.set(normaliseGloss(key), glossId);
    }
    await db.insert(dictSenseGlosses).values({ senseId, lexemeId: lexeme.id, userLanguageCode: spec.userLanguageCode, glossId });
    glossBySense.set(senseId, glossId);
  }
```

and return `{ lexemeId: lexeme.id, variantIds, senseIds, glossIds: senseIds.map((id) => glossBySense.get(id) ?? '') }`, with the return type to match.

In `apps/server/tests/support/fakes.ts`, import `type MergePair` from `../../src/repo/dictionary` and:
- add `mergePairs: MergePair[];` to `FakeDictRepo`, `[]` in `createFakeDictRepo`;
- add `lockLexemes: async () => {},`;
- in `repairVariantRenderings`, return `{ needsMerge: false }` after recording the call;
- in `persistEntries`, give each written entry its gloss ids and return the pairs:

```ts
        written: input.entries.map((entry, index) => ({
          lemma: entry.lemma,
          lexemeId: `t-${index}`,
          variantId: `v-${index}`,
          senseIds: entry.senses.map((_, rank) => `s-${index}-${rank}`),
          glossIds: entry.senses.map((_, rank) => `g-${index}-${rank}`),
          created: true,
        })),
        senses: repo.reread.length > 0 ? rowsToSenses(repo.reread) : flattenEntries(input.entries),
        mergePairs: repo.mergePairs,
```

- [ ] **Step 10: Run them and see them pass.** The command of Step 6, then the dictionary suites (`tests/integration/repo/dictionary.test.ts`, `dictionary.stale.test.ts`, `dictionary.renderings.test.ts`). Expected: PASS. If the race test reports a 40P01 deadlock, `writeGlosses` is reading before the lock: step 1b must stay above every loop.

- [ ] **Step 11: Check and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch`. Expected: PASS.

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): assignGlosses — both writers give every rendered sense its gloss, and the lemma form renames a key"
```

---

### Task 4: The model's new fields — one translation, alternatives, a citation form, a definition

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`LlmSenseSchema`, `LlmRenderingSchema`), `schemas.test.ts`
- Modify: `apps/server/src/domain/translation.ts` (`buildPrompt`), `translation.test.ts`
- Modify: `apps/server/src/domain/dictionary.ts` (`renderingOf`), `dictionary.test.ts`
- Modify: `apps/server/src/repo/dictionary.ts` (definitions in `persistEntries` and `repairVariantRenderings`)
- Modify: `apps/server/tests/integration/repo/dictionary.glosses.test.ts`
- Modify: `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/run.ts`

**Interfaces:**
- Produces: `LlmSense` gains optional `alternatives?: string[]`, `gloss?: string`, `gloss_alternatives?: string[]`, `definition?: string`. `LlmRendering` gains the same four, each also nullable.
- Produces: `renderingOf` reads the four fields (each may be absent or null).
- Produces: a written sense keeps the first definition offered for it.

- [ ] **Step 1: Write the failing tests.**

In `packages/core/src/api/schemas.test.ts`, inside the `LlmTranslationSchema` describe:

```ts
  it('takes the phase 31 fields on a sense, and a sense without them', () => {
    const full = {
      translation: 'מכונית',
      sense_code: 'motor_vehicle',
      alternatives: ['רכב'],
      gloss: 'מכונית',
      gloss_alternatives: ['רכב'],
      definition: 'a road vehicle with an engine',
    };
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [{ lemma: 'car', part_of_speech: 'noun', senses: [full] }] }).success).toBe(true);
    expect(LlmTranslationSchema.safeParse({ kind: 'word', entries: [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'motor_vehicle' }] }] }).success).toBe(true);
  });
```

and inside the `LlmReconciliationSchema` describe (create one if the file has none, importing the schema):

```ts
  it('takes the phase 31 fields as absent or null, since this answer is parsed without dropNulls', () => {
    const base = { sense_code: 'motor_vehicle', translation: 'מכוניות' };
    expect(LlmReconciliationSchema.safeParse({ senses: [{ ...base, gloss: 'מכונית', alternatives: ['רכבים'], gloss_alternatives: ['רכב'], definition: 'a road vehicle' }] }).success).toBe(true);
    expect(LlmReconciliationSchema.safeParse({ senses: [{ ...base, gloss: null, alternatives: null, gloss_alternatives: null, definition: null }] }).success).toBe(true);
  });
```

In `apps/server/src/domain/dictionary.test.ts`, inside `describe('entriesToRows (phase 31)')`:

```ts
  it("takes the model's citation form, alternatives and definition, tidied", () => {
    const [row] = entriesToRows([
      {
        lemma: 'car',
        part_of_speech: 'noun',
        senses: [
          {
            translation: 'מכוניות',
            sense_code: 'motor_vehicle',
            alternatives: ['רכבים', 'מכוניות', 'אוטואים'],
            gloss: 'מכונית',
            gloss_alternatives: ['רכב', 'אוטו', 'מכונית'],
            definition: '  a road vehicle with an engine ',
          },
        ],
      },
    ]);
    expect(row.senses[0]).toMatchObject({
      translation: 'מכוניות',
      alternatives: ['רכבים', 'אוטואים'],
      gloss: 'מכונית',
      glossAlternatives: ['רכב', 'אוטו'],
      definition: 'a road vehicle with an engine',
    });
  });

  it('cleans a citation form the model gave as a list, keeping the rest as citation alternatives', () => {
    const [row] = entriesToRows([
      { lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'v', gloss: 'מכונית, רכב' }] },
    ]);
    expect(row.senses[0]).toMatchObject({ gloss: 'מכונית', glossAlternatives: ['רכב'] });
  });
```

In `apps/server/src/domain/translation.test.ts`:

```ts
describe('buildPrompt (phase 31)', () => {
  const system = buildPrompt({ text: 'car', from: 'en', to: 'he' }).system;

  it('asks for one translation, alternatives, the citation forms and a definition', () => {
    expect(system).toContain('one main Hebrew translation');
    expect(system).toContain('"alternatives"');
    expect(system).toContain('"gloss"');
    expect(system).toContain('"gloss_alternatives"');
    expect(system).toContain('one short phrase in English');
  });
});
```

Append to `describe('persistEntries writes glosses (spec D6, D8)')` in `tests/integration/repo/dictionary.glosses.test.ts`:

```ts
  it("groups by the model's citation form, so an inflected form keys its gloss uninflected", async () => {
    await persist('fingers', [{ lemma: 'finger', part_of_speech: 'noun', senses: [{ translation: 'אצבעות', gloss: 'אצבע', sense_code: 'body_part' }] }]);
    expect(await glossesOf('finger')).toEqual([{ key: 'אצבע', members: ['body_part'] }]);
  });

  it('stores the first definition offered for a sense, and fills one a sense lacks', async () => {
    await persist('car', [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'vehicle' }] }]);
    await persist('cars', [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכוניות', sense_code: 'vehicle', definition: 'a road vehicle' }] }]);
    await persist('car', [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'vehicle', definition: 'an automobile' }] }]);
    const rows = await t.db.execute<{ definition: string | null }>(sql`select definition from dict_senses where sense_code = 'vehicle'`);
    expect(rows.rows).toEqual([{ definition: 'a road vehicle' }]);
  });
```

- [ ] **Step 2: Run them and see them fail.** `npm exec -w packages/core -- jest --runTestsByPath src/api/schemas.test.ts`; `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/dictionary.test.ts src/domain/translation.test.ts`; `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/repo/dictionary.glosses.test.ts`. Expected: the core schema test already passes, since zod strips unknown keys and no LLM schema is strict; it guards Step 3's explicit schema. The server tests FAIL: `gloss` is ignored, the prompt lacks the rules, and no definition is stored.

- [ ] **Step 3: The schemas.** In `packages/core/src/api/schemas.ts`, replace `LlmSenseSchema` (and the comment above it, which explained the `.omit`):

```ts
// Phase 31. Written out rather than derived from TranslationSenseSchema, which
// becomes a gloss card (Tasks 6 and 7) and shares nothing with what the model
// writes but the translation and the example. A model that still puts a part
// of speech on a sense loses it on parse, as before: the key is not here.
//
// The four phase 31 fields are optional and never defaulted, for the reason
// LlmCorrectionSchema.alternatives gives: a missing decorative field must not
// fail an answer, and a `default` would travel to Gemini. No maxItems either:
// array caps multiply the response schema's states, which Gemini refuses past a
// limit (see `entries` below). renderingOf cuts the lists after parsing.
export const LlmSenseSchema = z.object({
  translation: z.string().min(1),
  example: z.object({ source: z.string().min(1), target: z.string().min(1) }).optional(),
  sense_code: z.string().min(1).max(60),
  // Spec D4, D5. The sense's other target words, in the translation's form.
  alternatives: z.array(z.string().min(1)).optional(),
  // Spec D6. The translation's citation form, uninflected.
  gloss: z.string().min(1).optional(),
  // Spec D5. The alternatives' citation forms.
  gloss_alternatives: z.array(z.string().min(1)).optional(),
  // Spec D9. One short phrase in the headword's language.
  definition: z.string().min(1).optional(),
});
```

`LlmRenderingSchema` gains the same four, nullable as well, because `parseLlmReconciliation` parses without `dropNulls` (its own `translation: null` is load-bearing):

```ts
  // Phase 31: the first call's four fields, for the same reasons. Nullable as
  // well as optional, because this answer is parsed without dropNulls: a
  // provider spelling "none" as null must not fail the whole reconciliation.
  alternatives: z.array(z.string().min(1)).nullable().optional(),
  gloss: z.string().min(1).nullable().optional(),
  gloss_alternatives: z.array(z.string().min(1)).nullable().optional(),
  definition: z.string().min(1).nullable().optional(),
```

- [ ] **Step 4: The prompt.** In `apps/server/src/domain/translation.ts`, `buildPrompt`'s rule list gains the new rules right after `` `Write every sense's translation in ${to}.` ``:

```ts
    // Phase 31 (spec D4-D6, D9). A card shows one target word, so the
    // translation is one, and the rest go where they are shown as "also …" and
    // accepted as answers. The citation forms are what groups senses into
    // glosses; the definition is what a learner language with no renderings yet
    // reconciles against. Before changing a word here, check it against every
    // registered MockServer expectation (see the illustration note below).
    ...glossRules(to),
    `Define the sense in "definition": one short phrase in ${from}.`,
```

with the three rules both calls share in a helper beside `formRules` and `writingRules` (Task 5 gives the second call the same three):

```ts
/** Phase 31 (spec D4-D6). How each sense's target words are written: both
 *  calls ask for them in these words. */
function glossRules(to: string): string[] {
  return [
    `Give each sense one main ${to} translation: never a list of words, and never a note in brackets; a note that tells one sense from another belongs in "definition". A translation may be several words where ${to} needs them for one meaning.`,
    `List other ${to} words that render the sense equally well in "alternatives", in the same grammatical form as the translation.`,
    `Give the translation's dictionary citation form in "gloss", uninflected, and the alternatives' in "gloss_alternatives".`,
  ];
}
```

Then run `grep -rn "matchText\|expectGeminiMatching" apps/server/tests e2e/tests` and check that none of the registered patterns occurs in the four new lines. None should: they hold no headword. If one does, reword the line, not the expectation.

- [ ] **Step 5: The write reads the fields.** In `apps/server/src/domain/dictionary.ts`, import `tidyGlossList` beside `splitTranslation`, and replace `renderingOf`:

```ts
/**
 * Phase 31. A model's sense as every writer stores it: one clean translation and
 * the rest of any list as alternatives, so a model that ignores "one
 * translation" still never puts a list on a card (Review Focus 5). The citation
 * form is the model's, cleaned the same way, or the translation when it gave
 * none. The lookup and the repair both call it.
 */
export function renderingOf(
  sense: {
    translation: string;
    example?: { source: string; target: string };
    alternatives?: readonly string[] | null;
    gloss?: string | null;
    gloss_alternatives?: readonly string[] | null;
    definition?: string | null;
  },
  rank: number,
): Rendering {
  const said = splitTranslation(sense.translation);
  const cited = sense.gloss ? splitTranslation(sense.gloss) : null;
  const gloss = cited?.translation ?? said.translation;
  return {
    rank,
    translation: said.translation,
    alternatives: tidyGlossList([...said.alternatives, ...(sense.alternatives ?? [])], said.translation),
    gloss,
    glossAlternatives: tidyGlossList([...(cited?.alternatives ?? []), ...(sense.gloss_alternatives ?? [])], gloss),
    definition: sense.definition?.trim() || null,
    exampleSource: sense.example?.source ?? null,
    exampleTarget: sense.example?.target ?? null,
  };
}
```

In `apps/server/src/repo/dictionary.ts`, step 4 of `persistEntries` writes and fills definitions. The insert of a new sense becomes `.values({ lexemeId, senseCode: sense.senseCode, definition: sense.definition })`, and right after the `if (!id) { … }` block, still inside the loop:

```ts
        // Phase 31 (spec D9). The first definition offered stays: a sense written
        // before the phase, or by a call that gave none, takes this one.
        if (sense.definition !== null) {
          await tx
            .update(dictSenses)
            .set({ definition: sense.definition })
            .where(and(eq(dictSenses.id, id), isNull(dictSenses.definition)));
        }
```

`repairVariantRenderings` fills the same way, before its delete:

```ts
    // Phase 31 (spec D9). The rendering call names definitions too.
    for (const sense of input.senses) {
      if (sense.definition === null) continue;
      await tx
        .update(dictSenses)
        .set({ definition: sense.definition })
        .where(and(eq(dictSenses.id, sense.senseId), isNull(dictSenses.definition)));
    }
```

- [ ] **Step 6: Run the tests of Step 2.** Expected: PASS.

- [ ] **Step 7: The eval cases (tier 2, which tolerates a model update).** In `apps/server/tests/eval/cases.ts`, `EvalCase` gains:

```ts
  /** Phase 31 (spec D4). Every sense's translation is one translation: no comma,
   *  slash or semicolon list and no parenthetical. */
  expectOneTranslation?: true;
  /** Phase 31 (spec D6). The first entry's first sense names one of these as its
   *  citation form, compared by normaliseGloss. */
  expectGloss?: string[];
  /** Phase 31 (spec D5). Every alternative and citation alternative is in this script. */
  expectAlternativesIn?: LanguageCode;
  /** Phase 31 (spec D5). Some sense lists one of these among its alternatives. */
  expectAlternativeWord?: string[];
  /** Phase 31 (spec D9). Every sense has a definition, in this script. */
  expectDefinitionIn?: LanguageCode;
```

Append to `CASES`. Before adding them, `grep -n "'car'\|'café'\|'fingers'\|'столы'\|'combination'" apps/server/tests/eval/cases.ts apps/server/src/db/content.ts` must show no case or seeded word with these texts; if one exists, extend that case with the new fields instead of adding a second.

```ts
  // Phase 31 (spec D4, D5, D9). One main translation, the other target words as
  // alternatives in the same language, and a definition in the headword's.
  {
    label: 'one main translation, the other target words as alternatives (phase 31)',
    text: 'car',
    expectKind: 'word',
    acceptTop: ['מכונית', 'רכב', 'אוטו'],
    expectOneTranslation: true,
    expectAlternativesIn: 'he',
    expectAlternativeWord: ['רכב', 'אוטו', 'מכונית'],
    expectDefinitionIn: 'en',
  },
  // Phase 31 (spec D4). One meaning that Hebrew says in two words stays whole.
  {
    label: 'a compound translation survives whole (phase 31)',
    text: 'café',
    expectKind: 'word',
    acceptTop: ['בית קפה'],
    expectOneTranslation: true,
  },
  // Phase 31 (spec D6). The translation inflects with the form; the citation form does not.
  {
    label: 'an inflected form keeps its citation form uninflected (phase 31)',
    text: 'fingers',
    expectKind: 'word',
    acceptTop: ['אצבעות'],
    expectLemma: 'finger',
    expectGloss: ['אצבע'],
    expectOneTranslation: true,
  },
  {
    label: 'a Russian plural: a singular citation form and a Russian definition (phase 31)',
    text: 'столы',
    from: 'ru',
    expectKind: 'word',
    acceptTop: ['שולחנות'],
    expectGloss: ['שולחן'],
    expectDefinitionIn: 'ru',
  },
  // Phase 31 (Review Focus 5). Lane 0 stored "קומבינציה, צירוף" for this word.
  {
    label: 'no comma list where lane 0 held one (phase 31)',
    text: 'combination',
    expectKind: 'word',
    acceptTop: ['שילוב', 'צירוף', 'קומבינציה'],
    expectOneTranslation: true,
    expectAlternativesIn: 'he',
  },
```

In `apps/server/tests/eval/run.ts`, import `normaliseGloss` from `@lang-tutor/core/domain`, and at the end of `tier2`, before its `return checks;`:

```ts
  // Phase 31 (spec D4-D6, D9).
  const allSenses = result.entries.flatMap((entry) => entry.senses);
  if (kase.expectOneTranslation) {
    const lists = allSenses.filter((sense) => /[,/;()]/u.test(sense.translation));
    checks.push({
      name: 'every translation is one translation, with no list and no note',
      ok: lists.length === 0,
      detail: lists.map((sense) => sense.translation).join(' | ') || undefined,
    });
  }
  if (kase.expectGloss) {
    const gloss = result.entries[0]?.senses[0]?.gloss;
    checks.push({
      name: `the citation form is one of ${kase.expectGloss.join(', ')}`,
      ok: gloss !== undefined && kase.expectGloss.some((accepted) => normaliseGloss(accepted) === normaliseGloss(gloss)),
      detail: gloss ?? 'none',
    });
  }
  if (kase.expectAlternativesIn) {
    const words = allSenses.flatMap((sense) => [...(sense.alternatives ?? []), ...(sense.gloss_alternatives ?? [])]);
    checks.push({
      name: `every alternative is in ${kase.expectAlternativesIn} script`,
      ok: words.every((word) => isInScript(word, kase.expectAlternativesIn!)),
      detail: words.join(' | ') || 'none',
    });
  }
  if (kase.expectAlternativeWord) {
    const listed = allSenses.flatMap((sense) => sense.alternatives ?? []);
    checks.push({
      name: `lists one of ${kase.expectAlternativeWord.join(', ')} as an alternative`,
      ok: kase.expectAlternativeWord.some((word) => listed.some((alt) => normaliseGloss(alt) === normaliseGloss(word))),
      detail: listed.join(' | ') || 'none',
    });
  }
  if (kase.expectDefinitionIn) {
    checks.push({
      name: `every sense has a definition in ${kase.expectDefinitionIn} script`,
      ok: allSenses.length > 0 && allSenses.every((sense) => Boolean(sense.definition?.trim()) && isInScript(sense.definition!, kase.expectDefinitionIn!)),
      detail: allSenses.map((sense) => sense.definition ?? 'none').join(' | '),
    });
  }
```

- [ ] **Step 8: Run the live eval now, before anything builds on the schema.** From `apps/server` in the worktree: `npx tsx tests/eval/run.ts 'phase 31'`, then `npx tsx tests/eval/run.ts book` (an old case: the schema change must not cost it). Expected: no tier 1 failure and no `400`. A `400 INVALID_ARGUMENT … too many states` means the new fields pushed the response schema past Gemini's limit: drop `gloss_alternatives` from `LlmSenseSchema` first (renderingOf then takes citation alternatives from `alternatives` only), re-run, and say so in the task report. If the keys are not available locally, push the branch and read CI's `eval-report` artifact before Step 9; do not continue on an unmeasured schema.

- [ ] **Step 9: Check and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch`. Expected: PASS.

```bash
git add packages/core/src/api apps/server/src apps/server/tests
git commit -m "feat(server): the lookup asks for one translation, its alternatives, its citation form and a definition"
```

---

### Task 5: Reconciliation by definition — the first learner of a new language reuses sense codes

**Files:**
- Modify: `apps/server/src/domain/translation.ts` (`StoredSense`, `buildRenderingPrompt`), `translation.test.ts`
- Modify: `apps/server/src/repo/dictionary.ts` (`findSensesByLexeme`)
- Modify: `apps/server/src/services/translations.ts` (`reconcile` carries the four fields)
- Modify: `apps/server/tests/support/dictRows.ts` (`readSenseDefinitions`), `apps/server/tests/support/fakes.ts`, `apps/server/tests/support/mockServer.ts` (`expectReconciliation` takes the new fields)
- Create: `apps/server/tests/integration/services/translations.definitions.test.ts`
- Modify: `apps/server/tests/eval/cases.ts` (one rendering case)

**Interfaces:**
- Produces: `StoredSense = { senseCode: string; definition?: string | null; translation: string; glossLanguage?: LanguageCode; exampleSource: string | null; exampleTarget: string | null }`. An absent `glossLanguage` is the learner's language.
- Produces: `findSensesByLexeme` returns every stored sense with any rendering, the learner's language's rendering first, and `definition` and `glossLanguage` on each.
- Produces, in `tests/support/dictRows.ts`: `readSenseDefinitions(db: Db, lemma: string): Promise<{ senseCode: string; definition: string | null }[]>`.

- [ ] **Step 1: Write the failing prompt test.** Append to `apps/server/src/domain/translation.test.ts`:

```ts
describe('buildRenderingPrompt (phase 31, spec D9)', () => {
  const prompt = buildRenderingPrompt({
    form: 'חלונות',
    from: 'he',
    to: 'ru',
    lemma: 'חלון',
    partOfSpeech: 'noun',
    storedSenses: [
      { senseCode: 'wall_opening', definition: 'פתח בקיר', translation: 'window', glossLanguage: 'en', exampleSource: 'פתחתי את החלון.', exampleTarget: 'I opened the window.' },
      { senseCode: 'time_slot', definition: null, translation: 'окно', exampleSource: null, exampleTarget: null },
    ],
  });

  it('lists each stored sense as code — definition — gloss, and names a gloss in another language', () => {
    expect(prompt.system).toContain('- wall_opening — פתח בקיר — window (in English) — e.g. "פתחתי את החלון."');
    expect(prompt.system).toContain('- time_slot — окно');
  });

  it('keeps the marker MockServer matches the reconciliation on', () => {
    expect(prompt.system).toContain('reusing its sense_code EXACTLY');
  });

  it('asks for a definition where a sense has none, and for every new code', () => {
    expect(prompt.system).toContain('for every sense whose line above has no definition, and for every new sense_code');
  });
});
```

- [ ] **Step 2: Write the failing service test.** Add to `apps/server/tests/support/dictRows.ts`:

```ts
/** Phase 31. One lemma's senses with their definitions, by code. For service
 *  tests, which may not reach the database themselves (ADR 0001 R2). */
export async function readSenseDefinitions(db: Db, lemma: string): Promise<{ senseCode: string; definition: string | null }[]> {
  const rows = await db.execute<{ sense_code: string; definition: string | null }>(sql`
    select s.sense_code, s.definition from dict_senses s join dict_lexemes l on l.id = s.lexeme_id
    where l.lemma = ${lemma} order by s.sense_code`);
  return rows.rows.map((row) => ({ senseCode: row.sense_code, definition: row.definition }));
}
```

(import `sql` from `drizzle-orm` if the file does not yet.) Create `apps/server/tests/integration/services/translations.definitions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { insertLexeme, readSenseDefinitions } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  countGeminiRequests,
  expectGeminiJson,
  expectReconciliation,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 31 (spec D9). A Hebrew headword rendered for English learners, looked up
// by the first Russian one. Without definitions the second call was skipped, the
// model invented a code, and the lexeme grew a second set of senses.

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('services-translations-definitions');
});
afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const translations = () =>
  createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) }).translations;

const WINDOWS_RU = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'חלון',
      part_of_speech: 'noun' as const,
      senses: [{ translation: 'окна', gloss: 'окно', sense_code: 'glass_pane', example: { source: 'החלונות נקיים.', target: 'Окна чистые.' } }],
    },
  ],
};

describe('a learner language with no renderings yet', () => {
  it('reconciles by the definition and reuses the stored code', async () => {
    // The first English learner's lookup stores the sense with its definition.
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'חלון',
          part_of_speech: 'noun',
          senses: [{ translation: 'window', sense_code: 'wall_opening', definition: 'פתח בקיר שמכניס אור', example: { source: 'פתחתי את החלון.', target: 'I opened the window.' } }],
        },
      ],
      matchText: '"חלון"',
    });
    await translations().translate({ text: 'חלון', from: 'he', to: 'en' });

    // Registered first: only the reconciliation prompt says "reusing its sense_code EXACTLY".
    await expectReconciliation(ns, {
      senses: [{ sense_code: 'wall_opening', translation: 'окна', example: { source: 'החלונות נקיים.', target: 'Окна чистые.' } }],
    });
    await expectGeminiJson(ns, { ...WINDOWS_RU, matchText: '"חלונות"' });
    await translations().translate({ text: 'חלונות', from: 'he', to: 'ru' });

    expect(await readSenseDefinitions(t.db, 'חלון')).toEqual([{ senseCode: 'wall_opening', definition: 'פתח בקיר שמכניס אור' }]);
    // The stored list comes before the reuse rule in the prompt.
    expect(await countGeminiRequests(ns, 'wall_opening — פתח בקיר שמכניס אור — window \\(in English\\)[\\s\\S]*reusing its sense_code EXACTLY')).toBe(1);
  });

  it('with no definition either, reconciles by the other language’s gloss, and fills the definition from the answer', async () => {
    await insertLexeme(t.db, {
      lemma: 'חלון',
      languageCode: 'he',
      partOfSpeech: 'noun',
      userLanguageCode: 'en',
      senses: [{ senseCode: 'wall_opening' }],
      variants: [
        { form: 'חלון', kind: 'word', entryRank: 0, translations: [{ senseCode: 'wall_opening', rank: 0, translation: 'window', exampleSource: 'פתחתי את החלון.', exampleTarget: 'I opened the window.' }] },
      ],
    });
    await expectReconciliation(ns, {
      senses: [{ sense_code: 'wall_opening', translation: 'окна', definition: 'פתח בקיר' }],
    });
    await expectGeminiJson(ns, { ...WINDOWS_RU, matchText: '"חלונות"' });

    await translations().translate({ text: 'חלונות', from: 'he', to: 'ru' });

    expect(await readSenseDefinitions(t.db, 'חלון')).toEqual([{ senseCode: 'wall_opening', definition: 'פתח בקיר' }]);
    expect(await countGeminiRequests(ns, 'wall_opening — window \\(in English\\)[\\s\\S]*reusing its sense_code EXACTLY')).toBe(1);
  });
});
```

In `apps/server/tests/support/mockServer.ts`, widen `expectReconciliation`'s `senses` option to `LlmRendering[]` (import the type from `@lang-tutor/core/api`), so a stub can carry the phase 31 fields.

- [ ] **Step 3: Run them and see them fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/translation.test.ts` and `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/services/translations.definitions.test.ts`. Expected: FAIL. The prompt has no definition column, and the Russian lookup makes no reconciliation call: `stored` comes back empty for a language with no renderings, so `glass_pane` is written as a second sense.

- [ ] **Step 4: The rendering prompt.** In `apps/server/src/domain/translation.ts`, replace `StoredSense`:

```ts
/** One stored sense as the reconciliation prompt needs it: its code, its
 *  definition, and the gloss that names what it means. Phase 31 (spec D9): the
 *  gloss may be in another learner language when the learner's has none yet;
 *  `glossLanguage` says which, and an absent one is the learner's. */
export type StoredSense = {
  senseCode: string;
  definition?: string | null;
  translation: string;
  glossLanguage?: LanguageCode;
  exampleSource: string | null;
  exampleTarget: string | null;
};
```

In `buildRenderingPrompt`, the stored list becomes:

```ts
  // Each stored sense as `code — definition — gloss — example`, one per line.
  // The definition, in the headword's language, is the handle every learner
  // language shares (spec D9); a gloss in another learner language says so.
  const stored = input.storedSenses
    .map((sense) => {
      const definition = sense.definition ? ` — ${sense.definition}` : '';
      const other =
        sense.glossLanguage && sense.glossLanguage !== input.to ? ` (in ${LANGUAGES[sense.glossLanguage].name})` : '';
      const example = sense.exampleSource ? ` — e.g. "${sense.exampleSource}"` : '';
      return `- ${sense.senseCode}${definition} — ${sense.translation}${other}${example}`;
    })
    .join('\n');
```

The sentence introducing the list becomes:

```ts
    `The ${from} headword "${input.lemma}" (${input.partOfSpeech}) is already in this`,
    `dictionary with the senses below, each a sense_code, its definition in ${from} where one`,
    `is recorded, and the gloss recorded for it, in ${to} unless another language is named:`,
```

and after `` `Write every sense's translation in ${to}.` `` add Task 4's `glossRules` and a definition rule worded for this call:

```ts
    // Phase 31 (spec D4-D6, D9): the first call's rules, for the same reasons.
    ...glossRules(to),
    `Give "definition", one short phrase in ${from}, for every sense whose line above has no definition, and for every new sense_code.`,
```

- [ ] **Step 5: The stored senses, in any language.** In `apps/server/src/repo/dictionary.ts`, replace `findSensesByLexeme`'s query and mapping (keep its comment, adding the phase 31 paragraph):

```ts
  /*
   * Phase 31 (spec D9). No longer INNER-joined to the learner's language: a
   * language with no renderings yet still lists every sense, with its
   * definition and a gloss in some other language, so the second call runs and
   * reuses codes instead of the lexeme growing a second set of senses. The
   * learner's own rendering is preferred where there is one.
   */
  const findSensesByLexeme = async (input: {
    lemma: string;
    partOfSpeech: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<(StoredSense & { senseId: string })[]> => {
    const rows = await tx.execute<{
      sense_id: string;
      sense_code: string;
      definition: string | null;
      translation: string;
      gloss_language: string;
      example_source: string | null;
      example_target: string | null;
    }>(sql`
      SELECT sense_id, sense_code, definition, translation, gloss_language, example_source, example_target
      FROM (
        SELECT DISTINCT ON (s.id)
               s.id                   AS sense_id,
               s.sense_code           AS sense_code,
               s.definition           AS definition,
               tr.translation,
               tr.user_language_code  AS gloss_language,
               tr.example_source,
               tr.example_target,
               tr.rank                AS rank,
               (tr.user_language_code = ${input.userLanguageCode}) AS own
        FROM dict_lexemes l
        JOIN dict_senses s            ON s.lexeme_id = l.id
        JOIN dict_var_translations tr ON tr.sense_id = s.id
        JOIN dict_variants v          ON v.id = tr.variant_id
        WHERE l.language_code = ${input.languageCode}
          AND l.lemma = ${input.lemma}
          AND l.part_of_speech = ${input.partOfSpeech}
        ORDER BY s.id, (tr.user_language_code = ${input.userLanguageCode}) DESC, tr.rank, tr.user_language_code, v.id
      ) picked
      ORDER BY own DESC, rank, sense_code
    `);

    return rows.rows.map((row) => ({
      senseId: row.sense_id,
      senseCode: row.sense_code,
      definition: row.definition,
      translation: row.translation,
      glossLanguage: row.gloss_language as LanguageCode,
      exampleSource: row.example_source,
      exampleTarget: row.example_target,
    }));
  };
```

Import `type StoredSense` from `../domain/translation` and `type LanguageCode` from `../domain/languages`.

In `apps/server/src/services/translations.ts`, `reconcile` passes the four fields through to the entry it builds:

```ts
        senses.push({
          sense_code: rendering.sense_code,
          translation: rendering.translation,
          ...(rendering.example ? { example: rendering.example } : {}),
          // Phase 31: the rendering call's fields, for the write (renderingOf).
          ...(rendering.alternatives ? { alternatives: rendering.alternatives } : {}),
          ...(rendering.gloss ? { gloss: rendering.gloss } : {}),
          ...(rendering.gloss_alternatives ? { gloss_alternatives: rendering.gloss_alternatives } : {}),
          ...(rendering.definition ? { definition: rendering.definition } : {}),
        });
```

`repairForm` needs no change: it already spreads the whole rendering into `renderingOf`.

- [ ] **Step 6: Add the rendering eval case.** In `apps/server/tests/eval/cases.ts`, append to `RENDERING_CASES`:

```ts
  // Phase 31 (spec D9). The first learner of a new language: the stored sense
  // has no gloss in Russian, only its Hebrew definition and its English gloss,
  // and its code must still come back reused.
  {
    label: 'a sense with no gloss in this language is reused by its definition (phase 31)',
    form: 'חלונות',
    from: 'he',
    to: 'ru',
    lemma: 'חלון',
    partOfSpeech: 'noun',
    stored: [
      {
        senseCode: 'wall_opening',
        definition: 'פתח בקיר שמכניס אור ואוויר',
        translation: 'window',
        glossLanguage: 'en',
        exampleSource: 'פתחתי את החלון כדי להכניס אוויר.',
        exampleTarget: 'I opened the window to let air in.',
      },
    ],
    expectReused: ['wall_opening'],
  },
```

- [ ] **Step 7: Run everything.** The commands of Step 3 (expected: PASS), then the live eval from `apps/server`: `npx tsx tests/eval/run.ts 'phase 31'` and `npx tsx tests/eval/run.ts banks` (the existing reconciliation case must stay green). Expected: no tier 1 failure, and the new case reuses `wall_opening`.

- [ ] **Step 8: Check and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch`. Expected: PASS. A stale-form test that now sees an extra reconciliation call is the behaviour change the spec's Risks name ("Reconciliation with definitions changes the second call's behaviour"): read it, and update its expectation only where the new call is the one D9 asks for.

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): reconciliation lists definitions, so a new learner language reuses sense codes"
```

---

## Part B — The learner's unit is the gloss

### Task 6: Re-key every learner table on `gloss_id`, and rename `sense_id` on the wire

This task changes keys, not behaviour: after it, lookup and detail cards are still one per sense, but each carries its gloss's id, and every save, level and question is the gloss's. Two senses of `mouse` therefore show two cards that save together. Task 7 makes them one card.

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`vocabularyEntries`, `senseProgress` → `glossProgress`, `sessionProgress`, `questions`, `photoImportItems`, `dictVarTranslations`)
- Create: `apps/server/src/db/migrations/0023_glosses_rekey.sql` (+ `meta/0023_snapshot.json`, `_journal.json`)
- Modify: `packages/core/src/api/schemas.ts`, `schemas.test.ts`, `types.ts`, `index.ts`
- Modify (server source): `domain/dictionary.ts`, `domain/vocabulary.ts`, `domain/progress.ts`, `domain/photoImports.ts`, `domain/distractors.ts`, `domain/jobs.ts`; `repo/dictionary.ts`, `repo/vocabulary.ts`, `repo/progress.ts`, `repo/questions.ts`, `repo/photoImports.ts`; `services/translations.ts`, `services/vocabulary.ts`, `services/sessions.ts`, `services/photoImports.ts`; `routes/vocabulary.ts`, `routes/sessions.ts`, `routes/photoImports.ts`; `errors.ts`; `db/seed.ts`, `db/progressRecompute.ts`
- Modify (server tests): every file under `apps/server/src` and `apps/server/tests` that the `grep` of Step 11 lists, and `tests/support/{vocabularyRows,progressRows,questions,photoImportRows,dictRows,grantRows}.ts`
- Modify: `apps/mobile/src/**` (wire renames), `apps/mobile/src/app/photo-imports/[id].tsx` (an option's examples)
- Modify: `e2e/tests/speaking.spec.ts`, `sentence-cards.spec.ts`, `listening-variety.spec.ts`

**Interfaces:**
- Produces, in `schema.ts`: `vocabularyEntries.glossId` (PK `enrollment_id, gloss_id`; FK `(gloss_id, lexeme_id)` → `dict_glosses (id, lexeme_id)`); `glossProgress` (table `gloss_progress`, FK into the entry `ON UPDATE CASCADE`); `sessionProgress.glossId`; `questions.glossId` (FK `questions_gloss_fk`); `photoImportItems.suggestedGlossId`, `.chosenGlossId`. `dictVarTranslations.definitionNotes` is gone.
- Produces, on the wire: every `sense_id` is `gloss_id`; `saved_sense_ids` → `saved_gloss_ids`; `chosen_sense_id` → `chosen_gloss_id`; `SenseProgress` → `GlossProgress`; `DELETE /api/enrollments/{id}/vocabulary/glosses/{gloss_id}`. `PhotoImportOption` is `{ gloss_id, variant_id, translation, part_of_speech?, examples?: { source, target }[], alternatives?: string[] }`.
- Produces, in the server:
  - `SenseRow.glossId: string` (`domain/dictionary.ts`), read by `findSensesByForm`.
  - `GenerationContext` gains `glossId` beside `senseId`; `RecentSentences` is keyed by gloss id.
  - `PrepareSessionPayloadSchema.picks: { gloss_id: string; sense_id: string; variant_id: string }[]`.
  - `VocabularyRepo.listSavedGlosses(enrollmentId): Promise<{ glossId: string; senseId: string; variantId: string }[]>`; `findSavedGlossIds({ enrollmentId, glossIds })`; `findSaveable({ entries: { glossId, variantId }[]; targetLanguage; sourceLanguage }): Promise<{ glossId, variantId, lexemeId, lemma }[]>`; `deleteEntry({ enrollmentId, glossId })`.
  - `ProgressRow`, `AnsweredQuestion`, `SnapshotRow`, `ProgressChange` carry `glossId` instead of `senseId`; `ProgressRepo.findRows({ enrollmentId, glossIds, savedBy })`.
  - `LexemeRendering` gains `glossId`; `SavedEntry` is `{ glossId, variantId, addedBy }`; `WordSummary.headlineGlossId`.
  - `firstPerGloss(entries: VocabularyEntryInput[])` replaces `firstPerSense`.
  - `InvalidVocabularyEntry(glossId: string)`.
- Produces, in `tests/support`: `seedSavedSenses(db, input)` keeps its input and returns `{ lexemeId, variantId, senseIds, glossIds }`, saving by gloss; progress and photo helpers speak glosses (Step 10).

- [ ] **Step 1: Write the failing migration test.** It starts at `0021`, so it runs `0022` and `0023` together, as a deploy will. Append to `apps/server/tests/integration/db/migrations.test.ts`:

```ts
describe('0023_glosses_rekey', () => {
  it("folds two saves of one gloss into one, keeping the earliest save and each dimension's best, and folds the sessions that asked both", async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0021_enrollment_grants'));
    const DIMS = sql.raw(`array['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling']`);
    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he'), ('u_2', 'u_2', 'two', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'it'), ('e_2', 'u_2', 'he', 'it');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech) values ('l_con', 'it', 'con', 'preposition');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s_with', 'l_con', 'accompaniment'), ('s_by', 'l_con', 'instrument'), ('s_and', 'l_con', 'manner');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v_con', 'l_con', 'it', 'con', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank, example_source, example_target)
        values ('v_con', 's_with', 'he', 'עם', 0, 'Vado con lei.', 'אני הולך איתה.'),
               ('v_con', 's_by', 'he', 'עם', 1, 'Scrivo con la penna.', 'אני כותב עם העט.'),
               ('v_con', 's_and', 'he', 'בעזרת', 2, null, null);
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, added_by_user_id, created_at)
        values ('e_1', 's_by', 'l_con', 'con', 'v_con', 'u_1', '2026-02-01'),
               ('e_1', 's_with', 'l_con', 'con', 'v_con', 'u_1', '2026-01-01'),
               ('e_1', 's_and', 'l_con', 'con', 'v_con', 'u_1', '2026-01-15'),
               ('e_2', 's_by', 'l_con', 'con', 'v_con', 'u_2', '2026-03-01');
    `);
    await db.execute(sql`
      insert into sense_progress (enrollment_id, sense_id, dimension)
        select ve.enrollment_id, ve.sense_id, d from vocabulary_entries ve cross join unnest(${DIMS}) d`);
    await db.execute(sql`
      update sense_progress set level = 3, last_step_on = '2026-03-01'
        where enrollment_id = 'e_1' and sense_id = 's_with' and dimension = 'written_receptive';
      update sense_progress set level = 2, last_step_on = '2026-03-05', last_wrong_on = '2026-03-04'
        where enrollment_id = 'e_1' and sense_id = 's_by' and dimension = 'written_receptive';
      update sense_progress set level = 4
        where enrollment_id = 'e_1' and sense_id = 's_by' and dimension = 'written_productive';
      insert into sessions (id, user_id, enrollment_id, status, source, completed_at)
        values ('00000000-0000-0000-0000-000000000031', 'u_1', 'e_1', 'completed', 'list', now());
      insert into questions (id, user_id, enrollment_id, sense_id, prompt_variant_id, target_language, user_language_code, type, options)
        values ('q_with', 'u_1', 'e_1', 's_with', 'v_con', 'it', 'he', 'multiple_choice',
                '[{"position":0,"text":"עם","is_correct":true},{"position":1,"text":"בלי","is_correct":false}]'),
               ('q_by', 'u_1', 'e_1', 's_by', 'v_con', 'it', 'he', 'multiple_choice',
                '[{"position":0,"text":"עם","is_correct":true},{"position":1,"text":"בלי","is_correct":false}]');
      insert into photo_imports (id, enrollment_id, status) values ('00000000-0000-0000-0000-000000000032', 'e_1', 'read');
      insert into photo_import_items (import_id, position, text, hebrew, status, options, suggested_sense_id, chosen_sense_id, ticked)
        values ('00000000-0000-0000-0000-000000000032', 0, 'con', 'עם', 'ready',
                '[{"sense_id":"s_with","variant_id":"v_con","translation":"עם","example":{"source":"Vado con lei.","target":"אני הולך איתה."}},
                  {"sense_id":"s_by","variant_id":"v_con","translation":"עם","example":{"source":"Scrivo con la penna.","target":"אני כותב עם העט."}},
                  {"sense_id":"s_and","variant_id":"v_con","translation":"בעזרת"}]',
                's_with', 's_by', true);
    `);
    await db.execute(sql`
      insert into session_progress (session_id, sense_id, dimension, level_before, level_after)
        select '00000000-0000-0000-0000-000000000031', s, d,
               case when d = 'written_receptive' and s = 's_with' then 2 else 1 end,
               case when d = 'written_receptive' and s = 's_with' then 3 when d = 'written_receptive' then 2 else 1 end
        from unnest(array['s_with', 's_by']) s cross join unnest(${DIMS}) d`);

    await runMigrations(db);

    const glossOf = async (key: string) =>
      (await db.execute<{ id: string }>(sql`select id from dict_glosses where key = ${key}`)).rows[0].id;
    const im = await glossOf('עם');
    const beezrat = await glossOf('בעזרת');

    const entries = await db.execute<{ enrollment_id: string; gloss_id: string; variant_id: string; added_by_user_id: string; saved: string }>(sql`
      select enrollment_id, gloss_id, variant_id, added_by_user_id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as saved
      from vocabulary_entries order by enrollment_id, saved`);
    expect(entries.rows).toEqual([
      { enrollment_id: 'e_1', gloss_id: im, variant_id: 'v_con', added_by_user_id: 'u_1', saved: '2026-01-01' },
      { enrollment_id: 'e_1', gloss_id: beezrat, variant_id: 'v_con', added_by_user_id: 'u_1', saved: '2026-01-15' },
      { enrollment_id: 'e_2', gloss_id: im, variant_id: 'v_con', added_by_user_id: 'u_2', saved: '2026-03-01' },
    ]);

    const progress = await db.execute<{ dimension: string; level: number; last_step_on: string | null; last_wrong_on: string | null }>(sql`
      select dimension, level, last_step_on::text, last_wrong_on::text from gloss_progress
      where enrollment_id = 'e_1' and gloss_id = ${im} order by dimension`);
    expect(progress.rows).toEqual([
      { dimension: 'spelling', level: 1, last_step_on: null, last_wrong_on: null },
      { dimension: 'spoken_productive', level: 1, last_step_on: null, last_wrong_on: null },
      { dimension: 'spoken_receptive', level: 1, last_step_on: null, last_wrong_on: null },
      { dimension: 'written_productive', level: 4, last_step_on: null, last_wrong_on: null },
      { dimension: 'written_receptive', level: 3, last_step_on: '2026-03-05', last_wrong_on: '2026-03-04' },
    ]);
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from gloss_progress`)).rows[0].n).toBe(15);

    const snapshot = await db.execute<{ gloss_id: string; dimension: string; level_before: number; level_after: number }>(sql`
      select gloss_id, dimension, level_before, level_after from session_progress order by dimension`);
    expect(snapshot.rows).toHaveLength(5);
    expect(snapshot.rows.every((row) => row.gloss_id === im)).toBe(true);
    expect(snapshot.rows.find((row) => row.dimension === 'written_receptive')).toMatchObject({ level_before: 1, level_after: 3 });

    const questions = await db.execute<{ id: string; gloss_id: string }>(sql`select id, gloss_id from questions order by id`);
    expect(questions.rows).toEqual([{ id: 'q_by', gloss_id: im }, { id: 'q_with', gloss_id: im }]);

    const item = await db.execute<{ options: unknown; suggested_gloss_id: string; chosen_gloss_id: string }>(sql`
      select options, suggested_gloss_id, chosen_gloss_id from photo_import_items`);
    expect(item.rows[0]).toEqual({
      options: [
        {
          gloss_id: im,
          variant_id: 'v_con',
          translation: 'עם',
          examples: [
            { source: 'Vado con lei.', target: 'אני הולך איתה.' },
            { source: 'Scrivo con la penna.', target: 'אני כותב עם העט.' },
          ],
        },
        { gloss_id: beezrat, variant_id: 'v_con', translation: 'בעזרת' },
      ],
      suggested_gloss_id: im,
      chosen_gloss_id: im,
    });

    const gone = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from information_schema.columns
      where (table_name = 'dict_var_translations' and column_name = 'definition_notes')
         or column_name in ('sense_id', 'suggested_sense_id', 'chosen_sense_id') and table_name in
            ('vocabulary_entries', 'gloss_progress', 'session_progress', 'questions', 'photo_import_items')`);
    expect(gone.rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/db/migrations.test.ts -t 0023`. Expected: FAIL, `relation "gloss_progress" does not exist`.

- [ ] **Step 3: The schema.** In `apps/server/src/db/schema.ts`:

`dictVarTranslations`: delete `definitionNotes` (spec D9: empty on lane 0 and read by nothing).

`vocabularyEntries`: replace the `senseId` column, the primary key and `vocabulary_entries_sense_fk`:

```ts
    // Phase 31 (spec D2). The gloss saved: one target word of one headword in the
    // enrollment's learner language. Was sense_id (phase 18).
    glossId: text('gloss_id').notNull(),
```

```ts
    primaryKey({ name: 'vocabulary_entries_pkey', columns: [t.enrollmentId, t.glossId] }),
```

```ts
    // Phase 31. The gloss AND the lexeme, through dict_glosses_id_lexeme_key: an
    // entry's copied lexeme is its gloss's, which the sense key never held.
    foreignKey({
      name: 'vocabulary_entries_gloss_fk',
      columns: [t.glossId, t.lexemeId],
      foreignColumns: [dictGlosses.id, dictGlosses.lexemeId],
    }).onDelete('cascade'),
```

Rename `senseProgress` to `glossProgress` (export and table), and update the comment's first line to "Phase 20, re-keyed in phase 31 (spec D16). How well a learner knows one saved gloss …":

```ts
export const glossProgress = pgTable(
  'gloss_progress',
  {
    enrollmentId: text('enrollment_id').notNull(),
    glossId: text('gloss_id').notNull(),
    dimension: text('dimension').notNull(),
    level: integer('level').notNull().default(1),
    lastStepOn: date('last_step_on', { mode: 'string' }),
    lastWrongOn: date('last_wrong_on', { mode: 'string' }),
  },
  (t) => [
    primaryKey({ name: 'gloss_progress_pkey', columns: [t.enrollmentId, t.glossId, t.dimension] }),
    // ON UPDATE CASCADE (phase 31): a merge moves an entry to its survivor
    // gloss, and its five rows follow it.
    foreignKey({
      name: 'gloss_progress_entry_fk',
      columns: [t.enrollmentId, t.glossId],
      foreignColumns: [vocabularyEntries.enrollmentId, vocabularyEntries.glossId],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    check(
      'gloss_progress_dimension_known',
      sql`${t.dimension} in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')`,
    ),
    check('gloss_progress_level_range', sql`${t.level} between 1 and 5`),
    index('gloss_progress_enrollment_dimension_idx').on(t.enrollmentId, t.dimension, t.glossId, t.level),
  ],
);
```

`sessionProgress`: `senseId: text('sense_id')` becomes `glossId: text('gloss_id').notNull()`, and its key `primaryKey({ name: 'session_progress_pkey', columns: [t.sessionId, t.glossId, t.dimension] })`.

`questions`: replace the `senseId` column (and its `.references`) with

```ts
    // Phase 31. The gloss the card practises; prompt_variant_id names the one
    // form's rendering of one member it was built from (spec D12).
    glossId: text('gloss_id').notNull(),
```

and add `foreignKey({ name: 'questions_gloss_fk', columns: [t.glossId], foreignColumns: [dictGlosses.id] }),` to its constraints.

`photoImportItems`: `suggestedSenseId` and `chosenSenseId` become `suggestedGlossId: text('suggested_gloss_id')` and `chosenGlossId: text('chosen_gloss_id')`, and the check becomes `check('photo_import_items_tick_needs_gloss', sql\`not ${t.ticked} or ${t.chosenGlossId} is not null\`)`. Its `options` column keeps `$type<PhotoImportOption[]>()`: the type changes shape in Step 6.

- [ ] **Step 4: Write the migration by hand.** `npm run db:generate -w apps/server -- --custom --name glosses_rekey`. Expected: an empty `0023_glosses_rekey.sql`, `meta/0023_snapshot.json` and a journal entry. Fill the SQL file with exactly this:

```sql
-- Phase 31 (spec §2, migration steps 4-6). Every learner table names a gloss
-- instead of a sense. Hand-written (drizzle-kit generate --custom): drizzle reads
-- a dropped sense_id beside a new gloss_id as a possible rename and stops to ask.
-- 0022_glosses gave every rendered sense a gloss in each language it is rendered
-- in, which is what each fill below joins through.
ALTER TABLE "vocabulary_entries" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "sense_progress" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "session_progress" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "photo_import_items" ADD COLUMN "suggested_gloss_id" text;--> statement-breakpoint
ALTER TABLE "photo_import_items" ADD COLUMN "chosen_gloss_id" text;--> statement-breakpoint
-- Each row's gloss, through the membership in the language the row is about.
UPDATE "vocabulary_entries" ve SET "gloss_id" = m."gloss_id"
  FROM "enrollments" e, "dict_sense_glosses" m
  WHERE e."id" = ve."enrollment_id" AND m."sense_id" = ve."sense_id"
    AND m."user_language_code" = e."source_language";--> statement-breakpoint
UPDATE "sense_progress" p SET "gloss_id" = ve."gloss_id"
  FROM "vocabulary_entries" ve
  WHERE ve."enrollment_id" = p."enrollment_id" AND ve."sense_id" = p."sense_id";--> statement-breakpoint
UPDATE "session_progress" sp SET "gloss_id" = m."gloss_id"
  FROM "sessions" s, "enrollments" e, "dict_sense_glosses" m
  WHERE s."id" = sp."session_id" AND e."id" = s."enrollment_id"
    AND m."sense_id" = sp."sense_id" AND m."user_language_code" = e."source_language";--> statement-breakpoint
UPDATE "questions" q SET "gloss_id" = m."gloss_id"
  FROM "dict_sense_glosses" m
  WHERE m."sense_id" = q."sense_id" AND m."user_language_code" = q."user_language_code";--> statement-breakpoint
UPDATE "photo_import_items" i SET
    "suggested_gloss_id" = (SELECT m."gloss_id" FROM "photo_imports" pi
                              JOIN "enrollments" e ON e."id" = pi."enrollment_id"
                              JOIN "dict_sense_glosses" m ON m."sense_id" = i."suggested_sense_id"
                                                         AND m."user_language_code" = e."source_language"
                              WHERE pi."id" = i."import_id"),
    "chosen_gloss_id" = (SELECT m."gloss_id" FROM "photo_imports" pi
                           JOIN "enrollments" e ON e."id" = pi."enrollment_id"
                           JOIN "dict_sense_glosses" m ON m."sense_id" = i."chosen_sense_id"
                                                      AND m."user_language_code" = e."source_language"
                           WHERE pi."id" = i."import_id");--> statement-breakpoint
-- A photo row's options become gloss cards (spec D15): one per gloss, in the
-- order of its first option, with every member's example.
UPDATE "photo_import_items" i SET "options" = coalesce((
    SELECT jsonb_agg(o."card" ORDER BY o."first")
    FROM (
      SELECT min(x."ord") AS "first",
             jsonb_strip_nulls(jsonb_build_object(
               'gloss_id', m."gloss_id",
               'variant_id', (array_agg(x."opt"->>'variant_id' ORDER BY x."ord"))[1],
               'translation', (array_agg(x."opt"->>'translation' ORDER BY x."ord"))[1],
               'part_of_speech', (array_agg(x."opt"->>'part_of_speech' ORDER BY x."ord"))[1],
               'examples', jsonb_agg(x."opt"->'example' ORDER BY x."ord") FILTER (WHERE x."opt" ? 'example')
             )) AS "card"
      FROM jsonb_array_elements(i."options") WITH ORDINALITY AS x("opt", "ord")
      JOIN "photo_imports" pi ON pi."id" = i."import_id"
      JOIN "enrollments" e ON e."id" = pi."enrollment_id"
      JOIN "dict_sense_glosses" m ON m."sense_id" = x."opt"->>'sense_id' AND m."user_language_code" = e."source_language"
      GROUP BY m."gloss_id"
    ) o
  ), '[]'::jsonb)
  WHERE jsonb_array_length(i."options") > 0;--> statement-breakpoint
-- Spec D3 and done-means 4. A learner who saved two senses of one gloss keeps
-- one entry, the earliest save with its form and its adder, at each dimension's
-- highest level with the later dates (mergeLevels, domain/glosses.ts). The
-- progress folds first, onto the kept entry's rows, while both entries exist.
UPDATE "sense_progress" p SET
    "level" = f."level", "last_step_on" = f."last_step_on", "last_wrong_on" = f."last_wrong_on"
  FROM (
    SELECT "enrollment_id", "gloss_id", "dimension", max("level") AS "level",
           max("last_step_on") AS "last_step_on", max("last_wrong_on") AS "last_wrong_on"
    FROM "sense_progress" GROUP BY "enrollment_id", "gloss_id", "dimension" HAVING count(*) > 1
  ) f,
  (
    SELECT DISTINCT ON ("enrollment_id", "gloss_id") "enrollment_id", "gloss_id", "sense_id"
    FROM "vocabulary_entries" ORDER BY "enrollment_id", "gloss_id", "created_at", "sense_id"
  ) kept
  WHERE p."enrollment_id" = f."enrollment_id" AND p."gloss_id" = f."gloss_id" AND p."dimension" = f."dimension"
    AND kept."enrollment_id" = p."enrollment_id" AND kept."sense_id" = p."sense_id";--> statement-breakpoint
-- The other entries go, and their progress rows with them (sense_progress_entry_fk cascades).
DELETE FROM "vocabulary_entries" ve
  USING (
    SELECT DISTINCT ON ("enrollment_id", "gloss_id") "enrollment_id", "gloss_id", "sense_id"
    FROM "vocabulary_entries" ORDER BY "enrollment_id", "gloss_id", "created_at", "sense_id"
  ) kept
  WHERE kept."enrollment_id" = ve."enrollment_id" AND kept."gloss_id" = ve."gloss_id"
    AND kept."sense_id" <> ve."sense_id";--> statement-breakpoint
-- A session that practised two senses of one gloss: one row per dimension, the
-- lowest level before and the highest after (mergeSnapshots), which keeps
-- session_progress_levels_valid true. Lane 0 has 16 such sessions.
UPDATE "session_progress" sp SET "level_before" = f."level_before", "level_after" = f."level_after"
  FROM (
    SELECT "session_id", "gloss_id", "dimension", min("level_before") AS "level_before",
           max("level_after") AS "level_after", min("sense_id") AS "kept"
    FROM "session_progress" GROUP BY "session_id", "gloss_id", "dimension" HAVING count(*) > 1
  ) f
  WHERE sp."session_id" = f."session_id" AND sp."gloss_id" = f."gloss_id"
    AND sp."dimension" = f."dimension" AND sp."sense_id" = f."kept";--> statement-breakpoint
DELETE FROM "session_progress" sp
  USING (
    SELECT "session_id", "gloss_id", "dimension", min("sense_id") AS "kept"
    FROM "session_progress" GROUP BY "session_id", "gloss_id", "dimension" HAVING count(*) > 1
  ) f
  WHERE sp."session_id" = f."session_id" AND sp."gloss_id" = f."gloss_id"
    AND sp."dimension" = f."dimension" AND sp."sense_id" <> f."kept";--> statement-breakpoint
-- The keys. The progress FK goes first: it depends on the entries' primary key.
ALTER TABLE "sense_progress" DROP CONSTRAINT "sense_progress_entry_fk";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" DROP CONSTRAINT "vocabulary_entries_pkey";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" DROP CONSTRAINT "vocabulary_entries_sense_fk";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_pkey" PRIMARY KEY("enrollment_id","gloss_id");--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_gloss_fk" FOREIGN KEY ("gloss_id","lexeme_id") REFERENCES "public"."dict_glosses"("id","lexeme_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sense_progress" RENAME TO "gloss_progress";--> statement-breakpoint
ALTER TABLE "gloss_progress" DROP CONSTRAINT "sense_progress_pkey";--> statement-breakpoint
-- Dropping the column drops sense_progress_enrollment_dimension_idx with it.
ALTER TABLE "gloss_progress" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "gloss_progress" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "gloss_progress" ADD CONSTRAINT "gloss_progress_pkey" PRIMARY KEY("enrollment_id","gloss_id","dimension");--> statement-breakpoint
ALTER TABLE "gloss_progress" ADD CONSTRAINT "gloss_progress_entry_fk" FOREIGN KEY ("enrollment_id","gloss_id") REFERENCES "public"."vocabulary_entries"("enrollment_id","gloss_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gloss_progress" RENAME CONSTRAINT "sense_progress_dimension_known" TO "gloss_progress_dimension_known";--> statement-breakpoint
ALTER TABLE "gloss_progress" RENAME CONSTRAINT "sense_progress_level_range" TO "gloss_progress_level_range";--> statement-breakpoint
CREATE INDEX "gloss_progress_enrollment_dimension_idx" ON "gloss_progress" USING btree ("enrollment_id","dimension","gloss_id","level");--> statement-breakpoint
ALTER TABLE "session_progress" DROP CONSTRAINT "session_progress_pkey";--> statement-breakpoint
ALTER TABLE "session_progress" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "session_progress" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "session_progress" ADD CONSTRAINT "session_progress_pkey" PRIMARY KEY("session_id","gloss_id","dimension");--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_sense_id_dict_senses_id_fk";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_gloss_fk" FOREIGN KEY ("gloss_id") REFERENCES "public"."dict_glosses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_import_items" DROP CONSTRAINT "photo_import_items_tick_needs_sense";--> statement-breakpoint
ALTER TABLE "photo_import_items" DROP COLUMN "suggested_sense_id";--> statement-breakpoint
ALTER TABLE "photo_import_items" DROP COLUMN "chosen_sense_id";--> statement-breakpoint
ALTER TABLE "photo_import_items" ADD CONSTRAINT "photo_import_items_tick_needs_gloss" CHECK (not "photo_import_items"."ticked" or "photo_import_items"."chosen_gloss_id" is not null);--> statement-breakpoint
ALTER TABLE "dict_var_translations" DROP COLUMN "definition_notes";
```

Then `npm run db:check -w apps/server` (no errors) and `npm run db:generate -w apps/server` (nothing to generate). If the second run proposes changes, `schema.ts` and the hand-written SQL disagree on a name: make `schema.ts` say what the SQL says, delete the files the second run wrote, and repeat.

- [ ] **Step 5: Run the migration test.** The command of Step 2. Expected: PASS. The rest of the server does not compile yet; Steps 6–10 fix that.

- [ ] **Step 6: The wire.** From the worktree root, run:

```bash
sed -i '' -e 's/saved_sense_ids/saved_gloss_ids/g' -e 's/chosen_sense_id/chosen_gloss_id/g' -e 's/sense_id/gloss_id/g' \
  -e 's/SenseProgress/GlossProgress/g' \
  packages/core/src/api/schemas.ts packages/core/src/api/schemas.test.ts packages/core/src/api/types.ts packages/core/src/api/index.ts
```

Then replace `PhotoImportOptionSchema`:

```ts
// One saveable gloss of a row's word: a snapshot of the lookup's card (spec
// D15). Phase 31: a gloss, with one example per member sense.
export const PhotoImportOptionSchema = z.object({
  gloss_id: z.string(),
  variant_id: z.string(),
  translation: z.string(),
  part_of_speech: z.string().optional(),
  examples: z.array(z.object({ source: z.string(), target: z.string() })).optional(),
  alternatives: z.array(z.string()).optional(),
});
```

Reread every comment the `sed` touched in `schemas.ts` and fix any that now says "gloss" where it means a dictionary sense.

- [ ] **Step 7: Server domain.** Write the learner renames with the Write tool to `<scratchpad>/gloss-renames.sed`, never inside the worktree or the main checkout. They are ordered so no rule eats a prefix of a later one:

```sed
s/saved_sense_ids/saved_gloss_ids/g
s/chosen_sense_id/chosen_gloss_id/g
s/suggested_sense_id/suggested_gloss_id/g
s/sense_progress/gloss_progress/g
s/senseProgress/glossProgress/g
s/SenseProgress/GlossProgress/g
s/sense_id/gloss_id/g
s/senseIds/glossIds/g
s/senseId/glossId/g
s/SenseIds/GlossIds/g
s/SenseId/GlossId/g
s/firstPerSense/firstPerGloss/g
s/listSavedSenses/listSavedGlosses/g
s/unknown_sense/unknown_gloss/g
s/changedSense/changedGloss/g
s/changed_sense_count/changed_gloss_count/g
s/sessionSenseEntries/sessionGlossEntries/g
s/saveSessionSenses/saveSessionGlosses/g
s/selectSessionSenses/selectSessionGlosses/g
s/AskedSense/AskedGloss/g
```

Apply it to the files where every sense id is the learner's unit (from the worktree root):

```bash
sed -i '' -f <scratchpad>/gloss-renames.sed \
  apps/server/src/domain/progress.ts apps/server/src/domain/progress.test.ts \
  apps/server/src/domain/photoImports.ts apps/server/src/domain/photoImports.test.ts \
  apps/server/src/repo/progress.ts apps/server/src/repo/photoImports.ts apps/server/src/db/progressRecompute.ts \
  apps/server/src/services/vocabulary.ts apps/server/src/services/photoImports.ts \
  apps/server/src/services/photoImports.test.ts apps/server/src/services/photoImports.jobs.test.ts \
  apps/server/src/services/sessions.progress.test.ts apps/server/src/routes/sessions.ts apps/server/src/routes/photoImports.ts
```

Then, by hand:

`domain/dictionary.ts`: `SenseRow` gains `glossId: string;` (comment: "Phase 31. The sense's gloss in the read's learner language."). In `rowsToSenses`, `sense_id: row.senseId` becomes `gloss_id: row.glossId`.

`domain/distractors.ts`: `GenerationContext` gains `glossId: string;` above `senseId` (comment: "Phase 31. The gloss the card practises; senseId and variantId name the rendering it is built from."). `RecentSentences` becomes `Map<string /* glossId */, …>` and `avoidFor` reads `recent.get(row.glossId)`.

`domain/jobs.ts`: the picks schema becomes

```ts
    .array(
      z.object({
        // Phase 31. The gloss practised, and the rendering its card is built
        // from: one member sense in one form (spec D12).
        gloss_id: z.string().min(1),
        sense_id: z.string().min(1),
        variant_id: z.string().min(1),
      }),
    )
```

`domain/vocabulary.ts`:
- `WordSummary.headlineSenseId` → `headlineGlossId`; `assemblePage`'s headline is `{ gloss_id: s.headlineGlossId, translation: s.headlineTranslation, form: s.headlineForm }`.
- `LexemeRendering` gains `glossId: string;` after `senseId`.
- `SavedEntry` becomes `{ glossId: string; variantId: string; addedBy: string | null }`.
- `senseProgressOf` → `glossProgressOf`, typed with `GlossProgress`.
- In `buildWordDetail`, the saved and progress maps key on the gloss: `savedVariant`, `addedBy` and `progressByGloss` are built from `entry.glossId` / `row.glossId`, and each per-sense card looks itself up by its rendering's gloss:

```ts
  const shown = [...bySense.entries()].map(([, options]) => {
    const glossId = options[0].glossId;
    const own = savedVariant.get(glossId);
    const rendering = options.find((o) => o.variantId === own) ?? [...options].sort(better)[0];
    return { rendering, partOfSpeech: partOfSpeech.get(rendering.lexemeId) ?? '', saved: savedVariant.has(glossId) };
  });
```

  and the card emits `gloss_id: r.glossId`, `added_by` from `addedBy.get(r.glossId)`, `progress` from `progressByGloss.get(r.glossId)`. The sort's last tie-breaker stays `senseId`.
- `markSaved` reads `sense.gloss_id`; `firstPerSense` becomes `firstPerGloss`, keyed on `entry.gloss_id`.

`domain/photoImports.ts`: `optionsFrom` builds the new option shape. Cards are still one per sense here, so it folds them by gloss (Task 7 makes it a plain map):

```ts
/** A lookup's saveable glosses, in its order: one option per gloss, with every
 *  example its cards carry (spec D10, D15). */
export function optionsFrom(senses: readonly TranslationSense[]): PhotoImportOption[] {
  const byGloss = new Map<string, PhotoImportOption>();
  for (const sense of senses) {
    if (!sense.gloss_id || !sense.variant_id) continue;
    const examples = sense.example ? [sense.example] : [];
    const seen = byGloss.get(sense.gloss_id);
    if (seen) {
      if (examples.length > 0) seen.examples = [...(seen.examples ?? []), ...examples];
      continue;
    }
    byGloss.set(sense.gloss_id, {
      gloss_id: sense.gloss_id,
      variant_id: sense.variant_id,
      translation: sense.translation,
      ...(sense.part_of_speech ? { part_of_speech: sense.part_of_speech } : {}),
      ...(examples.length > 0 ? { examples } : {}),
    });
  }
  return [...byGloss.values()];
}
```

- [ ] **Step 8: Server repositories.** Run `sed -i '' -f <scratchpad>/gloss-renames.sed apps/server/src/repo/vocabulary.ts`. Then put back the one line the sed breaks outside the queries below: `wordSummaries`' `sense_count` subquery counts dictionary senses until Task 7 replaces it, so its `WHERE r.gloss_id = s.id` returns to `WHERE r.sense_id = s.id` (`dict_var_translations` has no `gloss_id`). Then replace by hand the three queries whose sense ids are dictionary senses:

`SaveableEntry` becomes `{ glossId: string; variantId: string; lexemeId: string; lemma: string }`, and `vocabularyQueries.saveable`:

```ts
  /** Which asked pairs may be saved (spec D2, D14): the gloss is live and in the
   *  enrollment's learner language, its lexeme is in the target language, and the
   *  variant is a form of that lexeme rendering one of the gloss's senses in the
   *  learner's language. Primary-key and index lookups throughout. */
  saveable: (input: {
    entries: { glossId: string; variantId: string }[];
    targetLanguage: string;
    sourceLanguage: string;
  }): SQL => sql`
    SELECT g.id AS gloss_id, v.id AS variant_id, l.id AS lexeme_id, l.lemma
    FROM (VALUES ${sql.join(
      input.entries.map((e) => sql`(${e.glossId}::text, ${e.variantId}::text)`),
      sql`, `,
    )}) AS asked(gloss_id, variant_id)
    JOIN dict_glosses g  ON g.id = asked.gloss_id
                        AND g.merged_into IS NULL
                        AND g.user_language_code = ${input.sourceLanguage}
    JOIN dict_lexemes l  ON l.id = g.lexeme_id
                        AND l.language_code = ${input.targetLanguage}
    JOIN dict_variants v ON v.id = asked.variant_id
                        AND v.lexeme_id = l.id
    WHERE EXISTS (
      SELECT 1 FROM dict_sense_glosses m
      JOIN dict_var_translations tr ON tr.sense_id = m.sense_id
                                   AND tr.user_language_code = m.user_language_code
                                   AND tr.variant_id = v.id
      WHERE m.gloss_id = g.id)`,
```

The headline lateral of `wordSummaries` (its `sense_count` subquery stays until Task 7):

```ts
    JOIN LATERAL (
      SELECT ve.gloss_id, tr.translation, v.form
      FROM vocabulary_entries ve
      JOIN dict_sense_glosses m     ON m.gloss_id = ve.gloss_id
      JOIN dict_var_translations tr ON tr.variant_id = ve.variant_id
                                   AND tr.sense_id = m.sense_id
                                   AND tr.user_language_code = ${input.sourceLanguage}
      JOIN dict_variants v          ON v.id = ve.variant_id
      WHERE ve.enrollment_id = ${input.enrollmentId}
        AND ve.lemma = w.lemma
      ORDER BY tr.rank, ve.created_at, ve.gloss_id
      LIMIT 1
    ) h ON true`,
```

with `h.gloss_id AS headline_gloss_id` in its select list. `lemmaRenderings`:

```ts
  lemmaRenderings: (input: { languageCode: string; lemma: string; userLanguageCode: string }): SQL => sql`
    SELECT s.lexeme_id, tr.sense_id, m.gloss_id, tr.variant_id, v.form, tr.rank, tr.translation,
           tr.example_source, tr.example_target
    FROM dict_lexemes l
    JOIN dict_senses s            ON s.lexeme_id = l.id
    JOIN dict_var_translations tr ON tr.sense_id = s.id
                                 AND tr.user_language_code = ${input.userLanguageCode}
    JOIN dict_sense_glosses m     ON m.sense_id = tr.sense_id
                                 AND m.user_language_code = tr.user_language_code
    JOIN dict_variants v          ON v.id = tr.variant_id
    WHERE l.language_code = ${input.languageCode}
      AND l.lemma = ${input.lemma}`,
```

and `findLemmaRenderings` maps `senseId: row.sense_id, glossId: row.gloss_id` (fix what the `sed` did to that mapping and to the row type). `listSavedGlosses` becomes:

```ts
    /** Every saved gloss of one enrollment, with the sense its saved form ranks
     *  first, for picking a list session. Ordered so a seeded rng picks
     *  reproducibly. Task 11 replaces the sense with a rendering chosen per pick. */
    listSavedGlosses: async (enrollmentId: string): Promise<{ glossId: string; senseId: string; variantId: string }[]> => {
      const rows = await tx.execute<{ gloss_id: string; sense_id: string; variant_id: string }>(sql`
        SELECT DISTINCT ON (ve.gloss_id) ve.gloss_id, tr.sense_id, ve.variant_id
        FROM vocabulary_entries ve
        JOIN dict_sense_glosses m     ON m.gloss_id = ve.gloss_id
        JOIN dict_var_translations tr ON tr.variant_id = ve.variant_id
                                     AND tr.sense_id = m.sense_id
                                     AND tr.user_language_code = m.user_language_code
        WHERE ve.enrollment_id = ${enrollmentId}
        ORDER BY ve.gloss_id, tr.rank`);
      return rows.rows.map((row) => ({ glossId: row.gloss_id, senseId: row.sense_id, variantId: row.variant_id }));
    },
```

`repo/dictionary.ts`, `findSensesByForm`: select `glossId: dictSenseGlosses.glossId` and add, after the join to `dictVarTranslations`,

```ts
      // Phase 31 (spec D8). Every rendered sense has its gloss in this language.
      .innerJoin(
        dictSenseGlosses,
        and(eq(dictSenseGlosses.senseId, dictSenses.id), eq(dictSenseGlosses.userLanguageCode, input.userLanguageCode)),
      )
```

`repo/questions.ts`:
- `findGenerationContext` takes `picks: { glossId: string; senseId: string; variantId: string }[]`, carries `asked.gloss_id` through the `VALUES` list (`AS asked(gloss_id, sense_id, variant_id)`), selects `asked.gloss_id`, keys `found` on `` `${row.gloss_id} ${row.sense_id} ${row.variant_id}` ``, and returns `glossId: row.gloss_id` beside `senseId`.
- `findRecentSentences` takes `glossIds`, partitions and filters on `q.gloss_id`, and keys the map on `row.gloss_id`.
- `findJudgeContext` reaches the example through the gloss's members:

```sql
        SELECT v.form, l.lemma, l.part_of_speech, q.prompt, tr.example_source, tr.example_target
        FROM questions q
        JOIN dict_variants v  ON v.id = q.prompt_variant_id
        JOIN dict_lexemes l   ON l.id = v.lexeme_id
        LEFT JOIN LATERAL (
          SELECT tr.example_source, tr.example_target
          FROM dict_sense_glosses m
          JOIN dict_var_translations tr ON tr.sense_id = m.sense_id
                                       AND tr.user_language_code = m.user_language_code
                                       AND tr.variant_id = q.prompt_variant_id
          WHERE m.gloss_id = q.gloss_id AND m.user_language_code = q.user_language_code
          ORDER BY tr.rank
          LIMIT 1
        ) tr ON true
        WHERE q.id = ${questionId}
```

- `insertGeneratedQuestions`' input rows take `glossId` instead of `senseId`, and write `glossId: question.glossId`.

- [ ] **Step 9: Services, routes and the rest.**

`services/translations.ts`, in `translate`:

```ts
      const glossIds = response.senses.flatMap((sense) => (sense.gloss_id ? [sense.gloss_id] : []));
      if (glossIds.length === 0) return response;
      const saved = await transaction((repos) =>
        repos.vocabulary.findSavedGlossIds({ enrollmentId: enrollment.id, glossIds }),
      );
```

`services/sessions.ts`:
- `recordProgress`: `glossIds: [...new Set(evidence.answers.map((answer) => answer.glossId))]`.
- `createNextSession`: `const saved = await vocabulary.listSavedGlosses(enrollmentId);` and the job's picks are `picks.map((pick) => ({ gloss_id: pick.glossId, sense_id: pick.senseId, variant_id: pick.variantId }))`.
- `prepareSession`: `findGenerationContext({ picks: payload.picks.map((pick) => ({ glossId: pick.gloss_id, senseId: pick.sense_id, variantId: pick.variant_id })), sourceLanguage: enrolled.source_language })`; `findRecentSentences({ enrollmentId, glossIds: context.map((row) => row.glossId), limit: MAX_AVOID })`; and each question to insert carries `glossId: row.glossId` instead of `senseId`.

`routes/vocabulary.ts`, the unsave route:

```ts
const unsaveRoute = createRoute({
  method: 'delete',
  path: `${BASE}/glosses/{gloss_id}`,
  tags: ['vocabulary'],
  summary: 'Unsave a gloss',
  description: 'Idempotent: unsaving a gloss that is not saved also answers 204.',
  request: { params: z.object({ id: z.string(), gloss_id: z.string() }), headers: ActorHeadersSchema },
  responses: {
    204: { description: 'The gloss is not saved.' },
    400: json(ErrorSchema, 'The acting-user header is missing.'),
    403: json(ErrorSchema, "Only the list's owner may remove a word."),
    404: NOT_ENROLLED,
  },
});
```

and its handler reads `const { id, gloss_id } = c.req.valid('param');` and calls `vocabulary.unsave(actor, id, gloss_id)`. The save route's summary and descriptions say "glosses" where they say "senses".

`errors.ts`: `InvalidVocabularyEntry` takes `readonly glossId: string` and says `` `gloss ${glossId} cannot be saved here` ``; its comment names the gloss checks of `saveable`.

`db/seed.ts`: the shared question's `senseId: written[0].senseIds[0]` becomes `glossId: written[0].glossIds[0]`.

`src/openapi.test.ts`: both occurrences of `` `${BASE}/senses/{sense_id}` `` / `'/api/enrollments/{id}/vocabulary/senses/{sense_id}'` become the `glosses/{gloss_id}` path.

- [ ] **Step 10: Test fixtures.** `apps/server/tests/support/vocabularyRows.ts`, `seedSavedSenses` saves by gloss and returns the glosses:

```ts
  const variantId = word.variantIds[0];
  const addedByUserId = input.addedByUserId ?? (await ownerOf(db, input.enrollmentId));
  // Phase 31. Saved by gloss. Distinct translations make one gloss per sense, as
  // before; two equal ones are one gloss, saved once (spec D3).
  const glossIds = [...new Set(word.glossIds)];
  await withTx(db, (tx) =>
    createVocabularyRepo(tx).insertEntries({
      enrollmentId: input.enrollmentId,
      addedByUserId,
      entries: glossIds.map((glossId) => ({ glossId, variantId, lexemeId: word.lexemeId, lemma: input.lemma })),
    }),
  );
  return { lexemeId: word.lexemeId, variantId, senseIds: word.senseIds, glossIds: word.glossIds };
```

`progressRows.ts`: `senseProgress` → `glossProgress` throughout; `insertProgressRows(db, enrollmentId, glossIds)`, `setLevel({ enrollmentId, glossId, level, dimension })`, `StoredProgress.glossId`, `readSnapshot` ordered by `glossId`; `sessionSenseEntries` returns `{ gloss_id, variant_id }[]` (rename it `sessionGlossEntries`); `selectSessionSenses` selects `glossId: questions.glossId` (rename it `selectSessionGlosses`); `saveSessionSenses` → `saveSessionGlosses`, saving `{ glossId, variantId, lexemeId, lemma }` and returning gloss ids; `insertAnsweredSession`'s `asked` items are `{ glossId, variantId, translation }` and its questions write `glossId: item.glossId`.

`questions.ts`: `AskedSense` → `AskedGloss`, `senseId` → `glossId` (it builds questions through `insertGeneratedQuestions`, which now takes `glossId`).

`photoImportRows.ts` and `grantRows.ts`: `chosenSenseId`/`suggestedSenseId` → `chosenGlossId`/`suggestedGlossId`, and any `senseIds` read from `seedSavedSenses` → `glossIds`.

- [ ] **Step 11: Server tests.** List what still mentions a learner's sense:

```bash
grep -rlE "sense_id|senseId|senseIds|sense_progress|senseProgress|SenseProgress|saved_sense_ids|chosen_sense_id|firstPerSense|listSavedSenses|sessionSenseEntries|saveSessionSenses|AskedSense" apps/server/src apps/server/tests \
  | grep -vE "db/migrations/|tests/integration/db/migrations\.test\.ts|repo/dictionary(\.[a-z]+)?\.test\.ts|tests/eval/"
```

For each file listed, apply `sed -i '' -f <scratchpad>/gloss-renames.sed <file>` when every sense id in it is a learner's (route, service, progress, session, photo, vocabulary and grant tests), and edit by hand where it also builds dictionary rows. The rules for the hand edits:
- A test that inserts dictionary rows by SQL also inserts their gloss and membership, and its learner rows name the gloss: `insert into dict_glosses (id, lexeme_id, user_language_code, key) values ('g1', 'l1', 'he', 'עפיפון'); insert into dict_sense_glosses (sense_id, lexeme_id, user_language_code, gloss_id) values ('s1', 'l1', 'he', 'g1');`, every rendering insert names a `gloss`, and `vocabulary_entries`, `gloss_progress` and `questions` rows use `'g1'`.
- A test that builds rows through `insertLexeme` or `seedSavedSenses` uses the `glossIds` they return for learner rows and keeps `senseIds` for dictionary assertions.
- A unit test's `SenseRow`, `LexemeRendering` or `GenerationContext` fixture gains `glossId: \`g-${senseId}\``, one gloss per sense as before, and its expectations read `gloss_id`.
- `tests/integration/repo/vocabulary.plan.test.ts`: `WATCHED` lists `gloss_progress` instead of `sense_progress`, plus `dict_glosses` and `dict_sense_glosses`; `LOAD` writes `'pg' || g` glosses and memberships after the renderings, then entries and progress on `gloss_id`:

```ts
    `insert into dict_glosses (id, lexeme_id, user_language_code, key)
       select 'pg' || g, 'pl' || g, 'he', 'מילה' || g from generate_series(1, 20000) g`,
    `insert into dict_sense_glosses (sense_id, lexeme_id, user_language_code, gloss_id)
       select 'ps' || g, 'pl' || g, 'he', 'pg' || g from generate_series(1, 20000) g`,
    `insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, created_at, added_by_user_id)
       select 'pe' || e, 'pg' || s, 'pl' || s, 'слово' || s, 'pv' || s, now() - (s || ' seconds')::interval, 'pu' || e
       from generate_series(2, 1000) e, generate_series(1, 200) s`,
    `insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, created_at, added_by_user_id)
       select '${HEAVY}', 'pg' || s, 'pl' || s, 'слово' || s, 'pv' || s, now() - (s || ' seconds')::interval, 'pu1'
       from generate_series(1, 20000) s`,
    `insert into gloss_progress (enrollment_id, gloss_id, dimension, level)
       select ve.enrollment_id, ve.gloss_id, d, 1 + ((hashtext(ve.gloss_id || d) & 2147483647) % 5)
       from vocabulary_entries ve
       cross join unnest(array['written_receptive', 'written_productive', 'spoken_receptive',
                               'spoken_productive', 'spelling']) d`,
```

  and the `vacuum analyze` list names `gloss_progress`, `dict_glosses` and `dict_sense_glosses`. Its cases that name sense ids (`saveable`, `savedSenseIds`) take `pg` gloss ids.
- `tests/integration/db/schema.test.ts`: add `gloss_progress` to `TABLES` (the list never named `sense_progress`).
- `tests/eval/run.ts`: check its two mentions by hand; neither is a learner's.

Run `npm run typecheck -w apps/server` until it is clean, then `npm test` and `npm run test:integration`. Expected: PASS. A test that counted two saved senses of one target word now counts one: that is D3, so update its expectation and say which tests did so in the task report.

- [ ] **Step 12: The app and e2e.** From the worktree root:

```bash
sed -i '' -e 's/saved_sense_ids/saved_gloss_ids/g' -e 's/chosen_sense_id/chosen_gloss_id/g' -e 's/sense_id/gloss_id/g' \
  -e 's/senseIds/glossIds/g' -e 's/senseId/glossId/g' -e 's#/senses/#/glosses/#g' -e 's/SenseProgress/GlossProgress/g' \
  -e 's/keepSenseOrder/keepGlossOrder/g' \
  $(grep -rlE "sense_id|senseId|/senses/|SenseProgress|keepSenseOrder" apps/mobile/src)
sed -i '' -e 's/sense_id/gloss_id/g' e2e/tests/speaking.spec.ts e2e/tests/sentence-cards.spec.ts e2e/tests/listening-variety.spec.ts
```

Then in `apps/mobile/src/app/photo-imports/[id].tsx`, an option shows its examples, all of them (spec D10):

```tsx
                          <Meaning option={option} />
                          {(option.examples ?? []).map((example) => (
                            <View key={example.source}>
                              <Text style={[styles.exampleSource, { writingDirection: wordDirection }]}>{example.source}</Text>
                              <Text style={styles.meta}>{example.target}</Text>
                            </View>
                          ))}
```

`apps/mobile/src/photoImports.test.ts` fixtures that built an option with `example` give `examples: [ … ]`. Run `npm run typecheck` and `npm test` from the root. Expected: PASS.

- [ ] **Step 13: Run every gate and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch && npm run e2e`. Expected: PASS. Migrate the lane: `npm run db:migrate`.

```bash
git add -A apps packages e2e
git commit -m "feat: the learner's unit is the gloss — every learner table keyed on gloss_id, and the wire says gloss_id"
```

---

### Task 7: One card per gloss — the lookup, the word page and the list

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`TranslationSenseSchema`, `VocabularySenseSchema`, `VocabularyWordSchema`), `schemas.test.ts`
- Modify: `apps/server/src/domain/dictionary.ts` (`SenseRow`, `rowsToCards`, `flattenEntries`), `dictionary.test.ts`
- Modify: `apps/server/src/repo/dictionary.ts` (`findSensesByForm`, `persistEntries`' re-read)
- Modify: `apps/server/src/services/translations.ts` (`rowsToSenses` → `rowsToCards`)
- Modify: `apps/server/src/domain/vocabulary.ts` (`LexemeRendering`, `WordSummary`, `assemblePage`, `buildWordDetail`), `vocabulary.test.ts`
- Modify: `apps/server/src/repo/vocabulary.ts` (`lemmaRenderings`, `wordSummaries`)
- Modify: `apps/server/src/domain/photoImports.ts` (`optionsFrom`), `apps/server/src/repo/progress.ts` (`findSnapshot` reads the key)
- Modify: `apps/server/tests/eval/run.ts` (tier 1 reads `examples`), `apps/server/tests/support/fakes.ts`
- Modify: `apps/server/tests/integration/repo/dictionary.test.ts`, `tests/integration/services/translations.test.ts`, `tests/integration/routes/vocabulary.test.ts`, `tests/integration/repo/vocabulary.test.ts`, `tests/integration/repo/progress.test.ts`, and the unit tests that build `SenseRow` fixtures
- Modify: `apps/mobile/src/components/LookupPanel.tsx`, `app/vocabulary/word.tsx`, `app/vocabulary/index.tsx`, `src/vocabulary.ts` (they compile against the new cards; Task 8 finishes them), and `src/vocabulary.test.ts` (its fixtures say `gloss_count`)

**Interfaces:**
- Produces, on the wire:
  - `TranslationSense = { translation; part_of_speech?; examples?: { source; target }[]; alternatives?: string[]; key?: string; gloss_id?; variant_id?; saved? }`: one per gloss, at most five.
  - `VocabularySense = { gloss_id; variant_id; form; translation /* the key */; alternatives: string[]; part_of_speech; examples: { source; target }[]; saved; progress?; added_by?; saved_from?: { form; translation } }`.
  - `VocabularyWord.gloss_count` replaces `sense_count`; `headline.translation` is the gloss key.
  - A completed session's `progress` items carry the gloss key as `translation`, beside the form the session asked.
- Produces, in the server: `SenseRow` gains `glossKey: string` and `alternatives: string[]`; `rowsToCards(rows: SenseRow[]): TranslationSense[]` replaces `rowsToSenses`; `RESPONSE_CARD_CAP = 5`; `LexemeRendering` gains `glossKey: string` and `glossAlternatives: string[]`; `WordSummary.glossCount` replaces `senseCount`.

- [ ] **Step 1: Write the failing domain tests.** In `apps/server/src/domain/dictionary.test.ts` (import `rowsToCards`):

```ts
const row = (over: Partial<SenseRow> & Pick<SenseRow, 'senseId' | 'glossId' | 'translation' | 'rank'>): SenseRow => ({
  lexemeId: 'l1',
  variantId: 'v1',
  entryRank: 0,
  partOfSpeech: 'noun',
  exampleSource: null,
  exampleTarget: null,
  kind: 'word',
  glossKey: over.translation,
  alternatives: [],
  ...over,
});

describe('rowsToCards (phase 31, spec D10, D15)', () => {
  it('makes one card of two senses with one target word, with an example from each', () => {
    const cards = rowsToCards([
      row({ senseId: 's1', glossId: 'g1', translation: 'עכבר', rank: 0, exampleSource: 'The mouse ran.', exampleTarget: 'העכבר רץ.' }),
      row({ senseId: 's2', glossId: 'g1', translation: 'עכבר', rank: 1, exampleSource: 'Click the mouse.', exampleTarget: 'לחץ על העכבר.' }),
    ]);
    expect(cards).toEqual([
      {
        translation: 'עכבר',
        part_of_speech: 'noun',
        gloss_id: 'g1',
        variant_id: 'v1',
        examples: [
          { source: 'The mouse ran.', target: 'העכבר רץ.' },
          { source: 'Click the mouse.', target: 'לחץ על העכבר.' },
        ],
      },
    ]);
  });

  it("groups lane 0's seven `stream` rows into five cards, so no gloss hides behind a row cap", () => {
    const noun = { lexemeId: 'l_noun', entryRank: 0, partOfSpeech: 'noun' };
    const verb = { lexemeId: 'l_verb', entryRank: 1, partOfSpeech: 'verb', variantId: 'v2' };
    const cards = rowsToCards([
      row({ ...noun, senseId: 'n1', glossId: 'g_nahal', translation: 'נחל', rank: 0 }),
      row({ ...verb, senseId: 'v1', glossId: 'g_lizrom', translation: 'לזרום', rank: 0 }),
      row({ ...noun, senseId: 'n2', glossId: 'g_zerem', translation: 'זרם', rank: 1 }),
      row({ ...verb, senseId: 'v2', glossId: 'g_lizrom', translation: 'לזרום', rank: 1 }),
      row({ ...noun, senseId: 'n3', glossId: 'g_zerem', translation: 'זרם', rank: 2 }),
      row({ ...verb, senseId: 'v3', glossId: 'g_streaming', translation: 'לשדר בסטרימינג', rank: 2 }),
      row({ ...noun, senseId: 'n4', glossId: 'g_stream_n', translation: 'סטרימינג', rank: 3 }),
    ]);
    expect(cards.map((card) => card.translation)).toEqual(['נחל', 'לזרום', 'זרם', 'לשדר בסטרימינג', 'סטרימינג']);
  });

  it("sends the gloss's key only when the typed form says something else", () => {
    const [plural] = rowsToCards([row({ senseId: 's1', glossId: 'g1', translation: 'אצבעות', glossKey: 'אצבע', rank: 0 })]);
    const [vowelled] = rowsToCards([row({ senseId: 's1', glossId: 'g1', translation: 'עכבר', glossKey: 'עַכְבָּר', rank: 0 })]);
    expect(plural.key).toBe('אצבע');
    expect(vowelled.key).toBeUndefined();
  });

  it("pools the members' alternatives, never the translation, never twice", () => {
    const [card] = rowsToCards([
      row({ senseId: 's1', glossId: 'g1', translation: 'מכוניות', rank: 0, alternatives: ['רכבים'] }),
      row({ senseId: 's2', glossId: 'g1', translation: 'מכוניות', rank: 1, alternatives: ['רכבים', 'אוטואים', 'מכוניות'] }),
    ]);
    expect(card.alternatives).toEqual(['רכבים', 'אוטואים']);
  });

  it('stops at five cards', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ senseId: `s${i}`, glossId: `g${i}`, translation: `מילה${i}`, rank: i }));
    expect(rowsToCards(rows)).toHaveLength(5);
  });
});

describe('flattenEntries (phase 31)', () => {
  it("groups one entry's senses by citation form, as the written path will", () => {
    const cards = flattenEntries([
      {
        lemma: 'mouse',
        part_of_speech: 'noun',
        senses: [
          { translation: 'עכבר', sense_code: 'rodent', example: { source: 'A mouse.', target: 'עכבר.' } },
          { translation: 'עכבר', sense_code: 'device', example: { source: 'Click it.', target: 'לחץ.' } },
        ],
      },
    ]);
    expect(cards).toEqual([
      {
        translation: 'עכבר',
        part_of_speech: 'noun',
        examples: [
          { source: 'A mouse.', target: 'עכבר.' },
          { source: 'Click it.', target: 'לחץ.' },
        ],
      },
    ]);
  });
});
```

In `apps/server/src/domain/vocabulary.test.ts`, replace the `buildWordDetail` describe with one written for gloss cards (keep the file's other describes; the old per-sense assertions no longer hold):

```ts
const rendering = (over: Partial<LexemeRendering> & Pick<LexemeRendering, 'senseId' | 'glossId' | 'variantId' | 'form' | 'translation'>): LexemeRendering => ({
  lexemeId: 'l1',
  rank: 0,
  exampleSource: null,
  exampleTarget: null,
  glossKey: over.translation,
  glossAlternatives: [],
  ...over,
});
const NOUN: WordLexeme[] = [{ lexemeId: 'l1', partOfSpeech: 'noun' }];

describe('buildWordDetail by gloss (phase 31)', () => {
  it("makes one card of a gloss's senses, headlined by the key, with an example from each member", () => {
    const detail = buildWordDetail('mouse', NOUN, [
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v1', form: 'mouse', translation: 'עכבר', rank: 0, exampleSource: 'The mouse ran.', exampleTarget: 'העכבר רץ.' }),
      rendering({ senseId: 's2', glossId: 'g1', variantId: 'v1', form: 'mouse', translation: 'עכבר', rank: 1, exampleSource: 'Click the mouse.', exampleTarget: 'לחץ על העכבר.' }),
    ], [], []);
    expect(detail.senses).toHaveLength(1);
    expect(detail.senses[0]).toMatchObject({
      gloss_id: 'g1',
      translation: 'עכבר',
      examples: [
        { source: 'The mouse ran.', target: 'העכבר רץ.' },
        { source: 'Click the mouse.', target: 'לחץ על העכבר.' },
      ],
      saved: false,
    });
  });

  it("headlines the key, not the saved form's rendering, and says which form it was saved from", () => {
    const detail = buildWordDetail('finger', NOUN, [
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_fingers', form: 'fingers', translation: 'אצבעות', glossKey: 'אצבע', glossAlternatives: ['אצבע יד'] }),
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_finger', form: 'finger', translation: 'אצבע', glossKey: 'אצבע', glossAlternatives: ['אצבע יד'] }),
    ], [{ glossId: 'g1', variantId: 'v_fingers', addedBy: null }], []);
    expect(detail.senses[0]).toMatchObject({
      translation: 'אצבע',
      alternatives: ['אצבע יד'],
      variant_id: 'v_fingers',
      form: 'fingers',
      saved: true,
      saved_from: { form: 'fingers', translation: 'אצבעות' },
    });
  });

  it('takes a member’s example from the lemma form where it has one', () => {
    const detail = buildWordDetail('car', NOUN, [
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_cars', form: 'cars', translation: 'מכוניות', glossKey: 'מכונית', exampleSource: 'Cars pass.', exampleTarget: 'מכוניות עוברות.' }),
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_car', form: 'car', translation: 'מכונית', exampleSource: 'A car.', exampleTarget: 'מכונית.' }),
    ], [], []);
    expect(detail.senses[0].examples).toEqual([{ source: 'A car.', target: 'מכונית.' }]);
    expect(detail.senses[0]).not.toHaveProperty('saved_from');
  });

  it('lists saved glosses first, then by part of speech, then by rank', () => {
    const detail = buildWordDetail('stream', [{ lexemeId: 'ln', partOfSpeech: 'noun' }, { lexemeId: 'lv', partOfSpeech: 'verb' }], [
      rendering({ lexemeId: 'ln', senseId: 'n1', glossId: 'g_nahal', variantId: 'vn', form: 'stream', translation: 'נחל', rank: 0 }),
      rendering({ lexemeId: 'ln', senseId: 'n2', glossId: 'g_zerem', variantId: 'vn', form: 'stream', translation: 'זרם', rank: 1 }),
      rendering({ lexemeId: 'lv', senseId: 'v1', glossId: 'g_lizrom', variantId: 'vv', form: 'stream', translation: 'לזרום', rank: 0 }),
    ], [{ glossId: 'g_lizrom', variantId: 'vv', addedBy: null }], []);
    expect(detail.senses.map((card) => card.translation)).toEqual(['לזרום', 'נחל', 'זרם']);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/dictionary.test.ts src/domain/vocabulary.test.ts`. Expected: FAIL, `rowsToCards is not a function`, and the detail still has one card per sense.

- [ ] **Step 3: The cards on the wire.** In `packages/core/src/api/schemas.ts`:

```ts
// Phase 31 (spec D10, D15). A lookup card is one gloss: the senses of one
// headword this language says with one target word. `translation` is the typed
// form's rendering; `key` the gloss's citation form, present only when it
// differs; `examples` one per member sense, in the typed form; `alternatives` the
// typed form's other words for it (D5). Optional fields keep phase 18's
// meaning: a sentence has no part of speech and no examples, and an answer whose
// write failed has no ids.
export const TranslationSenseSchema = z.object({
  translation: z.string().min(1),
  part_of_speech: z.string().optional(),
  examples: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) })).optional(),
  alternatives: z.array(z.string().min(1)).optional(),
  key: z.string().min(1).optional(),
  gloss_id: z.string().optional(),
  variant_id: z.string().optional(),
  // Present only when the request named an enrollment AND `from` is that
  // enrollment's target language AND the card has ids. Absent means "cannot be
  // saved here", never "not saved".
  saved: z.boolean().optional(),
});
```

```ts
// Phase 31 (spec D10, D11). One gloss on the word's page. `translation` is the
// gloss's key, `alternatives` its other words ("also …"). `variant_id` and
// `form` name the rendering a save from here records: the saved form for a saved
// gloss, a representative one otherwise. `examples` holds one per member sense.
// `saved_from` is there when the saved form is not the lemma: that form and its
// rendering, "saved from fingers: אצבעות".
export const VocabularySenseSchema = z.object({
  gloss_id: z.string(),
  variant_id: z.string(),
  form: z.string(),
  translation: z.string(),
  alternatives: z.array(z.string()),
  part_of_speech: z.string(),
  examples: z.array(z.object({ source: z.string(), target: z.string() })),
  saved: z.boolean(),
  progress: GlossProgressSchema.optional(),
  added_by: z.string().optional(),
  saved_from: z.object({ form: z.string(), translation: z.string() }).optional(),
});
```

`VocabularyWordSchema`: `sense_count` becomes `gloss_count: z.number().int()`, and its comment says: "Phase 31: `headline` is the earliest saved gloss, in its key and the form it was saved from; `gloss_count` counts the live glosses of every lexeme with the lemma in the enrollment's language, what the drill-down shows (spec D11)."

Update `schemas.test.ts`'s fixtures to the new shapes (an `example` becomes `examples: [ … ]`, `sense_count` becomes `gloss_count`).

- [ ] **Step 4: The lookup reads every rendering and groups it.** In `apps/server/src/domain/dictionary.ts`, import `normaliseGloss` from `@lang-tutor/core/domain` and `tidyGlossList` from `./glosses`. `SenseRow` gains:

```ts
  /** Phase 31. The gloss's key, for the card's `key` (spec D11). */
  glossKey: string;
  /** Phase 31 (spec D5). This rendering's alternatives. */
  alternatives: string[];
```

Rename `RESPONSE_SENSE_CAP` to `RESPONSE_CARD_CAP` (still 5), delete `toResponseSense` and `rowsToSenses`, and add:

```ts
type Example = { source: string; target: string };
type PendingCard = { card: TranslationSense; alternatives: string[] };

const exampleOf = (source: string | null, target: string | null): Example | null =>
  source && target ? { source, target } : null;

/** A pending card's alternatives tidied, and the card returned. */
function finish({ card, alternatives }: PendingCard): TranslationSense {
  const tidy = tidyGlossList(alternatives, card.translation);
  return tidy.length > 0 ? { ...card, alternatives: tidy } : card;
}

/**
 * Phase 31 (spec D10, D15). Rows to the wire: one card per gloss, in the order of
 * each gloss's first row, which is the read's (rank first, then entry rank, so
 * still round-robin across lexemes), at most five cards. The cap counts cards,
 * not rows: `stream`'s seven rows are five glosses and show five cards. A card
 * reads the typed form: its lowest-ranked member's rendering is the translation,
 * every member adds its example, and the renderings' alternatives are pooled.
 * `key` is the gloss's, sent only when it differs from the translation.
 */
export function rowsToCards(rows: SenseRow[]): TranslationSense[] {
  return groupCards(
    rows.map((row) => ({
      id: row.glossId,
      card: {
        translation: row.translation,
        gloss_id: row.glossId,
        variant_id: row.variantId,
        ...(row.partOfSpeech ? { part_of_speech: row.partOfSpeech } : {}),
      },
      key: row.glossKey,
      example: exampleOf(row.exampleSource, row.exampleTarget),
      alternatives: row.alternatives,
    })),
  );
}

/** One rendering as card grouping reads it: the group it joins, the card it
 *  starts when it is the group's first, and what every member adds. */
type CardRow = { id: string; card: TranslationSense; key: string; example: Example | null; alternatives: readonly string[] };

/** Renderings to cards by group id, in first-seen order, at most
 *  RESPONSE_CARD_CAP cards. A group's first row names its card; every row adds
 *  its example and its alternatives, so a capped card still gathers them. */
function groupCards(rows: readonly CardRow[]): TranslationSense[] {
  const cards = new Map<string, PendingCard>();
  for (const row of rows) {
    const seen = cards.get(row.id);
    if (seen) {
      if (row.example) seen.card.examples = [...(seen.card.examples ?? []), row.example];
      seen.alternatives.push(...row.alternatives);
      continue;
    }
    if (cards.size === RESPONSE_CARD_CAP) continue;
    const card: TranslationSense = { ...row.card };
    if (row.example) card.examples = [row.example];
    if (normaliseGloss(row.key) !== normaliseGloss(card.translation)) card.key = row.key;
    cards.set(row.id, { card, alternatives: [...row.alternatives] });
  }
  return [...cards.values()].map(finish);
}
```

`flattenEntries` groups the same way, by entry and citation form, since the paths that do not write have no gloss ids:

```ts
export function flattenEntries(entries: LlmEntry[]): TranslationSense[] {
  const rows: CardRow[] = [];
  const deepest = Math.max(0, ...entries.map((entry) => entry.senses.length));
  for (let rank = 0; rank < deepest; rank++) {
    entries.forEach((entry, index) => {
      const sense = entry.senses[rank];
      if (!sense) return;
      const written = renderingOf(sense, rank);
      rows.push({
        id: `${index} ${normaliseGloss(written.gloss)}`,
        card: { translation: written.translation, part_of_speech: entry.part_of_speech },
        key: written.gloss,
        example: exampleOf(written.exampleSource, written.exampleTarget),
        alternatives: written.alternatives,
      });
    });
  }
  return groupCards(rows);
}
```

Keep `flattenEntries`' comment about round-robin, and add: "Phase 31: grouped into cards like rowsToCards, by entry and citation form."

In `apps/server/src/repo/dictionary.ts`: delete `READ_LIMIT` and `findSensesByForm`'s `.limit(READ_LIMIT)`, rewrite the comment above it to say the read returns every rendering of the form and the five-card cap is `rowsToCards`', and select two more columns with one more join:

```ts
        glossKey: dictGlosses.key,
        alternatives: dictVarTranslations.alternatives,
```

```ts
      .innerJoin(dictGlosses, eq(dictGlosses.id, dictSenseGlosses.glossId))
```

`persistEntries`' re-read and every `rowsToSenses` in `services/translations.ts` and `tests/support/fakes.ts` become `rowsToCards`.

- [ ] **Step 5: The word's page by gloss.** In `apps/server/src/repo/vocabulary.ts`, `lemmaRenderings` joins the gloss and selects its key and alternatives:

```ts
    JOIN dict_glosses g           ON g.id = m.gloss_id
```

```ts
    SELECT s.lexeme_id, tr.sense_id, m.gloss_id, g.key AS gloss_key, g.alternatives AS gloss_alternatives,
           tr.variant_id, v.form, tr.rank, tr.translation, tr.example_source, tr.example_target
```

and `findLemmaRenderings` maps them to `glossKey` and `glossAlternatives`. In `apps/server/src/domain/vocabulary.ts`, `LexemeRendering` gains:

```ts
  /** Phase 31. The gloss's key and alternatives (spec D5, D11). */
  glossKey: string;
  glossAlternatives: string[];
```

and `buildWordDetail` becomes (keep the file's `glossProgressOf`):

```ts
/**
 * The drill-down (phase 31, spec D10, D11): one card per gloss of every lexeme
 * with this lemma that the enrollment's learner language can show, labelled with
 * its part of speech. Saved glosses first, then by part of speech, then by the
 * gloss's best rank, then by gloss id.
 *
 * A card's headline is the gloss's key. The rendering it names, the one a save
 * from here records, is the saved form's while that form still renders a member,
 * otherwise a representative: the lemma's own spelling if anyone looked it up,
 * else the form that renders the most senses, ties broken by variant id.
 * `saved_from` names the saved form when it is not the lemma.
 *
 * Each member sense gives one example, from the same choice of form: the lemma's
 * where it renders that sense, otherwise the representative. All are shown;
 * capping them would hide exactly the meaning the learner has not met.
 */
export function buildWordDetail(
  lemma: string,
  lexemes: WordLexeme[],
  renderings: LexemeRendering[],
  saved: SavedEntry[],
  progress: ProgressRow[],
): VocabularyWordDetail {
  const partOfSpeech = new Map(lexemes.map((lexeme) => [lexeme.lexemeId, lexeme.partOfSpeech]));
  const entries = new Map(saved.map((entry) => [entry.glossId, entry]));
  const perVariant = new Map<string, number>();
  for (const r of renderings) perVariant.set(r.variantId, (perVariant.get(r.variantId) ?? 0) + 1);

  const lowered = lemma.toLowerCase();
  const isLemma = (r: LexemeRendering) => Number(r.form.toLowerCase() === lowered);
  const better = (a: LexemeRendering, b: LexemeRendering) =>
    isLemma(b) - isLemma(a) ||
    perVariant.get(b.variantId)! - perVariant.get(a.variantId)! ||
    a.variantId.localeCompare(b.variantId);
  const byRank = (a: LexemeRendering, b: LexemeRendering) => a.rank - b.rank || a.senseId.localeCompare(b.senseId);

  const byGloss = new Map<string, LexemeRendering[]>();
  for (const r of renderings) byGloss.set(r.glossId, [...(byGloss.get(r.glossId) ?? []), r]);

  const progressByGloss = new Map<string, ProgressRow[]>();
  for (const row of progress) progressByGloss.set(row.glossId, [...(progressByGloss.get(row.glossId) ?? []), row]);
  const live = progress.filter((row) => LIVE_DIMENSIONS.includes(row.dimension));

  const cards = [...byGloss.entries()].map(([glossId, options]) => {
    const entry = entries.get(glossId);
    const savedRendering = entry ? options.filter((o) => o.variantId === entry.variantId).sort(byRank)[0] : undefined;
    const shown = savedRendering ?? [...options].sort(better)[0];

    const bySense = new Map<string, LexemeRendering[]>();
    for (const o of options) bySense.set(o.senseId, [...(bySense.get(o.senseId) ?? []), o]);
    const examples = [...bySense.values()]
      .map((own) => [...own].sort(better)[0])
      .sort(byRank)
      .flatMap((pick) =>
        pick.exampleSource && pick.exampleTarget ? [{ source: pick.exampleSource, target: pick.exampleTarget }] : [],
      );

    const savedFrom =
      savedRendering && savedRendering.form.toLowerCase() !== lowered
        ? { form: savedRendering.form, translation: savedRendering.translation }
        : undefined;
    const glossProgress = progressByGloss.get(glossId);

    return {
      rank: [...options].sort(byRank)[0].rank,
      partOfSpeech: partOfSpeech.get(shown.lexemeId) ?? '',
      card: {
        gloss_id: glossId,
        variant_id: shown.variantId,
        form: shown.form,
        translation: shown.glossKey,
        alternatives: [...shown.glossAlternatives],
        part_of_speech: partOfSpeech.get(shown.lexemeId) ?? '',
        examples,
        saved: entry !== undefined,
        ...(entry?.addedBy ? { added_by: entry.addedBy } : {}),
        ...(entry && glossProgress ? { progress: glossProgressOf(glossProgress) } : {}),
        ...(savedFrom ? { saved_from: savedFrom } : {}),
      },
    };
  });

  cards.sort(
    (a, b) =>
      Number(b.card.saved) - Number(a.card.saved) ||
      (a.partOfSpeech < b.partOfSpeech ? -1 : a.partOfSpeech > b.partOfSpeech ? 1 : 0) ||
      a.rank - b.rank ||
      a.card.gloss_id.localeCompare(b.card.gloss_id),
  );

  return {
    lemma,
    level: live.length === 0 ? null : badge(live.map((row) => row.level)),
    senses: cards.map(({ card }) => card),
  };
}
```

- [ ] **Step 6: The list's headline is the key; its mark counts glosses.** In `apps/server/src/repo/vocabulary.ts`, `wordSummaries` reads the headline from the gloss, drops the join on the saved variant's translation, and counts glosses:

```ts
           (SELECT count(*) FROM dict_lexemes l
              JOIN dict_glosses g ON g.lexeme_id = l.id
             WHERE l.language_code = ${input.targetLanguage}
               AND l.lemma = w.lemma
               AND g.user_language_code = ${input.sourceLanguage}
               AND g.merged_into IS NULL)::int AS gloss_count
```

```ts
    -- Phase 31 (spec D11). The headline is the earliest saved gloss, in its key;
    -- no rendering is read, so a form saved inflected still headlines its
    -- citation form.
    JOIN LATERAL (
      SELECT ve.gloss_id, g.key, v.form
      FROM vocabulary_entries ve
      JOIN dict_glosses g  ON g.id = ve.gloss_id
      JOIN dict_variants v ON v.id = ve.variant_id
      WHERE ve.enrollment_id = ${input.enrollmentId}
        AND ve.lemma = w.lemma
      ORDER BY ve.created_at, ve.gloss_id
      LIMIT 1
    ) h ON true
```

with `h.key AS headline_translation` in the select list. Update the query's doc comment and the `sense_count` comment to say glosses. `WordSummary.senseCount` → `glossCount`, mapped from `gloss_count`, and `assemblePage` writes `gloss_count: s.glossCount`.

- [ ] **Step 7: The other readers of cards.** `apps/server/src/domain/photoImports.ts`, `optionsFrom` is a plain map now:

```ts
/** A lookup's saveable cards, in its order: one option per gloss (spec D15). */
export function optionsFrom(cards: readonly TranslationSense[]): PhotoImportOption[] {
  return cards.flatMap((card) =>
    card.gloss_id && card.variant_id
      ? [
          {
            gloss_id: card.gloss_id,
            variant_id: card.variant_id,
            translation: card.translation,
            ...(card.part_of_speech ? { part_of_speech: card.part_of_speech } : {}),
            ...(card.examples ? { examples: card.examples } : {}),
            ...(card.alternatives ? { alternatives: card.alternatives } : {}),
          },
        ]
      : [],
  );
}
```

The results name a practised gloss the way the list does (decided while planning, item 8). In `apps/server/src/repo/progress.ts`, `findSnapshot` reads the key from the gloss and the form from the first question that asked it:

```ts
    /** The snapshot with, for each practised gloss, the form of the first
     *  question in the session that asked it and the gloss's key: the results
     *  name a saved word as the list does (phase 31, spec D11). */
    findSnapshot: async (sessionId: string): Promise<SnapshotRead[]> => {
      const rows = await tx.execute<{
        gloss_id: string;
        dimension: string;
        level_before: number;
        level_after: number;
        form: string;
        key: string;
        position: number;
      }>(sql`
        SELECT sp.gloss_id, sp.dimension, sp.level_before, sp.level_after, f.form, g.key, f.position
        FROM session_progress sp
        JOIN dict_glosses g ON g.id = sp.gloss_id
        JOIN LATERAL (
          SELECT v.form, sq.position
          FROM session_questions sq
          JOIN questions q     ON q.id = sq.question_id
          JOIN dict_variants v ON v.id = q.prompt_variant_id
          WHERE sq.session_id = sp.session_id
            AND q.gloss_id = sp.gloss_id
          ORDER BY sq.position
          LIMIT 1
        ) f ON true
        WHERE sp.session_id = ${sessionId}`);
      return rows.rows.map((row) => ({
        glossId: row.gloss_id,
        dimension: row.dimension as Dimension,
        levelBefore: row.level_before,
        levelAfter: row.level_after,
        form: row.form,
        translation: row.key,
        position: row.position,
      }));
    },
```

Remove the `canonicalOptions` import if nothing else in the file reads it. The missed list is unchanged: it still shows each card as it was asked.

`apps/server/tests/eval/run.ts`, tier 1: the two example checks read every card's `examples` (`senses.every((sense) => (sense.examples ?? []).length > 0 && sense.examples!.every((example) => example.source.trim()))`, and the same for `target`), and the sentence check is `senses.every((sense) => !sense.part_of_speech && !sense.examples)`.

The app compiles against the new cards, with Task 8 finishing the design:
- `apps/mobile/src/components/LookupPanel.tsx` and `app/vocabulary/word.tsx`: where a card rendered `sense.example`, render each of `sense.examples ?? []` / `sense.examples` with the same markup, keyed by `example.source`.
- `apps/mobile/src/app/vocabulary/index.tsx`: `item.sense_count` → `item.gloss_count`; `apps/mobile/src/vocabulary.ts`: `showsMark` reads `word.gloss_count`; `apps/mobile/src/vocabulary.test.ts`: its `VocabularyWord` fixtures say `gloss_count` for `sense_count`.

- [ ] **Step 8: Integration tests.** Update the tests the new behaviour changes: `sense_count` becomes `gloss_count` in `tests/integration/routes/vocabulary.test.ts`'s `Page` type and expectations, and every fixture there renders its senses with distinct words, so its counts keep their values. Then:

In `tests/integration/repo/dictionary.test.ts`, replace the case "caps the read at five even though the database stores every sense" with:

```ts
  it("reads every rendering of the form: the card cap is the service's, after grouping (phase 31)", async () => {
    await insertLexeme(t.db, {
      lemma: 'light',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(7),
      variants: [variant('light', [0, 1, 2, 3, 4, 5, 6].map((n) => `t${n}`))],
    });

    expect(await find('light')).toHaveLength(7);
  });
```

In `tests/integration/services/translations.test.ts`, inside `describe('translate, against a real database', …)`:

```ts
  it('answers at most five cards for a form with seven glosses, from the model and from the dictionary alike (phase 31)', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        entry('trellis', ['סבכה', 'סורג', 'רשת', 'מסגרת'], 'noun'),
        entry('trellis', ['להדלות', 'לתמוך', 'לשתול'], 'verb'),
      ],
    });
    const service = translations();
    const first = await service.translate({ text: 'trellis', from: 'en', to: 'he' });
    const again = await service.translate({ text: 'trellis', from: 'en', to: 'he' });

    expect(first.senses).toHaveLength(5);
    expect(again.senses.map((card) => card.translation)).toEqual(first.senses.map((card) => card.translation));
    expect(await countGeminiRequests(ns)).toBe(1);
  });
```

In `tests/integration/routes/vocabulary.test.ts`, a new describe at the end:

```ts
type Detail = {
  senses: { gloss_id: string; translation: string; saved: boolean; examples: unknown[]; saved_from?: { form: string; translation: string } }[];
};

describe('glosses on the list and the word page (phase 31)', () => {
  it('shows two senses with one target word as one card, saved once and counted once', async () => {
    const mouse = await insertLexeme(t.db, {
      lemma: 'мышь',
      languageCode: 'ru',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'rodent' }, { senseCode: 'device' }],
      variants: [
        {
          form: 'мышь',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'rodent', rank: 0, translation: 'עכבר', exampleSource: 'Мышь бежит.', exampleTarget: 'עכבר רץ.' },
            { senseCode: 'device', rank: 1, translation: 'עכבר', exampleSource: 'Кликни мышью.', exampleTarget: 'לחץ בעכבר.' },
          ],
        },
      ],
    });
    expect(mouse.glossIds[0]).toBe(mouse.glossIds[1]);
    expect((await save(RU, [{ gloss_id: mouse.glossIds[0], variant_id: mouse.variantIds[0] }])).status).toBe(200);

    const page = (await (await list(RU)).json()) as Page;
    expect(page.items[0]).toMatchObject({ lemma: 'мышь', saved_count: 1, gloss_count: 1, headline: { translation: 'עכבר', form: 'мышь' } });
    const word = (await (await detail(RU, 'мышь')).json()) as Detail;
    expect(word.senses).toHaveLength(1);
    expect(word.senses[0]).toMatchObject({ gloss_id: mouse.glossIds[0], translation: 'עכבר', saved: true });
    expect(word.senses[0].examples).toHaveLength(2);
  });

  it('headlines the key of a word saved from an inflected form, and says where it was saved from', async () => {
    const palets = await insertLexeme(t.db, {
      lemma: 'палец',
      languageCode: 'ru',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'digit' }],
      variants: [
        {
          form: 'палец',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null }],
        },
        {
          form: 'пальцы',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבעות', gloss: 'אצבע', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    // The lemma form is rendered, so from Task 10 on this save asks for no job.
    expect((await save(RU, [{ gloss_id: palets.glossIds[0], variant_id: palets.variantIds[1] }])).status).toBe(200);

    const page = (await (await list(RU)).json()) as Page;
    expect(page.items[0]).toMatchObject({ lemma: 'палец', headline: { translation: 'אצבע', form: 'пальцы' } });
    const word = (await (await detail(RU, 'палец')).json()) as Detail;
    expect(word.senses[0]).toMatchObject({ translation: 'אצבע', saved_from: { form: 'пальцы', translation: 'אצבעות' } });
  });
});
```

`Page`'s items gain `headline: { gloss_id: string; translation: string; form: string }` if the type lacks it.

In `tests/integration/repo/progress.test.ts`, after the `findSnapshot` describes:

```ts
describe('findSnapshot names a gloss by its key (phase 31, spec D11)', () => {
  it("reads the form the session asked beside the gloss's key, not that form's rendering", async () => {
    const finger = await insertLexeme(t.db, {
      lemma: 'finger',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'digit' }],
      variants: [
        {
          form: 'finger',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null }],
        },
        {
          form: 'fingers',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבעות', gloss: 'אצבע', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [{ glossId: finger.glossIds[0], variantId: finger.variantIds[1], translation: 'אצבעות' }],
      answers: [],
    });
    await repo((r) =>
      r.insertSnapshot({
        sessionId,
        rows: [{ glossId: finger.glossIds[0], dimension: 'written_receptive', levelBefore: 1, levelAfter: 2 }],
      }),
    );

    expect(await repo((r) => r.findSnapshot(sessionId))).toEqual([
      expect.objectContaining({ glossId: finger.glossIds[0], form: 'fingers', translation: 'אצבע' }),
    ]);
  });
});
```

`tests/integration/repo/vocabulary.plan.test.ts`: still within `BUDGET_MS`. If it is not, report the measured time and stop; do not raise the budget.

- [ ] **Step 9: Run every gate and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch && npm run e2e`. Expected: PASS. In e2e, `vocabulary.spec.ts`'s marks (`1/2`, `2/2`) still hold: `прочитать` and `лук` each have two glosses.

```bash
git add -A apps packages
git commit -m "feat: one card per gloss — the lookup groups by gloss and caps cards, and the list headlines the key"
```

---

### Task 8: The app's gloss cards — "also …", the key beneath, "saved from …", every example

**Files:**
- Modify: `apps/mobile/src/strings.ts`
- Modify: `apps/mobile/src/vocabulary.ts`, `apps/mobile/src/vocabulary.test.ts`
- Modify: `apps/mobile/src/components/LookupPanel.tsx`, `apps/mobile/src/app/vocabulary/word.tsx`, `apps/mobile/src/app/photo-imports/[id].tsx`

**Interfaces:**
- Consumes: the cards of Task 7.
- Produces: `strings.also(words: readonly string[]): string`, `strings.savedFrom(form: string, translation: string): string`; `alsoLine(alternatives?: readonly string[]): string | null` and `savedFromLine(card: VocabularySense): string | null` in `src/vocabulary.ts`.

- [ ] **Step 1: Write the failing tests.** Append to `apps/mobile/src/vocabulary.test.ts` (import `alsoLine`, `savedFromLine`):

```ts
describe('gloss card lines (phase 31)', () => {
  it('says "also …" only when there are alternatives', () => {
    expect(alsoLine(['רכב', 'אוטו'])).toBe('גם: רכב, אוטו');
    expect(alsoLine([])).toBeNull();
    expect(alsoLine(undefined)).toBeNull();
  });

  it('names the form a gloss was saved from, with its rendering', () => {
    const card = {
      gloss_id: 'g1', variant_id: 'v1', form: 'fingers', translation: 'אצבע', alternatives: [], part_of_speech: 'noun',
      examples: [], saved: true, saved_from: { form: 'fingers', translation: 'אצבעות' },
    };
    expect(savedFromLine(card)).toBe('נשמר מתוך ⁨fingers⁩: אצבעות');
    expect(savedFromLine({ ...card, saved_from: undefined })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail.** `npm exec -w apps/mobile -- jest --runTestsByPath src/vocabulary.test.ts`. Expected: FAIL, `alsoLine is not a function`.

- [ ] **Step 3: Strings and helpers.** In `apps/mobile/src/strings.ts`, beside `vocabularyFromForm`:

```ts
  // Phase 31 (spec D5). The gloss's other target words, under its headline.
  also: (words: readonly string[]) => `גם: ${words.join(', ')}`,
  // Phase 31 (spec D11). The form a word was saved from, when it is not the lemma.
  savedFrom: (form: string, translation: string) => `נשמר מתוך ⁨${form}⁩: ${translation}`,
```

In `apps/mobile/src/vocabulary.ts`:

```ts
/** Phase 31 (spec D5). The line under a gloss card's headline, or nothing. */
export function alsoLine(alternatives: readonly string[] | undefined): string | null {
  return alternatives && alternatives.length > 0 ? strings.also(alternatives) : null;
}

/** Phase 31 (spec D11). "Saved from fingers: אצבעות", for a word saved inflected. */
export function savedFromLine(card: VocabularySense): string | null {
  return card.saved_from ? strings.savedFrom(card.saved_from.form, card.saved_from.translation) : null;
}
```

(import `type VocabularySense` from `@lang-tutor/core/api`). Run Step 2's command. Expected: PASS.

- [ ] **Step 4: The lookup card.** In `apps/mobile/src/components/LookupPanel.tsx`, `SenseCard` shows, in this order: the headline translation with its speak button (as today); the key beneath it when the card has one, in the muted part-of-speech style with `writingDirection: strings.textDirection(to)` and `testID="translate-key"`; `alsoLine(sense.alternatives)` when not null, same style, `testID="translate-also"`; the part of speech; then each of `sense.examples ?? []` with the existing example markup and speak buttons, keyed by `example.source`, its container carrying `testID="translate-example"`; then the save button. Nothing else on the card changes. The tutor's screen, `app/students/words.tsx`, renders `LookupPanel`, so it gets the same card with no change of its own (spec, "Mobile").

- [ ] **Step 5: The word page's card.** In `apps/mobile/src/app/vocabulary/word.tsx`, each card shows: part of speech; the translation (now the key); `alsoLine(sense.alternatives)` (`testID="vocabulary-sense-also"`); added by; `savedFromLine(sense)` (`testID="vocabulary-sense-saved-from"`) in place of the old `sense.form !== word.lemma` line and its `vocabularyFromForm` string; each of `sense.examples` with the existing example markup, its container carrying `testID="vocabulary-sense-example"`; progress; the toggle. Delete `vocabularyFromForm` from `strings.ts` if nothing else reads it (`grep -rn vocabularyFromForm apps/mobile/src`).

- [ ] **Step 6: The photo import's option.** In `apps/mobile/src/app/photo-imports/[id].tsx`, an option shows `alsoLine(option.alternatives)` under its meaning, in the `styles.meta` style.

- [ ] **Step 7: Look at it.** Start the lane's server and web app in the background (`npm run server`, `npm run mobile`; `bash scripts/lane-env.sh env | grep -E 'PORT|METRO'` for the URLs) and use the `run` skill or a short Playwright script: look up a word saved before this phase whose two senses share a target word (on a fresh lane, look up `mouse` through MockServer as Task 15's stub does), and check the card shows one headline, both examples and the save button; open the word's page and check the same. Stop both processes afterwards.

- [ ] **Step 8: Check and commit.** `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.

```bash
git add apps/mobile/src
git commit -m "feat(mobile): gloss cards — also, the key beneath, saved from, and every member's example"
```

---

## Part C — Merges and lemma renders

### Task 9: Merges — the merge job, forwarding, and every learner write resolving under a share lock (D7, D14)

**Files:**
- Modify: `apps/server/src/domain/glosses.ts` (`mergeLevels`, `mergeSnapshots`, `keptEntry`; `assignGlosses` takes aliases), `glosses.test.ts`
- Create: `apps/server/src/repo/glosses.ts` (`resolveGlosses`, `findMergeCandidates`, `mergeGlosses`)
- Modify: `apps/server/src/repo/dictionary.ts` (`writeGlosses` reads forwarded keys; `persistEntries` reports gloss counts), `apps/server/src/repo/progress.ts` (`lockSessionGlosses`)
- Create: `apps/server/src/services/glosses.ts` (`createGlossService`, `mergeLexeme`)
- Modify: `apps/server/src/services/transaction.ts`, `composition.ts`, `worker.ts`, `domain/jobs.ts`, `db/jobs.ts`, `errors.ts`
- Modify: `apps/server/src/services/translations.ts` (enqueue the merge; log `dict_glosses_assigned`), `services/vocabulary.ts`, `services/photoImports.ts`, `services/sessions.ts` (resolve, D14)
- Modify: `apps/server/tests/support/fakes.ts`; Create: `apps/server/tests/support/locks.ts`
- Modify: `apps/server/tests/support/dictRows.ts` (`insertDriftedFinger`, `insertRendering`, shared by Tasks 9 and 14)
- Create: `apps/server/tests/integration/repo/glosses.merge.test.ts`, `tests/integration/services/glosses.race.test.ts`, `tests/integration/jobs/mergeGlosses.test.ts`

**Interfaces:**
- Produces, in `domain/glosses.ts`:
  - `type LevelState = { level: number; lastStepOn: string | null; lastWrongOn: string | null }`; `mergeLevels(a: LevelState, b: LevelState): LevelState`.
  - `type SnapshotLevels = { levelBefore: number; levelAfter: number }`; `mergeSnapshots(a: SnapshotLevels, b: SnapshotLevels): SnapshotLevels`.
  - `type SavedState = { variantId: string; addedByUserId: string; savedAt: string }`; `keptEntry(a: SavedState, b: SavedState): SavedState`.
  - `assignGlosses`' input gains `aliases?: ReadonlyMap<string, string>` (a forwarded gloss's normalised key → its survivor's id).
- Produces, in `repo/glosses.ts` (`Repos.gloss`):
  - `resolveGlosses(ids: string[]): Promise<Map<string, ResolvedGloss>>`, `ResolvedGloss = { id: string; lexemeId: string; userLanguageCode: string }`.
  - `findMergeCandidates(input: { lexemeId: string; userLanguageCode: string }): Promise<{ otherId: string; survivorId: string }[]>`.
  - `mergeGlosses(input: { survivorId: string; otherId: string }): Promise<MergeCounts | null>`, `MergeCounts = { entriesMoved: number; entriesFolded: number; snapshots: number; questions: number; memberships: number }`.
- Produces: `ProgressRepo.lockSessionGlosses(sessionId: string): Promise<void>`.
- Produces: `MERGE_GLOSSES = 'merge-glosses'`, `MergeGlossesPayloadSchema = z.object({ lexeme_id: z.string().min(1), user_language_code: z.string().min(1) })`.
- Produces: `GlossService.mergeLexeme(data: unknown): Promise<void>`; `AppDeps.glosses`.
- Produces: `class GlossLanguageMismatch extends InvalidVocabularyEntry`.
- Produces: `persistEntries` also returns `glosses: { created: number; joined: number; members: number }`.

- [ ] **Step 1: Write the failing unit tests.** Append to `apps/server/src/domain/glosses.test.ts` (import the three functions):

```ts
describe('folding two glosses (spec D3, D7)', () => {
  it('keeps the higher level and the later of each date', () => {
    expect(
      mergeLevels(
        { level: 3, lastStepOn: '2026-03-01', lastWrongOn: null },
        { level: 2, lastStepOn: '2026-03-05', lastWrongOn: '2026-03-04' },
      ),
    ).toEqual({ level: 3, lastStepOn: '2026-03-05', lastWrongOn: '2026-03-04' });
  });

  it('keeps the lowest level before and the highest after, so the snapshot check still holds', () => {
    expect(mergeSnapshots({ levelBefore: 2, levelAfter: 3 }, { levelBefore: 1, levelAfter: 2 })).toEqual({ levelBefore: 1, levelAfter: 3 });
  });

  it('keeps the earlier save, with its form and its adder', () => {
    const early = { variantId: 'v_fingers', addedByUserId: 'u_tutor', savedAt: '2026-01-01T00:00:00.000000' };
    const late = { variantId: 'v_finger', addedByUserId: 'u_1', savedAt: '2026-02-01T00:00:00.000000' };
    expect(keptEntry(late, early)).toBe(early);
    expect(keptEntry(early, late)).toBe(early);
  });
});

describe('assignGlosses after a merge (spec D7)', () => {
  it("joins a new sense whose key a merged gloss had to that gloss's survivor", () => {
    const plan = assignGlosses({
      senses: [sense('s9', 'אצבעות')],
      lemmaForm: false,
      glosses: [{ id: 'g_survivor', key: 'אצבע', alternatives: ['אצבעות'] }],
      memberships: new Map(),
      aliases: new Map([['אצבעות', 'g_survivor']]),
    });
    expect(plan.join).toEqual([{ senseId: 's9', glossId: 'g_survivor' }]);
    expect(plan.create).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/glosses.test.ts`. Expected: FAIL, `mergeLevels is not a function`.

- [ ] **Step 3: The fold rules.** Append to `apps/server/src/domain/glosses.ts`:

```ts
/** One progress row's state, as a merge folds it. Dates are `YYYY-MM-DD`. */
export type LevelState = { level: number; lastStepOn: string | null; lastWrongOn: string | null };

const later = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** Spec D3, done-means 4: two rows of one dimension folded into one, the higher
 *  level with the later of each date. 0023_glosses_rekey.sql holds the same rule. */
export function mergeLevels(a: LevelState, b: LevelState): LevelState {
  return {
    level: Math.max(a.level, b.level),
    lastStepOn: later(a.lastStepOn, b.lastStepOn),
    lastWrongOn: later(a.lastWrongOn, b.lastWrongOn),
  };
}

/** One session's snapshot of one dimension. */
export type SnapshotLevels = { levelBefore: number; levelAfter: number };

/** Two snapshot rows of one session and dimension folded: the lowest level before
 *  and the highest after, which keeps session_progress_levels_valid true. */
export function mergeSnapshots(a: SnapshotLevels, b: SnapshotLevels): SnapshotLevels {
  return { levelBefore: Math.min(a.levelBefore, b.levelBefore), levelAfter: Math.max(a.levelAfter, b.levelAfter) };
}

/** One saved entry, as a merge compares it. `savedAt` is a fixed-width UTC
 *  timestamp, `YYYY-MM-DDTHH:MI:SS.US`, so text order is time order. */
export type SavedState = { variantId: string; addedByUserId: string; savedAt: string };

/** Spec §3, the merge's entry rule: of two saves of one gloss, the earlier stays,
 *  with its form and its adder. */
export function keptEntry(a: SavedState, b: SavedState): SavedState {
  return b.savedAt < a.savedAt ? b : a;
}
```

`assignGlosses`' input gains `aliases?: ReadonlyMap<string, string>` with the doc line "A merged gloss's normalised key → its survivor's id: a sense that names a merged key joins the survivor (spec D7)." In its join step, `const existing = byKey.get(key) ?? input.aliases?.get(key);`. Run Step 2's command. Expected: PASS.

- [ ] **Step 4: The merge job's queue and the error.** In `apps/server/src/domain/jobs.ts`:

```ts
/** Phase 31 (spec D7). Merges the glosses of one lexeme and language whose
 *  lemma-form rendering names another live gloss's key. */
export const MERGE_GLOSSES = 'merge-glosses';
/** One transaction of a few statements: a minute is generous. */
export const MERGE_GLOSSES_EXPIRY_SECONDS = 60;

export const MergeGlossesPayloadSchema = z.object({
  lexeme_id: z.string().min(1),
  user_language_code: z.string().min(1),
});
export type MergeGlossesPayload = z.infer<typeof MergeGlossesPayloadSchema>;
```

and `[MERGE_GLOSSES]: MergeGlossesPayload;` in `JobPayloads`. In `apps/server/src/db/jobs.ts`, add to `JOB_QUEUES` (no dead letter: a merge that keeps failing leaves two glosses, which the by-hand tool of Task 14 also finds):

```ts
  {
    name: MERGE_GLOSSES,
    options: { retryLimit: 2, retryBackoff: true, expireInSeconds: MERGE_GLOSSES_EXPIRY_SECONDS, deleteAfterSeconds: 86_400 },
  },
```

In `apps/server/src/errors.ts`, below `InvalidVocabularyEntry`:

```ts
/** Phase 31 (spec D14). A gloss whose learner language is not the enrollment's:
 *  the one invariant the explicit key brings. A kind of InvalidVocabularyEntry,
 *  so every route that answers that one with a 400 answers this one too. */
export class GlossLanguageMismatch extends InvalidVocabularyEntry {
  constructor(glossId: string) {
    super(glossId);
    this.name = 'GlossLanguageMismatch';
  }
}
```

- [ ] **Step 5: Write the failing repository tests.** Create `apps/server/tests/support/locks.ts`:

```ts
import { sql } from 'drizzle-orm';

import type { Db, Tx } from '../../src/db/client';
import { createDictRepo } from '../../src/repo/dictionary';
import { createGlossRepo } from '../../src/repo/glosses';

/**
 * Phase 31. Runs `work` in a transaction that stays open until `release()`, so a
 * test can line another transaction up behind its locks. `ready` resolves once
 * `work` has run, whether it threw or not; `done` settles with the transaction.
 */
export function holdOpen(db: Db, work: (tx: Tx) => Promise<void>): { ready: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  let markReady!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = db.transaction(async (tx) => {
    try {
      await work(tx);
    } finally {
      markReady();
    }
    await gate;
  });
  return { ready, release, done };
}

/** A merge held open under its lexeme's lock: what the merge job does, paused. */
export function holdMergeOpen(db: Db, input: { lexemeId: string; survivorId: string; otherId: string }) {
  return holdOpen(db, async (tx) => {
    await createDictRepo(tx).lockLexemes([input.lexemeId]);
    await createGlossRepo(tx).mergeGlosses({ survivorId: input.survivorId, otherId: input.otherId });
  });
}

/** Polls until some session of this database waits on a lock. */
export async function waitForBlockedQuery(db: Db, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`);
    if (rows.rows[0].n > 0) return;
    if (Date.now() > deadline) throw new Error(`no query blocked on a lock within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
```

Add to `apps/server/tests/support/vocabularyRows.ts`:

```ts
/** Phase 31. One enrollment's saved gloss ids, ordered. */
export async function readSavedGlossIds(db: Db, enrollmentId: string): Promise<string[]> {
  const rows = await db.execute<{ gloss_id: string }>(
    sql`select gloss_id from vocabulary_entries where enrollment_id = ${enrollmentId} order by gloss_id`,
  );
  return rows.rows.map((row) => row.gloss_id);
}
```

Add to `apps/server/tests/support/dictRows.ts` (import `dictVarTranslations` from the schema if the file does not already) the two fixtures the merge, race and tool tests share:

```ts
/** Phase 31. `finger` with two glosses of one word, the drift D6 could not
 *  rename: body_part keyed אצבעות from `fingers`, digit keyed אצבע from `finger`. */
export async function insertDriftedFinger(db: Db) {
  const word = await insertLexeme(db, {
    lemma: 'finger',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'body_part' }, { senseCode: 'digit' }],
    variants: [
      { form: 'fingers', kind: 'word', entryRank: 0, translations: [{ senseCode: 'body_part', rank: 0, translation: 'אצבעות', exampleSource: null, exampleTarget: null }] },
      { form: 'finger', kind: 'word', entryRank: 0, translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null }] },
    ],
  });
  return { ...word, other: word.glossIds[0], survivor: word.glossIds[1], fingers: word.variantIds[0], finger: word.variantIds[1] };
}

/** Phase 31. One rendering written past insertLexeme's gloss rule: a form
 *  rendered after its senses' memberships were decided, which is how drift
 *  arrives. */
export async function insertRendering(
  db: Db,
  row: { variantId: string; senseId: string; userLanguageCode: string; translation: string; gloss: string; rank: number },
): Promise<void> {
  await db.insert(dictVarTranslations).values(row);
}
```

Create `apps/server/tests/integration/repo/glosses.merge.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createGlossRepo } from '../../../src/repo/glosses';
import { insertDriftedFinger, insertLexeme, insertRendering } from '../../support/dictRows';
import { insertAnsweredSession, insertProgressRows, setLevel } from '../../support/progressRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { readSavedGlossIds } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u1');
  await seedUser(t.db, 'u2');
});
afterEach(async () => {
  await t.close();
});

const twoGlosses = () => insertDriftedFinger(t.db);

const save = (enrollmentId: string, glossId: string, variantId: string, lexemeId: string, at: string) =>
  t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id, created_at)
    values (${enrollmentId}, ${glossId}, ${lexemeId}, 'finger', ${variantId},
            (select user_id from enrollments where id = ${enrollmentId}), ${at}::timestamptz)`);

const merge = (lexemeId: string, survivorId: string, otherId: string) =>
  withTx(t.db, async (tx) => {
    await createDictRepo(tx).lockLexemes([lexemeId]);
    return createGlossRepo(tx).mergeGlosses({ survivorId, otherId });
  });

describe('mergeGlosses (spec D7)', () => {
  it('folds two enrollments onto the survivor: one entry each, the best levels, the earlier save, every question re-pointed', async () => {
    const w = await twoGlosses();
    const e1 = enrollmentOf('u1');
    const e2 = enrollmentOf('u2');
    await save(e1, w.other, w.fingers, w.lexemeId, '2026-01-01');
    await save(e1, w.survivor, w.finger, w.lexemeId, '2026-02-01');
    await save(e2, w.other, w.fingers, w.lexemeId, '2026-03-01');
    await insertProgressRows(t.db, e1, [w.other, w.survivor]);
    await insertProgressRows(t.db, e2, [w.other]);
    await setLevel(t.db, { enrollmentId: e1, glossId: w.other, level: 3, dimension: 'written_receptive' });
    await setLevel(t.db, { enrollmentId: e1, glossId: w.survivor, level: 4, dimension: 'written_productive' });
    const session = await insertAnsweredSession(t.db, {
      userId: 'u1',
      enrollmentId: e1,
      status: 'completed',
      asked: [
        { glossId: w.other, variantId: w.fingers, translation: 'אצבעות' },
        { glossId: w.survivor, variantId: w.finger, translation: 'אצבע' },
      ],
      answers: [],
    });

    const counts = await merge(w.lexemeId, w.survivor, w.other);

    expect(counts).toMatchObject({ entriesMoved: 1, entriesFolded: 1, questions: 1, memberships: 1 });
    expect(await readSavedGlossIds(t.db, e1)).toEqual([w.survivor]);
    expect(await readSavedGlossIds(t.db, e2)).toEqual([w.survivor]);
    const kept = await t.db.execute<{ variant_id: string }>(sql`select variant_id from vocabulary_entries where enrollment_id = ${e1}`);
    expect(kept.rows).toEqual([{ variant_id: w.fingers }]);
    const levels = await t.db.execute<{ dimension: string; level: number }>(sql`
      select dimension, level from gloss_progress where enrollment_id = ${e1} and dimension in ('written_receptive', 'written_productive') order by dimension`);
    expect(levels.rows).toEqual([{ dimension: 'written_productive', level: 4 }, { dimension: 'written_receptive', level: 3 }]);
    const questions = await t.db.execute<{ gloss_id: string }>(sql`
      select distinct q.gloss_id from questions q join session_questions sq on sq.question_id = q.id where sq.session_id = ${session}`);
    expect(questions.rows).toEqual([{ gloss_id: w.survivor }]);
    const forwarded = await t.db.execute<{ merged_into: string | null }>(sql`select merged_into from dict_glosses where id = ${w.other}`);
    expect(forwarded.rows).toEqual([{ merged_into: w.survivor }]);
    const survivor = await t.db.execute<{ alternatives: string[] }>(sql`select alternatives from dict_glosses where id = ${w.survivor}`);
    expect(survivor.rows[0].alternatives).toContain('אצבעות');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const w = await twoGlosses();
    await merge(w.lexemeId, w.survivor, w.other);
    expect(await merge(w.lexemeId, w.survivor, w.other)).toBeNull();
  });

  it('resolves a forwarded id to its survivor', async () => {
    const w = await twoGlosses();
    await merge(w.lexemeId, w.survivor, w.other);
    const resolved = await withTx(t.db, (tx) => createGlossRepo(tx).resolveGlosses([w.other, w.survivor]));
    expect(resolved.get(w.other)).toEqual({ id: w.survivor, lexemeId: w.lexemeId, userLanguageCode: 'he' });
    expect(resolved.get(w.survivor)?.id).toBe(w.survivor);
  });

  it('names a blocked rename as a candidate, and leaves two glosses that only name each other alone', async () => {
    const w = await twoGlosses();
    // The lemma form renders body_part as אצבע: the drift D6 could not rename.
    await insertRendering(t.db, { variantId: w.finger, senseId: w.senseIds[0], userLanguageCode: 'he', translation: 'אצבע', gloss: 'אצבע', rank: 1 });
    const candidates = await withTx(t.db, (tx) => createGlossRepo(tx).findMergeCandidates({ lexemeId: w.lexemeId, userLanguageCode: 'he' }));
    expect(candidates).toEqual([{ otherId: w.other, survivorId: w.survivor }]);

    const amazing = await insertLexeme(t.db, {
      lemma: 'amazing',
      languageCode: 'en',
      partOfSpeech: 'adjective',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'surprising' }, { senseCode: 'excellent' }],
      variants: [
        {
          form: 'amazing',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'surprising', rank: 0, translation: 'מדהים', alternatives: ['נהדר'], exampleSource: null, exampleTarget: null },
            { senseCode: 'excellent', rank: 1, translation: 'נהדר', alternatives: ['מדהים'], exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const none = await withTx(t.db, (tx) => createGlossRepo(tx).findMergeCandidates({ lexemeId: amazing.lexemeId, userLanguageCode: 'he' }));
    expect(none).toEqual([]);
  });
});
```

Create `apps/server/tests/integration/services/glosses.race.test.ts`. It may not import `src/repo` or Drizzle (ADR 0001 R2), so it reaches the merge only through `tests/support/locks.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { insertDriftedFinger } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { holdMergeOpen, waitForBlockedQuery } from '../../support/locks';
import { insertAnsweredSession, readProgress, readSnapshot } from '../../support/progressRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { readSavedGlossIds } from '../../support/vocabularyRows';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u1');
});
afterEach(async () => {
  await t.close();
});

const deps = () => createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(3) });

const twoGlosses = () => insertDriftedFinger(t.db);

describe('a learner write racing a merge (spec D14)', () => {
  it('lands a save on the survivor, as one row, when the merge commits first', async () => {
    const w = await twoGlosses();
    const merge = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merge.ready;
    const saving = deps().vocabulary.save('u1', enrollmentOf('u1'), [{ gloss_id: w.other, variant_id: w.fingers }]);
    await waitForBlockedQuery(t.db);
    merge.release();
    await merge.done;
    await saving;
    expect(await readSavedGlossIds(t.db, enrollmentOf('u1'))).toEqual([w.survivor]);
  });

  it('lands a save by an id merged long ago on the survivor', async () => {
    const w = await twoGlosses();
    const merge = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merge.ready;
    merge.release();
    await merge.done;
    await deps().vocabulary.save('u1', enrollmentOf('u1'), [{ gloss_id: w.other, variant_id: w.fingers }]);
    expect(await readSavedGlossIds(t.db, enrollmentOf('u1'))).toEqual([w.survivor]);
  });

  it("writes a session's progress and snapshot on the survivor when the session ends during a merge", async () => {
    const w = await twoGlosses();
    await deps().vocabulary.save('u1', enrollmentOf('u1'), [{ gloss_id: w.other, variant_id: w.fingers }]);
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u1',
      enrollmentId: enrollmentOf('u1'),
      status: 'ready',
      asked: [{ glossId: w.other, variantId: w.fingers, translation: 'אצבעות' }],
      answers: [],
    });
    const { questions } = await deps().sessions.getSession(sessionId);

    const merge = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merge.ready;
    const answering = deps().sessions.submitAnswer(sessionId, questions[0].id, { option_index: 0 });
    await waitForBlockedQuery(t.db);
    merge.release();
    await merge.done;
    await answering;

    const progress = await readProgress(t.db, enrollmentOf('u1'));
    expect(new Set(progress.map((row) => row.glossId))).toEqual(new Set([w.survivor]));
    expect(progress.find((row) => row.dimension === 'written_receptive')?.level).toBe(2);
    const snapshot = await readSnapshot(t.db, sessionId);
    expect(new Set(snapshot.map((row) => row.glossId))).toEqual(new Set([w.survivor]));
  });
});
```

The session's single card is a `multiple_choice` whose right option is at display index 0, because `insertAnsweredSession` writes `option_order` `[0, 1, 2, 3]` with the translation first.

- [ ] **Step 6: Run them and see them fail.** `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/repo/glosses.merge.test.ts tests/integration/services/glosses.race.test.ts`. Expected: FAIL, `Cannot find module '../../../src/repo/glosses'`.

- [ ] **Step 7: The gloss repository.** Create `apps/server/src/repo/glosses.ts`:

```ts
import { eq, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { dictGlosses } from '../db/schema';
import { keptEntry, mergeLevels, mergeSnapshots, tidyGlossList } from '../domain/glosses';

/** A gloss id as a write uses it: its survivor's, after any merge. */
export type ResolvedGloss = { id: string; lexemeId: string; userLanguageCode: string };

/** What one merge re-keyed, for the `gloss_merged` log (spec D19). */
export type MergeCounts = {
  entriesMoved: number;
  entriesFolded: number;
  snapshots: number;
  questions: number;
  memberships: number;
};

const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);
// A save time as fixed-width UTC text, so keptEntry can compare it as text.
const savedAt = (alias: 's' | 'o') =>
  sql.raw(`to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`);

/**
 * Phase 31 (spec D7, D14). Glosses as a learner's unit: resolving an id through
 * a merge, and the merge itself, which is the only regroup and runs outside the
 * lookup. A merge spans the dictionary and every learner table keyed on a gloss,
 * which is why it has a repository of its own.
 *
 * Locking. A merge runs under its lexeme's FOR UPDATE lock (lockLexemes, taken by
 * the caller). Every learner write takes FOR SHARE on the same row through
 * resolveGlosses (or ProgressRepo.lockSessionGlosses) before it reads an id, so
 * a write and a merge of one lexeme run one after the other, never interleaved.
 * A gloss never changes lexeme, so the row to lock is known before the lock.
 */
export function createGlossRepo(tx: Tx) {
  const resolveGlosses = async (ids: string[]): Promise<Map<string, ResolvedGloss>> => {
    const asked = [...new Set(ids)];
    if (asked.length === 0) return new Map();
    await tx.execute(sql`
      SELECT l.id FROM dict_lexemes l
      WHERE l.id IN (SELECT g.lexeme_id FROM dict_glosses g WHERE g.id IN (${inList(asked)}))
      ORDER BY l.id
      FOR SHARE`);
    // One hop: a merge re-points every gloss forwarded to the one it forwards,
    // so no chain forms.
    const rows = await tx.execute<{ asked: string; id: string; lexeme_id: string; user_language_code: string }>(sql`
      SELECT g.id AS asked, s.id, s.lexeme_id, s.user_language_code
      FROM dict_glosses g
      JOIN dict_glosses s ON s.id = coalesce(g.merged_into, g.id)
      WHERE g.id IN (${inList(asked)})`);
    return new Map(
      rows.rows.map((row) => [row.asked, { id: row.id, lexemeId: row.lexeme_id, userLanguageCode: row.user_language_code }]),
    );
  };

  /** Spec D7's automatic signal (decided while planning, item 4): a live gloss
   *  with a member whose lemma-form rendering's citation form is another live
   *  gloss's key. That other gloss survives: its key is the lemma form's (D6). */
  const findMergeCandidates = async (input: {
    lexemeId: string;
    userLanguageCode: string;
  }): Promise<{ otherId: string; survivorId: string }[]> => {
    const rows = await tx.execute<{ other_id: string; survivor_id: string }>(sql`
      SELECT DISTINCT ON (g.id) g.id AS other_id, s.id AS survivor_id
      FROM dict_glosses g
      JOIN dict_sense_glosses m     ON m.gloss_id = g.id
      JOIN dict_var_translations tr ON tr.sense_id = m.sense_id
                                   AND tr.user_language_code = m.user_language_code
      JOIN dict_variants v          ON v.id = tr.variant_id
      JOIN dict_lexemes l           ON l.id = v.lexeme_id AND lower(v.form) = lower(l.lemma)
      JOIN dict_glosses s           ON s.lexeme_id = g.lexeme_id
                                   AND s.user_language_code = g.user_language_code
                                   AND s.merged_into IS NULL
                                   AND s.id <> g.id
                                   AND gloss_key(s.key) = gloss_key(tr.gloss)
      WHERE g.lexeme_id = ${input.lexemeId}
        AND g.user_language_code = ${input.userLanguageCode}
        AND g.merged_into IS NULL
        AND gloss_key(tr.gloss) <> gloss_key(g.key)
      ORDER BY g.id, tr.rank`);
    return rows.rows.map((row) => ({ otherId: row.other_id, survivorId: row.survivor_id }));
  };

  /**
   * Spec D7. Folds `other` into `survivor`, both live glosses of one lexeme and
   * language: entries (an enrollment holding both keeps one, the earlier save,
   * at each dimension's best), session snapshots, questions and memberships move
   * to the survivor; the survivor takes the other's key and alternatives as its
   * own alternatives; the other forwards to it, and so does anything that
   * forwarded to the other. Photo rows are left alone: their options are a
   * snapshot, and a stale id resolves when the import is saved.
   *
   * Null when there is nothing to do (either gloss gone or no longer live),
   * which is what makes a retried job safe. The caller holds lockLexemes.
   */
  const mergeGlosses = async (input: { survivorId: string; otherId: string }): Promise<MergeCounts | null> => {
    const glosses = await tx.execute<{
      id: string;
      lexeme_id: string;
      user_language_code: string;
      key: string;
      alternatives: string[];
      merged_into: string | null;
    }>(sql`
      SELECT id, lexeme_id, user_language_code, key, alternatives, merged_into
      FROM dict_glosses WHERE id IN (${input.survivorId}, ${input.otherId})`);
    const survivor = glosses.rows.find((row) => row.id === input.survivorId);
    const other = glosses.rows.find((row) => row.id === input.otherId);
    if (!survivor || !other || survivor.merged_into !== null || other.merged_into !== null) return null;
    if (survivor.lexeme_id !== other.lexeme_id || survivor.user_language_code !== other.user_language_code) {
      throw new Error(`glosses ${input.otherId} and ${input.survivorId} are not of one lexeme and language`);
    }

    // 1. Enrollments holding both: fold the progress onto the survivor's rows,
    //    keep the earlier save, drop the other entry (its progress cascades).
    const both = await tx.execute<{
      enrollment_id: string;
      s_variant: string;
      s_adder: string;
      s_saved: string;
      o_variant: string;
      o_adder: string;
      o_saved: string;
    }>(sql`
      SELECT o.enrollment_id,
             s.variant_id AS s_variant, s.added_by_user_id AS s_adder, ${savedAt('s')} AS s_saved,
             o.variant_id AS o_variant, o.added_by_user_id AS o_adder, ${savedAt('o')} AS o_saved
      FROM vocabulary_entries o
      JOIN vocabulary_entries s ON s.enrollment_id = o.enrollment_id AND s.gloss_id = ${input.survivorId}
      WHERE o.gloss_id = ${input.otherId}`);
    for (const row of both.rows) {
      const levels = await tx.execute<{
        dimension: string;
        s_level: number;
        s_step: string | null;
        s_wrong: string | null;
        o_level: number;
        o_step: string | null;
        o_wrong: string | null;
      }>(sql`
        SELECT o.dimension,
               s.level AS s_level, s.last_step_on::text AS s_step, s.last_wrong_on::text AS s_wrong,
               o.level AS o_level, o.last_step_on::text AS o_step, o.last_wrong_on::text AS o_wrong
        FROM gloss_progress o
        JOIN gloss_progress s ON s.enrollment_id = o.enrollment_id AND s.dimension = o.dimension
                             AND s.gloss_id = ${input.survivorId}
        WHERE o.enrollment_id = ${row.enrollment_id} AND o.gloss_id = ${input.otherId}`);
      for (const level of levels.rows) {
        const folded = mergeLevels(
          { level: level.s_level, lastStepOn: level.s_step, lastWrongOn: level.s_wrong },
          { level: level.o_level, lastStepOn: level.o_step, lastWrongOn: level.o_wrong },
        );
        await tx.execute(sql`
          UPDATE gloss_progress
          SET level = ${folded.level}, last_step_on = ${folded.lastStepOn}::date, last_wrong_on = ${folded.lastWrongOn}::date
          WHERE enrollment_id = ${row.enrollment_id} AND gloss_id = ${input.survivorId} AND dimension = ${level.dimension}`);
      }
      const kept = keptEntry(
        { variantId: row.s_variant, addedByUserId: row.s_adder, savedAt: row.s_saved },
        { variantId: row.o_variant, addedByUserId: row.o_adder, savedAt: row.o_saved },
      );
      if (kept.savedAt === row.o_saved && row.o_saved !== row.s_saved) {
        await tx.execute(sql`
          UPDATE vocabulary_entries s
          SET variant_id = o.variant_id, added_by_user_id = o.added_by_user_id, created_at = o.created_at
          FROM vocabulary_entries o
          WHERE s.enrollment_id = ${row.enrollment_id} AND s.gloss_id = ${input.survivorId}
            AND o.enrollment_id = s.enrollment_id AND o.gloss_id = ${input.otherId}`);
      }
      await tx.execute(sql`DELETE FROM vocabulary_entries WHERE enrollment_id = ${row.enrollment_id} AND gloss_id = ${input.otherId}`);
    }

    // 2. Enrollments holding only the other: the entry moves, and its progress
    //    rows follow it (gloss_progress_entry_fk is ON UPDATE CASCADE).
    const moved = await tx.execute(sql`UPDATE vocabulary_entries SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);

    // 3. Snapshots: a session that practised both folds (mergeSnapshots); the rest move.
    const sessions = await tx.execute<{ session_id: string; dimension: string; s_before: number; s_after: number; o_before: number; o_after: number }>(sql`
      SELECT o.session_id, o.dimension, s.level_before AS s_before, s.level_after AS s_after,
             o.level_before AS o_before, o.level_after AS o_after
      FROM session_progress o
      JOIN session_progress s ON s.session_id = o.session_id AND s.dimension = o.dimension AND s.gloss_id = ${input.survivorId}
      WHERE o.gloss_id = ${input.otherId}`);
    for (const row of sessions.rows) {
      const folded = mergeSnapshots({ levelBefore: row.s_before, levelAfter: row.s_after }, { levelBefore: row.o_before, levelAfter: row.o_after });
      await tx.execute(sql`
        UPDATE session_progress SET level_before = ${folded.levelBefore}, level_after = ${folded.levelAfter}
        WHERE session_id = ${row.session_id} AND gloss_id = ${input.survivorId} AND dimension = ${row.dimension}`);
      await tx.execute(sql`
        DELETE FROM session_progress
        WHERE session_id = ${row.session_id} AND gloss_id = ${input.otherId} AND dimension = ${row.dimension}`);
    }
    const snapshots = await tx.execute(sql`UPDATE session_progress SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);

    // 4. Questions and memberships.
    const questions = await tx.execute(sql`UPDATE questions SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);
    const memberships = await tx.execute(sql`UPDATE dict_sense_glosses SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);

    // 5. The other's words become the survivor's alternatives. Through the query
    //    builder: an array inside a sql`` template expands into a list.
    const alternatives = tidyGlossList([...survivor.alternatives, other.key, ...other.alternatives], survivor.key);
    await tx.update(dictGlosses).set({ alternatives }).where(eq(dictGlosses.id, input.survivorId));

    // 6. Forward the other, and whatever forwarded to it.
    await tx.execute(sql`
      UPDATE dict_glosses SET merged_into = ${input.survivorId}
      WHERE id = ${input.otherId} OR merged_into = ${input.otherId}`);

    return {
      entriesMoved: moved.rowCount ?? 0,
      entriesFolded: both.rows.length,
      snapshots: (snapshots.rowCount ?? 0) + sessions.rows.length,
      questions: questions.rowCount ?? 0,
      memberships: memberships.rowCount ?? 0,
    };
  };

  return { resolveGlosses, findMergeCandidates, mergeGlosses };
}

export type GlossRepo = ReturnType<typeof createGlossRepo>;
```

Register it: `apps/server/src/services/transaction.ts` adds `gloss: GlossRepo;` to `Repos` (type import from `../repo/glosses`); `composition.ts` binds `gloss: createGlossRepo(tx)`; `tests/support/fakes.ts`' `createFakeTransaction` adds `gloss: repos.gloss ?? unreachableRepo('gloss repo')`, and fakes gains:

```ts
/** Phase 31. resolveGlosses as the identity, in one learner language: no merge
 *  happened. Records every id it was asked about. */
export function createFakeGlossRepo(userLanguageCode = 'he') {
  const asked: string[][] = [];
  return {
    asked,
    resolveGlosses: async (ids: string[]) => {
      asked.push(ids);
      return new Map(ids.map((id) => [id, { id, lexemeId: `lexeme-of-${id}`, userLanguageCode }]));
    },
    findMergeCandidates: async () => [],
    mergeGlosses: async () => null,
  };
}
```

- [ ] **Step 8: `writeGlosses` reads forwarded keys.** In `apps/server/src/repo/dictionary.ts`, `writeGlosses` also reads the lexeme's forwarded glosses in the language and hands them to `assignGlosses`:

```ts
    // Phase 31 (spec D7). A merged gloss's key still names its survivor: a sense
    // that names it later joins the survivor rather than reviving the word.
    const forwarded = await tx
      .select({ key: dictGlosses.key, survivor: dictGlosses.mergedInto })
      .from(dictGlosses)
      .where(
        and(
          eq(dictGlosses.lexemeId, input.lexemeId),
          eq(dictGlosses.userLanguageCode, input.userLanguageCode),
          isNotNull(dictGlosses.mergedInto),
        ),
      );
    const aliases = new Map(forwarded.map((row) => [normaliseGloss(row.key), row.survivor!]));
```

(import `isNotNull` from `drizzle-orm`, `normaliseGloss` from `@lang-tutor/core/domain`) and passes `aliases` to `assignGlosses`. `writeGlosses` also returns `counts: { created: plan.create.length, joined: plan.join.length, members: added.length }`, and `persistEntries` sums them into `glosses: { created, joined, members }` on its return value.

- [ ] **Step 9: The merge job and its service.** Create `apps/server/src/services/glosses.ts`:

```ts
import { MergeGlossesPayloadSchema } from '../domain/jobs';
import type { Logger } from '../logger';
import type { MergeCounts } from '../repo/glosses';
import type { Transaction } from './transaction';

/** The `gloss_merged` log line (spec D19): one shape for the job and the tool. */
function glossMerged(input: { lexemeId: string; userLanguageCode: string; survivorId: string; otherId: string; counts: MergeCounts }) {
  return {
    event: 'gloss_merged',
    lexeme_id: input.lexemeId,
    user_language_code: input.userLanguageCode,
    survivor_id: input.survivorId,
    merged_id: input.otherId,
    entries_moved: input.counts.entriesMoved,
    entries_folded: input.counts.entriesFolded,
    snapshots: input.counts.snapshots,
    questions: input.counts.questions,
    memberships: input.counts.memberships,
  };
}

/**
 * Phase 31 (spec D7). The gloss use cases that are not a lookup: the merge job.
 * A merge runs here, outside the lookup, in a transaction of its own under the
 * lexeme's lock; the lookup only ever asks for one.
 */
export function createGlossService({ transaction, logger }: { transaction: Transaction; logger: Logger }) {
  return {
    /** The merge-glosses job: every pair of one lexeme and language whose lemma
     *  form names another gloss's key, merged. Idempotent, so a retry is safe. */
    mergeLexeme: async (data: unknown): Promise<void> => {
      const { lexeme_id: lexemeId, user_language_code: userLanguageCode } = MergeGlossesPayloadSchema.parse(data);
      const merged = await transaction(async ({ dict, gloss }) => {
        await dict.lockLexemes([lexemeId]);
        const done: { otherId: string; survivorId: string; counts: Record<string, number> }[] = [];
        for (const pair of await gloss.findMergeCandidates({ lexemeId, userLanguageCode })) {
          const counts = await gloss.mergeGlosses(pair);
          if (counts) done.push({ ...pair, counts });
        }
        return done;
      });
      for (const { otherId, survivorId, counts } of merged) {
        logger.info(glossMerged({ lexemeId, userLanguageCode, survivorId, otherId, counts }));
      }
    },
  };
}

export type GlossService = ReturnType<typeof createGlossService>;
```

`composition.ts`: `AppDeps` gains `glosses: GlossService;` and `createServerDeps` returns `glosses: createGlossService({ transaction, logger: io.logger })`. `tests/support/fakes.ts`' `createFakeAppDeps` adds `glosses: { mergeLexeme: unreachable }`. `worker.ts`: `registerWorkers`' `services` gains `glosses: GlossService`, and:

```ts
  // Phase 31 (spec D7). One merge at a time per process: each locks a lexeme.
  await boss.work(MERGE_GLOSSES, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async (jobs) => {
    for (const job of jobs) await glosses.mergeLexeme(job.data);
  });
```

`services/translations.ts` enqueues what the writes return, and logs the assignment (spec D19). In `translate`'s write transaction, after `persistEntries`:

```ts
        // Phase 31 (spec D7). A rename another gloss's key blocked: the merge job
        // decides, in its own transaction, under the lexeme's lock.
        for (const pair of result.mergePairs) {
          await repos.jobs.enqueue(MERGE_GLOSSES, { lexeme_id: pair.lexemeId, user_language_code: pair.userLanguageCode });
        }
```

and after the transaction, beside `dict_persisted`: `logger.info({ event: 'dict_glosses_assigned', from, to, created: glosses.created, joined: glosses.joined, members: glosses.members });` (return `glosses` out of the transaction with `written` and `senses`). In `repairForm`'s write, collect `needsMerge` per lexeme and enqueue the same job for each lexeme that needs one, inside that transaction. Add a unit test to `services/translations.test.ts`: with `dict.mergePairs = [{ lexemeId: 't-0', userLanguageCode: 'he' }]` and a `createFakeJobRepo()` in the transaction, a lookup enqueues one `merge-glosses` job with that payload.

- [ ] **Step 10: Every learner write resolves first (D14).**

`services/vocabulary.ts`, `save`, right after `authorize`:

```ts
        // Phase 31 (spec D14). Share-lock and resolve before anything is checked or
        // written: a merge of these glosses runs wholly before this or wholly after.
        const resolved = await repos.gloss.resolveGlosses(asked.map((entry) => entry.gloss_id));
        const foreign = asked.find((entry) => {
          const gloss = resolved.get(entry.gloss_id);
          return gloss !== undefined && gloss.userLanguageCode !== enrolled.source_language;
        });
        if (foreign) {
          logger.info({ event: 'vocabulary_entry_refused', enrollment_id: enrollmentId, gloss_id: foreign.gloss_id, reason: 'language' });
          throw new GlossLanguageMismatch(foreign.gloss_id);
        }
        const toSave = firstPerGloss(
          asked.map((entry) => ({ gloss_id: resolved.get(entry.gloss_id)?.id ?? entry.gloss_id, variant_id: entry.variant_id })),
        );
```

and the rest of the transaction (`findSaveable`, the refusal, `insertEntries`) works on `toSave`. The response still lists the ids the client sent (`asked`): those are the ids on its screen. `unsave` resolves the one id the same way and deletes the survivor's entry.

`services/photoImports.ts`, `save`: resolve every entry's `gloss_id` through `vocabulary`'s transaction's `gloss.resolveGlosses` before `findSaveable`, with the same language check, and save the resolved ids. `updateItem` keeps checking the chosen id against the row's options as it is: the options are a snapshot and hold the ids it was given.

`repo/progress.ts` gains:

```ts
    /** Phase 31 (spec D14). FOR SHARE on the lexemes of every gloss this session's
     *  questions practise, in id order, before its evidence is read. A gloss never
     *  changes lexeme, so this holds the right rows even while a merge re-keys
     *  these questions; once the merge commits, the reads after this see it. */
    lockSessionGlosses: async (sessionId: string): Promise<void> => {
      await tx.execute(sql`
        SELECT l.id FROM dict_lexemes l
        WHERE l.id IN (
          SELECT g.lexeme_id
          FROM session_questions sq
          JOIN questions q    ON q.id = sq.question_id
          JOIN dict_glosses g ON g.id = q.gloss_id
          WHERE sq.session_id = ${sessionId})
        ORDER BY l.id
        FOR SHARE`);
    },
```

`services/sessions.ts`:
- `recordProgress` starts with `await repos.progress.lockSessionGlosses(sessionId);`.
- `prepareSession`'s read transaction (add `gloss` to its destructuring) resolves the picks before `findGenerationContext`, refuses a foreign one, and asks for the survivors:

```ts
        // Phase 31 (spec D14). A pick made before a merge names the survivor now,
        // and a gloss of another learner language is refused.
        const resolved = await gloss.resolveGlosses(payload.picks.map((pick) => pick.gloss_id));
        const foreign = payload.picks.find((pick) => (resolved.get(pick.gloss_id)?.userLanguageCode ?? enrolled.source_language) !== enrolled.source_language);
        if (foreign) throw new GlossLanguageMismatch(foreign.gloss_id);
        const context = await question.findGenerationContext({
          picks: payload.picks.map((pick) => ({
            glossId: resolved.get(pick.gloss_id)?.id ?? pick.gloss_id,
            senseId: pick.sense_id,
            variantId: pick.variant_id,
          })),
          sourceLanguage: enrolled.source_language,
        });
```

- Its write transaction (add `gloss`) resolves again right before `insertGeneratedQuestions`, because a merge may have landed during the model call, and writes `glossId: now.get(row.glossId)?.id ?? row.glossId`.
- Unit tests that fake these transactions (`sessions.prepare.test.ts`, `sessions.progress.test.ts`, `sessions.test.ts`, `photoImports.test.ts`) pass `gloss: createFakeGlossRepo()` and a `progress` stub with `lockSessionGlosses: async () => {}`.

Run Step 6's command. Expected: PASS. If a race test hangs at `waitForBlockedQuery`, the write under test did not take the share lock: check that its first statement after `authorize` is `resolveGlosses`.

- [ ] **Step 11: Write and run the job test.** Create `apps/server/tests/integration/jobs/mergeGlosses.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { MERGE_GLOSSES } from '../../../src/domain/jobs';
import { createFakeLogger } from '../../support/fakes';
import { countJobs, startTestBoss, stopTestBoss } from '../../support/jobs';
import { clearNamespace, expectGeminiJson, expectReconciliation, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;
let boss: PgBoss;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('jobs-merge-glosses');
  boss = await startTestBoss(t.db);
});
afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

const deps = () => createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(5), geminiBaseUrl: geminiBaseUrlFor(ns), boss });
const sense = (sense_code: string, translation: string, gloss: string) => ({ sense_code, translation, gloss, example: { source: 'A finger.', target: 'אצבע.' } });

describe('the merge-glosses job (spec D7)', () => {
  it('is enqueued by the lookup whose lemma form names another gloss’s key, and merges the two', async () => {
    // `fingers` first, with a drifted citation form; then `finger`, whose answer
    // names the same sense אצבע beside a new one that takes the key first.
    await expectGeminiJson(ns, { kind: 'word', entries: [{ lemma: 'finger', part_of_speech: 'noun', senses: [sense('body_part', 'אצבעות', 'אצבעות')] }], matchText: '"fingers"' });
    await deps().translations.translate({ text: 'fingers', from: 'en', to: 'he' });
    await expectReconciliation(ns, { senses: [sense('digit', 'אצבע', 'אצבע'), sense('body_part', 'אצבע', 'אצבע')] });
    await expectGeminiJson(ns, { kind: 'word', entries: [{ lemma: 'finger', part_of_speech: 'noun', senses: [sense('digit', 'אצבע', 'אצבע')] }], matchText: '"finger"' });
    await deps().translations.translate({ text: 'finger', from: 'en', to: 'he' });

    expect(await countJobs(t.db, MERGE_GLOSSES)).toBe(1);
    const lexemeId = (await t.db.execute<{ id: string }>(sql`select id from dict_lexemes where lemma = 'finger'`)).rows[0].id;
    await deps().glosses.mergeLexeme({ lexeme_id: lexemeId, user_language_code: 'he' });
    const live = await t.db.execute<{ key: string }>(sql`select key from dict_glosses where merged_into is null order by key`);
    expect(live.rows).toEqual([{ key: 'אצבע' }]);
  });
});
```

Job tests may import `sql` from `drizzle-orm`: ADR 0001's checks bar it only in route and service tests. Add two more cases in the same file: a lexeme whose glosses only name each other among their alternatives (write it with `insertLexeme` as in `glosses.merge.test.ts`) enqueues nothing on a lookup and `mergeLexeme` leaves both live; and `mergeLexeme` on a lexeme with one gloss per key changes nothing and logs no `gloss_merged`.

Run: `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/jobs/mergeGlosses.test.ts`. Expected: PASS.

- [ ] **Step 12: Check and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch`. Expected: PASS. ADR 0007's check must still pass: the merge is enqueued only through `repo/jobs.ts`, inside the lookup's and the repair's transactions.

```bash
git add apps/server
git commit -m "feat(server): merges — the merge job, forwarded glosses, and every learner write resolving under a share lock"
```

---

### Task 10: Lemma renders — the `render-lemma` job, its enqueue on every save, and the start-up backfill (D12)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`dictLemmaRenders`); Create: `apps/server/src/db/migrations/0024_lemma_renders.sql` (+ meta)
- Modify: `apps/server/src/domain/jobs.ts`, `apps/server/src/db/jobs.ts` (`RENDER_LEMMA`, `withJobQueue`), `apps/server/src/worker.ts`
- Modify: `apps/server/src/domain/dictionary.ts` (`entriesToRows`' offset)
- Modify: `apps/server/src/repo/dictionary.ts` (`findLexeme`, `hasLemmaRendering`, `nextEntryRank`, `claimLemmaRenders`, `claimSavedLemmaRenders`, `persistEntries`' `entryRankOffset`)
- Modify: `apps/server/src/services/translations.ts` (`renderLemma`, `addHeadwordToForm`)
- Modify: `apps/server/src/services/vocabulary.ts`, `services/photoImports.ts` (claim and enqueue on save)
- Create: `apps/server/src/db/lemmaRenders.ts`; Modify: `apps/server/src/db/cli.ts`, `apps/server/package.json`, `package.json`
- Create: `apps/server/tests/integration/jobs/renderLemma.test.ts`, `apps/server/tests/integration/db/lemmaRenders.test.ts`
- Modify: `e2e/tests/support/mockServer.ts` (`userText`), `e2e/tests/support/interactions.ts` (`lookUp` matches its own text)

**Interfaces:**
- Produces: table `dict_lemma_renders (lexeme_id, user_language_code, requested_at)`, primary key `(lexeme_id, user_language_code)`.
- Produces: `RENDER_LEMMA = 'render-lemma'`, `RenderLemmaPayloadSchema = z.object({ lexeme_id, user_language_code })`.
- Produces, in `repo/dictionary.ts`: `type LexemeLanguage = { lexemeId: string; userLanguageCode: string }` (and `MergePair = LexemeLanguage`); `findLexeme(lexemeId): Promise<{ id; lemma; languageCode; partOfSpeech } | undefined>`; `hasLemmaRendering(input: LexemeLanguage): Promise<boolean>`; `nextEntryRank(input: { form; languageCode }): Promise<number>`; `claimLemmaRenders(pairs: LexemeLanguage[]): Promise<LexemeLanguage[]>`; `claimSavedLemmaRenders(): Promise<LexemeLanguage[]>`; `persistEntries` input gains `entryRankOffset?: number`.
- Produces: `entriesToRows(entries: LlmEntry[], entryRankOffset = 0)`.
- Produces: `TranslationService.renderLemma(data: unknown): Promise<void>`.
- Produces: `withJobQueue<T>(db: Db, run: (boss: PgBoss) => Promise<T>): Promise<T>` in `db/jobs.ts`; `requestLemmaRenders(db: Db): Promise<{ requested: number }>` in `db/lemmaRenders.ts`.
- Produces: `npm run dict:lemmas:render` (root, through `lane-env.sh`) and the CLI flag `--render-lemmas`.
- Produces: `userText(text: string): string` in `e2e/tests/support/mockServer.ts`, the body regex for a model call whose user part is exactly `text`.

- [ ] **Step 1: The table.** In `apps/server/src/db/schema.ts`, after `dictSenseGlosses`:

```ts
/**
 * Phase 31 (decided while planning, item 3; spec D12). One row per lexeme and
 * learner language whose lemma form's rendering was ever requested, by a save or
 * by the start-up backfill. Nothing requests it twice: a lemma the job skipped
 * (the lemma's lookup had no entry for this headword) would otherwise cost model
 * calls on every save and every container start.
 */
export const dictLemmaRenders = pgTable(
  'dict_lemma_renders',
  {
    lexemeId: text('lexeme_id').notNull(),
    userLanguageCode: varchar('user_language_code', { length: 10 }).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'dict_lemma_renders_pkey', columns: [t.lexemeId, t.userLanguageCode] }),
    foreignKey({ name: 'dict_lemma_renders_lexeme_fk', columns: [t.lexemeId], foreignColumns: [dictLexemes.id] }).onDelete('cascade'),
  ],
);
```

`npm run db:generate -w apps/server -- --name lemma_renders`, put `-- Phase 31. Lemma-form render requests (plan item 3).` at the top of the SQL, then the two checks of Global Constraints. Add `'dict_lemma_renders'` to `TABLES` in `tests/integration/db/schema.test.ts`.

- [ ] **Step 2: Write the failing tests.** Create `apps/server/tests/integration/jobs/renderLemma.test.ts`. The fixtures are lane 0's cases: `to spike` saved under the verb, nobody having looked up `spike`; `bank` looked up as a noun only, with the verb saved from `banking`.

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { RENDER_LEMMA } from '../../../src/domain/jobs';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { countJobs, startTestBoss, stopTestBoss } from '../../support/jobs';
import { clearNamespace, expectGeminiJson, expectGeminiStatus, expectReconciliation, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;
let boss: PgBoss;
let logger: FakeLogger;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('jobs-render-lemma');
  boss = await startTestBoss(t.db);
  logger = createFakeLogger();
  await seedUser(t.db, 'u1');
});
afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

const deps = () => createTestServerDeps({ db: t.db, logger, rng: testRng(5), geminiBaseUrl: geminiBaseUrlFor(ns), boss });
const none = (s: string) => ({ senseCode: s, rank: 0, exampleSource: null, exampleTarget: null });

async function spikeVerb() {
  return insertLexeme(t.db, {
    lemma: 'spike',
    languageCode: 'en',
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'sharp_increase' }],
    variants: [{ form: 'to spike', kind: 'word', entryRank: 0, translations: [{ ...none('sharp_increase'), translation: 'לזנק' }] }],
  });
}

async function headwordsOfForm(form: string) {
  const rows = await t.db.execute<{ part_of_speech: string; entry_rank: number }>(sql`
    select l.part_of_speech, v.entry_rank from dict_variants v join dict_lexemes l on l.id = v.lexeme_id
    where lower(v.form) = lower(${form})
      and exists (select 1 from dict_var_translations tr where tr.variant_id = v.id and tr.user_language_code = 'he')
    order by v.entry_rank`);
  return rows.rows;
}

describe('enqueueing render-lemma (spec D12)', () => {
  it('a save of a form whose lemma is unrendered asks for it once; a save of the lemma asks for nothing', async () => {
    const spike = await spikeVerb();
    const save = () => deps().vocabulary.save('u1', enrollmentOf('u1'), [{ gloss_id: spike.glossIds[0], variant_id: spike.variantIds[0] }]);
    await save();
    await save();
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(1);

    const ladder = await insertLexeme(t.db, {
      lemma: 'ladder', languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'steps' }],
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0, translations: [{ ...none('steps'), translation: 'סולם' }] }],
    });
    await deps().vocabulary.save('u1', enrollmentOf('u1'), [{ gloss_id: ladder.glossIds[0], variant_id: ladder.variantIds[0] }]);
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(1);
  });
});

describe('the render-lemma job (spec D12)', () => {
  it('on a lemma nobody looked up, runs the ordinary lookup, which writes every headword of the form', async () => {
    const spike = await spikeVerb();
    await expectReconciliation(ns, { senses: [{ sense_code: 'sharp_increase', translation: 'לזנק', gloss: 'לזנק' }] });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        { lemma: 'spike', part_of_speech: 'noun', senses: [{ sense_code: 'sharp_point', translation: 'חוד', example: { source: 'A spike.', target: 'חוד.' } }] },
        { lemma: 'spike', part_of_speech: 'verb', senses: [{ sense_code: 'jump_up', translation: 'לזנק', example: { source: 'Prices spike.', target: 'מחירים מזנקים.' } }] },
      ],
      matchText: '"spike"',
    });

    await deps().translations.renderLemma({ lexeme_id: spike.lexemeId, user_language_code: 'he' });

    expect(await headwordsOfForm('spike')).toEqual([
      { part_of_speech: 'noun', entry_rank: 0 },
      { part_of_speech: 'verb', entry_rank: 1 },
    ]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_rendered', path: 'lookup' }));
  });

  it('on a lemma already a hit without this headword, adds it with the scoped call at the next entry rank', async () => {
    await insertLexeme(t.db, {
      lemma: 'bank', languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'money' }],
      variants: [{ form: 'bank', kind: 'word', entryRank: 0, translations: [{ ...none('money'), translation: 'בנק' }] }],
    });
    const verb = await insertLexeme(t.db, {
      lemma: 'bank', languageCode: 'en', partOfSpeech: 'verb', userLanguageCode: 'he', senses: [{ senseCode: 'deposit' }],
      variants: [{ form: 'banking', kind: 'word', entryRank: 0, translations: [{ ...none('deposit'), translation: 'מפקיד' }] }],
    });
    await expectReconciliation(ns, { senses: [{ sense_code: 'deposit', translation: 'להפקיד', gloss: 'להפקיד' }] });

    await deps().translations.renderLemma({ lexeme_id: verb.lexemeId, user_language_code: 'he' });

    expect(await headwordsOfForm('bank')).toEqual([
      { part_of_speech: 'noun', entry_rank: 0 },
      { part_of_speech: 'verb', entry_rank: 1 },
    ]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_rendered', path: 'scoped' }));
  });

  it('skips, and says why, when the lemma’s lookup has no entry for this headword', async () => {
    const spike = await spikeVerb();
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [{ lemma: 'spike', part_of_speech: 'noun', senses: [{ sense_code: 'sharp_point', translation: 'חוד', example: { source: 'A spike.', target: 'חוד.' } }] }],
      matchText: '"spike"',
    });
    await deps().translations.renderLemma({ lexeme_id: spike.lexemeId, user_language_code: 'he' });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_render_skipped', reason: 'no_entry' }));
  });

  it('fails loudly for pg-boss to retry when the provider fails, and the saved word still serves', async () => {
    const spike = await spikeVerb();
    await deps().vocabulary.save('u1', enrollmentOf('u1'), [{ gloss_id: spike.glossIds[0], variant_id: spike.variantIds[0] }]);
    await expectGeminiStatus(ns, 500);
    await expect(deps().translations.renderLemma({ lexeme_id: spike.lexemeId, user_language_code: 'he' })).rejects.toThrow();
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_render_failed' }));
    const detail = await deps().vocabulary.wordDetail(enrollmentOf('u1'), 'spike');
    expect(detail.senses[0]).toMatchObject({ saved: true, form: 'to spike' });
  });
});
```

Create `apps/server/tests/integration/db/lemmaRenders.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { RENDER_LEMMA } from '../../../src/domain/jobs';
import { requestLemmaRenders } from '../../../src/db/lemmaRenders';
import { insertLexeme } from '../../support/dictRows';
import { countJobs } from '../../support/jobs';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u1');
});
afterEach(async () => {
  await t.close();
});

const none = (s: string) => ({ senseCode: s, rank: 0, exampleSource: null, exampleTarget: null });

async function savedFrom(lemma: string, form: string, translation: string) {
  const word = await insertLexeme(t.db, {
    lemma, languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'only' }],
    variants: [{ form, kind: 'word', entryRank: 0, translations: [{ ...none('only'), translation }] }],
  });
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id)
    values (${enrollmentOf('u1')}, ${word.glossIds[0]}, ${word.lexemeId}, ${lemma}, ${word.variantIds[0]}, 'u1')`);
}

describe('requestLemmaRenders, the start-up backfill (plan item 3)', () => {
  it('asks once for every saved word whose lemma form is unrendered, and never again', async () => {
    await savedFrom('finger', 'fingers', 'אצבעות');
    await savedFrom('see', 'saw', 'ראה');
    await savedFrom('car', 'car', 'מכונית');

    expect(await requestLemmaRenders(t.db)).toEqual({ requested: 2 });
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(2);
    expect(await requestLemmaRenders(t.db)).toEqual({ requested: 0 });
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(2);
  });
});
```

- [ ] **Step 3: Run them and see them fail.** `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/jobs/renderLemma.test.ts tests/integration/db/lemmaRenders.test.ts`. Expected: FAIL, `renderLemma is not a function` and `Cannot find module '../../../src/db/lemmaRenders'`.

- [ ] **Step 4: The queue.** In `apps/server/src/domain/jobs.ts`:

```ts
/** Phase 31 (spec D12). Renders one lexeme's lemma form in one learner language. */
export const RENDER_LEMMA = 'render-lemma';
/** A lookup's two calls and a write, each call within the lookup's 25 s. */
export const RENDER_LEMMA_EXPIRY_SECONDS = 180;

export const RenderLemmaPayloadSchema = z.object({
  lexeme_id: z.string().min(1),
  user_language_code: z.string().min(1),
});
export type RenderLemmaPayload = z.infer<typeof RenderLemmaPayloadSchema>;
```

with `[RENDER_LEMMA]: RenderLemmaPayload;` in `JobPayloads`. In `db/jobs.ts`, the queue (no dead letter: no state to mark, and the saved form serves meanwhile):

```ts
  {
    name: RENDER_LEMMA,
    options: { retryLimit: 2, retryBackoff: true, expireInSeconds: RENDER_LEMMA_EXPIRY_SECONDS, deleteAfterSeconds: 86_400 },
  },
```

and, below `installJobs`:

```ts
/**
 * Phase 31. A started pg-boss on the caller's handle for the length of `run`,
 * for an enqueue outside the server: the CLI's lemma backfill. Built as
 * installJobs builds its own, and stopped however `run` ends.
 */
export async function withJobQueue<T>(db: Db, run: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = new PgBoss({
    db: fromDrizzle(db, sql),
    schema: JOB_SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  let failure: unknown;
  boss.on('error', (error) => {
    failure ??= error;
  });
  await boss.start();
  try {
    return await run(boss);
  } finally {
    await boss.stop({ graceful: false });
    if (failure) throw failure;
  }
}
```

`worker.ts`, with `translations: TranslationService` added to `registerWorkers`' services:

```ts
  // Phase 31 (spec D12). Two at once per process: each is a lookup's calls.
  await boss.work(
    RENDER_LEMMA,
    { localConcurrency: 2, pollingIntervalSeconds: options.pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await translations.renderLemma(job.data);
    },
  );
```

- [ ] **Step 5: The repository reads and claims.** In `apps/server/src/domain/dictionary.ts`, `entriesToRows(entries: LlmEntry[], entryRankOffset = 0)` assigns `entryRank: entryRankOffset + index`. In `apps/server/src/repo/dictionary.ts`: `PersistEntriesInput` gains `entryRankOffset?: number` (passed to `entriesToRows`); `export type LexemeLanguage = { lexemeId: string; userLanguageCode: string };` with `MergePair` now `= LexemeLanguage`; and:

```ts
  /** Phase 31. One lexeme, for the render-lemma job. */
  const findLexeme = async (lexemeId: string) => {
    const [row] = await tx
      .select({ id: dictLexemes.id, lemma: dictLexemes.lemma, languageCode: dictLexemes.languageCode, partOfSpeech: dictLexemes.partOfSpeech })
      .from(dictLexemes)
      .where(eq(dictLexemes.id, lexemeId));
    return row;
  };

  /** Phase 31 (spec D12). Whether a lexeme's lemma form renders it in a language:
   *  the condition the read and both claims below share. */
  const LEMMA_RENDERED = (lexeme: SQL, language: SQL) => sql`
    EXISTS (
      SELECT 1 FROM dict_variants v
      JOIN dict_lexemes l           ON l.id = v.lexeme_id
      JOIN dict_var_translations tr ON tr.variant_id = v.id AND tr.user_language_code = ${language}
      WHERE v.lexeme_id = ${lexeme} AND lower(v.form) = lower(l.lemma))`;

  /** Phase 31 (spec D12). Whether this lexeme's lemma form renders it in a language. */
  const hasLemmaRendering = async (input: LexemeLanguage): Promise<boolean> => {
    const rows = await tx.execute<{ rendered: boolean }>(
      sql`SELECT ${LEMMA_RENDERED(sql`${input.lexemeId}`, sql`${input.userLanguageCode}`)} AS rendered`,
    );
    return rows.rows[0].rendered;
  };

  /** Phase 31 (spec D12). The next free entry rank of a form, for a headword added
   *  to a form already written: the safety net
   *  dict_variants_form_entry_rank_key stays a safety net. */
  const nextEntryRank = async (input: { form: string; languageCode: string }): Promise<number> => {
    const rows = await tx.execute<{ next: number }>(sql`
      SELECT coalesce(max(entry_rank) + 1, 0)::int AS next FROM dict_variants
      WHERE language_code = ${input.languageCode} AND lower(form) = lower(${input.form})`);
    return rows.rows[0].next;
  };

  /** Phase 31 (plan item 3). Records a render request for each pair whose lemma
   *  form is unrendered and that was never requested, and returns those: the
   *  ones to enqueue. */
  const claimLemmaRenders = async (pairs: LexemeLanguage[]): Promise<LexemeLanguage[]> => {
    if (pairs.length === 0) return [];
    const rows = await tx.execute<{ lexeme_id: string; user_language_code: string }>(sql`
      INSERT INTO dict_lemma_renders (lexeme_id, user_language_code)
      SELECT DISTINCT asked.lexeme_id, asked.user_language_code
      FROM (VALUES ${sql.join(pairs.map((p) => sql`(${p.lexemeId}::text, ${p.userLanguageCode}::text)`), sql`, `)})
           AS asked(lexeme_id, user_language_code)
      WHERE NOT ${LEMMA_RENDERED(sql`asked.lexeme_id`, sql`asked.user_language_code`)}
      ON CONFLICT DO NOTHING
      RETURNING lexeme_id, user_language_code`);
    return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, userLanguageCode: row.user_language_code }));
  };

  /** The same for every saved gloss of every enrollment: the start-up backfill. */
  const claimSavedLemmaRenders = async (): Promise<LexemeLanguage[]> => {
    const rows = await tx.execute<{ lexeme_id: string; user_language_code: string }>(sql`
      INSERT INTO dict_lemma_renders (lexeme_id, user_language_code)
      SELECT DISTINCT ve.lexeme_id, e.source_language
      FROM vocabulary_entries ve
      JOIN enrollments e ON e.id = ve.enrollment_id
      WHERE NOT ${LEMMA_RENDERED(sql`ve.lexeme_id`, sql`e.source_language`)}
      ON CONFLICT DO NOTHING
      RETURNING lexeme_id, user_language_code`);
    return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, userLanguageCode: row.user_language_code }));
  };
```

(import `type SQL` from `drizzle-orm`), all five added to the returned object.

- [ ] **Step 6: Saves ask for it.** In `services/vocabulary.ts`, after `insertEntries` in `save` (import `RENDER_LEMMA`):

```ts
        // Phase 31 (spec D12). A word whose lemma form this language has not
        // rendered gets it rendered in the background, once (plan item 3).
        const claimed = await repos.dict.claimLemmaRenders(
          saveable.map((row) => ({ lexemeId: row.lexemeId, userLanguageCode: enrolled.source_language })),
        );
        for (const pair of claimed) {
          await repos.jobs.enqueue(RENDER_LEMMA, { lexeme_id: pair.lexemeId, user_language_code: pair.userLanguageCode });
        }
```

The same block goes after `insertEntries` in `services/photoImports.ts`' `save` (add `dict` and `jobs` to its transaction's destructuring). Unit tests that fake that save pass `dict: stub<DictRepo>({ claimLemmaRenders: async () => [] })` and `jobs: createFakeJobRepo()`. An integration test that saves a form whose lemma is unrendered now enqueues: give it a started boss (`startTestBoss`/`stopTestBoss`, as `tests/integration/jobs/photoImport.test.ts` does), or save the lemma form; list each test you changed in the task report.

- [ ] **Step 7: The job.** In `apps/server/src/services/translations.ts` (import `RENDER_LEMMA`'s payload schema `RenderLemmaPayloadSchema`, `MERGE_GLOSSES`, `kindForForm`), factor `reconcile`'s per-rendering push into a module-private helper both callers use:

```ts
/** One rendering of the second call as the entry it becomes: the model's fields,
 *  passed through for the write (renderingOf). */
function entrySense(rendering: LlmRendering & { translation: string }): LlmEntry['senses'][number] {
  return {
    sense_code: rendering.sense_code,
    translation: rendering.translation,
    ...(rendering.example ? { example: rendering.example } : {}),
    ...(rendering.alternatives ? { alternatives: rendering.alternatives } : {}),
    ...(rendering.gloss ? { gloss: rendering.gloss } : {}),
    ...(rendering.gloss_alternatives ? { gloss_alternatives: rendering.gloss_alternatives } : {}),
    ...(rendering.definition ? { definition: rendering.definition } : {}),
  };
}
```

(`reconcile` pushes `entrySense({ ...rendering, translation: rendering.translation })`), then add:

```ts
/**
 * Phase 31 (spec D12). The lemma form is already a hit, without this headword:
 * the scoped rendering call names this lexeme's senses for the form, and the
 * write adds the lexeme to the form at the next free entry rank, as a lookup
 * would have listed it. Reuses buildRenderingPrompt, which is eval-scored.
 */
async function addHeadwordToForm({
  llm,
  transaction,
  lexeme,
  to,
  kind,
}: {
  llm: LlmClient;
  transaction: Transaction;
  lexeme: { lemma: string; languageCode: string; partOfSpeech: string };
  to: LanguageCode;
  kind: TranslationKind;
}): Promise<void> {
  const from = lexeme.languageCode as LanguageCode;
  const partOfSpeech = lexeme.partOfSpeech as PartOfSpeech;
  const stored = await transaction((repos) =>
    repos.dict.findSensesByLexeme({ lemma: lexeme.lemma, partOfSpeech, languageCode: from, userLanguageCode: to }),
  );
  if (stored.length === 0) return;
  const raw = await llm(
    buildRenderingPrompt({ form: lexeme.lemma, from, to, lemma: lexeme.lemma, partOfSpeech, storedSenses: stored }),
  );
  const parsed = parseLlmReconciliation(raw);
  if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));
  const seen = new Set<string>();
  const senses: LlmEntry['senses'] = [];
  for (const rendering of parsed.senses) {
    if (rendering.translation === null || seen.has(rendering.sense_code)) continue;
    seen.add(rendering.sense_code);
    senses.push(entrySense({ ...rendering, translation: rendering.translation }));
  }
  if (senses.length === 0) return;
  await transaction(async (repos) => {
    const entryRankOffset = await repos.dict.nextEntryRank({ form: lexeme.lemma, languageCode: from });
    const { mergePairs } = await repos.dict.persistEntries({
      form: lexeme.lemma,
      languageCode: from,
      userLanguageCode: to,
      kind,
      entries: [{ lemma: lexeme.lemma, part_of_speech: partOfSpeech, senses }],
      entryRankOffset,
    });
    for (const pair of mergePairs) {
      await repos.jobs.enqueue(MERGE_GLOSSES, { lexeme_id: pair.lexemeId, user_language_code: pair.userLanguageCode });
    }
  });
}
```

and, in the object `createTranslationService` returns, beside `translate`:

```ts
    /**
     * Phase 31 (spec D12). The render-lemma job: renders a saved word's lemma form
     * for its lexeme in one learner language, so a session can ask the standard
     * form. A lemma form nobody has looked up runs the ordinary lookup, which
     * writes every headword of the form: a form with renderings is a hit, and a
     * hit only repairs the headwords already on it, so a lemma written for one
     * headword alone would stay partial for every learner (`spike` without its
     * noun). A form already a hit without this headword gets the scoped call.
     * No session waits on this; the saved form serves until it lands.
     */
    renderLemma: async (data: unknown): Promise<void> => {
      const { lexeme_id: lexemeId, user_language_code: language } = RenderLemmaPayloadSchema.parse(data);
      const to = language as LanguageCode;
      const skip = (reason: string) =>
        logger.info({ event: 'lemma_render_skipped', lexeme_id: lexemeId, user_language_code: to, reason });
      const state = await transaction(async (repos) => {
        const lexeme = await repos.dict.findLexeme(lexemeId);
        if (!lexeme) return null;
        if (await repos.dict.hasLemmaRendering({ lexemeId, userLanguageCode: to })) return { lexeme, rendered: true, rows: [] };
        const rows = await repos.dict.findSensesByForm({ form: lexeme.lemma, languageCode: lexeme.languageCode, userLanguageCode: to });
        return { lexeme, rendered: false, rows };
      });
      if (!state) return skip('lexeme_gone');
      if (state.rendered) return skip('already_rendered');
      const path = state.rows.length === 0 ? 'lookup' : 'scoped';
      try {
        if (path === 'lookup') {
          const response = await lookup({ text: state.lexeme.lemma, from: state.lexeme.languageCode as LanguageCode, to });
          if (response.correction) return skip('corrected');
          // A failed write still answers 200 (dict_persist_failed): retry it.
          if (response.senses.length > 0 && response.senses.every((card) => card.gloss_id === undefined)) {
            throw new Error('the lemma lookup answered without writing');
          }
        } else {
          await addHeadwordToForm({ llm, transaction, lexeme: state.lexeme, to, kind: kindForForm(state.rows) });
        }
      } catch (error) {
        logger.info({
          event: 'lemma_render_failed',
          lexeme_id: lexemeId,
          user_language_code: to,
          path,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const rendered = await transaction((repos) => repos.dict.hasLemmaRendering({ lexemeId, userLanguageCode: to }));
      if (!rendered) return skip('no_entry');
      logger.info({ event: 'lemma_rendered', lexeme_id: lexemeId, user_language_code: to, path });
    },
```

Add `renderLemma: unreachable` to the translations stub in `createFakeAppDeps`. Run Step 3's job test. Expected: PASS.

- [ ] **Step 8: The start-up backfill.** Create `apps/server/src/db/lemmaRenders.ts`:

```ts
import { RENDER_LEMMA } from '../domain/jobs';
import { createDictRepo } from '../repo/dictionary';
import { createJobRepo } from '../repo/jobs';
import type { Db } from './client';
import { withJobQueue } from './jobs';
import { createTransaction } from './transaction';

/**
 * Phase 31 (plan item 3; spec §2, "old glosses keyed from an inflected
 * rendering"). Asks for the render-lemma job for every saved gloss whose lexeme
 * has no lemma-form rendering in its enrollment's language and was never asked
 * for. The CLI's default path runs this after migrating and seeding, because that
 * is the only process that reaches production's database (ADR 0010); `npm run
 * dict:lemmas:render` runs it on demand. dict_lemma_renders records each request,
 * so a second run, or the next start, asks for nothing again.
 */
export async function requestLemmaRenders(db: Db): Promise<{ requested: number }> {
  return withJobQueue(db, async (boss) => {
    const inTransaction = createTransaction(db, (tx) => ({ dict: createDictRepo(tx), jobs: createJobRepo(tx, boss) }));
    return inTransaction(async ({ dict, jobs }) => {
      const claimed = await dict.claimSavedLemmaRenders();
      for (const pair of claimed) {
        await jobs.enqueue(RENDER_LEMMA, { lexeme_id: pair.lexemeId, user_language_code: pair.userLanguageCode });
      }
      return { requested: claimed.length };
    });
  });
}
```

In `apps/server/src/db/cli.ts` (import `requestLemmaRenders`): right after the `--recompute-progress` block,

```ts
    // Phase 31 (plan item 3). On demand, after migrating: `npm run dict:lemmas:render`.
    if (process.argv.includes('--render-lemmas')) {
      const { requested } = await requestLemmaRenders(db);
      console.log(`asked for ${requested} lemma renders in ${databaseUrl}`);
      return;
    }
```

and at the end of the default path, after the reseed or seed branch and its logs:

```ts
    // Phase 31 (plan item 3). The words saved before glosses existed get their
    // lemma form rendered once: production runs only this command (ADR 0010).
    const { requested } = await requestLemmaRenders(db);
    if (requested > 0) console.log(`asked for ${requested} lemma renders`);
```

Scripts: `apps/server/package.json` gains `"dict:lemmas:render": "tsx src/db/cli.ts --render-lemmas"`; the root `package.json` gains `"dict:lemmas:render": "bash scripts/lane-env.sh npm run dict:lemmas:render --workspace apps/server"`. Check that the production build includes the new module: `npm run build -w apps/server` and confirm `dist/cli.js` starts with `node dist/cli.js --render-lemmas` against the lane (`bash scripts/lane-env.sh node apps/server/dist/cli.js --render-lemmas`).

Run Step 3's backfill test. Expected: PASS.

- [ ] **Step 9: The lane, end to end.** `npm run db:migrate` on the lane. Expected: `migrated and seeded`, then `asked for N lemma renders` when the lane holds words saved from inflected forms. Start `npm run server` and watch for `lemma_rendered` and `lemma_render_skipped` lines; stop it afterwards.

- [ ] **Step 10: E2E lookup stubs answer only their own text.** A save of an inflected form now looks its lemma up in the background. Five existing specs save `прочитала` (`grep -ln "PROCHITALA" e2e/tests/*.spec.ts`), so each of those saves starts a lookup of `прочитать`. Today `lookUp` registers a stub that answers every model call. That stub would answer the job with whichever word the spec looked up last, and the job would write that word's entries under the form `прочитать`; a later session could then ask `прочитать` for בצל. In `e2e/tests/support/mockServer.ts`, add:

```ts
/**
 * Phase 31. The body regex for a model call whose user part is exactly `text`.
 * The provider sends that part as `"parts":[{"text":"…"}]`, and the system
 * prompt's quoted words are escaped inside the JSON, so they never match.
 */
export function userText(text: string): string {
  return `"text":"${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`;
}
```

In `e2e/tests/support/interactions.ts`, `lookUp` registers its payload with `expectGeminiMatching` in place of `expectGemini` (update the import):

```ts
export async function lookUp(page: Page, request: APIRequestContext, text: string, payload: unknown) {
  await clearGemini(request);
  // Phase 31. Matched on its own text: a save of an inflected form looks its
  // lemma up in the background, and a stub that answered every call would write
  // this word's entries under that lemma.
  await expectGeminiMatching(request, userText(text), payload);
  await page.getByTestId('translate-input').fill(text);
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-sense').first()).toBeVisible();
}
```

The job's lookup then finds no stub and writes nothing. `translate.spec.ts` registers one-shot stubs that still answer any call; they stay safe because no spec saves an inflected form within seconds of registering them. Run `npm run e2e`. Expected: PASS. A spec that relied on a lookup's stub answering a different call now fails on that call with a 502: register that call's own stub in the spec, and list each one in the task report.

- [ ] **Step 11: Check and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch`. Expected: PASS, ADR 0007's and ADR 0010's checks included.

```bash
git add apps/server package.json e2e
git commit -m "feat(server): render-lemma — a saved word's lemma form is rendered once, and the CLI asks for it after migrating"
```

---

## Part D — Sessions, the meaning card, the photo import, and the tools

### Task 11: Sessions practise a gloss — every agreeing rendering in turn, one pick per key, siblings accepted (D12, D18)

**Files:**
- Modify: `apps/server/src/domain/session.ts` (`SavedGloss`, `GlossRendering`, `pickGlosses`, `askableRenderings`, `pickRendering`), `session.test.ts`
- Modify: `apps/server/src/domain/distractors.ts` (`withSiblingAlternatives`), `distractors.test.ts`
- Modify: `apps/server/src/repo/vocabulary.ts` (`listSavedGlosses` carries the key), `apps/server/src/repo/dictionary.ts` (`findGlossRenderings`, `findSiblings`)
- Modify: `apps/server/src/services/sessions.ts` (`createNextSession`, `prepareSession`), `sessions.prepare.test.ts`, `sessions.test.ts`
- Create: `apps/server/tests/integration/repo/dictionary.sessions.test.ts`, `apps/server/tests/integration/services/sessions.glosses.test.ts`
- Modify: `apps/server/tests/support/jobs.ts` (`jobPayloads`)

**Interfaces:**
- Produces, in `domain/session.ts`:
  - `type SavedGloss = { glossId: string; key: string; variantId: string }`
  - `type GlossRendering = { glossId: string; senseId: string; variantId: string; form: string; gloss: string; rank: number }`
  - `pickGlosses(saved: readonly SavedGloss[], max: number, rng: () => number): SavedGloss[]`
  - `askableRenderings(gloss: SavedGloss, renderings: readonly GlossRendering[]): GlossRendering[]`
  - `pickRendering(options: readonly GlossRendering[], rng: () => number): GlossRendering | undefined`
- Produces: `withSiblingAlternatives(input: { form: string; lemma: string; siblings: readonly string[]; alternatives: readonly string[] }): string[]` in `domain/distractors.ts`.
- Produces: `VocabularyRepo.listSavedGlosses(enrollmentId): Promise<SavedGloss[]>`; `DictRepo.findGlossRenderings(input: { glossIds: string[]; userLanguageCode: string }): Promise<GlossRendering[]>`; `DictRepo.findSiblings(input: { glossIds: string[] }): Promise<{ glossId: string; lemma: string }[]>`.
- Produces, in `tests/support/jobs.ts`: `jobPayloads(db: Db, name: string): Promise<unknown[]>`.

- [ ] **Step 1: Write the failing unit tests.** Append to `apps/server/src/domain/session.test.ts` (import the new names and `testRng` from `../../tests/support/testRng`):

```ts
const saved = (glossId: string, key: string, variantId = `v-${glossId}`): SavedGloss => ({ glossId, key, variantId });
const rendering = (glossId: string, variantId: string, gloss: string, senseId = 's1', form = variantId): GlossRendering => ({
  glossId, senseId, variantId, form, gloss, rank: 0,
});

describe('pickGlosses (spec D18)', () => {
  it('never picks two glosses with one key, and picks either of them', () => {
    const list = [saved('g_book', 'להזמין'), saved('g_order', 'לְהַזְמִין'), saved('g_cat', 'חתול'), saved('g_dog', 'כלב')];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const picked = pickGlosses(list, 10, testRng(seed)).map((gloss) => gloss.glossId);
      expect(picked.filter((id) => id === 'g_book' || id === 'g_order')).toHaveLength(1);
      expect(picked).toHaveLength(3);
      picked.forEach((id) => seen.add(id));
    }
    expect(seen).toEqual(new Set(['g_book', 'g_order', 'g_cat', 'g_dog']));
  });
});

describe('askableRenderings (spec D12)', () => {
  const gloss = saved('g1', 'אצבע', 'v_fingers');

  it('keeps every rendering whose own citation form is the key, the lemma form among them', () => {
    const options = askableRenderings(gloss, [rendering('g1', 'v_fingers', 'אצבע'), rendering('g1', 'v_finger', 'אצבע'), rendering('g2', 'v_toe', 'בוהן')]);
    expect(options.map((option) => option.variantId)).toEqual(['v_finger', 'v_fingers']);
  });

  it('drops a drifted rendering, but never the saved form', () => {
    const options = askableRenderings(gloss, [rendering('g1', 'v_fingers', 'אצבעות'), rendering('g1', 'v_digit', 'ספרה')]);
    expect(options.map((option) => option.variantId)).toEqual(['v_fingers']);
  });

  it('takes one of them uniformly under the injected rng', () => {
    const options = askableRenderings(gloss, [rendering('g1', 'v_fingers', 'אצבע'), rendering('g1', 'v_finger', 'אצבע')]);
    expect(pickRendering(options, () => 0)?.variantId).toBe('v_finger');
    expect(pickRendering(options, () => 0.99)?.variantId).toBe('v_fingers');
    expect(pickRendering([], () => 0)).toBeUndefined();
  });
});
```

Append to `apps/server/src/domain/distractors.test.ts`:

```ts
describe('withSiblingAlternatives (spec D18)', () => {
  it('accepts the sibling headwords first, never the card’s own word, at most five', () => {
    expect(
      withSiblingAlternatives({
        form: 'booked',
        lemma: 'book',
        siblings: ['order', 'reserve', 'book'],
        alternatives: ['reserved', 'Order', 'arranged', 'scheduled', 'set up'],
      }),
    ).toEqual(['order', 'reserve', 'reserved', 'arranged', 'scheduled']);
  });
});
```

The validator needs no new case. `distractors.test.ts` already has "refuses, on a word item, the word of another row with the same meaning", and Step 6 passes each sibling with the card's own translation, which is exactly the row that case refuses.

- [ ] **Step 2: Run them and see them fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/session.test.ts src/domain/distractors.test.ts`. Expected: FAIL, `pickGlosses is not a function`.

- [ ] **Step 3: The pure rules.** Append to `apps/server/src/domain/session.ts` (import `normaliseGloss` from `@lang-tutor/core/domain`):

```ts
/** Phase 31. A saved gloss as a session picks it: its key, and the form it was saved from. */
export type SavedGloss = { glossId: string; key: string; variantId: string };

/** Phase 31 (spec D12). One rendering of one member of a gloss, by one form, with
 *  the citation form the model gave it. */
export type GlossRendering = { glossId: string; senseId: string; variantId: string; form: string; gloss: string; rank: number };

/**
 * Spec D18. Up to `max` saved glosses, uniformly at random, at most one per
 * normalised key: `book` and `order` both saved under להזמין give one card, so a
 * session never asks one target word twice. Which of them is uniform too.
 */
export function pickGlosses(saved: readonly SavedGloss[], max: number, rng: () => number): SavedGloss[] {
  const keys = new Set<string>();
  const picked: SavedGloss[] = [];
  for (const gloss of pickSenses(saved, saved.length, rng)) {
    const key = normaliseGloss(gloss.key);
    if (keys.has(key)) continue;
    keys.add(key);
    picked.push(gloss);
    if (picked.length === max) break;
  }
  return picked;
}

/**
 * Spec D12. The renderings a session may ask for a gloss: every form of every
 * member whose own citation form is the gloss's key, and the saved form always,
 * so a learner is never asked a word that was never on their card (a drifted or
 * misspelt citation form) and always may be asked the one they saved. Ordered by
 * variant and sense, so a seeded rng picks reproducibly.
 */
export function askableRenderings(gloss: SavedGloss, renderings: readonly GlossRendering[]): GlossRendering[] {
  const key = normaliseGloss(gloss.key);
  return renderings
    .filter(
      (rendering) =>
        rendering.glossId === gloss.glossId && (normaliseGloss(rendering.gloss) === key || rendering.variantId === gloss.variantId),
    )
    .sort((a, b) => a.variantId.localeCompare(b.variantId) || a.senseId.localeCompare(b.senseId));
}

/** One of `options`, uniformly under the injected rng; undefined when there is none. */
export function pickRendering(options: readonly GlossRendering[], rng: () => number): GlossRendering | undefined {
  return options[Math.floor(rng() * options.length)];
}
```

Append to `apps/server/src/domain/distractors.ts`:

```ts
/**
 * Phase 31 (spec D18). A typed or spoken card's right answers: the sibling
 * headwords first, which are certain (`order` is right where להזמין asks for
 * `book`), then the model's, never the card's own form or lemma, at most
 * MAX_ALTERNATIVES, the column check's five.
 */
export function withSiblingAlternatives(input: {
  form: string;
  lemma: string;
  siblings: readonly string[];
  alternatives: readonly string[];
}): string[] {
  return keepAlternatives(input.form, input.lemma, [...input.siblings, ...input.alternatives]);
}
```

It shares its loop with `cleanAlternatives`, so the two cannot drift apart. Add above both, and make `cleanAlternatives` (keeping its comment) call it with its own extra refusal:

```ts
/** Alternatives for a typed card: trimmed, never empty, never the card's own
 *  form or lemma, no two alike under `comparable`, at most MAX_ALTERNATIVES, in
 *  the order given. `accept` adds a caller's own refusal. */
function keepAlternatives(
  form: string,
  lemma: string,
  candidates: readonly string[],
  accept: (text: string) => boolean = () => true,
): string[] {
  const seen = new Set([form, lemma].map(comparable));
  const kept: string[] = [];
  for (const raw of candidates) {
    const text = raw.trim();
    const key = comparable(text);
    if (text === '' || !accept(text) || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === MAX_ALTERNATIVES) break;
  }
  return kept;
}

function cleanAlternatives(item: DistractorItem, found: string[] | undefined, explanationLetters: RegExp): string[] {
  return keepAlternatives(item.form, item.lemma, found ?? [], (text) => !explanationLetters.test(text));
}
```

Run Step 2's command. Expected: PASS.

- [ ] **Step 4: The reads.** In `apps/server/src/repo/vocabulary.ts`, `listSavedGlosses` becomes:

```ts
    /** Every saved gloss of one enrollment with its key and the form it was saved
     *  from, for picking a list session (spec D12, D18). Ordered so a seeded rng
     *  picks reproducibly. */
    listSavedGlosses: async (enrollmentId: string): Promise<SavedGloss[]> => {
      const rows = await tx.execute<{ gloss_id: string; key: string; variant_id: string }>(sql`
        SELECT ve.gloss_id, g.key, ve.variant_id
        FROM vocabulary_entries ve
        JOIN dict_glosses g ON g.id = ve.gloss_id
        WHERE ve.enrollment_id = ${enrollmentId}
        ORDER BY ve.gloss_id`);
      return rows.rows.map((row) => ({ glossId: row.gloss_id, key: row.key, variantId: row.variant_id }));
    },
```

In `apps/server/src/repo/dictionary.ts` (import the two types from `../domain/session`):

```ts
  /** Phase 31 (spec D12). Every rendering of every member of these glosses in one
   *  learner language, with its form and its own citation form. */
  const findGlossRenderings = async (input: { glossIds: string[]; userLanguageCode: string }): Promise<GlossRendering[]> => {
    if (input.glossIds.length === 0) return [];
    const rows = await tx.execute<{ gloss_id: string; sense_id: string; variant_id: string; form: string; gloss: string; rank: number }>(sql`
      SELECT m.gloss_id, tr.sense_id, tr.variant_id, v.form, tr.gloss, tr.rank
      FROM dict_sense_glosses m
      JOIN dict_var_translations tr ON tr.sense_id = m.sense_id AND tr.user_language_code = m.user_language_code
      JOIN dict_variants v          ON v.id = tr.variant_id
      WHERE m.gloss_id IN (${sql.join(input.glossIds.map((id) => sql`${id}`), sql`, `)})
        AND m.user_language_code = ${input.userLanguageCode}`);
    return rows.rows.map((row) => ({
      glossId: row.gloss_id,
      senseId: row.sense_id,
      variantId: row.variant_id,
      form: row.form,
      gloss: row.gloss,
      rank: row.rank,
    }));
  };

  /** Phase 31 (spec D18). For each of these glosses, the lemmas of the other
   *  headwords of its language pair whose live gloss has the same key: `order`
   *  beside `book` under להזמין. Through dict_glosses_language_key_idx. */
  const findSiblings = async (input: { glossIds: string[] }): Promise<{ glossId: string; lemma: string }[]> => {
    if (input.glossIds.length === 0) return [];
    const rows = await tx.execute<{ gloss_id: string; lemma: string }>(sql`
      SELECT DISTINCT p.id AS gloss_id, l2.lemma
      FROM dict_glosses p
      JOIN dict_lexemes l1 ON l1.id = p.lexeme_id
      JOIN dict_glosses s  ON s.user_language_code = p.user_language_code
                          AND gloss_key(s.key) = gloss_key(p.key)
                          AND s.lexeme_id <> p.lexeme_id
                          AND s.merged_into IS NULL
      JOIN dict_lexemes l2 ON l2.id = s.lexeme_id AND l2.language_code = l1.language_code
      WHERE p.id IN (${sql.join(input.glossIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY 1, 2`);
    return rows.rows.map((row) => ({ glossId: row.gloss_id, lemma: row.lemma }));
  };
```

both added to the returned object. Create `apps/server/tests/integration/repo/dictionary.sessions.test.ts` with two cases built on `insertLexeme`: `findGlossRenderings` returns both of a gloss's forms with their own citation forms and nothing of another gloss; `findSiblings` returns `order` for `book`'s gloss when both verbs render להזמין, and nothing for a gloss whose key no other headword shares.

- [ ] **Step 5: Picking at session creation (D12, D18).** In `apps/server/src/services/sessions.ts`, `createNextSession` (add `dict` to its transaction's destructuring, import the three domain functions, and drop `pickSenses` from the import, since `pickGlosses` now calls it):

```ts
        const saved = await vocabulary.listSavedGlosses(enrollmentId);
        if (saved.length === 0) throw new NoSavedWords(enrollmentId);
        // Phase 31 (spec D18). At most one gloss per key, across headwords.
        const picked = pickGlosses(saved, SESSION_LENGTH, rng);
        // Spec D12. One rendering per gloss, uniformly over every form of every
        // member that agrees with the gloss, the saved form always among them.
        // No model call: a lemma form not yet rendered joins once its job lands.
        const renderings = await dict.findGlossRenderings({
          glossIds: picked.map((gloss) => gloss.glossId),
          userLanguageCode: enrolled.source_language,
        });
        const picks = picked.flatMap((gloss) => {
          const rendering = pickRendering(askableRenderings(gloss, renderings), rng);
          return rendering ? [{ gloss_id: gloss.glossId, sense_id: rendering.senseId, variant_id: rendering.variantId }] : [];
        });
        if (picks.length === 0) throw new NoSavedWords(enrollmentId);
```

and the job's payload takes `picks` as built. `services/sessions.test.ts` fakes this use case too: its `listSavedGlosses` stubs return `SavedGloss` rows (`{ glossId, key, variantId }`), and its fake transaction gains `dict: stub<DictRepo>({ findGlossRenderings: async () => [...] })`, returning for each saved row one `GlossRendering` on its saved variant whose `gloss` is its `key`. Add to `tests/support/jobs.ts`:

```ts
/** Phase 31. The payloads of every job of one queue, oldest first. */
export async function jobPayloads(db: Db, name: string): Promise<unknown[]> {
  const rows = await db.execute<{ data: unknown }>(
    sql`select data from ${sql.raw(JOB_SCHEMA)}.job where name = ${name} order by created_on`,
  );
  return rows.rows.map((row) => row.data);
}
```

- [ ] **Step 6: Siblings in preparation (D18).** In `prepareSession`'s read transaction (add `dict`), after the context: `const siblings = await dict.findSiblings({ glossIds: context.map((row) => row.glossId) });`, returned with the rest. After the plan:

```ts
      // Phase 31 (spec D18). Another headword with this card's key is right where
      // the card asks for this one: off limits as a wrong option, and named to the
      // model with the session's other rows, so it never offers one the
      // validator would refuse on every retry.
      const siblingsOf = (glossId: string) =>
        read.siblings.filter((sibling) => sibling.glossId === glossId).map((sibling) => sibling.lemma);
      const siblingRows = ordered.flatMap((row) => siblingsOf(row.glossId).map((lemma) => ({ form: lemma, translation: row.translation })));
      const others = [...ordered.filter((_, index) => !tasks[index]), ...siblingRows];
```

replacing the existing `others`. In the write's mapping, after `const content = degraded ? NOTHING_GENERATED : made;`:

```ts
            // Spec D18. A sibling headword is a right answer to a typed or spoken card.
            const answered =
              type === 'typed_translation' || type === 'say_translation'
                ? {
                    ...content,
                    alternatives: withSiblingAlternatives({
                      form: row.form,
                      lemma: row.lemma,
                      siblings: siblingsOf(row.glossId),
                      alternatives: content.alternatives,
                    }),
                  }
                : content;
```

and the `generatedContent` call below it takes `answered` as its third argument in place of `content`. Its fourth argument is unchanged.

- [ ] **Step 7: The preparation unit test.** In `apps/server/src/services/sessions.prepare.test.ts`, `world()` takes `siblings?: { glossId: string; lemma: string }[]`, passes `dict: stub<DictRepo>({ findSiblings: async () => opts.siblings ?? [] })` and Task 9's `gloss: createFakeGlossRepo()` to `createFakeTransaction`, and every `CONTEXT` row has a `glossId`. Add:

```ts
  it('accepts a sibling headword on the typed card and names it to the model (spec D18)', async () => {
    const context: GenerationContext[] = [
      ...CONTEXT,
      { glossId: 'g_book', senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'book', lemma: 'book', partOfSpeech: 'verb', translation: 'להזמין', example: null, exampleTranslation: null },
    ];
    const reply = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] },
        { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
        { key: 'q3', distractors: [], alternatives: ['reserve'] },
      ],
    });
    const { service, calls, llm } = world({ context, reply, siblings: [{ glossId: 'g_book', lemma: 'order' }] });
    await service.prepareSession({ ...PAYLOAD, picks: [...PAYLOAD.picks, { gloss_id: 'g_book', sense_id: 's3', variant_id: 'v3' }] });

    const inserted = (calls.generated[0] as { questions: { type: string; alternatives: string[] | null }[] }).questions;
    expect(inserted[2]).toMatchObject({ type: 'typed_translation', alternatives: ['order', 'reserve'] });
    expect(JSON.parse(llm.calls[0].user).also_in_session).toContainEqual({ word: 'order', correct: 'להזמין' });
  });
```

(Adjust `PAYLOAD.picks` at the top of the file to carry `gloss_id` as well, if Task 6 left it without.)

- [ ] **Step 8: The integration test.** Create `apps/server/tests/integration/services/sessions.glosses.test.ts` (it may not import `src/repo` or Drizzle):

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION } from '../../../src/domain/jobs';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let boss: PgBoss;
beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u1');
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

const deps = (seed: number) => createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(seed), boss });

async function savedVerb(lemma: string, translation: string) {
  const word = await insertLexeme(t.db, {
    lemma, languageCode: 'en', partOfSpeech: 'verb', userLanguageCode: 'he', senses: [{ senseCode: 'reserve' }],
    variants: [{ form: lemma, kind: 'word', entryRank: 0, translations: [{ senseCode: 'reserve', rank: 0, translation, exampleSource: null, exampleTarget: null }] }],
  });
  await deps(1).vocabulary.save('u1', enrollmentOf('u1'), [{ gloss_id: word.glossIds[0], variant_id: word.variantIds[0] }]);
  return word.glossIds[0];
}

describe('a list session over glosses (spec D12, D18)', () => {
  it('never picks two saved headwords that share a target word', async () => {
    const book = await savedVerb('book', 'להזמין');
    const order = await savedVerb('order', 'להזמין');
    await savedVerb('cook', 'לבשל');
    for (const seed of [1, 2, 3, 4, 5]) {
      const session = deps(seed).sessions;
      const created = await session.createNextSession(enrollmentOf('u1'), { listening: false, speaking: false });
      await session.skipSession(created.sessionId);
    }
    const payloads = (await jobPayloads(t.db, PREPARE_SESSION)) as { picks: { gloss_id: string }[] }[];
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      const ids = payload.picks.map((pick) => pick.gloss_id);
      expect(ids.filter((id) => id === book || id === order)).toHaveLength(1);
      expect(ids).toHaveLength(2);
    }
  });
});
```

The first `createNextSession` of an enrollment is the seed and enqueues nothing, which is why the loop runs five and the assertion reads only the list sessions' payloads.

- [ ] **Step 9: Run and commit.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/session.test.ts src/domain/distractors.test.ts src/services/sessions.prepare.test.ts` and `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/repo/dictionary.sessions.test.ts tests/integration/services/sessions.glosses.test.ts`. Expected: PASS. Then `npm run typecheck && npm test && npm run test:integration && npm run lint:arch && npm run e2e`. Expected: PASS.

```bash
git add apps/server
git commit -m "feat(server): sessions practise a gloss — every agreeing rendering in turn, one pick per key, siblings accepted"
```

---

### Task 12: The meaning card accepts a gloss's other words (D13)

**Files:**
- Modify: `apps/server/src/domain/judge.ts` (`MeaningJudgeContext.alternatives`, `meaningRuleVerdict`, `ruleVerdict`), `judge.test.ts`
- Modify: `apps/server/src/repo/questions.ts` (`findJudgeContext`), `apps/server/src/services/sessions.ts` (`answerJudged`)
- Modify: `apps/server/tests/integration/repo/questions.test.ts`

**Interfaces:**
- Produces: `MeaningJudgeContext.alternatives?: readonly string[]` (the rendering's and the gloss's); `meaningRuleVerdict(meaning: string, text: string, alternatives?: readonly string[]): TypedVerdict | null`; `ruleVerdict(question, text, alternatives?)`.
- Produces: `findJudgeContext` returns `alternatives: string[]`.

- [ ] **Step 1: Write the failing test.** Append to `apps/server/src/domain/judge.test.ts`:

```ts
describe('meaningRuleVerdict over the stored alternatives (spec D13)', () => {
  it("takes the gloss's or the rendering's other words as the meaning, and still asks the judge about any other", () => {
    expect(meaningRuleVerdict('מכונית', 'רכב', ['רכב', 'אוטו'])).toBe('exact');
    expect(meaningRuleVerdict('מכונית', 'רֶכֶב', ['רכב'])).toBe('exact');
    expect(meaningRuleVerdict('מכונית', 'משאית', ['רכב'])).toBeNull();
    expect(meaningRuleVerdict('מכונית', 'מכונית', [])).toBe('exact');
  });
});
```

- [ ] **Step 2: Run it and see it fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/judge.test.ts`. Expected: FAIL: `'רכב'` comes back `null`.

- [ ] **Step 3: The rule.** In `apps/server/src/domain/judge.ts`, `MeaningJudgeContext` gains:

```ts
  /** Phase 31 (spec D13). The gloss's other words and the rendering's: right as
   *  typed, so רכב for מכונית costs no judge call. */
  alternatives?: readonly string[];
```

and:

```ts
/** Spec D3 step 2. Empty text is "show me the answer"; the stored meaning, or
 *  (phase 31, D13) one of its stored alternatives, is right as typed. Null: only
 *  the model can tell. */
export function meaningRuleVerdict(meaning: string, text: string, alternatives: readonly string[] = []): TypedVerdict | null {
  const typed = normaliseHebrew(text);
  if (typed === '') return 'wrong';
  if (typed === normaliseHebrew(meaning)) return 'exact';
  return alternatives.some((alternative) => normaliseHebrew(alternative) === typed) ? 'exact' : null;
}
```

`ruleVerdict(question, text, alternatives: readonly string[] = [])` passes `alternatives` to `meaningRuleVerdict` for `typed_meaning`. In `services/sessions.ts`, `answerJudged` calls `ruleVerdict(checked.current, text, checked.context.alternatives)`. The app's banner needs no change: for a judged card it words the server's verdict, and shows "correct, the saved meaning is …" when the typed text differs from the stored meaning, as it already does for a synonym the judge accepted.

- [ ] **Step 4: The context carries the words.** In `apps/server/src/repo/questions.ts`, `findJudgeContext` joins the gloss and reads both lists (its lateral, from Task 6, adds `tr.alternatives`):

```sql
        SELECT v.form, l.lemma, l.part_of_speech, q.prompt, tr.example_source, tr.example_target,
               coalesce(tr.alternatives, '{}'::text[]) AS rendering_alternatives,
               g.alternatives AS gloss_alternatives
        FROM questions q
        JOIN dict_glosses g   ON g.id = q.gloss_id
        JOIN dict_variants v  ON v.id = q.prompt_variant_id
        JOIN dict_lexemes l   ON l.id = v.lexeme_id
        LEFT JOIN LATERAL (
          SELECT tr.example_source, tr.example_target, tr.alternatives
          FROM dict_sense_glosses m
          JOIN dict_var_translations tr ON tr.sense_id = m.sense_id
                                       AND tr.user_language_code = m.user_language_code
                                       AND tr.variant_id = q.prompt_variant_id
          WHERE m.gloss_id = q.gloss_id AND m.user_language_code = q.user_language_code
          ORDER BY tr.rank
          LIMIT 1
        ) tr ON true
        WHERE q.id = ${questionId}
```

and returns `alternatives: [...row.rendering_alternatives, ...row.gloss_alternatives]`. Add a case to `tests/integration/repo/questions.test.ts`: a `typed_meaning` question on a gloss with alternatives `['רכב']` whose prompt form's rendering has `['רכבים']` gets both from `findJudgeContext`.

- [ ] **Step 5: Run and commit.** Step 2's command and `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/repo/questions.test.ts`. Expected: PASS. Then `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.

```bash
git add apps/server
git commit -m "feat(server): the meaning card takes a gloss's other words as right, without asking the judge"
```

---

### Task 13: The photo import finds a gloss by its key and its other words

**Files:**
- Modify: `apps/server/src/domain/senseMatching.ts` (`MatchOption`, `glossesOf`, `firstChoice`, `buildSenseMatchPrompt`), `senseMatching.test.ts`

**Interfaces:**
- Produces: `MatchOption = { translation: string; alternatives?: readonly string[]; part_of_speech?: string }`. `PhotoImportOption` already satisfies it (Task 7 put `alternatives` on it).

- [ ] **Step 1: Write the failing tests.** Append to `apps/server/src/domain/senseMatching.test.ts`:

```ts
describe('matching a printed word to a gloss card (phase 31)', () => {
  it("finds the card by one of its other words, with no model call", () => {
    expect(firstChoice('רכב', [{ translation: 'שולחן' }, { translation: 'מכונית', alternatives: ['רכב', 'אוטו'] }])).toEqual({
      index: 1,
      mismatch: false,
      matchedBy: 'exact',
    });
  });

  it('folds points, a maqaf and a note in brackets the way glosses do', () => {
    expect(firstChoice('בֵּית־סֵפֶר (מוסד)', [{ translation: 'בית ספר' }])).toMatchObject({ index: 0, matchedBy: 'exact' });
  });
});
```

- [ ] **Step 2: Run them and see them fail.** `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/senseMatching.test.ts`. Expected: FAIL, `ask_model` for both.

- [ ] **Step 3: Match on the gloss's words.** In `apps/server/src/domain/senseMatching.ts` (import `normaliseGloss` from `@lang-tutor/core/domain`, drop the `comparable` import if nothing else uses it):

```ts
export type MatchOption = { translation: string; alternatives?: readonly string[]; part_of_speech?: string };

/** A printed translation's words: `בנק, גדה / שפה` is three. Notes in brackets go
 *  first, as splitTranslation drops them, so a comma inside one never splits;
 *  each word is folded with normaliseGloss, the rule that makes two target words
 *  one gloss. */
export function glossesOf(hebrew: string): string[] {
  return hebrew
    .replace(/\([^)]*\)/gu, '')
    .split(/[,/;]/u)
    .map(normaliseGloss)
    .filter((gloss) => gloss.length > 0);
}

export function firstChoice(hebrew: string | null, options: readonly MatchOption[]): SenseChoice | 'ask_model' {
  if (hebrew === null) return { index: 0, mismatch: false, matchedBy: 'no_hebrew' };
  const printed = new Set(glossesOf(hebrew));
  // Phase 31: a card's other words name it too, so a printed רכב finds מכונית.
  const index = options.findIndex((option) =>
    [option.translation, ...(option.alternatives ?? [])].some((word) => printed.has(normaliseGloss(word))),
  );
  return index === -1 ? 'ask_model' : { index, mismatch: false, matchedBy: 'exact' };
}
```

In `buildSenseMatchPrompt`, each numbered sense lists its other words when it has any: `...(option.alternatives?.length ? { also: option.alternatives } : {})`. The marker `which numbered sense` is unchanged.

- [ ] **Step 4: Run and commit.** Step 2's command. Expected: PASS. Then `npm run typecheck && npm test && npm run lint:arch`, and the photo import integration suites: `bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/jobs/photoImport.test.ts tests/integration/routes/photoImports.test.ts`. Expected: PASS.

```bash
git add apps/server/src/domain
git commit -m "feat(server): the photo import matches a printed word to a gloss by its key and its other words"
```

---

### Task 14: The tools — export and restore the new fields, and `dict:glosses:merge` in two tiers

**Files:**
- Modify: `apps/server/src/db/dictExport.ts`, `apps/server/src/db/dictImport.ts`, `tests/integration/db/dictRoundTrip.test.ts`
- Create: `apps/server/src/domain/glossMerge.ts`, `glossMerge.test.ts` (the model tier's prompt and parse)
- Modify: `apps/server/src/services/glosses.ts` (`planMerges`, `applyMerges`), `apps/server/src/composition.ts` (`createGlossTools`)
- Modify: `apps/server/src/db/cli.ts` (`--merge-glosses`), `apps/server/package.json`, `package.json`
- Create: `apps/server/tests/integration/services/glosses.tools.test.ts`
- Modify: `packages/core/src/api/schemas.ts` (`LlmGlossMergeSchema`)
- Modify: `docs/adr/adr-0001-layered-architecture.md`, `scripts/check-adr-0001-layered-architecture.sh` (R4 lets `db/cli.ts` import the composition root)
- Modify: `apps/server/tests/support/fakes.ts` (`createFakeAppDeps`' `glosses`, `createFakeGlossRepo`)

**Interfaces:**
- Consumes: `insertDriftedFinger` and `insertRendering` from `tests/support/dictRows.ts` (Task 9).
- Produces: an exported sense carries `alternatives`, `gloss`, `gloss_alternatives` and `definition`, and a restore writes them through `persistEntries`.
- Produces, in `domain/glossMerge.ts`: `GLOSS_MERGE_MARKER = 'forms of one word'`; `buildGlossMergePrompt(input: { lemma: string; partOfSpeech: string; from: LanguageCode; to: LanguageCode; glosses: { key: string; alternatives: string[] }[]; senses: { senseCode: string; gloss: string; definition: string | null }[] }): GlossMergePrompt`; `parseGlossMerge(raw: string): { groups: string[][]; definitions: { senseCode: string; definition: string }[] } | null`; `mutualPairs(glosses: { id: string; key: string; alternatives: string[] }[]): [string, string][]`.
- Produces, in `services/glosses.ts`: `planMerges(input: { model: boolean }): Promise<MergePlan>`; `applyMerges(plan: MergePlan): Promise<{ merged: number; definitions: number }>`, where `MergePlan = { merges: { lexemeId: string; userLanguageCode: string; lemma: string; survivorId: string; survivorKey: string; otherId: string; otherKey: string; tier: 1 | 2 }[]; definitions: { senseId: string; definition: string }[]; suggestions: { lemma: string; keys: [string, string] }[] }`.
- Produces, in `composition.ts`: `createGlossTools(io: { db: Db; logger: Logger; fetch: typeof globalThis.fetch; gemini: GeminiConfig; timeoutMs: number }): GlossService`.
- Produces: `npm run dict:glosses:merge`, which takes `--model` and `--yes` after npm's bare `--`: `npm run dict:glosses:merge -- --model --yes`.

- [ ] **Step 1: Export and restore the fields.** In `apps/server/src/db/dictExport.ts`, the read selects `dictVarTranslations.alternatives`, `dictVarTranslations.gloss`, `dictSenses.definition`, and the sense's gloss alternatives through its membership in the export's learner language (join `dictSenseGlosses` on sense and language, then `dictGlosses`). Each exported `LlmSense` gains, only when present: `alternatives` (non-empty), `gloss` (when it differs from the translation), `gloss_alternatives` (non-empty) and `definition` (non-null). `dictImport.ts` needs no change beyond types: it replays through `persistEntries`, which reads them (Task 4). Add a case to `tests/integration/db/dictRoundTrip.test.ts`: a form whose sense has a definition, an alternative and a citation form different from its translation exports them, and a restore into an empty database stores the same definition, the same alternatives and the same gloss key.

- [ ] **Step 2: Write the failing model-tier tests.** Create `apps/server/src/domain/glossMerge.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { buildGlossMergePrompt, GLOSS_MERGE_MARKER, mutualPairs, parseGlossMerge } from './glossMerge';

describe('the model tier of dict:glosses:merge (spec D7)', () => {
  const prompt = buildGlossMergePrompt({
    lemma: 'finger',
    partOfSpeech: 'noun',
    from: 'en',
    to: 'he',
    glosses: [{ key: 'אצבע', alternatives: [] }, { key: 'אצבעות', alternatives: [] }],
    senses: [{ senseCode: 'body_part', gloss: 'אצבעות', definition: null }],
  });

  it('asks which target words are forms of one word, and for missing definitions', () => {
    expect(prompt.system).toContain(GLOSS_MERGE_MARKER);
    expect(JSON.parse(prompt.user)).toEqual({
      headword: 'finger',
      part_of_speech: 'noun',
      words: ['אצבע', 'אצבעות'],
      senses_without_definition: [{ sense_code: 'body_part', gloss: 'אצבעות' }],
    });
  });

  it('reads groups with the citation form first, and definitions', () => {
    expect(parseGlossMerge('{"groups":[["אצבע","אצבעות"]],"definitions":[{"sense_code":"body_part","definition":"one of the five parts at the end of the hand"}]}')).toEqual({
      groups: [['אצבע', 'אצבעות']],
      definitions: [{ senseCode: 'body_part', definition: 'one of the five parts at the end of the hand' }],
    });
    expect(parseGlossMerge('not json')).toBeNull();
  });

  it('lists two glosses that name each other among their alternatives, which it never merges', () => {
    expect(
      mutualPairs([
        { id: 'g1', key: 'מדהים', alternatives: ['נהדר'] },
        { id: 'g2', key: 'נהדר', alternatives: ['מדהים'] },
        { id: 'g3', key: 'מצוין', alternatives: ['נהדר'] },
      ]),
    ).toEqual([['g1', 'g2']]);
  });
});
```

Run `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/glossMerge.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: The model tier, pure.** In `packages/core/src/api/schemas.ts`, beside the other LLM schemas:

```ts
// Phase 31 (spec D7). The by-hand merge tool's answer: groups of target words
// that are forms of one word, the citation form first, and definitions for the
// senses that had none. Lists only, no caps: the tool reads them, and nothing it
// reads reaches a learner without an operator's --yes.
export const LlmGlossMergeSchema = z.object({
  groups: z.array(z.array(z.string().min(1))),
  definitions: z.array(z.object({ sense_code: z.string().min(1), definition: z.string().min(1) })),
});
```

(with its `z.infer` type in `types.ts` and `index.ts`). Create `apps/server/src/domain/glossMerge.ts`:

```ts
import { LlmGlossMergeSchema } from '@lang-tutor/core/api/schemas';
import { normaliseGloss } from '@lang-tutor/core/domain';

import { LANGUAGES, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 31 (spec D7). The model-judged tier of `dict:glosses:merge`: which of a
 * headword's target words are forms of one word (gender, number, spelling), so
 * their glosses can be merged, and definitions for senses written without one.
 * Run by hand only: a merge cannot be undone, so the tool prints its plan first.
 */
export const GLOSS_MERGE_MARKER = 'forms of one word';

export type GlossMergePrompt = { system: string; user: string; schema: typeof LlmGlossMergeSchema };

export function buildGlossMergePrompt(input: {
  lemma: string;
  partOfSpeech: string;
  from: LanguageCode;
  to: LanguageCode;
  glosses: { key: string; alternatives: string[] }[];
  senses: { senseCode: string; gloss: string; definition: string | null }[];
}): GlossMergePrompt {
  const from = LANGUAGES[input.from].name;
  const to = LANGUAGES[input.to].name;
  const system = [
    `A ${from} headword has several ${to} target words recorded for its senses. Say which of them are ${GLOSS_MERGE_MARKER}: the same word in another gender, number or spelling.`,
    'Return JSON only, matching the supplied schema.',
    'In "groups", list each set of two or more such words, its dictionary citation form first. Leave out a word that is a different word, even one that means the same: synonyms are never forms of one word.',
    `In "definitions", define each sense listed without a definition in one short phrase in ${from}, by its sense_code.`,
  ].join('\n');
  const user = JSON.stringify({
    headword: input.lemma,
    part_of_speech: input.partOfSpeech,
    words: input.glosses.map((gloss) => gloss.key),
    senses_without_definition: input.senses
      .filter((sense) => sense.definition === null)
      .map((sense) => ({ sense_code: sense.senseCode, gloss: sense.gloss })),
  });
  return { system, user, schema: LlmGlossMergeSchema };
}

/** Null when unreadable. */
export function parseGlossMerge(raw: string): { groups: string[][]; definitions: { senseCode: string; definition: string }[] } | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const parsed = LlmGlossMergeSchema.safeParse(dropNulls(json));
  if (!parsed.success) return null;
  return {
    groups: parsed.data.groups.filter((group) => group.length >= 2),
    definitions: parsed.data.definitions.map((d) => ({ senseCode: d.sense_code, definition: d.definition.trim() })),
  };
}

/** Pairs of glosses that each name the other's key among their alternatives:
 *  listed to the operator as suggestions and never merged, because two glosses
 *  of one headword always hold different senses (spec D7, the Out list). */
export function mutualPairs(glosses: { id: string; key: string; alternatives: string[] }[]): [string, string][] {
  const names = (gloss: { alternatives: string[] }, key: string) =>
    gloss.alternatives.some((alternative) => normaliseGloss(alternative) === normaliseGloss(key));
  const pairs: [string, string][] = [];
  glosses.forEach((a, i) =>
    glosses.slice(i + 1).forEach((b) => {
      if (names(a, b.key) && names(b, a.key)) pairs.push([a.id, b.id]);
    }),
  );
  return pairs;
}
```

Run Step 2's command. Expected: PASS.

- [ ] **Step 4: Plan and apply, as use cases.** In `apps/server/src/repo/glosses.ts`, add the two things the tool reads and writes:

```ts
/** One lexeme and learner language the tool looks at: two or more live glosses,
 *  or a sense with no definition. */
export type MergeWork = {
  lexemeId: string;
  lemma: string;
  partOfSpeech: string;
  languageCode: string;
  userLanguageCode: string;
  glosses: { id: string; key: string; alternatives: string[] }[];
  senses: { senseId: string; senseCode: string; gloss: string; definition: string | null }[];
};
```

```ts
  /** Phase 31 (spec D7, the tool). The whole dictionary's work list. A by-hand
   *  tool reads everything once; nothing on a learner's path calls this. */
  const findMergeWork = async (): Promise<MergeWork[]> => {
    const glosses = await tx.execute<{
      id: string; lexeme_id: string; lemma: string; part_of_speech: string;
      language_code: string; user_language_code: string; key: string; alternatives: string[];
    }>(sql`
      SELECT g.id, g.lexeme_id, l.lemma, l.part_of_speech, l.language_code, g.user_language_code, g.key, g.alternatives
      FROM dict_glosses g JOIN dict_lexemes l ON l.id = g.lexeme_id
      WHERE g.merged_into IS NULL
      ORDER BY l.lemma, g.user_language_code, g.key`);
    const senses = await tx.execute<{
      sense_id: string; sense_code: string; definition: string | null; lexeme_id: string; user_language_code: string; key: string;
    }>(sql`
      SELECT s.id AS sense_id, s.sense_code, s.definition, m.lexeme_id, m.user_language_code, g.key
      FROM dict_sense_glosses m
      JOIN dict_senses s  ON s.id = m.sense_id
      JOIN dict_glosses g ON g.id = m.gloss_id
      ORDER BY s.sense_code`);
    const work = new Map<string, MergeWork>();
    for (const row of glosses.rows) {
      const id = `${row.lexeme_id} ${row.user_language_code}`;
      const item = work.get(id) ?? {
        lexemeId: row.lexeme_id,
        lemma: row.lemma,
        partOfSpeech: row.part_of_speech,
        languageCode: row.language_code,
        userLanguageCode: row.user_language_code,
        glosses: [],
        senses: [],
      };
      item.glosses.push({ id: row.id, key: row.key, alternatives: row.alternatives });
      work.set(id, item);
    }
    for (const row of senses.rows) {
      work.get(`${row.lexeme_id} ${row.user_language_code}`)?.senses.push({
        senseId: row.sense_id,
        senseCode: row.sense_code,
        gloss: row.key,
        definition: row.definition,
      });
    }
    return [...work.values()].filter((item) => item.glosses.length >= 2 || item.senses.some((sense) => sense.definition === null));
  };

  /** Phase 31 (spec D9). Fills definitions a sense lacks; one already there stays. */
  const setDefinitions = async (rows: { senseId: string; definition: string }[]): Promise<number> => {
    let filled = 0;
    for (const row of rows) {
      const result = await tx.execute(sql`UPDATE dict_senses SET definition = ${row.definition} WHERE id = ${row.senseId} AND definition IS NULL`);
      filled += result.rowCount ?? 0;
    }
    return filled;
  };
```

both added to the returned object (and `createFakeGlossRepo` in `fakes.ts` gains `findMergeWork: async () => []` and `setDefinitions: async () => 0`; `createFakeAppDeps`' `glosses` gains `planMerges: unreachable` and `applyMerges: unreachable`, because `AppDeps.glosses` is the whole `GlossService`).

In `apps/server/src/services/glosses.ts`, the factory takes an optional `llm?: LlmClient` and gains two use cases (import `buildGlossMergePrompt`, `parseGlossMerge`, `mutualPairs`, `normaliseGloss`, `type LanguageCode`):

```ts
export type PlannedMerge = {
  lexemeId: string;
  userLanguageCode: string;
  lemma: string;
  survivorId: string;
  survivorKey: string;
  otherId: string;
  otherKey: string;
  tier: 1 | 2;
};
export type MergePlan = {
  merges: PlannedMerge[];
  definitions: { senseId: string; definition: string }[];
  suggestions: { lemma: string; keys: [string, string] }[];
};
```

```ts
    /**
     * Spec D7, the by-hand tool. Tier 1 is the job's signal over the whole
     * dictionary; tier 2 (`model`) asks the model, once per lexeme and language,
     * which target words are forms of one word, and for missing definitions.
     * Mutual-alternative pairs are listed as suggestions and never merged.
     * Writes nothing. The model is called outside any transaction (ADR 0001 R8).
     */
    planMerges: async ({ model }: { model: boolean }): Promise<MergePlan> => {
      const work = await transaction(({ gloss }) => gloss.findMergeWork());
      const plan: MergePlan = { merges: [], definitions: [], suggestions: [] };
      for (const item of work) {
        const keyOf = new Map(item.glosses.map((g) => [g.id, g.key]));
        const planned = new Set<string>();
        const base = { lexemeId: item.lexemeId, userLanguageCode: item.userLanguageCode, lemma: item.lemma };
        const candidates = await transaction(({ gloss }) =>
          gloss.findMergeCandidates({ lexemeId: item.lexemeId, userLanguageCode: item.userLanguageCode }),
        );
        for (const pair of candidates) {
          planned.add(pair.otherId);
          plan.merges.push({ ...base, ...pair, survivorKey: keyOf.get(pair.survivorId)!, otherKey: keyOf.get(pair.otherId)!, tier: 1 });
        }
        for (const [a, b] of mutualPairs(item.glosses)) plan.suggestions.push({ lemma: item.lemma, keys: [keyOf.get(a)!, keyOf.get(b)!] });
        if (!model || !llm) continue;

        const raw = await llm(
          buildGlossMergePrompt({
            lemma: item.lemma,
            partOfSpeech: item.partOfSpeech,
            from: item.languageCode as LanguageCode,
            to: item.userLanguageCode as LanguageCode,
            glosses: item.glosses,
            senses: item.senses,
          }),
        );
        const answer = parseGlossMerge(raw);
        if (!answer) {
          logger.info({ event: 'gloss_merge_unreadable', lexeme_id: item.lexemeId, user_language_code: item.userLanguageCode });
          continue;
        }
        const byKey = new Map(item.glosses.map((g) => [normaliseGloss(g.key), g]));
        for (const group of answer.groups) {
          const [survivor, ...others] = group.flatMap((word) => {
            const found = byKey.get(normaliseGloss(word));
            return found ? [found] : [];
          });
          for (const other of others) {
            if (!survivor || other.id === survivor.id || planned.has(other.id)) continue;
            planned.add(other.id);
            plan.merges.push({ ...base, survivorId: survivor.id, survivorKey: survivor.key, otherId: other.id, otherKey: other.key, tier: 2 });
          }
        }
        const senseOf = new Map(item.senses.map((sense) => [sense.senseCode, sense]));
        for (const { senseCode, definition } of answer.definitions) {
          const sense = senseOf.get(senseCode);
          if (sense && sense.definition === null && definition !== '') plan.definitions.push({ senseId: sense.senseId, definition });
        }
      }
      return plan;
    },

    /** Applies a plan: one transaction per merge, under its lexeme's lock, then
     *  the definitions. A merge whose glosses a previous one already folded is a
     *  no-op (mergeGlosses returns null). */
    applyMerges: async (plan: MergePlan): Promise<{ merged: number; definitions: number }> => {
      let merged = 0;
      for (const merge of plan.merges) {
        const counts = await transaction(async ({ dict, gloss }) => {
          await dict.lockLexemes([merge.lexemeId]);
          return gloss.mergeGlosses({ survivorId: merge.survivorId, otherId: merge.otherId });
        });
        if (!counts) continue;
        merged += 1;
        logger.info({ ...glossMerged({ lexemeId: merge.lexemeId, userLanguageCode: merge.userLanguageCode, survivorId: merge.survivorId, otherId: merge.otherId, counts }), tier: merge.tier });
      }
      const definitions = plan.definitions.length === 0 ? 0 : await transaction(({ gloss }) => gloss.setDefinitions(plan.definitions));
      return { merged, definitions };
    },
```

In `composition.ts`, extract the repositories `createServerDeps` binds into a module-private function both factories use, and export a narrow factory for the CLI, the one place besides `createServerDeps` that names `createGeminiClient` (ADR 0001 R11):

```ts
// A tool that enqueues nothing gets a jobs repository that says so.
const NO_JOBS: JobRepo = {
  enqueue: async () => {
    throw new Error('this composition enqueues no job');
  },
};

/** Every repository bound to one transaction: what a use case receives (R8). */
function bindRepos(tx: Tx, boss: PgBoss | null): Repos {
  return {
    session: createSessionRepo(tx),
    question: createQuestionRepo(tx),
    user: createUserRepo(tx),
    enrollment: createEnrollmentRepo(tx),
    grant: createGrantRepo(tx),
    dict: createDictRepo(tx),
    vocabulary: createVocabularyRepo(tx),
    progress: createProgressRepo(tx),
    jobs: boss ? createJobRepo(tx, boss) : NO_JOBS,
    photoImport: createPhotoImportRepo(tx),
    gloss: createGlossRepo(tx),
  };
}

/**
 * Phase 31 (spec D7). The by-hand merge tool's use cases, for db/cli.ts: the
 * glosses service with a transaction and a model client, and nothing else a
 * server needs. No I/O here (R6): the caller owns the pool.
 */
export function createGlossTools(io: {
  db: Db;
  logger: Logger;
  fetch: typeof globalThis.fetch;
  gemini: GeminiConfig;
  timeoutMs: number;
}): GlossService {
  const transaction = createTransaction(io.db, (tx) => bindRepos(tx, null));
  const llm: LlmClient = createGeminiClient({
    fetch: io.fetch,
    baseUrl: io.gemini.baseUrl,
    apiKey: io.gemini.apiKey,
    model: io.gemini.model,
    timeoutMs: io.timeoutMs,
  });
  return createGlossService({ transaction, logger: io.logger, llm });
}
```

`createServerDeps` binds with `createTransaction(io.db, (tx) => bindRepos(tx, io.boss))` (import `type Tx` from `./db/client`, `type Repos` from `./services/transaction`, `type JobRepo` from `./repo/jobs`).

- [ ] **Step 5: The command.** ADR 0001 needs one amendment first (decided while planning, item 10). R4 forbids `src/db/` from importing `composition.ts`, and R11 lets only `composition.ts` construct the Gemini client, so the CLI, which R7 already treats as an entry point, may import the composition root, and nothing else under `db/` may. In `docs/adr/adr-0001-layered-architecture.md`, add that one exception to R4's row and text, and append `R4 amended 2026-10-09 (phase 31): db/cli.ts may import composition.ts` to the Date line. In `scripts/check-adr-0001-layered-architecture.sh`, end `r4()`'s pipeline with `| grep -v '^apps/server/src/db/cli.ts:'`. Plant a violation before trusting the change: add `import { createServerDeps } from '../composition';` to `apps/server/src/db/seed.ts`, run `bash scripts/check-adr-0001-layered-architecture.sh`, and expect a VIOLATION under R4 naming `seed.ts`; then remove the plant and expect R4 ok. Paste both outputs into the report.

Then, in `apps/server/src/db/cli.ts` (import `loadGeminiConfig` from `../config`, `createGlossTools` from `../composition` and `createConsoleLogger` from `../logger`), after the `--render-lemmas` block:

```ts
    // Phase 31 (spec D7). `npm run dict:glosses:merge [-- --model] [-- --yes]`:
    // prints the plan, and changes nothing without --yes, as lane:clean does.
    if (process.argv.includes('--merge-glosses')) {
      const tools = createGlossTools({
        db,
        logger: createConsoleLogger(),
        fetch: globalThis.fetch,
        gemini: loadGeminiConfig(process.env),
        timeoutMs: 60_000,
      });
      const plan = await tools.planMerges({ model: process.argv.includes('--model') });
      for (const merge of plan.merges) console.log(`tier ${merge.tier}  ${merge.lemma}: ${merge.otherKey} → ${merge.survivorKey}`);
      for (const suggestion of plan.suggestions) console.log(`suggestion, not merged: ${suggestion.lemma}: ${suggestion.keys.join(' ↔ ')}`);
      console.log(`${plan.merges.length} merges, ${plan.definitions.length} definitions to fill`);
      if (!process.argv.includes('--yes')) {
        console.log('Nothing changed. Run again with -- --yes to apply.');
        return;
      }
      const done = await tools.applyMerges(plan);
      console.log(`merged ${done.merged}, filled ${done.definitions} definitions`);
      return;
    }
```

Scripts: `apps/server/package.json`, `"dict:glosses:merge": "tsx src/db/cli.ts --merge-glosses"`; root, `"dict:glosses:merge": "bash scripts/lane-env.sh npm run dict:glosses:merge --workspace apps/server --"`. The tool runs in a lane; production's database is reachable only from the container's start command (ADR 0010), so in production the automatic job is the only merge.

- [ ] **Step 6: Test the use cases.** Create `apps/server/tests/integration/services/glosses.tools.test.ts` (no `src/repo`, no Drizzle; the composition factory and the support helpers only):

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createGlossTools } from '../../../src/composition';
import { insertDriftedFinger, insertRendering } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { geminiResponse } from '../../support/geminiResponse';
import { clearNamespace, expectGeminiRawBody, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
let ns: string;
beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('services-glosses-tools');
});
afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const tools = () =>
  createGlossTools({
    db: t.db,
    logger: createFakeLogger(),
    fetch: globalThis.fetch,
    gemini: { baseUrl: geminiBaseUrlFor(ns), apiKey: 'test', model: 'test' },
    timeoutMs: 5_000,
  });

/** `finger` whose lemma form renders body_part as אצבע while body_part's gloss is
 *  keyed אצבעות: the blocked rename tier 1 finds. insertLexeme alone cannot
 *  build it, since its rule keys body_part from the lemma form. */
async function blockedRename() {
  const w = await insertDriftedFinger(t.db);
  await insertRendering(t.db, { variantId: w.finger, senseId: w.senseIds[0], userLanguageCode: 'he', translation: 'אצבע', gloss: 'אצבע', rank: 1 });
  return w;
}

describe('dict:glosses:merge (spec D7)', () => {
  it('plans tier 1 without writing, and applies it only when asked', async () => {
    await blockedRename();
    const plan = await tools().planMerges({ model: false });
    expect(plan.merges.map(({ otherKey, survivorKey, tier }) => ({ otherKey, survivorKey, tier }))).toEqual([
      { otherKey: 'אצבעות', survivorKey: 'אצבע', tier: 1 },
    ]);
    expect((await tools().planMerges({ model: false })).merges).toHaveLength(1);
    expect(await tools().applyMerges(plan)).toEqual({ merged: 1, definitions: 0 });
    expect((await tools().planMerges({ model: false })).merges).toHaveLength(0);
  });

  it("plans tier 2 from the model's groups, the citation form surviving", async () => {
    await insertDriftedFinger(t.db);
    await expectGeminiRawBody(ns, JSON.stringify(geminiResponse({ groups: [['אצבע', 'אצבעות']], definitions: [] })));
    const plan = await tools().planMerges({ model: true });
    expect(plan.merges.map(({ otherKey, survivorKey, tier }) => ({ otherKey, survivorKey, tier }))).toEqual([
      { otherKey: 'אצבעות', survivorKey: 'אצבע', tier: 2 },
    ]);
  });
});
```

- [ ] **Step 7: Run and commit.** `npm run typecheck && npm test && npm run test:integration && npm run lint:arch`. Expected: PASS. Then, on the lane, `npm run dict:glosses:merge` (expected: a plan and "Nothing changed").

```bash
git add apps/server packages/core package.json docs/adr scripts
git commit -m "feat(server): export and restore the new fields, and dict:glosses:merge in two tiers with a plan step"
```

---

## Part E — End to end, the ADR, and the branch

### Task 15: E2E — `mouse` is one card, `fingers` headlines אצבע, and a session asks `finger`

**Files:**
- Modify: `e2e/tests/support/lexemes.ts` (`MOUSE`, `FINGERS`, `FINGER`, `FINGER_RECONCILED`)
- Modify: `e2e/tests/support/mockServer.ts` (`expectGeminiMatching` takes a priority)
- Create: `e2e/tests/support/sessions.ts`, `e2e/tests/glosses.spec.ts`

**Interfaces:**
- Consumes: Task 8's test ids `translate-example`, `vocabulary-sense-example` and `vocabulary-sense-saved-from`, and the existing `translate-sense`, `translate-save`, `translate-back`, `vocabulary-entry`, `vocabulary-word`, `vocabulary-sense` and `vocabulary-sense-level`. The level badge renders for a saved card with progress rows, and a save writes five of them per entry.
- Consumes: Task 10's `userText(text)` in `e2e/tests/support/mockServer.ts`, and `lookUp`, which since Task 10 answers only its own text.
- Consumes: `VocabularyWordDetail` with Task 7's `examples` and `saved_from`, and `NextStepResponse`'s `progress`, both from `@lang-tutor/core/api`.
- Produces, in `e2e/tests/support/sessions.ts`:
  - `enrollmentIdOf(request, userId): Promise<string>`;
  - `readyListSession(request, enrollmentId): Promise<{ id: string; total: number; question: Question }>`;
  - `skipSession(request, sessionId): Promise<void>`;
  - `askedForm(question: Question): string`;
  - `answerChoiceRight(request, sessionId, userId, question): Promise<NextStepResponse>`.

- [ ] **Step 1: The stubs.** Append to `e2e/tests/support/lexemes.ts`. None of these words is in the seed: `grep -rn "'mouse'\|'finger'" apps/server/src/db/` prints nothing.

```ts
/** Phase 31. `mouse`: two senses, one Hebrew word, so one card with two examples. */
export const MOUSE = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'mouse',
      part_of_speech: 'noun',
      senses: [
        { translation: 'עכבר', gloss: 'עכבר', definition: 'a small rodent with a long tail', sense_code: 'rodent', example: { source: 'A mouse ran across the kitchen floor.', target: 'עכבר רץ על רצפת המטבח.' } },
        { translation: 'עכבר', gloss: 'עכבר', definition: 'a hand-held device that moves a pointer', sense_code: 'computer_device', example: { source: 'Click the left mouse button.', target: 'לחץ על הכפתור השמאלי של העכבר.' } },
      ],
    },
  ],
};

/** Phase 31. `fingers`, saved inflected: a plural rendering, a singular citation form. */
export const FINGERS = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'finger',
      part_of_speech: 'noun',
      senses: [{ translation: 'אצבעות', gloss: 'אצבע', alternatives: [], gloss_alternatives: [], definition: 'one of the five digits of the hand', sense_code: 'body_part', example: { source: 'He has long fingers.', target: 'יש לו אצבעות ארוכות.' } }],
    },
  ],
};

/** Phase 31. The render-lemma job's lookup of `finger`: the first call's answer
 *  (a new code), then the rendering call that maps it onto the stored sense. */
export const FINGER = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'finger',
      part_of_speech: 'noun',
      senses: [{ translation: 'אצבע', gloss: 'אצבע', definition: 'one of the five digits of the hand', sense_code: 'digit_of_hand', example: { source: 'She pointed with one finger.', target: 'היא הצביעה באצבע אחת.' } }],
    },
  ],
};
export const FINGER_RECONCILED = {
  senses: [{ sense_code: 'body_part', translation: 'אצבע', gloss: 'אצבע', definition: null, example: { source: 'She pointed with one finger.', target: 'היא הצביעה באצבע אחת.' } }],
};
```

These stubs carry the model's new fields (spec, "MockServer and eval"). The existing stubs stay as they are, because they are model answers without those fields, and such answers must keep working. `FINGER_RECONCILED`'s null definition is the rendering call's way of leaving a stored definition alone.

In `e2e/tests/support/mockServer.ts`, `expectGeminiMatching`'s options become `{ delayMs?: number; priority?: number }`. Send `...(opts.priority ? { priority: opts.priority } : {})` beside `httpRequest`. MockServer tries a higher priority first, so a stub matched on a marker outranks one matched on the same text.

- [ ] **Step 2: The session helpers.** Create `e2e/tests/support/sessions.ts`:

```ts
import type { CreateSessionResponse, NextStepResponse, Question, SessionView } from '@lang-tutor/core/api';
import { expect, type APIRequestContext } from '@playwright/test';

import { API_URL } from '../../urls';

/** Phase 31. The enrollment createLearner made. */
export async function enrollmentIdOf(request: APIRequestContext, userId: string): Promise<string> {
  const res = await request.get(`${API_URL}/api/users/${userId}/enrollments`);
  expect(res.ok(), await res.text()).toBe(true);
  const [first] = (await res.json()) as { id: string }[];
  return first.id;
}

export async function skipSession(request: APIRequestContext, sessionId: string): Promise<void> {
  expect((await request.post(`${API_URL}/api/sessions/${sessionId}/skip`)).ok()).toBe(true);
}

/**
 * Phase 31. The enrollment's next list session, made over the API and waited
 * for. An enrollment's first session is the seed, which is skipped unplayed.
 * Needs a generation stub registered (cards.ts' generationStub).
 */
export async function readyListSession(
  request: APIRequestContext,
  enrollmentId: string,
): Promise<{ id: string; total: number; question: Question }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const made = await request.post(`${API_URL}/api/sessions`, { data: { enrollment_id: enrollmentId } });
    expect(made.ok(), await made.text()).toBe(true);
    const created = (await made.json()) as CreateSessionResponse;
    if (created.source === 'seed') {
      await skipSession(request, created.session_id);
      continue;
    }
    let view: SessionView | undefined;
    await expect(async () => {
      const res = await request.get(`${API_URL}/api/sessions/${created.session_id}`);
      view = (await res.json()) as SessionView;
      expect(view.status).toBe('ready');
    }).toPass({ timeout: 60_000 });
    return { id: created.session_id, total: view!.position.total, question: view!.question! };
  }
  throw new Error('no list session after the seed');
}

/**
 * The form a one-word session asks about. With no voice and no microphone
 * declared, one pick always takes the first tier's card: a choice of meanings
 * or a typed meaning, and both show the form as `question` (domain/plan.ts).
 */
export function askedForm(question: Question): string {
  if (question.type === 'multiple_choice' || question.type === 'typed_meaning') return question.question;
  throw new Error(`a one-word session asked a ${question.type} card`);
}

/** Answers a choice of meanings right, as the app does. */
export async function answerChoiceRight(
  request: APIRequestContext,
  sessionId: string,
  userId: string,
  question: Question,
): Promise<NextStepResponse> {
  if (question.type !== 'multiple_choice') throw new Error(`expected a choice of meanings, got ${question.type}`);
  const res = await request.post(`${API_URL}/api/sessions/${sessionId}/next-step`, {
    data: { user_id: userId, question_id: question.id, option_index: question.correct_option },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as NextStepResponse;
}
```

An enrollment's first list session has ordinal 0, so its one card is a choice of meanings. Later sessions alternate between that and a typed meaning, because the listening card in between is not eligible. If phase 29 has merged by now, these API calls need its session cookie: follow how its own e2e specs call the API.

- [ ] **Step 3: The spec.** Create `e2e/tests/glosses.spec.ts`:

```ts
import type { VocabularyWordDetail } from '@lang-tutor/core/api';
import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { generationStub } from './support/cards';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { FINGER, FINGER_RECONCILED, FINGERS, MOUSE } from './support/lexemes';
import { clearGemini, expectGeminiMatching, expectGeminiPayload, userText } from './support/mockServer';
import { answerChoiceRight, askedForm, enrollmentIdOf, readyListSession, skipSession } from './support/sessions';
import { createLearner, logIn } from './support/users';

test.setTimeout(240_000);

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

async function wordDetail(request: Parameters<typeof enrollmentIdOf>[0], enrollmentId: string, lemma: string) {
  const res = await request.get(`${API_URL}/api/enrollments/${enrollmentId}/vocabulary/word?lemma=${encodeURIComponent(lemma)}`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as VocabularyWordDetail;
}

test('two senses with one target word are one card, saved once, practised once, at one level', async ({ page, request }) => {
  const user = await createLearner(request, 'e2e_gloss_mouse', 'en');
  const enrollmentId = await enrollmentIdOf(request, user.id);
  await logIn(page, 'e2e_gloss_mouse');
  await tapUntil(page, 'translate-entry', 'translate-input');

  await lookUp(page, request, 'mouse', MOUSE);
  await expect(page.getByTestId('translate-sense')).toHaveCount(1);
  await expect(page.getByTestId('translate-example')).toHaveCount(2);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save'));

  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  await expect(page.getByTestId('vocabulary-word')).toHaveCount(1);
  await page.getByTestId('vocabulary-word').first().click();
  await expect(page.getByTestId('vocabulary-sense')).toHaveCount(1);
  await expect(page.getByTestId('vocabulary-sense-example')).toHaveCount(2);
  await expect(page.getByTestId('vocabulary-sense-level')).toHaveCount(1);

  // Practised once: one card in the session, and one level when it ends.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStub());
  const session = await readyListSession(request, enrollmentId);
  expect(session.total).toBe(1);
  expect(askedForm(session.question)).toBe('mouse');
  const done = await answerChoiceRight(request, session.id, user.id, session.question);
  expect(done.complete).toBe(true);
  if (done.complete) expect(done.progress).toHaveLength(1);

  // Read over the API: a reload would sign the page out, since the app keeps
  // the profile in memory and remembers only the username.
  const detail = await wordDetail(request, enrollmentId, 'mouse');
  expect(detail.senses).toHaveLength(1);
  expect(detail.senses[0].progress).toBeDefined();
});

test('a word saved from fingers headlines אצבע and says where it was saved from, and once its lemma is rendered a session asks finger', async ({
  page,
  request,
}) => {
  const user = await createLearner(request, 'e2e_gloss_finger', 'en');
  const enrollmentId = await enrollmentIdOf(request, user.id);
  await logIn(page, 'e2e_gloss_finger');
  await tapUntil(page, 'translate-entry', 'translate-input');

  await lookUp(page, request, 'fingers', FINGERS);
  // The save asks for the render-lemma job, which looks `finger` up: the first
  // call, then the rendering call for the stored sense. Both send `finger` as
  // their text, so the rendering call's marker ranks first.
  await expectGeminiMatching(request, 'reusing its sense_code EXACTLY', FINGER_RECONCILED, { priority: 20 });
  await expectGeminiMatching(request, userText('finger'), FINGER, { priority: 10 });
  await tapAndWaitForWrite(page, page.getByTestId('translate-save'));

  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const word = page.getByTestId('vocabulary-word').first();
  await expect(word).toContainText('finger');
  await expect(word).toContainText('אצבע');
  await expect(word).not.toContainText('אצבעות');
  await word.click();
  await expect(page.getByTestId('vocabulary-sense-saved-from')).toContainText('fingers');
  await expect(page.getByTestId('vocabulary-sense-saved-from')).toContainText('אצבעות');

  // The job has run once the word's page takes its example from the lemma form.
  await expect(async () => {
    const detail = await wordDetail(request, enrollmentId, 'finger');
    expect(detail.senses[0].examples[0].source).toBe('She pointed with one finger.');
  }).toPass({ timeout: 60_000 });

  // Each session asks one agreeing rendering at random (spec D12): `fingers` or
  // `finger`. Ten sessions miss `finger` once in 1024 runs.
  await clearGemini(request);
  await expectGeminiPayload(request, generationStub());
  const asked = new Set<string>();
  for (let attempt = 0; attempt < 10 && !asked.has('finger'); attempt++) {
    const session = await readyListSession(request, enrollmentId);
    asked.add(askedForm(session.question));
    await skipSession(request, session.id);
  }
  expect([...asked]).toContain('finger');
});
```

- [ ] **Step 4: Run it.** `npm run e2e -- glosses`, then the whole suite with `npm run e2e`. Expected: PASS. In CI, a test-e2e run that fails at "Install Chromium" with an empty log after 30 minutes is the known install hang: rerun the failed job once.

- [ ] **Step 5: Commit.**

```bash
git add e2e
git commit -m "test(e2e): mouse is one card, fingers headlines its citation form, and a session asks finger"
```

---

### Task 16: ADR 0011 — "The learner's unit is the gloss", and its check

**Files:**
- Create: `docs/adr/adr-0011-learner-unit-is-the-gloss.md`, `scripts/check-adr-0011-learner-unit-is-the-gloss.sh` (executable)
- Modify: `README.md` (its ADR list and counts)

**Interfaces:**
- Produces: two rules, each the same command in the ADR and the script: R1, no table outside the `dict_` prefix references `dict_senses` or `dict_var_translations`; R2, `vocabulary_entries` and `questions` each declare a foreign key to `dict_glosses`.

- [ ] **Step 1: Use the `create-adr` skill.** Its four questions are answered by the spec (D17), so do not ask them again; give the skill these answers:
  - **Scope:** `apps/server/src/db/schema.ts`, its table definitions' foreign keys. Tests and migrations are out.
  - **Corollaries:** none beyond R1 and R2.
  - **Exceptions:** tables whose name starts with `dict_` may reference `dict_senses` and `dict_var_translations`: they are the dictionary.
  - **Status and Source:** Accepted; `docs/superpowers/specs/2026-10-09-lang-tutor-phase-31-glosses-design.md` (D1, D2, D8, D17).
  The skill's conflict scan will find no contradiction with ADRs 0001–0010; report any it does find instead of resolving it.

- [ ] **Step 2: The check, violation first.** Create `scripts/check-adr-0011-learner-unit-is-the-gloss.sh`, framed exactly as `scripts/check-adr-0008-access-grants.sh` (same `check()` helper and output), with the banner "Checking the repo against ADR 0011 (the learner's unit is the gloss)" and the pass line "Learner-unit check passed: 2 rules, no violations.":

```bash
SCHEMA=apps/server/src/db/schema.ts

# Every line of schema.ts, prefixed with the table whose pgTable(...) block it
# is in: the first quoted snake_case word after `pgTable(`, on its line or the next.
tables() {
  awk '
    /= pgTable\(/ { pending = 1; table = "" }
    pending && match($0, /'"'"'[a-z_]+'"'"'/) { table = substr($0, RSTART + 1, RLENGTH - 2); pending = 0 }
    { print table "\t" NR ": " $0 }
  ' "$SCHEMA"
}

# R1 — no table outside the dict_ prefix references dict_senses or dict_var_translations.
r1() {
  tables | awk -F '\t' -v file="$SCHEMA" '$1 != "" && $1 !~ /^dict_/ && $2 ~ /(dictSenses|dictVarTranslations)\./ { print file ":" $2 }'
}

# R2 — vocabulary_entries and questions each declare a foreign key to dict_glosses.
r2() {
  for t in vocabulary_entries questions; do
    tables | awk -F '\t' -v want="$t" -v file="$SCHEMA" \
      '$1 == want && $2 ~ /dictGlosses\./ { found = 1 } END { if (!found) print file ": " want " declares no foreign key to dict_glosses" }'
  done
}
```

`chmod +x` it. Plant each violation and confirm the report before trusting the script (CLAUDE.md: a check that cannot fire prints nothing, exactly like one that passes):
1. In `schema.ts`, add `foreignKey({ name: 'planted', columns: [t.promptVariantId], foreignColumns: [dictSenses.id] }),` to `questions`' constraints. Run `bash scripts/check-adr-0011-learner-unit-is-the-gloss.sh`. Expected: `VIOLATION  R1 …` naming that line, exit 1.
2. Remove the plant, and delete `questions_gloss_fk` from `questions`. Expected: `VIOLATION  R2 … questions declares no foreign key to dict_glosses`, exit 1.
3. Restore it. Expected: `ok` for both, exit 0.
Paste the two VIOLATION outputs into the task report. Run it on Linux too if you can (`docker run --rm -v "$PWD":/w -w /w ubuntu bash scripts/check-adr-0011-learner-unit-is-the-gloss.sh`): CI's `awk` is not macOS's.

- [ ] **Step 3: The ADR.** Write `docs/adr/adr-0011-learner-unit-is-the-gloss.md` in the skill's shape: the header; `## Decision` (a gloss is one target word of one lexeme in one learner language; senses stay the dictionary's identity; learner tables key on the gloss; every rendered sense has a gloss, written by the lookup and the repair; a diagram of `dict_lexemes ← dict_senses ← dict_sense_glosses → dict_glosses ← vocabulary_entries / questions`); `## Rules` with R1 and R2; `## How to detect a violation` with the two functions above verbatim; `## Why` (R1: a learner table keyed on a sense would leak one language's grouping into every other, D1; R2: the explicit key is what a save, a level and a card are about, D2); `## Related` (ADR 0001 R4, ADR 0008 R1).

- [ ] **Step 4: README and the whole check.** Add ADR 0011 to `README.md`'s ADR list and update its counts the way phase 30's commit `05f497b` did. Run `npm run lint:arch`. Expected: every ADR passes, 0011 included.

- [ ] **Step 5: Commit.**

```bash
git add docs/adr scripts/check-adr-0011-learner-unit-is-the-gloss.sh README.md
git commit -m "docs(adr): ADR 0011 — the learner's unit is the gloss, with its check"
```

---

### Task 17: The whole branch — every gate, the spec as built, and the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-lang-tutor-phase-31-glosses-design.md`

- [ ] **Step 1: Every gate.** `git fetch origin` and merge `origin/master` if it moved (Global Constraints). Then, from the worktree root, in order: `npm run typecheck`, `npm run test:all` (unit, then integration: the spec's done criterion), `npm run lint:arch`, `npm run e2e`, and the whole eval set (`npx tsx tests/eval/run.ts` from `apps/server`). Expected: all PASS, and the eval's tier 2 score at or above `TIER2_THRESHOLD`. Paste each summary line into the report. Never lower `TIER2_THRESHOLD` to pass.

- [ ] **Step 2: A copy of lane 0's data, migrated as the deploy will migrate it.** Stop this lane's server if it runs. Read this lane's database name from `bash scripts/lane-env.sh printenv DATABASE_URL`, the part after the last `/`; below it is `<lane db>`, spelled out. Lane 0's database is `lang_tutor` (CLAUDE.md, "Lanes"), and this step only reads it. Replace the lane's database with a copy:

```bash
docker exec lang-tutor-db-1 dropdb -U postgres --force <lane db>
docker exec lang-tutor-db-1 createdb -U postgres <lane db>
docker exec lang-tutor-db-1 sh -c 'pg_dump -U postgres lang_tutor | psql -q -U postgres -d <lane db>'
```

Before migrating, measure the fold the re-key will make. Write this to `<scratchpad>/folds.sql` with the Write tool and run `docker exec -i lang-tutor-db-1 psql -U postgres -d <lane db> < <scratchpad>/folds.sql`. It applies 0022's key rule by hand, since `gloss_key` does not exist yet:

```sql
with first_item as (
  select tr.variant_id, tr.sense_id, tr.user_language_code, tr.rank, v.form, l.lemma, s.lexeme_id,
         coalesce(
           (select btrim(regexp_replace(u.item, '\s+', ' ', 'g'))
            from unnest(regexp_split_to_array(regexp_replace(tr.translation, '\([^)]*\)', '', 'g'), '[,/;]')) with ordinality as u(item, n)
            where btrim(regexp_replace(u.item, '\s+', ' ', 'g')) <> ''
            order by u.n limit 1),
           btrim(regexp_replace(tr.translation, '\s+', ' ', 'g'))) as item
  from dict_var_translations tr
  join dict_variants v on v.id = tr.variant_id
  join dict_senses s on s.id = tr.sense_id
  join dict_lexemes l on l.id = s.lexeme_id
),
sense_key as (
  select distinct on (sense_id, user_language_code) sense_id, lexeme_id, user_language_code,
         lower(btrim(regexp_replace(regexp_replace(regexp_replace(translate(normalize(item, NFC), U&'\05BE-', '  '),
           '[֑-ׇ́]', '', 'g'), '\([^)]*\)', '', 'g'), '\s+', ' ', 'g'))) as k
  from first_item
  order by sense_id, user_language_code, (lower(form) = lower(lemma)) desc, rank, variant_id
)
select count(*) as entries_now,
       count(*) filter (where sk.k is null) as entries_without_key,
       count(distinct (e.enrollment_id, sk.lexeme_id, sk.k)) as entries_after_fold
from vocabulary_entries e
join enrollments en on en.id = e.enrollment_id
left join sense_key sk on sk.sense_id = e.sense_id and sk.user_language_code = en.source_language;
```

On 2026-10-09 lane 0 gave 164 entries, none without a key, and 152 after the fold. The 12 that go were 20 entries in 8 groups: con, decoration, fratello, ora, tè, день, ложка and цель. Lane 0 changes as Victor uses the app, so use this run's numbers.

Then `npm run db:migrate`. Expected: the three migrations apply, and the CLI prints `asked for N lemma renders`. Then check, with `docker exec lang-tutor-db-1 psql -U postgres -d <lane db> -c "<query>"`:
- `select count(*) from vocabulary_entries` equals `entries_after_fold`;
- `select count(*) from gloss_progress` is five times that: every entry had exactly five progress rows on 2026-10-09, and a fold keeps one entry's five;
- `select l.lemma, g.key, g.alternatives from dict_glosses g join dict_lexemes l on l.id = g.lexeme_id where l.lemma in ('mouse', 'con', 'день', 'development') and g.user_language_code = 'he' and g.merged_into is null order by 1, 2` shows one live gloss per target word.

Start `npm run server` for a minute and watch for `lemma_rendered` and `lemma_render_skipped` lines, then stop it. Paste every output into the report. If the auto-mode classifier refuses the dump of lane 0, skip this step and say so: Task 6's migration test carries lane 0's shapes.

- [ ] **Step 3: The spec as built.** In the spec, add a `- **Built:**` line under its Status naming the PR, and a short section `## As built` after `## Risks` listing the eight items of this plan's "Decided while planning", each in one sentence with its reason, plus:
  - the lookup card's and the word page's exact shapes (Task 7);
  - the list headline is the earliest saved gloss (Task 7), not the lowest-ranked;
  - the merge tool runs only in a lane: production's database is reachable only from the container's start command (ADR 0010), so in production the automatic job is the only merge;
  - Task 10's failed-render case checks the word page on the saved form, not session preparation: preparation never reads lemma renders, so it cannot wait on one;
  - `also` and `savedFrom` are Hebrew only: the app's strings have one language, so the spec's "both languages" had nothing to fill.
  Replace every "ADR 0009" in the spec with "ADR 0011": Done means, Scope, D17, Testing and Build order name it, five places in all (`grep -n "ADR 0009" docs/superpowers/specs/2026-10-09-lang-tutor-phase-31-glosses-design.md`).

- [ ] **Step 4: Finish the branch.** Follow CLAUDE.md "Finishing a branch": `superpowers:finishing-a-development-branch`, taking "Push and create a Pull Request" through the `git-create-pr` skill, then `ci-green`. Never merge locally, and keep the worktree. One PR for the whole phase. The PR description says, beside the summary:
  - ADR 0010's rollout window applies: for about a minute the old container serves after the new one has migrated, and this phase renames `sense_progress` and drops `sense_id` columns, so the old code's session completions and list reads fail during that minute;
  - the first start after the deploy asks for the lemma renders of every word saved from an inflected form, one or two model calls each, in the background;
  - which tests changed expectations because two senses of one target word now count once (from Task 6's report).
  If `test-eval` goes red with nothing in the diff to explain it, read its `eval-report` artifact before touching anything (CLAUDE.md, "Prompt evals").

  The final message also tells Victor that the main checkout still holds untracked copies of the spec and this plan. Once the PR merges, those copies block `git pull` on master and must be removed first, after a `cmp` against the merged files if either was edited since.

