# Phase 64 — Home, a bar and one look Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A four-tab bar, a header with translate and photo, a home of one card at a time with a blue header, a
fuse and a "not ready" line, one photo flow, and one look on every screen in scope.

**Architecture:** Expo Router gains a `(tabs)` group under the root Stack: the four tabs share a custom bar and
a header; everything else (session, translate, the wizard, the screens a tab opens) stays a Stack screen over
the tabs, so the bar hides there. Home's machinery (`LearningSection`) is kept and only re-rendered as a stack.
The photo flow is the target wizard with a new `photo` mode. The server adds `created_on` to a target's
summary.

**Tech Stack:** Expo 57 / Expo Router 57 (`Tabs`), React Native 0.86 (`PanResponder`, `experimental_backgroundImage`),
`@expo/vector-icons` Ionicons (already used), zod in `packages/core`, Hono + Drizzle on the server, Jest,
Playwright e2e on web.

**Spec:** `docs/superpowers/specs/2026-10-18-lang-tutor-phase-64-home-and-options-design.md`

## Global Constraints

- UI copy is Hebrew (memory: hebrew-only-ui-copy); numbers in copy go through `isolateLtr`, as every count in
  `strings.ts` does.
- No new native module (ADR 0012 R1, fingerprint runtime): no `expo-linear-gradient`, no `react-native-svg`. The
  header's gradient is `experimental_backgroundImage: 'linear-gradient(150deg, #3B5BDB, #5B7BF0)'` over a
  `backgroundColor: '#3B5BDB'` fallback.
- The font stays the phone's own (R13): no `fontFamily` anywhere new.
- Colours (D9): background `#F6F7FB`, surface `#FFFFFF`, text `#101828`, muted `#667085`, primary `#3B5BDB`,
  primary surface `#EEF2FB`, progress `#12B76A`, header gradient end `#5B7BF0`, amber `#F79009` / `#FDB022`,
  amber surface `#FFFAEB`, amber text `#93370D`, danger `#D92D20`.
- Tabs, right to left: **תרגול · מילים · אני · הגדרות**. The bar shows on these four only (D10).
- "Last two days" means `days_left <= 1` (R9).
- Every kept control keeps its testID. `API_LEVEL` stays 5: `created_on` is an added field (ADR 0012).
- ADR 0002: no `jest.mock`, no new module-level singletons; `_layout.tsx` stays the only composition root.
- Do not run `expo lint` in `apps/mobile` (memory: expo-lint-adds-deps).

## Review Focus

1. **Desktop/web has no swipe.** A learner with a mouse must reach every card: the dots are buttons. → Task 3's
   e2e clicks a dot (Task 7).
2. **One card only.** A learner with no target sees My words alone: no dots and no card edges behind it. →
   `stackDots` returns `[]` for one card (Task 2 test).
3. **Coming back from a session.** The stack shows the first card again, not the index left from before. →
   `CardStack` resets to 0 when its order changes or the tab regains focus (Task 3); e2e in Task 7 finishes a
   target session and sees the first card's testID.
4. **A prep made on its own date or a day before:** `created_on == due_on` or `due_on − created_on == 1`; the
   fuse must not divide by zero or exceed 1. → `fuseOf` tests (Task 2).
5. **Switching language from another tab.** The header's switcher on **מילים** switches the enrollment and the
   list follows. → e2e in Task 7 switches on **מילים**.

---

### Task 1: `created_on` on a target's summary

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`TargetSummarySchema`), `packages/core/src/api/schemas.test.ts`
- Modify: `apps/server/src/services/targetDayRead.ts` (return `createdOn`), `apps/server/src/services/targets.ts`
  (`view`)
- Test: `apps/server/tests/integration/services/targets.test.ts`
- Modify: every app test fixture that builds a `TargetSummary` (typecheck finds them)

**Interfaces:**
- Produces: `TargetSummary.created_on: string` (`LearnerDaySchema`), the learner day of `targets.created_at`.

- [ ] **Step 1: Failing tests.** Core: a summary without `created_on` fails to parse; with `'2026-10-13'` parses.
  Integration (next to the existing list tests): a target created through the service reads back with
  `created_on` equal to the learner's today at creation; after `moveTargetBack`-style `created_at - 3 days`
  in the test's own SQL, it reads three days earlier.
- [ ] **Step 2:** `npm test --workspace packages/core` and
  `npm run test:integration -- --selectProjects=integration --runTestsByPath tests/integration/services/targets.test.ts`
  (memory: jest-select-projects-path) fail.
