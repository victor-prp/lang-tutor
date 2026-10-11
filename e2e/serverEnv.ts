import { E2E_MOCK_NAMESPACE } from './tests/support/mockServer';
import { API_URL, APP_URL, MOCKSERVER_URL, requireEnv } from './urls';

/**
 * One environment for the e2e server however it runs: Playwright's webServer
 * (playwright.config.ts), the production image, and phase 35's bots dry run,
 * which starts the same server again after the suite (botsDryRun.ts). A variable a
 * later phase adds here reaches all three.
 */
export const serverEnv = {
  PORT: String(new URL(API_URL).port),
  // This lane's e2e database, rebuilt by globalSetup.ts on every run.
  DATABASE_URL: requireEnv('E2E_DATABASE_URL'),
  // Published on /health, so a probe that reaches the wrong server says so.
  LANE: process.env.LANE ?? 'main',
  // Only the base URL differs from production. There is no stub mode inside
  // the server.
  GEMINI_BASE_URL: `${MOCKSERVER_URL}/${E2E_MOCK_NAMESPACE}`,
  GEMINI_API_KEY: 'e2e',
  GEMINI_MODEL: 'e2e-model',
  // Phase 29. Sign-in: a fixed test secret, this run's origins, and Resend
  // faked by the lane's MockServer namespace, as Gemini is. Under the image
  // target the app and the API share one origin, so WEB_ORIGINS is the API's.
  BETTER_AUTH_SECRET: 'e2e-secret-that-is-at-least-32-characters',
  AUTH_BASE_URL: API_URL,
  WEB_ORIGINS: APP_URL,
  RESEND_API_KEY: 'e2e',
  RESEND_BASE_URL: `${MOCKSERVER_URL}/${E2E_MOCK_NAMESPACE}`,
  MAIL_FROM: 'e2e@example.com',
};
