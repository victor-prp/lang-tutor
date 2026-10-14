#!/usr/bin/env bash
#
# Phase 51. Pulls master into the main checkout and brings the server and Metro
# back up on it, in one terminal:
#
#   npm run rerun
#
# Six steps, in order. The first that fails stops the command and names itself,
# and nothing is stopped until pull, install and migrate have succeeded:
#
#   pull     git pull --ff-only origin master
#   install  npm install, only when package-lock.json changed or node_modules is missing
#   migrate  npm run db:migrate
#   stop     whatever this checkout runs on PORT and METRO_PORT, and nothing else
#   server   npm run server in the background, its lines prefixed [server]; waits
#            until /health names the commit with-commit.sh gives
#   metro    npm run mobile in the foreground; Ctrl-C stops both
#
# Lane 0 on master only. lane-env.sh supplies LANE_SLOT, PORT and METRO_PORT.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT" || exit 1

HEALTH_TIMEOUT=90
STOP_TIMEOUT=10

STEP=
SERVER=

fail() { echo "rerun: ${STEP:+$STEP: }$1" >&2; exit 1; }
step() { STEP="$1"; printf '\n== %s\n' "$1"; }

# --- who may run it (D1) -----------------------------------------------------
[ -n "${LANE_SLOT:-}" ] && [ -n "${PORT:-}" ] && [ -n "${METRO_PORT:-}" ] \
  || fail "run it as 'npm run rerun', which supplies this lane's ports"
[ "$LANE_SLOT" = 0 ] \
  || fail "lane 0 only. In a worktree, merge origin/master and restart 'npm run server' and 'npm run mobile'."
branch=$(git branch --show-current)
[ "$branch" = master ] || fail "the main checkout is on '${branch:-a detached HEAD}', not master"

# --- pull, install, migrate (D2) ---------------------------------------------
step pull
before=$(git rev-parse HEAD)
git pull --ff-only origin master || fail "master cannot fast-forward to origin's; nothing was stopped"
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "already on $(git rev-parse --short=7 HEAD)"
else
  echo "$(git rev-parse --short=7 "$before") -> $(git rev-parse --short=7 "$after")"
fi

# Against the lockfile node_modules was last installed from, recorded after
# each install that succeeds, not against what this pull changed: that would
# skip the retry after a failed install, and a pull done by hand beforehand.
step install
STAMP=node_modules/.rerun-lockfile
if [ "$(cat "$STAMP" 2> /dev/null)" != "$(git hash-object package-lock.json)" ]; then
  # `npm run rerun` exported the user's npm config to this script as npm_config_*
  # variables. npm 12 refuses allow-scripts from the environment in a project
  # install (EALLOWSCRIPTS); without it, npm reads it from ~/.npmrc itself.
  env -u npm_config_allow_scripts npm install || fail "npm install failed; nothing was stopped"
  git hash-object package-lock.json > "$STAMP"
else
  echo "package-lock.json unchanged since the last install; skipped"
fi

step migrate
npm run db:migrate || fail "the migration failed; nothing was stopped"

# --- stop only what is ours (D3) ---------------------------------------------
listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2> /dev/null | head -1; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2> /dev/null | sed -n 's/^n//p' | head -1; }

# stop_port <name> <port>. The whole process group goes, so a hand-started
# `npm run server` in another terminal returns to its prompt instead of leaving
# a `tsx watch` behind that would start the server again on the next save.
stop_port() {
  local name="$1" port="$2" pid cwd pgid leader i
  pid=$(listener "$port")
  if [ -z "$pid" ]; then
    echo "$name: nothing on :$port"
    return 0
  fi
  cwd=$(cwd_of "$pid")
  case "$cwd/" in
    "$ROOT"/.claude/worktrees/*) fail "pid $pid on :$port belongs to a worktree ($cwd); not stopping it" ;;
    "$ROOT"/*) ;;
    *) fail "pid $pid on :$port is not this checkout's ($(ps -o command= -p "$pid" | cut -c1-80)); stop it yourself" ;;
  esac
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  [ "$pgid" != "$(ps -o pgid= -p $$ | tr -d ' ')" ] \
    || fail "pid $pid on :$port is in this command's own process group"
  leader=$(ps -o comm= -p "$pgid" 2> /dev/null)
  case "${leader##*/}" in
    -* | sh | bash | zsh | fish | dash)
      fail "pid $pid on :$port was started straight from a shell (group $pgid); stop it in its own terminal" ;;
  esac
  echo "$name: stopping pid $pid on :$port (process group $pgid)"
  kill -TERM -- "-$pgid" 2> /dev/null
  i=0
  while [ -n "$(listener "$port")" ]; do
    i=$((i + 1))
    [ "$i" -eq $((STOP_TIMEOUT * 2)) ] && kill -KILL -- "-$pgid" 2> /dev/null
    [ "$i" -gt $((STOP_TIMEOUT * 2 + 10)) ] && fail "pid $pid still holds :$port"
    sleep 0.5
  done
}

step stop
stop_port server "$PORT"
stop_port metro "$METRO_PORT"

# --- the server, then Metro (D4, D5) -----------------------------------------
# This trap is what stops the server, whichever way the command ends. Expo puts
# the terminal in raw mode, so Ctrl-C reaches Metro alone, as a key press: Metro
# exits, and nothing but this trap would then stop the server, a tree of npm,
# tsx watch and node.
descendants() {
  local child
  for child in $(pgrep -P "$1"); do
    echo "$child"
    descendants "$child"
  done
}
stop_server() {
  [ -n "$SERVER" ] || return 0
  kill -TERM "$SERVER" $(descendants "$SERVER") 2> /dev/null
  SERVER=
}
trap stop_server EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step server
expected=$(bash scripts/with-commit.sh printenv APP_COMMIT)
npm run server < /dev/null > >(awk '{ print "[server] " $0; fflush() }') 2>&1 &
SERVER=$!
i=0
while :; do
  kill -0 "$SERVER" 2> /dev/null || fail "the server exited before /health answered"
  got=$(curl -s --max-time 2 "http://localhost:$PORT/health" \
    | sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p')
  [ -n "$got" ] && break
  i=$((i + 1))
  [ "$i" -ge $((HEALTH_TIMEOUT * 2)) ] && fail "no answer from /health on :$PORT after ${HEALTH_TIMEOUT}s"
  sleep 0.5
done
[ "$got" = "$expected" ] || fail "the server answered with $got, expected $expected"
echo "server answered on :$PORT with $got"

step metro
npm run mobile
