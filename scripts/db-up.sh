#!/usr/bin/env bash
#
# Starts the two shared containers, and refuses to do it from the wrong place.
#
# docker compose derives its project name from the directory, so running this
# from a worktree starts a SECOND Postgres and fails with "port is already
# allocated" — after having created a container nobody wanted. The running one
# serves every checkout equally well: each lane has its own databases on it, and
# the integration suites clone per-test databases off it either way.
#
# Run through scripts/lane-env.sh, which is what sets LANE_SLOT.

set -u

cd "$(dirname "$0")/.." || exit 1

if [ "${LANE_SLOT:-0}" != "0" ] && docker ps --format '{{.Image}}' 2>/dev/null | grep -q '^postgres:'; then
  echo "Postgres is already running, started from the main checkout." >&2
  echo "This is lane ${LANE:-?} (slot ${LANE_SLOT}), and compose would start a second" >&2
  echo "container here and fail on port ${PGPORT:-5432}. Use the running one: this" >&2
  echo "lane's databases live on it, and ./scripts/setup-worktree.sh created them." >&2
  exit 1
fi

docker compose up -d --wait db mockserver || exit 1
bash scripts/wait-for-mockserver.sh
