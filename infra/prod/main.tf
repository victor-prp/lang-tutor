# Phase 30 (spec D7, D11, D12, D13). Production: one database, one container
# service at scale 1, its certificate, the budget alert, and the deployment.

# --- database ------------------------------------------------------------------

# Lightsail refuses /, " and @ in the password, and the password goes into a URL.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_lightsail_database" "app" {
  relational_database_name = "wordspal-db"
  availability_zone        = var.availability_zone
  master_database_name     = "wordspal"
  master_username          = "wordspal"
  master_password          = random_password.db.result
  blueprint_id             = var.db_blueprint_id
  bundle_id                = var.db_bundle_id
  publicly_accessible      = var.publicly_accessible
  backup_retention_enabled = true
  preferred_backup_window  = "01:00-01:30"
  apply_immediately        = true
  final_snapshot_name      = "wordspal-db-final"
}

# --- container service and certificate ----------------------------------------

resource "aws_lightsail_certificate" "app" {
  name        = "wordspal-app"
  domain_name = var.domain
}

resource "aws_lightsail_container_service" "app" {
  name  = var.service_name
  power = var.power
  scale = 1 # ADR 0010: one container, which migrates before it serves

  private_registry_access {
    ecr_image_puller_role {
      is_active = true
    }
  }

  dynamic "public_domain_names" {
    for_each = var.attach_domain ? [1] : []
    content {
      certificate {
        certificate_name = aws_lightsail_certificate.app.name
        domain_names     = [var.domain]
      }
    }
  }
}

# --- the image -----------------------------------------------------------------

data "aws_ecr_repository" "app" {
  name = var.ecr_repository_name
}

# The repository is bootstrap's; the puller role is this stack's, so the grant
# lives here.
resource "aws_ecr_repository_policy" "lightsail_pull" {
  repository = data.aws_ecr_repository.app.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LightsailPull"
      Effect    = "Allow"
      Principal = { AWS = aws_lightsail_container_service.app.private_registry_access[0].ecr_image_puller_role[0].principal_arn }
      Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    }]
  })
}

# --- environment ---------------------------------------------------------------

data "aws_secretsmanager_secret_version" "env" {
  for_each  = toset(var.secret_env_names)
  secret_id = "${var.secret_prefix}${each.key}"
}

locals {
  # verify-full against the RDS authority the image carries.
  database_url = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem",
    aws_lightsail_database.app.master_username,
    urlencode(random_password.db.result),
    aws_lightsail_database.app.master_endpoint_address,
    aws_lightsail_database.app.master_endpoint_port,
    aws_lightsail_database.app.master_database_name,
  )

  environment = merge(
    {
      DATABASE_URL = local.database_url
      PORT         = tostring(var.container_port)
      LANE         = "prod"
      PG_POOL_MAX  = tostring(var.pg_pool_max)
      GEMINI_MODEL = var.gemini_model
    },
    { for name, secret in data.aws_secretsmanager_secret_version.env : name => secret.secret_string },
  )
}

# --- the deployment --------------------------------------------------------------

# No deployment until a tag is given: the first apply from the laptop builds the
# infrastructure, and the first release creates the first deployment.
resource "aws_lightsail_container_service_deployment_version" "app" {
  count        = var.image_tag == "" ? 0 : 1
  service_name = aws_lightsail_container_service.app.name

  container {
    container_name = "app"
    image          = "${data.aws_ecr_repository.app.repository_url}:${var.image_tag}"
    environment    = local.environment
    ports = {
      (tostring(var.container_port)) = "HTTP"
    }
  }

  public_endpoint {
    container_name = "app"
    container_port = var.container_port

    health_check {
      path                = "/health"
      success_codes       = "200-299"
      interval_seconds    = 10
      timeout_seconds     = 5
      healthy_threshold   = 2
      unhealthy_threshold = 3
    }
  }

  depends_on = [aws_ecr_repository_policy.lightsail_pull]
}

# --- the bill --------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "wordspal-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
