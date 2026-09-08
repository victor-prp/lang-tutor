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
    const senses = (schema.properties as Record<string, Record<string, unknown>>).senses;
    const item = senses.items as Record<string, unknown>;

    expect(schema).not.toHaveProperty('$schema');
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(item).not.toHaveProperty('additionalProperties');
    expect(senses.maxItems).toBe(5);
    expect(item.required).toEqual(['translation']);
    expect(schema.required).toEqual(['kind', 'senses']);
  });

  it('leaves no $schema or additionalProperties at any depth', () => {
    const serialized = JSON.stringify(toGeminiSchema(LlmTranslationSchema));
    expect(serialized).not.toContain('$schema');
    expect(serialized).not.toContain('additionalProperties');
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
