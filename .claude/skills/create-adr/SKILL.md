---
name: create-adr
description: Use when a structural decision about this repo needs recording — a new layering rule, module boundary, or invariant — or when asked to write, add, or create an ADR under docs/adr/
---

# Create an ADR

## Overview

An ADR in this repo is an **enforcement artifact**, not a rationale document. It exists so a
rule survives the next refactor, and so an agent can check compliance in seconds without
reading prose. The reasoning that produced the decision lives in the phase design doc; the
ADR links to it and does not restate it.

**One ADR is two files, always:**

1. `docs/adr/adr-NNNN-<kebab-title>.md` — the decision and its rules
2. `scripts/check-adr-NNNN-<kebab-title>.sh` — those same rules as commands

Writing only the first file is not creating an ADR. One script per ADR, so the pairing stays
one-to-one; ADR 0001's script keeps its historical name, `scripts/check-architecture.sh`.

Naming the script correctly *is* the wiring: `scripts/check-adrs.sh` discovers
`scripts/check-adr-*.sh` (plus `check-architecture.sh`, ADR 0001's historical exception) by
glob and runs all of them, and that one script is what `npm run lint:arch`, the CI
`check-adrs` job, and the agent-facing Stop hook all call. Get the filename right and none of
those three need touching.

`NNNN` is the next free number, zero-padded to four digits.

## Before writing: conflict scan (required)

Read every existing `docs/adr/*.md` and README's Architecture section first. Then report,
before drafting:

- **Contradiction** — a new rule cannot hold while an accepted rule holds. Stop and list each
  one as `ADR 0001 R2 says X; this decision needs Y`, then ask which gives. Never silently
  supersede an accepted rule, never quietly narrow it to fit.
- **Stale prose** — existing text that this decision makes untrue. Report it in the same list.
  (Live example: README's architecture table still grants `services/` the `Db` handle "for
  transaction scope", which ADR 0001 R2 forbids outright.)

The user decides how conflicts resolve. Do not resolve them yourself.

## Then ask, before writing any file

A one-line decision does not contain an ADR's worth of rules. Ask these four, **batched in
one round**, after the conflict scan and before the ADR, the script, or the wiring exists.
Fold any conflicts from the scan into the same round.

| Ask | Why it cannot be inferred |
|---|---|
| **Scope** — which trees do these rules govern (`apps/server/src` only? `apps/mobile/src`? `packages/core`?), and are test files in or out? | Two agents given the same sentence chose opposite coverage: production-source-only versus both apps plus core, with the mock rules applying to tests *above all*. |
| **The corollaries** — list the rules you would add that the user did not state, as one list to accept or trim. | "No `class` outside `Error` subclasses", "no `rng = Math.random` default", "no `jest.spyOn` on globals" are all inferred. They are probably right, and they are about to block every push. |
| **Exceptions and roots** — which files are composition roots or otherwise excluded, and is there a known exception to carve out? | Every `grep -v` is a policy decision. `_layout.tsx` reading `process.env` at module scope is required by Metro's inliner — not something to grant yourself. |
| **Status and Source** — `Accepted` or `Proposed`, and which design doc the header links (or none, if the decision was made in conversation). | The header has a `Source` line; guessing which spec justifies a rule misattributes it. |

Ask once, in one batch — not a question per rule, and not a drip across the task.

If the questions cannot be asked — the user declined, said "you decide", or the session is
non-interactive — proceed on your own answers and put **all four** in your final report under
their own heading, the corollaries named individually: *these rules are inferred, you did not
state them, and they now block every push.* That list is the user's only chance to trim a rule
before CI enforces it, so it is the one part of the report that cannot be summarised away.

**Do not ask about** the filename slug, section order, rule-ID scheme, the script's frame, or
where the wiring goes. This skill fixes all of those; there is no decision there.

Approved rules are the user's rules. Do not annotate the ADR with which ones were inferred —
the document records the decision, not its provenance.

## The ADR's shape

These sections, in this order, and no others. **No Options, no Alternatives Considered, no
Consequences** — automation and agents need the decision and the check, and every extra
section is prose that drifts out of sync with the code.

| Section | Contents | Limit |
|---|---|---|
| Header | `# ADR NNNN: <decision, present tense>`, then `- **Status:**`, `- **Date:**`, `- **Source:**` (link the design doc) | 4 lines |
| `## Decision` | What is true now, present tense. An ASCII diagram when the decision is a shape (layers, arrows, seams). | ~15 lines + diagram |
| `## Rules` | One table row per rule: `\| # \| Subject \| May import \| Must not import \|`, or the equivalent columns for a non-import decision. One line each. | one line per rule |
| `## Rules that are not import rules` | Only rules grep cannot see. Each names what enforces it instead — `tsc`, review, a call-site count. | 2 lines each |
| `## How to detect a violation` | One `bash` block, one command per rule, each headed `# Rn — <what it protects>`. Says which script mirrors it and that each command must print nothing. | — |
| `### What the rules cover` | Which trees are scanned; which are excluded and why (test trees, composition roots). | 5 bullets |
| `## Why` | Only for rules that look stylistic but are not. One bullet each. | 5 bullets, ~80 words total |
| `## Related` | Cross-links, in `ADR NNNN Rn` form. | — |

Rule IDs are `R1, R2, …`, restarting at R1 in each ADR — do not invent a per-ADR letter
prefix. Cite across ADRs as `ADR 0001 R2`.

## Every rule needs a command

A rule with no command is not a rule — it is a preference nobody is keeping. Before writing a
rule down, decide which of three states it is in, and label it in the ADR:

1. **Greppable** — write the command. This is the default; aim for it.
2. **Not greppable because the seam is too wide** — narrow the type, then grep. ADR 0001 R2 is
   the worked example: a service holding a `Db` could read any table through
   `db.query.<table>` with *no import at all*, because the schema arrives via a type parameter.
   No regex can see that. The fix was handing services a `Transaction` that yields only
   repositories — a narrower seam, not a sharper pattern. **Narrow the seam before sharpening
   the regex.**
3. **Genuinely not greppable** (a type derivation, a function signature) — it goes under
   `## Rules that are not import rules`, naming its real enforcement. Never leave an
   unenforceable rule sitting unlabeled in the rules table; readers will assume it is checked.

**Any coverage claim the ADR makes needs a command behind it.** ADR 0001 claimed "R1–R6 apply
to test files too" while nothing scanned `tests/integration/` — and both trees had hand-wired
the repositories they were forbidden to know about. If you write that the rules cover a tree,
scan that tree.

### The mirror contract

The ADR's commands and the script are the same text: the ADR is the explanation, the script is
the enforcement, and a rule living in only one of them is a rule nobody keeps.

- Each command becomes one shell **function** in the script — never a string passed to `eval`,
  so the ADR's quoting copies across unchanged.
- Copy the command **verbatim**. No shell variables, no `$NOCOMMENT` helpers, no reformatting:
  anything the ADR defines out of line stops the command being pasteable at a prompt, which is
  the one thing it must be.
- `grep`'s exit codes run backwards here — **a match is the violation**, and finding nothing
  (exit 1) is the passing case. So nothing keys off exit status, and `set -e` stays absent.
  Use `set -u`, collect output, and fail when output is non-empty.
- Every exclusion (`grep -v -e …`) is an exception the ADR names in `### What the rules cover`,
  with the reason, in the script as a comment.

Copy the frame from `scripts/check-architecture.sh`: `cd "$(dirname "$0")/.."`, a `check()`
that prints `ok` / `VIOLATION` per rule and sets `status=1`, one function per rule, and a
footer pointing at the ADR for what each rule protects.

## Wiring (all three, or it does not run)

`package.json`'s `lint:arch`, `.github/workflows/ci.yml`'s architecture step, and the
agent-facing Stop hook in `.claude/settings.json` all call `scripts/check-adrs.sh`, which
discovers `scripts/check-adr-*.sh` by glob and runs every one of them, combining exit statuses
so one ADR's violation never hides another's (`&&` would stop at the first failure). None of
those three call sites need editing for a new ADR — only these:

1. The script itself, named `scripts/check-adr-NNNN-<kebab-title>.sh` so the glob finds it.
2. README's ADR index row — create the index under `## Architecture` if none exists yet
   (today nothing in the repo links `docs/adr/` at all) — and its `npm run lint:arch` line.
3. The rule count, if the ADR or script states one, in both places.

## Verify before claiming it is done

**A check that has never failed is not a check.** For **each** rule, in order:

1. Plant a violation of exactly that rule in a real file under the tree it scans.
2. Run `npm run lint:arch`. It must fail, naming that rule, with `file:line`.
3. Restore the file.

Then, on an unmodified tree:

- `npm run lint:arch` passes, and reports every rule as `ok`.
- `git status --porcelain` shows only the ADR, the script, and the wiring — no planted
  violation survived.
- The ADR's commands and the script's functions are identical text. Check it, don't assume it:
  strip comments and blank lines from the ADR's `bash` block and from the script's rule
  functions, then compare line by line. A one-line function (`r3() { grep …; }`) is fine — the
  command inside it is what must match.

Report the result of these runs, not the intention to do them.

## Rationalizations

Every excuse below was recorded from an agent doing this task without this skill:

| Excuse | Reality |
|---|---|
| "The script is separate CI infrastructure — I'll leave the commands in the ADR" | The script is the ADR's other half, not infrastructure. Without it you shipped an honour-system checklist. |
| "The commands are written to copy across unchanged when someone wires them up" | Then copy them across. "Someone" is you, now. |
| "I'll follow the convention present in this tree" | The convention is enforcement. An ADR whose rules only run when someone remembers is the state this repo already fixed once. |
| "grep can't express this rule, so I'll describe it carefully instead" | Narrow the seam until grep sees it, or list it under the non-import rules with its real enforcement. Careful prose is not enforcement. |
| "The check passes, so the rule works" | It has never failed. Plant the violation and watch it fail. |
| "The decision needs its rationale to be understood" | The rationale is in the design doc the header links. `Why` is 5 bullets, for rules that look stylistic and are not. |
| "An ADR should record the options considered" | Not here. Options are the design doc's job; this file is the decision and the check. |
| "The decision is clear enough to write the rules from" | One sentence yielded two agents inventing nine rules each, disagreeing on scope and on three of the rules. Ask. |
| "I'll write it and the user can correct the rules in review" | The rules ship wired into CI. A wrong one blocks every push on the branch, which is not a review comment. |
| "It's a small rule, one more grep in the existing script is simpler" | One script per ADR keeps the pairing one-to-one. A shared script makes "which ADR is this rule from?" unanswerable. |

## Red flags — stop

- About to report an ADR as done with no `scripts/check-adr-*.sh` in `git status`
- A rule in the table with no command in the detection block
- The detection block defines a shell variable or helper the script would need to reuse
- Writing `## Options`, `## Alternatives Considered`, or `## Consequences`
- Rule IDs that are not `R1, R2, …`
- Claiming a tree is covered without a command that scans it
- Never having seen the new check fail
- A new rule that contradicts an accepted ADR and you are drafting around it instead of asking
- Writing the rules table without having asked about scope, corollaries, exceptions or status
- A rule in the table the user never stated and never approved

## Checklist

Create a todo per item.

- [ ] Conflict scan over `docs/adr/*.md` + README; contradictions and stale prose reported to the user
- [ ] Scope, corollaries, exceptions/roots, status/source asked in one batch — before any file exists
- [ ] If they could not be asked: all four answered in the report, inferred rules named one by one
- [ ] Next free `NNNN`; ADR at `docs/adr/adr-NNNN-<slug>.md`
- [ ] Sections exactly as tabled above; `Why` ≤ 5 bullets; no Options/Consequences
- [ ] Every rule is `Rn`, one line, independently checkable
- [ ] Non-greppable rules under their own heading, each naming its real enforcement
- [ ] `scripts/check-adr-NNNN-<slug>.sh`, one function per rule, commands verbatim from the ADR
- [ ] Filename matches the glob `check-adrs.sh` discovers (no edit needed to `lint:arch`, CI, or
      the Stop hook); README index and rule counts updated
- [ ] Each rule watched failing against a planted violation, then restored
- [ ] `npm run lint:arch` green on a clean tree; `git status` clean of test violations
