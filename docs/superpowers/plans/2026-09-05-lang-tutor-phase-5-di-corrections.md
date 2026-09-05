# Phase 5: Dependency-Injection Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every collaborator in `apps/server/src` received rather than reached for — no `Math.random`, no `console`, no concretely-imported repository factory, no SQL in the wiring layer outside the two composition roots — and prove each new seam with a test.

**Architecture:** The wiring above irreducible I/O becomes a pure function: `loadConfig(env)` → `Config`, `createServerDeps({ db, logger, rng })` → `AppDeps`, `createApp(deps)`. `index.ts` shrinks to a `main()` behind a `require.main === module` guard, and is the only server file that names `Math.random` or opens a socket. A derived `Tx` type separates a transaction handle from a pool handle so "one transaction per use case" becomes a compile error rather than a convention, and the session service receives its repository factories instead of importing them.

**Tech Stack:** Node 22 (`.nvmrc`), TypeScript 6 (`strict`, `verbatimModuleSyntax`, no build step — everything runs from source via `tsx`), Hono 4 + `@hono/node-server`, Drizzle ORM 0.45 over `pg` 8.23, Postgres 17 in Docker Compose, Jest 29 (babel transform), Playwright 1.62 for e2e.

**Spec:** [docs/superpowers/specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md](../specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Closure-based DI is mandatory, no opt-out.** Construct dependencies only at a composition root; capture them in a `createX` factory returning an object of closures; derive the type with `ReturnType<typeof createX>`; pass the object down.
- **The two composition roots are `apps/server/src/index.ts` and `apps/server/src/db/cli.ts`.** They alone may name a concrete collaborator (`Math.random`, `console`, `createConsoleLogger`). `composition.ts` is *assembly only*: no I/O, no logic, no conditionals beyond choosing an implementation.
- **No defaulted collaborators.** `onError` is required; `rng` is required; `logger` is required. `max` is an optional scalar tuning knob, not a collaborator.
- **No module-level mutable state.** No `export const db = …`, no `process.env` read at import time, no singleton caches.
- **No `jest.mock` anywhere, and no `jest.spyOn` anywhere in `apps/server`.** A test passes a fake in. If a test seems to need a mock, a seam is missing — add the seam.
- **Never mutate process-global state in a test.** No `process.env` writes, no `jest.useFakeTimers()`, no swapping globals.
- **No exported test seams.** A module exports what production uses, plus its `ReturnType` types. Nothing extra for tests.
- **Classes only where the language requires one:** `Error` subclasses, and instances we consume but did not write (`pg.Pool`).
- **snake_case in data objects and SQL identifiers**, camelCase in Drizzle property names, camelCase filenames.
- **Pure functions are exempt from the DI rule** but never get a defaulted `rng` or clock: `newSessionRecord(userId, pool, rng)` keeps its signature.
- **The HTTP contract does not change.** No route, status code, or response body changes in this phase.
- **`DATABASE_URL` default stays `postgres://postgres:postgres@localhost:5432/lang_tutor`** — it moves into `config.ts`, it does not change value.
- **Postgres must be running for the test suite**: `npm run db:up` (requires Docker) before any `npm test`. Jest's `globalSetup` builds a per-worker template database.

## Success Criteria

The phase is done when all of these hold (Task 7 runs them):

- `grep -rn "console\." apps/server/src` → only `logger.ts`, `index.ts`, `db/cli.ts`
- `grep -rn "Math.random" apps/server/src` → only `index.ts`
- `grep -rn "jest.spyOn" apps/server` → nothing
- `grep -rn "drizzle-orm" apps/server/src/app.ts` → nothing
- `const b: Tx = db` fails to compile (a permanent `@ts-expect-error` assertion in `src/db/client.test.ts` proves it)
- `npm run typecheck`, `npm test` and `npm run e2e` all green

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/server/src/logger.ts` | The `Logger` type (`info(event)`, `error(message, cause?)`) and `createConsoleLogger()` — the only implementation |
| `apps/server/src/config.ts` | `loadConfig(env)` → `Config` — a pure function of its argument, reads no global |
| `apps/server/src/config.test.ts` | Literal `env` objects in, `Config` out |
| `apps/server/src/index.test.ts` | Proves `index.ts` can be imported without opening a socket or a pool |
| `apps/server/src/repo/health.ts` | `createHealthRepo(db)` → `{ ping(): Promise<boolean> }` — the health query, in the layer queries belong to |
| `apps/server/src/repo/health.test.ts` | `ping()` true against a live database, false against an unreachable one |
| `apps/server/src/composition.ts` | `createServerDeps(io)` → `AppDeps` — assembly only, no I/O |
| `apps/server/src/composition.test.ts` | Called with a per-test database and fakes; asserts a well-formed `AppDeps` |
| `apps/server/tests/support/fakes.ts` | `createFakeLogger()` — a capturing `Logger`, shared by the service, app and composition tests |
| `apps/server/tests/support/testRng.ts` | `testRng(seed)` — the seeded rng, moved out of `repo/sessions.test.ts` so the service test can reuse it |
| `apps/server/tests/support/withTx.ts` | `withTx(db, fn)` — a thin pass-through to `db.transaction`, so repository tests bind a handle the way production does |

**Modified**

| Path | Change |
|---|---|
| `apps/server/src/db/client.ts` | `createDb(url, { max, onError })`; adds the derived `Tx` type |
| `apps/server/src/index.ts` | Becomes `main()` behind a `require.main === module` guard; the only file naming `Math.random` |
| `apps/server/src/db/cli.ts` | Takes its connection string from `loadConfig`, not a copy-pasted literal |
| `apps/server/src/app.ts` | `createApp(deps)`; no `drizzle-orm` import, no `Db`, no service construction, no `console.error` |
| `apps/server/src/services/sessions.ts` | `createSessionService({ db, rng, logger, repos })`; the completed-session log moves outside the transaction |
| `apps/server/src/repo/sessions.ts` | `createSessionRepo(tx: Tx)`; exports `CreateSessionRepo` |
| `apps/server/src/repo/questions.ts` | `createQuestionRepo(tx: Tx)`; exports `CreateQuestionRepo` |
| `apps/server/src/app.test.ts` | Health cases use fakes; the side-effect case goes through `createServerDeps` |
| `apps/server/src/db/client.test.ts` | New signature; gains the `Tx`/`Db` compile-time assertion |
| `apps/server/src/db/schema.test.ts`, `tests/support/{testDb,globalSetup,globalTeardown}.ts`, `e2e/globalSetup.ts` | New `createDb` signature |
| `apps/server/src/services/sessions.test.ts` | Fake logger instead of `jest.spyOn`; adds rng-determinism and fake-repo cases |
| `apps/server/src/repo/sessions.test.ts`, `src/repo/questions.test.ts` | Every case runs inside `withTx` |
| `docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md` | One-line forward pointer: `createApp(db)` is superseded |
| `README.md` | The composition-root rule names `config.ts`/`composition.ts` |

## Task Order

The order is forced by what each change needs from the one before it:

1. **Logger + `createDb` error policy** — nothing depends on it, and `main()` needs both in Task 2.
2. **`config.ts` + `main()`** — the smallest independent piece; writes `main()` once, against the final `createDb` signature.
3. **`repo/health.ts`** — a standalone seam with its own test, needed by `AppDeps` in Task 4.
4. **`createApp(deps)` + `composition.ts`** — the keystone. Every later task adds a collaborator that reaches the service *through* this wiring; done last it would be rewritten four times.
5. **`rng` + `Logger` into the service, log moved out of the transaction** — one parameter addition to Task 4's wiring.
6. **`Tx` + injected repository factories** — one change, because the factory type is `(tx: Tx) => SessionRepo`.
7. **Verification and docs.**

---

### Task 1: Logger and the database error policy

Finding 2, in part: `db/client.ts` reaches for `console`. It receives an error *policy*
instead of a `Logger`, because injecting the full `Logger` into `db/` would drag the
type through ~12 call sites, most of them tests, for no gain — and passing the policy is
more correct than passing a logger to enact a policy hardcoded in the callee.

`createConsoleLogger()` itself has no test: the only way to assert on it is
`jest.spyOn(console, …)`, which this phase removes. Its *seam* is proven in Tasks 4 and 5
by fakes passed through it. `onError` is likewise not directly tested — inducing a real
idle-client error makes a fragile test; it is proven by every call site being *required*
to pass one.

**Files:**
- Create: `apps/server/src/logger.ts`
- Modify: `apps/server/src/db/client.ts:11-22`
- Test: `apps/server/src/db/client.test.ts`
- Modify (call sites): `apps/server/src/index.ts:11`, `apps/server/src/db/cli.ts:8`,
  `apps/server/src/db/schema.test.ts:18,21`, `apps/server/src/app.test.ts:38`,
  `apps/server/tests/support/testDb.ts:17,28,36`,
  `apps/server/tests/support/globalSetup.ts:14,34`,
  `apps/server/tests/support/globalTeardown.ts:7`, `e2e/globalSetup.ts:20,28`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type Logger = { info(event: Record<string, unknown>): void; error(message: string, cause?: unknown): void }` from `src/logger.ts`
  - `export function createConsoleLogger(): Logger` from `src/logger.ts`
  - `export function createDb(connectionString: string, options: { max?: number; onError: (error: Error) => void }): { db: Db; pool: Pool; close: () => Promise<void> }` from `src/db/client.ts`

- [ ] **Step 1: Write the failing test**

Replace the whole of `apps/server/src/db/client.test.ts` with:

```ts
import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from './client';
import { ADMIN_URL } from '../../tests/support/dbNames';

// Deliberately the maintenance database: this test proves connectivity only,
// and must not depend on lang_tutor having been migrated yet. A no-op error
// policy is what a short-lived test handle wants — there is no logger here to
// route an idle-client error to, and nothing to do about one.
const handle = createDb(ADMIN_URL, { max: 1, onError: () => {} });

afterAll(() => handle.close());

describe('createDb', () => {
  it('returns a handle that can query Postgres', async () => {
    const result = await handle.db.execute(sql`select 1 as one`);
    expect(result.rows[0]).toEqual({ one: 1 });
  });

  it('reports the server version, proving a real connection', async () => {
    const result = await handle.db.execute<{ server_version: string }>(sql`show server_version`);
    expect(result.rows[0].server_version).toMatch(/^17\./);
  });

  // The options object is the point of the new signature: under the old
  // positional `max` it lands in the pool config as an object, not a number.
  it('applies the pool size it is given', () => {
    expect(handle.pool.options.max).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run db:up
npm test --workspace apps/server -- src/db/client.test.ts
```

Expected: FAIL on `applies the pool size it is given` — `expect(received).toBe(1)`, received
an object `{ max: 1, onError: [Function] }`. The other two cases pass, because the
connection string is still the first argument.

- [ ] **Step 3: Write `src/logger.ts`**

```ts
// Shaped by the three application call sites: one structured event
// (services/sessions.ts) and two error reports (app.ts, and db/client.ts's error
// policy). A logging library would be a dependency and a configuration surface
// for three call sites; this type does not foreclose putting one behind it later.
export type Logger = {
  info(event: Record<string, unknown>): void;
  error(message: string, cause?: unknown): void;
};

// A composition root names a concrete thing — that is what it is for. This is
// the only implementation, and the only file under services/, repo/, routes/ or
// the wiring layer allowed to touch `console`.
export function createConsoleLogger(): Logger {
  return {
    // An object, not a string: the one info site is an event you tail and grep
    // without opening psql.
    info: (event) => {
      console.log(JSON.stringify(event));
    },
    error: (message, cause) => {
      if (cause === undefined) console.error(message);
      else console.error(message, cause);
    },
  };
}
```

- [ ] **Step 4: Change `createDb`'s signature**

In `apps/server/src/db/client.ts`, replace lines 11-22 (the function body, keeping the
comment block above it) with:

```ts
export function createDb(
  connectionString: string,
  options: { max?: number; onError: (error: Error) => void },
) {
  const pool = new Pool({ connectionString, max: options.max ?? 5 });
  // The policy is received, not decided here: `db/` does not get to choose what
  // an idle-client failure means to the process it is running in.
  pool.on('error', options.onError);
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test --workspace apps/server -- src/db/client.test.ts
```

Expected: PASS, 3 cases.

- [ ] **Step 6: Update every remaining call site**

`apps/server/src/index.ts` — add the import and construct a logger for the policy
(Task 2 moves both inside `main()`):

```ts
import { serve } from '@hono/node-server';

import { createApp } from './app';
import { createDb } from './db/client';
import { createConsoleLogger } from './logger';

const port = Number(process.env.PORT) || 3001;
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lang_tutor';

const logger = createConsoleLogger();

// The process is the composition root: the only place a connection is created.
const { db, close } = createDb(databaseUrl, {
  onError: (error) => logger.error('idle postgres client', error),
});
```

(leave the rest of `index.ts` untouched)

`apps/server/src/db/cli.ts:8` — a composition root writing to a human's terminal:

```ts
  const { db, close } = createDb(url, {
    onError: (error) => console.error('unexpected error on idle Postgres client', error),
  });
```

The remaining sites are test support. Each takes a no-op policy, for the reason in the
comment added to `client.test.ts` above:

- `apps/server/src/db/schema.test.ts:18` → `admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });`
- `apps/server/src/db/schema.test.ts:21` → `handle = createDb(urlFor(DB_NAME), { onError: () => {} });`
- `apps/server/src/app.test.ts:38` → `const dead = createDb('postgres://postgres:postgres@localhost:1/none', { onError: () => {} });`
- `apps/server/tests/support/testDb.ts:17` → `const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });`
- `apps/server/tests/support/testDb.ts:28` → `const handle = createDb(urlFor(name), { onError: () => {} });`
- `apps/server/tests/support/testDb.ts:36` → `const dropper = createDb(ADMIN_URL, { max: 1, onError: () => {} });`
- `apps/server/tests/support/globalSetup.ts:14` → `const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });`
- `apps/server/tests/support/globalSetup.ts:34` → `const handle = createDb(urlFor(name), { max: 1, onError: () => {} });`
- `apps/server/tests/support/globalTeardown.ts:7` → `const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });`
- `e2e/globalSetup.ts:20` → `const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });`
- `e2e/globalSetup.ts:28` → `const handle = createDb(E2E_DATABASE_URL, { max: 1, onError: () => {} });`

Add this one-line comment above `testDb.ts:17` so the no-op is not read as an oversight:

```ts
  // A no-op error policy: a per-test handle lives for one test and has no logger
  // to route an idle-client error to.
```

- [ ] **Step 7: Verify nothing was missed**

```bash
grep -rn "createDb(" apps/server/src apps/server/tests e2e --include="*.ts"
```

Expected: every hit passes an options object; the only remaining positional call is the
declaration in `db/client.ts`.

```bash
npm run typecheck
npm test --workspace apps/server
```

Expected: typecheck clean across all workspaces; the full server suite green.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/logger.ts apps/server/src/db/client.ts apps/server/src/db/client.test.ts \
  apps/server/src/db/cli.ts apps/server/src/db/schema.test.ts apps/server/src/index.ts \
  apps/server/src/app.test.ts apps/server/tests/support e2e/globalSetup.ts
git commit -m "feat(server): inject the idle-connection error policy into createDb

Adds a two-method Logger with a console implementation, and replaces
createDb's positional max with { max, onError }. onError is required: a
defaulted collaborator is the violation this phase removes."
```

---

### Task 2: `config.ts` and a real `main()`

Findings 6 and 7. `postgres://postgres:postgres@localhost:5432/lang_tutor` is currently
written out in two files, `createDb`'s pool size cannot be set from the environment, and
`index.ts` reads the environment, opens a pool and binds a port *at import time* — which
is why nothing in the test suite can reference it.

A second process (`db/cli.ts`) is a legitimate second composition root; the config being
copy-pasted into it is not. Both roots now call `loadConfig`.

**Files:**
- Create: `apps/server/src/config.ts`
- Test: `apps/server/src/config.test.ts` (new), `apps/server/src/index.test.ts` (new)
- Modify: `apps/server/src/index.ts` (whole file), `apps/server/src/db/cli.ts:1-16`

**Interfaces:**
- Consumes: `createDb(url, { max, onError })` and `createConsoleLogger()` from Task 1.
- Produces:
  - `export type Config = { databaseUrl: string; port: number; poolMax: number }` from `src/config.ts`
  - `export function loadConfig(env: NodeJS.ProcessEnv): Config` from `src/config.ts`
  - `export function main(): void` from `src/index.ts` (Task 4 rewrites its body; the signature stays)

- [ ] **Step 1: Write the failing config test**

Create `apps/server/src/config.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { loadConfig } from './config';

// Literal env objects in, Config out. No process.env is read or written here —
// which is the whole point of taking `env` as a parameter.
describe('loadConfig', () => {
  it('falls back to the development defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual({
      databaseUrl: 'postgres://postgres:postgres@localhost:5432/lang_tutor',
      port: 3001,
      poolMax: 5,
    });
  });

  it('takes every value from the environment when it is set', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://u:p@db:5432/other',
        PORT: '8080',
        PG_POOL_MAX: '20',
      }),
    ).toEqual({
      databaseUrl: 'postgres://u:p@db:5432/other',
      port: 8080,
      poolMax: 20,
    });
  });

  it('falls back when a numeric variable is not a number', () => {
    expect(loadConfig({ PORT: 'nonsense', PG_POOL_MAX: '' }).port).toBe(3001);
    expect(loadConfig({ PORT: 'nonsense', PG_POOL_MAX: '' }).poolMax).toBe(5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test --workspace apps/server -- src/config.test.ts
```

Expected: FAIL — `Cannot find module './config' from 'src/config.test.ts'`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
// A pure function of its argument: it reads no global, so a test hands it a
// literal object rather than mutating the process environment.
export type Config = {
  databaseUrl: string;
  port: number;
  poolMax: number;
};

// The one place this default lives. Both composition roots read it from here.
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/lang_tutor';

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    // `Number('') === 0` and `Number('nonsense') === NaN`, both falsy: an unset,
    // empty or malformed value all mean "use the default".
    port: Number(env.PORT) || 3001,
    poolMax: Number(env.PG_POOL_MAX) || 5,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test --workspace apps/server -- src/config.test.ts
```

Expected: PASS, 3 cases.

- [ ] **Step 5: Write the failing import test**

Create `apps/server/src/index.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { main } from './index';

// The guard is the point. Before this task, importing this module read the
// environment, opened a pool and bound port 3001 as a side effect of the import
// itself — which is why nothing in the suite referenced it.
describe('index.ts', () => {
  it('exports main, and importing it starts nothing', () => {
    expect(typeof main).toBe('function');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npm test --workspace apps/server -- src/index.test.ts
```

Expected: FAIL. Either `expect(typeof main).toBe('function')` receiving `"undefined"`, or a
listen failure from the import's side effects (`EADDRINUSE` if a dev server is running).
Jest may also warn that it could not exit cleanly, because the import left a listening
socket and a pool open. All three are the finding.

- [ ] **Step 7: Rewrite `src/index.ts`**

Replace the whole file:

```ts
import { serve } from '@hono/node-server';

import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createConsoleLogger } from './logger';

// The process composition root: the only place that reads the environment, names
// a concrete logger or randomness source, opens a pool, or binds a port. Naming
// concrete things is what this file is for; everything it calls is a pure
// function a test can call with fakes.
export function main(): void {
  const config = loadConfig(process.env);
  // Constructed before the pool, because the pool's error policy closes over it.
  const logger = createConsoleLogger();

  const { db, close } = createDb(config.databaseUrl, {
    max: config.poolMax,
    onError: (error) => logger.error('idle postgres client', error),
  });

  const server = serve(
    { fetch: createApp(db).fetch, port: config.port, hostname: '0.0.0.0' },
    (info) => {
      console.log(`lang-tutor server listening on http://0.0.0.0:${info.port}`);
    },
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void close().then(() => process.exit(0));
      });
    });
  }
}

