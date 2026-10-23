# Phase 75 — Reminders that name what matters most: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each reminder names the single most pressing path (a target due tomorrow, another owed target, My words' goal) in the cards' words, with a picture per kind, and its tap opens that path's session directly.

**Architecture:** A pure `chooseReminder` and `reminderMessage` in `domain/reminders.ts` decide over `ReminderPath[]`, which `services/reminderPaths.ts` builds from the reads home's cards use (`targets.list`, a new read-only `sessions.myWordsDay`, `enrollments.list`), handed to the reminder service as closures by `composition.ts`. The app reads the path from the notification's data and opens a new `/practice` screen that replaces itself with the session.

**Tech Stack:** Hono + Drizzle + pg-boss server, Jest (unit + integration), Expo Router app, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-24-lang-tutor-phase-75-reminders-what-matters-design.md`

## Global Constraints

- Copy is Hebrew, exactly as spec D3's table; numbers are plain digits in the server's strings.
- No migration: `reminders.outcome` keeps `claimed | sent | skip_target_met | failed`; new facts go in `evidence` (jsonb).
- `API_LEVEL` stays; `daily_target` stays on the wire and in the table, unread by the tick.
- Never a hardcoded port or database name (ADR 0006); never `expo lint`; e2e test-results and local eval reports are removed after reading.
- Services import other services' **types** only; the closures meet in `composition.ts` (ADR 0001 R8 phase 26 note, R11).
- Side pictures: `apps/mobile/public/notifications/{exam,exam-urgent,homework,homework-urgent,my-words}.png`; top-line icon `apps/mobile/assets/images/notification-icon.png` (both already rendered by `scripts/render-notification-images.mjs` from `apps/mobile/assets/notifications/source.html`).

## Review Focus

- A learner with two courses where one course's read throws: the slot records `failed` with the error, nothing is sent (Task 3 test).
- A target with no words left, ended, or on its due date is never chosen; a target `rest` today is not owed (Task 1 tests).
- My words' goal off and no target owed: `skip_target_met`, no send, the evidence lists the paths (Task 1, Task 3 tests).
- A tap for the course that is not active: the practice screen switches course before reading, never opens the other course's path (Task 6 test).
- A notification without `enrollment_id` (sent before the release): home's `start=reminder` as today (Task 5 test).

---

### Task 1: Domain — choose and word the reminder

**Files:**
- Modify: `apps/server/src/domain/reminders.ts` (add; `decide` goes in Task 3)
- Test: `apps/server/src/domain/reminders.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TargetPath = { kind: 'exam' | 'homework'; enrollmentId: string; language: string; targetId: string;
    daysLeft: number; state: 'owed' | 'done' | 'rest' | 'due_today'; wordCount: number; readyCount: number;
    readinessPct: number; sessionsOffer: number; sessionsDone: number; minutes: number };
  export type MyWordsPath = { kind: 'my_words'; enrollmentId: string; language: string; goal: number | null;
    sessionsDone: number; waiting: number };
  export type ReminderPath = TargetPath | MyWordsPath;
  export type ReminderChoice = { path: ReminderPath; rank: 1 | 2 | 3 };
  export type ReminderImage = 'exam' | 'exam-urgent' | 'homework' | 'homework-urgent' | 'my-words';
  export function chooseReminder(paths: readonly ReminderPath[]): ReminderChoice | null;
  export function reminderMessage(choice: ReminderChoice, opts: { withLanguage: boolean }): { title: string; body: string; image: ReminderImage };
  export function pathEvidence(path: ReminderPath): Record<string, string | number | null>; // snake_case, spec D5
  ```

- [ ] **Step 1: Write the failing tests** — `chooseReminder`: rank 1 (`daysLeft 1`, owed) beats rank 2 beats My words; exam before homework at ranks 1 and 2 even when the homework is nearer; nearest date within a kind; ties by input order; ranks across two enrollments; `done`, `rest`, `due_today` and `wordCount 0` targets owe nothing; My words with `goal null` or `sessionsDone >= goal` owes nothing; `[]` → `null`. `reminderMessage`: one test per D3 row with exact strings, e.g. `{ title: 'הבוחן מחר', body: '6 מילים צריכות חיזוק · מוכנות לבוחן: 72%', image: 'exam-urgent' }`, `'מילה אחת צריכה חיזוק · מוכנות לשיעורי הבית: 81%'`, `'כל המילים מוכנות · נשארה בדיקה אחרונה לפני מחר'` (image `exam`), `{ title: 'שיעורי הבית בעוד 2 ימים', body: 'היעד של היום: תרגול אחד · כ-3 דקות' }`, minutes 0 drops ` · כ-0 דקות`, `'כמעט שם · עוד תרגול אחד ליעד של היום'`, `'התחלה טובה · עוד 2 ליעד של היום'`, offer 0 → `'נשאר תרגול להיום'`, `'היעד של היום: 3 תרגולים · 12 מילים מחכות לחזרה'`, waiting 1 → `'מילה אחת מחכה לחזרה'`, waiting 0 → no second part, `'כל הכבוד! עוד תרגול אחד להיום'`, `'כל הכבוד! עוד 2 תרגולים להיום'`; `withLanguage` → `'הבוחן באיטלקית מחר'`, `'שיעורי הבית באנגלית בעוד 2 ימים'`, `'המילים שלי באנגלית'`.
- [ ] **Step 2: Run** `npx jest --selectProjects=unit src/domain/reminders.test.ts` from `apps/server` → FAIL (not exported).
- [ ] **Step 3: Implement** in `domain/reminders.ts`. Language names `{ he: 'עברית', en: 'אנגלית', ru: 'רוסית', it: 'איטלקית' }`, unknown code → the code. Ordering key: `[rank, kind === 'exam' ? 0 : 1, daysLeft, input index]`.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(server): choose a reminder's path and word it (phase 75 D2, D3)`.

