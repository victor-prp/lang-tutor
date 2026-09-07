# Phase 8 — User onboarding and username identity: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the anonymous client-generated device UUID with a named user who logs in by username, onboards by answering five questions, and can view their profile.

**Architecture:** Additive first, destructive last. Tasks 1–5 add a `users` write path and two endpoints without touching existing behaviour; tasks 6–9 migrate the mobile app and the e2e suite onto it; only then does task 10 delete `upsertUser` and tighten the columns to `NOT NULL`. Every task leaves the repo green, including `npm run e2e`.

**Tech Stack:** TypeScript throughout. `packages/core` — Zod 4 wire schemas. `apps/server` — Hono + `@hono/zod-openapi`, Drizzle ORM over Postgres 17, Jest (two projects: `unit`, `integration`). `apps/mobile` — Expo 57, expo-router, Jest via `jest-expo`. `e2e` — Playwright.

**Spec:** [`docs/superpowers/specs/2026-09-07-lang-tutor-phase-8-onboarding-design.md`](../specs/2026-09-07-lang-tutor-phase-8-onboarding-design.md)

## Global Constraints

Every task's requirements implicitly include these.

- **ADR 0001 (layering).** `routes/` must not import `db/`, `repo/`, `drizzle-orm` or `pg`. `services/` must not import anything under `db/`, must not import Hono, and may reference `repo/` modules **only** as `import type`. `domain/` imports `@lang-tutor/core/*` only. `console` appears only in `logger.ts`, `index.ts` and `db/cli.ts`. `.transaction(` appears only in `db/transaction.ts`.
- **ADR 0002 (DI).** No `process.env` outside `index.ts`, `db/cli.ts`, `_layout.tsx`. No `jest.mock` anywhere in `apps/server` or `apps/mobile`. No optional or defaulted collaborator parameters (`logger?:`, `storage = …` and friends). No module-level `export const x = createX(...)`. Every factory's exported type is `ReturnType<typeof createX>`, never hand-written.
- **ADR 0003 (OpenAPI).** Endpoints are declared with `createRoute` + `router.openapi(...)` — never a raw `.post(`/`.get(` in `routes/` or `app.ts`. Wire schemas live only in `packages/core/src/api/schemas.ts`. Every export in `packages/core/src/api/types.ts` is a `z.infer`. `packages/core/src/api/index.ts` exports types only. Any router validating a body supplies the `defaultHook` returning `{ error: 'invalid request' }` with status 400.
- **ADR 0004 (test topology).** `apps/server/src/**/*.test.ts` must not import `pg`, `drizzle-orm`, or `src/db/{client,migrate,seed,cli}`, and from `tests/support/` may import only `fakes.ts` and `testRng.ts`. Database-backed tests live under `apps/server/tests/integration/`, mirroring the `src/` path of what they test.
- **Language codes are `'he'` and `'en'`** — nothing else is accepted by `CreateUserRequestSchema` in this phase.
- **Username format** is exactly `^[a-z0-9_]{3,30}$`, enforced identically in the Zod schema and a database `CHECK`.
- **`age`** is an integer in `[3, 120]`, enforced in both places. **`display_name`** length is `[1, 60]`, enforced in both places.
- **All new user-facing copy is Hebrew** and lives in `apps/mobile/src/strings.ts`. No string literals in screens.
- **No credentials.** No password field, no token, no `bcrypt`/`argon2`/`jsonwebtoken`/`expo-secure-store`. Task 11 adds the grep that enforces this.

## Commands

| Purpose | Command |
|---|---|
| Core unit tests | `npm test -w @lang-tutor/core` |
| Server unit tests | `npm test -w apps/server` |
| Server integration tests | `npm run db:up && npm run test:integration -w apps/server` |
| Mobile unit tests | `npm test -w apps/mobile` |
| Generate a migration | `npm run db:generate -w apps/server` |
| Apply migrations locally | `npm run db:migrate` |
| Typecheck everything | `npm run typecheck` |
| ADR checks | `npm run lint:arch` |
| End-to-end | `npm run e2e` |

---

## File structure

**Created**

| File | Responsibility |
|---|---|
| `apps/server/src/repo/users.ts` | Three persistence primitives over `users`: insert, find-by-username, find-by-id. Owns the unique-violation → `UsernameTaken` translation. |
| `apps/server/src/services/transaction.ts` | The `Repos` and `Transaction` types, extracted from `services/sessions.ts` so two services can share one transaction shape. Types only, no runtime code. |
| `apps/server/src/services/users.ts` | Two use cases — `register`, `login` — one transaction each. |
| `apps/server/src/services/users.test.ts` | Unit half: both use cases against a fake transaction. |
| `apps/server/src/routes/users.ts` | `POST /users` and `POST /login` as `createRoute` definitions plus handlers. |
| `apps/server/tests/integration/repo/users.test.ts` | Proves the database constraints actually reject. |
| `apps/server/tests/integration/services/users.test.ts` | Proves the use cases behave against real Postgres. |
| `apps/server/tests/integration/routes/users.test.ts` | Status codes and bodies. |
| `apps/mobile/src/currentUser.ts` | The remembered-username store. Pure, storage injected. |
| `apps/mobile/src/currentUser.test.ts` | Its unit test. |
| `apps/mobile/src/hooks/useCurrentUser.tsx` | `CurrentUserProvider` + `useCurrentUser` — the logged-in user in memory. |
| `apps/mobile/src/app/login.tsx` | Login screen. |
| `apps/mobile/src/app/onboarding.tsx` | Five-field account creation. |
| `apps/mobile/src/app/profile.tsx` | Read-only profile + switch user. |
| `e2e/tests/support/users.ts` | Creates a learner over HTTP and drives the login screen. Shared by both specs. |
| `e2e/tests/onboarding.spec.ts` | Create-account and unknown-username journeys. |
| `docs/adr/adr-0005-identity-without-authentication.md` | The ADR. |
| `scripts/check-adr-0005-identity-without-authentication.sh` | Its enforcement. |

**Modified**

| File | Change |
|---|---|
| `packages/core/src/api/schemas.ts` | `UsernameSchema`, `LanguageCodeSchema`, `UserSchema`, `CreateUserRequestSchema`, `LoginRequestSchema` |
| `packages/core/src/api/types.ts` | `User`, `CreateUserRequest`, `LoginRequest` — all `z.infer` |
| `packages/core/src/api/index.ts` | Re-export the three types |
| `packages/core/src/api/schemas.test.ts` | Validation tests for the new schemas |
| `apps/server/src/db/schema.ts` | `users` gains `username`, `display_name`, `age`, four `CHECK`s, and a generated `id` default |
| `apps/server/src/errors.ts` | `UsernameTaken`, `UserNotFound`, `InvalidLanguagePair` |
| `apps/server/src/services/sessions.ts` | Imports `Transaction` from `./transaction`; requires an existing user (task 10) |
| `apps/server/src/repo/sessions.ts` | `upsertUser` deleted (task 10) |
| `apps/server/src/routes/sessions.ts` | Maps `UserNotFound` to 404 (task 10) |
| `apps/server/src/composition.ts` | Binds `user` into the transaction, wires `createUserService`, adds `users` to `AppDeps` |
| `apps/server/src/app.ts` | Mounts the users router at `/api` |
| `apps/server/src/openapi.test.ts` | Asserts `/api/users` and `/api/login` are published |
| `apps/server/tests/support/fakes.ts` | `createFakeAppDeps` gains `users` |
| `apps/server/tests/integration/{services,routes}/sessions.test.ts` | Create a user first; assert 404 for an unknown one (task 10) |
| `apps/mobile/src/api/client.ts` | `login`, `createUser` |
| `apps/mobile/src/api/client.test.ts` | Their tests |
| `apps/mobile/src/app/_layout.tsx` | Builds the username store, wraps `CurrentUserProvider`; drops `expo-crypto` |
| `apps/mobile/src/app/index.tsx` | Redirects to `/login` when logged out; profile affordance |
| `apps/mobile/src/hooks/useSession.tsx` | Reads the user id from `useCurrentUser` instead of a `UserIdStore` |
| `apps/mobile/src/strings.ts` | Hebrew copy for three screens |
| `e2e/tests/session.spec.ts` | Logs in before starting a session |
| `docs/adr/adr-0002-di-with-closures.md` | R6's factory list |
| `README.md` | Data model, architecture, phase index, the "no auth" sentence |

**Deleted**

| File | Why |
|---|---|
| `apps/mobile/src/userId.ts` | The server issues ids now |
| `apps/mobile/src/userId.test.ts` | With it |

---

### Task 1: The wire contract for users

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (append)
- Modify: `packages/core/src/api/types.ts` (append to both the import list and the exports)
- Modify: `packages/core/src/api/index.ts`
- Test: `packages/core/src/api/schemas.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `UsernameSchema: z.ZodString` — matches `/^[a-z0-9_]{3,30}$/`
  - `LanguageCodeSchema` — `z.enum(['he', 'en'])`
  - `UserSchema` → `{ id: string; username: string; display_name: string; age: number; native_language: string; target_language: string }`
  - `CreateUserRequestSchema` → same minus `id`, with `native_language`/`target_language` narrowed to `'he' | 'en'`
  - `LoginRequestSchema` → `{ username: string }`
  - types `User`, `CreateUserRequest`, `LoginRequest`

`UserSchema`'s language fields are plain `z.string()` on purpose: it describes a **response** built from a `varchar(10)` column, and narrowing it to an enum would make a future third language a runtime validation failure in already-shipped clients. The **request** schema is narrow, because that is where today's accepted values belong.

There is deliberately **no** `.refine()` for "native ≠ target". `@hono/zod-openapi` has to convert this schema to JSON Schema, and a refinement is not representable there; the rule is enforced by the service (task 4) and by a database `CHECK` (task 2) instead.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/api/schemas.test.ts`:

```ts
describe('UsernameSchema', () => {
  it.each(['abc', 'a_b_c', 'user_123', 'a'.repeat(30)])('accepts %s', (value) => {
    expect(UsernameSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(31)],
    ['uppercase', 'Alice'],
    ['a space', 'a b'],
    ['a hyphen', 'a-b'],
    ['Hebrew', 'דנה'],
  ])('rejects %s', (_label, value) => {
    expect(UsernameSchema.safeParse(value).success).toBe(false);
  });
});

describe('CreateUserRequestSchema', () => {
  const valid = {
    username: 'dana',
    display_name: 'דנה',
    age: 34,
    native_language: 'he',
    target_language: 'en',
  };

  it('accepts a well-formed request', () => {
    expect(CreateUserRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['an empty display_name', { display_name: '' }],
    ['a display_name over 60 characters', { display_name: 'א'.repeat(61) }],
    ['an age below 3', { age: 2 }],
    ['an age above 120', { age: 121 }],
    ['a fractional age', { age: 9.5 }],
    ['an unsupported language', { target_language: 'fr' }],
    ['a malformed username', { username: 'Dana' }],
  ])('rejects %s', (_label, override) => {
    expect(CreateUserRequestSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  // Deliberately accepted at the schema level: the service and a database
  // CHECK reject it. A refinement here would not survive JSON Schema output.
  it('does not itself reject a matching language pair', () => {
    expect(
      CreateUserRequestSchema.safeParse({ ...valid, target_language: 'he' }).success,
    ).toBe(true);
  });
});

describe('LoginRequestSchema', () => {
  it('accepts a well-formed username', () => {
    expect(LoginRequestSchema.safeParse({ username: 'dana' }).success).toBe(true);
  });

  it('rejects a malformed username', () => {
    expect(LoginRequestSchema.safeParse({ username: 'D' }).success).toBe(false);
  });
});

describe('UserSchema', () => {
  it('accepts a language code it does not narrow', () => {
    const parsed = UserSchema.safeParse({
      id: 'u1',
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he',
      target_language: 'fr',
    });
    expect(parsed.success).toBe(true);
  });
});
```

