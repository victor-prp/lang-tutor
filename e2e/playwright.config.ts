import path from 'node:path';

import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

import { E2E_DATABASE_URL } from './globalSetup';
import { E2E_MOCK_NAMESPACE } from './tests/support/mockServer';
import { API_URL, APP_URL, MOCKSERVER_URL } from './urls';

const REPO_ROOT = path.resolve(__dirname, '..');

type WebServer = Exclude<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>;

// Phase 30. `image` runs the suite against the production image: one container
// serving the export and the API. Anything else is the source target below.
const TARGET = process.env.E2E_TARGET === 'image' ? 'image' : 'source';

// One environment for the server however it runs, so a variable a later phase
// adds here reaches the image too.
const serverEnv = {
  PORT: String(new URL(API_URL).port),
  DATABASE_URL: E2E_DATABASE_URL,
  // Published on /health, so a probe that reaches the wrong server says so.
  LANE: process.env.LANE ?? 'main',
  // Only the base URL differs from production. There is no stub mode inside
  // the server.
  GEMINI_BASE_URL: `${MOCKSERVER_URL}/${E2E_MOCK_NAMESPACE}`,
  GEMINI_API_KEY: 'e2e',
  GEMINI_MODEL: 'e2e-model',
};

// The tsx server and `expo serve` over a fresh export, each on its own port.
const sourceServers: WebServer[] = [
  {
    command: 'npm run start -w apps/server',
    cwd: REPO_ROOT,
    env: serverEnv,
    url: `${API_URL}/health`,
    // Never reuse, not even locally. Until phase 15 this was `!process.env.CI`,
    // and on a developer's machine it silently attached the suite to whatever
    // held the port — the dev server, on the dictionary database, calling the
    // real provider. This entry now has a port of its own, so an occupied one
    // means a stray process and must fail the run loudly.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  {
    // Build and serve chained in one entry so the bundle and the server
    // hosting it can never disagree. EXPO_PUBLIC_API_URL must be set HERE:
    // export-time inlining is the only thing that controls the app's API
    // target, and it overrides apps/mobile/.env.development.local without touching it.
    // Served on this lane's e2e app port, never Metro's: reuseExistingServer
    // must never let this entry silently attach to a `npm run mobile` dev
    // server a developer happens to have running.
    command: 'npm run build:web -w apps/mobile && npm run serve:web -w apps/mobile',
    cwd: REPO_ROOT,
    url: APP_URL,
    env: { EXPO_PUBLIC_API_URL: API_URL, E2E_APP_PORT: new URL(APP_URL).port },
    // Deliberately not tied to CI: a stray process already on this port must
    // fail the run loudly (port already in use) rather than have Playwright
    // silently reuse it and run the test against the wrong server.
    reuseExistingServer: false,
    // Generous: Playwright starts counting before the export begins. ~9s warm,
    // materially slower on a cold Metro cache.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
];

const imageServer: WebServer = {
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
  gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  stdout: 'pipe',
  stderr: 'pipe',
};

export default defineConfig({
  testDir: './tests',
  // Not wired as Playwright's `globalSetup` hook: that hook runs after
  // `webServer` entries are already started and polled healthy, which is too
  // late for a server whose `/health` depends on the e2e database existing
  // (verified empirically — see the comment atop globalSetup.ts). Instead the
  // `e2e` npm script runs it directly before `playwright test` starts.
  // One worker, no parallelism: the server is a single process against a single
  // e2e database, so concurrent specs would interleave against shared session
  // rows. (Before phase 4 the shared state was an in-memory Map; the reason
  // changed, the setting did not.) There is also only one spec.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    // Left near default deliberately: the app is a pre-built static bundle, so
    // nothing compiles mid-test and page loads are fast. Under the Metro dev
    // server these would have needed raising — see the spec for why that
    // approach was rejected.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: TARGET === 'image' ? [imageServer] : sourceServers,
});
