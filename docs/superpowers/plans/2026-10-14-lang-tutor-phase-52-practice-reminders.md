# Phase 52 — Practice reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server pushes daily practice reminders to the Android app at the learner's hours, in the learner's time zone, until the daily target is met. Every decision is recorded, and taps and the sessions that follow are marked on it.

**Architecture:** An EventBridge rule posts to an internal route every 5 minutes. The route enqueues one pg-boss job. The job's use case picks due slots with pure domain functions, claims each one, decides, sends through a plain-fetch Expo push provider, and records the outcome. The app registers its Expo push token after the permission is granted, reports its time zone, and has a Reminders screen.

**Tech Stack:** Hono + zod-openapi, Drizzle/Postgres, pg-boss, Jest, MockServer, Expo SDK 57 (`expo-notifications`), Playwright (web e2e), Terraform (AWS EventBridge).

**Spec:** `docs/superpowers/specs/2026-10-14-lang-tutor-phase-52-practice-reminders-design.md`. Read it before your task: decisions D1–D10 are referenced by number below.

## Global Constraints

- **The worktree.** Work only in `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-52-practice-reminders`. Start every shell command with `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-52-practice-reminders && …`. Never read, write or run anything in `/Users/victorprp/git/lang-tutor` outside `.claude/worktrees/`.
- **Tests.** This worktree has **no lane** (all 9 slots are taken). Run unit tests (`npx jest --selectProjects=unit <path>` in `apps/server`, `npx jest <path>` in `apps/mobile`), `npx tsc --noEmit -p <workspace>` and `./scripts/check-adrs.sh` locally. Integration tests and e2e are written here and run in CI only. Never try to free a lane, and never write `.lane`.
- **ADRs.** All of `docs/adr/` binds. The ones in play:
  - 0001: services own transactions, and depend on a contract type for providers.
  - 0002: closures; `expo-notifications` only in `_layout.tsx`; no `process.env` outside composition roots; no defaulted collaborator parameters.
  - 0003: every endpoint through `createRoute`.
  - 0007: enqueue only through `repo/jobs.ts`, `.work(` only in `worker.ts`.
  - 0009 R5: no `firebase` npm package.
  - 0013: only `services/learnerDay.ts` computes a progress day.
- **Fixed values.**
  - Defaults: `enabled: true`, `daily_target: 1`, `days: [1,2,3,4,5,6,7]`, `times: ['13:00','17:00','20:00','22:00']`.
  - Catch-up window: 30 minutes.
  - Channel id `reminders`. Title `הגיע הזמן לתרגל`, body `כמה דקות עכשיו, והמילים נשארות בזיכרון.` (ruled Hebrew in Task 9)
  - Queue `remind` with singleton key `remind`.
  - Secret env `REMINDER_SECRET` (at least 32 characters). Base URL env `PUSH_BASE_URL`, default `https://exp.host`.
  - `API_LEVEL` stays 3.
- **Commits.** Commit after each green step group with a conventional message (`feat(server): …`, `feat(mobile): …`, `infra: …`, `docs(adr): …`). End each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use the word "eval" in a command line.
- **Migrations.** Generate with `npm run db:generate -w apps/server` after editing `schema.ts`, then rename the generated file to the stated name and update `meta/_journal.json`'s tag to match. New columns need defaults, because the old container runs for about a minute after the migration (ADR 0010).

## Review Focus

1. **One learner's stored time zone is invalid.** The tick logs and skips that learner, and the rest are still reminded. (Task 6)
2. **A push call fails for one learner.** Their row is `failed` with the error, and the next learner in the same tick is still sent. (Task 6)
3. **A learner never reported a time zone** (an old app, or the web before it reports). Reminders follow UTC hours, and nothing crashes. (Task 2)
4. **`enabled: false`, or an empty `days`.** No row is claimed at all. (Tasks 2 and 6)
5. **A tap with a malformed id** (`not-a-uuid`) answers 404, not 500, as does someone else's reminder. (Task 4)

---

### Task 1: The learner clock and the learner's time zone (D1)

