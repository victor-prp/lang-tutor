# Store reviewer accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store reviewers sign in with a fixed 8-digit code per reviewer address, from the `REVIEWER_CODES` prod secret.

**Architecture:** `loadAuthConfig` parses `REVIEWER_CODES` into a map; `createAuth` hands Better Auth's `emailOTP` a `generateOTP` that returns the reviewer's code for a reviewer address, and its sender skips mailing (but still counts the send) for those addresses.

**Tech Stack:** TypeScript, Better Auth 1.7 `emailOTP`, Jest, Terraform.

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-store-reviewer-accounts-design.md`

## Global Constraints

- No reviewer address or code in the repo outside tests; error messages never print a value.
- Codes are exactly 8 digits; emails normalised with `normalizeEmail`, deliverable per `isDeliverable`.
- `better-auth` stays imported only in `auth/betterAuth.ts` (ADR 0009 R1).

## Review Focus

- Reviewer address typed in mixed case or with spaces in the app → still the reviewer (normalised lookup). Task 2 test.
- Reviewer code typed for a non-reviewer address → refused. Task 2 test.
- Repeated sends to a reviewer address → still limited to five an hour. Task 2 test.
- `REVIEWER_CODES` with a trailing comma or spaces → parses; duplicate address → start-up error. Task 1 test.
- A non-sign-in type to a reviewer address → still refused by the before-hook (unchanged path; no new test).

---

### Task 1: Parse `REVIEWER_CODES`

**Files:** Modify `apps/server/src/config.ts`, `apps/server/src/config.test.ts`

**Interfaces:** Produces `AuthConfig.reviewerCodes: ReadonlyMap<string, string>` (normalised email → code).

- [ ] Tests in `describe('loadAuthConfig')`: unset and blank give an empty map (and the existing `toEqual` gains `reviewerCodes: new Map()`); `' A@Example.com=12345678 , b@example.com=87654321, '` gives both entries with `a@example.com`; each of `x@example.com`, `x@example.com=1234567`, `x@example.com=abcdefgh`, `x@example.invalid=12345678`, a duplicate address throws an error containing `REVIEWER_CODES` and not containing the code.
- [ ] Run `npx jest src/config.test.ts` in `apps/server`: FAIL.
- [ ] Implement in `loadAuthConfig`; error text names the pair's position (`pair 2`).
- [ ] Run: PASS. Commit.

### Task 2: Reviewer codes in Better Auth + wiring + docs

**Files:** Modify `apps/server/src/auth/betterAuth.ts`, `apps/server/src/composition.ts`, `apps/server/tests/integration/auth/flow.test.ts`, `terraform/prod/variables.tf`, `docs/adr/adr-0009-sign-in.md`, `docs/runbooks/android.md`, `docs/runbooks/ios.md`

**Interfaces:** `createAuth` deps gain `reviewerCodes: ReadonlyMap<string, string>`.

- [ ] Flow test: existing `createAuth` call passes `reviewerCodes: new Map([['reviewer@example.com', '24681357']])`. New `describe('a store reviewer')`: send to `Reviewer@Example.com` → 200, `codes` empty, sign-in with `24681357` → 200 and a cookie; send to `other@example.com` then sign-in with `24681357` → not 200; six sends to the reviewer → sixth 429; log has `auth_code_sent` with `reviewer: true` and no line containing the address or code.
- [ ] Run (CI if no lane DB): FAIL.
- [ ] Implement `generateOTP` and the sender branch (spec D2, D3); pass `io.auth.reviewerCodes` in composition.
- [ ] `REVIEWER_CODES` appended to `secret_env_names`; ADR 0009 paragraph; runbook bullets (spec D5).
- [ ] Run flow test, `npx tsc --noEmit`, `npm test`, `./scripts/check-adrs.sh`: PASS. Commit.
