# Phase 43 — A session is always ready

- **Status:** Scoped with Victor on 2026-10-12 (one-pager), the approach and the skip question
  discussed, then "go till PR": the rest of the design is self-approved (CLAUDE.md, *Continue
  till PR*). Rulings are at the end. Implemented on branch `phase-43-always-ready-session` from
  `docs/superpowers/plans/2026-10-12-phase-43-always-ready-session.md`. Building added R8 to R11
  and the final review's fixes: create and the stock job take turns per enrollment, a save's
  stock waits past the last save, and the device columns keep a default.
- **Date:** 2026-10-12
- **Source:** the one-pager `drafts/2026-10-12-always-ready-session-one-pager.md` (gitignored; its
  Done-means are restated below) and the design dialogue: "one in stock, refilled on first
  answer" approved by Victor; skip left exactly as it is ("only I am really testing it").
- **Builds on:** phase 19 (create, preparing, resume, skip; one open session per enrollment;
  the prepare-session job), phase 35 / 37 / 39 (the picker, its day state and its families),
  phase 24 / 25 (only the device knows whether it can listen or speak).
- **Touches:** one migration (`sessions.started_at`, `listening`, `speaking`; the one-open index
  becomes two); a new job queue; a new route `POST /sessions/{id}/start`; the meaning of
  `POST /sessions` and of `current`, both compatible with older apps, so no `API_LEVEL` change;
  the home and results screens; the bots' log.

---

## Goal

A learner with saved words never waits for a session: whatever state they are in, practice
starts in a few seconds at most. The one exception is a learner with no saved words.

Today every list session is created on demand: the learner taps **צור שאלות** and waits while
one model batch, a context call and a checker run, tens of seconds. No speed-up brings that
under "a few seconds", so a session has to be ready before it is asked for.

**Done means:**

1. A learner with saved words never sees "preparing" on the home screen after finishing a
   session, after skipping a started one, after switching enrollment, or on a cold app open,
   once the enrollment has had a session started since this phase (D2).
2. The **צור שאלות** button is gone. The home screen offers start or continue, the "save some
   words first" state for an empty list, and a retry after a failed preparation.
3. A session starts right away: the learner does not wait more than a few seconds.
4. It is countable: the server logs `session_offered` for each home read that offers an
   unstarted session, with its status (D8), so the share offered `ready` can be read.
5. The bots log every session they found still preparing (R1).

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass, and
`TIER2_THRESHOLD` is not lowered.

## Scope

**In:** keeping one unstarted session in stock per enrollment (D1–D3); picking that session
while another is in progress (D4); create and current as the stock makes them (D5, D6); the
app's start call, its home screen and its results screen (D7); the measurement (D8); the bots'
waits (R1).

**Out:**

- newly saved words joining a stocked session: they appear one session later;
- faster generation: no change to the model calls or the prompts;
- a push notification that a session is ready;
- the picker's rules: phase 35 / 37 / 39 stand; D4 only tells it about the session in flight;
- learner settings: session length, how many sessions are kept in stock;
- the seed: it stays the first session, created on **start** and ready at once;
- skip: unchanged for everyone, a session started or not. Its UX is rethought when there are
  real users (Victor, 2026-10-12);
- rebuilding a stocked session that sat unused for days (R5);
- retrying a failed stock automatically (R4).

---

## D1. Data: one started session and one in stock

Phase 19 kept at most one open session per enrollment (`sessions_one_open_per_enrollment`, open
meaning `preparing` or `ready`). "In progress" was not stored: it was `ready` with an answer.

- **`sessions.started_at`** (timestamptz, null): set when the session is started (D2), never
  cleared. The migration backfills it for every session with an answer: its first answer's
  `answered_at`.
- **The index becomes two.** `sessions_one_stock_per_enrollment`: unique `enrollment_id` where
  status is `preparing` or `ready` and `started_at` is null. `sessions_one_started_per_enrollment`:
  unique `enrollment_id` where status is `ready` and `started_at` is not null. Every enrollment
  has at most one open session today, so both hold from the start.
