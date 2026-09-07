import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';
import { createServerDeps } from '../../src/composition';
import { createFakeLogger } from '../support/fakes';
import { createTestDb, type TestDb } from '../support/testDb';
import { testRng } from '../support/testRng';

// The other half of this file's tests is src/app.test.ts, which covers /health
// against a fake ping and needs no database. This half keeps a real one on
// purpose: it asserts something about the app production actually assembles, so
// faking the service would assert nothing.
describe('the app as production assembles it', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('does not create a session as a side effect of a health check', async () => {
    const app = createApp(
      createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
    );
    await app.request('/health');
    const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u_1', question_id: 'q-window', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });

  // These three exercise the fully-assembled app, not the bare-Hono mount in
  // tests/integration/routes/sessions.test.ts — the missing `body.required`
  // and the wrong-4xx-swallowed-into-500 behavior only show up here, because
  // that other file's buildTestApp has no app-level onError to swallow anything.
  describe('request body edge cases', () => {
    it('400s with { error: "invalid request" } for a bodyless request with no Content-Type', async () => {
      const app = createApp(
        createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
      );
      const res = await app.request('/api/sessions', { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('415s with { error: "invalid request" } for a non-JSON Content-Type', async () => {
      const app = createApp(
        createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
      );
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"user_id":"u1"}',
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('400s with { error: "invalid request" } for malformed JSON, not 500', async () => {
      const app = createApp(
        createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
      );
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    // Same three cases against /next-step: cheap to add and confirms the fix
    // isn't specific to createSessionRoute's body declaration.
    it('400s /next-step for a bodyless request with no Content-Type', async () => {
      const app = createApp(
        createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
      );
      const res = await app.request(
        '/api/sessions/00000000-0000-0000-0000-000000000000/next-step',
        { method: 'POST' },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('415s /next-step for a non-JSON Content-Type', async () => {
      const app = createApp(
        createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
      );
      const res = await app.request(
        '/api/sessions/00000000-0000-0000-0000-000000000000/next-step',
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{"user_id":"u1","question_id":"q0","option_index":0}',
        },
      );
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });

    it('400s /next-step for malformed JSON, not 500', async () => {
      const app = createApp(
        createServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) }),
      );
      const res = await app.request(
        '/api/sessions/00000000-0000-0000-0000-000000000000/next-step',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not json',
        },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    });
  });
});
