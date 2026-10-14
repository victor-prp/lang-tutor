# Phase 49 — The exact release, in the app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (continue till PR, inline). Steps use checkbox (`- [ ]`) syntax.

**Goal:** an About screen, opened from the profile's version row, shows the Mobile App, Server and Native releases and copies them in one tap.

**Architecture:** each part reports itself (spec D1): the bundle has its tag and commit inlined, the server reports its own on `/health`, and the native layer reports its fingerprint through `expo-updates` in `_layout.tsx`. A pure `release.ts` formats the lines.

**Tech Stack:** Expo 57 / expo-router, Hono + zod-openapi, Jest, Playwright, bash.

**Spec:** `docs/superpowers/specs/2026-10-14-lang-tutor-phase-49-about-release-design.md`

## Global Constraints

- Commit stamp: `git rev-parse --short=7`, plus `-dirty` when the tree has uncommitted changes.
- Only `_layout.tsx` imports `expo-updates` and `expo-clipboard` (ADR 0002 R1).
- No port or database literal in scripts (ADR 0006). Root scripts `server`, `mobile`, `e2e` still invoke `lane-env.sh`.
- Labels `Mobile App`, `Server`, `Native` in English; the title and buttons from `strings.ts`.
- No `API_LEVEL` change: `/health` only gains a field.

## Review Focus

- `/health` answers 503 or never answers → the Server line reads `not reachable`, and copying still works.
- An older server (a rollback) with no `commit` → the Server line shows the version alone, no `(undefined)`.
- The bundle inside a new binary (no tag inlined, embedded launch) → `built-in`, not `dev`.
- `APP_COMMIT` unset (a bare `npm run start -w apps/server`) → `unknown`, and the server still starts.
- Copy fails (no clipboard permission on web) → no crash, and the button does not claim "הועתק".

---

### Task 1: The server reports its commit

**Files:** `apps/server/src/config.ts`, `config.test.ts`, `composition.ts` (`ServerIdentity`), `index.ts`, `app.test.ts`; `packages/core/src/api/schemas.ts` (`HealthResponseSchema`).

- [ ] Test first: `loadConfig({ APP_COMMIT: ' a3f9c21 ' })` gives `commit: 'a3f9c21'`; unset or blank gives `'unknown'`. `/health`'s body in `app.test.ts` includes `commit`.
- [ ] Add `commit: env.APP_COMMIT?.trim() || 'unknown'` to config, `commit: string` to `ServerIdentity` and to `HealthResponseSchema` (with a comment), and wire it in `index.ts`.
- [ ] Run `npx jest` in apps/server (unit project) and `npx tsc --noEmit`. Commit.

### Task 2: Everything that builds stamps the commit

**Files:** create `scripts/with-commit.sh`; modify root `package.json` (`server`, `mobile`, `e2e`, `e2e:image`), `scripts/image-build.sh`, `Dockerfile`, `.github/workflows/release.yml`, `scripts/android-release.sh`, `scripts/test-android-release.sh`, `e2e/serverEnv.ts`, `e2e/playwright.config.ts`.

- [ ] `with-commit.sh`: unless `APP_COMMIT` is set, `APP_COMMIT=$(git rev-parse --short=7 HEAD)`, with `-dirty` appended if `git status --porcelain` prints anything; then `export APP_COMMIT EXPO_PUBLIC_APP_COMMIT="${EXPO_PUBLIC_APP_COMMIT:-$APP_COMMIT}"` and `exec "$@"`.
- [ ] Root scripts become `bash scripts/lane-env.sh bash scripts/with-commit.sh <command>`.
- [ ] Dockerfile: `ARG APP_COMMIT=unknown` in both stages; `EXPO_PUBLIC_APP_COMMIT="$APP_COMMIT"` on the web export; `ENV APP_COMMIT=$APP_COMMIT`. `image-build.sh` passes `--build-arg "APP_COMMIT=${APP_COMMIT:-unknown}"`. `release.yml` passes `--build-arg "APP_COMMIT=${GITHUB_SHA::7}"`.
- [ ] `android-release.sh` `publish`: `EXPO_PUBLIC_APP_COMMIT="$(git rev-parse --short=7 HEAD)"`. Test first in `test-android-release.sh`: log the variable from the fake `eas` and assert that it is set (fails, then passes).
- [ ] e2e: `serverEnv.APP_COMMIT = process.env.APP_COMMIT ?? 'unknown'`; the web-export entry's env gets `EXPO_PUBLIC_APP_COMMIT`.
- [ ] Run `bash scripts/test-android-release.sh` and `./scripts/check-adrs.sh`. Commit.

