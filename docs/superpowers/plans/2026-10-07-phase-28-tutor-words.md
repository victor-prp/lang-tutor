# Phase 28 — A tutor adds words to a student's list: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tutor invites a student for one of the student's languages. Once the student accepts, the tutor adds words to that list, each one labelled "added by" the tutor. This is built as access grants (a role, a permission map and one check), not as a tutor-only feature.

**Architecture:**
- A new `enrollment_grants` table links a grantee to an enrollment with a role.
- `domain/access.ts` maps roles to permissions. `services/access.ts` (`authorize`) is the one check, inside the use case's transaction.
- The acting user arrives as an asserted `X-Acting-User-Id` header, read only in `routes/actor.ts` on the server and only in `api/client.ts` in the app.
- `vocabulary_entries.added_by_user_id` records who added each sense.
- The app gains grants on the current user, an invite screen, invite cards, a students section, a tutor-mode lookup and labels.

**Tech Stack:**
- Server: TypeScript, Hono + `@hono/zod-openapi`, zod 4, Drizzle ORM on Postgres, Jest (unit and integration projects).
- App: Expo Router (Expo SDK 57, React Native).
- E2E: Playwright against the web export, with MockServer for Gemini.

**Spec:** `docs/superpowers/specs/2026-10-07-lang-tutor-phase-28-tutor-words-design.md`. Read it before any task. Decisions are cited as D1–D19.

## Global Constraints

- **Worktree only.** Work in `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-28-tutor-words`, with absolute paths.
  - Never `cd` to, read from, or write to `/Users/victorprp/git/lang-tutor` itself (the main checkout).
  - Use `git -C /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-28-tutor-words …` or run from inside the worktree.
- **This lane has its own ports and database** (slot 5, `lang_tutor_phase_28_tutor_words`).
  - Never hardcode a port or a database name (ADR 0006).
  - `npm run test:integration` and `npm run e2e` already go through `scripts/lane-env.sh`.
  - To run ONE integration file, from `apps/server`: `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath <file>`. Use the `=` form: `--selectProjects integration <file>` swallows the path and runs the whole suite.
- **Every ADR in `docs/adr/` binds.** `npm run lint:arch` must pass at the end of every task. In particular:
  - ADR 0001: services never import `db/` and import `repo/` as types only; routes never import `db/` or `repo/`; domain is pure.
  - ADR 0002: factories return closures, there is no `jest.mock`, and no module-level singleton.
  - ADR 0003: every endpoint is a `createRoute`, wire schemas live only in `packages/core/src/api/schemas.ts`, and `types.ts` only `z.infer`s.
  - ADR 0005: no credential code anywhere.
- **No `jest.mock`.** Fakes go through `tests/support/fakes.ts` (`createFakeTransaction`, `stub`) on the server, and through injected deps in the app.
- **App strings are Hebrew** and live in `apps/mobile/src/strings.ts` only. The exact strings are given in Task 8.
- **App Expo docs:** `apps/mobile/AGENTS.md` says to read https://docs.expo.dev/versions/v57.0.0/ before writing app code. Check any Expo Router API you have not seen in this repo (for example `useLocalSearchParams`) there.
- **Error bodies** are `{ error: string }`. New codes: `forbidden` (403), `grant not found` (404), `user not found` (404), and the 409 codes `not_learning`, `own_list` and `grant_exists`.
- **Header name:** `x-acting-user-id` on the server (Hono lowercases header names) and `X-Acting-User-Id` from the app.
- **The role literal `'tutor'`** appears in `apps/server/src` only in `domain/access.ts` and `db/schema.ts` (ADR 0008 R3). Everything else uses the exported `TUTOR` constant.
- **Commits:** conventional style as in `git log` (`feat(server): …`, `test(e2e): …`, `docs: …`). End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ak6dM6rXFB1JXPLx6dLbCZ
  ```

## Review Focus

1. **The student ends the link while the tutor has the words screen open.** The tutor's next add gets a 403. The app must show the existing "save failed" notice, not crash, and the student must disappear from the tutor's home on the next visit. Pinned by a service test in Task 4 (save after `end` is refused) and the hook behaviour in Task 10.
2. **A username typed with capitals or surrounding spaces** ("Victor ") must still find `victor`. The server's `UsernameSchema` is lowercase-only, so the app normalises before sending. Pinned by `normalizeUsername` in Task 8's `grants.test.ts`.
3. **The tutor flips the lookup to Hebrew → target.** Those senses belong to Hebrew lexemes and must show no add button, as a learner's reverse lookup shows no save button. Pinned by `addableStateOf` in Task 10.
4. **A double tap on Accept** sends two accepts. The second must answer 200 with the same accepted grant, not an error. Pinned by a service test in Task 5.
5. **A learner who is also a tutor.** Switching the active language must not hide their students or pending invites, and an account with an enrollment but no grants must never be sent to `/enroll`. Pinned by `needsEnrollScreen` tests in Task 8.

---

## File Structure

**packages/core**
- `src/api/schemas.ts`: `GrantStatusSchema`, `GrantSchema`, `GrantListSchema`, `CreateGrantRequestSchema` (Task 3); `added_by` on `VocabularyWordSchema` and `VocabularySenseSchema` (Task 6).
- `src/api/types.ts`, `src/api/index.ts`: the inferred types.

**apps/server**
- `src/db/schema.ts`: `enrollmentGrants`, `vocabularyEntries.addedByUserId` (Task 1).
- `src/db/migrations/0018_enrollment_grants.sql` and `meta/*`: generated, then hand-edited for the backfill (Task 1).
- `src/domain/access.ts` (+ `access.test.ts`): roles, permissions, `may`, `mayAnswerInvite`, `mayEndGrant`, `grantViewOf` (Task 2).
- `src/repo/grants.ts`: grant persistence (Task 3). `src/repo/enrollments.ts`: `findByUserAndTarget` (Task 3).
- `src/repo/vocabulary.ts`: `addedByUserId` on insert (Task 1); the label reads (Task 6).
- `src/services/access.ts`: `authorize` (Task 4). `src/services/grants.ts`: `createGrantService` (Task 5).
- `src/services/vocabulary.ts`: the actor on save and unsave (Task 4); the owner id passed to the label reads (Task 6).
- `src/services/transaction.ts`, `src/composition.ts`, `src/app.ts`: wiring (Tasks 3 and 5).
- `src/errors.ts`: `AccessDenied` (Task 4); `GrantNotFound`, `GrantExists`, `NotLearning`, `OwnList` (Tasks 3 and 5).
- `src/routes/actor.ts` (Task 4), `src/routes/grants.ts` (Task 5), `src/routes/vocabulary.ts` (Task 4).
- `src/domain/vocabulary.ts`: `addedBy` passed through (Task 6).
- `src/openapi.test.ts`: the paths, statuses and the header description (Tasks 4 and 5).
- `tests/support/*`: `seedGrant`, `sessionSenseEntries`, and the fake changes.

**docs and scripts**
- `docs/adr/adr-0008-access-grants.md`, `scripts/check-adr-0008-access-grants.sh` (Task 7).
- `docs/adr/adr-0005-identity-without-authentication.md` (status line), `docs/adr/adr-0002-di-with-closures.md` (R6 list) (Task 7).

**apps/mobile**
- `src/api/client.ts`: the actor header, the vocabulary writes taking the actor (Task 4), and the grant calls (Task 8).
- `src/grants.ts` (+ `grants.test.ts`): pure helpers (Task 8).
- `src/hooks/useApi.tsx`: `ApiProvider`/`useApi`, so a screen can nest a provider that needs `api` (Task 10).
- `src/hooks/useCurrentUser.tsx`: grants (Task 8).
- `src/hooks/useTranslation.tsx`, `src/hooks/useVocabulary.tsx`: the actor (Task 4); the `list` prop and tutor mode (Task 10).
- `src/vocabulary.ts`: `addableStateOf` (Task 10). `src/enrollments.ts`: `lookupDirection` takes a pair (Task 10).
- `src/components/LearningSection.tsx` (Task 9), `InvitesSection.tsx`, `StudentsSection.tsx` (Task 9), and `LookupPanel.tsx` (Task 10).
- `src/app/index.tsx`, `enroll.tsx` and `profile.tsx` (Task 9); `students/invite.tsx` (Task 9); `students/words.tsx` (Task 10); `translate.tsx` (Task 10); `vocabulary/index.tsx` and `vocabulary/word.tsx` (Task 11).
- `src/strings.ts` (Task 8).

**e2e**
- `e2e/tests/support/users.ts`: `createUser`, and a `landing` parameter on `logIn` (Task 12).
- `e2e/tests/tutor.spec.ts` (Task 12).

---

### Task 1: Data — the grants table, `added_by_user_id`, and every writer of entries

**Files:**
- Modify: `apps/server/src/db/schema.ts` (after `enrollments`, around line 87; `vocabularyEntries` around line 351)
- Create: `apps/server/src/db/migrations/0018_enrollment_grants.sql` (+ drizzle `meta/0018_snapshot.json`, `meta/_journal.json`)
- Modify: `apps/server/src/repo/vocabulary.ts` (`vocabularyQueries.insertEntries`, `insertEntries`)
- Modify: `apps/server/src/services/vocabulary.ts:77`
- Modify: `apps/server/tests/support/vocabularyRows.ts`, `apps/server/tests/support/progressRows.ts`
- Modify (every raw insert gains the column): `tests/integration/db/vocabulary.schema.test.ts`, `tests/integration/db/progress.schema.test.ts`, `tests/integration/db/progressRecompute.test.ts`, `tests/integration/repo/vocabulary.test.ts`, `tests/integration/repo/progress.test.ts`, `tests/integration/repo/vocabulary.plan.test.ts`
- Create: `apps/server/tests/integration/db/grants.schema.test.ts`
- Modify: `apps/server/tests/integration/db/migrations.test.ts` (new describe at the end)
- Create: `apps/server/tests/support/grantRows.ts`

**Interfaces:**
- Produces: the table `enrollment_grants` (`id`, `enrollment_id`, `owner_user_id`, `grantee_user_id`, `role`, `accepted_at`, `created_at`), and the drizzle export `enrollmentGrants`.
- Produces: `vocabulary_entries.added_by_user_id` (NOT NULL) and `vocabularyEntries.addedByUserId`.
- Produces: `VocabularyRepo.insertEntries(input: { enrollmentId: string; addedByUserId: string; entries: SaveableEntry[] }): Promise<void>`, and the same field on `vocabularyQueries.insertEntries`.
- Produces: `seedGrant(db, { id?, enrollmentId, ownerUserId, granteeUserId, accepted }): Promise<string>` in `tests/support/grantRows.ts`, which returns the grant id.
- Produces: `seedSavedSenses(db, { …, addedByUserId? })`. Without the field, the adder is the enrollment's owner.

- [ ] **Step 1: Write the failing schema test.** Create `apps/server/tests/integration/db/grants.schema.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_student'); // enrolled in English as e_u_student
  await seedUser(t.db, 'u_tutor');
});
afterEach(async () => {
  await t.close();
});

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

const grant = (over: { owner?: string; grantee?: string; enrollment?: string; role?: string } = {}) =>
  t.db.execute(sql`
    insert into enrollment_grants (enrollment_id, owner_user_id, grantee_user_id, role)
    values (${over.enrollment ?? enrollmentOf('u_student')}, ${over.owner ?? 'u_student'},
            ${over.grantee ?? 'u_tutor'}, ${over.role ?? 'tutor'})`);

describe('enrollment_grants', () => {
  it('accepts a pending tutor grant with a generated id', async () => {
    await grant();
    const rows = await t.db.execute<{ id: string; accepted_at: string | null }>(
      sql`select id, accepted_at from enrollment_grants`,
    );
    expect(rows.rows).toEqual([{ id: expect.any(String), accepted_at: null }]);
  });

  it('refuses a grant to the owner', async () => {
    await expect(grant({ grantee: 'u_student' })).rejects.toEqual(violating('enrollment_grants_not_owner'));
  });

  it('refuses an owner who does not own the enrollment', async () => {
    await expect(grant({ owner: 'u_tutor', grantee: 'u_student' })).rejects.toEqual(
      violating('enrollment_grants_enrollment_fk'),
    );
  });

  it('refuses a second grant to the same person on the same list', async () => {
    await grant();
    await expect(grant()).rejects.toEqual(violating('enrollment_grants_enrollment_grantee_key'));
  });

  it('refuses an unknown role', async () => {
    await expect(grant({ role: 'parent' })).rejects.toEqual(violating('enrollment_grants_role_known'));
  });
});

describe('vocabulary_entries.added_by_user_id', () => {
  it('is required, and must name a user', async () => {
    const kite = await insertLexeme(t.db, {
      lemma: 'kite',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'toy' }],
      variants: [
        {
          form: 'kite',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    const insert = (addedBy: string | null) =>
      t.db.execute(sql`
        insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, added_by_user_id)
        values (${enrollmentOf('u_student')}, ${kite.senseIds[0]}, ${kite.lexemeId}, 'kite', ${kite.variantIds[0]}, ${addedBy})`);
    await expect(insert(null)).rejects.toEqual(violating('added_by_user_id'));
    await expect(insert('u_nobody')).rejects.toEqual(violating('vocabulary_entries_added_by_fk'));
    await insert('u_tutor');
  });
});
```

- [ ] **Step 2: Run it and see it fail.** From `apps/server`: `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/db/grants.schema.test.ts`. Expected: FAIL with `relation "enrollment_grants" does not exist`.

- [ ] **Step 3: Add the table and column to `src/db/schema.ts`.**
  - Add `enrollmentGrants` directly after `enrollments` (the existing imports already include `foreignKey`, `unique`, `check`, `index`, `timestamp`, `text` and `sql`; check them).
  - In `vocabularyEntries`, add the column after `variantId`, and the FK after `vocabulary_entries_variant_fk`.

```ts
/**
 * Phase 28 (spec D1–D5). An access grant: someone other than an enrollment's
 * owner may act on it, as far as the grant's role allows. domain/access.ts maps
 * roles to permissions; services/access.ts is the one check (ADR 0008). The
 * grant names its TARGET, which is what a role column on users could not do
 * (phase 8, "Why `users` has no role column").
 *
 * accepted_at null is an invite. Declining, cancelling and ending all delete the
 * row: nothing reads an ended grant, and words a tutor added keep their label
 * through vocabulary_entries.added_by_user_id, not through this row.
 *
 * owner_user_id is the enrollment's user, held here only so the composite FK
 * into enrollments_user_id_id_key can prove it and the CHECK can compare it.
 * Read and written only by repo/grants.ts (ADR 0008 R1).
 */
export const enrollmentGrants = pgTable(
  'enrollment_grants',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    enrollmentId: text('enrollment_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    granteeUserId: text('grantee_user_id').notNull(),
    role: text('role').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'enrollment_grants_enrollment_fk',
      columns: [t.ownerUserId, t.enrollmentId],
      foreignColumns: [enrollments.userId, enrollments.id],
    }),
    foreignKey({ name: 'enrollment_grants_grantee_fk', columns: [t.granteeUserId], foreignColumns: [users.id] }),
    unique('enrollment_grants_enrollment_grantee_key').on(t.enrollmentId, t.granteeUserId),
    check('enrollment_grants_not_owner', sql`${t.granteeUserId} <> ${t.ownerUserId}`),
    check('enrollment_grants_role_known', sql`${t.role} in ('tutor')`),
    index('enrollment_grants_grantee_idx').on(t.granteeUserId),
    index('enrollment_grants_owner_idx').on(t.ownerUserId),
  ],
);
```

In `vocabularyEntries`:

```ts
    // Phase 28 (spec D5). Who put this sense in the list: the owner, or a
    // grantee such as a tutor. NOT NULL so no reader has to know that null
    // means "the owner"; the migration backfilled older rows to the owner.
    addedByUserId: text('added_by_user_id').notNull(),
```

```ts
    foreignKey({
      name: 'vocabulary_entries_added_by_fk',
      columns: [t.addedByUserId],
      foreignColumns: [users.id],
    }),
