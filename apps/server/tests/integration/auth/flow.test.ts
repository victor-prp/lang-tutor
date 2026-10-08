import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { AUTH_BASE_PATH, createAuth, type AuthModule } from '../../../src/auth/betterAuth';
import { EmailNotSent } from '../../../src/errors';
import { createAuthRepo } from '../../../src/repo/auth';
import { createFakeLogger } from '../../support/fakes';
import { createTestDb, type TestDb } from '../../support/testDb';

const BASE = 'http://localhost:3999';
let t: TestDb;
let auth: AuthModule;
let codes: Map<string, string>;
let failSends: boolean;

beforeEach(async () => {
  t = await createTestDb();
  codes = new Map();
  failSends = false;
  auth = createAuth({
    db: t.db,
    authRepo: createAuthRepo(t.db),
    secret: 'test-secret-that-is-at-least-32-chars',
    baseUrl: BASE,
    webOrigins: ['https://web.example.test'],
    sendCode: async (email, code) => {
      if (failSends) throw new EmailNotSent(500);
      codes.set(email, code);
    },
    now: Date.now,
    logger: createFakeLogger(),
  });
});
afterEach(async () => {
  await t.close();
});

const post = (path: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${BASE}${AUTH_BASE_PATH}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
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
});

describe('our limits on sending', () => {
  it('sends five codes an hour to one address, counted case-blind, and refuses the sixth with 429', async () => {
    for (let i = 0; i < 5; i += 1) expect((await sendCode(i % 2 ? 'A@example.com' : 'a@example.com')).status).toBe(200);
    const res = await sendCode('a@example.com');
    expect(res.status).toBe(429);
    const sends = await t.db.execute(sql`select count(*)::int as n from auth_code_sends`);
    expect(sends.rows[0]).toEqual({ n: 5 });
  });

  it('answers 503 when the email is not sent, and does not count it', async () => {
    failSends = true;
    const res = await sendCode('a@example.com');
    expect(res.status).toBe(503);
    const sends = await t.db.execute(sql`select count(*)::int as n from auth_code_sends`);
    expect(sends.rows[0]).toEqual({ n: 0 });
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
