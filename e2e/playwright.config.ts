import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { E2E_DATABASE_URL } from './globalSetup';
import { API_URL, APP_URL } from './urls';

const REPO_ROOT = path.resolve(__dirname, '..');

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
  webServer: [
    {
      command: 'npm run start -w apps/server',
      cwd: REPO_ROOT,
      env: { DATABASE_URL: E2E_DATABASE_URL },
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Build and serve chained in one entry so the bundle and the server
      // hosting it can never disagree. EXPO_PUBLIC_API_URL must be set HERE:
      // export-time inlining is the only thing that controls the app's API
      // target, and it overrides apps/mobile/.env.local without touching it.
      // Served on 8082, not Metro's default 8081: reuseExistingServer must
      // never let this entry silently attach to a `npm run mobile` dev server
      // a developer happens to have running elsewhere.
      command: 'npm run build:web -w apps/mobile && npm run serve:web -w apps/mobile',
      cwd: REPO_ROOT,
      url: APP_URL,
      env: { EXPO_PUBLIC_API_URL: API_URL },
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
  ],
});
