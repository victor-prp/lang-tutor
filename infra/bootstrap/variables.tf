variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "github_repository" {
  type    = string
  default = "victor-prp/lang-tutor"
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
