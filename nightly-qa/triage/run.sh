#!/usr/bin/env bash
#
# One categorisation session, end to end: prepare inputs, prove the fence, run
# the session, collect what it wrote into nightly-qa/.out/triage.
#
# The session runs FROM the checkout, because reading source is its job, but
# writes only to an out directory outside it. Inputs and outputs live there.
#
# --calibrate grades the rules instead of applying them: every decided issue is
# a target, triage labels are stripped, and the session runs against an export
# of HEAD with the owner's answers deleted from it.

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
# Three directories, all outside the checkout:
#   OUT   the session reads its inputs here and writes categories.json here;
#   PREP  meta.json and known.json as prepare-triage wrote them. The apply job
#         trusts these - they say which issues exist and which are targets - so
#         the session must not be able to reach them. Only categories.json and
#         the transcripts come back from OUT.
#   TREE  calibration only: a throwaway export of HEAD with the answers removed.
rm -rf "$OUT_RAW" "$OUT_RAW-prep" "$OUT_RAW-tree"
mkdir -p "$OUT_RAW" "$OUT_RAW-prep"
# Resolved after creation, for the same two reasons nightly-qa/workdir.sh gives:
# TMPDIR's trailing slash, and /var being a symlink on macOS.
OUT=$(cd "$OUT_RAW" && pwd -P) || fail "could not resolve $OUT_RAW"
PREP=$(cd "$OUT_RAW-prep" && pwd -P) || fail "could not resolve $OUT_RAW-prep"
for d in "$OUT" "$PREP"; do
  case "$d/" in "$REPO/"*) fail "the triage directories must be outside the checkout: $d" ;; esac
done

rm -rf "$DEST"; mkdir -p "$DEST"
collect() {
  cp "$PREP"/*.json "$PREP"/*.txt "$DEST/" 2>/dev/null || true
  for f in categories.json transcript.jsonl guard-transcript.jsonl; do
    [ -f "$OUT/$f" ] && cp "$OUT/$f" "$DEST/$f"
  done
  return 0
}

# --- inputs ------------------------------------------------------------------
if [ -n "$CALIBRATE" ]; then
  npx tsx nightly-qa/src/prepare-triage.ts "$PREP" --calibrate nightly-qa/triage/examples.csv || fail "prepare failed"
else
  npx tsx nightly-qa/src/prepare-triage.ts "$PREP" --filed nightly-qa/.out/filed.json || fail "prepare failed"
fi

targets=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).targets.length)' "$PREP/meta.json")
if [ "$targets" = "0" ]; then
  echo '{"decisions":[],"rule_gaps":[]}' > "$OUT/categories.json"
  collect
  echo "  ok         nothing to categorise; no session started"
  exit 0
fi

# What the session reads: copies, so nothing it does to them reaches apply.
cp "$PREP/targets.json" "$PREP/known.json" "$PREP/commits.txt" "$OUT/"
cp nightly-qa/triage/rules.md "$OUT/rules.md"

if [ -n "$CALIBRATE" ]; then
  EXAMPLES_NOTE="Tonight is a calibration run: examples.csv is deliberately absent. Decide from the rules alone."
  # The session reads a committed export of HEAD rather than this checkout, so
  # the answers are absent rather than merely denied, and nothing of the
  # owner's is moved: no worktrees, no .superpowers, no drafts/ - none of which
  # git archive carries - and the files below deleted from the copy.
  mkdir -p "$OUT_RAW-tree"
  TREE=$(cd "$OUT_RAW-tree" && pwd -P) || fail "could not resolve $OUT_RAW-tree"
  trap 'rm -rf "$OUT_RAW-tree"' EXIT
  git archive HEAD | tar -x -C "$TREE" || fail "could not export HEAD"
  rm -f "$TREE/nightly-qa/triage/examples.csv" "$TREE/nightly-qa/TRIAGE-CALIBRATION.md" \
    "$TREE"/docs/superpowers/specs/*phase-17* "$TREE"/docs/superpowers/plans/*phase-17* \
    "$TREE"/nightly-qa/src/*.test.ts
  SESSION_REPO="$TREE"
else
  EXAMPLES_NOTE=""
  cp nightly-qa/triage/examples.csv "$OUT/examples.csv"
  SESSION_REPO="$REPO"
fi

sed -e "s|__OUT__|$OUT|g" -e "s|__EXAMPLES_NOTE__|$EXAMPLES_NOTE|g" nightly-qa/triage/brief.md > "$OUT/brief.md"
# `//` is an absolute path in a permission rule; see nightly-qa/workdir.sh.
sed -e "s|__REPO__|${SESSION_REPO#/}|g" -e "s|__OUT__|${OUT#/}|g" nightly-qa/triage/settings.template.json > "$OUT/settings.json"

# --- the fence ---------------------------------------------------------------
./nightly-qa/triage/guard.sh "$OUT" "$OUT/settings.json" "$PREP" "$SESSION_REPO" || { collect; fail "Triage fence guard failed. Not starting a session."; }

# --- the session -------------------------------------------------------------
echo "  ..         triage session starting ($MODEL, $targets targets, max $MAX_TURNS turns)"
( cd "$SESSION_REPO" && claude -p "$(cat "$OUT/brief.md")" \
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