- [ ] **Step 3:** Add `created_on: LearnerDaySchema` after `due_on`. `readTargetDay` returns `createdOn` beside
  `day`; `view` sets `created_on: read?.createdOn ?? (await learnerDays(repos, enrolled.user_id, [target.createdAt.getTime()]))[0]`.
  Fix app fixtures with a `created_on`.
- [ ] **Step 4:** Both commands pass; `npm run typecheck` passes.
- [ ] **Step 5:** Commit `feat(server): a target's summary carries the day it was created`.

### Task 2: The theme and the card's rules

**Files:**
- Modify: `apps/mobile/src/theme.ts`, `apps/mobile/src/strings.ts`, `apps/mobile/src/targets.ts`,
  `apps/mobile/src/nextSession.ts`
- Test: `apps/mobile/src/targets.test.ts`, `apps/mobile/src/nextSession.test.ts`

**Interfaces:**
- Produces (theme): `colors.background = '#F6F7FB'`, `colors.text = '#101828'`, `colors.muted = '#667085'`, and new
  `colors.bandEnd`, `colors.progress`, `colors.amber`, `colors.amberBright`, `colors.amberSurface`,
  `colors.amberText`, `colors.danger`; `export const shadows = { card: ViewStyle }` (iOS/web shadow + Android
  `elevation: 3`); `radii.card = 20`, `radii.group = 16`.
- Produces (targets.ts):
  - `countdownBig(daysLeft: number): { big: string; unit: string | null }`: `>= 2` → `{ big: isolateLtr(n), unit: 'ימים' }`; `1` → `{ big: 'מחר', unit: null }`; `<= 0` → `{ big: 'היום', unit: null }`
  - `type Fuse = { share: number; hot: boolean; label: string | null }`;
    `fuseOf(t: Pick<TargetSummary, 'created_on' | 'due_on' | 'days_left'>): Fuse`, share =
    `clamp(days_left / max(1, daysBetweenDays(created_on, due_on)), 0, 1)`, hot = `days_left <= 1`, label =
    hot ? (`days_left <= 0` ? 'היום' : 'יום אחד') : null
  - `type Urgency = { kind: 'not-ready' | 'ready'; text: string } | null`;
    `urgencyOf(t: Pick<TargetSummary, 'kind' | 'days_left' | 'word_count' | 'ready_count'>): Urgency`
  - `isUrgent(t: Pick<TargetSummary, 'days_left'>): boolean` (`days_left <= 1`)
  - `targetButtonSolid(t: TargetSummary): boolean`: `owed`, or `due_today` below 100%
  - `stackDots(order: HomeCard[], targets: readonly TargetSummary[]): { card: HomeCard; urgent: boolean }[]`,
    `[]` when `order.length <= 1`
- Produces (nextSession.ts): `mainButtonSolid(action: HomeAction | null): boolean` (true for `start-seed`, `start`,
  `resume`); `myWordsBand(state: CurrentSessionResponse, language: string): { big: string; line: string }`:
  seed → `SESSION_LENGTH`, `מילים ב${language}`; `due_count > 0` → the count, `מילים מחכות לחזרה` (`מילה אחת מחכה לחזרה` big `1`);
  else `saved_count`, `משמעויות שמורות ב${language}`.
- Produces (strings): `fuseLabel: 'הזמן שנשאר'`, `targetNotReady(kind, daysLeft, missing)`, `targetAllReady(kind)`.

- [ ] **Step 1: Failing tests** (`targets.test.ts`), exact copy compared through the file's isolate-stripping
  helper:
  - `fuseOf({created_on:'2026-10-13', due_on:'2026-10-23', days_left:5})` → `{ share: 0.5, hot: false, label: null }`
  - `days_left: 1` → hot, label `'יום אחד'`; `days_left: 0` → share 0, label `'היום'`
  - `created_on == due_on`, `days_left: 0` → share 0, no throw; `created_on` a day before, `days_left: 1` → share 1
  - `urgencyOf` exam, 1 day, 8 words, 5 ready → `'הבוחן מחר ו-3 מילים עוד לא מוכנות. עוד תרגול אחד יעזור.'`
  - homework, 0 days, 6/4 → `'שיעורי הבית היום ו-2 מילים עוד לא מוכנות. חזרה אחרונה תעזור.'`
  - exam, 1 day, 8/7 → `'הבוחן מחר ומילה אחת עוד לא מוכנה. עוד תרגול אחד יעזור.'`
  - exam, 1 day, 8/8 → `{ kind: 'ready', text: 'כל המילים מוכנות לבוחן ✓' }`; homework → `'כל המילים מוכנות לשיעורי הבית ✓'`
  - 2 days left → `null`; `word_count: 0` → `null`
  - `targetButtonSolid`: owed true; done, rest false; due_today at 99 true, at 100 false
  - `stackDots(['main'], [])` → `[]`; `['t1','main','t2']` with t2 at 1 day left → `[{t1,false},{main,false},{t2,true}]`
  - `countdownBig` 5 / 1 / 0
  - `nextSession.test.ts`: `mainButtonSolid` per action kind; `myWordsBand` for seed, due, saved.
