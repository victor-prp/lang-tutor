#!/usr/bin/env bash
#
# Tests scripts/infra.sh (phase 30) with a stub terraform that records its
# arguments. No AWS, no Terraform install.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

cat > "$FIXTURE/terraform" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  *"output -raw image_tag"*)
    if [ -f "$STUB_TAG" ]; then cat "$STUB_TAG"; exit 0; fi
    exit 1 ;;
esac
exit 0
STUB
chmod +x "$FIXTURE/terraform"

export TERRAFORM="$FIXTURE/terraform" STUB_LOG="$FIXTURE/log" STUB_TAG="$FIXTURE/tag"

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

printf 'v2026.10.01' > "$STUB_TAG"
run prod apply -auto-approve
expect_eq "an apply from the laptop keeps the tag the state says is live" \
  "-chdir=infra/prod apply -input=false -var image_tag=v2026.10.01 -auto-approve" "$(last_call)"

IMAGE_TAG=v2026.10.08 run prod apply -auto-approve
expect_eq "the release's IMAGE_TAG wins over the state" \
  "-chdir=infra/prod apply -input=false -var image_tag=v2026.10.08 -auto-approve" "$(last_call)"

IMAGE_TAG= run prod plan
expect_eq "an empty IMAGE_TAG is ignored, not deployed" \
  "-chdir=infra/prod plan -input=false -var image_tag=v2026.10.01" "$(last_call)"

rm -f "$STUB_TAG"
run prod plan
expect_eq "no state yet means no deployment" \
  "-chdir=infra/prod plan -input=false -var image_tag=" "$(last_call)"

run bootstrap plan -lock=false
expect_eq "bootstrap takes no image tag" \
  "-chdir=infra/bootstrap plan -input=false -lock=false" "$(last_call)"

run prod plan
expect_eq "init names the bucket from TF_STATE_BUCKET" \
  "-chdir=infra/prod init -input=false -reconfigure -backend-config=bucket=test-bucket" "$(head -1 "$STUB_LOG")"

run prod output -raw public_url
expect_eq "output passes its arguments through" \
  "-chdir=infra/prod output -raw public_url" "$(last_call)"

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
