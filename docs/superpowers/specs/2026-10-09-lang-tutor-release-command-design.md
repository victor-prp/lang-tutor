# Release command — `npm run release` and `npm run rollback`

- **Status:** Designed and built on 2026-10-09. Victor scoped it in the one-pager and asked for
  the design and the build in one step, without a brainstorming round. The decisions he did not
  state are D3–D6 below, each with its reason, so any of them can be overturned in review.
- **Date:** 2026-10-09
- **Source:** the one-pager `drafts/2026-10-09-release-command-one-pager.md`. `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 30 (hosting): a release is a pushed `v*` tag on a master commit (D6), the
  Release workflow builds, applies and checks `/health`, and a rollback is that workflow
  dispatched from an earlier tag.
- **Touches:** `scripts/release.sh`, its test `scripts/test-release.sh`, two npm scripts, one CI
  step, the release docs. No server, app or Terraform change.

## Goal

To release, Victor types `git tag v2026.10.09.2 && git push origin v2026.10.09.2`, working the tag
name out by hand from today's date and the last release. After this change one command does it.

**Done means** (from the one-pager, in Victor's words):

1. One command starts the release workflow on the right tag. Victor never types a tag name again.
2. It refuses, and says why, when he is not on `master` or `master` is behind or ahead of
   `origin`.
3. A second release on the same day gets `.2`, `.3` and so on, with no clash.

## Scope

**In:** check that the checkout is on `master` and level with `origin`; work out the next tag and
push it, with no prompt; rollback.

**Out** (from the one-pager): waiting for the Release workflow or reporting its result; a deploy
step after the release; release notes.

The second Out item costs nothing. Pushing the tag already deploys: `release.yml` builds the
image, runs `terraform apply` and goes green only when `/health` names the tag. So the command
releases and deploys without running a deploy step of its own.

## Design

**D1. One script, two npm entry points.** `scripts/release.sh` releases. With `--rollback` it
rolls back. `npm run release` and `npm run rollback` call it, and `npm run rollback -- <tag>` names
the target.

**D2. Release.** The script refuses unless HEAD is on the `master` branch. It fetches
`origin/master` and refuses when `master` is behind or ahead of it, giving the count. It then
computes the tag and creates it on HEAD as a lightweight tag, as the existing ones are, then
pushes it and prints the workflow's URL.

**D3. The tag list is origin's, read with `git ls-remote`, not the local tag list.** A tag that
exists only on the laptop was never released and must not move the counter. A tag deleted
locally was still released. Only names matching `vYYYY.MM.DD` or `vYYYY.MM.DD.N` count.
Annotated tags count by the commit they point at.

**D4. Naming.** The date is the laptop's local `date +%Y.%m.%d`, as phase 30's runbook already
used. The first release of the day is `v<date>`, which counts as 1, and the next is one past the
highest number that day, so a hand-pushed `.7` makes the next one `.8`, never a clash.
`RELEASE_DATE` overrides today, for the tests.

**D5. A commit already released is refused**, naming its tag and the rollback command that
redeploys it. A second tag on the same commit would build nothing new and would make "which
release is this" ambiguous.

**D6. Rollback without a tag goes to the release before the newest one**, by version order of
origin's tags, and dispatches `gh workflow run release.yml --ref <tag>`. With a tag, it checks
the tag is a release on origin and dispatches that. It does not ask `/health` what is live: a
rollback is most needed when the site is down. The cost: after one rollback the newest tag is no
longer live, so a second rollback must name its tag. The docs and the script's output say so.
No branch check is made, because a rollback moves no ref.

## Testing

`scripts/test-release.sh` builds a bare origin and a clone, with a stub `gh` on `PATH` that
records its arguments. It covers: the first release of a day, `.2` and `.3`, a gap (`.7` → `.8`),
a malformed tag ignored, an annotated tag, a local-only tag ignored, already-released, behind,
ahead, off master, rollback to the previous and to a named release, an unknown tag, and too few
releases. Every refusal is checked to push no tag and dispatch nothing. It needs only git and
bash, so CI runs it in the setup-free `check-adrs` job beside the other release tests. Each check
was confirmed able to fail by planting a mutation in the script (no branch check, no behind check,
a broken counter, rollback to the oldest, the annotated tag's object id in place of its commit).
