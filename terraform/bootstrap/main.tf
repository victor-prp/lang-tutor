# Phase 30 (spec D8, D9, D10). What GitHub needs before any release can run: a
# way to reach AWS without stored keys, and a private registry for the image.

data "aws_caller_identity" "current" {}

locals {
  account_id        = data.aws_caller_identity.current.account_id
  secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${var.secret_prefix}"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Tags are immutable, so a tag names one image forever. That is what makes a
# rollback an apply that points at an image which already exists.
resource "aws_ecr_repository" "app" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last twenty images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "trust" {
  for_each = {
    release = "repo:${var.github_repository}:ref:refs/tags/v*"
    plan    = "repo:${var.github_repository}:ref:refs/heads/*"
  }

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [each.value]
    }
  }
}

# --- the release role: v* tags only ------------------------------------------

resource "aws_iam_role" "release" {
  name               = "wordspal-release"
  assume_role_policy = data.aws_iam_policy_document.trust["release"].json
}

data "aws_iam_policy_document" "release" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushAndRepositoryPolicy"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DeleteRepositoryPolicy",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:GetLifecyclePolicy",
      "ecr:GetRepositoryPolicy",
      "ecr:InitiateLayerUpload",
      "ecr:ListTagsForResource",
      "ecr:PutImage",
      "ecr:SetRepositoryPolicy",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket}"]
  }

  statement {
    sid       = "ProdState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.state_bucket}/prod.tfstate*"]
  }

  statement {
    sid       = "ProdSecrets"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["${local.secret_arn_prefix}*"]
  }

  statement {
    sid       = "Lightsail"
    actions   = ["lightsail:*"]
    resources = ["*"]
  }

  statement {
    sid       = "Budget"
    actions   = ["budgets:*"]
    resources = ["arn:aws:budgets::${local.account_id}:budget/wordspal-*"]
  }
}

resource "aws_iam_role_policy" "release" {
  name   = "release"
  role   = aws_iam_role.release.id
  policy = data.aws_iam_policy_document.release.json
}

# --- the plan role: every branch push, read-only -----------------------------
# ReadOnlyAccess covers reading the state, Lightsail, ECR, IAM and budgets. Secret
# values are added on top because a plan resolves the secret data sources; that
# is the trust the spec's first risk names.

resource "aws_iam_role" "plan" {
  name               = "wordspal-plan"
  assume_role_policy = data.aws_iam_policy_document.trust["plan"].json
}

resource "aws_iam_role_policy_attachment" "plan_read_only" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn_prefix}*"]
  }
}

resource "aws_iam_role_policy" "plan_secrets" {
  name   = "read-prod-secrets"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan_secrets.json
}