```

- [ ] **Step 4: Generate the migration, then make it backfill.** From `apps/server`: `npx drizzle-kit generate --name=enrollment_grants`. Expected: it creates `src/db/migrations/0018_enrollment_grants.sql` and `meta/0018_snapshot.json`, and appends `0018_enrollment_grants` to `meta/_journal.json`. Open the SQL. Drizzle writes `ALTER TABLE "vocabulary_entries" ADD COLUMN "added_by_user_id" text NOT NULL;`, which fails on existing rows. Replace that one statement with these three, keeping drizzle's `--> statement-breakpoint` separators, and put this comment at the top of the file:

```sql
-- Phase 28. Access grants (ADR 0008), and who added each saved sense. Rows saved
-- before this phase were all saved by their list's owner, so the backfill is exact.
```

```sql
ALTER TABLE "vocabulary_entries" ADD COLUMN "added_by_user_id" text;--> statement-breakpoint
UPDATE "vocabulary_entries" ve SET "added_by_user_id" = e."user_id" FROM "enrollments" e WHERE e."id" = ve."enrollment_id";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ALTER COLUMN "added_by_user_id" SET NOT NULL;--> statement-breakpoint
```

Leave the rest of drizzle's output as it is: the CREATE TABLE, the constraints, the FKs and the indexes. Run `npx drizzle-kit check` from `apps/server`. Expected: no errors.

- [ ] **Step 5: Run the schema test.** Same command as Step 2. Expected: PASS for the `enrollment_grants` describe. The `added_by_user_id` case also passes once the migration is applied (`createTestDb` migrates from the folder).

- [ ] **Step 6: Write the migration backfill test.** Append to `tests/integration/db/migrations.test.ts`, using the helpers already at the top of that file (`emptyDatabase`, `runMigrationsFrom`, `migrationsUpTo`, `runMigrations`, `sql`):

```ts
// Phase 28: every entry saved before 0018 was saved by its list's owner.
describe('0018_enrollment_grants', () => {
  it("backfills added_by_user_id to the list's owner", async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0017_speaking_cards'));
    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he'), ('u_2', 'u_2', 'two', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en'), ('e_2', 'u_2', 'he', 'en');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('l1', 'en', 'kite', 'noun');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s1', 'l1', 'toy');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v1', 'l1', 'en', 'kite', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v1', 's1', 'he', 'עפיפון', 0);
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id)
        values ('e_1', 's1', 'l1', 'kite', 'v1'), ('e_2', 's1', 'l1', 'kite', 'v1');
    `);

    await runMigrations(db);

    const rows = await db.execute<{ enrollment_id: string; added_by_user_id: string }>(
      sql`select enrollment_id, added_by_user_id from vocabulary_entries order by enrollment_id`,
    );
    expect(rows.rows).toEqual([
      { enrollment_id: 'e_1', added_by_user_id: 'u_1' },
      { enrollment_id: 'e_2', added_by_user_id: 'u_2' },
    ]);
  });
});
```

If a table in the `insert` block has more required columns at `0017` than shown, read the `0017_speaking_cards` describe just above it in the same file, which inserts the same rows, and match it.

- [ ] **Step 7: Run it.** `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/db/migrations.test.ts`. Expected: PASS, including the new describe.

- [ ] **Step 8: Make `insertEntries` take the adder.** In `src/repo/vocabulary.ts`, change both `vocabularyQueries.insertEntries` and the repo's `insertEntries` to `input: { enrollmentId: string; addedByUserId: string; entries: SaveableEntry[] }`. Change the statement to:

```ts
      INSERT INTO vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, added_by_user_id)
      VALUES ${sql.join(
        input.entries.map(
          (e) =>
            sql`(${input.enrollmentId}, ${e.senseId}, ${e.lexemeId}, ${e.lemma}, ${e.variantId}, ${input.addedByUserId})`,
        ),
        sql`, `,
      )}
```

Add one sentence to the builder's doc comment: "First adder wins, exactly as first form does: the conflict keeps the row, its form and its adder (spec D5)."

- [ ] **Step 9: Keep the service compiling, with the owner as adder for now.** In `src/services/vocabulary.ts`, the call becomes:

```ts
        await repos.vocabulary.insertEntries({ enrollmentId, addedByUserId: enrolled.user_id, entries: saveable });
```

Task 4 replaces `enrolled.user_id` with the actor.

- [ ] **Step 10: Add the test seed helpers, and give every test writer the column.**
  - Create `tests/support/grantRows.ts`:

```ts
import { sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';

/**
 * A grant written directly. tests/support/ is the test composition root, so it
 * may name enrollment_grants (ADR 0008 R1 scans apps/server/src only). Tests
 * about what a grant ALLOWS need one without driving invite and accept.
 */
export async function seedGrant(
  db: Db,
  input: { id?: string; enrollmentId: string; ownerUserId: string; granteeUserId: string; accepted: boolean },
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into enrollment_grants (id, enrollment_id, owner_user_id, grantee_user_id, role, accepted_at)
    values (coalesce(${input.id ?? null}, gen_random_uuid()::text), ${input.enrollmentId}, ${input.ownerUserId},
            ${input.granteeUserId}, 'tutor', ${input.accepted ? sql`now()` : sql`null`})
    returning id`);
  return rows.rows[0].id;
}
```

  - `tests/support/vocabularyRows.ts`, in `seedSavedSenses`:
    - Add `addedByUserId?: string` to the input type.
    - Before the insert, resolve the adder: `const addedByUserId = input.addedByUserId ?? (await ownerOf(db, input.enrollmentId));`, with a local helper:

```ts
async function ownerOf(db: Db, enrollmentId: string): Promise<string> {
  const rows = await db.execute<{ user_id: string }>(sql`select user_id from enrollments where id = ${enrollmentId}`);
  if (rows.rows.length === 0) throw new Error(`seedSavedSenses: no enrollment ${enrollmentId}`);
  return rows.rows[0].user_id;
}
```

    - Then pass `addedByUserId` to `insertEntries`, and import `sql` from `drizzle-orm`.
  - `tests/support/progressRows.ts`, in `saveSessionSenses` (around line 125): resolve the owner the same way (copy `ownerOf`, or export it from `vocabularyRows.ts` and import it), and pass `addedByUserId`.
  - Every raw `insert into vocabulary_entries (…)` in the six test files listed under **Files** gains `added_by_user_id` with the enrollment owner's id. Each file seeds its user with `seedUser(t.db, 'u_1')`, whose enrollment is `e_u_1`, so the value is `'u_1'` unless the file inserts for another enrollment. Read each insert and use the owner of the enrollment it names.
  - In `tests/integration/repo/vocabulary.plan.test.ts`, the volume inserts use `generate_series` or similar. Add the column with the same owner literal.
  - Every `insertEntries({ enrollmentId: E, entries })` call in `tests/integration/repo/vocabulary.test.ts` and in `vocabulary.plan.test.ts` gains `addedByUserId: '<owner of E>'`.

- [ ] **Step 11: Typecheck and run the affected suites.** From the worktree root: `npm run typecheck`. Expected: no errors. Then, from `apps/server`: `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/db tests/integration/repo tests/integration/services tests/integration/routes tests/integration/jobs`. Expected: all PASS. If `--runTestsByPath` refuses directories, run `npm run test:integration` from the root instead.

- [ ] **Step 12: Run the unit tests and the architecture check.** From the root: `npm test && npm run lint:arch`. Expected: PASS.

- [ ] **Step 13: Commit.**

```bash
git add apps/server/src/db apps/server/src/repo/vocabulary.ts apps/server/src/services/vocabulary.ts apps/server/tests
git commit -m "feat(server): enrollment_grants, and who added each saved sense" -m "<attribution lines from Global Constraints>"
```

---

### Task 2: `domain/access.ts` — roles, permissions, the rule

**Files:**
- Create: `apps/server/src/domain/access.ts`
- Create: `apps/server/src/domain/access.test.ts`

**Interfaces:**
- Consumes: `Grant` from `@lang-tutor/core/api`. If Task 3 has not landed yet, type `grantViewOf`'s parameter structurally, as shown below, so this task does not depend on Task 3.
- Produces:

```ts
export const PERMISSIONS: readonly ['vocabulary.add', 'vocabulary.remove'];
export type Permission = 'vocabulary.add' | 'vocabulary.remove';
export const ROLES: readonly ['tutor'];
export type Role = 'tutor';
export const TUTOR: Role;
export type GrantView = { ownerUserId: string; granteeUserId: string; role: string; accepted: boolean };
export function isRole(value: string): value is Role;
export function may(actorUserId: string, ownerUserId: string, grant: GrantView | null, permission: Permission): boolean;
export function mayAnswerInvite(actorUserId: string, grant: GrantView): boolean;
export function mayEndGrant(actorUserId: string, grant: GrantView): boolean;
export function grantViewOf(grant: { owner: { id: string }; grantee: { id: string }; role: string; status: string }): GrantView;
```

- [ ] **Step 1: Write the failing test** `src/domain/access.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { PERMISSIONS, grantViewOf, isRole, may, mayAnswerInvite, mayEndGrant, type GrantView } from './access';

const OWNER = 'u_student';
const TUTOR_ID = 'u_tutor';
const STRANGER = 'u_stranger';
const accepted: GrantView = { ownerUserId: OWNER, granteeUserId: TUTOR_ID, role: 'tutor', accepted: true };
const pending: GrantView = { ...accepted, accepted: false };

describe('may', () => {
  it.each(PERMISSIONS)('lets the owner %s on their own list, with or without a grant', (permission) => {
    expect(may(OWNER, OWNER, null, permission)).toBe(true);
    expect(may(OWNER, OWNER, accepted, permission)).toBe(true);
  });

  it('lets an accepted tutor add words and nothing else', () => {
    expect(may(TUTOR_ID, OWNER, accepted, 'vocabulary.add')).toBe(true);
    expect(may(TUTOR_ID, OWNER, accepted, 'vocabulary.remove')).toBe(false);
  });

  it.each(PERMISSIONS)('refuses a pending tutor %s', (permission) => {
    expect(may(TUTOR_ID, OWNER, pending, permission)).toBe(false);
  });

  it.each(PERMISSIONS)('refuses %s to someone holding no grant', (permission) => {
    expect(may(STRANGER, OWNER, null, permission)).toBe(false);
  });

  it("refuses an actor presenting someone else's grant", () => {
    expect(may(STRANGER, OWNER, accepted, 'vocabulary.add')).toBe(false);
  });

  it('refuses a role this server does not know', () => {
    expect(may(TUTOR_ID, OWNER, { ...accepted, role: 'parent' }, 'vocabulary.add')).toBe(false);
  });
});

describe('isRole', () => {
  it('knows tutor and nothing else', () => {
    expect(isRole('tutor')).toBe(true);
    expect(isRole('parent')).toBe(false);
  });
});

describe('mayAnswerInvite', () => {
  it('is the owner only', () => {
    expect(mayAnswerInvite(OWNER, pending)).toBe(true);
    expect(mayAnswerInvite(TUTOR_ID, pending)).toBe(false);
    expect(mayAnswerInvite(STRANGER, pending)).toBe(false);
  });
});

describe('mayEndGrant', () => {
  it('is either party, and nobody else', () => {
    expect(mayEndGrant(OWNER, accepted)).toBe(true);
    expect(mayEndGrant(TUTOR_ID, accepted)).toBe(true);
    expect(mayEndGrant(STRANGER, accepted)).toBe(false);
  });
});

describe('grantViewOf', () => {
  it('reads the parties, the role and acceptance off a wire grant', () => {
    expect(
      grantViewOf({ owner: { id: OWNER }, grantee: { id: TUTOR_ID }, role: 'tutor', status: 'pending' }),
    ).toEqual(pending);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** From `apps/server`: `npx jest --selectProjects=unit --runTestsByPath src/domain/access.test.ts`. Expected: FAIL, `Cannot find module './access'`.

- [ ] **Step 3: Implement** `src/domain/access.ts`:

```ts
/**
 * Phase 28 (spec D6, ADR 0008). Who may do what to an enrollment.
 *
 * A grant gives its grantee a ROLE on one enrollment; a role names a set of
 * PERMISSIONS, here and nowhere else. A later permission (tutors read progress)
 * is one entry in PERMISSIONS and one in the role's list, plus a call to
 * services/access.ts authorize() in the use case that needs it: no migration, and
 * no grant changes. The owner may do anything with their own list.
 *
 * Pure (ADR 0001 R3). The actor is ASSERTED until login exists (ADR 0008 R5):
 * this is a correctness boundary for an honest client, not a security one.
 */

export const PERMISSIONS = ['vocabulary.add', 'vocabulary.remove'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['tutor'] as const;
export type Role = (typeof ROLES)[number];

/** The one role this phase grants. Everything outside this file and the schema
 *  names it through this constant (ADR 0008 R3). */
export const TUTOR: Role = 'tutor';

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  tutor: ['vocabulary.add'],
};

/** What the rule needs to know about a grant, whatever shape it was read in. */
export type GrantView = { ownerUserId: string; granteeUserId: string; role: string; accepted: boolean };

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The owner may do anything; anyone else needs an ACCEPTED grant of their own
 *  whose role includes the permission. A pending grant allows nothing. */
export function may(
  actorUserId: string,
  ownerUserId: string,
  grant: GrantView | null,
  permission: Permission,
): boolean {
  if (actorUserId === ownerUserId) return true;
  if (!grant || !grant.accepted || grant.granteeUserId !== actorUserId) return false;
  return isRole(grant.role) && ROLE_PERMISSIONS[grant.role].includes(permission);
}

/** An invite is the list owner's to accept or decline. */
export function mayAnswerInvite(actorUserId: string, grant: GrantView): boolean {
  return actorUserId === grant.ownerUserId;
}

/** Either party may end a grant: the owner declines or ends it, the grantee
 *  cancels an invite or stops (spec D4). */
export function mayEndGrant(actorUserId: string, grant: GrantView): boolean {
  return actorUserId === grant.ownerUserId || actorUserId === grant.granteeUserId;
}

/** A wire Grant (packages/core GrantSchema) as the rule sees it. Structural, so
 *  domain/ needs nothing but the shape. */
export function grantViewOf(grant: {
  owner: { id: string };
  grantee: { id: string };
  role: string;
  status: string;
}): GrantView {
  return {
    ownerUserId: grant.owner.id,
    granteeUserId: grant.grantee.id,
    role: grant.role,
    accepted: grant.status === 'accepted',
  };
}
```

- [ ] **Step 4: Run it.** Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Lint and commit.** From the root: `npm run lint:arch`. Expected: PASS (domain imports nothing).

```bash
git add apps/server/src/domain/access.ts apps/server/src/domain/access.test.ts
git commit -m "feat(server): roles, permissions and the access rule, pure" -m "<attribution>"
```

---

### Task 3: Core grant schemas and `repo/grants.ts`

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (after `EnrollmentListSchema`, around line 419)
- Modify: `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Create: `apps/server/src/repo/grants.ts`
- Modify: `apps/server/src/repo/enrollments.ts` (add `findByUserAndTarget`)
- Modify: `apps/server/src/errors.ts` (add `GrantExists`)
- Modify: `apps/server/src/services/transaction.ts` (`Repos.grant`), `apps/server/src/composition.ts` (bind it), `apps/server/tests/support/fakes.ts` (`createFakeTransaction` gains `grant`)
- Create: `apps/server/tests/integration/repo/grants.test.ts`
- Modify: `apps/server/tests/integration/repo/enrollments.test.ts`

**Interfaces:**
- Consumes: `enrollmentGrants`, `enrollments` and `users` from `db/schema.ts` (Task 1), and `GrantView` from `domain/access.ts` (Task 2).
- Produces (core):

```ts
export const GrantStatusSchema = z.enum(['pending', 'accepted']);
export const GrantSchema: z.ZodObject<{ id; role: string; status; enrollment: { id; source_language; target_language }; owner: { id; username; display_name }; grantee: { id; username; display_name }; created_at: string; accepted_at: string | null }>;
export const GrantListSchema = z.object({ tutors: z.array(GrantSchema), students: z.array(GrantSchema) });
export const CreateGrantRequestSchema = z.object({ username: UsernameSchema, target_language: LanguageCodeSchema });
// types: Grant, GrantList, CreateGrantRequest
```

- Produces (server): `createGrantRepo(tx)`, `type GrantRepo` with:

```ts
insertGrant(input: { enrollmentId: string; ownerUserId: string; granteeUserId: string; role: string }): Promise<Grant>  // throws GrantExists on the unique key
findGrant(id: string): Promise<Grant | undefined>
findGrantFor(input: { enrollmentId: string; granteeUserId: string }): Promise<GrantView | null>
acceptGrant(id: string): Promise<void>        // sets accepted_at once; a second call changes nothing
deleteGrant(id: string): Promise<void>
listForOwner(userId: string): Promise<Grant[]>    // grants ON the user's lists, newest first
listForGrantee(userId: string): Promise<Grant[]>  // grants the user HOLDS, newest first
```

- Produces: `EnrollmentRepo.findByUserAndTarget(userId: string, targetLanguage: string): Promise<Enrollment | undefined>`.
- Produces: `class GrantExists extends Error { constructor(readonly enrollmentId: string, readonly granteeUserId: string) }`.

- [ ] **Step 1: Add the core schemas.** In `packages/core/src/api/schemas.ts`, after `EnrollmentListSchema`:

```ts
// Phase 28 (spec D9). An access grant: the grantee may act on the owner's
// enrollment, as far as the role allows. `role` is a plain string for the reason
// UserSchema's language fields are — a later role must not fail validation in a
// client that shipped before it.
export const GrantStatusSchema = z.enum(['pending', 'accepted']);

const GrantPartySchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
});

export const GrantSchema = z.object({
  id: z.string(),
  role: z.string(),
  status: GrantStatusSchema,
  enrollment: z.object({
    id: z.string(),
    source_language: z.string(),
    target_language: z.string(),
  }),
  // The student, whose list it is.
  owner: GrantPartySchema,
  // The tutor.
  grantee: GrantPartySchema,
  created_at: z.string(),
  accepted_at: z.string().nullable(),
});

// Both sides of one account: grants ON its lists (its tutors, and invites to
// answer) and grants it HOLDS (its students). Newest first in each.
export const GrantListSchema = z.object({
  tutors: z.array(GrantSchema),
  students: z.array(GrantSchema),
});

// The tutor names the student and the language they teach. The grant goes on the
// student's enrollment in that language, which must exist (spec D3).
export const CreateGrantRequestSchema = z.object({
  username: UsernameSchema,
  target_language: LanguageCodeSchema,
});
```

In `types.ts`, follow the file's existing pattern (`export type Enrollment = z.infer<typeof EnrollmentSchema>;`) and add `Grant`, `GrantList` and `CreateGrantRequest`, importing the schemas the way the file already does. In `index.ts`, add the three names to its `export type { … }` list.

- [ ] **Step 2: Write the failing repo test.** Create `apps/server/tests/integration/repo/grants.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { GrantExists } from '../../../src/errors';
import { createGrantRepo } from '../../../src/repo/grants';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_student'); // English
const RU = 'e_student_ru';

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_student');
  await seedUser(t.db, 'u_tutor');
  await seedEnrollment(t.db, { id: RU, userId: 'u_student', targetLanguage: 'ru' });
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createGrantRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createGrantRepo(tx)));

