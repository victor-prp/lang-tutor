#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0002-di-with-closures.md.
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

r1_rng()   { grep -rn "Math\.random" apps/server/src --include='*.ts' | grep -v -e '/index\.ts:' -e '\.test\.ts:'; }
r1_mobile() {
  grep -rln "from '@react-native-async-storage/async-storage'\|from 'expo-crypto'" apps/mobile/src --include='*.ts' --include='*.tsx' \
    | grep -v '_layout\.tsx'
}

r2() {
  grep -rn "process\.env" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
    | grep -vE ':[0-9]+:[[:space:]]*(//|\*)' \
    | grep -v -e '/index\.ts:' -e '/db/cli\.ts:' -e '_layout\.tsx:'
}

r3() {
  grep -rnE "^export const [a-zA-Z_]+ = (create[A-Z]|new [A-Z])" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
    | grep -v '\.test\.ts:'
}

r4() { grep -rn "jest\.mock(" apps/server apps/mobile --include='*.ts' --include='*.tsx'; }

r5_optional() {
  grep -rnE "\b(rng|onError|randomUUID|logger|storage|fetch)\?\s*:" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
    | grep -v '\.test\.ts:'
}
r5_defaulted() {
  grep -rnE "(rng|onError|randomUUID|logger|storage|fetch)\s*=\s*[^,}]+[,}]" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
    | grep -v '\.test\.ts:' | grep -vE ':[0-9]+:[[:space:]]*(//|\*)'
}

echo "Checking apps/server and apps/mobile against ADR 0002 (DI via closures)"
echo

check "R1  Math.random named only at a composition root"           r1_rng
check "R1  AsyncStorage/expo-crypto imported only at _layout.tsx"   r1_mobile
check "R2  process.env read only at a composition root"            r2
check "R3  no module-level exported singleton"                     r3
check "R4  no jest.mock"                                            r4
check "R5  no optional collaborator parameter"                     r5_optional
check "R5  no defaulted collaborator parameter"                    r5_defaulted

echo
if [ "$status" -ne 0 ]; then
  echo "DI check FAILED. See docs/adr/adr-0002-di-with-closures.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "DI check passed: 7 rules, no violations."
fi

exit "$status"
