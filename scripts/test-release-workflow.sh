#!/usr/bin/env bash
#
# Pins two facts about .github/workflows/release.yml (phase 30) that a reader of
# the YAML could undo without noticing:
#
#   - the image is built from the tag, so build-push checks out the default ref;
#   - Terraform is applied from master, so the apply job checks out master. A
#     rollback runs this workflow FROM an old tag; applying that tag's terraform/
#     would undo every infrastructure change merged since (the domain binding
#     first of all) and take the site down. The guard already requires the tag
#     to be on master, so master's terraform/ is never older than the tag's.
#   - (phase 32) the Android app ships after apply, whose last step waits for
#     /health to name the tag, and from the tag's own checkout; a dispatch,
#     which is a rollback, passes --rollback so it can never build;
#   - the job reads the ANDROID_RELEASE repository variable; without it the
#     script would skip every release, green, and nobody would notice.

set -u

cd "$(dirname "$0")/.." || exit 1

status=0
checks=0

job() { # job <name>: the lines of one job, up to the next job or the end
  awk -v name="  $1:" '
    $0 == name { inside = 1; next }
    inside && /^  [a-z][a-z-]*:$/ { exit }
    inside { print }
  ' .github/workflows/release.yml
}

expect() { # expect <label> <0|1 = grep must match|must not match> <job> <pattern>
  local label="$1" want="$2" name="$3" pattern="$4" found=1
  checks=$((checks + 1))
  job "$name" | grep -qE "$pattern" && found=0
  if [ "$found" = "$want" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s\n' "$label" >&2
    status=1
  fi
}

echo "Testing .github/workflows/release.yml"
echo

expect "the apply job checks out master" 0 apply '^[[:space:]]+ref: master$'
expect "the apply job runs scripts/infra.sh" 0 apply 'scripts/infra.sh prod apply'
expect "build-push builds the tag, not master" 1 build-push 'ref:'
expect "android runs after apply" 0 android '^[[:space:]]+needs: apply$'
expect "android ships the tag, not master" 1 android 'ref:'
expect "android passes --rollback on a dispatch" 0 android "workflow_dispatch' && '--rollback'"
expect "android hands the job the ANDROID_RELEASE variable" 0 android 'ANDROID_RELEASE: \$\{\{ vars\.ANDROID_RELEASE \}\}'
expect "android runs native-release.sh for android" 0 android 'scripts/native-release\.sh android '

echo
if [ "$status" -ne 0 ]; then
  echo "release.yml FAILED ($checks checks)" >&2
else
  echo "release.yml ok ($checks checks)"
fi
exit "$status"
