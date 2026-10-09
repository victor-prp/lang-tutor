import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AuthErrorSchema,
  GetSessionResponseSchema,
  SendCodeRequestSchema,
  SendCodeResponseSchema,
  SignInWithCodeRequestSchema,
  SignInWithCodeResponseSchema,
  SignOutResponseSchema,
} from '@lang-tutor/core/api/schemas';
import type { Env } from 'hono';

/** The cookie Better Auth sets; `__Secure-` prefixed once the API is served over HTTPS. */
export const SESSION_COOKIE = 'better-auth.session_token';

const err = (description: string) => ({ description, content: { 'application/json': { schema: AuthErrorSchema } } });

/**
 * Phase 29 (spec D14, ADR 0003's second exception). The four Better Auth paths
 * app.ts mounts are not createRoutes, so they are described here, in the same
 * registry, from packages/core schemas: the document shows exactly what answers.
 * Also declares the session scheme every other operation requires.
 */
export function registerAuthDocs<E extends Env>(app: OpenAPIHono<E>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description: 'Set by POST /api/auth/sign-in/email-otp. The app sends it as a Cookie header on the phone.',
  });
  const tags = ['auth'];
  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/api/auth/email-otp/send-verification-otp',
    tags,
    summary: 'Email a sign-in code',
    description:
      'Emails an 8-digit code, valid for 10 minutes, to any address: sign-up, sign-in and recovery are this one flow. A new code cancels the previous one. At most 5 codes per address per hour; only `type: sign-in`.',
    security: [],
    request: { body: { required: true, content: { 'application/json': { schema: SendCodeRequestSchema } } } },
    responses: {
      200: { description: 'The code was sent.', content: { 'application/json': { schema: SendCodeResponseSchema } } },
      400: err('Not an address this server sends to, or a type other than sign-in.'),
      429: err('Five codes were already sent to this address in the last hour.'),
      503: err('The email provider did not take the message.'),
    },
  });
  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/api/auth/sign-in/email-otp',
    tags,
    summary: 'Sign in (or up) with the emailed code',
    description:
      'Creates a session and sets its cookie. A new address gets a sign-in identity and no profile: POST /api/users creates it. Three wrong tries end the code.',
    security: [],
    request: { body: { required: true, content: { 'application/json': { schema: SignInWithCodeRequestSchema } } } },
    responses: {
      200: { description: 'Signed in.', content: { 'application/json': { schema: SignInWithCodeResponseSchema } } },
      400: err('Wrong or expired code (INVALID_OTP, OTP_EXPIRED).'),
      403: err('Three wrong tries (TOO_MANY_ATTEMPTS): send a new code.'),
    },
  });
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/api/auth/get-session',
    tags,
    summary: 'The session behind this cookie',
    security: [],
    responses: {
      200: { description: 'The session, or null.', content: { 'application/json': { schema: GetSessionResponseSchema } } },
    },
  });
  app.openAPIRegistry.registerPath({
    method: 'post',
    path: '/api/auth/sign-out',
    tags,
    summary: 'End this session',
    security: [],
    responses: {
      200: { description: 'The session is revoked.', content: { 'application/json': { schema: SignOutResponseSchema } } },
    },
  });
}
