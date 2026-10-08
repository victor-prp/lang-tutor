#!/usr/bin/env bash
#
# The one way Terraform runs against the two stacks under infra/ (phase 30, spec
# D7, D10): from the laptop, from CI's plan job, and from the release workflow.
#
#   scripts/infra.sh <bootstrap|prod> <init|plan|apply|output> [terraform args...]
#
# TF_STATE_BUCKET names the state bucket; it is passed at init, never committed.
#
# For prod, the image tag is resolved here and never typed: IMAGE_TAG when it is
# set and non-empty (the release workflow sets it), otherwise the tag of the last
# apply, read back from the state. Without that, an apply from the laptop, such
# as a domain or database toggle, would either drop the deployment or deploy a
# typed tag, and the next unrelated apply would undo a rollback.

set -u

cd "$(dirname "$0")/.." || exit 1

usage() { echo "usage: scripts/infra.sh <bootstrap|prod> <init|plan|apply|output> [terraform args...]" >&2; exit 2; }

stack="${1:-}"
cmd="${2:-}"
case "$stack" in bootstrap | prod) ;; *) usage ;; esac
case "$cmd" in init | plan | apply | output) ;; *) usage ;; esac
shift 2

if [ -z "${TF_STATE_BUCKET:-}" ]; then
  echo "infra.sh: set TF_STATE_BUCKET to the state bucket (docs/runbooks/hosting.md)" >&2
  exit 1
fi

TERRAFORM="${TERRAFORM:-terraform}"
dir="infra/$stack"

"$TERRAFORM" -chdir="$dir" init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET" > /dev/null || exit 1
[ "$cmd" = init ] && exit 0
[ "$cmd" = output ] && exec "$TERRAFORM" -chdir="$dir" output "$@"

if [ "$stack" = prod ]; then
  if [ -n "${IMAGE_TAG:-}" ]; then
    tag="$IMAGE_TAG"
  else
    tag=$("$TERRAFORM" -chdir="$dir" output -raw image_tag 2> /dev/null || true)
  fi
  echo "infra.sh: prod image_tag=${tag:-<none, no deployment>}" >&2
  exec "$TERRAFORM" -chdir="$dir" "$cmd" -input=false -var "image_tag=$tag" "$@"
fi

exec "$TERRAFORM" -chdir="$dir" "$cmd" -input=false "$@"
