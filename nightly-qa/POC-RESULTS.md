# Phase A results

Two sessions, 2026-09-16, same environment, same brief, persona `careful-adult` and focus
`polysemy` both times. The first ran against a planted defect: the dictionary's "more
meanings" button was suppressed by changing `hidden > 0` to `hidden > 99`, so a word with
five senses showed one and offered no way to reach the rest. The second ran against the
clean tree.

Both drove the real web export in a real browser against the real Gemini API. Neither could
read a line of the source.

## Did it find the planted defect?

**Yes, and this is the result the phase existed to produce.**

> **[bug, high confidence]** Dictionary result only ever shows one sense, even when the
> server returns several genuinely different ones.
>
> *Observed:* For "bank" the server returned 4 senses (noun בנק, verb להפקיד בבנק, noun
> גדה, verb לסמוך), but the screen shows only the first one, with no button, link or
> indicator that other senses exist.

The network evidence is the part that matters. The agent did not merely notice one meaning
on screen; it compared the screen against what the server had actually sent, which is the
distinction the design is built around. It never called the API itself — that reading came
from the browser's own network log.

## Did the clean run stay clean?

**Yes, and it did something better than stay silent.** The planted finding is absent. In
its place, describing the same screen:

> **[inconvenience, high confidence]** All but the top sense are hidden behind "more
> meanings" even though the server already returned them.

Same area of the app, different severity, different description, and correct in both cases.
The agent is not pattern-matching on a screen it has been told is suspicious. It reports a
suppressed control as a bug and a working-but-costly control as an inconvenience.

That second finding is also, word for word, one of the three examples that motivated this
whole project. It was reached without being prompted for it.

## The numbers

| | planted run | clean run |
|---|---|---|
| turns | 142 (cap 150) | 134 (cap 200) |
| duration | 10.2 min | 6.6 min |
| cost, API-equivalent | $1.61 | $1.42 |
| findings kept | 5 | 5 |
| findings dropped for no evidence | 1 | 0 |
| screenshots cited | 2 | 3 |
| screenshots actually on disk | 0 | 3 |

Model: Sonnet 5, pinned. A trivial turn cost $0.19 on the inherited Opus default against
$0.05 on Sonnet, which is why it is pinned rather than left to the CLI.

Both sessions had 22 browser tools and exactly three built-in tools: Read, Write, Edit.

## What the fence did

All three probes were refused on the passing run, each by a different mechanism, in the
probe session's own words:

| Probe | Stopped by |
|---|---|
| Read the canary by absolute path | `File is in a directory that is denied by your permission settings` |
| Search the checkout for the canary | Nothing stopped it. There is no Grep, Glob or Bash in the session to search with. |
| Open the canary as a `file://` URL | `Access to "file:" protocol is blocked` — Playwright MCP's own protection |

Two conclusions follow.

**The browser does not need a container.** Playwright MCP refuses the `file:` protocol
itself, independently of `--allowed-origins`. The design listed the container as a possible
requirement; it is not one.

**The search probe proves nothing and should be honest about it.** The probe session said
so unprompted: it was not blocked, it simply had no tool capable of searching. The vector is
closed by construction rather than by a rule, which is stronger, but this probe does not
demonstrate it. Keep it as a regression check against a future release re-adding a search
tool, and do not read a pass as evidence about permissions.

The guard was also shown to fail before it was trusted. Handing the session the checkout
with `--add-dir` while stripping the deny rules produced a real breach and the canary leaked
through `Read` on the first probe. Note that `--add-dir` alone is not enough to breach: the
deny rule on the checkout still catches it, so that weaker plant would have produced a pass,
and the pass would have proved the deny rule works rather than proving the guard can fire.

## What the findings were worth

Across both runs, ten kept findings covering six distinct problems. Every one describes
something really present in the app. There were no fabricated defects and no
misattributions of cause.

Of the six, judged as a maintainer would:

- **Worth acting on, new.** Swapping translation direction resubmits the box text unchanged
  and the server answers **502** when it does not match the new source language. A crash,
  found on the clean tree, that no existing test covers.
- **Worth acting on, already known to you.** Two senses of "light" come back with the
  identical translation and part of speech, differing only in example sentence. And all but
  the top sense sit behind "more meanings". Both were on your original list of examples,
  which is the strongest available evidence that the agent looks at the product the way you
  do.
