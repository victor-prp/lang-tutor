#!/usr/bin/env bash
#
# Builds the scratch working directory the agent session runs in.
#
# The point is that this directory is NOT the checkout. Claude Code auto-allows
# file reads inside its working directory with no permission check at all, so a
# session started in the repository can read every file under apps/ without ever
# consulting a rule. Starting it here instead, with
# blockReadsOutsideWorkingDirectories on, is what makes "no source access" a
# fact rather than a hope. A second consequence, also wanted: the repository's
# CLAUDE.md is never loaded, because Claude reads the working directory's, and
# this directory has none.
#
# Prints the directory's absolute path on stdout. Everything else goes to stderr.

set -u

cd "$(dirname "$0")/.." || exit 1

REPO=$(pwd -P)
# Outside the checkout, deliberately, and this is not cosmetic. Deny rules beat
# allow rules with no exception, so with the work directory nested inside the
# repo the `Read(//<repo>/**)` deny would also swallow `Edit(//<work>/.out/**)`
# and the agent could not write its own report. Keeping the two trees disjoint
# removes the overlap, and it is what makes blockReadsOutsideWorkingDirectories
# fence the checkout on its own — the explicit deny then becomes a second layer
# rather than the only one. CI does the same thing with $RUNNER_TEMP.
WORK_RAW="${NIGHTLY_QA_WORK:-${TMPDIR:-/tmp}/lang-tutor-nightly-qa}"
HEADLESS="--headless"
QA_API_PORT="${QA_API_PORT:-3101}"
QA_APP_PORT="${QA_APP_PORT:-8092}"

PERSONA="careful-adult"
FOCUS="polysemy"

while [ $# -gt 0 ]; do
  case "$1" in
    --headed) HEADLESS="--no-headless"; shift ;;
    --persona) PERSONA="$2"; shift 2 ;;
    --focus) FOCUS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

rm -rf "$WORK_RAW"
mkdir -p "$WORK_RAW/.out/shots"

# Resolve only after the directory exists. TMPDIR carries a trailing slash on
# macOS, which would otherwise leave a `//` in the middle of a permission rule's
# path, and /var is a symlink to /private/var, which would leave the allow rule
# describing a different path than the one Claude reports as its working
# directory. Both would fence nothing while looking perfectly correct.
WORK=$(cd "$WORK_RAW" && pwd -P) || { echo "could not resolve $WORK_RAW" >&2; exit 1; }

# `//` is an absolute path from the filesystem root in a permission rule. A
# single leading slash would anchor at the settings source instead, which is a
# different directory and would silently fence nothing.
sed -e "s|__WORK__|${WORK#/}|g" -e "s|__REPO__|${REPO#/}|g" \
  nightly-qa/fence/settings.template.json > "$WORK/settings.json"

sed -e "s|__WORK__|$WORK|g" -e "s|__HEADLESS__|$HEADLESS|g" \
    -e "s|__API_PORT__|$QA_API_PORT|g" -e "s|__APP_PORT__|$QA_APP_PORT|g" \
  nightly-qa/fence/mcp.template.json > "$WORK/mcp.json"

PERSONA_FILE="nightly-qa/charters/personas/$PERSONA.md"
FOCUS_FILE="nightly-qa/charters/focus/$FOCUS.md"
# Fail rather than fall back. A typo in a charter name must not quietly produce a
# session with no persona at all, which would look like a normal night in every
# artifact it left behind.
[ -f "$PERSONA_FILE" ] || { echo "no such persona: $PERSONA_FILE" >&2; exit 1; }
[ -f "$FOCUS_FILE" ] || { echo "no such focus: $FOCUS_FILE" >&2; exit 1; }

cat nightly-qa/brief/mission.md "$PERSONA_FILE" "$FOCUS_FILE" \
  | sed -e "s|__APP_URL__|http://localhost:$QA_APP_PORT|g" > "$WORK/brief.md"

echo "  ok         charter: $PERSONA / $FOCUS" >&2

# The agent reads this to decide what is already known. Copied in rather than
# read from the checkout, because the checkout is exactly what the fence stops
# it reaching.
if [ -f nightly-qa/.out/known-issues.json ]; then
  cp nightly-qa/.out/known-issues.json "$WORK/known-issues.json"
else
  echo '[]' > "$WORK/known-issues.json"
fi

echo "  ok         work dir at $WORK ($HEADLESS)" >&2
echo "$WORK"
