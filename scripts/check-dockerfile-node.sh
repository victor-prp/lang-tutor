#!/usr/bin/env bash
#
# The image runs the Node major CI tests against (phase 30, spec §3): every
# `FROM node:` line in the Dockerfile starts with .nvmrc's major. No Dockerfile,
# or a Dockerfile with no `FROM node:` line, is a violation too: a check that
# finds nothing to check must not print `ok`.

set -u

cd "$(dirname "$0")/.." || exit 1

major=$(tr -d '[:space:]v' < .nvmrc | cut -d. -f1)
lines=$(grep -nE '^FROM[[:space:]]+node:' Dockerfile 2>/dev/null)
if [ -z "$lines" ]; then
  echo "  VIOLATION  the Dockerfile has no FROM node: line" >&2
  exit 1
fi
wrong=$(printf '%s\n' "$lines" | grep -vE "^[0-9]+:FROM[[:space:]]+node:${major}([.-]|[[:space:]]|$)")
if [ -n "$wrong" ]; then
  echo "  VIOLATION  the Dockerfile's Node is not .nvmrc's major ($major):" >&2
  printf '%s\n' "$wrong" | sed 's/^/             /' >&2
  exit 1
fi
echo "  ok         the Dockerfile runs Node $major, as .nvmrc says"
