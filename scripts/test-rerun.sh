#!/usr/bin/env bash
#
# Tests scripts/rerun.sh (phase 51, spec D1-D5) in throwaway repositories: an
# origin, and a clone of it standing in for the main checkout (lane 0). A stub
# npm on PATH logs what it was asked to run, plays the server with a python3
# stand-in that answers /health, and plays Metro by returning, or sleeping.
# The listeners D3 must stop or refuse are real python3 servers, each in a
# process group of its own, as a job started from a terminal would be.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
WORK=$(cd "$(mktemp -d)" && pwd -P)
GROUPS_STARTED=
cleanup() {
  for pid in $GROUPS_STARTED; do kill -TERM -- "-$pid" 2> /dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

status=0
checks=0

expect() { # expect <label> <want> <got>
  checks=$((checks + 1))
  if [ "$2" = "$3" ]; then printf '  ok         %s\n' "$1"
  else printf '\n  FAIL       %s\n  wanted: %s\n  got:    %s\n' "$1" "$2" "$3" >&2; status=1; fi
}

says() { # says <label> <text>: the last run's output contains the text
  checks=$((checks + 1))
  case "$OUT" in
    *"$2"*) printf '  ok         %s\n' "$1" ;;
    *) printf '\n  FAIL       %s\n  wanted output containing: %s\n  got:\n%s\n' "$1" "$2" \
         "$(printf '%s\n' "$OUT" | sed 's/^/    /')" >&2
       status=1 ;;
  esac
}

g() { git -c user.email=t@t -c user.name=t "$@"; }
free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])'; }
holder() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2> /dev/null | head -1; }
alive() { if kill -0 "$1" 2> /dev/null; then echo alive; else echo gone; fi; }
held() { if [ -n "$(holder "$1")" ]; then echo held; else echo free; fi; }
npm_log() { tr '\n' ',' < "$WORK/npm.log"; }
short() { git -C "$WORK/main" rev-parse --short=7 HEAD; }

# held_after <port>: held or free, once whatever was stopping has had 5 s.
held_after() {
  local i=0
  while [ -n "$(holder "$1")" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.1; done
  held "$1"
}

# listen <dir> <port> [shell|tree]: a listener started from <dir>, in a
# process group of its own; the group leader's pid lands in LPID. With `shell`,
# a bash that does not exec leads the group. With `tree`, a watcher that does
# not listen leads it and outlives its listener, as `tsx watch` does, so only
# stopping the whole group stops the leader.
listen() {
  set -m
  if [ "${3:-}" = shell ]; then
    (cd "$1" && python3 "$WORK/listener.py" "$2"; true) &
  elif [ "${3:-}" = tree ]; then
    (cd "$1" && exec python3 "$WORK/watcher.py" "$WORK/listener.py" "$2") &
  else
    (cd "$1" && exec python3 "$WORK/listener.py" "$2") &
  fi
  LPID=$!
  disown "$LPID"
  set +m
  GROUPS_STARTED="$GROUPS_STARTED $LPID"
  local i=0
  until [ -n "$(holder "$2")" ] || [ "$i" -gt 50 ]; do i=$((i + 1)); sleep 0.1; done
}
unlisten() { kill -TERM -- "-$1" 2> /dev/null; held_after "$2" > /dev/null; }

PORT=$(free_port)
METRO_PORT=$(free_port)
while [ "$METRO_PORT" = "$PORT" ]; do METRO_PORT=$(free_port); done
LANE0="LANE_SLOT=0 PORT=$PORT METRO_PORT=$METRO_PORT"

# --- fixture -----------------------------------------------------------------
cd "$WORK" || exit 1
git init -q seed
cd seed || exit 1
git symbolic-ref HEAD refs/heads/master
mkdir -p scripts apps/server apps/mobile
cp "$REPO/scripts/with-commit.sh" scripts/
cp "$REPO/scripts/rerun.sh" scripts/ 2> /dev/null || echo "  (scripts/rerun.sh does not exist yet)"
echo '{}' > package-lock.json
echo 'node_modules/' > .gitignore
echo readme > README.md
touch apps/server/.keep apps/mobile/.keep
g add -A && g commit -q -m seed
git clone -q --bare "$WORK/seed" "$WORK/origin.git"
git remote add origin "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/main"
mkdir "$WORK/main/node_modules"

# publish <file> <content>: origin gains a commit changing that file.
publish() {
  (cd "$WORK/seed" && printf '%s\n' "$2" > "$1" && g add -A && g commit -q -m "$1" \
    && git push -q origin master)
}

mkdir "$WORK/bin"
cat > "$WORK/bin/npm" << 'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$NPM_LOG"
case "$*" in
  install) [ -z "${FAKE_INSTALL_FAILS:-}" ] ;;
  "run db:migrate") [ -z "${FAKE_MIGRATE_FAILS:-}" ] ;;
  "run server")
    # Not exec: the real server is a tree (npm, tsx watch, node), so the
    # stand-in nests a level and only stopping the whole tree frees the port.
    commit=${FAKE_HEALTH_COMMIT:-$(bash scripts/with-commit.sh printenv APP_COMMIT)}
    cd apps/server && python3 "$FAKE_SERVER" "$PORT" "$commit" ;;
  "run mobile") exec sleep "${FAKE_MOBILE_SLEEPS:-0}" ;;
  *) echo "stub npm: unexpected 'npm $*'" >&2; exit 2 ;;
