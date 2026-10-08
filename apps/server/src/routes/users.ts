import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { CreateUserRequestSchema, ErrorSchema, UserSchema } from '@lang-tutor/core/api/schemas';

import { ProfileExists, UsernameTaken } from '../errors';
import type { UserService } from '../services/users';
import { signedInResponses, type ActorEnv } from './actor';

const createUserRoute = createRoute({
  method: 'post',
  path: '/users',
  tags: ['users'],
  summary: 'Create your profile',
  description:
    "Onboarding. Creates the signed-in user's profile under their own id. The username is the public handle tutors invite by.",
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateUserRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The profile was created.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The username is taken, or this user already has a profile.',
    },
    ...signedInResponses,
  },
});

// Transport only: parse, validate, map an outcome to a status code. Mounted at
// /api, so this publishes as /api/users.
export function createUsersRouter(users: UserService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload; the
  // contract says { error: 'invalid request' } and this is what keeps it saying so.
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createUserRoute, async (c) => {
    const input = c.req.valid('json');
    try {
      return c.json(await users.createProfile(c.var.actor, input), 201);
    } catch (error) {
      if (error instanceof UsernameTaken) return c.json({ error: 'username is already taken' }, 409);
      if (error instanceof ProfileExists) return c.json({ error: 'profile exists' }, 409);
      throw error; // app.ts's onError turns anything else into a 500
    }
  });

  return router;
}