### Task 2: Server reads — My words' day and a learner's paths

**Files:**
- Modify: `apps/server/src/services/sessions.ts` (new use case beside `currentSession`)
- Create: `apps/server/src/services/reminderPaths.ts`, `apps/server/src/services/reminderPaths.test.ts`
- Test: `apps/server/tests/integration/services/myWordsDay.test.ts`

**Interfaces:**
- Consumes: Task 1's `ReminderPath`.
- Produces:
  ```ts
  // sessions service
  myWordsDay(actorUserId: string, enrollmentId: string): Promise<{ today: MyWordsToday; waiting: number }>;
  // reminderPaths.ts
  export type PathReads = {
    enrollments: (userId: string) => Promise<Enrollment[]>;
    targets: (actorUserId: string, enrollmentId: string) => Promise<TargetList>;
    myWordsDay: (actorUserId: string, enrollmentId: string) => Promise<{ today: MyWordsToday; waiting: number }>;
  };
  export function createReminderPaths(reads: PathReads): (userId: string) => Promise<ReminderPath[]>;
  ```

- [ ] **Step 1: Failing tests.** `reminderPaths.test.ts` with fake reads: two enrollments (`it`, `en`) → each target as a `TargetPath` (fields from `TargetSummary`: `kind`, `days_left`, `today.state`, `word_count`, `ready_count`, `readiness_pct`, `today.sessions_offer`, `today.sessions_done`, `today.minutes`) followed by that course's `MyWordsPath` (`goal`, `sessions_done`, `waiting`), in enrollment order; a read that rejects rejects the whole call. Integration `myWordsDay`: goal 3 stored, one completed main-path session today → `today.sessions_done 1`, `today.goal 3`; `waiting` equals `currentSession`'s `dueCount`; another learner's enrollment → `AccessDenied`, as `currentSession`.
- [ ] **Step 2: Run** unit (`npx jest --selectProjects=unit src/services/reminderPaths.test.ts`) → FAIL; integration later in CI or `npm run test:integration -- --runTestsByPath tests/integration/services/myWordsDay.test.ts` → FAIL.
- [ ] **Step 3: Implement** `myWordsDay` as one read transaction: `authorizeEnrollment(… 'session.practice')`, `myWordsToday(repos, enrolled)`, `waitingOn(repos, enrolled, null)`; no lock, no stock check, no log. `createReminderPaths` maps the reads; a learner's own enrollments only (`enrollments.list(userId)`).
- [ ] **Step 4: Run** both → PASS.
- [ ] **Step 5: Commit** `feat(server): read a learner's paths for a reminder (phase 75 D1)`.

