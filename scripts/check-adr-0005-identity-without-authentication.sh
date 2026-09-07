#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0005-identity-without-authentication.md.
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
  grep -rniE "bcrypt|argon2|jsonwebtoken|password_hash|passwordHash|expo-secure-store" \
    apps/server/src packages/core/src apps/mobile/src \
    --include='*.ts' --include='*.tsx'
}

# tests/support/seedUser.ts is the test composition root and inserts users on
# purpose; scanning apps/server/src only is what keeps it out of scope.
r2() { grep -rn "insert(users)" apps/server/src --include='*.ts' | grep -v 'repo/users.ts'; }

r3() {
  grep -nE '"(bcrypt|bcryptjs|argon2|jsonwebtoken|jose|passport|expo-secure-store|firebase)"' \
    package.json apps/*/package.json packages/*/package.json e2e/package.json
}

echo "Checking the repo against ADR 0005 (identity without authentication)"
echo

check "R1  no credential primitive in any src tree"        r1
check "R2  users are inserted only in repo/users.ts"       r2
check "R3  no authentication dependency in a package.json" r3

echo
if [ "$status" -ne 0 ]; then
  echo "Identity check FAILED. See docs/adr/adr-0005-identity-without-authentication.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Identity check passed: 3 rules, no violations."
fi

exit "$status"
