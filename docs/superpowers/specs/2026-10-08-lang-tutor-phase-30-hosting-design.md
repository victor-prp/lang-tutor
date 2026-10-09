# Phase 30 — Hosting at app.wordspal.ai

- **Status:** Designed on 2026-10-08. Victor scoped the phase in the one-pager, then approved the
  design in conversation section by section: the image (§1 of the talk, D1–D3 here), startup and
  the single-container ADR (D4, D5), the release workflow (D6–D9), the one-time setup as Terraform
  (D10–D14), the server and repo changes (§2), testing (§3) and the phase 29 hand-over (§4). Three
  choices were revised during the talk at his request and are recorded as decided, not as
  alternatives: Terraform owns the deployment (D7), the image lives in a private ECR repository
  (D8), and secrets live in Secrets Manager (D12).
- **Date:** 2026-10-08
- **Source:** the one-pager `drafts/2026-10-08-hosting-one-pager.md`. `drafts/` is gitignored, so
  everything this spec depends on is restated below.
- **Builds on:** phase 3 (CI, which deferred deployment), phase 15 (lanes, ADR 0006), phase 19
  (pg-boss in the server process, ADR 0007), and phase 29 (sign-in), which is in flight on its
  own branch and names "the hosting phase" as the owner of four obligations; see §4.
- **Touches:** a Dockerfile and a server build. An optional static-file handler and a version field
  on `/health`. The web export's output mode and the mobile env files. Two Terraform stacks under
  `infra/`, a release workflow, two new CI jobs, an e2e target. A new ADR 0010 with its check
  script. No table, no endpoint, no change to any use case.

---

## Goal

The server runs on Victor's laptop on a LAN address, so the app works only while the laptop is on
and the learner is on the same Wi-Fi. After this phase anyone with the link opens
`https://app.wordspal.ai` in a browser, signs up, and uses the app without Victor's help; the
laptop can be closed for a day and nothing stops.

Done means, in Victor's words from the one-pager, with the one rewording he agreed to after
choosing fresh data (D14):

1. With Victor's laptop closed for a day, `app.wordspal.ai` still works, and the words a learner
   saved on it are still there.
2. A deploy is one explicit action, taken after Victor has merged to master and tested it locally,
   with no manual steps on a box. Merging alone deploys nothing.
3. The previous version can be put back with the same kind of action.

## Scope

**In:** the server answers at `app.wordspal.ai`; the web build is a product surface, served from
the same host; open sign-up as the code provides it; the hosted environment is what phase 29's
obligations assume (HTTPS, a proxy, a secret store); Expo Go on a phone can target either the lane
server or production.

**Out** (from the one-pager):

- Standalone Android or iPhone builds; Expo Go stays the native path.
- Spending protection: the per-IP limits phase 29 deferred, and any per-account Gemini cap.
- Monitoring, alerting, error tracking, uptime checks. (A billing alert is in, D13; it is a guard
  on the bill, not monitoring of the app.)
- A staging environment. The check after merge is a local run against a local database, so it
  catches code regressions and not production configuration or data problems. Known gap.
- A prod branch, rejected in discussion twice: once against tags (D6), once when Terraform took
  over the deployment (D7). A release names a master commit; nothing else needs a second ref.
- Migrating the laptop's data. Production starts fresh (D14).

**Answers that fixed the design**, from the scoping talk and brainstorming:

| Question | Answer |
|---|---|
| For whom | Anyone with the link; open sign-up; no app store yet |
| Smallest version | Server plus a usable web build in the browser |
| Host | AWS, because the account exists. Lightsail: 10 $/month Micro container, 15 $/month database |
| Domain | DNS stays at GoDaddy. The app is `app.wordspal.ai`; the apex is deliberately not the app |
| Data | Fresh. The checked-in en-he dictionary is loaded once, for cost, not for continuity |
| Timing | Host now, open, before phase 29 merges; see §4 for the window |
| Release | Push a `v*` tag on a master commit, after testing master locally |
| Infrastructure | Terraform, owning the deployment too; secrets in AWS Secrets Manager |

