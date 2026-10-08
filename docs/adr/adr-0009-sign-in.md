# ADR 0009: Sign-in with Better Auth, behind one seam

- **Status:** Accepted. Supersedes [ADR 0005](adr-0005-identity-without-authentication.md); amends [ADR 0001](adr-0001-layered-architecture.md), [ADR 0002](adr-0002-di-with-closures.md), [ADR 0003](adr-0003-openapi-wire-contract.md) and [ADR 0008](adr-0008-access-grants.md)
- **Date:** 2026-10-08
- **Source:** [phase 29 design](../superpowers/specs/2026-10-08-lang-tutor-phase-29-auth-design.md) — D1 to D21, with D20 for these rules

## Decision

A learner signs in with an emailed 8-digit code. Better Auth 1.7.x does the work (the
`emailOTP` and `expo` plugins, password sign-in off), over tables of ours, and it is reached
through one file on each side. Nothing else in either app knows which product issues the
session. The actor of every request comes from the session cookie and from nothing a client
asserts.

```
  app: auth/client.ts  ── better-auth client, built in _layout.tsx (SecureStore there only)
        │ sessionHeaders()
        ▼
  api/client.ts        ── attaches the session to every call; no identity of its own
        │
  server: app.ts mounts four /api/auth paths ──► auth/betterAuth.ts   the ONE better-auth import
        │                                          (built only by composition.ts)
        ▼
  routes/actor.ts      ── sessionOf(headers) → c.var.actor; 401 / 403 profile required
        │ actorUserId
        ▼
  services/*  ── authorize() / authorizeEnrollment() (ADR 0008)
```

Four paths under `/api/auth` are mounted and nothing else: `POST /email-otp/send-verification-otp`,
`POST /sign-in/email-otp`, `GET /get-session`, `POST /sign-out`. Any other path under
`/api/auth/*` answers 404 `{ error: 'not found' }` without reaching Better Auth.

The tables are `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications` and our own
`auth_code_sends`, created by migration 0022 (tables, and a backfill giving every existing
profile an unclaimed `.invalid` identity). Migration 0023 then makes `users.id` reference
`auth_users.id`: a profile needs a sign-in identity. Better Auth is told not to generate ids
(`generateId: false`), so the database does, as everywhere else here.

A session lasts 90 days and is extended by use at most once a day. Better Auth extends a session
only through the app's call to `GET /api/auth/get-session`, which re-issues the cookie; the server
middleware reads sessions with refresh disabled, so the row and the cookie always move together.

Better Auth logs through our `Logger`, level and the first line of the message only: its extra
arguments are driver errors whose text holds query parameters (tokens, addresses). Its origin
check is switched on explicitly (`advanced.disableOriginCheck: false`), because by default it is
off whenever `NODE_ENV=test`, and the flow test then ran without the check production runs.

## Rules

| # | Subject | May | Must not |
|---|---|---|---|
| R1 | `better-auth`, `@better-auth/*` | `apps/server/src/auth/betterAuth.ts`; `apps/mobile/src/auth/client.ts` | an import of either in any other `.ts`/`.tsx` file under `apps/server/src` or `apps/mobile/src` |
| R2 | the five `auth_*` tables | `src/db/schema.ts` (declares them), `src/auth/betterAuth.ts` (hands them to the adapter), `src/repo/auth.ts` | `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`, `auth_code_sends`, or their Drizzle consts, in any other file under `apps/server/src` |
| R3 | the session becomes an actor | `src/routes/actor.ts` | `sessionOf(` in any other non-test file under `routes/` or `services/`; `x-acting-user-id`, in any case, in any non-test file of either app |
| R4 | `better-auth` and `@better-auth/expo` versions | an exact version | a `^` or `~` range in any `package.json` |
| R5 | authentication dependencies | `better-auth`, `@better-auth/expo` | passport, jose, jsonwebtoken, bcrypt, argon2, Clerk, Supabase, Firebase, Amplify, SuperTokens, next-auth, `@auth/*` or lucia in any `package.json` (carried over from ADR 0005 R3) |
| R6 | creating a profile | `src/repo/users.ts` | `insert(users)` in any other file under `apps/server/src` (carried over from ADR 0005 R2) |

