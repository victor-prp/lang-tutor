# syntax=docker/dockerfile:1
#
# The production image (phase 30, spec D1/D2): one process serving the API, the
# background jobs and the web export. The release workflow builds it from a
# tagged master commit; scripts/image-build.sh builds it locally and in CI.

# --- build: install the monorepo, then make the two artifacts ----------------
FROM node:24.20.0-bookworm-slim AS build
WORKDIR /repo
ENV CI=1 EXPO_NO_TELEMETRY=1
# Manifests first, so a source-only change reuses the install layer. npm ci
# needs every workspace's package.json to accept the lockfile, even the two
# whose dependencies are skipped here.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY e2e/package.json e2e/
COPY nightly-qa/package.json nightly-qa/
RUN npm ci --workspace apps/server --workspace apps/mobile --workspace packages/core --include-workspace-root
COPY . .
# Unset for a release, so the web export reads apps/mobile/.env.production.
# scripts/image-build.sh sets it for a local or CI build, which must call the
# container it runs in, not production.
ARG EXPO_PUBLIC_API_URL=
RUN if [ -z "$EXPO_PUBLIC_API_URL" ]; then unset EXPO_PUBLIC_API_URL; fi \
 && npm run build:web --workspace apps/mobile \
 && npm run build --workspace apps/server

# --- runtime: production dependencies, the bundle and the export -------------
FROM node:24.20.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY e2e/package.json e2e/
COPY nightly-qa/package.json nightly-qa/
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root && npm cache clean --force
# The bundle sits inside the server's workspace, so a dependency npm nested under
# apps/server/node_modules still resolves from it.
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY --from=build /repo/apps/mobile/dist web
# Lightsail's Postgres presents a certificate from the Amazon RDS authority,
# which Node does not trust by default. Production's DATABASE_URL names this
# file as its sslrootcert.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem certs/rds-global-bundle.pem
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION WEB_DIST_DIR=/app/web
USER node
WORKDIR /app/apps/server
# ADR 0010: migrate, then serve. A failed migration exits non-zero, the server
# never listens, /health never answers, and Lightsail keeps the previous
# deployment. exec makes node PID 1, so Lightsail's SIGTERM reaches the server's
# own shutdown path. PORT comes from the environment that runs the image.
CMD ["sh", "-c", "node dist/cli.js && exec node dist/index.js"]
