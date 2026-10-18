# Phase 64b — Same-size cards and named bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards of one height that slide, named bars in place of dots, and the first tab renamed בית.

**Architecture:** The bars' rules are a pure function in `targets.ts`. `CardStack` lays every card in
one row (so each is as tall as the tallest, and the row fills the free height), slides it with an
`Animated` translate driven by a `PanResponder`, and draws the bars. `BandCard` gains a `fill` mode in
which the header grows. The tab bar renames its first tab.

**Tech Stack:** React Native 0.86 (`Animated`, `PanResponder`, `onLayout`), Expo Router 57, Jest,
Playwright on web.

**Spec:** `docs/superpowers/specs/2026-10-18-lang-tutor-phase-64b-named-bars-design.md`

## Global Constraints

- Hebrew copy; numbers through `isolateLtr`. Day letters Sunday first: א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳.
- No new native module (ADR 0012). No `jest.mock` (ADR 0002).
- Bar colours: on `colors.primary`, urgent `colors.amber`, else `#D0D5DD`; bar 5 pt, target 44 pt.
- Compact labels from 5 cards; spoken label `"<name>, <n> מתוך <total>"`.

## Review Focus

1. **A card taller than the screen** (a long urgency line on a small phone): the row grows and the
   tab scrolls; nothing is clipped. → the home ScrollView keeps scrolling; checked on web at 390×640.
2. **Two targets of a kind on the same weekday** (homework ה׳ this week and next): both read
   "שיעורי בית ה׳". → accepted; the spoken label adds its place ("3 מתוך 6"). Unit test pins it.
3. **A drag that is a tap** (a button pressed inside the card): it must still press. → the responder
   claims only a horizontal move over 12 pt; e2e taps buttons inside cards (existing specs).
4. **Rotation or a resize** (web window, tablet): the slide offset follows the new width. → `onLayout`
   re-measures and the translate is recomputed from the index.
5. **The order changing under an open card** (a session finished): back to the first card. → reset
   on the order's key and on focus, as phase 64.

---

### Task 1: The bars' rules

**Files:** Modify `apps/mobile/src/targets.ts`, `apps/mobile/src/strings.ts`; Test `apps/mobile/src/targets.test.ts`

**Interfaces:**
- Produces: `type StackBar = { card: HomeCard; urgent: boolean; label: string; icon: 'main' | 'exam' | 'homework' | null; spoken: string }`;
  `stackBars(order: readonly HomeCard[], targets: readonly TargetSummary[]): StackBar[]` (`[]` for one card;
  `icon` null and `label` the name below 5 cards, `icon` set and `label` the day letter or '' from 5);
  `strings.dayLetter(jsWeekday: number)`, `strings.barSpoken(name, place, total)`.
- Replaces `stackDots`.

- [ ] **Step 1: Failing tests:** one card → `[]`; `['t1','main']` (exam) → labels `['בוחן','המילים שלי']`,
  icons null, spoken `'בוחן, 1 מתוך 2'`; two homeworks due Thu and Fri plus main → `'שיעורי בית ה׳'`,
  `'שיעורי בית ו׳'`; two homeworks both Thu → both `'שיעורי בית ה׳'`; six cards → icons
  `exam/homework/main`, labels the day letters and `''` for main, spoken names in full with the day;
  urgent for `days_left <= 1`.
- [ ] **Step 2:** `npm test --workspace apps/mobile -- targets` fails.
- [ ] **Step 3:** Implement; replace `stackDots` and its tests.
- [ ] **Step 4:** Passes; full mobile suite passes.
- [ ] **Step 5:** Commit `feat(app): the stack's named bars`.

### Task 2: Same-size cards, sliding, bars, and בית

**Files:** Modify `apps/mobile/src/components/CardStack.tsx`, `BandCard.tsx`, `TargetCard.tsx`,
`MyWordsCard.tsx`, `LearningSection.tsx`, `TabBar.tsx`, `app/(tabs)/index.tsx`, `strings.ts`;
e2e `support/targets.ts`, `targets.spec.ts`, `photo-import.spec.ts`, `navigation.spec.ts`, any `tab-practice` use.

- [ ] **Step 1: Failing e2e** (`navigation.spec`): the first tab is `tab-home` and reads בית; on a learner with an
  exam and My words, the bars read `בוחן` and `המילים שלי`, tapping `home-bar-main` shows My words, and both
  cards report the same height (`boundingBox`).
- [ ] **Step 2:** `npm run e2e -- navigation` fails.
- [ ] **Step 3:** `CardStack({ cards: { key, node }[]; bars: StackBar[]; resetKey })`: a row of slots each as
  wide as the stage (`onLayout`), `alignItems: 'stretch'`, an `Animated.Value` translate of
  `index × (width + 12)`, `PanResponder` (claim on |dx| > 12 and |dx| > |dy|; past 50 pt go one card, else spring
  back; no wrap), bars as `Pressable`s (`home-bar-<card>`, `accessibilityRole: 'button'`, `accessibilityLabel:
  spoken`, selected state), reset to 0 on `resetKey` and focus. `BandCard` `fill`: the card and its pressable
  top flex, the band `flex: 1, justifyContent: 'center'`. Home's ScrollView `flexGrow: 1` and the section
  `flex: 1` so the row takes the free height. TabBar's first tab: `home-outline`, `strings.tabHome` 'בית',
  testID `tab-home`.
- [ ] **Step 4:** Update e2e helpers (`homeOrder` reads `home-bar-`, `showCard` taps a bar) and every spec
  reference; `npm run e2e` passes in full.
- [ ] **Step 5:** Commit `feat(app): cards of one height slide, named bars, and the בית tab`.

### Task 3: Finish

- [ ] `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`; final review; PR; CI.
