#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0011-learner-unit-is-the-gloss.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. Any output is a VIOLATION, so nothing here relies
# on awk's or grep's exit status, and `set -e` is deliberately absent.

set -u

cd "$(dirname "$0")/.." || exit 1

status=0

check() {
  rule="$1"
  fn="$2"
  output=$("$fn" 2>/dev/null)
  if [ -n "$output" ]; then
    printf '\n  VIOLATION  %s\n' "$rule" >&2
    printf '%s\n' "$output" | sed 's/^/             /' >&2
    status=1
  else
    printf '  ok         %s\n' "$rule"
  fi
}

SCHEMA=apps/server/src/db/schema.ts

# Every line of schema.ts, prefixed with the table whose pgTable(...) block it
# is in: the first quoted snake_case word after `pgTable(`, on its line or the next.
# The prefix is joined with \001, never a tab: a tab inside the source line would
# split it, and whatever followed the tab would leave field 2 unseen.
tables() {
  awk '
    /= pgTable\(/ { pending = 1; table = "" }
    pending && match($0, /'"'"'[a-z_]+'"'"'/) { table = substr($0, RSTART + 1, RLENGTH - 2); pending = 0 }
    { print table "\001" NR ": " $0 }
  ' "$SCHEMA"
}

# R1 — no table outside the dict_ prefix references dict_senses or dict_var_translations.
# The exception the ADR names is the prefix itself: a dict_ table is the dictionary,
# so dict_var_translations and dict_sense_glosses may reference dict_senses, and a
# new dictionary table needs no edit here. Lines before the first pgTable( have no
# table and are skipped. Tests and migrations are not scanned: only schema.ts is.
r1() {
  tables | awk -F '\001' -v file="$SCHEMA" '$1 != "" && $1 !~ /^dict_/ && $2 ~ /(dictSenses|dictVarTranslations)\./ { print file ":" $2 }'
}

# R2 — vocabulary_entries and questions each declare a foreign key to dict_glosses.
# No exceptions. It fails when a table has no such line, so a deleted key and a
# renamed table both report rather than pass.
r2() {
  for t in vocabulary_entries questions; do
    tables | awk -F '\001' -v want="$t" -v file="$SCHEMA" \
      '$1 == want && $2 ~ /dictGlosses\./ { found = 1 } END { if (!found) print file ": " want " declares no foreign key to dict_glosses" }'
  done
}

echo "Checking the repo against ADR 0011 (the learner's unit is the gloss)"
echo

check "R1  no table outside the dict_ prefix references dict_senses or dict_var_translations" r1
check "R2  vocabulary_entries and questions each declare a foreign key to dict_glosses"       r2

echo
if [ "$status" -ne 0 ]; then
  echo "Learner-unit check FAILED. See docs/adr/adr-0011-learner-unit-is-the-gloss.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Learner-unit check passed: 2 rules, no violations."
fi

exit "$status"
