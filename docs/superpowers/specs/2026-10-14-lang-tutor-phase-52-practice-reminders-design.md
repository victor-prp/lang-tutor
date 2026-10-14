# Phase 52 — A learner who forgets is reminded

- **Status:** Designed on 2026-10-14 under "go till PR, subagents". The scope and four design
  choices are Victor's, from the one-pager conversation: server push through Expo's push service,
  an EventBridge tick, "today" in the learner's time zone, and every decision recorded with the
  session it led to marked on it. The rest are mine, recorded as decisions below.
- **Date:** 2026-10-14
- **Source:** `drafts/2026-10-14-schedule-reminders-one-pager.md` (main checkout), and two
  research reports: `drafts/2026-10-14-server-push-reminders-findings.md` and
  `reports/Scheduled push reminders for Expo.md`.
- **Builds on:** phase 35 (the learner day, ADR 0013), phase 39 and 40 (the bot door and its
  EventBridge trigger), phase 29 (the session, ADR 0009), phase 32 (the Android app, ADR 0012),
  phase 19 (pg-boss, ADR 0007).
- **Touches:** a new domain module, a new service, repository, provider and job; five learner
  routes and one internal route; migration 0035; `learnerDay`; the Android app's composition root,
  a new screen and the home screen; `terraform/bootstrap` and `terraform/prod`; ADRs 0002, 0003
  and 0013.

---

## Goal

A learner who means to practise every day and forgets gets a push notification on their phone.
By default it comes at 13:00, with follow-ups at 17:00, 20:00 and 22:00, in the learner's own
time zone. Once the day's target is met (one session by default) no more come that day. Tapping
one opens the session. Each decision, sent or skipped, is a row with its evidence, and a session
finished after a reminder is marked on that reminder, so sent, tapped and practised-after can be
counted.

## Scope

**In:** the learner's time zone, reported by the app; a daily target; a reminder schedule (on or
off, days, hours) with defaults; device registration on Android; a tick every five minutes that
decides and sends; the decision log with tap and session marks; a Reminders screen; the
infrastructure for the tick.

**Out** (from the one-pager): email, SMS and in-app banners; smart timing and due-word reminders;
iOS; personalised text; a "session is ready" notification. Also out, mine: a reminder log
retention policy (rows are small: at most one per slot per learner per day); Expo's access-token
requirement ("enhanced push security"); minute-level times (the screen offers whole hours); a
streak or daily-target widget on home.

---

## 1. Decisions

### D1. The learner's day is the date in their time zone

`users.time_zone` (IANA name, `text not null default 'UTC'`) is new. The app reports it once signed
in, from `Intl.DateTimeFormat().resolvedOptions().timeZone`, through `PUT /api/me/time-zone`, and
only when it differs from the zone the server already holds: the profile (`GET /api/me`,
`POST /api/users`) carries it as `time_zone`, an additive field, so `API_LEVEL` stays. A launch
that changed nothing sends nothing, which also leaves no request for a page load to abort. The
server accepts a name only if `Intl.DateTimeFormat` accepts it (otherwise 400).

The formula moves into a pure function, `dayInTimeZone(now, timeZone): 'YYYY-MM-DD'`, in
`apps/server/src/domain/learnerClock.ts`, with `localMinutes(now, timeZone)` (minutes since local
midnight) and `isoWeekday(now, timeZone)` (1 = Monday). `learnerDay` becomes: bot → `bot_day`
as today; learner → `dayInTimeZone(now, timeZone)`, with `findDayContext` now also returning the
time zone. Nothing else computes a progress day.

Rows already written keep their UTC `practice_day`; there is no backfill. A learner east or west of
UTC can see one day counted twice or skipped on the day the change ships, and once whenever they
travel across time zones. Both are accepted.

**ADR 0013** is amended rather than replaced: its decision now reads "the date of the clock in the
learner's time zone", R1's pattern stays, and it names `domain/learnerClock.ts` as the one formula
that `learnerDay` and the reminder tick both call.

### D2. The daily target and the schedule are one row per learner

