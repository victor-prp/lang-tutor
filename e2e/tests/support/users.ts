import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { CreateUserRequest, User } from '@lang-tutor/core/api';

import { API_URL } from '../../urls';

export function learnerFor(username: string): CreateUserRequest {
  return {
    username,
    display_name: 'דנה',
    age: 34,
    native_language: 'he',
    target_language: 'en',
  };
}

/** Creates a learner over the same endpoint the app uses. There is no fixture
 *  seed and no test-only route: this is the production path. */
export async function createLearner(
  request: APIRequestContext,
  username: string,
): Promise<User> {
  const res = await request.post(`${API_URL}/api/users`, { data: learnerFor(username) });
  if (!res.ok()) {
    throw new Error(`could not create ${username}: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as User;
}

/** Drives the real login screen. The click is retried because a static export
 *  serves pre-rendered markup: a click before hydration is a silent no-op. */
export async function logIn(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('login-username')).toBeVisible();
  await page.getByTestId('login-username').fill(username);

  await expect(async () => {
    await page.getByTestId('login-button').click();
    await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