// Importing this file must not start a server — the pattern e2e/globalSetup.ts
// already uses.
if (require.main === module) {
  main();
}
```

- [ ] **Step 8: Run it to verify it passes**

```bash
npm test --workspace apps/server -- src/index.test.ts
```

Expected: PASS, 1 case, and Jest exits without an open-handle warning.

- [ ] **Step 9: Point `db/cli.ts` at `loadConfig`**

Replace `apps/server/src/db/cli.ts` lines 1-16 (everything above the final
`main().catch(...)`) with:

```ts
import { loadConfig } from '../config';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { seedContent } from './seed';

// A second process is a legitimate second composition root — but it reads the
// same config as the first rather than a copy-pasted connection string.
async function main(): Promise<void> {
  const { databaseUrl, poolMax } = loadConfig(process.env);
  const { db, close } = createDb(databaseUrl, {
    max: poolMax,
    onError: (error) => console.error('unexpected error on idle Postgres client', error),
  });
  try {
    await runMigrations(db);
    await seedContent(db);
    console.log(`migrated and seeded ${databaseUrl}`);
  } finally {
    await close();
  }
}
```

- [ ] **Step 10: Verify the duplicated connection string is gone, and the CLI still runs**

```bash
grep -rn "localhost:5432/lang_tutor" apps/server/src
```

Expected: exactly one hit — `apps/server/src/config.ts`.

```bash
npm run db:migrate
```

Expected: `migrated and seeded postgres://postgres:postgres@localhost:5432/lang_tutor`.

