# ADR 0008: Access grants — a role on a grant, one permission map, one check, an asserted actor

- **Status:** Accepted
- **Date:** 2026-10-07
- **Source:** [phase 28 design](../superpowers/specs/2026-10-07-lang-tutor-phase-28-tutor-words-design.md) — D1 for the grant, D6 for roles and permissions, D7 for the actor header, D8 for the check, D18 for these rules

## Decision

A student's list can be shared with another user through an access grant: a row in
`enrollment_grants` that carries a role. Roles map to permissions in one pure module, and one
check, run inside the use case's transaction before anything is written, decides whether the
actor may act on the list. The actor is named by a request header, which is asserted.

```
  X-Acting-User-Id: <id>          asserted by the client, proves nothing
        │
        ▼
  routes/actor.ts      ACTOR_HEADER, ActorHeadersSchema, actorOf   the ONLY reader (server)
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
In the app the header is built once, in `api/client.ts`.

## Rules

| # | Subject | May | Must not |
|---|---|---|---|
| R1 | `enrollment_grants` | `src/repo/grants.ts`, and `src/db/schema.ts` which declares it | `enrollment_grants` or `enrollmentGrants` in any other file under `apps/server/src` |
| R2 | the actor header | `apps/server/src/routes/actor.ts`; `apps/mobile/src/api/client.ts` | `x-acting-user-id`, in any case, in any other non-test file of either app |
| R3 | role literals | `src/domain/access.ts`, `src/db/schema.ts` | the literal `'tutor'` in any other non-test file under `apps/server/src`; use `TUTOR` |

## Rules that are not import rules

- **R4 — Every use case that acts on an enrollment for an actor calls `authorize`.** Not
  greppable: a use case that forgets looks like one that does not need it. Enforced by review,
  like [ADR 0001](adr-0001-layered-architecture.md) R9.
- **R5 — Nothing treats the actor as authenticated.** Not greppable. Replacing the header with
  login is a new ADR, not an edit to a service. Enforced by review.

## How to detect a violation

`npm run lint:arch` runs the commands below alongside the other ADRs';
`scripts/check-adr-0008-access-grants.sh` mirrors this block verbatim. Each command must
print nothing.

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

### What the rules cover

- R1 scans `apps/server/src`, colocated tests included: a test reaches the table through
  `repo/grants.ts` like production code. `apps/server/tests/` is outside every command.
- R2 scans both apps' `src`, test files excepted: a test may spell the header it asserts on.
- R3 scans `apps/server/src`, test files excepted, for the same reason.
- **`routes/actor.ts` is a deliberate exception to [ADR 0003](adr-0003-openapi-wire-contract.md) R2.**
  It defines the header's zod schema inside `routes/`. The header is transport, not a body
  schema, and putting it in `packages/core` would name the header in a second place, which
  R2 here forbids.
- **The exceptions are the owners.** `db/schema.ts` declares the table and the role enum,
  `routes/actor.ts` and `api/client.ts` are each app's one header site, `domain/access.ts`
  holds the role map.
- `packages/core` is not scanned.

## Why

- The actor is asserted: anyone can send any user id, as anyone can type any username today.
- So the check is a correctness boundary until login, not a security one. An honest app
  cannot write to a stranger's list; a hostile client can.
- The header is the slot login fills. When it arrives the authenticated identity replaces the
  header's value, and nothing behind `actorOf` changes. R2 keeps that a one-file change.
- A role on a grant answers phase 8's objection to a role on a user: nobody is a tutor in
  general, only on one student's list.
- R3 keeps the permission map the only place a role gains power, so adding a role or a
  permission is an edit to `domain/access.ts` and no migration.

## Related

- [ADR 0005](adr-0005-identity-without-authentication.md) — amended: authorization exists, over
  an asserted identity; still no credential code.
- [ADR 0001](adr-0001-layered-architecture.md) R9 — R4 here is its twin, enforced by review.