## 1. Decisions

**D1. One container, one process.** The Hono process serves the API, runs the pg-boss workers
as today, and serves the static web export from the same host. `app.wordspal.ai/` is the app and
`app.wordspal.ai/api/...` is the API. Alternatives weighed: the web export on a Lightsail
distribution with the API on `api.wordspal.ai` (two targets, CORS in production, and phase 29's
cookie would become cross-subdomain for nothing); a Lightsail VM with Docker Compose (the VPS
route Victor declined). The single host is the only shape in which phase 29's session cookie
works unchanged, because page and API share an origin.

**D2. The image.** One root `Dockerfile`, three stages. *Build:* `npm ci` for the monorepo; the web
export by `expo export -p web` (production mode, which reads the committed `.env.production`,
D3); the server by esbuild, two entries (`src/index.ts` and `src/db/cli.ts`) bundled into
`dist/` with workspace code (`@lang-tutor/core`) inlined and third-party packages external; the
migrations folder copied next to the bundle, since `migrate.ts` finds it relative to the running
file. *Runtime:* the Node 24 image pinned to `.nvmrc`'s major, `npm ci --omit=dev`, the bundle,
the migrations, the web export under `/app/web`, and the entrypoint (D4). No TypeScript tooling,
Expo or tsx in the final image. An `APP_VERSION` build argument carries the release tag. The same
image runs on the laptop against the lane's Postgres (§3).

**D3. The hosted URL is written once, in `apps/mobile/.env.production`.** Expo loads env files by
mode: development mode (`expo start`) reads `.env.development.local`, `.env.local`,
`.env.development`, `.env`; production mode (`expo start --no-dev`, and always `expo export`)
reads `.env.production.local`, `.env.local`, `.env.production`, `.env`. Under Metro the value
comes only from these files, never from the shell (measured in the e2e design, confirmed in
`@expo/env` and `@expo/cli`). `.env.local` outranks `.env.production` in both lists, so the lane
URL moves from `.env.local` to `.env.development.local`, which production mode never reads. Then:

- `npm run mobile` is development mode and reads the lane URL, as today.
- `npm run mobile:prod` is `expo start --no-dev`, reads `.env.production`, and points Expo Go on a
  phone at `https://app.wordspal.ai`. It serves a production-style bundle: minified, no Fast
  Refresh. Expo's docs discourage faking the mode with `NODE_ENV` to keep dev tooling; we do not.
- The Docker build's `expo export` reads `.env.production` and needs no build argument for the
  URL. The build context has no `.env*.local` (`.dockerignore`).
- The e2e suite is unaffected: it overrides the URL in the shell at export time, which Expo
  honours, and it never read `.env.local`.

**D4. The entrypoint migrates, then serves.** `node dist/cli.js && node dist/index.js`. The first
is the same code `npm run db:migrate` runs today: ensure the database exists, apply migrations,
install the pg-boss schema, seed shared content. Against Lightsail the database already exists,
so the create step finds it and moves on; whether the master user may stamp the lane comment is
verified in the first task and, if not, that comment becomes best-effort. The server listens only
after migration succeeds. Lightsail's health check polls `/health`, so a failed migration never
becomes healthy, the deployment is marked failed, and the previous one keeps serving. Shutdown is
the existing SIGTERM path: HTTP first, pg-boss drains up to 30 s, pool last.

**D5. ADR 0010: migrations run inside the single production container.** Production is one
container at scale 1, and that container migrates on start. The decision holds while there is one
copy; wanting a second copy first moves migrations to a step that runs once before any container
starts, under a new ADR that supersedes this one. Reasoning: with one copy nothing races; the
database is private, so no outside job can reach it; a release stays one artifact. Accepted cost,
written in the ADR: during a rollout the old container serves for about a minute after the new one
has migrated, so a migration that drops or renames something the old code reads errors for that
minute. Additive migrations, Drizzle's default, are unaffected. The check script
`scripts/check-adr-0010-single-container.sh` fails if `infra/prod` sets a scale other than 1, or
if the Dockerfile's start command runs the server without the migrate step in front of it. Both
violations are planted before the script is trusted, per CLAUDE.md.