Extend the existing import at the top of the file to include `CreateUserRequestSchema`, `LoginRequestSchema`, `UserSchema` and `UsernameSchema`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @lang-tutor/core`
Expected: FAIL — `UsernameSchema` and the other three are not exported from `./schemas`.

- [ ] **Step 3: Add the schemas**

Append to `packages/core/src/api/schemas.ts`:

```ts
// Identity, phase 8. A username identifies a learner; it authenticates nothing.
// Lowercase ASCII so it is unambiguous to type on an RTL keyboard, in a URL,
// and in a test. The display name carries the Hebrew.
export const UsernameSchema = z.string().regex(/^[a-z0-9_]{3,30}$/);

// The pair this app supports today. Narrow on the way in only — see UserSchema.
export const LanguageCodeSchema = z.enum(['he', 'en']);

// A response shape, so the language fields are plain strings: they are read from
// a varchar(10) column, and narrowing them here would turn a future third
// language into a validation failure inside clients that shipped before it.
export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string(),
  age: z.number().int(),
  native_language: z.string(),
  target_language: z.string(),
});

// No .refine() for native !== target. @hono/zod-openapi converts this to JSON
// Schema, which cannot express a cross-field rule; the service raises
// InvalidLanguagePair and a database CHECK is the backstop.
export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  display_name: z.string().min(1).max(60),
  age: z.number().int().min(3).max(120),
  native_language: LanguageCodeSchema,
  target_language: LanguageCodeSchema,
});

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
});
```

- [ ] **Step 4: Infer and export the types**

In `packages/core/src/api/types.ts`, add `CreateUserRequestSchema`, `LoginRequestSchema` and `UserSchema` to the existing `import type { … } from './schemas'` list, then append:

```ts
export type User = z.infer<typeof UserSchema>;
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
```

In `packages/core/src/api/index.ts`, add `CreateUserRequest`, `LoginRequest` and `User` to the alphabetically-sorted `export type { … } from './types'` list.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @lang-tutor/core && npm run typecheck`
Expected: PASS, and no type errors anywhere in the monorepo.

- [ ] **Step 6: Run the ADR checks**

Run: `npm run lint:arch`
Expected: no output before the summary — in particular ADR 0003 R3 (every export in `types.ts` is a `z.infer`) and R4 (`index.ts` exports types only) still hold.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/api
git commit -m "feat(core): add the user, create-user and login wire schemas"
```

---

### Task 2: The `users` table gains its profile columns

**Files:**
- Modify: `apps/server/src/db/schema.ts:19-24` (the `users` table)
- Create: `apps/server/src/db/migrations/<generated>.sql` (produced by drizzle-kit, not hand-written)
- Test: `apps/server/tests/integration/repo/users.test.ts` (created here, extended in task 3)

**Interfaces:**
- Consumes: nothing.
- Produces: the `users` Drizzle table with `username`, `displayName`, `age` columns and four `CHECK` constraints. Column names on the TypeScript side are `username`, `displayName`, `age`; in SQL they are `username`, `display_name`, `age`.

**The columns are added NULLABLE here, on purpose.** `repo/sessions.ts`'s `upsertUser` still inserts a bare `{ id }` on first session, and will keep doing so until task 10. Adding `NOT NULL` now would break every existing session test in this same commit. Task 10 backfills and tightens them once nothing creates a bare user any more. This is the standard two-step for a non-null column on a live table, and it is what keeps every task in this plan green.

The four `CHECK`s can go in now regardless: a `CHECK` evaluates to `NULL` for a `NULL` input, and Postgres accepts anything that is not `FALSE`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/integration/repo/users.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { users } from '../../../src/db/schema';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

const DANA = {
  username: 'dana',
  displayName: 'דנה',
  age: 34,
  nativeLanguage: 'he',
  targetLanguage: 'en',
};

describe('the users table', () => {
  it('generates an id when the caller supplies none', async () => {
    const [row] = await withTx(t.db, (tx) => tx.insert(users).values(DANA).returning());
    // A UUID, not something a client picked: 36 characters with four hyphens.
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('rejects a second row with the same username', async () => {
    await withTx(t.db, (tx) => tx.insert(users).values(DANA));
    await expect(
      withTx(t.db, (tx) => tx.insert(users).values({ ...DANA, displayName: 'אחר' })),
    ).rejects.toThrow();
  });

  it.each([
    ['an uppercase username', { username: 'Dana' }],
    ['a two-character username', { username: 'da' }],
    ['an empty display name', { displayName: '' }],
    ['an age below the floor', { age: 2 }],
    ['an age above the ceiling', { age: 121 }],
    ['a language pair that matches', { targetLanguage: 'he' }],
  ])('rejects %s', async (_label, override) => {
    await expect(
      withTx(t.db, (tx) => tx.insert(users).values({ ...DANA, ...override })),
    ).rejects.toThrow();
  });

  // Transitional: upsertUser still writes a bare row until task 10 tightens
  // these columns to NOT NULL. Delete this test in task 10.
  it('still accepts a row with no profile, until task 10', async () => {
    const [row] = await withTx(t.db, (tx) =>
      tx.insert(users).values({ id: 'legacy-1' }).returning(),
    );
    expect(row.username).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run db:up && npm run test:integration -w apps/server -- users`
Expected: FAIL — `username`, `displayName` and `age` do not exist on the `users` table, so this will not even compile.

- [ ] **Step 3: Change the schema**

Replace the `users` table in `apps/server/src/db/schema.ts` with:

```ts
export const users = pgTable(
  'users',
  {
    // Server-issued. Once a username is the client-facing handle, a
    // client-chosen id can only collide or impersonate. Generated by the
    // database rather than the application so no randomness enters a layer
    // ADR 0002 R1 would have to police — the same reason sessions.id does it.
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // Nullable until task 10: upsertUser still writes a bare row.
    username: text('username').unique(),
    displayName: text('display_name'),
    age: integer('age'),
    nativeLanguage: varchar('native_language', { length: 10 }).notNull().default('he'),
    targetLanguage: varchar('target_language', { length: 10 }).notNull().default('en'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mirrors UsernameSchema in packages/core exactly. Two enforcement points
    // for one rule is deliberate: the schema gives a 400 with a good message,
    // the constraint is what actually holds when something bypasses the route.
    check('users_username_format', sql`${t.username} ~ '^[a-z0-9_]{3,30}$'`),
    check('users_display_name_length', sql`length(${t.displayName}) between 1 and 60`),
    check('users_age_range', sql`${t.age} between 3 and 120`),
    check('users_languages_differ', sql`${t.nativeLanguage} <> ${t.targetLanguage}`),
  ],
);
```

`integer` is already imported at the top of the file; `check`, `sql`, `text`, `varchar` and `timestamp` are too.

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate -w apps/server`
Expected: a new file under `apps/server/src/db/migrations/`. Open it and confirm it contains `ADD COLUMN "username" text`, the unique constraint, four `ADD CONSTRAINT … CHECK`, and `ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text`. It must contain **no** `SET NOT NULL` — if it does, the schema edit was wrong.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:integration -w apps/server -- users`
Expected: PASS, all eight cases.

- [ ] **Step 6: Verify nothing else regressed**

Run: `npm run test:integration -w apps/server && npm test -w apps/server && npm run typecheck`
Expected: PASS. The existing session tests still work because `upsertUser`'s bare insert is still legal.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db apps/server/tests/integration/repo/users.test.ts
git commit -m "feat(server): give users a username, display name and age

Nullable for now: upsertUser still writes a bare row. The CHECK constraints
go in immediately since they are satisfied by NULL."
```

---

### Task 3: `repo/users.ts`

**Files:**
- Create: `apps/server/src/repo/users.ts`
- Modify: `apps/server/src/errors.ts` (append `UsernameTaken`)
- Test: `apps/server/tests/integration/repo/users.test.ts` (append a second `describe`)

**Interfaces:**
- Consumes: the `users` table from task 2; `User` and `CreateUserRequest` from task 1.
- Produces:
  ```ts
  export function createUserRepo(tx: Tx): {
    insertUser(input: CreateUserRequest): Promise<User>;
    findByUsername(username: string): Promise<User | undefined>;
    findById(id: string): Promise<User | undefined>;
  };
  export type UserRepo = ReturnType<typeof createUserRepo>;
  ```
  and `class UsernameTaken extends Error` with a readonly `username` field.

**Why the repository translates the unique violation rather than the service checking first.** A `SELECT … WHERE username = $1` followed by an `INSERT` has a window between the two statements in which another transaction can insert the same username; the unique constraint is the only thing that actually holds. So `insertUser` inserts optimistically and turns SQLSTATE `23505` into `UsernameTaken`. Detecting it needs a cause-chain walk rather than a direct `error.code` read, because Drizzle 0.45 wraps driver errors in a `DrizzleQueryError` whose `cause` is the `pg` error — and older paths throw the `pg` error directly. Walking the chain is correct under both.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/tests/integration/repo/users.test.ts`:

```ts
import { UsernameTaken } from '../../../src/errors';
import { createUserRepo } from '../../../src/repo/users';

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
  target_language: 'en' as const,
};

describe('createUserRepo', () => {
  it('inserts a user and returns it with a generated id', async () => {
    const user = await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));

    expect(user).toEqual({
      id: expect.any(String),
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he',
      target_language: 'en',
    });
    expect(user.id.length).toBeGreaterThan(0);
  });

  it('throws UsernameTaken rather than a raw driver error on a duplicate', async () => {
    await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));

    await expect(
      withTx(t.db, (tx) => createUserRepo(tx).insertUser({ ...REQUEST, display_name: 'אחרת' })),
    ).rejects.toBeInstanceOf(UsernameTaken);
  });

  it('finds a user by username', async () => {
    const created = await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));
    const found = await withTx(t.db, (tx) => createUserRepo(tx).findByUsername('dana'));
    expect(found).toEqual(created);
  });

  it('returns undefined for a username nobody has', async () => {
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findByUsername('nobody'))).toBeUndefined();
  });

  it('finds a user by id', async () => {
    const created = await withTx(t.db, (tx) => createUserRepo(tx).insertUser(REQUEST));
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findById(created.id))).toEqual(created);
  });

  it('returns undefined for an id nobody has', async () => {
    expect(await withTx(t.db, (tx) => createUserRepo(tx).findById('no-such-id'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -w apps/server -- users`
Expected: FAIL — `src/repo/users` does not exist.

- [ ] **Step 3: Add the error**

Append to `apps/server/src/errors.ts`:

```ts
export class UsernameTaken extends Error {
  constructor(readonly username: string) {
    super(`username ${username} is already taken`);
    this.name = 'UsernameTaken';
  }
}
```

- [ ] **Step 4: Write the repository**

Create `apps/server/src/repo/users.ts`:

```ts
import type { CreateUserRequest, User } from '@lang-tutor/core/api';
import { eq } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { users } from '../db/schema';
import { UsernameTaken } from '../errors';

// The columns are nullable until task 10 tightens them, so the row type is
// wider than User. Anything this function is handed came from an INSERT that
// supplied every field, or from a SELECT filtered to rows that have one.
type UserRow = typeof users.$inferSelect;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username!,
    display_name: row.displayName!,
    age: row.age!,
    native_language: row.nativeLanguage,
    target_language: row.targetLanguage,
  };
}

/**
 * Drizzle 0.45 wraps a driver error in a DrizzleQueryError whose `cause` is the
 * pg error carrying `code`; other paths throw the pg error directly. Walking the
 * chain is correct under both, and stays correct if another wrapper is added.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error; current != null; ) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createUserRepo(tx: Tx) {
  return {
    /**
     * Inserts optimistically and lets the unique constraint decide. A
     * check-then-insert would race: the gap between the SELECT and the INSERT
     * is exactly long enough for another transaction to take the username.
     */
    insertUser: async (input: CreateUserRequest): Promise<User> => {
      try {
        const [row] = await tx
          .insert(users)
          .values({
            username: input.username,
            displayName: input.display_name,
            age: input.age,
            nativeLanguage: input.native_language,
            targetLanguage: input.target_language,
          })
          .returning();
        return toUser(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new UsernameTaken(input.username);
        throw error;
      }
    },

    findByUsername: async (username: string): Promise<User | undefined> => {
      const [row] = await tx.select().from(users).where(eq(users.username, username));
      return row ? toUser(row) : undefined;
    },

    findById: async (id: string): Promise<User | undefined> => {
      const [row] = await tx.select().from(users).where(eq(users.id, id));
      return row ? toUser(row) : undefined;
    },
  };
}

export type UserRepo = ReturnType<typeof createUserRepo>;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:integration -w apps/server -- users`
Expected: PASS.

