# Hosting runbook

Production is `https://app.wordspal.ai`: one Lightsail container in `eu-central-1` running
the image a `v*` tag built, against one Lightsail Postgres. Everything in AWS is Terraform
under `terraform/`, run only through `scripts/infra.sh`. Design:
[phase 30](../superpowers/specs/2026-10-08-lang-tutor-phase-30-hosting-design.md).

## Go-live, once

Run from the main checkout on `master`, after phase 30 has merged. Each step says what it
proves before the next one starts.

1. **Tools and credentials.** `brew install awscli` and
   `brew tap hashicorp/tap && brew install hashicorp/tap/terraform` (1.16 or later 1.x). Sign
   in with credentials that may administer the account (`aws configure sso`, or an access
   key), then `aws sts get-caller-identity` names your account.
2. **The state bucket**, the one resource made by hand:

   ```bash
   export AWS_REGION=eu-central-1
   export TF_STATE_BUCKET="wordspal-tfstate-$(aws sts get-caller-identity --query Account --output text)"
   aws s3api create-bucket --bucket "$TF_STATE_BUCKET" --region eu-central-1 \
     --create-bucket-configuration LocationConstraint=eu-central-1
   aws s3api put-bucket-versioning --bucket "$TF_STATE_BUCKET" --versioning-configuration Status=Enabled
   aws s3api put-public-access-block --bucket "$TF_STATE_BUCKET" --public-access-block-configuration \
     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```

   S3 encrypts every new object by default. The state holds the database password.
3. **What Lightsail offers today.** If either answer differs from `terraform/prod/variables.tf`
   (`postgres_17`, `micro_2_0`), change the default in a commit before step 6:

   ```bash
   aws lightsail get-relational-database-blueprints --region eu-central-1 \
     --query "blueprints[?engine=='postgres'].[blueprintId,engineVersion]" --output table
   aws lightsail get-relational-database-bundles --region eu-central-1 \
     --query "bundles[?isActive].[bundleId,price,ramSizeInGb]" --output table
   ```

   Take the Postgres major that `docker-compose.yml` and CI run (17), not simply the newest
   one, and the 15-dollar bundle.
4. **The production Gemini key**, a new one, not your laptop's:

   ```bash
   read -rs KEY && aws secretsmanager create-secret --region eu-central-1 \
     --name wordspal/prod/GEMINI_API_KEY --secret-string "$KEY"; unset KEY
   ```
5. **Bootstrap**: `TF_VAR_state_bucket="$TF_STATE_BUCKET" ./scripts/infra.sh bootstrap apply`.
   It prints the two role ARNs and the repository URL.
6. **GitHub variables** (variables, not secrets: none of these is secret):

   ```bash
   gh variable set TF_STATE_BUCKET --body "$TF_STATE_BUCKET"
   gh variable set AWS_RELEASE_ROLE_ARN --body "$(./scripts/infra.sh bootstrap output -raw release_role_arn)"
   gh variable set AWS_PLAN_ROLE_ARN --body "$(./scripts/infra.sh bootstrap output -raw plan_role_arn)"
   gh variable set ALERT_EMAIL --body "<your address>"
   ```

   `GEMINI_MODEL` exists already; the eval job uses it, and production runs the same model.
   The next push's `terraform-plan` job now plans instead of skipping.
7. **Prod, without a deployment**:

   ```bash
   export TF_VAR_gemini_model="$(gh variable get GEMINI_MODEL)" TF_VAR_alert_email="<your address>"
   ./scripts/infra.sh prod apply
   ```

   About fifteen minutes, mostly the database. `image_tag=<none, no deployment>` is expected.
8. **The certificate's validation record at GoDaddy.**
   `./scripts/infra.sh prod output certificate_validation` prints a CNAME. At GoDaddy → DNS →
   Add record: type CNAME, name is the record name without the trailing `.wordspal.ai.`, value
   as printed. Then wait for:

   ```bash
   aws lightsail get-certificates --region eu-central-1 --certificate-name wordspal-app \
     --query 'certificates[0].certificateDetail.status' --output text   # ISSUED
   ```
9. **The database stays reachable from the laptop.** `publicly_accessible` defaults to `true`:
   Lightsail cannot limit a database by IP, so the generated password and `verify-full` TLS are
   all that guard it, and the password lives only in the Terraform state. To connect:

   ```bash
   curl -fsSo "$TMPDIR/rds-global-bundle.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   export PROD_DB="$(./scripts/infra.sh prod output -raw database_url \
     | sed "s#/app/certs/rds-global-bundle.pem#$TMPDIR/rds-global-bundle.pem#")"
   psql "$PROD_DB"
   ```

   The first container start migrates and seeds the database, so nothing has to run from the
   laptop first. Loading the checked-in dictionary (spec D14) is optional; without it the
   dictionary starts empty and fills as words are looked up. `DATABASE_URL="$PROD_DB" npm run
   dict:restore` migrates, then loads it in about two minutes, and a rerun is harmless. The next
   container start re-stamps the database comment the restore wrote from your laptop's lane.

   A restore carries no gloss merge: it rebuilds the glosses from the renderings, so follow it
   with both tiers of the merge tool (README, *Backing the dictionary up*):

   ```bash
   DATABASE_URL="$PROD_DB" npm run dict:glosses:merge               # tier 1
   DATABASE_URL="$PROD_DB" npm run dict:glosses:merge -- --model    # tier 2, one model call per headword
   ```

   Each prints its plan and changes nothing until run again with `--yes` added (`-- --yes`,
   `-- --model --yes`). Even the dry run migrates the database first, as `dict:restore` does.