const invite = (enrollmentId = E) =>
  repo((r) => r.insertGrant({ enrollmentId, ownerUserId: 'u_student', granteeUserId: 'u_tutor', role: 'tutor' }));

describe('grants repository', () => {
  it('inserts a pending grant and returns it in wire shape', async () => {
    const grant = await invite();
    expect(grant).toEqual({
      id: expect.any(String),
      role: 'tutor',
      status: 'pending',
      enrollment: { id: E, source_language: 'he', target_language: 'en' },
      owner: { id: 'u_student', username: 'u_student', display_name: 'test u_student' },
      grantee: { id: 'u_tutor', username: 'u_tutor', display_name: 'test u_tutor' },
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      accepted_at: null,
    });
    expect(await repo((r) => r.findGrant(grant.id))).toEqual(grant);
  });

  it('throws GrantExists for a second grant to the same person on the same list', async () => {
    await invite();
    await expect(invite()).rejects.toBeInstanceOf(GrantExists);
  });

  it('allows the same tutor on another of the student’s lists', async () => {
    await invite();
    await expect(invite(RU)).resolves.toMatchObject({ enrollment: { id: RU } });
  });

  it('accepts once: a second accept keeps the first time', async () => {
    const grant = await invite();
    await repo((r) => r.acceptGrant(grant.id));
    const first = await repo((r) => r.findGrant(grant.id));
    await repo((r) => r.acceptGrant(grant.id));
    const second = await repo((r) => r.findGrant(grant.id));
    expect(first).toMatchObject({ status: 'accepted', accepted_at: expect.stringMatching(/^\d{4}-/) });
    expect(second!.accepted_at).toBe(first!.accepted_at);
  });

  it('finds the view the check needs, and null when there is no grant', async () => {
    const grant = await invite();
    expect(await repo((r) => r.findGrantFor({ enrollmentId: E, granteeUserId: 'u_tutor' }))).toEqual({
      ownerUserId: 'u_student',
      granteeUserId: 'u_tutor',
      role: 'tutor',
      accepted: false,
    });
    await repo((r) => r.acceptGrant(grant.id));
    expect(await repo((r) => r.findGrantFor({ enrollmentId: E, granteeUserId: 'u_tutor' }))).toMatchObject({
      accepted: true,
    });
    expect(await repo((r) => r.findGrantFor({ enrollmentId: RU, granteeUserId: 'u_tutor' }))).toBeNull();
  });

  it('lists grants both ways, newest first', async () => {
    const older = await invite();
    await t.db.execute(sql`update enrollment_grants set created_at = now() - interval '1 hour' where id = ${older.id}`);
    const newer = await invite(RU);
    expect((await repo((r) => r.listForOwner('u_student'))).map((g) => g.id)).toEqual([newer.id, older.id]);
    expect((await repo((r) => r.listForGrantee('u_tutor'))).map((g) => g.id)).toEqual([newer.id, older.id]);
    expect(await repo((r) => r.listForOwner('u_tutor'))).toEqual([]);
    expect(await repo((r) => r.listForGrantee('u_student'))).toEqual([]);
  });

  it('deletes a grant, and deleting it again is a no-op', async () => {
    const grant = await invite();
    await repo((r) => r.deleteGrant(grant.id));
    await repo((r) => r.deleteGrant(grant.id));
    expect(await repo((r) => r.findGrant(grant.id))).toBeUndefined();
  });
});
```

Add to `tests/integration/repo/enrollments.test.ts`:

```ts
  it('finds an enrollment by its learner and target, and nothing for another target', async () => {
    const ru = await repo((r) => r.insertEnrollment({ userId: 'u_1', sourceLanguage: 'he', targetLanguage: 'ru' }));
    expect(await repo((r) => r.findByUserAndTarget('u_1', 'ru'))).toEqual(ru);
    expect(await repo((r) => r.findByUserAndTarget('u_1', 'it'))).toBeUndefined();
    expect(await repo((r) => r.findByUserAndTarget('u_2', 'ru'))).toBeUndefined();
  });
```

- [ ] **Step 3: Run them and see them fail.** From `apps/server`: `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/repo/grants.test.ts tests/integration/repo/enrollments.test.ts`. Expected: FAIL, `Cannot find module '../../../src/repo/grants'`.

- [ ] **Step 4: Add `GrantExists` to `src/errors.ts`,** after `AlreadyEnrolled`, in the file's style:

```ts
/** Phase 28. This person already holds a grant on this list, pending or accepted. */
export class GrantExists extends Error {
  constructor(
    readonly enrollmentId: string,
    readonly granteeUserId: string,
  ) {
    super(`${granteeUserId} already holds a grant on ${enrollmentId}`);
    this.name = 'GrantExists';
  }
}
```

- [ ] **Step 5: Implement `src/repo/grants.ts`:**

```ts
import type { Grant } from '@lang-tutor/core/api';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Tx } from '../db/client';
import { enrollmentGrants, enrollments, users } from '../db/schema';
import type { GrantView } from '../domain/access';
import { GrantExists } from '../errors';
import { isUniqueViolation } from './pgErrors';

const owner = alias(users, 'owner');
const grantee = alias(users, 'grantee');

/** Every grant read joins its enrollment and both parties, so the wire shape is
 *  built in one place. */
function selectGrants(tx: Tx) {
  return tx
    .select({
      id: enrollmentGrants.id,
      role: enrollmentGrants.role,
      acceptedAt: enrollmentGrants.acceptedAt,
      createdAt: enrollmentGrants.createdAt,
      enrollmentId: enrollments.id,
      sourceLanguage: enrollments.sourceLanguage,
      targetLanguage: enrollments.targetLanguage,
      ownerId: owner.id,
      ownerUsername: owner.username,
      ownerDisplayName: owner.displayName,
      granteeId: grantee.id,
      granteeUsername: grantee.username,
      granteeDisplayName: grantee.displayName,
    })
    .from(enrollmentGrants)
    .innerJoin(enrollments, eq(enrollments.id, enrollmentGrants.enrollmentId))
    .innerJoin(owner, eq(owner.id, enrollmentGrants.ownerUserId))
    .innerJoin(grantee, eq(grantee.id, enrollmentGrants.granteeUserId));
}

type GrantSelectRow = Awaited<ReturnType<typeof selectGrants>>[number];

function toGrant(row: GrantSelectRow): Grant {
  return {
    id: row.id,
    role: row.role,
    status: row.acceptedAt ? 'accepted' : 'pending',
    enrollment: { id: row.enrollmentId, source_language: row.sourceLanguage, target_language: row.targetLanguage },
    owner: { id: row.ownerId, username: row.ownerUsername, display_name: row.ownerDisplayName },
    grantee: { id: row.granteeId, username: row.granteeUsername, display_name: row.granteeDisplayName },
    created_at: row.createdAt.toISOString(),
    accepted_at: row.acceptedAt ? row.acceptedAt.toISOString() : null,
  };
}

/**
 * Phase 28. The only reader and writer of enrollment_grants (ADR 0008 R1).
 * Primitives only (ADR 0001 R9): who may do what is domain/access.ts, and the
 * check is services/access.ts.
 */
export function createGrantRepo(tx: Tx) {
  const findGrant = async (id: string): Promise<Grant | undefined> => {
    const [row] = await selectGrants(tx).where(eq(enrollmentGrants.id, id));
    return row ? toGrant(row) : undefined;
  };

  return {
    /** Inserts optimistically and lets the unique key decide, as insertEnrollment
     *  does: a check-then-insert races a double tap. */
    insertGrant: async (input: {
      enrollmentId: string;
      ownerUserId: string;
      granteeUserId: string;
      role: string;
    }): Promise<Grant> => {
      let id: string;
      try {
        const [row] = await tx
          .insert(enrollmentGrants)
          .values({
            enrollmentId: input.enrollmentId,
            ownerUserId: input.ownerUserId,
            granteeUserId: input.granteeUserId,
            role: input.role,
          })
          .returning({ id: enrollmentGrants.id });
        id = row.id;
      } catch (error) {
        if (isUniqueViolation(error)) throw new GrantExists(input.enrollmentId, input.granteeUserId);
        throw error;
      }
      return (await findGrant(id))!;
    },

    findGrant,

    /** What authorize() needs: the actor's own grant on one list, if any. Served by
     *  enrollment_grants_enrollment_grantee_key. */
    findGrantFor: async (input: { enrollmentId: string; granteeUserId: string }): Promise<GrantView | null> => {
      const [row] = await tx
        .select({
          ownerUserId: enrollmentGrants.ownerUserId,
          granteeUserId: enrollmentGrants.granteeUserId,
          role: enrollmentGrants.role,
          acceptedAt: enrollmentGrants.acceptedAt,
        })
        .from(enrollmentGrants)
        .where(
          and(
            eq(enrollmentGrants.enrollmentId, input.enrollmentId),
            eq(enrollmentGrants.granteeUserId, input.granteeUserId),
          ),
        );
      return row
        ? { ownerUserId: row.ownerUserId, granteeUserId: row.granteeUserId, role: row.role, accepted: row.acceptedAt !== null }
        : null;
    },

    /** Sets accepted_at once. A second accept finds no pending row and changes
     *  nothing, so a double tap keeps the first time. */
    acceptGrant: async (id: string): Promise<void> => {
      await tx
        .update(enrollmentGrants)
        .set({ acceptedAt: sql`now()` })
        .where(and(eq(enrollmentGrants.id, id), isNull(enrollmentGrants.acceptedAt)));
    },

    deleteGrant: async (id: string): Promise<void> => {
      await tx.delete(enrollmentGrants).where(eq(enrollmentGrants.id, id));
    },

    listForOwner: async (userId: string): Promise<Grant[]> =>
      (
        await selectGrants(tx)
          .where(eq(enrollmentGrants.ownerUserId, userId))
          .orderBy(desc(enrollmentGrants.createdAt), desc(enrollmentGrants.id))
      ).map(toGrant),

    listForGrantee: async (userId: string): Promise<Grant[]> =>
      (
        await selectGrants(tx)
          .where(eq(enrollmentGrants.granteeUserId, userId))
          .orderBy(desc(enrollmentGrants.createdAt), desc(enrollmentGrants.id))
      ).map(toGrant),
  };
}

export type GrantRepo = ReturnType<typeof createGrantRepo>;
```

Add `sql` to the `drizzle-orm` import. The clock stays in Postgres, matching `created_at`'s `defaultNow()`.

- [ ] **Step 6: Add `findByUserAndTarget` to `src/repo/enrollments.ts`:**

```ts
    /** Phase 28. The enrollment a tutor's invite names: UNIQUE(user_id, target_language). */
    findByUserAndTarget: async (userId: string, targetLanguage: string): Promise<Enrollment | undefined> => {
      const [row] = await tx
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.userId, userId), eq(enrollments.targetLanguage, targetLanguage)));
      return row ? toEnrollment(row) : undefined;
    },
```

(add `and` to the drizzle import.)

- [ ] **Step 7: Wire `Repos.grant`.**
  - `src/services/transaction.ts`: `import type { GrantRepo } from '../repo/grants';`, then add `grant: GrantRepo;` to `Repos`.
  - `src/composition.ts`: import `createGrantRepo`, and add `grant: createGrantRepo(tx),` to the bound repos.
  - `tests/support/fakes.ts` `createFakeTransaction`: add `grant: repos.grant ?? unreachableRepo('grant repo'),`.

- [ ] **Step 8: Run the tests.** Same command as Step 3. Expected: PASS. Then from the root run `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add packages/core/src/api apps/server/src/repo apps/server/src/errors.ts apps/server/src/services/transaction.ts apps/server/src/composition.ts apps/server/tests
git commit -m "feat(server): grants on the wire and in the database" -m "<attribution>"
```

---

### Task 4: The actor header and the one check, on the vocabulary writes

**Files:**
- Create: `apps/server/src/routes/actor.ts`
- Create: `apps/server/src/services/access.ts`
- Modify: `apps/server/src/errors.ts` (add `AccessDenied`)
- Modify: `apps/server/src/services/vocabulary.ts` (`save`, `unsave`)
- Modify: `apps/server/src/routes/vocabulary.ts` (headers, 403)
- Modify: `apps/server/src/openapi.test.ts`
- Modify: `apps/server/tests/integration/routes/vocabulary.test.ts`
- Create: `apps/server/tests/integration/services/vocabulary.access.test.ts`
- Modify: `apps/server/tests/integration/services/sessions.test.ts` (done-means 2)
- Modify: `apps/server/tests/support/progressRows.ts` (`sessionSenseEntries`)
- Modify: `apps/mobile/src/api/client.ts`, `apps/mobile/src/api/client.test.ts`, `apps/mobile/src/hooks/useVocabulary.tsx`, `apps/mobile/src/hooks/useTranslation.tsx`

**Interfaces:**
- Consumes: `may` and `Permission` (Task 2); `Repos.grant.findGrantFor` (Task 3); `seedGrant` (Task 1).
- Produces (server):

```ts
// routes/actor.ts
export const ACTOR_HEADER = 'x-acting-user-id';
export const ActorHeadersSchema: z.ZodObject<{ 'x-acting-user-id': z.ZodString }>;
export function actorOf(headers: { 'x-acting-user-id': string }): string;
// services/access.ts
export async function authorize(repos: Repos, logger: Logger, input: { actorUserId: string; enrollment: Enrollment; permission: Permission }): Promise<'owner' | 'grantee'>;
// errors.ts
export class AccessDenied extends Error { constructor(readonly actorUserId: string, readonly enrollmentId: string, readonly action: string) }
// services/vocabulary.ts
save(actorUserId: string, enrollmentId: string, entries: VocabularyEntryInput[]): Promise<SaveVocabularyResponse>;
unsave(actorUserId: string, enrollmentId: string, senseId: string): Promise<void>;
```

- Produces (mobile): `saveVocabulary(actorUserId, enrollmentId, request)` and `unsaveVocabulary(actorUserId, enrollmentId, senseId)`. Internally, `postJson(path, body, options?: { signal?: AbortSignal; actorUserId?: string })`, `getJson(path, actorUserId?)` and `deleteResource(path, actorUserId?)`.

- [ ] **Step 1: Write the failing service test.** Create `apps/server/tests/integration/services/vocabulary.access.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AccessDenied } from '../../../src/errors';
import type { VocabularyService } from '../../../src/services/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { seedGrant } from '../../support/grantRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 28 (spec D6–D8). Who may write to a list. The owner always; a tutor with
// an accepted grant may add and never remove; nobody else may do either.

