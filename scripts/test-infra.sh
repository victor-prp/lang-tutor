#!/usr/bin/env bash
#
# Tests scripts/infra.sh (phase 30) with a stub terraform that records its
# arguments and a stub aws that answers what Lightsail is serving. No AWS, no
# Terraform install.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

# The state still says v2026.10.02 — a release that failed, so it never went
# live. infra.sh must not believe it.
cat > "$FIXTURE/terraform" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  *"output -raw image_tag"*) printf 'v2026.10.02'; exit 0 ;;
esac
exit 0
STUB
chmod +x "$FIXTURE/terraform"

# What Lightsail serves: STUB_LIVE holds the image of the current deployment,
# `None` for a service with no deployment, or is absent for no service at all.
# STUB_AWS_ERROR, when present, is an error the call fails with instead.
cat > "$FIXTURE/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
if [ -f "$STUB_AWS_ERROR" ]; then cat "$STUB_AWS_ERROR" >&2; exit 254; fi
if [ ! -f "$STUB_LIVE" ]; then
  echo "An error occurred (NotFoundException) when calling the GetContainerServices operation" >&2
  exit 254
fi
cat "$STUB_LIVE"
STUB
chmod +x "$FIXTURE/aws"

export TERRAFORM="$FIXTURE/terraform" AWS="$FIXTURE/aws" STUB_LOG="$FIXTURE/log" \
  STUB_LIVE="$FIXTURE/live" STUB_AWS_ERROR="$FIXTURE/aws-error"

run() { : > "$STUB_LOG"; (cd "$REPO" && bash scripts/infra.sh "$@") > /dev/null 2>&1; }
last_call() { tail -1 "$STUB_LOG"; }

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  checks=$((checks + 1))
  if [ "$expected" = "$actual" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s\n             expected: %s\n             actual:   %s\n' \
      "$label" "$expected" "$actual" >&2
    status=1
  fi
}

echo "Testing scripts/infra.sh"
echo

export TF_STATE_BUCKET=test-bucket

printf '123456789012.dkr.ecr.eu-central-1.amazonaws.com/wordspal:v2026.10.01\n' > "$STUB_LIVE"
run prod apply -auto-approve
expect_eq "an apply from the laptop keeps the tag Lightsail is serving, not the state's" \
  "-chdir=terraform/prod apply -input=false -var image_tag=v2026.10.01 -auto-approve" "$(last_call)"

IMAGE_TAG=v2026.10.08 run prod apply -auto-approve
expect_eq "the release's IMAGE_TAG wins over what Lightsail serves" \
  "-chdir=terraform/prod apply -input=false -var image_tag=v2026.10.08 -auto-approve" "$(last_call)"

IMAGE_TAG= run prod plan
expect_eq "an empty IMAGE_TAG is ignored, not deployed" \
  "-chdir=terraform/prod plan -input=false -var image_tag=v2026.10.01" "$(last_call)"

printf 'None\n' > "$STUB_LIVE"
run prod plan
expect_eq "a service with no deployment yet means no deployment" \
  "-chdir=terraform/prod plan -input=false -var image_tag=" "$(last_call)"

rm -f "$STUB_LIVE"
run prod plan
expect_eq "no service yet means no deployment" \
  "-chdir=terraform/prod plan -input=false -var image_tag=" "$(last_call)"

printf 'An error occurred (ExpiredToken) when calling the GetContainerServices operation\n' > "$STUB_AWS_ERROR"
checks=$((checks + 1))
if run prod apply -auto-approve; then
  printf '\n  FAIL       a failed Lightsail read is refused, not taken as no deployment\n' >&2; status=1
elif grep -q ' apply ' "$STUB_LOG"; then
  printf '\n  FAIL       a failed Lightsail read still reached terraform apply\n' >&2; status=1
else
  printf '  ok         a failed Lightsail read is refused, not taken as no deployment\n'
fi
rm -f "$STUB_AWS_ERROR"

run bootstrap plan -lock=false
expect_eq "bootstrap takes no image tag" \
  "-chdir=terraform/bootstrap plan -input=false -lock=false" "$(last_call)"

run prod plan
expect_eq "init names the bucket from TF_STATE_BUCKET" \
  "-chdir=terraform/prod init -input=false -reconfigure -backend-config=bucket=test-bucket" "$(head -1 "$STUB_LOG")"

run prod output -raw public_url
expect_eq "output passes its arguments through" \
  "-chdir=terraform/prod output -raw public_url" "$(last_call)"

checks=$((checks + 1))
if (cd "$REPO" && TF_STATE_BUCKET= bash scripts/infra.sh prod plan) > /dev/null 2>&1; then
  printf '\n  FAIL       a missing TF_STATE_BUCKET is refused\n' >&2; status=1
else
  printf '  ok         a missing TF_STATE_BUCKET is refused\n'
fi

checks=$((checks + 1))
if (cd "$REPO" && bash scripts/infra.sh staging plan) > /dev/null 2>&1; then
  printf '\n  FAIL       an unknown stack is refused\n' >&2; status=1
else
  printf '  ok         an unknown stack is refused\n'
fi

echo
if [ "$status" -ne 0 ]; then
  echo "infra.sh FAILED ($checks checks)" >&2
else
  echo "infra.sh ok ($checks checks)"
fi
exit "$status"
