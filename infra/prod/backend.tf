# See infra/bootstrap/backend.tf: the bucket is named at init by scripts/infra.sh.
terraform {
  backend "s3" {
    key          = "prod.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
