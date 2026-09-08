#!/usr/bin/env bash
#
# Prepares a git worktree for running this project.
#
# `git worktree add` brings tracked files and nothing else, so a fresh worktree
# is missing exactly what .gitignore covers: apps/mobile/.env.local and
# node_modules. The app then fails at module scope with
# "EXPO_PUBLIC_API_URL is not set", which surfaces as three unrelated-looking
# router errors rather than as the missing file it actually is.
#
# Idempotent and safe to run from any checkout, worktree or not: every step is
# guarded, so a second run does nothing. Nothing here is destructive — no file
# that already exists is overwritten.

set -u

cd "$(dirname "$0")/.." || exit 1

# The main checkout, wherever this is run from. In a worktree, --git-common-dir
# points at the original repository's .git; in a normal checkout it is that .git
# itself, and this resolves to the same tree we are already in.
MAIN=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
HERE=$(pwd -P)

status=0

# --- 1. the mobile env file --------------------------------------------------
# EXPO_PUBLIC_API_URL is read at module scope in apps/mobile/src/app/_layout.tsx
# (Metro inlines EXPO_PUBLIC_* at build time, which is why it is read there and
# not through an indirection). Missing file, no app.
if [ -f apps/mobile/.env.local ]; then
  echo "  ok         apps/mobile/.env.local present"
elif [ "$HERE" != "$MAIN" ] && [ -f "$MAIN/apps/mobile/.env.local" ]; then
  cp "$MAIN/apps/mobile/.env.local" apps/mobile/.env.local
  echo "  created    apps/mobile/.env.local (copied from the main checkout,"
  echo "             keeping the LAN IP already configured there)"
elif [ -f apps/mobile/.env.example ]; then
  cp apps/mobile/.env.example apps/mobile/.env.local
  echo "  created    apps/mobile/.env.local from .env.example — it points at"
  echo "             localhost, so set your LAN IP to use a physical device"
else
  echo "  MISSING    apps/mobile/.env.local, and no .env.example to copy" >&2
  status=1
fi

# --- 1b. the provider key ----------------------------------------------------
# Not copied from the main checkout the way .env.local is: this one is a secret
# and lives in the shell, not in a file the script can find. Reported rather
# than failed, because the tests do not need it — only `npm run server` does.
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "  note       GEMINI_API_KEY is not set — 'npm run server' will refuse to start."
  echo "             For local work, point GEMINI_BASE_URL at MockServer and use any dummy key:"
  echo "               export GEMINI_BASE_URL=http://localhost:1080/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev"
else
  echo "  ok         GEMINI_API_KEY set"
fi

# --- 2. dependencies ---------------------------------------------------------
# A worktree gets its own node_modules; there is no sharing with the main
# checkout. Roughly 700MB per worktree.
if [ -d node_modules ]; then
  echo "  ok         node_modules present"
else
  echo "  running    npm install (a worktree does not share the main checkout's)"
  npm install || status=1
fi

# --- 3. the database ---------------------------------------------------------
# docker compose derives its project name from the directory, so `npm run db:up`
# in a worktree starts a SECOND Postgres and fails with "port is already
# allocated". The running container serves every checkout equally well:
# integration tests clone a per-test database off it either way.
if command -v docker > /dev/null 2>&1; then
  running=$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep 'postgres:17' | cut -f1)
  if [ -n "$running" ]; then
    echo "  ok         Postgres already running ($running)"
    echo "             do NOT run 'npm run db:up' here — it will collide on port 5432"
  else
    echo "  note       no Postgres running; 'npm run db:up' is safe from this checkout"
  fi
else
  echo "  note       docker not on PATH; skipping the database check"
fi

echo
if [ "$status" -ne 0 ]; then
  echo "Worktree setup FAILED — see the messages above." >&2
else
  echo "Worktree ready. See the Worktrees section of CLAUDE.md for what this covers."
fi

exit "$status"