**Files:**
- Create: `apps/server/src/domain/learnerClock.ts`, `apps/server/src/domain/learnerClock.test.ts`
- Modify:
  - `apps/server/src/db/schema.ts`: `users.time_zone text not null default 'UTC'`
  - migration `0035_user_time_zone.sql`
  - `apps/server/src/repo/users.ts`: `findDayContext` returns `{ kind: 'learner', timeZone }`; add `setTimeZone(userId, timeZone)`
  - `apps/server/src/services/learnerDay.ts`
  - `apps/server/src/services/users.ts`: `setTimeZone(actorUserId, timeZone)`, throwing a 400-mapped error for an invalid zone (reuse the existing invalid-request error in `errors.ts`)
  - `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts`: `TimeZoneRequestSchema = z.object({ time_zone: z.string().min(1).max(64) })`
  - `apps/server/src/routes/me.ts`: `PUT /me/time-zone`, which answers 204
  - `docs/adr/adr-0013-learner-day.md`: amend the Decision and its date line, saying the day is the date in `users.time_zone` and that `domain/learnerClock.ts` holds the formula. R1–R3 are unchanged.
- Test:
  - `apps/server/tests/integration/services/learnerDay.test.ts`: add a learner in `Pacific/Auckland` whose UTC date differs
  - `apps/server/tests/integration/routes/users.test.ts` (or a new `me.test.ts`): 204, 400 for `Mars/Olympus`, 401 without a session

**Interfaces — Produces:**

```ts
// domain/learnerClock.ts — pure, no Date.now / new Date() (ADR 0001 R3)
export function isTimeZone(name: string): boolean;               // new Intl.DateTimeFormat('en-US', { timeZone }) does not throw
export function dayInTimeZone(now: number, timeZone: string): string;   // 'YYYY-MM-DD'
export function localMinutes(now: number, timeZone: string): number;   // 0..1439
export function isoWeekday(now: number, timeZone: string): number;     // 1 = Monday … 7 = Sunday
```

Implement all three from one `Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(now))`.

- [ ] Step 1: Write `learnerClock.test.ts`:
  - `dayInTimeZone(Date.UTC(2026,9,14,22,30), 'Asia/Jerusalem') === '2026-10-15'`
  - the same instant in `America/New_York` is `'2026-10-14'`
  - `localMinutes` there is `18*60+30`
  - `isoWeekday(Date.UTC(2026,9,18,12), 'UTC') === 7` (a Sunday)
  - New York across the 2026-11-01 daylight-saving change: 05:30Z is 01:30 local and 06:30Z is 01:30 local
  - `isTimeZone('UTC')` is true and `isTimeZone('Mars/Olympus')` is false

  Run it and see it fail.
- [ ] Step 2: Implement `learnerClock.ts` and see it pass.
- [ ] Step 3: Make the schema change and generate migration 0035. Change `findDayContext` and `learnerDay` (learner → `dayInTimeZone(now, context.timeZone)`). Check that `./scripts/check-adrs.sh` still passes; R1 forbids `.toISOString().slice(0, 10)` outside `learnerDay.ts`, so that function stops using it entirely.
- [ ] Step 4: Add the wire schema, the service method and the route, then the integration tests (CI only). Run `npx tsc --noEmit -p apps/server` and `-p packages/core`.
- [ ] Step 5: Amend ADR 0013 and commit.

### Task 2: The reminder rules, pure (D2, D3, D5, D6)

**Files:**
- Create: `apps/server/src/domain/reminders.ts`, `apps/server/src/domain/reminders.test.ts`

**Interfaces:**
- Consumes: `localMinutes`, `isoWeekday`, `dayInTimeZone` from Task 1.
- Produces:

```ts
export type ReminderSettings = { enabled: boolean; dailyTarget: number; days: number[]; times: string[] };
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings; // the fixed values in Global Constraints
export const CATCH_UP_MINUTES = 30;
export const REMINDER_CHANNEL = 'reminders';
export const REMINDER_TITLE = 'הגיע הזמן לתרגל';
export const REMINDER_BODY = 'כמה דקות עכשיו, והמילים נשארות בזיכרון.';
export type DueSlot = { localDay: string; slot: string };   // slot 'HH:MM'
export function normalizeSettings(s: ReminderSettings): ReminderSettings; // days and times sorted and distinct
export function dueSlots(settings: ReminderSettings, timeZone: string, now: number): DueSlot[];
export type Decision = { kind: 'send' | 'skip_target_met'; evidence: { completed_today: number; daily_target: number; time_zone: string; devices: number } };
export function decide(input: { completedToday: number; dailyTarget: number; timeZone: string; devices: number }): Decision;
export type MarkCandidate = { id: string; decidedAt: number; sessionId: string | null };  // sent reminders of the day
export function reminderForSession(candidates: MarkCandidate[], now: number): string | null;
```