### Task 3: The tick sends the chosen reminder

**Files:**
- Modify: `apps/server/src/services/reminders.ts`, `apps/server/src/domain/reminders.ts` (remove `decide`, `REMINDER_TITLE`, `REMINDER_BODY`), `apps/server/src/config.ts`, `apps/server/src/composition.ts`, `apps/server/tests/support/serverDeps.ts` (pass-through), `docs/runbooks/reminders.md`
- Test: `apps/server/src/services/reminders.test.ts`, `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes: Task 1 (`chooseReminder`, `reminderMessage`, `pathEvidence`), Task 2 (`createReminderPaths`).
- Produces: `createReminderService({ transaction, push, logger, now, paths: (userId: string) => Promise<ReminderPath[]>, imageBaseUrl: string | null })`; `PushMessage` gains `tag?: string; richContent?: { image: string }`; `Config.reminderImageBaseUrl: string | null`.

- [ ] **Step 1: Failing tests** (rewrite the "a slot that is due" block; keep receipts, devices, summary): a due slot with paths `[homework daysLeft 1 owed, my_words goal 3 done 1]` sends `{ title: 'שיעורי הבית מחר', body: …, channelId: 'reminders', priority: 'high', tag: 'reminder', richContent: { image: 'https://app.example/notifications/homework-urgent.png' }, data: { reminder_id, enrollment_id, target_id } }` and records `sent` with `evidence.chosen.rank 1` and `evidence.paths` (Done-means 1, 4); only My words owed → My words message, `data` without `target_id` (Done-means 2); nothing owed → `skip_target_met`, no send, `evidence.chosen null` (Done-means 3); `imageBaseUrl null` → no `richContent`; two enrollments → titles carry the language; `paths` rejects → `failed` with `evidence.error`, no send, next learner still reminded; claim and record are separate transactions with the read and the send between. Config: `REMINDER_IMAGE_BASE_URL` set → it; `off` → null; unset with `WEB_DIST_DIR` and `AUTH_BASE_URL` → `<AUTH_BASE_URL>/notifications`; otherwise null.
- [ ] **Step 2: Run** `npx jest --selectProjects=unit src/services/reminders.test.ts src/config.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Claim alone in the first transaction (the count goes); then `paths(userId)`; `chooseReminder`; `withLanguage` = more than one distinct `enrollmentId` among the paths; evidence `{ time_zone, devices, paths: paths.map(pathEvidence), chosen }`. Composition: `paths: createReminderPaths({ enrollments: services.enrollments.list, targets: services.targets.list, myWordsDay: services.sessions.myWordsDay })` (closures, built after those services), `imageBaseUrl: config.reminderImageBaseUrl`. Runbook: the new message, the evidence's fields, `REMINDER_IMAGE_BASE_URL=off`.
- [ ] **Step 4: Run** the unit tests and `npm run typecheck` from the root → PASS.
- [ ] **Step 5: Commit** `feat(server): the tick reminds about the most pressing path (phase 75 D2–D5)`.

### Task 4: Integration — the scenarios on a real database

**Files:**
- Modify: `apps/server/tests/integration/jobs/remind.test.ts`; a web test beside the web handler's (`tests/integration/web*.test.ts` or the existing one)

