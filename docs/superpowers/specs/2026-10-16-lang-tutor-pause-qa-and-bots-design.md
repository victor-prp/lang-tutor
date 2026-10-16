# Pause nightly QA and the bots — design

- **Status:** Designed on 2026-10-16. Victor scoped it in a one-pager and then said "go till PR":
  the design is self-approved (CLAUDE.md, *Continue till PR*).
- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-16-pause-qa-and-bots-one-pager.md`
- **Builds on:** phase 14/17 (nightly QA, `.github/workflows/nightly-qa.yml`) and phases 35/40
  (the bots, `.github/workflows/bots.yml`, started hourly by `terraform/bootstrap/bots.tf`).
- **Supersedes:** phase 40's done-means 3, "Stopping the bots is still `BOTS_ENABLED`, and
  nothing else". `BOTS_ENABLED` still stops them, but the hourly rule now pauses too.
- **Touches:** `nightly-qa.yml`, `terraform/bootstrap/bots.tf` and `variables.tf`, the bots
  runbook. No application code, no migration, no wire change.

## Goal

Victor does not use nightly QA or the bots right now. Each one still runs, spends money (Gemini, and
Claude on his subscription) and files issues. He expects to want both back in about a month.
So this phase pauses them without removing anything, and clears the issues they already filed.

**Done means:**
1. Once merged and applied, no new Nightly QA or Bots run shows up in `gh run list` for a few
   days, not even a skipped one.
2. No new nightly QA or bots issue is filed.
3. Each one has a written way to turn it back on.
4. The open issues nightly QA filed are closed.

## Non-goals

- Deleting any code, workflow, runbook or Terraform resource.
- Touching `origin/bots-state`. When the bots restart, they resume from it.
- Changing `test-eval` or any other CI job.

## Decisions

**D1 — Nightly QA loses its `schedule:` block.** `workflow_dispatch` stays with all its
inputs, so `gh workflow run nightly-qa.yml` still runs a night by hand. The workflow's header
comment says the schedule is paused, and gives the line to restore. `gh workflow disable` was
rejected: it also blocks the manual run, and its state is invisible in the repository.

**D2 — The bots' hourly rule gets a switch.** A new `bootstrap` variable, `bots_schedule_enabled`
(bool, default `false`), sets the rule's `state` to `ENABLED` or `DISABLED`. The
connection, the token, the role and the alerts all stay. A disabled rule makes no
invocations, so the `FailedInvocations` alarm stays quiet (`notBreaching`). The connection's
deauthorization rule hears every connection and keeps covering the reminders.

Unsetting `BOTS_ENABLED` alone is not enough. The rule would still dispatch a run every hour,
and each would show up in `gh run list` as skipped, which breaks done-means 1.
`aws events disable-rule` alone is not enough either: the next `bootstrap` apply would turn it
back on. *(my call)*

**D3 — `BOTS_ENABLED` is set to `false` as well.** It is the immediate stop, before anything is
merged or applied, and it keeps a hand-run `gh workflow run bots.yml` from playing by
accident. A restart turns both on again, and the runbook's *Stop* and *Start again* sections say
so. *(my call)*

**D4 — Close the open nightly QA issues as "not planned", labelled `paused-2026-10`, after the
merge.** This covers every open issue labelled `nightly-qa` or `nightly-qa-triage-report`, each
with one comment saying it was closed to cut noise while nightly QA is paused, not because it was
fixed. The bots' own weekly issues are all closed already.

No `wontfix` or `by-design` label: `filing.ts` treats those as settled. But a plain close is not
enough to bring an issue back either. A restarted night only *comments* on a closed issue that
reproduces (`file.ts` never reopens), and triage and calibration read open issues only
(`targets.ts`). Real bugs among them (`triage:real-bug` #55, #61, #77, #104) would stay parked for
good. So the close adds the label `paused-2026-10`, which is not in `SETTLED`, and the restart
reopens everything carrying it, before the first night. The reopen command is in the
`nightly-qa.yml` header, beside the `schedule:` lines it goes with. The night's triage report
(`nightly-qa-triage-report`) is closed without the label: the next night's report supersedes it,
so there is nothing to reopen. *(my call; the label came out
of the final review)*

The close waits for the merge. Until then the scheduled night still runs. It would comment
"reproduced after close" on what was just closed, and file new issues after the cleanup.
*(my call)*

## Left to the builder

The comment wording, and where exactly the runbook text goes.
