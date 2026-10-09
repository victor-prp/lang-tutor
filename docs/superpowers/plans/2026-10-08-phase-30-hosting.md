# Phase 30 — Hosting at app.wordspal.ai Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One container on AWS Lightsail serves the API, the background jobs and the web export at `https://app.wordspal.ai`, released by pushing a `v*` tag on a master commit, with all infrastructure in Terraform.

**Architecture:** The Hono server gains a version on `/health` and an optional static handler for the Expo web export. A multi-stage Dockerfile bundles the server with esbuild and builds the export. Two Terraform stacks own the AWS side: `infra/bootstrap` (GitHub OIDC roles, the ECR repository) and `infra/prod` (database, container service, certificate, budget, and the deployment itself). A release workflow builds and pushes the image, then runs `terraform apply` with the tag; CI builds the image on every push and runs the e2e suite against it.

**Tech Stack:** Node 24, Hono 4 with `@hono/node-server` 2.1, esbuild 0.28.2, Expo 57 web export, Docker (BuildKit), Terraform 1.16 with the AWS provider 6.66.0, AWS Lightsail, ECR, Secrets Manager, GitHub Actions with OIDC.

**Spec:** `docs/superpowers/specs/2026-10-08-lang-tutor-phase-30-hosting-design.md`

## Before Task 1

- Work in the worktree `.claude/worktrees/phase-30-hosting` on branch `phase-30-hosting`. Run `./scripts/setup-worktree.sh` first. If it reports every lane slot taken, do not retire a lane: run unit tests and typecheck locally, leave integration and e2e to CI, and ask Victor to run `npm run lane:clean`.
- Phase 29 (sign-in) is in flight on `phase-29-auth`. Run `git fetch origin` between tasks. If phase 29 has merged, merge `origin/master` into this branch before the next task, then `npm install` and `./scripts/setup-worktree.sh`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use the `git-commit` skill for each commit.

## Refinements to the spec, decided while planning

Each is a place where reading the code showed the spec's wording would not work as written. Victor reviews these with the plan.

1. **Test builds of the image take the API URL as a build argument** (spec D3 said no build argument). A release build leaves it unset, so the export reads `apps/mobile/.env.production`. A local or CI build sets it to the address the container answers on there; otherwise the CI e2e run against the image would drive production.
2. **`npm run mobile:prod` unsets the wrapper's URL and refuses a stale env file.** `scripts/lane-env.sh` exports `EXPO_PUBLIC_API_URL`, and production mode keeps a value the shell already set. A `.env.local` or `.env.production.local` setting the URL outranks `.env.production`. Both would point the phone at a laptop. `setup-worktree.sh` moves an old `.env.local` to the new name.
3. **Production uses port 8080 and a database named `wordspal`** (spec D11 said 3001 and `lang_tutor`). No lane-0 value then appears in production configuration, so CLAUDE.md's never-hardcode rule needs no exception.
4. **The state bucket is made by one CLI command, and both stacks keep remote state** (spec D10 had bootstrap create the bucket and keep local state). A stack cannot keep its state in a bucket it creates; this way CI can plan both stacks and no state lives only on the laptop.
5. **`WEB_DIST_DIR` and `APP_VERSION` are image environment, not Terraform environment** (spec D12 listed them in the deployment). They are facts about the image; `/health` proves the running image is the tag.
6. **`GEMINI_MODEL` comes from the existing GitHub variable** that the eval job already uses (spec D12 said a committed default). Production then runs the model the eval tests.
7. **Static serving answers `index.html` only for extension-less paths outside `/api`**, with `no-cache` on HTML and a year-long immutable cache on `/_expo/static/` bundles. A missing bundle stays a 404; a stale cached page cannot outlive a release.
8. **The database URL uses `sslmode=verify-full` with the Amazon RDS CA bundle baked into the image.** Lightsail's Postgres presents an RDS certificate, which Node does not trust by default.
9. **Rollback runs the release workflow from the old tag** (`gh workflow run release.yml --ref <tag>`). The release role trusts tag refs only, so the tag is the ref, not an input.
10. **The release guard requires every CI job except `test-eval`.** CLAUDE.md says that job can go red with nothing wrong in the commit.
11. **`scripts/infra.sh` is the one way Terraform runs.** It reads the live image tag back from the state unless `IMAGE_TAG` is set, so an apply from the laptop never drops the deployment or undoes a rollback. *Changed in the final review:* it asks Lightsail which tag it serves instead of reading the state, because a failed release leaves its never-live tag in the state; and the release workflow applies master's `infra/`, so a rollback moves only the image.
12. **ADR 0010 gains a third rule: nothing in `infra/prod` overrides the container's start command.** Lightsail's `command` field would otherwise bypass the migration. This is a corollary Victor did not state; confirm or strike it at plan review.
13. **The spec's `index.test.ts` line is covered elsewhere.** The identity is assembled inside `main()`, which a unit test cannot call; config, app and OpenAPI tests pin the version instead, and the release workflow checks it live.
14. **The plan role's `terraform plan` runs with `-lock=false`**, so the job stays read-only.

## Global Constraints

