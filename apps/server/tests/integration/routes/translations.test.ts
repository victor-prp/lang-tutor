import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createTranslationsRouter } from '../../../src/routes/translations';
import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  countGeminiRequests,
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

// Every test here that expects a provider call uses a string the seed does not
// contain. As of phase 10 a seeded string answers from Postgres and never
// reaches MockServer — which is the whole point, and would otherwise turn the
// 502 and timeout tests into silent 200s.

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
      entries: [
        {
          lemma: 'ladder',
          senses: [
            {
              translation: 'סולם',
              part_of_speech: 'noun',
              example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
              sense_code: 'climbing_frame',
            },
            { translation: 'דירוג', part_of_speech: 'noun', sense_code: 'ranking' },
          ],
        },
      ],
    });

    const res = await translate({ text: 'ladder' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: 'ladder',
      direction: 'en_he',
      kind: 'word',
      senses: [
        {
          translation: 'סולם',
          part_of_speech: 'noun',
          example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
        },
        { translation: 'דירוג', part_of_speech: 'noun' },
      ],
    });
  });

  it('detects Hebrew input without being told', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [{ lemma: 'fork', senses: [{ translation: 'fork', sense_code: 'utensil' }] }],
    });

    const res = await translate({ text: 'מזלג' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ direction: 'he_en' });
  });

  it('honours an explicit direction', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [{ lemma: 'x', senses: [{ translation: 'x', sense_code: 'x' }] }],
    });

    const res = await translate({ text: 'ladder', direction: 'he_en' });

    expect(await res.json()).toMatchObject({ direction: 'he_en' });
  });

  it('reduces a sentence to one bare sense', async () => {
    await expectGeminiJson(ns, {
      kind: 'sentence',
      entries: [
        {
          lemma: 'I read a book',
          senses: [
            {
              translation: 'קראתי ספר.',
              part_of_speech: 'verb',
              example: { source: 'a', target: 'b' },
              sense_code: 'the_sentence',
            },
          ],
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
    await expectGeminiJson(ns, { kind: 'word', entries: [] });

    const res = await translate({ text: 'asdkjhasd' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ senses: [] });
  });

  it('sends the API key as a header', async () => {
    await expectGeminiJson(ns, { kind: 'word', entries: [] });

    await translate({ text: 'ladder' });

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
    const res = await translate({ text: 'ladder', direction: 'fr_he' });
    expect(res.status).toBe(400);
  });

  it('returns 502 when the provider fails', async () => {
    await expectGeminiStatus(ns, 500);

    const res = await translate({ text: 'ladder' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'translation unavailable' });
  });

  it('returns 502 when the provider rate-limits', async () => {
    await expectGeminiStatus(ns, 429);
    expect((await translate({ text: 'ladder' })).status).toBe(502);
  });

  it('returns 502 when the model answers with unreadable output', async () => {
    await expectGeminiRawBody(
      ns,
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] } }],
      }),
    );

    const res = await translate({ text: 'ladder' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'translation unavailable' });
  });

  it('returns 200 with no senses when the model is safety-blocked', async () => {
    await expectGeminiRawBody(ns, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));

    const res = await translate({ text: 'ladder' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ senses: [] });
  });

  it('gives up on a provider that exceeds the timeout budget', async () => {
    // The client's budget is 10s; 11s is past it. Jest's testTimeout is 30s.
    await expectGeminiDelayedJson(ns, { kind: 'word', entries: [], delayMs: 11_000 });

    const res = await translate({ text: 'ladder' });

    expect(res.status).toBe(502);
  }, 25_000);

  it('answers the same string twice over HTTP with one provider request', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'ladder',
          senses: [
            {
              translation: 'סולם',
              part_of_speech: 'noun',
              example: { source: 'She climbed the ladder.', target: 'היא טיפסה על הסולם.' },
              sense_code: 'climbing_frame',
            },
          ],
        },
      ],
    });

    const first = await translate({ text: 'ladder' });
    const second = await translate({ text: 'ladder' });

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(await countGeminiRequests(ns, 'ladder')).toBe(1);
  });

  it('flattens a two-entry answer into one ranked list on the wire', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'see',
          senses: [
            { translation: 'לראות', part_of_speech: 'verb', sense_code: 'perceive' },
            { translation: 'להבין', part_of_speech: 'verb', sense_code: 'understand' },
          ],
        },
        {
          lemma: 'saw',
          senses: [{ translation: 'מסור', part_of_speech: 'noun', sense_code: 'tool' }],
        },
      ],
    });

    const res = await translate({ text: 'saw' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { senses: { translation: string }[] };
    // One flat list, with no sign that two headwords are in it — the per-sense
    // part_of_speech is the only hint. Grouping is out of scope for this phase.
    expect(body.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור', 'להבין']);
    expect(body.senses[0]).not.toHaveProperty('sense_code');
  });

  it('answers a recorded string from the seed, with no provider request at all', async () => {
    // No expectation is registered: this namespace has nothing to answer with,
    // so a 200 here can only have come from Postgres.
    //
    // Containment, not an exact list: how many senses `book` has, and whether
    // any carry an example, is a property of whatever `content:generate`
    // recorded — richer today or later — not a property of this phase.
    // "Exactly as recorded" for all sixteen seeded queries, including `book`,
    // is already proven in tests/integration/db/seed.test.ts ("leaves every
    // recorded string servable, as exactly the merge persistEntries
    // produces"), which may import `recorded` because it sits in the `db/`
    // bucket. This test only proves the one thing that check cannot: that the
    // HTTP boundary serves it too, without reaching the provider.
    const res = await translate({ text: 'book' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { senses: { translation: string }[] };
    expect(body.senses.map((sense) => sense.translation)).toContain('ספר');
    expect(await countGeminiRequests(ns)).toBe(0);
  });
});
