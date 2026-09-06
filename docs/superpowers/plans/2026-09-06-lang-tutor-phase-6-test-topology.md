# Phase 6: Test Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `apps/server`'s test suite into a database-free `unit` bucket decided by folder and a Postgres-backed `integration` bucket, give every test database a name and a `COMMENT` that identify the test it served, and define the `postgres:17` image once in `docker-compose.yml`.

**Architecture:** Two Jest projects in a new `apps/server/jest.config.js` — `unit` matches `<rootDir>/src/**/*.test.ts` and has no `globalSetup`, `integration` matches `<rootDir>/tests/integration/**/*.test.ts` and keeps the existing harness. Database-backed test files move under `tests/integration/` with their `src/` path mirrored; two mixed files are split in half. Per-test databases are named `t_test_<slug>_<random>` and are no longer dropped on `close()` — a `^t_(test|tmpl)_` sweep at the top of `globalSetup` reclaims them, and self-heals orphaned worker templates in the same pass. CI grows from three jobs to four, with the two database jobs bringing Postgres up from `docker-compose.yml` instead of a `services:` block.

**Tech Stack:** Jest 29 (`projects`, `--selectProjects`), Babel (`@babel/preset-typescript`) for TS transform, Drizzle ORM over `pg`, npm workspaces, GitHub Actions, Docker Compose.

**Spec:** [docs/superpowers/specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md](../specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md)

## Global Constraints

- **Phase 5 has landed.** Verified against the working tree: `src/config.test.ts`, `src/composition.test.ts`, `src/index.test.ts`, `src/repo/health.test.ts`, `tests/support/fakes.ts`, `tests/support/testRng.ts` and `tests/support/withTx.ts` all exist. Do not re-derive the split from the spec's table alone — the table is the *expected* shape; the authority is the tree, and *File Structure* below records the re-derivation.
- **No new test coverage.** This phase relocates and re-buckets. The only assertions added are the ones that verify this phase's own behaviour change (database naming and metadata, in Task 1). Do not add tests for app behaviour.
- **No `jest.mock`, anywhere** (existing repo rule, README line 65). A test supplies a fake by passing one.
- **Nothing under `apps/server/src/**/*.test.ts` may import `createTestDb` or `createDb`.** This is a success criterion, checked by grep in Task 7.
- **Jest config is `.js`, not `.ts`.** A TypeScript Jest config needs `ts-node`, which is not installed, and adding a dependency to parse config is not worth it.
- **Test database names must fit Postgres's 63-byte identifier limit.**
- **Job ids in `.github/workflows/ci.yml` are free to change.** `master` has no legacy branch protection and its "protect muster" ruleset contains only `deletion`, `non_fast_forward` and `pull_request` — no `required_status_checks`. The existing comment in `ci.yml` claiming job ids are load-bearing check contexts is stale and is corrected in Task 6.
- **Commit after every task.** Each task ends green.

---

## File Structure

### Created

| File | Responsibility |
|---|---|
| `apps/server/jest.config.js` | The two Jest projects. Replaces the `"jest"` block in `package.json`; `.js` so the *why* comments can live next to the config. |
| `apps/server/tests/integration/db/client.test.ts` | Moved from `src/db/client.test.ts` |
| `apps/server/tests/integration/db/schema.test.ts` | Moved from `src/db/schema.test.ts` |
| `apps/server/tests/integration/db/seed.test.ts` | Moved from `src/db/seed.test.ts` |
| `apps/server/tests/integration/repo/questions.test.ts` | Moved from `src/repo/questions.test.ts` |
| `apps/server/tests/integration/repo/sessions.test.ts` | Moved from `src/repo/sessions.test.ts` |
| `apps/server/tests/integration/repo/health.test.ts` | Moved from `src/repo/health.test.ts` — **not in the spec's table**; see *Re-derivation* below |
| `apps/server/tests/integration/routes/sessions.test.ts` | Moved from `src/routes/sessions.test.ts` |
| `apps/server/tests/integration/composition.test.ts` | Moved from `src/composition.test.ts` |
| `apps/server/tests/integration/support/isolation.test.ts` | Moved from `tests/support/isolation.test.ts` |
| `apps/server/tests/integration/app.test.ts` | The database half split out of `src/app.test.ts` |
| `apps/server/tests/integration/services/sessions.test.ts` | The database half split out of `src/services/sessions.test.ts` |

### Modified

| File | Change |
|---|---|
| `apps/server/tests/support/dbNames.ts` | `templateName` renamed to the `t_tmpl_` prefix; new `slugify` and `testDbName` |
| `apps/server/tests/support/testDb.ts` | New name, `COMMENT ON DATABASE`, and `close()` no longer drops |
| `apps/server/tests/support/globalSetup.ts` | `^t_(test|tmpl)_` sweep before template creation |
| `apps/server/src/app.test.ts` | Reduced to the two `/health` cases |
| `apps/server/src/services/sessions.test.ts` | Reduced to the one fake-repo case |
| `apps/server/package.json` | `"jest"` block removed; `test` narrowed to the unit project; `test:integration` added |
| `package.json` (root) | `test:unit`, `test:integration`, `test:all`; `test` gains the unit-only notice |
| `.github/workflows/ci.yml` | `test` → `test-unit` + `test-integration`; `services:` blocks replaced by `docker compose up -d --wait db` |
| `README.md` | Checks and CI sections rewritten for the two buckets |

### Unchanged, and deliberately so

`apps/server/tests/integration/session-flow.test.ts` already sits correctly — it is the model this generalises. `apps/server/tests/support/{fakes,testRng,withTx}.ts` stay in `support/`: they are harness, not tests, and `support/` keeps the harness. `apps/server/tests/support/globalTeardown.ts` needs no edit beyond what `templateName`'s rename gives it for free. `docker-compose.yml` is not edited — CI starts reusing it, which is the point. `packages/core` and `apps/mobile` are out of scope; the `e2e` workspace has no `test` script, so root `--if-present` fan-out already skips it.

### Re-derivation of the split from the real tree

The spec's *File topology* table predates phase 5's final shape. Checked against the working tree, every row holds, plus these three findings:

1. **`src/repo/health.test.ts` moves too** (spec table does not list it — phase 5 created it after the spec was written). It calls `createTestDb()` in `beforeEach` and imports `createDb` directly for its dead-pool case. Both imports are forbidden under `src/` by the success criteria, so the whole file moves; it is not split, because its second case's value is precisely that it opens a real doomed connection.
2. **`src/composition.test.ts` moves whole**, as the spec anticipated ("Phase 5's `composition.test.ts` needs a real `Db` and belongs here too"). All three of its cases take `t.db`.
3. **`src/index.test.ts` stays** (spec table does not list it — also a phase-5 addition). It asserts that importing `./index` starts nothing; it touches no infrastructure, which is the whole point of the case.

Confirmed database-free and staying in `src/`: `config.test.ts`, `db/content.test.ts`, `domain/session.test.ts`, `index.test.ts`. No `logger.test.ts` exists.

---

## Task 1: Database lifecycle — naming, metadata, and the stale-database sweep

This task runs entirely under the *existing* single-project Jest config, so the whole
suite stays green throughout. Nothing moves yet.

**Files:**
- Modify: `apps/server/tests/support/dbNames.ts`
- Modify: `apps/server/tests/support/testDb.ts`
- Modify: `apps/server/tests/support/globalSetup.ts`
- Test: `apps/server/tests/support/isolation.test.ts` (moves to `tests/integration/support/` in Task 2)