### Task 3: `release.ts` formats the lines

**Files:** create `apps/mobile/src/release.ts`, `release.test.ts`.

**Produces:**
```ts
export type NativeLayer = { kind: 'web' } | { kind: 'expo-go' } | { kind: 'build'; fingerprint: string; embedded: boolean };
export type AppRelease = { version: string | null; commit: string | null; native: NativeLayer };
export type ServerRelease = { state: 'loading' } | { state: 'unreachable' } | { state: 'ok'; version: string; commit?: string };
export function mobileAppLine(r: AppRelease): string;   // 'v… (a3f9c21)' | 'dev (e91c0aa, uncommitted changes)' | 'built-in'
export function serverLine(s: ServerRelease): string;   // '…' | 'not reachable' | 'v… (a3f9c21)' | 'v…'
export function nativeLine(n: NativeLayer): string;     // 'web' | 'Expo Go' | 'fp 5b5540e'
export function releaseReport(r: AppRelease, s: ServerRelease): string; // the copied text
```
- [ ] Tests first for every row above, `-dirty`, `built-in` (embedded build with no version), `unknown` commit shown as is, and the report's aligned layout. Then implement. `npx jest src/release.test.ts` in apps/mobile. Commit.

### Task 4: The About screen

**Files:** `apps/mobile/package.json` (`expo-clipboard` `~57.0.1` via `npm install`, not `expo install`); `src/app/_layout.tsx`; `src/hooks/useAppUpdates.tsx` (`version` → `release: AppRelease`, `useAppRelease()`; new `copy` prop and `useCopy()`); `src/api/client.ts` (`health()`); `src/app/profile.tsx`; create `src/app/about.tsx`; `src/strings.ts`; ADR 0002 doc + `scripts/check-adr-0002-di-with-closures.sh` (`expo-clipboard`).

- [ ] ADR check first: add `expo-clipboard` to R1, plant `import * as Clipboard from 'expo-clipboard'` in `profile.tsx`, confirm `./scripts/check-adrs.sh` reports it, and remove it.
- [ ] `_layout.tsx` builds `appRelease` from `EXPO_PUBLIC_APP_VERSION`, `EXPO_PUBLIC_APP_COMMIT`, `Platform.OS`, `Updates.isEnabled`, `Updates.runtimeVersion`, `Updates.isEmbeddedLaunch`, and `copy = (t) => Clipboard.setStringAsync(t)`.
- [ ] Profile: the version row is a `Pressable` (`testID="app-version"`, the value from `mobileAppLine`) that pushes `/about`.
- [ ] About: title `strings.aboutTitle`; rows `about-mobile-app`, `about-server`, `about-native`; `about-copy` shows `strings.copied` only after `copy` resolves; back. Server via `api.health()` on mount.
- [ ] `npx tsc --noEmit` and `npx jest` in apps/mobile. Commit.

### Task 5: e2e

**Files:** create `e2e/tests/about.spec.ts`.

- [ ] Sign up a learner, open profile → `app-version` → About. Expect `about-mobile-app` and `about-server` to read `dev (<APP_COMMIT formatted>)`, `about-native` `web`. Grant clipboard permissions, tap `about-copy`, expect `הועתק` and the clipboard to hold the report.
- [ ] No free lane here, so CI runs it (lanes full). `npx tsc --noEmit -p e2e`. Commit, push, open the PR.
