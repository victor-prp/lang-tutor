import { expect, test } from '@playwright/test';

import { APP_COMMIT } from '../serverEnv';
import { openApp, signUpLearner } from './support/users';

test.setTimeout(120_000);

// The suite's builds carry no tag: the web export and the server are both `dev`,
// stamped with the commit `npm run e2e` runs on (scripts/with-commit.sh).
const shown = `dev (${APP_COMMIT.replace(/-dirty$/, ', uncommitted changes')})`;

// Phase 49 (spec D5). About names the release the build was made from, and the
// copy button puts the same three lines on the clipboard.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('About, opened from הגדרות, names the exact release and copies it', async ({ page }) => {
  await signUpLearner(page, 'e2e_about');
  await openApp(page);
  await page.getByTestId('settings-tab').click();
  await expect(page.getByTestId('app-version')).toContainText(shown);
  await page.getByTestId('app-version').click();

  await expect(page.getByTestId('about-mobile-app')).toHaveText(shown);
  await expect(page.getByTestId('about-server')).toHaveText(shown);
  await expect(page.getByTestId('about-native')).toHaveText('web');

  await page.getByTestId('about-copy').click();
  await expect(page.getByTestId('about-copy')).toHaveText('הועתק');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    ['WordsPal', `Mobile App: ${shown}`, `Server:     ${shown}`, 'Native:     web'].join('\n'),
  );
});
