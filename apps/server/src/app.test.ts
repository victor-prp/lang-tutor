import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createApp } from './app';
import type { AppDeps } from './composition';
import { createServerDeps } from './composition';
import type { SessionService } from './services/sessions';
import { createFakeLogger } from '../tests/support/fakes';
import { createTestDb, type TestDb } from '../tests/support/testDb';

// A service that fails if it is called at all. Passing it alongside a health fake
// proves the health route never reaches the service, rather than assuming it.
const unreachableSessions: SessionService = {
  startSession: () => {
    throw new Error('the health route must not reach the session service');
  },
  submitAnswer: () => {
    throw new Error('the health route must not reach the session service');
  },
};

function depsWithPing(ok: boolean): AppDeps {
  return {
    sessions: unreachableSessions,
    health: { ping: async () => ok },
    logger: createFakeLogger(),
  };
}

// No database: the health route's two branches are now reachable with a fake,
// where before this task the 503 branch needed a real pool against localhost:1.
describe('GET /health', () => {
  it('returns 200 with ok: true when the health check passes', async () => {
    const res = await createApp(depsWithPing(true)).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 503 with ok: false when the health check fails', async () => {
    const res = await createApp(depsWithPing(false)).request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});

// This one keeps a real database on purpose: it asserts something about the app
// production actually assembles, so faking the service would assert nothing.
describe('the app as production assembles it', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('does not create a session as a side effect of a health check', async () => {
    const app = createApp(createServerDeps({ db: t.db, logger: createFakeLogger() }));
    await app.request('/health');
    const res = await app.request('/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', question_id: 'q-window', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });
});
