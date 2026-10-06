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

# In CI, docker-compose.ci.yml turns Postgres durability off: the database dies
# with the job, and syncing to disk was most of what the integration suite waited
# on. Never locally, where the same Postgres holds every lane's data.
if [ -n "${CI:-}" ]; then
  docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait db mockserver || exit 1
else
  docker compose up -d --wait db mockserver || exit 1
fi
bash scripts/wait-for-mockserver.sh || exit 1

# The pg-boss dashboard, for people only: no test reads it, so CI (which sets
# CI=true) never pays for the image pull and the package download. Not
# --wait-ed either, so a slow first download never holds up db:up.
if [ -z "${CI:-}" ]; then
  docker compose up -d pgboss-dashboard
  echo "pg-boss dashboard: http://localhost:3000"
fi
