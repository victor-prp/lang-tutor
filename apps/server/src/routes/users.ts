import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  CreateUserRequestSchema,
  ErrorSchema,
  LoginRequestSchema,
  UserSchema,
} from '@lang-tutor/core/api/schemas';

import { InvalidLanguagePair, UsernameTaken, UserNotFound } from '../errors';
import type { UserService } from '../services/users';

const createUserRoute = createRoute({
  method: 'post',
  path: '/users',
  tags: ['users'],
  summary: 'Create an account',
  description:
    'Registers a learner. The id is issued by the server; an `id` in the request body is ignored.',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateUserRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The account was created.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate, or the two languages are the same.',
    },
    409: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'Another account already uses this username.',
    },
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['users'],
  summary: 'Identify a learner by username',
  description:
    'Returns the profile registered under this username. This performs NO authentication: there is no password, and holding a username proves nothing. Do not build an authorization decision on this endpoint. See ADR 0005.',
  request: {
    body: { required: true, content: { 'application/json': { schema: LoginRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: UserSchema } },
      description: 'The username is registered; this is its profile.',
    },
    400: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'The request body did not validate.',
    },
    404: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'No account uses this username.',
    },
  },
});

// Transport only: parse, validate, map an outcome to a status code. Mounted at
// /api, so these two paths publish as /api/users and /api/login.
export function createUsersRouter(users: UserService) {
  // Without this hook the adapter's own 400 carries a Zod issue payload; the
  // contract says { error: 'invalid request' } and this is what keeps it saying so.
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(createUserRoute, async (c) => {
    const input = c.req.valid('json');
    try {
      return c.json(await users.register(input), 201);
    } catch (error) {
      if (error instanceof UsernameTaken) {
        return c.json({ error: 'username is already taken' }, 409);
      }
      if (error instanceof InvalidLanguagePair) {
        return c.json({ error: 'native and target language must differ' }, 400);
      }
      throw error; // app.ts's onError turns anything else into a 500
    }
  });

  router.openapi(loginRoute, async (c) => {
    const { username } = c.req.valid('json');
    try {
      return c.json(await users.login(username), 200);
    } catch (error) {
      if (error instanceof UserNotFound) return c.json({ error: 'no such user' }, 404);
      throw error;
    }
  });

  return router;
}
