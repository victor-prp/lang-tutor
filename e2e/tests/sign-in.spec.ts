import { expect, test, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { lookUp, tapAndWaitForWrite, tapUntil } from './support/interactions';
import { PROCHITALA } from './support/lexemes';
import { codeFor, expectEmails } from './support/mockServer';
import { emailFor, openApp, signUpLearner } from './support/users';

test.setTimeout(120_000);

async function enterEmail(page: Page, email: string) {
  await expect(async () => {
    await page.goto('/');
    await expect(page.getByTestId('sign-in-email')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId('sign-in-email').fill(email);
  await page.getByTestId('sign-in-send').click();
  await expect(page.getByTestId('sign-in-sent-to')).toContainText(email);
}

test('a new learner signs up with a code, onboards, signs out and back in, and keeps their word', async ({ page, request }) => {
  await expectEmails(request);
  const email = emailFor('e2e_new_learner');

  await enterEmail(page, email);
  await page.getByTestId('sign-in-code').fill(await codeFor(request, email));
  await page.getByTestId('sign-in-submit').click();

  await expect(page.getByTestId('onboarding-username')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('onboarding-username').fill('e2e_new_learner');
  await page.getByTestId('onboarding-display-name').fill('יוני');
  await page.getByTestId('onboarding-age').fill('9');
  await page.getByTestId('native-he').click();
  await page.getByTestId('onboarding-submit').click();
  await expect(page.getByTestId('enroll-ru')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('enroll-ru').click();
  await page.getByTestId('enroll-submit').click();
  await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('profile-button')).toHaveText('יוני');

  // One saved word, through the app, as vocabulary.spec saves one.
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save').first());

  await openApp(page);
  await page.getByTestId('profile-button').click();
  await page.getByTestId('sign-out-button').click();
  await expect(page.getByTestId('sign-in-email')).toBeVisible({ timeout: 30_000 });
  // Signed out means the API refuses this browser now.
  expect((await page.request.get(`${API_URL}/api/enrollments`)).status()).toBe(401);

  // lookUp cleared the namespace, emails expectation included.
  await expectEmails(request);
  await enterEmail(page, email);
  await page.getByTestId('sign-in-code').fill(await codeFor(request, email));
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 30_000 });

  // The word is still there.
  const [enrollment] = (await (await page.request.get(`${API_URL}/api/enrollments`)).json()) as { id: string }[];
  const list = (await (await page.request.get(`${API_URL}/api/enrollments/${enrollment.id}/vocabulary`)).json()) as {
    items: unknown[];
  };
  expect(list.items).toHaveLength(1);
});

test('a wrong code says so and keeps the learner on the code screen', async ({ page, request }) => {
  await expectEmails(request);
  const email = emailFor('e2e_wrong_code');
  await enterEmail(page, email);
  const code = await codeFor(request, email);
  await page.getByTestId('sign-in-code').fill(code === '00000000' ? '11111111' : '00000000');
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('sign-in-error')).toHaveText('הקוד לא נכון. אפשר לנסות שוב.');
  await expect(page.getByTestId('start-button')).toHaveCount(0);
});

test('with no session the app opens on sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('sign-in-email')).toBeVisible({ timeout: 30_000 });
});

test('onboarding offers another address: it signs out and returns to sign-in', async ({ page, request }) => {
  await expectEmails(request);
  const email = emailFor('e2e_other_address');
  await enterEmail(page, email);
  await page.getByTestId('sign-in-code').fill(await codeFor(request, email));
  await page.getByTestId('sign-in-submit').click();

  await expect(page.getByTestId('onboarding-sign-out')).toHaveText('כתובת מייל אחרת', { timeout: 30_000 });
  await page.getByTestId('onboarding-sign-out').click();
  await expect(page.getByTestId('sign-in-email')).toBeVisible({ timeout: 30_000 });
  // Signed out on the server too, not only on the screen.
  expect((await page.request.get(`${API_URL}/api/me`)).status()).toBe(401);
});

test('the profile shows what onboarding collected', async ({ page }) => {
  await signUpLearner(page, 'e2e_profile');
  await openApp(page);
  await page.getByTestId('profile-button').click();
  await expect(page.getByTestId('profile-username')).toHaveText('e2e_profile');
  await expect(page.getByTestId('profile-name')).toHaveText('דנה');
  await expect(page.getByTestId('profile-age')).toHaveText('34');
  await expect(page.getByTestId('profile-native')).toHaveText('עברית');
  await expect(page.getByTestId('profile-target')).toHaveText('אנגלית');
});
