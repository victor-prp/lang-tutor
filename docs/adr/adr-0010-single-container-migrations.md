# ADR 0010: Production is one container, which migrates the database before it serves

- **Status:** Accepted
- **Date:** 2026-10-08
- **Source:** [phase 30 design](../superpowers/specs/2026-10-08-lang-tutor-phase-30-hosting-design.md) — D4, D5

## Decision

Production runs exactly one container on Lightsail. That container runs the migrate command
first and starts the server only if it succeeded. Nothing else migrates the production
database: the database is private, so no outside job can reach it. This holds while there is
one copy. Wanting a second copy first moves migrations to a step that runs once before any
container starts, under a new ADR that supersedes this one.

```
  release: terraform apply -var image_tag=vX   (scripts/infra.sh)
        │ one deployment, scale = 1
        ▼
  container start:  node dist/cli.js            migrate + seed; non-zero exit stops here
        │ && exec
        ▼
                    node dist/index.js          listens; /health answers; Lightsail switches over
```

During a rollout the old container serves for about a minute after the new one has migrated,
so a migration that drops or renames something the old code reads errors for that minute.

## Rules

| # | Subject | Must | Must not |
|---|---|---|---|
| R1 | `infra/prod/*.tf` | declare the container service with `scale = 1` | declare any other scale |
| R2 | `Dockerfile` | start with `node dist/cli.js && exec node dist/index.js` | have a `CMD` or `ENTRYPOINT` that starts the server another way |
| R3 | `infra/prod/*.tf` | — | set a container `command`, which would replace the image's start command |

## How to detect a violation

Mirrored by `scripts/check-adr-0010-single-container-migrations.sh`. Each command must print nothing.

```bash
# R1 — one container: no scale other than 1, and a scale = 1 that exists
{ grep -qE '^[[:space:]]*scale[[:space:]]*=[[:space:]]*1[[:space:]]*(#.*)?$' infra/prod/main.tf || echo "infra/prod/main.tf: no scale = 1"; grep -nE '^[[:space:]]*scale[[:space:]]*=' infra/prod/*.tf | grep -vE 'scale[[:space:]]*=[[:space:]]*1[[:space:]]*(#.*)?$'; }

# R2 — migrate, then serve: the start command exists, and nothing else starts the image
{ grep -qF 'CMD ["sh", "-c", "node dist/cli.js && exec node dist/index.js"]' Dockerfile || echo "Dockerfile: no migrate-then-serve CMD"; grep -nE '^(CMD|ENTRYPOINT)' Dockerfile | grep -vF 'node dist/cli.js && exec node dist/index.js'; }

# R3 — no start-command override in the deployment
grep -nE '^[[:space:]]*command[[:space:]]*=' infra/prod/*.tf
```

### What the rules cover

- `infra/prod/*.tf` for R1 and R3; `Dockerfile` for R2.
- `infra/bootstrap` is out: it declares no container.
- R1 and R2 each fail when their file lacks the required line, not only when a wrong one is present.

## Why

- **R1 looks like a sizing choice and is a correctness rule.** Two containers starting at once would both migrate.
- **R3 looks redundant with R2.** A Lightsail `command` replaces the image's `CMD`, so R2 alone would pass while production skipped the migration.

## Related

- ADR 0007 R1 — pg-boss's schema is installed by the same migrate command.
- ADR 0006 — production is not a lane; its port and database name are its own.