- [ ] **Step 6: Check layering and types**

Run: `npm run lint:arch && npm run typecheck`
Expected: clean. ADR 0001 R4 permits `repo/` to import `drizzle-orm`, `db/*` and the leaf `errors` module.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/repo/users.ts apps/server/src/errors.ts apps/server/tests/integration/repo/users.test.ts
git commit -m "feat(server): add the users repository

insertUser lets the unique constraint decide rather than checking first —
a check-then-insert races with a concurrent registration."
```

---

### Task 4: `services/users.ts` and a shared transaction type

**Files:**
- Create: `apps/server/src/services/transaction.ts`
- Create: `apps/server/src/services/users.ts`
- Create: `apps/server/src/services/users.test.ts` (unit)
- Modify: `apps/server/src/services/sessions.ts:22-30` (import the shared types instead of declaring them)
- Modify: `apps/server/src/errors.ts` (append two errors)
- Modify: `apps/server/tests/support/fakes.ts` (append two fakes)
- Test: `apps/server/tests/integration/services/users.test.ts`

**Interfaces:**
- Consumes: `UserRepo` and `UsernameTaken` from task 3; `User`, `CreateUserRequest` from task 1.
- Produces:
  ```ts
  // services/transaction.ts
  export type Repos = { session: SessionRepo; question: QuestionRepo; user: UserRepo };
  export type Transaction = <T>(run: (repos: Repos) => Promise<T>) => Promise<T>;

  // services/users.ts
  export function createUserService(deps: { transaction: Transaction; logger: Logger }): {
    register(input: CreateUserRequest): Promise<User>;
    login(username: string): Promise<User>;
  };
  export type UserService = ReturnType<typeof createUserService>;

  // errors.ts
  export class UserNotFound extends Error { readonly identifier: string }
  export class InvalidLanguagePair extends Error { readonly languageCode: string }

  // tests/support/fakes.ts
  export function createInMemoryUserRepo(): UserRepo & { rows: User[] };
  export function createFakeTransaction(user: UserRepo): Transaction;
  ```

`Repos` and `Transaction` currently live in `services/sessions.ts`. Two services cannot both own that shape, so they move to `services/transaction.ts` — a types-only module. This is not a rename for tidiness: `composition.ts` binds one repo set for the whole app, so the type describing it has to be reachable from every service that receives it.

`register` validates the language pair **before** opening a transaction, and logs **after** it resolves — the same ordering `services/sessions.ts` uses for `logCompletedSession`, and for the same reason: a commit that fails after the log would leave a line claiming a user the database never recorded.

- [ ] **Step 1: Write the failing unit test**

Create `apps/server/src/services/users.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { createFakeLogger, createFakeTransaction, createInMemoryUserRepo } from '../../tests/support/fakes';
import { InvalidLanguagePair, UsernameTaken, UserNotFound } from '../errors';
import { createUserService } from './users';

// The other half of this file's tests is
// tests/integration/services/users.test.ts, which covers what only real
// Postgres can decide — the unique constraint, above all.

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
  target_language: 'en' as const,
};

function build() {
  const repo = createInMemoryUserRepo();
  const logger = createFakeLogger();
  const service = createUserService({ transaction: createFakeTransaction(repo), logger });
  return { repo, logger, service };
}

describe('register', () => {
  it('returns the created user', async () => {
    const { service } = build();
    const user = await service.register(REQUEST);
    expect(user.username).toBe('dana');
    expect(user.display_name).toBe('דנה');
    expect(user.id).toEqual(expect.any(String));
  });

  it('logs the registration once the write has resolved', async () => {
    const { service, logger } = build();
    const user = await service.register(REQUEST);
    expect(logger.events).toEqual([
      { event: 'user_registered', user_id: user.id, username: 'dana' },
    ]);
  });

  it('rejects a matching language pair without writing anything', async () => {
    const { service, repo } = build();
    await expect(
      service.register({ ...REQUEST, target_language: 'he' }),
    ).rejects.toBeInstanceOf(InvalidLanguagePair);
    expect(repo.rows).toEqual([]);
  });

  it('propagates UsernameTaken and logs nothing', async () => {
    const { service, logger } = build();
    await service.register(REQUEST);
    logger.events.length = 0;

    await expect(service.register(REQUEST)).rejects.toBeInstanceOf(UsernameTaken);
    expect(logger.events).toEqual([]);
  });
});

describe('login', () => {
  it('returns the user registered under that username', async () => {
    const { service } = build();
    const created = await service.register(REQUEST);
    expect(await service.login('dana')).toEqual(created);
  });

  it('throws UserNotFound for a username nobody has', async () => {
    const { service } = build();
    await expect(service.login('nobody')).rejects.toBeInstanceOf(UserNotFound);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w apps/server`
Expected: FAIL — `./users`, `createFakeTransaction` and `createInMemoryUserRepo` do not exist.

- [ ] **Step 3: Extract the shared transaction types**

Create `apps/server/src/services/transaction.ts`:

```ts
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import type { UserRepo } from '../repo/users';

// The repositories composition.ts binds to one transaction. This module holds
// types only — R2 lets services reference repo modules as types, and nothing
// here is a value, so no service gains a route to Drizzle through it.
export type Repos = { session: SessionRepo; question: QuestionRepo; user: UserRepo };

/**
 * One use case, one transaction — ADR 0001 R8's boundary, expressed without a
 * database handle. The repositories arrive already bound, so nothing in
 * services/ names Drizzle, a pool, or a `Tx`.
 */
export type Transaction = <T>(run: (repos: Repos) => Promise<T>) => Promise<T>;
```

In `apps/server/src/services/sessions.ts`, delete the local `type Repos = …` and `export type Transaction = …` declarations along with their comment block, and add near the other imports:

```ts
import type { Transaction } from './transaction';
```

Then re-export it so existing importers keep working:

```ts
export type { Transaction } from './transaction';
```

`QuestionRepo` and `SessionRepo` were imported into `sessions.ts` only to build the deleted `Repos` type, so both imports are now dead. Remove them — no tsconfig in this repo sets `noUnusedLocals`, so `npm run typecheck` will not tell you. Confirm with `grep -n "QuestionRepo\|SessionRepo" apps/server/src/services/sessions.ts` before deleting, in case something else picked them up.

- [ ] **Step 4: Add the two errors**

Append to `apps/server/src/errors.ts`:

```ts
// `identifier` is a username when a login fails and a user id when a session is
// started for someone who does not exist. One error, because the transport
// answer is the same 404 either way.
export class UserNotFound extends Error {
  constructor(readonly identifier: string) {
    super(`no user matches ${identifier}`);
    this.name = 'UserNotFound';
  }
}

export class InvalidLanguagePair extends Error {
  constructor(readonly languageCode: string) {
    super(`native and target language are both ${languageCode}`);
    this.name = 'InvalidLanguagePair';
  }
}
```

- [ ] **Step 5: Add the fakes**

Append to `apps/server/tests/support/fakes.ts`:

```ts
import type { User } from '@lang-tutor/core/api';

import { UsernameTaken } from '../../src/errors';
import type { UserRepo } from '../../src/repo/users';
import type { Repos, Transaction } from '../../src/services/transaction';

// A repository a unit test can hold in its head: the same contract, backed by
// an array. It reproduces the one behaviour a caller depends on — a duplicate
// username raises UsernameTaken — because that is a contract of the interface,
// not an accident of Postgres.
export function createInMemoryUserRepo(): UserRepo & { rows: User[] } {
  const rows: User[] = [];
  let n = 0;
  return {
    rows,
    insertUser: async (input) => {
      if (rows.some((row) => row.username === input.username)) {
        throw new UsernameTaken(input.username);
      }
      const user: User = {
        id: `fake-user-${++n}`,
        username: input.username,
        display_name: input.display_name,
        age: input.age,
        native_language: input.native_language,
        target_language: input.target_language,
      };
      rows.push(user);
      return user;
    },
    findByUsername: async (username) => rows.find((row) => row.username === username),
    findById: async (id) => rows.find((row) => row.id === id),
  };
}

// A Proxy rather than a hand-listed stub: a test that reaches one of these
// should fail with the method name it reached for, and adding a repository
// method must not mean editing this file.
function unreachableRepo<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property) => () => {
      throw new Error(`${name}.${String(property)} must not be called by this test`);
    },
  });
}

/** Runs `run` immediately with the supplied user repo. No rollback, by design:
 *  a fake that pretended to roll back would be asserting a database behaviour
 *  it cannot actually provide. */
export function createFakeTransaction(user: UserRepo): Transaction {
  const repos: Repos = {
    user,
    session: unreachableRepo('session repo'),
    question: unreachableRepo('question repo'),
  };
  return (run) => run(repos);
}
```

**Keep every `repo/` import in `fakes.ts` type-only.** `repo/users.ts` imports `drizzle-orm`, and `fakes.ts` is imported by a *unit* test — one that CI runs with no database reachable at all. `import type` is erased, so nothing loads; a value import would pull Drizzle into the unit bucket. ADR 0004's greps scan `src/**/*.test.ts`, not `tests/support/`, so they would not catch it: this one is on you.

- [ ] **Step 6: Write the service**

Create `apps/server/src/services/users.ts`:

```ts
import type { CreateUserRequest, User } from '@lang-tutor/core/api';

import { InvalidLanguagePair, UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

/**
 * The application layer for identity. Two use cases, one transaction each.
 *
 * There is no authentication here and there is not meant to be: `login` looks a
 * username up and returns the profile. Anything that needs to *authorize* an
 * action must not build on this — see ADR 0005.
 */
export function createUserService({
  transaction,
  logger,
}: {
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    register: async (input: CreateUserRequest): Promise<User> => {
      // Checked before a transaction is opened: no write is attempted, so
      // there is nothing to roll back. The database CHECK is the backstop for
      // anything that reaches the table by another route.
      if (input.native_language === input.target_language) {
        throw new InvalidLanguagePair(input.native_language);
      }

      const created = await transaction(({ user }) => user.insertUser(input));

      // After the transaction resolves, matching logCompletedSession: a commit
      // that fails must not leave a log claiming a user the database never got.
      logger.info({
        event: 'user_registered',
        user_id: created.id,
        username: created.username,
      });
      return created;
    },

    login: (username: string): Promise<User> =>
      transaction(async ({ user }) => {
        const found = await user.findByUsername(username);
        if (!found) throw new UserNotFound(username);
        return found;
      }),
  };
}

export type UserService = ReturnType<typeof createUserService>;
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npm test -w apps/server`
Expected: PASS, including the pre-existing `services/sessions.test.ts` — the `Transaction` re-export keeps its import working.

- [ ] **Step 8: Wire the service into composition**

The service exists but nothing constructs it. In `apps/server/src/composition.ts`:

1. Add the imports:

```ts
import { createUserRepo } from './repo/users';
import { createUserService, type UserService } from './services/users';
```

2. Add `users` to `AppDeps`:

```ts
export type AppDeps = {
  sessions: SessionService;
  users: UserService;
  health: HealthRepo;
  logger: Logger;
};
```

3. Bind the third repository and construct the service:

```ts
  const transaction = createTransaction(io.db, (tx) => ({
    session: createSessionRepo(tx),
    question: createQuestionRepo(tx),
    user: createUserRepo(tx),
  }));

  return {
    sessions: createSessionService({ transaction, rng: io.rng, logger: io.logger }),
    users: createUserService({ transaction, logger: io.logger }),
    health: createHealthRepo(io.db),
    logger: io.logger,
  };
```

Then add `users` to `createFakeAppDeps` in `apps/server/tests/support/fakes.ts`, alongside the existing `sessions`:

```ts
  const users: UserService = {
    register: unreachable,
    login: unreachable,
  };
```

and include it in the returned object. Add `import type { UserService } from '../../src/services/users';` at the top.

- [ ] **Step 9: Write the integration test**

Create `apps/server/tests/integration/services/users.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createServerDeps } from '../../../src/composition';
import { InvalidLanguagePair, UsernameTaken, UserNotFound } from '../../../src/errors';
import type { UserService } from '../../../src/services/users';
import { createFakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import { createTestDb, type TestDb } from '../../support/testDb';

// The other half is src/services/users.test.ts. This half exists for the one
// thing a fake cannot decide: whether the database actually refuses a duplicate.

let t: TestDb;
let service: UserService;

beforeEach(async () => {
  t = await createTestDb();
  service = createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }).users;
});