**D6. A release is a pushed tag matching `v*` on a master commit.** Suggested scheme
`v2026.10.08`, `v2026.10.08.2` for a second one that day: readable in a bug report, no
bookkeeping. The workflow does not depend on the scheme. Two guards run before anything is built:
the tagged commit is an ancestor of `origin/master` (`git merge-base --is-ancestor`), and the
commit's CI run concluded `success` (GitHub API). A tag on a branch or on a red commit fails in
seconds without touching AWS. Rollback is the same workflow run by hand (`workflow_dispatch`) with
an earlier tag. A prod branch was rejected: it is a second long-lived ref to keep in sync, it
records nothing a tag on the commit does not, and rolling it back is a revert or a force-push.

**D7. Terraform owns the deployment.** `release.yml` builds and pushes the image, then runs
`terraform apply -var image_tag=<tag>` in `infra/prod`, which creates a new
`aws_lightsail_container_service_deployment_version`. Lightsail rolls it out; the workflow polls
the service until the deployment is active and then checks `/health`. Consequences, all wanted:
every deployment is in state; a console-made deployment shows as drift at the next plan; infra
changes merge to master and go live on the next release apply, together with the code; rollback is
an apply pointing at an image that already exists, one to two minutes, nothing rebuilt. The
deployment resource is created only when `image_tag` is non-empty, so the first apply from the
laptop builds infrastructure with no deployment and the first tag creates the first one. The
provider cannot delete a deployment version; removing the resource only forgets it, which is fine.

**D8. The image lives in a private Amazon ECR repository.** The repository is public today and
becomes private soon, so the image is private from day one and the flip touches nothing. Lightsail
pulls from a private ECR repository through its *ECR image puller role*: the container service
enables it, and the repository policy grants that role pull access; both are Terraform. The image
is `<account>.dkr.ecr.<region>.amazonaws.com/wordspal:<tag>`, deterministic from the tag, which is
what makes D7's rollback a plain apply. A lifecycle rule keeps the last twenty tags. Cost is well
under a dollar a month. Lightsail's own registry was rejected because its image labels are
generated at push time, so a rollback would have to look one up or rebuild; GitHub's registry was
rejected because Lightsail cannot authenticate to it and a public image of private code is not
acceptable.

**D9. GitHub reaches AWS through OIDC, with two roles.** No long-lived AWS keys in GitHub. The
*release role* trusts this repository on `refs/tags/v*` only and may: push to the one ECR
repository, read and write the state bucket and its lock, read the `wordspal/prod/*` secrets,
manage Lightsail resources, and manage the budget. The *plan role* trusts `refs/heads/*` of this
repository and is read-only, including `GetSecretValue` on the same prefix, because a plan
resolves data sources. Terraform marks those values sensitive in output. Only Victor pushes
branches here, but this is the one place a branch push touches production credentials; see Risks.
Role ARNs and the region are GitHub *variables*, not secrets; they are not secret.

**D10. Two Terraform stacks.** `infra/bootstrap`, applied once from the laptop with Victor's own
credentials: the encrypted, non-public S3 state bucket with locking, the OIDC identity provider,
the two roles, the ECR repository and its lifecycle rule. `infra/prod`, applied by the release
workflow and by Victor from the laptop when needed, both against the same remote state: the
database, the container service, the certificate and domain binding, the budget alert, the
deployment version, and data sources for the secrets. Provider and Terraform versions are pinned.
The bootstrap stack's own state is local to the laptop and tiny; it holds no secret.

