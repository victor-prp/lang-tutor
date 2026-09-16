#!/usr/bin/env bash
#
# One QA agent session, end to end.
#
# Assumes the environment is already up (./nightly-qa/up.sh). Keeping the two
# separate is deliberate: the environment takes minutes to build and is worth
# reusing across two runs, which is exactly what the planted-defect check needs.

set -u

cd "$(dirname "$0")/.." || exit 1

REPO=$(pwd -P)
OUT="$REPO/nightly-qa/.out"
QA_API_PORT="${QA_API_PORT:-3101}"
QA_APP_PORT="${QA_APP_PORT:-8092}"
# Measured, not guessed: the first full session used 142 of a 150 cap, which is
# close enough to truncation that a slightly chattier night would be cut off
# mid-report. 200 leaves room without inviting a session to wander.
MAX_TURNS=200
# Pinned rather than left to the CLI default, because phase A's whole output is a
# set of measurements and a turn count measured against an unknown model means
# nothing. Change it here, deliberately, and re-measure.
MODEL="claude-sonnet-5"
WORKDIR_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --headed) WORKDIR_ARGS+=(--headed); shift ;;
    --persona) WORKDIR_ARGS+=(--persona "$2"); shift 2 ;;
    --focus) WORKDIR_ARGS+=(--focus "$2"); shift 2 ;;
    --max-turns) MAX_TURNS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "$1" >&2; exit 1; }

curl -sf -o /dev/null "http://localhost:$QA_API_PORT/health" || fail "No server on :$QA_API_PORT. Run ./nightly-qa/up.sh first."
curl -sf -o /dev/null "http://localhost:$QA_APP_PORT" || fail "No app on :$QA_APP_PORT. Run ./nightly-qa/up.sh first."

# --- the fence, before anything else -----------------------------------------
./nightly-qa/guard.sh "${WORKDIR_ARGS[@]+"${WORKDIR_ARGS[@]}"}" || fail "Fence guard failed. Not starting a session."

# --- the session -------------------------------------------------------------
WORK=$(./nightly-qa/workdir.sh "${WORKDIR_ARGS[@]+"${WORKDIR_ARGS[@]}"}") || exit 1
[ -f "$WORK/brief.md" ] || fail "No brief at $WORK/brief.md."

echo "  ..         session starting ($MODEL, max $MAX_TURNS turns)"
( cd "$WORK" && claude -p "$(cat "$WORK/brief.md")" \
    --restricted \
    --tools "Read,Write,Edit" \
    --model "$MODEL" \
    --settings "$WORK/settings.json" \
    --mcp-config "$WORK/mcp.json" \
    --strict-mcp-config \
    --permission-mode dontAsk \
    --max-turns "$MAX_TURNS" \
    --output-format stream-json --verbose ) > "$OUT/transcript.jsonl" 2>&1
session_status=$?

# The session's own outputs live in the work directory; collect them next to the
# server log so one directory holds everything the run produced.
cp -R "$WORK/.out/." "$OUT/" 2>/dev/null || true

npx tsx nightly-qa/src/summarize.ts "$OUT/transcript.jsonl"
if [ $session_status -ne 0 ]; then
  echo "  !!         claude exited $session_status — see $OUT/transcript.jsonl" >&2
fi

npx tsx nightly-qa/src/validate.ts "$OUT/findings.json" || fail "The findings file is missing or malformed. See $OUT/transcript.jsonl."

echo
echo "Report:    $OUT/report.md"
echo "Findings:  $OUT/findings.json"
echo "Screens:   $OUT/shots/"
