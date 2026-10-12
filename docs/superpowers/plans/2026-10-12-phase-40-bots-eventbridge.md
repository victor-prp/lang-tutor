# Phase 40 — The bots' hourly trigger moves to EventBridge: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An EventBridge rule in the `bootstrap` stack dispatches `bots.yml` at :17 every hour, emails when it stops working, and `bots.yml` loses its GitHub cron.

**Architecture:** One new Terraform file, `terraform/bootstrap/bots.tf`: the connection (placeholder token, `ignore_changes`), the API destination, the hourly rule and its target, the role EventBridge calls with, and the alerts (an SNS topic with an email subscription, a rule on `Connection Deauthorized`, an alarm on `FailedInvocations`). `bots.yml` keeps only `workflow_dispatch`. Runbooks say how to set and replace the token and what the emails mean.

**Tech Stack:** Terraform 1.16, hashicorp/aws 6.66.0 (pinned), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-12-lang-tutor-phase-40-bots-eventbridge-design.md`

## Global Constraints

- Region `eu-central-1`; every new resource is named `wordspal-bots-*`, except the topic `wordspal-alerts`.
- The rule's schedule is `cron(17 * * * ? *)`; the target's body is `{"ref":"master"}`; `maximum_event_age_in_seconds = 3000`.
- The connection is created with `Bearer unset` and `lifecycle { ignore_changes = [auth_parameters] }`: no token in Terraform.
- Bootstrap gains exactly one variable, `alert_email`.
- `terraform fmt -check -recursive terraform` and `validate` for both stacks pass.
- Never run `infra.sh … apply`, `aws events update-connection` or `gh variable set`: those are Victor's.

## Review Focus

1. **The placeholder fires before the token is set.** A :17 between apply and `update-connection` gets a 401, the connection is deauthorized, and one email arrives; `update-connection` re-authorizes. The runbook must say so (Task 2 step 3 checks the text).
2. **`BOTS_ENABLED` off.** Each hourly dispatch makes a run whose job is skipped at once; the job-level `if` stays exactly as it is (Task 2 step 1 checks the diff).
3. **The topic policy replaces SNS's default policy.** Without a `cloudwatch.amazonaws.com` statement the alarm could not publish. Task 1 step 4 checks both statements are in the plan's JSON.
4. **The plan role reads every new resource type.** CI's plan runs with `ReadOnlyAccess`; an AccessDenied there is a red `terraform-plan`. Task 3 step 2 reads the CI log for "12 to add, 0 to change, 0 to destroy".
5. **GitHub's outage retries.** A retried call must never land in the next hour: `maximum_event_age_in_seconds` is 3000, below 3600. Task 1 step 4 checks it in the plan.

---

### Task 1: The trigger and its alerts in `terraform/bootstrap`

**Files:**
- Create: `terraform/bootstrap/bots.tf`
- Modify: `terraform/bootstrap/variables.tf` (append `alert_email`)
- Modify: `terraform/bootstrap/outputs.tf` (append `bots_connection_name`)
- Modify: `terraform/bootstrap/main.tf:1-2` (header comment)
- Modify: `terraform/README.md` (the stacks' description)

**Interfaces:**
- Consumes: `local.account_id` and `var.region` from `terraform/bootstrap/main.tf` / `variables.tf`.
- Produces: the connection name `wordspal-bots-dispatch` (output `bots_connection_name`), which Task 2's runbook command names literally.

- [ ] **Step 1: Append the variable** to `terraform/bootstrap/variables.tf`:

```hcl
variable "alert_email" {
  description = "Where the bots' trigger alerts go (phase 40): the GitHub variable ALERT_EMAIL, as prod's budget. Set TF_VAR_alert_email."
  type        = string
}
```

- [ ] **Step 2: Create `terraform/bootstrap/bots.tf`:**

```hcl
# Phase 40. The bots' hourly trigger: an EventBridge rule that starts bots.yml
# through GitHub's workflow_dispatch API at :17, because GitHub's own schedule
# ran one slot in five on the bots' first evening. Here and not in prod for the
# reason the roles are: only Victor changes what crosses between GitHub and AWS.
# docs/runbooks/bots.md, "The hourly trigger", has the token and the alerts.

locals {
  bots_dispatch_url = "https://api.github.com/repos/victor-prp/lang-tutor/actions/workflows/bots.yml/dispatches"
}

# --- the call ------------------------------------------------------------------

# The token never passes through Terraform, so this state still holds no secret
# (phase 30 D10): the connection is created with a placeholder, and Victor sets
# the real token with `aws events update-connection`. EventBridge keeps it in a
# secret of its own. Until then GitHub answers 401 and the connection is
# deauthorized, which the alerts below report.
resource "aws_cloudwatch_event_connection" "bots_dispatch" {
  name               = "wordspal-bots-dispatch"
  description        = "GitHub token that may dispatch bots.yml (fine-grained, Actions: read and write)"
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      key   = "Authorization"
      value = "Bearer unset"
    }
  }

  lifecycle {
    ignore_changes = [auth_parameters]
  }
}

