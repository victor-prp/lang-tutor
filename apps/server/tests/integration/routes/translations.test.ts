import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createTranslationsRouter } from '../../../src/routes/translations';
import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  expectGeminiDelayedJson,
  expectGeminiJson,
  expectGeminiRawBody,
  expectGeminiStatus,
  geminiBaseUrlFor,
  mockNamespace,
  verifyGeminiHeader,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('routes-translations');
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

// Production's assembly with a per-test database and this test's own MockServer
// namespace. Nothing is injected into the server: the real Gemini client makes
// a real HTTP request over a real socket, and only the base URL differs from
// production.
function buildTestApp() {
  const deps = createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    geminiBaseUrl: geminiBaseUrlFor(ns),
  });
  const app = new Hono();
  app.route('/api', createTranslationsRouter(deps.translations));
  return app;
}

function translate(body: unknown) {
  return buildTestApp().request('/api/translations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/translations', () => {
  it('returns ranked senses for a word', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      senses: [
        {
          translation: 'ספר',
          part_of_speech: 'noun',
          example: { source: 'I read a book.', target: 'קראתי ספר.' },
        },
        { translation: 'להזמין', part_of_speech: 'verb' },
      ],
    });

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: 'book',
      direction: 'en_he',
      kind: 'word',
      senses: [
        {
          translation: 'ספר',
          part_of_speech: 'noun',
          example: { source: 'I read a book.', target: 'קראתי ספר.' },
        },
        { translation: 'להזמין', part_of_speech: 'verb' },
      ],
    });
  });

  it('detects Hebrew input without being told', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [{ translation: 'fork' }] });

    const res = await translate({ text: 'מזלג' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ direction: 'he_en' });
  });

  it('honours an explicit direction', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [{ translation: 'x' }] });

    const res = await translate({ text: 'book', direction: 'he_en' });

    expect(await res.json()).toMatchObject({ direction: 'he_en' });
  });

  it('reduces a sentence to one bare sense', async () => {
    await expectGeminiJson(ns, {
      kind: 'sentence',
      senses: [
        {
          translation: 'קראתי ספר.',
          part_of_speech: 'verb',
          example: { source: 'a', target: 'b' },
        },
      ],
    });

    const res = await translate({ text: 'I read a book' });

    expect(await res.json()).toMatchObject({
      kind: 'sentence',
      senses: [{ translation: 'קראתי ספר.' }],
    });
  });

  it('returns 200 with an empty sense list for gibberish', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [] });

    const res = await translate({ text: 'asdkjhasd' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ senses: [] });
  });

  it('sends the API key as a header', async () => {
    await expectGeminiJson(ns, { kind: 'word', senses: [] });

    await translate({ text: 'book' });

    // The unit test asserts this against a fake fetch; this asserts the real
    // client actually put it on the wire.
    await expect(verifyGeminiHeader(ns, 'x-goog-api-key', 'test-key')).resolves.toBe(true);
  });

  it('rejects empty, blank and over-long text with the contract error body', async () => {
    for (const text of ['', '   ', 'a'.repeat(101)]) {
      const res = await translate({ text });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
    }
  });

  it('rejects an unknown direction', async () => {
    const res = await translate({ text: 'book', direction: 'fr_he' });
    expect(res.status).toBe(400);
  });

  it('returns 502 when the provider fails', async () => {
    await expectGeminiStatus(ns, 500);

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'translation unavailable' });
  });

  it('returns 502 when the provider rate-limits', async () => {
    await expectGeminiStatus(ns, 429);
    expect((await translate({ text: 'book' })).status).toBe(502);
  });

  it('returns 502 when the model answers with unreadable output', async () => {
    await expectGeminiRawBody(
      ns,
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] } }],
      }),
    );

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'translation unavailable' });
  });

  it('returns 200 with no senses when the model is safety-blocked', async () => {
    await expectGeminiRawBody(ns, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ senses: [] });
  });

  it('gives up on a provider that exceeds the timeout budget', async () => {
    // The client's budget is 10s; 11s is past it. Jest's testTimeout is 30s.
    await expectGeminiDelayedJson(ns, { kind: 'word', senses: [], delayMs: 11_000 });

    const res = await translate({ text: 'book' });

    expect(res.status).toBe(502);
  }, 25_000);
});
