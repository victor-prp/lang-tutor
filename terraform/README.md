# terraform

Two Terraform stacks for production (phase 30). `bootstrap` holds what crosses between GitHub and
AWS: what GitHub needs to reach AWS and the image repository, and the hourly trigger that starts
the bots' workflow (phase 39); `prod` holds the database, the container service, the
certificate, the budget and the deployment. Run both only through `scripts/infra.sh`, and
follow [the hosting runbook](../docs/runbooks/hosting.md) for the first apply.