esac
EOF
chmod +x "$WORK/bin/npm"

# Python's HTTPServer looks up its own host name before it listens, which can
# stall for seconds; both stand-ins bind and listen without that lookup.
cat > "$WORK/listener.py" << 'EOF'
import socket, sys, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("", int(sys.argv[1])))
s.listen()
while True:
    time.sleep(3600)
EOF

cat > "$WORK/watcher.py" << 'EOF'
import subprocess, sys, time
subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])
while True:  # stays when its listener exits, as tsx watch does
    time.sleep(3600)
EOF

cat > "$WORK/fake_server.py" << 'EOF'
import http.server, json, socketserver, sys
port, commit = int(sys.argv[1]), sys.argv[2]
class Server(http.server.HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", port
class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"ok": True, "commit": commit}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
Server(("", port), Health).serve_forever()
EOF

# rerun_env: the environment lane-env.sh would hand rerun.sh, minus the lane
# values, which each run passes itself.
rerun_env() {
  env -u APP_COMMIT -u EXPO_PUBLIC_APP_COMMIT -u LANE_SLOT -u PORT -u METRO_PORT \
    PATH="$WORK/bin:$PATH" NPM_LOG="$WORK/npm.log" FAKE_SERVER="$WORK/fake_server.py" "$@"
}

# run [VAR=value...]: rerun.sh in the main checkout; sets OUT and CODE. In a
# process group of its own, as `npm run rerun` typed at a prompt would be, and
# writing to a file: a server it failed to stop then fails the checks that
# follow instead of holding a pipe open and hanging the test.
run() {
  : > "$WORK/npm.log"
  set -m
  (cd "$WORK/main" && rerun_env "$@" bash scripts/rerun.sh > "$WORK/out" 2>&1) &
  local pid=$!
  set +m
  GROUPS_STARTED="$GROUPS_STARTED $pid"
  wait "$pid"
  CODE=$?
  OUT=$(cat "$WORK/out")
}

echo "Testing scripts/rerun.sh"
echo

# --- D1: who may run it ------------------------------------------------------
run
expect "outside lane-env.sh: refused" 1 "$CODE"
says   "  and says to use npm run rerun" "npm run rerun"

run $LANE0 LANE_SLOT=4
expect "a worktree's lane: refused" 1 "$CODE"
says   "  lane 0 only" "lane 0 only"

git -C "$WORK/main" checkout -q -b review
run $LANE0
expect "the main checkout on another branch: refused" 1 "$CODE"
says   "  not master" "not master"
git -C "$WORK/main" checkout -q master

# --- D2: the steps -----------------------------------------------------------
publish package-lock.json '{"v":2}'
run $LANE0
expect "origin gained a lockfile change: the run succeeds" 0 "$CODE"
expect "  main is on origin's master" "$(git -C "$WORK/origin.git" rev-parse master)" \
  "$(git -C "$WORK/main" rev-parse HEAD)"
expect "  install, migrate, server, Metro, in that order" \
  "npm install,npm run db:migrate,npm run server,npm run mobile," "$(npm_log)"
says   "  the server answered with the commit just pulled" "server answered on :$PORT with $(short)"
expect "  the server it started is stopped when Metro ends" free "$(held_after "$PORT")"

publish README.md 'readme, again'
run $LANE0
expect "a pull that leaves the lockfile alone: no install" \
  "npm run db:migrate,npm run server,npm run mobile," "$(npm_log)"

run $LANE0
expect "nothing new on origin: the run still succeeds" 0 "$CODE"
says   "  and says it is already on the commit" "already on $(short)"

publish package-lock.json '{"v":3}'
git -C "$WORK/main" pull -q --ff-only origin master
run $LANE0
expect "a lockfile change pulled by hand first: install still runs" \
  "npm install,npm run db:migrate,npm run server,npm run mobile," "$(npm_log)"

