# Bots runbook

Six simulated learners (phase 35, spec D13–D22) play the app against production, one simulated
day per hourly run of `.github/workflows/bots.yml`. What each bot really knows lives on the
orphan branch `bots-state`, one directory per bot (`state.json`, `log.jsonl`), never on the
server. Every simulated week has a GitHub issue, label `bots`, titled "Bots — simulated week N".

The driver is `bots/run.ts`. The roster and every simulation knob are in `bots/src/roster.ts` and
`bots/src/actr.ts`; the picker's constants are in `apps/server/src/domain/chooseConstants.ts`.

## Start

Once, in this order. Steps 2, 5 and 6 need production access (AWS or the database); `PROD_DB` is the connection
string from the hosting runbook's go-live step 9.

1. **Delete the test incident's junk branch, before anything else.** A local run during the
   build pushed a `bots-state` with three days of junk on it. Left there, the first real run
   would start every bot at day 4 from that junk. It must be gone before step 8 sets
   `BOTS_ENABLED`:

   ```bash
   git push origin --delete bots-state
   ```

   Only in a checkout that ran the bots locally (it has `bots/.state`), also remove its local
   copy, from that checkout:

   ```bash
   git worktree remove bots/.state
   git branch -D bots-state
   ```
2. **`BOT_SECRET`**, one value in two places: production's Secrets Manager, which the container
   reads, and the repository's GitHub secret `BOT_SECRET`, which the workflow reads. The server
   refuses fewer than 32 characters.

   ```bash
   KEY="$(openssl rand -hex 32)" \
     && aws secretsmanager create-secret --region eu-central-1 --name wordspal/prod/BOT_SECRET --secret-string "$KEY" \
     && gh secret set BOT_SECRET --body "$KEY"; unset KEY
   ```

   This comes before the merge. The PR adds `BOT_SECRET` to `secret_env_names` in
   `terraform/prod/variables.tf`, and a plan reads every secret it names, so the PR's
   `terraform-plan` job is red until the secret exists (re-run it then), and the release guard
   refuses a commit whose plan is red.
3. **Point the workflow at production** (the workflow is still off; `BOTS_ENABLED` is unset):

   ```bash
   gh variable set BOTS_API_URL --body https://app.wordspal.ai
   ```
