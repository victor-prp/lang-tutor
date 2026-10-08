import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { CreateGrantRequestSchema, ErrorSchema, GrantListSchema, GrantSchema } from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { AccessDenied, GrantExists, GrantNotFound, NotLearning, OwnList, UserNotFound } from '../errors';
import type { GrantService } from '../services/grants';
import { forbidden, learnerResponses, type ActorEnv } from './actor';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const grantParams = z.object({ id: z.string() });

const inviteRoute = createRoute({
  method: 'post',
  path: '/grants',
  tags: ['grants'],
  summary: 'Invite a student: the signed-in user asks to tutor them in one language',
  description:
    "Creates a pending tutor grant on the student's enrollment in `target_language`. The student " +
    'must already be learning it. The grant allows nothing until the student accepts.',
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateGrantRequestSchema } } },
  },
  responses: {
    201: json(GrantSchema, 'The invite, pending.'),
    400: json(ErrorSchema, 'The body did not validate.'),
    404: json(ErrorSchema, 'No user has this username.'),
    409: json(
      ErrorSchema,
      '`not_learning`: the student is not learning this language. `own_list`: the signed-in user named ' +
        'themselves. `grant_exists`: the signed-in user already holds a grant on this list.',
    ),
    ...learnerResponses,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/grants',
  tags: ['grants'],
  summary: "The signed-in user's grants, both ways",
  description:
    '`tutors`: grants on the signed-in user’s own lists (their tutors, and invites to answer). ' +
    '`students`: grants the signed-in user holds. Pending and accepted, newest first.',
  responses: { 200: json(GrantListSchema, 'Both lists, possibly empty.'), ...learnerResponses },
});

const acceptRoute = createRoute({
  method: 'post',
  path: '/grants/{id}/accept',
  tags: ['grants'],
  summary: 'Accept an invite',
  description: "Only the list's owner may accept. Accepting an accepted grant answers it unchanged.",
  request: { params: grantParams },
  responses: {
    200: json(GrantSchema, 'The grant, accepted.'),
    404: json(ErrorSchema, 'No grant has this id.'),
    ...learnerResponses,
    403: forbidden("the caller is not the list's owner, who alone may accept or decline an invite"),
  },
});

const endRoute = createRoute({
  method: 'delete',
  path: '/grants/{id}',
  tags: ['grants'],
  summary: 'Decline, cancel or end a grant',
  description:
    'Either party may end a grant, pending or accepted. Words the grantee added stay in the list. ' +
    'Idempotent: a grant that does not exist also answers 204.',
  request: { params: grantParams },
  responses: {
    204: { description: 'The grant is gone.' },
    ...learnerResponses,
    403: forbidden('the caller is neither party to this grant'),
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createGrantsRouter(grants: GrantService) {
  const router = new OpenAPIHono<ActorEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(inviteRoute, async (c) => {
    try {
      return c.json(await grants.invite(c.var.actor, c.req.valid('json')), 201);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      if (error instanceof UserNotFound) return c.json({ error: 'user not found' }, 404);
      if (error instanceof NotLearning) return c.json({ error: 'not_learning' }, 409);
      if (error instanceof OwnList) return c.json({ error: 'own_list' }, 409);
      if (error instanceof GrantExists) return c.json({ error: 'grant_exists' }, 409);
      throw error;
    }
  });

  router.openapi(listRoute, async (c) => c.json(await grants.list(c.var.actor), 200));

  router.openapi(acceptRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await grants.accept(c.var.actor, id), 200);
    } catch (error) {
      if (error instanceof GrantNotFound) return c.json({ error: 'grant not found' }, 404);
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      throw error;
    }
  });

  router.openapi(endRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      await grants.end(c.var.actor, id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AccessDenied) return c.json({ error: 'forbidden' }, 403);
      throw error;
    }
  });

  return router;
}
