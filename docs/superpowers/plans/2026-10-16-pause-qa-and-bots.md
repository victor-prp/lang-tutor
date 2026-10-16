# Pause nightly QA and the bots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nightly QA and the bots stop starting runs, and each one has a documented way back on.

**Architecture:** Configuration only. Nightly QA's cron goes, and the bots' EventBridge rule gets
a `state` driven by a new `bootstrap` variable. The issues are closed after the merge, by
command, not by code.

**Tech Stack:** GitHub Actions YAML, Terraform (aws provider 6.66.0), Markdown runbook.

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-pause-qa-and-bots-design.md`

## Global Constraints

- Delete nothing: no workflow, script, runbook or Terraform resource goes (spec, Non-goals).
- `origin/bots-state` is not touched.
- `bots_schedule_enabled` is a `bool`, default `false`.

## Review Focus

- A hand run of nightly QA must still work: `workflow_dispatch` and its inputs must be unchanged.
- With the rule disabled, the `FailedInvocations` alarm must not fire (`treat_missing_data = "notBreaching"` is already set; check it stays).
- The reminders' deauthorization alert shares `bots.tf`, so only `aws_cloudwatch_event_rule.bots_hourly` changes.
- The runbook's restart has to say both switches, in order: apply with the variable on, then `BOTS_ENABLED=true`.

---

### Task 1: Nightly QA without a schedule

**Files:** Modify `.github/workflows/nightly-qa.yml` (the `on:` block).

- [ ] Remove `schedule:` and its cron line. Above `on:`, add a comment: paused 2026-10-16 (this spec), and to resume, restore `schedule: - cron: '0 1 * * *'`.
- [ ] Verify: `node -e "const y=require('yaml');const d=y.parse(require('fs').readFileSync('.github/workflows/nightly-qa.yml','utf8'));if(d.on.schedule||!d.on.workflow_dispatch.inputs.persona)process.exit(1)"` exits 0 (or the same check with whichever YAML parser is in `node_modules`).
- [ ] Commit `ci(nightly-qa): pause the nightly schedule`.

### Task 2: The bots' rule behind a switch

**Files:** Modify `terraform/bootstrap/variables.tf` and `terraform/bootstrap/bots.tf` (`aws_cloudwatch_event_rule.bots_hourly`).

- [ ] Add `variable "bots_schedule_enabled"` (bool, default `false`, a description naming this spec and the runbook).
- [ ] Set `state = var.bots_schedule_enabled ? "ENABLED" : "DISABLED"` on `bots_hourly`, with a one-line comment.
- [ ] Verify: `terraform fmt -check -recursive terraform` and `terraform -chdir=terraform/bootstrap init -backend=false -input=false && terraform -chdir=terraform/bootstrap validate` both succeed.
- [ ] Commit `feat(infra): the bots' hourly rule is off unless bots_schedule_enabled`.

### Task 3: The runbook

**Files:** Modify `docs/runbooks/bots.md` (*Stop*, and a restart paragraph).

- [ ] *Stop:* `BOTS_ENABLED=false` first, then a `bootstrap` apply with `bots_schedule_enabled` false (the default), so that no hourly run appears at all. Replace the "Nothing changes in AWS" paragraph.
- [ ] *Start again:* `terraform apply` with `-var bots_schedule_enabled=true` (or `TF_VAR_bots_schedule_enabled=true`), then `gh variable set BOTS_ENABLED --body true`. Check the token is still `AUTHORIZED` (the *Is it working?* commands). Add a nightly QA line pointing at the workflow comment.
- [ ] Commit `docs(runbooks): pause and restart the bots`.
