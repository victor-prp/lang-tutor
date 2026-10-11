#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0013-learner-day.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. Any output is a VIOLATION, so nothing here relies
# on grep's exit status, and `set -e` is deliberately absent.

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

# R1 — only services/learnerDay.ts computes a progress day.
# The exclusion is the file the rule names.
r1() { grep -rnE --include='*.ts' --exclude='*.test.ts' "AT TIME ZONE 'UTC'\)::date|\.toISOString\(\)\.slice\(0, ?10\)" apps/server/src | grep -v -e '^apps/server/src/services/learnerDay.ts:'; }

# R2 — bot_day is read or written only in repo/users.ts.
# schema.ts must declare the column, and migrations are history.
r2() { grep -rnE --include='*.ts' --exclude='*.test.ts' 'bot_day|botDay' apps/server/src | grep -v -e '^apps/server/src/repo/users.ts:' -e '^apps/server/src/db/schema.ts:' -e '^apps/server/src/db/migrations/'; }

# R3 — routes/bots.ts is the only route file that names the bot kind or its secret.
# The exclusion is the file the rule names.
r3() { grep -rnE --include='*.ts' --exclude='*.test.ts' "kind = 'bot'|BOT_SECRET" apps/server/src/routes | grep -v -e '^apps/server/src/routes/bots.ts:'; }

echo "Checking the repo against ADR 0013 (a learner's day comes from one place)"
echo

check "R1  only services/learnerDay.ts computes a progress day"                          r1
check "R2  bot_day is read or written only in repo/users.ts"                             r2
check "R3  routes/bots.ts is the only route file naming kind = 'bot' or BOT_SECRET"      r3

echo
if [ "$status" -ne 0 ]; then
  echo "Learner-day check FAILED. See docs/adr/adr-0013-learner-day.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Learner-day check passed: 3 rules, no violations."
fi

exit "$status"