```bash
npm run typecheck
npm test --workspace apps/server
```

Expected: both green.

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/config.test.ts apps/server/src/index.ts \
  apps/server/src/index.test.ts apps/server/src/db/cli.ts
git commit -m "feat(server): add loadConfig and put index.ts behind a main() guard

Both composition roots now read one Config instead of a copy-pasted
connection string, the pool size becomes settable via PG_POOL_MAX, and
importing index.ts no longer opens a pool or binds a port."
```

---

### Task 3: `createHealthRepo`

Finding 3, first half. `app.ts` currently imports `sql` and executes `select 1` — SQL in
the composition root — and the only way a test can reach the 503 branch is to open a real
pool against `localhost:1`. `select 1` is a query, and the layer table gives queries to
`repo/`.

`ping()` returns a boolean rather than throwing: throwing would leave a `try`/`catch`,
and therefore logic, in `app.ts`. The cost is that *why* health failed is swallowed —
acceptable, because a genuinely broken pool surfaces through `createDb`'s `onError`.

**Files:**
- Create: `apps/server/src/repo/health.ts`
- Test: `apps/server/src/repo/health.test.ts` (new)

**Interfaces:**
- Consumes: `createDb(url, { max, onError })` from Task 1; `createTestDb()` from `tests/support/testDb.ts`.
- Produces:
  - `export function createHealthRepo(db: Db): { ping(): Promise<boolean> }`
  - `export type HealthRepo = ReturnType<typeof createHealthRepo>`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/repo/health.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDb } from '../db/client';
import { createHealthRepo } from './health';
import { createTestDb, type TestDb } from '../../tests/support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

describe('createHealthRepo', () => {
  it('reports true when the database answers', async () => {
    expect(await createHealthRepo(t.db).ping()).toBe(true);
  });

  it('reports false when the connection fails, instead of throwing', async () => {
    // A pool pointed at a port nothing listens on: a real connection failure,
    // with no global state touched and nothing mocked. This case moves here from
    // app.test.ts, which after Task 4 reaches its 503 branch with a fake.
    const dead = createDb('postgres://postgres:postgres@localhost:1/none', {
      onError: () => {},
    });
    try {
      expect(await createHealthRepo(dead.db).ping()).toBe(false);
    } finally {
      await dead.close().catch(() => undefined);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test --workspace apps/server -- src/repo/health.test.ts
```

Expected: FAIL — `Cannot find module './health' from 'src/repo/health.test.ts'`.

- [ ] **Step 3: Write `src/repo/health.ts`**

```ts
import { sql } from 'drizzle-orm';

import type { Db } from '../db/client';

// The pool handle, not a transaction handle: this is the one place a
// non-transactional call is genuinely intended.
export function createHealthRepo(db: Db) {
  return {
    // A boolean rather than a throw, so app.ts maps an outcome to a status code
    // with no try/catch — "wires everything, holds no logic" survives.
    ping: async (): Promise<boolean> => {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type HealthRepo = ReturnType<typeof createHealthRepo>;
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test --workspace apps/server -- src/repo/health.test.ts
```

Expected: PASS, 2 cases. The unreachable-pool case takes a moment to fail its connection;
the 30s `testTimeout` covers it.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repo/health.ts apps/server/src/repo/health.test.ts
git commit -m "feat(server): add createHealthRepo so select 1 lives in repo/

