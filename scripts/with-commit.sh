#!/usr/bin/env bash
#
# Phase 49 (spec D2). Runs a command with the commit this checkout is on, so the
# server's /health and the app's About screen can name the exact code:
#
#   APP_COMMIT              read by the server (config.ts)
#   EXPO_PUBLIC_APP_COMMIT  inlined into the app's bundle by Metro
#
# 7 characters, with `-dirty` appended when a tracked file has uncommitted
# changes (untracked files do not count, as with `git describe --dirty`);
# `unknown` outside a repository. A value already set wins: the release sets
# its own, and the image carries one. Read once, when the command starts, so a
# server or Metro left running shows the commit it started on (spec R3).
#
#   bash scripts/with-commit.sh <command...>

set -u

if [ -z "${APP_COMMIT:-}" ]; then
  if APP_COMMIT=$(git rev-parse --short=7 HEAD 2> /dev/null); then
    [ -n "$(git status --porcelain --untracked-files=no 2> /dev/null)" ] && APP_COMMIT="$APP_COMMIT-dirty"
  else
    APP_COMMIT=unknown
  fi
fi
export APP_COMMIT
export EXPO_PUBLIC_APP_COMMIT="${EXPO_PUBLIC_APP_COMMIT:-$APP_COMMIT}"

exec "$@"