## Rules that are not import rules

- **R7 — Every use case that touches a learner's data takes `actorUserId` and calls
  `authorize` (or `authorizeEnrollment`).** Not greppable: a use case that forgets looks like
  one that does not need it. Enforced by the stranger matrix test (no session is 401, a
  stranger is 403 everywhere, a tutor only adds words) and by review, like
  [ADR 0001](adr-0001-layered-architecture.md) R9. It widens ADR 0008's former R4.
- **R8 — Better Auth mounts only the `emailOTP` and `expo` plugins, with password sign-in off,
  and only the four paths above.** Enforced by the mount test
  (`apps/server/tests/integration/auth/mount.test.ts`), which asserts that `update-user`,
  `sign-up/email`, `email-otp/reset-password` and the rest answer 404 without reaching Better
  Auth.
- **R9 — Upgrade policy and switch signals.** `better-auth` and `@better-auth/expo` are pinned
  to an exact version (R4). Advisories touching the core, email codes or Expo are patched
  within days, minors are taken deliberately, and the whole-flow integration test gates every
  upgrade. The switch signals are below.

## How to detect a violation

`npm run lint:arch` runs the commands below alongside the other ADRs';
`scripts/check-adr-0009-sign-in.sh` mirrors this block verbatim. Each command must print
nothing.

```bash
# R1 — better-auth is imported in one file per app
grep -rnE "(from|import|require)[[:space:]]*\(?[[:space:]]*'(better-auth|@better-auth/[a-z-]+)(/[^']*)?'" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
  | grep -vE '^apps/server/src/auth/betterAuth\.ts:|^apps/mobile/src/auth/client\.ts:'

# R2 — the auth tables are named in three server files
grep -rnE "auth_(users|sessions|accounts|verifications|code_sends)\b|auth(Users|Sessions|Accounts|Verifications|CodeSends)\b" apps/server/src --include='*.ts' \
  | grep -vE '^apps/server/src/(db/schema|auth/betterAuth|repo/auth)\.ts:'

# R3 — the session becomes an actor in one place; the asserted header is gone
grep -rn "sessionOf(" apps/server/src/routes apps/server/src/services --include='*.ts' --exclude='*.test.ts' \
  | grep -v '^apps/server/src/routes/actor\.ts:'
grep -rniE "x-acting-user-id" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx'

# R4 — better-auth is pinned exactly
grep -nE '"(better-auth|@better-auth/expo)": "[\^~]' package.json apps/*/package.json packages/*/package.json e2e/package.json

# R5 — no other authentication dependency
grep -nE '"(passport[a-z-]*|jose|jsonwebtoken|bcrypt|bcryptjs|argon2|@clerk/[a-z-]+|@supabase/[a-z-]+|firebase|aws-amplify|supertokens[a-z-]*|next-auth|@auth/[a-z-]+|lucia)"' \
  package.json apps/*/package.json packages/*/package.json e2e/package.json

# R6 — profiles are inserted in one place
grep -rn "insert(users)" apps/server/src --include='*.ts' | grep -v 'repo/users.ts'
```

### What the rules cover

- R1 scans both apps' `src`, tests included: a test that wants a session builds one through
  the seam. `apps/mobile/src/auth/client.ts` does not have to exist for the rule to hold.
- R2 scans `apps/server/src` with tests: a test reaches the tables through `repo/auth.ts`.
  `apps/server/tests/` is outside every command.
- R3 has two commands. The first scans only `routes/` and `services/`, test files excepted:
  `composition.ts` and `auth/betterAuth.ts` define and wire `sessionOf`, and tests stub it.
  The second scans both apps, test files excepted, because `actor.test.ts` spells
  `x-acting-user-id` to prove it is ignored.
