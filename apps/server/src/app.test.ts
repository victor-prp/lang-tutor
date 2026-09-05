import { describe, expect, it } from '@jest/globals';

import { createApp } from './app';
import type { AppDeps } from './composition';
import type { SessionService } from './services/sessions';
import { createFakeLogger } from '../tests/support/fakes';

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

// No database: the health route's two branches are both reachable with a fake.
// The app's one database-backed case lives in tests/integration/app.test.ts.
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
