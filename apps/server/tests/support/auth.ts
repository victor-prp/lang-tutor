import type { CreateUserRequest } from '@lang-tutor/core/api';

import type { createApp } from '../../src/app';
import { codeSentTo } from './mockServer';

type App = ReturnType<typeof createApp>;
const json = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

/** Signs an address in through the real flow; `ns` must have expectEmails registered. */
export async function signUp(app: App, ns: string, email: string): Promise<{ cookie: string; userId: string }> {
  const sent = await app.request('/api/auth/email-otp/send-verification-otp', json({ email, type: 'sign-in' }));
  if (sent.status !== 200) throw new Error(`send code: ${sent.status} ${await sent.text()}`);
  const otp = await codeSentTo(ns, email);
  const res = await app.request('/api/auth/sign-in/email-otp', json({ email, otp }));
  if (res.status !== 200) throw new Error(`sign in: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const { user } = (await res.json()) as { user: { id: string } };
  return { cookie, userId: user.id };
}

/** signUp, then onboarding's POST /api/users (from Task 5 on). */
export async function signUpWithProfile(
  app: App,
  ns: string,
  input: { email: string; username: string; displayName?: string },
): Promise<{ cookie: string; userId: string }> {
  const signedIn = await signUp(app, ns, input.email);
  const profile: CreateUserRequest = {
    username: input.username,
    display_name: input.displayName ?? input.username,
    age: 30,
    native_language: 'he',
  };
  const res = await app.request('/api/users', json(profile, signedIn.cookie));
  if (res.status !== 201) throw new Error(`profile: ${res.status} ${await res.text()}`);
  return signedIn;
}