resource "aws_cloudwatch_event_api_destination" "bots_dispatch" {
  name                             = "wordspal-bots-dispatch"
  description                      = "Starts bots.yml on master"
  invocation_endpoint              = local.bots_dispatch_url
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
  connection_arn                   = aws_cloudwatch_event_connection.bots_dispatch.arn
}

# --- every hour ----------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "bots_hourly" {
  name                = "wordspal-bots-hourly"
  description         = "Starts the bots' run at :17 every hour (phase 40)"
  schedule_expression = "cron(17 * * * ? *)"
}

resource "aws_cloudwatch_event_target" "bots_hourly" {
  rule      = aws_cloudwatch_event_rule.bots_hourly.name
  target_id = "github-dispatch"
  arn       = aws_cloudwatch_event_api_destination.bots_dispatch.arn
  role_arn  = aws_iam_role.bots_dispatch.arn
  input     = jsonencode({ ref = "master" })

  http_target {
    header_parameters = {
      "Accept"               = "application/vnd.github+json"
      "X-GitHub-Api-Version" = "2022-11-28"
    }
  }

  # Under an hour, so a retried call never adds a second run to the next hour.
  # EventBridge retries 401, 407, 409, 429 and 5xx.
  retry_policy {
    maximum_event_age_in_seconds = 3000
    maximum_retry_attempts       = 10
  }
}

data "aws_iam_policy_document" "bots_dispatch_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.bots_hourly.arn]
    }
  }
}

resource "aws_iam_role" "bots_dispatch" {
  name               = "wordspal-bots-dispatch"
  assume_role_policy = data.aws_iam_policy_document.bots_dispatch_trust.json
}

data "aws_iam_policy_document" "bots_dispatch" {
  statement {
    actions   = ["events:InvokeApiDestination"]
    resources = [aws_cloudwatch_event_api_destination.bots_dispatch.arn]
  }
}

resource "aws_iam_role_policy" "bots_dispatch" {
  name   = "invoke-bots-dispatch"
  role   = aws_iam_role.bots_dispatch.id
  policy = data.aws_iam_policy_document.bots_dispatch.json
}

# --- hearing when it stops -------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "wordspal-alerts"
}

# Confirmed once by clicking the link SNS emails; nothing arrives before that.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# A 401 or 407 from GitHub (a token expired, revoked or never set) deauthorizes
# the connection, and every later hour fails until it is updated. This is the
# one account connection, so the rule needs no name filter.
resource "aws_cloudwatch_event_rule" "bots_deauthorized" {
  name        = "wordspal-bots-dispatch-deauthorized"
  description = "The bots' trigger lost its GitHub token"
  event_pattern = jsonencode({
    source        = ["aws.events"]
    "detail-type" = ["Connection Deauthorized"]
  })
}

resource "aws_cloudwatch_event_target" "bots_deauthorized" {
  rule      = aws_cloudwatch_event_rule.bots_deauthorized.name
  target_id = "email"
  arn       = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      at = "$.time"
    }
    input_template = "\"GitHub refused the bots' trigger token at <at>, so no bot run starts until it is replaced. docs/runbooks/bots.md, The hourly trigger.\""
  }
}

# The deauthorization event is best effort; this catches it too, and what is
# not a 401: a 404 or 422 (the workflow renamed, master gone) and 5xx retries
# that ran out.
resource "aws_cloudwatch_metric_alarm" "bots_dispatch_failed" {
  alarm_name          = "wordspal-bots-dispatch-failed"
  alarm_description   = "A call that starts the bots' run failed. docs/runbooks/bots.md, The hourly trigger."
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.bots_hourly.name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Replaces SNS's default policy, so it names both publishers.
data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "DeauthorizedRule"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.bots_deauthorized.arn]
    }
  }

  statement {
    sid       = "FailedAlarm"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_metric_alarm.bots_dispatch_failed.arn]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}
