import { describe, expect, it, jest } from '@jest/globals';

import { PushUnavailable } from '../errors';
import { createExpoPushClient, PUSH_TIMEOUT_MS } from './expoPush';

// What the provider returns is typed by services/reminders.ts, which providers/ may not import
// (ADR 0001 R10). The test names the shapes it needs by hand.
type Message = { to: string; title: string; body: string; channelId: string; data: Record<string, string> };

const message = (n: number): Message => ({
  to: `ExponentPushToken[${n}]`,
  title: 'הגיע הזמן לתרגל',
  body: 'כמה דקות עכשיו, והמילים נשארות בזיכרון.',
  channelId: 'reminders',
  data: { reminder_id: `r-${n}` },
});

const messages = (count: number): Message[] => Array.from({ length: count }, (_, i) => message(i));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; init: RequestInit };

/** A fake Expo: one ok ticket per message, its id naming the message's token. */
function expoFetch(answer?: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fake = jest.fn(async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    if (answer) return answer(call, calls.length - 1);
    const body = JSON.parse(init.body as string) as unknown;
    if (url.endsWith('/push/send')) {
      return json({ data: (body as Message[]).map((m) => ({ status: 'ok', id: `ticket-${m.to}` })) });
    }
    const ids = (body as { ids: string[] }).ids;
    return json({ data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) });
  });
  return { fetch: fake as unknown as typeof globalThis.fetch, calls, fake };
}

const clientOver = (fetch: typeof globalThis.fetch, timeoutMs = PUSH_TIMEOUT_MS) =>
  createExpoPushClient({ fetch, baseUrl: 'http://mock/ns', timeoutMs });

const bodyOf = (call: Call) => JSON.parse(call.init.body as string) as unknown;

describe('PUSH_TIMEOUT_MS', () => {
  it('is ten seconds, like the mailer', () => {
    expect(PUSH_TIMEOUT_MS).toBe(10_000);
  });
});

describe('send', () => {
  it('posts 150 messages as two calls of 100 and 50 and concatenates the tickets in order', async () => {
    const { fetch, calls } = expoFetch();
    const sent = messages(150);

    const tickets = await clientOver(fetch).send(sent);

    expect(calls).toHaveLength(2);
    expect((bodyOf(calls[0]) as Message[]).map((m) => m.to)).toEqual(sent.slice(0, 100).map((m) => m.to));
    expect((bodyOf(calls[1]) as Message[]).map((m) => m.to)).toEqual(sent.slice(100).map((m) => m.to));
    expect(tickets).toEqual(sent.map((m) => ({ status: 'ok', id: `ticket-${m.to}` })));
  });

  it('keeps one call for exactly 100 messages', async () => {
    const { fetch, calls } = expoFetch();
    await clientOver(fetch).send(messages(100));
    expect(calls).toHaveLength(1);
  });

  it('posts a JSON array to /--/api/v2/push/send with the two headers and a timeout signal', async () => {
    const { fetch, calls } = expoFetch();
    const sent = messages(2);

    await clientOver(fetch).send(sent);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('http://mock/ns/--/api/v2/push/send');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(calls[0])).toEqual(sent);
  });

  it('hands an error ticket back as it came, for the caller to read', async () => {
    const { fetch } = expoFetch(() =>
      json({
        data: [
          { status: 'ok', id: 'a' },
          { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
        ],
      }),
    );

    expect(await clientOver(fetch).send(messages(2))).toEqual([
      { status: 'ok', id: 'a' },
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
    ]);
  });

  it('calls nothing for no messages', async () => {
    const { fetch, fake } = expoFetch();
    expect(await clientOver(fetch).send([])).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  });

  it('turns a 500 into PushUnavailable carrying the status', async () => {
    const { fetch } = expoFetch(() => json({ errors: [{ message: 'boom' }] }, 500));
    const failure = await clientOver(fetch)
      .send(messages(1))
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PushUnavailable);
    expect(failure).toEqual(new PushUnavailable(500));
  });

  it('turns a fetch that throws into PushUnavailable', async () => {
    const fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const failure = await clientOver(fetch)
      .send(messages(1))
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PushUnavailable);
    expect(failure).toEqual(new PushUnavailable('network'));
  });

  it('turns a body without data into PushUnavailable', async () => {
    const { fetch } = expoFetch(() => json({ errors: [{ message: 'no' }] }));
    await expect(clientOver(fetch).send(messages(1))).rejects.toEqual(new PushUnavailable('unreadable'));
  });

  it('turns a body that is not JSON into PushUnavailable', async () => {
    const { fetch } = expoFetch(() => new Response('<html>bad gateway</html>', { status: 200 }));
    await expect(clientOver(fetch).send(messages(1))).rejects.toBeInstanceOf(PushUnavailable);
  });

  // Tickets are matched to messages by position. One short of the messages sent would hand a
  // device the ticket of its neighbour, and DeviceNotRegistered would delete the wrong token.
  it('refuses an answer with a different number of tickets than messages', async () => {
    const { fetch } = expoFetch(() => json({ data: [{ status: 'ok', id: 'only-one' }] }));
    await expect(clientOver(fetch).send(messages(2))).rejects.toEqual(new PushUnavailable('unreadable'));
  });

  it('refuses data that is not a list', async () => {
    const { fetch } = expoFetch(() => json({ data: { status: 'ok', id: 'x' } }));
    await expect(clientOver(fetch).send(messages(1))).rejects.toEqual(new PushUnavailable('unreadable'));
  });

  it('fails the whole call when a later chunk fails, rather than answering a partial list', async () => {
    const { fetch, calls } = expoFetch((call, index) =>
      index === 0
        ? json({ data: (bodyOf(call) as Message[]).map((m) => ({ status: 'ok', id: m.to })) })
        : json({}, 503),
    );
    await expect(clientOver(fetch).send(messages(150))).rejects.toEqual(new PushUnavailable(503));
    expect(calls).toHaveLength(2);
  });

  it('gives up after its budget', async () => {
    const fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof globalThis.fetch;
    await expect(clientOver(fetch, 20).send(messages(1))).rejects.toEqual(new PushUnavailable('timeout'));
  });
});

