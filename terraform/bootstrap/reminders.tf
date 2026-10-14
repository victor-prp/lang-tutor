# Phase 52. The practice reminders' trigger: an EventBridge rule that posts to
# our own server's internal tick route every five minutes. Here beside bots.tf,
# and not in prod, for the same reason: only Victor changes what crosses between
# AWS and the app's secret. docs/runbooks/reminders.md has the secret, the
# connection's key and the alerts.

locals {
  reminders_tick_url = "https://app.wordspal.ai/api/internal/reminders/tick"
}

# --- the call ------------------------------------------------------------------

# The secret never passes through Terraform, so this state still holds none
# (phase 30 D10): the connection is created with a placeholder, and Victor sets
# the real REMINDER_SECRET with `aws events update-connection`. Until then the
# server answers 401 and the connection is deauthorized, which the alerts report.
resource "aws_cloudwatch_event_connection" "reminders_tick" {
  name               = "wordspal-reminders-tick"
  description        = "REMINDER_SECRET, which the server's reminder tick route takes as a bearer token"
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

resource "aws_cloudwatch_event_api_destination" "reminders_tick" {
  name                             = "wordspal-reminders-tick"
  description                      = "Queues one run of the reminder job on the server"
  invocation_endpoint              = local.reminders_tick_url
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
  connection_arn                   = aws_cloudwatch_event_connection.reminders_tick.arn
}

# --- every five minutes --------------------------------------------------------

resource "aws_cloudwatch_event_rule" "reminders_every_5_minutes" {
  name                = "wordspal-reminders-every-5-minutes"
  description         = "Asks the server which practice reminders are due, every five minutes (phase 52)"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "reminders_every_5_minutes" {
  rule      = aws_cloudwatch_event_rule.reminders_every_5_minutes.name
  target_id = "reminders-tick"
  arn       = aws_cloudwatch_event_api_destination.reminders_tick.arn
  role_arn  = aws_iam_role.reminders_tick.arn
  input     = "{}"

  # Five minutes, so a retried call never lands after the next tick has run: the
  # next tick covers any slot a failed one missed, inside the 30-minute catch-up
  # window. EventBridge retries 401, 407, 409, 429 and 5xx.
  retry_policy {
    maximum_event_age_in_seconds = 300
    maximum_retry_attempts       = 2
  }
}

# The bots' role cannot be shared: its trust names the bots' rule alone, so
# EventBridge could not assume it for this one.
data "aws_iam_policy_document" "reminders_tick_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.reminders_every_5_minutes.arn]
    }
  }
}

resource "aws_iam_role" "reminders_tick" {
  name               = "wordspal-reminders-tick"
  assume_role_policy = data.aws_iam_policy_document.reminders_tick_trust.json
}

data "aws_iam_policy_document" "reminders_tick" {
  statement {
    actions   = ["events:InvokeApiDestination"]
    resources = [aws_cloudwatch_event_api_destination.reminders_tick.arn]
  }
}

resource "aws_iam_role_policy" "reminders_tick" {
  name   = "invoke-reminders-tick"
  role   = aws_iam_role.reminders_tick.id
  policy = data.aws_iam_policy_document.reminders_tick.json
}

# --- hearing when it stops -------------------------------------------------------

# A secret that is wrong, a route that is not mounted (404: the container has no
# REMINDER_SECRET) and 5xx retries that ran out all count here. The topic, its
# subscription and its policy are bots.tf's; the policy names this alarm too.
# The period is 900 seconds, three ticks: a failure is heard within a quarter of
# an hour, and an OK email follows the first quarter hour without one.
resource "aws_cloudwatch_metric_alarm" "reminders_tick_failed" {
  alarm_name          = "wordspal-reminders-tick-failed"
  alarm_description   = "A call that asks the server for the due practice reminders failed. docs/runbooks/reminders.md, Is it working."
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.reminders_every_5_minutes.name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