ping() returns a boolean rather than throwing, so the composition root maps
an outcome to a status code without a try/catch."
```

---

### Task 4: `createApp(deps)` and the composition layer

Finding 4, and the second half of findings 2 and 3. This is the keystone: every remaining
task adds a collaborator that must reach the service *through* this wiring. Done last, the
wiring would be rewritten four times.

`createApp(db)` cannot accommodate the remaining findings without `createApp` constructing
collaborators itself, which is the "holds no logic" line it exists to respect. So the
whole assembly moves into `composition.ts` — a pure function a test can call with a
per-test database and a fake logger, with no socket and no environment.

**`composition.ts` is assembly only: no I/O, no logic, no conditionals beyond choosing an
implementation.** A file whose whole job is construction attracts "just one more thing";
if it starts making decisions it has stopped being a composition root.

**Files:**
- Create: `apps/server/src/composition.ts`, `apps/server/tests/support/fakes.ts`
- Test: `apps/server/src/composition.test.ts` (new), `apps/server/src/app.test.ts` (rewritten)
- Modify: `apps/server/src/app.ts` (whole file), `apps/server/src/index.ts:20`,
  `apps/server/tests/integration/session-flow.test.ts:4-16`,
  `docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md` (one line)

**Interfaces:**
- Consumes: `Logger` and `createConsoleLogger` (Task 1); `main()` (Task 2); `createHealthRepo`, `HealthRepo` (Task 3); the existing `createSessionService(db)` and `SessionService`.
- Produces:
  - `export type AppDeps = { sessions: SessionService; health: HealthRepo; logger: Logger }` from `src/composition.ts`
  - `export function createServerDeps(io: { db: Db; logger: Logger }): AppDeps` from `src/composition.ts` (Task 5 adds `rng` to `io`)
  - `export function createApp(deps: AppDeps)` from `src/app.ts`
  - `export function createFakeLogger(): FakeLogger` from `tests/support/fakes.ts`, where
    `FakeLogger = Logger & { events: Record<string, unknown>[]; errors: { message: string; cause?: unknown }[] }`

- [ ] **Step 1: Write the capturing logger fake**

Create `apps/server/tests/support/fakes.ts`:

```ts
import type { Logger } from '../../src/logger';

export type FakeLogger = Logger & {
  events: Record<string, unknown>[];
  errors: { message: string; cause?: unknown }[];
};

// A capturing Logger. This is what replaces jest.spyOn(console, 'log'): a fake
// passed in, rather than process-global state mutated inside a Jest worker.
export function createFakeLogger(): FakeLogger {
  const events: Record<string, unknown>[] = [];
  const errors: { message: string; cause?: unknown }[] = [];
  return {
    events,
    errors,
    info: (event) => {
      events.push(event);
    },
    error: (message, cause) => {
      errors.push({ message, cause });
    },
  };
}
```

- [ ] **Step 2: Write the failing composition test**

Create `apps/server/src/composition.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createServerDeps } from './composition';
import { createFakeLogger } from '../tests/support/fakes';
import { createTestDb, type TestDb } from '../tests/support/testDb';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

