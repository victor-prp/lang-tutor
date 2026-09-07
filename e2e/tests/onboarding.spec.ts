import { expect, test } from '@playwright/test';

import { createLearner, logIn } from './support/users';

// Three page loads and a handful of round trips — well inside this, and well
// above Playwright's 30s default.
test.setTimeout(120_000);

test('a new learner can create an account and reach the home screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-username')).toBeVisible();

  // Retried for the same reason session.spec.ts retries its start click: a
  // static export serves markup before React hydrates.
  await expect(async () => {
    await page.getByTestId('new-user-button').click();
    await expect(page.getByTestId('onboarding-username')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await page.getByTestId('onboarding-username').fill('e2e_new_learner');
  await page.getByTestId('onboarding-display-name').fill('יוני');
  await page.getByTestId('onboarding-age').fill('9');
  await page.getByTestId('native-he').click();
  await page.getByTestId('target-en').click();
  await page.getByTestId('onboarding-submit').click();

  // Landing on home is the assertion: it means the server issued an id and the
  // app adopted it.
  await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('profile-button')).toHaveText('יוני');
});

test('the profile shows what onboarding collected', async ({ page, request }) => {
  await createLearner(request, 'e2e_profile');
  await logIn(page, 'e2e_profile');

  await page.getByTestId('profile-button').click();

  await expect(page.getByTestId('profile-username')).toHaveText('e2e_profile');
  await expect(page.getByTestId('profile-name')).toHaveText('דנה');
  await expect(page.getByTestId('profile-age')).toHaveText('34');
  await expect(page.getByTestId('profile-native')).toHaveText('עברית');
  await expect(page.getByTestId('profile-target')).toHaveText('אנגלית');
});

test('switching user returns to a login screen that remembers the username', async ({
  page,
  request,
}) => {
  await createLearner(request, 'e2e_switch');
  await logIn(page, 'e2e_switch');

  await page.getByTestId('profile-button').click();
  await page.getByTestId('switch-user-button').click();

  const field = page.getByTestId('login-username');
  await expect(field).toBeVisible();
  // Kept on purpose: the whole point of remembering it is the one-tap return.
  await expect(field).toHaveValue('e2e_switch');
});

test('logging in as a username nobody registered shows an error', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-username')).toBeVisible();

  await page.getByTestId('login-username').fill('e2e_nobody');
  await expect(async () => {
    await page.getByTestId('login-button').click();
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // Still on the login screen — a failed login must not let anyone through.
  await expect(page.getByTestId('start-button')).toHaveCount(0);
});
