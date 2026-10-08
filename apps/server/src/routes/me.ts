import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { MeResponseSchema } from '@lang-tutor/core/api/schemas';

import type { UserService } from '../services/users';
import { signedInResponses, type ActorEnv } from './actor';

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['users'],
  summary: 'Who is signed in',
  description: 'The signed-in address and its profile; `user` is null until onboarding (POST /api/users).',
  responses: {
    200: { content: { 'application/json': { schema: MeResponseSchema } }, description: 'The signed-in user.' },
    ...signedInResponses,
  },
});

// Transport only (ADR 0001 R1). Mounted at /api, so this publishes as /api/me.
export function createMeRouter(users: UserService) {
  const router = new OpenAPIHono<ActorEnv>();
  router.openapi(meRoute, async (c) => c.json({ email: c.var.actorEmail, user: await users.me(c.var.actor) }, 200));
  return router;
}
