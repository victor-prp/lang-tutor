import { createMiddleware } from 'hono/factory';

import type { ActorEnv } from '../../src/routes/actor';

/** The header route tests use to say who is acting. Tests only: production reads the session (ADR 0009 R3). */
export const ACT_AS = 'x-test-actor';

/** Mount before a router under test: sets the actor from ACT_AS (default 'u1'). */
export const actAs = () =>
  createMiddleware<ActorEnv>(async (c, next) => {
    c.set('actor', c.req.header(ACT_AS) ?? 'u1');
    c.set('actorEmail', `${c.req.header(ACT_AS) ?? 'u1'}@test.invalid`);
    await next();
  });