// The seam proof for the wiring layer itself: production's assembly, called with
// a per-test database and a fake logger — no socket, no environment.
describe('createServerDeps', () => {
  it('passes the logger it is given straight through', () => {
    const logger = createFakeLogger();
    expect(createServerDeps({ db: t.db, logger }).logger).toBe(logger);
  });

  it('assembles a health repo bound to the database it is given', async () => {
    const deps = createServerDeps({ db: t.db, logger: createFakeLogger() });
    expect(await deps.health.ping()).toBe(true);
  });

  it('assembles a session service that works against that database', async () => {
    const deps = createServerDeps({ db: t.db, logger: createFakeLogger() });
    const { record } = await deps.sessions.startSession('u1');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm test --workspace apps/server -- src/composition.test.ts
```

Expected: FAIL — `Cannot find module './composition' from 'src/composition.test.ts'`.

- [ ] **Step 4: Write `src/composition.ts`**

```ts
import type { Db } from './db/client';
import type { Logger } from './logger';
import { createHealthRepo, type HealthRepo } from './repo/health';
import { createSessionService, type SessionService } from './services/sessions';

export type AppDeps = {
  sessions: SessionService;
  health: HealthRepo;
  logger: Logger;
};

// Assembly only: no I/O, no logic, no conditionals beyond choosing an
// implementation. `db` and `logger` are received rather than built here because
// createDb opens a real pool — that stays in main(), and everything above it is
// a pure function a test can call.
export function createServerDeps(io: { db: Db; logger: Logger }): AppDeps {
  return {
    sessions: createSessionService(io.db),
    health: createHealthRepo(io.db),
    logger: io.logger,
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npm test --workspace apps/server -- src/composition.test.ts
```

Expected: PASS, 3 cases.

- [ ] **Step 6: Write the failing app test**

Replace the whole of `apps/server/src/app.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from './app';
import type { AppDeps } from './composition';
import { createServerDeps } from './composition';
import type { SessionService } from './services/sessions';
import { createFakeLogger } from '../tests/support/fakes';
import { createTestDb, type TestDb } from '../tests/support/testDb';

// A service that fails if it is called at all. Passing it alongside a health fake
// proves the health route never reaches the service, rather than assuming it.
const unreachableSessions: SessionService = {
  startSession: () => {
    throw new Error('the health route must not reach the session service');
  },
  submitAnswer: () => {
    throw new Error('the health route must not reach the session service');
  },
};

function depsWithPing(ok: boolean): AppDeps {
  return {
    sessions: unreachableSessions,
    health: { ping: async () => ok },
    logger: createFakeLogger(),
  };
}

// No database: the health route's two branches are now reachable with a fake,
// where before this task the 503 branch needed a real pool against localhost:1.
describe('GET /health', () => {
  it('returns 200 with ok: true when the health check passes', async () => {
    const res = await createApp(depsWithPing(true)).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 503 with ok: false when the health check fails', async () => {
    const res = await createApp(depsWithPing(false)).request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});

// This one keeps a real database on purpose: it asserts something about the app
// production actually assembles, so faking the service would assert nothing.
describe('the app as production assembles it', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('does not create a session as a side effect of a health check', async () => {
    const app = createApp(createServerDeps({ db: t.db, logger: createFakeLogger() }));
    await app.request('/health');
    const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', question_id: 'q-window', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
npm test --workspace apps/server -- src/app.test.ts
```

Expected: FAIL — `createApp` still takes a `Db`, so `deps.health.ping` is undefined and the
health cases throw `TypeError: db.execute is not a function` (or return 503 for the wrong
reason).

- [ ] **Step 8: Rewrite `src/app.ts`**

Replace the whole file:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { AppDeps } from './composition';
import { createSessionsRouter } from './routes/sessions';

// Wires everything, holds no logic — and after this phase it does not know a
// database exists: no drizzle import, no Db, no SQL, no console. Every
// collaborator arrives in `deps`.
export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use('*', cors());

  // Readiness, not just liveness: the e2e suite waits on this before starting the
  // app, and a 503 here is what distinguishes "server booting" from "broken".
  app.get('/health', async (c) => {
    const ok = await deps.health.ping();
    return ok ? c.json({ ok: true }) : c.json({ ok: false }, 503);
  });

  app.route('/api/sessions', createSessionsRouter(deps.sessions));

  app.onError((error, c) => {
    deps.logger.error('unhandled request error', error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
```

- [ ] **Step 9: Run it to verify it passes**

```bash
npm test --workspace apps/server -- src/app.test.ts
```

Expected: PASS, 3 cases.

- [ ] **Step 10: Update the two remaining `createApp` call sites**

`apps/server/src/index.ts` — inside `main()`, replace the `serve` call's `fetch`:

```ts
  const deps = createServerDeps({ db, logger });

  const server = serve(
    { fetch: createApp(deps).fetch, port: config.port, hostname: '0.0.0.0' },
    (info) => {
      console.log(`lang-tutor server listening on http://0.0.0.0:${info.port}`);
    },
  );
```

and add the import: `import { createServerDeps } from './composition';`

`apps/server/tests/integration/session-flow.test.ts` — add two imports and change line 16:

```ts
import { createServerDeps } from '../../src/composition';
import { createFakeLogger } from '../support/fakes';
```

```ts
    server = serve(
      { fetch: createApp(createServerDeps({ db: t.db, logger: createFakeLogger() })).fetch, port: 0 },
      (info) => {
        baseUrl = `http://localhost:${info.port}`;
        resolve();
      },
    );
```

- [ ] **Step 11: Add the forward pointer to phase 4's spec**

Phase 4's spec prescribes `createApp(db)` and must not be followed as current guidance,
but rewriting its prescriptions retroactively would make it a worse record. It gains
exactly one line. In
`docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md`, insert this
immediately after the intro paragraph ending `becomes mandatory rather than aspirational.`
and before `## Goals`:

```markdown
> **Superseded in part:** `createApp(db)` — prescribed below in *Existing violations* and
> *Wiring, health, errors* — is replaced by `createApp(deps)` in
> [phase 5](2026-09-05-lang-tutor-phase-5-di-corrections-design.md). The rest of this
> document stands.
```

- [ ] **Step 12: Verify the composition root holds no SQL**

```bash
grep -rn "drizzle-orm" apps/server/src/app.ts
grep -rn "console\." apps/server/src/app.ts
```

Expected: no output from either.

```bash
npm run typecheck
npm test --workspace apps/server
```

Expected: both green.

- [ ] **Step 13: Commit**

```bash
git add apps/server/src/composition.ts apps/server/src/composition.test.ts \
  apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/index.ts \
  apps/server/tests/support/fakes.ts apps/server/tests/integration/session-flow.test.ts \
  docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md
git commit -m "feat(server): replace createApp(db) with createApp(deps)

Assembly moves to a pure createServerDeps(io); app.ts no longer imports
drizzle, executes SQL, constructs the service, or reaches for console."
```

---

### Task 5: `rng` and `Logger` into the service, and the log out of the transaction

Findings 1 and 2, and the one real defect. `services/sessions.ts:42` reaches for
`Math.random`, so no test can pin which ten questions a session draws;
`services/sessions.ts:11` reaches for `console`, so two tests use
`jest.spyOn(console, 'log')` — the same signal a missing seam always gives — and mutate
process-global state inside a Jest worker.

And `logCompletedSession` is called *inside* `db.transaction`: if the commit fails after
`completeSession`, stdout has already claimed a session the database never recorded. The
transaction callback now returns its outcome and the log fires after it resolves. A
replay yields `justCompleted: false`, preserving today's behaviour exactly — logged once
on completion, never on a retry.

A single destructured deps object, not four positional parameters: the house style
already uses one for multi-dependency factories (`createApiClient({ baseUrl, fetch })`,
`createUserIdStore({ storage, randomUUID })`).

**Files:**
- Create: `apps/server/tests/support/testRng.ts`
- Modify: `apps/server/src/services/sessions.ts` (whole file),
  `apps/server/src/composition.ts:16-22`, `apps/server/src/index.ts` (one line),
  `apps/server/src/repo/sessions.test.ts:21-30` (drop the local `testRng`)
- Test: `apps/server/src/services/sessions.test.ts` (rewritten),
  `apps/server/src/composition.test.ts`, `apps/server/src/app.test.ts`,
  `apps/server/src/routes/sessions.test.ts`,
  `apps/server/tests/integration/session-flow.test.ts` (call sites)

**Interfaces:**
- Consumes: `Logger` (Task 1), `createServerDeps`/`AppDeps` (Task 4), `createFakeLogger` (Task 4).
- Produces:
  - `export function createSessionService(deps: { db: Db; rng: () => number; logger: Logger })` — Task 6 adds `repos`
  - `export function testRng(seed: number): () => number` from `tests/support/testRng.ts`
  - `createServerDeps(io: { db: Db; logger: Logger; rng: () => number })` — `rng` added to `io`

- [ ] **Step 1: Move the seeded rng into test support**

Create `apps/server/tests/support/testRng.ts`:

```ts
// A deterministic rng for tests. packages/core's seededRng is deliberately
// unreachable — `utils` is absent from both core's index.ts and its exports map
// — and this phase does not change that.
export function testRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}
```

In `apps/server/src/repo/sessions.test.ts`, delete the local `testRng` (lines 21-30) and
import it instead:

```ts
import { testRng } from '../../tests/support/testRng';
```

- [ ] **Step 2: Rewrite the service test against the seams**

Replace lines 1-18 of `apps/server/src/services/sessions.test.ts` (imports and hooks;
`jest` goes with them) with:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { createFakeLogger, type FakeLogger } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import { createSessionService, type SessionService } from './sessions';

let t: TestDb;
let logger: FakeLogger;
let service: SessionService;

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  service = createSessionService({ db: t.db, rng: testRng(7), logger });
});

afterEach(async () => {
  await t.close();
});
```

Replace the two logging cases (currently lines 78-110) with:

```ts
  it('completes the session on the tenth answer and logs it exactly once', async () => {
    const { sessionId, record } = await service.startSession('u1');

    let current = record;
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const question = current.questions[i];
      current = await service.submitAnswer(sessionId, question.id, question.correct_option);
    }

    expect(current.complete).toBe(true);
    expect(current.answers).toHaveLength(SESSION_LENGTH);
    expect(logger.events).toHaveLength(1);
    expect(logger.events[0]).toMatchObject({
      session_id: sessionId,
      user_id: 'u1',
      score: { correct: SESSION_LENGTH, total: SESSION_LENGTH },
    });
  });

  it('does not log a second time when a completed session is retried', async () => {
    const { sessionId, record } = await service.startSession('u1');
    let current = record;
    for (let i = 0; i < SESSION_LENGTH; i++) {
      const question = current.questions[i];
      current = await service.submitAnswer(sessionId, question.id, question.correct_option);
    }
    expect(logger.events).toHaveLength(1);

    const last = record.questions[SESSION_LENGTH - 1];
    await service.submitAnswer(sessionId, last.id, last.correct_option);
    expect(logger.events).toHaveLength(1);
  });
```

And add a new `describe` at the end of the file — the assertion that is impossible today:

```ts
describe('rng', () => {
  it('draws the same ten questions for two services sharing a seed', async () => {
    const first = createSessionService({ db: t.db, rng: testRng(7), logger: createFakeLogger() });
    const second = createSessionService({ db: t.db, rng: testRng(7), logger: createFakeLogger() });

    const a = await first.startSession('u1');
    const b = await second.startSession('u2');

    expect(b.record.questions.map((question) => question.id)).toEqual(
      a.record.questions.map((question) => question.id),
    );
  });
});
```

> If this case ever flakes, the cause is `loadQuestionPool` having no `ORDER BY`, so
> Postgres returned the pool rows in a different order for the two calls. The fix is an
> `ORDER BY` in the repository, not a weaker assertion.

- [ ] **Step 3: Run it to verify it fails**

```bash
npm test --workspace apps/server -- src/services/sessions.test.ts
```

Expected: FAIL — `createSessionService` still takes a `Db`, so `db.transaction` is not a
function on the deps object.

- [ ] **Step 4: Rewrite `src/services/sessions.ts`**

Replace the whole file:

```ts
import type { SessionRecord } from '../domain/session';
import { newSessionRecord, sessionScore, step } from '../domain/session';
import type { Db } from '../db/client';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import type { Logger } from '../logger';
import { createQuestionRepo } from '../repo/questions';
import { createSessionRepo } from '../repo/sessions';

// The one place a completed session is logged. Redundant with the database, kept
// because it is output you can tail without opening psql — structured, so you
// can grep it.
function logCompletedSession(logger: Logger, sessionId: string, record: SessionRecord): void {
  logger.info({
    session_id: sessionId,
    user_id: record.user_id,
    questions: record.questions,
    answers: record.answers,
    score: sessionScore(record),
  });
}

/**
 * The application layer. Each use case is one transaction, opened here — a route
 * handler never opens one. The repositories are created from the transaction
 * handle inside, because that handle does not exist until the transaction does.
 *
 * Every collaborator arrives in one deps object: nothing here reaches for a
 * source of randomness or an output stream.
 */
export function createSessionService({
  db,
  rng,
  logger,
}: {
  db: Db;
  rng: () => number;
  logger: Logger;
}) {
  return {
    startSession: (userId: string): Promise<{ sessionId: string; record: SessionRecord }> =>
      db.transaction(async (tx) => {
        const sessionRepo = createSessionRepo(tx);
        const questionRepo = createQuestionRepo(tx);

        const user = await sessionRepo.upsertUser(userId);
        const pool = await questionRepo.loadQuestionPool(
          user.targetLanguage,
          user.nativeLanguage,
          userId,
        );
        const record = newSessionRecord(userId, pool, rng);
        const sessionId = await sessionRepo.insertSession(userId, record.questions);
        return { sessionId, record };
      }),

    submitAnswer: async (
      sessionId: string,
      questionId: string,
      optionIndex: number,
    ): Promise<SessionRecord> => {
      // The transaction returns its outcome and the log fires after it resolves:
      // a commit that fails after completeSession must not leave a log claiming a
      // session the database never recorded.
      const { record, justCompleted } = await db.transaction(async (tx) => {
        const repo = createSessionRepo(tx);
        const loaded = await repo.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);

        const outcome = step(loaded.record, questionId, optionIndex);
        if (outcome.status === 'invalid_question') throw new QuestionDesynced(questionId);
        // A replay reports justCompleted: false, so retrying a completed session
        // logs nothing — exactly today's behaviour.
        if (outcome.status === 'replayed') {
          return { record: outcome.record, justCompleted: false };
        }

        const position = loaded.record.answers.length;
        const order = loaded.optionOrders[position];
        if (optionIndex >= order.length) throw new OptionOutOfRange(optionIndex);

        await repo.insertAnswer(sessionId, position, questionId, order[optionIndex]);

        if (outcome.justCompleted) {
          await repo.completeSession(sessionId);
        }

        return { record: outcome.record, justCompleted: outcome.justCompleted };
      });

      if (justCompleted) {
        logCompletedSession(logger, sessionId, record);
      }

      return record;
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
```

- [ ] **Step 5: Thread `rng` through the wiring**

`apps/server/src/composition.ts` — add `rng` to `io` and pass the deps object:

```ts
export function createServerDeps(io: { db: Db; logger: Logger; rng: () => number }): AppDeps {
  return {
    sessions: createSessionService({ db: io.db, rng: io.rng, logger: io.logger }),
    health: createHealthRepo(io.db),
    logger: io.logger,
  };
}
```

`apps/server/src/index.ts` — inside `main()`, the one line that names randomness in the
whole server:

```ts
  const deps = createServerDeps({ db, logger, rng: Math.random });
```

- [ ] **Step 6: Update the remaining service and deps call sites**

Each of these gains a seeded rng — no test may name `Math.random`, and `src/**` may not
either outside `index.ts`:

- `apps/server/src/composition.test.ts` — add `import { testRng } from '../tests/support/testRng';` and change all three calls to `createServerDeps({ db: t.db, logger, rng: testRng(7) })` (keeping each call's existing `logger` value; where the test passes `createFakeLogger()` inline, keep it inline).
- `apps/server/src/app.test.ts` — add the same import (`'../tests/support/testRng'`) and change the one call to `createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })`.
- `apps/server/tests/integration/session-flow.test.ts` — add `import { testRng } from '../support/testRng';` and change the call to `createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) })`.
- `apps/server/src/routes/sessions.test.ts:20` — add
  `import { createFakeLogger } from '../../tests/support/fakes';` and
  `import { testRng } from '../../tests/support/testRng';`, then:

```ts
function buildTestApp() {
  const app = new Hono();
  app.route(
    '/api/sessions',
    createSessionsRouter(
      createSessionService({ db: t.db, rng: testRng(7), logger: createFakeLogger() }),
    ),
  );
  return app;
}
```

- [ ] **Step 7: Run the suite to verify it passes**

```bash
npm test --workspace apps/server
```

Expected: PASS. `src/services/sessions.test.ts` now runs its eight original cases plus the
new `rng` case; the fake-repository case arrives in Task 6.

- [ ] **Step 8: Verify the reach-outs are gone**

```bash
grep -rn "Math.random" apps/server/src
grep -rn "jest.spyOn" apps/server
grep -rn "console\." apps/server/src
```

Expected: `Math.random` only in `src/index.ts`; no `jest.spyOn` anywhere; `console.` only in
`src/logger.ts`, `src/index.ts` and `src/db/cli.ts`.

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/services/sessions.ts apps/server/src/services/sessions.test.ts \
  apps/server/src/composition.ts apps/server/src/composition.test.ts apps/server/src/index.ts \
  apps/server/src/app.test.ts apps/server/src/routes/sessions.test.ts \
  apps/server/src/repo/sessions.test.ts apps/server/tests/support/testRng.ts \
  apps/server/tests/integration/session-flow.test.ts
git commit -m "feat(server): inject rng and Logger into the session service

index.ts becomes the only file naming Math.random, jest.spyOn leaves the
server, and the completed-session log moves outside the transaction that
records it."
```

---

### Task 6: the `Tx` type and injected repository factories

Findings 5 and 8, as one change, because the injected factory's type *is* `(tx: Tx) => Repo`.

Today `Db` is one type for both a pool handle and a transaction handle, and the assignability
runs the wrong way: a repository handed the *pool* instead of `tx` compiles and silently
runs outside the transaction — `repo/sessions.test.ts:45` already does exactly that. A
derived `Tx` closes it:

```ts
const a: Db = tx;   // still compiles — a transaction satisfies Db
const b: Tx = db;   // TS2739: NodePgDatabase is missing 'schema', 'nestedIndex',
                    // 'rollback', 'setTransaction'
```

Derived rather than hand-written, because spelling out
`PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<…>>` guesses
generics that can drift from what Drizzle actually hands the callback.

`createHealthRepo` deliberately keeps `Db` — the one place a non-transactional call is
intended. And the rejected alternative (stateless repositories taking the handle as a first
argument) stays rejected: it lets one call in `submitAnswer` receive `tx` and the next
receive the pool and still compile, silently dropping the `SELECT … FOR UPDATE`
serialisation the design rests on.

**Files:**
- Create: `apps/server/tests/support/withTx.ts`
- Modify: `apps/server/src/db/client.ts` (add `Tx`), `apps/server/src/repo/sessions.ts:4,30`,
  `apps/server/src/repo/questions.ts:4,32`, `apps/server/src/services/sessions.ts`,
  `apps/server/src/composition.ts`
- Test: `apps/server/src/db/client.test.ts` (compile-time assertion),
  `apps/server/src/repo/sessions.test.ts` (rewritten),
  `apps/server/src/repo/questions.test.ts` (rewritten),
  `apps/server/src/services/sessions.test.ts` (fake-repo case),
  `apps/server/src/routes/sessions.test.ts` (call site)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces:
  - `export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]` from `src/db/client.ts`
  - `export function createSessionRepo(tx: Tx)` and `export type CreateSessionRepo = (tx: Tx) => SessionRepo`
  - `export function createQuestionRepo(tx: Tx)` and `export type CreateQuestionRepo = (tx: Tx) => QuestionRepo`
  - `createSessionService({ db, rng, logger, repos: { session, question } })`
  - `export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>` from `tests/support/withTx.ts`

- [ ] **Step 1: Write the failing compile-time assertion**

In `apps/server/src/db/client.test.ts`, change the import to
`import { createDb, type Tx } from './client';` and add, directly below the `handle`
declaration (deliberately *without* the `@ts-expect-error` line for now):

```ts
const notATransaction: Tx = handle.db;
void notATransaction;
```

- [ ] **Step 2: Run typecheck to verify it fails**

```bash
npm run typecheck --workspace apps/server
```

Expected: FAIL — `Module '"./client"' has no exported member 'Tx'`.

- [ ] **Step 3: Add the `Tx` type**

Append to `apps/server/src/db/client.ts`:

```ts
// A transaction handle, derived from what Drizzle actually hands the transaction
// callback rather than hand-written from its generics. `Db` accepts a `Tx`, but
// not the reverse — which is what makes "one transaction per use case" a
// compile error instead of a convention someone has to remember.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
```

- [ ] **Step 4: Run typecheck to verify the assertion now fails for the right reason**

```bash
npm run typecheck --workspace apps/server
```

Expected: FAIL with exactly
`src/db/client.test.ts(…): error TS2739: Type 'NodePgDatabase<…>' is missing the following properties from type 'PgTransaction<…>': schema, nestedIndex, rollback, setTransaction`.
That message *is* the proof; now pin it in place.

- [ ] **Step 5: Pin it with `@ts-expect-error`**

```ts
// A compile-time assertion, not a runtime one: the pool handle must not satisfy
// `Tx`. If this ever compiles, tsc fails on the unused directive — so the
// asymmetry cannot silently regress.
// @ts-expect-error a pool handle is not a transaction handle
const notATransaction: Tx = handle.db;
void notATransaction;
```

```bash
npm run typecheck --workspace apps/server
```

Expected: clean.

- [ ] **Step 6: Write the transaction helper for repository tests**

Create `apps/server/tests/support/withTx.ts`:

```ts
import type { Db, Tx } from '../../src/db/client';

// A thin pass-through to db.transaction, not a try/catch: the repositories take a
// transaction handle, so their tests bind one the way production does. Nothing is
// caught here — a helper that swallowed a rollback would let a test report success
// on work the database discarded.
export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
```

- [ ] **Step 7: Rewrite `src/repo/sessions.test.ts` against transactions**

Replace the whole file:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { testRng } from '../../tests/support/testRng';
import { withTx } from '../../tests/support/withTx';
import type { Tx } from '../db/client';
import { newSessionRecord } from '../domain/session';
import { sessions } from '../db/schema';
import { createQuestionRepo } from './questions';
import { createSessionRepo } from './sessions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

/** Creates a session the way the service does — inside the caller's transaction. */
async function startSession(tx: Tx, userId = 'u1') {
  const sessionRepo = createSessionRepo(tx);
  const questionRepo = createQuestionRepo(tx);
  const user = await sessionRepo.upsertUser(userId);
  const pool = await questionRepo.loadQuestionPool(user.targetLanguage, user.nativeLanguage, userId);
  const record = newSessionRecord(userId, pool, testRng(7));
  const sessionId = await sessionRepo.insertSession(userId, record.questions);
  return { sessionRepo, sessionId, record };
}

describe('upsertUser', () => {
  it('creates an unknown user with Hebrew/English defaults', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      expect(await repo.upsertUser('brand-new')).toEqual({
        nativeLanguage: 'he',
        targetLanguage: 'en',
      });
    });
  });

  it('is idempotent for a user that already exists', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      await repo.upsertUser('twice');
      expect(await repo.upsertUser('twice')).toEqual({
        nativeLanguage: 'he',
        targetLanguage: 'en',
      });
    });
  });
});

describe('insertSession then loadSession', () => {
  it('round-trips the ten questions in presentation order', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, record } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded).toBeDefined();
      expect(loaded!.record.questions).toHaveLength(SESSION_LENGTH);
      expect(loaded!.record.questions.map((q) => q.id)).toEqual(record.questions.map((q) => q.id));
    });
  });

  it('round-trips the per-session option shuffle exactly', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId, record } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      // The shuffled option text and the correct index must survive storage; this
      // is what option_order exists for.
      expect(loaded!.record.questions).toEqual(record.questions);
    });
  });

  it('reports an unstarted session as incomplete with no answers', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.record.answers).toEqual([]);
      expect(loaded!.record.complete).toBe(false);
      expect(loaded!.record.completed_at).toBeNull();
    });
  });

  it('returns undefined for an unknown session id', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      expect(await repo.loadSession('00000000-0000-0000-0000-000000000000')).toBeUndefined();
    });
  });

  // `sessions.id` is a `uuid` column, so a malformed id would otherwise reach
  // Postgres and raise 22P02 (invalid input syntax for type uuid) rather than
  // simply finding no row. Treat it the same as "not found".
  it('returns undefined for a malformed (non-UUID) session id, without querying the database', async () => {
    await withTx(t.db, async (tx) => {
      const repo = createSessionRepo(tx);
      expect(await repo.loadSession('not-a-uuid')).toBeUndefined();
    });
  });

  it('exposes an option order parallel to the questions', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.optionOrders).toHaveLength(SESSION_LENGTH);
      for (const order of loaded!.optionOrders) {
        expect([...order].sort()).toEqual([0, 1, 2, 3]);
      }
    });
  });
});

