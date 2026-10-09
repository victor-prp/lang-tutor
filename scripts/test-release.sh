#!/usr/bin/env bash
#
# Tests scripts/release.sh against a throwaway bare origin and a clone of it,
# with a stub gh that records what it was asked to dispatch. No network and no
# dependencies, so it runs in CI's setup-free check-adrs job.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

ok() { checks=$((checks + 1)); printf '  ok         %s\n' "$1"; }
fail() { checks=$((checks + 1)); printf '\n  FAIL       %s\n%s\n' "$1" "$2" >&2; status=1; }

# --- the fixture -------------------------------------------------------------
ORIGIN="$FIXTURE/origin.git"
WORK="$FIXTURE/work"
OTHER="$FIXTURE/other"
STUB="$FIXTURE/bin"
GH_LOG="$FIXTURE/gh.log"

git init -q --bare -b master "$ORIGIN"
git clone -q "$ORIGIN" "$WORK" 2> /dev/null
git -C "$WORK" checkout -q -b master
for c in "$WORK"; do
  git -C "$c" config user.email t@t
  git -C "$c" config user.name t
done
commit() { git -C "$1" commit -q --allow-empty -m "$2"; }
commit "$WORK" init
git -C "$WORK" push -q origin master
git clone -q "$ORIGIN" "$OTHER"
git -C "$OTHER" config user.email t@t
git -C "$OTHER" config user.name t

mkdir -p "$STUB"
cat > "$STUB/gh" << EOF
#!/usr/bin/env bash
echo "\$*" >> "$GH_LOG"
EOF
chmod +x "$STUB/gh"

run() { # run <date> <args...>: release.sh in the clone; sets $out and $code
  local day="$1"; shift
  out=$(cd "$WORK" && PATH="$STUB:$PATH" RELEASE_DATE="$day" bash "$REPO/scripts/release.sh" "$@" 2>&1)
  code=$?
}

remote_tag() { git ls-remote --tags "$ORIGIN" "$1" | awk '{ print $1 }'; }

expect_release() { # expect_release <label> <date> <tag>
  local label="$1" day="$2" tag="$3"
  run "$day"
  if [ "$code" = 0 ] && [ "$(remote_tag "$tag")" = "$(git -C "$WORK" rev-parse HEAD)" ]; then
    ok "$label"
  else
    fail "$label" "             expected origin to have $tag on HEAD; exit $code, said: $out"
  fi
}

expect_refused() { # expect_refused <label> <needle> <date> <args...>
  local label="$1" needle="$2" day="$3"; shift 3
  local before; before=$(git ls-remote --tags "$ORIGIN" | wc -l)
  : > "$GH_LOG"
  run "$day" "$@"
  if [ "$code" != 0 ] && printf '%s' "$out" | grep -qF -- "$needle" &&
     [ "$(git ls-remote --tags "$ORIGIN" | wc -l)" = "$before" ] && [ ! -s "$GH_LOG" ]; then
    ok "$label"
  else
    fail "$label" "             expected a refusal saying '$needle' that pushes and dispatches nothing; exit $code, said: $out"
  fi
}

expect_dispatched() { # expect_dispatched <label> <tag> <args...>
  local label="$1" tag="$2"; shift 2
  : > "$GH_LOG"
  run 2026.10.09 "$@"
  if [ "$code" = 0 ] && [ "$(cat "$GH_LOG")" = "workflow run release.yml --ref $tag" ]; then
    ok "$label"
  else
    fail "$label" "             expected gh to dispatch from $tag; exit $code, gh got: $(cat "$GH_LOG"), said: $out"
  fi
}

echo "Testing scripts/release.sh"
echo

# --- release -----------------------------------------------------------------
expect_refused "rollback with no release at all is refused" "no release tags" 2026.10.09 --rollback
expect_release "the first release of a day is v<date>" 2026.10.08 v2026.10.08
expect_refused "rollback with only one release is refused" "nothing to roll back to" 2026.10.09 --rollback
expect_refused "a commit already released is refused" "already released as v2026.10.08" 2026.10.09

commit "$WORK" second; git -C "$WORK" push -q origin master
expect_release "a later day starts again at v<date>" 2026.10.09 v2026.10.09
commit "$WORK" third; git -C "$WORK" push -q origin master
expect_release "the second release of a day is .2" 2026.10.09 v2026.10.09.2
commit "$WORK" fourth; git -C "$WORK" push -q origin master
expect_release "the third release of a day is .3" 2026.10.09 v2026.10.09.3

# A tag pushed by hand with a gap still counts: the next one goes past it.
git -C "$WORK" push -q origin "$(git -C "$WORK" rev-parse HEAD~3):refs/tags/v2026.10.09.7"
# A tag outside the scheme is ignored.
git -C "$WORK" push -q origin "$(git -C "$WORK" rev-parse HEAD~3):refs/tags/v2026.10.09.x"
commit "$WORK" fifth; git -C "$WORK" push -q origin master
expect_release "the counter goes past the highest of the day" 2026.10.09 v2026.10.09.8

# Annotated tags count as releases of the commit they point at.
commit "$WORK" sixth; git -C "$WORK" push -q origin master
git -C "$WORK" tag -a -m annotated v2026.10.10 HEAD
git -C "$WORK" push -q origin refs/tags/v2026.10.10
expect_refused "a commit released with an annotated tag is refused" "already released as v2026.10.10" 2026.10.10

# A tag that exists only locally was never released and does not count.
commit "$WORK" seventh; git -C "$WORK" push -q origin master
git -C "$WORK" tag v2026.10.11.4 HEAD~1
expect_release "a local-only tag does not move the counter" 2026.10.11 v2026.10.11

commit "$WORK" ahead
expect_refused "master ahead of origin is refused" "1 commit(s) ahead" 2026.10.12
git -C "$WORK" reset -q --hard HEAD~1

commit "$OTHER" elsewhere; git -C "$OTHER" pull -q --rebase origin master; git -C "$OTHER" push -q origin master
expect_refused "master behind origin is refused" "1 commit(s) behind" 2026.10.12
git -C "$WORK" pull -q origin master

git -C "$WORK" checkout -q -b feature
expect_refused "a branch other than master is refused" "on 'feature', not master" 2026.10.12
git -C "$WORK" checkout -q master

expect_release "a release after all the refusals goes through" 2026.10.12 v2026.10.12

# --- rollback ----------------------------------------------------------------
expect_dispatched "rollback goes to the release before the newest" v2026.10.11 --rollback
expect_dispatched "rollback to a named release dispatches it" v2026.10.09.2 --rollback v2026.10.09.2
expect_refused "rollback to a tag origin does not have is refused" "not a release on origin" 2026.10.12 \
  --rollback v2026.10.11.4
expect_refused "an unknown argument is refused" "unknown argument" 2026.10.12 --deploy

echo
if [ "$status" -ne 0 ]; then
  echo "release.sh FAILED ($checks checks)" >&2
else
  echo "release.sh ok ($checks checks)"
fi
exit "$status"
