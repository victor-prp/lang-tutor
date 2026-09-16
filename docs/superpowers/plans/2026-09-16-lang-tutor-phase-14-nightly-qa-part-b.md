# Nightly QA agent — part B (the night) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run part A's session unattended every night in GitHub Actions, and turn its
findings into a small, non-duplicating set of tracker issues.

**Architecture:** One workflow, two jobs. `explore` holds the model and can only *read*
issues; `file` holds no model and does the writing. The agent decides, finding by finding,
whether a problem is one the tracker already knows; a deterministic script applies those
decisions under fixed rules. Charters rotate by date so no two consecutive nights run the
same persona and focus.

**Tech Stack:** GitHub Actions, `gh` CLI, bash, Node 26 (`node --test` runs TypeScript
natively), `tsx`, Zod 4. Everything part A built is reused unchanged unless a task says
otherwise.

**Spec:** `docs/superpowers/specs/2026-09-15-lang-tutor-phase-14-nightly-qa-design.md`.
Read *Architecture*, *Charters*, *Filing*, *How matching actually has to work*, *Caps* and
*Verification before the first night* before Task 1. `nightly-qa/POC-RESULTS.md` records
what part A measured, and every number below comes from it.

## Global Constraints

- **The model never writes to GitHub.** The `explore` job gets `issues: read`. Only `file`
  writes, and it runs no model. This split is the whole safety argument; do not collapse
  the jobs to save a runner minute.
- **The fence is not negotiable.** `guard.sh` runs before every session, in CI as locally.
  A leak fails the job before the session starts. Do not add `--add-dir`, do not widen
  `--tools`, do not put the work directory inside the checkout.
- **A check that cannot fire is not a check.** Per `CLAUDE.md`, plant a violation and watch
  the check report it before trusting it. This applies to every filing rule in Task 4 and
  to the whole workflow in Task 8.
- **Caps, from the spec's *Caps* table:** `--max-turns 200`, `--model claude-sonnet-5`,
  `timeout-minutes: 40`, `concurrency: nightly-qa` with no cancel, at most **3** new issues
  a night, and `if: github.repository_owner == 'victor-prp'` so forks skip rather than fail.
- **Ports:** server 3101, app 8092. Not the app's own and not e2e's.
- **Schedule:** `0 1 * * *` UTC.
- **Never run `npm run db:up` from a worktree** while another checkout's Postgres holds
  5432.
- **Severity rank** is `bug` (2) > `weird` (1) > `inconvenience` (0). It is used for the
  creation order and for escalation, and it is defined once, in `nightly-qa/src/filing.ts`.

## One deliberate departure from the spec

The spec's *How matching actually has to work* says the `possible-duplicate` flag fires
when a new issue's `screen | element` collides with an open one. That was written before
the same section made the fingerprint's third segment a **controlled vocabulary**, and the
two decisions interact: with a fixed symptom word, `dictionary | senses list |
duplicate-entry` and `dictionary | senses list | hidden-behind-tap` are cleanly different,
and a `screen | element` trigger would label almost every dictionary finding a possible
duplicate.

So the flag fires on an **exact three-segment fingerprint match** against an open issue,
which under the vocabulary is both meaningful and rare. The weaker `screen | element`
neighbours are still computed and printed in the job summary, where a human can see them
without an issue being labelled. Task 9 corrects the spec to say this.

---

## File structure

| Path | Responsibility |
|---|---|
| `nightly-qa/charters/personas/*.md` | Four personas. `careful-adult` moves here from `brief/`. |
| `nightly-qa/charters/focus/*.md` | Seven focus areas. `polysemy` moves here from `brief/`. |
| `nightly-qa/brief/mission.md` | Unchanged except for the deduplication section Task 3 adds. |
| `nightly-qa/prepare.sh` | Picks tonight's charter, dumps known issues. Writes `.out/charter` and `.out/known-issues.json`. |
| `nightly-qa/workdir.sh` | Gains `--persona` and `--focus`; no longer hardcodes two filenames. |
| `nightly-qa/src/knownIssues.ts` | Zod schema for `known-issues.json`, plus `parseFingerprint` and the issue-body renderer. |
| `nightly-qa/src/knownIssues.test.ts` | Its tests. |
| `nightly-qa/src/filing.ts` | **Pure.** `decide(report, known, limits) -> Action[]`. No `gh`, no filesystem, no clock. |
| `nightly-qa/src/filing.test.ts` | Its tests, built on the part A fixtures. |
| `nightly-qa/src/file.ts` | The impure half: reads the files, calls `gh`, writes the job summary. `--dry-run` by default in local use. |
| `nightly-qa/src/evidence.ts` | Pushes a run's screenshots to the orphan `nightly-qa-evidence` branch and returns their raw URLs. |
| `nightly-qa/src/fixtures/run-clean.json`, `run-planted.json` | The two part A runs. Already committed. |
| `.github/workflows/nightly-qa.yml` | The two jobs. |
| `nightly-qa/run.sh` | Gains `--persona`/`--focus` passthrough and `--known-issues`. |
| `nightly-qa/src/findings.ts` | Gains the optional `match` field. |

---

### Task 1: Charters, and a rotation that is a function of the date

**Files:**
- Create: `nightly-qa/charters/personas/{careful-adult,impatient-typer,young-learner,returning-user}.md`
- Create: `nightly-qa/charters/focus/{polysemy,typos-and-near-misses,phrases-and-sentences,session-and-scoring,abandon-and-resume,onboarding-edges,hebrew-input}.md`
- Delete: `nightly-qa/brief/persona-careful-adult.md`, `nightly-qa/brief/focus-polysemy.md`
- Modify: `nightly-qa/workdir.sh`, `nightly-qa/run.sh`

**Interfaces:**
- Consumes: part A's `workdir.sh`, which currently concatenates two hardcoded filenames.
- Produces: `workdir.sh --persona <name> --focus <name>` assembles
  `mission.md + charters/personas/<persona>.md + charters/focus/<focus>.md`, and fails
  loudly when either file is missing. `run.sh` passes both through. Task 2's `prepare.sh`
  chooses the names.

- [ ] **Step 1: Move the two existing charter files**

```bash
mkdir -p nightly-qa/charters/personas nightly-qa/charters/focus
git mv nightly-qa/brief/persona-careful-adult.md nightly-qa/charters/personas/careful-adult.md
git mv nightly-qa/brief/focus-polysemy.md nightly-qa/charters/focus/polysemy.md
```

Their content does not change. Each already begins with a `---` rule and a heading, which
is what lets them be concatenated in any combination.

- [ ] **Step 2: Write the three remaining personas**

Each file follows `careful-adult.md` exactly: a leading blank line, `---`, then
`## Who you are tonight`, then two or three short paragraphs. Read that file first and
match its shape. None of them may name a file, a test ID or a route.

`nightly-qa/charters/personas/impatient-typer.md`:

```markdown

---

## Who you are tonight

You are in a hurry. You type fast and you do not check what you typed, so roughly one word
in three comes out wrong — a doubled letter, a swapped pair, a missing vowel. You expect the
app to cope, and you are annoyed when it makes you retype something you already typed.

You do not read instructions or hint text. You tap the first thing that looks like it will
get you what you want. If something takes more than a couple of seconds you assume it is
broken, and you tap it again, or you go somewhere else and come back.

You are not a tester and you do not know how the app is built. You never guess at what the
code does. You report what you see.
```

`nightly-qa/charters/personas/young-learner.md`:

```markdown

---

## Who you are tonight

You are ten years old. Your English is beginner level: short, concrete, everyday words, and
you have not met abstract or idiomatic ones. Hebrew is your first language and you read it
comfortably; long or formal Hebrew wording loses you.

You tap things to find out what they do, including things that are probably not for you. You
are happy to guess. When something appears that you do not understand, that is worth
reporting, because an app aimed at learners should not leave a child stuck.

You are not a tester and you do not know how the app is built. You never guess at what the
code does. You report what you see.
```

`nightly-qa/charters/personas/returning-user.md`:

```markdown

---

## Who you are tonight

You have used this app before and you already have an account, so create one at the start of
the night and then behave as though you have had it for months. You know roughly where
things are and you go straight to them rather than reading the screen.

Because you think you know the app, you notice two things a first-time user would not: when
something is not where you expected it, and when something you did earlier in the night did
not stick. Leave a flow half-finished, go elsewhere, and come back to it — you want to know
whether the app remembered.

You are not a tester and you do not know how the app is built. You never guess at what the
code does. You report what you see.
```

- [ ] **Step 3: Write the six remaining focus areas**

Each follows `polysemy.md`: a blank line, `---`, `## Where to spend your night`, a short
paragraph, four to six bullets, and a closing line telling the agent to look briefly at one
other part of the app so a night is never spent entirely in one screen.

`nightly-qa/charters/focus/typos-and-near-misses.md`:

```markdown

---

## Where to spend your night

Words that are not quite words. Type things wrong on purpose and judge what comes back as a
learner would:

- A single transposed pair, like `recieve` or `freind`. Does the app notice?
- A word that is a real but different word when mistyped, like `form` for `from`.
- A word with a doubled or missing letter that has no near neighbour at all.
- Something that is not a word in any language.
- If the app corrects you, is it clear *that* it corrected you, and what it corrected to?
  Can you get back to what you actually typed?

Look at the practice session too, at least briefly, so the night is not spent entirely in
one screen.
```

`nightly-qa/charters/focus/phrases-and-sentences.md`:

```markdown

---

## Where to spend your night

Input longer than one word. The app invites a word, a phrase or a sentence, so find out
whether all three are really welcome:

- A two or three word phrase whose meaning is not the sum of its parts, like `give up`.
- An idiom that cannot be translated literally.
- A complete sentence, including one that is grammatically ambiguous.
- Something long enough to test whatever limit exists, and then something past it.
- Does the answer for a sentence look like an answer for a word, and should it?

Look at the practice session too, at least briefly, so the night is not spent entirely in
one screen.
```

`nightly-qa/charters/focus/session-and-scoring.md`:

