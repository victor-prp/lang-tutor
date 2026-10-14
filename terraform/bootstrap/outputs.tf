output "release_role_arn" {
  description = "GitHub variable AWS_RELEASE_ROLE_ARN."
  value       = aws_iam_role.release.arn
}

output "plan_role_arn" {
  description = "GitHub variable AWS_PLAN_ROLE_ARN."
  value       = aws_iam_role.plan.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "bots_connection_name" {
  description = "The connection whose token Victor sets (docs/runbooks/bots.md, The hourly trigger)."
  value       = aws_cloudwatch_event_connection.bots_dispatch.name
}

output "reminders_connection_name" {
  description = "The connection whose key Victor sets to REMINDER_SECRET (docs/runbooks/reminders.md, After the release)."
  value       = aws_cloudwatch_event_connection.reminders_tick.name
}