**Interfaces:**
- Consumes: `createDb(connectionString, { max?, onError })` from `src/db/client.ts`, returning `{ db, pool, close }`. `db.execute<T>(sql\`…\`)` returns a node-postgres `QueryResult`, so results are read off `result.rows`.
- Produces:
  - `testDbName(testName: string, random: string): string` — `t_test_<slug>_<random>`, slug truncated so the whole identifier fits 63 bytes.
  - `templateName(workerId: string | number): string` — now returns `t_tmpl_<workerId>` (was `lang_tutor_tmpl_<workerId>`). Signature unchanged; only the returned string changes.
  - `createTestDb(): Promise<TestDb>` — `TestDb` is unchanged (`{ db, name, close }`), but `close()` now only ends the pool.

**Prerequisite for running anything in this task:** `npm run db:up` from the repo root.

- [ ] **Step 1: Write the failing test**

Append this case to `apps/server/tests/support/isolation.test.ts`, inside the existing
`describe('per-test database isolation', …)` block, after the last `it`:

```ts
  it('names the database after the test and comments it with the detail', async () => {
    // The slug is the full "describe > it" name, so it is long enough to be
    // truncated — which is the interesting half of the assertion. 63-byte limit
    // minus `t_test_` (7), the separator (1) and 8 hex chars leaves 47 for the
    // slug; this name's slug is cut to 46 because the 47th character was `_`.
    expect(current.name).toMatch(
      /^t_test_per_test_database_isolation_names_the_database_[0-9a-f]{8}$/,
    );
    expect(current.name.length).toBeLessThanOrEqual(63);

    const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });
    try {
      const result = await admin.db.execute<{ comment: string | null }>(sql`
        select shobj_description(oid, 'pg_database') as comment
        from pg_database
        where datname = ${current.name}
      `);
      const comment = result.rows[0]?.comment ?? '';
      // The untruncated name, which is what the identifier could not carry.
      expect(comment).toContain(
        'per-test database isolation names the database after the test and comments it with the detail',
      );
      expect(comment).toContain('isolation.test.ts');
      expect(comment).toContain(`worker: ${process.env.JEST_WORKER_ID ?? '1'}`);
      expect(comment).toMatch(/created: \d{4}-\d{2}-\d{2}T/);
    } finally {
      await admin.close();
    }
  });
```

Add the imports that case needs. The file's import block becomes:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../src/db/client';
import { users } from '../../src/db/schema';
import { ADMIN_URL } from './dbNames';
import { createTestDb, type TestDb } from './testDb';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w apps/server -- tests/support/isolation.test.ts -t "names the database"`

Expected: FAIL. The name assertion fails first, on the current
`lang_tutor_test_1_<uuid8>` shape:
`Expected pattern: /^t_test_per_test_database_isolation…/  Received string: "lang_tutor_test_1_a1b2c3d4"`

- [ ] **Step 3: Add the naming functions to `dbNames.ts`**

Replace the `templateName` function in `apps/server/tests/support/dbNames.ts` and add
the two new exports below it:

```ts
// One template per Jest worker, not one shared template: CREATE DATABASE locks
// its template for the duration of the copy, so a single template would make
// every worker serialise on it.
//
// The `t_tmpl_` prefix is one of the two globalSetup's sweep reclaims, so a
// template outliving the run that made it is picked up next time. Dropping
// templates by exact worker number was the leak: a 4-worker run followed by a
// 2-worker run stranded 3 and 4 permanently, because nothing ever looked for them.
export function templateName(workerId: string | number): string {
  return `t_tmpl_${workerId}`;
}

/** Postgres truncates identifiers past this silently, which would collide names. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * A test name reduced to an identifier body. Not exported — nothing outside this
 * module needs it, and `tests/support/` is matched by neither Jest project, so
 * an exported-for-testing seam here would have nowhere to be tested from.
 * Slugifying to `[a-z0-9_]` first is
 * also what makes the byte budget below a character count: every surviving
 * character is one byte, so no multi-byte test name can overrun the limit.
 */
function slugify(testName: string): string {
  return testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * `t_test_<slug>_<random>`. The slug says which test this database served; the
 * random suffix is what keeps two tests whose names share a prefix from
 * colliding after truncation. The full, untruncated name goes in the database's
 * COMMENT — see testDb.ts.
 */
export function testDbName(testName: string, random: string): string {
  const prefix = 't_test_';
  const budget = MAX_IDENTIFIER_BYTES - prefix.length - 1 - random.length;
  const slug = slugify(testName).slice(0, budget).replace(/_+$/, '') || 'unnamed';
  return `${prefix}${slug}_${random}`;
}
```

- [ ] **Step 4: Rewrite `createTestDb` to use the name, write the COMMENT, and stop dropping**

Replace the whole body of `apps/server/tests/support/testDb.ts` with:

```ts
import { randomUUID } from 'node:crypto';

import { expect } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb, type Db } from '../../src/db/client';
import { ADMIN_URL, currentWorkerId, templateName, testDbName, urlFor } from './dbNames';

export type TestDb = { db: Db; name: string; close: () => Promise<void> };

/**
 * A database of its own for one test. Nothing is shared with any other test and
 * nothing is reused: every clone starts from the template's pristine seed.
 *
 * The database outlives the test on purpose — `close()` ends the pool but does
 * not drop, so after a run `\l` shows which test each database served and `\l+`
 * shows the detail. globalSetup's sweep reclaims them on the next run.
 */
