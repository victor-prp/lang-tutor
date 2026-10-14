# Android runbook

Friends install **WordsPal** (`ai.wordspal.app`) from Google Play's internal testing track,
limited to a tester list. Every release ships the app from the Release workflow's last job,
`android`. If native code is unchanged, the job publishes an over-the-air update that phones
take within minutes. If native code changed, it uploads a new build to Play, which installs it
within a day or so. Design:
[phase 32](../superpowers/specs/2026-10-11-lang-tutor-phase-32-android-app-design.md),
[ADR 0012](../adr/adr-0012-native-client-releases.md).

**The on/off switch is the repository variable `ANDROID_RELEASE`.** The `android` job ships
only when it is exactly `on`. Unset or any other value means the job does not run: the release
run shows `android` as *skipped*, greyed out, and the server and web still release. It is unset until step 5. Turn it on or off
with:

```bash
/opt/homebrew/bin/gh variable set ANDROID_RELEASE --body on    # ship the app with every release
/opt/homebrew/bin/gh variable set ANDROID_RELEASE --body off   # pause: releases skip Android
```

The job also skips, green, while steps 2–4 are not done.

## Where go-live stands

Last updated 2026-10-13.

- [x] **1. Play Console.** Done 2026-10-13: identity verified, app created, tester list and
      app content filled in.
