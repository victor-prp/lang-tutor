#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0010-single-container-migrations.md.
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

r1() { { grep -qE '^[[:space:]]*scale[[:space:]]*=[[:space:]]*1[[:space:]]*(#.*)?$' infra/prod/main.tf || echo "infra/prod/main.tf: no scale = 1"; grep -nE '^[[:space:]]*scale[[:space:]]*=' infra/prod/*.tf | grep -vE 'scale[[:space:]]*=[[:space:]]*1[[:space:]]*(#.*)?$'; }; }

r2() { { grep -qF 'CMD ["sh", "-c", "node dist/cli.js && exec node dist/index.js"]' Dockerfile || echo "Dockerfile: no migrate-then-serve CMD"; grep -nE '^(CMD|ENTRYPOINT)' Dockerfile | grep -vF 'node dist/cli.js && exec node dist/index.js'; }; }

r3() { grep -nE '^[[:space:]]*command[[:space:]]*=' infra/prod/*.tf; }

echo "Checking the image and infra/prod against ADR 0010 (single-container migrations)"
echo

check "R1  production runs exactly one container"            r1
check "R2  the image migrates before it serves"              r2
check "R3  nothing overrides the image's start command"      r3

echo
if [ "$status" -ne 0 ]; then
  echo "Single-container check FAILED. See docs/adr/adr-0010-single-container-migrations.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Single-container check passed: 3 rules, no violations."
fi

exit "$status"
