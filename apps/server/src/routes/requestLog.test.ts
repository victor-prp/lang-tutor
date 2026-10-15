import { describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import type { Logger } from '../logger';
import { createRequestLog, redactBody } from './requestLog';

// A bare Hono with the log on /api/* and a few stub routes, the way
// apiLevel.test.ts tests its gate. The logger records what it is given; the
// clock moves 5 ms each time it is read.
function setup({ bodies = true }: { bodies?: boolean } = {}) {
  const events: Record<string, unknown>[] = [];
  const logger: Logger = { info: (event) => events.push(event), error: () => undefined };
  let clock = 1_000;
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: 'internal' }, 500));
  app.use('/api/*', createRequestLog({ logger, now: () => (clock += 5), bodies }));
  app.post('/api/echo', async (c) => c.json({ got: await c.req.json() }));
  app.post('/api/raw', async (c) => c.json({ got: await c.req.raw.text() }));
  app.get('/api/boom', () => {
    throw new Error('boom');
  });
  app.get('/health', (c) => c.json({ ok: true }));
  return { app, events };
}

const post = (body: string, headers: Record<string, string> = {}) => ({
  method: 'POST',
  body,
  headers: { 'content-type': 'application/json', ...headers },
});

const started = (events: Record<string, unknown>[]) => events.filter((e) => e.event === 'request_started');
const finished = (events: Record<string, unknown>[]) => events.filter((e) => e.event === 'request_finished');

describe('the request log', () => {
  it('writes a started and a finished line that share an id', async () => {
    const { app, events } = setup();
    const res = await app.request('/api/echo?x=1', post('{"a":1}'));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      expect.objectContaining({ event: 'request_started', req: 'r1', method: 'POST', path: '/api/echo', query: 'x=1', body: { a: 1 } }),
      expect.objectContaining({ event: 'request_finished', req: 'r1', method: 'POST', path: '/api/echo', status: 200, body: { got: { a: 1 } } }),
    ]);
    expect(finished(events)[0].duration_ms).toBeGreaterThan(0);
  });

  it('numbers each request in turn', async () => {
    const { app, events } = setup();
    await app.request('/api/echo', post('{}'));
    await app.request('/api/echo', post('{}'));
    expect(started(events).map((e) => e.req)).toEqual(['r1', 'r2']);
  });

  it('finishes a request whose handler threw as the 500 it became', async () => {
    const { app, events } = setup();
    await app.request('/api/boom');
    expect(finished(events)).toEqual([expect.objectContaining({ req: 'r1', status: 500 })]);
  });

  it('leaves only the started line while a request has not finished', async () => {
    const events: Record<string, unknown>[] = [];
    const logger: Logger = { info: (event) => events.push(event), error: () => undefined };
    let release: () => void = () => undefined;
    const app = new Hono();
    app.use('/api/*', createRequestLog({ logger, now: () => 0, bodies: true }));
    app.get('/api/slow', async (c) => {
      await new Promise<void>((resolve) => (release = resolve));
      return c.json({ ok: true });
    });

    const pending = app.request('/api/slow');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.map((e) => e.event)).toEqual(['request_started']);

    release();
    await pending;
    expect(events.map((e) => e.event)).toEqual(['request_started', 'request_finished']);
  });

  it('does not log outside /api', async () => {
    const { app, events } = setup();
    await app.request('/health');
    expect(events).toEqual([]);
  });

  it('masks the session cookie and the authorization header', async () => {
    const { app, events } = setup();
    await app.request('/api/echo', post('{}', { cookie: 'session=abc', authorization: 'Bearer s3cret', 'x-api-level': '7' }));
    expect(started(events)[0].headers).toEqual(
      expect.objectContaining({ cookie: '<masked>', authorization: '<masked>', 'x-api-level': '7' }),
    );
  });

  it('still hands the handler its body, read raw as Better Auth reads it', async () => {
    const { app, events } = setup();
    const res = await app.request('/api/raw', post('{"email":"a@b.c"}'));
    expect(await res.json()).toEqual({ got: '{"email":"a@b.c"}' });
    expect(started(events)[0].body).toEqual({ email: 'a@b.c' });
  });

  it('leaves out a request body too large to read', async () => {
    const { app, events } = setup();
    const big = JSON.stringify({ photo: 'x'.repeat(300_000) });
    const res = await app.request('/api/echo', post(big, { 'content-length': String(big.length) }));
    expect(res.status).toBe(200);
    expect(started(events)[0].body).toBe(`<omitted: ${big.length} bytes>`);
  });

  it('summarises a body that is not JSON', async () => {
    const { app, events } = setup();
    await app.request('/api/raw', { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } });
    expect(started(events)[0].body).toBe('<omitted: text/plain, 5 bytes>');
  });

  it('leaves out a JSON body that does not parse, and the request goes on', async () => {
    const { app, events } = setup();
    const res = await app.request('/api/raw', post('{not json'));
    expect(res.status).toBe(200);
    expect(started(events)[0].body).toBe('<omitted: unparsable json, 9 bytes>');
  });

  it('logs no body at all when bodies are off', async () => {
    const { app, events } = setup({ bodies: false });
    await app.request('/api/echo', post('{"a":1}'));
    expect(events.every((e) => !('body' in e))).toBe(true);
  });
});

describe('redactBody', () => {
  it('masks credential fields at any depth, whatever their case', () => {
    expect(
      redactBody({ token: 't', user: { accessToken: 'a', name: 'n' }, otp: '123456', list: [{ Password: 'p' }], clientSecret: 's' }),
    ).toEqual({ token: '<masked>', user: { accessToken: '<masked>', name: 'n' }, otp: '<masked>', list: [{ Password: '<masked>' }], clientSecret: '<masked>' });
  });

  it('leaves out a string long enough to be media', () => {
    expect(redactBody({ audio: 'a'.repeat(2_001), text: 'b'.repeat(2_000) })).toEqual({
      audio: '<omitted: 2001 chars>',
      text: 'b'.repeat(2_000),
    });
  });
});
