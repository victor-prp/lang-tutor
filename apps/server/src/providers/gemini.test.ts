import { describe, expect, it } from '@jest/globals';
import { LlmTranslationSchema } from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { LlmUnavailable } from '../errors';
import { createGeminiClient, createGeminiTranscriber, createGeminiVisionClient, toGeminiSchema } from './gemini';

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

describe('createGeminiTranscriber (phase 25)', () => {
  const schema = z.object({ heard: z.string() });

  it('sends the clip as inlineData, the instruction as the system part, and thinking off', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"heard":"gatto"}' }] } }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const transcribe = createGeminiTranscriber({ fetch, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 1_000 });

    expect(await transcribe({ system: 'transcribe the spoken audio', audio: 'QUJD', mimeType: 'audio/aac', schema })).toBe('{"heard":"gatto"}');
    expect(seen[0].url).toBe('http://g/v1beta/models/m:generateContent');
    expect((seen[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const body = JSON.parse(String(seen[0].init.body));
    expect(body.systemInstruction.parts[0].text).toBe('transcribe the spoken audio');
    expect(body.contents[0].parts).toEqual([{ inlineData: { mimeType: 'audio/aac', data: 'QUJD' } }]);
    expect(body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  });

  it('answers an empty candidate with the empty string', async () => {
    const fetch = (async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const transcribe = createGeminiTranscriber({ fetch, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 1_000 });
    expect(await transcribe({ system: 's', audio: 'QUJD', mimeType: 'audio/aac', schema })).toBe('');
  });

  it('turns a failure status and a timeout into LlmUnavailable', async () => {
    const failing = (async () => new Response('{}', { status: 400 })) as unknown as typeof globalThis.fetch;
    await expect(
      createGeminiTranscriber({ fetch: failing, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 1_000 })({
        system: 's',
        audio: 'QUJD',
        mimeType: 'audio/aac',
        schema,
      }),
    ).rejects.toBeInstanceOf(LlmUnavailable);
    const hanging = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof globalThis.fetch;
    await expect(
      createGeminiTranscriber({ fetch: hanging, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 10 })({
        system: 's',
        audio: 'QUJD',
        mimeType: 'audio/aac',
        schema,
      }),
    ).rejects.toThrow(/timed out after 10ms/);
  });
});

describe('createGeminiVisionClient', () => {
  const visionRequest = {
    system: 'read the word list in this photo',
    user: 'Language: Italian.',
    schema: LlmTranslationSchema,
    image: { data: 'QUJD', mimeType: 'image/jpeg' },
  };
  const visionWith = (fetchImpl: typeof globalThis.fetch) =>
    createGeminiVisionClient({ fetch: fetchImpl, baseUrl: 'https://example.test', apiKey: 'secret', model: 'test-model', timeoutMs: 50 });

  it('sends the image as inlineData before the text, with the system instruction and the schema', async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const vision = visionWith(async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)) };
      return jsonResponse(geminiBody('{"items":[]}'));
    });
    expect(await vision(visionRequest)).toBe('{"items":[]}');
    expect(sent?.url).toBe('https://example.test/v1beta/models/test-model:generateContent');
    expect(sent?.body.contents).toEqual([
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }, { text: 'Language: Italian.' }] },
    ]);
    expect(sent?.body.systemInstruction).toEqual({ parts: [{ text: 'read the word list in this photo' }] });
    expect((sent?.body.generationConfig as Record<string, unknown>).responseMimeType).toBe('application/json');
  });

  it('answers an empty string when no candidate came back', async () => {
    const vision = visionWith(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    expect(await vision(visionRequest)).toBe('');
  });

  it('maps a non-2xx and a timeout to LlmUnavailable', async () => {
    await expect(visionWith(async () => jsonResponse({}, 400))(visionRequest)).rejects.toBeInstanceOf(LlmUnavailable);
    const hanging = visionWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(hanging(visionRequest)).rejects.toThrow('timed out after 50ms');
  });
});

describe('createGeminiClient thinkingBudget (phase 27)', () => {
  const schema = z.object({ verdict: z.string() });
  const seenBody = async (thinkingBudget?: number) => {
    let body: { generationConfig: Record<string, unknown> } | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await createGeminiClient({ fetch, baseUrl: 'http://g', apiKey: 'k', model: 'm', timeoutMs: 1_000, thinkingBudget })({ system: 's', user: 'u', schema });
    return body!;
  };

  it('sends thinkingConfig when a budget is given', async () => {
    expect((await seenBody(0)).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('sends no thinkingConfig key without one', async () => {
    expect(Object.keys((await seenBody()).generationConfig)).not.toContain('thinkingConfig');
  });
});