The new table `reminder_settings` holds `user_id` (primary key, references `users`, cascade),
`enabled boolean`, `daily_target smallint` (1–10), `days smallint[]` (ISO weekdays) and
`times text[]` (`'HH:MM'`, sorted, distinct, 1–8 entries). A missing row means the defaults,
which live in one constant in `domain/reminders.ts`: on, target 1, every day,
`13:00, 17:00, 20:00, 22:00`. `GET /api/me/reminders` returns the effective settings plus the
time zone, and `PUT /api/me/reminders` replaces them whole.

Defaults are on, so that "it works without setup" holds. Nothing reaches a learner who has not
let the app notify them, because only a granted permission registers a device (D4).

### D3. The target is met by completed sessions on the learner's day

Met means `completed sessions with practice_day = today >= daily_target`, counted across every
enrollment the learner owns. A skipped session does not count. A tutor finishing a session on the
learner's list counts for the learner, as its `practice_day` already does.

### D4. Devices register on Android only, after the permission is granted

The new table `push_devices` holds `token text primary key`, `user_id` (cascade), `platform`
(`'android'`), `created_at` and `last_seen_at`. `PUT /api/me/push-devices {token, platform}`
upserts a token and hands it to the caller if it belonged to someone else (one phone, two
accounts). `POST /api/me/push-devices/unregister {token}` deletes it, and sign-out calls it before
the session is cleared.

The app (Android only, and never in Expo Go, where remote push does not exist) does these in
order: create the notification channel `reminders`, ask for permission, fetch the Expo push token
with the project id, then register it. It asks once on the home screen after sign-in, and again
only from the Reminders screen. A refusal is remembered by Android, and the screen then says
reminders are off in Android settings and offers to open them.

### D5. The tick: EventBridge, then a job, then a pure decision

EventBridge calls `POST /api/internal/reminders/tick` every five minutes, with
`Authorization: Bearer <REMINDER_SECRET>`. The route is mounted only where `REMINDER_SECRET` is
set (production), before the session middleware. It checks the secret the way `routes/bots.ts`
does, enqueues the `remind` job with `singletonKey: 'remind'` in one transaction, and answers
202. Anywhere else `/api/internal/*` answers a plain 404, which is ADR 0003 R1's third exception.
The job keeps the request inside EventBridge's five-second limit, and the singleton key keeps two
overlapping ticks (a rollout runs two containers, ADR 0010) to one run.

The job's use case, `reminders.tick(now)`:

1. **Due slots.** It reads every learner with at least one device who owns at least one
   enrollment (ruling 9), with their settings and time zone. The pure `dueSlots(settings, timeZone, now)` returns the slots of today that started in
   the last 30 minutes (`0 <= localMinutes − slot < 30`) on an enabled weekday. A tick that was
   missed is caught up by the next one inside that window, and a slot left out longer than that is
   skipped.
2. **Claim.** For each due slot it inserts `(user_id, local_day, slot)` into `reminders` with
   `ON CONFLICT DO NOTHING`. Only a row it inserted goes on, so no slot is decided twice.
3. **Decide.** It counts the day's completed sessions. The pure
   `decide({ completedToday, target })` returns `skip_target_met` or `send`, with its evidence:
   `{ completed_today, daily_target, time_zone, devices }`.
4. **Send and record.** On `send` it posts one message per device to Expo with title "הגיע הזמן
   לתרגל" (ruled Hebrew in Task 9, like the app), a fixed body "כמה דקות עכשיו, והמילים נשארות
   בזיכרון.", channel `reminders`, priority `high` (so Doze does not hold it back), and data
   `{ reminder_id }`. The outcome is
   `sent`, or `failed` with the error, and the tickets are stored. A ticket of
   `DeviceNotRegistered` deletes that device.
5. **Receipts.** In the same run it fetches receipts for `sent` rows decided between 15 minutes
   and 23 hours ago and not yet checked, stores them, and deletes devices whose receipt says
   `DeviceNotRegistered`.

