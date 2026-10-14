# terraform

Two Terraform stacks for production (phase 30). `bootstrap` holds what crosses between GitHub and
AWS: what GitHub needs to reach AWS and the image repository, the hourly trigger that starts
the bots' workflow (phase 40), and the five-minute tick that asks the server for the practice
reminders that are due (phase 52); `prod` holds the database, the container service, the
certificate, the budget and the deployment. Run both only through `scripts/infra.sh`, and
follow [the hosting runbook](../docs/runbooks/hosting.md) for the first apply.