export async function createTestDb(): Promise<TestDb> {
  const worker = currentWorkerId();
  // Available inside beforeEach, not only inside the test body: jest-circus sets
  // it before the hooks for the test it is about to run. Verified, not assumed.
  const state = expect.getState();
  const testName = state.currentTestName ?? 'unnamed';
  const name = testDbName(testName, randomUUID().slice(0, 8));

  // A no-op error policy: a per-test handle lives for one test and has no logger
  // to route an idle-client error to.
  const admin = createDb(ADMIN_URL, { max: 1, onError: () => {} });

  try {
    // No `drop database if exists` first: the random suffix makes a live
    // collision impossible, and stale databases are the sweep's job, not this
    // call's — paying a round trip per test to re-check that is waste.
    await admin.db.execute(
      sql.raw(`create database ${name} template ${templateName(worker)}`),
    );

    // What the 63-byte identifier could not carry. COMMENT ON DATABASE writes to
    // a shared catalog, so it works from the maintenance connection — no second
    // connection into the new database is needed.
    const comment = [
      `test: ${testName}`,
      `file: ${state.testPath ?? 'unknown'}`,
      `worker: ${worker}`,
      `created: ${new Date().toISOString()}`,
    ].join(' | ');
    await admin.db.execute(
      sql.raw(`comment on database ${name} is '${comment.replace(/'/g, "''")}'`),
    );
  } finally {
    await admin.close();
  }

  const handle = createDb(urlFor(name), { onError: () => {} });

  return {
    db: handle.db,
    name,
    close: async () => {
      // Only the pool. Ending it is load-bearing against Postgres's
      // max_connections; dropping the database is not, and would throw away the
      // name and COMMENT this phase exists to leave behind.
      await handle.close();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w apps/server -- tests/support/isolation.test.ts`

Expected: PASS, all four cases.

- [ ] **Step 6: Add the sweep to `globalSetup.ts`**

In `apps/server/tests/support/globalSetup.ts`, insert this block between the
reachability probe's `catch` and the `try` that creates templates:

```ts
  // Reclaim everything the last run left behind — per-test databases (kept on
  // purpose so they could be inspected) and worker templates alike. Matching by
  // pattern rather than dropping templates by exact worker number is what stops
  // a 4-worker run followed by a 2-worker run from stranding t_tmpl_3 and 4.
  //
  // A regex, and both prefixes spelled out, rather than LIKE 't_%'. Two reasons,
  // and neither is style: `_` is a LIKE wildcard, so 't_%' would also sweep
  // `taxes` and `todo` — in a POSIX regex `_` is literal, so there is no escape
  // to get wrong. And naming the two prefixes keeps the blast radius to database
  // names this harness actually creates; a bare `t_` prefix match would take a
  // hand-made `t_scratch` with it. A third category of test database, if one is
  // ever added, goes in this pattern deliberately.
  const stale = await admin.db.execute<{ datname: string }>(
    sql`select datname from pg_database where datname ~ ${'^t_(test|tmpl)_'}`,
  );
  for (const { datname } of stale.rows) {
    await admin.db.execute(sql.raw(`drop database if exists ${datname} with (force)`));
  }
```

Then update the function's doc comment above it to mention the sweep:

```ts
/**
 * Sweeps the previous run's databases, then migrates and seeds one template per
 * worker. Migrating and seeding is the expensive part, so it happens once per
 * worker; each test then clones its template, which Postgres does as a copy —
 * tens of milliseconds, and parallel across workers.
 */
```

- [ ] **Step 7: Verify the sweep reclaims what it should and spares two bystanders**

What the sweep must *not* take cannot be caught by the suite, so check it by hand. The
two decoys are chosen to fail under the two tempting simplifications of this pattern:
`taxes` dies under an unescaped `LIKE 't_%'` (because `_` is a wildcard), and
`t_scratch` dies under any bare `t_` prefix match.

```bash
docker compose exec -T db psql -U postgres -c 'create database taxes'
docker compose exec -T db psql -U postgres -c 'create database t_scratch'
docker compose exec -T db psql -U postgres -c 'create database t_test_left_over_deadbeef'
docker compose exec -T db psql -U postgres -c 'create database t_tmpl_9'
npm test -w apps/server -- tests/support/isolation.test.ts
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | grep -E '^\s*(taxes|t_)' | sort
```

Expected, all four in one listing:

- `taxes` and `t_scratch` are **present** — the bystanders survived.
- `t_test_left_over_deadbeef` and `t_tmpl_9` are **absent** — both prefixes swept, and
  `t_tmpl_9` in particular is the orphaned-template bug: no run has nine workers, so
  nothing dropping templates by exact worker number would ever have reclaimed it.
- Four fresh `t_test_per_test_database_isolation_…` databases are present — kept for
  inspection, not dropped by `close()`.

Then confirm the metadata reads back, and clean up the decoys:

```bash
docker compose exec -T db psql -U postgres -c \
  "select datname, shobj_description(oid, 'pg_database') from pg_database where datname ~ '^t_test_'"
docker compose exec -T db psql -U postgres -c 'drop database taxes'
docker compose exec -T db psql -U postgres -c 'drop database t_scratch'
```

Expected: each row's description shows `test: … | file: … | worker: … | created: …`.

- [ ] **Step 8: Run the whole suite**

Run: `npm test -w apps/server`

Expected: PASS. Every existing database-backed test still works — they go through
`createTestDb`, and only the names changed.

- [ ] **Step 9: Commit**

```bash
git add apps/server/tests/support/dbNames.ts \
        apps/server/tests/support/testDb.ts \
        apps/server/tests/support/globalSetup.ts \
        apps/server/tests/support/isolation.test.ts
git commit -m "test: name test databases after the tests they serve, sweep stale ones in globalSetup"
```

---

## Task 2: Move the nine whole-file database tests under `tests/integration/`

Still under the existing single-project Jest config, whose `testMatch` is Jest's default
(`**/?(*.)+(spec|test).[jt]s?(x)`) — that already matches `tests/`, which is how
`session-flow.test.ts` runs today. So the suite stays green across this move and the
whole task is verifiable with one `npm test`.

Only import paths change. Do not edit a single assertion.

**Files:**
- Move: `apps/server/src/db/client.test.ts` → `apps/server/tests/integration/db/client.test.ts`
- Move: `apps/server/src/db/schema.test.ts` → `apps/server/tests/integration/db/schema.test.ts`
- Move: `apps/server/src/db/seed.test.ts` → `apps/server/tests/integration/db/seed.test.ts`
- Move: `apps/server/src/repo/questions.test.ts` → `apps/server/tests/integration/repo/questions.test.ts`
- Move: `apps/server/src/repo/sessions.test.ts` → `apps/server/tests/integration/repo/sessions.test.ts`
- Move: `apps/server/src/repo/health.test.ts` → `apps/server/tests/integration/repo/health.test.ts`
- Move: `apps/server/src/routes/sessions.test.ts` → `apps/server/tests/integration/routes/sessions.test.ts`
- Move: `apps/server/src/composition.test.ts` → `apps/server/tests/integration/composition.test.ts`
- Move: `apps/server/tests/support/isolation.test.ts` → `apps/server/tests/integration/support/isolation.test.ts`

**Interfaces:**
- Consumes: everything from Task 1 — `createTestDb()` returning `{ db, name, close }`, `ADMIN_URL`, `urlFor`, `templateName`.
- Produces: nothing new. The rewrite rule for every file two levels deep under `tests/integration/` is: `'./x'` → `'../../../src/<dir>/x'`, `'../<dir>/x'` → `'../../../src/<dir>/x'`, `'../../tests/support/x'` → `'../../support/x'`. Files directly in `tests/integration/` drop one `../` from each.

- [ ] **Step 1: Move the files with `git mv`**

Run from the repo root:

```bash
cd apps/server
mkdir -p tests/integration/db tests/integration/repo tests/integration/routes tests/integration/support
git mv src/db/client.test.ts        tests/integration/db/client.test.ts
git mv src/db/schema.test.ts        tests/integration/db/schema.test.ts
git mv src/db/seed.test.ts          tests/integration/db/seed.test.ts
git mv src/repo/questions.test.ts   tests/integration/repo/questions.test.ts
git mv src/repo/sessions.test.ts    tests/integration/repo/sessions.test.ts
git mv src/repo/health.test.ts      tests/integration/repo/health.test.ts
git mv src/routes/sessions.test.ts  tests/integration/routes/sessions.test.ts
git mv src/composition.test.ts      tests/integration/composition.test.ts
git mv tests/support/isolation.test.ts tests/integration/support/isolation.test.ts
cd ../..
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test -w apps/server`

Expected: FAIL — nine suites fail to run, each with `Cannot find module './client' from
'tests/integration/db/client.test.ts'` or the equivalent for its own first bad import.

- [ ] **Step 3: Rewrite the import block in each moved file**

Replace only the contiguous import block at the top of each file. Everything below it is
untouched.

`tests/integration/db/client.test.ts` — lines 1-5 become:

```ts
import { afterAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb, type Tx } from '../../../src/db/client';
import { ADMIN_URL } from '../../support/dbNames';
```

`tests/integration/db/schema.test.ts` — lines 1-9 become:

```ts
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { eq } from 'drizzle-orm';

import { createDb, type Db } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { sessions, users } from '../../../src/db/schema';
import { ADMIN_URL, urlFor } from '../../support/dbNames';
```

`tests/integration/db/seed.test.ts` — lines 1-7 become:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../support/testDb';
import { content } from '../../../src/db/content';
import { seedContent } from '../../../src/db/seed';
import {
  questions,
  termSenseTranslations,
  termVariants,
  vocabTerms,
  vocabTermSenses,
} from '../../../src/db/schema';
```

`tests/integration/repo/questions.test.ts` — lines 1-7 become:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';
import { content } from '../../../src/db/content';
import { users } from '../../../src/db/schema';
import { createQuestionRepo } from '../../../src/repo/questions';
```

`tests/integration/repo/sessions.test.ts` — lines 1-12 become:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { withTx } from '../../support/withTx';
import type { Tx } from '../../../src/db/client';
import { newSessionRecord } from '../../../src/domain/session';
import { sessions } from '../../../src/db/schema';
import { createQuestionRepo } from '../../../src/repo/questions';
import { createSessionRepo } from '../../../src/repo/sessions';
```

`tests/integration/repo/health.test.ts` — lines 1-5 become:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDb } from '../../../src/db/client';
import { createHealthRepo } from '../../../src/repo/health';
import { createTestDb, type TestDb } from '../../support/testDb';
```

Also fix the stale reference in that file's inline comment: it says "This case moves here
from app.test.ts, which after Task 4 reaches its 503 branch with a fake" — the phase-5
task numbering no longer applies. Replace that sentence with:

```ts
    // A pool pointed at a port nothing listens on: a real connection failure,
    // with no global state touched and nothing mocked. app.test.ts reaches its
    // own 503 branch with a fake ping instead, which is why it stays fast.
```

`tests/integration/routes/sessions.test.ts` — lines 1-10 become:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createTestDb, type TestDb } from '../../support/testDb';
import { createFakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import { createQuestionRepo } from '../../../src/repo/questions';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createSessionService } from '../../../src/services/sessions';
import { createSessionsRouter } from '../../../src/routes/sessions';
```

`tests/integration/composition.test.ts` — lines 1-7 become (one `../` shallower, this
file sits directly in `tests/integration/`):

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createServerDeps } from '../../src/composition';
import { createFakeLogger } from '../support/fakes';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';
```

`tests/integration/support/isolation.test.ts` — the import block written in Task 1 becomes:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import { users } from '../../../src/db/schema';
import { ADMIN_URL } from '../../support/dbNames';
import { createTestDb, type TestDb } from '../../support/testDb';
```

That file's Task 1 case asserts `expect(comment).toContain('isolation.test.ts')` — still
true after the move, because the assertion matches the basename, not the directory.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test -w apps/server`

Expected: PASS. Same test count as before the move.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w apps/server`

Expected: no output, exit 0. `tsconfig.json` already includes both `src/**/*.ts` and
`tests/**/*.ts`, so no config change is needed for the new folders.

- [ ] **Step 6: Commit**

```bash
git add -A apps/server/src apps/server/tests
git commit -m "test: move database-backed suites under tests/integration/ with mirrored paths"
```

---

## Task 3: Split `app.test.ts`

Two `describe` blocks, two buckets. `GET /health` already runs on a fake `ping` and a
throwing `sessions` stub — phase 5's work — so it needs nothing but to be left behind.
The one case that assembles production deps against a real database leaves.

**Files:**
- Modify: `apps/server/src/app.test.ts` (reduced to the `/health` describe)
- Create: `apps/server/tests/integration/app.test.ts`

**Interfaces:**
- Consumes: `createApp(deps: AppDeps)` from `src/app.ts`; `createServerDeps({ db, logger, rng }): AppDeps` and `type AppDeps` from `src/composition.ts`; `type SessionService` from `src/services/sessions.ts`; `createFakeLogger(): FakeLogger` from `tests/support/fakes.ts`; `testRng(seed: number): () => number` from `tests/support/testRng.ts`; `createTestDb()` from Task 1.
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the integration half as a new file**

Create `apps/server/tests/integration/app.test.ts` with exactly this content — it is the
`describe('the app as production assembles it', …)` block lifted verbatim, with the
imports it actually needs and a note pointing back at its other half:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';
import { createServerDeps } from '../../src/composition';
import { createFakeLogger } from '../support/fakes';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';

// The other half of this file's tests is src/app.test.ts, which covers /health
// against a fake ping and needs no database. This half keeps a real one on
// purpose: it asserts something about the app production actually assembles, so
// faking the service would assert nothing.
describe('the app as production assembles it', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('does not create a session as a side effect of a health check', async () => {
    const app = createApp(
      createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
    );
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

- [ ] **Step 2: Run both halves to verify the case now runs twice**

Run: `npm test -w apps/server -- app.test.ts`

Expected: PASS, but **3 tests in 2 suites** — the side-effect case is duplicated,
because the old copy is still in `src/app.test.ts`. That duplication is the proof the
new file is wired up correctly before the old one is cut.

- [ ] **Step 3: Reduce `src/app.test.ts` to its fast half**

Replace the whole of `apps/server/src/app.test.ts` with:

```ts
import { describe, expect, it } from '@jest/globals';

import { createApp } from './app';
import type { AppDeps } from './composition';
import type { SessionService } from './services/sessions';
import { createFakeLogger } from '../tests/support/fakes';

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

// No database: the health route's two branches are both reachable with a fake.
// The app's one database-backed case lives in tests/integration/app.test.ts.
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
```

- [ ] **Step 4: Run both halves to verify the duplication is gone**

Run: `npm test -w apps/server -- app.test.ts`

Expected: PASS, **3 tests in 2 suites** — but now they are the two `/health` cases plus
the one side-effect case, with nothing repeated. Confirm by reading the case names in
the output.

- [ ] **Step 5: Confirm the fast half really is database-free**

```bash
npm run db:down
cd apps/server
npx jest --config '{"testEnvironment":"node","testMatch":["<rootDir>/src/app.test.ts"]}'
cd ../..
npm run db:up
```

Expected: PASS with Docker stopped. A one-off ad-hoc config, because Task 5 has not
created `jest.config.js` yet — the point is only to prove this file needs nothing. Run
it from `apps/server`, not the repo root: an inline `--config` has no file to anchor
`rootDir` to, so it uses the working directory, and that is also where Babel looks for
the `babel.config.js` that transforms the TypeScript.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/app.test.ts apps/server/tests/integration/app.test.ts
git commit -m "test: split app.test.ts into a fake-ping unit half and a database half"
```

---

## Task 4: Split `services/sessions.test.ts`

Nine database-backed cases plus the `rng` determinism case leave; the one case that
already runs on fake repository factories stays. Its inline comment currently says
moving it off Postgres is "phase 6's job, not this phase's" — this is that job, so the
comment is rewritten.

**Files:**
- Modify: `apps/server/src/services/sessions.test.ts` (reduced to the `repos` describe)
- Create: `apps/server/tests/integration/services/sessions.test.ts`

**Interfaces:**
- Consumes: `createSessionService({ db, rng, logger, repos })` and `type SessionService` from `src/services/sessions.ts`; `type SessionRepo` and `createSessionRepo` from `src/repo/sessions.ts`; `createQuestionRepo` from `src/repo/questions.ts`; `type Db`, `type Tx` from `src/db/client.ts`; `OptionOutOfRange`, `QuestionDesynced`, `SessionNotFound` from `src/errors.ts`; `SESSION_LENGTH` from `@lang-tutor/core/domain`; `createFakeLogger`/`type FakeLogger`, `testRng`, `createTestDb`/`type TestDb` from `tests/support/`.
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the integration half as a new file**

Create the directory and the file — `tests/integration/services/` does not exist yet,
Task 2 created only `db/`, `repo/`, `routes/` and `support/`:

```bash
mkdir -p apps/server/tests/integration/services
```

Then write `apps/server/tests/integration/services/sessions.test.ts`. Its body is the
`startSession`, `submitAnswer` and `rng` describes lifted verbatim from
`src/services/sessions.test.ts`, together with the file-level `beforeEach`/`afterEach`
and the `let` bindings they use:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import { createTestDb, type TestDb } from '../../support/testDb';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../../../src/errors';
import { createQuestionRepo } from '../../../src/repo/questions';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createSessionService, type SessionService } from '../../../src/services/sessions';

// The other half of this file's tests is src/services/sessions.test.ts, which
// covers the cases the repository-factory seam makes reachable without Postgres.

let t: TestDb;
let logger: FakeLogger;
let service: SessionService;

beforeEach(async () => {
  t = await createTestDb();
  logger = createFakeLogger();
  service = createSessionService({
    db: t.db,
    rng: testRng(7),
    logger,
    repos: { session: createSessionRepo, question: createQuestionRepo },
  });
});

afterEach(async () => {
  await t.close();
});

describe('startSession', () => {
  it('creates a user on first sight and returns a ten-question session', async () => {
    const { sessionId, record } = await service.startSession('u1');
    expect(typeof sessionId).toBe('string');
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
    expect(record.complete).toBe(false);
  });

  it('gives the same learner a second, distinct session', async () => {
    const first = await service.startSession('u1');
    const second = await service.startSession('u1');
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe('submitAnswer', () => {
  it('advances on a fresh answer', async () => {
    const { sessionId, record } = await service.startSession('u1');
    const question = record.questions[0];
    const after = await service.submitAnswer(sessionId, question.id, question.correct_option);
    expect(after.answers).toHaveLength(1);
    expect(after.answers[0]).toEqual({
      question_id: question.id,
      is_correct: true,
      answer_string: question.options[question.correct_option],
    });
    expect(after.complete).toBe(false);
  });

  it('replays a retried answer without double-counting it', async () => {
    const { sessionId, record } = await service.startSession('u1');
    const question = record.questions[0];
    await service.submitAnswer(sessionId, question.id, question.correct_option);
    const retry = await service.submitAnswer(sessionId, question.id, question.correct_option);
    expect(retry.answers).toHaveLength(1);
  });

  it('throws SessionNotFound for an unknown session', async () => {
    await expect(
      service.submitAnswer('00000000-0000-0000-0000-000000000000', 'q-window', 0),
    ).rejects.toBeInstanceOf(SessionNotFound);
  });

  it('throws QuestionDesynced for a question that is not current', async () => {
    const { sessionId, record } = await service.startSession('u1');
    await expect(
      service.submitAnswer(sessionId, record.questions[3].id, 0),
    ).rejects.toBeInstanceOf(QuestionDesynced);
  });

  it('throws OptionOutOfRange for an option index past the last option', async () => {
    const { sessionId, record } = await service.startSession('u1');
    await expect(
      service.submitAnswer(sessionId, record.questions[0].id, 99),
    ).rejects.toBeInstanceOf(OptionOutOfRange);
  });

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
});

describe('rng', () => {
  it('draws the same ten questions for two services sharing a seed', async () => {
    const first = createSessionService({
      db: t.db,
      rng: testRng(7),
      logger: createFakeLogger(),
      repos: { session: createSessionRepo, question: createQuestionRepo },
    });
    const second = createSessionService({
      db: t.db,
      rng: testRng(7),
      logger: createFakeLogger(),
      repos: { session: createSessionRepo, question: createQuestionRepo },
    });

    const a = await first.startSession('u1');
    const b = await second.startSession('u2');

    expect(b.record.questions.map((question) => question.id)).toEqual(
      a.record.questions.map((question) => question.id),
    );
  });
});
```

- [ ] **Step 2: Run both halves to verify the cases now run twice**

Run: `npm test -w apps/server -- services/sessions.test.ts`

Expected: PASS, **21 tests in 2 suites** — the ten database-backed cases duplicated,
plus the one fake-repo case that exists only in the `src/` copy.

- [ ] **Step 3: Reduce `src/services/sessions.test.ts` to its fast half**

Replace the whole of `apps/server/src/services/sessions.test.ts` with:

```ts
import { describe, expect, it } from '@jest/globals';

import { createFakeLogger } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { Db, Tx } from '../db/client';
import { SessionNotFound } from '../errors';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

// The repository factories are the seam, so a handle that only knows how to run
// a transaction callback is enough — no Postgres, no clone, no globalSetup. The
// service's database-backed cases live in
// tests/integration/services/sessions.test.ts.
describe('repos', () => {
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

- [ ] **Step 4: Run both halves to verify the duplication is gone**

Run: `npm test -w apps/server -- services/sessions.test.ts`

Expected: PASS, **11 tests in 2 suites** — ten in the integration half, one in the unit
half.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test -w apps/server && npm run typecheck -w apps/server`

Expected: both PASS. The total case count must be unchanged from before Task 3 — no case
was added or lost, only relocated.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/sessions.test.ts \
        apps/server/tests/integration/services/sessions.test.ts
git commit -m "test: split services/sessions.test.ts into fake-repo and database halves"
```

---

## Task 5: Two Jest projects, and the scripts that select them

The buckets are correct now, so the config can enforce them. This is the task that
delivers the phase's headline: `npm run db:down && npm test` passes.

**Files:**
- Create: `apps/server/jest.config.js`
- Modify: `apps/server/package.json` (remove the `"jest"` block; `test` narrows; add `test:integration`)
- Modify: `package.json` (root — `test:unit`, `test:integration`, `test:all`, and the notice on `test`)

**Interfaces:**
- Consumes: the folder layout Tasks 2-4 produced. `<rootDir>` in an inline `projects` entry inherits the outer `rootDir`, which is the directory holding `jest.config.js` — `apps/server`. That is also where `babel.config.js` sits, so the existing Babel TS transform keeps working for both projects with no extra configuration.
- Produces: the project names `unit` and `integration`, selected with `jest --selectProjects <name>`. Any later task or script that wants one bucket uses those names.

- [ ] **Step 1: Run the phase's headline check to verify it fails**

```bash
npm run db:down
npm test
```

Expected: FAIL. `apps/server`'s single-project config still has a `globalSetup`, so the
run dies in setup with ``Postgres unreachable at postgres://…/postgres — Run `npm run
db:up` first``. That message is the preflight working as designed; the failure is that
it fires at all for a unit run.

- [ ] **Step 2: Create `apps/server/jest.config.js`**

```js
// A .js config rather than a JSON block in package.json or a .ts file: the two
// projects need comments to explain *why* they differ, JSON cannot carry them,
// and a TypeScript config would need ts-node, which is not installed — adding a
// dependency just to parse config is not worth it.
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      // Folder decides the bucket. No allowlist for anyone to remember to update.
      testMatch: ['<rootDir>/src/**/*.test.ts'],
      restoreMocks: true,
      resetMocks: true,
      // No globalSetup: nothing here may touch Postgres. That is the whole point,
      // and CI's test-unit job (which has no database at all) enforces it.
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      globalSetup: '<rootDir>/tests/support/globalSetup.ts',
      globalTeardown: '<rootDir>/tests/support/globalTeardown.ts',
      restoreMocks: true,
      resetMocks: true,
      testTimeout: 30000, // a clone plus a pool connection is slower than a pure unit test
    },
  ],
};
```

- [ ] **Step 3: Rewrite `apps/server/package.json`'s scripts and delete its `"jest"` block**

Delete the entire top-level `"jest": { … }` object (it would otherwise conflict with
`jest.config.js`, and Jest errors on having both). Change the `test` script and add
`test:integration`, so the `"scripts"` object reads:

```json
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "jest --selectProjects unit",
    "test:integration": "jest --selectProjects integration",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:check": "drizzle-kit check",
    "db:migrate": "tsx src/db/cli.ts"
  }
