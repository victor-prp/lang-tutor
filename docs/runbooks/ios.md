# iOS runbook

Friends install **WordsPal** (`ai.wordspal.app`) on iPhone or iPad from TestFlight, invited to an
external testing group. Every release ships the app from the Release workflow's `ios` job, which
runs beside `android` after the server is live. If native code is unchanged, the job publishes an
over-the-air update that phones take within minutes. If native code changed, it uploads a new
build to TestFlight. Design:
[phase 36](../superpowers/specs/2026-10-11-lang-tutor-phase-36-ios-app-design.md),
[ADR 0012](../adr/adr-0012-native-client-releases.md).

**The on/off switch is the repository variable `IOS_RELEASE`.** The `ios` job ships only when
it is exactly `on`. Unset or any other value means the job does not run: the release run shows
`ios` as *skipped*, greyed out, and the server, the web and Android still release. Turn it on or off with:

```bash
/opt/homebrew/bin/gh variable set IOS_RELEASE --body on    # ship the iOS app with every release
/opt/homebrew/bin/gh variable set IOS_RELEASE --body off   # pause: releases skip iOS
```

With `IOS_RELEASE` on, the job still skips, green, with a `::notice::`, while steps 3–4 are not
done.

## Where go-live stands

Last updated 2026-10-17.

- [ ] **1. Xcode and the simulators.** Not started. Blocked on a macOS update: the App Store's
      Xcode needs macOS 26.6 or later and this Mac is on 26.5.2, so run Software Update first
      (26.7.1 is enough). Nothing automated needs Xcode, only the simulator check by hand, so
      this can wait for a real iPhone or iPad from TestFlight after step 6.
- [x] **2. Apple Developer Program.** Active 2026-10-16: team Victor Perepelitsky
      (6883G8TLZV), as an individual.
- [x] **3. Signing and submission credentials in EAS.** Done 2026-10-16. The bundle id
      `ai.wordspal.app` is registered with Push Notifications enabled; EAS holds the
      distribution certificate, the provisioning profile, and an App Store Connect API key with
      the App Manager role. No push key: reminders are Android-only.
- [x] **4. The app in App Store Connect, and its id in `eas.json`.** Done 2026-10-16: Apple ID
      `6823711479`, in `submit.production.ios.ascAppId`.
- [x] **5. TestFlight's external group.** Done 2026-10-16: the **Friends** group, with test
      information and beta review details (reviewer sign-in `ios_tester_0001@wordspal.ai`).
      EAS also created an internal group, *Team (Expo)*, on its first submit; it is harmless.
- [x] **6. The first release.** Done 2026-10-16: `IOS_RELEASE` on, release `v2026.10.16`
      built 1.0.0 (1), uploaded it and published its update. Beta App Review approved it for
      Friends on 2026-10-17.
- [ ] **7. Invite friends.** After step 6.

`EXPO_TOKEN` and the EAS project are already in place from Android's setup; iOS uses the same.

## Go-live, once

Run from the main checkout on `master`, after phase 36 has merged.

