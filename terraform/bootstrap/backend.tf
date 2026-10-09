# The state bucket is the one resource made by hand (docs/runbooks/hosting.md):
# a stack cannot keep its state in a bucket it creates. The bucket's name is
# passed at init by scripts/infra.sh, from TF_STATE_BUCKET, so no account-specific
# value is committed. use_lockfile is S3's own lock; no DynamoDB table.
terraform {
  backend "s3" {
    key          = "bootstrap.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