The claim and the result are two writes with the push call between them. They are independent and
idempotent in ADR 0001 R8's sense: a claimed row whose send never lands is a slot missed, recorded
as `claimed`, and repeating either write is a no-op. A process that dies mid-send therefore costs
one reminder, never a duplicate.

### D6. One row per decision; the tap and the session are marked on it

`reminders` holds `id uuid`, `user_id` (cascade), `local_day date`, `slot text`, `decided_at`,
`outcome` (`claimed | sent | skip_target_met | failed`), `evidence jsonb`, `tickets jsonb`,
`receipts jsonb`, `receipts_checked_at`, `tapped_at` and `session_id` (no foreign key, so the log
outlives the session, as `gloss_family_events` does). It is unique on
`(user_id, local_day, slot)` and indexed on `(user_id, local_day)`.

- **Tap:** the notification carries `reminder_id`. The app reports the tap with
  `POST /api/me/reminders/{id}/tap`, which sets `tapped_at` once on a reminder the actor owns, and
  answers 404 for anyone else's (ADR 0009 R7).
- **Session:** inside `submitAnswer`'s completing transaction, the latest `sent` reminder of the
  learner's `practice_day` with `decided_at <= now` gets this session, unless it already has one.
  That is "finished before the next reminder or the end of the day". A second session in the same
  gap marks nothing more, and never an earlier reminder. It is a dependent write of the completion, so it shares the transaction.

Counts are queries over this table. The runbook gets the three queries.

### D7. The provider: a plain-fetch Expo client with an injected base URL

`providers/expoPush.ts` exports `createExpoPushClient({ fetch, baseUrl, timeoutMs })` with
`send(messages)`, which posts to `/--/api/v2/push/send` in chunks of 100, and
`receipts(ids)`, which posts to `/--/api/v2/push/getReceipts`. It does not use
`expo-server-sdk`, which hard-codes its host, because ADR 0001's providers take a base URL so that
tests reach MockServer. `PUSH_BASE_URL` defaults to `https://exp.host`. Failures map to a new
`PushUnavailable` in `errors.ts` (ADR 0001 R12). The service depends on a `PushSender` contract
type declared in `services/` (R11). `scripts/image-run.sh` and `e2e/serverEnv.ts` point
`PUSH_BASE_URL` at MockServer like `RESEND_BASE_URL`.

### D8. The app: one engine at the root, one screen, a tap that starts the session

- **Composition root:** `expo-notifications` is imported only in `_layout.tsx` (ADR 0002 R1 gains
  it). The root builds a notifications engine (channel, permission, token, tap listener and last
  response) and passes it to `src/reminders.ts`, a `createReminders({ engine, api, platform,
  isExpoGo })` factory that is tested with a fake engine.
- **Reminders screen:** `app/reminders.tsx`, linked from Profile, has an on/off switch, the target
  (1–5, minus and plus), seven day chips, and hour chips from 06:00 to 23:00, and saves on change.
  On Android with the permission refused it shows the notice from D4. On the web it shows the
  settings with the line "התזכורות מגיעות לאפליקציה באנדרואיד." (the screen is in Hebrew, ruled in Task 9).
- **Tap:** it reports the tap, then navigates to `/?start=reminder`. Home starts or resumes the
  ready session once, as its start button would. A tap that launched the app from closed is read
  from the last response.
- **Native config:** `app.json` gets the `expo-notifications` plugin. A new `app.config.js` adds
  `android.googleServicesFile` only when `apps/mobile/google-services.json` exists, so builds
  keep working before Victor adds the Firebase file, and reminders stay dormant until he does.
  The fingerprint changes, so the next release ships a new binary (ADR 0012).
- **Preview build:** `eas.json` gains a `preview` profile (distribution internal, android
  `buildType` `apk`, channel `preview`, environment `production`), so push can be tried on a phone
  without Play. It is not a `development` profile because a dev client needs `expo-dev-client`, a
  second native-layer change.

### D9. Infrastructure: a second EventBridge rule, to our own server

