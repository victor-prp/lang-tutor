import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../../src/app';
import { createFakeLogger } from '../../support/fakes';
import { clearNamespace, codeSentTo, expectEmails, mailBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('auth-mount');
  await expectEmails(ns);
  app = createApp(
    createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), mailBaseUrl: mailBaseUrlFor(ns) }),
  );
});
afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('the auth mount', () => {
  it('sends a code through Resend and signs in through the app', async () => {
    const sent = await app.request(
      '/api/auth/email-otp/send-verification-otp',
      json({ email: 'm@example.com', type: 'sign-in' }),
    );
    expect(sent.status).toBe(200);
    const code = await codeSentTo(ns, 'm@example.com');
    const res = await app.request('/api/auth/sign-in/email-otp', json({ email: 'm@example.com', otp: code }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('better-auth.session_token=');
  });

  it.each([
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/update-user'],
    ['POST', '/api/auth/delete-user'],
    ['POST', '/api/auth/change-email'],
    ['GET', '/api/auth/list-sessions'],
    ['POST', '/api/auth/email-otp/reset-password'],
    ['POST', '/api/auth/forget-password/email-otp'],
    ['GET', '/api/auth/ok'],
  ])('answers 404 for %s %s without reaching Better Auth', async (method, path) => {
    const res = await app.request(path, method === 'GET' ? {} : json({}));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('admits a listed web origin with credentials and refuses another', async () => {
    const ok = await app.request('/health', { headers: { origin: 'https://web.example.test' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://web.example.test');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const other = await app.request('/health', { headers: { origin: 'https://other.example.test' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});
