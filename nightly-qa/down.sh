#!/usr/bin/env bash
#
# Kills what up.sh started. Reads .out/pids rather than pattern-matching on
# process names, so it can never kill a developer's own `npm run server`.
#
# Descendants are walked with pgrep rather than killed as a process group.
# `kill -- -PID` would be wrong here and dangerous: a non-interactive shell has
# job control off, so a backgrounded child is NOT a process group leader — it
# stays in this script's own group, and the negative-PID form could match that
# group and kill the script itself. npm is a wrapper that execs node as a child,
# so the descendants are exactly what has to be reached.

set -u

cd "$(dirname "$0")/.." || exit 1

PIDS="nightly-qa/.out/pids"
[ -f "$PIDS" ] || { echo "Nothing to stop (no $PIDS)."; exit 0; }

kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

while read -r pid; do
  [ -n "$pid" ] || continue
  kill_tree "$pid"
done < "$PIDS"

rm -f "$PIDS"

# The ports are the real check: a process that ignored TERM still holds one, and
# up.sh would then fail confusingly on "port already in use" rather than here.
sleep 1
for port in 3001 8082; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  !!         port $port is still held after TERM:" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
  fi
done

echo "  ok         stopped"