- [ ] **Step 2:** `npm test --workspace apps/mobile -- targets nextSession` fails.
- [ ] **Step 3:** Implement. `daysBetweenDays(a, b)` is private in `targets.ts`, built on `dayStart` and `DAY_MS`.
- [ ] **Step 4:** Passes; `npm test --workspace apps/mobile` passes (theme value changes break no test).
- [ ] **Step 5:** Commit `feat(app): the card's countdown, fuse, urgency and button rules`.

### Task 3: The card and the stack on home

**Files:**
- Create: `apps/mobile/src/components/BandCard.tsx`, `apps/mobile/src/components/CardStack.tsx`,
  `apps/mobile/src/components/MyWordsCard.tsx`
- Modify: `apps/mobile/src/components/TargetCard.tsx` (draws through `BandCard`),
  `apps/mobile/src/components/LearningSection.tsx`

**Interfaces:**
- Consumes: Task 2's rules.
- Produces:
  - `BandCard({ icon, kind, big, unit, line, fuse, children, testID, onOpen })`: the blue header (kind with an
    Ionicons glyph, `big` 56–64 pt weight 900, `unit`, the pale `line`, the fuse when given, the faint corner
    circle) and a white body for `children`; `onOpen` makes the header and body above the button pressable.
  - `CardStack({ cards: { key: HomeCard; urgent: boolean; node: ReactNode }[]; resetKey: string })`: one card
    on top; two card edges under it when `cards.length > 1`; dots (`testID="home-dot-${key}"`, pressable, the
    top one long and blue, an urgent one amber); a horizontal `PanResponder` swipe (left → next, right →
    previous, as RTL reads); back to index 0 when `resetKey` changes or on focus.
- testIDs kept: `target-card-${id}`, `target-row-${id}`, `target-countdown-${id}`, `target-today-${id}`,
  `target-readiness-${id}`, `target-practice-${id}`, `target-${note}-${id}`, `home-my-words`, `start-button`,
  and every `SessionAction` id. New: `target-fuse-${id}`, `target-urgency-${id}`.

- [ ] **Step 1:** `TargetCard` renders a `BandCard`: kind icon `calendar-outline` (exam) / `document-text-outline`
  (homework), `countdownBig`, `dueDayLabel(due_on)`, `fuseOf`; under the header the `urgencyOf` strip (amber
  surface, `warning-outline`, `target-urgency-${id}`) or the green ready line; then phase 57's lines and bars;
  the button solid when `targetButtonSolid`, pale otherwise.
- [ ] **Step 2:** `MyWordsCard` takes the My words block out of `LearningSection` unchanged in behaviour, drawn
  through `BandCard` with `book-outline`, `myWordsBand`, `SessionAction` with `filled={mainButtonSolid(action)}`.
- [ ] **Step 3:** `LearningSection` renders `CardStack` over `homeOrder(...).order` (resetKey = the order
  joined); removes the switcher (moves in Task 4), the photo card, `target-new`, `translate-entry`,
  `vocabulary-entry`, `photo-import-entry`; keeps the `home-photo-saved` notice above the stack and every
  effect.
- [ ] **Step 4:** `npm run typecheck` and `npm test --workspace apps/mobile` pass. Run `npm run mobile` with the
  server and check on web: one card, swipe with the mouse, dots move between cards.
- [ ] **Step 5:** Commit `feat(app): home shows one card at a time with a blue header`.

### Task 4: The tabs, the header, מילים, אני and הגדרות

**Files:**
- Create: `apps/mobile/src/app/(tabs)/_layout.tsx`, `(tabs)/index.tsx` (from `app/index.tsx`),
  `(tabs)/words.tsx` (from `app/vocabulary/index.tsx`), `(tabs)/me.tsx` and `(tabs)/settings.tsx` (from
  `app/profile.tsx`); `apps/mobile/src/components/TabBar.tsx`, `AppHeader.tsx`, `LanguageSwitcher.tsx`
- Delete: `apps/mobile/src/app/index.tsx`, `app/profile.tsx`, `app/vocabulary/index.tsx`
- Modify: every `router.push('/vocabulary')`, `'/profile'` (grep), `HomeScreen`'s gates