- [x] **2. Expo account and project.** Done. The project is `@wordspal/lang-tutor`, owned by the
      `wordspal` Expo account, id `66fb04ba-7006-4095-92be-9c26592db6c7`. The `production`
      channel exists, and `app.json` has the project id, updates URL and owner (PR #130).
- [x] **3. Play service account.** Done 2026-10-13. `play-publisher@gen-lang-client-0339599374`
      in the `words-ai-teacher` Cloud project, its key held by EAS.
- [x] **4. The GitHub secret.** Done. `EXPO_TOKEN` is a **Developer** robot token of the
      `wordspal` account.
- [x] **5. The first release.** Done 2026-10-13: `v2026.10.13`, build
      `ec913d7c-281e-4caa-aa89-69bcbf5889c6`, versionCode 2, submitted to the internal track and
      its update published, with no draft-app detour. `ANDROID_RELEASE` is `on`.
- [ ] **6. Back up the upload key.** Next.
- [ ] **7. Check it on your phone.** Next.
- [ ] **8. Invite friends.** After step 7. The tester list already holds four addresses.

Every release now ships the app. The tag `v2026.10.13` was cut before PR #160 merged, so the
live privacy page still names the old contact until the next release.

**Picking up from here:** step 6, then step 7, then step 8.

## Go-live, once

Run from the main checkout on `master`, after phase 32 has merged. Each step says what it
proves before the next one starts.

1. **Play Console.**
   1. At [play.google.com/console](https://play.google.com/console), create a developer
      account for **Yourself**, not an organisation. An organisation account needs a D-U-N-S
      number and a registered business. It costs a one-time $25, and Google verifies your
      identity, which can take a few days. *(Account created and documents uploaded
      2026-10-11; verified 2026-10-13.)*
   2. *Create app*: name **WordsPal**, default language Hebrew, App, Free. If it asks for a
      package name, enter `ai.wordspal.app`, the `android.package` in `apps/mobile/app.json`.
   3. *Testing → Internal testing → Testers*: create an email list with your friends'
      Google-account addresses, and your own. Keep the opt-in link it shows: friends open it
      once before installing.
   4. *App content*. Fill in every item it lists:
      - **Privacy policy:** `https://app.wordspal.ai/privacy.html`. Read the page first. Its
        deletion contact is `contact@wordspal.ai`; if that address does not receive mail, change it
        in `apps/mobile/public/privacy.html` and release before citing the page.
      - **Data safety:** the answers in [Data safety](#data-safety) below.
      - **Content rating:** the questionnaire. It is an education app with no violence, no user
        chat and no purchases.
      - **Target audience:** 13 and over.
      - **Ads:** no ads.
      - **App access:** sign-in is by one-time email code, so a reviewer cannot use a real
        account. The form names a placeholder reviewer account, `android_tester_0001@wordspal.ai`, that
        the server does not accept yet. *(Entered 2026-10-13.)* Internal testing is rarely
        reviewed, but **before the first production release** the server must accept a fixed
        8-digit sign-in code for that account (the form's "password"; codes are 8 digits in
        `SignInWithCodeRequestSchema`), or the entry must change to a mailbox you can share.

   *Proves:* the app exists. Its package name, whether entered here or taken from the first
   upload, can never change afterwards.

2. **Expo account and project.** *(Done 2026-10-11.)* Create an account at
   [expo.dev](https://expo.dev), then:

   ```bash
   npm install                             # at the repo root first: app.json names the expo-updates plugin
   cd apps/mobile
   npx eas-cli@24.8.0 login
   npx eas-cli@24.8.0 init                 # writes extra.eas.projectId into app.json
   npx eas-cli@24.8.0 update:configure     # writes updates.url into app.json
   npx eas-cli@24.8.0 channel:create production
   git diff app.json                       # the project id and the updates URL, nothing else
   ```

   `init` asks which account owns the project: pick the **wordspal** organisation, not the
   personal account. The robot token in step 4 must belong to the same account.

   Commit the `app.json` change on a branch and merge it through a PR. Keep only three keys:
   `extra.eas.projectId`, `updates.url` and `owner`. None of them is a secret. The commands
   also write the evaluated config back: `android.permissions`, with each permission listed
   twice, and `extra.router`. Leave those out, because the plugins add them at build time. The
   name, package, runtime version and plugins are already right.

   *Proves:* `npx eas-cli@24.8.0 channel:list` shows `production`.

3. **Play service account**, which lets EAS upload builds:
   1. In [Google Cloud Console](https://console.cloud.google.com), create a project (or reuse
      one). Enable the **Google Play Android Developer API**, then *IAM → Service accounts →
      Create*, and create a JSON key for it.
   2. In Play Console, *Users and permissions → Invite new users*: the service account's email,
      with *Release apps to testing tracks* for WordsPal.
   3. Hand the key to EAS, then delete the local file:

      ```bash
      cd apps/mobile
      npx eas-cli@24.8.0 credentials   # Android → production → Google Service Account → upload the JSON key
      ```

   *Proves:* `npx eas-cli@24.8.0 credentials` shows the service account under Android.

4. **The GitHub secret.** *(Done 2026-10-11.)* At expo.dev, switch to the **wordspal**
   account, then *Settings → Access tokens → Robot users*, and create a robot with the
   **Developer** role. That role builds, submits and publishes. It would need *Release Manager*
   only if the `production` channel were marked protected. Copy the token, which Expo shows
   once, then:

   ```bash
   /opt/homebrew/bin/gh secret set EXPO_TOKEN    # paste the token when asked
   ```

   *Proves:* `gh secret list` shows `EXPO_TOKEN`.

5. **The first release.** Turn Android releases on, then release:

   ```bash
   /opt/homebrew/bin/gh variable set ANDROID_RELEASE --body on
   npm run release
   ```

   The `android` job finds no build, so it builds
   (about 15–20 minutes), submits the build to the internal track, then publishes the
   update. EAS creates the app's signing key on this first build.

   A Play app that has never had a release rolled out may accept only drafts through the API. If
   the submit step fails with *"Only releases with status draft may be created on draft app"*:
   1. Download the `.aab` from the build page the job's log links (expo.dev → the build →
      *Download*).
   2. In Play Console, *Internal testing → Create new release*: upload it, *Save*, *Review
      release*, *Start rollout*.
   3. **Do not rerun the job.** It would submit the same build again, and Play refuses a version
      code twice. Instead, publish its first update by hand, from the tag's checkout, with the
      tag and the build id from the job's log:

      ```bash
      git checkout <tag>
      cd apps/mobile
      EXPO_PUBLIC_APP_VERSION=<tag> EXPO_PUBLIC_APP_COMMIT=$(git rev-parse --short=7 HEAD) \
        EXPO_PUBLIC_API_URL=https://app.wordspal.ai \
        npx eas-cli@24.8.0 update --branch production --platform android \
        --environment production --message "<tag> for build <build id>"
      git checkout master
      ```

      `eas update --environment` reads no `.env` file, so every `EXPO_PUBLIC_` value the app
      needs is passed on the command line. An update without `EXPO_PUBLIC_API_URL` crashes at
      launch, and phones quietly keep the build's own bundle.

      That message is the marker later releases look for: an update naming the newest build means
      the build reached Play. From then on, releases publish over the air on their own.

   *Proves:* Play Console's internal track shows the release, and the build is listed as
   *Available to internal testers*.

6. **Back up the upload key.** Losing it means asking Google to reset it, which takes days.

   ```bash
   cd apps/mobile
   npx eas-cli@24.8.0 credentials   # Android → production → Keystore → Download
   ```

   Store the keystore and its passwords in your password manager, not in the repo.

7. **Check it on your phone** (the phase's done-means 1–4):
   1. Open the opt-in link, accept, and install WordsPal from Play. Sign in and finish a session
      with your laptop off. The profile screen's version row shows the release tag.
   2. Release a JavaScript-only change. Close the app fully and open it: within a minute of the
      job going green, the version row shows the new tag.
   3. Release a native change, such as an Expo SDK patch. The job's log says it is building.
      Within a day Play updates the app by itself, or tap *Update* on its Play page.
   4. Answer a speaking question by voice, and import a photo of a word list.

8. **Invite friends.** Add their emails to the tester list (step 1.3) and send them the opt-in
   link. They need nothing else, ever: updates arrive by themselves.

## What a release prints

The `android` job runs `scripts/android-release.sh` from the tag's checkout:

| It prints | It did |
|---|---|
| `Same native layer as build …: publishing … over the air.` | `eas update`. Phones take it on their next open, or after 30 minutes away |
| `Build … has no update yet, so it never reached Play: submitting it first.` | A rerun after a failed submit: `eas submit`, then `eas update`. Every update's message names its build (`<tag> for build <id>`), and that is how the job tells |
| `The native layer changed: building, submitting …` | `eas build`, then `eas submit` to the internal track, then `eas update`. Play installs it within a day or so |
| a `::warning::` about the native layer, on a rollback | Nothing. Play cannot downgrade an installed app. If the newer app is broken against the older server, release a fix forward |
| nothing: the job shows as *skipped* | `ANDROID_RELEASE` is not `on` |
| a `::notice::` that it skipped | Steps 2–4 are not done, or the tag predates phase 32 |

A failure in `android` leaves the server release standing, and friends keep their current app.
Rerun that job alone (*Actions → Release → the run → Re-run failed jobs*). Expo's free tier can
queue a build long enough to hit the job's 60-minute timeout; the rerun picks up the finished
build.

## Breaking older clients

An installed app can be a day or two behind the server. A change that breaks older clients
must raise `API_LEVEL` in `packages/core/src/apiLevel.ts` by one, in the same PR. A breaking
change removes or renames a response field, adds a required request field, or changes a
meaning. Older apps then get 426, and show "a new version is available". That screen tries an
over-the-air update first and offers Play and "check again".

## Data safety

What the app sends, for Play Console's *Data safety* form:

| Play data type | Collected | Shared | Ephemeral | Required | Purposes |
|---|---|---|---|---|---|
| Personal info → Email address | yes | no | no | yes | app functionality, account management |
| Personal info → Name, Other info (age) | yes | no | no | yes | app functionality |
| Personal info → User IDs (account id) | yes | no | no | yes | account management |
| App activity → App interactions, Other user-generated content | yes | no | no | yes | app functionality |
| Audio files → Voice or sound recordings | yes | no | **yes**: transcribed, never stored | no | app functionality |
| Photos and videos → Photos | yes | no | no: held in a row until read, then cleared | no | app functionality |
| Device or other IDs | yes | no | no | yes | app functionality: expo-updates sends a per-install id to Expo |

Account creation: *Username and other authentication* (email plus a one-time code). Deletion:
by request at the privacy page, which also covers deleting some data without closing the account
(saved words can be removed in the app). *(Filled in 2026-10-13.)* When gender is added to
onboarding, it joins age under *Other info*, and the privacy page's list must name it.

- All of it is encrypted in transit.
- Users can ask for deletion by email.
- Gemini, Resend and AWS process data on WordsPal's behalf. Play counts them as service
  providers, not as sharing.
