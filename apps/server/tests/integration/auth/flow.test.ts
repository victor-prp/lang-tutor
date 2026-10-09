import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { AUTH_BASE_PATH, createAuth, type AuthModule } from '../../../src/auth/betterAuth';
import { EmailNotSent } from '../../../src/errors';
import { createAuthRepo } from '../../../src/repo/auth';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

const BASE = 'http://localhost:3999';
const WEB = 'https://web.example.test';
let t: TestDb;
let auth: AuthModule;
let logger: FakeLogger;
let codes: Map<string, string>;
let failSends: boolean;

beforeEach(async () => {
  t = await createTestDb();
  codes = new Map();
  failSends = false;
  logger = createFakeLogger();
  auth = createAuth({
    db: t.db,
    authRepo: createAuthRepo(t.db),
    secret: 'test-secret-that-is-at-least-32-chars',
    baseUrl: BASE,
    webOrigins: [WEB],
    // Records every code it is handed, delivered or not: a failed send must
    // still leave nothing that code can sign in with.
    sendCode: async (email, code) => {
      codes.set(email, code);
      if (failSends) throw new EmailNotSent(500);
    },
    now: Date.now,
    logger,
  });
});
afterEach(async () => {
  await t.close();
});

// A request that carries a cookie also carries a trusted Origin, as the web
// build's do: Better Auth checks it (ruling 8), even under NODE_ENV=test.
const post = (path: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${BASE}${AUTH_BASE_PATH}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie, origin: WEB } : {}) },
      body: JSON.stringify(body),
    }),
  );
