#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0014-sessions-belong-to-a-path.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. A match is a VIOLATION, so nothing here relies on
# grep's exit status, and `set -e` is deliberately absent.
#
# R1 reads db/schema.ts alone and fails when a declaration is missing. R2 scans
# every .ts file under apps/server/src; db/migrations/ is .sql and .json, so the
# history that drops the old indexes is out of the scan by the --include.

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

r1() { { [ "$(grep -cE "uniqueIndex\('sessions_one_(stock|started)_per_path'\)" apps/server/src/db/schema.ts)" = 2 ] || echo "apps/server/src/db/schema.ts: the per-path open-session indexes are not both declared"; [ "$(grep -cF ".on(t.enrollmentId, sql\`coalesce(\${t.targetId}, '00000000-0000-0000-0000-000000000000'::uuid)\`)" apps/server/src/db/schema.ts)" = 2 ] || echo "apps/server/src/db/schema.ts: the open-session indexes are not on the path"; }; }

r2() { grep -rnE --include='*.ts' 'sessions_one_(stock|started)_per_enrollment|next-session:\$\{enrollmentId\}`' apps/server/src; }

echo "Checking apps/server/src against ADR 0014 (sessions belong to a path)"
echo

check "R1  one stock and one started session per path, held by the indexes"  r1
check "R2  no per-enrollment open session, no lock without its path"         r2

echo
if [ "$status" -ne 0 ]; then
  echo "Sessions-per-path check FAILED. See docs/adr/adr-0014-sessions-belong-to-a-path.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Sessions-per-path check passed: 2 rules, no violations."
fi

exit "$status"