describe('insertAnswer', () => {
  it('reconstitutes answer_string and is_correct from the canonical option', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const before = await sessionRepo.loadSession(sessionId);
      const question = before!.record.questions[0];
      const displayIndex = question.correct_option;
      const canonical = before!.optionOrders[0][displayIndex];

      await sessionRepo.insertAnswer(sessionId, 0, question.id, canonical);

      const after = await sessionRepo.loadSession(sessionId);
      expect(after!.record.answers).toEqual([
        {
          question_id: question.id,
          is_correct: true,
          answer_string: question.options[displayIndex],
        },
      ]);
    });
  });

  it('records an incorrect answer as incorrect', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const before = await sessionRepo.loadSession(sessionId);
      const question = before!.record.questions[0];
      const wrongDisplay = (question.correct_option + 1) % question.options.length;
      const canonical = before!.optionOrders[0][wrongDisplay];

      await sessionRepo.insertAnswer(sessionId, 0, question.id, canonical);

      const after = await sessionRepo.loadSession(sessionId);
      expect(after!.record.answers[0].is_correct).toBe(false);
      expect(after!.record.answers[0].answer_string).toBe(question.options[wrongDisplay]);
    });
  });

  // The constraint violation aborts the transaction, and nothing runs in it
  // afterwards: Postgres answers the eventual COMMIT with a rollback, which is
  // the correct outcome for a test that asserts only the rejection.
  it('rejects a second answer at the same position', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      const question = loaded!.record.questions[0];
      await sessionRepo.insertAnswer(sessionId, 0, question.id, 0);
      await expect(sessionRepo.insertAnswer(sessionId, 0, question.id, 1)).rejects.toThrow();
    });
  });

  it('rejects an answer naming a question not at that position', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      const loaded = await sessionRepo.loadSession(sessionId);
      const notFirst = loaded!.record.questions[1];
      await expect(sessionRepo.insertAnswer(sessionId, 0, notFirst.id, 0)).rejects.toThrow();
    });
  });
});

