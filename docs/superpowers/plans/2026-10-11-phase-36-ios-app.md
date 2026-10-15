# Phase 36 — iPhone and iPad app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship WordsPal to iPhone and iPad through TestFlight on every release, behind `IOS_RELEASE`, with a centred content column on wide screens.

**Architecture:** `android-release.sh` becomes `native-release.sh <android|ios>` with a per-platform table (switch, setup check, store name, max build age). A new `ios` job runs it after `apply`. The app gains iOS config, a 640-point root column, and a platform-aware store link.

**Tech Stack:** bash + jq, GitHub Actions, EAS CLI, Expo SDK 57, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-11-lang-tutor-phase-36-ios-app-design.md`

## Global Constraints

- Bundle identifier `ai.wordspal.app`.
- Switch: repository variable `IOS_RELEASE`; only the exact value `on` ships.
- iOS newest build older than **80 days** takes the build path; a rollback never builds.
- `layout.maxContentWidth` is **640**.
- No `jest.mock` in app tests (ADR 0002); no hardcoded ports or database names (ADR 0006).

## Review Focus

- `createdAt` missing or unparsable in `eas build:list` output → treat the build as not too old (no surprise build), never crash. Test in Task 1.
- `NOW` unset → the script uses `date +%s`. Covered by every non-age case in Task 1.
- iOS rollback with an expired build → publishes the update and warns; never builds. Test in Task 1.
- Android behaviour must be byte-for-byte the same as before the rename: every old case still runs for `android`. Task 1.
- Phone-width screens must not change: the column is `width: '100%'` capped by `maxWidth`, so it fills anything narrower than 640. Task 3 e2e checks the wide case; the existing e2e suite at desktop width runs every screen inside the column.

---

### Task 1: `native-release.sh` for both platforms

**Files:**
- Rename: `scripts/android-release.sh` → `scripts/native-release.sh`
- Rename: `scripts/test-android-release.sh` → `scripts/test-native-release.sh`
- Modify: `.github/workflows/ci.yml` (the `check-adrs` job runs the renamed test), `.github/workflows/release.yml` (the `android` job calls `native-release.sh android`)

**Interfaces:** Produces `scripts/native-release.sh <android|ios> [--rollback]`; env `TAG`, `ANDROID_RELEASE`/`IOS_RELEASE`, `EXPO_TOKEN`, `MOBILE_DIR`, `NOW` (epoch seconds, tests only).

- [ ] **Step 1:** `git mv` both files; in the test, wrap every existing case in `for platform in android ios`, with `fixture` exporting `${PLATFORM_VAR}=on` (`ANDROID_RELEASE` or `IOS_RELEASE`), and the iOS fixture writing `{"submit":{"production":{"ios":{"ascAppId":"123"}}}}` to `eas.json`. Assertions that name `--platform android` use `--platform $platform`. The stub `eas build:list` prints `"createdAt":"$CREATED"`, defaulting to one day before `NOW`.
- [ ] **Step 2:** Add the iOS-only cases: no `ascAppId` skips green with a notice naming it; 81-day-old build with matching fp builds, submits, updates; 79-day-old updates only; rollback with an 81-day-old build updates and warns; missing `createdAt` updates only. Add: Android ignores age (81 days, matching fp → update only).
- [ ] **Step 3:** Run `bash scripts/test-native-release.sh` → FAIL (script takes no platform yet).
- [ ] **Step 4:** Implement in `native-release.sh`: parse `$1` (`android`|`ios`, else `::error::` exit 2); set `switch_var`, `store`, `max_age_days` (`ios`: 80, `android`: empty); read the switch with `${!switch_var}`; iOS checks `jq -e '.submit.production.ios.ascAppId // empty' eas.json`; every `--platform android` → `--platform "$platform"`; after reading the newest build, compute `too_old` with `jq --argjson now "${NOW:-$(date +%s)}" --argjson days "$max_age_days" '(.[0].createdAt // empty | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $t | ($now - $t) > ($days * 86400)'` (empty/invalid → false). Branch: same fp and not too old → existing path; same fp, too old, release → build path; same fp, too old, rollback → update + `::warning::`.
- [ ] **Step 5:** Run the test → PASS. Plant two mutations (drop the age branch; swap the switch var) and see each fail; revert.
- [ ] **Step 6:** Update `ci.yml` and the `android` job's `run:` line; run `bash scripts/test-release-workflow.sh` → PASS. Commit.

### Task 2: The `ios` job and ADR 0012

**Files:**
- Modify: `.github/workflows/release.yml` (new `ios` job), `scripts/test-release-workflow.sh`, `scripts/check-adr-0012-native-client-releases.sh`, `docs/adr/adr-0012-native-client-releases.md`, `README.md` (ADR table row)

- [ ] **Step 1:** Add to `test-release-workflow.sh`: `ios runs after apply`, `ios ships the tag, not master`, `ios passes --rollback on a dispatch`, `ios hands the job the IOS_RELEASE variable`, `ios runs native-release.sh ios`. Run → FAIL.
- [ ] **Step 2:** Add the `ios` job: a copy of `android` with `IOS_RELEASE: ${{ vars.IOS_RELEASE }}`, `if: env.IOS_RELEASE == 'on' && env.EXPO_TOKEN != ''`, and `./scripts/native-release.sh ios …`. Run → PASS.
- [ ] **Step 3:** ADR 0012: title and prose say "native apps"; R2 names both jobs; the detection block's `r2` loops over `android ios`; add phase 36 to Source. Mirror `r2` verbatim in the check script. Plant: remove `needs: apply` from `ios` → `npm run lint:arch` reports R2; restore → clean. README row updated. Commit.

### Task 3: App configuration, store link, content column

**Files:**
- Modify: `apps/mobile/app.json`, `apps/mobile/eas.json`, `apps/mobile/src/theme.ts`, `apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/components/UpdateRequired.tsx`, `apps/mobile/src/strings.ts`
- Create: `apps/mobile/src/storeLink.ts`, `apps/mobile/src/storeLink.test.ts`, `e2e/tests/wide-screen.spec.ts`

**Interfaces:** Produces `storeLink(platform: string): { url: string; label: string }`; `layout.maxContentWidth`.

- [ ] **Step 1:** `storeLink.test.ts`: `ios` → `{ url: 'itms-beta://', label: strings.updateRequiredButtonIos }`; `android` and `web` → `market://details?id=ai.wordspal.app` with `strings.updateRequiredButton`. Run → FAIL.
- [ ] **Step 2:** Implement `storeLink.ts`; add `updateRequiredButtonIos: 'לעדכון ב‑TestFlight'`; `UpdateRequired` uses `storeLink(Platform.OS)`. Run the mobile unit tests and typecheck → PASS.
- [ ] **Step 3:** `app.json` `ios`: `bundleIdentifier`, `supportsTablet: true`, `requireFullScreen: true`, `config.usesNonExemptEncryption: false`. `eas.json`: `build.simulator` = `{ "channel": "production", "environment": "production", "ios": { "simulator": true } }`.
- [ ] **Step 4:** e2e `wide-screen.spec.ts`: sign in a learner as other specs do, open home, assert the column's bounding box is ≤ 640 wide and its centre within 2 px of the viewport's. Run → FAIL.
- [ ] **Step 5:** `theme.ts` exports `layout = { maxContentWidth: 640 }`; `_layout.tsx` wraps `AppUpdatesProvider` in `<View style={styles.column} testID="content-column">` with `{ flex: 1, width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center' }`. Run the spec and the full e2e suite → PASS. Commit.

### Task 4: Runbook and README

**Files:** Create `docs/runbooks/ios.md`; modify `README.md` (an *iPhone and iPad app* section beside *The Android app*), `docs/runbooks/android.md` (script name).

- [ ] **Step 1:** Write the runbook from spec §7, D5 and D11, with a status checklist like `android.md`'s. Fix every reference to `android-release.sh`. Commit.
