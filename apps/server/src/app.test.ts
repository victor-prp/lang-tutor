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

// The documentation routes need no database: after phase 5, createApp takes
// fakes. Their contents are asserted in src/openapi.test.ts once all three
// routes are declared; these two are the "it is mounted and it renders" pair.
describe('the documentation routes', () => {
  it('serves an OpenAPI 3.1 document at /openapi.json', async () => {
    const res = await createApp(depsWithPing(true)).request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('lang-tutor API');
    expect(Object.keys(doc.paths)).toContain('/health');
  });

  it('serves the Scalar reference at /docs', async () => {
    const res = await createApp(depsWithPing(true)).request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

// /health is the first route converted to a createRoute definition, so its
// declared statuses are the first proof that a route's failures are published
// rather than implied.
describe('the /health route definition', () => {
  it('declares both 200 and 503 in the document', async () => {
    const res = await createApp(depsWithPing(true)).request('/openapi.json');
    const doc = await res.json();
    expect(Object.keys(doc.paths['/health'].get.responses).sort()).toEqual(['200', '503']);
  });
});
