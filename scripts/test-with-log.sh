#!/usr/bin/env bash
#
# Tests scripts/with-log.sh (request logs, spec D3 and D4) against a throwaway
# LANE_LOGS: the terminal sees the command's output as it always did, the file
# gets every line timestamped and without colour codes, and the exit code is
# the command's own.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
LOGS=$(mktemp -d)
trap 'rm -rf "$LOGS"' EXIT

status=0
checks=0

expect() { # expect <label> <want> <got>
  checks=$((checks + 1))
  if [ "$2" = "$3" ]; then printf '  ok         %s\n' "$1"
  else printf '\n  FAIL       %s\n  wanted: %s\n  got:    %s\n' "$1" "$2" "$3" >&2; status=1; fi
}

# run <args...>: with-log.sh with stdin not a terminal, as in CI and a Claude shell.
run() { LANE_LOGS="$LOGS" APP_COMMIT=a3f9c21 bash "$REPO/scripts/with-log.sh" "$@" < /dev/null; }

STAMP='[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}'

echo "Testing scripts/with-log.sh"
echo

out=$(run server bash -c 'echo one; echo two >&2; echo three')
expect "the terminal sees the output, stderr included" "one two three" "$(echo $out)"

expect "the file opens with a start line naming the commit" "1" \
  "$(grep -cE "^$STAMP ---- server started .* \(a3f9c21\)$" "$LOGS/server.log")"
expect "every output line is in the file, timestamped" "one two three" \
  "$(grep -E "^$STAMP (one|two|three)$" "$LOGS/server.log" | sed -E "s/^$STAMP //" | tr '\n' ' ' | sed 's/ $//')"

run server bash -c 'exit 3' > /dev/null
expect "the exit code is the command's" "3" "$?"

run server echo again > /dev/null
expect "each run appends to the same file (three so far)" "3" "$(grep -c -- '---- server started' "$LOGS/server.log")"

out=$(run metro printf '\033[32mgreen\033[0m\r\nprogress 10%%\rprogress 99%%\r\ndone\n')
expect "the terminal keeps the colour codes" "1" "$(printf '%s' "$out" | grep -c $'\033\\[32m')"
expect "the file has them stripped, and only a line's last redraw" "green|progress 99%|done" \
  "$(grep -vE -- '---- metro started' "$LOGS/metro.log" | sed -E "s/^$STAMP //" | paste -sd '|' -)"

out=$(run --tty metro bash -c '[ -t 1 ] && echo tty || echo plain')
expect "--tty with no terminal on stdin runs the command plainly" "plain" "$out"

# A terminal for with-log.sh itself, from `script`, the way Victor's shell gives
# it one: the macOS and Linux forms, as with-log.sh has them. On Linux its input
# stays open and empty, as a terminal's does: given one that ends (/dev/null),
# `script` types an EOF into the terminal, and when with-log.sh's own `script` has
# already set that terminal raw, it echoes as ^@ into the output and the file
# (about one run in five under load; CI run 39133235622). A pipe whose writer only
# sleeps sends none. macOS's `script` refuses a pipe for input ("tcgetattr/ioctl:
# Operation not supported on socket"), so it keeps /dev/null, whose EOF echoes as
# ^D and is stripped below.
in_tty() {
  if [ "$(uname)" = "Darwin" ]; then script -q /dev/null "$@" < /dev/null; return; fi
  mkfifo "$LOGS/stdin"
  sleep 60 > "$LOGS/stdin" &
  local keep=$! status
  script -qefc "$(printf '%q ' "$@")" /dev/null < "$LOGS/stdin"
  status=$?
  kill "$keep" 2>/dev/null
  return "$status"
}
out=$(in_tty env LANE_LOGS="$LOGS" bash "$REPO/scripts/with-log.sh" --tty tty bash -c '[ -t 1 ] && echo tty || echo plain' \
  | tr -d '\r\004\010' | sed 's/\^D//g')
expect "--tty in a terminal gives the command one" "tty" "$out"
expect "and its output still reaches the file" "1" "$(grep -cE "^$STAMP tty$" "$LOGS/tty.log")"

big="$LOGS/big.log"
head -c 2000 /dev/zero | tr '\0' 'x' > "$big"
LANE_LOGS="$LOGS" WITH_LOG_MAX_BYTES=1000 bash "$REPO/scripts/with-log.sh" big echo fresh < /dev/null > /dev/null
expect "a file over the limit moves to .log.1" "2000" "$(wc -c < "$big.1" | tr -d ' ')"
expect "and the new file starts empty but for this run" "1" "$(grep -c 'fresh' "$big")"

err=$(env -u LANE_LOGS bash "$REPO/scripts/with-log.sh" server echo hi 2>&1 < /dev/null)
expect "no LANE_LOGS: refuses, naming lane-env.sh" "1" "$(printf '%s' "$err" | grep -c 'lane-env.sh')"

err=$(run 'bad name' echo hi 2>&1)
expect "a name that is not a plain word is refused" "1" "$(printf '%s' "$err" | grep -c 'name')"

echo
if [ "$status" -ne 0 ]; then
  echo "with-log.sh FAILED ($checks checks)" >&2
  exit 1
fi
echo "with-log.sh passed ($checks checks)"