- **`dueSlots`:** returns `[]` when `!enabled` or when today's `isoWeekday` is not in `days`. Otherwise it returns each time `t` with `0 <= localMinutes − minutes(t) < 30`, together with `localDay = dayInTimeZone(now, tz)`.
- **`decide`:** returns `skip_target_met` when `completedToday >= dailyTarget`, and `send` otherwise.
- **`reminderForSession`:** takes the candidate with the largest `decidedAt <= now`. It returns that candidate's id when its `sessionId` is null, and `null` otherwise, including when there are no candidates.

- [ ] Step 1: Write the tests:
  - 13:00 with now at 13:00, 13:29 and 13:30 (the last is not due)
  - now at 12:59 (not due)
  - a disabled weekday, and `enabled: false`
  - the default settings with `'UTC'`
  - two slots inside one window (`13:00` and `13:15` at 13:20)
  - `decide` at the boundary (1 of 1 skips, 0 of 1 sends)
  - `reminderForSession`: the latest before now wins; a later one after `now` is ignored; the latest already marked gives `null` even when an earlier one is unmarked; an empty list
  - `normalizeSettings` sorts and dedupes

  Run them and see them fail.
- [ ] Step 2: Implement, see the tests pass, and commit.

### Task 3: Persistence — the three tables and their repository (D2, D4, D6)

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/services/transaction.ts` (`Repos.reminders`), and the place `composition.ts` builds the repos `bind`
- Create:
  - migration `0036_reminders.sql`
  - `apps/server/src/repo/reminders.ts`
  - `apps/server/tests/integration/repo/reminders.test.ts`

**Tables (D2, D4, D6):**
- `reminder_settings`: `user_id text pk references users(id) on delete cascade`, `enabled boolean not null`, `daily_target smallint not null`, `days smallint[] not null`, `times text[] not null`, `updated_at timestamptz not null default now()`
- `push_devices`: `token text pk`, `user_id text not null references users on delete cascade`, `platform text not null`, `created_at` and `last_seen_at timestamptz not null default now()`, and an index on `user_id`
- `reminders`:
  - `id uuid pk default gen_random_uuid()`
  - `user_id text not null references users on delete cascade`
  - `local_day date not null`, `slot text not null`
  - `decided_at timestamptz not null default now()`
  - `outcome text not null` (check `in ('claimed','sent','skip_target_met','failed')`)
  - `evidence jsonb not null default '{}'`
  - `tickets jsonb`, `receipts jsonb`, `receipts_checked_at timestamptz`, `tapped_at timestamptz`
  - `session_id text` (no foreign key)
  - unique `(user_id, local_day, slot)`, and an index on `(user_id, local_day)`

  Match the users id column type, which is `text` in `schema.ts`.

**Interfaces — Produces** (`createReminderRepo(tx)`, type `ReminderRepo = ReturnType<…>`, each function one persistence step per ADR 0001 R9):

```ts
getSettings(userId): Promise<ReminderSettings | null>;
putSettings(userId, s: ReminderSettings): Promise<void>;                 // upsert
upsertDevice({ token, userId, platform }): Promise<void>;                // reassigns the owner, bumps last_seen_at
deleteDevice({ token, userId }): Promise<void>;                          // only the caller's own token
deleteDevicesByToken(tokens: string[]): Promise<void>;
candidates(): Promise<{ userId: string; timeZone: string; settings: ReminderSettings | null; tokens: string[] }[]>; // users with ≥1 device
claim({ userId, localDay, slot }): Promise<string | null>;               // insert outcome 'claimed' ON CONFLICT DO NOTHING RETURNING id
countCompletedOnDay(userId, day): Promise<number>;                       // sessions completed, practice_day = day, across enrollments the user owns
record(id, { outcome, evidence, tickets }): Promise<void>;
markTapped({ id, userId, at }): Promise<boolean>;                        // false when it isn't theirs or doesn't exist; sets tapped_at only if null
sentOnDay(userId, day): Promise<MarkCandidate[]>;
markSession(id, sessionId): Promise<void>;
awaitingReceipts({ olderThan, newerThan }): Promise<{ id: string; tickets: unknown }[]>;
recordReceipts(id, receipts: unknown, at): Promise<void>;
```

- [ ] Step 1: Write the repository integration test:
  - the settings round trip
  - device re-assignment between two users
  - `deleteDevice` refuses another user's token
  - `claim` twice gives an id, then `null`
  - `countCompletedOnDay` counts completed sessions and not skipped ones, across two enrollments, using the existing session seed helpers in `tests/support`
  - `markTapped` for a stranger is false
  - `candidates` leaves out users without devices
- [ ] Step 2: Make the schema change, generate migration 0036, write the repository, and register it in `Repos`. Run `tsc`. The integration test runs in CI.
- [ ] Step 3: Run `./scripts/check-adrs.sh` and commit.

### Task 4: Learner endpoints — settings, devices, tap (D2, D4, D6, D10)

**Files:**
- Modify:
  - `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts`
  - `apps/server/src/composition.ts` (`AppDeps.reminders`)
  - `apps/server/src/app.ts`: mount after the session middleware, with the other `/api` routers
- Create:
  - `apps/server/src/services/reminders.ts`, holding the learner use cases now and `tick` in Task 6
  - `apps/server/src/routes/reminders.ts`
  - `apps/server/tests/integration/routes/reminders.test.ts`

**Wire:**

```ts
export const ReminderSettingsSchema = z.object({
  enabled: z.boolean(),
  daily_target: z.number().int().min(1).max(10),
  days: z.array(z.number().int().min(1).max(7)).max(7),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(8),
});
export const ReminderSettingsResponseSchema = ReminderSettingsSchema.extend({ time_zone: z.string() });
export const PushDeviceRequestSchema = z.object({ token: z.string().min(1).max(256), platform: z.literal('android') });
export const PushDeviceUnregisterRequestSchema = z.object({ token: z.string().min(1).max(256) });
```

**Routes** (all `createRoute`, all on the signed-in actor):
- `GET /me/reminders` → 200, the response schema (defaults when there is no row)
- `PUT /me/reminders` → 200, the normalized settings plus the time zone
- `PUT /me/push-devices` → 204
- `POST /me/push-devices/unregister` → 204
- `POST /me/reminders/{id}/tap` → 204, or 404 `{ error: 'not found' }` when `markTapped` is false or the id is not a uuid. Validate the path param as `z.string()` and check it in the service with a uuid regex, so a malformed id never reaches Postgres.

**Service — Produces:** `createReminderService({ transaction, push, logger, now })` returns `{ settings(actorUserId), putSettings(actorUserId, s), registerDevice(actorUserId, { token, platform }), unregisterDevice(actorUserId, token), tap(actorUserId, id), requestTick(), tick() }`. `push`, `requestTick` and `tick` arrive in Task 6; for now declare `push` as a `PushSender` type that Task 5 creates, or leave those members out until Task 6 and add them there. The settings use cases run `normalizeSettings` before writing.

- [ ] Step 1: Write the route integration tests:
  - no session → 401 on each route
  - GET defaults
  - PUT then GET round trip (unsorted input comes back sorted)
  - 400 for `times: ['25:00']` and for `daily_target: 0`
  - device register, then a second user registering the same token takes it over
  - unregister
  - tap your own → 204 and `tapped_at` set (seed a reminder row through the repo helper in `tests/support`)
  - tap someone else's → 404
  - tap `not-a-uuid` → 404
- [ ] Step 2: Implement the schemas, service, routes and mount. Run `tsc`, the unit tests and `check-adrs`, then commit.

### Task 5: The Expo push provider and its configuration (D7)

**Files:**
- Create: `apps/server/src/providers/expoPush.ts`, `apps/server/src/providers/expoPush.test.ts`
- Modify:
  - `apps/server/src/errors.ts`: `PushUnavailable`
  - `apps/server/src/services/reminders.ts`: export the contract types below
  - `apps/server/src/config.ts`: `pushBaseUrl` from `PUSH_BASE_URL`; `loadReminderSecret(env): string | null`, copying `loadBotSecret` (null when unset, throws when under 32 characters)
  - `apps/server/src/index.ts`, `composition.ts`: build the client and pass `push` to the reminder service
  - `apps/server/tests/support/serverDeps.ts`: `pushBaseUrl?`, defaulting to the unroutable `http://127.0.0.1:9/never-registered` like `mailBaseUrl`
  - `apps/server/tests/support/mockServer.ts`: `pushBaseUrlFor(ns)`, `stubPushSend(ns, tickets)`, `stubPushReceipts(ns, receipts)`, `pushSends(ns)`
  - `e2e/serverEnv.ts`: `PUSH_BASE_URL` set to MockServer's namespace like `RESEND_BASE_URL`
  - `scripts/image-run.sh`: pass and rewrite `PUSH_BASE_URL` like `RESEND_BASE_URL`

