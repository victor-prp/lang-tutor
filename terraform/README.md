# terraform

Two Terraform stacks for production (phase 30). `bootstrap` holds what GitHub needs to reach
AWS and the image repository; `prod` holds the database, the container service, the
certificate, the budget and the deployment. Run both only through `scripts/infra.sh`, and
follow [the hosting runbook](../docs/runbooks/hosting.md) for the first apply.