```

- [ ] **Step 4: Verify the unit project runs with Docker stopped**

```bash
npm run db:down
npm test -w apps/server
```

Expected: PASS. Six suites — `src/app.test.ts`, `src/config.test.ts`,
`src/db/content.test.ts`, `src/domain/session.test.ts`, `src/index.test.ts`,
`src/services/sessions.test.ts` — and no `globalSetup` line in the output.

- [ ] **Step 5: Verify the integration project still gives the readable preflight when the database is down**

Run (still with Docker stopped): `npm run test:integration -w apps/server`

Expected: FAIL with ``Postgres unreachable at postgres://postgres:postgres@localhost:5432/postgres`` followed by ``Run `npm run db:up` first (requires Docker).`` — not a bare
`ECONNREFUSED` stack.

Then bring it up and run it for real:

```bash
npm run db:up
npm run test:integration -w apps/server
```

Expected: PASS. Twelve suites, all under `tests/integration/`.

- [ ] **Step 6: Add the root fan-out scripts**

In the root `package.json`, replace the single `"test"` line with these four. Order them
as written — `test` first, so the command people type is the first one they read:

```json
    "test": "npm run test:unit && echo '' && echo 'Note: unit tests only. Run npm run test:all before pushing - database-backed tests did not run.'",
    "test:unit": "npm test --workspaces --if-present",
    "test:integration": "npm run test:integration --workspaces --if-present",
    "test:all": "npm run test:unit && npm run test:integration",
