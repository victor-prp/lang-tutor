#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0004-test-topology.md.
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

r1() { grep -rnE "from 'pg'|from 'drizzle-orm" apps/server/src --include='*.test.ts'; }

r2() { grep -rnE "from '[^']*db/(client|migrate|seed|cli)'" apps/server/src --include='*.test.ts'; }

r3() {
  grep -rnE "from '[^']*tests/support/" apps/server/src --include='*.test.ts' \
    | grep -vE "tests/support/(fakes|testRng)'"
}

r4() { find apps/server/tests -name '*.test.ts' | grep -v '^apps/server/tests/integration/'; }

r5() {
  awk '/displayName: .unit./,/^    \},/' apps/server/jest.config.js \
    | grep -vE '^\s*(//|\*)' | grep -n "globalSetup"
}

# The eval bucket is kept out of both Jest projects by naming alone: nothing
# under tests/eval/ is a *.test.ts. These two guard that from either direction —
# a project that started matching on "eval", and src/ reaching into the bucket.
r4_jest() { grep -n 'eval' apps/server/jest.config.js; }

r4_src() { grep -rn 'tests/eval' apps/server/src --include='*.ts'; }

echo "Checking apps/server against ADR 0004 (test topology)"
echo

check "R1  unit tests must not import pg or drizzle-orm"              r1
check "R2  unit tests must not import a connecting src/db/ module"    r2
check "R3  unit tests may take only fakes.ts/testRng.ts from support" r3
check "R4  no *.test.ts under tests/ outside tests/integration/"      r4
check "R5  the unit Jest project declares no globalSetup"             r5
check "R4  no Jest project picks up an eval file"                     r4_jest
check "R4  nothing under tests/eval/ is imported by src/"             r4_src

echo
if [ "$status" -ne 0 ]; then
  echo "Test topology check FAILED. See docs/adr/adr-0004-test-topology.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Test topology check passed: 7 rules, no violations."
fi

exit "$status"
