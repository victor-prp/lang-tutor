# ADR 0007: Background jobs run on pg-boss, enqueued only inside a transaction

- **Status:** Accepted
- **Date:** 2026-10-05
- **Source:** [phase 19 design](../superpowers/specs/2026-10-05-lang-tutor-phase-19-next-enrollment-session-design.md) — §1 for the pg-boss verdict and its switch signals, §3 for the port, the lifecycle and the dead-letter path

## Decision

Background work runs on pg-boss, in schema `pgboss` of the app's own database. A job is
enqueued in the same transaction as the write that makes it necessary, so the two commit or
roll back together.

```
  index.ts        new PgBoss, start() ──────────────┐ passed down, never re-created
        │                                           ▼
  composition.ts  boss ──► repo/jobs.ts  enqueue(tx, …)   the ONLY boss.send
        │                        ▲
        │                        │ tx-bound
        ▼                  services/  one transaction per use case
  worker.ts       boss.work(queue, handler)  ◄── the ONLY .work(
                  handler ──► one service use case, nothing else

  db/jobs.ts      installJobs: schema + queues, run by runMigrations
```

pg-boss's schema and queues are installed by `runMigrations`, through `db/jobs.ts`. Jobs are
enqueued only through `repo/jobs.ts`'s tx-bound `enqueue`. Handlers are registered only in
`worker.ts`, each calling one service use case. The boss is constructed and started in
`index.ts` and passed down.

## Rules

| # | Subject | May | Must not |
|---|---|---|---|
| R1 | `pg-boss` import | `src/index.ts`, `src/composition.ts`, `src/worker.ts`, `src/db/jobs.ts`, `src/repo/jobs.ts` | any other file; `new PgBoss` anywhere but `src/index.ts` and `src/db/jobs.ts` |
| R2 | enqueue | `src/repo/jobs.ts` | `boss.send(`, `boss.insert(`, `boss.sendAfter(`, `boss.sendThrottled(`, `boss.sendDebounced(` or `boss.flow(` anywhere else |
| R3 | handler registration | `src/worker.ts` | `.work(` anywhere else |

## Rules that are not import rules

- **R4 — A handler in `worker.ts` calls one service method and nothing else.** Not
  greppable: a handler that also reads a row looks the same as one that does not. Enforced
  by review, like [ADR 0001](adr-0001-layered-architecture.md) R9.

## How to detect a violation

`npm run lint:arch` runs the commands below alongside the other ADRs';
`scripts/check-adr-0007-background-jobs.sh` mirrors this block verbatim. Each command must
print nothing.

```bash
# R1 — pg-boss is imported only by the five files that own it
grep -rnE "from 'pg-boss'" apps/server/src --include='*.ts' \
  | grep -vE '^apps/server/src/(index|composition|worker)\.ts:|^apps/server/src/(db|repo)/jobs\.ts:'

# R1 — new PgBoss only in index.ts and db/jobs.ts
grep -rn "new PgBoss" apps/server/src --include='*.ts' \
  | grep -vE '^apps/server/src/index\.ts:|^apps/server/src/db/jobs\.ts:'

# R2 — jobs are enqueued only through repo/jobs.ts
grep -rnE "boss\??\.(send|insert|sendAfter|sendThrottled|sendDebounced|flow)\(" apps/server/src --include='*.ts' \
  | grep -v '^apps/server/src/repo/jobs\.ts:'

# R3 — handlers are registered only in worker.ts
grep -rnE "\.work\(" apps/server/src --include='*.ts' \
  | grep -v '^apps/server/src/worker\.ts:'
```

### What the rules cover

- `apps/server/src`, colocated `*.test.ts` included: a test that needs a boss goes through
  `composition.ts` or `db/jobs.ts` like production code does. `apps/server/tests/` is outside
  every command; a test of `worker.ts` registers nothing itself.
- **The five allow-listed files are the exceptions.** `index.ts` and `worker.ts` are the two
  entry points, `composition.ts` only names the `PgBoss` type, `db/jobs.ts` installs the
  schema on its own short-lived instance, and `repo/jobs.ts` is the enqueue seam.
- R2 matches the receiver name `boss` (optionally `boss?.`); a boss passed under another
  name is still caught by R1, which stops it being imported. R3 matches any receiver.
- `apps/mobile` and `packages/core` never see pg-boss, and no command scans them.

## Why

- R2 is what makes "the job exists if and only if the write committed" a property of the
  code rather than a habit: `repo/jobs.ts` takes the transaction, so a bare `boss.send` that
  commits independently has nowhere to hide.
- R3 and R4 keep `worker.ts` a second entry point shaped like `app.ts`: a queue name maps to
  a service call, and the logic stays where the transaction and the tests are.
- R1's narrow `new PgBoss` list is the connection count: each construction opens its own
  pool, and only the two places that already own connections may.

## Related

- [ADR 0001](adr-0001-layered-architecture.md) R5, R8, R9 — `worker.ts` carries `app.ts`'s
  obligation; one transaction per use case; R4 here is R9's twin.
- [ADR 0002](adr-0002-di-with-closures.md) — the boss is constructed at a composition root
  and passed down as a closure.
