#!/usr/bin/env bash
#
# Builds the production image (phase 30, spec D2) for a local or CI run.
#
# The release builds the same Dockerfile with no EXPO_PUBLIC_API_URL argument,
# so its web export reads apps/mobile/.env.production. This build sets it to the
# address the container will answer on here: a test build that called
# https://app.wordspal.ai would be testing production, not the image.
#
# Runs under scripts/lane-env.sh. IMAGE_API_URL defaults to this lane's server;
# IMAGE defaults to lang-tutor:<lane>, so two lanes never overwrite each other.

set -u

cd "$(dirname "$0")/.." || exit 1
: "${LANE:?run this through scripts/lane-env.sh, for example npm run image:build}"
IMAGE="${IMAGE:-lang-tutor:$LANE}"
IMAGE_API_URL="${IMAGE_API_URL:-http://localhost:$PORT}"

exec docker build \
  --build-arg "EXPO_PUBLIC_API_URL=$IMAGE_API_URL" \
  --build-arg "APP_VERSION=${APP_VERSION:-dev}" \
  -t "$IMAGE" .