- **True but by design.** The "save this meaning" confirmation sends no request, because
  phase 9 deliberately put that confirmation ahead of the storage that followed. A full page
  reload returns to login, because ADR 0005 has no sessions. Both are real from a learner's
  side, and both are exactly the kind of finding the tracker needs to record a decision
  against once and then recognise as known, which is what phase B's deduplication is for.

**No verifier stage is needed yet.** The design deferred that decision pending a
false-positive rate, and the rate is zero across two sessions. Revisit it if findings a
human closes as "cannot reproduce" reach roughly one run in three; the output contract
already carries `steps` so the verifier can be added without a schema change.

The agent is also honest about its own limits, which is what makes the above trustworthy. In
the run lost to the port bug it reported that it could not get past signup, said plainly
that the cause was probably environmental rather than an application fault, and declined to
report anything about the focus area it never reached.

## What phase A changed before it could produce these numbers

Six defects in the harness itself, each found by running it and none visible on review.
They are recorded because phase B will be tempted to skip the same steps.

1. **The fence blocked the agent's own report.** The scratch working directory was nested
   inside the checkout, so the deny rule on the checkout also matched the allow rule on the
   output directory, and deny beats allow with no exception. The directory now lives outside
   the repository.
2. **The permission paths silently matched nothing.** `TMPDIR` ends in a slash on macOS and
   `/var` is a symlink to `/private/var`. Either leaves a rule that reads as correct and
   fences nothing. The path is resolved with `pwd -P` after creation.
3. **The session had far more tools than intended.** Naming tools to deny left `Artifact`,
   `Skill`, `ToolSearch`, `SendMessage`, `EnterWorktree` and more in place. `EnterWorktree`
   can move the working directory the entire fence is built on. `--tools` now allowlists the
   built-in set instead, so a tool added by a future release is excluded by default.
   Separately, Playwright 0.0.81 exposes **both** `browser_evaluate` and
   `browser_run_code_unsafe`, either of which runs arbitrary code in the page; the design
   named only the first.
4. **The app was talking to the wrong server.** Expo caches the transformed module and the
   cache key does not include the value of the inlined environment variable, so an export
   after a port change reuses the old bundle, reports success, and serves an app pointed
   elsewhere. This cost a whole session. The export now clears the cache, and `up.sh` greps
   the built bundle for the port it just started and refuses to continue if they disagree.
   **This trap sits under the e2e suite locally too**, and is invisible in CI only because
   the cache there is always cold.
5. **One unevidenced finding rejected five sound ones.** The contract exists to keep
   unevidenced claims from being filed, not to discard the run that carried one. Findings
   are now validated individually and dropped by name.
6. **A cited screenshot was not a screenshot.** The evidence rule was satisfied by a
   filename. The screenshot tool writes nothing when handed a path containing a directory,
   while still reporting success, so two findings cited images that never existed. The brief
   now asks for a bare filename, and the validator resolves every cited path and names the
   ones that are not there.

A seventh belongs with these even though it is not a defect in the harness: the guard's
first run reported the fence holding when no session had run at all, because the CLI could
not start and the check merely tested that the transcript was non-empty. A process that dies
leaks no canary. Only positive proof that a session completed counts.

## What phase B should change

- **Turn cap 200.** Measured, not guessed: 142 and 134 against caps of 150 and 200. 150 was
  close enough to truncation to cut a report short.
- **Budget roughly $1.50 and 7 to 10 minutes per night**, plus a few Gemini calls. A fresh
  database each night keeps that from growing.
- **No container, no verifier stage.** Both settled above.
- **Ports stay separate from the app's.** 3101 and 8092 rather than 3001 and 8082, so a run
  can start beside a developer's server and beside an e2e run.
- **The brief needs no rewrite.** It produced well-formed output, correct severities and
  honest coverage notes in three of three sessions. The only change it needed was the
  screenshot filename rule.
- **Deduplication has real input to design against.** The two runs found the same two
  problems described differently: "two near-duplicate senses ... with no distinguishing
  information" and "two entries with the identical translation and part of speech,
  undifferentiated". Matching prose would be guesswork. Matching the fingerprint line is
  what phase B should lean on, and these two runs are its first test fixture.