**Contract (in `services/reminders.ts`):**

```ts
export type PushMessage = { to: string; title: string; body: string; channelId: string; data: Record<string, string> };
export type PushTicket = { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } };
export type PushReceipt = { status: 'ok' } | { status: 'error'; message: string; details?: { error?: string } };
export type PushSender = {
  send(messages: PushMessage[]): Promise<PushTicket[]>;                 // same order as messages
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
};
```

**Provider:** `createExpoPushClient({ fetch, baseUrl, timeoutMs })`, annotated as `PushSender` at its call site in `composition.ts` (ADR 0002 R6 note). It posts JSON arrays of at most 100 to `${baseUrl}/--/api/v2/push/send` and reads `{ data: PushTicket[] }`. It posts `{ ids }` in chunks of at most 1000 to `${baseUrl}/--/api/v2/push/getReceipts` and reads `{ data: Record<id, PushReceipt> }`. It sends `accept: application/json` and `content-type: application/json`. A non-2xx response, a timeout, a network error or a body without `data` throws `PushUnavailable`. Use `AbortSignal.timeout(timeoutMs)`, with `PUSH_TIMEOUT_MS = 10_000` exported.

- [ ] Step 1: Write the provider unit tests against a fake `fetch`:
  - 150 messages make two calls of 100 and 50, and the tickets are concatenated in order
  - the URL path and headers
  - a 500, a thrown fetch and a missing `data` each throw `PushUnavailable`
  - receipts are merged across chunks
