variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "github_repository" {
  description = "The repository as the OIDC token's sub claim names it. The repo uses GitHub's immutable subject, owner@id/name@id, so a renamed or recreated repository cannot assume these roles. Check with: gh api repos/victor-prp/lang-tutor/actions/oidc/customization/sub."
  type        = string
  default     = "victor-prp@1573006/lang-tutor@1342656794"
}

variable "state_bucket" {
  description = "The Terraform state bucket, created by hand. Set TF_VAR_state_bucket."
  type        = string
}

variable "ecr_repository_name" {
  type    = string
  default = "wordspal"
}

variable "secret_prefix" {
  type    = string
  default = "wordspal/prod/"
}