```markdown

---

## Where to spend your night

The practice session, from start to results:

- Answer everything correctly, and check the score you are shown is the score you earned.
- Answer some wrong on purpose. Is the feedback clear about what the right answer was?
- Are the wrong options plausible, or obviously filler? A question with a giveaway answer
  teaches nothing.
- Does the same question, or the same word, come back within one session?
- What happens at the very end, and can you start another session straight away?

Look at the dictionary too, at least briefly, so the night is not spent entirely in one
screen.
```

`nightly-qa/charters/focus/abandon-and-resume.md`:

```markdown

---

## Where to spend your night

Leaving things half done, which is what people actually do:

- Start a practice session, answer a few questions, then navigate away. Come back. Where
  are you?
- Type into the dictionary and leave without submitting. Return. Is your text still there?
- Reload the page in the middle of something.
- Use the back control at several points, including the first screen after signing in.
- Whatever the app remembers, is that the thing a learner would want remembered?

Look at the dictionary too, at least briefly, so the night is not spent entirely in one
screen.
```

`nightly-qa/charters/focus/onboarding-edges.md`:

```markdown

---

## Where to spend your night

Signing up, and the ways a real person fills a form:

- A username someone would plausibly choose, and then one at each end of whatever the
  rules allow.
- A display name in Hebrew, and one in English. Does either look wrong on screen afterwards?
- An age that is very low, very high, or not a number.
- Leaving a field empty and submitting anyway.
- Signing up twice with the same username.
- After signing up, does the profile show you what you actually entered?

Look at the dictionary too, at least briefly, so the night is not spent entirely in one
screen.
```

`nightly-qa/charters/focus/hebrew-input.md`:

```markdown

---

## Where to spend your night

Language going the wrong way, which is easy to do on a bilingual keyboard:

- Type Hebrew into the dictionary while the direction says English to Hebrew.
- Type English while the direction says Hebrew to English.
- Mix both scripts in one input.
- Switch direction after a result is already on screen, without changing the text.
- Does the app tell you what it did with what you gave it, or does it guess silently?

Look at the practice session too, at least briefly, so the night is not spent entirely in
one screen.
```

- [ ] **Step 4: Parameterise `workdir.sh`**

Replace the hardcoded concatenation with arguments. In `nightly-qa/workdir.sh`, change the
argument loop:

```bash
for arg in "$@"; do
  case "$arg" in
    --headed) HEADLESS="--no-headless" ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done
```

to:

```bash
PERSONA="careful-adult"
FOCUS="polysemy"

while [ $# -gt 0 ]; do
  case "$1" in
    --headed) HEADLESS="--no-headless"; shift ;;
    --persona) PERSONA="$2"; shift 2 ;;
    --focus) FOCUS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
```

and replace the brief assembly:

```bash
if [ -d nightly-qa/brief ] && [ -f nightly-qa/brief/mission.md ]; then
  cat nightly-qa/brief/mission.md \
      nightly-qa/brief/persona-careful-adult.md \
      nightly-qa/brief/focus-polysemy.md \
    | sed -e "s|__APP_URL__|http://localhost:$QA_APP_PORT|g" > "$WORK/brief.md"
fi
```

with:

```bash
PERSONA_FILE="nightly-qa/charters/personas/$PERSONA.md"
FOCUS_FILE="nightly-qa/charters/focus/$FOCUS.md"
# Fail rather than fall back. A typo in a charter name must not quietly produce a
# session with no persona at all, which would look like a normal night in every
# artifact it left behind.
[ -f "$PERSONA_FILE" ] || { echo "no such persona: $PERSONA_FILE" >&2; exit 1; }
[ -f "$FOCUS_FILE" ] || { echo "no such focus: $FOCUS_FILE" >&2; exit 1; }

cat nightly-qa/brief/mission.md "$PERSONA_FILE" "$FOCUS_FILE" \
  | sed -e "s|__APP_URL__|http://localhost:$QA_APP_PORT|g" > "$WORK/brief.md"

echo "  ok         charter: $PERSONA / $FOCUS" >&2
```

- [ ] **Step 5: Pass the charter through `run.sh`**

In `nightly-qa/run.sh`, extend the argument loop so `--persona` and `--focus` are collected
into `WORKDIR_ARGS` alongside `--headed`:

```bash
    --headed) WORKDIR_ARGS+=(--headed); shift ;;
    --persona) WORKDIR_ARGS+=(--persona "$2"); shift 2 ;;
    --focus) WORKDIR_ARGS+=(--focus "$2"); shift 2 ;;
```

- [ ] **Step 6: Verify every charter assembles, and that a bad name fails**

```bash
for p in nightly-qa/charters/personas/*.md; do
  for f in nightly-qa/charters/focus/*.md; do
    pn=$(basename "$p" .md); fn=$(basename "$f" .md)
    W=$(./nightly-qa/workdir.sh --persona "$pn" --focus "$fn" 2>/dev/null) || { echo "FAILED: $pn/$fn"; continue; }
    lines=$(wc -l < "$W/brief.md")
    leak=$(grep -c 'testID\|apps/\|src/' "$W/brief.md")
    printf '%-16s %-24s %4s lines  leaks=%s\n' "$pn" "$fn" "$lines" "$leak"
  done
done
```

Expected: 28 rows, every one with more than 120 lines and `leaks=0`. Then the negative case:

```bash
./nightly-qa/workdir.sh --persona nonesuch --focus polysemy; echo "exit=$?"
```

Expected: `no such persona: ...` and `exit=1`. A silent fallback here would produce a
session with no persona that looks completely normal afterwards, which is why it fails.

- [ ] **Step 7: Commit**

```bash
git add -A nightly-qa/charters nightly-qa/brief nightly-qa/workdir.sh nightly-qa/run.sh
git commit -m "feat: four personas and seven focus areas, chosen by argument

Part A hardcoded one of each. They move to charters/ and workdir.sh takes
--persona and --focus, which is everything the rotation needs from this side.

Four and seven are coprime, so a date-driven pick cycles all 28 pairings before
repeating - that arithmetic is Task 2's, but it is why there are four and seven
rather than round numbers.

A charter name that does not resolve fails the run. A fallback would produce a
session with no persona that looks entirely normal in every artifact it leaves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `prepare.sh` — tonight's charter and what the tracker already knows

**Files:**
- Create: `nightly-qa/prepare.sh`
- Create: `nightly-qa/src/knownIssues.ts`
- Create: `nightly-qa/src/knownIssues.test.ts`

**Interfaces:**
- Consumes: Task 1's charter directories; `gh` on the PATH and authenticated.
- Produces: `prepare.sh` writes `nightly-qa/.out/charter` (two lines: persona, focus) and
  `nightly-qa/.out/known-issues.json` (a JSON array validated by `knownIssuesSchema`). It
  prints `persona=<p> focus=<f>` on stdout for the workflow to read. Task 3's brief reads
  the JSON; Task 4's `decide()` takes the parsed array.
- `nightly-qa/src/knownIssues.ts` exports `knownIssuesSchema`, `type KnownIssue`,
  `parseFingerprint(body: string): string | null`,
  `severityFromLabels(labels: string[]): Severity | null`, and
  `renderIssueBody(finding, run): string`.

- [ ] **Step 1: Write the failing tests**

`nightly-qa/src/knownIssues.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  knownIssuesSchema,
  parseFingerprint,
  renderIssueBody,
  severityFromLabels,
} from './knownIssues.ts';

test('parses the fingerprint back out of a rendered body', () => {
  const finding = {
    id: 'f1',
    severity: 'bug' as const,
    confidence: 'high' as const,
    title: 'Only the top sense renders',
    screen: 'dictionary',
    steps: ['open the dictionary', 'type bank'],
    expected: 'all senses reachable',
    observed: 'one sense, no control',
    evidence: { screenshots: [], network: 'POST /api/translations -> 4 senses', console: [] },
    fingerprint: 'dictionary | senses list | hidden-behind-tap',
  };
  const body = renderIssueBody(finding, {
    date: '2026-09-17',
    persona: 'careful-adult',
    focus: 'polysemy',
    browser_ok: true,
  });
  assert.equal(parseFingerprint(body), 'dictionary | senses list | hidden-behind-tap');
});

test('a body with no fingerprint line parses as null', () => {
  assert.equal(parseFingerprint('Some human wrote this issue by hand.'), null);
});

test('the fingerprint line is matched even with other backticks in the body', () => {
  const body = 'Steps: run `npm test`\n\n**Fingerprint:** `home | route navigation | lost-session`\n';
  assert.equal(parseFingerprint(body), 'home | route navigation | lost-session');
});

test('reads the severity back off the labels', () => {
  assert.equal(severityFromLabels(['nightly-qa', 'bug']), 'bug');
  assert.equal(severityFromLabels(['nightly-qa', 'inconvenience']), 'inconvenience');
  assert.equal(severityFromLabels(['nightly-qa']), null);
});

test('accepts the shape gh produces', () => {
  const parsed = knownIssuesSchema.parse([
    {
      number: 42,
      title: '[nightly-qa] Only the top sense renders',
      state: 'OPEN',
      labels: [{ name: 'nightly-qa' }, { name: 'bug' }],
      body: '**Fingerprint:** `dictionary | senses list | hidden-behind-tap`',
    },
  ]);
  assert.equal(parsed[0].number, 42);
  assert.equal(parsed[0].state, 'open');
  assert.deepEqual(parsed[0].labels, ['nightly-qa', 'bug']);
  assert.equal(parsed[0].fingerprint, 'dictionary | senses list | hidden-behind-tap');
  assert.equal(parsed[0].severity, 'bug');
});