- [ ] Step 2: Implement the provider, config and wiring, plus the test-support and e2e/image plumbing. Run `tsc`, the unit tests and `check-adrs`, then commit.

### Task 6: The tick — internal route, job, use case (D5, D6, D9's server side)

**Files:**
- Modify:
  - `apps/server/src/domain/jobs.ts`: `REMIND = 'remind'`, `REMIND_EXPIRY_SECONDS = 240`, an empty payload schema
  - `apps/server/src/db/jobs.ts`: queue `remind`, policy `exclusive`, `retryLimit: 0`
  - `apps/server/src/worker.ts`: `REMIND` → `reminders.tick()`
  - `apps/server/src/services/reminders.ts`: `requestTick`, `tick`
  - `apps/server/src/app.ts`: before the session middleware, `if (deps.reminderTick) app.route('/api', createInternalRemindersRouter(...))`, then `app.all('/api/internal/*', c => c.json({ error: 'not found' }, 404))`
  - `composition.ts` and `index.ts`: `reminderTick: io.reminderSecret ? { secret, service } : null`
  - `docs/adr/adr-0003-openapi-wire-contract.md`: R1's exception gains the `/api/internal/*` 404, with a "What the rules cover" bullet and the date line
- Create:
  - `apps/server/src/routes/internalReminders.ts`, which copies `routes/bots.ts`'s secret check: a SHA-256 plus `timingSafeEqual` bearer check, 401 `{ error: 'unauthorized' }`, and one log line without the secret
  - `apps/server/tests/integration/routes/internalReminders.test.ts`
  - `apps/server/tests/integration/services/reminders.tick.test.ts`

**Use cases:**
- `requestTick()` is one `transaction(r => r.jobs.enqueue(REMIND, {}, { singletonKey: 'remind' }))`. The route answers 202 `{ queued: true }`.
- `tick()`, with `const at = now()`:
  1. `candidates` comes from one read transaction.
  2. For each candidate, inside a `try`, so a failure is logged as `{ event: 'reminder_tick_error', user_id, error }` and the loop goes on: skip with a log when `!isTimeZone(timeZone)`. Otherwise, for each `dueSlots(settings ?? DEFAULT_REMINDER_SETTINGS, timeZone, at)`, run one transaction that does `claim`, then `countCompletedOnDay` when the claim succeeded, and returns `{ id, completed }`. Skip when `id` is null. Then `decide`. On `skip_target_met`, call `record(id, { outcome: 'skip_target_met', evidence, tickets: null })`. On `send`, call `push.send(tokens.map(to => ({ to, title, body, channelId, data: { reminder_id: id } })))`. On success, record `sent` with the tickets, then `deleteDevicesByToken` for each ticket whose `details.error === 'DeviceNotRegistered'`. On `PushUnavailable`, record `failed` with `evidence.error`.
  3. **Receipts:** `awaitingReceipts({ olderThan: at − 15 min, newerThan: at − 23 h })`, then one `push.receipts` call for all their ticket ids. Then, per row, `recordReceipts` and delete the `DeviceNotRegistered` tokens. A `PushUnavailable` here is logged and left for the next tick.
  4. Log one summary line: `{ event: 'reminder_tick', candidates, claimed, sent, skipped, failed }`.

