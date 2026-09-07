# Idea: back the ADR checks with semgrep instead of grep

Status: draft / not decided. No ADR, no spec yet.

## The idea

Keep everything about the current ADR infra — one ADR paired with one
`scripts/check-adr-NNNN-*.sh`, glob discovery in `check-adrs.sh`, the Stop hook, the
CI job — and swap only the matching engine inside the rule bodies from `grep -rnE`
to semgrep (or ast-grep) rules.

## Why

1. **A broken rule currently reports `ok`.** The `check()` helper treats "no output"
   as passing, so a rule whose import path stopped matching after a refactor silently
   becomes a no-op and still prints `ok`. There is no way to tell a rule that found
   nothing from a rule that can no longer find anything. Semgrep fails loudly when a
   rule file does not parse or a pattern is invalid.

2. **Regex over import statements is guessing at syntax.** ADR 0001's inward
   dependency rule and ADR 0002's "no concrete construction outside a composition
   root" are structural claims about the AST — `new Pool`, `Math.random`,
   module-level state. Regex approximates these; a type-aware matcher states them.

3. **Per-rule messages become fix instructions.** Both engines attach a `message` to
   each rule. Today a violation prints the rule name and the matching lines, so the
   agent has to go read the ADR to learn what to do instead. A message like
   "move this DB access into `repo/`; `services/` may not import `drizzle-orm`"
   lets the agent self-correct without the round trip.

## Sketch

```
docs/adr/adr-0001-layered-architecture.md      unchanged: prose + numbered R-rules
scripts/adr-0001.semgrep.yml                   the R-rules as semgrep rules, id: R1, R2, ...
scripts/check-adr-0001-layered-architecture.sh thin: semgrep --config that file
```

`check-adrs.sh` needs no change — the script name is still the wiring.

## Open questions

- **The ADR/script sync convention breaks.** Today the "How to detect a violation"
  section holds the exact shell command the script runs, verbatim, so the two can be
  diffed by eye. A semgrep YAML rule is not a shell one-liner. Does the ADR embed the
  YAML instead, or just the `semgrep --config` invocation plus a rule id per R-rule?
- **Zero-install property.** The current checks run with nothing but bash and grep,
  which matters for Stop hook latency on every turn. ast-grep is a single Rust binary
  and much faster to start than semgrep (OCaml, larger ruleset machinery). If we go
  this way, ast-grep is probably the right pick for the hook path.
- **Migrate all four ADRs or one?** ADR 0004's test-topology rules are genuinely
  path-and-import shaped and may be fine as grep forever. The structural wins are
  concentrated in 0001 and 0002.
- Do we keep a test-the-rules fixture (a file that must fail, a legal neighbor that
  must pass) per rule? That closes the no-op gap even without switching engines, and
  might be the cheaper first move.

## Prior art

`archgate/cli` pairs each ADR with a `.rules.ts` of executable checks — same shape as
ours, TS instead of bash. `GLips/enforced-architecture` is where the
error-message-as-fix-instruction idea comes from. Neither is widely adopted; semgrep
(16.5k) and ast-grep (15.8k) are the popular, maintained engines underneath.
