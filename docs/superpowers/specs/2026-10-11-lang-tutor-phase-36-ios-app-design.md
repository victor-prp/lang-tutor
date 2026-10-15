# Phase 36 — The iPhone and iPad app: TestFlight and over-the-air updates

- **Status:** Designed on 2026-10-11. Victor scoped it in the one-pager, then said
  `continue till PR` before brainstorming. Every decision below is therefore a *(ruling)*: my
  recommendation, taken without his review, with its reason.
- **Date:** 2026-10-11
- **Source:** the one-pager `drafts/2026-10-11-iphone-app-one-pager.md`. `drafts/` is gitignored,
  so everything this spec depends on is restated here.
- **Builds on:** phase 32 (the Android app: EAS build, submit and update; a release job that
  picks build or update by fingerprint; the API-level gate; ADR 0012).

## Goal

Friends on iPhone, and learners on a family iPad, cannot install WordsPal. Their only routes are
Expo Go pointed at Victor's laptop, or the web build. After this phase they get what Android
friends get: install once from TestFlight, then every release arrives with no action of theirs.
On an iPad the app is laid out for the larger screen, not shown as a stretched phone screen.

Victor has no iPhone or iPad yet, and no Apple Developer account yet. So this phase is proved in
simulators and by the upload, and the release path waits behind a switch until the account exists.

**Done means:**

1. The app runs correctly in the iPhone simulator and the iPad simulator. On the iPad its content
   sits in a centred column instead of stretching across the screen. *(By hand, Victor, once Xcode
   is installed; §7.)*
2. A release with `IOS_RELEASE=on` uploads a TestFlight build. *(By hand, Victor, once the Apple
   Developer account exists; §7.)*
3. While `IOS_RELEASE` is not `on`, a release skips iOS and stays green.
4. `scripts/test-native-release.sh` covers every row of D3 for both platforms, the iOS build-age
   rule and the iOS setup skips. A web e2e test shows the content column capped and centred on a
   wide screen.
5. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass. ADR 0012's check
   reports a planted violation of its extended R2.

## Scope

**In:** iPhone and iPad builds through EAS; TestFlight distribution; over-the-air updates for iOS
on the same `production` channel; an `ios` release job behind its own switch; a centred content
column on wide screens; the update-required screen opening TestFlight on iOS; a simulator build
profile; ADR 0012 extended to iOS; the runbook.

**Out:** a public App Store listing; landscape on iPad; Sign in with Apple (the app offers no
third-party sign-in, so Apple's guideline 4.8 does not ask for it); testing on a real device (the
camera and microphone are checked once someone has one); a macOS runner in CI.

## 1. Decisions

**D1. Same approach as Android: Expo's cloud for build, submit and update.** EAS Build compiles
the iOS app on Expo's Macs, so the release job stays on `ubuntu-latest` and no Xcode is needed in
CI. EAS Submit uploads to App Store Connect, where the build becomes a TestFlight build. EAS
Update hosts the JavaScript for both platforms. Expo holds the distribution certificate, the
provisioning profile and the App Store Connect API key. Rejected: a macOS GitHub runner with
Xcode (a second build system to keep alive, and ten times the runner cost, for a handful of
friends).

**D2. Identity.** Bundle identifier `ai.wordspal.app`, the same as the Android package and
permanent after the first upload. The App Store Connect app id (`ascAppId`) is written into
`eas.json`'s iOS submit profile during the one-time setup and committed then. It is an
identifier, not a secret, and `eas submit --non-interactive` refuses to run without it.

**D3. One release script for both platforms.** `scripts/android-release.sh` becomes
`scripts/native-release.sh <android|ios> [--rollback]`. The D5 table of phase 32 is unchanged and
now applies per platform: each platform has its own fingerprint, its own newest build and its own
updates. What differs is one small table at the top of the script:

| | android | ios |
|---|---|---|
| switch (repository variable) | `ANDROID_RELEASE` | `IOS_RELEASE` |
| extra setup check | — | `submit.production.ios.ascAppId` in `eas.json` |
| where builds go | Play's internal track | TestFlight |
| newest build too old to keep | never | older than 80 days (D5) |

*(ruling: two scripts would copy a hundred lines of decision logic that has already had review
fixes, and the next fix would land in one of them.)* `test-android-release.sh` becomes
`test-native-release.sh` and runs its cases for both platforms.

