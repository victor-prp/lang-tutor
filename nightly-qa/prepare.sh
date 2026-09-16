#!/usr/bin/env bash
#
# Chooses tonight's charter and fetches what the tracker already knows.
#
# The charter is a function of the date rather than a random draw, so re-running
# a night by hand reproduces it exactly. Four personas and seven focus areas are
# coprime, so the pairing cycles through all 28 combinations before repeating -
# a random pick would collide far more often than that over a month.

set -u

cd "$(dirname "$0")/.." || exit 1

OUT="nightly-qa/.out"
mkdir -p "$OUT"

PERSONA=""
FOCUS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --persona) PERSONA="$2"; shift 2 ;;
    --focus) FOCUS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Sorted so the mapping from a date to a charter is stable across machines,
# where `ls` order is not guaranteed to be. A read loop rather than `mapfile`,
# because macOS ships bash 3.2 and this script has to behave identically on a
# laptop and on a runner - a rotation that differs between the two would make
# re-running a night by hand reproduce a different night.
PERSONAS=()
while IFS= read -r name; do PERSONAS+=("$name"); done < <(
  find nightly-qa/charters/personas -name '*.md' -exec basename {} .md \; | sort
)
FOCUSES=()
while IFS= read -r name; do FOCUSES+=("$name"); done < <(
  find nightly-qa/charters/focus -name '*.md' -exec basename {} .md \; | sort
)

[ "${#PERSONAS[@]}" -gt 0 ] || { echo "no personas found" >&2; exit 1; }
[ "${#FOCUSES[@]}" -gt 0 ] || { echo "no focus areas found" >&2; exit 1; }

DOY=$(date -u +%j)
DOY=$((10#$DOY))   # strip the leading zero; 008 is not octal here

[ -n "$PERSONA" ] || PERSONA="${PERSONAS[$((DOY % ${#PERSONAS[@]}))]}"
[ -n "$FOCUS" ] || FOCUS="${FOCUSES[$((DOY % ${#FOCUSES[@]}))]}"

printf '%s\n%s\n' "$PERSONA" "$FOCUS" > "$OUT/charter"

# --- what the tracker already knows ------------------------------------------
# Open AND closed. A closed issue is exactly the thing the agent must not spend
# tonight rediscovering, and file.ts needs the closed ones to tell "reproduced
# after a fix" from "arguing with a wontfix".
if gh issue list --label nightly-qa --state all --limit 200 \
     --json number,title,state,labels,body > "$OUT/known-issues.json" 2>"$OUT/gh.log"; then
  count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$OUT/known-issues.json")
  echo "  ok         $count known issues" >&2
else
  # A tracker we cannot read is not a reason to skip the night: the session is
  # still worth running, and file.ts treats an empty list as "nothing known",
  # which at worst files a duplicate a human can merge. Silence would be worse.
  echo "  !!         could not read the tracker; continuing with none known" >&2
  cat "$OUT/gh.log" >&2
  echo '[]' > "$OUT/known-issues.json"
fi

echo "  ok         charter: $PERSONA / $FOCUS" >&2
echo "persona=$PERSONA focus=$FOCUS"
