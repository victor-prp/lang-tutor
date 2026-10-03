#!/usr/bin/env bash
#
# One categorisation session, end to end: prepare inputs, prove the fence, run
# the session, collect what it wrote into nightly-qa/.out/triage.
#
# The session runs FROM the checkout, because reading source is its job, but
# writes only to an out directory outside it. Inputs and outputs live there.
#
# --calibrate grades the rules instead of applying them: every decided issue is
# a target, triage labels are stripped, and the owner's answers are moved out of
# the checkout for the duration so the session cannot read them.

set -u

cd "$(dirname "$0")/../.." || exit 1

REPO=$(pwd -P)
DEST="$REPO/nightly-qa/.out/triage"
MAX_TURNS=120
MODEL="claude-sonnet-5"
CALIBRATE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --calibrate) CALIBRATE=1; MAX_TURNS=300; shift ;;
    --max-turns) MAX_TURNS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "$1" >&2; exit 1; }

OUT_RAW="${NIGHTLY_QA_TRIAGE_OUT:-${TMPDIR:-/tmp}/lang-tutor-triage}"
rm -rf "$OUT_RAW"; mkdir -p "$OUT_RAW"
# Resolved after creation, for the same two reasons nightly-qa/workdir.sh gives:
# TMPDIR's trailing slash, and /var being a symlink on macOS.
OUT=$(cd "$OUT_RAW" && pwd -P) || fail "could not resolve $OUT_RAW"
case "$OUT/" in "$REPO/"*) fail "the triage out directory must be outside the checkout: $OUT" ;; esac

rm -rf "$DEST"; mkdir -p "$DEST"
collect() { cp "$OUT"/*.json "$OUT"/*.jsonl "$OUT"/*.txt "$DEST/" 2>/dev/null || true; }

# --- inputs ------------------------------------------------------------------
if [ -n "$CALIBRATE" ]; then
  npx tsx nightly-qa/src/prepare-triage.ts "$OUT" --calibrate nightly-qa/triage/examples.csv || fail "prepare failed"
else
  npx tsx nightly-qa/src/prepare-triage.ts "$OUT" --filed nightly-qa/.out/filed.json || fail "prepare failed"
fi

targets=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).targets.length)' "$OUT/meta.json")
if [ "$targets" = "0" ]; then
  echo '{"decisions":[],"rule_gaps":[]}' > "$OUT/categories.json"
  collect
  echo "  ok         nothing to categorise; no session started"
  exit 0
fi

cp nightly-qa/triage/rules.md "$OUT/rules.md"
if [ -n "$CALIBRATE" ]; then
  EXAMPLES_NOTE="Tonight is a calibration run: examples.csv is deliberately absent. Decide from the rules alone."
  # Hide the answers. Moved, not just denied: a Grep over the checkout would
  # otherwise find them, and "the rule should have stopped it" is a hope.
  HIDE="$OUT.hidden"
  rm -rf "$HIDE"; mkdir -p "$HIDE"
  restore() { (cd "$HIDE" && find . -type f) | while read -r f; do mkdir -p "$(dirname "$REPO/$f")"; mv "$HIDE/$f" "$REPO/$f"; done; rm -rf "$HIDE"; }
  trap restore EXIT
  for p in nightly-qa/triage/examples.csv drafts docs/superpowers/specs/*phase-17* docs/superpowers/plans/*phase-17* nightly-qa/TRIAGE-CALIBRATION.md; do
    [ -e "$p" ] || continue
    mkdir -p "$HIDE/$(dirname "$p")"
    mv "$p" "$HIDE/$p"
  done
else
  EXAMPLES_NOTE=""
  cp nightly-qa/triage/examples.csv "$OUT/examples.csv"
fi

sed -e "s|__OUT__|$OUT|g" -e "s|__EXAMPLES_NOTE__|$EXAMPLES_NOTE|g" nightly-qa/triage/brief.md > "$OUT/brief.md"
# `//` is an absolute path in a permission rule; see nightly-qa/workdir.sh.
sed -e "s|__REPO__|${REPO#/}|g" -e "s|__OUT__|${OUT#/}|g" nightly-qa/triage/settings.template.json > "$OUT/settings.json"

# --- the fence ---------------------------------------------------------------
./nightly-qa/triage/guard.sh "$OUT" "$OUT/settings.json" || { collect; fail "Triage fence guard failed. Not starting a session."; }

# --- the session -------------------------------------------------------------
echo "  ..         triage session starting ($MODEL, $targets targets, max $MAX_TURNS turns)"
( cd "$REPO" && claude -p "$(cat "$OUT/brief.md")" \
    --restricted \
    --tools "Read,Grep,Glob,Write" \
    --model "$MODEL" \
    --settings "$OUT/settings.json" \
    --add-dir "$OUT" \
    --strict-mcp-config \
    --permission-mode dontAsk \
    --max-turns "$MAX_TURNS" \
    --output-format stream-json --verbose ) > "$OUT/transcript.jsonl" 2>&1
status=$?

collect
npx tsx nightly-qa/src/summarize.ts "$DEST/transcript.jsonl" || true
[ $status -eq 0 ] || echo "  !!         claude exited $status — see $DEST/transcript.jsonl" >&2
[ -f "$DEST/categories.json" ] || fail "The session wrote no categories.json. See $DEST/transcript.jsonl."
echo "Categories: $DEST/categories.json"