let t: TestDb;
let logger: FakeLogger;
let vocabulary: VocabularyService;
const E = enrollmentOf('u_student'); // English
const RU = 'e_student_ru';

let kite: { senseIds: string[]; variantIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  await seedUser(t.db, 'u_student');
  await seedUser(t.db, 'u_tutor');
  await seedUser(t.db, 'u_stranger');
  await seedEnrollment(t.db, { id: RU, userId: 'u_student', targetLanguage: 'ru' });
  vocabulary = createTestServerDeps({ db: t.db, logger, rng: testRng(7) }).vocabulary;
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [{ senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null }],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

const entry = () => [{ sense_id: kite.senseIds[0], variant_id: kite.variantIds[0] }];
```

Change that file's `seedGrant` import to `import { addedByOf, seedGrant } from '../../support/grantRows';`. Then add `addedByOf` to `tests/support/grantRows.ts`. `tests/integration/services/` may NOT import `drizzle-orm` (ADR 0001 R2's test rule), so raw reads go through the test composition root:

```ts
/** Who added each saved sense of one list, in sense order. */
export async function addedByOf(db: Db, enrollmentId: string): Promise<string[]> {
  const rows = await db.execute<{ added_by_user_id: string }>(
    sql`select added_by_user_id from vocabulary_entries where enrollment_id = ${enrollmentId} order by sense_id`,
  );
  return rows.rows.map((row) => row.added_by_user_id);
}
```

Then the cases:

```ts
describe('save', () => {
  it('lets the owner save, recorded as theirs', async () => {
    await vocabulary.save('u_student', E, entry());
    expect(await addedByOf(t.db, E)).toEqual(['u_student']);
  });

  it('lets an accepted tutor add, recorded as the tutor’s', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_tutor', E, entry());
    expect(await addedByOf(t.db, E)).toEqual(['u_tutor']);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'vocabulary_saved', by: 'grantee' }));
  });

  it.each([
    ['a pending tutor', 'u_tutor', { enrollment: E, accepted: false }],
    ['a tutor of the student’s other language', 'u_tutor', { enrollment: RU, accepted: true }],
    ['a stranger', 'u_stranger', null],
  ] as const)('refuses %s and writes nothing', async (_who, actor, held) => {
    if (held) {
      await seedGrant(t.db, { enrollmentId: held.enrollment, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: held.accepted });
    }
    await expect(vocabulary.save(actor, E, entry())).rejects.toBeInstanceOf(AccessDenied);
    expect(await addedByOf(t.db, E)).toEqual([]);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'access_denied', enrollment_id: E, permission: 'vocabulary.add' }),
    );
  });

  it('keeps the first adder when the tutor adds a sense the student already has', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_student', E, entry());
    await vocabulary.save('u_tutor', E, entry());
    expect(await addedByOf(t.db, E)).toEqual(['u_student']);
  });
});

describe('unsave', () => {
  it('refuses a tutor, even an accepted one', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_tutor', E, entry());
    await expect(vocabulary.unsave('u_tutor', E, kite.senseIds[0])).rejects.toBeInstanceOf(AccessDenied);
    expect(await addedByOf(t.db, E)).toEqual(['u_tutor']);
  });

  it('lets the owner remove a word the tutor added', async () => {
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_student', granteeUserId: 'u_tutor', accepted: true });
    await vocabulary.save('u_tutor', E, entry());
    await vocabulary.unsave('u_student', E, kite.senseIds[0]);
    expect(await addedByOf(t.db, E)).toEqual([]);
  });
});
```

`logger.events` is the fake's array of logged events (`tests/support/fakes.ts`).

- [ ] **Step 2: Write the done-means-2 test.** In `tests/support/progressRows.ts`, factor the select out of `saveSessionSenses` into an exported helper, and make `saveSessionSenses` use it:

```ts
/** The sense and form of each question at `positions` of a session, as save
 *  entries. Phase 28: a test can save them through the service, as a tutor. */
export async function sessionSenseEntries(
  db: Db,
  input: { sessionId: string; positions: number[] },
): Promise<{ sense_id: string; variant_id: string }[]> {
  /* the existing select from saveSessionSenses, filtered by positions */
}
```

Then, in `tests/integration/services/sessions.test.ts`, inside the describe that defines `seedWithSavedSenses`, `answerAll` and `receptive` (around line 289), add:

```ts
  // Phase 28, done-means 2: a word a tutor added is practised like any other.
  it('practises a sense a tutor added, and a right answer lifts it', async () => {
    await seedUser(t.db, 'u_tutor');
    await seedGrant(t.db, { enrollmentId: E, ownerUserId: 'u_1', granteeUserId: 'u_tutor', accepted: true });
    const { sessionId, record } = await startSeed(E);
    const [added] = await sessionSenseEntries(t.db, { sessionId, positions: [0] });
    await vocabulary.save('u_tutor', E, [added]);

    await answerAll(sessionId, record);

    expect(receptive(await readProgress(t.db, E), added.sense_id)).toMatchObject({ level: 2 });
  });
```

Also add a sibling right after the `'after the seed, prepares a list session from at most ten saved senses'` case, in the `createNextSession` describe (whose `E` is `enrollmentOf('u_1')`):

```ts
  // Phase 28, done-means 2: the planner draws a tutor's words like the owner's.
  it('after the seed, plans a list session from words a tutor added', async () => {
    await seedUser(t.db, 'u_tutor');
    const { sessionId: seed } = await service.createNextSession(E, { listening: false, speaking: false });
    await service.skipSession(seed);
    const added = await seedSavedSenses(t.db, {
      enrollmentId: E,
      lemma: 'tome',
      translations: ['ספר', 'כרך', 'חיבור', 'מחברת', 'דף', 'עמוד', 'פרק', 'שער', 'כותר', 'ספרון', 'קובץ', 'גליון'],
      addedByUserId: 'u_tutor',
    });

    const created = await service.createNextSession(E, { listening: false, speaking: false });

    const jobs = await boss.findJobs<PrepareSessionPayload>(PREPARE_SESSION);
    expect(jobs.find((job) => job.data.session_id === created.sessionId)!.data.picks.every((p) =>
      added.senseIds.includes(p.sense_id),
    )).toBe(true);
  });
```

Import `seedGrant` from `../../support/grantRows` and `sessionSenseEntries` from `../../support/progressRows`.

- [ ] **Step 3: Run them and see them fail.** From `apps/server`: `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/services/vocabulary.access.test.ts tests/integration/services/sessions.test.ts`. Expected: FAIL. `vocabulary.save` takes 2 arguments, and `AccessDenied` is not exported.

- [ ] **Step 4: Add `AccessDenied` to `src/errors.ts`:**

```ts
/** Phase 28 (ADR 0008). The actor may not do this to that enrollment. `action` is
 *  a permission name, or a grant action such as 'grant.accept'. The route
 *  answers 403 with a fixed body; the detail is only in the access_denied log. */
export class AccessDenied extends Error {
  constructor(
    readonly actorUserId: string,
    readonly enrollmentId: string,
    readonly action: string,
  ) {
    super(`${actorUserId} may not ${action} on ${enrollmentId}`);
    this.name = 'AccessDenied';
  }
}
```

- [ ] **Step 5: Implement `src/services/access.ts`:**

```ts
import type { Enrollment } from '@lang-tutor/core/api';

import { may, type Permission } from '../domain/access';
import { AccessDenied } from '../errors';
import type { Logger } from '../logger';
import type { Repos } from './transaction';

/**
 * ADR 0008's one check (spec D8). Call it inside the use case's transaction,
 * after the enrollment is loaded and before anything is written. Answers who
 * the actor is to this list, for the log; throws AccessDenied when the rule in
 * domain/access.ts says no.
 *
 * The owner needs no read: may() with no grant already answers for them.
 */
export async function authorize(
  repos: Repos,
  logger: Logger,
  input: { actorUserId: string; enrollment: Enrollment; permission: Permission },
): Promise<'owner' | 'grantee'> {
  const { actorUserId, enrollment, permission } = input;
  if (may(actorUserId, enrollment.user_id, null, permission)) return 'owner';
  const grant = await repos.grant.findGrantFor({ enrollmentId: enrollment.id, granteeUserId: actorUserId });
  if (may(actorUserId, enrollment.user_id, grant, permission)) return 'grantee';
  logger.info({
    event: 'access_denied',
    actor_user_id: actorUserId,
    enrollment_id: enrollment.id,
    permission,
  });
  throw new AccessDenied(actorUserId, enrollment.id, permission);
}
```

- [ ] **Step 6: Put the check in the vocabulary service.** In `src/services/vocabulary.ts`:
  - `import { authorize } from './access';`
  - `save` becomes `save: async (actorUserId: string, enrollmentId: string, entries: VocabularyEntryInput[])`. Inside the transaction, right after `const enrolled = await enrollmentOrThrow(repos, enrollmentId);`, add `by = await authorize(repos, logger, { actorUserId, enrollment: enrolled, permission: 'vocabulary.add' });`, with `let by: 'owner' | 'grantee' = 'owner';` declared before the transaction.
  - The insert becomes `insertEntries({ enrollmentId, addedByUserId: actorUserId, entries: saveable })`.
  - The `vocabulary_saved` log gains `by`.
  - `unsave` becomes `unsave: async (actorUserId: string, enrollmentId: string, senseId: string)`. After `enrollmentOrThrow`, add `await authorize(repos, logger, { actorUserId, enrollment: enrolled, permission: 'vocabulary.remove' });`. Keep the result of `enrollmentOrThrow` in `const enrolled`.
  - Update the factory's doc comment with one line: "Phase 28: both writes name an actor and pass ADR 0008's check first."

- [ ] **Step 7: Create `src/routes/actor.ts`:**

```ts
import { z } from 'zod';

/**
 * Phase 28 (spec D7, ADR 0008 R2). The ONE place on the server that names the
 * actor header. Hono lowercases header names, so the key is lowercase. Login
 * will replace this header with an authenticated identity; nothing behind it
 * changes when it does.
 */
export const ACTOR_HEADER = 'x-acting-user-id';

export const ActorHeadersSchema = z.object({
  [ACTOR_HEADER]: z
    .string()
    .min(1)
    .describe(
      'The id of the user this request acts as. ASSERTED, NOT AUTHENTICATED: the server checks ' +
        'what that user may do, and nothing proves the caller is them (ADR 0008). Login will ' +
        'replace it.',
    ),
});

export const actorOf = (headers: z.infer<typeof ActorHeadersSchema>): string => headers[ACTOR_HEADER];
```

- [ ] **Step 8: Declare the header and the 403 on the two writes.** In `src/routes/vocabulary.ts`:
  - `import { ActorHeadersSchema, actorOf } from './actor';`. Add `AccessDenied` to the errors import.
  - `saveRoute.request` gains `headers: ActorHeadersSchema`, and its responses gain `403: json(ErrorSchema, "The acting user is not the list's owner and holds no accepted grant that allows adding words.")`.
  - `unsaveRoute.request` becomes `{ params: …, headers: ActorHeadersSchema }`, and its responses gain `403: json(ErrorSchema, "Only the list's owner may remove a word.")` and `400: json(ErrorSchema, 'The acting-user header is missing.')`.
  - The save handler: `const actor = actorOf(c.req.valid('header'));` → `vocabulary.save(actor, id, entries)`. Before the generic rethrow, add `if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);`.
  - The unsave handler gets the same change, calling `vocabulary.unsave(actor, id, sense_id)`.

- [ ] **Step 9: Update the route tests.** In `tests/integration/routes/vocabulary.test.ts`:
  - The `save` and `unsave` helpers gain an optional `actor = 'u_1'`, sent as `'X-Acting-User-Id': actor`. For unsave, pass `headers: { 'X-Acting-User-Id': actor }`.
  - Every existing case keeps passing as the owner.
  - Add a `describe('access (phase 28)')` with:
    - (a) save without the header → 400 `{ error: 'invalid request' }`;
    - (b) save as `u_2` (seed it with `seedUser(t.db, 'u_2')`) → 403 `{ error: 'forbidden' }`;
    - (c) save as an accepted tutor (`seedUser` `u_tutor` + `seedGrant` on `RU`) → 200;
    - (d) unsave as that tutor → 403;
    - (e) save to `e_missing` as anyone → 404, which shows that 404 comes before 403 (spec D8).

- [ ] **Step 10: Update `src/openapi.test.ts`.** Add a describe:

```ts
describe('the actor header in the published document (phase 28)', () => {
  it('is required on both vocabulary writes, and says it authenticates nothing', async () => {
    const doc = await openApiDocument();
    for (const operation of [
      doc.paths['/api/enrollments/{id}/vocabulary'].post,
      doc.paths['/api/enrollments/{id}/vocabulary/senses/{sense_id}'].delete,
    ]) {
      const header = operation.parameters.find((p: { name: string }) => p.name === 'x-acting-user-id');
      expect(header).toMatchObject({ in: 'header', required: true });
      expect(header.description).toMatch(/NOT AUTHENTICATED/);
      expect(Object.keys(operation.responses)).toContain('403');
    }
  });
});
```

If an existing assertion lists the exact statuses of either write, add `'403'` to it (and `'400'` for the DELETE).

- [ ] **Step 11: Implement the server side and run it.** From `apps/server`: `npx jest --selectProjects=unit --runTestsByPath src/openapi.test.ts`, then `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/services/vocabulary.access.test.ts tests/integration/services/sessions.test.ts tests/integration/routes/vocabulary.test.ts`. Expected: PASS.

- [ ] **Step 12: The app sends the header.** In `apps/mobile/src/api/client.ts`:

```ts
// Phase 28 (ADR 0008 R2). The ONE place in the app that names the actor header.
// Asserted, not a credential: the server checks what this user may do, and login
// will replace it. The client is built before anyone logs in, so the caller
// passes the id; nothing here holds it.
const ACTOR_HEADER = 'X-Acting-User-Id';
const actorHeader = (actorUserId: string | undefined): Record<string, string> =>
  actorUserId ? { [ACTOR_HEADER]: actorUserId } : {};
```

  - `postJson(path, body, options: { signal?: AbortSignal; actorUserId?: string } = {})` sends `headers: { 'Content-Type': 'application/json', ...actorHeader(options.actorUserId) }`. The spread is empty without an actor, so `createSession`'s existing test still sees exactly `{ 'Content-Type': 'application/json' }`.
  - `getJson(path, actorUserId?: string)` sends `{ method: 'GET', ...(actorUserId ? { headers: actorHeader(actorUserId) } : {}) }`, so the existing `{ method: 'GET' }` assertions still hold.
  - `deleteResource(path, actorUserId?: string)` follows the same pattern as `getJson`.
  - `answerBySpeech` passes `{ signal: controller.signal }`.
  - `saveVocabulary: (actorUserId: string, enrollmentId: string, request: SaveVocabularyRequest) => postJson<SaveVocabularyResponse>(vocabularyPath(enrollmentId), request, { actorUserId })`.
  - `unsaveVocabulary: (actorUserId: string, enrollmentId: string, senseId: string) => deleteResource(…, actorUserId)`.

In `client.test.ts`, change the existing save/unsave expectations to the new signatures, and add:

```ts
  it('sends the acting user on a save, and only there', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ saved_sense_ids: ['s1'] }) }));
    const client = buildClient(mockFetch);
    await client.saveVocabulary('u_1', 'e1', { entries: [{ sense_id: 's1', variant_id: 'v1' }] });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments/e1/vocabulary',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json', 'X-Acting-User-Id': 'u_1' } }),
    );
  });

  it('sends the acting user on an unsave', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    const client = buildClient(mockFetch);
    await client.unsaveVocabulary('u_1', 'e1', 's1');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments/e1/vocabulary/senses/s1',
      { method: 'DELETE', headers: { 'X-Acting-User-Id': 'u_1' } },
    );
  });
