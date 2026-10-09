#!/usr/bin/env bash
#
# Cuts a release, or rolls one back, without typing a tag name.
#
#   npm run release                  tag master's HEAD with the next vYYYY.MM.DD[.N] and push it
#   npm run rollback                 rerun the Release workflow from the release before the newest
#   npm run rollback -- v2026.10.08  rerun it from that release
#
# Pushing the tag is the whole release: .github/workflows/release.yml waits for
# CI, builds, applies and checks /health (phase 30, D6–D9). A rollback is that
# workflow dispatched from an older tag, whose image already exists. This script
# neither waits for the workflow nor reports on it.
#
# The tags come from origin, never from the local tag list: a tag that exists
# only here was never released, and one deleted here still was.
#
# RELEASE_DATE (YYYY.MM.DD) stands in for today, for the tests.

set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }

# origin's release tags as "<commit> <tag>", oldest first. An annotated tag's
# peeled ^{} line names its commit and wins over the tag object's own line.
remote_releases() {
  git ls-remote --tags origin 'v*' |
    awk '
      {
        ref = $2; sub(/^refs\/tags\//, "", ref)
        peeled = sub(/\^\{\}$/, "", ref)
        if (ref !~ /^v[0-9][0-9][0-9][0-9]\.[0-9][0-9]\.[0-9][0-9](\.[0-9]+)?$/) next
        if (peeled || !(ref in sha)) sha[ref] = $1
      }
      END {
        for (ref in sha) {
          split(substr(ref, 2), p, ".")
          printf "%s%s%s %09d %s %s\n", p[1], p[2], p[3], (4 in p) ? p[4] : 1, sha[ref], ref
        }
      }' |
    sort | awk '{ print $3, $4 }'
}

release() {
  local branch behind ahead releases head today last n tag url
  branch=$(git rev-parse --abbrev-ref HEAD)
  [ "$branch" = master ] || die "on '$branch', not master. A release is a commit on master."

  git fetch --quiet origin master || die "could not fetch origin/master."
  read -r behind ahead < <(git rev-list --left-right --count origin/master...HEAD)
  [ "$behind" = 0 ] || die "master is $behind commit(s) behind origin/master. Pull and test it first."
  [ "$ahead" = 0 ] || die "master is $ahead commit(s) ahead of origin/master. Only merged work is released."

  releases=$(remote_releases) || die "could not list origin's tags."
  head=$(git rev-parse HEAD)
  last=$(printf '%s\n' "$releases" | awk -v head="$head" '$1 == head { t = $2 } END { print t }')
  [ -z "$last" ] || die "$(git rev-parse --short HEAD) is already released as $last. To deploy it again: npm run rollback -- $last"

  today=${RELEASE_DATE:-$(date +%Y.%m.%d)}
  # The first release of the day is v<date>, the second v<date>.2, and so on.
  n=$(printf '%s\n' "$releases" | awk -v base="v$today" '
    $2 == base { if (max < 1) max = 1 }
    index($2, base ".") == 1 { k = substr($2, length(base) + 2) + 0; if (k > max) max = k }
    END { print max + 0 }')
  if [ "$n" = 0 ]; then tag="v$today"; else tag="v$today.$((n + 1))"; fi

  git tag "$tag" HEAD || die "could not create $tag here; a local tag of that name was never pushed. Delete it: git tag -d $tag"
  git push --quiet origin "refs/tags/$tag" || { git tag -d "$tag" > /dev/null; die "could not push $tag."; }

  echo "Released $(git rev-parse --short HEAD) as $tag."
  url=$(git remote get-url origin | sed -nE 's#^(https://|git@|ssh://git@)github\.com[:/](.+/[^/]+)$#\2#p')
  url=${url%.git}
  [ -z "$url" ] || echo "The Release workflow builds and deploys it: https://github.com/$url/actions/workflows/release.yml"
}

rollback() {
  local wanted="${1:-}" releases tag newest
  releases=$(remote_releases) || die "could not list origin's tags."
  [ -n "$releases" ] || die "origin has no release tags."

  if [ -n "$wanted" ]; then
    tag=$(printf '%s\n' "$releases" | awk -v w="$wanted" '$2 == w { print $2 }')
    [ -n "$tag" ] || die "$wanted is not a release on origin. The latest: $(printf '%s\n' "$releases" | awk '{ print $2 }' | tail -5 | tr '\n' ' ')"
    echo "Rolling back to $tag."
  else
    newest=$(printf '%s\n' "$releases" | tail -1 | awk '{ print $2 }')
    tag=$(printf '%s\n' "$releases" | tail -2 | head -1 | awk '{ print $2 }')
    [ "$tag" != "$newest" ] || die "$newest is the only release; there is nothing to roll back to."
    # The newest tag is not always what is live: after one rollback it is not.
    # A second rollback names its tag.
    echo "Rolling back to $tag, the release before the newest, $newest."
  fi

  gh workflow run release.yml --ref "$tag" || die "could not start the Release workflow from $tag."
  echo "The Release workflow redeploys $tag's image; follow it with: gh run list --workflow release.yml"
}

case "${1:-}" in
  "") release ;;
  --rollback) shift; rollback "$@" ;;
  *) die "unknown argument '$1'. Usage: release.sh [--rollback [tag]]" ;;
esac