```

Three details that look like fussiness and are not:

- The notice uses a second `echo ''` rather than a leading `\n`: bash's builtin `echo`
  prints `\n` literally while zsh and `sh` interpret it, so the escape is not portable
  and the extra `echo` is.
- It does not quote `npm run test:all` inside the message. Nested single quotes inside a
  single-quoted script string survive only by accidental word concatenation.
- `test:all` calls `test:unit`, not `test`, so the "unit only" notice does not print in
  the middle of a full run.

`test:unit` invokes each workspace's own `test` script — which for `apps/server` is now
the unit project, and for `mobile` and `core` is everything they have, already fast. The
`e2e` workspace has no `test` script at all, so `--if-present` skips it. No workspace is
special-cased.

- [ ] **Step 7: Verify the headline check now passes**

```bash
npm run db:down
npm test
```

Expected: PASS across all three workspaces with Docker stopped, ending with the blank
line and the notice.

- [ ] **Step 8: Verify a unit run creates zero databases**

```bash
npm run db:up
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | sort > /tmp/before.txt
npm test
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "IDENTICAL"
```

Expected: `IDENTICAL`. This is the structural version of "unit tests are fast" — a
stopwatch assertion would be brittle, a database count is not.

- [ ] **Step 9: Verify a second integration run sweeps the first run's databases**

```bash
npm run test:integration
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | grep -c 't_test_'
npm run test:integration
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | grep -c 't_test_'
```

Expected: the same count both times — the second run swept the first run's databases
before creating its own. Not a growing number.

- [ ] **Step 10: Verify the template-orphan bug is fixed**

```bash
npm run test:integration -w apps/server -- --maxWorkers=4
npm run test:integration -w apps/server -- --maxWorkers=2
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | grep 't_tmpl_' || echo "no templates stranded"
```

Expected: `no templates stranded`. Before this sweep, the 2-worker run would have
left `t_tmpl_3` and `t_tmpl_4` behind permanently, because `globalTeardown` drops
templates by exact worker number.

- [ ] **Step 11: Run everything**

Run: `npm run test:all && npm run typecheck`

Expected: both PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/server/jest.config.js apps/server/package.json package.json
git commit -m "test: split apps/server into unit and integration Jest projects"
```