10. **The first release.** Merge, pull, test master locally, then
    `tag=v$(date +%Y.%m.%d); git tag "$tag" && git push origin "$tag"`. The Release workflow waits for CI,
    builds, pushes, applies, and checks `/health` on the service's default address (the domain
    is not attached yet). On that address only `/health` is meaningful: the web export calls
    `https://app.wordspal.ai`.
11. **The domain.** In a commit on a branch, set `attach_domain`'s default to `true` in
    `terraform/prod/variables.tf`; merge it. Then `./scripts/infra.sh prod apply` from the main
    checkout (it keeps the live tag), and at GoDaddy add CNAME `app` →
    `./scripts/infra.sh prod output -raw app_cname_target`.
12. **Done means.** Open `https://app.wordspal.ai` on a phone's browser, sign up, save a word.
    `curl https://app.wordspal.ai/health` names the tag. `npm run mobile:prod` on the phone
    reaches production. The next day, with the laptop closed, the word is still there.

## Releasing

Merge, pull, test master locally, then `npm run release`. It tags HEAD with the next
`vYYYY.MM.DD` (a second release that day is `.2`, then `.3`) and pushes it, after checking that
you are on `master` and level with `origin/master` and that HEAD is not released already.
Merging alone deploys nothing.

A red Release run leaves the previous deployment serving: Lightsail switches only to a
container whose `/health` passes. The next `./scripts/infra.sh prod apply` from the laptop
keeps that one too, because the script asks Lightsail which tag it serves rather than trusting
the state; `IMAGE_TAG=<tag>` in front of it overrides that. Read the failing step first; a migration failure shows in
the container log (below).

## Rolling back

`npm run rollback` reruns the Release workflow from the release before the newest tag;
`npm run rollback -- <tag>` from the one you name. After one rollback the newest tag is no
longer live, so name the tag for the next. Both call `gh workflow run release.yml --ref <tag>`,
which also works by hand, as does Actions → Release → Run workflow → pick the tag. The image exists, so this is one apply, one to two minutes. Only the image goes back:
the workflow applies master's `terraform/`, so the domain, the budget and every secret stay as they
are now. Rolling back past a
migration does not undo the migration; ADR 0010 says why additive migrations make that safe.

## Reading the container's log

```bash
aws lightsail get-container-log --region eu-central-1 --service-name wordspal --container-name app \
  --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)" --query 'logEvents[].message' --output text
```

## Changing a secret

`aws secretsmanager put-secret-value --region eu-central-1 --secret-id wordspal/prod/<NAME> --secret-string ...`,
then `./scripts/infra.sh prod apply`: the environment changed, so Terraform creates a new
deployment of the live tag.

## Behind Lightsail's proxy

Lightsail terminates TLS and forwards plain HTTP to the container on port 8080. The client's
address arrives in `X-Forwarded-For`; the container never sees it directly. Phase 29's rate
limiter needs exactly that fact when it is switched on.

## When phase 29 merges

Phase 29's PR carries its `terraform/prod` entries: `BETTER_AUTH_SECRET` and `RESEND_API_KEY`
in `secret_env_names`, and `AUTH_BASE_URL`, `WEB_ORIGINS` (both `https://app.wordspal.ai`)
and `MAIL_FROM` in the environment map. A plan reads every secret it names, so its
`terraform-plan` job stays red until both secrets exist, and the release guard refuses a
commit whose `terraform-plan` is red. The secrets therefore come before the merge:

1. **Resend.** Add the domain `wordspal.ai` and put the SPF and DKIM records it shows
   into GoDaddy's DNS; optionally a `_dmarc` TXT record with `p=none`. Create an API key
   restricted to sending on that domain.
2. **Both secrets**, as in go-live step 4:

   ```bash
   KEY="$(openssl rand -base64 32)" && aws secretsmanager create-secret --region eu-central-1 \
     --name wordspal/prod/BETTER_AUTH_SECRET --secret-string "$KEY"; unset KEY
   read -rs KEY && aws secretsmanager create-secret --region eu-central-1 \
     --name wordspal/prod/RESEND_API_KEY --secret-string "$KEY"; unset KEY
   ```

   Then re-run the PR's `terraform-plan` job; it goes green once it can read both.
3. **Merge, then release.** Phase 29's migrations run on that container's start (ADR 0010),
   and every learner already in production gets an unclaimed placeholder identity. That
   release closes the exposure window the phase 30 design describes.
4. **Claim the accounts that predate sign-in**, each before anyone signs in with its address
   on production, with `PROD_DB` from go-live step 9:

   ```bash
   DATABASE_URL="$PROD_DB" npm run db:claim-account -- --username <name> --email <address>
   ```

Still open after that release: Better Auth's rate limiter (`storage: 'database'`,
`trustedProxies` for the proxy above) and a per-IP limit on sending codes, which ADR 0009
lists as its remaining obligations. Until they land, the limits are 3 tries per code and 5
codes per address per hour.