afterEach(async () => {
  await t.close();
});

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he' as const,
  target_language: 'en' as const,
};

describe('register', () => {
  it('persists a user that login can then find', async () => {
    const created = await service.register(REQUEST);
    expect(await service.login('dana')).toEqual(created);
  });

  it('issues an id the caller did not supply', async () => {
    const created = await service.register(REQUEST);
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('refuses a username the database already holds', async () => {
    await service.register(REQUEST);
    await expect(
      service.register({ ...REQUEST, display_name: 'אחרת' }),
    ).rejects.toBeInstanceOf(UsernameTaken);
  });

  it('refuses a matching language pair', async () => {
    await expect(
      service.register({ ...REQUEST, target_language: 'he' }),
    ).rejects.toBeInstanceOf(InvalidLanguagePair);
  });
});

describe('login', () => {
  it('throws UserNotFound for a username nobody registered', async () => {
    await expect(service.login('nobody')).rejects.toBeInstanceOf(UserNotFound);
  });
});
```

- [ ] **Step 10: Run everything**

Run: `npm test -w apps/server && npm run test:integration -w apps/server && npm run typecheck && npm run lint:arch`
Expected: all PASS. ADR 0001 R2 in particular: `services/` still imports `repo/` only as types, and `composition.ts` still performs no I/O.

- [ ] **Step 11: Commit**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): add the user service and share the transaction type

Repos and Transaction move out of services/sessions.ts: composition binds one
repo set for the whole app, so two services cannot each own its type."
```

---

### Task 5: `routes/users.ts` and mounting it

**Files:**
- Create: `apps/server/src/routes/users.ts`
- Modify: `apps/server/src/app.ts` (one `app.route` line plus an import)
- Modify: `apps/server/src/openapi.test.ts` (append)
- Test: `apps/server/tests/integration/routes/users.test.ts`

**Interfaces:**
- Consumes: `UserService` from task 4; `CreateUserRequestSchema`, `LoginRequestSchema`, `UserSchema`, `ErrorSchema` from task 1.
- Produces: `export function createUsersRouter(users: UserService): OpenAPIHono`, declaring `POST /users` and `POST /login`. Mounted at `/api`, so the published paths are `/api/users` and `/api/login`.

**Why one router mounted at `/api` rather than two.** `/api/users` and `/api/login` are two paths of one resource concern, and `app.route('/api', router)` lets a single router own both while `@hono/zod-openapi` still prefixes them correctly in the document. The openapi test below asserts that prefixing rather than trusting it — a router mounted at the wrong base publishes silently wrong paths.

Status mapping: `UsernameTaken` → 409, `UserNotFound` → 404, `InvalidLanguagePair` → 400, anything else rethrown for `app.ts`'s `onError` to turn into a 500.

- [ ] **Step 1: Write the failing route test**

Create `apps/server/tests/integration/routes/users.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createServerDeps } from '../../../src/composition';
import { createUsersRouter } from '../../../src/routes/users';
import { createFakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

// Production's assembly with a per-test database, exactly as the sessions route
// test does it. A route test that hand-wired repositories would be testing a
// graph this server never builds.
function buildTestApp() {
  const app = new Hono();
  const deps = createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  app.route('/api', createUsersRouter(deps.users));
  return app;
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const REQUEST = {
  username: 'dana',
  display_name: 'דנה',
  age: 34,
  native_language: 'he',
  target_language: 'en',
};

describe('POST /api/users', () => {
  it('creates a user and returns it with a server-issued id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', REQUEST);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(String), ...REQUEST });
  });

  it('returns 409 when the username is taken', async () => {
    const app = buildTestApp();
    await postJson(app, '/api/users', REQUEST);

    const res = await postJson(app, '/api/users', { ...REQUEST, display_name: 'אחרת' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'username is already taken' });
  });

  it('returns 400 for a matching language pair', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', { ...REQUEST, target_language: 'he' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'native and target language must differ' });
  });

  it('returns 400 with the contract error body for a malformed request', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', { ...REQUEST, username: 'Dana' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('ignores an id supplied by the caller', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/users', { ...REQUEST, id: 'chosen-by-client' });
    expect(res.status).toBe(201);
    expect((await res.json()).id).not.toBe('chosen-by-client');
  });
});

describe('POST /api/login', () => {
  it('returns the user for a known username', async () => {
    const app = buildTestApp();
    const created = await (await postJson(app, '/api/users', REQUEST)).json();

    const res = await postJson(app, '/api/login', { username: 'dana' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });

  it('returns 404 for a username nobody registered', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/login', { username: 'nobody' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such user' });
  });

  it('returns 400 with the contract error body for a malformed username', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/login', { username: 'D' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -w apps/server -- routes/users`
Expected: FAIL — `src/routes/users` does not exist.

- [ ] **Step 3: Write the router**

Create `apps/server/src/routes/users.ts`:

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateUserRequestSchema,
  ErrorSchema,
  LoginRequestSchema,
  UserSchema,
} from '@lang-tutor/core/api/schemas';

import { InvalidLanguagePair, UsernameTaken, UserNotFound } from '../errors';
import type { UserService } from '../services/users';

const createUserRoute = createRoute({
  method: 'post',
  path: '/users',
  tags: ['users'],
  summary: 'Create an account',
  description:
    'Registers a learner. The id is issued by the server; an `id` in the request body is ignored.',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateUserRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The account was created.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate, or the two languages are the same.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'Another account already uses this username.',
    },
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['users'],
  summary: 'Identify a learner by username',
  description:
    'Returns the profile registered under this username. This performs NO authentication: there is no password, and holding a username proves nothing. Do not build an authorization decision on this endpoint. See ADR 0005.',
  request: {
    body: { required: true, content: { 'application/json': { schema: LoginRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The username is registered; this is its profile.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No account uses this username.',
    },
  },
});

// Transport only: parse, validate, map an outcome to a status code. Mounted at
// /api, so these two paths publish as /api/users and /api/login.
export function createUsersRouter(users: UserService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload; the
  // contract says { error: 'invalid request' } and this is what keeps it saying so.
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createUserRoute, async (c) => {
    const input = c.req.valid('json');
    try {
      return c.json(await users.register(input), 201);
    } catch (error) {
      if (error instanceof UsernameTaken) {
        return c.json({ error: 'username is already taken' }, 409);
      }
      if (error instanceof InvalidLanguagePair) {
        return c.json({ error: 'native and target language must differ' }, 400);
      }
      throw error; // app.ts's onError turns anything else into a 500
    }
  });

  router.openapi(loginRoute, async (c) => {
    const { username } = c.req.valid('json');
    try {
      return c.json(await users.login(username), 200);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'no such user' }, 404);
      throw error;
    }
  });

  return router;
}
```

- [ ] **Step 4: Mount it**

In `apps/server/src/app.ts`, add the import beside the sessions one:

```ts
import { createUsersRouter } from './routes/users';
```

and the mount immediately above the existing sessions mount:

```ts
  app.route('/api', createUsersRouter(deps.users));
  app.route('/api/sessions', createSessionsRouter(deps.sessions));
```

- [ ] **Step 5: Run the route test to verify it passes**

Run: `npm run test:integration -w apps/server -- routes/users`
Expected: PASS, all eight cases.

- [ ] **Step 6: Assert the document publishes both paths**

Append to `apps/server/src/openapi.test.ts`:

```ts
describe('the user endpoints in the published document', () => {
  it('publishes /api/users, not /users', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths)).toContain('/api/users');
    expect(Object.keys(doc.paths)).not.toContain('/users');
  });

  it('publishes /api/login, not /login', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths)).toContain('/api/login');
    expect(Object.keys(doc.paths)).not.toContain('/login');
  });

  it('declares every status POST /api/users can return', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/users'].post.responses).sort()).toEqual([
      '201',
      '400',
      '409',
    ]);
  });

  it('declares every status POST /api/login can return', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/login'].post.responses).sort()).toEqual([
      '200',
      '400',
      '404',
    ]);
  });

  it('declares the error body the user endpoints actually return', async () => {
    const doc = await openApiDocument();
    const schema =
      doc.paths['/api/users'].post.responses['409'].content['application/json'].schema;
    expect(schema.required).toEqual(['error']);
    expect(schema.properties.error.type).toBe('string');
  });

  // The one place a reader is most likely to assume otherwise.
  it('says in the document that login authenticates nothing', async () => {
    const doc = await openApiDocument();
    expect(doc.paths['/api/login'].post.description).toMatch(/NO authentication/);
  });
});
```

- [ ] **Step 7: Run everything**

Run: `npm test -w apps/server && npm run test:integration -w apps/server && npm run typecheck && npm run lint:arch`
Expected: all PASS. ADR 0003 R1 in particular — `routes/users.ts` registers both endpoints through `router.openapi(...)`, never a raw `.post(`.

- [ ] **Step 8: Verify by hand**

Run `npm run server` in one terminal, then:

```bash
curl -s -X POST localhost:3001/api/users -H 'Content-Type: application/json' \
  -d '{"username":"dana","display_name":"דנה","age":34,"native_language":"he","target_language":"en"}'
curl -s -X POST localhost:3001/api/login -H 'Content-Type: application/json' -d '{"username":"dana"}'
```

Expected: the first prints a user with a UUID id, the second prints the same user. Open <http://localhost:3001/docs> and confirm both appear under a **users** tag.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src apps/server/tests/integration/routes/users.test.ts
git commit -m "feat(server): publish POST /api/users and POST /api/login

login performs no authentication, and its published description says so."
```

---

### Task 6: The mobile remembered-username store and API calls

**Files:**
- Create: `apps/mobile/src/currentUser.ts`
- Create: `apps/mobile/src/currentUser.test.ts`
- Modify: `apps/mobile/src/api/client.ts:32-36` (the returned object)
- Modify: `apps/mobile/src/api/client.test.ts` (append)

**Interfaces:**
- Consumes: `User`, `LoginRequest`, `CreateUserRequest` from task 1.
- Produces:
  ```ts
  export function createRememberedUsernameStore(deps: {
    storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  }): {
    read(): Promise<string>;   // '' when nothing is remembered
    write(username: string): Promise<void>;
  };
  export type RememberedUsernameStore = ReturnType<typeof createRememberedUsernameStore>;

  // on ApiClient:
  login(request: LoginRequest): Promise<User>;
  createUser(request: CreateUserRequest): Promise<User>;
  ```

`read()` returns `''` rather than `null` because its only consumer is a `TextInput`'s value, and a component that has to translate `null` into `''` at every use is a component doing the store's job.

There is **no** `clear()`. Signing out deliberately keeps the remembered username so the login field stays prefilled — that is the whole "just push the button" behaviour. A `clear()` nothing calls would be an invitation to break it.

`apps/mobile/src/userId.ts` still exists after this task; task 7 deletes it, once `_layout.tsx` stops importing it.

- [ ] **Step 1: Write the failing store test**

Create `apps/mobile/src/currentUser.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { createRememberedUsernameStore } from './currentUser';

function fakeStorage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: async (key: string) => values[key] ?? null,
    setItem: async (key: string, value: string) => {
      values[key] = value;
    },
  };
}

describe('createRememberedUsernameStore', () => {
  it('reads an empty string when nothing has been remembered', async () => {
    const store = createRememberedUsernameStore({ storage: fakeStorage() });
    expect(await store.read()).toBe('');
  });

  it('reads back what was written', async () => {
    const storage = fakeStorage();
    const store = createRememberedUsernameStore({ storage });

    await store.write('dana');

    expect(await store.read()).toBe('dana');
    expect(storage.values['lang-tutor:username']).toBe('dana');
  });

  it('overwrites the previous username rather than accumulating', async () => {
    const storage = fakeStorage({ 'lang-tutor:username': 'dana' });
    const store = createRememberedUsernameStore({ storage });

    await store.write('yoni');

    expect(await store.read()).toBe('yoni');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/mobile`
Expected: FAIL — cannot resolve `./currentUser`.

- [ ] **Step 3: Write the store**

Create `apps/mobile/src/currentUser.ts`:

```ts
const STORAGE_KEY = 'lang-tutor:username';

export type RememberedUsernameStoreDeps = {
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
};

/**
 * Remembers the last username typed into the login screen — nothing else.
 *
 * The profile is deliberately not cached: it is a server fact, and a copy here
 * would go stale the moment anything changed it. The username is the one part
 * of identity that belongs to this device.
 *
 * There is no clear(): signing out keeps the username so the field stays
 * prefilled, which is the point of remembering it at all.
 */
export function createRememberedUsernameStore({ storage }: RememberedUsernameStoreDeps) {
  return {
    // '' rather than null: the only consumer is a TextInput's value.
    read: async (): Promise<string> => (await storage.getItem(STORAGE_KEY)) ?? '',
    write: async (username: string): Promise<void> => {
      await storage.setItem(STORAGE_KEY, username);
    },
  };
}

export type RememberedUsernameStore = ReturnType<typeof createRememberedUsernameStore>;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w apps/mobile`
Expected: PASS.

- [ ] **Step 5: Write the failing API client tests**

Append to `apps/mobile/src/api/client.test.ts`, inside the existing `describe('api/client', …)`:

```ts
  it('login posts the username to /api/login', async () => {
    const user = {
      id: 'u1',
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he',
      target_language: 'en',
    };
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => user }));
    const client = buildClient(mockFetch);

    const result = await client.login({ username: 'dana' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/login',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'dana' }),
      }),
    );
    expect(result).toEqual(user);
  });

  it('login throws ApiError with the status when the username is unknown', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await expect(client.login({ username: 'nobody' })).rejects.toMatchObject({ status: 404 });
    await expect(client.login({ username: 'nobody' })).rejects.toBeInstanceOf(ApiError);
  });

  it('createUser posts the profile to /api/users', async () => {
    const request = {
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he' as const,
      target_language: 'en' as const,
    };
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'u1', ...request }),
    }));
    const client = buildClient(mockFetch);

    const result = await client.createUser(request);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/users',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
    expect(result.id).toBe('u1');
  });

  it('createUser throws ApiError with 409 when the username is taken', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await expect(
      client.createUser({
        username: 'dana',
        display_name: 'דנה',
        age: 34,
        native_language: 'he',
        target_language: 'en',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `npm test -w apps/mobile`
Expected: FAIL — `client.login is not a function`.

- [ ] **Step 7: Add the two calls**

In `apps/mobile/src/api/client.ts`, extend the type import:

```ts
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateUserRequest,
  LoginRequest,
  NextStepRequest,
  NextStepResponse,
  User,
} from '@lang-tutor/core/api';
```

and add both to the returned object:

```ts
  return {
    // Identification, not authentication: there is no password to send.
    login: (request: LoginRequest) => postJson<User>('/api/login', request),
    createUser: (request: CreateUserRequest) => postJson<User>('/api/users', request),
    createSession: (request: CreateSessionRequest) =>
      postJson<CreateSessionResponse>('/api/sessions', request),
    nextStep: (sessionId: string, request: NextStepRequest) =>
      postJson<NextStepResponse>(`/api/sessions/${sessionId}/next-step`, request),
  };