/** Sign-out with exactly these headers besides the cookie: no Origin unless given. */
const signOutWith = (cookie: string, headers: Record<string, string>) =>
  auth.handler(
    new Request(`${BASE}${AUTH_BASE_PATH}/sign-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: '{}',
    }),
  );
const sendCode = (email: string, type = 'sign-in') => post('/email-otp/send-verification-otp', { email, type });
const signIn = (email: string, otp: string) => post('/sign-in/email-otp', { email, otp });
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

describe('signing in with an emailed code', () => {
  it('signs a new address up: an identity, no profile, an 8-digit code stored hashed', async () => {
    expect((await sendCode('New@Example.com')).status).toBe(200);
    const code = codes.get('new@example.com')!;
    expect(code).toMatch(/^\d{8}$/);
    const stored = await t.db.execute(sql`select value from auth_verifications`);
    expect(JSON.stringify(stored.rows)).not.toContain(code);

    const res = await signIn('new@example.com', code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.email).toBe('new@example.com');
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    const profiles = await t.db.execute(sql`select count(*)::int as n from users`);
    expect(profiles.rows[0]).toEqual({ n: 0 });

    const session = await auth.sessionOf(new Headers({ cookie: cookieOf(res) }));
    expect(session).toEqual({ userId: body.user.id, email: 'new@example.com' });
  });

  it('refuses even the right code after three wrong tries', async () => {
    await sendCode('a@example.com');
    const code = codes.get('a@example.com')!;
    const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 3; i += 1) expect((await signIn('a@example.com', wrong)).status).toBe(400);
    const res = await signIn('a@example.com', code);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('accepts a code once', async () => {
    await sendCode('a@example.com');
    const code = codes.get('a@example.com')!;
    expect((await signIn('a@example.com', code)).status).toBe(200);
    expect((await signIn('a@example.com', code)).status).toBe(400);
  });

  it('cancels the previous code when a new one is sent', async () => {
    await sendCode('a@example.com');
    const first = codes.get('a@example.com')!;
    await sendCode('a@example.com');
    const second = codes.get('a@example.com')!;
    if (first !== second) expect((await signIn('a@example.com', first)).status).toBe(400);
    expect((await signIn('a@example.com', second)).status).toBe(200);
  });

  it('revokes the session on sign-out', async () => {
    await sendCode('a@example.com');
    const res = await signIn('a@example.com', codes.get('a@example.com')!);
    const cookie = cookieOf(res);
    expect(await auth.sessionOf(new Headers({ cookie }))).not.toBeNull();
    expect((await post('/sign-out', {}, cookie)).status).toBe(200);
    expect(await auth.sessionOf(new Headers({ cookie }))).toBeNull();
  });

  it('reads no session without a cookie', async () => {
    expect(await auth.sessionOf(new Headers())).toBeNull();
  });

  it('signs a claimed account in as its old self, and verifies its address', async () => {
    await seedUser(t.db, 'vic1');
    expect(await createAuthRepo(t.db).claimAccount({ username: 'vic1', email: 'Victor@Example.com' })).toBe('claimed');
    expect((await sendCode('victor@example.com')).status).toBe(200);
    const res = await signIn('victor@example.com', codes.get('victor@example.com')!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string; emailVerified: boolean } };
    expect(body.user).toMatchObject({ id: 'vic1', email: 'victor@example.com', emailVerified: true });
  });
});

describe("Better Auth's origin check is on, test runs included", () => {
  const signedIn = async (): Promise<string> => {
    await sendCode('a@example.com');
    return cookieOf(await signIn('a@example.com', codes.get('a@example.com')!));
  };

  it('refuses a sign-out from an untrusted Origin and keeps the session', async () => {
    const cookie = await signedIn();
    expect((await signOutWith(cookie, { origin: 'https://evil.example.test' })).status).toBe(403);
    expect(await auth.sessionOf(new Headers({ cookie }))).not.toBeNull();
  });

  it('refuses a cookie-bearing sign-out with no Origin at all', async () => {
    const cookie = await signedIn();
    expect((await signOutWith(cookie, {})).status).toBe(403);
    expect(await auth.sessionOf(new Headers({ cookie }))).not.toBeNull();
  });

  it("admits the phone's sign-out: no Origin, the app's scheme in expo-origin", async () => {
    const cookie = await signedIn();
    expect((await signOutWith(cookie, { 'expo-origin': 'langtutor://' })).status).toBe(200);
    expect(await auth.sessionOf(new Headers({ cookie }))).toBeNull();
  });
});

describe("Better Auth's own log lines", () => {
  const SECRET_EMAIL = 'secret.person@example.com';
  const logged = () => JSON.stringify({ events: logger.events, errors: logger.errors });

  it('carry no email, code or session token across a whole flow', async () => {
    expect((await sendCode(SECRET_EMAIL)).status).toBe(200);
    const code = codes.get(SECRET_EMAIL)!;
    expect((await signIn(SECRET_EMAIL, code === '00000000' ? '11111111' : '00000000')).status).toBe(400);
    const res = await signIn(SECRET_EMAIL, code);
    const { token } = (await res.json()) as { token: string };
    const cookie = cookieOf(res);
    // Refused, and Better Auth logs the refusal: proof its lines reach ours.
    expect((await signOutWith(cookie, { origin: 'https://evil.example.test' })).status).toBe(403);
    expect((await post('/sign-out', {}, cookie)).status).toBe(200);

    expect(logged()).toContain('Invalid origin');
    for (const secret of [SECRET_EMAIL, code, token]) expect(logged()).not.toContain(secret);
  });

  it('pass a database failure on as a message, without the driver error and its parameters', async () => {
    expect((await sendCode(SECRET_EMAIL)).status).toBe(200);
    const res = await signIn(SECRET_EMAIL, codes.get(SECRET_EMAIL)!);
    const { token } = (await res.json()) as { token: string };
    await t.db.execute(
      sql.raw(`create function refuse_delete() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`),
    );
    await t.db.execute(sql`create trigger refuse before delete on auth_sessions for each row execute function refuse_delete()`);

    // Better Auth swallows the failed delete, logs it with the driver error
    // (whose text holds the token as a query parameter), and answers 200.
    expect((await post('/sign-out', {}, cookieOf(res))).status).toBe(200);

    expect(logger.errors.map((e) => e.message)).toContainEqual(expect.stringContaining('Failed to delete session'));
    expect(logger.errors.every((e) => e.cause === undefined)).toBe(true);
    expect(logged()).not.toContain(token);
  });
});

describe('the session slides only through get-session', () => {
  const expiresAtOf = async (): Promise<Date> => {
    const rows = await t.db.execute(sql`select expires_at from auth_sessions`);
    return new Date((rows.rows[0] as { expires_at: string | Date }).expires_at);
  };

  it('is read by sessionOf without extending it; get-session extends it and re-issues the cookie', async () => {
    await sendCode('a@example.com');
    const res = await signIn('a@example.com', codes.get('a@example.com')!);
    const cookie = cookieOf(res);
    const day = 24 * 60 * 60 * 1000;
    await t.db.execute(
      sql`update auth_sessions set expires_at = now() + interval '80 days', updated_at = now() - interval '10 days'`,
    );
    const before = await expiresAtOf();

    expect(await auth.sessionOf(new Headers({ cookie }))).toEqual({ userId: expect.any(String), email: 'a@example.com' });
    expect((await expiresAtOf()).getTime()).toBe(before.getTime());

    const got = await auth.handler(
      new Request(`${BASE}${AUTH_BASE_PATH}/get-session`, { method: 'GET', headers: { cookie, origin: WEB } }),
    );
    expect(got.status).toBe(200);
    expect(got.headers.get('set-cookie')).toContain('session_token=');
    const after = await expiresAtOf();
    expect(after.getTime() - Date.now()).toBeGreaterThan(89 * day);
  });
});

describe('our limits on sending', () => {
  it('sends five codes an hour to one address, counted case-blind, and refuses the sixth with 429', async () => {
    for (let i = 0; i < 5; i += 1) expect((await sendCode(i % 2 ? 'A@example.com' : 'a@example.com')).status).toBe(200);
    const res = await sendCode('a@example.com');
    expect(res.status).toBe(429);
    const sends = await t.db.execute(sql`select count(*)::int as n from auth_code_sends`);
    expect(sends.rows[0]).toEqual({ n: 5 });
  });

  it('answers 503 when the email is not sent, leaves no code that works, and does not count it', async () => {
    failSends = true;
    const res = await sendCode('a@example.com');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ message: 'email not sent' });

    // Better Auth stored this code before calling the sender (ruling 7).
    const undelivered = codes.get('a@example.com')!;
    const attempt = await signIn('a@example.com', undelivered);
    expect(attempt.status).toBe(400);
    expect(((await attempt.json()) as { code: string }).code).toBe('INVALID_OTP');
    const sends = await t.db.execute(sql`select count(*)::int as n from auth_code_sends`);
    expect(sends.rows[0]).toEqual({ n: 0 });
  });

  it('a failed send cancels the code sent before it, and leaves none', async () => {
    await sendCode('a@example.com');
    const delivered = codes.get('a@example.com')!;
    failSends = true;
    expect((await sendCode('a@example.com')).status).toBe(503);
    expect((await signIn('a@example.com', delivered)).status).toBe(400);
    const stored = await t.db.execute(sql`select count(*)::int as n from auth_verifications`);
    expect(stored.rows[0]).toEqual({ n: 0 });
  });

  it('refuses the reserved .invalid domain', async () => {
    expect((await sendCode('u1@unclaimed.invalid')).status).toBe(400);
    expect(codes.size).toBe(0);
  });

  it('refuses any code type but sign-in', async () => {
    for (const type of ['email-verification', 'forget-password']) {
      expect((await sendCode('a@example.com', type)).status).toBe(400);
    }
    expect(codes.size).toBe(0);
  });
});