- R4 and R5 read every `package.json` the workspaces have, plus `e2e/`.
- R6 scans `apps/server/src`, tests included.
- **The exceptions are the owners.** `db/schema.ts` declares the tables, `auth/betterAuth.ts`
  is the one place Better Auth is imported, `repo/auth.ts` is the one reader of the send log
  and the claim, `routes/actor.ts` is the one session middleware, `repo/users.ts` the one
  profile insert.
- `packages/core` is not scanned.

## Why

- The previous identity was a username anyone could type and a header anyone could send. The
  authorization check of ADR 0008 was a correctness boundary; with a session it becomes a
  security one, and R3 keeps the slot it fills in a single file.
- Every server and hosted option failed a hard constraint (Expo Go, offline CI, ids we
  choose) or cost a container per lane; hand-rolled was close. Better Auth already worked in
  the spike on Android and web and its Expo client and later Google/Apple linking are built.
  Its cost is churn, which R4, R8 and R9 contain: an exact pin, four mounted paths, and a flow
  test as the upgrade gate.
- One import site per app (R1) and one table owner (R2) are what make "switch to hand-rolled
  on the same tables" a change to two files rather than a rewrite.
- R5 and R6 carry over ADR 0005's two checkable rules: no second authentication stack, and no
  profile row without going through `repo/users.ts`.

## Accepted risks

- **A nuisance wait.** Our own limit is 5 sent codes per email per hour, and a new code
  cancels the old one, so someone requesting codes for your address can make you wait for the
  next one. They still cannot sign in, and each new code reaches you. A burst of concurrent
  requests may also exceed 5 by a few. A failed send cancels the previous code and leaves
  none: Better Auth stores a new code before calling the sender, and our after-hook deletes it
  before answering 503, so no code that never arrived can be guessed at. An email outage
  therefore also cancels a code the learner already received, and the learner asks again; the
  failed send is not counted against the hour.
- **Session tokens are stored in plain form.** Better Auth does not hash them at rest (still a
  draft upstream, PR #11444), so a database leak would expose live sessions. A database backup
  is as sensitive as a password file.
- **Better Auth's IP rate limiter is off until hosting.** Without a proxy it cannot see a
  client IP and falls back to one shared bucket per path for everyone, so switched on now it
  would throttle every learner and every e2e test together. Until hosting the protection is
  3 tries per code and 5 codes per email per hour. See the obligations below.

## Obligations for the hosting phase

Before the app is public: switch on Better Auth's rate limiter with `storage: 'database'` (adding
`auth_rate_limits`) and `trustedProxies` for the real proxy; add a per-IP limit on sending codes;
serve the API over HTTPS (Better Auth then marks the cookie `Secure`); move `BETTER_AUTH_SECRET` and
`RESEND_API_KEY` into the host's secret store.

## Switch signals

**The switch target is hand-rolled on the same tables, not another product.** Switch when
two upgrades in a row break the flow test or need a core-table change, when an advisory on the
code or session path stays unpatched for a week, or when an Expo client breakage stays open past
one release.

## Related

- [ADR 0005](adr-0005-identity-without-authentication.md) — superseded: sign-in exists. Its R2
  and R3 live on as R6 and R5 here.
- [ADR 0008](adr-0008-access-grants.md) — amended: the actor is the signed-in user, and R7
  here widens its former R4 to every use case.
- [ADR 0001](adr-0001-layered-architecture.md) — `auth/` joins the layers, beside `providers/`.
- [ADR 0002](adr-0002-di-with-closures.md) — `expo-secure-store` joins R1; the new factories
  join R6.
- [ADR 0003](adr-0003-openapi-wire-contract.md) — the `/api/auth/*` mounts are its second
  exception to R1.
- [ADR 0006](adr-0006-lanes.md) — `AUTH_BASE_URL` and `WEB_ORIGINS` are derived in
  `scripts/lane-env.sh`.