- **`sessions.listening`, `sessions.speaking`** (boolean, not null, default `false`): what the
  session was built for. Backfilled `false`; written on every insert from then on. The default
  is for the old container, which still inserts without them for the minute it serves after the
  migration (ADR 0010). A stock built with no device in hand inherits the enrollment's newest
  session's (D3).
- **Statuses do not change:** `preparing → ready → completed`, or `skipped` / `failed`.

The service checks first for a clean error; the indexes are what hold under a race, as in phase
19. A unique violation on either maps to `SessionOpen`.

## D2. Starting a session

A session is started by whichever comes first:

- **`POST /sessions/{id}/start`** `{ listening?, speaking? }`, which the app sends when the
  learner taps **start** (D7). It answers `{ session_id, status }`. A `ready` session is started;
  one already started is a no-op; a `preparing`, completed, skipped or failed one is
  `409 session_not_ready`; another started session of the enrollment is `409 session_open`.
- **Its first answer**, through any answer route, for an app that never sends start (every
  build older than this phase) and for the bots.

Either sets `started_at` (conditionally: `where started_at is null`) and, when it did, enqueues
a stock job. Only start carries the device's capabilities (R2).

## D3. The stock job

A new queue, **`stock-session`**, payload `{ enrollment_id, reason, listening?, speaking? }`.
Policy `stately` with the enrollment id as singleton key: at most one job queued and one active
per enrollment, so a trigger that arrives while a job runs is queued, not lost, and a burst of
triggers is one job. Two retries; no dead letter: a stock that never got built is built by the
next trigger, or by the home screen (D7).

**Triggers,** each in the transaction of the change that calls for it:

| reason | when |
|---|---|
| `start` | D2's start call, with the request's capabilities |
| `answer` | a first answer that started the session |
| `complete` | the last answer completed a session |
| `skip` | a skip ended a list session (not the seed, R8) |
| `save` | words were saved: the vocabulary save and the photo-import save; held 30 s past the last save (R3) |

Create and the handler take a lock per enrollment (an advisory lock held to the end of the
transaction), so a double tap, or a create racing the job, waits for the other and answers what
it made.

**The handler**, in one transaction: the enrollment exists; it has no stock; it has had a
session (otherwise the seed comes next); it has saved words. Then `stockNext` (below), and it
logs `session_stocked` `{ enrollment_id, session_id, reason }`. Any of the checks failing is a
no-op, logged as `session_stock_skipped` with why. A race lost to another stock (`SessionOpen`
from the index) is the same no-op.

**`stockNext`** is phase 19's list branch of `createNextSession`, moved out so the job and the
route share it: pick (D4), insert the session `preparing` with its capabilities, record the
families' refresh, enqueue prepare-session. Capabilities: the job's payload's when it carries
them, otherwise the enrollment's newest session's, otherwise `false`.

## D4. Picking around the session in flight

The stock is usually picked while another session is started and not finished. Its glosses
are treated as already answered today, so the two sessions do not ask the same words:

- they are dropped from the returns (`steps`) and added to `done`, after today's own, so a
  short list still fills a session with them, last, as phase 37 does;
- those never met (no memory and not introduced today) count toward `newToday`, so
  `DAY_NEW_CAP` still holds across the two sessions.

A pure function in `domain/today.ts`, `withSessionInFlight`, given `dayState`'s result, the
in-flight glosses and the glosses already met. The cost, accepted when the approach was
approved: a session's answers shape the session after next, not the next one, so phase 37's
same-day returns arrive one session later.

## D5. Create: the next session to play

`POST /sessions` keeps its request and response:

- a started session exists: `409 session_open`, as before (the bots resume it);
- a stock exists: `200` with it; the request's capabilities are not applied to a session
  already built;
- no session ever: the seed, `201`, as before;
- otherwise `stockNext` inline, `201`, `preparing`.

Older apps call create only when `current` is null, so they never meet the `200`.

## D6. Current

`current` is the started session if there is one, else the stock, else the newest session if
it failed, else null. An older app reads that exactly as before: continue while a session is
started, start for a ready stock, the poll for a preparing one.

## D7. The app