**Interfaces:**
- Produces: routes `/` (תרגול), `/words`, `/me`, `/settings`. Tab buttons: `tab-practice`, `vocabulary-entry`
  (מילים keeps the old entry's id), `profile-button` (אני), `settings-tab`. Header: `enrollment-switcher`
  (the chip; label is the language name with ▾), `enrollment-option-*`, `enrollment-add`, `translate-entry`
  (Ionicons `search-outline`), `photo-entry` (`camera-outline`, pushes `/targets/new`).

- [ ] **Step 1:** `(tabs)/_layout.tsx`: the gates now in `HomeScreen` (loading, offline, signed out, needs
  profile, enroll redirect) and its two effects (time zone report, reminders prompt) move here so every tab is
  gated; `<Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>` with the four
  screens in order. `TabBar`: Ionicons `play`, `book-outline`, `person-outline`, `settings-outline`; active blue
  with an `#EEF2FB` pill behind the icon.
- [ ] **Step 2:** `AppHeader` (chip right, two icons left) at the top of every tab. `LanguageSwitcher` is the
  switcher moved from `LearningSection`, its list dropping under the header.
- [ ] **Step 3:** `(tabs)/index.tsx`: `AppHeader`, `InvitesSection`, the stack (`LearningSection`) or
  `StartLearning`. No title, no profile link, no `StudentsSection`.
- [ ] **Step 4:** `(tabs)/words.tsx`: the vocabulary screen without its back button; title `המילים שלי` with
  the count; filters as pills; the list in a white group with level tags. Behaviour and other testIDs as today.
- [ ] **Step 5:** `(tabs)/me.tsx`: initial in a pale blue circle, name, username, today's profile fields, then
  groups **השפות שלי** (enrollments, `+ הוספת שפה`), **המורים שלי** (as today), **הוראה** (`StudentsSection`,
  `+ הזמנת תלמיד/ה`). `(tabs)/settings.tsx`: group **תזכורות** (`profile-reminders`) with a one-line summary
  from `useReminders`, **אודות** with the version, then **יציאה** (`sign-out-button`) in red alone.
- [ ] **Step 6:** A reminder's `dismissTo({ pathname: '/', params: { start: 'reminder' } })` still lands on
  תרגול; `nextSession`/`LearningSection` param handling unchanged.
- [ ] **Step 7:** `npm run typecheck`, `npm test --workspace apps/mobile`, `npm run lint:arch` pass; on web, the
  four tabs move without home, the bar hides in a session.
- [ ] **Step 8:** Commit `feat(app): a bar of four tabs and a header with translate and photo`.

### Task 5: One photo flow

**Files:**
- Modify: `apps/mobile/src/targetWizard.ts`, `apps/mobile/src/targets.ts` (titles), `apps/mobile/src/strings.ts`,
  `apps/mobile/src/app/targets/new.tsx`, `apps/mobile/src/app/targets/[id].tsx` (drop the add-photos action),
  `apps/mobile/src/photoImports.ts` (drop `homePhotoCard`), `apps/mobile/src/hooks/usePhotoImports.tsx` (drop
  the list read if nothing reads it)
- Delete: `apps/mobile/src/app/photo-imports/index.tsx`, `apps/mobile/src/app/photo-imports/[id].tsx`
- Test: `apps/mobile/src/targetWizard.test.ts`, `apps/mobile/src/photoImports.test.ts`

**Interfaces:**
- Produces: `WizardMode = 'photo' | 'add-words' | 'change-date'`; `WizardStep = 'photos' | 'review' | 'choose' | 'words' | 'date'`;
  `type Destination = { kind: 'my-words' } | { kind: 'new'; targetKind: TargetKind } | { kind: 'target'; targetId: string }`;
  `WizardState.destination: Destination | null` (replaces `kind`); action `{ type: 'destination'; destination: Destination }`;
  `wizardRouteOf({})` → `{ mode: 'photo', targetId: null }`.

- [ ] **Step 1: Failing tests** (`targetWizard.test.ts`): photo mode starts on `photos`; `canAdvance` on
  `photos` needs a photo; `choose` needs a destination; with `my-words` or `target`, `choose` is the last step
  (`isLastStep`) and `next` stays; with `new`, `next` goes to `words`, then `date` (last); `back` from `words`
  returns to `choose`; `createRequest` takes the kind from `destination.targetKind` and throws without a `new`
  destination; `addRequest` unchanged; the `create` and `add-photos` modes are gone.
- [ ] **Step 2:** `npm test --workspace apps/mobile -- targetWizard` fails.
- [ ] **Step 3:** Implement the reducer; `stepsFor('photo')` = `['photos','review','choose','words','date']`;
  `move` and `isLastStep` read the destination.
- [ ] **Step 4:** `targets/new.tsx`: the `choose` step titled **מה לעשות עם המילים החדשות?**, a white group of
  three rows (`wizard-dest-my-words`, `wizard-dest-exam`, `wizard-dest-homework`) then, under **או להוסיף להכנה
  קיימת**, one row per active target from `useTargets` (`wizard-dest-target-${id}`: kind, countdown, word count).
  Done: `my-words` saves each import with `save` inside `saveHolding` and `dismissTo('/', { photoSaved })` with
  the saved count; `target` sends `addTargetWords` and replaces to `/targets/${id}`; `new` sends `createTarget`
  and `dismissTo('/')`. Leaving discards as today (R12). Step titles: photos **תמונות של רשימת המילים**, review
  **המילים מהתמונות**, choose as above.
- [ ] **Step 5:** Drop the photo-import screens, `homePhotoCard` and its tests, and the target screen's
  **מילים מתמונות** action; grep that nothing routes to `/photo-imports`.
- [ ] **Step 6:** `npm run typecheck`, `npm test --workspace apps/mobile` pass.
- [ ] **Step 7:** Commit `feat(app): one photo flow from the header asks what to do with the words`.

### Task 6: The screens a tab opens

**Files:**
- Create: `apps/mobile/src/components/ScreenHeader.tsx`
- Modify: `apps/mobile/src/app/targets/[id].tsx`, `app/targets/new.tsx`, `app/vocabulary/word.tsx`,
  `app/vocabulary/question-types.tsx`, `app/reminders.tsx`, `app/about.tsx`, `app/translate.tsx` (and the
  translate component it renders)

**Interfaces:**
- Produces: `ScreenHeader({ title, onBack, close?: boolean, backTestID })`: a row with `arrow-forward` (RTL back)
  or `close` and the title, 20 pt weight 800.

- [ ] **Step 1:** Each screen's header becomes `ScreenHeader`, its existing back testID passed through
  (`wizard-back` keeps its own row: the wizard keeps back and cancel). Content blocks become white cards or
  grouped lists with `shadows.card`; primary and secondary buttons as D9. No text, behaviour or testID changes.
- [ ] **Step 2:** `npm run typecheck` and `npm test --workspace apps/mobile` pass; each screen checked on web.
- [ ] **Step 3:** Commit `feat(app): the screens a tab opens take the new look`.

### Task 7: e2e

**Files:**
- Modify: `e2e/tests/support/targets.ts` (`homeOrder` reads the dots), `e2e/tests/support/users.ts` if needed,
  and every spec the full run breaks: `photo-import.spec.ts` (rewritten), `targets.spec.ts`,
  `enrollments.spec.ts` (switcher label is the language name), `sign-in.spec.ts` and `about.spec.ts`,
  `reminders.spec.ts`, `tutor.spec.ts` (profile is אני / הגדרות), the specs that pressed `vocabulary-back`
- Create: `e2e/tests/navigation.spec.ts`

- [ ] **Step 1:** `homeOrder(page)` returns the dots' order (`[data-testid^="home-dot-"]`), `main` for My words.
  A helper `showCard(page, card)` clicks `home-dot-${card}` when there are dots.
- [ ] **Step 2:** `navigation.spec.ts`: the four tabs from each other without home; the header's translate
  opens translate and back returns to the same tab; the bar is absent in a session; the switcher on **מילים**
  switches language and the list follows (Review Focus 5).
- [ ] **Step 3:** `photo-import.spec.ts`: the flow from `photo-entry` to My words (saved notice on תרגול, word in
  **מילים**), to a new exam (its card on תרגול), to an existing target (its screen lists the word); ✕ asks and
  discards.
- [ ] **Step 4:** `targets.spec.ts`: new targets through the photo flow (no `target-new`, no kind step); order
  through `homeOrder`; a target due tomorrow with words not ready shows `target-urgency-${id}` with the exam
  text and an amber `target-fuse-${id}`; after its session the stack shows the first card (Review Focus 3); a
  dot click reaches a second card (Review Focus 1).
- [ ] **Step 5:** Fix the rest until `npm run e2e` passes in full.
- [ ] **Step 6:** Commit `test(e2e): the tabs, the header, the stack and the photo flow`.

### Task 8: Finish

- [ ] **Step 1:** `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`: all pass.
- [ ] **Step 2:** The spec's Testing section, item by item, has a test.
- [ ] **Step 3:** `superpowers:finishing-a-development-branch` → `git-create-pr` → `ci-green` (CLAUDE.md).
