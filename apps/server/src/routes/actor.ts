import { ErrorSchema } from '@lang-tutor/core/api/schemas';
import type { MiddlewareHandler } from 'hono';

/**
 * Phase 29 (spec D11, ADR 0009 R3; replaces phase 28's asserted header). The
 * ONE place a request becomes an actor: the signed-in user behind the session
 * cookie. Routes read `c.var.actor` and nothing else; no header, body field or
 * path segment can name a user.
 */
export type ActorEnv = { Variables: { actor: string; actorEmail: string } };

/** Signed in is enough for these two; every other /api route needs a profile. */
export const PROFILE_EXEMPT = [
  { method: 'GET', path: '/api/me' },
  { method: 'POST', path: '/api/users' },
] as const;

export function createSessionMiddleware(deps: {
  sessionOf: (headers: Headers) => Promise<{ userId: string; email: string } | null>;
  hasProfile: (userId: string) => Promise<boolean>;
  profileExempt: readonly { method: string; path: string }[];
}): MiddlewareHandler<ActorEnv> {
  return async (c, next) => {
    const session = await deps.sessionOf(c.req.raw.headers);
    if (!session) return c.json({ error: 'not signed in' }, 401);
    const exempt = deps.profileExempt.some((e) => e.method === c.req.method && e.path === c.req.path);
    if (!exempt && !(await deps.hasProfile(session.userId))) return c.json({ error: 'profile required' }, 403);
    c.set('actor', session.userId);
    c.set('actorEmail', session.email);
    await next();
  };
}

const errorBody = { 'application/json': { schema: ErrorSchema } };

// Not `as const`: a deeply readonly `content` no longer matches the adapter's
// response mapping, and a handler's 403 would stop type-checking.

/** Spread into a signed-in route's `responses`. */
export const signedInResponses = {
  401: { content: errorBody, description: 'Not signed in.' },
};

/** Spread into every learner route's `responses`. */
export const learnerResponses = {
  ...signedInResponses,
  403: {
    content: errorBody,
    description: 'Signed in without a profile, or not allowed to act on this resource.',
  },
};

/**
 * Phase 29 (spec D13). A learner route's 403 that names its own rule. Placed
 * after the `learnerResponses` spread, so the document says who may act; the
 * gate still answers 403 to a session without a profile, so it says that too.
 */
export const forbidden = (rule: string) => ({
  content: errorBody,
  description: `Signed in without a profile (\`profile required\`), or ${rule} (\`forbidden\`).`,
});