- [ ] **Step 1: Failing tests.** Seed `u_1` (Jerusalem, a device), `seedSavedSenses` + `seedTarget` a homework due tomorrow (the learner day of `AT`) whose words are below the bar, one completed main-path session today, goal 3: the 13:05 tick sends one message whose title is `'שיעורי הבית מחר'` and data names the target (Done-means 1); the stored row's `evidence.chosen.kind` is `homework` (Done-means 4). End the target (`endTargetNow`): the next due slot (17:05) sends `'המילים שלי'` (Done-means 2). Store goal 1 with one session done and no target: the 20:05 slot records `skip_target_met`, nothing sent (Done-means 3). Web: with `webDistDir` pointing at a temp dir holding `notifications/exam.png`, `GET /notifications/exam.png` answers 200 `image/png`.
- [ ] **Step 2: Run** `npm run test:integration -- --runTestsByPath tests/integration/jobs/remind.test.ts` (lane DB) → FAIL before Task 3 is wired, PASS after; if the lane's Postgres is loaded, push and let CI run it.
- [ ] **Step 3: Commit** `test(server): a reminder's scenarios through the real reads (phase 75 Done means)`.

### Task 5: App — the tap carries its path

**Files:**
- Modify: `apps/mobile/src/reminders.ts`, `apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/nextSession.ts`
- Test: `apps/mobile/src/reminders.test.ts`, `apps/mobile/src/nextSession.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ReminderTap = { reminderId: string; enrollmentId: string | null; targetId: string | null };
  export function reminderTapOf(data: unknown): ReminderTap | null; // reminders.ts; reads reminder_id, enrollment_id, target_id
  // engine: onTap(listener: (tap: ReminderTap | null) => void); lastTap(): Promise<ReminderTap | null>
  // createReminders(...).onTap(go: (tap: ReminderTap) => void)
  export function openReminderTap(router: ReminderRouter, tap: ReminderTap): void;
  // ReminderRouter gains push(href: { pathname: '/practice'; params: { enrollment: string; target?: string } })
  export type PracticeStep = { kind: 'enter'; sessionId: string; fresh: boolean } | { kind: 'wait' } | { kind: 'home' }
    | { kind: 'create'; targetId: string; waitForVoices: boolean } | { kind: 'make' } | { kind: 'discover' };
  export function practiceStartOf(input: { targetId: string | null; targets: 'reading' | 'failed' | readonly TargetSummary[];
    main: HomeAction | null; flags: { failed: boolean; read: boolean }; created: TargetCreate; made: 'none' | 'sending' | 'failed';
    latest: readonly TargetSummary[] }): PracticeStep; // nextSession.ts
  ```
- [ ] **Step 1: Failing tests.** `reminderTapOf`: full data, My words (no target), no `reminder_id` → null, non-string ids → null. `openReminderTap`: with `enrollmentId` → `dismissTo('/')` (when it can) then `push({ pathname: '/practice', params: { enrollment, target } })`, `target` omitted for My words; without → today's `/?start=reminder`. `createReminders.onTap` passes the tap, reports `tapReminder(reminderId)` once per id. `practiceStartOf`: target path → the same steps `homeReminderStartOf` gives its first card (resume → enter, failed → home, none → create, sending → wait, answered ready → enter, answered preparing → wait until `latest` shows it ready); a target not in the read → `home`; targets read failed → `home`; My words: start → enter fresh, resume → enter, preparing → wait, create with `made 'none'` → `make`, `made 'sending'` → wait, `made 'failed'` → home, discover → discover, main read failed → home, not yet `read` → wait.
- [ ] **Step 2: Run** `npx jest src/reminders.test.ts src/nextSession.test.ts` from `apps/mobile` → FAIL.
- [ ] **Step 3: Implement.** Extract the target half of `homeReminderStartOf` into a helper both call, so home's behaviour does not change; `_layout.tsx` uses `reminderTapOf(response?.notification.request.content.data)` and `openReminderTap(router, tap)`.
- [ ] **Step 4: Run** → PASS, and `npx jest src/` stays green.
- [ ] **Step 5: Commit** `feat(mobile): a tapped reminder carries its path (phase 75 D6)`.