---

## Task 6: CI — four jobs, one Postgres definition

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the root scripts from Task 5 (`npm test`, `npm run test:integration`) and the `db` service already defined in `docker-compose.yml` with its `pg_isready` healthcheck.
- Produces: the check contexts `typecheck`, `test-unit`, `test-integration`, `e2e` — the four names a `master` ruleset would list. Task 7 documents them in the README.

- [ ] **Step 1: Correct the stale comment above `jobs:`**

`.github/workflows/ci.yml` line 21 currently reads:

```yaml
  # Job IDs are the branch-protection check contexts. Do not add `name:` keys.
```

It is half stale — the ids *are* the contexts, but the instruction it implies (that the
`test` id is frozen) is not true. Replace it with:

```yaml
  # Job IDs are the branch-protection check contexts, so keep them stable once a
  # ruleset lists them — and do not add `name:` keys, which would rename the
  # context out from under it. `master`'s ruleset currently requires no status
  # checks at all, which is why renaming `test` below was free. See the README.
```

- [ ] **Step 2: Replace the `test` job with `test-unit` and `test-integration`**

Delete the whole `test:` job (lines 35-77, from `  test:` through `      - run: npm test`)
and put these two in its place:

```yaml
  # No database, deliberately. A "unit" test that secretly needs Postgres fails
  # here, loudly, instead of passing because a database happened to be reachable.
  # This is what makes the src/ vs tests/integration/ boundary a fact rather than
  # a convention.
  test-unit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      # Root install: the root package.json owns resolution for all four workspaces.
      - run: npm ci
      - run: npm test

  test-integration:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      # Must come after checkout: it reads docker-compose.yml from the tree. The
      # `services:` block this replaces duplicated the postgres:17 image and its
      # healthcheck; `--wait` blocks on the compose healthcheck exactly as that
      # block's `options: --health-cmd` did.
      - run: docker compose up -d --wait db
      # The drift steps need no database — drizzle-kit generate and check never
      # connect — but they belong with the other database concerns rather than
      # muddying test-unit's single purpose.
      #
      # db:check only validates that the migrations folder's own snapshot/journal
      # are internally consistent (e.g. two branches both generating a migration
      # against the same prior state) — it never compares schema.ts against the
      # committed migrations, so an edited schema.ts with no `generate` run passes
      # it silently. Regenerating and diffing is what actually catches that drift:
      # if schema.ts and the migrations folder disagree, `generate` produces a new
      # file and/or rewrites the journal, and the diff step fails the build.
      - run: npm run db:check -w apps/server
      - run: npm run db:generate -w apps/server
      - name: Fail if schema.ts and the committed migrations have drifted
        run: |
          # git diff alone would miss a brand-new, still-untracked migration file;
          # git status --porcelain catches both a rewritten journal/snapshot and a
          # new file that generate produced but nobody committed.
          if [ -n "$(git status --porcelain apps/server/src/db/migrations)" ]; then
            echo "schema.ts and the committed migrations have drifted." >&2
            echo "Run 'npm run db:generate -w apps/server' and commit the result." >&2
            git status --porcelain apps/server/src/db/migrations >&2
            exit 1
          fi
      - run: npm run test:integration
```