describe('completeSession', () => {
  it('sets completed_at, which loadSession reports as complete', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      await sessionRepo.completeSession(sessionId);

      const loaded = await sessionRepo.loadSession(sessionId);
      expect(loaded!.record.complete).toBe(true);
      expect(typeof loaded!.record.completed_at).toBe('number');

      // Read through `tx`, not `t.db`: a pool connection would not see this
      // transaction's uncommitted write, and the assertion would fail for a
      // reason that has nothing to do with completeSession.
      const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(row.completedAt).not.toBeNull();
    });
  });

  it('keeps the row after completion — there is no stale sweep', async () => {
    await withTx(t.db, async (tx) => {
      const { sessionRepo, sessionId } = await startSession(tx);
      await sessionRepo.completeSession(sessionId);
      expect(await sessionRepo.loadSession(sessionId)).toBeDefined();
    });
  });
});
```

- [ ] **Step 8: Rewrite `src/repo/questions.test.ts` the same way**

Replace lines 1-6 (imports) and every case body:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createTestDb, type TestDb } from '../../tests/support/testDb';
import { withTx } from '../../tests/support/withTx';
import { content } from '../db/content';
import { users } from '../db/schema';
import { createQuestionRepo } from './questions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await t.db.insert(users).values({ id: 'u1' });
});

afterEach(async () => {
  await t.close();
});

describe('loadQuestionPool', () => {
  it('returns every shared question for the language pair', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      expect(pool).toHaveLength(content.length);
    });
  });

  it('returns options in canonical order with correct_option pointing at the right one', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      const question = pool.find((q) => q.id === 'q-window')!;
      expect(question.options).toEqual(['דלת', 'חלון', 'שולחן', 'קיר']);
      expect(question.correct_option).toBe(1);
    });
  });

  it("uses the term variant's form as the prompt, not the lemma", async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      expect(pool.find((q) => q.id === 'q-remember')!.question).toBe('to remember');
    });
  });

  it('exposes the vocabulary term id', async () => {
    await withTx(t.db, async (tx) => {
      const pool = await createQuestionRepo(tx).loadQuestionPool('en', 'he', 'u1');
      expect(pool.find((q) => q.id === 'q-window')!.vocab_term_id).toBe('vt-en-window');
    });
  });

  it('returns nothing for a language pair with no content', async () => {
    await withTx(t.db, async (tx) => {
      expect(await createQuestionRepo(tx).loadQuestionPool('es', 'ru', 'u1')).toEqual([]);
    });
  });
});
```

- [ ] **Step 9: Run the repository tests — and watch them pass before the fix**

```bash
npm run typecheck --workspace apps/server
npm test --workspace apps/server -- src/repo
```

Expected: clean typecheck and PASS, 19 cases — *before* the repositories change signature.
That is finding 5 itself: `PgTransaction` satisfies `Db`, so passing a `tx` where a `Db` is
declared already compiles. The hole runs the other way — passing the *pool* where a
transaction is meant — and the next step is what closes it. The green run here is the
baseline that proves the rewrite of these two files changed no behaviour.

- [ ] **Step 10: Move both repositories to `Tx`**

In `apps/server/src/repo/sessions.ts`: change the import on line 4 to
`import type { Tx } from '../db/client';`, change the signature on line 30 to
`export function createSessionRepo(tx: Tx) {`, rename every use of the parameter in the
body, and add the factory type at the bottom:

```bash
# In the repository body, `db` is only ever the parameter — these three calls are
# every use of it. (BSD sed on macOS: no \b, no alternation, hence three -e clauses.)
sed -i '' -e 's/db\.insert/tx.insert/g' -e 's/db\.select/tx.select/g' \
  -e 's/db\.update/tx.update/g' apps/server/src/repo/sessions.ts
grep -n "db\." apps/server/src/repo/sessions.ts   # expect: no hits
```

```ts
export type SessionRepo = ReturnType<typeof createSessionRepo>;

// The injected factory's type. Typing only this would leave the hole open: since
// `Tx` is assignable to `Db`, a `Db`-taking factory still satisfies it by
// parameter contravariance — so `createSessionRepo` itself must take a `Tx`.
export type CreateSessionRepo = (tx: Tx) => SessionRepo;
```

The same three edits in `apps/server/src/repo/questions.ts` — import on line 4, signature
on line 32 (`export function createQuestionRepo(tx: Tx) {`), and the same `sed` over the
body (it has one `db.select`) — plus:

```ts
export type QuestionRepo = ReturnType<typeof createQuestionRepo>;
export type CreateQuestionRepo = (tx: Tx) => QuestionRepo;
```

- [ ] **Step 11: Verify the hole is closed**

```bash
npm run typecheck --workspace apps/server
```

Expected: clean — the repository tests now pass a real `tx`, and `createSessionRepo(t.db)`
would no longer compile anywhere.

```bash
npm test --workspace apps/server -- src/repo
```

Expected: PASS, 19 cases.

- [ ] **Step 12: Write the failing fake-repository test**