```

Both endpoints are POSTs, so the existing `postJson` covers them and no `getJson` helper is needed.

- [ ] **Step 8: Run everything**

Run: `npm test -w apps/mobile && npm run typecheck && npm run lint:arch`
Expected: PASS. ADR 0002 R5 in particular — neither new function takes a defaulted collaborator.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/currentUser.ts apps/mobile/src/currentUser.test.ts apps/mobile/src/api
git commit -m "feat(mobile): remember the last username and call login/createUser

The store persists the username only. A cached profile would go stale the
moment anything server-side changed it."
```

---

### Task 7: Login and onboarding screens

**Files:**
- Create: `apps/mobile/src/hooks/useCurrentUser.tsx`
- Create: `apps/mobile/src/app/login.tsx`
- Create: `apps/mobile/src/app/onboarding.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx`
- Modify: `apps/mobile/src/app/index.tsx`
- Modify: `apps/mobile/src/hooks/useSession.tsx:96-160`
- Modify: `apps/mobile/src/strings.ts`
- Delete: `apps/mobile/src/userId.ts`, `apps/mobile/src/userId.test.ts`

**Interfaces:**
- Consumes: `createRememberedUsernameStore`, `api.login`, `api.createUser`, `ApiError` from task 6.
- Produces:
  ```ts
  export type CurrentUserValue = {
    user: User | null;
    rememberedUsername: string;
    login(username: string): Promise<void>;      // rejects with ApiError
    register(input: CreateUserRequest): Promise<void>;  // rejects with ApiError
    signOut(): void;
  };
  export function CurrentUserProvider(props: {
    api: ApiClient; usernameStore: RememberedUsernameStore; children: ReactNode;
  }): JSX.Element;
  export function useCurrentUser(): CurrentUserValue;
  ```
  and these testIDs, which task 9's e2e suite depends on **exactly**:
  `login-username`, `login-button`, `new-user-button`, `login-error`,
  `onboarding-username`, `onboarding-display-name`, `onboarding-age`,
  `native-he`, `native-en`, `target-he`, `target-en`,
  `onboarding-submit`, `onboarding-error`, and `profile-button` on the home screen
  (whose text is the learner's `display_name` — task 9 asserts on it).

**Client-side validation is deliberately shallow.** The screen checks only what it can check without duplicating a rule: required fields, an age that parses, and two different languages. It does **not** re-implement the username pattern — that would be a third copy of a regex already living in `packages/core` and in a database `CHECK`. Instead the pattern is stated to the learner as always-visible hint text under the field, and a violation comes back as the server's 400. `apps/mobile` importing `@lang-tutor/core/api/schemas` to validate would drag Zod into the app bundle, which is exactly what ADR 0003's separate schemas entry point exists to prevent.

- [ ] **Step 1: Add the Hebrew copy**

Append inside the `strings` object in `apps/mobile/src/strings.ts`:

```ts
  loginTitle: 'כניסה',
  loginUsernameLabel: 'שם משתמש',
  loginAction: 'כניסה',
  loginUnknownUser: 'לא נמצא משתמש בשם הזה',
  loginFailed: 'הכניסה נכשלה, נסו שוב',
  newUserAction: 'משתמש חדש',
  usernameHint: 'אותיות אנגליות קטנות, ספרות וקו תחתון — בין 3 ל‑30 תווים',
  onboardingTitle: 'יצירת משתמש',
  onboardingNameLabel: 'שם',
  onboardingAgeLabel: 'גיל',
  onboardingNativeLabel: 'שפת אם',
  onboardingTargetLabel: 'שפה נלמדת',
  onboardingSubmit: 'יצירה',
  onboardingIncomplete: 'יש למלא את כל השדות',
  onboardingSameLanguage: 'שפת האם והשפה הנלמדת חייבות להיות שונות',
  onboardingUsernameTaken: 'שם המשתמש כבר תפוס',
  onboardingRejected: 'אחד הפרטים אינו תקין',
  onboardingFailed: 'היצירה נכשלה, נסו שוב',
  languageName: (code: string) => (code === 'he' ? 'עברית' : code === 'en' ? 'אנגלית' : code),
```

- [ ] **Step 2: Write the current-user provider**

Create `apps/mobile/src/hooks/useCurrentUser.tsx`:

```tsx
import type { CreateUserRequest, User } from '@lang-tutor/core/api';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { ApiClient } from '@/api/client';
import type { RememberedUsernameStore } from '@/currentUser';

export type CurrentUserValue = {
  /** The identified learner, in memory only. Null between app launch and login. */
  user: User | null;
  /** Prefill for the login field. Arrives asynchronously; '' until it does. */
  rememberedUsername: string;
  login: (username: string) => Promise<void>;
  register: (input: CreateUserRequest) => Promise<void>;
  signOut: () => void;
};

const CurrentUserContext = createContext<CurrentUserValue | null>(null);

export function CurrentUserProvider({
  api,
  usernameStore,
  children,
}: {
  api: ApiClient;
  usernameStore: RememberedUsernameStore;
  children: ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [rememberedUsername, setRememberedUsername] = useState('');

  useEffect(() => {
    void usernameStore.read().then(setRememberedUsername);
  }, [usernameStore]);

  // The profile lives in memory; only the username is written to storage. Both
  // login and register end here, so there is one place that decides what being
  // logged in means.
  const adopt = useCallback(
    async (next: User) => {
      setUser(next);
      setRememberedUsername(next.username);
      await usernameStore.write(next.username);
    },
    [usernameStore],
  );

  const login = useCallback(
    async (username: string) => {
      await adopt(await api.login({ username }));
    },
    [api, adopt],
  );

  const register = useCallback(
    async (input: CreateUserRequest) => {
      await adopt(await api.createUser(input));
    },
    [api, adopt],
  );

  // Keeps the remembered username on purpose: the login field stays prefilled,
  // which is the entire reason it is remembered.
  const signOut = useCallback(() => setUser(null), []);

  const value = useMemo(
    () => ({ user, rememberedUsername, login, register, signOut }),
    [user, rememberedUsername, login, register, signOut],
  );

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserValue {
  const value = useContext(CurrentUserContext);
  if (!value) throw new Error('useCurrentUser must be used inside a CurrentUserProvider');
  return value;
}
```

- [ ] **Step 3: Write the login screen**

Create `apps/mobile/src/app/login.tsx`:

```tsx
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function LoginScreen() {
  const { user, rememberedUsername, login } = useCurrentUser();
  const [username, setUsername] = useState('');
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // rememberedUsername arrives after a storage read, so it cannot be the
  // initial state. Adopt it until the learner types — after that, their text wins.
  useEffect(() => {
    if (!edited) setUsername(rememberedUsername);
  }, [rememberedUsername, edited]);

  // Also covers landing here while already identified, e.g. via back navigation.
  if (user) return <Redirect href="/" />;

  async function onLogin() {
    setBusy(true);
    setError(null);
    try {
      await login(username.trim());
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 404
          ? strings.loginUnknownUser
          : strings.loginFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.loginTitle}</Text>

      <Text style={styles.label}>{strings.loginUsernameLabel}</Text>
      <TextInput
        testID="login-username"
        value={username}
        onChangeText={(text) => {
          setEdited(true);
          setUsername(text);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        // The app is force-RTL but a username is lowercase ASCII: without this
        // the text and the caret render on the wrong side.
        style={[styles.input, styles.ltr]}
      />
      <Text style={styles.hint}>{strings.usernameHint}</Text>

      {error ? (
        <Text testID="login-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="login-button"
        onPress={onLogin}
        disabled={busy || username.trim().length === 0}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.loginAction}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="new-user-button"
        onPress={() => router.push('/onboarding')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryLabel}>{strings.newUserAction}</Text>
      </Pressable>

      <View style={styles.spacer} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.sm },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  label: {
    marginTop: spacing.md,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'rtl',
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSizes.md,
    color: colors.text,
  },
  ltr: { writingDirection: 'ltr', textAlign: 'left' },
  hint: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  error: { fontSize: fontSizes.md, color: colors.wrong, writingDirection: 'rtl' },
  button: {
    marginTop: spacing.md,
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
  secondaryButton: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  spacer: { flex: 1 },
});
```

Every token used here already exists in `apps/mobile/src/theme.ts`: `colors.wrong` is the error red (there is no `colors.wrong`), and `fontSizes.sm`, `spacing.xs`/`sm`/`md`/`lg`/`xl`, `radii.md` and `lineHeights.md`/`xxl` are all defined. Do not hard-code a colour or a spacing value in a screen.

- [ ] **Step 4: Write the onboarding screen**

Create `apps/mobile/src/app/onboarding.tsx`:

```tsx
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

const LANGUAGES = ['he', 'en'] as const;
type LanguageCode = (typeof LANGUAGES)[number];

function LanguageChoice({
  prefix,
  value,
  onChange,
}: {
  prefix: 'native' | 'target';
  value: LanguageCode;
  onChange: (code: LanguageCode) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      {LANGUAGES.map((code) => (
        <Pressable
          key={code}
          accessibilityRole="button"
          accessibilityState={{ selected: value === code }}
          testID={`${prefix}-${code}`}
          onPress={() => onChange(code)}
          style={[styles.choice, value === code && styles.choiceSelected]}
        >
          <Text style={[styles.choiceLabel, value === code && styles.choiceLabelSelected]}>
            {strings.languageName(code)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function OnboardingScreen() {
  const { user, register } = useCurrentUser();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [age, setAge] = useState('');
  const [nativeLanguage, setNativeLanguage] = useState<LanguageCode>('he');
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>('en');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // register() sets the user, and this is what turns that into navigation.
  if (user) return <Redirect href="/" />;

  async function onSubmit() {
    const parsedAge = Number.parseInt(age, 10);

    // Only what can be checked without duplicating a rule. The username pattern
    // is stated in the hint and enforced by the server — re-implementing it here
    // would be a third copy of a regex that already lives in packages/core and
    // in a database CHECK.
    if (!username.trim() || !displayName.trim() || !Number.isInteger(parsedAge)) {
      setError(strings.onboardingIncomplete);
      return;
    }
    if (nativeLanguage === targetLanguage) {
      setError(strings.onboardingSameLanguage);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await register({
        username: username.trim(),
        display_name: displayName.trim(),
        age: parsedAge,
        native_language: nativeLanguage,
        target_language: targetLanguage,
      });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setError(strings.onboardingUsernameTaken);
      } else if (failure instanceof ApiError && failure.status === 400) {
        setError(strings.onboardingRejected);
      } else {
        setError(strings.onboardingFailed);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.onboardingTitle}</Text>

      <Text style={styles.label}>{strings.loginUsernameLabel}</Text>
      <TextInput
        testID="onboarding-username"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, styles.ltr]}
      />
      <Text style={styles.hint}>{strings.usernameHint}</Text>

      <Text style={styles.label}>{strings.onboardingNameLabel}</Text>
      <TextInput
        testID="onboarding-display-name"
        value={displayName}
        onChangeText={setDisplayName}
        style={styles.input}
      />

      <Text style={styles.label}>{strings.onboardingAgeLabel}</Text>
      <TextInput
        testID="onboarding-age"
        value={age}
        onChangeText={setAge}
        keyboardType="number-pad"
        style={[styles.input, styles.ltr]}
      />

      <Text style={styles.label}>{strings.onboardingNativeLabel}</Text>
      <LanguageChoice prefix="native" value={nativeLanguage} onChange={setNativeLanguage} />

      <Text style={styles.label}>{strings.onboardingTargetLabel}</Text>
      <LanguageChoice prefix="target" value={targetLanguage} onChange={setTargetLanguage} />

      {error ? (
        <Text testID="onboarding-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="onboarding-submit"
        onPress={onSubmit}
        disabled={busy}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.onboardingSubmit}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.xs },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  label: {
    marginTop: spacing.sm,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'rtl',
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSizes.md,
    color: colors.text,
  },
  ltr: { writingDirection: 'ltr', textAlign: 'left' },
  hint: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
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
    marginTop: spacing.md,
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

- [ ] **Step 5: Rewire the composition root**

In `apps/mobile/src/app/_layout.tsx`:

1. Delete `import * as Crypto from 'expo-crypto';` and `import { createUserIdStore } from '@/userId';`.
2. Add `import { createRememberedUsernameStore } from '@/currentUser';` and `import { CurrentUserProvider } from '@/hooks/useCurrentUser';`.
3. Replace the `const userIdStore = createUserIdStore({ … });` block with:

```ts
const usernameStore = createRememberedUsernameStore({ storage: AsyncStorage });
```

4. Wrap `SessionProvider` and drop its `userIdStore` prop:

```tsx
      <CurrentUserProvider api={api} usernameStore={usernameStore}>
        <SessionProvider api={api}>
          <View style={styles.root} {...rtlProps}>
            <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
          </View>
        </SessionProvider>
      </CurrentUserProvider>
```

`expo-crypto` may now be unused across the app. Check with `grep -rn "expo-crypto" apps/mobile/src`; if nothing matches, remove it from `apps/mobile/package.json` too.

- [ ] **Step 6: Take the user id off the session hook**

In `apps/mobile/src/hooks/useSession.tsx`:

1. Replace `import type { UserIdStore } from '@/userId';` with `import { useCurrentUser } from '@/hooks/useCurrentUser';`.
2. Change the signature to `export function SessionProvider({ api, children }: { api: ApiClient; children: ReactNode })`.
3. Immediately after `const [state, setState] = useState<QuizState | null>(null);`, add:

```ts
  const { user } = useCurrentUser();

  // A ref, matching this file's existing stateRef idiom, so start()'s empty
  // dependency array stays correct: the callback must read the user who is
  // logged in when it fires, not the one captured when it was created.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);
```

4. Inside `start`'s async body, replace `const userId = await userIdStore.getOrCreateUserId();` with:

```ts
        const currentUser = userRef.current;
        // Unreachable in practice — Home redirects to /login when logged out —
        // but a session with no learner must fail loudly, not invent an id.
        if (!currentUser) throw new Error('cannot start a session with no current user');
        const userId = currentUser.id;
```

- [ ] **Step 7: Gate the home screen and add the profile affordance**

In `apps/mobile/src/app/index.tsx`:

1. Add `import { Redirect } from 'expo-router';` to the existing expo-router import, plus `import { useCurrentUser } from '@/hooks/useCurrentUser';`.
2. At the top of `HomeScreen`, after `const { start } = useSession();`:

```tsx
  const { user } = useCurrentUser();
  if (!user) return <Redirect href="/login" />;
```

3. Add a profile affordance immediately after the `<Text style={styles.subtitle}>` line:

```tsx
      <Pressable
        accessibilityRole="button"
        testID="profile-button"
        onPress={() => router.push('/profile')}
        style={styles.profileLink}
      >
        <Text style={styles.profileLinkLabel}>{user.display_name}</Text>
      </Pressable>
```

4. Add to the stylesheet:

```ts
  profileLink: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  profileLinkLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
```

The `/profile` route does not exist until task 8, so this button navigates nowhere until then. That is fine — nothing tests it yet.

- [ ] **Step 8: Delete the old identity module**

```bash
git rm apps/mobile/src/userId.ts apps/mobile/src/userId.test.ts
```

- [ ] **Step 9: Run everything**

Run: `npm test -w apps/mobile && npm run typecheck && npm run lint:arch`
Expected: PASS. `npm run lint:arch` should now find **nothing** for ADR 0002 R1's `expo-crypto` grep, since no file imports it.

- [ ] **Step 10: Verify by hand**

With `npm run server` running, start `npm run mobile` and press `w`. Expected:

1. The login screen appears with an empty username field.
2. **New user** → fill in `dana` / דנה / 34 / עברית / אנגלית → **יצירה** → the home screen, showing דנה.
3. Reload the browser → the login screen again, with `dana` prefilled → **כניסה** → home in one tap.
4. Typing `nobody` and pressing **כניסה** shows "לא נמצא משתמש בשם הזה".
5. Confirm the username field renders its text left-aligned while the rest of the page is right-to-left.

- [ ] **Step 11: Commit**

```bash
git add -A apps/mobile
git commit -m "feat(mobile): add login and onboarding, replacing the device UUID

The server issues the id now, so expo-crypto leaves the composition root and
userId.ts goes with it. The login field remembers the last username so a
returning learner reaches home in one tap."
```

---

### Task 8: The profile screen

**Files:**
- Create: `apps/mobile/src/app/profile.tsx`
- Modify: `apps/mobile/src/strings.ts`

**Interfaces:**
- Consumes: `useCurrentUser()` from task 7.
- Produces: the `/profile` route, and testIDs `profile-username`, `profile-name`, `profile-age`, `profile-native`, `profile-target`, `switch-user-button`.

Read-only. The screen renders the `User` already held in memory and makes no request — both `login` and `register` return the full profile, which is why there is no `GET /api/users/{id}` to call.

The language pair is shown as two labelled rows rather than one `he → en` line: an arrow between two runs in a right-to-left layout resolves its direction from the surrounding text and flips, and pinning it with a directional isolate is more machinery than two rows deserve.

- [ ] **Step 1: Add the Hebrew copy**

Append inside the `strings` object in `apps/mobile/src/strings.ts`:

```ts
  profileTitle: 'הפרופיל שלי',
  profileNameLabel: 'שם',
  profileAgeLabel: 'גיל',
  switchUser: 'החלפת משתמש',
  back: 'חזרה',
```

`loginUsernameLabel`, `onboardingNativeLabel` and `onboardingTargetLabel` from task 7 are reused for the other three rows — the same field should not be named two ways in one app.

- [ ] **Step 2: Write the screen**

Create `apps/mobile/src/app/profile.tsx`:

```tsx
import { Redirect, router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

function Row({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text testID={testID} style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { user, signOut } = useCurrentUser();

  if (!user) return <Redirect href="/login" />;

  function onSwitchUser() {
    signOut();
    router.replace('/login');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.profileTitle}</Text>

      <View style={styles.card}>
        <Row label={strings.loginUsernameLabel} value={user.username} testID="profile-username" />
        <Row label={strings.profileNameLabel} value={user.display_name} testID="profile-name" />
        <Row label={strings.profileAgeLabel} value={String(user.age)} testID="profile-age" />
        <Row
          label={strings.onboardingNativeLabel}
          value={strings.languageName(user.native_language)}
          testID="profile-native"
        />
        <Row
          label={strings.onboardingTargetLabel}
          value={strings.languageName(user.target_language)}
          testID="profile-target"
        />
      </View>

      <Pressable
        accessibilityRole="button"
        testID="switch-user-button"
        onPress={onSwitchUser}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.switchUser}</Text>
      </Pressable>

      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
        <Text style={styles.secondaryLabel}>{strings.back}</Text>
      </Pressable>

      <View style={styles.spacer} />
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
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  rowLabel: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  rowValue: { fontSize: fontSizes.md, color: colors.text, fontWeight: '700' },
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
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  spacer: { flex: 1 },
});
```

- [ ] **Step 3: Typecheck and run the mobile tests**

Run: `npm test -w apps/mobile && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Verify by hand**

With the server and app running: log in, tap the display-name link on the home screen, confirm all five rows show the values you onboarded with, then tap **החלפת משתמש**. Expected: the login screen, with the username still prefilled — signing out keeps it on purpose.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/app/profile.tsx apps/mobile/src/strings.ts
git commit -m "feat(mobile): add a read-only profile screen with switch user

Renders the User already in memory: login and register both return the full
profile, so there is nothing to fetch."
```

---

### Task 9: End-to-end coverage

**Files:**
- Create: `e2e/tests/support/users.ts`
- Create: `e2e/tests/onboarding.spec.ts`
- Modify: `e2e/tests/session.spec.ts` (a login step before the existing flow)

**Interfaces:**
- Consumes: the testIDs listed in task 7 and task 8, exactly.
- Produces:
  ```ts
  export function learnerFor(username: string): CreateUserRequest;
  export function createLearner(request: APIRequestContext, username: string): Promise<User>;
  export function logIn(page: Page, username: string): Promise<void>;
  ```

**`e2e/globalSetup.ts` is not touched.** It runs *before* Playwright starts the server — that is the whole point of the long comment at the bottom of it — so no HTTP call can be made from there. Each spec creates the learner it needs through the `request` fixture instead, which is closer to what a real client does anyway.

**Usernames must not collide across spec files.** The e2e database is dropped and recreated per run, so a fixed username per spec is stable, but two spec files sharing one would race when Playwright runs them in parallel. Each spec below owns its own.

**The hydration retry from `session.spec.ts` applies to the login button too.** `web.output: "static"` pre-renders the markup before React hydrates, so a click landing in that window is a silent no-op. `logIn` wraps its click in the same `toPass` loop for the same reason.

- [ ] **Step 1: Write the shared helper**

Create `e2e/tests/support/users.ts`:

```ts
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { CreateUserRequest, User } from '@lang-tutor/core/api';

import { API_URL } from '../../urls';

export function learnerFor(username: string): CreateUserRequest {
  return {
    username,
    display_name: 'דנה',
    age: 34,
    native_language: 'he',
    target_language: 'en',
  };
}

/** Creates a learner over the same endpoint the app uses. There is no fixture
 *  seed and no test-only route: this is the production path. */
export async function createLearner(
  request: APIRequestContext,
  username: string,
): Promise<User> {
  const res = await request.post(`${API_URL}/api/users`, { data: learnerFor(username) });
  if (!res.ok()) {
    throw new Error(`could not create ${username}: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as User;
}

/** Drives the real login screen. The click is retried because a static export
 *  serves pre-rendered markup: a click before hydration is a silent no-op. */
export async function logIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('login-username')).toBeVisible();
  await page.getByTestId('login-username').fill(username);

  await expect(async () => {
    await page.getByTestId('login-button').click();
    await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
```

- [ ] **Step 2: Run the existing suite to watch it fail**

Run: `npm run db:up && npm run e2e`
Expected: FAIL — `session.spec.ts` calls `page.goto('/')` and waits for `start-button`, but the app now shows the login screen. This failure is the proof that the redirect from task 7 works end to end.

- [ ] **Step 3: Log in before the session flow**

In `e2e/tests/session.spec.ts`:

1. Add the import:

```ts
import { createLearner, logIn } from './support/users';
```

2. Change the test signature to take `request` alongside `page`:

```ts
test('a full session scores exactly the answers given', async ({ page, request }) => {
```

3. Replace these four lines —

```ts
  await page.goto('/');
  await expect(page.getByTestId('start-button'), `home never rendered\n${report()}`).toBeVisible();
  await expect(async () => {
    await page.getByTestId('start-button').click();
```

— with:

```ts
  await createLearner(request, 'e2e_session');
  await logIn(page, 'e2e_session');
  await expect(page.getByTestId('start-button'), `home never rendered\n${report()}`).toBeVisible();
  await expect(async () => {
    await page.getByTestId('start-button').click();
```

Leave the rest of the file, including the comment above the retry loop, exactly as it is.

- [ ] **Step 4: Run it**

Run: `npm run e2e -- session.spec.ts`
Expected: PASS — the full ten-question run, now behind a login.

- [ ] **Step 5: Write the onboarding spec**

Create `e2e/tests/onboarding.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { createLearner, logIn } from './support/users';

// Three page loads and a handful of round trips — well inside this, and well
// above Playwright's 30s default.
test.setTimeout(120_000);

test('a new learner can create an account and reach the home screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-username')).toBeVisible();

  // Retried for the same reason session.spec.ts retries its start click: a
  // static export serves markup before React hydrates.
  await expect(async () => {
    await page.getByTestId('new-user-button').click();
    await expect(page.getByTestId('onboarding-username')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await page.getByTestId('onboarding-username').fill('e2e_new_learner');
  await page.getByTestId('onboarding-display-name').fill('יוני');
  await page.getByTestId('onboarding-age').fill('9');
  await page.getByTestId('native-he').click();
  await page.getByTestId('target-en').click();
  await page.getByTestId('onboarding-submit').click();

  // Landing on home is the assertion: it means the server issued an id and the
  // app adopted it.
  await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('profile-button')).toHaveText('יוני');
});

test('the profile shows what onboarding collected', async ({ page, request }) => {
  await createLearner(request, 'e2e_profile');
  await logIn(page, 'e2e_profile');

  await page.getByTestId('profile-button').click();

  await expect(page.getByTestId('profile-username')).toHaveText('e2e_profile');
  await expect(page.getByTestId('profile-name')).toHaveText('דנה');
  await expect(page.getByTestId('profile-age')).toHaveText('34');
  await expect(page.getByTestId('profile-native')).toHaveText('עברית');
  await expect(page.getByTestId('profile-target')).toHaveText('אנגלית');
});

test('switching user returns to a login screen that remembers the username', async ({
  page,
  request,
}) => {
  await createLearner(request, 'e2e_switch');
  await logIn(page, 'e2e_switch');

  await page.getByTestId('profile-button').click();
  await page.getByTestId('switch-user-button').click();

  const field = page.getByTestId('login-username');
  await expect(field).toBeVisible();
  // Kept on purpose: the whole point of remembering it is the one-tap return.
  await expect(field).toHaveValue('e2e_switch');
});

test('logging in as a username nobody registered shows an error', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-username')).toBeVisible();

  await page.getByTestId('login-username').fill('e2e_nobody');
  await expect(async () => {
    await page.getByTestId('login-button').click();
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // Still on the login screen — a failed login must not let anyone through.
  await expect(page.getByTestId('start-button')).toHaveCount(0);
});
```

- [ ] **Step 6: Run the whole suite**

Run: `npm run e2e`
Expected: five tests PASS. If `toHaveText` fails on a Hebrew value with what looks like the right text, the string is wrapped in directional isolates — use `stripIsolates` from `./support/text` the way `session.spec.ts` does.

- [ ] **Step 7: Commit**

```bash
git add e2e
git commit -m "test(e2e): cover onboarding, profile and switch user

Learners are created over POST /api/users — the same endpoint the app calls.
No fixture seed and no test-only route exist to make this work."
```

---

### Task 10: Delete `upsertUser` and tighten the columns

**Files:**
- Create: `apps/server/tests/support/seedUser.ts`
- Modify: `apps/server/src/db/schema.ts` (three `.notNull()`, two dropped defaults)
- Create: `apps/server/src/db/migrations/<generated>.sql`, then hand-edit it
- Modify: `apps/server/src/repo/sessions.ts:25-38` (delete `upsertUser`)
- Modify: `apps/server/src/services/sessions.ts` (`startSession` looks the user up)
- Modify: `apps/server/src/routes/sessions.ts` (map `UserNotFound` to 404)
- Modify: `apps/server/tests/integration/{app,composition,session-flow}.test.ts`, `tests/integration/repo/sessions.test.ts`, `tests/integration/routes/sessions.test.ts`, `tests/integration/services/sessions.test.ts`, `tests/integration/repo/users.test.ts`

**Interfaces:**
- Consumes: `UserNotFound` from task 4; `findById` from task 3.
- Produces: `export async function seedUser(db: Db, id: string): Promise<void>` in `tests/support/seedUser.ts` — inserts a fully-formed user under an explicit id, so every existing test keeps using `'u1'` instead of threading a generated UUID through dozens of call sites.

**This is the destructive task, and it goes last on purpose.** Everything that used to rely on a user appearing out of nowhere — the mobile app, the e2e suite — was migrated in tasks 6 to 9. Only now is deleting the implicit creation safe.

`users.id` keeps accepting an explicit value; the `gen_random_uuid()` default applies only when the column is omitted. That is what lets `seedUser(db, 'u1')` exist and keeps this task's test churn to one line per file.

- [ ] **Step 1: Write the seed helper**

Create `apps/server/tests/support/seedUser.ts`:

```ts
import type { Db } from '../../src/db/client';
import { users } from '../../src/db/schema';

/**
 * Inserts a fully-formed user under an id the caller chooses.
 *
 * The id default only fires when the column is omitted, so a test can keep
 * using a readable 'u1' instead of threading a generated UUID through every
 * assertion. Registration through the service is covered by its own tests;
 * this exists so tests *about sessions* can have a user without saying so
 * five times.
 */
export async function seedUser(db: Db, id: string): Promise<void> {
  await db
    .insert(users)
    .values({
      id,
      username: id,
      displayName: `test ${id}`,
      age: 30,
      nativeLanguage: 'he',
      targetLanguage: 'en',
    })
    .onConflictDoNothing();
}
```

The id doubles as the username, so it must satisfy `^[a-z0-9_]{3,30}$` — `'u1'` is two characters and will be rejected. Use `'u_1'` and `'u_2'` in the call sites below, and update the literals in the affected tests to match.

- [ ] **Step 2: Give every session test a real user**

Run: `grep -rn "'u1'\|'u2'\|upsertUser" apps/server/tests apps/server/src --include='*.ts'`

For each **integration** test file the grep names (`app.test.ts`, `composition.test.ts`, `session-flow.test.ts`, `repo/sessions.test.ts`, `routes/sessions.test.ts`, `services/sessions.test.ts`):

1. Add `import { seedUser } from '../support/seedUser';` (adjust the depth per file).
2. In the `beforeEach` that already calls `createTestDb()`, add after it:

```ts
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
```

3. Replace every `'u1'` with `'u_1'` and every `'u2'` with `'u_2'` in that file.

Leave `apps/server/src/domain/session.test.ts` alone: its `'u1'` is a field on a pure in-memory record that never reaches a database.

In `tests/integration/repo/sessions.test.ts`, the local `startSession(tx, userId = 'u1')` helper calls `sessionRepo.upsertUser`. Delete that call — the user now exists before the transaction opens — and change the default to `'u_1'`.

- [ ] **Step 3: Write the failing tests for the new behaviour**

In `apps/server/tests/integration/services/sessions.test.ts`, replace the test named `'creates a user on first sight and returns a ten-question session'` with:

```ts
  it('returns a ten-question session for a user who exists', async () => {
    const { sessionId, record } = await service.startSession('u_1');
    expect(typeof sessionId).toBe('string');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
    expect(record.complete).toBe(false);
  });

  // The regression test for deleting upsertUser. Before this phase a session
  // for an unknown id silently created the user.
  it('refuses to start a session for a user who does not exist', async () => {
    await expect(service.startSession('u_nobody')).rejects.toBeInstanceOf(UserNotFound);
  });
```

and add `UserNotFound` to the existing `import { … } from '../../../src/errors';`.

In `apps/server/tests/integration/routes/sessions.test.ts`, append to the `describe('POST /api/sessions', …)` block:

```ts
  it('returns 404 for a user id that was never onboarded', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { user_id: 'u_nobody' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'user not found' });
  });
```

In `apps/server/tests/integration/repo/users.test.ts`, delete the test named `'still accepts a row with no profile, until task 10'` and replace it with:

```ts
  it('refuses a row with no profile', async () => {
    await expect(
      withTx(t.db, (tx) => tx.insert(users).values({ id: 'bare' })),
    ).rejects.toThrow();
  });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npm run test:integration -w apps/server`
Expected: FAIL — `startSession` still creates the user, so both new tests fail, and the bare-insert test fails because the columns are still nullable.

- [ ] **Step 5: Delete `upsertUser`**

In `apps/server/src/repo/sessions.ts`, delete the whole `upsertUser` property including its doc comment. Then remove `users` from the `db/schema` import and `eq` from the `drizzle-orm` import **only if** nothing else in the file still uses them — check with `grep -n "users\|eq(" apps/server/src/repo/sessions.ts` before deleting either.

- [ ] **Step 6: Make the service require an existing user**

In `apps/server/src/services/sessions.ts`, replace the body of `startSession` with:

```ts
    startSession: (userId: string): Promise<{ sessionId: string; record: SessionRecord }> =>
      transaction(async ({ session, question, user }) => {
        const learner = await user.findById(userId);
        // No implicit creation. A session for an id nobody onboarded is a bug,
        // and the route turns this into a 404.
        if (!learner) throw new UserNotFound(userId);

        const pool = await question.loadQuestionPool(
          learner.target_language,
          learner.native_language,
          userId,
        );
        const record = newSessionRecord(userId, pool, rng);
        const sessionId = await session.insertSession(userId, record.questions);
        return { sessionId, record };
      }),
```

Note the field names: `findById` returns the wire `User`, whose language fields are `target_language`/`native_language` — the deleted `upsertUser` returned camelCase column names. Add `UserNotFound` to the existing `import { … } from '../errors';`.

- [ ] **Step 7: Map it to a 404**

In `apps/server/src/routes/sessions.ts`:

1. Add `UserNotFound` to the existing errors import.
2. Wrap the `createSessionRoute` handler's body:

```ts
  router.openapi(createSessionRoute, async (c) => {
    const { user_id } = c.req.valid('json');
    try {
      const { sessionId, record } = await sessions.startSession(user_id);
      return c.json(
        {
          session_id: sessionId,
          question: currentQuestion(record)!,
          position: positionOf(record),
        },
        200,
      );
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'user not found' }, 404);
      throw error;
    }
  });
```

3. Declare the new status on `createSessionRoute`, or the document will be wrong and `tsc` will reject the `c.json(..., 404)`:

```ts
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No user has this `user_id`. Create one with POST /api/users first.',
    },
```

4. Update the existing openapi assertion. In `apps/server/src/openapi.test.ts`, the test `'declares its 200 and its 400'` for `/api/sessions` now expects three statuses:

```ts
  it('declares its 200, 400 and 404', async () => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths['/api/sessions'].post.responses).sort()).toEqual([
      '200',
      '400',
      '404',
    ]);
  });
```

- [ ] **Step 8: Tighten the columns**

In `apps/server/src/db/schema.ts`'s `users` table:

```ts
    username: text('username').notNull().unique(),
    displayName: text('display_name').notNull(),
    age: integer('age').notNull(),
    nativeLanguage: varchar('native_language', { length: 10 }).notNull(),
    targetLanguage: varchar('target_language', { length: 10 }).notNull(),
```

Delete the `// Nullable until task 10` comment above `username`, and note that `.default('he')` and `.default('en')` are gone: onboarding always supplies both, so a default could only mask a bug.

- [ ] **Step 9: Generate the migration and add the backfill by hand**

Run: `npm run db:generate -w apps/server`

The generated file will contain `SET NOT NULL` on three columns and `DROP DEFAULT` on two. It will fail against any database holding a pre-phase-8 row. Open it and paste these three statements **above** the first `SET NOT NULL`:

```sql
--> statement-breakpoint
WITH numbered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n
  FROM "users" WHERE "username" IS NULL
)
UPDATE "users" SET "username" = 'legacy_' || numbered.n
FROM numbered WHERE "users"."id" = numbered."id";
--> statement-breakpoint
UPDATE "users" SET "display_name" = "username" WHERE "display_name" IS NULL;
--> statement-breakpoint
UPDATE "users" SET "age" = 30 WHERE "age" IS NULL;
--> statement-breakpoint
```

`'legacy_' || n` is used rather than anything derived from the id because it is guaranteed to satisfy the `users_username_format` CHECK: lowercase letters, an underscore and digits, at least three characters. An expression built from an arbitrary existing id is not.

Editing the SQL is safe with respect to CI's drift check: that job runs `db:generate` and fails on a `git status` change, and `db:generate` diffs `schema.ts` against the snapshot JSON — it does not read or checksum the `.sql` files.

- [ ] **Step 10: Run everything**

Run:

```bash
npm run db:migrate
npm test -w apps/server
npm run test:integration -w apps/server
npm run typecheck
npm run lint:arch
npm run e2e
```

Expected: all PASS. `npm run e2e` matters most here — it is the proof that a real app, driven by a real browser, can complete a session now that nothing creates users implicitly.

- [ ] **Step 11: Confirm the drift check would pass in CI**

Run: `npm run db:generate -w apps/server && git status --porcelain`
Expected: no output. A generated file appearing means `schema.ts` and the snapshot disagree.

- [ ] **Step 12: Commit**

```bash
git add apps/server
git commit -m "feat(server): require an onboarded user to start a session

upsertUser created a user row on first sight, which was right when a UUID
arrived from nowhere. With onboarding, a session for an unknown id is a bug:
startSession looks the user up and the route returns 404. The profile columns
become NOT NULL in the same change, since nothing writes a bare row any more."
```

---

### Task 11: ADR 0005 and the documents this phase invalidates

**Files:**
- Create: `docs/adr/adr-0005-identity-without-authentication.md`
- Create: `scripts/check-adr-0005-identity-without-authentication.sh`
- Modify: `docs/adr/adr-0002-di-with-closures.md` (R6's factory list)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything tasks 1–10 built.
- Produces: three new checks discovered automatically by `scripts/check-adrs.sh` — it globs `scripts/check-adr-*.sh`, so no wiring is needed.

The roles reasoning is deliberately **not** in this ADR. It constrains no code yet; it lives in the spec's *Why `users` has no role column* section, and whichever phase actually builds guardianships writes that ADR then.

- [ ] **Step 1: Write the ADR**

Per `CLAUDE.md`, invoke the `create-adr` skill and answer its gating questions with the material below. The ADR must contain:

- **Status** Accepted, **Date** 2026-09-07, **Source** the phase 8 design.
- **Decision:** a username identifies a learner and authorizes nothing. `POST /api/login` performs a lookup, not an authentication. No credential machinery — password hashes, tokens, auth middleware, a third-party auth SDK — enters the repo until a phase deliberately adds it. Users are created in exactly one place; there is no implicit creation.
- **Rules table:**

  | # | Subject | Must not appear |
  |---|---|---|
  | R1 | `apps/server/src`, `packages/core/src`, `apps/mobile/src` | any credential primitive: `bcrypt`, `argon2`, `jsonwebtoken`, `password_hash`/`passwordHash`, `expo-secure-store` |
  | R2 | `apps/server/src` | `insert(users)` anywhere but `repo/users.ts` |
  | R3 | every `package.json` | an authentication dependency |

- **A rule that is not a grep:** R4 — no authorization decision may read the result of `POST /api/login` as proof of anything. Not greppable: an `if (user)` guarding a feature looks identical whether the identity behind it was authenticated or merely asserted. Enforced by review, and by that endpoint's own published description saying so.
- **Why:** a username with no password is a smaller claim than the client-generated UUID it replaced, not a larger one — but it *looks* like a login, and that resemblance is the risk. The failure mode this ADR prevents is someone adding a "since we're already here" password field, or building a permission check on `login`'s return value, and nobody noticing because both look reasonable in a diff.
- **What the rules cover:** all three `src` trees plus every workspace's `package.json`. `apps/server/tests/support/seedUser.ts` inserts users directly and is deliberately out of R2's scope — it is the test composition root, the same carve-out ADR 0001 and ADR 0004 already grant it. Database migrations are also out of scope: they are SQL, not application code.

- [ ] **Step 2: Write the enforcement script**

Create `scripts/check-adr-0005-identity-without-authentication.sh`, following `scripts/check-adr-0004-test-topology.sh` exactly — same header comment about grep's inverted exit codes, same `check()` helper, same output format:

```bash
r1() {
  grep -rniE "bcrypt|argon2|jsonwebtoken|password_hash|passwordHash|expo-secure-store" \
    apps/server/src packages/core/src apps/mobile/src \
    --include='*.ts' --include='*.tsx'
}

r2() {
  grep -rn "insert(users)" apps/server/src --include='*.ts' | grep -v 'repo/users.ts'
}

r3() {
  grep -nE '"(bcrypt|bcryptjs|argon2|jsonwebtoken|jose|passport|expo-secure-store|firebase)"' \
    package.json apps/*/package.json packages/*/package.json e2e/package.json
}
```

with the three `check` lines:

```bash
echo "Checking the repo against ADR 0005 (identity without authentication)"
echo

check "R1  no credential primitive in any src tree"        r1
check "R2  users are inserted only in repo/users.ts"       r2
check "R3  no authentication dependency in a package.json" r3
```

and the same failure epilogue pointing at `docs/adr/adr-0005-identity-without-authentication.md`.

Make it executable: `chmod +x scripts/check-adr-0005-identity-without-authentication.sh`

- [ ] **Step 3: Prove the checks actually fail on a violation**

Do not trust a check that has only ever passed. Temporarily add `const passwordHash = 'x';` to `apps/server/src/errors.ts`, run `npm run lint:arch`, and confirm R1 reports a VIOLATION and the script exits non-zero. Then remove the line and confirm it passes again. Do the same for R2 by pasting `insert(users)` into a comment in `apps/server/src/services/users.ts`.

- [ ] **Step 4: Update ADR 0002's factory list**

In `docs/adr/adr-0002-di-with-closures.md`, R6's parenthetical list of factories currently reads `createDb, createConsoleLogger, createSessionRepo, createQuestionRepo, createHealthRepo, createTransaction, createSessionService, createServerDeps, createApiClient, createUserIdStore`. Replace `createUserIdStore` with `createRememberedUsernameStore` and add `createUserRepo` and `createUserService`.

- [ ] **Step 5: Update the README**

Four edits:

1. **Data model table** — replace the `users` row with: *One row per learner: a unique `username` they log in with, a `display_name`, an `age`, and their native/target language pair. The id is issued by the database, never by a client.*
2. **ADR table** — add: `| [0005](docs/adr/adr-0005-identity-without-authentication.md) | Identity without authentication — a username identifies, it authorizes nothing |`, and update the count line "All four are enforced by `npm run lint:arch` (15 + 7 + 6 + 5 = 33 checks…)" to "All five … (15 + 7 + 6 + 5 + 3 = 36 checks…)".
3. **Phase index** — add `- Phase 8: [design](docs/superpowers/specs/2026-09-07-lang-tutor-phase-8-onboarding-design.md) · [plan](docs/superpowers/plans/2026-09-07-lang-tutor-phase-8-onboarding.md)`, and add a paragraph to the opening summary describing phase 8 in the voice of the existing ones.
4. **Reading the API** — the sentence "There is no auth and no secret here, and the API surface is already fully described by an open-source client that calls it, so gating them would add configuration and remove no risk." is no longer the whole truth. Replace with:

> There is no auth here, and the API surface is already fully described by an open-source client that calls it, so gating the documentation would add configuration and remove no risk. What *has* changed since phase 8 is that this API now carries personal data: a display name and an age. `POST /api/login` takes a username and no password — it identifies a learner, it does not authenticate one, and nothing may treat it as proof of anything. See [ADR 0005](docs/adr/adr-0005-identity-without-authentication.md).

Also update the **Layout** table's `apps/mobile` row to mention the login, onboarding and profile screens.

- [ ] **Step 6: Run the whole suite one last time**

```bash
npm run lint:arch
npm run typecheck
npm run test:all
npm run e2e
```

Expected: all PASS, and `lint:arch` reports five ADRs.

- [ ] **Step 7: Commit**

```bash
git add docs scripts README.md
git commit -m "docs: add ADR 0005, identity without authentication

A username identifies a learner and authorizes nothing. Three greps keep it
that way: no credential primitive in any src tree, users inserted only in
repo/users.ts, and no auth dependency in any package.json.

The roles reasoning stays in the phase 8 spec — it constrains no code yet."
```

---

## Done when

1. A new learner creates an account in the app and starts a session in the same run, with no database access and no `curl`.
2. A returning learner reaches home in one tap, username prefilled.
3. `POST /api/sessions` for a username that was never onboarded returns 404.
4. `grep -rn "upsertUser" apps/server` finds nothing.
5. No file in the repo contains a fixture user, a dev-only route, or a `__DEV__` identity branch.
6. `npm run lint:arch`, `npm run test:all` and `npm run e2e` are all green.
