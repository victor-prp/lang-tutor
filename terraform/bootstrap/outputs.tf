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