Append to `apps/server/src/services/sessions.test.ts`, and extend its imports with:

```ts
import type { Db, Tx } from '../db/client';
import { createQuestionRepo } from '../repo/questions';
import { createSessionRepo, type SessionRepo } from '../repo/sessions';
```

```ts
describe('repos', () => {
  // This case needs no database: the repository factories are the seam, so a
  // handle that only knows how to run a transaction callback is enough. (The
  // file-level beforeEach still clones one — moving cases like this off Postgres
  // is phase 6's job, not this phase's.)
  function fakeDb(): Db {
    return {
      transaction: (run: (tx: Tx) => Promise<unknown>) => run({} as Tx),
    } as unknown as Db;
  }

  function sessionRepoWith(overrides: Partial<SessionRepo>): SessionRepo {
    const notStubbed = () => {
      throw new Error('this repository method should not have been called');
    };
    return {
      upsertUser: notStubbed,
      insertSession: notStubbed,
      loadSession: notStubbed,
      insertAnswer: notStubbed,
      completeSession: notStubbed,
      ...overrides,
    };
  }

  it('throws SessionNotFound when the repository reports no such session', async () => {
    const service = createSessionService({
      db: fakeDb(),
      rng: testRng(7),
      logger: createFakeLogger(),
      repos: {
        session: () => sessionRepoWith({ loadSession: async () => undefined }),
        question: () => {
          throw new Error('submitAnswer must not load the question pool');
        },
      },
    });

    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', 0),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });
});
```

Also update the file's `beforeEach` and its `rng` describe to pass the real factories,
since `repos` is required and has no default:

```ts
  service = createSessionService({
    db: t.db,
    rng: testRng(7),
    logger,
    repos: { session: createSessionRepo, question: createQuestionRepo },
  });
```

(and the same `repos` line in each of the two services the `rng` case constructs)

- [ ] **Step 13: Run it to verify it fails**

```bash
npm test --workspace apps/server -- src/services/sessions.test.ts
```

Expected: FAIL — `createSessionService` does not accept `repos`, and the fake-repo case
reaches the concretely-imported `createSessionRepo` instead of the fake.

- [ ] **Step 14: Inject the repository factories**

In `apps/server/src/services/sessions.ts`, replace the two concrete repository imports:

```ts
import type { CreateQuestionRepo } from '../repo/questions';
import type { CreateSessionRepo } from '../repo/sessions';
```

change the signature to:

```ts
export function createSessionService({
  db,
  rng,
  logger,
  repos,
}: {
  db: Db;
  rng: () => number;
  logger: Logger;
  repos: { session: CreateSessionRepo; question: CreateQuestionRepo };
}) {
```

and build the repositories from the injected factories — the handle is still bound once
per transaction, exactly as before; what changes is where the factory comes from:

```ts
        const sessionRepo = repos.session(tx);
        const questionRepo = repos.question(tx);
```

in `startSession`, and in `submitAnswer`:

```ts
        const repo = repos.session(tx);
```

- [ ] **Step 15: Pass the real factories from the composition root**

In `apps/server/src/composition.ts`, add:

```ts
import { createQuestionRepo } from './repo/questions';
import { createSessionRepo } from './repo/sessions';
```

and:

```ts
    sessions: createSessionService({
      db: io.db,
      rng: io.rng,
      logger: io.logger,
      repos: { session: createSessionRepo, question: createQuestionRepo },
    }),
```

- [ ] **Step 16: Update the last remaining service construction**

`apps/server/src/routes/sessions.test.ts` — add
`import { createQuestionRepo } from '../repo/questions';` and
`import { createSessionRepo } from '../repo/sessions';`, then:

```ts
function buildTestApp() {
  const app = new Hono();
  app.route(
    '/api/sessions',
    createSessionsRouter(
      createSessionService({
        db: t.db,
        rng: testRng(7),
        logger: createFakeLogger(),
        repos: { session: createSessionRepo, question: createQuestionRepo },
      }),
    ),
  );
  return app;
}
```

- [ ] **Step 17: Run everything**

```bash
npm run typecheck
npm test --workspace apps/server
```

Expected: both green. `grep -rn "from '../repo/" apps/server/src/services/sessions.ts`
should show only `import type` lines — the service names no concrete repository.

- [ ] **Step 18: Commit**

```bash
git add apps/server/src/db/client.ts apps/server/src/db/client.test.ts \
  apps/server/src/repo/sessions.ts apps/server/src/repo/questions.ts \
  apps/server/src/repo/sessions.test.ts apps/server/src/repo/questions.test.ts \
  apps/server/src/services/sessions.ts apps/server/src/services/sessions.test.ts \
  apps/server/src/composition.ts apps/server/src/routes/sessions.test.ts \
  apps/server/tests/support/withTx.ts
git commit -m "feat(server): separate Tx from Db and inject the repository factories

A pool handle no longer satisfies a repository's parameter, so 'one
transaction per use case' is a compile error rather than a convention, and
the service receives its repository factories instead of importing them."
```

---

### Task 7: prove the success criteria, and update the README

The criteria are checkable, not impressionistic — run them, and fix what fails rather than
reinterpreting it. The README states the DI rule for a contributor who cannot infer it from
any single file, so it names the new roots.

**Files:**
- Modify: `README.md:54-67`
- Test: the whole suite, plus the e2e suite

- [ ] **Step 1: Run every success-criteria grep**

```bash
grep -rn "console\." apps/server/src
grep -rn "Math.random" apps/server/src
grep -rn "jest.spyOn" apps/server
grep -rn "drizzle-orm" apps/server/src/app.ts
```

Expected, in order:
- `console.` only in `src/logger.ts`, `src/index.ts`, `src/db/cli.ts` — nothing under
  `services/`, `repo/`, `routes/`, nothing in `app.ts`, nothing in `db/client.ts`
- `Math.random` only in `src/index.ts`
- no output
- no output

- [ ] **Step 2: Confirm the compile-time guarantee is real**

```bash
npm run typecheck
```

Expected: clean across all workspaces — which includes `src/db/client.test.ts`'s
`@ts-expect-error` assertion. To satisfy yourself it is not vacuous, delete the
`// @ts-expect-error` line, re-run, see TS2739, and put it back.

- [ ] **Step 3: Run the full suite**

```bash
npm run db:up
npm test
```

Expected: green across workspaces. New files contribute: `config.test.ts` (3),
`index.test.ts` (1), `repo/health.test.ts` (2), `composition.test.ts` (3).

- [ ] **Step 4: Run the e2e suite**

```bash
npm run e2e
```

Expected: green. This is the only thing that exercises `main()`'s final assembly — the pool
options, the signal handlers and `serve` are covered only by running the process, which is
accepted rather than solved. Requires Docker, and Playwright browsers installed
(`npx playwright install` inside `e2e/` if this is a fresh checkout).

- [ ] **Step 5: Update the README's composition-root rule**

In `README.md`, replace rule 1 of the DI list:

```markdown
1. **Construct at the composition root.** `apps/server/src/index.ts` for the server — it
   reads its `Config` from `apps/server/src/config.ts` and hands the pieces it opens (a
   pool, a logger, `Math.random`) to `apps/server/src/composition.ts`, which is assembly
   only: no I/O, no logic. `apps/server/src/db/cli.ts` is a second server-side root, for
   the migration process. `apps/mobile/src/app/_layout.tsx` is the app's. Nowhere else
   calls a constructor.
```

and extend the closing sentence of that section:

```markdown
A contributor cannot infer this from reading any single file, so it is written down
here rather than left implicit. See the [phase 4 design doc](docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md)
for the reasoning and the violations it fixed, and the [phase 5 design doc](docs/superpowers/specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md)
for the eight it corrected afterwards.
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: name config.ts and composition.ts as the server's composition layer"
```

---

## Notes for the reviewer

Three things this phase deliberately does **not** do, so they do not read as omissions:

- **It does not move the bulk of the service and route tests off Postgres.** Phase 5
  establishes the seams and proves each one once; harvesting them is
  [phase 6](../specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md). Phase 4
  recorded "real Postgres everywhere — one driver, one code path"; replacing
  database-backed happy paths with fakes would quietly reverse that, and should be argued
  explicitly rather than drifted into.
- **It does not test `createConsoleLogger` or `createDb`'s `onError`.** The only way to
  assert on the first is `jest.spyOn(console, …)`, which this phase removes; inducing a
  real idle-client error for the second makes a fragile test. Both are proven by their call
  sites being required to pass the seam.
- **It does not test `main()`.** The `require.main` guard makes `index.ts` importable and
  `loadConfig`/`createServerDeps` carry the parts worth asserting, but the final assembly is
  covered only by the e2e suite running the process.
