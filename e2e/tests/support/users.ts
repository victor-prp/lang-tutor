import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { CreateUserRequest, User } from '@lang-tutor/core/api';

import { API_URL } from '../../urls';
import { codeFor, expectEmails } from './mockServer';

export function learnerFor(username: string): CreateUserRequest {
  return { username, display_name: 'דנה', age: 34, native_language: 'he' };
}

/** One address per username: the e2e database is fresh each run. */
export const emailFor = (username: string): string => `${username}@e2e.example.com`;

/**
 * Signs `request` in through the real flow (code from MockServer) and creates
 * the profile. `page.request` shares the page's cookies, so the app then opens
 * signed in; a standalone request context is a second user.
 */
export async function signIn(request: APIRequestContext, username: string): Promise<void> {
  await expectEmails(request);
  const email = emailFor(username);
  const sent = await request.post(`${API_URL}/api/auth/email-otp/send-verification-otp`, { data: { email, type: 'sign-in' } });
  if (!sent.ok()) throw new Error(`send code for ${username}: ${sent.status()} ${await sent.text()}`);
  const signedIn = await request.post(`${API_URL}/api/auth/sign-in/email-otp`, {
    data: { email, otp: await codeFor(request, email) },
  });
  if (!signedIn.ok()) throw new Error(`sign in ${username}: ${signedIn.status()} ${await signedIn.text()}`);
}

export async function signUpUser(request: APIRequestContext, username: string, displayName = 'דנה'): Promise<User> {
  await signIn(request, username);
  const res = await request.post(`${API_URL}/api/users`, { data: { ...learnerFor(username), display_name: displayName } });
  if (!res.ok()) throw new Error(`profile ${username}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as User;
}

/** A signed-in learner with one enrollment, in this page's browser context. */
export async function signUpLearner(page: Page, username: string, targetLanguage: 'en' | 'ru' | 'it' = 'en'): Promise<User> {
  const user = await signUpUser(page.request, username);
  const enrolled = await page.request.post(`${API_URL}/api/enrollments`, {
    data: { source_language: 'he', target_language: targetLanguage },
  });
  if (!enrolled.ok()) throw new Error(`enroll ${username}: ${enrolled.status()} ${await enrolled.text()}`);
  return user;
}

/** Opens the app signed in. Retried: a static export serves markup before React hydrates. */
export async function openApp(page: Page, landing = 'start-button'): Promise<void> {
  await expect(async () => {
    await page.goto('/');
    await expect(page.getByTestId(landing)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}
