# ADR 0005: Identity without authentication

- **Status:** Accepted
- **Date:** 2026-09-07
- **Source:** [phase 8 design](../superpowers/specs/2026-09-07-lang-tutor-phase-8-onboarding-design.md)

## Decision

A username **identifies** a learner and **authorizes** nothing. `POST /api/login` takes a
username and no password: it is a lookup that returns a profile, not an authentication.

```
  POST /api/users     register    the ONE place a user row is created
        │
        ▼
  users.username      identity    unique, ^[a-z0-9_]{3,30}$, no secret attached
        │
        ▼
  POST /api/login     lookup      returns the profile — proves nothing about who asked
        │
        ▼
  (nothing)           authorization — deliberately absent
```

No credential machinery — a password hash, a token, auth middleware, a third-party auth
SDK — enters this repo until a phase deliberately adds it and supersedes this ADR. Users
are created in exactly one place; nothing creates one implicitly. Phase 8 deleted
`upsertUser`, which created a row on first sight, precisely so that place stays single.

## Rules

| # | Subject | Must not appear |
|---|---|---|
| R1 | `apps/server/src`, `packages/core/src`, `apps/mobile/src` | any credential primitive: `bcrypt`, `argon2`, `jsonwebtoken`, `password_hash`/`passwordHash`, `expo-secure-store` |
| R2 | `apps/server/src` | `insert(users)` anywhere but `repo/users.ts` |
| R3 | every workspace's `package.json` | an authentication dependency |

## Rules that are not import rules

- **R4 — No authorization decision may read the result of `POST /api/login` as proof of
  anything.** Not greppable: an `if (user)` guarding a feature looks identical whether the
  identity behind it was authenticated or merely asserted, so no regex can tell the two
  apart. Enforced by review, and by that endpoint's own published `description`, which says
  it authenticates nothing — asserted by `apps/server/src/openapi.test.ts`.

## How to detect a violation

`npm run lint:arch` runs the three commands below alongside the other ADRs';
`scripts/check-adr-0005-identity-without-authentication.sh` mirrors this block verbatim.
Each command must print nothing.

```bash
# R1 — no credential primitive in any src tree
grep -rniE "bcrypt|argon2|jsonwebtoken|password_hash|passwordHash|expo-secure-store" \
  apps/server/src packages/core/src apps/mobile/src \
  --include='*.ts' --include='*.tsx'

# R2 — users are inserted in exactly one place
grep -rn "insert(users)" apps/server/src --include='*.ts' | grep -v 'repo/users.ts'

# R3 — no authentication dependency in a package.json
grep -nE '"(bcrypt|bcryptjs|argon2|jsonwebtoken|jose|passport|expo-secure-store|firebase)"' \
  package.json apps/*/package.json packages/*/package.json e2e/package.json
```

### What the rules cover

- All three `src` trees (R1), `apps/server/src` (R2), and every workspace's `package.json`
  plus the root one (R3).
- **`apps/server/tests/support/seedUser.ts` is deliberately outside R2's scope.** It inserts
  users directly, and it may: it is the test composition root, the same carve-out
  [ADR 0001](adr-0001-layered-architecture.md) and [ADR 0004](adr-0004-test-topology.md)
  already grant it. R2 scans `apps/server/src` only, so the carve-out needs no `grep -v`.
- **Database migrations are out of scope.** They are SQL, not application code, and the
  phase 8 backfill writes usernames directly by design.
- R1 is case-insensitive and scans `.tsx` as well as `.ts`, so a credential primitive cannot
  hide in a screen or behind different capitalisation.
- The rules govern source, not the wire: the *absence* of a password field in
  `CreateUserRequestSchema` is enforced by [ADR 0003](adr-0003-openapi-wire-contract.md)'s
  R3, which makes every published type an inference from that schema.

## Why

- A username with no password is a *smaller* claim than the client-generated UUID it
  replaced, not a larger one — but it **looks** like a login, and that resemblance is the
  whole risk this ADR exists for.
- The failure mode is not a breach, it is a diff: someone adds a "since we're already here"
  password field, or builds a permission check on `login`'s return value, and neither looks
  wrong in review. R1 and R4 are aimed at exactly that.
- R2 exists because implicit user creation is what phase 8 removed. One insertion point is
  what makes "who can create a learner" a question with an answer.

## Related

- [ADR 0003](adr-0003-openapi-wire-contract.md) — the login endpoint's published description
  is part of the wire contract; R4's real enforcement lives there.
- [ADR 0001](adr-0001-layered-architecture.md) R9 — R2 is that rule's identity-specific case:
  a repository owns the persistence step, so `insert(users)` belongs to `repo/users.ts` alone.
