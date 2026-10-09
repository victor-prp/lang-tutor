# Phase 29 — Sign-in: emailed codes, sessions, and the user from the session everywhere

- **Status:** Designed on 2026-10-08. Victor scoped the phase in the one-pager, chose Better Auth
  after a spike and a research round (the decision is recorded in D1), and approved the design in
  conversation section by section: how sign-in works (§1 there), the tables and the migration (§2),
  the user from the session in every route (§3), the email sender, Resend from `mail.wordspal.ai`
  (§4), the app (§5), testing (§6) and ADR 0009 (§7). He then handed the remaining decisions over
  ("I trust your decisions"). Three decisions were made after that approval, while checking Better
  Auth's installed source; they are marked **(after approval)** with the evidence, so each can be
  overturned in review.
- **Date:** 2026-10-08
- **Source:** the one-pager `drafts/2026-10-07-auth-one-pager.md`, the research prompt and verdict
  `drafts/2026-10-08-auth-library-research-prompt.md` and `drafts/2026-10-08-auth-library-decision.md`,
  and the throwaway spike on branch `spike-better-auth` (local only). `drafts/` is gitignored, so
  everything this spec depends on is restated below.
- **Builds on:** phase 8 (username identity, ADR 0005), phase 16 (enrollments), phase 28 (access
  grants, the actor header, `authorize()`, ADR 0008).
- **Touches:** five new tables and a foreign key from `users`. Better Auth mounted on four
  allow-listed paths. Every `/api/*` route now requires a session; most also require a profile.
  `POST /api/login` is removed, `GET /api/me` is added, the enrollment paths lose their user id, and
  three request bodies lose `user_id`. `authorize()` grows from 2 call sites to every use case that
  touches a learner's data. A new ADR 0009 supersedes ADR 0005 and amends 0001, 0002, 0003 and
  0008. Mobile replaces the login screen with sign-in by emailed code and gets a real sign-out.

## Goal

A username proves nothing today: typing another learner's username opens their words and progress,
and anyone who finds the server can spend Gemini calls on Victor's key. This phase makes signing in
prove who you are, and makes every API answer depend on it, so the app can be shared beyond its
current users and later go public.

Done means, in Victor's words from the one-pager:

1. Typing someone else's username no longer opens their account.
2. An API call (translate, a session, speech) from someone not signed in is refused.
3. A new person signs up on their own phone unaided, uses the app, signs out and back in, and
   their words are still there.
4. A learner who forgot how to sign in gets back in without contacting Victor.
5. Existing accounts keep their words, enrollments and progress after the switch.
6. The automated suites still run in CI as now, with no outside service required.

## Scope

**In:** sign-in by a code emailed to the learner (sign-up, sign-in on a new phone and recovery are
one flow); open sign-up; 90-day device sessions and sign-out; every API route behind a session;
every use case authorized against the signed-in user; existing accounts carried over and claimable;
real email through Resend; offline tests through MockServer.

**Out** (from the one-pager, plus what this design defers):

- A per-account spending cap; protection against bulk sign-ups.
- Roles beyond phase 28's tutor; seeing another learner's account.
- Account deletion; data download; privacy policy and terms pages.
- Changing username or email; seeing or signing out other devices; two-step verification.
- "Continue with Google/Apple" (Better Auth supports it later; it needs an EAS build).
- **Deferred to the hosting phase, required before going public:** Better Auth's IP rate limiter
  with a trusted proxy, and a per-IP limit on sending codes (D5).

## 1. Decisions

**D1. Better Auth 1.7.x, email codes only, behind one seam on each side.** Victor's decision,
2026-10-08, after a spike and a four-way research round (Better Auth, hand-rolled on Node `crypto`,
self-hosted servers such as Kratos and SuperTokens, hosted providers such as Clerk, Supabase and
Cognito). Every server and hosted option failed a hard constraint (Expo Go, offline CI, ids we
choose) or cost a container per lane. Better Auth won narrowly over hand-rolled: it already worked
in the spike on Android and web, its Expo client and later Google/Apple linking are built, and the
hand-rolled reference material (Lucia, the Copenhagen Book) was deprecated or archived this summer.
Its cost is churn: 24 GitHub advisories between December 2024 and September 2026, two of them CVSS
≥ 9, and a breaking change in each 1.x minor. So: `better-auth` and `@better-auth/expo` are pinned
to an exact version (ADR 0009 R4), advisories touching the core, email codes or Expo are patched
within days, minors are taken deliberately, and the whole-flow integration test (§3) gates every
upgrade. **The switch target is hand-rolled on the same tables, not another product.** Switch when
two upgrades in a row break the flow test or need a core-table change, when an advisory on the code
or session path stays unpatched for a week, or when an Expo client breakage stays open past one
release.

