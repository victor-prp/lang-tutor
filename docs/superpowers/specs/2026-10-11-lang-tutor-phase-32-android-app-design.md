# Phase 32 — An Android app for friends: Play internal testing and over-the-air updates

- **Status:** Designed on 2026-10-11. Victor scoped it in the one-pager and settled every
  decision below in the brainstorming conversation (Approach A, "gate only"), then said
  `continue till PR`. The details he did not rule on are marked *(ruling)* with their reason.
- **Date:** 2026-10-11
- **Source:** the one-pager `drafts/2026-10-09-android-play-testers-one-pager.md`. `drafts/` is
  gitignored, so everything this spec depends on is restated here.
- **Builds on:** phase 30 (hosting: Expo Go was the only native path; a release is a `v*` tag that
  builds, applies and checks `/health`), the release command (`npm run release` / `rollback`),
  phase 29 (sign-in; `langtutor://` is a trusted origin).

## Goal

Friends on Android use the app through Expo Go pointed at Victor's laptop, so it disappears when
Metro stops. Installing Expo Go and scanning a QR code is a hurdle, and the web build lacks the
native feel: voice, the camera, a home-screen icon.

After this phase a friend on the tester list installs **WordsPal** from the Play Store and never
needs Victor's laptop. Every release reaches their phone with no action of theirs: JavaScript
over the air within minutes, native changes through Play.

**Done means:**

1. A friend on the tester list opts in, installs from Play, signs in and completes a session on
   their own phone with Victor's laptop off.
2. A JavaScript-only release reaches that phone over the air, with no action from the friend, by
   their next app open after the release.
3. A native release reaches it through Play with no action from the friend.
4. Voice and photo import work in the installed app as they do in Expo Go.
5. A client below the server's `API_LEVEL` sees the "update required" screen.
6. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass. ADR 0012's check
   reports a planted violation of each rule.

Items 1–4 are checked by hand on Victor's Android phone after the one-time setup (§7); CI cannot
reach Play or EAS.

## Scope

**In:** an EAS project with one production build profile; the Play internal testing track,
limited to an email list; over-the-air updates through EAS Update; a release job that picks build
or update by fingerprint; the API-level gate; a version line on the profile screen; the privacy
policy page Play requires; ADR 0012.

**Out** (from the one-pager and the conversation): iPhone (TestFlight is the next phase); a public
Play listing or production track; Play's in-app update prompt (gate only); "Continue with Google";
limiting who may sign up (web sign-up stays open, the tester list limits installs only); lane or
preview builds of the native app.

## 1. Decisions

**D1. Approach A: Expo's cloud for build, submit and update.** EAS Build makes the AAB, EAS
Submit sends it to Play's internal track, EAS Update hosts the JavaScript. It is the least code of
ours for an app that updates itself. Expo holds the upload key (Victor downloads its backup once)
and the Play service-account key. Rejected: Gradle in GitHub Actions plus our own updates server
(a sizeable subsystem for a handful of friends), and the hybrid (Gradle upkeep without dropping
the third party).

**D2. Identity.** Package `ai.wordspal.app`, the reversed domain Victor owns and permanent after
the first upload. Display name `WordsPal`, as the sign-in email already says. The `langtutor`
scheme stays: Better Auth trusts it.

**D3. The runtime version is Expo's fingerprint policy.** A build carries the hash of its native
layer and an update reaches only builds with the same hash, so JavaScript never lands on native
code it was not built against.

**D4. Every release ships the app, after the server.** A new job `android` runs after `apply`,
whose last step waits for `/health` to name the tag. New app code therefore never calls a server
that is not live yet. If `android` fails, the server release stands and the run is red; the job
can be rerun on its own.

**D5. Build or update, decided by `scripts/android-release.sh`.** With `fp` the fingerprint of the
tag's checkout and `latest` the newest finished production build:

| Situation | Action |
|---|---|
| `fp` = `latest`'s runtime, and `fp`'s newest update on `production` names `latest` | `eas update` |
| `fp` = `latest`'s runtime, no such update yet | `eas submit` that build, then `eas update` |
| `fp` ≠ `latest`'s runtime (or no build yet), a release | `eas build`, `eas submit`, `eas update` |
| `fp` ≠ `latest`'s runtime, a rollback | publish nothing, `::warning::` |

