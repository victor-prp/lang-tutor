#!/usr/bin/env bash
#
# Runs the production image in the foreground against this lane's Postgres and
# MockServer, on this lane's PORT (phase 30, spec §3). `npm run image:run` is
# for a look in a browser; the e2e suite's image target runs it too.
#
# Addresses are rewritten, never written down: the container reaches the host
# through host.docker.internal, which --add-host makes work on Linux (CI) as well
# as on Docker Desktop. Only addresses the container dials are rewritten;
# AUTH_BASE_URL is the browser's address and is passed as it is.
#
# The container is named after the lane and port, and an old one of that name is
# removed first, so a run that was killed without stopping its container cannot
# leave the port taken.

set -u

cd "$(dirname "$0")/.." || exit 1
: "${LANE:?run this through scripts/lane-env.sh, for example npm run image:run}"
IMAGE="${IMAGE:-lang-tutor:$LANE}"
NAME="lang-tutor-$LANE-$PORT"

to_container() {
  printf '%s' "$1" | sed -E 's#(//|@)(localhost|127\.0\.0\.1)([:/])#\1host.docker.internal\3#'
}

args=(--rm --name "$NAME" --add-host host.docker.internal:host-gateway
  -p "$PORT:$PORT"
  -e "PORT=$PORT" -e "LANE=$LANE"
  -e "DATABASE_URL=$(to_container "$DATABASE_URL")")

# Forwarded only when set. The last five are phase 29's; until it merges they
# are never set and nothing is forwarded.
for key in GEMINI_API_KEY GEMINI_MODEL BETTER_AUTH_SECRET AUTH_BASE_URL WEB_ORIGINS RESEND_API_KEY MAIL_FROM; do
  if [ -n "${!key:-}" ]; then args+=(-e "$key=${!key}"); fi
done
for key in GEMINI_BASE_URL RESEND_BASE_URL; do
  if [ -n "${!key:-}" ]; then args+=(-e "$key=$(to_container "${!key}")"); fi
done

docker rm -f "$NAME" > /dev/null 2>&1 || true
exec docker run "${args[@]}" "$IMAGE"
