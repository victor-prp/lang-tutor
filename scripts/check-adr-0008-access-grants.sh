#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0008-access-grants.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. A match is a VIOLATION, so nothing here relies on
# grep's exit status, and `set -e` is deliberately absent.

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

# Exceptions the ADR names: repo/grants.ts owns the table and db/schema.ts
# declares it.
r1() {
  grep -rnE "enrollment_grants|enrollmentGrants" apps/server/src --include='*.ts' \
    | grep -vE '^apps/server/src/(repo/grants|db/schema)\.ts:'
}

# Exceptions: each app's one header site. Test files are excluded by the command.
r2() {
  grep -rniE "x-acting-user-id" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
    --exclude='*.test.ts' --exclude='*.test.tsx' \
    | grep -vE '^apps/server/src/routes/actor\.ts:|^apps/mobile/src/api/client\.ts:'
}

# Exceptions: the role map and the schema's role enum. Test files are excluded.
r3() {
  grep -rn "'tutor'" apps/server/src --include='*.ts' --exclude='*.test.ts' \
    | grep -vE '^apps/server/src/(domain/access|db/schema)\.ts:'
}

echo "Checking the repo against ADR 0008 (access grants)"
echo

check "R1  enrollment_grants is read and written only by repo/grants.ts" r1
check "R2  the actor header is named once per app"                       r2
check "R3  roles are named once"                                         r3

echo
if [ "$status" -ne 0 ]; then
  echo "Access-grants check FAILED. See docs/adr/adr-0008-access-grants.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Access-grants check passed: 3 rules, no violations."
fi

exit "$status"
