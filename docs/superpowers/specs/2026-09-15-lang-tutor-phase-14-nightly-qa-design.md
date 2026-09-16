# Nightly QA agent — design

- **Status:** Part A implemented and measured; part B ready to plan. See
  *Delivery in two phases*, and `nightly-qa/POC-RESULTS.md` for what the two proof-of-
  concept sessions showed. Everything below that describes the night is still a design.
- **Date:** 2026-09-15
- **Relationship to earlier work:** the e2e suite
  (`docs/superpowers/specs/2026-08-26-lang-tutor-e2e-testing-design.md`) proved the app and
  the server close the loop on a scripted happy path, against MockServer. The eval bucket
  (ADR 0004) is the one place that calls the real model, and it scores the prompt, not the
  product. Nothing today uses the product the way a learner does, against the real model,
  and asks whether the experience is any good. This design adds that.

## Summary

Every night a GitHub Actions job stands up the full environment the e2e suite already
knows how to build — fresh Postgres database, the Hono server, the static web export of the
Expo app — with one difference: the server talks to the real Gemini API. A Claude Code
session is then handed a **charter** (a persona and a focus area, different each night)
and a real browser through the Playwright MCP server, and told to behave like a learner:
sign up, look words up, take a session, get confused, make typos, abandon things halfway.
It reports defects, weird behaviour and inconveniences with screenshots and the network
evidence behind them.

Before anything is filed, the session reads every issue the bot has ever filed and decides,
finding by finding, whether it is a known problem. Known problems get a comment on the
existing issue. New ones become new issues, a few per night at most. A deterministic script
does the filing; the agent only decides.

One session, one browser, one night. No source access, no API calls the learner did not
make, no verifier stage yet.

## Goals

- Find the class of problem the scripted tiers cannot: near-duplicate meanings offered side
  by side, a typo silently accepted with no hint, the most common meaning hidden behind a
  **more** button, a flow that dead-ends. UX, not just correctness.
- Vary the exploration night to night, so the same ten clicks are not repeated.
- Never file a duplicate. An existing issue gains a "seen again" comment instead.
- Bound the cost on a Claude subscription and on the Gemini key, in a way that cannot be
  exceeded by the agent being enthusiastic.
- Be runnable locally, in a dry-run mode that files nothing, so the brief can be developed
  without waiting for the night.

## Non-goals

- Replacing any deterministic tier. A finding here is a lead, not a failing test.
- Native behaviour. The agent drives the web export, exactly as e2e does, so anything that
  only exists on iOS or Android is invisible.
- A second, adversarial verifier session. Deferred until the false-positive rate is known
  (see *Decisions deferred*).
- Fixing anything. The agent has no write access to the repository.

## What shaped this design

Precedents, each with the one thing taken from it:

| Precedent | Taken |
|---|---|
| [Claude Code + Playwright MCP "Quinn"](https://alexop.dev/posts/building_ai_qa_engineer_claude_code_playwright/) | A persona charter and a tool allowlist restricted to browser tools, so the agent cannot read the source and stays a black-box user. About 7 minutes per run in Actions. |
| [Site-agnostic explore-QA harness](https://alexop.dev/posts/exploratory-qa-ai-agents-site-agnostic-harness/) | A charter is a mission plus three or four risk oracles. Screenshots only at findings, to save context. A low-confidence finding is not shipped. |
| [msilvera-howdy/qa-agent](https://github.com/msilvera-howdy/qa-agent) | "Belief is not a finding." Separate stages with separate tool allowlists: whatever reasons about findings does not also get the browser, and whatever writes to the tracker does not also get the model. |
| [GitHub Agentic Workflows safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/) | The agent never writes to GitHub. It emits a structured output; a separate job with scoped permissions applies it, with a `max` per run and title-based deduplication as code, not prompt. |
| [Anthropic's issue-deduplication example](https://github.com/anthropics/claude-code-action/blob/main/examples/issue-deduplication.yml) | The model is a good judge of "same root problem" given the existing issues' text. No embeddings needed at this scale. |
| [Playwright + LLM nightly agent](https://scrolltest.com/autonomous-testing-agent-playwright-llm-ollama-2026/) | Console errors and the network log are cheap evidence. Caps on total actions and on actions per page. |
| [Claude Code GitHub Actions docs](https://code.claude.com/docs/en/github-actions) | A subscription OAuth token works in Actions. The dollar cap flag only limits API billing, so on a subscription the caps that matter are `--max-turns`, a job timeout and a concurrency group. |

## Architecture

```
.github/workflows/nightly-qa.yml
│
├─ job: explore            (permissions: contents read, issues read, id-token write)
│   1. npm ci, install Chromium
│   2. npm run db:up                         ← Postgres (+ MockServer, unused tonight)
│   3. nightly-qa/up.sh                      ← fresh lang_tutor_qa, server on :3101
│   │                                          against real Gemini, web export on :8092
│   4. nightly-qa/prepare.sh                 ← picks the charter for tonight, dumps the
│   │                                          bot's issues to .out/known-issues.json
│   5. nightly-qa/guard.sh                   ← three probes that must be refused (see
│   │                                          The fence); a leak fails the job here
│   6. claude -p "/nightly-qa <charter>"      ← ONE session, run from a scratch working
│   │      directory that is not the checkout. Tools: Playwright MCP (browser only),
│   │      Read/Write under .out. Writes .out/findings.json, report.md, shots/*.png
│   7. upload artifact  nightly-qa-<date>    ← report, findings, screenshots, server log
│
└─ job: file  (needs: explore)   (permissions: issues write)
    1. download the artifact
    2. nightly-qa/file.ts                    ← no model. Comments on matched issues,
                                               creates new ones (capped), writes the
                                               job summary. --dry-run prints instead.
```

Two jobs, not one, because the split is the permission boundary: the job that holds the
model has read-only access to issues, and the job that writes issues holds no model. This
is the safe-outputs shape, and it is also what makes the write side unit-testable.

## The environment — `nightly-qa/up.sh`

The same three things `e2e/playwright.config.ts` starts, started from a shell script
because Playwright only starts its `webServer` entries under `playwright test`:

1. `npx tsx nightly-qa/src/provision-db.ts` — drops and recreates `lang_tutor_qa`,
   migrates, seeds. Not `e2e/globalSetup.ts`, which the design originally proposed reusing:
   that file hard-codes `lang_tutor_e2e` and probes MockServer, and a QA run needs neither.
   Its own database means an e2e run and a QA run can be in flight at once without one
   dropping the other's out from under it. `globalSetup.ts` is not a library but a caller of
   `createDb`, `runMigrations` and `seedContent`; this is a second caller of the same three,
   which is the same relationship rather than a copy. A fresh database every night means every lookup the agent makes is a real
   provider call, which is the point, and also means the dictionary cache cannot grow into
   a hidden variable between nights.
2. `npm run start -w apps/server` with `DATABASE_URL` pointing at that database,
   `GEMINI_API_KEY` and `GEMINI_MODEL` from the repository secrets and variables the eval
   job already uses, and **no** `GEMINI_BASE_URL`, so the server's default, the real
   endpoint, applies. Waited for on `/health`. Stdout and stderr go to
   `nightly-qa/.out/server.log`, which ships in the artifact: a 502 the learner saw as a
   blank screen is explained there.
3. `EXPO_PUBLIC_API_URL=http://localhost:3101 npm run build:web -w apps/mobile -- --clear`
   then `expo serve` on 8092. Ports of its own rather than e2e's, so a run can start beside
   a developer's server and beside an e2e run; both are overridable. `--clear` is not
   optional: Metro's cache key excludes the value of the inlined variable, so an export
   after a port change reports success and serves an app pointed at the old server. `up.sh`
   greps the built bundle for the port it just started and refuses to continue if they
   disagree.

The script is idempotent about ports: if either is already bound it fails loudly,
the same rule `playwright.config.ts` applies with `reuseExistingServer: false`.

The browser binary is the one implementation risk here. `@playwright/mcp` bundles its own
Playwright version, which need not match the one `e2e/` installs, so the workflow installs
Chromium through the MCP package's own dependency rather than through `e2e/`. Confirming
the exact command is the first task of the plan, before anything else is built on it.

## The session

Claude Code in print mode (`claude -p`), authenticated with `CLAUDE_CODE_OAUTH_TOKEN`
(the subscription, per the decision in this thread). The CLI is used directly rather than
through `anthropics/claude-code-action`, because the fence below needs the session to
start in a directory that is not the checkout, and the action runs in the checkout. The
action is a wrapper over the same headless mode, so nothing is lost, and the local run and
the nightly run become the same command. The workflow has two triggers: the nightly `schedule`, and `workflow_dispatch` with four
inputs, `persona`, `focus`, `max_turns` and `file_issues` (default `true`), so a night
can be re-run by hand with a chosen charter, or run without touching the tracker. The prompt
is a skill invocation, `/nightly-qa`, so the brief lives in the repository at
`nightly-qa/brief/` as three files — mission, persona, focus — that `workdir.sh`
concatenates, and is reviewed like code. Not a skill, which the design first proposed: a
skill has to be discovered from `.claude/skills/` in the working directory, and the working
directory is a generated scratch directory by design. Passing the brief as the prompt text
removes the discovery step entirely.

### Tools, and why each

| Tool | Purpose |
|---|---|
| `mcp__playwright__browser_navigate`, `_navigate_back`, `_click`, `_type`, `_fill_form`, `_press_key`, `_select_option`, `_hover`, `_wait_for`, `_resize` | Being a user. |
| `mcp__playwright__browser_snapshot` | The accessibility tree. This is how the agent reads the page; it is far cheaper in tokens than a screenshot and it is what a screen reader would see, which is itself a lens on UX. |
| `mcp__playwright__browser_take_screenshot` | Evidence, taken at a finding, not after every click. |
| `mcp__playwright__browser_console_messages` | Page errors the UI swallowed. |
| `mcp__playwright__browser_network_requests` | **The API lens.** The exact request the UI made and the exact response it got. This is how "the UI showed one meaning" becomes "the server returned four senses and the UI showed one" without the agent ever making a call the learner did not make. |
| `Read(/.out/**)` | The charter and the known-issues dump. |
| `Edit(/.out/**)` | The report, the findings file. (`Write` is governed by `Edit` rules.) Nothing else is writable. |

Deliberately absent: `browser_evaluate` **and** `browser_run_code_unsafe` (Playwright 0.0.81
exposes both, and either runs arbitrary code in the page, which is how an agent fakes a
result instead of observing one), the `webmcp` bridge, `Bash`
(no `curl`, no `gh`), `Read` of anything outside `.out/`, and every GitHub MCP tool. The
agent cannot read `apps/`, cannot call the server directly, and cannot touch the tracker.

### The fence — how "no source access" is made true

An allowlist is not enough. Claude Code auto-allows file reads inside its working
directory with no permission check at all, so a session started in the checkout can
`Read`, `Grep` and `Glob` every file under `apps/` without ever consulting a rule. The
fence is structural, in three layers, each of which holds on its own.

1. **The working directory is not the checkout.** The session starts in a scratch
   directory (under `$TMPDIR` locally, `$RUNNER_TEMP/qa` in CI — **outside the checkout**,
   because deny beats allow and a nested directory's own allow rule is swallowed by the
   repo's deny) that holds only the
   skill, the charter and `.out/`. The checkout, where the servers are already running
   from, is outside it. `permissions.blockReadsOutsideWorkingDirectories: true` makes the
   file tools refuse every path outside the working directory in every permission mode,
   and there is no `--add-dir`. As a side effect the repository's `CLAUDE.md` is never
   loaded: Claude reads the working directory's, and the scratch directory has none.
2. **The tools do not exist.** Deny rules beat allow rules, and a bare tool name in a deny
   rule removes the tool from the model's context. The session's settings deny `Bash`,
   `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Agent`, `Edit`, `NotebookEdit` and
   both code-execution browser tools by name, then allow `Read(/.out/**)`,
   `Edit(/.out/**)` and `mcp__playwright__*`. `--strict-mcp-config` with the one
   `mcp.json` means no other MCP server can appear. An absolute-path deny on the checkout
   (`Read(//<checkout>/**)`) is added on top, belt over braces.
3. **The browser cannot reach the disk.** A `browser_navigate` to a `file://` URL of the
   checkout would render the source and hand it back through a snapshot. The MCP server
   runs `--headless --isolated`, with `--output-dir` under `.out/` and `--allowed-origins`
   limited to the two localhost ports. Whether that refuses `file://` is verified, not
   assumed (see below). If it does not, the browser moves into the official
   `mcr.microsoft.com/playwright/mcp` container, which sees no host filesystem and reaches
   the two servers over host networking.

**The guard.** A fence that has never been tested against a breach looks identical to no
fence. `nightly-qa/guard.sh` runs before every session, locally and in CI, with the same
settings, MCP config and working directory, and a fixed three-turn prompt: read
`apps/server/src/app.ts` by absolute path, grep the checkout for `testID`, navigate the
browser to that file's `file://` URL. It fails if the transcript contains a line of the
file. It costs a few turns a night and catches a Claude Code or Playwright MCP upgrade
that changes behaviour.

Why this matters, given the repository is public: not secrecy, honesty. A tester who can
read the code stops being a user. It explains findings away as "by design", and it drives
the app by `testID` instead of by what is on the screen.

### The brief (`nightly-qa/brief/`), in outline

The skill's body is the standing part of the prompt; the charter is the variable part.

1. **Who you are tonight.** The persona file, verbatim, and the focus file, verbatim.
2. **The rules of evidence.** A finding needs steps, expected, observed, and one of: a
   screenshot, a network exchange, a console error. A finding with none of these is a
   note in the report, not a finding. Rate your own confidence; low confidence is
   reported but never filed.
3. **What counts.** Three severities: `bug` (wrong or broken), `weird` (surprising, not
   clearly wrong), `inconvenience` (works, costs the learner effort). The user's own three
   examples are in the brief as calibration: near-duplicate meanings among four options,
   a typo accepted with no hint, the top meaning shown alone behind **more**.
4. **Known limits of the web build.** Native alerts do not render on web, so an action
   that silently does nothing may be a swallowed error: check the network log and report
   the failure, not the missing alert. This is the one place the brief gives the agent
   inside knowledge, and it is there because without it every server error would be
   reported as "the button does nothing".
5. **Budget.** Stop exploring at roughly 80 browser actions and spend what is left on the
   report. Write `findings.json` **before** the deduplication pass, so that hitting the
   turn cap mid-dedup still leaves a complete report on disk.
6. **Deduplication.** Read `known-issues.json`. For each finding, decide: the same
   underlying problem as an existing issue (same screen, same symptom, even if the word
   differs), or new. Record the decision on the finding. One issue per defect, never one
   per word.
7. **Debrief.** `report.md`: what was covered, what was not and why, the findings in
   severity order, and anything the agent was unsure about.

### Output contract — `findings.json`

```json
{
  "run":      { "date": "2026-09-16", "persona": "impatient-typer", "focus": "typos",
                "browser_ok": true },
  "coverage": [ "onboarded as qa-2026-09-16-impatient", "looked up 11 strings", "..." ],
  "findings": [
    {
      "id": "f1",
      "severity": "inconvenience",
      "confidence": "high",
      "title": "Top meaning shown alone; the other three sit behind ‘more’",
      "screen": "translate",
      "steps": ["log in", "tap translate", "type ‘window’", "submit"],
      "expected": "all meanings visible, most common first",
      "observed": "one card; ‘more’ reveals three others",
      "evidence": {
        "screenshots": ["shots/f1-1.png"],
        "network": "POST /api/translations → 200, entries[0].senses.length = 4",
        "console": []
      },
      "fingerprint": "translate | senses list | hidden-behind-tap",
      "match": { "issue": 42 }
    }
  ],
  "notes": "could not test the results screen: session ended at question 7 with ..."
}
```

`match` is `{ "issue": n }`, `{ "new": true }`, or absent when the agent never reached the
deduplication pass. The file is validated with a Zod schema in `file.ts`; a malformed file
fails the `file` job loudly rather than filing garbage.

## Charters — variety without chaos

`nightly-qa/charters/personas/*.md` and `nightly-qa/charters/focus/*.md`, one short
Markdown file each. Initial set:

- **Personas:** `impatient-typer` (fast, typos, abandons anything slow), `careful-adult`
  (reads everything, wants to understand nuance), `young-learner` (age 10, short words,
  taps everything), `returning-user` (already has an account, skips onboarding, expects
  things to be where they were).
- **Focus areas:** `typos-and-near-misses`, `polysemy` (words with many meanings),
  `phrases-and-sentences`, `session-and-scoring`, `abandon-and-resume` (leave a flow
  halfway, come back), `onboarding-edges` (odd names, ages, empty fields), `hebrew-input`
  (typing Hebrew where English is expected, and the reverse).

`prepare.sh` picks persona `dayOfYear mod 4` and focus `dayOfYear mod 7`. Four and seven
are coprime, so the pairing cycles through all 28 combinations before repeating, and the
choice is a function of the date: re-running a night by hand gets the same charter, and
`workflow_dispatch` inputs override both.

The second source of variety is memory. `prepare.sh` also dumps every issue labelled
`nightly-qa`, open and closed, to `known-issues.json`. The brief says: these are known, do
not spend the night re-finding them, though confirming one still reproduces is worth one
line in the report. That is the same file the deduplication pass reads, so it costs one
`gh` call.

## Filing — `nightly-qa/file.ts`

No model. Reads `findings.json`, applies these rules in order, and prints every action it
takes to the job summary:

1. **Malformed or missing file:** fail the job. The `explore` job's artifact is still there.
2. **Confidence `low`:** never filed. Listed in the summary.
3. **`match.issue = n`, issue open:** comment on *n*: date, persona, focus, the observed
   text, and the run's screenshots. Do not reopen or retitle. **Do relabel when the
   severity rose**, replacing the severity label and saying so in the comment. Part A
   showed why: the direction-swap defect was `weird` on one run and a `bug` on the next,
   because only the second run reached the state that returns 502. The same defect looks
   worse once a nastier manifestation is found, and an issue frozen at the severity of the
   night it was opened will understate it forever. Severity never falls automatically — a
   quieter night is not evidence the problem got smaller.
4. **`match.issue = n`, issue closed, labelled `wontfix` or `by-design`:** drop silently
   into the summary. A decision was made; the bot does not argue with it nightly.
5. **`match.issue = n`, issue closed otherwise:** one comment, "reproduced again on
   `date` after close", and nothing else. Reopening is a human's call.
6. **`match.new`:** create an issue, capped at **3 per night**, `bug` before `weird`
   before `inconvenience`. Overflow goes to the summary with a note that it was not filed
   for the cap. Title is the finding's title prefixed `[nightly-qa]`; labels `nightly-qa`
   and the severity; body rendered from a fixed template ending in a **Fingerprint** line
   copied from the finding.
7. **`match` absent:** the agent ran out of turns before deciding. Not filed; the summary
   says so, and the finding is in the artifact for a human.

### How matching actually has to work

The original plan here — the agent compares fingerprints first and prose second, with a
near-identical-title check in code as the safety net — was tested against part A's two runs
and does not survive. Three defects were found by both runs, which makes six fingerprints
and three known-correct answers.

| Strategy | Catches | Fails |
|---|---|---|
| Exact fingerprint match | **0 of 3** | Pairs differ by a word: "two senses share *identical* translation and part of speech" against "two senses share *the same* translation and part of speech". |
| First two fingerprint segments (`screen \| element`) | 3 of 3 | Catastrophically over-merges. Four findings across the two runs carry `dictionary \| senses list`, and they are **three different problems**: duplicate meanings, the real "more" button, and the suppressed button. |
| Near-identical title, in code | **0 of 3** | The same defect was titled *"Save this meaning" claims success but never calls the server* and *"Saved to vocabulary" confirmation shown after choosing a meaning, but no request is sent to the server*. |

So three changes.

**The model decides, and that is not a fallback.** Given the existing issues' text it has the
context to tell the suppressed button from the working one — it did exactly that
unprompted, filing one as a `bug` and the other as an `inconvenience`. Nothing mechanical
available here distinguishes those two, so the judgement is the mechanism, not a
convenience on top of one.

**The fingerprint's third segment becomes a controlled vocabulary, not prose.** Free text
in that position is what made every pair miss by a word. The agent picks the symptom from a
fixed list carried in the brief — `no-network-call`, `duplicate-entry`, `hidden-behind-tap`,
`server-error`, `stale-input`, `lost-session`, `dead-end`, `no-feedback`, `wrong-content`,
`other` — so the fingerprint becomes matchable while the prose stays free. A finding that
reaches for `other` twice in a week is a sign the list needs a term, and the report should
say so.

**The code guard stops pretending to be a safety net.** It caught nothing above, and a
guard that cannot fire is the failure mode `CLAUDE.md` warns about. It becomes a *flag*
rather than a refusal: when a new issue's `screen | element` collides with an open one, file
it anyway and label it `possible-duplicate` for a human to merge. Over-merging silently is
worse than a labelled pair, because a merged issue is invisible.

**Screenshots go into the issue.** The GitHub API has no image upload for issue bodies, and
the original answer was to link the run's artifact, retained 14 days. Part A changed this
from a minor weakness into a real one: `nightly-qa/evidence/f_light_expanded.png` proves the
duplicate-meanings defect on its own, more directly than the prose does, and an issue whose
evidence expires in a fortnight is an issue nobody can act on later. The `file` job commits
the run's screenshots to an orphan `nightly-qa-evidence` branch and links them by raw URL.
That branch never merges and is not built by CI; at four images a night and roughly 25KB
each it costs a few megabytes a year.

## Caps

| Cap | Where | Value to start | Why |
|---|---|---|---|
| Turns | `--max-turns` | 200 | The only spend cap that applies on a subscription. Roughly: ~20 for onboarding and login, ~80 browser actions, ~20 for reading known issues and writing outputs, slack. |
| Actions | in the brief | ~80 | Soft cap so the hard cap is not hit mid-report. |
| Job timeout | `timeout-minutes` | 40 | `npm ci`, Chromium, the web export and the session; e2e's job is allowed 30 with no agent. |
| Overlap | `concurrency: nightly-qa`, no cancel | 1 | Two sessions against one server would interleave; a manual dispatch queues behind the night. |
| New issues | `file.ts` | 3 per night | A quiet tracker is what makes a comment on it worth reading. |
| Model | `--model` | Sonnet 5 | Tool-heavy, cheap on the window. One line to change. |
| Forks | `if: github.repository_owner == 'victor-prp'` | — | Secrets are withheld on forks; a red run nobody can fix is worse than a skipped one. |
| Gemini | none needed | — | A night is tens of lookups. The eval job spends more per push. |

The turn number is measured rather than guessed. Two part A sessions against Sonnet 5
used 142 and 134 turns; 150 was close enough to truncation to cut a report short, so the
cap is 200. Each ran 7 to 10 minutes and cost about $1.50 API-equivalent. Pinning the
model matters for more than the bill: a turn count means nothing beside an unknown model,
and the CLI's inherited default was Opus, at roughly four times the cost per turn.
Scheduled at `0 1 * * *` UTC, which is early morning in Israel, so the
session's use of the five-hour window lands where no interactive session is competing.

## Repository layout

Built in part A:

```
nightly-qa/                                a workspace, like e2e/
  package.json                             @playwright/mcp pinned, tsx, zod, node:test
  up.sh / down.sh                          environment; mirrors playwright.config.ts
  workdir.sh                               the scratch dir, from the fence templates
  guard.sh                                 the canary probes
  run.sh                                   one session, end to end
  fence/settings.template.json             permissions, with __WORK__ / __REPO__
  fence/mcp.template.json                  the MCP server command and flags
  brief/mission.md, persona-*.md, focus-*.md
  src/provision-db.ts                      lang_tutor_qa
  src/findings.ts, findings.test.ts        the contract and its tests
  src/validate.ts, summarize.ts            the two CLIs run.sh calls
  POC-RESULTS.md                           what the two sessions showed
  .out/, .work/                            gitignored
```

Part B adds `.github/workflows/nightly-qa.yml` (the two jobs), `prepare.sh` (charter pick
and known-issues dump), `file.ts` with `file.test.ts` (the filing rules), and the remaining
persona and focus files. `charters/` from the original sketch is `brief/`, since the part A
files already have that shape.

`nightly-qa/` is a workspace so `npm run test:unit` picks up its tests automatically
and so the MCP server version is pinned in the lockfile. It is outside `apps/`, so ADRs
0001 to 0005 do not apply to it, and outside `apps/server/tests/`, so ADR 0004's buckets
are untouched; e2e already set that precedent for a top-level browser-driven workspace.

## Running it locally

`npm run qa:nightly` at the root runs `up.sh`, `guard.sh`, then the same `claude -p`
command CI runs, from the same kind of scratch directory with the same settings, MCP
config and turn cap, then `file.ts --dry-run`. Nothing is CI-only: if the brief or the
fence behaves differently at night than on a laptop, that is a defect in the setup. It
needs Docker (and the one-Postgres-per-port rule from `CLAUDE.md`), `GEMINI_API_KEY` and
`GEMINI_MODEL` in the shell as for `npm run eval`, and a local Claude Code login, which
draws on the same subscription the night does.

Two things are better locally:

- **Headed.** `--headed` drops the MCP server's `--headless`, so the browser is visible
  and the agent's clicks can be watched in real time. This is the fastest way to tune a
  persona file.
- **Explicit charter.** `--persona` and `--focus` override the day's pick, so one focus
  area can be run repeatedly while it is being written.

`--file` replaces the dry run with real filing, for the verification step that needs a
tracker with one bot issue already in it. A local run costs the same as a night, in
Gemini calls and in the subscription window.

## How each failure surfaces

| Failure | Surfaces as |
|---|---|
| Server fails to start, or the export fails | `up.sh` exits non-zero; the job is red before the model is called; the server log is uploaded. |
| The fence leaks | `guard.sh` fails the job before the real session starts; nothing is explored, nothing is filed. |
| Gemini is down or the key is bad | The learner sees the translate error state; the agent reports it as a `bug` with the network evidence; `file.ts` files it. Correct: that is what a learner would see. |
| Playwright MCP cannot launch Chromium | The first browser tool call errors. The brief requires `run.browser_ok` in `findings.json`, set from whether the first `browser_navigate` to the app succeeded; `file.ts` fails the job when it is `false`, so a night with no browser is red, not quietly empty. |
| Turn cap hit | `findings.json` exists from before the dedup pass; unmatched findings are not filed and are listed in the summary. |
| OAuth token expired | The action fails at authentication; nothing is filed. Renewal is manual (`claude setup-token`). |
| Agent files nonsense | Cap of 3, low confidence never filed, and every issue carries the label, so a bad night is three labelled issues to close. Note the code guard is a `possible-duplicate` flag, not a filter — it stops nothing on its own. |

## Verification before the first night

In the spirit of `CLAUDE.md`'s rule for ADR checks: a system that can only ever say
"nothing found" looks identical to one that works. Before the schedule is enabled:

1. `file.test.ts` covers each filing rule with fixtures, including severity escalation, the
   `possible-duplicate` flag and the cap ordering. Its fixtures are part A's two real runs,
   in `nightly-qa/FINDINGS.md`: they contain three defects found twice and described
   differently, plus the trap pair that shares `dictionary | senses list` while being two
   different problems. A matching strategy that merges that pair is wrong, and this is the
   test that says so.
2. A local `npm run qa:nightly` against a branch with a **planted defect** (hide the
   **more** button behind an off-screen style, say) must produce a finding with the right
   screen and a screenshot. Then the same run on the clean tree must not.
3. A `workflow_dispatch` with `file_issues=false` runs the real pipeline end to end and
   the dry-run summary is read by a human.
4. One dispatch with filing on, into a repository state that already has one bot issue,
   confirms a comment lands on it and no duplicate is created.

## Delivery in two phases

Everything that could sink the idea sits inside the session, and none of it is answered by
writing the filing code: whether Playwright MCP can drive a right-to-left static Expo
export at all, how many turns a night takes, whether the findings are sharp or half false
positives, and whether the fence holds. One local run answers all four. So the work is
split, and the second half is designed against a real report rather than an imagined one.

**Part A — proof of concept, local only. Implemented; see
`nightly-qa/POC-RESULTS.md`.** `up.sh`; the scratch directory with the settings fence and
`mcp.json`; `guard.sh`; the brief with one persona and one focus; `run.sh`; the findings
schema and its validator. No workflow, no charter rotation, no filing.

It answered all four questions. The agent found the planted defect — the reveal button
suppressed — as a high-confidence bug carrying the network evidence that the server had
returned four senses while the screen showed one. On the clean tree that finding is absent,
and the same screen is reported instead as a high-confidence *inconvenience*. Same area,
different severity, right both times. Two of the six distinct findings across the two runs
are examples from this project's original brief, reached unprompted, and one is a 502 on the
clean tree that no existing test covers.

Part A also cost six harness defects to get there, none of them visible on review, all
listed in `POC-RESULTS.md`. Two are worth carrying into any future work here: the scratch
directory must not sit inside the checkout, because deny beats allow and the repo rule
swallowed the agent's own output rule; and `expo export` must clear its cache, because
Metro's cache key excludes the value of the inlined environment variable, so an export after
a port change silently serves an app pointed at the old server.

**Part B — the night.** `nightly-qa.yml` with its two jobs and dispatch inputs;
`prepare.sh` and the charter files; `file.ts` with its tests and the deduplication rules;
the `match` field in the output contract; the artifact. Written against part A's numbers
and part A's report.

## Out of scope

- Native builds, Maestro, device farms.
- A verifier stage, embeddings-based deduplication, auto-closing stale bot issues.
- Slack or email. The run's job summary and the tracker are the two outputs.
- Running on pull requests. Real model spend per push is the eval job's trade, not this one's.
- Auto-fix. The bot never opens a pull request.

## Decisions deferred

- **Verifier stage — settled: not needed now.** Across two part A sessions every kept
  finding described something really present in the app, and the agent reported an obstacle
  honestly rather than inventing findings when a harness bug blocked it from the focus area
  entirely. Revisit when findings a human closes as "cannot reproduce" reach roughly one run
  in three. The output contract already carries `steps`, so the verifier can be added later
  without a schema change.
- **Screenshots in issues — settled: they go in.** Part A showed a single image proving a
  defect outright, so the orphan-branch approach moves from this list into part B's scope.
  See *How matching actually has to work*.
- **Claude's issue writes via the GitHub App instead of `GITHUB_TOKEN`.** Not needed:
  issues created with `GITHUB_TOKEN` trigger no further workflows, which here is a feature.
- **Browser in a container — settled: not needed.** Playwright MCP refuses the `file:`
  protocol itself, independently of `--allowed-origins`, and the guard confirmed it with the
  error verbatim. `npx` is enough.
