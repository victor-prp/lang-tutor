# Phase 49 — The exact release, in the app

- **Status:** Scoped with Victor on 2026-10-14 (one-pager, four scope answers, two open and two
  parked questions answered one by one). Then "go till PR": the design below is self-approved
  (CLAUDE.md, *Continue till PR*). Rulings are at the end.
- **Date:** 2026-10-14
- **Source:** the one-pager `drafts/2026-10-14-exact-release-in-app-one-pager.md` (gitignored;
  restated below).
- **Builds on:** phase 30 (a release is a date tag; `/health` names it), phase 32 (the Android
  release by fingerprint, the profile's "גרסה" row, ADR 0012).
- **Touches:** a new About screen, opened from the profile's version row; `/health` gains
  `commit`; the release workflow, `android-release.sh`, the Dockerfile and the dev scripts stamp
  the commit; `expo-clipboard` (a native module, so the next release builds a new binary).

---

## Goal

When something looks wrong on the phone, Victor cannot tell which release it runs, and after
tagging he cannot confirm the release reached the phone. The profile shows the bundle's tag and
nothing else. The app's code, the server and the native binary can each be on a different
release.

**Done means:**

1. After tagging `vX`, Victor opens About on his Android phone and sees `vX` on the Mobile App and
   Server lines.
2. An e2e test asserts that About shows the release and commit the build was made from.

`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:** the About screen with three lines (Mobile App, Server, Native) and a tap that copies them
all:

```
WordsPal
Mobile App: v2026.10.14.2 (a3f9c21)
Server:     v2026.10.14.2 (a3f9c21)
Native:     fp 5b5540e
```

A build with no tag shows `dev (e91c0aa, uncommitted changes)`, and Native shows `Expo Go`.

**Out:** warning about or blocking on a mismatch; a changelog; prompting an update; the binary's
`1.0.0 (2)`, and stamping the tag into the binary; who is signed in; the release anywhere but
About.

## Design

**D1 — Where each line comes from (agreed with Victor).** Each line describes the thing itself,
never what another part believes:

| Line | Version | Commit |
|---|---|---|
| Mobile App | `EXPO_PUBLIC_APP_VERSION`, inlined into the bundle (exists since phase 32) | `EXPO_PUBLIC_APP_COMMIT`, inlined the same way |
| Server | `/health` `.version` (exists) | `/health` `.commit`, from `APP_COMMIT` |
| Native | `fp` + the first 7 characters of `Updates.runtimeVersion`, which is the fingerprint (ADR 0012 R1) | — |

**D2 — Who stamps the commit.** Always 7 characters (`git rev-parse --short=7`), with `-dirty`
appended when the tree has uncommitted changes.

- `release.yml` build-push passes `APP_COMMIT=${GITHUB_SHA::7}`. The Dockerfile hands it to the
  web export as `EXPO_PUBLIC_APP_COMMIT` and to the server as `APP_COMMIT`. A rollback reuses
  the tag's image, whose commit is already inside it.
- `android-release.sh` `publish` sets `EXPO_PUBLIC_APP_COMMIT` next to `EXPO_PUBLIC_APP_VERSION`.
- A new `scripts/with-commit.sh` exports `APP_COMMIT` and `EXPO_PUBLIC_APP_COMMIT` from git
  unless they are already set, then runs its command. The root scripts `server`, `mobile`, `e2e`
  and `e2e:image` run through it, inside `lane-env.sh` (ADR 0006 R3 still holds).
  `image-build.sh` passes `APP_COMMIT` as a build argument.

**D3 — `/health` gains `commit: string`.** `config.ts` reads `APP_COMMIT`, or `unknown`, and
`ServerIdentity` carries it. A new response field is compatible: no `API_LEVEL` change.

**D4 — The app.** A pure module `src/release.ts` formats the lines and the copied text.
`_layout.tsx` stays the only file that names `expo-updates` and now `expo-clipboard` (ADR 0002 R1):
it builds `AppRelease = { version, commit, native }` and a `copy` function. `AppUpdatesProvider`
carries the release where it carried the version. The API client gains `health()`.

- **Profile:** the "גרסה" row stays and becomes a button that opens `/about`.
- **About** (`src/app/about.tsx`): a Hebrew title, the three lines with English labels as agreed,
  a copy button that confirms "הועתק", and back. The Server line reads `…` while `/health`
  loads, and `not reachable` when it fails.
- **Native:** `web` on web, `Expo Go` where updates are disabled, otherwise `fp` and the
  fingerprint.

**D5 — Tests.** Unit tests: `release.test.ts` (formatting, `-dirty`, built-in, unreachable),
`config.test.ts` and `app.test.ts` (`commit` on `/health`), `test-android-release.sh` (the
commit reaches `eas update`). A new e2e `about.spec.ts` opens About from the profile and asserts
the Mobile App and Server lines against `APP_COMMIT`, Native `web`, and the copied text.
`check-adr-0002` gains `expo-clipboard`, checked by planting a violation first.

## Rulings

- **R1 — An embedded bundle reads `built-in`.** `eas build` runs on Expo's servers, where the
  release's shell variables never reach, so the bundle inside a new binary carries no tag. When
  the app runs that bundle (`Updates.isEmbeddedLaunch`, updates enabled, no version inlined), the
  Mobile App line reads `built-in`, not `dev`. The same release run publishes an update for that
  build minutes later.
- **R2 — Copy uses `expo-clipboard`, not the share sheet.** One tap was the agreed scope.
  `Share` would avoid a native module, but it is two taps on Android and has no fallback on
  desktop web. The price: the fingerprint changes, so the first release after this builds and
  submits a new binary (the automated phase 32 path), and Victor's phone needs that Play update
  before later over-the-air updates reach it.
- **R3 — A dev commit is the one at start.** `with-commit.sh` reads git when the server or Metro
  starts. Committing while they run leaves the old value until a restart.
- **R4 — Labels stay English on a Hebrew screen.** They are what Victor agreed and what gets
  pasted into a bug report. The title and buttons come from `strings.ts` in Hebrew.