describe('receipts', () => {
  it('posts { ids } to /--/api/v2/push/getReceipts with the two headers and a timeout signal', async () => {
    const { fetch, calls } = expoFetch();

    const receipts = await clientOver(fetch).receipts(['a', 'b']);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('http://mock/ns/--/api/v2/push/getReceipts');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(calls[0])).toEqual({ ids: ['a', 'b'] });
    expect(receipts).toEqual({ a: { status: 'ok' }, b: { status: 'ok' } });
  });

  it('asks 2500 ids in chunks of at most 1000 and merges the answers', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`);
    const { fetch, calls } = expoFetch();

    const receipts = await clientOver(fetch).receipts(ids);

    expect(calls.map((c) => (bodyOf(c) as { ids: string[] }).ids.length)).toEqual([1000, 1000, 500]);
    expect(Object.keys(receipts)).toHaveLength(2500);
    expect(receipts['id-0']).toEqual({ status: 'ok' });
    expect(receipts['id-2499']).toEqual({ status: 'ok' });
  });

  it('keeps an error receipt as it came, and leaves out the ids Expo has no receipt for yet', async () => {
    const { fetch } = expoFetch(() =>
      json({ data: { a: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } } }),
    );

    expect(await clientOver(fetch).receipts(['a', 'b'])).toEqual({
      a: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    });
  });

  it('calls nothing for no ids', async () => {
    const { fetch, fake } = expoFetch();
    expect(await clientOver(fetch).receipts([])).toEqual({});
    expect(fake).not.toHaveBeenCalled();
  });

  it('turns a 500 into PushUnavailable carrying the status', async () => {
    const { fetch } = expoFetch(() => json({}, 500));
    await expect(clientOver(fetch).receipts(['a'])).rejects.toEqual(new PushUnavailable(500));
  });

  it('turns a fetch that throws into PushUnavailable', async () => {
    const fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(clientOver(fetch).receipts(['a'])).rejects.toEqual(new PushUnavailable('network'));
  });

  it('turns a body without data into PushUnavailable', async () => {
    const { fetch } = expoFetch(() => json({ errors: [] }));
    await expect(clientOver(fetch).receipts(['a'])).rejects.toEqual(new PushUnavailable('unreadable'));
  });

  it('refuses data that is a list rather than a map by id', async () => {
    const { fetch } = expoFetch(() => json({ data: [{ status: 'ok' }] }));
    await expect(clientOver(fetch).receipts(['a'])).rejects.toEqual(new PushUnavailable('unreadable'));
  });

  it('gives up after its budget', async () => {
    const fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof globalThis.fetch;
    await expect(clientOver(fetch, 20).receipts(['a'])).rejects.toEqual(new PushUnavailable('timeout'));
  });
});
