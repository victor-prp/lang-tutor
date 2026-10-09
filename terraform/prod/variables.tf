variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "availability_zone" {
  type    = string
  default = "eu-central-1a"
}

variable "domain" {
  type    = string
  default = "app.wordspal.ai"
}

variable "service_name" {
  type    = string
  default = "wordspal"
}

variable "ecr_repository_name" {
  type    = string
  default = "wordspal"
}

# Production's own port. Not lane 0's: production is not a lane.
variable "container_port" {
  type    = number
  default = 8080
}

variable "power" {
  description = "Lightsail power. micro is 0.25 vCPU and 1 GB; nano's 512 MB is tight for Node plus pg-boss."
  type        = string
  default     = "micro"
}

variable "db_blueprint_id" {
  description = "Check with: aws lightsail get-relational-database-blueprints (runbook step 3)."
  type        = string
  default     = "postgres_17"
}

variable "db_bundle_id" {
  description = "The 15 USD plan. Check with: aws lightsail get-relational-database-bundles (runbook step 3)."
  type        = string
  default     = "micro_2_0"
}

variable "publicly_accessible" {
  description = "Open on purpose, so production can be inspected from the laptop. Lightsail cannot limit it by IP: only the generated password and TLS guard it (runbook step 9)."
  type        = bool
  default     = true
}

variable "attach_domain" {
  description = "True since the certificate was ISSUED (runbook step 11). With it, public_url is the domain, so the release checks /health there."
  type        = bool
  default     = true
}

variable "image_tag" {
  description = "Set by scripts/infra.sh: the release's tag, or the one Lightsail is serving. Empty means no deployment."
  type        = string
  default     = ""

  validation {
    condition     = var.image_tag == "" || can(regex("^v[0-9A-Za-z.-]+$", var.image_tag))
    error_message = "image_tag is empty or a v* release tag."
  }
}

variable "gemini_model" {
  description = "The GitHub variable GEMINI_MODEL, which the eval job also uses. Set TF_VAR_gemini_model."
  type        = string
}

variable "alert_email" {
  description = "Where the budget alert goes. The GitHub variable ALERT_EMAIL. Set TF_VAR_alert_email."
  type        = string
}

variable "monthly_budget_usd" {
  type    = string
  default = "40"
}

variable "pg_pool_max" {
  type    = number
  default = 5
}

variable "secret_prefix" {
  type    = string
  default = "wordspal/prod/"
}

variable "secret_env_names" {
  description = "Secrets Manager entries under secret_prefix, each passed to the container under its own name. Phase 29 appends BETTER_AUTH_SECRET and RESEND_API_KEY."
  type        = list(string)
  default     = ["GEMINI_API_KEY"]
}
