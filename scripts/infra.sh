#!/usr/bin/env bash
#
# The one way Terraform runs against the two stacks under terraform/ (phase 30, spec
# D7, D10): from the laptop, from CI's plan job, and from the release workflow.
#
#   scripts/infra.sh <bootstrap|prod> <init|plan|apply|output> [terraform args...]
#
# TF_STATE_BUCKET names the state bucket; it is passed at init, never committed.
#
# For prod, the image tag is resolved here and never typed: IMAGE_TAG when it is
# set and non-empty (the release workflow sets it), otherwise the tag Lightsail
# is serving right now. Not the state's: a release whose container never became
# healthy leaves its tag in the state while Lightsail keeps the previous one,
# and every later apply would retry the broken image. Without this, an apply
# from the laptop, such as a domain or database toggle, would either drop the
# deployment or deploy a typed tag, and would undo a rollback.
#
# A failed read of Lightsail (expired credentials, a network error) stops the
# run. Only "no such service" means there is no deployment yet.

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
AWS="${AWS:-aws}"
dir="terraform/$stack"

# The tag of the image Lightsail's current deployment runs, or nothing when
# there is no service or no deployment yet. The service name is infra/prod's
# service_name default.
live_tag() {
  local image errors
  errors=$(mktemp)
  if ! image=$("$AWS" lightsail get-container-services --region "${AWS_REGION:-eu-central-1}" \
    --service-name wordspal --output text \
    --query 'containerServices[0].currentDeployment.containers.app.image' 2> "$errors"); then
    if grep -q 'NotFoundException' "$errors"; then
      rm -f "$errors"
      return 0
    fi
    echo "infra.sh: could not read what Lightsail is serving:" >&2
    cat "$errors" >&2
    rm -f "$errors"
    return 1
  fi
  rm -f "$errors"
  case "$image" in '' | None) return 0 ;; esac
  printf '%s' "${image##*:}"
}

"$TERRAFORM" -chdir="$dir" init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET" > /dev/null || exit 1
[ "$cmd" = init ] && exit 0
[ "$cmd" = output ] && exec "$TERRAFORM" -chdir="$dir" output "$@"

if [ "$stack" = prod ]; then
  if [ -n "${IMAGE_TAG:-}" ]; then
    tag="$IMAGE_TAG"
  else
    tag=$(live_tag) || exit 1
  fi
  echo "infra.sh: prod image_tag=${tag:-<none, no deployment>}" >&2
  exec "$TERRAFORM" -chdir="$dir" "$cmd" -input=false -var "image_tag=$tag" "$@"
fi

exec "$TERRAFORM" -chdir="$dir" "$cmd" -input=false "$@"
