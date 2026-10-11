# Phase 32 — Android app for friends: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, per
> `continue till PR`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WordsPal installs from Play's internal track and updates itself: JavaScript over the
air, native changes through Play, an "update required" gate for clients the server has left behind.

**Architecture:** EAS Build/Submit/Update driven from a new `android` job in `release.yml`, after
`apply`. A bash script decides build vs update by fingerprint. A shared `API_LEVEL` constant, a
server middleware answering 426, and an app screen that tries over the air before Play.

**Tech Stack:** Expo SDK 57 (`expo-updates` ~57.0.17), eas-cli 24.8.0, Hono middleware, Jest, bash.

**Spec:** `docs/superpowers/specs/2026-10-11-lang-tutor-phase-32-android-app-design.md`

## Global Constraints

- Package `ai.wordspal.app`, display name `WordsPal`, scheme `langtutor` unchanged.
- `API_LEVEL` starts at `1`; header `X-Api-Level`; 426 body `{ "error": "app_update_required" }`.
- Missing or unparsable header passes. The web app never sends it.
- Foreground check threshold: 30 minutes in the background. Cold-start `fallbackToCacheTimeout: 3000`.
- `expo-updates` is imported only in `apps/mobile/src/app/_layout.tsx` (ADR 0002 R1).
- No port or database name hardcoded (ADR 0006); no `jest.mock` (ADR 0002 R4).
- `npm install` the `bundledNativeModules.json` range; `npx expo install` fails here (EALLOWSCRIPTS).

## Review Focus

1. An unauthenticated old client: the gate must answer 426 before the session middleware's 401,
   or a signed-out friend on an old build sees the sign-in screen forever. Pinned in Task 1.
2. A header like `"abc"`, `""` or `"1.5"` must pass, not 426: a garbled header must never lock a
   current client out. Pinned in Task 1.
3. A 426 must still throw from the API client, or callers treat it as data. Pinned in Task 2.
4. Returning from the background repeatedly within 30 minutes must not check again each time
   (no polling loop; Expo warns against it). Pinned in Task 2.