test('an issue a human opened, with no fingerprint and no severity label, still parses', () => {
  const parsed = knownIssuesSchema.parse([
    { number: 7, title: 'something', state: 'CLOSED', labels: [{ name: 'nightly-qa' }], body: '' },
  ]);
  assert.equal(parsed[0].fingerprint, null);
  assert.equal(parsed[0].severity, null);
  assert.equal(parsed[0].state, 'closed');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm test -w nightly-qa
```

Expected: FAIL, cannot find module `./knownIssues.ts`.

- [ ] **Step 3: Implement**

`nightly-qa/src/knownIssues.ts`:

```ts
import { z } from 'zod';

import type { Finding, QaReport, Severity } from './findings.ts';
import { severities } from './findings.ts';

/**
 * What the `file` job knows about the tracker, and how an issue carries enough
 * structure to be recognised again tomorrow.
 *
 * The fingerprint lives in the issue body rather than anywhere clever, because
 * the body is the one field that survives every edit a human might make to an
 * issue: retitling, relabelling, moving it around a project board.
 */

/** The last line of every issue this bot opens. Parsed back out by parseFingerprint. */
const FINGERPRINT_LABEL = '**Fingerprint:**';

export function parseFingerprint(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(FINGERPRINT_LABEL)) continue;
    const match = trimmed.slice(FINGERPRINT_LABEL.length).match(/`([^`]+)`/);
    if (match) return match[1].trim();
  }
  return null;
}

export function severityFromLabels(labels: string[]): Severity | null {
  return severities.find((s) => labels.includes(s)) ?? null;
}

const rawIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  body: z.string().nullable().default(''),
});

export const knownIssuesSchema = z.array(rawIssueSchema).transform((rows) =>
  rows.map((row) => {
    const labels = row.labels.map((l) => l.name);
    const body = row.body ?? '';
    return {
      number: row.number,
      title: row.title,
      state: row.state.toLowerCase() === 'open' ? ('open' as const) : ('closed' as const),
      labels,
      body,
      fingerprint: parseFingerprint(body),
      severity: severityFromLabels(labels),
    };
  }),
);

export type KnownIssue = z.infer<typeof knownIssuesSchema>[number];

/**
 * The issue body. Fixed template, and the fingerprint is last so that a human
 * appending notes to the issue never pushes it out of reach of the parser -
 * parseFingerprint scans every line, but keeping it last also keeps it visible.
 */
export function renderIssueBody(finding: Finding, run: QaReport['run']): string {
  const steps = finding.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const evidence: string[] = [];
  if (finding.evidence.network) evidence.push(`**Network:** ${finding.evidence.network}`);
  if (finding.evidence.console.length > 0) {
    evidence.push(`**Console:** ${finding.evidence.console.join(' / ')}`);
  }

  return [
    `Found by the nightly QA agent on ${run.date}, as **${run.persona}** looking at **${run.focus}**.`,
    '',
    `**Screen:** ${finding.screen}`,
    '',
    '**Steps**',
    '',
    steps,
    '',
    `**Expected:** ${finding.expected}`,
    '',
    `**Observed:** ${finding.observed}`,
    '',
    ...(evidence.length > 0 ? [evidence.join('\n\n'), ''] : []),
    '<!-- screenshots -->',
    '',
    `**Fingerprint:** \`${finding.fingerprint}\``,
    '',
  ].join('\n');
}
```

The `<!-- screenshots -->` marker is where Task 6 injects image links. It is a comment so
an issue with no screenshots reads normally.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w nightly-qa
```

Expected: PASS, and the part A tests still pass alongside.

- [ ] **Step 5: Write `prepare.sh`**

`nightly-qa/prepare.sh`:

```bash
#!/usr/bin/env bash
#
# Chooses tonight's charter and fetches what the tracker already knows.
#
# The charter is a function of the date rather than a random draw, so re-running
# a night by hand reproduces it exactly. Four personas and seven focus areas are
# coprime, so the pairing cycles through all 28 combinations before repeating -
# a random pick would collide far more often than that over a month.

set -u

cd "$(dirname "$0")/.." || exit 1

OUT="nightly-qa/.out"
mkdir -p "$OUT"

PERSONA=""
FOCUS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --persona) PERSONA="$2"; shift 2 ;;
    --focus) FOCUS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Sorted so the mapping from a date to a charter is stable across machines,
# where `ls` order is not guaranteed to be.
mapfile -t PERSONAS < <(find nightly-qa/charters/personas -name '*.md' -exec basename {} .md \; | sort)
mapfile -t FOCUSES < <(find nightly-qa/charters/focus -name '*.md' -exec basename {} .md \; | sort)

[ "${#PERSONAS[@]}" -gt 0 ] || { echo "no personas found" >&2; exit 1; }
[ "${#FOCUSES[@]}" -gt 0 ] || { echo "no focus areas found" >&2; exit 1; }

DOY=$(date -u +%j)
DOY=$((10#$DOY))   # strip the leading zero; 008 is not octal here

[ -n "$PERSONA" ] || PERSONA="${PERSONAS[$((DOY % ${#PERSONAS[@]}))]}"
[ -n "$FOCUS" ] || FOCUS="${FOCUSES[$((DOY % ${#FOCUSES[@]}))]}"

printf '%s\n%s\n' "$PERSONA" "$FOCUS" > "$OUT/charter"

# --- what the tracker already knows ------------------------------------------
# Open AND closed. A closed issue is exactly the thing the agent must not spend
# tonight rediscovering, and file.ts needs the closed ones to tell "reproduced
# after a fix" from "arguing with a wontfix".
if gh issue list --label nightly-qa --state all --limit 200 \
     --json number,title,state,labels,body > "$OUT/known-issues.json" 2>"$OUT/gh.log"; then
  count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$OUT/known-issues.json")
  echo "  ok         $count known issues" >&2
else
  # A tracker we cannot read is not a reason to skip the night: the session is
  # still worth running, and file.ts treats an empty list as "nothing known",
  # which at worst files a duplicate a human can merge. Silence would be worse.
  echo "  !!         could not read the tracker; continuing with none known" >&2
  cat "$OUT/gh.log" >&2
  echo '[]' > "$OUT/known-issues.json"
fi

echo "  ok         charter: $PERSONA / $FOCUS" >&2
echo "persona=$PERSONA focus=$FOCUS"
```

```bash
chmod +x nightly-qa/prepare.sh
```

- [ ] **Step 6: Verify the rotation covers all 28 pairings without repeating**

```bash
for d in $(seq 1 30); do
  DOY=$d node -e '
    const p=["careful-adult","impatient-typer","returning-user","young-learner"].sort();
    const f=["abandon-and-resume","hebrew-input","onboarding-edges","phrases-and-sentences","polysemy","session-and-scoring","typos-and-near-misses"].sort();
    const d=Number(process.env.DOY);
    console.log(p[d%p.length]+" / "+f[d%f.length]);'
done | sort | uniq -c | sort -rn | head -3
```

Expected: every line appears once. Then confirm the script itself agrees with that model:

```bash
./nightly-qa/prepare.sh >/dev/null && cat nightly-qa/.out/charter
./nightly-qa/prepare.sh --persona young-learner --focus hebrew-input >/dev/null && cat nightly-qa/.out/charter
```

Expected: the first prints today's pair; the second prints exactly the override.

- [ ] **Step 7: Verify the tracker read, and its failure path**

```bash
./nightly-qa/prepare.sh 2>&1 >/dev/null | head -3
node -e 'const j=JSON.parse(require("fs").readFileSync("nightly-qa/.out/known-issues.json","utf8")); console.log(Array.isArray(j), j.length)'
```

Expected: an `ok N known issues` line and a JSON array. With no issues labelled
`nightly-qa` yet, `N` is 0 and the array is empty, which is correct rather than a failure.

Now plant the failure: make `gh` unavailable and confirm the night still proceeds.

```bash
PATH=/usr/bin:/bin ./nightly-qa/prepare.sh 2>&1 >/dev/null | head -3; echo "exit=$?"
cat nightly-qa/.out/known-issues.json
```

Expected: the `could not read the tracker` warning, `exit=0`, and `[]` in the file. A
tracker that cannot be read must not cancel the night — at worst it files a duplicate
someone merges.

- [ ] **Step 8: Commit**

```bash
git add nightly-qa/prepare.sh nightly-qa/src/knownIssues.ts nightly-qa/src/knownIssues.test.ts
git commit -m "feat: pick tonight's charter by date and read what the tracker knows

The charter is a function of the day of the year rather than a random draw, so
re-running a night by hand reproduces it exactly. Four personas and seven focus
areas are coprime, so the pairing cycles all 28 combinations before repeating;
a random pick would collide far more often over a month.

known-issues.json carries open and closed issues alike. A closed one is exactly
what the agent must not spend the night rediscovering, and the filing rules need
it to tell 'reproduced after a fix' from 'arguing with a wontfix every night'.

The fingerprint lives in the issue body because the body is the one field that
survives retitling, relabelling and being moved around a board.

A tracker that cannot be read warns and continues with none known, rather than
cancelling the night. The worst case is a duplicate someone merges; a skipped
night finds nothing at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `match` field, and teaching the brief to deduplicate

**Files:**
- Modify: `nightly-qa/src/findings.ts`
- Modify: `nightly-qa/src/findings.test.ts`
- Modify: `nightly-qa/brief/mission.md`
- Modify: `nightly-qa/workdir.sh`, `nightly-qa/run.sh`

**Interfaces:**
- Consumes: Task 2's `known-issues.json`.
- Produces: `Finding.match` is `{ issue: number } | { new: true } | undefined`. `workdir.sh`
  copies `known-issues.json` into the work directory so the agent can read it; `run.sh`
  passes its path. Task 4's `decide()` reads `match`.

- [ ] **Step 1: Write the failing tests**

Append to `nightly-qa/src/findings.test.ts`:

```ts

test('accepts a finding matched to an existing issue', () => {
  const parsed = parseReport({
    ...validReport,
    findings: [{ ...validFinding, match: { issue: 42 } }],
  });
  assert.deepEqual(parsed.findings[0].match, { issue: 42 });
});

test('accepts a finding the agent judged new', () => {
  const parsed = parseReport({
    ...validReport,
    findings: [{ ...validFinding, match: { new: true } }],
  });
  assert.deepEqual(parsed.findings[0].match, { new: true });
});

test('accepts a finding with no match at all, for a session that ran out of turns', () => {
  const parsed = parseReport(validReport);
  assert.equal(parsed.findings[0].match, undefined);
});

