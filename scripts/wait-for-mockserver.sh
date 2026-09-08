#!/usr/bin/env bash
#
# Blocks until the MockServer container answers its liveness probe.
#
# This exists because `docker compose up --wait` can only wait on a
# healthcheck, and mockserver/mockserver:5.15.0 is a distroless image: its
# filesystem holds java, openssl and c_rehash and no shell, so neither the
# CMD-SHELL nor the CMD exec form of a healthcheck has anything to run. The
# probe therefore has to come from the host, which is where this runs.
#
# Without it, `npm run db:up && npm run test:integration` races the container's
# few seconds of JVM startup on a cold `up`.

set -u

URL="${MOCKSERVER_URL:-http://localhost:1080}/liveness/probe"
DEADLINE=$((SECONDS + 60))

until curl -sf -o /dev/null "$URL"; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "MockServer did not become ready within 60s at $URL" >&2
    echo "Check 'docker compose logs mockserver'." >&2
    exit 1
  fi
  sleep 1
done

echo "  ok         MockServer ready at $URL"
