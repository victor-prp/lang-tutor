import { describe, expect, it } from '@jest/globals';
import { LlmTranslationSchema } from '@lang-tutor/core/api/schemas';

import { LlmUnavailable } from '../errors';
import { createGeminiClient, toGeminiSchema } from './gemini';

const request = { system: 'be helpful', user: 'book', schema: LlmTranslationSchema };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function geminiBody(text: string) {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] };
}

function clientWith(fetchImpl: typeof globalThis.fetch) {
  return createGeminiClient({
    fetch: fetchImpl,
    baseUrl: 'https://example.test',
    apiKey: 'secret',
    model: 'test-model',
    timeoutMs: 50,
  });
}

describe('toGeminiSchema', () => {
  it('strips the keys Gemini rejects and keeps the ones it needs', () => {
    const schema = toGeminiSchema(LlmTranslationSchema) as Record<string, unknown>;
    const entries = (schema.properties as Record<string, Record<string, unknown>>).entries;
    const entryItem = entries.items as Record<string, unknown>;
    const senses = (entryItem.properties as Record<string, Record<string, unknown>>).senses;
    const senseItem = senses.items as Record<string, unknown>;

    expect(schema).not.toHaveProperty('$schema');
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(entryItem).not.toHaveProperty('additionalProperties');
    expect(senseItem).not.toHaveProperty('additionalProperties');
    // Five, not six, and the ceiling is the provider's: array caps multiply
    // inside `responseSchema`, and six entries by five senses tipped Gemini past
    // "too many states for serving" the moment phase 13 added `correction` —
    // a 400 on every translation call. Measured against the live API.
    expect(entries.maxItems).toBe(5);
    expect(senses.maxItems).toBe(5);
    expect(entryItem.required).toEqual(['lemma', 'part_of_speech', 'senses']);
    expect(senseItem.required).toEqual(['translation', 'sense_code']);
    expect(schema.required).toEqual(['kind', 'entries']);
    // The closed set travels to Gemini inside responseSchema, which is what makes
    // an eleventh spelling of a word class inexpressible rather than merely
    // discouraged — part_of_speech is half of dict_lexemes' unique key.
    const entryPos = (entryItem.properties as Record<string, Record<string, unknown>>)
      .part_of_speech;
    expect(entryPos.enum).toEqual([
      'noun',
      'verb',
      'adjective',
      'adverb',
      'pronoun',
      'preposition',
      'conjunction',
      'determiner',
      'interjection',
      'numeral',
    ]);
  });

  it('leaves no $schema or additionalProperties at any depth', () => {
    const serialized = JSON.stringify(toGeminiSchema(LlmTranslationSchema));
    expect(serialized).not.toContain('$schema');
    expect(serialized).not.toContain('additionalProperties');
  });

  // The regression lock on this phase's `.optional()` decision. `.default([])`
  // was the obvious spelling: Zod 4 emits a `"default": []` key into the JSON
  // Schema, `strip` removes only $schema and additionalProperties, so the key
  // would travel to Gemini inside responseSchema — a keyword this repository has
  // never sent. A responseSchema Gemini refuses is a 400 on EVERY translation
  // call: a total outage of the endpoint, arrived at through a field designed
  // never to be able to fail an answer.
  //
  // A test rather than a comment because the next person reaching for
  // `.default()` will reach for it in packages/core, nowhere near this reasoning.
  it('emits no default keyword anywhere, at any depth', () => {
    expect(JSON.stringify(toGeminiSchema(LlmTranslationSchema))).not.toContain('"default"');
  });

  it('leaves correction out of the root required list', () => {
    const schema = toGeminiSchema(LlmTranslationSchema) as Record<string, unknown>;
    expect(schema.required).toEqual(['kind', 'entries']);
    expect(schema.properties).toHaveProperty('correction');
  });
});

describe('createGeminiClient', () => {
  it('posts to the generateContent path with the key in a header', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const client = clientWith(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return jsonResponse(geminiBody('{"kind":"word","senses":[]}'));
    });

    await client(request);

    expect(seenUrl).toBe('https://example.test/v1beta/models/test-model:generateContent');
    expect(seenInit?.method).toBe('POST');
    expect((seenInit?.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
    // Never a query parameter: that would put the secret in URLs and access logs.
    expect(seenUrl).not.toContain('key=');
  });

  it('sends the system instruction, the user text and structured-output config', async () => {
    let body: Record<string, unknown> = {};
    const client = clientWith(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(geminiBody('{"kind":"word","senses":[]}'));
    });

    await client(request);

    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be helpful' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'book' }] }]);
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.temperature).toBe(0);
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseSchema).toBeDefined();
    expect(JSON.stringify(config.responseSchema)).not.toContain('$schema');
  });

  it('returns the model text verbatim', async () => {
    const client = clientWith(async () => jsonResponse(geminiBody('{"kind":"word","senses":[]}')));
    await expect(client(request)).resolves.toBe('{"kind":"word","senses":[]}');
  });

  it('returns an empty string when the response was safety-blocked', async () => {
    const client = clientWith(async () =>
      jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    );
    // Empty string is the contract's "no content", which the service turns into
    // an empty sense list rather than an error.
    await expect(client(request)).resolves.toBe('');
  });

  it('returns an empty string when a candidate carries no text part', async () => {
    const client = clientWith(async () => jsonResponse({ candidates: [{ content: {} }] }));
    await expect(client(request)).resolves.toBe('');
  });

  it('maps a 500 to LlmUnavailable', async () => {
    const client = clientWith(async () => jsonResponse({ error: 'boom' }, 500));
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('maps a 429 to LlmUnavailable', async () => {
    const client = clientWith(async () => jsonResponse({ error: 'slow down' }, 429));
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('maps a network failure to LlmUnavailable', async () => {
    const client = clientWith(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('maps a body that is not JSON to LlmUnavailable', async () => {
    const client = clientWith(async () => new Response('<html>gateway</html>', { status: 200 }));
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('aborts once the budget is spent and maps that to LlmUnavailable', async () => {
    const client = clientWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(client(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('does not leak the key into the error message', async () => {
    const client = clientWith(async () => jsonResponse({ error: 'boom' }, 500));
    // Asserted against the message string rather than handed to `.toThrow` as an
    // asymmetric matcher: `toThrow` applies one of those to the thrown Error
    // *object*, and `expect.not.stringContaining` is vacuously true of any
    // non-string — so that form passes whatever the message says.
    await expect(client(request)).rejects.toMatchObject({
      message: expect.not.stringContaining('secret') as unknown as string,
    });
  });
});