test('rejects a match that is neither an issue number nor new', () => {
  assert.throws(() =>
    parseReport({ ...validReport, findings: [{ ...validFinding, match: { issue: 'yes' } }] }),
  );
  assert.throws(() =>
    parseReport({ ...validReport, findings: [{ ...validFinding, match: { new: false } }] }),
  );
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm test -w nightly-qa
```

Expected: FAIL. The strict object schema rejects the unknown `match` key, so the first two
tests fail.

- [ ] **Step 3: Add the field**

In `nightly-qa/src/findings.ts`, above `findingSchema`:

```ts
/**
 * The agent's own judgement about whether the tracker already knows this.
 *
 * Optional on purpose. A session that hits the turn cap before the
 * deduplication pass leaves it off entirely, and that is a different thing from
 * "I decided this is new" - file.ts files the second and never the first.
 */
const matchSchema = z.union([
  z.object({ issue: z.number().int().positive() }).strict(),
  z.object({ new: z.literal(true) }).strict(),
]);
```

and add to the object passed to `z.object({...})` in `findingSchema`, after `fingerprint`:

```ts
    match: matchSchema.optional(),
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w nightly-qa
```

Expected: PASS, all of them.

- [ ] **Step 5: Put the known issues in front of the agent**

In `nightly-qa/workdir.sh`, after the brief is assembled, add:

```bash
# The agent reads this to decide what is already known. Copied in rather than
# read from the checkout, because the checkout is exactly what the fence stops
# it reaching.
if [ -f nightly-qa/.out/known-issues.json ]; then
  cp nightly-qa/.out/known-issues.json "$WORK/known-issues.json"
else
  echo '[]' > "$WORK/known-issues.json"
fi
```

The allow rule already covers this: `Read(//__WORK__/**)` includes it.

- [ ] **Step 6: Teach the brief the deduplication pass**

In `nightly-qa/brief/mission.md`, immediately before the `## What to leave behind` heading,
insert:

```markdown
## What is already known

`known-issues.json` in your working directory lists every issue this bot has ever filed,
open and closed. Read it **before** you start exploring, and again before you write up.

Reading it first saves you the night. These are problems someone has already been told
about, so do not spend your budget re-finding them. If you happen to pass one, a single
line in the report saying it still reproduces is worth more than a finding.

Reading it again at the end is the deduplication pass, and it is the part that keeps the
tracker worth reading. For **every** finding, add a `match` field:

- `"match": { "issue": 42 }` when it is the same underlying problem as issue 42, even if
  the wording, the word you looked up, or the severity differ. Same screen, same control,
  same symptom means same problem.
- `"match": { "new": true }` when nothing in the list is this problem.

Judge the problem, not the prose. Two write-ups of one defect will not look alike. What
makes them the same is the fingerprint and the mechanism, not the sentence. And the reverse
trap is real: two findings can share a screen and a control and still be different problems,
so a suppressed control and a working-but-awkward one are **not** a match.

If you run out of budget before you get to this, leave `match` off rather than guessing. A
guess files a duplicate; an absent field files nothing and says so.
```

- [ ] **Step 7: Verify the brief assembles and the contract holds**

```bash
./nightly-qa/prepare.sh >/dev/null
W=$(./nightly-qa/workdir.sh --persona impatient-typer --focus typos-and-near-misses)
ls "$W"
grep -c "known-issues.json" "$W/brief.md"
grep -c 'testID\|apps/\|src/' "$W/brief.md"
npm test -w nightly-qa 2>&1 | grep -E "^. (pass|fail)"
```

Expected: the work directory holds `brief.md`, `known-issues.json`, `settings.json` and
`mcp.json`; the brief mentions the file at least once; leaks are `0`; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add nightly-qa/src/findings.ts nightly-qa/src/findings.test.ts nightly-qa/brief/mission.md nightly-qa/workdir.sh
git commit -m "feat: let the agent say whether the tracker already knows a finding

match is { issue: n } or { new: true }, and optional on purpose: a session that
hits the turn cap before the deduplication pass leaves it off, which is a
different thing from deciding a finding is new. The filing rules act on the
second and never on the first.

The brief now puts known-issues.json in front of the agent twice: before
exploring, so a night is not spent re-finding what someone has already been
told, and at the end as the deduplication pass. It is copied into the work
directory rather than read from the checkout, which is exactly what the fence
stops the agent reaching.

The instruction that matters most is the one about the reverse trap: two
findings can share a screen and a control and still be different problems. Phase
A produced exactly that pair, and merging them would have hidden one completely.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The filing decision, pure

**Files:**
- Create: `nightly-qa/src/filing.ts`
- Create: `nightly-qa/src/filing.test.ts`

**Interfaces:**
- Consumes: `QaReport` from `findings.ts`, `KnownIssue` from `knownIssues.ts`, the fixtures
  in `src/fixtures/`.
- Produces: `decide(report, known, options): Decision`, where
  `Decision = { actions: Action[]; neighbours: Neighbour[] }` and

```ts
type Action =
  | { kind: 'comment'; issue: number; finding: Finding; escalateTo?: Severity; reopened: boolean }
  | { kind: 'create'; finding: Finding; possibleDuplicateOf: number[] }
  | { kind: 'skip'; finding: Finding; reason: string };
type Neighbour = { finding: string; issue: number; shared: string };
```

  Task 5's `file.ts` executes these and nothing else.

This is the heart of part B. It is pure — no `gh`, no filesystem, no clock — so every rule
is testable, and the tests use part A's real runs rather than invented data.

- [ ] **Step 1: Write the failing tests**

`nightly-qa/src/filing.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { decide, severityRank, type Action } from './filing.ts';
import { parseReport, parseReportLoose, type QaReport } from './findings.ts';
import { knownIssuesSchema, type KnownIssue } from './knownIssues.ts';

// Narrowing helpers. `assert.equal(a.kind, 'skip')` satisfies the runtime but
// not tsc, which still sees the union and rejects `.reason` - and typecheck runs
// over this workspace, so without these the suite passes and the build fails.
const expectSkip = (a: Action) => {
  assert.equal(a.kind, 'skip');
  return a as Extract<Action, { kind: 'skip' }>;
};
const expectComment = (a: Action) => {
  assert.equal(a.kind, 'comment');
  return a as Extract<Action, { kind: 'comment' }>;
};
const expectCreate = (a: Action) => {
  assert.equal(a.kind, 'create');
  return a as Extract<Action, { kind: 'create' }>;
};

const run = { date: '2026-09-17', persona: 'careful-adult', focus: 'polysemy', browser_ok: true };

function finding(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    severity: 'bug',
    confidence: 'high',
    title: 'Only the top sense renders',
    screen: 'dictionary',
    steps: ['open the dictionary', 'type bank'],
    expected: 'all senses reachable',
    observed: 'one sense, no control',
    evidence: { screenshots: [], network: 'POST /api/translations -> 4 senses', console: [] },
    fingerprint: 'dictionary | senses list | hidden-behind-tap',
    ...over,
  };
}

function report(findings: Record<string, unknown>[]): QaReport {
  return parseReport({ run, coverage: [], findings, notes: '' });
}

function issues(rows: Partial<Record<string, unknown>>[]): KnownIssue[] {
  return knownIssuesSchema.parse(
    rows.map((r, i) => ({
      number: r.number ?? i + 1,
      title: r.title ?? 'an issue',
      state: r.state ?? 'OPEN',
      labels: (r.labels as string[] | undefined)?.map((name) => ({ name })) ?? [
        { name: 'nightly-qa' },
        { name: 'bug' },
      ],
      body: r.body ?? '**Fingerprint:** `dictionary | senses list | hidden-behind-tap`',
    })),
  );
}

const limits = { maxNew: 3 };

test('a low-confidence finding is never filed', () => {
  const { actions } = decide(report([finding({ confidence: 'low', match: { new: true } })]), [], limits);
  assert.match(expectSkip(actions[0]).reason, /confidence/);
});

test('a finding with no match at all is not filed, and says why', () => {
  const { actions } = decide(report([finding()]), [], limits);
  assert.match(expectSkip(actions[0]).reason, /no deduplication decision/);
});

test('a match against an open issue comments on it', () => {
  const known = issues([{ number: 42, state: 'OPEN' }]);
  const { actions } = decide(report([finding({ match: { issue: 42 } })]), known, limits);
  const comment = expectComment(actions[0]);
  assert.equal(comment.issue, 42);
  assert.equal(comment.reopened, false);
});

test('severity escalates when the finding is worse than the issue on record', () => {
  const known = issues([{ number: 42, state: 'OPEN', labels: ['nightly-qa', 'weird'] }]);
  const { actions } = decide(report([finding({ severity: 'bug', match: { issue: 42 } })]), known, limits);
  assert.equal(expectComment(actions[0]).escalateTo, 'bug');
});

test('severity never falls: a quieter night does not shrink a known bug', () => {
  const known = issues([{ number: 42, state: 'OPEN', labels: ['nightly-qa', 'bug'] }]);
  const { actions } = decide(
    report([finding({ severity: 'inconvenience', match: { issue: 42 } })]),
    known,
    limits,
  );
  assert.equal(expectComment(actions[0]).escalateTo, undefined);
});

test('a match against an issue closed as by-design is dropped without comment', () => {
  const known = issues([{ number: 42, state: 'CLOSED', labels: ['nightly-qa', 'by-design'] }]);
  const { actions } = decide(report([finding({ match: { issue: 42 } })]), known, limits);
  assert.match(expectSkip(actions[0]).reason, /by-design/);
});

test('a match against an issue closed for any other reason comments that it came back', () => {
  const known = issues([{ number: 42, state: 'CLOSED', labels: ['nightly-qa', 'bug'] }]);
  const { actions } = decide(report([finding({ match: { issue: 42 } })]), known, limits);
  assert.equal(expectComment(actions[0]).reopened, true);
});

test('a match against an issue number that does not exist is not filed', () => {
  const { actions } = decide(report([finding({ match: { issue: 999 } })]), issues([{ number: 42 }]), limits);
  assert.match(expectSkip(actions[0]).reason, /999/);
});

test('a new finding is created', () => {
  const { actions } = decide(report([finding({ match: { new: true } })]), [], limits);
  assert.deepEqual(expectCreate(actions[0]).possibleDuplicateOf, []);
});

test('creations are capped, bugs first, and the overflow says it was the cap', () => {
  const many = [
    finding({ id: 'a', severity: 'inconvenience', match: { new: true } }),
    finding({ id: 'b', severity: 'bug', match: { new: true } }),
    finding({ id: 'c', severity: 'weird', match: { new: true } }),
    finding({ id: 'd', severity: 'bug', match: { new: true } }),
  ];
  const { actions } = decide(report(many), [], { maxNew: 2 });
  const created = actions.filter((a) => a.kind === 'create').map((a) => a.finding.id);
  assert.deepEqual(created, ['b', 'd']);
  const skipped = actions.filter((a) => a.kind === 'skip') as Extract<Action, { kind: 'skip' }>[];
  assert.equal(skipped.length, 2);
  for (const s of skipped) assert.match(s.reason, /cap/);
});

test('a new finding whose exact fingerprint is already open is flagged, not blocked', () => {
  const known = issues([
    { number: 42, state: 'OPEN', body: '**Fingerprint:** `dictionary | senses list | hidden-behind-tap`' },
  ]);
  const { actions } = decide(report([finding({ match: { new: true } })]), known, limits);
  assert.deepEqual(expectCreate(actions[0]).possibleDuplicateOf, [42]);
});

test('THE TRAP: same screen and element, different symptom, is not flagged as a duplicate', () => {
  const known = issues([
    { number: 42, state: 'OPEN', body: '**Fingerprint:** `dictionary | senses list | duplicate-entry`' },
  ]);
  const { actions, neighbours } = decide(
    report([finding({ fingerprint: 'dictionary | senses list | hidden-behind-tap', match: { new: true } })]),
    known,
    limits,
  );
  assert.deepEqual(
    expectCreate(actions[0]).possibleDuplicateOf,
    [],
    'must not flag: these are two different problems',
  );
  assert.equal(neighbours.length, 1, 'but a human should still see they are neighbours');
  assert.equal(neighbours[0].issue, 42);
});

test('fingerprint comparison ignores spacing and case', () => {
  const known = issues([
    { number: 42, state: 'OPEN', body: '**Fingerprint:** `Dictionary|Senses List|hidden-behind-tap`' },
  ]);
  const { actions } = decide(report([finding({ match: { new: true } })]), known, limits);
  assert.deepEqual(expectCreate(actions[0]).possibleDuplicateOf, [42]);
});

test('severityRank orders bug above weird above inconvenience', () => {
  assert.ok(severityRank('bug') > severityRank('weird'));
  assert.ok(severityRank('weird') > severityRank('inconvenience'));
});

// --- the real runs -----------------------------------------------------------
// These are part A's two sessions. What makes them worth testing against is
// exactly what invented fixtures smooth over: the same defect written up two
// different ways on two different nights.

const clean = parseReport(JSON.parse(readFileSync('src/fixtures/run-clean.json', 'utf8')));

// parseReportLoose, not parseReport: this run carried one finding with no
// evidence at all, and the strict parser rejects the whole document for it. That
// is exactly the case parseReportLoose exists for, and the fixture is worth
// keeping unedited because a real night really does produce one.
const plantedParse = parseReportLoose(
  JSON.parse(readFileSync('src/fixtures/run-planted.json', 'utf8')),
);

test('both real runs parse and carry no match field, so nothing files by accident', () => {
  assert.equal(clean.findings.length, 5);
  assert.equal(plantedParse.report.findings.length, 5);
  assert.equal(plantedParse.dropped.length, 1, 'the planted run carried one unevidenced finding');
  const { actions } = decide(clean, [], limits);
  assert.ok(actions.every((a) => a.kind === 'skip'));
});

test('a real run with every finding marked new files exactly the cap, bugs first', () => {
  const marked = parseReport({
    ...clean,
    findings: clean.findings.map((f) => ({ ...f, match: { new: true } })),
  });
  const { actions } = decide(marked, [], limits);
  const created = actions.filter((a) => a.kind === 'create') as Extract<Action, { kind: 'create' }>[];
  assert.equal(created.length, 3);
  assert.ok(created.every((a) => a.finding.severity === 'bug'));
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd nightly-qa && npm test; cd ..
```

Expected: FAIL, cannot find module `./filing.ts`. Note the `cd`: the fixture paths in the
test are relative to the workspace, which is how `npm test -w nightly-qa` already runs.

- [ ] **Step 3: Implement**

`nightly-qa/src/filing.ts`:

```ts
import type { Finding, QaReport, Severity } from './findings.ts';
import type { KnownIssue } from './knownIssues.ts';

/**
 * Every decision about what reaches the tracker, and nothing else.
 *
 * Pure by design: no gh, no filesystem, no clock. The rules are the part that
 * has to be right, and the only way to keep them testable against real sessions
 * is to keep the side effects in file.ts.
 */

export type Action =
  | {
      kind: 'comment';
      issue: number;
      finding: Finding;
      escalateTo?: Severity;
      /** The issue was closed and this finding reproduced it anyway. */
      reopened: boolean;
    }
  | { kind: 'create'; finding: Finding; possibleDuplicateOf: number[] }
  | { kind: 'skip'; finding: Finding; reason: string };

export type Neighbour = { finding: string; issue: number; shared: string };
export type Decision = { actions: Action[]; neighbours: Neighbour[] };

const RANK: Record<Severity, number> = { inconvenience: 0, weird: 1, bug: 2 };
export function severityRank(severity: Severity): number {
  return RANK[severity];
}

/**
 * Labels that mean a human has already ruled on this. The bot does not reopen
 * that argument nightly; it drops the finding silently into the summary.
 */
const SETTLED = ['wontfix', "won't fix", 'by-design', 'not-planned'];

const normalise = (fingerprint: string): string =>
  fingerprint
    .split('|')
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, ' '))
    .join(' | ');

const screenAndElement = (fingerprint: string): string =>
  normalise(fingerprint).split(' | ').slice(0, 2).join(' | ');

export function decide(
  report: QaReport,
  known: KnownIssue[],
  options: { maxNew: number },
): Decision {
  const byNumber = new Map(known.map((issue) => [issue.number, issue]));
  const open = known.filter((issue) => issue.state === 'open');
  const actions: Action[] = [];
  const neighbours: Neighbour[] = [];
  const creations: { finding: Finding; possibleDuplicateOf: number[] }[] = [];

  for (const finding of report.findings) {
    if (finding.confidence === 'low') {
      actions.push({ kind: 'skip', finding, reason: 'low confidence is reported, never filed' });
      continue;
    }

    if (!finding.match) {
      actions.push({
        kind: 'skip',
        finding,
        reason: 'no deduplication decision: the session ended before the match pass',
      });
      continue;
    }

    if ('issue' in finding.match) {
      const issue = byNumber.get(finding.match.issue);
      if (!issue) {
        actions.push({
          kind: 'skip',
          finding,
          reason: `matched issue ${finding.match.issue} is not a known nightly-qa issue`,
        });
        continue;
      }

      if (issue.state === 'closed' && issue.labels.some((l) => SETTLED.includes(l.toLowerCase()))) {
        actions.push({
          kind: 'skip',
          finding,
          reason: `issue ${issue.number} is closed as by-design or wontfix; a decision was already taken`,
        });
        continue;
      }

      // Escalate only upward. A quieter night is not evidence the problem got
      // smaller - it is evidence the agent did not reach the worse path.
      const escalateTo =
        issue.severity && severityRank(finding.severity) > severityRank(issue.severity)
          ? finding.severity
          : undefined;

      actions.push({
        kind: 'comment',
        issue: issue.number,
        finding,
        escalateTo,
        reopened: issue.state === 'closed',
      });
      continue;
    }

    // match.new
    const fingerprint = normalise(finding.fingerprint);
    const prefix = screenAndElement(finding.fingerprint);

    const possibleDuplicateOf = open
      .filter((issue) => issue.fingerprint && normalise(issue.fingerprint) === fingerprint)
      .map((issue) => issue.number);

    for (const issue of open) {
      if (!issue.fingerprint) continue;
      if (possibleDuplicateOf.includes(issue.number)) continue;
      if (screenAndElement(issue.fingerprint) === prefix) {
        neighbours.push({ finding: finding.id, issue: issue.number, shared: prefix });
      }
    }

    creations.push({ finding, possibleDuplicateOf });
  }

  // Bugs before weird before inconveniences, and a stable order within a rank so
  // the same report always files the same issues.
  creations.sort((a, b) => severityRank(b.finding.severity) - severityRank(a.finding.severity));

  creations.forEach((creation, index) => {
    if (index < options.maxNew) {
      actions.push({ kind: 'create', ...creation });
    } else {
      actions.push({
        kind: 'skip',
        finding: creation.finding,
        reason: `over the cap of ${options.maxNew} new issues a night`,
      });
    }
  });

  return { actions, neighbours };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w nightly-qa
```

Expected: PASS, every test including the trap.

- [ ] **Step 5: Plant a violation and confirm the trap test actually fires**

The trap test is the most important one in this plan, so prove it can fail. Temporarily
change the `possibleDuplicateOf` filter in `filing.ts` from the full fingerprint to the
prefix:

```ts
      .filter((issue) => issue.fingerprint && screenAndElement(issue.fingerprint) === prefix)
```

Run `npm test -w nightly-qa`. Expected: **FAIL**, on
`must not flag: these are two different problems`. Then revert the line. A test that cannot
fail is the failure mode `CLAUDE.md` warns about, and this one guards the exact mistake
part A proved is easy to make.

- [ ] **Step 6: Commit**

```bash
git add nightly-qa/src/filing.ts nightly-qa/src/filing.test.ts
git commit -m "feat: decide what reaches the tracker, without touching it

decide() is pure - no gh, no filesystem, no clock - so every rule is tested
against part A's two real sessions rather than against invented data. What
makes those runs worth testing against is exactly what invented fixtures smooth
over: the same defect written up two different ways on two different nights.

The test that matters most is the trap. Two findings that share a screen and an
element can still be different problems, and part A produced exactly that pair:
a suppressed control and a working-but-awkward one, in the same senses list.
Flagging on the prefix merges them and hides one completely, so the duplicate
flag fires only on a full three-segment fingerprint match. Confirmed by making
it fail: switching the comparison to the prefix breaks that test and nothing
else.

Severity escalates but never falls. A quieter night is not evidence a problem
got smaller, only that the agent did not reach the worse path - part A found
the same defect as 'weird' one run and a 502 the next.

An issue number the agent invented files nothing, and an issue closed as
by-design is dropped in silence rather than argued with nightly.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `file.ts` — carrying the decisions out

**Files:**
- Create: `nightly-qa/src/file.ts`
- Modify: `package.json` (root) — add `qa:file`

**Interfaces:**
- Consumes: `decide()` from Task 4, `renderIssueBody` from Task 2.
- Produces: `npx tsx nightly-qa/src/file.ts <findings.json> <known-issues.json> [--apply]`.
  Without `--apply` it prints what it would do and touches nothing. Task 7's workflow calls
  it with `--apply`; Task 6 adds screenshot links.

- [ ] **Step 1: Write it**

`nightly-qa/src/file.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { decide, type Action } from './filing.ts';
import { parseReportLoose } from './findings.ts';
import { knownIssuesSchema, renderIssueBody } from './knownIssues.ts';

const MAX_NEW = 3;

const [findingsPath, knownPath, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');

if (!findingsPath || !knownPath) {
  console.error('usage: tsx nightly-qa/src/file.ts <findings.json> <known-issues.json> [--apply]');
  process.exit(2);
}

const { report, dropped } = parseReportLoose(JSON.parse(readFileSync(findingsPath, 'utf8')));
const known = knownIssuesSchema.parse(JSON.parse(readFileSync(knownPath, 'utf8')));

if (!report.run.browser_ok) {
  console.error('browser_ok is false: the session never drove the app. Filing nothing.');
  process.exit(1);
}

const { actions, neighbours } = decide(report, known, { maxNew: MAX_NEW });

const lines: string[] = [
  `# Nightly QA — ${report.run.date}`,
  '',
  `Persona **${report.run.persona}**, focus **${report.run.focus}**. ` +
    `${report.findings.length} findings kept, ${dropped.length} dropped.`,
  '',
];

function gh(args: string[]): string {
  if (!apply) {
    console.log(`  would run: gh ${args.join(' ')}`);
    return '';
  }
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function commentBody(action: Extract<Action, { kind: 'comment' }>): string {
  const head = action.reopened
    ? `Reproduced again on ${report.run.date}, after this issue was closed.`
    : `Seen again on ${report.run.date}.`;
  const escalation = action.escalateTo
    ? `\n\nSeverity raised to **${action.escalateTo}**: this run reached a worse manifestation than the one on record.`
    : '';
  return (
    `${head} Persona **${report.run.persona}**, focus **${report.run.focus}**.` +
    escalation +
    `\n\n**Observed:** ${action.finding.observed}` +
    (action.finding.evidence.network ? `\n\n**Network:** ${action.finding.evidence.network}` : '')
  );
}

for (const action of actions) {
  if (action.kind === 'skip') {
    lines.push(`- **skipped** ${action.finding.title} — ${action.reason}`);
    continue;
  }

  if (action.kind === 'comment') {
    gh(['issue', 'comment', String(action.issue), '--body', commentBody(action)]);
    if (action.escalateTo) {
      const previous = known.find((i) => i.number === action.issue)?.severity;
      if (previous) gh(['issue', 'edit', String(action.issue), '--remove-label', previous]);
      gh(['issue', 'edit', String(action.issue), '--add-label', action.escalateTo]);
    }
    lines.push(
      `- **commented on #${action.issue}** ${action.finding.title}` +
        (action.escalateTo ? ` _(severity raised to ${action.escalateTo})_` : '') +
        (action.reopened ? ' _(reproduced after close)_' : ''),
    );
    continue;
  }

  const labels = ['nightly-qa', action.finding.severity];
  if (action.possibleDuplicateOf.length > 0) labels.push('possible-duplicate');
  let body = renderIssueBody(action.finding, report.run);
  if (action.possibleDuplicateOf.length > 0) {
    body +=
      `\n> The same fingerprint is already open on ` +
      action.possibleDuplicateOf.map((n) => `#${n}`).join(', ') +
      `. The agent judged this a separate problem; worth a human confirming.\n`;
  }
  const out = gh([
    'issue',
    'create',
    '--title',
    `[nightly-qa] ${action.finding.title}`,
    '--label',
    labels.join(','),
    '--body',
    body,
  ]);
  lines.push(`- **created** ${action.finding.title} ${out.trim()}`);
}

for (const drop of dropped) lines.push(`- **dropped** finding ${drop.id} — ${drop.reason}`);

if (neighbours.length > 0) {
  lines.push('', '## Neighbours, for a human to glance at', '');
  for (const n of neighbours) {
    lines.push(`- finding \`${n.finding}\` shares \`${n.shared}\` with #${n.issue}, but is not the same symptom`);
  }
}

if (report.notes) lines.push('', '## What the agent could not reach', '', report.notes);

const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}
```

- [ ] **Step 2: Add the root script**

In the root `package.json` `scripts`, after `qa:poc`:

```json
    "qa:file": "tsx nightly-qa/src/file.ts nightly-qa/.out/findings.json nightly-qa/.out/known-issues.json",
```

- [ ] **Step 3: Dry-run against a real part A session**

```bash
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("nightly-qa/src/fixtures/run-clean.json","utf8"));
j.findings = j.findings.map((f,i)=> i===0 ? {...f, match:{issue:42}} : {...f, match:{new:true}});
fs.writeFileSync("/tmp/qa-findings.json", JSON.stringify(j,null,2));
fs.writeFileSync("/tmp/qa-known.json", JSON.stringify([{
  number:42, title:"[nightly-qa] Save claims success", state:"OPEN",
  labels:[{name:"nightly-qa"},{name:"weird"}],
  body:"**Fingerprint:** `dictionary | mark-meaning action | no-network-call`"
}],null,2));
'
npx tsx nightly-qa/src/file.ts /tmp/qa-findings.json /tmp/qa-known.json
```

Expected, and read every line: one `would run: gh issue comment 42`, then the label
swap from `weird` to `bug` because the finding is a bug and the issue is only `weird`,
then exactly **three** `gh issue create` calls, then a skip naming the cap. Nothing is
written to GitHub, because `--apply` was not passed.

- [ ] **Step 4: Confirm the safety rails**

```bash
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("nightly-qa/src/fixtures/run-clean.json","utf8"));
j.run.browser_ok=false;
fs.writeFileSync("/tmp/qa-noboot.json", JSON.stringify(j));'
npx tsx nightly-qa/src/file.ts /tmp/qa-noboot.json /tmp/qa-known.json; echo "exit=$?"

npx tsx nightly-qa/src/file.ts nightly-qa/src/fixtures/run-clean.json /tmp/qa-known.json | grep -c "would run"
```

Expected: the first exits `1` with `browser_ok is false`. The second prints `0`, because
the unmodified fixture has no `match` on any finding, so nothing is filed — which is the
rule that stops a truncated session filing guesses.

- [ ] **Step 5: Commit**

```bash
git add nightly-qa/src/file.ts package.json
git commit -m "feat: carry the filing decisions out, and print every one

file.ts holds the side effects and none of the rules: it reads two files, calls
decide(), and runs gh. Without --apply it prints the gh calls it would make and
touches nothing, which is how a night is inspected before it is trusted.

The job summary is the second output and the one a human actually reads. Every
action appears in it, including the ones that did nothing: findings skipped for
low confidence, for the cap, for an invented issue number, and for arriving
without a deduplication decision at all. A silent skip is indistinguishable from
a finding that was never made.

browser_ok false exits non-zero rather than filing an empty night.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Screenshots that outlive the artifact

**Files:**
- Create: `nightly-qa/src/evidence.ts`
- Modify: `nightly-qa/src/file.ts`

**Interfaces:**
- Consumes: `.out/shots/*.png` and the repository's git remote.
- Produces: `pushEvidence(runDate, shotsDir, apply): Map<string, string>` mapping each
  screenshot's relative path (`shots/f1.png`) to a raw URL on the orphan branch. `file.ts`
  substitutes these into the `<!-- screenshots -->` marker.

The spec's reasoning: an artifact expires in 14 days, and part A produced an image that
proves a defect on its own. Evidence with an expiry date is evidence nobody can act on
later.

- [ ] **Step 1: Write it**

`nightly-qa/src/evidence.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

/**
 * Screenshots on an orphan branch, because the GitHub API has no image upload
 * for issue bodies and a run artifact expires in 14 days.
 *
 * The branch never merges and CI never builds it. At four images a night and
 * roughly 25KB each it costs a few megabytes a year, which buys issues whose
 * evidence is still there when someone finally reads them.
 */

const BRANCH = 'nightly-qa-evidence';

export function pushEvidence(
  runDate: string,
  shotsDir: string,
  apply: boolean,
): Map<string, string> {
  const urls = new Map<string, string>();
  if (!existsSync(shotsDir)) return urls;

  const images = readdirSync(shotsDir).filter((name) => name.endsWith('.png'));
  if (images.length === 0) return urls;

  const repo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();

  for (const image of images) {
    urls.set(
      `shots/${image}`,
      `https://raw.githubusercontent.com/${repo}/${BRANCH}/${runDate}/${image}`,
    );
  }

  if (!apply) {
    console.log(`  would push ${images.length} screenshots to ${BRANCH}/${runDate}/`);
    return urls;
  }

  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' });

  // A worktree, so the run's own checkout is never switched out from under the
  // rest of the job. --orphan on first use; afterwards the branch already exists.
  const tmp = `${process.env.RUNNER_TEMP ?? '/tmp'}/qa-evidence`;
  const exists = git(['ls-remote', '--heads', 'origin', BRANCH]).trim() !== '';
  if (exists) {
    git(['fetch', 'origin', `${BRANCH}:${BRANCH}`]);
    git(['worktree', 'add', tmp, BRANCH]);
  } else {
    git(['worktree', 'add', '--detach', tmp]);
    execFileSync('git', ['checkout', '--orphan', BRANCH], { cwd: tmp });
    execFileSync('git', ['rm', '-rf', '--cached', '.'], { cwd: tmp });
  }

  execFileSync('mkdir', ['-p', `${tmp}/${runDate}`]);
  for (const image of images) execFileSync('cp', [`${shotsDir}/${image}`, `${tmp}/${runDate}/`]);

  execFileSync('git', ['add', runDate], { cwd: tmp });
  execFileSync('git', ['commit', '-m', `evidence: ${runDate}`], { cwd: tmp });
  execFileSync('git', ['push', 'origin', BRANCH], { cwd: tmp });
  git(['worktree', 'remove', '--force', tmp]);

  return urls;
}
```

- [ ] **Step 2: Wire it into `file.ts`**

Add the import, and after the `known` line:

```ts
import { pushEvidence } from './evidence.ts';

