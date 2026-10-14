# Reminders runbook

The app reminds a learner to practise with a push notification (phase 52,
[design](../superpowers/specs/2026-10-14-lang-tutor-phase-52-practice-reminders-design.md)). An
EventBridge rule, `wordspal-reminders-every-5-minutes` in `eu-central-1`, posts to the server's
`/api/internal/reminders/tick` every five minutes. The route queues one run of the `remind` job,
which finds each learner's slots that came due in the last 30 minutes, skips a learner whose daily
target is met, and sends the rest through Expo's push service to Firebase and the phone. The push
is in Hebrew: the title is "הגיע הזמן לתרגל". Every decision is a row in the `reminders` table,
which is what the queries below read. Only the Android app receives them; the web shows the
settings and says so.

The rule is Terraform in `terraform/bootstrap/reminders.tf`, applied from the laptop like the
rest of `bootstrap`. The call carries `REMINDER_SECRET` as a bearer token, kept in the EventBridge
connection `wordspal-reminders-tick`, never in Terraform or its state. The server mounts the route
only where `REMINDER_SECRET` is set, which is production alone.

## Start

Once, in this order. Steps 1 and 2 come before the merge, step 4 after the release, and step 6
needs the Android phone.

1. **Firebase, once.** Reminders need Firebase for the phone's push token, and Expo's push service
   needs a Firebase key to deliver. Until both exist the app's token call fails (it logs it), no
   phone registers, and everything else works.
   1. At [console.firebase.google.com](https://console.firebase.google.com), add a project (Google
      Analytics is not needed).
   2. In it: *Project settings* → *General* → *Your apps* → add an **Android** app with the package
      name `ai.wordspal.app`. Download `google-services.json` to `apps/mobile/` and **commit it** to
      the PR's branch, `phase-52-practice-reminders`.
      The file holds client identifiers, not a secret. `app.config.js` adds it to the build only
      when it is there, and EAS builds only what is committed. It changes the app's native layer,
      so the release that first carries it builds a new app for Play (ADR 0012) instead of
      publishing an update. Add the file before the release that ships this phase and that build
      happens once.
   3. *Project settings* → *Service accounts* → *Generate new private key*. Save it outside the
      repository, for example as `$TMPDIR/fcm-key.json`.
   4. Upload it to EAS (the key belongs to the app, not to the build profile, so the preview build
      below sends through it too):

      ```bash
      cd apps/mobile && npx eas-cli@24.8.0 credentials
      ```

      Android → `production` → Google Service Account → the Push Notifications (FCM V1) key →
      upload the file from step 3.
   5. Delete the local key: `rm "$TMPDIR/fcm-key.json"`. EAS holds it now, and Firebase can issue
      another.

   *Proves:* `npx eas-cli@24.8.0 credentials` shows an FCM V1 key under Android.
2. **`REMINDER_SECRET`, before merging.** One value in Secrets Manager, which the container
   reads. The EventBridge connection gets the same value in step 4. The server refuses fewer than
   32 characters.

   ```bash
   aws secretsmanager create-secret --region eu-central-1 --name wordspal/prod/REMINDER_SECRET \
     --secret-string "$(openssl rand -hex 32)"
   ```

   The PR adds `REMINDER_SECRET` to `secret_env_names` in `terraform/prod/variables.tf`, and a plan
   reads every secret it names, so the PR's `terraform-plan` job is red until the secret exists
   (re-run it then), and the release guard refuses a commit whose plan is red.
3. **Merge, then release** as usual (hosting runbook, *Releasing*):

   ```bash
   git switch master && git pull && npm run release
   ```

   The release applies `terraform/prod`, which hands the container its new `REMINDER_SECRET`, and
   deploys the image with the tick route and the `remind` job. The Android job ships the app.