- **Start.** Entering a session from home's **start** sends D2's start with the device's
  capabilities, read as create reads them, then goes in without waiting on it; a failed start
  is covered by the first answer.
- **Home.** The `create` state is no longer a button: home sends create itself, once per focus
  and enrollment, and shows "preparing". If that create fails, it offers **נסה שוב**. A failed
  preparation shows its notice and **נסה שוב** instead of **צור שאלות**. Every other state is
  as before.
- **Results.** **לתרגול הבא** goes home. It no longer sends create: the stock is there, and when
  it is not, home makes it.

## D8. Measurement

`currentSession` logs `session_offered` `{ enrollment_id, session_id, status }` when `current`
is an unstarted list session. A session's first `session_offered` says whether the learner found
it ready. In CloudWatch Logs Insights:

```
filter event = "session_offered"
| stats earliest(status) as first by session_id
| stats count(*) as sessions by first
```

---

## Testing

- **Unit:** `withSessionInFlight`; the service's start, stock and create branches against the
  fakes; the triggers' enqueues; the app's home action and its auto-create guard.
- **Integration:** the migration's indexes and backfill; the repo's `markStarted` race; the
  stock job end to end through pg-boss (a stock built while a session is started does not ask
  its words); the start, create and current routes.
- **E2e:** home makes the first list session itself (no **צור שאלות**); after a list session ends,
  home offers **start** without "preparing"; the seed is unchanged.

---

## Rulings

Taken under "go till PR", for Victor to overturn.

- **R1. The bots log their waits.** Done-means 5 as scoped ("the bots never hit a wait") cannot
  hold: a bot answers a whole session in seconds, faster than any session can be prepared, so it
  meets the stock still preparing whatever the server does. The bots keep their flow and log
  each session they found preparing, with how long they waited, which counts the same thing.
- **R2. The device's capabilities travel with start.** Only the device knows whether it can
  listen or speak (phases 24, 25), and with a stock the app no longer creates sessions, so
  without start the capabilities would be fixed at the seed forever. A stock with no device in
  hand inherits the newest session's: the same device, almost always.
- **R3. A save stocks 30 s after the last save.** Stocked at the first save, a first list session
  would hold one word: a learner saves several in a row. Each save moves the held job on (pg-boss
  `upsert`), so a burst becomes one session however long it lasts; a learner back home sooner gets
  the home screen's create, which holds every word saved. `STOCK_SAVE_DELAY_SECONDS` sets the
  delay; e2e sets it past any run, so a spec's first list session is the one home creates.
- **R4. A failed stock is not retried by itself.** Retrying on failure would loop on a model
  outage. The next trigger, or the learner's **נסה שוב**, builds a new one.
- **R5. A stale stock is played as is.** Built on an earlier day, its words were due then and are
  due still; rebuilding it would mean a wait or two stocks. Anything due since comes next.
- **R6. No `API_LEVEL` change.** No field is removed or renamed and no request field becomes
  required. An older app's results screen calls create after every session, so it does meet the
  200 for the stock: it accepts any success, ignores the body and goes home, as before. `current`
  reads as it always did, and a first answer starts a session for it (D2). An older app never
  sends start, so its stocks inherit the newest session's devices until it updates.
- **R7. `started_at`, not a status.** A started session is still `ready` everywhere phase 19 reads
  it; a column the indexes can see was the only missing piece.
- **R8. A seed skip asks for no stock.** The seed is played before anything is saved; a stock
  built behind the first saves would hold one word and race them.
- **R9. Create and start wait for the device's voices**, at most 3 s: home creates as soon as it
  shows, before the voices may be read, and an unread list would say the device cannot listen.
- **R10. The integration suites' default pg-boss drops stock requests** and still fails loudly for
  every other queue: every first answer, ending and skip makes one. The stock job is proven
  through a real pg-boss in `jobs/stockSession.test.ts`.
- **R11. A save's stock has a key of its own** (`<enrollment>:save`), so a held save never
  swallows a start's trigger and its devices. Two stock jobs may then run at once for one
  enrollment; the lock and the stock index make the second a no-op.