const shotUrls = pushEvidence(report.run.date, `${findingsPath.replace(/\/[^/]+$/, '')}/shots`, apply);
```

Then replace the `let body = renderIssueBody(...)` line with:

```ts
  const shots = action.finding.evidence.screenshots
    .map((path) => shotUrls.get(path))
    .filter((url): url is string => Boolean(url))
    .map((url) => `![screenshot](${url})`);
  let body = renderIssueBody(action.finding, report.run).replace(
    '<!-- screenshots -->',
    shots.length > 0 ? `**Screenshots**\n\n${shots.join('\n\n')}` : '',
  );
```

Do the same substitution for the comment body, appending the images after the network line.

- [ ] **Step 3: Dry-run with real screenshots**

```bash
mkdir -p /tmp/qa-evidence-test/shots
cp nightly-qa/evidence/*.png /tmp/qa-evidence-test/shots/
cp /tmp/qa-findings.json /tmp/qa-evidence-test/findings.json
npx tsx nightly-qa/src/file.ts /tmp/qa-evidence-test/findings.json /tmp/qa-known.json | head -20
```

Expected: a `would push 4 screenshots` line, and the `gh issue create` bodies carry
`![screenshot](https://raw.githubusercontent.com/...)` URLs for findings that cite an image
that exists. Nothing is pushed.

- [ ] **Step 4: Commit**

```bash
git add nightly-qa/src/evidence.ts nightly-qa/src/file.ts
git commit -m "feat: keep a run's screenshots where the issue can still reach them

The GitHub API has no image upload for issue bodies, so the original answer was
a link to the run artifact - which expires in 14 days. Part A turned that from
a minor weakness into a real one by producing an image that proves a defect on
its own, better than the prose does. Evidence with an expiry date is evidence
nobody can act on later.

An orphan branch that never merges and CI never builds. Four images a night at
roughly 25KB each is a few megabytes a year.

It runs in a git worktree so the job's own checkout is never switched out from
under whatever else is running.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The workflow

**Files:**
- Create: `.github/workflows/nightly-qa.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: a nightly run, and a `workflow_dispatch` that takes `persona`, `focus`,
  `max_turns` and `file_issues`.

- [ ] **Step 1: Write it**

`.github/workflows/nightly-qa.yml`:

```yaml
name: Nightly QA

# Deliberately not part of ci.yml. This job calls a paid model twice over - the
# agent and Gemini - and takes half an hour, neither of which belongs on every
# push. It is also the one workflow whose failure is often a finding rather than
# a regression.
on:
  schedule:
    - cron: '0 1 * * *'
  workflow_dispatch:
    inputs:
      persona:
        description: 'Override tonight''s persona (blank = by date)'
        required: false
      focus:
        description: 'Override tonight''s focus area (blank = by date)'
        required: false
      max_turns:
        description: 'Turn cap'
        required: false
        default: '200'
      file_issues:
        description: 'Write to the tracker'
        type: boolean
        required: false
        default: true

# One night at a time. Two sessions against one server would interleave, and a
# manual dispatch should queue behind the schedule rather than race it. No
# cancel-in-progress: a half-finished session is wasted money.
concurrency:
  group: nightly-qa
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  # Holds the model. Can READ issues and nothing else - the whole safety
  # argument for this workflow is that the half with the model cannot write.
  explore:
    if: github.repository_owner == 'victor-prp'
    runs-on: ubuntu-latest
    timeout-minutes: 40
    permissions:
      contents: read
      issues: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code
      # The binary and the native download are separate steps, and a blocked
      # postinstall leaves a CLI that cannot start. guard.sh would catch it, but
      # it costs nothing to fail here with a clear message instead.
      - name: Verify the CLI can start
        run: claude --version

      # NOT `npx playwright install`. That resolves to the repository's own
      # Playwright (1.62.1, which e2e pins) and fetches Chromium revision 1234,
      # while @playwright/mcp pins its own Playwright at 1.64.0-alpha and wants
      # 1244. The mismatch is invisible on a developer laptop, where MCP falls
      # back to the system Chrome; a fresh runner has none, and the browser
      # simply fails to launch. Installing through MCP's own copy is what keeps
      # the revision right whatever version it bumps to next.
      - name: Install Chromium for Playwright MCP
        run: node node_modules/@playwright/mcp/node_modules/playwright-core/cli.js install --with-deps chromium

      - run: npm run db:up

      - name: Start the app against the real provider
        run: ./nightly-qa/up.sh
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          GEMINI_MODEL: ${{ vars.GEMINI_MODEL }}

      - name: Pick tonight's charter and read the tracker
        id: charter
        run: |
          args=""
          [ -n "${{ inputs.persona }}" ] && args="$args --persona ${{ inputs.persona }}"
          [ -n "${{ inputs.focus }}" ] && args="$args --focus ${{ inputs.focus }}"
          ./nightly-qa/prepare.sh $args >> "$GITHUB_OUTPUT"
        env:
          GH_TOKEN: ${{ github.token }}

      # Before the session, every night. A leak fails here and no session runs.
      - name: Prove the source fence holds
        run: ./nightly-qa/guard.sh
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

      - name: The session
        run: |
          ./nightly-qa/run.sh \
            --persona "$(sed -n 1p nightly-qa/.out/charter)" \
            --focus "$(sed -n 2p nightly-qa/.out/charter)" \
            --max-turns "${{ inputs.max_turns || '200' }}"
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

      # always(): a session that died still leaves a transcript and a server log,
      # and those are the only way to find out why.
      - name: Upload the run
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: nightly-qa-${{ github.run_id }}
          path: nightly-qa/.out/
          include-hidden-files: true
          if-no-files-found: warn
          retention-days: 14

  # Holds no model. This is the only job that writes.
  file:
    needs: explore
    if: always() && needs.explore.result == 'success' && (inputs.file_issues != false)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write   # the orphan evidence branch
      issues: write
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - uses: actions/download-artifact@v4
        with:
          name: nightly-qa-${{ github.run_id }}
          path: nightly-qa/.out/

      - name: File
        run: |
          git config user.name 'nightly-qa'
          git config user.email 'noreply@anthropic.com'
          npx tsx nightly-qa/src/file.ts \
            nightly-qa/.out/findings.json \
            nightly-qa/.out/known-issues.json \
            --apply
        env:
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 2: Validate the workflow parses**

```bash
npx --yes @action-validator/cli@latest .github/workflows/nightly-qa.yml 2>/dev/null \
  || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/nightly-qa.yml')); print('valid YAML')"
```

Expected: valid. Then check the secrets and variables the workflow expects already exist,
since `test-eval` uses two of them:

```bash
gh secret list | grep -E 'GEMINI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN'
gh variable list | grep GEMINI_MODEL
```

Expected: `GEMINI_API_KEY` and `GEMINI_MODEL` are already there. **`CLAUDE_CODE_OAUTH_TOKEN`
will be missing** — generate it with `claude setup-token` and add it with
`gh secret set CLAUDE_CODE_OAUTH_TOKEN`. Stop and do that now; the workflow cannot run
without it.

- [ ] **Step 3: Create the labels the filing rules use**

```bash
for l in nightly-qa bug weird inconvenience possible-duplicate by-design; do
  gh label create "$l" --force >/dev/null 2>&1 || true
done
gh label list | grep -E 'nightly-qa|possible-duplicate|by-design|weird|inconvenience'
```

Expected: all six exist. `gh issue create --label` fails on a label that does not exist, so
a missing one turns into a filing failure at 01:00.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/nightly-qa.yml
git commit -m "feat: run the QA agent nightly, in two jobs

Two jobs because the split is the permission boundary, not a structure choice.
explore holds the model and gets issues:read; file writes and holds no model.
Collapsing them to save a runner minute would give a model with browser access
write access to the tracker.

Deliberately not part of ci.yml: it calls two paid models and takes half an
hour, and its failures are often findings rather than regressions.

The fence guard runs before every session, in CI exactly as locally. A leak
fails the job and no session starts.

claude --version is its own step because an install whose native binary
postinstall was blocked leaves a CLI that cannot start at all - that happened
during part A, and the guard reported the fence holding because no session had
run. The guard now catches it; this catches it earlier with a clearer message.

The artifact uploads on always(): a session that died still leaves the
transcript and the server log, which are the only way to find out why.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Prove it on the branch, by hand, before it runs on its own

**The order matters and is not the obvious one.** `workflow_dispatch` only fires for a
workflow that exists on the **default branch** — confirmed in GitHub's own documentation:
"This event will only trigger a workflow run if the workflow file exists on the default
branch." So a workflow living only on this branch cannot be triggered at all, by button or
by CLI.

The way through, which keeps every real run on this branch: merge a **dispatch-only stub**
to master first. It carries the full `workflow_dispatch` block and no `schedule`, so it can
never fire on its own, and it makes manual triggering possible. From then on, dispatching
against this branch runs **this branch's** version of the file, so all iteration happens
here. The schedule is added in the last commit, once everything below passes.

One detail that bites otherwise: GitHub validates dispatch inputs against the **default
branch's** copy of the workflow. The stub must therefore carry the final `inputs` block
from the start, even though the rest of the file keeps changing on the branch.

**Files:**
- Modify: `apps/mobile/src/app/translate.tsx` (temporarily, then revert)

This is the *Verification before the first night* section of the spec. Nothing here is
optional: the whole point of the workflow is that nobody is watching when it runs.

- [ ] **Step 0: Prove the browser installs and launches, before spending a runner on it**

The cheapest possible check of the most likely CI failure, run locally against a cache that
does not already hold the answer:

```bash
mv ~/Library/Caches/ms-playwright ~/Library/Caches/ms-playwright.bak
node node_modules/@playwright/mcp/node_modules/playwright-core/cli.js install chromium
ls ~/Library/Caches/ms-playwright/
./nightly-qa/guard.sh; echo "exit=$?"
```

Expected: `chromium-1244` appears, and the guard passes — which it can only do by launching
a browser, since its third probe is a navigation. Then restore:

```bash
rm -rf ~/Library/Caches/ms-playwright && mv ~/Library/Caches/ms-playwright.bak ~/Library/Caches/ms-playwright
```

If the guard fails here it would have failed in CI, and it cost three cents to find out.

- [ ] **Step 1: Merge the dispatch-only stub to master**

Create a branch off master carrying **only** `.github/workflows/nightly-qa.yml`, with the
`schedule:` block deleted and everything else — including the whole `inputs:` block —
exactly as Task 7 wrote it. Open a pull request, and say in its description that the
workflow is inert until the schedule is added, so a reviewer is not left wondering.

Merge it. Nothing runs: a workflow with no `schedule` and no `push` trigger fires only when
someone asks it to.

```bash
gh workflow list | grep -i nightly
```

Expected: `Nightly QA` is listed. Until it is, no dispatch below will work.

- [ ] **Step 2: A dispatch against this branch that writes nothing**

```bash
git push
gh workflow run nightly-qa.yml --ref "$(git branch --show-current)" \
  -f persona=careful-adult -f focus=polysemy -f file_issues=false
gh run watch
```

This runs **this branch's** copy of the workflow, not master's stub. Every fix from here on
is a push to this branch followed by another dispatch, and master stays untouched until the
very last step.

Expected: `explore` succeeds, `file` is skipped. Then read the artifact rather than trusting
the green tick:

```bash
gh run download "$(gh run list --workflow=nightly-qa.yml --limit 1 --json databaseId -q '.[0].databaseId')" -D /tmp/qa-run
cat /tmp/qa-run/report.md
npx tsx nightly-qa/src/validate.ts /tmp/qa-run/findings.json
```

Expected: a real report, findings that validate, and `match` present on each one. If `match`
is missing everywhere, the brief's deduplication section is not landing and Task 3 needs
revisiting before anything files.

- [ ] **Step 3: Dry-run the filing against that real run**

```bash
npx tsx nightly-qa/src/file.ts /tmp/qa-run/findings.json /tmp/qa-run/known-issues.json
```

Expected: a plausible set of `would run` lines and a summary. Read every one. This is the
last look before the bot writes to your tracker.

- [ ] **Step 4: Let it file, once, and inspect what it made**

```bash
gh workflow run nightly-qa.yml --ref "$(git branch --show-current)" -f file_issues=true
gh run watch
gh issue list --label nightly-qa
```

Expected: at most three new issues, each labelled `nightly-qa` and a severity, each body
ending in a fingerprint line, each screenshot rendering from the evidence branch. Open one
and check the image actually loads.

- [ ] **Step 5: Prove deduplication works, which needs a second night**

Run it again the same day, with the same charter:

```bash
gh workflow run nightly-qa.yml --ref "$(git branch --show-current)" \
  -f persona=careful-adult -f focus=polysemy -f file_issues=true
gh run watch
gh issue list --label nightly-qa
```

Expected, and this is the test the whole phase is for: **no new issue for a problem already
filed**. The existing issues gain "Seen again" comments instead. If new duplicates appear,
stop and read the run's `findings.json` to see whether the agent set `match.new` on
something it should have matched — that is a brief problem, not a code problem, and the
brief is where to fix it.

- [ ] **Step 6: Prove the fence still fails in CI**

Temporarily add `--add-dir "$REPO"` to `guard.sh` and remove the two `__REPO__` deny rules
from `fence/settings.template.json`, exactly as part A did. Push, dispatch, and confirm the
`explore` job fails at the guard step with the canary message. Then revert both.

A fence that has only ever been proven on a laptop has not been proven where it runs.

- [ ] **Step 7: Prove a planted defect is still caught through the whole pipeline**

In `apps/mobile/src/app/translate.tsx`, change `hidden > 0` to `hidden > 99`. Push,
dispatch with `file_issues=true`, and confirm an issue appears describing meanings that
cannot be reached. Then revert, push, and confirm the next run does not file it again.

```bash
git checkout apps/mobile/src/app/translate.tsx
git status --short apps/mobile
```

- [ ] **Step 8: Record what the first nights showed**

Append a short section to `nightly-qa/POC-RESULTS.md` titled *First nights in CI*: how long
the job took, what it cost, how many issues it filed, how many were duplicates a human had
to merge, and whether the `other` symptom appeared. That last one decides whether the
controlled vocabulary needs another term.

- [ ] **Step 9: Turn the schedule on, and only now**

Everything above ran by hand, on this branch, against a master that could not fire anything.
Add the `schedule:` block back to `.github/workflows/nightly-qa.yml`, and merge this branch.
That commit is the first moment the agent can run without someone asking it to.

```bash
grep -A2 '^on:' .github/workflows/nightly-qa.yml
gh workflow view nightly-qa.yml
```

Expected: the schedule is present, and the workflow shows both triggers — scheduled, and
manual. Nothing else changes: the dispatch inputs are the same ones the stub carried, so a
hand-run night stays available afterwards for re-testing a fix.

- [ ] **Step 10: Commit**

```bash
git add nightly-qa/POC-RESULTS.md .github/workflows/nightly-qa.yml
git commit -m "test: verify the nightly pipeline by hand, then let it run on its own

Every run below happened on this branch, triggered by hand, against a master
that carried a workflow with no schedule and so could fire nothing on its own.
That inversion is forced: workflow_dispatch only works for a workflow already on
the default branch, so a dispatch-only stub goes first and the schedule goes
last.

The checks in the order that makes each one meaningful. The browser install
proven locally against a cleared cache, because it is the likeliest CI failure
and costs three cents to rule out. A dispatch that writes nothing. A filing dry
run read line by line. One real filing run inspected issue by issue. Then the
one the whole phase exists for: a second run on the same charter the same day,
which must comment rather than file again.

Then the two that prove the checks can fail. The fence is breached in CI, not
just on a laptop, and the dictionary's reveal button is suppressed again to
confirm a real defect still travels the whole pipeline into a real issue.

Records what the first nights cost and whether the symptom vocabulary needed a
term it did not have.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Reconcile the spec with what was built

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-lang-tutor-phase-14-nightly-qa-design.md`

- [ ] **Step 1: Correct the possible-duplicate trigger**

The spec's *How matching actually has to work* says the flag fires on a `screen | element`
collision. Task 4 fires it on a full three-segment fingerprint match, because the same
section's controlled vocabulary made the weaker trigger fire on almost everything. Rewrite
that paragraph to say what was built, and keep the reason: the `screen | element`
neighbours are still surfaced, in the job summary, where they inform a human without
labelling an issue.

- [ ] **Step 2: Correct the charter paths**

The spec says `nightly-qa/charters/personas/*.md` and `charters/focus/*.md`, which is what
Task 1 built, but the *Repository layout* section still shows `brief/persona-*.md`. Make
them agree.

- [ ] **Step 3: Record the permission the evidence branch costs**

The spec's architecture diagram gives the `file` job `issues: write`. It also needs
`contents: write` to push the evidence branch. Say so, and say why that is acceptable: the
job holds no model, so nothing with browser access can reach that permission.

- [ ] **Step 4: Mark part B done**

Update the **Status** line and the *Delivery in two phases* section. Link the first-nights
section of `POC-RESULTS.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-15-lang-tutor-phase-14-nightly-qa-design.md
git commit -m "docs: reconcile the design with the nightly pipeline as built

Three corrections. The possible-duplicate flag fires on a full fingerprint
match rather than a screen-and-element collision, because the controlled
vocabulary this same section introduced made the weaker trigger fire on nearly
every dictionary finding; the weak neighbours still reach a human through the
job summary. The charter paths in the layout section had not followed the move
out of brief/. And the file job needs contents:write for the evidence branch,
which is acceptable precisely because that job holds no model.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verification checklist

| Claim | How it was shown |
|---|---|
| All 28 charters assemble and leak nothing | Task 1 Step 6 |
| A bad charter name fails rather than falling back | Task 1 Step 6 |
| The rotation covers 28 pairings before repeating | Task 2 Step 6 |
| A tracker that cannot be read does not cancel the night | Task 2 Step 7 |
| A truncated session files nothing | Task 4 test, Task 5 Step 4 |
| An invented issue number files nothing | Task 4 test |
| Severity rises but never falls | Task 4 tests |
| A by-design issue is not argued with nightly | Task 4 test |
| **Two problems sharing a screen and element are not merged** | Task 4 Step 5, proven by making it fail |
| The cap holds and prefers bugs | Task 4 test |
| Nothing is written without `--apply` | Task 5 Step 3 |
| Screenshots outlive the artifact | Task 6 Step 3, Task 8 Step 3 |
| The MCP browser installs and launches from a cold cache | Task 8 Step 0 |
| The fence fails the job in CI, not only locally | Task 8 Step 6 |
| A second run on the same charter files no duplicate | Task 8 Step 5 |
| A real defect reaches a real issue | Task 8 Step 7 |
| Nothing runs unattended until every check above passed | Task 8 Step 9 is the first commit with a schedule |

## Out of scope

No verifier session, no embeddings, no auto-closing of stale bot issues, no Slack or email,
no pull-request trigger, and the bot never opens a pull request. The verifier stage stays
deferred until findings a human closes as "cannot reproduce" reach roughly one run in three;
`steps` is already in the contract so it can be added without a schema change.
