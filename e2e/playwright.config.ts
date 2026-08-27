import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { API_URL, APP_URL } from './urls';

const REPO_ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './tests',
  // One worker, no parallelism: the server keeps sessions in a shared in-memory
  // Map, so concurrent specs would interleave against the same store. There is
  // also only one spec.
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
