/**
 * Every address this suite uses, and the one place it reads them.
 *
 * No defaults, deliberately, and this is the one consumer in the repo with
 * none. The suite is always started through `npm run e2e`, which runs it under
 * scripts/lane-env.sh; a default would therefore never be the right answer, it
 * would just be a wrong one nobody noticed. `npx playwright test` on its own is
 * not supported and says so.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Run the e2e suite with 'npm run e2e', which derives ` +
        'every address for this lane through scripts/lane-env.sh.',
    );
  }
  return value;
}

/**
 * The Hono server started by playwright.config.ts's first webServer entry.
 *
 * A port of its own since phase 15, never the dev server's. Before it,
 * `reuseExistingServer` attached a local run to whatever held the dev port — in
 * practice a developer's own server, on the dictionary database, calling the
 * real provider. A port of its own makes that impossible rather than unlikely.
 */
export const API_URL = requireEnv('E2E_API_URL');

/** The static web export served by the second webServer entry. */
export const APP_URL = requireEnv('E2E_APP_URL');

/** The shared MockServer compose service, standing in for the Gemini API. */
export const MOCKSERVER_URL = requireEnv('MOCKSERVER_URL');