4. **Merge, then release** as usual (hosting runbook, *Releasing*):

   ```bash
   git switch master && git pull && npm run release
   ```

   The Release workflow runs `./scripts/infra.sh prod apply`, the Terraform apply that hands
   the container its new `BOT_SECRET` entry, and deploys the new image. To give the serving
   container the secret without a release, `./scripts/infra.sh prod apply` from the laptop
   does the same apply (hosting runbook, *Changing a secret*). Then:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X PUT https://app.wordspal.ai/api/bots/day
   ```

   answers 401 once the route is mounted; 404 means the container has no `BOT_SECRET`.
5. **Recompute memory** from every ended session (spec D8), so learners' existing words start
   with memory instead of as new:

   ```bash
   DATABASE_URL="$PROD_DB" npm run db:progress:recompute
   ```
6. **Create the six bot profiles.** `--day` is required: the day each bot starts on. Use day 1
   of the bots' calendar, `2026-01-01` (`EPOCH` in `bots/src/play.ts`); every run sets the day
   explicitly anyway, before the bot plays.

   ```bash
   DATABASE_URL="$PROD_DB" npm run db:bots:create -- --day 2026-01-01 \
     steady-en fast-ru forgetful-it skipper-en silent-ru control-it
   ```
7. **Check the junk branch is gone** (step 1); this prints nothing when it is:

   ```bash
   git ls-remote --heads origin bots-state
   ```
8. **Turn the bots on:**

   ```bash
   gh variable set BOTS_ENABLED --body true
   ```

The next run at :17 plays day 1 and opens the week 1 issue. Week 1 closes about seven runs later.
`CLAUDE_CODE_OAUTH_TOKEN` is the nightly QA job's secret; the bots reuse it.

## Stop

```bash
gh variable set BOTS_ENABLED --body false     # or: gh variable delete BOTS_ENABLED
```

Every later run is skipped at once. A run already playing finishes its day. To start again,
set it back to `true`: the bots resume at the day after the last one they finished.

## Read the issue

```bash
gh issue list --label bots --state all
```

- **Each run's comment** has a line per bot: sessions, cards, right, new words, unheard (spoken
  answers the transcription missed), no voice (espeak-ng or ffmpeg missing on the runner),
  unmatched (cards the bot could not tie to a saved word) and failed requests. "day not
  finished" means a failed request ended that bot's day; the next run goes on with it from where it
  stopped (words already saved and sessions already played are not repeated), and the third
  failure counts it as played so the others are not held back. A bot's state is committed
  after every session, so a run killed by the job's 55-minute timeout loses at most the
  session it was in.
- **The week's closing comment** has the five numbers (spec D21) per bot for this week and every
  earlier one, the six reports, and the Claude spend. What each number is for:
  - (a) above 1: weak words get more than their share of the cards;
  - (b) high: a word's weakest dimension gets the cards;
  - (c) the 2nd / 3rd / 4th+ gaps rising: intervals grow (a day's first review only: a
    same-day return is learning, phase 37);
  - (d) low: the rung fits memory, recall for a same-day return or once recall is likely
    (phase 37);
  - (e) steady or rising: the bot remembers more.

  The spec's *Risks* section names what to change when they do not (`R_TARGET`,
  `RECOGNITION_EXPONENT`, the new-word cap). No threshold is applied.
- **A red run** is a bug in the driver, or `gh` failing, not a failed request, which only ends
  that bot's day. The run's log has a line per bot. A run red at "Verify the CLI can start" is
  the Claude CLI's install. A report is never paid for twice: a bot's numbers and report are
  committed to its state as soon as they are made, and a rerun skips them. A report call that
  fails shows as "No report: …" in the closing comment, and is not retried.
- **A week left open** (the week's last run died mid-close: a `gh` error, the job's timeout, or
  the six report calls running out) recovers by itself: every run first closes any finished
  week whose issue is still open or whose numbers or reports are missing, before it plays its
  day. If `gh` fails there, the run logs it, plays its day all the same, and ends red. Nothing to do but let the next run happen, or start it now with `gh workflow run
  bots.yml`. Its closing comment opens with "Closed by a later run". If later days were played
  before it closed (the bots were stopped or every run failed), its (e) shows –, since the
  memory at its end is gone; the other numbers come from the log and are unaffected.

## Rerun a day

```bash
gh workflow run bots.yml
```

A run plays the day after the last one every bot finished, so a dispatch after a failed run
plays the failed day again, for the bots that did not finish it. It does not replay a finished
day: for that, see *Reset a bot*.

## Reset a bot

Resetting touches the hidden side only. Production keeps the bot's saved words, memory rows,
levels and sessions, and nothing deletes them. A bot whose state no longer matches production
sees cards it cannot match (counted as unmatched), and its numbers stop meaning anything. So:

- **To fix a bot's state** (a stuck `attempts`, a bad value), edit its `state.json` on
  `bots-state` while the bots are stopped:

  ```bash
  git fetch origin bots-state
  git worktree add "$TMPDIR/bots-state" origin/bots-state
  cd "$TMPDIR/bots-state" && git switch -c bots-state-fix
  # edit <bot>/state.json, then
  git commit -am "<bot>: <what and why>" && git push origin HEAD:bots-state
  cd - && git worktree remove "$TMPDIR/bots-state"
  ```

  Every bot plays the lowest finished day + 1, so lowering one bot's `day` makes every other
  bot wait while it catches up, one day per run.
- **To start every bot over**, stop the bots, then delete the branch:

  ```bash
  git push origin --delete bots-state
  ```

  The next run starts every bot at day 0 again and plays day 1. Each bot's production day is
  set back by that run's explicit day (`PUT /api/bots/day`, 2026-01-01); to set it before then:

  ```bash
  curl -fsS -X PUT https://app.wordspal.ai/api/bots/day \
    -H "Authorization: Bearer $BOT_SECRET" -H 'Content-Type: application/json' \
    -d '{"name":"steady-en","day":"2026-01-01"}'
  ```

  Production still holds what the old bots saved and practised, with memory dated after the
  new day 1, so a true fresh start needs fresh bots: new names in `bots/src/roster.ts` (a code
  change), created with `db:bots:create` as in *Start*.

  The old weeks' issues must go too: the driver finds a week's issue by its title, and a closed
  one is never closed out again, so the new week 1 would get its daily lines but no numbers and
  no reports. Rename each before the first new run:

  ```bash
  gh issue list --label bots --state all --json number,title --jq '.[] | "\(.number) \(.title)"' |
    while read -r n title; do gh issue edit "$n" --title "${title/Bots/Bots (old run)}"; done
  ```

## Try it on a lane

`npm run bots:dry -- --days 7` plays seven days against this lane's server. The server and the
driver need the same `BOT_SECRET` (`export BOT_SECRET="$(openssl rand -hex 32)"` in both
shells, then `npm run server`), and the bots must exist in the lane's database
(`npm run db:bots:create -- --day 2026-01-01 <names>`). It makes no Claude call and files
nothing: the issue's text goes to `bots/.dry/<lane>/issues/week-N.md`, and the state to a git
repository of its own under `bots/.dry/<lane>`. CI runs one day of it after e2e
(`npm run bots:ci`).
