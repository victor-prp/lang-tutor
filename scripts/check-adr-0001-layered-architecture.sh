#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0001-layered-architecture.md.
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

r1() { grep -rnE "from '\.\./(db|repo)/|from 'drizzle-orm|from 'pg'" apps/server/src/routes/; }

r2_transport() { grep -rnE "from '(hono|@hono)/|from 'hono'|from 'drizzle-orm|from 'pg'" apps/server/src/services/; }
r2_db()        { grep -rn "from '\.\./db/" apps/server/src/services/; }
r2_repo_types() { grep -rn "from '\.\./repo/" apps/server/src/services/ | grep -v 'import type'; }

r3_imports() { grep -rnE "from '\.\./|from '(pg|drizzle-orm|hono)" apps/server/src/domain/; }
r3_impure()  { grep -rn "Math.random\|Date.now\|new Date()" apps/server/src/domain/; }

r4() { grep -rnE "from '\.\./(routes|services)/|from '\.\./(app|composition)'" apps/server/src/repo/ apps/server/src/db/; }

r5() { grep -nE "from './(db|repo)/|drizzle|from 'pg'" apps/server/src/app.ts | grep -vE '^[0-9]+:[[:space:]]*(//|\*)'; }

r6() { grep -nE "createDb|new Pool|await " apps/server/src/composition.ts | grep -vE '^[0-9]+:[[:space:]]*(//|\*)'; }

r7() {
  grep -rn "console\." apps/server/src --include='*.ts' \
    | grep -v -e '/logger.ts' -e '/index.ts' -e '/db/cli.ts' -e '\.test\.ts'
}

r8() {
  grep -rn "\.transaction(" apps/server/src --include='*.ts' \
    | grep -v -e '/db/transaction.ts' -e '\.test\.ts'
}

r10() { grep -rnE "from '\.\./(routes|services|domain|repo|db)/|from '\.\./(app|composition)'" apps/server/src/providers/; }

# --exclude-dir, never `grep -v '/providers/'`: a content filter matches every
# violation's own import path and deletes exactly the lines this is hunting,
# which is how an earlier draft of this check shipped unable to report anything.
# The -v below is anchored to the path with ^[^:]* for the same reason.
# `require(`/`import(` are matched so a dynamic import cannot launder the
# dependency, and apps/server/tests is scanned so an integration test cannot
# construct a provider directly and still call itself black-box. tests/support/
# and tests/eval/ are the two test composition roots and are exempt.
r11() {
  grep -rnE "(from|require\(|import\()[[:space:]]*'[^']*providers/" \
    apps/server/src apps/server/tests --include='*.ts' --exclude-dir=providers \
    | grep -vE "^[^:]*(composition\.ts|tests/support/|tests/eval/)"
}

# The same rules over apps/server/tests/integration. Unit tests live inside the
# directories scanned above and are already covered; the integration tree was
# not, which is what made "R1-R6 apply to test files too" untrue for two years'
# worth of nothing checking it.
#
# tests/support/ is deliberately unscanned: it is the test composition root, and
# may reach anywhere exactly as composition.ts may. A layer test that needs the
# graph assembled calls createServerDeps rather than wiring repositories itself
# — reaching past composition is precisely what these rules forbid of the layer
# under test.
r1_tests() { grep -rnE "from '.*src/(db|repo)/|from 'drizzle-orm|from 'pg'" apps/server/tests/integration/routes/; }

r2_tests() {
  grep -rnE "from '(hono|@hono)/|from 'hono'|from 'drizzle-orm|from 'pg'|from '.*src/db/" \
    apps/server/tests/integration/services/
}
r2_tests_repo() { grep -rn "from '.*src/repo/" apps/server/tests/integration/services/ | grep -v 'import type'; }

r4_tests() {
  grep -rnE "from '.*src/(routes|services)/|from '.*src/(app|composition)'" \
    apps/server/tests/integration/repo/ apps/server/tests/integration/db/
}

echo "Checking apps/server against ADR 0001 (layered architecture)"
echo

check "R1  routes must not touch persistence"                      r1
check "R2  services must not touch transport"                      r2_transport
check "R2  services must not hold a database handle at all"        r2_db
check "R2  services may reference repo modules only as types"      r2_repo_types
check "R3  domain must not import across layers"                   r3_imports
check "R3  domain must be free of ambient time and randomness"     r3_impure
check "R4  persistence must not reach upward"                      r4
check "R5  app.ts wires, it does not know a database exists"       r5
check "R6  composition performs no I/O"                            r6
check "R7  console outside the logger"                             r7
check "R8  the transaction primitive has exactly one call site"    r8
check "R10 providers must not reach upward"                        r10
check "R11 providers are constructed only at the composition root" r11
check "R1  route tests must not reach past composition"            r1_tests
check "R2  service tests must not touch transport or a database"   r2_tests
check "R2  service tests may reference repo modules only as types" r2_tests_repo
check "R4  persistence tests must not reach upward"                r4_tests

echo
if [ "$status" -ne 0 ]; then
  echo "Architecture check FAILED. See docs/adr/adr-0001-layered-architecture.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Architecture check passed: 17 rules, no violations."
fi

exit "$status"
