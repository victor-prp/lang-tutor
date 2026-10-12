# Phase 39 — The bots' hourly trigger moves to EventBridge

- **Status:** Designed on 2026-10-12. Victor chose EventBridge over four other external schedulers
  and the `bootstrap` stack over `prod` or a stack of its own, then said "go till PR": the rest of
  the design is self-approved (CLAUDE.md, *Continue till PR*).
- **Date:** 2026-10-12
- **Builds on:** phase 35 (PR #132), whose D18 started the bots with GitHub's cron, and phase 30
  (the hosting design), whose D9 and D10 split Terraform into `bootstrap` and `prod`.
- **Supersedes:** phase 35 D18's trigger, the `17 * * * *` cron line. The rest of D18 stands: one
  run is one simulated day, `concurrency: bots` without cancel, the 55-minute timeout, the fork
  guard and `BOTS_ENABLED`.
- **Touches:** `terraform/bootstrap` (a new `bots.tf`, one variable), `.github/workflows/bots.yml`
  (the `schedule:` block goes), the bots and hosting runbooks, `terraform/README.md`. No
  application code, no migration, no wire change, no new Secrets Manager entry of ours.

---

## Goal

Phase 35 went live on 2026-10-11 with `BOTS_ENABLED` set at 17:23 UTC. By 21:45 UTC GitHub had
started one run, at 20:23. The other slots left no run at all, not even a skipped one, so GitHub
never fired them. The same repository's nightly QA job, set for 01:00 UTC, has started between
06:17 and 07:25 UTC every day for two weeks. GitHub documents its schedule as best effort; under
load it is late by hours or drops a slot. Phase 35 expected "somewhat under 24 days per real day";
it got about five.

After this phase an AWS EventBridge rule starts `bots.yml` through GitHub's `workflow_dispatch`
API at :17 every hour. A dispatched run starts within seconds; it does not wait in the schedule's
queue. A trigger that stops working sends Victor an email.

**Done means:**
1. `gh run list --workflow bots.yml` shows one `workflow_dispatch` run per hour, created within
   a minute or two of :17, and no `schedule` runs.
2. A refused token or a failed call emails `ALERT_EMAIL`.
3. Stopping the bots is still `BOTS_ENABLED`, and nothing else.

## Scope

In: the EventBridge rule, its connection, API destination and role; the alerts; removing the cron
line; the runbooks.

Out:
- **Catching up missed days** in the driver (one run plays every day owed). With a reliable
  trigger nothing is missed; it stays an idea for if this trigger ever proves unreliable.
- **A GitHub App** instead of a personal token. An app's installation token lasts an hour and is
  minted by signing a JWT, which needs code (a Lambda) between the rule and GitHub.
- **Moving nightly QA** off GitHub's cron. It is late but never missed a day, and late is fine
  for a nightly job.

## D1. Where it lives: the `bootstrap` stack

Phase 30 D10 split Terraform in two. `bootstrap` holds what lets GitHub reach AWS (the OIDC
provider, the release and plan roles, the image repository), applied from the laptop with
Victor's credentials. `prod` holds the service, applied by every release with the release role.

The trigger goes in `bootstrap`, in a file of its own, `terraform/bootstrap/bots.tf`:
- **No new rights for a GitHub role.** In `prod`, the release role, which any `v*` tag assumes,
  would need EventBridge, SNS, CloudWatch and `iam:PassRole` rights, and its target role would
  have to come from `bootstrap` anyway. D9's line is that only Victor changes what crosses
  between GitHub and AWS; this is the same line, crossed the other way.
- **Its lifecycle is bootstrap's.** It changes almost never, and a failed release apply cannot
  touch it.
- **CI already plans it.** `terraform-plan` plans both stacks on every push, with the plan role,
  whose `ReadOnlyAccess` reads EventBridge, SNS, CloudWatch and IAM.

A third stack was rejected: `infra.sh`, its backend and CI's plan loop would all learn a new name
for a dozen resources.

`bootstrap` gains one variable, `alert_email`, the same `ALERT_EMAIL` that `prod`'s budget uses.
CI's plan job already exports `TF_VAR_alert_email` to both stacks; the laptop's bootstrap command
in the hosting runbook gains it.

## D2. The trigger

All in `eu-central-1`, all named `wordspal-bots-*`:

| Resource | What it is |
|---|---|
| `aws_cloudwatch_event_connection` `wordspal-bots-dispatch` | API-key auth: header `Authorization`, value `Bearer <token>` (D3) |
| `aws_cloudwatch_event_api_destination` `wordspal-bots-dispatch` | `POST https://api.github.com/repos/victor-prp/lang-tutor/actions/workflows/bots.yml/dispatches`, at most one call a second |
| `aws_cloudwatch_event_rule` `wordspal-bots-hourly` | `cron(17 * * * ? *)` on the default bus |
| `aws_cloudwatch_event_target` | body `{"ref":"master"}`; headers `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`; retries for at most 50 minutes |
| `aws_iam_role` `wordspal-bots-dispatch` + inline policy | trusts `events.amazonaws.com` for this one rule; may `events:InvokeApiDestination` on this one destination |

- **:17**, as before: off GitHub's busy :00, and the runbook's "the next run at :17" stays true.
- **Retries for 50 minutes** (`maximum_event_age_in_seconds = 3000`). EventBridge retries 401,
  407, 409, 429 and 5xx. A GitHub outage is retried within its hour, then dropped, so a late retry
  never adds a second run to the next hour. The default, 24 hours, would.
- **Not EventBridge Scheduler**, the newer service: it cannot call an HTTP endpoint without a
  Lambda in between. A scheduled rule can target an API destination directly.
- **No dead-letter queue.** A dropped call is one missing day, and the next hour fires anyway; D4
  covers hearing about it.
- **`ref` is `master`**: the workflow file and the driver run from master, as the cron's runs did.
- **Cost:** scheduled rules are free, API destination calls are 0.20 USD a million, and with the
  connection's secret and the alarm the whole phase is well under a dollar a month.

## D3. The token, outside Terraform

A fine-grained personal access token: resource owner `victor-prp`, repository `lang-tutor` only,
permission **Actions: read and write** (dispatching needs write), the longest expiry GitHub
offers.

D10 also says bootstrap's state holds no secret, and that stays true. Terraform creates the
connection with the placeholder `Bearer unset` and `lifecycle { ignore_changes =
[auth_parameters] }`. Victor sets the real value with `aws events update-connection`, and
EventBridge keeps it in a secret of its own (`events!connection/wordspal-bots-dispatch/…`). So:
- the token never reaches Terraform's state or a plan;
- there is no `wordspal/prod/` entry for it, and no plan goes red before it exists;
- replacing it is the same one command, with no apply.

The runbook's command reads the token with `read -rs`, so it stays out of the shell history, as
the hosting runbook's secret commands do. It is in the `aws` process's arguments for the second
the call takes, which on a one-person laptop is the same trust those commands already accept.

## D4. Hearing when it stops

On an API-key connection, a 401 or 407 from GitHub (an expired, revoked or wrong token)
**deauthorizes the connection**: the API destination goes inactive and every later hour fails
until the connection is updated. That is the one failure that would otherwise be silent for days.

An SNS topic, `wordspal-alerts`, with an email subscription to `alert_email`, gets two signals:

1. **A rule on EventBridge's own `Connection Deauthorized` event** (`source: aws.events`). It
   matches every connection in the account, of which this is the only one. Its target sends a
   sentence, not the raw event: the bots' trigger lost its GitHub token, and the runbook section
   that fixes it.
2. **A CloudWatch alarm on `AWS/Events` `FailedInvocations`** for `wordspal-bots-hourly`, sum at
   least 1 over an hour, missing data not breaching. It backs up signal 1, whose delivery AWS
   calls best effort, and catches what is not a 401: a 404 or 422 (the workflow renamed, master
   gone) and 5xx retries that ran out. It also emails when it returns to OK.

The topic policy lets exactly those two publish: `events.amazonaws.com` for that rule's ARN, and
`cloudwatch.amazonaws.com` for that alarm's ARN.

SNS asks for the subscription to be confirmed by email once; until Victor clicks the link,
nothing is delivered (Left for Victor).

## D5. The GitHub side

- `bots.yml` loses its `schedule:` block and keeps `workflow_dispatch`. Keeping both would add
  GitHub's late runs on top of the hourly ones, more than one day an hour.
- **`BOTS_ENABLED` stays the only switch.** The rule fires every hour regardless; with the
  variable off, each run is skipped at once by the job's `if`, at no runner cost. One switch, in
  the place the runbook already names, is worth an hourly skipped run in the Actions list.
- The fork guard (`github.repository_owner`) stays: a fork's maintainer can still dispatch.
- A dispatched run's actor is Victor, the token's owner. Nothing in the workflow or the driver
  looks at the event or the actor.

## D6. Testing

There is no unit to test: this is Terraform, a workflow line and two runbooks.

- `terraform fmt -check` and `validate` for both stacks, locally and in CI.
- **CI's `terraform-plan`** plans `bootstrap` with the plan role. Its log must show 12 to add, 0
  to change, 0 to destroy, and `prod` unchanged.
- **After the apply** (Left for Victor, then checked from here):
  - `aws events describe-connection --name wordspal-bots-dispatch --query ConnectionState` is
    `AUTHORIZED`;
  - at the next :17, `gh run list --workflow bots.yml --event workflow_dispatch` has a run created
    within two minutes;
  - `aws cloudwatch get-metric-statistics` for the rule shows `Invocations` 1 and
    `FailedInvocations` 0 for that hour;
  - the bots' week issue gains the next day.

## As built

- **Checked against a real plan.** `infra.sh bootstrap plan` with the laptop's credentials, read
  only: `Plan: 12 to add, 0 to change, 0 to destroy`, with the endpoint, cron, body, retry age,
  alarm, deauthorization pattern and topic policy checked in its JSON. Before `bots.tf` the same
  plan said "No changes".
- **The final review** found no critical issue. Its important one: AWS does not promise that an
  API destination whose connection was deauthorized becomes active again when the connection is
  updated, and that recovery would first be needed when the token expires. So the rollout now lets
  one :17 hit the placeholder on purpose (steps 5 and 6 below), and the runbook checks the
  destination's state and has two commands that bring it back.
- **The token command** keeps the token out of the shell history, not the process list (D3).

## Left for Victor

1. **Create the token** at https://github.com/settings/personal-access-tokens/new: owner
   `victor-prp`, only `lang-tutor`, Repository permissions → Actions: Read and write, the longest
   expiry offered. Keep it for step 6.
2. **Merge the PR.** Until step 6 nothing starts the bots; `gh workflow run bots.yml` plays a day
   by hand.
3. **Apply**, from the main checkout on an up-to-date master:

   ```bash
   TF_VAR_state_bucket="$TF_STATE_BUCKET" TF_VAR_alert_email="$(gh variable get ALERT_EMAIL)" \
     ./scripts/infra.sh bootstrap apply
   ```
4. **Confirm the subscription** before the next :17: the email "AWS Notification - Subscription
   Confirmation".
5. **Let one :17 hit the placeholder, on purpose.** It costs the bots one hour and is the only
   rehearsal of a token that stops working before one really does, in about a year (final
   review). Ten minutes after :17, expect an email with subject "AWS Notification Message" whose
   body starts "GitHub refused the bots' trigger token", and:

   ```bash
   aws events describe-connection --region eu-central-1 --name wordspal-bots-dispatch --query ConnectionState
   aws events describe-api-destination --region eu-central-1 --name wordspal-bots-dispatch --query ApiDestinationState
   aws cloudwatch describe-alarms --region eu-central-1 --alarm-names wordspal-bots-dispatch-failed --query 'MetricAlarms[0].StateValue'
   ```

   `"DEAUTHORIZED"`, `"INACTIVE"`, and the alarm's state, whatever it is: it says whether signal 2
   covers a refused token.
6. **Set the token** (the token from step 1):

   ```bash
   read -rs TOKEN && aws events update-connection --region eu-central-1 \
     --name wordspal-bots-dispatch --authorization-type API_KEY \
     --auth-parameters "{\"ApiKeyAuthParameters\":{\"ApiKeyName\":\"Authorization\",\"ApiKeyValue\":\"Bearer $TOKEN\"}}"; unset TOKEN
   ```

   Then the first two checks again: `"AUTHORIZED"` and `"ACTIVE"`. If the destination stays
   `"INACTIVE"`, the bots runbook's *The hourly trigger* has the two commands that bring it back.
7. After the next :17, ask Claude to run D6's checks, and tell it what steps 5 and 6 showed, so
   the runbook keeps only the recovery that worked.

## Risks

- **The token expires.** The connection is deauthorized at the next :17 and both signals email.
  Replacing it is D3's command, no apply. A year's expiry means a yearly email.
- **The token can do more than dispatch the bots.** Actions write on this repository can start
  any `workflow_dispatch` workflow, cancel or rerun runs. It lives only in EventBridge's secret,
  in an account whose admin can already do more. `release.yml` dispatched on master gets no AWS
  rights: the release role trusts `v*` tags only.
- **An alert that never comes.** Signal 1 is best effort, and signal 2 assumes a call to a
  deauthorized connection counts as a failed invocation. Together they cover each other's gap; if
  neither has fired by the time a token expires, the bots' week issue stops gaining days, and the
  runbook says to look there.
- **GitHub retires API version 2022-11-28.** GitHub supports a version for at least 24 months
  after its successor. A refused call is a 4xx other than 401, so signal 2 fires.