```

  - In `hooks/useVocabulary.tsx` and `hooks/useTranslation.tsx`, read `user` from `useCurrentUser()` next to `active`. Return early when `!user` wherever `!active` already returns early. Pass `user.id` first, and add `user` to the dependency arrays.

- [ ] **Step 13: Run everything and commit.** From the root: `npm run typecheck && npm test && npm run lint:arch && npm run test:integration`. Expected: PASS.

```bash
git add apps/server apps/mobile/src/api apps/mobile/src/hooks
git commit -m "feat: vocabulary writes name an actor and pass the access check" -m "<attribution>"
```

---

### Task 5: The grant API — invite, list, accept, end

**Files:**
- Create: `apps/server/src/services/grants.ts`
- Create: `apps/server/src/routes/grants.ts`
- Modify: `apps/server/src/errors.ts` (`GrantNotFound`, `NotLearning`, `OwnList`)
- Modify: `apps/server/src/composition.ts` (`grants` in `AppDeps`), `apps/server/src/app.ts` (mount), `apps/server/tests/support/fakes.ts` (`createFakeAppDeps`)
- Modify: `apps/server/src/openapi.test.ts`
- Create: `apps/server/tests/integration/services/grants.test.ts`
- Create: `apps/server/tests/integration/routes/grants.test.ts`

**Interfaces:**
- Consumes: `GrantRepo` (Task 3); `TUTOR`, `grantViewOf`, `mayAnswerInvite` and `mayEndGrant` (Task 2); `ActorHeadersSchema`, `actorOf` and `AccessDenied` (Task 4); `Repos.user.findByUsername` and `Repos.enrollment.findByUserAndTarget` (Task 3).
- Produces:

```ts
createGrantService({ transaction, logger }): {
  invite(actorUserId: string, input: CreateGrantRequest): Promise<Grant>;   // UserNotFound | OwnList | NotLearning | GrantExists
  list(actorUserId: string): Promise<GrantList>;
  accept(actorUserId: string, grantId: string): Promise<Grant>;              // GrantNotFound | AccessDenied
  end(actorUserId: string, grantId: string): Promise<void>;                 // AccessDenied; a missing grant is a no-op
}
type GrantService = ReturnType<typeof createGrantService>;
// AppDeps gains `grants: GrantService`
// routes: POST /api/grants, GET /api/grants, POST /api/grants/{id}/accept, DELETE /api/grants/{id}
```

- [ ] **Step 1: Write the failing service test** `tests/integration/services/grants.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AccessDenied, GrantExists, GrantNotFound, NotLearning, OwnList, UserNotFound } from '../../../src/errors';
import type { GrantService } from '../../../src/services/grants';
import type { VocabularyService } from '../../../src/services/vocabulary';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let logger: FakeLogger;
let grants: GrantService;
let vocabulary: VocabularyService;

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  await seedUser(t.db, 'u_student'); // English, as e_u_student
  await seedUser(t.db, 'u_tutor');
  await seedUser(t.db, 'u_stranger');
  await seedEnrollment(t.db, { id: 'e_student_ru', userId: 'u_student', targetLanguage: 'ru' });
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7) });
  grants = deps.grants;
  vocabulary = deps.vocabulary;
});
afterEach(async () => {
  await t.close();
});

const inviteRussian = () => grants.invite('u_tutor', { username: 'u_student', target_language: 'ru' });

describe('invite', () => {
  it('creates a pending tutor grant on the student’s list in that language', async () => {
    const grant = await inviteRussian();
    expect(grant).toMatchObject({
      role: 'tutor',
      status: 'pending',
      enrollment: { id: 'e_student_ru', target_language: 'ru' },
      owner: { id: 'u_student' },
      grantee: { id: 'u_tutor' },
    });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'grant_invited', grant_id: grant.id }));
  });

  it('refuses an unknown username', async () => {
    await expect(grants.invite('u_tutor', { username: 'nobody', target_language: 'ru' })).rejects.toBeInstanceOf(UserNotFound);
  });

  it('refuses a student who is not learning that language (spec D3)', async () => {
    await expect(grants.invite('u_tutor', { username: 'u_student', target_language: 'it' })).rejects.toBeInstanceOf(NotLearning);
  });

  it('refuses inviting yourself', async () => {
    await expect(grants.invite('u_student', { username: 'u_student', target_language: 'ru' })).rejects.toBeInstanceOf(OwnList);
  });

  it('refuses a second invite to the same list', async () => {
    await inviteRussian();
    await expect(inviteRussian()).rejects.toBeInstanceOf(GrantExists);
  });
});

describe('list', () => {
  it('shows each party its side', async () => {
    const grant = await inviteRussian();
    expect(await grants.list('u_student')).toEqual({ tutors: [grant], students: [] });
    expect(await grants.list('u_tutor')).toEqual({ tutors: [], students: [grant] });
    expect(await grants.list('u_stranger')).toEqual({ tutors: [], students: [] });
  });
});

describe('accept', () => {
  it('is the student’s, and lets the tutor add words afterwards', async () => {
    const grant = await inviteRussian();
    const accepted = await grants.accept('u_student', grant.id);
    expect(accepted).toMatchObject({ id: grant.id, status: 'accepted', accepted_at: expect.any(String) });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'grant_accepted', grant_id: grant.id }));
  });

  it('answers a second accept with the same accepted grant (Review Focus 4)', async () => {
    const grant = await inviteRussian();
    const first = await grants.accept('u_student', grant.id);
    expect(await grants.accept('u_student', grant.id)).toEqual(first);
  });

  it.each(['u_tutor', 'u_stranger'])('refuses %s', async (actor) => {
    const grant = await inviteRussian();
    await expect(grants.accept(actor, grant.id)).rejects.toBeInstanceOf(AccessDenied);
  });

  it('answers GrantNotFound for no such grant', async () => {
    await expect(grants.accept('u_student', 'g_missing')).rejects.toBeInstanceOf(GrantNotFound);
  });
});

describe('end', () => {
  it.each([
    ['the student declines', 'u_student', false, 'owner', 'pending'],
    ['the tutor cancels', 'u_tutor', false, 'grantee', 'pending'],
    ['the student ends it', 'u_student', true, 'owner', 'accepted'],
    ['the tutor stops', 'u_tutor', true, 'grantee', 'accepted'],
  ])('%s', async (_case, actor, accept, by, was) => {
    const grant = await inviteRussian();
    if (accept) await grants.accept('u_student', grant.id);
    await grants.end(actor, grant.id);
    expect(await grants.list('u_student')).toEqual({ tutors: [], students: [] });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'grant_ended', grant_id: grant.id, by, was }));
  });

  it('refuses a stranger', async () => {
    const grant = await inviteRussian();
    await expect(grants.end('u_stranger', grant.id)).rejects.toBeInstanceOf(AccessDenied);
  });

  it('is a no-op for no such grant', async () => {
    await expect(grants.end('u_student', 'g_missing')).resolves.toBeUndefined();
  });

  it('stops the tutor adding words, mid-session (Review Focus 1)', async () => {
    const grant = await inviteRussian();
    await grants.accept('u_student', grant.id);
    await grants.end('u_student', grant.id);
    await expect(vocabulary.save('u_tutor', 'e_student_ru', [{ sense_id: 's', variant_id: 'v' }])).rejects.toBeInstanceOf(
      AccessDenied,
    );
  });
});
```

Remove `enrollmentOf` from the `seedUser` import if nothing uses it.

- [ ] **Step 2: Run it and see it fail.** `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/services/grants.test.ts`. Expected: FAIL, because `deps.grants` is undefined and the errors are not exported.

- [ ] **Step 3: Add the errors** to `src/errors.ts`:

```ts
/** Phase 28. No grant has this id. */
export class GrantNotFound extends Error {
  constructor(readonly grantId: string) {
    super(`no grant ${grantId}`);
    this.name = 'GrantNotFound';
  }
}

/** Phase 28 (spec D3). An invite names a language the student is not learning. */
export class NotLearning extends Error {
  constructor(
    readonly userId: string,
    readonly targetLanguage: string,
  ) {
    super(`${userId} is not learning ${targetLanguage}`);
    this.name = 'NotLearning';
  }
}

/** Phase 28. Nobody holds a grant on their own list. */
export class OwnList extends Error {
  constructor(readonly userId: string) {
    super(`${userId} cannot be granted their own list`);
    this.name = 'OwnList';
  }
}
```

- [ ] **Step 4: Implement `src/services/grants.ts`:**

```ts
import type { CreateGrantRequest, Grant, GrantList } from '@lang-tutor/core/api';