publish package-lock.json '{"v":4}'
run $LANE0 FAKE_INSTALL_FAILS=1
expect "a failed install: the run fails" 1 "$CODE"
says   "  naming the step" "rerun: install:"
run $LANE0
expect "  and the retry installs, though the pull has nothing new" \
  "npm install,npm run db:migrate,npm run server,npm run mobile," "$(npm_log)"

echo edited >> "$WORK/main/README.md"
publish notes.txt notes
run $LANE0
expect "a tracked file left edited: the run succeeds" 0 "$CODE"
says   "  and expects the commit with-commit.sh names, -dirty" "with $(short)-dirty"
git -C "$WORK/main" checkout -q -- README.md

listen "$WORK/main/apps/server" "$PORT" tree
SERVER_LISTENER=$LPID
publish notes.txt 'more notes'
run $LANE0 FAKE_MIGRATE_FAILS=1
expect "a failed migration: the run fails" 1 "$CODE"
says   "  naming the step" "rerun: migrate:"
expect "  the running server is left alone" held "$(held "$PORT")"
expect "  and nothing was started" "npm run db:migrate," "$(npm_log)"

# --- D3: stopping only what is ours -------------------------------------------
listen "$WORK/main/apps/mobile" "$METRO_PORT" tree
METRO_LISTENER=$LPID
run $LANE0
expect "this checkout's server and Metro: the run succeeds" 0 "$CODE"
expect "  the old server is stopped" gone "$(alive "$SERVER_LISTENER")"
expect "  the old Metro is stopped" gone "$(alive "$METRO_LISTENER")"

mkdir "$WORK/elsewhere"
listen "$WORK/elsewhere" "$PORT"
run $LANE0
expect "a listener outside this checkout: refused" 1 "$CODE"
says   "  naming it" "not this checkout's"
expect "  and left running" held "$(held "$PORT")"
unlisten "$LPID" "$PORT"

mkdir -p "$WORK/main/.claude/worktrees/other"
listen "$WORK/main/.claude/worktrees/other" "$PORT"
run $LANE0
expect "a listener from a worktree inside it: refused" 1 "$CODE"
says   "  naming it" "belongs to a worktree"
expect "  and left running" held "$(held "$PORT")"
unlisten "$LPID" "$PORT"

listen "$WORK/main/apps/server" "$PORT" shell
run $LANE0
expect "a listener whose group a shell leads: refused" 1 "$CODE"
says   "  naming it" "started straight from a shell"
expect "  and left running" held "$(held "$PORT")"
unlisten "$LPID" "$PORT"

# --- D5: the check -------------------------------------------------------------
run $LANE0 FAKE_HEALTH_COMMIT=0000000
expect "the server answers with another commit: the run fails" 1 "$CODE"
says   "  naming both commits" "the server answered with 0000000, expected $(short)"
expect "  and stops the server it started" free "$(held_after "$PORT")"

# --- D4: Ctrl-C while Metro runs ---------------------------------------------
# SIGINT to the command's whole process group, as a terminal sends it. The
# stand-in server, started in the background by a shell without job control,
# inherits SIGINT ignored, so only the command's own exit can stop it. (The
# real server is node, which resets that, but under Expo's raw-mode terminal
# Ctrl-C never reaches it: Metro exits and, again, only the exit trap is left.)
: > "$WORK/npm.log"
set -m
(cd "$WORK/main" && rerun_env $LANE0 FAKE_MOBILE_SLEEPS=30 bash scripts/rerun.sh > "$WORK/ctrl-c.out" 2>&1) &
RERUN=$!
set +m
GROUPS_STARTED="$GROUPS_STARTED $RERUN"
i=0
until grep -q 'run mobile' "$WORK/npm.log" || [ "$i" -gt 150 ]; do i=$((i + 1)); sleep 0.1; done
kill -INT -- "-$RERUN" 2> /dev/null
wait "$RERUN" 2> /dev/null
expect "Ctrl-C while Metro runs: the server stops too" free "$(held_after "$PORT")"

# --- D2: a pull that cannot fast-forward ---------------------------------------
(cd "$WORK/main" && g commit -q --allow-empty -m local)
publish notes.txt 'diverged'
run $LANE0
expect "master diverged from origin: the run fails" 1 "$CODE"
says   "  at the pull" "rerun: pull:"

echo
if [ "$status" -ne 0 ]; then
  echo "rerun.sh FAILED ($checks checks)" >&2
  exit 1
fi
echo "rerun.sh ok ($checks checks)"