**D2. The code.** 8 digits, valid 10 minutes, 3 tries, stored hashed (`otpLength: 8`,
`expiresIn: 600`, `allowedAttempts: 3`, `storeOTP: 'hashed'`). Digits so it is typed on the number
pad; 8 because 6 is the floor no current guide recommends for sign-in. A new code cancels the
previous one (the plugin keys one live code per email). Password sign-in is off
(`emailAndPassword` not configured); the only Better Auth plugins are `emailOTP` and `expo` (ADR 0009
R8).

**D3. Four Better Auth paths, and nothing else. (after approval)** Better Auth registers dozens of
endpoints by default: `update-user`, `delete-user`, `change-email`, `list-sessions`,
`request-password-reset`, the plugin's `forget-password` and `reset-password` flows, and more.
Several past advisories were in endpoints like these. `app.ts` therefore mounts `auth.handler` on
exactly four paths, and every other `/api/auth/*` path answers 404 without reaching Better Auth:

| Path | Used by |
|---|---|
| `POST /api/auth/email-otp/send-verification-otp` | the sign-in screen: send a code |
| `POST /api/auth/sign-in/email-otp` | the code screen: sign in (and sign up) |
| `GET /api/auth/get-session` | the Expo client, on start |
| `POST /api/auth/sign-out` | the profile screen |

A Better Auth `before` hook also refuses any `type` other than `'sign-in'` on the send path (400),
so the plugin's email-verification and password-reset codes cannot be requested through it. The
allow-list lives in one constant in `auth/betterAuth.ts`, exported for `app.ts` and the tests.

**D4. Our own limit: 5 sent codes per email per hour.** Checked in the same `before` hook, counted
from a small table of ours, `auth_code_sends(email, sent_at)`. A row is written only after the
email provider accepts the message, so an outage does not lock anyone out. The 6th request in an
hour answers 429 `too many codes`. The hook also refuses an address ending in `.invalid` (400): the
migration's placeholder accounts use that reserved domain (D10), and nothing should ever be sent
there. On each send the hook deletes that table's rows older than a day. With 3 tries per code,
the limit caps guessing at 15 an hour per email: attacking one account non-stop for a year would
succeed about 0.13% of the time, while flooding the victim's inbox with ~44,000 emails. Concurrent
requests can each pass the count before either writes, so a burst may exceed 5 by a few; that is
accepted and recorded. Because a new code cancels the old one, someone requesting codes for your
email can make you wait for the next one; they still cannot sign in, and each new code reaches you.
Accepted in ADR 0009.

**D5. Better Auth's IP rate limiter is OFF in this phase. (after approval)** The conversation
assumed it would be on, stored in the database, and simply start working at hosting. Reading the
installed 1.7.7 (`dist/api/rate-limiter/index.mjs`, `resolveRateLimitConfig`) shows why it must not
be: Better Auth reads the client IP from headers only, and when it finds none — which is every
request on a laptop with no proxy — it falls back to **one shared bucket per path** for everyone.
Switched on now, every learner and every e2e test would throttle each other on the sign-in paths.
So `rateLimit: { enabled: false }`, explicitly, and no `auth_rate_limits` table yet. The hosting
phase must switch it on with `storage: 'database'` and `advanced.ipAddress.trustedProxies` set for
its proxy, and add a per-IP limit on sending codes. ADR 0009 records this as an obligation, not a
suggestion. Until then the protection is D2's 3 tries and D4's 5 codes per hour.