```

- [ ] **Step 3: Output, header, README.** Append to `outputs.tf`:

```hcl
output "bots_connection_name" {
  description = "The connection whose token Victor sets (docs/runbooks/bots.md, The hourly trigger)."
  value       = aws_cloudwatch_event_connection.bots_dispatch.name
}
```

Change `main.tf`'s first two lines to:

```hcl
# Phase 30 (spec D8, D9, D10). What GitHub needs before any release can run: a
# way to reach AWS without stored keys, and a private registry for the image.
# Phase 40 adds the other direction in bots.tf: AWS starting the bots' workflow.
```

In `terraform/README.md`, the bootstrap sentence becomes: "`bootstrap` holds what crosses between GitHub and AWS: what GitHub needs to reach AWS and the image repository, and the hourly trigger that starts the bots' workflow (phase 40)".

- [ ] **Step 4: Verify.**

```bash
terraform fmt -check -recursive terraform
for s in bootstrap prod; do terraform -chdir=terraform/$s init -backend=false -input=false >/dev/null && terraform -chdir=terraform/$s validate; done
```

Expected: no fmt output; `Success! The configuration is valid.` twice. If AWS credentials and `TF_STATE_BUCKET` are available locally, also `TF_VAR_state_bucket=$TF_STATE_BUCKET TF_VAR_alert_email=$(gh variable get ALERT_EMAIL) ./scripts/infra.sh bootstrap plan -lock=false -out=<scratchpad>/bootstrap.tfplan`, then `terraform show -json` it and check: 12 creates, 0 updates, 0 deletes; the topic policy has the `DeauthorizedRule` and `FailedAlarm` statements; `maximum_event_age_in_seconds` is 3000.

- [ ] **Step 5: Commit** `feat(infra): an EventBridge rule starts the bots hourly, with alerts (phase 40)`.

### Task 2: `bots.yml` loses its cron; the runbooks

**Files:**
- Modify: `.github/workflows/bots.yml:1-18`
- Modify: `docs/runbooks/bots.md` (intro, *Start*, *Stop*, a new *The hourly trigger* section)
- Modify: `docs/runbooks/hosting.md` (go-live step 5's command; *Changing a secret*)

**Interfaces:**
- Consumes: the names from Task 1: connection `wordspal-bots-dispatch`, rule `wordspal-bots-hourly`, alarm `wordspal-bots-dispatch-failed`, topic `wordspal-alerts`.

- [ ] **Step 1: `bots.yml`.** Replace the `on:` block and its comment with:

```yaml
on:
  # Phase 40: started at :17 every hour by an EventBridge rule in terraform/bootstrap
  # (bots.tf), through this trigger. GitHub's own schedule ran one slot in five on
  # the bots' first evening and is late by hours at night; a dispatched run starts
  # within seconds. Also how a failed day is rerun by hand: gh workflow run bots.yml.
  workflow_dispatch:
```

Update the header's first comment paragraph so "each run plays one simulated day" no longer implies the cron. The `jobs.play.if` line is unchanged: `git diff` must show no change to it.

- [ ] **Step 2: `docs/runbooks/bots.md`.**
  - Intro: "one simulated day per hourly run of `.github/workflows/bots.yml`, which an EventBridge rule starts at :17 (*The hourly trigger*)".
  - *Stop*: with `BOTS_ENABLED` off, the rule still starts a run every hour and its job is skipped at once; nothing to change in AWS.
  - New section *The hourly trigger*, after *Stop*: what fires (rule, connection, API destination, all in `terraform/bootstrap/bots.tf`); setting or replacing the token (the `read -rs` + `aws events update-connection` command, no apply); the two emails and what each means; how to check it (`aws events describe-connection --region eu-central-1 --name wordspal-bots-dispatch --query ConnectionState`, `gh run list --workflow bots.yml --event workflow_dispatch --limit 3`); the token must be fine-grained, this repository only, Actions read and write.
  - Note that the first apply leaves the placeholder, so a :17 before the token is set sends one deauthorization email and the token command fixes it.

- [ ] **Step 3: `docs/runbooks/hosting.md`.** Go-live step 5 becomes `TF_VAR_state_bucket="$TF_STATE_BUCKET" TF_VAR_alert_email="<your address>" ./scripts/infra.sh bootstrap apply` (the variable `ALERT_EMAIL` is set in step 6, so step 5 names the address). *Changing a secret* gains: "The bots' GitHub token is not one of these: it lives in an EventBridge connection, and the bots runbook's *The hourly trigger* replaces it." Check: `grep -n "placeholder" docs/runbooks/bots.md` finds the note from step 2.

- [ ] **Step 4: Commit** `feat(bots): bots.yml is started by EventBridge, not GitHub's cron (phase 40)`.

### Task 3: Verify, PR, CI

- [ ] **Step 1:** `terraform fmt -check -recursive terraform`, both validates, `./scripts/check-adrs.sh`. No application code changed, so no Jest run is needed beyond what CI does.
- [ ] **Step 2:** Push, open the PR (`git-create-pr`) with *Left for Victor* from the spec, then `ci-green`. In the `terraform-plan` job's log, `bootstrap`'s plan says `Plan: 12 to add, 0 to change, 0 to destroy.` and `prod`'s says `No changes.`