5. Reverting a native change (the fingerprint equals an *older* build's) must build, not publish
   an update no phone can take. Pinned in Task 3.

---

### Task 1: The gate on the server

**Files:** create `packages/core/src/apiLevel.ts`, `apps/server/src/routes/apiLevel.ts`,
`apps/server/src/routes/apiLevel.test.ts`; modify `packages/core/package.json` (export
`./apiLevel`), `apps/server/src/app.ts`, `apps/server/src/app.test.ts`.

**Produces:** `API_LEVEL: number`, `API_LEVEL_HEADER: 'X-Api-Level'` from `@lang-tutor/core/apiLevel`;
`createApiLevelGate({ apiLevel }): MiddlewareHandler`.

- [ ] Tests in `apiLevel.test.ts`, on a bare Hono app with the gate on `/api/*` and a 200 route:
  lower → 426 and the body; equal and higher → 200; missing, `''`, `'abc'`, `'1.5'` → 200.
- [ ] `app.test.ts`: a request with `X-Api-Level: 0` and no session gets 426, not 401.
- [ ] Run them and see them fail; implement. The gate parses `/^\d+$/` only:

```ts
export function createApiLevelGate({ apiLevel }: { apiLevel: number }): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header(API_LEVEL_HEADER);
    if (raw !== undefined && /^\d+$/.test(raw) && Number(raw) < apiLevel) {
      return c.json({ error: 'app_update_required' }, 426);
    }
    await next();
  };
}
```

  Mounted in `createApp` right after `cors`, as `app.use('/api/*', createApiLevelGate({ apiLevel: API_LEVEL }))`.
- [ ] `npm test --workspace apps/server`; commit `feat(server): an API-level gate answers 426 to clients left behind`.

### Task 2: The app — headers, gate screen, updates on resume, version line

**Files:** create `apps/mobile/src/appUpdates.ts` (+ test), `apps/mobile/src/hooks/useAppUpdates.tsx`,
`apps/mobile/src/components/UpdateRequired.tsx`; modify `api/client.ts` (+ test), `app/_layout.tsx`,
`app/profile.tsx`, `strings.ts`, `app.json`, `package.json`, `scripts/check-adr-0002-di-with-closures.sh`
and ADR 0002's R1 command.

**Consumes:** `API_LEVEL`, `API_LEVEL_HEADER` (Task 1).
**Produces:** `ApiClientDeps.appHeaders: Record<string, string>` and `onUpdateRequired: () => void`;
`createAppUpdates({ engine, now, minBackgroundMs })` → `{ onAppStateChange(state), tryOverTheAir(): Promise<boolean> }`,
with `engine = { isEnabled, check(): Promise<boolean>, fetch(): Promise<void>, reload(): Promise<void> }`.

- [ ] Client tests: `appHeaders` are on every request; a 426 calls `onUpdateRequired` once and
  still throws `ApiError(426, 'app_update_required')`.
- [ ] `appUpdates` tests (fake engine and clock): background 10 min → active: no check; 31 min →
  check, fetch, reload; a check that finds nothing does not fetch; disabled engine: nothing; a
  rejected check is swallowed; two quick returns after one long absence check once;
  `tryOverTheAir` → true after fetch and reload, false when nothing is available, false when disabled.
- [ ] Implement. `_layout.tsx` builds the engine from `expo-updates`
  (`check: async () => (await Updates.checkForUpdateAsync()).isAvailable`), subscribes
  `AppState`, passes `appHeaders` (`{}` on web), and holds `updateRequired` state in an
  `AppUpdatesProvider`. When it is set, the layout renders `<UpdateRequired/>` in place of `<Stack/>`.
  The screen runs `tryOverTheAir()` once, then shows the message and a button to
  `Linking.openURL('market://details?id=ai.wordspal.app')`.
- [ ] Version: `process.env.EXPO_PUBLIC_APP_VERSION ?? 'dev'` read in `_layout.tsx`, given to the
  provider, and shown as the last profile row (`testID="app-version"`).
- [ ] `npm install expo-updates@~57.0.17 --workspace apps/mobile`. `app.json`: name, package,
  `runtimeVersion`, `updates`, plugins `expo-updates` and `["expo-audio", { "microphonePermission": … }]`.
- [ ] Add `expo-updates` to ADR 0002 R1 (ADR text and check script, same command).
- [ ] `npm test --workspace apps/mobile`, `npm run typecheck --workspace apps/mobile`, `npm run lint:arch`; commit.

### Task 3: Release job

**Files:** create `apps/mobile/eas.json`, `scripts/android-release.sh`, `scripts/test-android-release.sh`;
modify `.github/workflows/release.yml`, `scripts/test-release-workflow.sh`, `.github/workflows/ci.yml`.

- [ ] `test-android-release.sh`: a temp `apps/mobile` with `app.json` and `eas.json`. Stub `eas` and
  `npx` on `PATH` answer from env fixtures (`FP`, `LATEST_RT`, `HAS_UPDATE`, `SUBMIT_FAILS`) and log
  their arguments. Cases: every D5 row; a reverted native change (fingerprint ≠ newest, = older) →
  build; rollback with a different fingerprint → warning, nothing published; rollback with the same
  fingerprint → update; no `EXPO_TOKEN` → skip; no `projectId` → skip; no `eas.json` → skip;
  a failed submit → no update, exit ≠ 0; the update carries `--message <tag>` and
  `EXPO_PUBLIC_APP_VERSION=<tag>`.
- [ ] Implement `android-release.sh` per spec §2 (`MOBILE_DIR` overridable for the test).
- [ ] `release.yml`: job `android`, `needs: apply`, checkout the tag, setup-node, `npm ci`,
  `expo/expo-github-action@v8` with `eas-version: 24.8.0` and `token: ${{ secrets.EXPO_TOKEN }}`,
  then run the script with `--rollback` when `github.event_name == 'workflow_dispatch'`.
- [ ] `test-release-workflow.sh`: `android` needs `apply` and checks out no other ref. `ci.yml`
  runs `test-android-release.sh` in `check-adrs`.
- [ ] Plant one mutation per branch and see the test fail; commit.

### Task 4: ADR 0012, privacy page, web version, runbook

**Files:** create `docs/adr/adr-0012-native-client-releases.md`,
`scripts/check-adr-0012-native-client-releases.sh`, `apps/mobile/public/privacy.html`; modify
`Dockerfile`, `README.md`.

- [ ] ADR with R1–R4 (spec §5) and the API-level rule; the check script prints `ok`/`VIOLATION`
  in the ADR 0002 style. Plant each violation and see it reported.
- [ ] `privacy.html`: what is collected (email, saved words and progress, voice recordings and
  photos sent for checking and processed by Google Gemini, no ads, no selling), retention and
  deletion by email request, contact `code@wordspal.ai` *(assumed)*.
- [ ] Dockerfile: `ARG APP_VERSION=dev` in the build stage, `EXPO_PUBLIC_APP_VERSION=$APP_VERSION`
  on the web export.
- [ ] README: the Android section (one-time setup, what the job prints, rollback across native, data
  safety answers).
- [ ] `npm run lint:arch`, `npm test`, `npm run test:all`, `npm run e2e`; commit.