import { TUTOR, grantViewOf, mayAnswerInvite, mayEndGrant } from '../domain/access';
import { AccessDenied, GrantNotFound, NotLearning, OwnList, UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * Phase 28 (spec D9). Inviting, listing, accepting and ending access grants. One
 * transaction per use case (ADR 0001 R8): each reads what it checks and writes in
 * the same one. The actor is asserted (ADR 0008 R5).
 */
export function createGrantService({ transaction, logger }: { transaction: Transaction; logger: Logger }) {
  const denied = (actorUserId: string, grant: Grant, action: string) => {
    logger.info({ event: 'access_denied', actor_user_id: actorUserId, enrollment_id: grant.enrollment.id, permission: action });
    return new AccessDenied(actorUserId, grant.enrollment.id, action);
  };

  return {
    invite: async (actorUserId: string, input: CreateGrantRequest): Promise<Grant> => {
      const grant = await transaction(async (repos) => {
        const student = await repos.user.findByUsername(input.username);
        if (!student) throw new UserNotFound(input.username);
        if (student.id === actorUserId) throw new OwnList(actorUserId);
        const enrollment = await repos.enrollment.findByUserAndTarget(student.id, input.target_language);
        if (!enrollment) throw new NotLearning(student.id, input.target_language);
        return repos.grant.insertGrant({
          enrollmentId: enrollment.id,
          ownerUserId: student.id,
          granteeUserId: actorUserId,
          role: TUTOR,
        });
      });
      logger.info({ event: 'grant_invited', grant_id: grant.id, role: grant.role, enrollment_id: grant.enrollment.id });
      return grant;
    },

    list: (actorUserId: string): Promise<GrantList> =>
      transaction(async (repos) => ({
        tutors: await repos.grant.listForOwner(actorUserId),
        students: await repos.grant.listForGrantee(actorUserId),
      })),

    /** Idempotent: accepting an accepted grant answers it unchanged. */
    accept: async (actorUserId: string, grantId: string): Promise<Grant> => {
      const accepted = await transaction(async (repos) => {
        const grant = await repos.grant.findGrant(grantId);
        if (!grant) throw new GrantNotFound(grantId);
        if (!mayAnswerInvite(actorUserId, grantViewOf(grant))) throw denied(actorUserId, grant, 'grant.accept');
        await repos.grant.acceptGrant(grantId);
        return (await repos.grant.findGrant(grantId))!;
      });
      logger.info({ event: 'grant_accepted', grant_id: accepted.id, role: accepted.role });
      return accepted;
    },

    /** Declining, cancelling and ending are one delete (spec D4). Idempotent: a
     *  grant that is already gone is not an error, as unsave is not. */
    end: async (actorUserId: string, grantId: string): Promise<void> => {
      const ended = await transaction(async (repos) => {
        const grant = await repos.grant.findGrant(grantId);
        if (!grant) return null;
        const view = grantViewOf(grant);
        if (!mayEndGrant(actorUserId, view)) throw denied(actorUserId, grant, 'grant.end');
        await repos.grant.deleteGrant(grantId);
        return { grant, by: actorUserId === view.ownerUserId ? 'owner' : 'grantee' };
      });
      if (ended) {
        logger.info({
          event: 'grant_ended',
          grant_id: ended.grant.id,
          role: ended.grant.role,
          by: ended.by,
          was: ended.grant.status,
        });
      }
    },
  };
}

export type GrantService = ReturnType<typeof createGrantService>;
```

- [ ] **Step 5: Wire it.**
  - `src/composition.ts`: add `grants: GrantService` to `AppDeps` (import the type), and `grants: createGrantService({ transaction, logger: io.logger }),` to the returned object.
  - `tests/support/fakes.ts` `createFakeAppDeps`: add `const grants: GrantService = { invite: unreachable, list: unreachable, accept: unreachable, end: unreachable };` and return it.

- [ ] **Step 6: Run the service test.** Same as Step 2. Expected: PASS.

- [ ] **Step 7: Write the failing route test** `tests/integration/routes/grants.test.ts`. Follow `routes/vocabulary.test.ts`: a Hono app with `hono.route('/api', createGrantsRouter(deps.grants))`, and helpers that send `'X-Acting-User-Id'`. Cover every row of spec D9:

```ts
// POST /api/grants
//   201 + Grant body for a valid invite
//   400 { error: 'invalid request' } with no header, and with username 'Victor' (capitals fail UsernameSchema)
//   404 { error: 'user not found' }
//   409 { error: 'not_learning' } | { error: 'own_list' } | { error: 'grant_exists' }
// GET /api/grants
//   200 { tutors, students } for each party; 400 with no header
// POST /api/grants/{id}/accept
//   200 accepted Grant for the owner; 403 { error: 'forbidden' } for the tutor; 404 { error: 'grant not found' }
// DELETE /api/grants/{id}
//   204 for owner and grantee; 204 for a missing id; 403 { error: 'forbidden' } for a stranger
```

Write each as its own `it` with real requests and `expect(res.status)` plus `expect(await res.json()).toEqual(...)`.

- [ ] **Step 8: Implement `src/routes/grants.ts`:**

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { CreateGrantRequestSchema, ErrorSchema, GrantListSchema, GrantSchema } from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { AccessDenied, GrantExists, GrantNotFound, NotLearning, OwnList, UserNotFound } from '../errors';
import type { GrantService } from '../services/grants';
import { ActorHeadersSchema, actorOf } from './actor';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const grantParams = z.object({ id: z.string() });
const NO_HEADER = json(ErrorSchema, 'The body or the acting-user header did not validate.');

const inviteRoute = createRoute({
  method: 'post',
  path: '/grants',
  tags: ['grants'],
  summary: 'Invite a student: the acting user asks to tutor them in one language',
  description:
    "Creates a pending tutor grant on the student's enrollment in `target_language`. The student " +
    'must already be learning it. The grant allows nothing until the student accepts.',
  request: {
    headers: ActorHeadersSchema,
    body: { required: true, content: { 'application/json': { schema: CreateGrantRequestSchema } } },
  },
  responses: {
    201: json(GrantSchema, 'The invite, pending.'),
    400: NO_HEADER,
    404: json(ErrorSchema, 'No user has this username.'),
    409: json(
      ErrorSchema,
      '`not_learning`: the student is not learning this language. `own_list`: the acting user named ' +
        'themselves. `grant_exists`: the acting user already holds a grant on this list.',
    ),
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/grants',
  tags: ['grants'],
  summary: "The acting user's grants, both ways",
  description:
    '`tutors`: grants on the acting user’s own lists (their tutors, and invites to answer). ' +
    '`students`: grants the acting user holds. Pending and accepted, newest first.',
  request: { headers: ActorHeadersSchema },
  responses: { 200: json(GrantListSchema, 'Both lists, possibly empty.'), 400: NO_HEADER },
});

const acceptRoute = createRoute({
  method: 'post',
  path: '/grants/{id}/accept',
  tags: ['grants'],
  summary: 'Accept an invite',
  description: "Only the list's owner may accept. Accepting an accepted grant answers it unchanged.",
  request: { params: grantParams, headers: ActorHeadersSchema },
  responses: {
    200: json(GrantSchema, 'The grant, accepted.'),
    400: NO_HEADER,
    403: json(ErrorSchema, "The acting user is not the list's owner."),
    404: json(ErrorSchema, 'No grant has this id.'),
  },
});

const endRoute = createRoute({
  method: 'delete',
  path: '/grants/{id}',
  tags: ['grants'],
  summary: 'Decline, cancel or end a grant',
  description:
    'Either party may end a grant, pending or accepted. Words the grantee added stay in the list. ' +
    'Idempotent: a grant that does not exist also answers 204.',
  request: { params: grantParams, headers: ActorHeadersSchema },
  responses: {
    204: { description: 'The grant is gone.' },
    400: NO_HEADER,
    403: json(ErrorSchema, 'The acting user is neither party to this grant.'),
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createGrantsRouter(grants: GrantService) {
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(inviteRoute, async (c) => {
    const actor = actorOf(c.req.valid('header'));
    try {
      return c.json(await grants.invite(actor, c.req.valid('json')), 201);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'user not found' }, 404);
      if (error instanceof NotLearning) return c.json({ error: 'not_learning' }, 409);
      if (error instanceof OwnList) return c.json({ error: 'own_list' }, 409);
      if (error instanceof GrantExists) return c.json({ error: 'grant_exists' }, 409);
      throw error;
    }
  });

  router.openapi(listRoute, async (c) => c.json(await grants.list(actorOf(c.req.valid('header'))), 200));

  router.openapi(acceptRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await grants.accept(actorOf(c.req.valid('header')), id), 200);
    } catch (error) {
      if (error instanceof GrantNotFound) return c.json({ error: 'grant not found' }, 404);
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      throw error;
    }
  });

  router.openapi(endRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await grants.end(actorOf(c.req.valid('header')), id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      throw error;
    }
  });

  return router;
}
```

In `src/app.ts`, import `createGrantsRouter` and add `app.route('/api', createGrantsRouter(deps.grants));` after the enrollments router.

- [ ] **Step 9: Update `src/openapi.test.ts`.**
  - The exact-paths test (currently "contains all fourteen paths") becomes "contains all seventeen paths", with `'/api/grants'`, `'/api/grants/{id}'` and `'/api/grants/{id}/accept'` in sorted position.
  - Add a describe that asserts each grant operation's status set: POST `/api/grants` → `['201','400','404','409']`; GET → `['200','400']`; POST accept → `['200','400','403','404']`; DELETE → `['204','400','403']`.
  - Assert that each of the four declares the `x-acting-user-id` header as required.

- [ ] **Step 10: Run, lint and commit.** From `apps/server`: run the unit `openapi.test.ts`, then the two new integration files. From the root: `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.

```bash
git add apps/server
git commit -m "feat(server): invite, list, accept and end access grants" -m "<attribution>"
```

---

### Task 6: "Added by" on the wire — the list and the word's page

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`VocabularyWordSchema`, `VocabularySenseSchema`)
- Modify: `apps/server/src/domain/vocabulary.ts` (`WordSummary`, `SavedEntry`, `assemblePage`, `buildWordDetail`) + `src/domain/vocabulary.test.ts`
- Modify: `apps/server/src/repo/vocabulary.ts` (`wordSummaries`, `savedInLemma` + their repo functions)
- Modify: `apps/server/src/services/vocabulary.ts` (pass `ownerUserId: enrolled.user_id`)
- Modify: `apps/server/tests/integration/repo/vocabulary.plan.test.ts` (builder inputs)
- Modify: `apps/server/tests/integration/routes/vocabulary.test.ts` (expected bodies gain `added_by`, plus a new case)
- Modify: mobile test fixtures that build `VocabularyWord`, if typecheck asks (`apps/mobile/src/vocabulary.test.ts` and others)

**Interfaces:**
- Produces (wire): `VocabularyWord.added_by: string[]` and `VocabularySense.added_by?: string` (spec D11).
- Produces (domain): `WordSummary.addedBy: string[]` and `SavedEntry.addedBy: string | null`.
- Produces (repo): `findWordSummaries(input: { …; ownerUserId: string })` and `findSavedInLemma(input: { enrollmentId; lemma; ownerUserId })`.

- [ ] **Step 1: Write the failing domain tests.** In `src/domain/vocabulary.test.ts`:
  - Every `WordSummary` fixture gains `addedBy: []` and every `SavedEntry` fixture gains `addedBy: null`. Every expected `VocabularyWord` gains `added_by: []`.
  - Add `assemblePage` → `it('carries the other adders of a word', …)`: a summary with `addedBy: ['רינה']` gives an item with `added_by: ['רינה']`.
  - Add `buildWordDetail` → `it('names who added a saved sense when it was not the owner', …)`: one saved entry with `addedBy: 'רינה'` and one with `addedBy: null`. Expect `added_by: 'רינה'` on the first sense and no `added_by` key on the second (`expect(sense).not.toHaveProperty('added_by')`). An unsaved sense never has the key either.

- [ ] **Step 2: Run them and see them fail.** `npx jest --selectProjects=unit --runTestsByPath src/domain/vocabulary.test.ts` from `apps/server`. Expected: FAIL, with type errors on `addedBy` and missing `added_by`.

- [ ] **Step 3: Implement.**
  - Core: `VocabularyWordSchema` gains

```ts
  // Phase 28 (spec D11). The display names of the people OTHER than the list's
  // owner who added any of this word's saved senses, distinct and sorted; [] when
  // the learner added everything themselves.
  added_by: z.array(z.string()),
```

    and `VocabularySenseSchema` gains

```ts
  // Phase 28. Present on a saved sense someone other than the list's owner added:
  // their display name.
  added_by: z.string().optional(),
```

  - Domain: `WordSummary` gains `addedBy: string[]`, and `assemblePage` sets `added_by: s.addedBy`. `SavedEntry` becomes `{ senseId: string; variantId: string; addedBy: string | null }`. In `buildWordDetail`, build `const addedBy = new Map(saved.map((entry) => [entry.senseId, entry.addedBy]));`, and in the sense object add, after `saved: isSaved,`:

```ts
      ...(isSaved && addedBy.get(r.senseId) ? { added_by: addedBy.get(r.senseId)! } : {}),
```

  - Repo: `vocabularyQueries.wordSummaries` input gains `ownerUserId: string`, and the SELECT list gains:

```sql
           (SELECT coalesce(array_agg(DISTINCT u.display_name ORDER BY u.display_name), '{}'::text[])
              FROM vocabulary_entries c
              JOIN users u ON u.id = c.added_by_user_id
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lemma = w.lemma
               AND c.added_by_user_id <> ${input.ownerUserId}) AS added_by,
```

    `findWordSummaries` maps `addedBy: row.added_by`, with the row type gaining `added_by: string[]`.
  - `vocabularyQueries.savedInLemma` input gains `ownerUserId`:

```ts
  savedInLemma: (input: { enrollmentId: string; lemma: string; ownerUserId: string }): SQL => sql`
    SELECT ve.sense_id, ve.variant_id,
           CASE WHEN ve.added_by_user_id <> ${input.ownerUserId} THEN u.display_name END AS added_by
    FROM vocabulary_entries ve
    JOIN users u ON u.id = ve.added_by_user_id
    WHERE ve.enrollment_id = ${input.enrollmentId}
      AND ve.lemma = ${input.lemma}`,
```

    `findSavedInLemma` maps `addedBy: row.added_by`.
  - Service: `listWords` passes `ownerUserId: enrolled.user_id` to `findWordSummaries`, and `wordDetail` passes it to `findSavedInLemma`.
  - `vocabulary.plan.test.ts`: the builder calls gain `ownerUserId: '<the plan test's user id>'`.

- [ ] **Step 4: Route test for the label.** In `tests/integration/routes/vocabulary.test.ts`:
  - Every expected list item gains `added_by: []`.
  - Add `it("labels a tutor's word with the tutor's display name, on the list and the word's page")`. Seed `u_tutor` with `seedUser`. Its display name is `test u_tutor`, so expect that. Add `seedGrant` accepted on `RU`, save one sense as `u_tutor` through the route and one as `u_1`, then expect:
    - the list item `added_by: ['test u_tutor']`;
    - in the detail, `added_by: 'test u_tutor'` on the tutor's sense and no key on the owner's.

- [ ] **Step 5: Run, typecheck, fix fixtures.**
  - From `apps/server`: the unit domain test, then `bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/routes/vocabulary.test.ts tests/integration/repo/vocabulary.test.ts tests/integration/repo/vocabulary.plan.test.ts`.
  - From the root: `npm run typecheck`. Where mobile fixtures build a `VocabularyWord` and now fail, add `added_by: []`.
  - Then `npm test && npm run lint:arch`. Expected: PASS. The plan test's time budget must still pass. If it does not, report the measured numbers and stop; do not loosen the budget.

- [ ] **Step 6: Commit.**

```bash
git add packages/core apps/server apps/mobile/src
git commit -m "feat: the saved list says who added a word" -m "<attribution>"
```

---

### Task 7: ADR 0008, its check script, and the ADR 0005 and 0002 edits

**Files:**
- Create: `docs/adr/adr-0008-access-grants.md`
- Create: `scripts/check-adr-0008-access-grants.sh` (executable)
- Modify: `docs/adr/adr-0005-identity-without-authentication.md` (status line)
- Modify: `docs/adr/adr-0002-di-with-closures.md` (R6's factory list gains `createGrantRepo`, `createGrantService`)

**Interfaces:**
- Consumes: the file layout of Tasks 2–5: `repo/grants.ts`, `routes/actor.ts`, `domain/access.ts`, `api/client.ts`.

- [ ] **Step 1: Invoke the `create-adr` skill** (Skill tool, `create-adr`) and follow it. The ADR's content is spec D18, with D1, D6, D7 and D8 as its Decision. Model it on ADR 0007 (`docs/adr/adr-0007-background-jobs.md`): Status Accepted, Date 2026-10-07, Source the phase 28 spec. Sections: Decision (with a diagram of header → `routes/actor.ts` → `authorize` → `may`), Rules (R1–R3 table), Rules that are not import rules (R4, R5), How to detect a violation (the three commands below, verbatim), What the rules cover, Why, Related (ADR 0005, ADR 0001 R9). The commands:

```bash
# R1 — enrollment_grants is read and written only by repo/grants.ts
grep -rnE "enrollment_grants|enrollmentGrants" apps/server/src --include='*.ts' \
  | grep -vE '^apps/server/src/(repo/grants|db/schema)\.ts:'

# R2 — the actor header is named once per app
grep -rniE "x-acting-user-id" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
  --exclude='*.test.ts' --exclude='*.test.tsx' \
  | grep -vE '^apps/server/src/routes/actor\.ts:|^apps/mobile/src/api/client\.ts:'

# R3 — roles are named once
grep -rn "'tutor'" apps/server/src --include='*.ts' --exclude='*.test.ts' \
  | grep -vE '^apps/server/src/(domain/access|db/schema)\.ts:'
```

The Why section must say plainly:
- the actor is asserted;
- the check is a correctness boundary until login, not a security one;
- the header is the slot login fills;
- a role on a grant answers phase 8's objection to a role on a user.

- [ ] **Step 2: Write the check script BEFORE trusting it — violation first.** Create `scripts/check-adr-0008-access-grants.sh` modelled exactly on `scripts/check-adr-0007-background-jobs.sh`, with the same `check()` helper and the same output format: functions `r1`, `r2` and `r3` running the three commands, the banner "Checking the repo against ADR 0008 (access grants)", and the pass line "Access-grants check passed: 3 rules, no violations." Then `chmod +x` it. `scripts/check-adrs.sh` discovers it automatically.

- [ ] **Step 3: Plant a violation of each rule and see it reported.** One at a time:
  - (R1) Add the line `// enrollment_grants` to `apps/server/src/services/grants.ts`.
  - (R2) Add `const h = 'X-Acting-User-Id';` to `apps/mobile/src/hooks/useCurrentUser.tsx`.
  - (R3) Add `const r = 'tutor';` to `apps/server/src/services/grants.ts`.

  After each, run `bash scripts/check-adr-0008-access-grants.sh`. Expected: `VIOLATION  R<n> …` naming the planted line, and exit code 1. Remove the plant and run again. Expected: `ok` for all three, and exit 0. Paste the three VIOLATION outputs into your report.

- [ ] **Step 4: Amend ADR 0005 and ADR 0002.**
  - ADR 0005's `- **Status:** Accepted` becomes `- **Status:** Accepted; amended 2026-10-07 by [ADR 0008](adr-0008-access-grants.md): authorization exists, over an asserted identity. No credential code, still.`
  - Its Decision diagram's last line, `(nothing)  authorization — deliberately absent`, becomes `ADR 0008  authorization over an ASSERTED actor — a correctness boundary, not a security one`.
  - In ADR 0002 R6's list of factories, add `createGrantRepo` and `createGrantService` after `createEnrollmentService`.

- [ ] **Step 5: Run the whole architecture check.** `npm run lint:arch`. Expected: every ADR passes, ADR 0008 included.

- [ ] **Step 6: Commit.**

```bash
git add docs/adr scripts/check-adr-0008-access-grants.sh
git commit -m "docs(adr): 0008 access grants, enforced; 0005 amended" -m "<attribution>"
```

---

### Task 8: App data — grant calls, pure helpers, grants on the current user, strings

**Files:**
- Modify: `apps/mobile/src/api/client.ts` (+ `client.test.ts`)
- Create: `apps/mobile/src/grants.ts`, `apps/mobile/src/grants.test.ts`
- Modify: `apps/mobile/src/hooks/useCurrentUser.tsx`
- Modify: `apps/mobile/src/strings.ts`

**Interfaces:**
- Consumes: `Grant`, `GrantList` and `CreateGrantRequest` (Task 3); the actor plumbing in the client (Task 4).
- Produces (client):

```ts
listGrants(actorUserId: string): Promise<GrantList>;                         // GET /api/grants
createGrant(actorUserId: string, request: CreateGrantRequest): Promise<Grant>; // POST /api/grants
acceptGrant(actorUserId: string, grantId: string): Promise<Grant>;          // POST /api/grants/{id}/accept
endGrant(actorUserId: string, grantId: string): Promise<void>;              // DELETE /api/grants/{id}
```

- Produces (`grants.ts`):

```ts
export const NO_GRANTS: GrantList;
export function pendingInvites(grants: GrantList): Grant[];   // tutors with status 'pending'
export function myTutors(grants: GrantList): Grant[];         // tutors with status 'accepted'
export function myStudents(grants: GrantList): Grant[];       // students, as listed
export function needsEnrollScreen(enrollments: Enrollment[], grants: GrantList): boolean;
export function normalizeUsername(typed: string): string;     // trim + lowercase
export function inviteErrorMessage(error: unknown, username: string, language: string): string;
export function studentGrant(grants: GrantList, grantId: string): Grant | undefined; // accepted student grant only
```

- Produces (`useCurrentUser`): `grants: GrantList`, `reloadGrants(): Promise<void>`, `invite(username: string, target: LanguageCode): Promise<Grant>`, `acceptInvite(grantId: string): Promise<void>`, `endGrant(grantId: string): Promise<void>`.

- [ ] **Step 1: Add the strings** to `strings.ts`, in the `strings` object, under a `// Phase 28. Tutors and students.` comment. Use exactly these:

```ts
  // Phase 28. Tutors and students. Usernames are Latin inside Hebrew sentences,
  // so they sit in FSI/PDI isolates, as translateCorrectionNotice's forms do.
  enrollTeach: 'אני כאן כדי ללמד',
  startLearning: 'התחלת לימוד שפה',
  inviteCard: (tutor: string, language: string) =>
    `${tutor} רוצה להוסיף מילים לרשימת ה${languageName(language)} שלך`,
  inviteAccept: 'אישור',
  inviteDecline: 'דחייה',
  studentsTitle: 'התלמידים שלי',
  personAndLanguage: (name: string, language: string) => `${name} · ${languageName(language)}`,
  studentPending: (name: string) => `ממתין לאישור של ${name}`,
  inviteStudent: 'הזמנת תלמיד/ה',
  inviteUsernameLabel: 'שם המשתמש של התלמיד/ה',
  inviteLanguageLabel: 'השפה שאת/ה מלמד/ת',
  inviteSubmit: 'שליחת הזמנה',
  inviteUserNotFound: 'אין משתמש בשם הזה',
  inviteNotLearning: (username: string, language: string) =>
    `⁨${username}⁩ עדיין לא לומד/ת ${languageName(language)} כאן`,
  inviteOwnList: 'אי אפשר להזמין את עצמך',
  inviteExists: 'כבר הזמנת את התלמיד/ה הזה/ו בשפה הזו',
  inviteFailed: 'ההזמנה נכשלה, נסו שוב',
  cancelInviteTitle: 'לבטל את ההזמנה?',
  cancelInviteMessage: (name: string) => `${name} לא יוכל/תוכל לאשר אותה.`,
  cancelInviteConfirm: 'ביטול ההזמנה',
  studentWordsTitle: (name: string, language: string) => `הוספת מילים ל${name} · ${languageName(language)}`,
  stopTutoring: (name: string) => `הפסקת הלימוד עם ${name}`,
  stopTutoringTitle: 'להפסיק ללמד?',
  stopTutoringMessage: (name: string) =>
    `לא תוכל/י יותר להוסיף מילים לרשימה של ${name}. המילים שכבר הוספת יישארו.`,
  tutorsTitle: 'המורים שלי',
  endTutor: 'סיום',
  endTutorTitle: 'לסיים עם המורה?',
  endTutorMessage: (name: string) =>
    `${name} לא יוכל/תוכל יותר להוסיף מילים לרשימה שלך. המילים שכבר נוספו יישארו.`,
  teachingTitle: 'הוראה',
  tutorAdd: 'הוספה',
  tutorAdded: 'נוסף ✓',
  tutorAddAll: 'הוספת הכל',
  addedBy: (names: string[]) => `נוספה ע״י ${names.join(', ')}`,
  noneYet: '—',
```

- [ ] **Step 2: Write the failing tests** `src/grants.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Grant, GrantList } from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';
import {
  NO_GRANTS,
  inviteErrorMessage,
  myStudents,
  myTutors,
  needsEnrollScreen,
  normalizeUsername,
  pendingInvites,
  studentGrant,
} from '@/grants';
import { strings } from '@/strings';

const grant = (over: Partial<Grant> & { id: string }): Grant => ({
  role: 'tutor',
  status: 'pending',
  enrollment: { id: 'e1', source_language: 'he', target_language: 'it' },
  owner: { id: 'u_student', username: 'victor', display_name: 'ויקטור' },
  grantee: { id: 'u_tutor', username: 'rina', display_name: 'רינה' },
  created_at: '2026-10-07T10:00:00.000Z',
  accepted_at: null,
  ...over,
});
const enrollment: Enrollment = {
  id: 'e1',
  user_id: 'u_student',
  source_language: 'he',
  target_language: 'it',
  created_at: '2026-10-01T00:00:00.000Z',
};

describe('the student side', () => {
  const list: GrantList = {
    tutors: [grant({ id: 'g1' }), grant({ id: 'g2', status: 'accepted', accepted_at: '2026-10-07T11:00:00.000Z' })],
    students: [],
  };
  it('splits invites to answer from accepted tutors', () => {
    expect(pendingInvites(list).map((g) => g.id)).toEqual(['g1']);
    expect(myTutors(list).map((g) => g.id)).toEqual(['g2']);
  });
});

describe('the tutor side', () => {
  const list: GrantList = {
    tutors: [],
    students: [grant({ id: 'g3' }), grant({ id: 'g4', status: 'accepted', accepted_at: '2026-10-07T11:00:00.000Z' })],
  };
  it('lists every student, pending ones included', () => {
    expect(myStudents(list).map((g) => g.id)).toEqual(['g3', 'g4']);
  });
  it('opens the words screen for an accepted student only', () => {
    expect(studentGrant(list, 'g4')?.id).toBe('g4');
    expect(studentGrant(list, 'g3')).toBeUndefined();
    expect(studentGrant(list, 'g_missing')).toBeUndefined();
  });
});

describe('needsEnrollScreen (spec D13, Review Focus 5)', () => {
  it('is only for an account with nothing at all', () => {
    expect(needsEnrollScreen([], NO_GRANTS)).toBe(true);
  });
  it('is never for a learner, grants or not', () => {
    expect(needsEnrollScreen([enrollment], NO_GRANTS)).toBe(false);
  });
  it('is not for a tutor who learns nothing, pending invite or accepted', () => {
    expect(needsEnrollScreen([], { tutors: [], students: [grant({ id: 'g1' })] })).toBe(false);
  });
});

describe('normalizeUsername (Review Focus 2)', () => {
  it('trims and lowercases what was typed', () => {
    expect(normalizeUsername('  Victor ')).toBe('victor');
  });
});

describe('inviteErrorMessage', () => {
  it.each([
    [new ApiError(404, 'user not found'), strings.inviteUserNotFound],
    [new ApiError(409, 'not_learning'), strings.inviteNotLearning('victor', 'it')],
    [new ApiError(409, 'own_list'), strings.inviteOwnList],
    [new ApiError(409, 'grant_exists'), strings.inviteExists],
    [new ApiError(500), strings.inviteFailed],
    [new Error('offline'), strings.inviteFailed],
  ])('says what went wrong for %s', (error, message) => {
    expect(inviteErrorMessage(error, 'victor', 'it')).toBe(message);
  });
});
```

- [ ] **Step 3: Run it and see it fail.** From `apps/mobile`: `npx jest src/grants.test.ts`. Expected: FAIL, `Cannot find module '@/grants'`.

- [ ] **Step 4: Implement `src/grants.ts`:**

```ts
import type { Enrollment, Grant, GrantList } from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';
import { strings } from '@/strings';

/** Phase 28. What an account holds before its grants are read, and after sign-out. */
export const NO_GRANTS: GrantList = { tutors: [], students: [] };

/** Invites waiting for this account, as the student, to answer. */
export const pendingInvites = (grants: GrantList): Grant[] => grants.tutors.filter((g) => g.status === 'pending');

/** This account's tutors, as the student. */
export const myTutors = (grants: GrantList): Grant[] => grants.tutors.filter((g) => g.status === 'accepted');

/** This account's students, as the tutor, pending ones included. */
export const myStudents = (grants: GrantList): Grant[] => grants.students;

/** The accepted student grant the words screen opens on, or undefined: the app
 *  never offers a tutor a list it may not add to (spec D14). */
export const studentGrant = (grants: GrantList, grantId: string): Grant | undefined =>
  grants.students.find((g) => g.id === grantId && g.status === 'accepted');

/** Spec D13. Only an account with no enrollment and no grant either way is sent
 *  to choose a language; it can also choose to teach there. */
export const needsEnrollScreen = (enrollments: Enrollment[], grants: GrantList): boolean =>
  enrollments.length === 0 && grants.tutors.length === 0 && grants.students.length === 0;

/** Usernames are lowercase ASCII on the server; a typed "Victor " means victor. */
export const normalizeUsername = (typed: string): string => typed.trim().toLowerCase();

export function inviteErrorMessage(error: unknown, username: string, language: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return strings.inviteUserNotFound;
    if (error.code === 'not_learning') return strings.inviteNotLearning(username, language);
    if (error.code === 'own_list') return strings.inviteOwnList;
    if (error.code === 'grant_exists') return strings.inviteExists;
  }
  return strings.inviteFailed;
}
```

- [ ] **Step 5: Run it.** Same command as Step 3. Expected: PASS.

- [ ] **Step 6: Add the client calls (test first).** In `client.test.ts`, add one test per call. Each asserts the URL, the method, the `X-Acting-User-Id` header, and the body for `createGrant`. Then add to `client.ts`, importing the types:

```ts
    // Phase 28. Grants: every call names the acting user (ADR 0008).
    listGrants: (actorUserId: string) => getJson<GrantList>('/api/grants', actorUserId),
    createGrant: (actorUserId: string, request: CreateGrantRequest) =>
      postJson<Grant>('/api/grants', request, { actorUserId }),
    acceptGrant: (actorUserId: string, grantId: string) =>
      postJson<Grant>(`/api/grants/${encodeURIComponent(grantId)}/accept`, {}, { actorUserId }),
    endGrant: (actorUserId: string, grantId: string) =>
      deleteResource(`/api/grants/${encodeURIComponent(grantId)}`, actorUserId),
```

Run `npx jest src/api/client.test.ts` from `apps/mobile`. Expected: PASS.

- [ ] **Step 7: Grants on the current user.** In `hooks/useCurrentUser.tsx`:
  - `CurrentUserValue` gains:

```ts
  /** Phase 28. Grants on this account's lists and grants it holds. NO_GRANTS until login. */
  grants: GrantList;
  /** Re-reads grants; a failed read keeps the last list (spec D15). */
  reloadGrants: () => Promise<void>;
  /** The current user invites a student; grants are re-read on success. Throws the ApiError. */
  invite: (username: string, target: LanguageCode) => Promise<Grant>;
  acceptInvite: (grantId: string) => Promise<void>;
  endGrant: (grantId: string) => Promise<void>;
```

  - State: `const [grants, setGrants] = useState<GrantList>(NO_GRANTS);`.
  - `adopt(next, list, rememberedId, grantList)` sets grants before `setUser`, for the same reason enrollments are set first.
  - `login` fetches `api.listGrants(next.id)` in the same `Promise.all` as enrollments.
  - `register` passes `NO_GRANTS`.
  - `signOut` resets to `NO_GRANTS`.
  - `reloadGrants`: if there is no user, return; otherwise `try { setGrants(await api.listGrants(user.id)); } catch { /* keep the last list */ }`.
  - `invite`: `const created = await api.createGrant(user.id, { username: normalizeUsername(username), target_language: target }); await reloadGrants(); return created;`.
  - `acceptInvite`: `await api.acceptGrant(user.id, grantId); await reloadGrants();`.
  - `endGrant`: `await api.endGrant(user.id, grantId); await reloadGrants();`.
  - Each throws `new Error('… with no current user')` when `!user`, as `enroll` does.
  - Add every new value to the `useMemo` and its dependencies.

- [ ] **Step 8: Typecheck, test and commit.** From the root: `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.

```bash
git add apps/mobile/src
git commit -m "feat(mobile): grants on the current user, and the strings for tutors" -m "<attribution>"
```

---

### Task 9: App screens — home without a language, invites, students, the invite screen, profile

**Files:**
- Create: `apps/mobile/src/components/LearningSection.tsx` (moved out of `app/index.tsx`)
- Create: `apps/mobile/src/components/InvitesSection.tsx`, `apps/mobile/src/components/StudentsSection.tsx`
- Create: `apps/mobile/src/app/students/invite.tsx`
- Modify: `apps/mobile/src/app/index.tsx`, `apps/mobile/src/app/enroll.tsx`, `apps/mobile/src/app/profile.tsx`

**Interfaces:**
- Consumes: `useCurrentUser()` with `grants`, `reloadGrants`, `invite`, `acceptInvite` and `endGrant` (Task 8); `pendingInvites`, `myStudents`, `myTutors`, `needsEnrollScreen` and `inviteErrorMessage` (Task 8); the strings (Task 8); `confirm` from `@/confirm`; `ENROLLABLE_TARGETS` from `@/enrollments`.
- Produces (testIDs the e2e uses):
  - `start-learning`, `enroll-teach`;
  - `invite-card`, `invite-accept`, `invite-decline`;
  - `students-section`, `student-<username>`, `invite-student`;
  - `invite-username`, `invite-language-<code>`, `invite-submit`, `invite-error`;
  - `profile-invite`, `tutor-<username>`, `tutor-end-<username>`.
- Produces: the route `/students/words?grant=<id>`, which Task 10 implements.

- [ ] **Step 1: Move home's learning block out unchanged, as its own commit (spec D17).**
  - Create `components/LearningSection.tsx` exporting `LearningSection({ active }: { active: Enrollment })`.
  - Move into it everything in `HomeScreen` from `const { enter } = useSession();` through the JSX from `enrollment-switcher` down to the `vocabulary-entry` button. That includes:
    - the two `useFocusEffect`s, `switcherOpen`, `busy`, `inFlight`, `run`, `create` and `skip`;
    - the cards and `SessionAction`;
    - the `SessionAction` function and every style those elements use.
  - It reads `enrollments` and `switchTo` from `useCurrentUser()` itself.
  - Wrap the moved JSX in a fragment.
  - `HomeScreen` keeps the redirects, the title, subtitle, profile link and future space, and renders `<LearningSection active={active} />` where the block was.
  - Behaviour must not change. Run `npm run typecheck && npm test` from the root, then commit:

```bash
git add apps/mobile/src/app/index.tsx apps/mobile/src/components/LearningSection.tsx
git commit -m "refactor(mobile): home's learning block is its own component" -m "<attribution>"
```

- [ ] **Step 2: Home with no language, and the redirect rule (D13).** In `app/index.tsx`:
  - Read `grants` and `reloadGrants` from `useCurrentUser()`.
  - Add a `useFocusEffect(useCallback(() => { void reloadGrants(); }, [reloadGrants]))`.
  - Replace `if (!active) return <Redirect href="/enroll" />;` with `if (needsEnrollScreen(enrollments, grants)) return <Redirect href="/enroll" />;`.
  - Render, in order:
    1. `<InvitesSection />`
    2. `{active ? <LearningSection active={active} /> : <StartLearning />}`, where `StartLearning` is a local primary button, testID `start-learning`, label `strings.startLearning`, `onPress={() => router.push('/enroll')}`.
    3. `<StudentsSection />`
  - Wrap the screen's content in a `ScrollView` (`contentContainerStyle` with the screen's existing padding and gap) so the extra sections fit on a phone. The `SafeAreaView` stays outside.

- [ ] **Step 3: `InvitesSection`.** It renders nothing when `pendingInvites(grants)` is empty. Otherwise it renders one card per invite (testID `invite-card`):
  - the text `strings.inviteCard(g.grantee.display_name, g.enrollment.target_language)`;
  - two buttons in a row: `invite-accept` (`strings.inviteAccept`) calls `acceptInvite(g.id)`, and `invite-decline` (`strings.inviteDecline`) calls `endGrant(g.id)`.
  - Use a `busy` ref so a double tap sends one request.
  - A failed call leaves the card, so the next focus re-reads.
  - Style it like home's `card`, with the primary colour on Accept.

- [ ] **Step 4: `StudentsSection`.** It renders nothing when `myStudents(grants)` is empty. Otherwise it renders a `View` with testID `students-section`:
  - the title `strings.studentsTitle`;
  - one `Pressable` per grant (testID `student-${g.owner.username}`) showing `strings.personAndLanguage(g.owner.display_name, g.enrollment.target_language)`, with a second line `strings.studentPending(g.owner.display_name)` when `g.status === 'pending'`;
  - `onPress`: for an accepted grant, `router.push({ pathname: '/students/words', params: { grant: g.id } })`. For a pending one, `confirm({ title: strings.cancelInviteTitle, message: strings.cancelInviteMessage(g.owner.display_name), confirm: strings.cancelInviteConfirm, cancel: strings.cancel })`, then `endGrant(g.id)` on yes;
  - and an `invite-student` secondary button (`strings.inviteStudent`) that pushes `/students/invite`.

- [ ] **Step 5: The invite screen** `app/students/invite.tsx`. Model it on `app/enroll.tsx`'s choice row and error handling:
  - Title `strings.inviteStudent`.
  - A username `TextInput` (testID `invite-username`) with `autoCapitalize="none"`, `autoCorrect={false}`, and `style` with `writingDirection: 'ltr'` (as the login field does).
  - Label `strings.inviteLanguageLabel`, then one choice per `ENROLLABLE_TARGETS` code (testID `invite-language-${code}`, label `strings.languageName(code)`). Default to the first.
  - Submit (testID `invite-submit`, label `strings.inviteSubmit`), disabled while busy or while the trimmed username is empty. It calls `await invite(username, selected)`, then `router.dismissTo('/')`.
  - On error: `setError(inviteErrorMessage(error, normalizeUsername(username), selected))`, shown in a `Text` with testID `invite-error`.
  - A back link (`strings.back`).
  - `if (!user) return <Redirect href="/login" />;`.

- [ ] **Step 6: The teach button on `/enroll`.** In `app/enroll.tsx`, when `enrollments.length === 0`, render a secondary button below submit: testID `enroll-teach`, label `strings.enrollTeach`, `onPress={() => router.push('/students/invite')}`.

- [ ] **Step 7: Profile (D12, D14).** In `app/profile.tsx`:
  - The target row's value becomes the joined names `|| strings.noneYet`.
  - Add a "my tutors" card when `myTutors(grants)` is non-empty: title `strings.tutorsTitle`, and per grant a row (testID `tutor-${g.grantee.username}`) with `strings.personAndLanguage(g.grantee.display_name, g.enrollment.target_language)` and an end button (testID `tutor-end-${g.grantee.username}`, label `strings.endTutor`). The button confirms with `strings.endTutorTitle` / `strings.endTutorMessage(g.grantee.display_name)` / `strings.endTutor` / `strings.cancel`, then calls `endGrant(g.id)`.
  - Add a "teaching" card for everyone: title `strings.teachingTitle`, and a link (testID `profile-invite`, label `strings.inviteStudent`) to `/students/invite`.

- [ ] **Step 8: Check it runs.**
  - From the root: `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.
  - Then start the lane's server and web app (`npm run server` and `npm run mobile` in the background, and check `bash scripts/lane-env.sh env | grep -E 'PORT|METRO'` for the URLs). Use the `run` skill or a quick Playwright script to load the web app, sign up a fresh user, and see `/enroll` with the teach button. Reach the invite screen and invite a learner created over the API, then see the student row on home.
  - Note what you saw in your report. Stop the processes afterwards.

- [ ] **Step 9: Commit.**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): invites, students and a home for a tutor who learns nothing" -m "<attribution>"
```

---

### Task 10: The shared lookup, tutor mode, and the student's words screen

**Files:**
- Create: `apps/mobile/src/components/LookupPanel.tsx` (moved out of `app/translate.tsx`)
- Create: `apps/mobile/src/hooks/useApi.tsx`
- Create: `apps/mobile/src/app/students/words.tsx`
- Modify: `apps/mobile/src/app/translate.tsx`, `apps/mobile/src/app/_layout.tsx` (wrap in `ApiProvider`)
- Modify: `apps/mobile/src/hooks/useTranslation.tsx`
- Modify: `apps/mobile/src/vocabulary.ts` (+ `vocabulary.test.ts`): `addableStateOf`
- Modify: `apps/mobile/src/enrollments.ts` (+ test if one covers it): `lookupDirection` takes a pair

**Interfaces:**
- Consumes: `studentGrant`, `endGrant` and the strings (Task 8); `api.saveVocabulary(actor, …)` (Task 4).
- Produces:

```ts
// vocabulary.ts
export function addableStateOf(senses: TranslationSense[], from: string, targetLanguage: string): SavedState;
// enrollments.ts
export function lookupDirection(pair: { source_language: string; target_language: string }): LookupDirection;
// hooks/useApi.tsx
export function ApiProvider(props: { api: ApiClient; children: ReactNode }): JSX.Element;
export function useApi(): ApiClient;
// hooks/useTranslation.tsx
export type LookupList = { enrollment: { id: string; source_language: string; target_language: string }; mode: 'learner' | 'tutor' };
TranslationProvider(props: { api: ApiClient; list?: LookupList; children: ReactNode });
// TranslationValue gains: mode: 'learner' | 'tutor'
```

- [ ] **Step 1: Move the translate body into `LookupPanel`, unchanged, as its own commit (spec D16).**
  - `components/LookupPanel.tsx` exports `LookupPanel()`.
  - It renders everything in `TranslateScreen` from the `directionRow` `View` to the end of the results `ScrollView`, plus the `SenseCard` component (or whatever the file names the card) and the styles they use. It calls `useTranslation()` itself.
  - `app/translate.tsx` keeps the `SafeAreaView`, the back/title header, `if (!t.direction) return <Redirect href="/" />;` (it still needs `useTranslation()` for that), and renders `<LookupPanel />`.
  - All testIDs stay the same. Run `npm run typecheck && npm test` from the root, then commit:

```bash
git add apps/mobile/src/app/translate.tsx apps/mobile/src/components/LookupPanel.tsx
git commit -m "refactor(mobile): the lookup is a panel the translate screen renders" -m "<attribution>"
```

- [ ] **Step 2: Write the failing unit test for `addableStateOf`.** In `src/vocabulary.test.ts`:

```ts
describe('addableStateOf (phase 28, tutor mode)', () => {
  const sense = (id: string | undefined, variant: string | undefined): TranslationSense =>
    ({ translation: 't', sense_id: id, variant_id: variant }) as TranslationSense;

  it('offers every sense with ids of a target-language lookup, none of them added yet', () => {
    expect(addableStateOf([sense('s1', 'v1'), sense('s2', 'v2')], 'it', 'it')).toEqual({ s1: false, s2: false });
  });

  it('leaves out a sense with no ids', () => {
    expect(addableStateOf([sense(undefined, undefined), sense('s2', 'v2')], 'it', 'it')).toEqual({ s2: false });
  });

  it('offers nothing on a reverse lookup: those senses are Hebrew (Review Focus 3)', () => {
    expect(addableStateOf([sense('s1', 'v1')], 'he', 'it')).toEqual({});
  });
});
```

Build the `TranslationSense` fixture with whatever required fields the type has. Copy the shape from the file's existing fixtures, not from the cast above.

- [ ] **Step 3: Run it and see it fail.** `npx jest src/vocabulary.test.ts` from `apps/mobile`. Expected: FAIL.

- [ ] **Step 4: Implement `addableStateOf`** in `src/vocabulary.ts`, beside `savedStateOf`:

```ts
/** Phase 28 (spec D10). A tutor's lookup carries no enrollment, so the server
 *  marks nothing as saved: reading which senses the student has would be reading
 *  their list. Every sense with ids of a lookup FROM the student's target language
 *  can be added; a reverse lookup's senses belong to Hebrew lexemes and cannot. */
export function addableStateOf(senses: TranslationSense[], from: string, targetLanguage: string): SavedState {
  if (from !== targetLanguage) return {};
  const state: SavedState = {};
  for (const sense of senses) if (sense.sense_id && sense.variant_id) state[sense.sense_id] = false;
  return state;
}
```

Run it again. Expected: PASS.

- [ ] **Step 5: `lookupDirection` takes a pair.** In `src/enrollments.ts`, change the parameter type to `pair: { source_language: string; target_language: string }`. An `Enrollment` still fits, and so does a grant's `enrollment`.

- [ ] **Step 6: `useApi`.** Create `hooks/useApi.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';

// Phase 28. The one ApiClient, for a screen that nests its own provider (the
// student's words screen nests a TranslationProvider). Received from the
// composition root like every other collaborator (ADR 0002).
const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi must be used inside an ApiProvider');
  return value;
}
```

In `app/_layout.tsx`, wrap the providers inside `SafeAreaProvider` with `<ApiProvider api={api}>…</ApiProvider>`.

- [ ] **Step 7: Tutor mode in `TranslationProvider`.** In `hooks/useTranslation.tsx`:
  - Export `type LookupList`. The provider takes `list?: LookupList`.
  - Derive the effective list once: `const effective = useMemo<LookupList | null>(() => list ?? (active ? { enrollment: active, mode: 'learner' } : null), [list, active]);`.
  - Use `effective?.enrollment` wherever the code used `active`, for the direction, the reset effect, the request and `send`. The reset effect depends on `effective?.enrollment.id`.
  - `TranslationValue` gains `mode: 'learner' | 'tutor'` (`effective?.mode ?? 'learner'`).
  - In `run`: send `enrollment_id` only when `effective.mode === 'learner'`. After the response, `setSaved(effective.mode === 'tutor' ? addableStateOf(response.senses, response.from, effective.enrollment.target_language) : savedStateOf(response.senses))`.
  - In `toggleSave`: in tutor mode, return when `saved[senseId]` is already `true`, because a tutor never removes (spec D10).
  - `send` passes `user.id` as the actor (Task 4 already did this), and in tutor mode is only ever called with `next === true`.
  - `canSaveAll` and `saveAll` work unchanged: `unsavedEntries` reads the `false` entries.

- [ ] **Step 8: Labels by mode in `LookupPanel`.** Where the panel shows `strings.translateSave`, `strings.translateSaved` and `strings.translateSaveAll`, choose `strings.tutorAdd`, `strings.tutorAdded` and `strings.tutorAddAll` when `t.mode === 'tutor'`. The testIDs stay the same: the e2e drives `translate-save` in both modes.

- [ ] **Step 9: The words screen** `app/students/words.tsx`:

```tsx
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LookupPanel } from '@/components/LookupPanel';
import { confirm } from '@/confirm';
import { studentGrant } from '@/grants';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { TranslationProvider } from '@/hooks/useTranslation';
import { strings } from '@/strings';
import { colors, fontSizes, spacing } from '@/theme';