- Node major 24 (`.nvmrc`); image base `node:24.20.0-bookworm-slim`.
- `esbuild` pinned `0.28.2` in `apps/server` devDependencies.
- Terraform `required_version = "~> 1.16"`; CI and the release workflow use `1.16.3`. Providers pinned exactly: `hashicorp/aws = 6.66.0`, `hashicorp/random = 3.9.1`, with `.terraform.lock.hcl` committed.
- Actions: `actions/checkout@v5` and `actions/setup-node@v5` (the repo's convention), `aws-actions/configure-aws-credentials@v6`, `aws-actions/amazon-ecr-login@v2`, `hashicorp/setup-terraform@v4`.
- Region `eu-central-1`, availability zone `eu-central-1a`. Domain `app.wordspal.ai`. Lightsail service and ECR repository both `wordspal`. Secrets under `wordspal/prod/`. Production port `8080`, database `wordspal`, scale `1`.
- ADR 0006 R1/R2: no `3001`, `3002`, `8081`, `8082` or `'lang_tutor` literal in `e2e/`, `scripts/`, `apps/server/tests/` or `package.json`, outside `scripts/lane-env.sh` and its test. New script tests use other numbers.
- ADR 0002 R2: `process.env` is read only in `apps/server/src/index.ts`, `apps/server/src/db/cli.ts` and `apps/mobile/src/app/_layout.tsx`.
- ADR 0003 R1: no `.get(`, `.post(`, `.put(`, `.patch(` or `.delete(` call in `apps/server/src/routes/` or `apps/server/src/app.ts`, except `app.get('/docs'`.
- One pull request for the whole phase.

## Review Focus

1. **A browser holding the previous release's `index.html`** after a deploy would load bundle files the new image no longer has: a white screen. Expected: `index.html` revalidates every time; hashed bundles cache for a year. Pinned in Task 1.
2. **A missing bundle file or an unknown `/api` path answered with the page.** HTML parsed as JavaScript is a blank screen; HTML parsed as JSON is a misleading client error. Expected: both are 404. Pinned in Task 1 and in Task 5's image-only spec.
3. **`npm run mobile:prod` silently reaching a laptop**, through an old `.env.local` or the wrapper's exported URL. Expected: the script refuses the file and unsets the variable. Pinned in Task 2.
4. **An apply from the laptop after a rollback** redeploying a different tag, or dropping the deployment. Expected: the tag of the last apply is read back from the state. Pinned in Task 7.
5. **A tag pushed while CI is still running, on a red commit, or with only `test-eval` red.** Expected: wait, refuse, and allow respectively. Pinned in Task 9.

---

### Task 1: Version on `/health`, and serving the web export

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`
- Modify: `packages/core/src/api/schemas.ts` (`HealthResponseSchema`)
- Modify: `apps/server/src/composition.ts` (`ServerIdentity`, `AppDeps`, `createServerDeps`)
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/src/web.ts`
- Create: `apps/server/src/web.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/openapi.test.ts`
- Modify: `apps/server/tests/support/fakes.ts`, `apps/server/tests/support/serverDeps.ts`, `apps/server/tests/integration/composition.test.ts`

**Interfaces:**
- Produces: `Config.version: string` (from `APP_VERSION`, default `'dev'`), `Config.webDistDir: string | null` (from `WEB_DIST_DIR`, default `null`). `ServerIdentity.version: string`. `AppDeps.webDistDir: string | null`. `createServerDeps` input gains `webDistDir: string | null`. `HealthResponseSchema` gains `version: z.string()`. `web.ts` exports `cacheControlFor(filePath: string): string | null`, `isApiPath(path: string): boolean`, `isAppRoute(path: string): boolean`, `createWebHandler(root: string): MiddlewareHandler`.
- Consumed by: Task 4 (the image sets `WEB_DIST_DIR=/app/web` and `APP_VERSION`), Task 9 (the release checks `version` on `/health`).

- [ ] **Step 1: Write the failing config test**

In `apps/server/src/config.test.ts`, add `version: 'dev',` and `webDistDir: null,` to both objects passed to `toEqual` inside `describe('loadConfig')` (the empty-environment test and the "takes every value from the environment" test). Then add this test inside the same `describe`:

```ts
  it('reads the release version and the web export directory (phase 30)', () => {
    expect(loadConfig({ APP_VERSION: ' v2026.10.08 ', WEB_DIST_DIR: ' /app/web ' })).toMatchObject({
      version: 'v2026.10.08',
      webDistDir: '/app/web',
    });
    expect(loadConfig({ APP_VERSION: '', WEB_DIST_DIR: '   ' })).toMatchObject({
      version: 'dev',
      webDistDir: null,
    });
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w apps/server -- src/config.test.ts`
Expected: FAIL, the received objects lack `version` and `webDistDir`.

- [ ] **Step 3: Add the two fields to `Config`**

In `apps/server/src/config.ts`, add to the `Config` type after `photoReadTimeoutMs: number;`:

```ts
  // Phase 30 (spec D2). The release tag the image was built from, published on
  // /health so a release can prove which image answers. `dev` everywhere else.
  version: string;
  // Phase 30 (spec D1). Where the web export sits inside the image. Unset, the
  // server answers the API only, which is every lane and every test: there,
  // Metro or `expo serve` serves the app.
  webDistDir: string | null;
```

and to the object `loadConfig` returns, after `photoReadTimeoutMs`:

```ts
    version: env.APP_VERSION?.trim() || 'dev',
    webDistDir: env.WEB_DIST_DIR?.trim() || null,
```

- [ ] **Step 4: Run the config tests**

Run: `npm test -w apps/server -- src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `web.ts` unit tests**

Create `apps/server/src/web.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { cacheControlFor, isApiPath, isAppRoute } from './web';

describe('cacheControlFor', () => {
  it('makes the browser revalidate every HTML page', () => {
    expect(cacheControlFor('/app/web/index.html')).toBe('no-cache');
  });

  it('caches a hashed bundle for a year', () => {
    expect(cacheControlFor('/app/web/_expo/static/js/web/entry-3f9a.js')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('leaves any other file to the browser default', () => {
    expect(cacheControlFor('/app/web/favicon.ico')).toBeNull();
  });
});

describe('isApiPath', () => {
  it('is true for /api and everything under it', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/users')).toBe(true);
  });

  it('is false for a path that only starts with the letters', () => {
    expect(isApiPath('/apiary')).toBe(false);
  });
});

describe('isAppRoute', () => {
  it('is true for the root and for screens, nested or not', () => {
    expect(isAppRoute('/')).toBe(true);
    expect(isAppRoute('/session')).toBe(true);
    expect(isAppRoute('/vocabulary/42')).toBe(true);
  });

  it('is false for a file, whatever the directory', () => {
    expect(isAppRoute('/_expo/static/js/web/entry-old.js')).toBe(false);
    expect(isAppRoute('/favicon.ico')).toBe(false);
  });

  it('is false under /api', () => {
    expect(isAppRoute('/api/nothing')).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `npm test -w apps/server -- src/web.test.ts`
Expected: FAIL, `Cannot find module './web'`.

- [ ] **Step 7: Write `web.ts`**

Create `apps/server/src/web.ts`:

```ts
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Phase 30 (spec D1, D15). The web export, served by the same process as the
 * API, so the page and the API share one origin. app.ts registers this with
 * `app.use`, after every route, so it only sees requests no route answered.
 *
 * Three answers, in order:
 *   1. a file in the export, when one matches the path;
 *   2. index.html, for an app route — a path outside /api whose last segment
 *      has no dot. The export is a single page (D15), and a reload on /session
 *      asks the server for /session;
 *   3. nothing, which is the app's 404, for everything else. A missing bundle
 *      file must not come back as HTML, and an unknown API path keeps the
 *      API's 404.
 */

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * index.html is revalidated every time: after a release it names new bundle
 * files, and a cached copy would point at files the new image does not have.
 * Files under /_expo/static/ carry a content hash in their names, so a given
 * name never changes and can be cached for a year.
 */
export function cacheControlFor(filePath: string): string | null {
  if (filePath.endsWith('.html')) return NO_CACHE;
  if (filePath.includes('/_expo/static/')) return IMMUTABLE;
  return null;
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function isAppRoute(path: string): boolean {
  if (isApiPath(path)) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

export function createWebHandler(root: string): MiddlewareHandler {
  const onFound = (filePath: string, c: Context) => {
    const value = cacheControlFor(filePath);
    if (value) c.header('Cache-Control', value);
  };
  const files = serveStatic({ root, onFound });
  const page = serveStatic({ root, path: 'index.html', onFound });
  const nothing = async () => {};

  return async (c, next) => {
    const method = c.req.method;
    if ((method !== 'GET' && method !== 'HEAD') || isApiPath(c.req.path)) return next();
    const file = await files(c, nothing);
    if (file) return file;
    if (!isAppRoute(c.req.path)) return next();
    return (await page(c, nothing)) ?? next();
  };
}
```

- [ ] **Step 8: Run the `web.ts` tests**

Run: `npm test -w apps/server -- src/web.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing request-level tests**

In `apps/server/src/app.test.ts`:

1. Change the first import line to `import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';` and add after it:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

2. In `depsWithPing`, change the identity to `identity: { lane: 'phase_15', database: 'lang_tutor_phase_15', port: 4001, version: 'v-test' },` and add `webDistDir: null,` after it.

3. In both `/health` tests, add `version: 'v-test',` to the expected body.

4. Append:

```ts
// Phase 30 (spec D1, D15). The web export is served only when webDistDir is set,
// which happens only inside the image. A temp directory stands in for the export.
describe('serving the web export (phase 30)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'web-export-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    mkdirSync(join(dir, '_expo', 'static', 'js', 'web'), { recursive: true });
    writeFileSync(join(dir, '_expo', 'static', 'js', 'web', 'entry-3f9a.js'), 'globalThis.loaded = true;');
    writeFileSync(join(dir, 'favicon.ico'), 'icon');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const app = () => createApp({ ...depsWithPing(true), webDistDir: dir });

  it('serves index.html at / and makes the browser revalidate it', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('id="root"');
  });

  it('serves a hashed bundle with a year-long immutable cache', async () => {
    const res = await app().request('/_expo/static/js/web/entry-3f9a.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers an app route with index.html, so a reload on a screen works', async () => {
    for (const path of ['/session', '/vocabulary/42']) {
      const res = await app().request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('answers a missing bundle file with 404, never with the page', async () => {
    const res = await app().request('/_expo/static/js/web/entry-old.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('leaves an unknown /api path to the 404 it had before', async () => {
    const res = await app().request('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('id="root"');
  });

  it('still answers /health with its JSON body', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: 'v-test' });
  });

  it('does not answer a POST to an app route with the page', async () => {
    const res = await app().request('/session', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('serves nothing at / when webDistDir is null, as in every lane', async () => {
    const res = await createApp(depsWithPing(true)).request('/');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 10: Write the failing OpenAPI tests**

In `apps/server/src/openapi.test.ts`, make sure these imports exist (add any that are missing): `import { tmpdir } from 'node:os';`, `import { createApp } from './app';`, `import { createFakeAppDeps } from '../tests/support/fakes';`. Inside `describe('the document as a whole', ...)` add:

```ts
  it('publishes version on the /health body (phase 30)', async () => {
    const doc = await (await createApp(createFakeAppDeps()).request('/openapi.json')).json();
    let schema = doc.paths['/health'].get.responses['200'].content['application/json'].schema;
    if (schema.$ref) schema = doc.components.schemas[schema.$ref.split('/').pop()];
    expect(schema.required).toContain('version');
  });

  it('publishes the same paths when the web export is served (phase 30)', async () => {
    const plain = await (await createApp(createFakeAppDeps()).request('/openapi.json')).json();
    const withWeb = await (
      await createApp({ ...createFakeAppDeps(), webDistDir: tmpdir() }).request('/openapi.json')
    ).json();
    expect(Object.keys(withWeb.paths)).toEqual(Object.keys(plain.paths));
  });
```

- [ ] **Step 11: Run them to see them fail**

Run: `npm test -w apps/server -- src/app.test.ts src/openapi.test.ts`
Expected: FAIL. TypeScript errors on `version` and `webDistDir` in `AppDeps`, or the `/health` bodies lack `version`.

- [ ] **Step 12: Add `version` to the health schema**

In `packages/core/src/api/schemas.ts`, extend the comment above `HealthResponseSchema` with one line, `// Since phase 30 it also names the release (the image's tag; \`dev\` elsewhere).`, and add the field:

```ts
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  lane: z.string(),
  database: z.string(),
  port: z.number().int(),
  version: z.string(),
});
```

- [ ] **Step 13: Thread the two values through composition**

In `apps/server/src/composition.ts`:

```ts
export type ServerIdentity = {
  lane: string;
  database: string;
  port: number;
  // Phase 30. The release tag; `dev` outside the image.
  version: string;
};
```

Add `webDistDir: string | null;` to `AppDeps` after `identity: ServerIdentity;`, with the comment `// Phase 30 (spec D1). Set only inside the image; app.ts serves the export from it.`. Add `webDistDir: string | null;` to the `createServerDeps` input after `identity: ServerIdentity;`, and `webDistDir: io.webDistDir,` to the returned object after `identity: io.identity,`.

In `apps/server/src/index.ts`, add `version: config.version,` inside `identity: { ... }` and `webDistDir: config.webDistDir,` after the `identity` block.

In `apps/server/tests/support/fakes.ts`, change the identity to `{ lane: 'test', database: 'test_db', port: 0, version: 'test' }` and add `webDistDir: null,`. In `apps/server/tests/support/serverDeps.ts`, change the default identity the same way and add `webDistDir: null,` to the `createServerDeps` call. In `apps/server/tests/integration/composition.test.ts`, change the identity the same way and add `webDistDir: null,`.

- [ ] **Step 14: Register the handler in `app.ts`**

In `apps/server/src/app.ts`, add `import { createWebHandler } from './web';` after the router imports, and after the `app.get('/docs', ...)` line:

```ts
  // Phase 30 (spec D1). Last, so it only sees what no route answered. Unset in
  // every lane and every test, where Metro or `expo serve` serves the app.
  if (deps.webDistDir) app.use('*', createWebHandler(deps.webDistDir));
```

- [ ] **Step 15: Run the server's unit tests, typecheck and the architecture checks**

Run: `npm test -w apps/server && npm run typecheck && npm run lint:arch`
Expected: all PASS; `lint:arch` reports every rule `ok`.

- [ ] **Step 16: Run the integration tests that build deps**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server`
Expected: PASS. If lanes are full (see Before Task 1), skip and say so; CI runs it.

- [ ] **Step 17: Commit**

```bash
git add apps/server/src packages/core/src/api/schemas.ts apps/server/tests
git commit -m "feat(server): /health names the release, and the server can serve the web export"
```

---

### Task 2: Two Expo Go modes, and a single-page export

**Files:**
- Rename: `apps/mobile/.env.example` to `apps/mobile/.env.development.example`
- Create: `apps/mobile/.env.production`
- Modify: `apps/mobile/package.json` (`start:prod`)
- Modify: `apps/mobile/app.json` (`web.output`)
- Modify: `package.json` (`mobile:prod`)
- Create: `scripts/mobile-prod.sh`, `scripts/test-mobile-prod.sh`
- Modify: `scripts/setup-worktree.sh` (section 1 and the header comment)
- Modify: `scripts/lane-env.sh` (`api_host`)
- Modify: `scripts/test-lane-env.sh`
- Modify: `.claude/settings.json` (SessionStart hook)
- Modify: `CLAUDE.md` (Lanes paragraph)
- Modify: `README.md` (Running it, Testing on a physical device, Working in lanes, End-to-end test)
- Modify: `e2e/playwright.config.ts` (one comment)
- Modify: `.github/workflows/ci.yml` (`check-adrs` job)

**Interfaces:**
- Produces: `apps/mobile/.env.production` with `EXPO_PUBLIC_API_URL=https://app.wordspal.ai`, read by every `expo export` including Task 4's image build. `npm run mobile:prod`. The lane URL file `apps/mobile/.env.development.local`.

- [ ] **Step 1: Write the failing lane-env tests**

In `scripts/test-lane-env.sh`, insert before the line `# --- exec and export modes ---`:

```bash
# --- the host comes from the main checkout's mobile env file (phase 30) -------
# .env.development.local is the name since phase 30; .env.local is read only
# when the new file is absent, so a main checkout that has not re-run
# setup-worktree.sh keeps its LAN IP.
printf 'EXPO_PUBLIC_API_URL=http://192.168.7.7:9\n' > "$MAIN/apps/mobile/.env.local"
expect_eq "an old .env.local in the main checkout still supplies the host" \
  "http://192.168.7.7:4001" "$(value_of "$FIXTURE/wt3" EXPO_PUBLIC_API_URL)"
printf 'EXPO_PUBLIC_API_URL=http://192.168.8.8:9\n' > "$MAIN/apps/mobile/.env.development.local"
expect_eq ".env.development.local wins over the old name" \
  "http://192.168.8.8:4001" "$(value_of "$FIXTURE/wt3" EXPO_PUBLIC_API_URL)"
rm -f "$MAIN/apps/mobile/.env.local" "$MAIN/apps/mobile/.env.development.local"
```

- [ ] **Step 2: Run it to see it fail**

Run: `./scripts/test-lane-env.sh`
Expected: FAIL on ".env.development.local wins over the old name" (actual `http://192.168.7.7:4001`).

- [ ] **Step 3: Read the new name first in `api_host`**

In `scripts/lane-env.sh`, replace the comment and body of `api_host`:

```bash
# The host a phone or simulator uses to reach this lane's server. Taken from the
# main checkout's .env.development.local so a LAN IP set once serves every lane;
# the port is always this lane's own. .env.local is that file's name before
# phase 30, read only when the new one is absent.
api_host() {
  [ -n "${LANE_API_HOST:-}" ] && { printf '%s' "$LANE_API_HOST"; return; }
  local file from_main=""
  for file in .env.development.local .env.local; do
    [ -f "$MAIN/apps/mobile/$file" ] || continue
    from_main=$(sed -n 's#^EXPO_PUBLIC_API_URL=http://\([^:/]*\).*#\1#p' \
      "$MAIN/apps/mobile/$file" 2>/dev/null | head -1)
    break
  done
  printf '%s' "${from_main:-localhost}"
}
```

- [ ] **Step 4: Run the lane tests**

Run: `npm run test:lanes`
Expected: PASS.

- [ ] **Step 5: Write the failing `mobile:prod` guard test**

Create `scripts/test-mobile-prod.sh` (executable):

```bash
#!/usr/bin/env bash
#
# Tests scripts/mobile-prod.sh's refusal (phase 30) against throwaway app
# directories. No Expo, no network: --check-only stops before Expo starts.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

expect() { # expect <label> <pass|refuse> <dir>
  local label="$1" want="$2" dir="$3" got
  checks=$((checks + 1))
  if MOBILE_DIR="$dir" bash "$REPO/scripts/mobile-prod.sh" --check-only > /dev/null 2>&1; then
    got=pass
  else
    got=refuse
  fi
  if [ "$got" = "$want" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s (expected %s, got %s)\n' "$label" "$want" "$got" >&2
    status=1
  fi
}

app() { mkdir -p "$FIXTURE/$1"; printf '%s\n' "$FIXTURE/$1"; }

echo "Testing scripts/mobile-prod.sh"
echo

d=$(app clean)
expect "no local env file starts" pass "$d"

d=$(app dev); printf 'EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.development.local"
expect "the lane URL in .env.development.local starts" pass "$d"

d=$(app legacy); printf 'EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.local"
expect "an old .env.local that sets the URL is refused" refuse "$d"

d=$(app exported); printf 'export EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.local"
expect "an exported URL in .env.local is refused" refuse "$d"

d=$(app prodlocal); printf 'EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.production.local"
expect "a .env.production.local that sets the URL is refused" refuse "$d"

d=$(app other); printf 'SOMETHING_ELSE=1\n' > "$d/.env.local"
expect "a .env.local without the URL starts" pass "$d"

d=$(app commented); printf '# EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.local"
expect "a commented-out URL starts" pass "$d"

echo
if [ "$status" -ne 0 ]; then
  echo "mobile-prod.sh FAILED ($checks checks)" >&2
else
  echo "mobile-prod.sh ok ($checks checks)"
fi
exit "$status"
```

- [ ] **Step 6: Run it to see it fail**

Run: `chmod +x scripts/test-mobile-prod.sh && ./scripts/test-mobile-prod.sh`
Expected: FAIL on every `refuse` case, because `scripts/mobile-prod.sh` does not exist yet.

- [ ] **Step 7: Write `scripts/mobile-prod.sh`**

Create `scripts/mobile-prod.sh` (executable):

```bash
#!/usr/bin/env bash
#
# `npm run mobile:prod`: Expo Go on a phone against the hosted server (phase 30,
# spec D3). Production mode reads apps/mobile/.env.production, which names
# https://app.wordspal.ai. Two things would silently beat that file, and both
# point the phone at a laptop instead, a test that looks like it passed:
#
#   1. The shell. scripts/lane-env.sh exports EXPO_PUBLIC_API_URL for this lane,
#      and Expo keeps a variable the shell already set instead of reading the
#      file. So it is unset below, just before Expo starts.
#   2. A .env.local or .env.production.local that sets the URL. Expo ranks both
#      above .env.production. This script refuses to start rather than guess.
#
# --check-only runs the refusal and exits. MOBILE_DIR, defaulting to this
# checkout's app, exists for scripts/test-mobile-prod.sh.

set -u

cd "$(dirname "$0")/.." || exit 1
MOBILE_DIR="${MOBILE_DIR:-apps/mobile}"

blocked=""
for file in .env.local .env.production.local; do
  if [ -f "$MOBILE_DIR/$file" ] &&
    grep -qE '^[[:space:]]*(export[[:space:]]+)?EXPO_PUBLIC_API_URL=' "$MOBILE_DIR/$file"; then
    blocked="$blocked $MOBILE_DIR/$file"
  fi
done

if [ -n "$blocked" ]; then
  echo "mobile:prod refused: EXPO_PUBLIC_API_URL is set in:$blocked" >&2
  echo "Expo ranks that file above .env.production, so the phone would reach a laptop," >&2
  echo "not production. The lane's URL belongs in apps/mobile/.env.development.local;" >&2
  echo "./scripts/setup-worktree.sh moves an old .env.local there." >&2
  exit 1
fi

[ "${1:-}" = "--check-only" ] && exit 0

unset EXPO_PUBLIC_API_URL
exec npm run start:prod --workspace apps/mobile
```

- [ ] **Step 8: Run the guard test**

Run: `chmod +x scripts/mobile-prod.sh && ./scripts/test-mobile-prod.sh`
Expected: `mobile-prod.sh ok (7 checks)`.

- [ ] **Step 9: Add the env files and the scripts**

```bash
git mv apps/mobile/.env.example apps/mobile/.env.development.example
```

Replace the comment in `apps/mobile/.env.development.example` (keep the value line `EXPO_PUBLIC_API_URL=http://localhost:3001` as it is):

```
# Copy this file to .env.development.local and set it to your dev machine's LAN
# IP, so a phone running Expo Go on the same Wi-Fi network can reach the server.
# The web target and simulators can keep using localhost. Development mode
# (`npm run mobile`) reads this file; production mode (`npm run mobile:prod`,
# and every `expo export`) never does: it reads .env.production instead.
```

Create `apps/mobile/.env.production`:

```
# Committed on purpose (phase 30, spec D3). Production mode reads this file:
# `npm run mobile:prod`, which is Expo Go against the hosted server, and every
# `expo export`, including the release image's web build. Nothing here is a
# secret: an EXPO_PUBLIC_ value is inlined into a bundle anyone can download.
EXPO_PUBLIC_API_URL=https://app.wordspal.ai
```

In `apps/mobile/package.json` scripts, after `"start"`, add:

```json
    "start:prod": "expo start --no-dev --port ${METRO_PORT:-8081}",
```

In the root `package.json` scripts, after `"mobile"`, add:

```json
    "mobile:prod": "bash scripts/lane-env.sh bash scripts/mobile-prod.sh",
```

- [ ] **Step 10: Move the lane file in `setup-worktree.sh`**

In `scripts/setup-worktree.sh`, change the header comment's `apps/mobile/.env.local` to `apps/mobile/.env.development.local`. In section 1, append this paragraph to the comment block, and replace the code from `desired=` to the closing `fi` of that section:

```bash
#
# Phase 30: the file is .env.development.local, which only development mode
# reads. Before that it was .env.local, which production mode reads too and
# ranks above .env.production, so `npm run mobile:prod` would have reached this
# lane instead of the hosted server. An old .env.local is moved, never deleted.
ENV_FILE=apps/mobile/.env.development.local
LEGACY_ENV_FILE=apps/mobile/.env.local
if [ -f "$LEGACY_ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
  mv "$LEGACY_ENV_FILE" "$ENV_FILE"
  echo "  moved      $LEGACY_ENV_FILE -> $ENV_FILE"
elif [ -f "$LEGACY_ENV_FILE" ]; then
  echo "  note       $LEGACY_ENV_FILE still exists beside $ENV_FILE. If it sets"
  echo "             EXPO_PUBLIC_API_URL, npm run mobile:prod refuses to start."
fi
desired="EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL"
if [ -f "$ENV_FILE" ] && grep -qxF "$desired" "$ENV_FILE"; then
  echo "  ok         $ENV_FILE points at this lane ($EXPO_PUBLIC_API_URL)"
else
  if [ -f "$ENV_FILE" ]; then
    echo "  rewriting  $ENV_FILE — it did not point at this lane's server"
  fi
  {
    echo "# Generated by scripts/setup-worktree.sh for lane $LANE (slot $LANE_SLOT)."
    echo "# The port is this lane's; the host comes from the main checkout, or from"
    echo "# LANE_API_HOST. Re-run the script after changing either."
    echo "$desired"
  } > "$ENV_FILE"
  echo "  created    $ENV_FILE -> $EXPO_PUBLIC_API_URL"
fi
```

Also change the comment line in section 1b from "the way .env.local is" to "the way the mobile env file is".

- [ ] **Step 11: Rename the file everywhere else**

1. `.claude/settings.json`: in the SessionStart hook command, replace both `apps/mobile/.env.local` with `apps/mobile/.env.development.local`, and `Without .env.local the app throws` with `Without .env.development.local the app throws`. Validate with `jq . .claude/settings.json > /dev/null`.
2. `CLAUDE.md`, Lanes section: `` `apps/mobile/.env.local` `` becomes `` `apps/mobile/.env.development.local` ``.
3. `e2e/playwright.config.ts`: in the web-export comment, `apps/mobile/.env.local` becomes `apps/mobile/.env.development.local`.
4. `README.md`: in "Running it", the file becomes `apps/mobile/.env.development.local`, the committed example `.env.development.example`, and the copy command `cp apps/mobile/.env.development.example apps/mobile/.env.development.local`. In "Testing on a physical device" and the `./scripts/setup-worktree.sh` comment in "Working in lanes", rename the same way. In "End-to-end test", the two mentions become `.env.development.local`. Then add after the "Phone and dev machine must be on the same Wi-Fi network." line:

```markdown
**Testing a phone against production:** `npm run mobile:prod` starts Expo in production
mode, which reads the committed `apps/mobile/.env.production` and so reaches
`https://app.wordspal.ai` instead of your lane. The bundle is a production one: minified,
with no Fast Refresh. The script refuses to start if `apps/mobile/.env.local` or
`.env.production.local` sets `EXPO_PUBLIC_API_URL`, because Expo ranks either above
`.env.production`. A checkout from before phase 30 has its URL in `.env.local`; re-run
`./scripts/setup-worktree.sh`, which moves it to `.env.development.local`.
```

5. Confirm nothing else names the old file: `git grep -n -e '\.env\.local' -e '\.env\.example' -- . ':(exclude)docs/superpowers'`. Expected: only the setup script's `LEGACY_ENV_FILE`, the lane script's fallback, the guard script, its test, and the README note above.
6. `nightly-qa`: run `grep -rn "EXPO_PUBLIC\|env.local" nightly-qa --include='*.sh' --include='*.ts'`. If anything reads the old file, rename it there too.

- [ ] **Step 12: Run the guard test in CI**

In `.github/workflows/ci.yml`, in the `check-adrs` job, after `- run: ./scripts/test-lane-abandon.sh`, add:

```yaml
      # Phase 30. The prod-mode Expo guard is pure text too.
      - run: ./scripts/test-mobile-prod.sh
```

- [ ] **Step 13: Move this worktree's own env file, then check the app still starts in both modes**

Run: `./scripts/setup-worktree.sh`
Expected: `moved apps/mobile/.env.local -> apps/mobile/.env.development.local` if the old file was there, then `ok ... points at this lane`.

Run: `npm run mobile:prod`, wait for Metro to report it is ready, then stop it with Ctrl-C.
Expected: Metro starts on this lane's Metro port. Open `http://localhost:<METRO_PORT>` in a browser only if a quick look is wanted; the web bundle must name `https://app.wordspal.ai`.

- [ ] **Step 14: Commit the env-file change**

```bash
git add apps/mobile/.env.development.example apps/mobile/.env.production apps/mobile/package.json package.json \
  scripts/mobile-prod.sh scripts/test-mobile-prod.sh scripts/setup-worktree.sh scripts/lane-env.sh \
  scripts/test-lane-env.sh .claude/settings.json CLAUDE.md README.md e2e/playwright.config.ts .github/workflows/ci.yml
git commit -m "feat(mobile): Expo Go can target the lane or production, and the lane URL moves to .env.development.local"
```

- [ ] **Step 15: Switch the web export to a single page**

In `apps/mobile/app.json`, change `"output": "static"` to `"output": "single"`.

Run: `EXPO_PUBLIC_API_URL=http://localhost:9 npm run build:web -w apps/mobile && ls apps/mobile/dist && grep -c 'id="root"' apps/mobile/dist/index.html`
Expected: `dist/` holds one `index.html` at the top and no per-route HTML files such as `session.html`; the grep prints `1`. If the root element has another id, use that id in Task 5's spec instead of `#root`.

- [ ] **Step 16: Run the mobile tests and the e2e suite**

Run: `npm test -w apps/mobile && npm run e2e`
Expected: PASS. Every spec opens only `/`, so `expo serve`'s lack of a fallback does not matter here. If lanes are full, run only the mobile tests and leave e2e to CI.

- [ ] **Step 17: Commit**

```bash
git add apps/mobile/app.json
git commit -m "feat(mobile): the web export is a single page, so one fallback serves every deep link"
```

---

### Task 3: A bundled server build

**Files:**
- Create: `apps/server/scripts/build.mjs`
- Modify: `apps/server/package.json` (`build` script, `esbuild` devDependency)

**Interfaces:**
- Produces: `npm run build -w apps/server` writes `apps/server/dist/index.js` (the server, exporting `main`), `apps/server/dist/cli.js` (migrate and seed, runs on load) and `apps/server/dist/migrations/`. Consumed by Task 4's Dockerfile.

- [ ] **Step 1: Write the build script**

Create `apps/server/scripts/build.mjs`:

```js
// Phase 30 (spec D2). Bundles the server's two entry points for the image:
// dist/index.js, the server, and dist/cli.js, which migrates and seeds. Our own
// workspace code is inlined, which is the point: @lang-tutor/core ships
// TypeScript source and the image carries no TypeScript tooling. Every
// third-party dependency stays external and is installed by npm in the image,
// so packages load exactly as they do under tsx.
import { build } from 'esbuild';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// esbuild treats a listed package's subpaths (hono/cors, drizzle-orm/...) as
// external too.
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@lang-tutor/'));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts', cli: 'src/db/cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external,
  sourcemap: true,
  logLevel: 'info',
});

// migrate.ts finds the folder beside the running file (__dirname), which in the
// bundle is dist/.
cpSync(join(root, 'src/db/migrations'), join(dist, 'migrations'), { recursive: true });
```

- [ ] **Step 2: Add the script and pin esbuild**

In `apps/server/package.json`, add `"build": "node scripts/build.mjs",` after `"start"`, and `"esbuild": "0.28.2",` to `devDependencies` in alphabetical order. Then run `npm install` at the root.

- [ ] **Step 3: Build, and check the bundle loads without starting anything**

Run:

```bash
npm run build -w apps/server
node -e "const m = require('./apps/server/dist/index.js'); if (typeof m.main !== 'function') { console.error('no main export'); process.exit(1); } console.log('index.js loads')"
ls apps/server/dist/migrations/meta/_journal.json
```

Expected: `index.js loads`, and the journal file is listed. If `require` fails with `ERR_REQUIRE_ASYNC_MODULE`, an external package uses top-level await. Report that rather than switching formats; the entry relies on `require.main === module`.

- [ ] **Step 4: Run the bundled CLI against this lane's database**

Run: `bash scripts/lane-env.sh node apps/server/dist/cli.js`
Expected: ends with `migrated and seeded postgres://...` naming this lane's database. Skip if lanes are full.

- [ ] **Step 5: Run the bundled server and ask it for `/health`**

Stop any `npm run server` in this lane first. Start the bundle on the lane's e2e API port, in the background:

```bash
bash scripts/lane-env.sh sh -c 'PORT=${E2E_API_URL##*:} GEMINI_BASE_URL=$MOCKSERVER_URL/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev node apps/server/dist/index.js'
```

Then: `bash scripts/lane-env.sh sh -c 'curl -fsS "$E2E_API_URL/health"'`
Expected: `{"ok":true,"lane":"...","database":"...","port":...,"version":"dev"}`. Stop the background server.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add apps/server/scripts/build.mjs apps/server/package.json package-lock.json
git commit -m "build(server): esbuild bundles the server and the migrate CLI for the image"
```

---

### Task 4: The image, built and run locally

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Create: `scripts/image-build.sh`, `scripts/image-run.sh`, `scripts/check-dockerfile-node.sh`
- Modify: `package.json` (`image:build`, `image:run`)
- Modify: `.github/workflows/ci.yml` (`check-adrs` job)
- Modify: `README.md` (a new "The production image" subsection under "Running it", and `APP_VERSION`, `WEB_DIST_DIR` under "Environment variables")

**Interfaces:**
- Consumes: Task 1's `APP_VERSION` and `WEB_DIST_DIR`; Task 2's `.env.production`; Task 3's `npm run build -w apps/server`.
- Produces: `scripts/image-build.sh` (reads `LANE`, `PORT`, optional `IMAGE`, `IMAGE_API_URL`, `APP_VERSION`; tags `lang-tutor:<lane>` by default). `scripts/image-run.sh` (reads `LANE`, `PORT`, `DATABASE_URL`, optional `IMAGE`, and forwards `GEMINI_*` and phase 29's variables when set). The image's start command `sh -c "node dist/cli.js && exec node dist/index.js"`, which Task 8's ADR pins.

- [ ] **Step 1: Write the failing Node-major check**

Create `scripts/check-dockerfile-node.sh` (executable):

```bash
#!/usr/bin/env bash
#
# The image runs the Node major CI tests against (phase 30, spec §3): every
# `FROM node:` line in the Dockerfile starts with .nvmrc's major. No Dockerfile,
# or a Dockerfile with no `FROM node:` line, is a violation too: a check that
# finds nothing to check must not print `ok`.

set -u

cd "$(dirname "$0")/.." || exit 1

major=$(tr -d '[:space:]v' < .nvmrc | cut -d. -f1)
lines=$(grep -nE '^FROM[[:space:]]+node:' Dockerfile 2>/dev/null)
if [ -z "$lines" ]; then
  echo "  VIOLATION  the Dockerfile has no FROM node: line" >&2
  exit 1
fi
wrong=$(printf '%s\n' "$lines" | grep -vE "^[0-9]+:FROM[[:space:]]+node:${major}([.-]|[[:space:]]|$)")
if [ -n "$wrong" ]; then
  echo "  VIOLATION  the Dockerfile's Node is not .nvmrc's major ($major):" >&2
  printf '%s\n' "$wrong" | sed 's/^/             /' >&2
  exit 1
fi
echo "  ok         the Dockerfile runs Node $major, as .nvmrc says"
```

Run: `chmod +x scripts/check-dockerfile-node.sh && ./scripts/check-dockerfile-node.sh`
Expected: FAIL, `the Dockerfile has no FROM node: line`.

- [ ] **Step 2: Write the Dockerfile**

Create `Dockerfile`:

```dockerfile
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
```

Create `.dockerignore`:

```
**/node_modules
**/dist
**/.expo
**/.env*.local
.git
.github
.claude
.superpowers
.lane
.vscode
drafts
docs
infra
data
test-results
playwright-report
nightly-qa/.out
nightly-qa/.work
apps/server/tests/eval/.results
```

Run: `./scripts/check-dockerfile-node.sh`
Expected: `ok         the Dockerfile runs Node 24, as .nvmrc says`.

- [ ] **Step 3: See the Node check fire on a planted violation**

Change the first `FROM node:24.20.0-bookworm-slim` to `FROM node:22.20.0-bookworm-slim`, run `./scripts/check-dockerfile-node.sh`, and expect a VIOLATION naming that line. Restore the line and run it again for `ok`.

- [ ] **Step 4: Write the build and run scripts**

Create `scripts/image-build.sh` (executable):

```bash
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
```

Create `scripts/image-run.sh` (executable):

```bash
#!/usr/bin/env bash
#
# Runs the production image in the foreground against this lane's Postgres and
# MockServer, on this lane's PORT (phase 30, spec §3). `npm run image:run` is
# for a look in a browser; the e2e suite's image target runs it too.
#
# Addresses are rewritten, never written down: the container reaches the host
# through host.docker.internal, which --add-host makes work on Linux (CI) as well
# as on Docker Desktop. Only addresses the container dials are rewritten;
# AUTH_BASE_URL is the browser's address and is passed as it is.
#
# The container is named after the lane and port, and an old one of that name is
# removed first, so a run that was killed without stopping its container cannot
# leave the port taken.

set -u

cd "$(dirname "$0")/.." || exit 1
: "${LANE:?run this through scripts/lane-env.sh, for example npm run image:run}"
IMAGE="${IMAGE:-lang-tutor:$LANE}"
NAME="lang-tutor-$LANE-$PORT"

to_container() {
  printf '%s' "$1" | sed -E 's#(//|@)(localhost|127\.0\.0\.1)([:/])#\1host.docker.internal\3#'
}

args=(--rm --name "$NAME" --add-host host.docker.internal:host-gateway
  -p "$PORT:$PORT"
  -e "PORT=$PORT" -e "LANE=$LANE"
  -e "DATABASE_URL=$(to_container "$DATABASE_URL")")

# Forwarded only when set. The last five are phase 29's; until it merges they
# are never set and nothing is forwarded.
for key in GEMINI_API_KEY GEMINI_MODEL BETTER_AUTH_SECRET AUTH_BASE_URL WEB_ORIGINS RESEND_API_KEY MAIL_FROM; do
  if [ -n "${!key:-}" ]; then args+=(-e "$key=${!key}"); fi
done
for key in GEMINI_BASE_URL RESEND_BASE_URL; do
  if [ -n "${!key:-}" ]; then args+=(-e "$key=$(to_container "${!key}")"); fi
done

docker rm -f "$NAME" > /dev/null 2>&1 || true
exec docker run "${args[@]}" "$IMAGE"
```

In the root `package.json` scripts, after `"mobile:prod"`, add:

```json
    "image:build": "bash scripts/lane-env.sh bash scripts/image-build.sh",
    "image:run": "bash scripts/lane-env.sh bash scripts/image-run.sh",
```

In `.github/workflows/ci.yml`, in the `check-adrs` job, after the `test-mobile-prod.sh` step, add:

```yaml
      # Phase 30. The image must run the Node major the other jobs test.
      - run: ./scripts/check-dockerfile-node.sh
```

Run: `npm run lint:arch`
Expected: every rule `ok`. ADR 0006 R1 scans `scripts/`, and these scripts name no port.

- [ ] **Step 5: Build the image**

Run: `npm run image:build`
Expected: the build succeeds and tags `lang-tutor:<this lane>`. The first build takes several minutes.

- [ ] **Step 6: Run it and look at it**

Stop any `npm run server` in this lane. Start the image in the background:

```bash
GEMINI_BASE_URL=http://localhost:1080/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev npm run image:run
```

Then check it, through the wrapper so the port is the lane's:

```bash
bash scripts/lane-env.sh sh -c '
  curl -fsS "http://localhost:$PORT/health"; echo
  curl -fsS -o /dev/null -w "/ %{http_code} %{content_type}\n" "http://localhost:$PORT/"
  curl -fsS -o /dev/null -w "/session %{http_code}\n" "http://localhost:$PORT/session"
  curl -s -o /dev/null -w "missing bundle %{http_code}\n" "http://localhost:$PORT/_expo/static/js/web/entry-none.js"
  curl -fsS -o /dev/null -w "openapi %{http_code}\n" "http://localhost:$PORT/openapi.json"'
```

Expected: `/health` shows `"ok":true` and `"version":"dev"`; `/` is `200 text/html`; `/session` is `200`; the missing bundle is `404`; the OpenAPI document is `200`. The container log starts with `migrated and seeded`. Stop the container with `docker rm -f lang-tutor-<lane>-<port>`, or Ctrl-C on the foreground run.

- [ ] **Step 7: Document the image**

In `README.md`, add after the "Testing a phone against production" paragraph from Task 2:

````markdown
### The production image

Production runs one container: the server, its background jobs and the web export, from
one process on one origin ([phase 30 design](docs/superpowers/specs/2026-10-08-lang-tutor-phase-30-hosting-design.md)).
To build and run that image against your lane:

```bash
npm run image:build   # tags lang-tutor:<lane>; the web export calls this lane's server
GEMINI_BASE_URL=http://localhost:1080/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev npm run image:run
```

Then open the lane's server address in a browser: `/` is the app, `/api/...` the API and
`/health` names the version (`dev` for a local build). The container migrates the
database before it listens ([ADR 0010](docs/adr/adr-0010-single-container-migrations.md)).
A release builds the same Dockerfile without the API URL argument, so its export calls
`https://app.wordspal.ai`.
````

Under "Environment variables", add two rows to the end of the table:

```markdown
| `APP_VERSION` | `dev` | Phase 30. The release tag, published on `/health`. The image sets it from its build argument. |
| `WEB_DIST_DIR` | unset — the server answers the API only | Phase 30. The web export the server serves. Set only inside the image, to `/app/web`. |
```

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore scripts/image-build.sh scripts/image-run.sh scripts/check-dockerfile-node.sh \
  package.json .github/workflows/ci.yml README.md
git commit -m "build: the production image, one process serving the API, the jobs and the web export"
```

---

### Task 5: The e2e suite against the image, in CI

**Files:**
- Modify: `e2e/urls.ts` (`APP_URL`)
- Modify: `e2e/playwright.config.ts` (shared server env, the image target)
- Create: `e2e/tests/deep-link.spec.ts`
- Modify: `package.json` (`e2e:image`)
- Modify: `.github/workflows/ci.yml` (`build-image` job)
- Modify: `README.md` (End-to-end test, Continuous integration job table)

**Interfaces:**
- Consumes: Task 4's `scripts/image-build.sh` and `scripts/image-run.sh`.
- Produces: `E2E_TARGET=image`, `npm run e2e:image`, and the CI job `build-image`, which Task 9's release guard requires.

- [ ] **Step 1: Write the image-only spec**

Create `e2e/tests/deep-link.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

// Phase 30 (spec D15). In production one process serves the web export, and a
// reload on any screen asks the server for that screen's path. Only the image
// target has that server. `expo serve`, which the source target uses, has no
// fallback to index.html, and no other spec opens a path other than '/'.
test.skip(process.env.E2E_TARGET !== 'image', 'needs the image target: npm run e2e:image');

test('a reload on a deep link gets the app, not a 404', async ({ page }) => {
  const response = await page.goto('/session');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.locator('#root')).toBeAttached();
});

test('a missing bundle file is a 404, not the page', async ({ request }) => {
  const response = await request.get('/_expo/static/js/web/entry-does-not-exist.js');
  expect(response.status()).toBe(404);
});
```

- [ ] **Step 2: Point `APP_URL` at the API under the image target**

In `e2e/urls.ts`, replace the `APP_URL` doc comment and line:

```ts
/**
 * The web export. Under the image target (phase 30), the container serves the
 * export and the API from one origin, as production does, so the app's address
 * is the API's.
 */
export const APP_URL = process.env.E2E_TARGET === 'image' ? API_URL : requireEnv('E2E_APP_URL');
```

- [ ] **Step 3: Add the image target to the Playwright config**

In `e2e/playwright.config.ts`:

1. After the `REPO_ROOT` line, add:

```ts
// Phase 30. `image` runs the suite against the production image: one container
// serving the export and the API. Anything else is the source target below.
const TARGET = process.env.E2E_TARGET === 'image' ? 'image' : 'source';

// One environment for the server however it runs, so a variable a later phase
// adds here reaches the image too. Only the base URL differs from production;
// there is no stub mode inside the server.
const serverEnv = {
  PORT: String(new URL(API_URL).port),
  DATABASE_URL: E2E_DATABASE_URL,
  // Published on /health, so a probe that reaches the wrong server says so.
  LANE: process.env.LANE ?? 'main',
  GEMINI_BASE_URL: `${MOCKSERVER_URL}/${E2E_MOCK_NAMESPACE}`,
  GEMINI_API_KEY: 'e2e',
  GEMINI_MODEL: 'e2e-model',
};
```

2. Change the server entry's `env: { ... }` block to `env: serverEnv,` and move its explanatory comments onto `serverEnv` as above.

3. Move the two existing `webServer` entries, unchanged otherwise, into `const sourceServers = [ ... ];` declared before `export default defineConfig(...)`. Add:

```ts
const imageServer = {
  // Build and run chained in one entry, like the source target's export: the
  // bundle inside the image is built for this API_URL and no other.
  command: 'bash scripts/image-build.sh && bash scripts/image-run.sh',
  cwd: REPO_ROOT,
  env: {
    ...serverEnv,
    IMAGE_API_URL: API_URL,
    IMAGE: `lang-tutor:e2e-${process.env.LANE ?? 'main'}`,
  },
  url: `${API_URL}/health`,
  reuseExistingServer: false,
  // The whole monorepo install plus both builds, on a cold Docker cache.
  timeout: 900_000,
  // docker run passes SIGTERM on to the container. The default SIGKILL would
  // kill only the client and leave the container holding the port.
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 15_000 },
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
};
```

4. In `defineConfig`, set `webServer: TARGET === 'image' ? [imageServer] : sourceServers,`.

In the root `package.json` scripts, after `"e2e"`, add:

```json
    "e2e:image": "E2E_TARGET=image bash scripts/lane-env.sh npm run e2e --workspace e2e",
```

- [ ] **Step 4: Typecheck, then run both targets**

Run: `npm run typecheck && npm run lint:arch`
Expected: PASS. ADR 0006 R4 still sees `requireEnv` on the `APP_URL` line.

Run: `npm run e2e`
Expected: PASS, with the two deep-link tests reported as skipped.

Run: `npm run e2e:image`
Expected: PASS, including both deep-link tests. Afterwards `docker ps --filter name=lang-tutor-` lists nothing, which proves the graceful shutdown reached the container. If lanes are full, skip both runs and rely on CI.

- [ ] **Step 5: Add the CI job**

In `.github/workflows/ci.yml`, add after the `test-e2e` job:

```yaml
  # Phase 30. The production image, built and then driven by the whole e2e
  # suite: one container serving the export and the API from one origin, as
  # Lightsail runs it. The test-e2e run above stays, being faster and pointed at
  # the tsx server. The image is built for this job's own API address, so the one
  # difference from a release build is the URL inlined into the web bundle.
  build-image:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run db:up
      - name: Resolve Playwright version
        id: playwright
        working-directory: e2e
        run: |
          version=$(node -p 'require("@playwright/test/package.json").version')
          [ -n "$version" ] || { echo "could not resolve @playwright/test version" >&2; exit 1; }
          echo "version=$version" >> "$GITHUB_OUTPUT"
      - name: Cache Playwright browsers
        uses: actions/cache@v6
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ steps.playwright.outputs.version }}
      - name: Install Chromium
        working-directory: e2e
        run: npx playwright install --with-deps chromium
      - run: npm run e2e:image
      - name: Upload Playwright traces
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-traces-image
          path: e2e/test-results/
          if-no-files-found: ignore
          retention-days: 7
```

- [ ] **Step 6: Document it**

In `README.md`'s "End-to-end test" section, add:

```markdown
`npm run e2e:image` runs the same suite against the production image instead: it builds
the image for this lane's e2e address, runs one container serving both the app and the
API, and adds two specs only that target can pass (a reload on a deep link, and a 404 for
a missing bundle). CI runs both targets on every push.
```

In the "Continuous integration" section, change "runs six parallel jobs" to "runs seven parallel jobs" and "runs the same six by hand" to "runs the same seven by hand", and add this row after `test-e2e`:

```markdown
| `build-image` | `npm run db:up` | `npm run e2e:image` — the production image, built for this job's own address, driven by the whole Playwright suite plus the two image-only specs | 10-15 min |
```

- [ ] **Step 7: Commit**

```bash
git add e2e/urls.ts e2e/playwright.config.ts e2e/tests/deep-link.spec.ts package.json .github/workflows/ci.yml README.md
git commit -m "test(e2e): the suite runs against the production image in CI, deep links included"
```

---

### Task 6: `infra/bootstrap` — GitHub's roles and the image repository

**Files:**
- Create: `infra/bootstrap/versions.tf`, `infra/bootstrap/backend.tf`, `infra/bootstrap/variables.tf`, `infra/bootstrap/main.tf`, `infra/bootstrap/outputs.tf`, `infra/bootstrap/.terraform.lock.hcl` (generated)
- Create: `infra/README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces outputs `release_role_arn`, `plan_role_arn`, `ecr_repository_url`. The ECR repository `wordspal` (Task 7 reads it as a data source; Task 9 pushes to it). The release role trusts `repo:victor-prp/lang-tutor:ref:refs/tags/v*`; the plan role trusts `repo:victor-prp/lang-tutor:ref:refs/heads/*`.

Terraform is not installed on this machine. Every Terraform command in this task and the next runs through its official image. Define this once per shell:

```bash
tf() { docker run --rm -v "$PWD/infra:/infra" -w "/infra/$1" hashicorp/terraform:1.16.3 "${@:2}"; }
```

- [ ] **Step 1: Ignore Terraform's local files**

Append to `.gitignore`:

```
# Terraform (phase 30): provider caches and any state or plan written locally.
# State lives in S3; a local copy would hold the database password.
.terraform/
*.tfstate
*.tfstate.*
*.tfplan
```

- [ ] **Step 2: Write the stack**

Create `infra/bootstrap/versions.tf`:

```hcl
terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.66.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project = "wordspal"
      stack   = "bootstrap"
    }
  }
}
```

Create `infra/bootstrap/backend.tf`:

```hcl
# The state bucket is the one resource made by hand (docs/runbooks/hosting.md):
# a stack cannot keep its state in a bucket it creates. The bucket's name is
# passed at init by scripts/infra.sh, from TF_STATE_BUCKET, so no account-specific
# value is committed. use_lockfile is S3's own lock; no DynamoDB table.
terraform {
  backend "s3" {
    key          = "bootstrap.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

Create `infra/bootstrap/variables.tf`:

```hcl
variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "github_repository" {
  type    = string
  default = "victor-prp/lang-tutor"
}

variable "state_bucket" {
  description = "The Terraform state bucket, created by hand. Set TF_VAR_state_bucket."
  type        = string
}

variable "ecr_repository_name" {
  type    = string
  default = "wordspal"
}

variable "secret_prefix" {
  type    = string
  default = "wordspal/prod/"
}
```

Create `infra/bootstrap/main.tf`:

```hcl
# Phase 30 (spec D8, D9, D10). What GitHub needs before any release can run: a
# way to reach AWS without stored keys, and a private registry for the image.

data "aws_caller_identity" "current" {}

locals {
  account_id        = data.aws_caller_identity.current.account_id
  secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${var.secret_prefix}"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Tags are immutable, so a tag names one image forever. That is what makes a
# rollback an apply that points at an image which already exists.
resource "aws_ecr_repository" "app" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last twenty images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "trust" {
  for_each = {
    release = "repo:${var.github_repository}:ref:refs/tags/v*"
    plan    = "repo:${var.github_repository}:ref:refs/heads/*"
  }

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [each.value]
    }
  }
}

# --- the release role: v* tags only ------------------------------------------

resource "aws_iam_role" "release" {
  name               = "wordspal-release"
  assume_role_policy = data.aws_iam_policy_document.trust["release"].json
}

data "aws_iam_policy_document" "release" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushAndRepositoryPolicy"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DeleteRepositoryPolicy",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:GetLifecyclePolicy",
      "ecr:GetRepositoryPolicy",
      "ecr:InitiateLayerUpload",
      "ecr:ListTagsForResource",
      "ecr:PutImage",
      "ecr:SetRepositoryPolicy",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket}"]
  }

  statement {
    sid       = "ProdState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.state_bucket}/prod.tfstate*"]
  }

  statement {
    sid       = "ProdSecrets"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["${local.secret_arn_prefix}*"]
  }

  statement {
    sid       = "Lightsail"
    actions   = ["lightsail:*"]
    resources = ["*"]
  }

  statement {
    sid       = "Budget"
    actions   = ["budgets:*"]
    resources = ["arn:aws:budgets::${local.account_id}:budget/wordspal-*"]
  }
}

