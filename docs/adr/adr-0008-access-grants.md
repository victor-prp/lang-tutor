# ADR 0008: Access grants — a role on a grant, one permission map, one check, an actor

- **Status:** Accepted; amended by [ADR 0009](adr-0009-sign-in.md) on 2026-10-08 (phase 29): the actor is the signed-in user
- **Date:** 2026-10-07; R2, R4, R5 and the diagram amended 2026-10-08 (phase 29)
- **Source:** [phase 28 design](../superpowers/specs/2026-10-07-lang-tutor-phase-28-tutor-words-design.md) — D1 for the grant, D6 for roles and permissions, D7 for the original actor header (replaced by the session, ADR 0009), D8 for the check, D18 for these rules

## Decision

A student's list can be shared with another user through an access grant: a row in
`enrollment_grants` that carries a role. Roles map to permissions in one pure module, and one
check, run inside the use case's transaction before anything is written, decides whether the
actor may act on the list. Since phase 29 the actor is the signed-in user, taken from the
session and from nothing a client sends.

```
  session cookie ──► routes/actor.ts (createSessionMiddleware)   the ONLY place a session
        │                                                         becomes an actor (ADR 0009)
        │ actorUserId, a plain argument
        ▼
  services/*           one transaction per use case
        │
        ▼
  services/access.ts   authorize(repos, logger, { actorUserId, enrollment, permission })
        │                  loads the grant through repos.grant ──► repo/grants.ts  (the ONLY
        │                                                          reader/writer of the table)
        ▼
  domain/access.ts     may(actor, owner, grant | null, permission)   pure
                       ROLE_PERMISSIONS: { tutor: ['vocabulary.add'] }
```

The owner may do anything with their own list; anyone else needs an accepted grant whose role
includes the permission; a pending grant allows nothing. A refusal is `AccessDenied`, a 403.

## Rules

| # | Subject | May | Must not |
|---|---|---|---|
| R1 | `enrollment_grants` | `src/repo/grants.ts`, and `src/db/schema.ts` which declares it | `enrollment_grants` or `enrollmentGrants` in any other file under `apps/server/src` |
| R2 | the actor | `apps/server/src/routes/actor.ts` (the session middleware) | a header, body field or path segment naming the acting user; `x-acting-user-id` anywhere |
| R3 | role literals | `src/domain/access.ts`, `src/db/schema.ts` | the literal `'tutor'` in any other non-test file under `apps/server/src`; use `TUTOR` |

## Rules that are not import rules

- **R4 — now [ADR 0009](adr-0009-sign-in.md) R7: every use case that touches a learner's
  data** takes `actorUserId` and calls `authorize`. Not greppable; enforced by the stranger
  matrix test and by review, like [ADR 0001](adr-0001-layered-architecture.md) R9.
- **R5 — Retired by ADR 0009: the actor is authenticated.**

## How to detect a violation

`npm run lint:arch` runs the commands below alongside the other ADRs';
`scripts/check-adr-0008-access-grants.sh` mirrors this block verbatim. Each command must
print nothing.

```bash
# R1 — enrollment_grants is read and written only by repo/grants.ts
grep -rnE "enrollment_grants|enrollmentGrants" apps/server/src --include='*.ts' \
  | grep -vE '^apps/server/src/(repo/grants|db/schema)\.ts:'

# R2 — the acting user comes from the session; the asserted header is gone (ADR 0009 R3)
grep -rniE "x-acting-user-id" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx'

# R3 — roles are named once
grep -rn "'tutor'" apps/server/src --include='*.ts' --exclude='*.test.ts' \
  | grep -vE '^apps/server/src/(domain/access|db/schema)\.ts:'
```

### What the rules cover

- R1 scans `apps/server/src`, colocated tests included: a test reaches the table through
  `repo/grants.ts` like production code. `apps/server/tests/` is outside every command.
- R2 scans both apps' `src`, test files excepted, with no exceptions: a test may spell the
  header it asserts is ignored.
- R3 scans `apps/server/src`, test files excepted, for the same reason.
- **The exceptions are the owners.** `db/schema.ts` declares the table and the role enum,
  `routes/actor.ts` is the one place a session becomes an actor (R2 allows no header anywhere,
  so it has no exception to name), `domain/access.ts` holds the role map.
- `packages/core` is not scanned.

## Why

- Until phase 29 the actor was asserted, so the check was a correctness boundary, not a
  security one. With sign-in the actor is the signed-in user and the same check is a security
  boundary. R2 keeps the slot it fills a one-file change, and forbids a client from naming the
  acting user in any other way.
- A role on a grant answers phase 8's objection to a role on a user: nobody is a tutor in
  general, only on one student's list.
- R3 keeps the permission map the only place a role gains power, so adding a role or a
  permission is an edit to `domain/access.ts` and no migration.

## Related

- [ADR 0009](adr-0009-sign-in.md) — the actor is the signed-in user; its R3 is R2 here, its R7
  widens R4.
- [ADR 0005](adr-0005-identity-without-authentication.md) — superseded by ADR 0009.
- [ADR 0001](adr-0001-layered-architecture.md) R9 — R4 here is its twin, enforced by review.