**D11. The Lightsail resources.** One region for everything, Frankfurt (`eu-central-1`), the
closest Lightsail region to most learners. Database: managed PostgreSQL, the 15 $/month plan
(1 GB, 40 GB, daily snapshots included), the newest major Lightsail offers at apply time (the
runbook has `get-relational-database-blueprints`; 16 as far as the docs say, see Risks),
`publicly_accessible = false`, database `lang_tutor`, a `random_password` master password held in
state and exposed as a sensitive output. Container service `wordspal`: power `micro` (0.25 vCPU,
1 GB; `nano`'s 512 MB is tight for Node plus pg-boss), scale 1 (D5), public endpoint on container
`app` port 3001 with health path `/health`, ECR puller role active (D8), and `public_domain_names`
bound to the certificate once validated. Certificate: `aws_lightsail_certificate` for
`app.wordspal.ai`; its validation CNAME is a Terraform output that Victor adds at GoDaddy; a
second apply attaches the domain. Lightsail terminates TLS; the container speaks plain HTTP on
3001.

**D12. Secrets in AWS Secrets Manager.** One secret per value under `wordspal/prod/`:
`GEMINI_API_KEY` and, when phase 29 merges, `BETTER_AUTH_SECRET` and `RESEND_API_KEY`. Written
once with the CLI, never in the repo or in GitHub. `GEMINI_MODEL` is not a secret and is a plain
Terraform variable with a committed default. `infra/prod` reads
each with `data.aws_secretsmanager_secret_version` and places it in the deployment's environment,
so copies exist in the deployment configuration and in the encrypted state, which is the standard
arrangement for this pipeline. Parameter Store was the first pick (free, same mechanics); Victor
chose Secrets Manager for the convention, at about 2 $/month for the handful of values. Rotation
is not configured: a Lightsail deployment reads its environment at deploy time, so a rotated value
needs a release anyway. Production gets its own Gemini key, separate from the laptop's, so a limit
or a leak on one does not touch the other. Non-secret environment: `DATABASE_URL` (built in
Terraform from the database's endpoint and the master password), `PORT=3001`, `LANE=prod` so
`/health` says where it is, `PG_POOL_MAX`, `WEB_DIST_DIR=/app/web`, `APP_VERSION` (also baked into
the image; the environment value is the one `/health` reports).

**D13. A billing alert.** `aws_budgets_budget`, 40 $/month, email to Victor. A guard on the bill,
not monitoring. Victor accepted it as assumed.

**D14. Fresh data, with the dictionary loaded once.** No learner, word or progress moves from the
laptop; Victor chose this over copying lane 0. The checked-in en-he dictionary is loaded once
because it is free and saves paid Gemini calls on common words. Mechanism: flip
`publicly_accessible` to true in `infra/prod` and apply; from the laptop run the existing
`dict:restore` with the production `DATABASE_URL` (the CLI migrates first, then imports, about two
minutes; `persistEntries` is first-writer-wins, so a rerun is harmless); flip back and apply. The
runbook covers the TLS parameter the connection needs. Nothing runs in the container for this.

**D15. The web export is a single page.** `app.json`'s `web.output` changes from `static` (one
HTML file per route) to `single` (one `index.html`, routing in the browser). The app sits behind
sign-in and has no pages to index, so per-route HTML buys nothing, and a plain server fallback to
`index.html` is then correct for every deep link. The e2e export uses the same setting, so the
suite exercises it.

## 2. Changes

### Server

- `src/config.ts`: `Config` gains `version: string` (`APP_VERSION`, default `dev`) and
  `webDistDir: string | undefined` (`WEB_DIST_DIR`, unset means no static serving). Pure
  function of its argument, as now.
- `src/index.ts`: passes `version` into `identity` and `webDistDir` into `createApp`'s deps.
- `src/app.ts`: when `webDistDir` is set, after every existing route (`/api/*`, `/health`,
  `/openapi.json`, `/docs`), `serveStatic` from `@hono/node-server/serve-static` rooted at it,
  then a fallback that answers any remaining `GET` with its `index.html`. Static routes are not
  `createRoute`s and do not appear in the OpenAPI document (ADR 0003 governs the API, and these
  are not API). `/health` publishes `version` beside `lane`, `database`, `port` and `ok`.
- `packages/core/src/api/schemas.ts`: the health response schema gains `version`.
- `scripts/build.mjs` (new, in `apps/server`) and `npm run build -w apps/server`: esbuild,
  platform node, format cjs, two entries, `external` derived from `apps/server/package.json`
  dependencies minus `@lang-tutor/core`, output `dist/`, then copy `src/db/migrations` to
  `dist/migrations`. `esbuild` joins devDependencies, pinned. `dist/` is already gitignored.
  `tsx` stays for `dev` and `start`, so nothing in development or in the e2e suite changes.

### Mobile

- `apps/mobile/.env.production` (new, committed): `EXPO_PUBLIC_API_URL=https://app.wordspal.ai`.
- `.env.local` → `.env.development.local`; `.env.example` → `.env.development.example` with the
  same comment, updated. `scripts/setup-worktree.sh` writes the new name; `scripts/lane-env.sh`'s
  `api_host()` reads it. `.gitignore`'s `.env*.local` already covers the new name.
- `package.json`: `"start:prod": "expo start --no-dev --port ${METRO_PORT:-8081}"`; root
  `"mobile:prod": "bash scripts/lane-env.sh npm run start:prod --workspace apps/mobile"`.
- `app.json`: `"web": { "output": "single", ... }` (D15).

### Repository root

- `Dockerfile`, `.dockerignore` (node_modules, `.env*.local`, `drafts/`, `.claude/`, `e2e/`,
  `nightly-qa/`, test results, `dist/`).
- `package.json`: `"image:build": "docker build --build-arg APP_VERSION=${APP_VERSION:-dev} -t lang-tutor:dev ."`
  and `"image:run": "bash scripts/lane-env.sh bash scripts/image-run.sh"`. `scripts/image-run.sh`
  runs the image on the lane's `PORT` with the lane's `DATABASE_URL` host rewritten to
  `host.docker.internal`, `GEMINI_BASE_URL` pointed at MockServer the same way, `WEB_DIST_DIR`,
  `LANE`, and `APP_VERSION=dev`. No port or database name is written down (ADR 0006).
- `.github/workflows/release.yml` (new): `on: push: tags: ['v*']` and `workflow_dispatch` with a
  `tag` input. Jobs: `guard` (ancestor of master; CI success for the commit), `build-push` (OIDC
  → release role; ECR login; `docker build --build-arg APP_VERSION=$TAG`; push), `apply`
  (`terraform init` with the remote backend, `terraform apply -auto-approve -var image_tag=$TAG`
  in `infra/prod`), `verify` (poll `get-container-services` until the deployment is `ACTIVE`;
  `curl https://app.wordspal.ai/health` must return `ok: true` and `version: $TAG`; fail
  otherwise). `permissions: id-token: write, contents: read`. Concurrency group `release`,
  no cancel: two releases queue.
- `.github/workflows/ci.yml`: trigger narrowed to `push: branches: ['**']` so tags do not re-run
  the suite. Two new jobs: `build-image` (build the image; `npm run db:up`; run the container
  against the compose Postgres and MockServer; `E2E_TARGET=image npm run e2e`) and
  `terraform-plan` (OIDC → plan role; `terraform fmt -check`, `validate`, `plan` in both stacks;
  the plan is read-only and its output is in the job log). Both guarded by
  `github.repository_owner == 'victor-prp'` like `test-eval`, since forks have no OIDC trust.
- `e2e/playwright.config.ts`: an `image` target. When `E2E_TARGET=image`, one `webServer` entry
  replaces the two: `scripts/image-run.sh` with the e2e lane values, `url` the health endpoint,
  and `APP_URL === API_URL`. The default target is unchanged. `e2e/urls.ts` derives `APP_URL`
  from the target.
- `scripts/check-adr-0010-single-container.sh` (D5) and `scripts/check-dockerfile-node.sh`
  (the Dockerfile's `FROM node:<major>` equals `.nvmrc`), the second run from the `check-adrs`
  job beside the lane tests. `check-adrs.sh` discovers the first by name.
- `infra/bootstrap/` and `infra/prod/` (D10), each with `versions.tf`, `main.tf`, `variables.tf`,
  `outputs.tf`, a `README.md` of three lines pointing at the runbook; `infra/prod/backend.tf`
  names the bucket. `infra/prod` variables: `image_tag` (default `""`), `publicly_accessible`
  (default `false`), `attach_domain` (default `false`, flipped after certificate validation).
- `docs/adr/adr-0010-single-container-migrations.md` (D5), via the `create-adr` skill.
- `docs/runbooks/hosting.md` (new): the go-live order and every command, in this order: write the
  secrets; bootstrap apply; prod apply; add the certificate's validation CNAME at GoDaddy; prod
  apply with `attach_domain = true`; add the `app` CNAME at GoDaddy pointing at the service's
  default hostname (an output); the dictionary load (D14); set the GitHub variables; push the first
  tag; open `https://app.wordspal.ai`. Plus: rollback, reading logs (`get-container-log`),
  rotating a secret (write it, release), and what `X-Forwarded-For` looks like behind Lightsail
  (§4).
- `README.md`: the image and `image:run`; the two Expo Go modes; releasing and rolling back; a
  pointer to the runbook. The "must not reach a public host in this state" paragraph is replaced
  by a reference to §4's window and phase 29.

## 3. Testing

### Unit

- `config.test.ts`: `version` defaults to `dev` and reads `APP_VERSION`; `webDistDir` is undefined
  when unset and trimmed when set.
- `app.test.ts`: with a temp `webDistDir` holding `index.html` and `assets/x.js`: `GET /` serves
  `index.html`; `GET /assets/x.js` serves the file with a JavaScript content type; `GET /session`
  (an app route) serves `index.html`; `GET /api/nothing` is still the API's 404, not the page;
  `GET /health` still answers JSON. Without `webDistDir`, `GET /` is a 404 as today.
- `openapi.test.ts`: the health schema includes `version`; no static route appears in the
  document.
- `index.test.ts`: `identity.version` is passed through.
- Mobile: `requireEnvValue` tests unchanged; nothing in the app reads the mode.

### Integration

None new: no table and no query changes.

### E2E

- The existing run is unchanged and keeps pointing at the tsx server.
- `build-image` runs the whole suite against the container (`E2E_TARGET=image`). This is the
  proof that one process serving both the export and the API, with D15's fallback, passes every
  flow the suite knows, including deep links. If the job's time hurts, the fallback is a smoke
  script (health with version, `/` served, `/session` served, `openapi.json`, one translation
  through MockServer); start with the full suite.

### Release

- `verify` in `release.yml` is the only test that touches production configuration and data:
  `/health` reports the released tag. It runs after the fact, which is the staging gap the
  one-pager accepts.

### Architecture

- `check-adr-0010-single-container.sh`: planted violations first — `scale = 2` in `infra/prod`,
  and a Dockerfile `CMD` that starts the server directly — each must be reported; then restored.
- `check-dockerfile-node.sh`: plant `FROM node:22`; must be reported.
- `npm run lint:arch` and the lane tests still pass: nothing writes a port or a database name
  outside `scripts/lane-env.sh`; `image-run.sh` derives everything from the wrapper.

### Manual, once, by Victor

- `npm run image:build && npm run image:run`, then `http://localhost:<lane port>/` shows the app
  and `/health` shows `version: dev`. Before the first tag.
- After go-live: open `https://app.wordspal.ai` on a phone's browser, sign up, save a word; the
  next day it is still there (done means 1). `npm run mobile:prod` on the phone reaches production.

## Build order

1. Server: `version` and `webDistDir` in config, `/health`, static serving and fallback, core
   schema; unit tests. (Runs in every lane as before; `WEB_DIST_DIR` unset.)
2. Mobile: `.env.production`, the `.env.development.local` rename across scripts and README,
   `mobile:prod`, `web.output: single`; run the e2e suite to prove the export still passes.
3. Server build (`build.mjs`), Dockerfile, `.dockerignore`, `image:build`, `image-run.sh`;
   `image:run` against the lane; the e2e `image` target; the `build-image` CI job.
4. ADR 0010 and the two check scripts, planted violations first; the Node-major check into
   `check-adrs`.
5. `infra/bootstrap` and `infra/prod`; `terraform-plan` CI job (it can only `validate` until the
   bootstrap has been applied; the plan step is allowed to skip when the backend is absent, and
   says so).
6. `release.yml`.
7. Runbook and README. Then Victor's go-live, following the runbook. The first tag is the first
   production deployment.

## 4. Hand-over with phase 29

Phase 29's spec lists obligations for "the hosting phase". Where each lands:

| Obligation | This phase | Phase 29's follow-up |
|---|---|---|
| Serve the API over HTTPS so the cookie is `Secure` | Lightsail terminates TLS on `app.wordspal.ai` (D11) | none |
| `BETTER_AUTH_SECRET` and `RESEND_API_KEY` in the host's secret store | Two more secrets under `wordspal/prod/` and two more environment entries in `infra/prod` (D12); slots prepared, values added at merge | write the values, release |
| Rate limiter on, `storage: 'database'`, `trustedProxies` for the real proxy | The runbook records that Lightsail sets `X-Forwarded-For` and the container never sees the client address | turn the limiter on, add `auth_rate_limits`, name the proxy |
| Per-IP limit on sending codes | nothing | its code |

`AUTH_BASE_URL=https://app.wordspal.ai` and `WEB_ORIGINS=https://app.wordspal.ai` are plain
environment entries added to `infra/prod` at merge. Phase 29's migrations run on the next
container start after its release, per D4.

**The exposure window.** Victor chose to go live before phase 29 merges. Until then anyone who
finds `app.wordspal.ai` can open any learner's data by typing a username, and can spend the
production Gemini key on new words. Bounded by: a production key separate from the laptop's,
revocable in one place (D12); the budget alert (D13); and the smallness of a brand-new site with
no users. Closed by: phase 29 merging, then a release. The README says exactly this in place of
its current "must not reach a public host" paragraph.

## Risks

- **The plan role reads production secrets on every branch push.** A `terraform plan` resolves the
  Secrets Manager data sources. Only Victor pushes branches, forks get no OIDC trust, and Terraform
  masks sensitive values in output, but the trust exists. Mitigation if it ever matters: move the
  secret data sources behind a `read_secrets` variable the plan job sets false, and accept a plan
  that shows those environment entries as "known after apply".
- **The old container serves for about a minute after the new one has migrated** (D5). A
  destructive migration errors for that minute. Drizzle generates additive migrations by default;
  a destructive one is a conscious act, and the ADR says what it costs.
- **A migration slower than the deployment's health window fails the release.** Lightsail waits a
  bounded time for `/health`; the dictionary is not loaded at startup (D14), and no migration to
  date takes more than seconds, so this is theoretical. If it happens the previous deployment keeps
  serving and the release is red, which is the right failure.
- **Lightsail's Postgres may trail the one CI tests against.** Compose runs `postgres:17`; Lightsail
  documents up to 16. Nothing in the schema or in pg-boss needs 17, and the runbook checks the
  blueprint list at apply time; if 17 is offered, it is chosen.
- **The lane comment on the production database.** `ensureDatabase` stamps a `COMMENT ON
  DATABASE`; the Lightsail master user may lack ownership. Verified in build step 1 against a
  throwaway Lightsail database if needed; if it fails, the stamp becomes best-effort and the
  `lane:list` tooling, which is a lane 0 concern anyway, is unaffected in production.
- **Private ECR pull from Lightsail is a documented feature, not one this repo has exercised.**
  The puller role and repository policy are the first thing the first apply proves. If it does not
  work, the fallback is Lightsail's own registry with the image label captured by the workflow and
  passed to Terraform, which loses nothing but the deterministic image reference.
- **Expo Go's `--no-dev` mode.** `mobile:prod` runs a production-style bundle on the phone. If a
  future need wants dev tooling against production, `NODE_ENV=production expo start` would read
  `.env.production` while keeping the dev server, at the cost Expo's docs warn about. Not done now.
- **Phase 29 renumbering.** This spec claims ADR 0010 because phase 29 holds 0009. If phase 29
  merges with a different number, this ADR follows.
