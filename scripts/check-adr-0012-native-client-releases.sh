#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0012-native-client-releases.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. Any output is a VIOLATION, so nothing here
# relies on grep's exit status, and `set -e` is deliberately absent.
#
# R3 excludes packages/core/src/apiLevel.ts, the one place the header is named,
# and test files, which send and assert it by name on purpose.

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

r1() { grep -L '"policy": "fingerprint"' apps/mobile/app.json; }

r2() { awk '/^  android:$/ { f = 1; next } f && /^  [a-z-]+:$/ { exit } f' .github/workflows/release.yml | grep -q '^    needs: apply$' || echo '.github/workflows/release.yml: job android does not need apply'; }

r3() { grep -rni "x-api-level" apps/server/src apps/mobile/src packages/core/src --include='*.ts' --include='*.tsx' | grep -v -e '^packages/core/src/apiLevel\.ts:' -e '\.test\.ts:'; }

r4() { grep -L '"track": "internal"' apps/mobile/eas.json; }

echo "Checking the Android release against ADR 0012 (native client releases)"
echo

check "R1  the runtime version is the fingerprint"            r1
check "R2  the android release job needs apply"                r2
check "R3  X-Api-Level is written only in core's apiLevel.ts"  r3
check "R4  Play submissions go to the internal track"          r4

echo
if [ "$status" -ne 0 ]; then
  echo "Native client release check FAILED. See docs/adr/adr-0012-native-client-releases.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Native client release check passed: 4 rules, no violations."
fi
exit "$status"