4. **After the release: the rule and its key.** Only now, because a rule that runs against a
   container without the secret gets a 404 every five minutes and the alarm below fires. The
   apply creates the connection with a placeholder key, `Bearer unset`; the second command sets
   the real one. Run them one after the other: a call that goes out with the placeholder is
   refused with a 401 and deauthorizes the connection (as in the bots' rollout, see
   [the bots runbook](bots.md#the-hourly-trigger)), and the alert emails then arrive. Setting the
   key restores it.

   ```bash
   export TF_STATE_BUCKET="$(gh variable get TF_STATE_BUCKET)"
   TF_VAR_state_bucket="$TF_STATE_BUCKET" TF_VAR_alert_email="$(gh variable get ALERT_EMAIL)" \
     ./scripts/infra.sh bootstrap apply

   SECRET="$(aws secretsmanager get-secret-value --region eu-central-1 \
     --secret-id wordspal/prod/REMINDER_SECRET --query SecretString --output text)" \
     && aws events update-connection --region eu-central-1 --name wordspal-reminders-tick \
       --authorization-type API_KEY \
       --auth-parameters "{\"ApiKeyAuthParameters\":{\"ApiKeyName\":\"Authorization\",\"ApiKeyValue\":\"Bearer $SECRET\"}}"; unset SECRET
   ```

   The connection's name is the apply's output `reminders_connection_name`.

   *Proves:*

   ```bash
   aws events describe-connection --region eu-central-1 --name wordspal-reminders-tick --query ConnectionState
   aws events describe-api-destination --region eu-central-1 --name wordspal-reminders-tick --query ApiDestinationState
   ```

   say `"AUTHORIZED"` and `"ACTIVE"` (the destination comes back within seconds of the key).
5. **Check the route.**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.wordspal.ai/api/internal/reminders/tick
   ```

   answers 401 once the route is mounted; 404 means the container has no `REMINDER_SECRET`
   (`./scripts/infra.sh prod apply` hands it over, hosting runbook, *Changing a secret*). With
   the secret it answers 202, the same call the rule makes (it also runs a tick, which sends
   whatever is due):

   ```bash
   curl -s -w '\n%{http_code}\n' -X POST https://app.wordspal.ai/api/internal/reminders/tick \
     -H "Authorization: Bearer $(aws secretsmanager get-secret-value --region eu-central-1 \
       --secret-id wordspal/prod/REMINDER_SECRET --query SecretString --output text)"
   ```
6. **On the phone**, once the tick is running. Reminders do not reach Expo Go or the web, so use
   a build of the app:
   1. Build the preview APK from a checkout that has `google-services.json` committed (master,
      after step 3):

      ```bash
      cd apps/mobile && npx eas-cli@24.8.0 build --profile preview --platform android
      ```

      EAS prints a link when it finishes. Open it on the phone and install the APK. It talks to
      production, like the Play app. **If the Play copy is installed, uninstall it first**: Play
      signs its copy with Google's key and the APK carries the upload key, and Android refuses an
      install over a different signature. Sign in again after.
   2. Signed in, the home screen asks Android to allow notifications: allow. The app reports its
      time zone and registers its token at every launch once the permission is granted. If it was
      refused, Profile → *תזכורות* has the way back (*הפעלת התראות*). Check the phone is
      registered (`PROD_DB` is the hosting runbook's go-live step 9):

      ```bash
      psql "$PROD_DB" -c "select d.platform, d.last_seen_at from push_devices d join users u on u.id = d.user_id where u.username = '<you>'"
      ```
   3. Pick the time. The hour chips are whole hours, 06:00 to 23:00, so the plain way is to leave
      the days on, select only the next hour, and wait for it: the reminder arrives within five
      minutes after the hour. To not wait, set the schedule in the database to the current minute;
      the next tick sends it. A target already met today is skipped, which is why this sets 5:

      ```bash
      psql "$PROD_DB" -c "
        insert into reminder_settings (user_id, enabled, daily_target, days, times, updated_at)
        select id, true, 5::smallint, '{1,2,3,4,5,6,7}'::smallint[],
               array[to_char(now() at time zone time_zone, 'HH24:MI')]::text[], now()
          from users where username = '<you>'
        on conflict (user_id) do update
          set enabled = true, daily_target = excluded.daily_target, days = excluded.days,
              times = excluded.times, updated_at = now()"
      ```

      Set the real schedule again in the app afterwards: this one has a single slot, at a minute
      that has passed.
   4. When it arrives, the push reads "הגיע הזמן לתרגל". Tap it: the app opens and starts, or
      resumes, today's session. Finish the session.
   5. Check the row:

      ```bash
      psql "$PROD_DB" -c "select local_day, slot, outcome, tapped_at, session_id from reminders where user_id = (select id from users where username = '<you>') order by decided_at desc limit 3"
      ```

      `outcome` is `sent`, `tapped_at` is the moment of the tap and `session_id` is the session
      you finished. A session you finish without tapping also marks the latest reminder before it,
      with `tapped_at` left empty.

## Is it working

```bash
aws events describe-connection --region eu-central-1 --name wordspal-reminders-tick --query ConnectionState
aws events describe-api-destination --region eu-central-1 --name wordspal-reminders-tick --query ApiDestinationState
aws lightsail get-container-log --region eu-central-1 --service-name wordspal --container-name app \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)" --query 'logEvents[].message' --output text | grep reminder_tick
```

`"AUTHORIZED"`, `"ACTIVE"`, and a `reminder_tick` line about every five minutes with the counts of
that run (`candidates`, `claimed`, `sent`, `skipped`, `failed`). Most lines say `claimed: 0`: a
tick claims only the slots that came due in the last five minutes. Other events in the log:
`reminder_tick_error` (one learner failed, the rest were still reminded),
`reminder_time_zone_invalid` (a stored zone the server does not know, that learner is skipped),
`reminder_receipts_error` and `reminder_tapped`.

**The alerts** go to the same emails as the bots' (the SNS topic `wordspal-alerts`, confirmed
once, see the bots runbook's *The emails*):

- **"ALARM: "wordspal-reminders-tick-failed" …"**: a call failed in the last quarter hour: the
  server answered 401 (the connection's key is not `REMINDER_SECRET`), 404 (the container has no
  `REMINDER_SECRET`), or kept answering 5xx through the retries. An "OK" email follows. Run the
  checks above, then step 5 of *Start*. A secret that is wrong also deauthorizes the connection;
  setting it again as in step 4 restores it.
- **Body "An EventBridge connection lost its credential …"**: the same cause, for either the
  bots' trigger or this one. Check `describe-connection` for both names.

No lost slot is made up past 30 minutes: if the rule or the container is down longer, those slots
leave no row, and the next tick that works sends only what is due then.

## The three counts

Against production (`psql "$PROD_DB"`), one row per learner's day on the learner's own clock. They
tell whether reminders bring people back:

```sql
-- reminders sent, per day
select local_day, count(*) as sent
  from reminders where outcome = 'sent' group by local_day order by local_day;

-- reminders tapped, per day
select local_day, count(*) as tapped
  from reminders where tapped_at is not null group by local_day order by local_day;

-- reminders after which the learner finished a session, per day
select local_day, count(*) as with_session
  from reminders where outcome = 'sent' and session_id is not null group by local_day order by local_day;
```

`tapped` over `sent` is how many reminders get opened. `with_session` over `sent` is how many are
followed by a finished session, tapped or not. A row is one learner's slot, whatever the number
of their phones.

## Why a learner got nothing

Look at the learner's settings, their phones and their reminder rows:

```sql
select u.time_zone, s.enabled, s.daily_target, s.days, s.times
  from users u left join reminder_settings s on s.user_id = u.id where u.username = '<name>';

select platform, created_at, last_seen_at
  from push_devices where user_id = (select id from users where username = '<name>');

select local_day, slot, outcome, evidence, receipts, tapped_at, session_id
  from reminders where user_id = (select id from users where username = '<name>')
  order by decided_at desc limit 20;
```

No settings row means the defaults: on, every day, 13:00, 17:00, 20:00 and 22:00. What the answer
means:

- **No `push_devices` row.** The learner is not a candidate, so no row is ever written for them.
  The permission was refused, they use Expo Go or the web, they signed out (that unregisters the
  phone), the app predates reminders, or Firebase is not set up (step 1; the token call fails).
- **A phone, but no list of their own.** A user who owns no enrollment (a tutor only) is not a
  candidate either: they have nothing to practise (spec ruling 9).
- **A phone, and no `reminders` row.** The settings are off or leave out today's weekday (1 is
  Monday, on the learner's clock), or no slot fell in the last 30 minutes of a tick that ran. A
  learner who never reported a time zone is read in UTC (`time_zone` says `UTC`).
- **`skip_target_met`.** `evidence` has `completed_today` at or over `daily_target`: nothing is
  sent, on purpose.
- **`failed`.** `evidence.error` is the push service's answer. The slot is not retried; the next
  slot is.
- **`claimed`** for more than a minute. The container stopped between the claim and the send.
  That reminder is lost, never sent twice.
- **`sent`, and the phone saw nothing.** `receipts` is filled 15 minutes to a day after the send,
  one entry per ticket. `DeviceNotRegistered` means the app was removed or its token went stale;
  the phone's `push_devices` row is deleted with it. `InvalidCredentials` or `MismatchSenderId`
  mean the Firebase key in EAS or `google-services.json` do not belong to this app: redo step 1.
  No error in `receipts` points at the phone: notifications muted, or the OS stopping the app.

`tickets` holds the push token each message went to, because a receipt names only its ticket and
a `DeviceNotRegistered` one must find the phone. So a token outlives its `push_devices` row, until
the user is deleted. Leave `tickets` out of anything pasted or shared.

## Replacing the secret

One value in two places, so both change, in this order:

```bash
aws secretsmanager put-secret-value --region eu-central-1 --secret-id wordspal/prod/REMINDER_SECRET \
  --secret-string "$(openssl rand -hex 32)"
./scripts/infra.sh prod apply
```

then `update-connection` from step 4. Between the apply and that command the tick answers 401 and
the alarm may send an email.

## Stop

```bash
aws events disable-rule --region eu-central-1 --name wordspal-reminders-every-5-minutes
```

No tick is sent, so no reminder. Learners' settings and phones stay. `enable-rule` resumes it,
and the next `bootstrap` apply enables it again by itself.