- [ ] **Step 3: Replace the `e2e` job's `services:` block with a compose step**

In the `e2e` job, delete these lines:

```yaml
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
```

and add a compose step immediately after that job's `- run: npm ci`:

```yaml
      - run: docker compose up -d --wait db
```

Everything else in the `e2e` job — the Playwright version resolution, the browser cache,
`--with-deps`, the trace upload — is unchanged.

- [ ] **Step 4: Verify no `services:` block survives**

Run: `grep -n "services:" .github/workflows/ci.yml`

Expected: no output, exit 1. (`docker-compose.yml` still has its own `services:` key —
that is the single definition this phase leaves behind, and it is a different file.)

Also confirm the image is now defined exactly once across both files:

Run: `grep -rn "postgres:17" .github/workflows/ci.yml docker-compose.yml`

Expected: one hit, in `docker-compose.yml`.

- [ ] **Step 5: Verify the workflow parses**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/^  test-unit:$/m.test(y)||!/^  test-integration:$/m.test(y)) throw new Error('job ids missing'); console.log('job ids present')"`

Expected: `job ids present`.

If `actionlint` is available (`brew install actionlint`), also run `actionlint` and
expect no output. If it is not installed, skip it rather than installing it — Step 7's
push is the real check.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: split test into test-unit and test-integration, define postgres once in compose"
```

- [ ] **Step 7: Push and confirm all four jobs go green**

```bash
git push -u origin phase-6-test-topology
gh run watch
```

Expected: `typecheck`, `test-unit`, `test-integration` and `e2e` all pass. `test-unit`
passing is the load-bearing one — it proves no test under `src/` needs a database, on a
runner where none exists.

---

## Task 7: README, and the full success-criteria sweep

The README is the third of the three guards on this phase's sharpest risk — a default
`npm test` that goes green without running the database-backed tests, on a repository
where CI cannot block a merge. The other two are the notice `npm test` prints and the
fact that both CI jobs run on every push.

**Files:**
- Modify: `README.md` — the `## Checks` section (currently lines 137-148) and the `## Continuous integration` section (currently lines 150-178)

**Interfaces:**
- Consumes: the script names from Task 5 (`test`, `test:unit`, `test:integration`, `test:all`) and the job ids from Task 6 (`typecheck`, `test-unit`, `test-integration`, `e2e`). Every name written here must match those exactly.
- Produces: nothing code depends on.

- [ ] **Step 1: Replace the `## Checks` section**

Replace everything from the `## Checks` heading up to (not including) the
`## Continuous integration` heading with:

````markdown
## Checks

```bash
npm test            # unit tests only — no Docker, no database, whole monorepo
npm run db:up       # docker compose up -d --wait db  (requires Docker)
npm run test:integration  # apps/server's database-backed tests; needs db:up
npm run test:all    # both buckets — run this before pushing
npm run typecheck   # every workspace
```

**Run `npm run test:all` before you push.** Bare `npm test` is unit-only, so it can go
green while every database-backed test sat out; it prints a reminder saying so. CI runs
both buckets on every push either way, but no ruleset on `master` requires those checks
yet, so nothing structurally stops a merge that breaks them — see *Continuous
integration*.

Which bucket a test is in is decided by the folder its file is in, not by an allowlist:

| Folder | Bucket | Rule |
|---|---|---|
| `apps/server/src/**/*.test.ts` | `unit` | Touches no infrastructure. No `globalSetup`. Importing `createTestDb` or `createDb` here is the bug. |
| `apps/server/tests/integration/**/*.test.ts` | `integration` | Needs real Postgres. Path mirrors the `src/` path of what it tests. |
| `apps/server/tests/support/**` | neither | The harness itself — `globalSetup`, `globalTeardown`, `testDb`, `dbNames`, and the fakes. Not matched by either project. |

Two files are deliberately split across both buckets — `app.test.ts` and
`services/sessions.test.ts` — because sending a whole mixed file to `integration` creates
a gravity well: new fast tests get written into the already-slow file out of convenience
and the fast bucket never grows. The mirrored paths are what make the other half
findable. The cost is real: opening `src/app.test.ts` shows you half the app's tests.

`npm run test:integration` with the database down fails with a readable instruction
pointing at `npm run db:up`, not a bare `ECONNREFUSED` — see `globalSetup.ts`.

### Inspecting what a test ran against

Each database-backed test gets its own database, cloned from a per-worker template that
`globalSetup` migrates and seeds once. They are **not** dropped when the test ends —
`close()` only ends the connection pool — so after a run you can look at exactly what a
test left behind:

```bash
docker compose exec -T db psql -U postgres -c '\l+' | grep t_test_
```

The name is `t_test_<slug of the test name>_<random>`; the `COMMENT` carries what the
63-byte identifier could not — the full untruncated test name, the file, the Jest worker
id and a creation timestamp.

Nothing accumulates: before `globalSetup` rebuilds the templates it drops every database
matching `^t_(test|tmpl)_`, so the *next* integration run reclaims the last one's. That
the sweep covers `t_tmpl_<worker>` too is what stops a 4-worker run followed by a
2-worker run from stranding templates 3 and 4 forever — they used to be dropped by exact
worker number, so nothing ever went looking for them.

The pattern names both prefixes rather than matching `t_` broadly, so a database of your
own is safe from it as long as it is not called `t_test_…` or `t_tmpl_…`.

A unit run creates no databases at all, which is the property CI's `test-unit` job
enforces.
````

- [ ] **Step 2: Replace the `## Continuous integration` section**

Replace everything from the `## Continuous integration` heading up to (not including)
the `## End-to-end test` heading with:

```markdown
## Continuous integration

Every push, on every branch, runs four parallel jobs on GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

| Job | Database | Runs | Roughly |
|---|---|---|---|
| `typecheck` | none | `npm run typecheck` — `tsc` reads `db/schema.ts` directly | 1 min |
| `test-unit` | **none, deliberately** | `npm test` | 1 min |
| `test-integration` | `docker compose up -d --wait db` | `npm run db:check -w apps/server` (migration-history consistency), then `npm run db:generate -w apps/server` followed by a `git status` check that fails if it produced any change (schema↔migrations drift), then `npm run test:integration` | 1-2 min |
| `e2e` | `docker compose up -d --wait db` | `npm run e2e` — the Playwright suite described below | 4-5 min |

`test-unit` has no database available at all. That is the point: it *proves* the
unit/integration boundary rather than assuming it, because a "unit" test that secretly
needs Postgres fails there loudly instead of passing because a database happened to be
reachable.

The two jobs that need a database bring it up from `docker-compose.yml` rather than
declaring a `services:` container, so the `postgres:17` image and its healthcheck are
defined in exactly one place in the repo. `docker compose up -d --wait db` has to come
after `actions/checkout` — it reads the compose file out of the tree — and `--wait`
blocks on the healthcheck, which is what the removed `services:` block's
`options: --health-cmd` was doing.

The jobs are independent, so a red `e2e` beside a green `typecheck` and `test-unit`
tells you the app broke, not that the code stopped compiling. A failing `e2e` run uploads
a Playwright trace as a `playwright-traces` artifact; download it and open it with
`npx playwright show-trace` rather than trying to reproduce the failure locally.

Pushing again cancels the previous run for that branch.

### Nothing gates a merge yet

These four context names — `typecheck`, `test-unit`, `test-integration`, `e2e` — are what
a branch-protection rule on `master` must list. **No such rule exists.** `master` has no
legacy branch protection, and its active ruleset ("protect muster") contains only
`deletion`, `non_fast_forward` and `pull_request` — no `required_status_checks`. A pull
request with a failing `test-integration` job is mergeable today.

That matters more now that bare `npm test` is unit-only: the two facts are individually
survivable and jointly leave no structural point at which a change that breaks the
database-backed tests is stopped before it reaches `master`. Fixing it is one ruleset
edit; it is a repository setting rather than a change to this repo, which is the only
reason it is not in the diff that introduced this section.

One caveat before making them required: a pull request from a **fork** produces no check
runs, because `on: push` only fires for branches in this repository. Requiring these
contexts would leave such a PR permanently unmergeable. Add a `pull_request` trigger to
the workflow first if outside contributions ever become real.
```

- [ ] **Step 3: Fix the two stale `npm test` references elsewhere in the README**

The `## End-to-end test` section says:

```markdown
`npm test` deliberately does **not** run this — the workspace's script is named `e2e`, not
`test`, to keep the unit loop fast.
```

Still true, but now under-explains. Replace it with:

```markdown
`npm test` and `npm run test:all` deliberately do **not** run this — the workspace's
script is named `e2e`, not `test`, so neither the root fan-out nor `--if-present` picks
it up, and the unit loop stays fast.
```

Then check the DI-rules list near the top (rule 5, "No `jest.mock`, anywhere") still
reads correctly — it does, and needs no edit. Confirm nothing else in the file promises
that `npm test` needs Docker:

Run: `grep -n "npm test" README.md`

Expected: every hit is one of the lines this task wrote. In particular, no surviving line
says `npm test` requires the database to be up.

- [ ] **Step 4: Add the phase 6 design-doc link**

At the end of the `## Checks` section's first paragraph block, the phase docs are linked
from the DI-rules section. Append this line to the end of the new `### Inspecting what a
test ran against` subsection:

```markdown
Design and plan for this layout:
[design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md) ·
[plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-6-test-topology.md)
```

- [ ] **Step 5: Walk the spec's success criteria, one command at a time**

Run each and confirm the expected result. Do not batch them — a single combined command
hides which one failed.

```bash
# 1. The phase in one line.
npm run db:down && npm test
```
Expected: PASS, with no Docker running, ending in the unit-only notice.

```bash
# 2. The preflight is still readable.
npm run test:integration
```
Expected: FAIL with ``Run `npm run db:up` first (requires Docker).``

```bash
# 3. No unit test reaches for a database.
npm run db:up
grep -rn "createTestDb\|createDb" apps/server/src --include='*.test.ts'
```
Expected: no output, exit 1.

```bash
# 4. A unit run creates zero databases.
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | sort > /tmp/before.txt
npm test
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "IDENTICAL"
```
Expected: `IDENTICAL`.

```bash
# 5. Databases name and describe the tests they served.
npm run test:integration
docker compose exec -T db psql -U postgres -c "select datname, shobj_description(oid, 'pg_database') from pg_database where datname ~ '^t_test_' limit 5"
```
Expected: names like `t_test_startsession_creates_a_user_on_first_sight_and_re_a1b2c3d4`,
each with a description reading `test: … | file: … | worker: … | created: …`.

```bash
# 6. No accumulation across runs.
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | grep -c 't_test_'
npm run test:integration
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | grep -c 't_test_'
```
Expected: the same number twice.

```bash
# 7. No templates stranded by a narrower second run.
npm run test:integration -w apps/server -- --maxWorkers=4
npm run test:integration -w apps/server -- --maxWorkers=2
docker compose exec -T db psql -U postgres -lqt | cut -d'|' -f1 | grep 't_tmpl_' || echo "none stranded"
```
Expected: `none stranded`.

```bash
# 8. The Postgres definition is not duplicated.
grep -n "services:" .github/workflows/ci.yml
```
Expected: no output, exit 1.

```bash
# 9. Everything green.
npm run typecheck && npm run test:all && npm run e2e
```
Expected: all three PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document the unit/integration split, database inspection, and the four CI jobs"
```

- [ ] **Step 7: Push and open the pull request**

```bash
git push
gh pr create --fill
```

Then watch the run: `gh run watch`. All four jobs must be green before the PR is
reviewed.

- [ ] **Step 8: Raise the ruleset change with the repository owner**

Not a code change, so not part of this diff — but it is the mitigation for this phase's
sharpest risk, and the spec says it should land alongside rather than after. Ask for
`master`'s "protect muster" ruleset to add `required_status_checks` listing `typecheck`,
`test-unit`, `test-integration` and `e2e`, and mention the fork caveat the README
records. Note it in the pull request description so it is not lost.

---

## Notes for the reviewer

**What must not have changed.** No assertion in any test. Compare case counts before and
after: `git stash && npm run test:all 2>&1 | grep "Tests:"` against the same on the
branch. Tasks 3 and 4 each deliberately produce a step where cases run twice — that
duplication is the evidence the new file works before the old copy is cut, and it must
be gone by the end of the task.

**Where the plan deviates from the spec.** Four places. Three are in *Re-derivation*
above and were forced by phase 5 landing after the spec was written:
`src/repo/health.test.ts` moves (the spec's table predates it), `src/index.test.ts`
stays, and `src/composition.test.ts` moves whole. The spec anticipated exactly this —
"treat this table as the *expected* shape, not the authority."

The fourth is a deliberate amendment, agreed before implementation started and recorded
in the spec's own *Amendments* section: **the sweep matches `^t_(test|tmpl)_`, not
`t_%`.** The spec weighed only two options — `t_test_%`, which misses the templates and
so does not fix the orphan bug, against `t_%`, which catches them along with everything
else `t_`-prefixed and is listed under the spec's Risks for exactly that reason. Naming
both prefixes is the third option neither considered: it self-heals orphaned templates
just as well, and its blast radius is limited to names this harness creates. It also
retires the risk entry rather than accepting it. Review the plan against that amended
decision, not against the original decision-table row.

**The two subtle bits.** First, `expect.getState().currentTestName` is read inside
`beforeEach`, not inside a test body; jest-circus populates it before the hooks for the
test it is about to run, which was verified against Jest 29 rather than assumed. Second,
the sweep is a POSIX regex naming both prefixes — `^t_(test|tmpl)_` — and not
`LIKE 't_%'`. Do not "simplify" it back: `_` is a LIKE wildcard, so `'t_%'` sweeps
`taxes` and `todo` as well, and even a correctly escaped `t\_%` takes any hand-made
`t_`-prefixed database with it. Task 1 Step 7 plants a decoy for each of those two
failure modes, because the suite cannot catch either.