resource "aws_iam_role_policy" "release" {
  name   = "release"
  role   = aws_iam_role.release.id
  policy = data.aws_iam_policy_document.release.json
}

# --- the plan role: every branch push, read-only -----------------------------
# ReadOnlyAccess covers reading the state, Lightsail, ECR, IAM and budgets. Secret
# values are added on top because a plan resolves the secret data sources; that
# is the trust the spec's first risk names.

resource "aws_iam_role" "plan" {
  name               = "wordspal-plan"
  assume_role_policy = data.aws_iam_policy_document.trust["plan"].json
}

resource "aws_iam_role_policy_attachment" "plan_read_only" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn_prefix}*"]
  }
}

resource "aws_iam_role_policy" "plan_secrets" {
  name   = "read-prod-secrets"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan_secrets.json
}
```

Create `infra/bootstrap/outputs.tf`:

```hcl
output "release_role_arn" {
  description = "GitHub variable AWS_RELEASE_ROLE_ARN."
  value       = aws_iam_role.release.arn
}

output "plan_role_arn" {
  description = "GitHub variable AWS_PLAN_ROLE_ARN."
  value       = aws_iam_role.plan.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}
```

Create `infra/README.md`:

```markdown
# infra

Two Terraform stacks for production (phase 30). `bootstrap` holds what GitHub needs to reach
AWS and the image repository; `prod` holds the database, the container service, the
certificate, the budget and the deployment. Run both only through `scripts/infra.sh`, and
follow [the hosting runbook](../docs/runbooks/hosting.md) for the first apply.
```

- [ ] **Step 3: Validate, format and lock**

Run:

```bash
tf bootstrap init -backend=false -input=false
tf bootstrap validate
tf bootstrap fmt -check -recursive /infra
tf bootstrap providers lock -platform=linux_amd64 -platform=darwin_arm64
```

Expected: `Success! The configuration is valid.`, `fmt` prints nothing, and `infra/bootstrap/.terraform.lock.hcl` is written. If `fmt -check` lists a file, run `tf bootstrap fmt -recursive /infra` and check the diff.

- [ ] **Step 4: Commit**

```bash
git add .gitignore infra/README.md infra/bootstrap/*.tf infra/bootstrap/.terraform.lock.hcl
git commit -m "feat(infra): bootstrap stack — GitHub OIDC roles for release and plan, and the private image repository"
```

---

### Task 7: `infra/prod`, the one way to run Terraform, and the plan job

**Files:**
- Create: `infra/prod/versions.tf`, `infra/prod/backend.tf`, `infra/prod/variables.tf`, `infra/prod/main.tf`, `infra/prod/outputs.tf`, `infra/prod/.terraform.lock.hcl` (generated)
- Create: `scripts/infra.sh`, `scripts/test-infra.sh`
- Modify: `.github/workflows/ci.yml` (`check-adrs` step; `terraform-plan` job)
- Modify: `README.md` (Continuous integration job table)

**Interfaces:**
- Consumes: Task 6's ECR repository `wordspal` and the plan role.
- Produces: `scripts/infra.sh <bootstrap|prod> <init|plan|apply|output> [args]`, reading `TF_STATE_BUCKET`, optional `IMAGE_TAG` and `TERRAFORM`. Prod variables `image_tag`, `publicly_accessible`, `attach_domain`, `gemini_model`, `alert_email`, `secret_env_names`. Prod outputs `image_tag`, `public_url`, `service_url`, `app_cname_target`, `certificate_validation`, `database_endpoint`, `database_url` (sensitive). The `scale = 1` and absent `command` that Task 8's ADR checks.

- [ ] **Step 1: Write the failing `infra.sh` test**

Create `scripts/test-infra.sh` (executable):

```bash
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
```

Run: `chmod +x scripts/test-infra.sh && ./scripts/test-infra.sh`
Expected: FAIL on every check, because `scripts/infra.sh` does not exist.

- [ ] **Step 2: Write `scripts/infra.sh`**

Create `scripts/infra.sh` (executable):

```bash
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
```

Run: `chmod +x scripts/infra.sh && ./scripts/test-infra.sh`
Expected: `infra.sh ok (9 checks)`.

- [ ] **Step 3: Write the prod stack**

Create `infra/prod/versions.tf`:

```hcl
terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.66.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.1"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project = "wordspal"
      stack   = "prod"
    }
  }
}
```

Create `infra/prod/backend.tf`:

```hcl
# See infra/bootstrap/backend.tf: the bucket is named at init by scripts/infra.sh.
terraform {
  backend "s3" {
    key          = "prod.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

Create `infra/prod/variables.tf`:

```hcl
variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "availability_zone" {
  type    = string
  default = "eu-central-1a"
}

variable "domain" {
  type    = string
  default = "app.wordspal.ai"
}

variable "service_name" {
  type    = string
  default = "wordspal"
}

variable "ecr_repository_name" {
  type    = string
  default = "wordspal"
}

# Production's own port. Not lane 0's: production is not a lane.
variable "container_port" {
  type    = number
  default = 8080
}

variable "power" {
  description = "Lightsail power. micro is 0.25 vCPU and 1 GB; nano's 512 MB is tight for Node plus pg-boss."
  type        = string
  default     = "micro"
}

variable "db_blueprint_id" {
  description = "Check with: aws lightsail get-relational-database-blueprints (runbook step 3)."
  type        = string
  default     = "postgres_16"
}

variable "db_bundle_id" {
  description = "The 15 USD plan. Check with: aws lightsail get-relational-database-bundles (runbook step 3)."
  type        = string
  default     = "micro_2_0"
}

variable "publicly_accessible" {
  description = "True only while the dictionary is loaded from the laptop (spec D14)."
  type        = bool
  default     = false
}

variable "attach_domain" {
  description = "Flipped to true by a commit once the certificate is ISSUED (runbook step 11)."
  type        = bool
  default     = false
}

variable "image_tag" {
  description = "Set by scripts/infra.sh: the release's tag, or the live one from state. Empty means no deployment."
  type        = string
  default     = ""

  validation {
    condition     = var.image_tag == "" || can(regex("^v[0-9A-Za-z.-]+$", var.image_tag))
    error_message = "image_tag is empty or a v* release tag."
  }
}

variable "gemini_model" {
  description = "The GitHub variable GEMINI_MODEL, which the eval job also uses. Set TF_VAR_gemini_model."
  type        = string
}

variable "alert_email" {
  description = "Where the budget alert goes. The GitHub variable ALERT_EMAIL. Set TF_VAR_alert_email."
  type        = string
}

variable "monthly_budget_usd" {
  type    = string
  default = "40"
}

variable "pg_pool_max" {
  type    = number
  default = 5
}

variable "secret_prefix" {
  type    = string
  default = "wordspal/prod/"
}

variable "secret_env_names" {
  description = "Secrets Manager entries under secret_prefix, each passed to the container under its own name. Phase 29 appends BETTER_AUTH_SECRET and RESEND_API_KEY."
  type        = list(string)
  default     = ["GEMINI_API_KEY"]
}
```

Create `infra/prod/main.tf`:

```hcl
# Phase 30 (spec D7, D11, D12, D13). Production: one database, one container
# service at scale 1, its certificate, the budget alert, and the deployment.

# --- database ------------------------------------------------------------------

# Lightsail refuses /, " and @ in the password, and the password goes into a URL.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_lightsail_database" "app" {
  relational_database_name = "wordspal-db"
  availability_zone        = var.availability_zone
  master_database_name     = "wordspal"
  master_username          = "wordspal"
  master_password          = random_password.db.result
  blueprint_id             = var.db_blueprint_id
  bundle_id                = var.db_bundle_id
  publicly_accessible      = var.publicly_accessible
  backup_retention_enabled = true
  preferred_backup_window  = "01:00-01:30"
  apply_immediately        = true
  final_snapshot_name      = "wordspal-db-final"
}

# --- container service and certificate ----------------------------------------

resource "aws_lightsail_certificate" "app" {
  name        = "wordspal-app"
  domain_name = var.domain
}

resource "aws_lightsail_container_service" "app" {
  name  = var.service_name
  power = var.power
  scale = 1 # ADR 0010: one container, which migrates before it serves

  private_registry_access {
    ecr_image_puller_role {
      is_active = true
    }
  }

  dynamic "public_domain_names" {
    for_each = var.attach_domain ? [1] : []
    content {
      certificate {
        certificate_name = aws_lightsail_certificate.app.name
        domain_names     = [var.domain]
      }
    }
  }
}

# --- the image -----------------------------------------------------------------

data "aws_ecr_repository" "app" {
  name = var.ecr_repository_name
}

# The repository is bootstrap's; the puller role is this stack's, so the grant
# lives here.
resource "aws_ecr_repository_policy" "lightsail_pull" {
  repository = data.aws_ecr_repository.app.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LightsailPull"
      Effect    = "Allow"
      Principal = { AWS = aws_lightsail_container_service.app.private_registry_access[0].ecr_image_puller_role[0].principal_arn }
      Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    }]
  })
}

# --- environment ---------------------------------------------------------------

data "aws_secretsmanager_secret_version" "env" {
  for_each  = toset(var.secret_env_names)
  secret_id = "${var.secret_prefix}${each.key}"
}

locals {
  # verify-full against the RDS authority the image carries.
  database_url = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem",
    aws_lightsail_database.app.master_username,
    urlencode(random_password.db.result),
    aws_lightsail_database.app.master_endpoint_address,
    aws_lightsail_database.app.master_endpoint_port,
    aws_lightsail_database.app.master_database_name,
  )

  environment = merge(
    {
      DATABASE_URL = local.database_url
      PORT         = tostring(var.container_port)
      LANE         = "prod"
      PG_POOL_MAX  = tostring(var.pg_pool_max)
      GEMINI_MODEL = var.gemini_model
    },
    { for name, secret in data.aws_secretsmanager_secret_version.env : name => secret.secret_string },
  )
}

# --- the deployment --------------------------------------------------------------

# No deployment until a tag is given: the first apply from the laptop builds the
# infrastructure, and the first release creates the first deployment.
resource "aws_lightsail_container_service_deployment_version" "app" {
  count        = var.image_tag == "" ? 0 : 1
  service_name = aws_lightsail_container_service.app.name

  container {
    container_name = "app"
    image          = "${data.aws_ecr_repository.app.repository_url}:${var.image_tag}"
    environment    = local.environment
    ports = {
      (tostring(var.container_port)) = "HTTP"
    }
  }

  public_endpoint {
    container_name = "app"
    container_port = var.container_port

    health_check {
      path                = "/health"
      success_codes       = "200-299"
      interval_seconds    = 10
      timeout_seconds     = 5
      healthy_threshold   = 2
      unhealthy_threshold = 3
    }
  }

  depends_on = [aws_ecr_repository_policy.lightsail_pull]
}

# --- the bill --------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "wordspal-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
```

Create `infra/prod/outputs.tf`:

```hcl
output "image_tag" {
  description = "The tag of the last apply. scripts/infra.sh reads it back so a laptop apply keeps what is live."
  value       = var.image_tag
}

output "service_url" {
  value = aws_lightsail_container_service.app.url
}

output "public_url" {
  description = "Where the release workflow checks /health."
  value       = var.attach_domain ? "https://${var.domain}" : trimsuffix(aws_lightsail_container_service.app.url, "/")
}

output "app_cname_target" {
  description = "The value of the app CNAME at GoDaddy."
  value       = trimsuffix(trimprefix(aws_lightsail_container_service.app.url, "https://"), "/")
}

output "certificate_validation" {
  description = "The CNAME to add at GoDaddy so the certificate is issued."
  value = [for option in aws_lightsail_certificate.app.domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }]
}

output "database_endpoint" {
  value = aws_lightsail_database.app.master_endpoint_address
}

output "database_url" {
  value     = local.database_url
  sensitive = true
}
```

- [ ] **Step 4: Validate, format and lock**

Run:

```bash
tf prod init -backend=false -input=false
tf prod validate
tf prod fmt -check -recursive /infra
tf prod providers lock -platform=linux_amd64 -platform=darwin_arm64
```

Expected: valid, `fmt` prints nothing, `infra/prod/.terraform.lock.hcl` written. If `validate` rejects a block name, check the AWS provider 6.66.0 documentation for `aws_lightsail_container_service` (`private_registry_access`) and `aws_lightsail_container_service_deployment_version`, and fix the name to what that version documents.

- [ ] **Step 5: Add the CI pieces**

In `.github/workflows/ci.yml`, in the `check-adrs` job, after the `check-dockerfile-node.sh` step, add:

```yaml
      # Phase 30. infra.sh's tag resolution, against a stub terraform.
      - run: ./scripts/test-infra.sh
```

and add this job after `build-image`:

```yaml
  # Phase 30 (spec D7). fmt and validate need no AWS and always run. The plan
  # needs the plan role, which exists once infra/bootstrap has been applied: until
  # the AWS_PLAN_ROLE_ARN variable is set, the step says so and passes. -lock=false
  # keeps the job read-only, since a plan otherwise writes the state's lock file.
  terraform-plan:
    if: github.repository_owner == 'victor-prp'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      id-token: write
    env:
      TF_STATE_BUCKET: ${{ vars.TF_STATE_BUCKET }}
      TF_VAR_state_bucket: ${{ vars.TF_STATE_BUCKET }}
      TF_VAR_gemini_model: ${{ vars.GEMINI_MODEL }}
      TF_VAR_alert_email: ${{ vars.ALERT_EMAIL }}
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: 1.16.3
          terraform_wrapper: false
      - run: terraform fmt -check -recursive infra
      - name: Validate both stacks
        run: |
          for stack in bootstrap prod; do
            terraform -chdir="infra/$stack" init -backend=false -input=false
            terraform -chdir="infra/$stack" validate
          done
      - name: Assume the plan role
        if: vars.AWS_PLAN_ROLE_ARN != ''
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.AWS_PLAN_ROLE_ARN }}
          aws-region: eu-central-1
      - name: Plan both stacks
        env:
          PLAN_ROLE: ${{ vars.AWS_PLAN_ROLE_ARN }}
        run: |
          if [ -z "$PLAN_ROLE" ]; then
            echo "::notice::AWS_PLAN_ROLE_ARN is not set: infra/bootstrap has not been applied yet. fmt and validate ran; the plan was skipped."
            exit 0
          fi
          ./scripts/infra.sh bootstrap plan -lock=false
          ./scripts/infra.sh prod plan -lock=false
```

- [ ] **Step 6: Run the script tests and the architecture checks**

Run: `./scripts/test-infra.sh && npm run lint:arch`
Expected: PASS. The test scripts name no lane-0 port.

- [ ] **Step 7: Document the job**

In `README.md`'s "Continuous integration" section, change "seven parallel jobs" to "eight parallel jobs" and "the same seven" to "the same eight", and add this row after `build-image`:

```markdown
| `terraform-plan` | none | `terraform fmt -check` and `validate` on both stacks under `infra/`; then, once the `AWS_PLAN_ROLE_ARN` variable exists, a read-only `plan` of both through the plan role | 1 min |
```

- [ ] **Step 8: Commit**

```bash
git add infra/prod/*.tf infra/prod/.terraform.lock.hcl scripts/infra.sh scripts/test-infra.sh .github/workflows/ci.yml README.md
git commit -m "feat(infra): prod stack — database, container service, certificate, budget and the deployment, run through scripts/infra.sh"
```

---

### Task 8: ADR 0010 — production is one container, which migrates before it serves

**Files:**
- Create: `docs/adr/adr-0010-single-container-migrations.md`
- Create: `scripts/check-adr-0010-single-container-migrations.sh`
- Modify: `README.md` (ADR index row)

**Interfaces:**
- Consumes: Task 4's Dockerfile `CMD`, Task 7's `scale = 1` and the absence of `command` in `infra/prod`.

Invoke the `create-adr` skill. Its four questions are answered here, from the approved spec, so it does not need to ask them again unless its conflict scan finds something:

- **Scope:** `Dockerfile` and `infra/prod/*.tf`. No source tree, no test tree.
- **Corollaries:** R3, "nothing in `infra/prod` overrides the image's start command", is inferred, not stated by Victor. It is listed in the plan's refinements for his confirmation; report it under its own heading in the task's summary.
- **Exceptions:** none.
- **Status and Source:** `Accepted`; Source is the phase 30 design, D5.

Run the skill's conflict scan over `docs/adr/*.md` and README's Architecture section, and report what it finds. One known candidate: ADR 0006's prose about never writing a port; production's port 8080 is not a lane port, and the plan's refinement 3 keeps lane-0 values out of production configuration.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/adr-0010-single-container-migrations.md`:

````markdown
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
````

- [ ] **Step 2: Write the check script**

Create `scripts/check-adr-0010-single-container-migrations.sh` (executable):

```bash
#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0010-single-container-migrations.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. A match is a VIOLATION, so nothing here relies on
# grep's exit status, and `set -e` is deliberately absent.

set -u

cd "$(dirname "$0")/.." || exit 1

status=0

check() {
  rule="$1"
  fn="$2"
  output=$("$fn" 2>/dev/null)
  if [ -n "$output" ]; then
    printf '\n  VIOLATION  %s\n' "$rule" >&2
    printf '%s\n' "$output" | sed 's/^/             /' >&2
    status=1
  else
    printf '  ok         %s\n' "$rule"
  fi
}

r1() { { grep -qE '^[[:space:]]*scale[[:space:]]*=[[:space:]]*1[[:space:]]*(#.*)?$' infra/prod/main.tf || echo "infra/prod/main.tf: no scale = 1"; grep -nE '^[[:space:]]*scale[[:space:]]*=' infra/prod/*.tf | grep -vE 'scale[[:space:]]*=[[:space:]]*1[[:space:]]*(#.*)?$'; }; }

r2() { { grep -qF 'CMD ["sh", "-c", "node dist/cli.js && exec node dist/index.js"]' Dockerfile || echo "Dockerfile: no migrate-then-serve CMD"; grep -nE '^(CMD|ENTRYPOINT)' Dockerfile | grep -vF 'node dist/cli.js && exec node dist/index.js'; }; }

r3() { grep -nE '^[[:space:]]*command[[:space:]]*=' infra/prod/*.tf; }

echo "Checking the image and infra/prod against ADR 0010 (single-container migrations)"
echo

check "R1  production runs exactly one container"            r1
check "R2  the image migrates before it serves"              r2
check "R3  nothing overrides the image's start command"      r3

echo
if [ "$status" -ne 0 ]; then
  echo "Single-container check FAILED. See docs/adr/adr-0010-single-container-migrations.md" >&2
  echo "for what each rule protects and why." >&2
else
  echo "Single-container check passed: 3 rules, no violations."
fi

exit "$status"
```

Run: `chmod +x scripts/check-adr-0010-single-container-migrations.sh && npm run lint:arch`
Expected: the new section reports all three rules `ok`.

- [ ] **Step 3: See each rule fire**

For each, plant, run `npm run lint:arch`, expect a VIOLATION naming that rule with `file:line`, then restore:

1. R1: in `infra/prod/main.tf`, change `scale = 1 # ADR 0010...` to `scale = 2`. Expected: the `scale = 2` line is reported. Then delete the line instead. Expected: `infra/prod/main.tf: no scale = 1`.
2. R2: in `Dockerfile`, change the `CMD` to `CMD ["node", "dist/index.js"]`. Expected: both the missing-CMD message and the wrong line. Then restore and add a line `ENTRYPOINT ["node"]`. Expected: that line is reported.
3. R3: in `infra/prod/main.tf`, inside the `container` block, add `command = ["node", "dist/index.js"]`. Expected: that line is reported.

After restoring: `npm run lint:arch` reports every rule `ok`, and `git status --porcelain` shows only the ADR, the script and README.

- [ ] **Step 4: Check the mirror**

Run:

```bash
diff <(sed -n '/^```bash$/,/^```$/p' docs/adr/adr-0010-single-container-migrations.md | grep -vE '^(```|#|$)') \
     <(grep -E '^r[0-9]+\(\)' scripts/check-adr-0010-single-container-migrations.sh | sed -E 's/^r[0-9]+\(\) \{ (.*); \}$/\1/')
```

Expected: no output. The ADR's commands and the script's functions are the same text.

- [ ] **Step 5: Add the README index row**

In `README.md`, under "Architecture decision records", add after the 0008 row:

```markdown
| [0010](docs/adr/adr-0010-single-container-migrations.md) | Production is one container, which migrates the database before it serves — `scale = 1` in `infra/prod`, the Dockerfile's `CMD` migrates first, nothing overrides it |
```

If phase 29 has merged by now and holds 0009, this number stands. If phase 29 took 0010, rename this ADR and its script to the next free number and update every reference.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/adr-0010-single-container-migrations.md scripts/check-adr-0010-single-container-migrations.sh README.md
git commit -m "docs(adr): ADR 0010 — production is one container, which migrates before it serves"
```

---

### Task 9: The release workflow

**Files:**
- Create: `scripts/release-guard.sh`, `scripts/test-release-guard.sh`
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml` (trigger; `check-adrs` step)

**Interfaces:**
- Consumes: Task 5's `build-image` and Task 7's `terraform-plan` job names; Task 6's release role and ECR repository; Task 7's `scripts/infra.sh` and `public_url` output; Task 1's `version` on `/health`.
- Produces: `scripts/release-guard.sh`, reading check-run JSON on stdin and printing `ok` (exit 0), `pending` (exit 3) or `failed` (exit 1).

- [ ] **Step 1: Write the failing guard test**

Create `scripts/test-release-guard.sh` (executable):

```bash
#!/usr/bin/env bash
#
# Tests scripts/release-guard.sh (phase 30) against hand-written check-run lists.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
status=0
checks=0

ALL="check-adrs check-types test-unit test-integration test-e2e build-image terraform-plan"

runs() { # runs <name:status:conclusion>... -> the JSON GitHub's API returns, trimmed
  local first=1
  printf '['
  for spec in "$@"; do
    IFS=: read -r name state conclusion <<< "$spec"
    [ "$first" = 1 ] || printf ','
    first=0
    if [ -n "$conclusion" ]; then
      printf '{"name":"%s","status":"%s","conclusion":"%s"}' "$name" "$state" "$conclusion"
    else
      printf '{"name":"%s","status":"%s","conclusion":null}' "$name" "$state"
    fi
  done
  printf ']'
}

all_passed() { for n in $ALL; do printf '%s:completed:success ' "$n"; done; }

expect() { # expect <label> <verdict> <runs json>
  local label="$1" want="$2" json="$3" got
  checks=$((checks + 1))
  got=$(printf '%s' "$json" | bash "$REPO/scripts/release-guard.sh" 2> /dev/null)
  if [ "$got" = "$want" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s (expected %s, got %s)\n' "$label" "$want" "$got" >&2
    status=1
  fi
}

echo "Testing scripts/release-guard.sh"
echo

# shellcheck disable=SC2046
expect "every required job passed" ok "$(runs $(all_passed))"
# shellcheck disable=SC2046
expect "a red test-eval alone does not block" ok "$(runs $(all_passed) test-eval:completed:failure)"
expect "a failed e2e run blocks" failed \
  "$(runs check-adrs:completed:success check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:failure build-image:completed:success \
          terraform-plan:completed:success)"
expect "a skipped required job blocks" failed \
  "$(runs check-adrs:completed:skipped check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:completed:success \
          terraform-plan:completed:success)"
expect "a job still running means wait" pending \
  "$(runs check-adrs:completed:success check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:in_progress: \
          terraform-plan:completed:success)"
expect "a job not yet started means wait" pending \
  "$(runs check-adrs:completed:success check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:completed:success)"
expect "a failure wins over a job still running" failed \
  "$(runs check-adrs:completed:failure check-types:in_progress: test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:completed:success \
          terraform-plan:completed:success)"

echo
if [ "$status" -ne 0 ]; then
  echo "release-guard.sh FAILED ($checks checks)" >&2
else
  echo "release-guard.sh ok ($checks checks)"
fi
exit "$status"
```

Run: `chmod +x scripts/test-release-guard.sh && ./scripts/test-release-guard.sh`
Expected: FAIL on every check, because `scripts/release-guard.sh` does not exist.

- [ ] **Step 2: Write the guard**

Create `scripts/release-guard.sh` (executable):

```bash
#!/usr/bin/env bash
#
# Decides whether a commit's CI allows a release (phase 30, spec D6). Reads the
# commit's latest check runs as JSON on stdin:
#
#   [{"name": "test-unit", "status": "completed", "conclusion": "success"}, ...]
#
# Prints one word: `ok` (exit 0), `pending` (exit 3) or `failed` (exit 1), with
# the reason on stderr. A failure wins over a job still running.
#
# test-eval is deliberately not required: it calls a third party and can go red
# with nothing wrong in the commit (CLAUDE.md), and a model update must not block
# a release. Its result is still on the commit for anyone who wants it.

set -u

REQUIRED="check-adrs check-types test-unit test-integration test-e2e build-image terraform-plan"

runs=$(cat)
pending=""
failed=""

for name in $REQUIRED; do
  run=$(printf '%s' "$runs" | jq -c --arg n "$name" '[.[] | select(.name == $n)] | first // empty')
  if [ -z "$run" ]; then
    pending="$pending $name"
    continue
  fi
  state=$(printf '%s' "$run" | jq -r '.status')
  conclusion=$(printf '%s' "$run" | jq -r '.conclusion // ""')
  if [ "$state" != completed ]; then
    pending="$pending $name"
  elif [ "$conclusion" != success ]; then
    failed="$failed $name($conclusion)"
  fi
done

if [ -n "$failed" ]; then
  echo failed
  echo "release-guard: CI did not pass:$failed" >&2
  exit 1
fi
if [ -n "$pending" ]; then
  echo pending
  echo "release-guard: still waiting on:$pending" >&2
  exit 3
fi
echo ok
```

Run: `chmod +x scripts/release-guard.sh && ./scripts/test-release-guard.sh`
Expected: `release-guard.sh ok (7 checks)`.

- [ ] **Step 3: Write the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

# Phase 30 (spec D6–D9). A release is a pushed v* tag on a master commit, after
# Victor has merged and tested master locally.
#
# Rollback is this workflow run by hand FROM an earlier tag: Actions → Release →
# Run workflow → pick the tag, or `gh workflow run release.yml --ref v2026.10.08`.
# The release role trusts tag refs only, so the tag is the ref, not an input.
# Tags are immutable in ECR, so that image already exists: a rollback skips the
# build and is one Terraform apply.
on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read

# Releases queue; one never cancels another mid-apply.
concurrency:
  group: release
  cancel-in-progress: false

env:
  AWS_REGION: eu-central-1
  ECR_REPOSITORY: wordspal
  TAG: ${{ github.ref_name }}

jobs:
  guard:
    if: github.repository_owner == 'victor-prp'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
      checks: read
    steps:
      - name: Only a v* tag releases
        run: |
          case "$GITHUB_REF" in
            refs/tags/v*) ;;
            *) echo "::error::Run this from a v* tag, not $GITHUB_REF"; exit 1 ;;
          esac
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: The tag is on master
        run: |
          git merge-base --is-ancestor "$GITHUB_SHA" origin/master ||
            { echo "::error::$TAG ($GITHUB_SHA) is not on master"; exit 1; }
      # Waits for CI to finish on this commit: a tag pushed right after the merge
      # would otherwise race the checks it depends on.
      - name: CI passed for this commit
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          verdict=pending
          for attempt in $(seq 1 80); do
            verdict=$(gh api "repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/check-runs?filter=latest&per_page=100" \
              --jq '[.check_runs[] | {name, status, conclusion}]' | ./scripts/release-guard.sh) && break
            [ "$verdict" = pending ] || exit 1
            sleep 30
          done
          [ "$verdict" = ok ] || { echo "::error::CI for $GITHUB_SHA did not finish within 40 minutes"; exit 1; }

  build-push:
    needs: guard
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v5
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.AWS_RELEASE_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - name: Build and push, unless this tag's image exists
        env:
          IMAGE: ${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ env.TAG }}
        run: |
          if aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids "imageTag=$TAG" > /dev/null 2>&1; then
            echo "::notice::$IMAGE already exists (a rollback or a rerun); deploying it as it is."
            exit 0
          fi
          # No EXPO_PUBLIC_API_URL argument: the web export reads
          # apps/mobile/.env.production, which is the point of a release build.
          docker build --build-arg "APP_VERSION=$TAG" -t "$IMAGE" .
          docker push "$IMAGE"

  apply:
    needs: build-push
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
      id-token: write
    env:
      TF_STATE_BUCKET: ${{ vars.TF_STATE_BUCKET }}
      TF_VAR_gemini_model: ${{ vars.GEMINI_MODEL }}
      TF_VAR_alert_email: ${{ vars.ALERT_EMAIL }}
      IMAGE_TAG: ${{ github.ref_name }}
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: 1.16.3
          terraform_wrapper: false
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.AWS_RELEASE_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
      - run: ./scripts/infra.sh prod apply -auto-approve
      # A green run means the tag is what answers, not only that Terraform
      # finished.
      - name: The released tag is what answers
        run: |
          url=$(./scripts/infra.sh prod output -raw public_url)
          for attempt in $(seq 1 40); do
            body=$(curl -fsS "$url/health" || true)
            version=$(printf '%s' "$body" | jq -r '.version // empty' 2> /dev/null || true)
            ok=$(printf '%s' "$body" | jq -r '.ok // empty' 2> /dev/null || true)
            if [ "$version" = "$TAG" ] && [ "$ok" = true ]; then
              echo "$url answers $TAG"
              exit 0
            fi
            echo "waiting: $url/health says version=${version:-?} ok=${ok:-?}"
            sleep 15
          done
          echo "::error::$url never reported $TAG with ok: true"
          exit 1
```

- [ ] **Step 4: Keep CI off tags, and run the guard test there**

In `.github/workflows/ci.yml`, change the trigger to:

```yaml
on:
  push:
    # Branches only: a v* tag starts the release workflow, which reads this
    # commit's results instead of running the suite a second time.
    branches: ['**']
  workflow_dispatch:
```

and in the `check-adrs` job, after the `test-infra.sh` step, add:

```yaml
      # Phase 30. The release guard's verdicts, against hand-written check runs.
      - run: ./scripts/test-release-guard.sh
```

- [ ] **Step 5: Lint the workflows**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color .github/workflows/ci.yml .github/workflows/release.yml`
Expected: no findings. If the image tag is not available, run `npx --yes yaml-lint .github/workflows/*.yml` at least, and say which check ran.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-guard.sh scripts/test-release-guard.sh .github/workflows/release.yml .github/workflows/ci.yml
git commit -m "ci: release by v* tag — guard on master and CI, build to ECR, terraform apply, check /health"
```

---

### Task 10: The runbook and the README

**Files:**
- Create: `docs/runbooks/hosting.md`
- Modify: `README.md` (Reading the API: the public-host paragraph; Continuous integration: a Releasing subsection)

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/hosting.md`:

````markdown
# Hosting runbook

Production is `https://app.wordspal.ai`: one Lightsail container in `eu-central-1` running
the image a `v*` tag built, against one Lightsail Postgres. Everything in AWS is Terraform
under `infra/`, run only through `scripts/infra.sh`. Design:
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
3. **What Lightsail offers today.** If either answer differs from `infra/prod/variables.tf`
   (`postgres_16`, `micro_2_0`), change the default in a commit before step 6:

   ```bash
   aws lightsail get-relational-database-blueprints --region eu-central-1 \
     --query "blueprints[?engine=='postgres'].[blueprintId,engineVersion]" --output table
   aws lightsail get-relational-database-bundles --region eu-central-1 \
     --query "bundles[?isActive].[bundleId,price,ramSizeInGb]" --output table
   ```

   Take the newest Postgres (17 if offered), and the 15-dollar bundle.
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
9. **The dictionary, once** (spec D14):

   ```bash
   ./scripts/infra.sh prod apply -var publicly_accessible=true
   curl -fsSo "$TMPDIR/rds-global-bundle.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   DATABASE_URL="$(./scripts/infra.sh prod output -raw database_url \
     | sed "s#/app/certs/rds-global-bundle.pem#$TMPDIR/rds-global-bundle.pem#")" npm run dict:restore
   ./scripts/infra.sh prod apply
   ```

   The restore migrates first, then loads the checked-in file, about two minutes; a rerun is
   harmless. The last apply closes the database again. The first container start re-stamps
   the database comment, which the restore wrote from your laptop's lane.
10. **The first release.** Merge, pull, test master locally, then
    `git tag v$(date +%Y.%m.%d) && git push origin --tags`. The Release workflow waits for CI,
    builds, pushes, applies, and checks `/health` on the service's default address (the domain
    is not attached yet). On that address only `/health` is meaningful: the web export calls
    `https://app.wordspal.ai`.
11. **The domain.** In a commit on a branch, set `attach_domain`'s default to `true` in
    `infra/prod/variables.tf`; merge it. Then `./scripts/infra.sh prod apply` from the main
    checkout (it keeps the live tag), and at GoDaddy add CNAME `app` →
    `./scripts/infra.sh prod output -raw app_cname_target`.
12. **Done means.** Open `https://app.wordspal.ai` on a phone's browser, sign up, save a word.
    `curl https://app.wordspal.ai/health` names the tag. `npm run mobile:prod` on the phone
    reaches production. The next day, with the laptop closed, the word is still there.

## Releasing

Merge, test master locally, then push a tag: `git tag v2026.10.08 && git push origin v2026.10.08`
(a second release that day is `v2026.10.08.2`). Merging alone deploys nothing.

A red Release run leaves the previous deployment serving: Lightsail switches only to a
container whose `/health` passes. Read the failing step first; a migration failure shows in
the container log (below).

## Rolling back

`gh workflow run release.yml --ref <earlier tag>`, or Actions → Release → Run workflow → pick
the tag. The image exists, so this is one apply, one to two minutes. Rolling back past a
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

1. Write `wordspal/prod/BETTER_AUTH_SECRET` (`openssl rand -base64 32`) and
   `wordspal/prod/RESEND_API_KEY` as in go-live step 4.
2. In `infra/prod`: append both names to `secret_env_names`, and add `AUTH_BASE_URL` and
   `WEB_ORIGINS` (both `https://app.wordspal.ai`) and `MAIL_FROM` to the environment map.
3. Release. Phase 29's migrations run on that container's start (ADR 0010). That release
   closes the exposure window the phase 30 design describes.
````

- [ ] **Step 2: Update the README**

1. Under "Reading the API", replace the paragraph that ends "**must not** reach a public host in this state." with:

```markdown
`POST /api/translations` reaches a paid third-party model **on a miss** — a string already
in the dictionary is answered from Postgres in milliseconds and costs nothing. Production
is public at `https://app.wordspal.ai` since phase 30, and until phase 29's sign-in merges
there is no authentication and no rate limit in front of this endpoint: anyone who finds the
site can open a learner's data by username and spend the production Gemini key on new words.
The key is production's own and revocable in one place, and a budget alert watches the bill.
Phase 29 merging, then a release, closes that window
([hosting runbook](docs/runbooks/hosting.md#when-phase-29-merges)).
```

2. Under "Continuous integration", add a subsection at its end:

```markdown
### Releasing

A release is a pushed `v*` tag on a commit already on `master`, after testing master locally:
`git tag v2026.10.08 && git push origin v2026.10.08`. The Release workflow waits for that
commit's CI (every job but `test-eval`), builds the image into ECR, runs `terraform apply`
through `scripts/infra.sh`, and goes green only when `/health` names the tag. Rolling back is
the same workflow run from an earlier tag. Everything else, from the first apply to reading
the container's log, is in the [hosting runbook](docs/runbooks/hosting.md).
```

- [ ] **Step 3: Check every link and command named in the runbook exists**

Run:

```bash
for f in scripts/infra.sh docs/adr/adr-0010-single-container-migrations.md infra/prod/variables.tf \
         docs/superpowers/specs/2026-10-08-lang-tutor-phase-30-hosting-design.md; do test -e "$f" || echo "missing $f"; done
grep -n "certificate_validation\|app_cname_target\|database_url\|public_url\|release_role_arn\|plan_role_arn" infra/*/outputs.tf | wc -l
```

Expected: no `missing` lines; the count is `6`.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/hosting.md README.md
git commit -m "docs: hosting runbook, releasing, and the exposure window until phase 29"
```

---

### After Task 10

- Run the whole local gate once: `npm run typecheck && npm test && npm run lint:arch && npm run test:lanes && ./scripts/test-mobile-prod.sh && ./scripts/test-infra.sh && ./scripts/test-release-guard.sh && ./scripts/check-dockerfile-node.sh`, plus `npm run test:all` and both e2e targets if a lane is free.
- Then `superpowers:finishing-a-development-branch`, which per CLAUDE.md takes "Push and create a Pull Request" through `git-create-pr`, then `ci-green`. The new `terraform-plan` job passes with a notice until go-live step 6 sets `AWS_PLAN_ROLE_ARN`.
- Go-live is Victor's, after merge, following `docs/runbooks/hosting.md`. Nothing in this plan touches AWS or GoDaddy.