`terraform/bootstrap/reminders.tf` holds a connection (API key `Authorization`, value
`Bearer unset`, `ignore_changes` on its auth, as for the bots), an API destination
`POST https://app.wordspal.ai/api/internal/reminders/tick`, a rule `rate(5 minutes)`, a target
whose retry policy gives up after 5 minutes (the next tick covers it), and an alarm on
`FailedInvocations` to the existing `wordspal-alerts` topic. `terraform/prod` adds
`REMINDER_SECRET` to `secret_env_names`. Victor creates the secret, applies, and sets the
connection's key. Those steps are the runbook section and the PR's **Left for Victor**.

### D10. Wire and API level

There are seven new endpoints, every field new: `GET` and `PUT /api/me/reminders`,
`PUT /api/me/time-zone`, `PUT /api/me/push-devices`, `POST /api/me/push-devices/unregister`,
`POST /api/me/reminders/{id}/tap` and the internal tick. Old apps never call them, so `API_LEVEL`
stays 3.

---

## 2. Testing

- **Unit:**
  - `learnerClock`: zones east and west, a daylight-saving change, the weekday.
  - `dueSlots`: the window edges, disabled days, disabled settings.
  - `decide`.
  - `pickReminderForSession`: the latest sent before now, none, already marked.
  - The provider's chunking and error mapping, against a fake `fetch`.
  - `src/reminders.ts` with a fake engine: the order, a refusal, Expo Go, the web.
  - The Reminders screen and the home screen's `start=reminder`.
- **Integration (CI):**
  - The routes: the settings round trip, the 400s, a stranger's tap answering 404, device
    re-assignment.
  - The tick route: unmounted is 404, a bad secret is 401, a good one is 202 with one job.
  - The service tick against MockServer: a send, a target met, a duplicate tick, a failed send, a
    `DeviceNotRegistered` ticket and receipt.
  - Completion marks the reminder.
  - `learnerDay` with a time zone.
- **e2e (web, CI):** the Reminders screen saves and reloads its settings. No push on the web.
- **On the phone:** Victor's, after the Firebase setup. Turn reminders on, set an hour five minutes
  ahead, wait for the reminder, tap it, finish the session. Then check the reminder row's
  `tapped_at` and `session_id`.

## Risks

- **Firebase first.** Until `google-services.json` and the FCM key exist, the Android token call
  fails, the app logs it, and no device registers. Everything else ships and works.
- **Time zone from the client.** A wrong device clock zone puts the learner's day there too, which
  is what the learner sees on their own clock anyway.
- **Missed ticks.** If EventBridge or the container is down for more than 30 minutes, those slots
  are skipped and leave no row. The alarm reports failed invocations.

## Rulings

1. **EventBridge over an in-process cron** (Victor). The bots already use it, and `schedule: false`
   stays.
2. **"Today" follows the learner's time zone** (Victor). ADR 0013 is amended.
3. **Decisions recorded, the session marked on its reminder** (Victor, option B).
4. **Defaults on, gated by the permission** (mine, D2). "Works without setup" needs defaults on,
   and the permission prompt is the consent.
5. **Hour chips rather than a time picker** (mine). There's no new native module, and the default
   hours are whole hours.
6. **A conditional `app.config.js`** (mine, D8). The PR can merge before the Firebase file
   exists without breaking the Android release.
7. **Hebrew copy** (mine, made in Task 9). The app's whole UI is Hebrew under forced RTL, so the
   Reminders screen and the push itself are Hebrew. The spec's English strings were a mistake.
   The day chips run Sunday first, the Israeli week, with ISO values unchanged.
8. **A `preview` build, not a dev client** (mine, D8). A `development` profile needs
   `expo-dev-client`, a second change to the native layer. A release-mode internal APK receives
   pushes with no new package. The cost is rebuilding instead of reloading through Metro.
9. **Only learners who own an enrollment are reminded** (mine, from the final review). A tutor
   with students but no list of their own has nothing to practise, and their count would stay 0
   forever. Home asks for the permission only with an active enrollment.
10. **The tap returns to Home with `dismissTo`** (mine). `push` would stack a second Home over an
    open session. Home acts only on a read made after the tap, so a reminder tapped after
    finishing one session of two opens the next one, not the finished one.