- [ ] Step 1: Write the route tests (copy `routes/bots.test.ts`):
  - unmounted → 404
  - a wrong, missing or other-scheme secret → 401
  - a good secret → 202, and exactly one `remind` job queued after two calls (use `tests/support/jobs.ts`)
  - the log line never contains the secret
  - `/api/internal/other` → 404 without a session
- [ ] Step 2: Write the service tick tests (MockServer namespace per test, injected `now`):
  - a learner with a device at 13:05 in their zone → one push request with `reminder_id`, and the row is `sent` with tickets
  - a completed session that day → `skip_target_met`, with the evidence, and no request
  - a second `tick()` at 13:10 → no new request
  - Expo answers 500 → `failed`, and a second learner in the same tick is still `sent`
  - one learner with the stored zone `Mars/Olympus` (set through SQL in the test) → skipped, and the others are sent
  - `enabled: false` → no row
  - a `DeviceNotRegistered` ticket deletes the device
  - receipts at +20 minutes are stored, and a `DeviceNotRegistered` receipt deletes the device
- [ ] Step 3: Implement. Run `tsc`, the unit tests and `check-adrs` (ADR 0007's greps), amend ADR 0003, and commit.

### Task 7: A finished session marks its reminder (D6)

**Files:**
- Modify: `apps/server/src/services/sessions.ts`, where `completeSession(sessionId, day)` is called inside `submitAnswer`'s transaction
- Test: `apps/server/tests/integration/services/reminders.mark.test.ts`

**Interfaces — Consumes:** `repos.reminders.sentOnDay`, `markSession` (Task 3); `reminderForSession` (Task 2).

In the same transaction, right after `completeSession`, with the owner's `userId` and the same `day`: `const id = reminderForSession(await repos.reminders.sentOnDay(userId, day), now())`, then `if (id) await repos.reminders.markSession(id, sessionId)`.

- [ ] Step 1: Write the tests:
  - a `sent` reminder at 13:00 and a session completed at 13:40 → marked
  - a second session at 14:00 → nothing more is marked
  - a session at 17:10 after a 17:00 `sent` → the 17:00 reminder is marked
  - a `skip_target_met` row is never marked
  - no reminders → completion still works
- [ ] Step 2: Implement, run `tsc`, and commit.

### Task 8: The app — notifications engine, registration, time zone, tap (D4, D8)

**Files:**
- Modify:
  - `apps/mobile/package.json`: `expo-notifications`. Install with `npm install expo-notifications@<range> -w apps/mobile`, where the range comes from `node_modules/expo/bundledNativeModules.json`; `npx expo install` fails here.
  - `apps/mobile/app.json`: the `["expo-notifications", { "defaultChannel": "reminders" }]` plugin
  - `apps/mobile/eas.json`: a `development` build profile with `developmentClient: true` and `distribution: internal`
  - `apps/mobile/src/api/client.ts`: `reminderSettings()`, `putReminderSettings(s)`, `setTimeZone(tz)`, `registerPushDevice(token)`, `unregisterPushDevice(token)`, `tapReminder(id)`
  - `apps/mobile/src/app/_layout.tsx`: build the engine and `createReminders`, and provide it through context, the way `copy` and `release` are passed
  - the sign-out path (`profile.tsx` or `auth`): `await reminders.unregister()` before signing out, ignoring any failure
  - the home screen (`app/index.tsx`): on mount when signed in, call `reminders.reportTimeZone()` and `reminders.promptOnce()`
  - `docs/adr/adr-0002-di-with-closures.md` and `scripts/check-adr-0002-di-with-closures.sh`: `expo-notifications` joins R1
- Create:
  - `apps/mobile/app.config.js`: `module.exports = ({ config }) => fs.existsSync(path.join(__dirname, 'google-services.json')) ? { ...config, android: { ...config.android, googleServicesFile: './google-services.json' } } : config;`
  - `apps/mobile/src/reminders.ts`, `apps/mobile/src/reminders.test.ts`

**Interfaces — Produces:**

```ts
export type Permission = 'granted' | 'denied' | 'undetermined';
export type NotificationsEngine = {
  setChannel(): Promise<void>;                 // Notifications.setNotificationChannelAsync('reminders', { name: 'Reminders', importance: DEFAULT })
  permission(): Promise<Permission>;
  requestPermission(): Promise<Permission>;
  token(): Promise<string>;                    // getExpoPushTokenAsync({ projectId }).data
  onTap(listener: (reminderId: string | null) => void): () => void;   // addNotificationResponseReceivedListener
  lastTap(): Promise<string | null>;           // getLastNotificationResponseAsync, then clearLastNotificationResponseAsync
  openSettings(): Promise<void>;               // Linking.openSettings
};
export function createReminders(deps: {
  engine: NotificationsEngine; api: ApiClient; platform: 'android' | 'ios' | 'web'; isExpoGo: boolean;
  timeZone: () => string; log: (event: string, detail: unknown) => void;
}): {
  supported: boolean;                          // platform === 'android' && !isExpoGo
  status(): Promise<Permission | 'unsupported'>;
  promptOnce(): Promise<void>;                 // supported and undetermined → request; granted → register
  enable(): Promise<Permission | 'unsupported'>; // from the screen: request if needed, register if granted
  unregister(): Promise<void>;
  reportTimeZone(): Promise<void>;             // every platform
  onTap(go: () => void): () => void;           // reports the tap, then go(); also handles lastTap() once
  openSettings(): Promise<void>;
};
```

The register order is `setChannel` → permission → `token` → `api.registerPushDevice`. A thrown `token()` (no Firebase file yet) is logged as `reminder_token_failed` and leaves no registration.

The root's engine wires `expo-notifications` and `Linking`, `isExpoGo = Constants.executionEnvironment === 'storeClient'`, and `timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone`. In `_layout`, `onTap(() => router.push('/?start=reminder'))`, and the notification handler shows alerts while the app is in the foreground (`setNotificationHandler`).

- [ ] Step 1: Write `reminders.test.ts` with a recording fake engine and a fake api:
  - the order of calls
  - denied → no token call
  - undetermined → asked once; granted → registered without asking
  - Expo Go or the web → `supported: false`, and no engine call except `reportTimeZone`
  - `token()` throws → logged, no api call
  - a tap with an id → `tapReminder(id)`, then `go`; a tap without an id → just `go`
  - `lastTap` is handled once
  - `unregister` calls the api with the token

  Run them and see them fail.
- [ ] Step 2: Implement `reminders.ts`, the api client methods (their tests sit beside the existing client tests), and the root wiring. Plant `import 'expo-notifications'` in a scratch file under `apps/mobile/src`, confirm `./scripts/check-adr-0002-di-with-closures.sh` reports it, then delete the scratch file.
- [ ] Step 3: Run `npx tsc --noEmit -p apps/mobile`, `npx jest` in `apps/mobile` and `./scripts/check-adrs.sh`, then commit.

### Task 9: The Reminders screen and the reminder tap's start (D8)

**Files:**
- Create:
  - `apps/mobile/src/app/reminders.tsx`
  - a pure helper `apps/mobile/src/reminderSettings.ts` with its test: toggling a day or hour keeps the lists sorted and distinct, the target is clamped to 1–5, and the last hour can't be removed
  - `e2e/tests/reminders.spec.ts`
- Modify:
  - `apps/mobile/src/app/profile.tsx`: a "Reminders" row linking to `/reminders`
  - `apps/mobile/src/components/LearningSection.tsx` (or `app/index.tsx`): with `start=reminder` in the search params and a `start` or `resume` action, call the start button's own handler once, then clear the param
  - `apps/mobile/src/strings.ts`, for any new copy, following its pattern

**Screen:**
- An on/off switch (`testID="reminders-enabled"`).
- The target, with minus and plus buttons around the number (`reminders-target-minus`, `reminders-target-plus`, `reminders-target`).
- Seven day chips (`reminders-day-1` … `reminders-day-7`, ISO weekdays), shown Sunday first like the Israeli week (ruled in Task 9).
- Hour chips from 06:00 to 23:00 (`reminders-hour-06` … `reminders-hour-23`).
- It loads with `api.reminderSettings()` and saves each change with `putReminderSettings`.
- On Android, when `status()` is `denied`, it shows "התזכורות כבויות בהגדרות של אנדרואיד." and a button that calls `openSettings`. When `undetermined`, it shows a "הפעלת התראות" button that calls `enable()`.
- On the web it shows "התזכורות מגיעות לאפליקציה באנדרואיד." (all Reminders copy ruled Hebrew in Task 9)
- Use the existing theme and components; read `profile.tsx` and `about.tsx` for the style.

- [ ] Step 1: Write the helper tests, see them fail, implement, and see them pass.
- [ ] Step 2: Build the screen, the profile link and the home `start=reminder` handling. For the home handling, add a test beside the existing `nextSession`/`startState` tests if the logic is pure there. Otherwise keep the effect thin.
- [ ] Step 3: Write `e2e/tests/reminders.spec.ts`, following the existing specs' sign-in helper: open Profile → Reminders, check the defaults (Mon–Sun selected, 13, 17, 20 and 22 selected, target 1), toggle Sunday off, add 09:00, raise the target to 2, reload, and check that all three persisted. It runs in CI.
- [ ] Step 4: Run `tsc`, the mobile jest suite and `check-adrs`, then commit.

### Task 10: Infrastructure and runbook (D9)

**Files:**
- Create: `terraform/bootstrap/reminders.tf`, `docs/runbooks/reminders.md`
- Modify:
  - `terraform/prod/variables.tf`: `REMINDER_SECRET` in `secret_env_names`
  - `terraform/bootstrap/outputs.tf`: `reminders_connection_name`

**`reminders.tf`** mirrors `bots.tf`:
- `aws_cloudwatch_event_connection.reminders_tick`: `API_KEY` auth, key `Authorization`, value `Bearer unset`, with `lifecycle { ignore_changes = [auth_parameters] }`.
- `aws_cloudwatch_event_api_destination.reminders_tick`: `POST`, `https://app.wordspal.ai/api/internal/reminders/tick` (use the existing domain variable if `bootstrap` has one), `invocation_rate_limit_per_second = 1`.
- `aws_cloudwatch_event_rule.reminders_every_5_minutes`: `rate(5 minutes)`.
- A target with `input = "{}"` and `retry_policy { maximum_event_age_in_seconds = 300, maximum_retry_attempts = 2 }`, on the IAM role. Reuse the bots role only if its policy is scoped by resource. Otherwise add a role and policy for this destination.
- An alarm `reminders_tick_failed` on `AWS/Events` `FailedInvocations` for this rule, Sum over 900 s, threshold 1, to `aws_sns_topic.alerts`.

**Runbook** `docs/runbooks/reminders.md`:
1. **Firebase, once.** Create a project, add the Android app `ai.wordspal.app`, download `google-services.json` to `apps/mobile/`, and commit it. Create a service-account key, then `cd apps/mobile && npx eas-cli credentials` → Android → production → Push Notifications (FCM V1) → upload the key. Delete the local key.
2. **The secret, before merging.**
   ```
   aws secretsmanager create-secret --name wordspal/prod/REMINDER_SECRET --secret-string "$(openssl rand -hex 32)"
   ```
3. **After the release.** `./scripts/infra.sh bootstrap apply`, then `aws events update-connection --name <reminders_connection_name> --authorization-type API_KEY --auth-parameters "ApiKeyAuthParameters={ApiKeyName=Authorization,ApiKeyValue=Bearer $(aws secretsmanager get-secret-value --secret-id wordspal/prod/REMINDER_SECRET --query SecretString --output text)}"`. Check that `aws events describe-connection` says AUTHORIZED.
4. **Check it.** `curl -s -o /dev/null -w '%{http_code}' -X POST https://app.wordspal.ai/api/internal/reminders/tick` gives 401 (mounted).
5. **On the phone.** Follow the spec's Testing bullet.
6. **The three count queries.** Reminders sent per day; tapped; sent with a `session_id` per day.

- [ ] Step 1: Write the files. Run `terraform fmt -check -recursive terraform` if terraform is installed (it is CI's terraform-plan job otherwise). Check the infra scripts' names and the domain variable by reading `bots.tf`, `docs/runbooks/bots.md` and `scripts/infra.sh`, and use the real ones. Commit.
