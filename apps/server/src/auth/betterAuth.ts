import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';

import type { Db } from '../db/client';
import { authAccounts, authSessions, authUsers, authVerifications } from '../db/schema';
import {
  SEND_LOG_RETENTION_MS,
  SEND_WINDOW_MS,
  isDeliverable,
  mayRequestCode,
  normalizeEmail,
} from '../domain/auth';
import { EmailNotSent } from '../errors';
import type { Logger } from '../logger';
import type { AuthRepo } from '../repo/auth';

/**
 * Phase 29 (spec D1–D8, ADR 0009). The ONE file that imports better-auth on the
 * server. Built only by composition.ts. Everything else sees `handler` (mounted
 * by app.ts on AUTH_PATHS only) and `sessionOf` (read by routes/actor.ts only).
 */
export const AUTH_BASE_PATH = '/api/auth';

/** Spec D3. Every other Better Auth endpoint stays unreachable. */
export const AUTH_PATHS = [
  { method: 'POST', path: '/email-otp/send-verification-otp' },
  { method: 'POST', path: '/sign-in/email-otp' },
  { method: 'GET', path: '/get-session' },
  { method: 'POST', path: '/sign-out' },
] as const satisfies readonly { method: 'GET' | 'POST'; path: string }[];

/** Expo Go and the app's own scheme (spec D15). */
export const NATIVE_ORIGINS = ['exp://', 'langtutor://'];

const SEND_PATH = '/email-otp/send-verification-otp';
const SESSION_TTL_S = 90 * 24 * 60 * 60;
const SESSION_RENEW_S = 24 * 60 * 60;

export type SendCode = (email: string, code: string) => Promise<void>;
export type SignedInUser = { userId: string; email: string };
export type SessionReader = { sessionOf: (headers: Headers) => Promise<SignedInUser | null> };

export function createAuth(deps: {
  db: Db;
  authRepo: AuthRepo;
  secret: string;
  baseUrl: string;
  webOrigins: string[];
  sendCode: SendCode;
  now: () => number;
  logger: Logger;
}) {
  const { authRepo, logger, now } = deps;
  // Better Auth awaits the sender but swallows whatever it throws and still
  // answers 200. So a failed send is remembered per request and turned into a
  // 503 by the after-hook below.
  const unsent = new WeakSet<Request>();

  const auth = betterAuth({
    secret: deps.secret,
    baseURL: deps.baseUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [...deps.webOrigins, ...NATIVE_ORIGINS],
    database: drizzleAdapter(deps.db, {
      provider: 'pg',
      schema: {
        auth_users: authUsers,
        auth_sessions: authSessions,
        auth_accounts: authAccounts,
        auth_verifications: authVerifications,
      },
    }),
    user: { modelName: 'auth_users' },
    session: {
      modelName: 'auth_sessions',
      expiresIn: SESSION_TTL_S,
      updateAge: SESSION_RENEW_S,
      cookieCache: { enabled: false },
    },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_verifications' },
    advanced: { database: { generateId: false } },
    // Spec D5: with no trusted client IP, Better Auth puts everyone in one
    // bucket per path. The hosting phase turns it on with trustedProxies.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    hooks: {
      // Spec D3/D4: only sign-in codes, never to .invalid, five an hour.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SEND_PATH) return;
        const body = (ctx.body ?? {}) as { email?: unknown; type?: unknown };
        if (body.type !== 'sign-in') {
          logger.info({ event: 'auth_code_refused', reason: 'type' });
          throw new APIError('BAD_REQUEST', { message: 'only sign-in codes' });
        }
        const email = normalizeEmail(String(body.email ?? ''));
        if (!isDeliverable(email)) {
          logger.info({ event: 'auth_code_refused', reason: 'invalid_domain' });
          throw new APIError('BAD_REQUEST', { message: 'undeliverable address' });
        }
        await authRepo.pruneSendsBefore(new Date(now() - SEND_LOG_RETENTION_MS));
        const recent = await authRepo.countSendsSince(email, new Date(now() - SEND_WINDOW_MS));
        if (!mayRequestCode(recent)) {
          logger.info({ event: 'auth_code_refused', reason: 'limit' });
          throw new APIError('TOO_MANY_REQUESTS', { message: 'too many codes' });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === SEND_PATH && ctx.request && unsent.has(ctx.request)) {
          throw new APIError('SERVICE_UNAVAILABLE', { message: 'email not sent' });
        }
      }),
    },
    databaseHooks: {
      user: { create: { after: async (user) => logger.info({ event: 'account_created', user_id: user.id }) } },
      session: { create: { after: async (session) => logger.info({ event: 'signed_in', user_id: session.userId }) } },
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email, otp }, ctx) => {
          try {
            await deps.sendCode(email, otp);
          } catch (error) {
            logger.info({
              event: 'email_not_sent',
              status: error instanceof EmailNotSent ? error.status : 'unknown',
            });
            if (ctx?.request) unsent.add(ctx.request);
            return;
          }
          await authRepo.recordSend(email);
          logger.info({ event: 'auth_code_sent' });
        },
      }),
      expo(),
    ],
  });

  return {
    paths: AUTH_PATHS,
    handler: (request: Request): Promise<Response> => auth.handler(request),
    sessionOf: async (headers: Headers): Promise<SignedInUser | null> => {
      const found = await auth.api.getSession({ headers });
      return found ? { userId: found.user.id, email: found.user.email } : null;
    },
  };
}

export type AuthModule = ReturnType<typeof createAuth>;
