import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';
import { signUp, signUpWithProfile } from '../support/auth';
import { createFakeLogger } from '../support/fakes';
import { expectEmails, mailBaseUrlFor, mockNamespace } from '../support/mockServer';
import { createTestServerDeps } from '../support/serverDeps';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';

// The other half of this file's tests is src/app.test.ts, which covers /health
// against a fake ping and needs no database. This half keeps a real one on
// purpose: it asserts something about the app production actually assembles, so
// faking the service would assert nothing. From phase 29 every /api request
// here is signed in through the real flow, with codes "emailed" to MockServer.
describe('the app as production assembles it', () => {
  let t: TestDb;
  let ns: string;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    t = await createTestDb();
    ns = mockNamespace('app');
    await expectEmails(ns);
    app = createApp(
      createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), mailBaseUrl: mailBaseUrlFor(ns) }),
    );
    ({ cookie } = await signUpWithProfile(app, ns, { email: 'learner@example.com', username: 'learner' }));
  });

  afterEach(async () => {
    await t.close();
  });

  const signedIn = (headers: Record<string, string> = {}) => ({ ...headers, cookie });

  it('does not create a session as a side effect of a health check', async () => {
    await app.request('/health');
    const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
      method: 'POST',
      headers: signedIn({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question_id: 'q-window', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });

  // These exercise the fully-assembled app, not the bare-Hono mount in
  // tests/integration/routes/sessions.test.ts — the missing `body.required`
  // and the wrong-4xx-swallowed-into-500 behavior only show up here, because
  // that other file's buildTestApp has no app-level onError to swallow anything.
  describe('request body edge cases', () => {
    it('400s with { error: "invalid request" } for a bodyless request with no Content-Type', async () => {
      const res = await app.request('/api/sessions', { method: 'POST', headers: signedIn() });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('415s with { error: "invalid request" } for a non-JSON Content-Type', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: signedIn({ 'Content-Type': 'text/plain' }),
        body: '{"enrollment_id":"e_u1"}',
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('400s with { error: "invalid request" } for malformed JSON, not 500', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: signedIn({ 'Content-Type': 'application/json' }),
        body: '{not json',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    // Same three cases against /next-step: cheap to add and confirms the fix
    // isn't specific to createSessionRoute's body declaration.
    it('400s /next-step for a bodyless request with no Content-Type', async () => {
      const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
        method: 'POST',
        headers: signedIn(),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('415s /next-step for a non-JSON Content-Type', async () => {
      const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
        method: 'POST',
        headers: signedIn({ 'Content-Type': 'text/plain' }),
        body: '{"question_id":"q0","option_index":0}',
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('400s /next-step for malformed JSON, not 500', async () => {
      const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
        method: 'POST',
        headers: signedIn({ 'Content-Type': 'application/json' }),
        body: '{not json',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });
  });

  // Phase 29 (spec D11): the gate as production wires it — the session read by
  // Better Auth, the profile check by the user service.
  describe('the session gate', () => {
    const json = (body: unknown, headers: Record<string, string> = {}) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    it('answers 401 not signed in to an /api request with no session', async () => {
      const res = await app.request('/api/enrollments');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not signed in' });
    });

    it('takes a new address from sign-in through onboarding', async () => {
      const fresh = await signUp(app, ns, 'new@example.com');
      const as = { cookie: fresh.cookie };

      const learner = await app.request('/api/enrollments', { headers: as });
      expect(learner.status).toBe(403);
      expect(await learner.json()).toEqual({ error: 'profile required' });

      const before = await app.request('/api/me', { headers: as });
      expect(before.status).toBe(200);
      expect(await before.json()).toEqual({ email: 'new@example.com', user: null });

      const profile = { username: 'newcomer', display_name: 'חדש', age: 30, native_language: 'he' };
      const created = await app.request('/api/users', json(profile, as));
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ id: fresh.userId, ...profile });

      const after = await app.request('/api/me', { headers: as });
      expect(await after.json()).toEqual({ email: 'new@example.com', user: { id: fresh.userId, ...profile } });
      expect((await app.request('/api/enrollments', { headers: as })).status).toBe(200);
    });

    it('answers 409 profile exists to a second onboarding', async () => {
      const res = await app.request(
        '/api/users',
        json({ username: 'learner_two', display_name: 'שוב', age: 30, native_language: 'he' }, { cookie }),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'profile exists' });
    });

    it('enrolls the signed-in learner, whatever an old client still sends', async () => {
      const res = await app.request(
        '/api/enrollments',
        json({ source_language: 'he', target_language: 'ru' }, { cookie, 'X-Acting-User-Id': 'someone-else' }),
      );
      expect(res.status).toBe(201);
      const me = (await (await app.request('/api/me', { headers: { cookie } })).json()) as { user: { id: string } };
      expect(await res.json()).toMatchObject({ user_id: me.user.id, target_language: 'ru' });
    });
  });
});
