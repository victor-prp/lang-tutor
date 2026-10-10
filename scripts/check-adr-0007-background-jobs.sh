#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0007-background-jobs.md.
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

# The five allow-listed files are the exceptions the ADR names: the two entry
# points, the composition root, db/jobs.ts (its two short-lived instances: the
# schema installer and withJobQueue, which db/lemmaRenders.ts calls for the CLI)
# and the enqueue seam.
r1_import() {
  grep -rnE "from 'pg-boss'" apps/server/src --include='*.ts' \
    | grep -vE '^apps/server/src/(index|composition|worker)\.ts:|^apps/server/src/(db|repo)/jobs\.ts:'
}

r1_construct() {
  grep -rn "new PgBoss" apps/server/src --include='*.ts' \
    | grep -vE '^apps/server/src/index\.ts:|^apps/server/src/db/jobs\.ts:'
}

r2() {
  grep -rnE "boss\??\.(send|insert|sendAfter|sendThrottled|sendDebounced|flow)\(" apps/server/src --include='*.ts' \
    | grep -v '^apps/server/src/repo/jobs\.ts:'
}

r3() {
  grep -rnE "\.work\(" apps/server/src --include='*.ts' \
    | grep -v '^apps/server/src/worker\.ts:'
}

echo "Checking the repo against ADR 0007 (background jobs)"
echo

check "R1  pg-boss is imported only by the five files that own it" r1_import
check "R1  new PgBoss only in index.ts and db/jobs.ts"             r1_construct
check "R2  jobs are enqueued only through repo/jobs.ts"            r2
check "R3  handlers are registered only in worker.ts"              r3

echo
if [ "$status" -ne 0 ]; then
  echo "Background-jobs check FAILED. See docs/adr/adr-0007-background-jobs.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Background-jobs check passed: 4 rules, no violations."
fi

exit "$status"
