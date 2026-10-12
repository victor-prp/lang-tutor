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
