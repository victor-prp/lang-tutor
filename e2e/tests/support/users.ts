import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { CreateUserRequest, User } from '@lang-tutor/core/api';

import { API_URL } from '../../urls';

export function learnerFor(username: string): CreateUserRequest {
  return {
    username,
    display_name: 'דנה',
    age: 34,
    native_language: 'he',
  };
}

/** Phase 28. An account with no enrollment, under its own display name: a tutor
 *  who learns nothing, whose name the student will see on a label. */
export async function createUser(request: APIRequestContext, username: string, displayName: string): Promise<User> {
  const res = await request.post(`${API_URL}/api/users`, {
    data: { ...learnerFor(username), display_name: displayName },
  });
  if (!res.ok()) throw new Error(`could not create ${username}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as User;
}

/** Creates a learner AND their enrollment over the endpoints the app uses. No
 *  fixture seed and no test-only route: this is the production path. */
export async function createLearner(
  request: APIRequestContext,
  username: string,
  targetLanguage: 'en' | 'ru' | 'it' = 'en',
): Promise<User> {
  const res = await request.post(`${API_URL}/api/users`, { data: learnerFor(username) });
  if (!res.ok()) {
    throw new Error(`could not create ${username}: ${res.status()} ${await res.text()}`);
  }
  const user = (await res.json()) as User;
  const enrolled = await request.post(`${API_URL}/api/users/${user.id}/enrollments`, {
    data: { source_language: 'he', target_language: targetLanguage },
  });
  if (!enrolled.ok()) {
    throw new Error(`could not enroll ${username}: ${enrolled.status()} ${await enrolled.text()}`);
  }
  return user;
}

/** Drives the real login screen. The click is retried because a static export
 *  serves pre-rendered markup: a click before hydration is a silent no-op. */
export async function logIn(page: Page, username: string, landing = 'start-button'): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('login-username')).toBeVisible();
  await page.getByTestId('login-username').fill(username);

  await expect(async () => {
    await page.getByTestId('login-button').click();
    await expect(page.getByTestId(landing)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