The update published after a submit is the marker that the build reached Play *(ruling: EAS
records no "this build is on Play" state the CLI can read, and the update is published only after
`eas submit --wait` succeeds)*. So a rerun after a failed submit submits again rather than
skipping the build forever. Each update's message is `<tag> for build <id>`, and only an update
naming the newest build counts: after a reverted native change, an older build of the same
runtime has updates of its own *(ruling, from the final review)*. Comparing against the *newest* build, not any build with `fp`, means
reverting a native change builds again instead of publishing an update no phone can take. Every
update carries the tag in its message, and `EXPO_PUBLIC_APP_VERSION` carries it into the bundle.

**D6. Rollback.** `npm run rollback` dispatches `release.yml`; the job passes `--rollback` on a
`workflow_dispatch`. A matching fingerprint publishes the old tag's JavaScript as a new update, so
phones follow within minutes. A different one publishes nothing: Play cannot downgrade an installed
app and old JavaScript is not safe on newer native code. The warning says the fix is a release
forward. A tag without `apps/mobile/eas.json` predates this phase, and the job skips itself.

**D7. The job skips, green, until it is set up** *(ruling)*: with no `EXPO_TOKEN` secret, or no
`extra.eas.projectId` in `app.json`, it prints a notice and exits 0. Releases keep working between
the merge and Victor's one-time setup, and the first release after setup takes the build path.
Added after the merge: the repository variable `ANDROID_RELEASE` is the explicit switch. The job
ships only when it is exactly `on`, and skips with a notice naming it otherwise. That lets releases
go out while Play is not ready, without removing the token *(Victor's call, 2026-10-11)*.

**D8. When an update applies.** `updates.checkAutomatically: ON_LOAD` with
`fallbackToCacheTimeout: 3000`: on a cold start the app waits up to 3 s for a new update. If one
arrives it starts on it; otherwise it starts on what it has and applies the download next time.
That is native, no code of ours. On top of it, `src/appUpdates.ts`: returning to the foreground
after ≥ 30 minutes in the background checks, fetches and reloads. Session state is on the server,
so a reload loses nothing. The app never reloads while it stays in the foreground.

**D9. The gate.** `packages/core/src/apiLevel.ts` exports `API_LEVEL` (starts at 1) and
`API_LEVEL_HEADER` (`X-Api-Level`). The native app sends the header on every API call; the web app
does not *(ruling: the web app is served by the same image and is never behind; no header also
means no CORS preflight change)*. Server middleware on `/api/*`, before the auth mount: a header
lower than `API_LEVEL` answers **426** `{ "error": "app_update_required" }`. A missing or
unparsable header passes. The rule: **a change that breaks older clients raises `API_LEVEL` by one
in the same PR.** In the app, `api/client.ts` reports a 426 through `onUpdateRequired`, beside
`onUnauthorized`. The root layout then renders one screen in place of the navigator. That screen
first tries an over-the-air update (a newer bundle for this build may fix it) and reloads if one
arrives. Otherwise it offers a button to `market://details?id=ai.wordspal.app`, and a "check again" button that retries
the update: a release that raises the level answers 426 minutes before its update is published. Better Auth's own
calls do not pass through the client and are not gated; the first API call after sign-in is.

**D10. Version line.** The profile screen's last row shows `EXPO_PUBLIC_APP_VERSION`. It is set to
the tag by the `android` job for every update and by the Dockerfile for the web export (from its
existing `APP_VERSION` argument). Unset, as in Expo Go, a lane, or a freshly installed build before
its first update, it shows `dev` *(ruling: an EAS build runs on Expo's machines and does not get
the CI shell's environment, and a fresh install takes the matching update on its first open anyway)*.

**D11. Microphone.** `expo-audio` joins the config plugins with a microphone reason string, as
`expo-image-picker` already does for the camera. Expo Go granted it implicitly; a standalone build
without it would break voice quietly.

**D12. Privacy policy.** Play requires one for an app that uses the camera and microphone. A
static page, `apps/mobile/public/privacy.html`, is served by the web export at
`https://app.wordspal.ai/privacy.html`. The text is drafted from what the app actually sends, and
Victor approves it before the Play declaration cites it.

## 2. Release job

```
guard ─► build-push ─► apply (/health = tag) ─► android
                                                 checkout the tag; npm ci; setup eas-cli
                                                 scripts/android-release.sh [--rollback]
```

`android`: `timeout-minutes: 60`, `contents: read`; the `EXPO_TOKEN` secret; eas-cli pinned
through `expo/expo-github-action`. The script works in `apps/mobile`, reads the tag from `TAG`, and
calls `npx expo-updates fingerprint:generate --platform android` and `eas` with `--non-interactive`
and `--json` where it reads output. Its commands, so a reader can check them by hand:

- newest build: `eas build:list --platform android --build-profile production --status finished --limit 1 --json`
- update marker: `eas update:list --branch production --runtime-version <fp> --limit 1 --json`
  (the newest group's message contains `for build <newest id>`)
- build: `eas build --platform android --profile production --wait --json` → the build id
- submit: `eas submit --platform android --profile production --id <id> --wait`
- update: `eas update --branch production --platform android --environment production
  --message "<tag> for build <id>"`, with `EXPO_PUBLIC_APP_VERSION=<tag>`

`eas.json`: `cli.appVersionSource: remote`; build profile `production` with `channel: production`,
`android.buildType: app-bundle`, `autoIncrement: true`; submit profile `production` with
`track: internal`.

## 3. App configuration

`app.json`: `name` WordsPal; `android.package` `ai.wordspal.app`; `runtimeVersion: { "policy":
"fingerprint" }`; `updates: { "checkAutomatically": "ON_LOAD", "fallbackToCacheTimeout": 3000 }`;
the plugins `expo-updates` and `expo-audio`. `updates.url` and `extra.eas.projectId` are written by
`eas init` and `eas update:configure` during the one-time setup and committed then. Both are
identifiers, not secrets.

`expo-updates` is a new dependency at the SDK 57 range from `bundledNativeModules.json`. It joins
ADR 0002 R1's list: only `_layout.tsx` imports it.

## 4. Failure

- **Android job fails** (build error, Play rejects, Expo outage): the server release stands,
  friends keep their app, and rerunning the job finishes what is missing (D5).
- **An update crashes on launch:** `expo-updates` falls back to the previous update by itself.
- **No network on the phone:** a failed check is silent. The app starts on what it has.
- **A rollback across a native change:** nothing is published, and the warning says to release
  forward (D6). The gate cannot catch an app that is *ahead* of the server.

## 5. ADR 0012 — Native client releases

Rules: (R1) the runtime version policy is `fingerprint`; (R2) the `android` job needs `apply`;
(R3) the literal `X-Api-Level` is written only in `packages/core/src/apiLevel.ts`; (R4) the Play
submit track is `internal`. Plus the API-level rule from D9, which a script cannot see. It is the
PR review's job, and the ADR says so. `scripts/check-adr-0012-native-client-releases.sh` enforces
R1–R4, and each rule is planted once to see it fire.

## 6. Testing

- **Server:** the gate's cases (lower → 426 with the body, equal → passes, higher → passes,
  missing → passes, garbage → passes) in `apiLevel.test.ts`, plus one `app.test.ts` case showing it
  runs before the session middleware (an unauthenticated old client gets 426, not 401).
- **App:** the client sends the headers it is given and maps 426 to `onUpdateRequired` (and still
  throws). `appUpdates.ts`: no check under 30 minutes, check-fetch-reload over it, nothing when
  updates are disabled, a failed check swallowed. The update-required flow tries over the air
  before offering the store. The engine is injected (ADR 0002), and the tests use no `jest.mock`.
- **`scripts/test-android-release.sh`:** stubs `eas` and `npx` on `PATH` and covers every row of
  D5, the rollback skip, both setup skips, a pre-phase tag, and a failing submit that publishes no
  update. Each assertion is proved able to fail by a planted mutation. It runs in CI's `check-adrs`
  job beside `test-release.sh`; `test-release-workflow.sh` pins `android`'s `needs` and its tag
  checkout.
- **Web e2e is unchanged:** the web app sends no header, which is the proof the gate leaves it
  alone.
- **By hand on Victor's phone after the setup:** done-means 1–4.

## 7. One-time setup (Victor)

1. Play Console: a developer account with identity verification; the app `ai.wordspal.app`; the
   internal testing track with a tester email list; content rating; data safety (answers drafted
   in the runbook); privacy policy URL `https://app.wordspal.ai/privacy.html`.
2. Expo: an account; in `apps/mobile`, `eas init` and `eas update:configure`; commit the `app.json`
   change through a PR. `eas channel:create production`.
3. Play service account with release rights; upload its key with `eas credentials`.
4. GitHub secret `EXPO_TOKEN` (an Expo robot token).
5. The first release after that takes the build path. A new Play app accepts only a draft release
   through the API until its first release is rolled out by hand, so if the submit fails with
   "Only releases with status draft may be created on draft app", upload that AAB once in Play
   Console's internal track and roll it out. Then publish its first update by hand, with the
   message `<tag> for build <id>`. Rerunning the job would submit the build again, which Play
   refuses (from the final review).
6. Download the upload-key backup: `eas credentials` → Android → production → download keystore.

The Android runbook, `docs/runbooks/android.md`, holds these steps, what each D5 row prints, and rollback
across a native change.
