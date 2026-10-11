import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, createApi } from './api.ts';

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const entry = { method: init?.method ?? 'GET', url: String(input), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, fetch: fetch as typeof globalThis.fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the bot route carries the secret, and a bot\'s calls carry its cookie', async () => {
  const { seen, fetch } = fakeFetch((s) =>
    s.url.endsWith('/api/bots/sign-in') ? json({ cookie: 'a=b' }) : s.url.endsWith('/api/bots/day') ? new Response(null, { status: 204 }) : json([]),
  );
  const api = createApi({ baseUrl: 'http://server.test/', secret: 's3cret', fetch });

  const cookie = await api.route.signIn('steady-en');
  await api.route.setDay('steady-en', '2026-01-01');
  await api.as(cookie).enrollments();

  assert.deepEqual(
    seen.map((s) => [s.method, s.url]),
    [
      ['POST', 'http://server.test/api/bots/sign-in'],
      ['PUT', 'http://server.test/api/bots/day'],
      ['GET', 'http://server.test/api/enrollments'],
    ],
  );
  assert.equal(seen[0].headers.authorization, 'Bearer s3cret');
  assert.deepEqual(seen[1].body, { name: 'steady-en', day: '2026-01-01' });
  assert.equal(seen[2].headers.cookie, 'a=b');
  assert.equal(seen[2].headers.authorization, undefined, 'the secret goes to the bot route only');
});

test('a failed request is an ApiError with its status and body', async () => {
  const { fetch } = fakeFetch(() => json({ error: 'session_open' }, 409));
  const api = createApi({ baseUrl: 'http://server.test', secret: 's', fetch });
  await assert.rejects(api.as('a=b').createSession('e1', { listening: true, speaking: false }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.match(error.body, /session_open/);
    return true;
  });
});

test('a response that does not match the contract is a failed request too', async () => {
  const { fetch } = fakeFetch(() => json({ nonsense: true }));
  const api = createApi({ baseUrl: 'http://server.test', secret: 's', fetch });
  await assert.rejects(api.as('a=b').session('s1'), ApiError);
});

test('sign-out says it comes from the app, as the phone does, so the origin check admits it', async () => {
  const { seen, fetch } = fakeFetch(() => json({ success: true }));
  await createApi({ baseUrl: 'http://server.test', secret: 's', fetch }).as('a=b').signOut();
  assert.equal(seen[0].url, 'http://server.test/api/auth/sign-out');
  assert.equal(seen[0].headers['expo-origin'], 'langtutor://');
});