/** Phase 28 (spec D10, D14). A tutor adds words to one student's list: the
 *  lookup panel in tutor mode, on the grant's enrollment. Only an ACCEPTED grant
 *  opens it. */
export default function StudentWordsScreen() {
  const api = useApi();
  const { grant: grantId } = useLocalSearchParams<{ grant: string }>();
  const { user, grants, endGrant } = useCurrentUser();
  if (!user) return <Redirect href="/login" />;
  const grant = grantId ? studentGrant(grants, grantId) : undefined;
  if (!grant) return <Redirect href="/" />;

  async function onStop() {
    if (!grant) return;
    const yes = await confirm({
      title: strings.stopTutoringTitle,
      message: strings.stopTutoringMessage(grant.owner.display_name),
      confirm: strings.stopTutoring(grant.owner.display_name),
      cancel: strings.cancel,
    });
    if (!yes) return;
    await endGrant(grant.id);
    router.back();
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="student-words-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text testID="student-words-title" style={styles.title}>
          {strings.studentWordsTitle(grant.owner.display_name, grant.enrollment.target_language)}
        </Text>
      </View>
      <TranslationProvider api={api} list={{ enrollment: grant.enrollment, mode: 'tutor' }}>
        <LookupPanel />
      </TranslationProvider>
      <Pressable accessibilityRole="button" testID="student-stop" onPress={onStop} style={styles.stop}>
        <Text style={styles.link}>{strings.stopTutoring(grant.owner.display_name)}</Text>
      </Pressable>
    </SafeAreaView>
  );
}
```

Copy the `screen`, `header`, `title` and `link` styles from `app/translate.tsx`'s header so the two screens look alike. `stop` is `{ paddingVertical: spacing.md, alignItems: 'center' }`. Use only theme tokens that exist in `@/theme`.

- [ ] **Step 10: Check it runs.**
  - From the root: `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.
  - Then run the lane's server and web app and walk the flow:
    1. invite a learner, then accept it as the learner (switch user on the profile screen);
    2. as the tutor, open the student and look up a word. The dictionary in this lane is empty, so run `npm run dict:restore` first, or look up a word the seed holds;
    3. add the word and see "נוסף ✓";
    4. as the learner, see the word in the saved list.
  - Note what you saw. Stop the processes.

