#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0009-sign-in.md.
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

# Exceptions the ADR names: one better-auth import per app.
r1() {
  grep -rnE "(from|import|require)[[:space:]]*\(?[[:space:]]*'(better-auth|@better-auth/[a-z-]+)(/[^']*)?'" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' \
    | grep -vE '^apps/server/src/auth/betterAuth\.ts:|^apps/mobile/src/auth/client\.ts:'
}

# Exceptions: the schema declares the tables, betterAuth.ts hands them to the
# adapter, repo/auth.ts owns the send log and the claim.
r2() {
  grep -rnE "auth_(users|sessions|accounts|verifications|code_sends)\b|auth(Users|Sessions|Accounts|Verifications|CodeSends)\b" apps/server/src --include='*.ts' \
    | grep -vE '^apps/server/src/(db/schema|auth/betterAuth|repo/auth)\.ts:'
}

# Exception: routes/actor.ts. Test files are excluded by the commands.
r3() {
  grep -rn "sessionOf(" apps/server/src/routes apps/server/src/services --include='*.ts' --exclude='*.test.ts' \
    | grep -v '^apps/server/src/routes/actor\.ts:'
  grep -rniE "x-acting-user-id" apps/server/src apps/mobile/src --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx'
}

r4() {
  grep -nE '"(better-auth|@better-auth/expo)": "[\^~]' package.json apps/*/package.json packages/*/package.json e2e/package.json
}

r5() {
  grep -nE '"(passport[a-z-]*|jose|jsonwebtoken|bcrypt|bcryptjs|argon2|@clerk/[a-z-]+|@supabase/[a-z-]+|firebase|aws-amplify|supertokens[a-z-]*|next-auth|@auth/[a-z-]+|lucia)"' \
    package.json apps/*/package.json packages/*/package.json e2e/package.json
}

r6() {
  grep -rn "insert(users)" apps/server/src --include='*.ts' | grep -v 'repo/users.ts'
}

echo "Checking the repo against ADR 0009 (sign-in)"
echo

check "R1  better-auth is imported in one file per app"                    r1
check "R2  the auth tables are named in three server files"                r2
check "R3  the session becomes an actor in one place; no asserted header"  r3
check "R4  better-auth and @better-auth/expo are pinned exactly"           r4
check "R5  no other authentication dependency"                             r5
check "R6  profiles are inserted in one place"                             r6

echo
if [ "$status" -ne 0 ]; then
  echo "Sign-in check FAILED. See docs/adr/adr-0009-sign-in.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Sign-in check passed: 6 rules, no violations."
fi

exit "$status"
