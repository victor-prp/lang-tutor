import { describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { PROFILE_EXEMPT, createSessionMiddleware, type ActorEnv } from './actor';

function appWith(session: { userId: string; email: string } | null, profile: boolean) {
  const app = new Hono<ActorEnv>();
  app.use(
    '/api/*',
    createSessionMiddleware({
      sessionOf: async () => session,
      hasProfile: async () => profile,
      profileExempt: PROFILE_EXEMPT,
    }),
  );
  // Echo stubs on a bare Hono, not API endpoints: `on` rather than the verb
  // helpers, which ADR 0003 R1 keeps for nothing under routes/ but createRoute.
  app.on('GET', '/api/me', (c) => c.json({ actor: c.var.actor, email: c.var.actorEmail }));
  app.on('POST', '/api/users', (c) => c.json({ actor: c.var.actor }, 201));
  app.on('GET', '/api/enrollments', (c) => c.json({ actor: c.var.actor }));
  return app;
}

describe('the session middleware', () => {
  it('refuses a request with no session: 401 not signed in', async () => {
    const res = await appWith(null, false).request('/api/enrollments');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not signed in' });
  });

  it('refuses a learner route to a session without a profile: 403 profile required', async () => {
    const res = await appWith({ userId: 'u1', email: 'a@example.com' }, false).request('/api/enrollments');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'profile required' });
  });

  it('lets a session without a profile reach GET /api/me and POST /api/users', async () => {
    const app = appWith({ userId: 'u1', email: 'a@example.com' }, false);
    expect(await (await app.request('/api/me')).json()).toEqual({ actor: 'u1', email: 'a@example.com' });
    expect((await app.request('/api/users', { method: 'POST' })).status).toBe(201);
  });

  it('sets the actor from the session, and nothing else can', async () => {
    const res = await appWith({ userId: 'u1', email: 'a@example.com' }, true).request('/api/enrollments', {
      headers: { 'x-acting-user-id': 'someone-else' },
    });
    expect(await res.json()).toEqual({ actor: 'u1' });
  });
});