- [ ] **Step 11: Commit.**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): a tutor looks up and adds words to a student's list" -m "<attribution>"
```

---

### Task 11: The label in the app — the list and the word's page

**Files:**
- Modify: `apps/mobile/src/app/vocabulary/index.tsx` (the row)
- Modify: `apps/mobile/src/app/vocabulary/word.tsx` (the sense card)

**Interfaces:**
- Consumes: `VocabularyWord.added_by` and `VocabularySense.added_by` (Task 6); `strings.addedBy` (Task 8).
- Produces: the testIDs `vocabulary-added-by` (list row) and `vocabulary-sense-added-by` (sense card).

- [ ] **Step 1: The list row.** In `app/vocabulary/index.tsx`, inside the row component that renders an item's headline (find where `item.headline` is rendered), add below the headline:

```tsx
            {item.added_by.length > 0 ? (
              <Text testID="vocabulary-added-by" style={styles.addedBy}>
                {strings.addedBy(item.added_by)}
              </Text>
            ) : null}
```

with `addedBy: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' }`. Check that `fontSizes.sm` exists in `@/theme`, and use the smallest existing size if it does not.

- [ ] **Step 2: The sense card.** In `app/vocabulary/word.tsx`, below the sense's translation line, add:

```tsx
              {sense.added_by ? (
                <Text testID="vocabulary-sense-added-by" style={styles.addedBy}>
                  {strings.addedBy([sense.added_by])}
                </Text>
              ) : null}
```

with the same style.

- [ ] **Step 3: Check and commit.** From the root: `npm run typecheck && npm test && npm run lint:arch`. Expected: PASS.

```bash
git add apps/mobile/src/app/vocabulary
git commit -m "feat(mobile): the saved list and a word's page say who added it" -m "<attribution>"
```

---

### Task 12: E2E — the whole tutor flow

**Files:**
- Modify: `e2e/tests/support/users.ts`
- Create: `e2e/tests/tutor.spec.ts`

**Interfaces:**
- Consumes: every testID listed in Tasks 9–11; `lookUp` and `tapAndWaitForWrite` from `support/interactions`; `LUK` from `support/lexemes` (a Russian word with senses); `clearGemini` from `support/mockServer`.
- Produces: `createUser(request, username, displayName): Promise<User>` and `logIn(page, username, landing = 'start-button')`.

- [ ] **Step 1: The support helpers.** In `e2e/tests/support/users.ts`:

```ts
/** Phase 28. An account with no enrollment, under its own display name: a tutor
 *  who learns nothing, whose name the student will see on a label. */
export async function createUser(request: APIRequestContext, username: string, displayName: string): Promise<User> {
  const res = await request.post(`${API_URL}/api/users`, {
    data: { ...learnerFor(username), display_name: displayName },
  });
  if (!res.ok()) throw new Error(`could not create ${username}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as User;
}
```

`logIn` gains `landing = 'start-button'` and waits for `page.getByTestId(landing)` instead of the hardcoded id. Existing callers are unchanged.

- [ ] **Step 2: Write the spec** `e2e/tests/tutor.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';

import { lookUp, tapAndWaitForWrite } from './support/interactions';
import { LUK } from './support/lexemes';
import { clearGemini } from './support/mockServer';
import { createLearner, createUser, logIn } from './support/users';

test.setTimeout(180_000);

const TUTOR = 'e2e_tutor_rina';
const STUDENT = 'e2e_tutor_student';

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

/** Waits for a grant call to answer before anything reloads. */
async function tapAndWaitForGrant(page: Page, testId: string, method: 'POST' | 'DELETE') {
  const answered = page.waitForResponse(
    (res) => /\/api\/grants/.test(res.url()) && res.request().method() === method,
  );
  await page.getByTestId(testId).click();
  expect((await answered).ok()).toBe(true);
}

test('a tutor invites a student, adds a word to their list, and the student ends it', async ({ page, request }) => {
  await createUser(request, TUTOR, 'רינה');
  await createLearner(request, STUDENT, 'ru');

  // 1. A tutor who learns nothing is offered to teach, and invites the student.
  await logIn(page, TUTOR, 'enroll-teach');
  await page.getByTestId('enroll-teach').click();
  await page.getByTestId('invite-username').fill(STUDENT);
  await page.getByTestId('invite-language-ru').click();
  await tapAndWaitForGrant(page, 'invite-submit', 'POST');
  await expect(page.getByTestId(`student-${STUDENT}`)).toBeVisible();

  // 2. The student sees the invite on home and accepts it.
  await logIn(page, STUDENT);
  await expect(page.getByTestId('invite-card')).toContainText('רינה');
  await tapAndWaitForGrant(page, 'invite-accept', 'POST');
  await expect(page.getByTestId('invite-card')).toHaveCount(0);

  // 3. The tutor opens the student and adds a word.
  await logIn(page, TUTOR, `student-${STUDENT}`);
  await page.getByTestId(`student-${STUDENT}`).click();
  await expect(page.getByTestId('student-words-title')).toBeVisible();
  await lookUp(page, request, 'лук', LUK);
  const add = page.getByTestId('translate-save').first();
  await tapAndWaitForWrite(page, add);
  await expect(add).toHaveText('נוסף ✓');

  // 4. The student's saved list says who added it.
  await logIn(page, STUDENT);
  await page.getByTestId('vocabulary-entry').click();
  await expect(page.getByTestId('vocabulary-added-by').first()).toHaveText('נוספה ע״י רינה');

  // 5. The student ends the link; the tutor no longer has them.
  await logIn(page, STUDENT);
  await page.getByTestId('profile-button').click();
  page.once('dialog', (dialog) => void dialog.accept());
  await tapAndWaitForGrant(page, `tutor-end-${TUTOR}`, 'DELETE');
  await expect(page.getByTestId(`tutor-${TUTOR}`)).toHaveCount(0);

  await logIn(page, TUTOR, 'enroll-teach');
  await expect(page.getByTestId(`student-${STUDENT}`)).toHaveCount(0);
});
```

Before running it, check:
- that `LUK` exists in `support/lexemes.ts` and is a Russian payload `lookUp` accepts (`vocabulary.spec.ts` uses it exactly this way);
- that the save button's testID inside `LookupPanel` is `translate-save`;
- that `confirm()` on web goes through `globalThis.confirm`, which Playwright answers through the `dialog` event (`src/confirm.ts`).

- [ ] **Step 3: Run the e2e suite.** From the root: `npm run e2e`. This builds the web export, starts the lane's e2e server, and needs MockServer. If MockServer is not up, `npm run e2e` says how to start it. Read `e2e/globalSetup.ts` rather than guessing.
  - Expected: `tutor.spec.ts` passes, and every other spec still passes. The other specs exercise saves, which now carry the header.
  - If a spec fails, use superpowers:systematic-debugging. Never weaken an assertion to pass.

- [ ] **Step 4: Commit.**

```bash
git add e2e
git commit -m "test(e2e): a tutor invites, adds a word, and the student ends it" -m "<attribution>"
```

---

### Task 13: Whole-branch verification and the spec as built

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-lang-tutor-phase-28-tutor-words-design.md`

- [ ] **Step 1: Run every gate.** From the root, in order: `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run lint:arch`, `npm run e2e`. Expected: all PASS. Paste the summary lines (suites, tests, failures) into your report.
- [ ] **Step 2: Record what was built.** In the spec's Status line, add "Built on 2026-10-07; see the plan `docs/superpowers/plans/2026-10-07-phase-28-tutor-words.md`." Add a short "### Deviations as built" at the end of §1 listing any decision the build departed from. One known deviation is already in this plan: everyone gets an "Invite a student" link on profile (Task 9 Step 7), which D14 did not mention, so that a learner can become a tutor. Add any others the tasks reported.
- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/specs/2026-10-07-lang-tutor-phase-28-tutor-words-design.md
git commit -m "docs: phase 28 spec as built" -m "<attribution>"
```