1. **Xcode and the simulators** (the phase's done-means 1):
   1. Install **Xcode** from the Mac App Store, open it once, and let it install the iOS
      platform. Then `sudo xcode-select -s /Applications/Xcode.app`. The App Store offers only
      the newest Xcode, which needs the current macOS point release, so if it refuses with
      "macOS … or later is required", run Software Update first (`softwareupdate -l` lists it).
   2. Expo Go in the simulators: `npm run mobile`, then press `i` for an iPhone, or `shift+i` to
      pick an iPad. Sign in and finish a session.
   3. The real built app, talking to production, with no Apple account needed:

      ```bash
      cd apps/mobile
      npx eas-cli@24.8.0 build --platform ios --profile simulator   # about 15–20 minutes on Expo's Macs
      npx eas-cli@24.8.0 build:run --platform ios --latest          # installs it into a booted simulator
      ```

   *Proves:* on the iPad the screens sit in a centred column, not stretched edge to edge, and
   in portrait only. The simulator has no camera: photo import works from the library only, and
   voice uses the Mac's microphone.

2. **Apple Developer Program.** At [developer.apple.com/programs](https://developer.apple.com/programs),
   enrol for $99 a year. **Individual** shows your legal name as the seller and is approved in
   a day or two. **Organisation** shows the company name, needs a D-U-N-S number and a
   registered company, and can take weeks. Use the same kind as the Play account if you want
   one seller name in both stores. An individual account can be converted later.

   *Proves:* you can sign in at [appstoreconnect.apple.com](https://appstoreconnect.apple.com).

3. **Signing and submission credentials in EAS.** Expo creates and keeps them:

   ```bash
   cd apps/mobile
   npx eas-cli@24.8.0 credentials --platform ios
   ```

   1. *production → Build credentials → Set up all the required credentials*: signs in to
      Apple, registers the bundle id `ai.wordspal.app`, and creates the distribution
      certificate and provisioning profile.
   2. *App Store Connect → Manage your API key → Set up an API key for submissions*: lets
      `eas submit` upload without your Apple password.

   `You have no team associated with your Apple account` after a successful sign-in means the
   Developer Program enrolment is still being processed. Nothing to fix: wait for Apple's
   welcome email and rerun.

   *Proves:* running it again lists the certificate, the profile and the API key.

4. **The app in App Store Connect.** *Apps → + → New App*: iOS, name **WordsPal**, primary
   language Hebrew, bundle id `ai.wordspal.app`, SKU `wordspal`. Open *App Information* and copy
   the **Apple ID** (a number). Put it into `apps/mobile/eas.json` and merge it through a PR:

   ```json
   "submit": {
     "production": {
       "android": { "track": "internal" },
       "ios": { "ascAppId": "<the Apple ID>" }
     }
   }
   ```

   It is an identifier, not a secret. The `ios` job skips until it is there, because
   `eas submit` refuses to run without it.

5. **TestFlight's external group.** In the app, *TestFlight*:
   1. *Test Information*: a feedback email, a beta description, and the privacy policy URL
      `https://app.wordspal.ai/privacy.html`.
   2. *Beta App Review Information*: contact details, and a sign-in Apple's reviewer can use:
      user name `ios_tester_0001@wordspal.ai` and its fixed 8-digit code as the password, the
      pair listed in the prod secret `REVIEWER_CODES` (see
      [Reviewer accounts](hosting.md#reviewer-accounts)). In the notes: "Enter the email, tap
      the button to get a code, then type the password as the code; no email is sent."
   3. *External Testing → +*: a group called **Friends**. Add their emails, or turn on its
      public link.

6. **The first release.** Turn iOS releases on, then release:

   ```bash
   /opt/homebrew/bin/gh variable set IOS_RELEASE --body on
   npm run release
   ```

   The `ios` job finds no build, so it builds (about 15–20 minutes), uploads it to TestFlight,
   then publishes the update. Apple processes the upload for a few minutes more. Then, in
   *TestFlight → Friends → Builds → +*, add the build and submit it for Beta App Review. The
   first build of a version waits for that review, usually under a day.

   *Proves:* the phase's done-means 2. The build shows in TestFlight as *Ready to test* for
   the Friends group.

7. **Invite friends.** They install the TestFlight app, open your invitation or the public
   link, and install WordsPal from it. After that, over-the-air updates arrive by themselves.

## What a release prints

The `ios` job runs `scripts/native-release.sh ios` from the tag's checkout:

| It prints | It did |
|---|---|
| `Same native layer as build …: publishing … over the air.` | `eas update`. Phones take it on their next open, or after 30 minutes away |
| `Build … has no update yet, so it never reached TestFlight: submitting it first.` | A rerun after a failed submit: `eas submit`, then `eas update` |
| `The native layer changed: building, submitting to TestFlight, then publishing …` | `eas build`, `eas submit`, `eas update`, then a `::notice::` to add the build to the Friends group (below) |
| `Build … is more than 80 days old and TestFlight expires it at 90: building anew …` | The same, with no native change: a fresh build before the old one expires |
| a `::warning::` about the native layer, on a rollback | Nothing. Release a fix forward |
| a `::warning::` that the build is more than 80 days old, on a rollback | The update was published, but a rollback never builds. Release forward soon |
| nothing: the job shows as *skipped* | `IOS_RELEASE` is not `on` |
| a `::notice::` that it skipped | `eas.json` has no `ascAppId`, or the tag predates phase 32 |

A failure in `ios` leaves the server and Android releases standing, and friends keep their
current app. Rerun that job alone (*Actions → Release → the run → Re-run failed jobs*).

## New builds and the Friends group

`eas submit` uploads a build to App Store Connect. External testers get it only once it is in
their group. After a native release, open *TestFlight → Friends → Builds*: if the new build is
not listed, add it with *+*. The version stays `1.0.0` and only the build number grows, so later
builds of the same version usually skip Beta App Review. Over-the-air updates need none of this.

## The 90-day rule

A TestFlight build stops launching 90 days after its upload, and an over-the-air update does
not reset that. The job rebuilds once the newest build is 80 days old, but only when a release
runs. **Release at least every 80 days**, even with nothing to ship, or the app stops opening
on friends' iPhones until the next release.

## Breaking older clients

As on Android: a change that breaks older clients raises `API_LEVEL` in
`packages/core/src/apiLevel.ts` by one, in the same PR. Older apps then show "a new version is
available". On iOS its button opens the TestFlight app, where the newer build is waiting.
