import { describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createApiLevelGate } from './apiLevel';

// Phase 32 (spec D9). A bare Hono with the gate at level 3 and an echo stub,
// the way actor.test.ts tests the session middleware.
function appAtLevel(apiLevel: number) {
  const app = new Hono();
  app.use('/api/*', createApiLevelGate({ apiLevel }));
  app.on('GET', '/api/me', (c) => c.json({ ok: true }));
  return app;
}

const at = (header: string | undefined) =>
  appAtLevel(3).request('/api/me', header === undefined ? {} : { headers: { 'X-Api-Level': header } });

describe('the API-level gate', () => {
  it('answers 426 app_update_required to a client below the server level', async () => {
    const res = await at('2');
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: 'app_update_required' });
  });

  it('lets a client at or above the server level through', async () => {
    expect((await at('3')).status).toBe(200);
    expect((await at('4')).status).toBe(200);
  });

  it('lets a request with no header through: the web app sends none', async () => {
    expect((await at(undefined)).status).toBe(200);
  });

  it('lets a garbled header through rather than lock a current client out', async () => {
    for (const garbled of ['', 'abc', '1.5', '-1']) {
      expect((await at(garbled)).status).toBe(200);
    }
  });
});
