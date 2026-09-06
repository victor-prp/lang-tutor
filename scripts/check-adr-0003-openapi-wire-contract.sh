#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0003-openapi-wire-contract.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. The two must stay in sync: the ADR is the
# explanation, this file is the enforcement, and a rule that lives in only one
# of them is a rule nobody is keeping.
#
# grep's exit codes run backwards from what this needs — a match means a
# VIOLATION, and finding nothing (exit 1) is the passing case — so nothing here
# relies on exit status, and `set -e` is deliberately absent. Each command is a
# function rather than a string passed to eval, so the ADR's quoting can be
# copied across unchanged.

set -u

cd "$(dirname "$0")/.." || exit 1

status=0

check() {
  rule="$1"
  fn="$2"
  output=$("$fn" 2>/dev/null)
  if [ -n "$output" ]; then
    printf '\n  VIOLATION  %s\n' "$rule" >&2
    printf '%s\n' "$output" | sed 's/^/             /' >&2
    status=1
  else
    printf '  ok         %s\n' "$rule"
  fi
}

r1() {
  grep -rnE "\.(get|post|put|patch|delete)\(" apps/server/src/routes/ apps/server/src/app.ts \
    | grep -v "app.get('/docs'"
}

r2() { find apps/server/src/routes -iname 'schemas.ts'; }

r3() { grep -nE "^export type" packages/core/src/api/types.ts | grep -v "z\.infer"; }

r4() { grep -n "^export " packages/core/src/api/index.ts | grep -v "export type"; }

r5() { grep -rln "@hono\|from 'hono'" packages/core/src; }

r6() { grep -n "'/doc'" apps/server/src/app.ts; }

echo "Checking apps/server and packages/core against ADR 0003 (OpenAPI wire contract)"
echo

check "R1  every route uses createRoute + .openapi()"      r1
check "R2  no route-local schema file"                      r2
check "R3  every core/api type is a z.infer"                r3
check "R4  core/api/index.ts exports types only"            r4
check "R5  packages/core has no Hono dependency"            r5
check "R6  doc routes are /openapi.json and /docs, not /doc" r6

echo
if [ "$status" -ne 0 ]; then
  echo "OpenAPI contract check FAILED. See docs/adr/adr-0003-openapi-wire-contract.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "OpenAPI contract check passed: 6 rules, no violations."
fi

exit "$status"