### Task 6: App — the practice screen

**Files:**
- Create: `apps/mobile/src/app/practice.tsx`
- Modify: `apps/mobile/src/strings.ts` (`practiceOpening: 'פותחים את התרגול…'`), `apps/mobile/src/app/_layout.tsx` (register the route like `results`)
- Test: `e2e/tests/reminders.spec.ts` (or a new `e2e/tests/reminder-tap.spec.ts`)

**Interfaces:**
- Consumes: Task 5's `practiceStartOf`; `useCurrentUser().switchTo/active/enrollments`, `useTargets()`, `useNextSession()`, `useSession().enter`.

- [ ] **Step 1: Failing e2e.** A learner with a homework target: `page.goto('/practice?enrollment=<id>&target=<id>')` shows the session's first question (`session-` testIDs the target specs use), and back lands on home; `'/practice?enrollment=<id>'` with saved words enters a My words session; an unknown target lands on home.
- [ ] **Step 2: Run** `npm run e2e -- tests/reminder-tap.spec.ts` → FAIL (no route).
- [ ] **Step 3: Implement.** Spinner + `strings.practiceOpening`; `switchTo(enrollment)` when it is not `active` and is among `enrollments` (else `home`); once `active.id === enrollment`, reload targets and the main read once, poll with `POLL_INTERVAL_MS` while preparing, and act on `practiceStartOf` after every render (a ref guards re-entry, as home's): `enter` → `next.start` when fresh, `session.enter`, `router.replace('/session')`; `create` → `useTargets().create` (session_open → `openSessionOf` on a reload); `make` → `next.create()`; `discover` → `router.replace({ pathname: '/discover', params: { from: 'my-words' } })`; `home` → `router.dismissTo('/')`.
- [ ] **Step 4: Run** the e2e → PASS; remove `e2e/test-results` after reading.
- [ ] **Step 5: Commit** `feat(mobile): a reminder's tap opens its path's session directly (phase 75 D6)`.

### Task 7: App — the reminders screen loses תרגולים ביום; the top-line icon

**Files:**
- Modify: `apps/mobile/src/app/reminders.tsx`, `apps/mobile/src/reminderSettings.ts` (drop the target stepper helpers if nothing else uses them), `apps/mobile/src/strings.ts` (drop `remindersTarget*`), `apps/mobile/app.json` (expo-notifications plugin: `"icon": "./assets/images/notification-icon.png"`, `"color": "#1A6FF0"`)
- Add: `apps/mobile/public/notifications/*.png`, `apps/mobile/assets/images/notification-icon.png`, `apps/mobile/assets/notifications/source.html`, `scripts/render-notification-images.mjs`
- Test: `apps/mobile/src/reminderSettings.test.ts`, `e2e/tests/reminders.spec.ts`

- [ ] **Step 1: Failing tests.** The screen has no `reminders-target-minus`/`-plus`; a saved change still PUTs the `daily_target` it read (e2e: change a day, reload, the stored `daily_target` is unchanged).
- [ ] **Step 2: Run** `npx jest src/reminderSettings.test.ts` and `npm run e2e -- tests/reminders.spec.ts` → FAIL.
- [ ] **Step 3: Implement**; check the web export copies `public/notifications/` (`npm run build:web` lists `dist/notifications/exam.png`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mobile): reminders lose the daily count, gain the W and the pictures (phase 75 D4, D7)`.

### Task 8: Finish

- [ ] `npm test`, `npm run typecheck`, `npm run lint:arch`, then `npm run test:integration` and `npm run e2e` where the lane allows (else CI).
- [ ] `superpowers:requesting-code-review` on the branch; fix what it finds.
- [ ] `git-create-pr` (body: Done means, Left for Victor from the spec), then `ci-green`.