**D6. Sessions.** 90 days, extended by use at most once a day (`expiresIn: 7776000`,
`updateAge: 86400`); cookie cache off, so every request reads the session row and sign-out takes
effect at once. Sign-out deletes the row. Every sign-in creates a new session. Better Auth stores
session tokens in plain form (hashing at rest is still a draft upstream, PR #11444): a database
leak would expose live sessions. Accepted in ADR 0009, and the reason a database backup is as
sensitive as a password file.

**D7. Telemetry off, explicitly.** It is off by default and under `NODE_ENV=test`; the config says
`telemetry: { enabled: false }` anyway, so an upstream default change cannot turn it on.

**D8. Five tables, our naming.** The repo's convention is snake_case, plural, prefixed by group
(`dict_senses`, `session_questions`, `photo_import_items`). Better Auth's models map onto it through
`modelName` and the Drizzle schema map; the `auth_` prefix is needed anyway because `sessions`
already holds practice sessions.

| Better Auth model | Table | Written by |
|---|---|---|
| user | `auth_users` | Better Auth |
| session | `auth_sessions` | Better Auth |
| account | `auth_accounts` | Better Auth (empty until Google sign-in) |
| verification | `auth_verifications` | Better Auth (the hashed codes) |
| — | `auth_code_sends` | our D4 limit |

Columns are snake_case. Ids are text generated by the database (`gen_random_uuid()::text`), exactly
like `users.id`, with Better Auth's own id generation off (`advanced.database.generateId: false`).
The spike proved this works with the Drizzle adapter. Drizzle Kit owns all five tables: they are
declared in `db/schema.ts` and created by a generated migration like every other table.

**D9. `users` stays the profile; a profile needs a sign-in identity.** `users` keeps its shape and
its meaning ("an onboarded person"). It gains a foreign key `users.id → auth_users.id`. Signing up
creates an `auth_users` row only; the profile is still created in exactly one place,
`repo/users.ts`, by onboarding (`POST /api/users`), with the id taken from the session. No Better
Auth hook creates a profile (Better Auth's after-hooks run after its commit, so a hook could leave
an identity without the profile it promised). Signed in without a profile means onboarding.

**D10. Existing accounts carry over, unclaimed; Victor claims his.** Migration `0022_auth` creates
the five tables, then gives every existing `users` row an `auth_users` row with the same id, the
email `<id>@unclaimed.invalid` (a reserved top-level domain that never receives mail),
`email_verified` false and the user's display name, then adds the foreign key. Every existing
account keeps its words, enrollments and progress, and nobody can sign into it yet. Victor then runs
`npm run db:claim-account -- --username vic1 --email <his>` against his main database once: a new
flag in `db/cli.ts`, beside `--reseed`, that sets the real email (lower-cased) on that user's
`auth_users` row. It fails with a clear message when the username is unknown, the email is not an
address, or the email already belongs to another `auth_users` row (Victor signed up before
claiming). (Final review, ruling 10: the claim claims only an account whose identity is still
`.invalid`, and an address held by an identity with no `users` profile is taken over — that
identity is deleted in the same transaction; only a holder with a profile is refused.) The claim leaves `email_verified` false; the first sign-in by code verifies it, and
Better Auth's `revokeUnprovenAccountAccess` (in the sign-in handler) first clears any session or
password an unverified account held. His email is not in the migration: migrations run in every lane, in CI and in every test
database, and the repo would carry his address.

**D11. One place turns a session into an actor.** `routes/actor.ts` becomes the session middleware
factory. It receives one contract, `SessionReader = { sessionOf(headers: Headers): Promise<{ userId:
string } | null> }`, which `auth/betterAuth.ts` satisfies with `auth.api.getSession`, and a
`hasProfile(userId)` check from the user service. Routes fall into three groups:

| Group | Needs | Routes | Refusal |
|---|---|---|---|
| Open | nothing | the four auth paths, `/health`, `/openapi.json`, `/docs` | — |
| Signed in | a session | `GET /api/me`, `POST /api/users` | 401 `not signed in` |
| Learner | a session and a profile | everything else under `/api` | 401, or 403 `profile required` |

The middleware sets `c.var.actor` (the user id). Handlers read it there and nowhere else; there is
no other way for a request to say who it is.

**D12. Identity comes only from the session.** The three ways a client asserts an identity today
are removed:

- the `X-Acting-User-Id` header (grants, vocabulary writes);
- `user_id` in the next-step, speech and judged-answer bodies (next-step required it and ignored
  it);
- the user id in `/users/{id}/enrollments`.

The API changes accordingly:

| Before | After |
|---|---|
| `POST /api/login` | removed. The username stays as the public handle tutors invite by |
| `POST /api/users` (anyone) | the signed-in user creates their own profile; 409 `username is already taken` or `profile exists` |
| — | `GET /api/me` → `{ email, user: User \| null }` |
| `GET/POST /api/users/{id}/enrollments` | `GET/POST /api/enrollments`, the caller's own, as `/api/grants` already is |
| `user_id` in three bodies | dropped |
| header on six routes | dropped |

**D13. Every use case is authorized against the signed-in user.** Only 6 of the 31 endpoints check
the caller today, and the other 25 answer anyone who holds an enrollment, session, photo-import or
user id; a tutor can read a student's ids from `GET /api/grants`. So every use case that touches a
learner's data takes `actorUserId` and calls ADR 0008's `authorize()` inside its transaction:

| Endpoints | Permission | Owner | Tutor |
|---|---|---|---|
| save a word | `vocabulary.add` (exists) | ✓ | ✓ |
| remove a word | `vocabulary.remove` (exists) | ✓ | – |
| word list, word detail, translate *with* `enrollment_id` | `vocabulary.read` (new) | ✓ | – |
| the 7 session endpoints | `session.practice` (new) | ✓ | – |
| the 6 photo-import endpoints | `photo_import.manage` (new) | ✓ | – |
| the 4 grant endpoints | their own rules, unchanged | | |
| translate *without* an enrollment | any learner | | |
| `GET/POST /api/enrollments` | the caller's own, by construction | | |

The three new permissions are owner-only, so `ROLE_PERMISSIONS` does not change: the tutor screen
translates without the enrollment and only saves words, which is exactly what phase 28 granted.
Session and photo-import endpoints are addressed by their own id; they load their enrollment and
authorize against it. Refusals are 403 everywhere; speech and judged-answer, which answer 404 to
another learner today, move to 403 (one check, one status). Photo-import save keeps crediting words
to the list's owner, which is now true by construction.

**D14. The OpenAPI document describes what is reachable. (after approval)** The conversation
planned to merge Better Auth's generated paths into `/openapi.json`. That generator is Better
Auth's `openAPI` plugin, a third plugin, and it documents every Better Auth endpoint, most of which
D3 does not mount. Instead, `app.ts` registers the four allow-listed paths in the OpenAPI registry
(`app.openAPIRegistry.registerPath`) with request and response schemas from `packages/core`, tagged
`auth`, so the document shows exactly what answers. A session security scheme, `sessionCookie`
(an API key in the `better-auth.session_token` cookie), is declared once and is the document's
default; the open paths declare `security: []`. `openapi.test.ts` asserts the four paths, the
scheme, and that `/api/login` is gone. ADR 0003 gains the mount as its second exception beside
`/docs`.

**D15. CORS and trusted origins come from the lane.** `cors()` (any origin) becomes an allow-list
with credentials: `WEB_ORIGINS`, a comma-separated list. `scripts/lane-env.sh` derives it for the
dev server from the lane's own values (`http://localhost:$METRO_PORT,http://$HOST:$METRO_PORT`),
and the e2e config sets it to the e2e app's URL; no port is written down anywhere (ADR 0006).
Better Auth's `trustedOrigins` are the same list plus `exp://` (Expo Go) and `langtutor://` (the
app's scheme). The phone sends no `Origin`; the `expo` server plugin turns its `expo-origin` header
into one. The web build is a test harness: it works when the page and the API share a host, which
e2e already does with `localhost` for both.

**D16. Email through Resend, from `mail.wordspal.ai`.** Victor owns `wordspal.ai`. Resend over
Amazon SES because it is one POST with an API key (no request signing, no production-access
review), free up to 100 a day and 3,000 a month, and sessions last 90 days, so most learners need a
code only on a new phone. `providers/resend.ts` is a plain `fetch` POST to `/emails`, injected like
Gemini's. Resend recommends a sending subdomain, so the domain verified in Resend is
`mail.wordspal.ai` and `MAIL_FROM` starts as `WordsPal <code@mail.wordspal.ai>` (config, changeable
any time). (Amended 2026-10-09: Victor chose the root domain, so the domain verified in Resend is
`wordspal.ai` and `MAIL_FROM` is `WordsPal <code@wordspal.ai>`. Resend's own records still sit on
subdomains, and the codes share the root's sending reputation.) The email is Hebrew, plain text plus simple HTML, and names no app (the app is still
called "lang tutor"):

- subject: `קוד הכניסה שלך: 1234 5678`
- body: `קוד הכניסה שלך הוא 1234 5678.` / `הקוד בתוקף ל-10 דקות.` / `אם לא ביקשת אותו, אפשר
  להתעלם מהמייל הזה.`

(Amended 2026-10-09: the code is one unbroken run of digits, `12345678`. Split in two, the
right-to-left lines drew the two halves in swapped order, so Victor read `2750 8997` as
`8997 2750` and his code was refused.)

If Resend refuses or does not answer within 10 seconds, the provider throws `EmailNotSent`; the
auth module turns it into 503 `email not sent`, and no `auth_code_sends` row is written. Moving to
SES later is one file in `providers/`.

**D17. Configuration fails at start-up, like Gemini's.** A new `loadAuthConfig(env)` in
`config.ts` reads, and throws on any missing value:

| Variable | Notes |
|---|---|
| `BETTER_AUTH_SECRET` | at least 32 characters; signs the session cookie. Victor generates his once (`openssl rand -base64 32`) |
| `AUTH_BASE_URL` | the server's own URL; `lane-env.sh` derives `http://$HOST:$PORT` |
| `WEB_ORIGINS` | D15 |
| `RESEND_API_KEY` | from Resend, a key that can only send, for `mail.wordspal.ai` |
| `MAIL_FROM` | D16 |
| `RESEND_BASE_URL` | optional, defaults to `https://api.resend.com`; tests point it at MockServer |

`db/cli.ts` does not call it, so `db:migrate` needs none of these. CI and e2e use dummy values and
MockServer; nothing in CI holds a real key.

**D18. The app's auth client is built at the root and passed down.** `apps/mobile/src/auth/client.ts`
exports `createAppAuthClient({ baseUrl, storage, platform })`: Better Auth's React client with
`emailOTPClient()`, plus `expoClient({ scheme: 'langtutor', storagePrefix: 'langtutor', storage })`
on native and `fetchOptions: { credentials: 'include' }` on web. It is the only mobile file that
imports `better-auth` or `@better-auth/expo` (ADR 0009 R1). `_layout.tsx` builds it with
`expo-secure-store` (imported there only; ADR 0002 R1's list gains it) and passes it down. It also
exposes `sessionHeaders()`: on native `{ cookie: await authClient.getCookie() }` (the spike's
Android fix: `getCookie()` is async, and an un-awaited one crashes the request on Android), on web
`{}` with `credentials: 'include'`. `createApiClient` receives `sessionHeaders` and `onUnauthorized`
and attaches the session to every call; the actor header and every `user_id` leave the client. New
mobile dependencies: `better-auth`, `@better-auth/expo`, `expo-secure-store` and `expo-network`
(the Expo client's peer), at the SDK 57 versions from `bundledNativeModules.json`. All four run in
Expo Go; the spike confirmed it on Victor's Android phone.

**D19. The app's start-up and screens.**

- **Start-up:** with a stored session the app calls `GET /api/me`: a profile → home; no profile →
  onboarding; 401 → sign-in. A network error signs nobody out: the screen offers a retry.
- **Sign-in** (`app/sign-in.tsx`, replacing `app/login.tsx`): an email field and "Send code", with
  "New here? The same code signs you up" under the button.
- **The code** (`app/sign-in-code.tsx`): an 8-digit field on the number pad, "We sent a code to
  x@y — check spam too", "Send a new code" unlocked after 30 seconds, and "Use a different email".
  Errors have plain messages, keyed on Better Auth's codes: `INVALID_OTP` (400) → wrong code, try
  again; `OTP_EXPIRED` (400) or `TOO_MANY_ATTEMPTS` (403) → send a new code; 429 → too many codes,
  try again later; 503 → the email could not be sent, try again. Better Auth does not report how
  many tries remain, so the screen does not either.
- **Onboarding** is the same form (username, display name, age, native language). It creates the
  profile for the signed-in user, then goes on to enroll.
- **Profile:** "Switch user" becomes "Sign out": it revokes the session, clears the app's state and
  goes to sign-in.
- **A 401 at any point** (an expired or revoked session) clears the app's state and goes to
  sign-in, through `onUnauthorized`.
- **Gone:** the remembered-username store and `login(username)`. The remembered-enrollment store
  stays, keyed by username, which still exists, so `vic1` keeps its active list.
- All new text is in Hebrew, in `strings.ts`.

**D20. ADR 0009, "Sign-in with Better Auth, behind one seam", supersedes ADR 0005.** Its checkable
rules:

| # | Rule |
|---|---|
| R1 | `better-auth` / `@better-auth/*` is imported only in `apps/server/src/auth/betterAuth.ts` and `apps/mobile/src/auth/client.ts` |
| R2 | the five `auth_*` tables are named only in `db/schema.ts`, `auth/betterAuth.ts` and `repo/auth.ts` |
| R3 | the session is read only in `routes/actor.ts` (`sessionOf(` appears nowhere else in `routes/` or `services/`), and `x-acting-user-id` appears nowhere in either app |
| R4 | `better-auth` and `@better-auth/expo` are pinned to an exact version in every `package.json` |
| R5 | no other authentication dependency in any `package.json` (passport, jose, jsonwebtoken, bcrypt, argon2, Clerk, Supabase, Firebase, Amplify, SuperTokens) — carried over from ADR 0005 R3 |
| R6 | `insert(users)` only in `repo/users.ts` — carried over from ADR 0005 R2 |

And rules enforced by tests and review: R7, every use case that touches a learner's data takes
`actorUserId` and calls `authorize` (the stranger matrix test, §3); R8, Better Auth mounts only the
`emailOTP` and `expo` plugins with password sign-in off, and only D3's four paths (the flow test
asserts the rest are 404); R9, the upgrade policy and switch signals of D1. It records the accepted
risks (D4's nuisance wait, D6's plain tokens, D5's limiter off until hosting) and the hosting
phase's obligations. Every check is planted first (CLAUDE.md). Amendments:

- **ADR 0001:** a row for `auth/`: may import `better-auth`, `@better-auth/*`, `db/schema`, `db/client`
  types, `repo/auth`, `errors` and `logger`; only `composition.ts` imports it, as with `providers/`.
- **ADR 0002:** `expo-secure-store` joins R1's mobile list; the new factories join R6's list.
- **ADR 0003:** the allow-listed `/api/auth/*` mount in `app.ts` is the second exception to R1,
  beside `/docs`; its paths are published through the registry (D14).
- **ADR 0005:** status Superseded by 0009; its check script is deleted (`check-adrs.sh` discovers
  scripts, so nothing else changes).
- **ADR 0008:** R2 now says the actor comes from the session, and the header is forbidden
  everywhere; R4 widens to every use case (now ADR 0009 R7); R5 ("nothing treats the actor as
  authenticated") is retired; the diagram's first box becomes the session.

**D21. Logs.** `auth_code_sent` and `auth_code_refused` (`reason: 'limit' | 'invalid_domain' |
'type'`) carry no email and no code; `account_created` and `signed_in` carry the user id (Better
Auth database hooks on user and session creation); `email_not_sent` carries Resend's status.
`profile_created` replaces `user_registered`. No log line ever carries a code, a token or a cookie.

### Deviations from the conversation

D3 (the allow-list), D5 (limiter off, no `auth_rate_limits` table) and D14 (our own registry
entries instead of the `openAPI` plugin) were decided after Victor's approval, from reading Better
Auth 1.7.7's installed source. Each narrows what is reachable; none adds a dependency or a plugin.

## 2. Changes

### Data (migration `0022_auth.sql`, generated by `drizzle-kit generate`, then edited)

- `auth_users(id text pk default gen_random_uuid()::text, name text not null, email text not null
  unique, email_verified boolean not null default false, image text, created_at, updated_at)`
- `auth_sessions(id text pk, expires_at, token text not null unique, created_at, updated_at,
  ip_address text, user_agent text, user_id text not null → auth_users on delete cascade)`, index on
  `user_id`
- `auth_accounts(id, account_id, provider_id, user_id → auth_users on delete cascade, access_token,
  refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password,
  created_at, updated_at)`, index on `user_id`
- `auth_verifications(id, identifier, value, expires_at, created_at, updated_at)`, index on
  `identifier`
- `auth_code_sends(id text pk, email text not null, sent_at timestamptz not null default now())`,
  index on `(email, sent_at)`
- Backfill (hand-written into the generated file, after the tables): one `auth_users` row per
  `users` row, D10.
- `users.id` gains `references auth_users(id)` (no cascade: deleting accounts is out of scope).

Columns follow Better Auth 1.7.7's model fields exactly (camelCase in the Drizzle schema, snake_case
in SQL); the spike's `authSchema.ts` is the starting point, renamed to the plural tables.

### `packages/core`

- `api/schemas.ts`: `MeResponseSchema { email, user: UserSchema.nullable() }`; the auth path schemas
  D14 publishes, matching Better Auth 1.7.7's handlers: `SendCodeRequestSchema { email, type:
  'sign-in' }` → `{ success: boolean }`; `SignInWithCodeRequestSchema { email, otp }` → `{ token,
  user: { id, email, name, emailVerified, image, createdAt, updatedAt } }`; get-session → `{
  session, user } | null`; sign-out → `{ success: boolean }`; Better Auth's error body `{ code,
  message }`. `LoginRequestSchema` removed;
  `user_id` removed from `NextStepRequestSchema`'s three branches, `SpeechAnswerRequestSchema` and
  `JudgedAnswerRequestSchema`. Types follow in `types.ts` and `index.ts`.

### Server

- `src/auth/betterAuth.ts` (new): `createAuth({ db, secret, baseUrl, trustedOrigins, sendCode,
  codeSends, logger })` returning `{ handler, sessionOf, allowedPaths }`; the only `better-auth`
  import; D2–D8, D21's hooks.
- `src/providers/resend.ts` (new): `createResendMailer({ fetch, baseUrl, apiKey, from, timeoutMs })`
  → `{ sendSignInCode(email, code) }`.
- `src/repo/auth.ts` (new): `countRecentSends`, `recordSend`, `pruneSends` (the D4 table) and
  `claimAccount` (D10). The one place our code writes `auth_*` tables.
- `src/routes/actor.ts`: the session middleware factory (D11); `ACTOR_HEADER` and
  `ActorHeadersSchema` deleted.
- `src/routes/me.ts` (new): `GET /api/me`.
- `src/routes/users.ts`: login removed; create-profile takes the actor.
- `src/routes/enrollments.ts`: paths lose `/users/{id}`.
- Every other router: reads `c.var.actor` and passes it down; no header, no body `user_id`.
- `src/services/*`: every use case in D13's table gains `actorUserId` and its `authorize` call;
  `users.register` becomes `users.createProfile(actorUserId, input)`; `users.me(actorUserId)`;
  `users.hasProfile(userId)`.
- `src/domain/access.ts`: `vocabulary.read`, `session.practice`, `photo_import.manage`.
- `src/app.ts`: CORS allow-list; the four auth paths mounted and registered (D3, D14); the session
  middleware on `/api/*` after the open paths; `sessionCookie` security scheme.
- `src/composition.ts`: builds the mailer, the auth module and the session reader; `AppDeps` gains
  `auth: { handler, allowedPaths }` and `sessions: SessionReader` (name it `signedIn` to avoid the
  practice `sessions` service).
- `src/config.ts`: `loadAuthConfig` (D17).
- `src/index.ts`: reads it and passes it in.
- `src/db/cli.ts`: `--claim-account` with `--username` and `--email`.
- `apps/server/jest.config.js`: `'\\.mjs$': 'babel-jest'` in each project's `transform` (the spike's
  one line; better-auth is ESM-only).
- `src/errors.ts`: `EmailNotSent`, `ProfileExists`.

### Mobile

- `src/auth/client.ts` (new): D18.
- `src/api/client.ts`: `sessionHeaders` and `onUnauthorized` received; actor header removed; `me`,
  `createProfile`; enrollment paths changed; `user_id` removed from the session calls.
- `src/hooks/useCurrentUser.tsx`: `login` and the username store removed; `start()` (the `me` call),
  `sendCode`, `signIn`, `createProfile`, `signOut` (revokes); the 401 path.
- `src/hooks/useSession.tsx`: no `userId` in request bodies.
- `src/app/sign-in.tsx`, `src/app/sign-in-code.tsx` (new); `src/app/login.tsx` removed;
  `src/app/index.tsx`, `onboarding.tsx`, `profile.tsx` adjusted; `src/strings.ts`.
- `src/currentUser.ts`: `createRememberedUsernameStore` removed.
- `src/app/_layout.tsx`: builds the auth client with SecureStore; passes it to the API client and the
  provider.

### e2e

- `e2e/tests/support/mockServer.ts`: `expectEmails()` (200 for `POST /<ns>/emails`) and
  `codeFor(email)` (`PUT /mockserver/retrieve?type=REQUESTS&format=JSON`, the latest request to
  `/emails` whose `to` is that address, the 8 digits from its subject).
- `e2e/tests/support/users.ts`: `signUpLearner(page, …)` and `signUpUser(request, …)` through
  `page.request` / a request context: send a code, read it, sign in, create the profile, enroll.
  `page.request` shares the browser context's cookies, so the app opens signed in. `createUser`,
  `createLearner` and `logIn` are replaced.
- `e2e/playwright.config.ts`: the server gets `BETTER_AUTH_SECRET` (a fixed test value),
  `AUTH_BASE_URL` (the API URL), `WEB_ORIGINS` (the app URL), `RESEND_API_KEY: 'e2e'`,
  `RESEND_BASE_URL` (the lane's MockServer namespace) and `MAIL_FROM`.
- Every spec that used `createLearner` + `logIn` moves to `signUpLearner`; `tutor.spec.ts` signs the
  student and the tutor in as two request contexts.
- `e2e/tests/sign-in.spec.ts` (new) absorbs `onboarding.spec.ts` (§3).

### Scripts, docs and CI

- `scripts/lane-env.sh`: exports `AUTH_BASE_URL` and `WEB_ORIGINS` (derived, D15/D17).
- `scripts/check-adr-0009-sign-in.sh` (new); `scripts/check-adr-0005-*.sh` deleted.
- `docs/adr/adr-0009-sign-in.md` (new) and the amendments in D20.
- `README.md`: the new variables, Victor's one-time Resend and DNS setup, and the claim command.
- `.github/workflows/ci.yml`: nothing for integration tests (they construct config directly); the
  e2e job needs nothing either, because `playwright.config.ts` sets the server's variables.

## 3. Testing

### Unit (`src`, no database)

- The session middleware with a fake `SessionReader` and `hasProfile`: no session → 401; signed in
  without a profile on a learner route → 403 `profile required`; on a signed-in route it passes;
  otherwise it sets `actor`.
- `domain/access.ts`: the three new permissions are owner-only; a tutor still has only
  `vocabulary.add`.
- The send rule as a pure function, `mayRequestCode(recentSends, now)`: 4, 5 and 6 sends, and the
  edge of the hour; `isDeliverable(email)` refuses `.invalid`.
- `providers/resend.ts` with a fake `fetch`: URL, bearer key, `from`, `to`, the code in the subject
  and the Hebrew body; a non-2xx answer and a timeout become `EmailNotSent`.
- `loadAuthConfig`: each missing variable throws, a short secret throws, `RESEND_BASE_URL` defaults.

### Integration (real Postgres)

- **The whole code flow, the upgrade gate** (`tests/integration/auth/flow.test.ts`), through the
  real Better Auth handler built by `createAuth` with a `sendCode` that keeps codes in memory: a new
  email creates an `auth_users` row and no profile; the code is 8 digits and stored hashed (the
  `auth_verifications.value` is not the code); 3 wrong tries, then even the right code is refused; a
  code works once; a new code cancels the old; sign-out revokes the session; `get-session` without a
  cookie is empty; ids are database-generated text in the `auth_*` tables; the 6th send in an hour
  is 429 and writes nothing; a failed send is 503 and is not counted; a `.invalid` address is 400;
  a non-`sign-in` type is 400; a path outside D3's four answers 404 (`/api/auth/update-user`,
  `/api/auth/sign-up/email`, `/api/auth/email-otp/reset-password`, `/api/auth/list-sessions`).
- **The three matrix tests** (`tests/integration/auth/matrix.test.ts`), through `createApp` with
  full deps and real sign-ins:
  1. *No session*: every operation in `/openapi.json` outside the open group answers 401.
  2. *Stranger*: user B, with a profile, calls every operation that has a path id with user A's ids;
     each answers 403 and writes nothing (row counts unchanged). Every operation in the document must
     have a fixture here, or the test fails, so a future endpoint cannot skip the check.
  3. *Tutor*: with an accepted grant, saving a word passes; every other operation on the student's
     ids answers 403.
- **The migration** (`db/migrations.test.ts`, the existing style): migrate to just before
  `0022_auth`, insert two users with words, run it; each user has an `auth_users` row with the same
  id and an `@unclaimed.invalid` email, the foreign key holds, the words are untouched.
- **`db:claim-account`**: claims; an unknown username, a malformed email, and an email that belongs
  to another account each fail with a clear message and change nothing.
- **`openapi.test.ts`**: the four auth paths are published, `sessionCookie` is the default scheme,
  the open paths declare `security: []`, `/api/login` is gone; ADR 0005's login-description
  assertion is removed.
- **Existing route tests** keep mounting one router at a time; a test helper `asUser(id)` in
  `tests/support/` sets `actor` directly. The real session path is covered by the flow and matrix
  tests. Tests that asserted 404 for another learner (speech, judge) now assert 403.
- **`seedUser`** inserts an `auth_users` row, then the `users` row.

### E2E (Playwright)

- `sign-in.spec.ts`: sign up through the UI with the code from MockServer, onboard, enroll, save a
  word; sign out; sign back in with a new code; the word is still there (done-means 3 and 4); a
  wrong code shows the error; with no session the app opens on sign-in.
- Every existing spec passes on `signUpLearner`; `tutor.spec.ts` on two signed-in contexts.

### Architecture

- `npm run lint:arch` runs ADR 0009's script; every new check is planted first.

### By hand, on Victor's Android phone after merging (done-means 3, 4, 5)

Set up Resend (`mail.wordspal.ai`, its SPF and DKIM records, optionally `_dmarc.wordspal.ai`
`p=none`, a send-only API key) and the variables in D17; sign up with a real email; restart the
app and still be signed in; sign out and back in; run the claim command for `vic1` and sign in as
`vic1` with its words intact.

## Build order

One PR (one line of work, never stacked). Each step leaves the suites green:

1. Dependencies (exact pins), Jest's `.mjs` transform, `loadAuthConfig`, the Resend provider.
2. Schema, migration `0022_auth`, migration test, `seedUser`, `repo/auth.ts`, the claim command.
3. `auth/betterAuth.ts` and the flow test.
4. Server wiring: mount, CORS, registry entries, session middleware, `/api/me`, profile creation,
   login removed; route tests on `asUser`.
5. The wire contract changes in `packages/core` and their routes.
6. Authorization in every use case, the new permissions, and the matrix tests.
7. ADR 0009, its script, the amendments, ADR 0005's script deleted.
8. Mobile: dependencies, auth client, API client, `useCurrentUser`, screens, strings.
9. e2e: MockServer helpers, `signUpLearner`, every spec moved, `sign-in.spec.ts`.
10. README and `lane-env.sh`.

## Risks

- **Better Auth churn (D1).** Mitigated by the exact pin, the flow test as the upgrade gate, and the
  switch signals in ADR 0009.
- **Session tokens in plain form (D6).** Accepted; backups are secrets.
- **A shared-bucket limiter if someone turns it on before hosting (D5).** ADR 0009 says why it is
  off; the flow test would show sign-ins throttling each other.
- **The web cookie needs the page and the API on one host.** True in e2e (`localhost`); the web
  build is a harness only. If web becomes a product surface, revisit (cross-site cookies, CSRF).
- **Resend's free tier caps at 100 a day.** A busy day returns 503 `email not sent`; the answer is
  the $20 plan or SES, one file each.
- **Master moves mid-build.** A sibling phase can merge a migration numbered 0022; renumber at merge
  and repair the lane database, as phase 28 did.
- **The matrix test is only as complete as its fixtures.** It fails on any operation without one,
  which is the point; its cost is that every future endpoint adds a fixture.

## Obligations for the hosting phase

Before the app is public: switch on Better Auth's rate limiter with `storage: 'database'` (adding
`auth_rate_limits`) and `trustedProxies` for the real proxy; add a per-IP limit on sending codes;
serve the API over HTTPS (Better Auth then marks the cookie `Secure`); move `BETTER_AUTH_SECRET` and
`RESEND_API_KEY` into the host's secret store.