**D4. An `ios` job beside `android`.** It `needs: apply`, like `android`, so new app code never
calls a server that is not live. The two jobs run in parallel and fail independently: a red
`ios` leaves Android's release standing and the other way round, and each can be rerun alone.
Like `android`, it skips green unless `IOS_RELEASE` is exactly `on`, and also with no
`EXPO_TOKEN`, no EAS project id, or no `ascAppId`. *(ruling: two jobs rather than a matrix, so
ADR 0012's check and `test-release-workflow.sh` read each job by name, as they already do.)*

**D5. TestFlight builds expire after 90 days.** A TestFlight build stops launching 90 days after
upload, and an over-the-air update does not reset that clock. So on iOS, a newest build older
than 80 days takes the build path even when the fingerprint matches. A rollback still never
builds; if the newest build is that old, it prints a `::warning::` saying a release forward is
due. If no release happens for 90 days, the app expires on friends' phones anyway; the runbook
says so. *(ruling: 80 days leaves ten days for a failed build to be noticed and rerun.)*

**D6. Export compliance is declared in the app.** `ios.config.usesNonExemptEncryption: false`
writes `ITSAppUsesNonExemptEncryption = NO`. The app uses only the system's HTTPS, which is exempt.
Without it, every new build waits in App Store Connect at "Missing Compliance" until someone
answers the question by hand, so no build would ever reach friends on its own.

**D7. iPad: the app supports tablets, portrait and full screen.** `ios.supportsTablet: true`
makes it a real iPad app instead of a phone app scaled up. `orientation` stays `portrait`, and
`ios.requireFullScreen: true` opts out of iPad multitasking: App Store Connect rejects an iPad app
that supports multitasking without every orientation. *(ruling: landscape is out of scope, and
this is the one combination App Store Connect accepts without it.)*

**D8. A centred content column on wide screens.** The root layout wraps the navigator in a view
with `maxWidth: layout.maxContentWidth` (640) and `alignSelf: 'center'`, so every screen is at
most 640 points wide and centred, with the app's background on either side. It applies on every
platform: a desktop browser had the same stretched layout. A phone is narrower than 640 and sees
no change. *(ruling: Approaches considered — (A) one column at the root; (B) per-screen tablet
layouts, such as the question and its feedback side by side; (C) larger type and spacing on
tablets. A changes one file and fixes every screen at once, and B and C are design work nobody can
check without a device. A was chosen; B and C can follow once someone has an iPad.)*

**D9. The update-required screen opens TestFlight on iOS.** Its store button opens
`itms-beta://` on iOS, which opens the TestFlight app where the newer build is waiting, and keeps
`market://details?id=ai.wordspal.app` on Android. The label follows the platform: "לעדכון
ב‑TestFlight" on iOS, "לעדכון ב‑Google Play" otherwise. The choice is a pure function,
`storeLink(platform)` in `src/storeLink.ts`, so it is unit tested without a device.

**D10. A simulator build profile.** `eas.json` gets a `simulator` build profile: the `production`
channel and environment, with `ios.simulator: true`. `eas build -p ios --profile simulator` makes
the real standalone app for the iOS simulator, talking to the production server. It needs no Apple
Developer account, so Victor can check done-means 1 on the built app, not only in Expo Go, before
the account exists. The release job never uses it.

**D11. Native builds reach friends through an external TestFlight group.** Friends are not members
of the App Store Connect team, so they are external testers, invited by email or a public link.
Apple reviews the first build of each version for external testing; later builds of the same
version usually skip that review. `version` stays `1.0.0` and EAS increments the build number, so
native releases stay builds of one version. Over-the-air updates need no review and no group: they
reach every installed build of the matching fingerprint. *(ruling: the runbook says how to check
whether a new build joins the group on its own, and how to add it if not. Native releases are rare;
JavaScript releases are most of them.)*

## 2. Release job

```
guard ─► build-push ─► apply (/health = tag) ─┬─► android   native-release.sh android [--rollback]
                                              └─► ios       native-release.sh ios     [--rollback]
```

`ios` is `android` with three changes: the env `IOS_RELEASE: ${{ vars.IOS_RELEASE }}`, the
`expo-github-action` step's condition reads `IOS_RELEASE`, and the script's first argument is
`ios`. The script's commands are phase 32's with `--platform ios`:

- fingerprint: `npx expo-updates fingerprint:generate --platform ios`
- newest build: `eas build:list --platform ios --build-profile production --status finished --limit 1 --json`
  (its `createdAt` is the build's age for D5)
- build, submit, update: as phase 32 §2, with `--platform ios`

## 3. App configuration

`app.json`, under `ios`: `bundleIdentifier: ai.wordspal.app`, `supportsTablet: true`,
`requireFullScreen: true`, `config.usesNonExemptEncryption: false`. The camera, photo library and
microphone reason strings already come from the `expo-image-picker` and `expo-audio` plugins.

`eas.json`: build profile `simulator` (D10); submit profile `production` gains
`ios: { "ascAppId": "<from setup>" }` in the setup PR, not this one. `theme.ts` gains
`layout.maxContentWidth: 640`.

## 4. Failure

- **`ios` fails** (build error, Apple rejects the upload, Expo outage): the server and Android
  releases stand, iPhone friends keep their app, and rerunning `ios` finishes what is missing.
- **The first non-interactive iOS build fails for missing credentials:** the one-time setup was
  skipped. `eas credentials -p ios` (§7) creates them.
- **App Store Connect rejects the upload over the privacy manifest (ITMS-91053):** Expo's template
  declares React Native's required-reason APIs. If Apple asks for one it lacks, `ios.privacyManifests`
  in `app.json` adds it; the rejection email names the API and the reason code.
- **The newest build passes 90 days** with no release in between: the app stops launching on
  iPhones until the next release builds a new one. The runbook says to release at least every 80
  days.

## 5. ADR 0012 — Native client releases, extended

The decision now covers both native apps. R2 becomes: the `android` and `ios` jobs of `release.yml`
each declare `needs: apply`. R1, R3 and R4 are unchanged: R1's fingerprint policy is one setting for
both platforms, R3 is platform-free, and R4 is Play's track (iOS has no track to choose: an upload
goes to TestFlight, and only a person can submit it to the public App Store). The title and prose
say "native apps" instead of "the Android app". `scripts/check-adr-0012-native-client-releases.sh`
checks both jobs, and the `ios` half of R2 is planted once to see it fire.

## 6. Testing

- **`scripts/test-native-release.sh`:** every phase 32 case, run for `android` and for `ios`
  (each platform's switch variable named in its skip notice). For iOS only: a missing `ascAppId`
  skips green; a newest build 81 days old with a matching fingerprint builds; one 79 days old
  updates; a rollback with an 81-day-old build publishes the update and warns. `NOW` (epoch
  seconds) is injectable so the age cases do not depend on the clock. Each new assertion is proved
  able to fail by a planted mutation.
- **`scripts/test-release-workflow.sh`:** pins `ios`'s `needs: apply`, its tag checkout and its
  `IOS_RELEASE` env, as it does for `android`.
- **App unit test:** `storeLink.test.ts` — iOS gets TestFlight's link and label, Android and web
  get Play's.
- **Web e2e:** at the suite's desktop viewport, the home screen's content is at most 640 pixels
  wide and centred. It is the automated stand-in for the iPad check.
- **By hand (Victor):** done-means 1 and 2 (§7).

## 7. One-time setup (Victor)

1. Install Xcode from the Mac App Store and open it once to install the iOS simulators. Then check
   done-means 1: `npm run mobile` and press `i` (Expo Go in the iPhone simulator), `shift+i` to pick
   an iPad simulator; or the built app, `cd apps/mobile && eas build -p ios --profile simulator`,
   then `eas build:run -p ios --latest`.
2. Enrol in the Apple Developer Program, as an individual or an organization (the seller name on
   the store; an organization needs a D-U-N-S number first).
3. `cd apps/mobile && eas credentials -p ios`: production → set up all build credentials (signs in
   to Apple, registers `ai.wordspal.app`, creates the certificate and profile), then App Store
   Connect → set up an API key for submissions.
4. App Store Connect: create the app on bundle id `ai.wordspal.app`; copy its Apple ID (a number)
   into `eas.json` as `submit.production.ios.ascAppId`, through a PR.
5. TestFlight: an external group with the friends' emails or a public link; test information and
   the beta review details Apple asks for.
6. `gh variable set IOS_RELEASE --body on`. The next release takes the build path; check
   done-means 2 in TestFlight.

The iOS runbook, `docs/runbooks/ios.md`, holds these steps, what each row prints, the 90-day rule,
and adding a build to the external group.
