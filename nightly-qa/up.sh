#!/usr/bin/env bash
#
# Boots the app for a QA agent run: a freshly provisioned database, the Hono
# server, and a static web export of the Expo app.
#
# This is e2e/playwright.config.ts's `webServer` block as a shell script, with
# one deliberate difference: GEMINI_BASE_URL is NOT set, so the server calls the
# real Gemini API rather than MockServer. A QA run against canned responses
# would be testing the mock.
#
# Playwright starts those two servers itself, but only under `playwright test`,
# which is why this exists at all rather than reusing that config.

set -u

cd "$(dirname "$0")/.." || exit 1

# Ports of its own, not the app's usual 3001/8081 and not e2e's 8082. A QA run
# has to be startable while a developer's `npm run server` is up in a terminal
# and while an e2e run is in flight, because otherwise the first thing it does
# is demand that someone stop working. This is the same reasoning that made e2e
# serve on 8082 rather than attach to whatever sits on Metro's 8081.
QA_API_PORT="${QA_API_PORT:-3101}"
QA_APP_PORT="${QA_APP_PORT:-8092}"
QA_API_URL="http://localhost:$QA_API_PORT"
QA_APP_URL="http://localhost:$QA_APP_PORT"

OUT="nightly-qa/.out"
mkdir -p "$OUT"
: > "$OUT/pids"

fail() { echo "$1" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------
# The same guard tests/eval/run.ts applies, for the same reason: a run against a
# localhost base URL is a run against a mock, and would silently produce a
# meaningless report rather than failing.
[ -n "${GEMINI_API_KEY:-}" ] || fail "GEMINI_API_KEY is not set. A QA run calls the real API."
[ -n "${GEMINI_MODEL:-}" ] || fail "GEMINI_MODEL is not set (for example: a current Gemini Flash model id)."
case "${GEMINI_BASE_URL:-}" in
  *localhost*|*127.0.0.1*) fail "GEMINI_BASE_URL points at a local mock. Unset it." ;;
esac

for port in "$QA_API_PORT" "$QA_APP_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Port $port is already in use. Stop whatever holds it (npm run server, an e2e run, a previous ./nightly-qa/down.sh that did not finish)."
  fi
done

# --- 1. the database ---------------------------------------------------------
npx tsx nightly-qa/src/provision-db.ts || fail "Could not provision lang_tutor_qa. Is Postgres up? (npm run db:up, from the MAIN checkout)"

# --- 2. the server -----------------------------------------------------------
# Log to a file rather than the terminal: the log ships with the run, and a 502
# the learner experienced as a blank screen is explained there and nowhere else.
PORT="$QA_API_PORT" \
DATABASE_URL="postgres://postgres:postgres@${PGHOST:-localhost}:${PGPORT:-5432}/lang_tutor_qa" \
  npm run start -w apps/server > "$OUT/server.log" 2>&1 &
echo $! >> "$OUT/pids"

deadline=$((SECONDS + 60))
until curl -sf -o /dev/null "$QA_API_URL/health"; do
  [ "$SECONDS" -lt "$deadline" ] || { tail -20 "$OUT/server.log" >&2; fail "Server did not answer /health within 60s."; }
  sleep 1
done
echo "  ok         server on :$QA_API_PORT (real Gemini)"

# --- 3. the app --------------------------------------------------------------
# EXPO_PUBLIC_API_URL must be set at EXPORT time: Metro inlines EXPO_PUBLIC_*
# into the bundle, so setting it when serving would be too late and the app
# would throw at module scope.
EXPO_PUBLIC_API_URL="$QA_API_URL" npm run build:web -w apps/mobile > "$OUT/export.log" 2>&1 \
  || { tail -20 "$OUT/export.log" >&2; fail "expo export failed."; }

( cd apps/mobile && npx expo serve dist --port "$QA_APP_PORT" ) > "$OUT/serve.log" 2>&1 &
echo $! >> "$OUT/pids"

deadline=$((SECONDS + 60))
until curl -sf -o /dev/null "$QA_APP_URL"; do
  [ "$SECONDS" -lt "$deadline" ] || { tail -20 "$OUT/serve.log" >&2; fail "App did not answer on :8082 within 60s."; }
  sleep 1
done
echo "  ok         app on :$QA_APP_PORT"
echo "$QA_APP_URL" > "$OUT/app-url"
echo "Environment up. Tear it down with ./nightly-qa/down.sh"
