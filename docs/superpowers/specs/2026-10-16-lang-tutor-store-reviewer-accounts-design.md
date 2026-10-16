# Store reviewer accounts — a fixed sign-in code per store reviewer

- **Status:** Scoped with Victor on 2026-10-16 (one-pager, four scope answers). Then "go till PR":
  the design below is self-approved (CLAUDE.md, *Continue till PR*). Rulings are at the end.
- **Date:** 2026-10-16
- **Source:** the one-pager `drafts/2026-10-16-store-reviewer-accounts-one-pager.md` (gitignored;
  restated below).
- **Builds on:** sign-in by emailed 8-digit code (phase 29, ADR 0009); the Play Console *App
  access* placeholder (`docs/runbooks/android.md` step 1.4); Beta App Review's sign-in
  (`docs/runbooks/ios.md`).
- **Touches:** `config.ts` (`loadAuthConfig`), `domain/auth.ts`, `auth/betterAuth.ts`,
  `composition.ts`; the auth flow integration test; `terraform/prod/variables.tf`; the Android
  and iOS runbooks; ADR 0009 (one paragraph).

---

## Goal

Apple and Google reviewers must sign in to review the app, but sign-in is by a code sent to the
address, and they cannot receive our mail. Play Console already names
`android_tester_0001@wordspal.ai` with a fixed 8-digit code. That account does not work today,
so a production release would fail review.

**Done means:**

1. A reviewer signs in on the prod build with the email and code from the store form, and lands
   on home (through the same first-run profile step as any new learner).
2. The same code for any other email is still refused.

## Scope

**In:** one reviewer account per store (Google's `android_tester_0001@wordspal.ai` and one for
Apple), each with its own fixed code; the code is typed on the normal code screen; the codes are
prod secrets, never in the repo.

**Out:** managing the list without a deploy; static-password access for our own testers or for
automation; pre-filled reviewer content; a password field or a separate sign-in screen.

## Design

### D1 — One optional secret, `REVIEWER_CODES`

`REVIEWER_CODES` holds the accounts as `email=code` pairs joined by commas:
`android_tester_0001@wordspal.ai=12345678,ios_tester_0001@wordspal.ai=87654321`.
`loadAuthConfig` parses it into `AuthConfig.reviewerCodes: ReadonlyMap<string, string>`, the
email normalised as the sign-in path normalises it (`normalizeEmail`). The map is empty when the
variable is unset or blank, which is every lane, CI and test.

Start-up fails on a pair that is not `email=code`, a code that is not exactly 8 digits (the app's
code field and `otpLength` are 8), an address that `isDeliverable` refuses, or the same address
twice. The error names the variable and the position of the bad pair, never a value.

Emails and codes both live in the secret, so changing the list is a secret write plus a
redeploy, and nothing about a reviewer is in the repo. The Apple address is Victor's to pick when
he writes the secret; `ios_tester_0001@wordspal.ai` is suggested in the runbook.

### D2 — The fixed code goes through Better Auth's own code path

`emailOTP` takes `generateOTP({ email, type })`. For a `sign-in` code to a reviewer address it
returns that reviewer's code; for everyone else it returns `undefined`, and Better Auth falls
back to its random generator, exactly as today. Better Auth then stores the fixed code as it
stores any code: hashed, ten minutes, three tries. Sign-in is the unchanged
`POST /sign-in/email-otp`.

That makes Done-means 2 structural rather than an extra check. Another address's stored code is
random, so typing a reviewer's code there fails like any wrong code.

Rejected: checking the code in a before-hook on the sign-in path and minting a session. That would
be a second sign-in path beside Better Auth's, with its own attempt counting and session creation.

`createAuth` takes the map as a new dependency, `reviewerCodes`, handed over by `composition.ts`
from `AuthConfig`.

### D3 — A reviewer's code is never mailed, but the send is still counted

In `sendVerificationOTP`, a reviewer address skips `sendCode` (the reviewer could not read it,
and `wordspal.ai` does not take mail for these addresses). It still calls `authRepo.recordSend`
and logs `{ event: 'auth_code_sent', reviewer: true }`, with no address or code.

Counting matters. The five-per-hour limit is what bounds guessing: each issued code allows three
tries, so a stranger who knows a reviewer address gets at most 15 guesses an hour against an
8-digit code. That is the same exposure every learner's address has.

### D4 — Prod wiring

`REVIEWER_CODES` joins `secret_env_names` in `terraform/prod/variables.tf`, under
`wordspal/prod/`. As with `BOT_SECRET`, a plan reads every named secret, so `terraform-plan` stays
red until Victor writes it. That is a **Left for Victor** step before merge.

### D5 — Docs

- ADR 0009 gains a paragraph under Decision: reviewer codes come only from `REVIEWER_CODES`, go
  through `generateOTP`, and are never mailed. R8 (plugins, paths) is unchanged.
- The Android runbook's *App access* bullet loses its "not implemented" note and points at the
  secret. The iOS runbook's Beta App Review step names the Apple reviewer address.

## Tests

- `config.test.ts`: unset or blank gives an empty map; two pairs parse with the email
  normalised; each malformed case throws without printing the value.
- `domain/auth` unit (if the lookup lives there): reviewer lookup is by normalised email.
- `tests/integration/auth/flow.test.ts`, with reviewer codes configured:
  - a send to the reviewer address answers 200 and never reaches `sendCode` (the test's fake
    sender records nothing), and sign-in with the fixed code gives a session;
  - the reviewer's code typed for another address is refused;
  - the reviewer's sends are counted: the sixth in an hour is 429.

## Left to the builder

Where the lookup function lives (`domain/auth.ts` is the natural home, beside `normalizeEmail`);
the exact error text.

## Rulings
