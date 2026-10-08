import { describe, expect, it, jest } from '@jest/globals';

import {
  ApiError,
  JUDGE_REQUEST_TIMEOUT_MS,
  PHOTO_UPLOAD_TIMEOUT_MS,
  SPEECH_UPLOAD_TIMEOUT_MS,
  createApiClient,
  type ApiClientDeps,
} from './client';

function buildClient(mockFetch: jest.Mock, extra: Partial<ApiClientDeps> = {}) {
  return createApiClient({
    baseUrl: 'http://test.local',
    fetch: mockFetch as unknown as typeof globalThis.fetch,
    sessionHeaders: async () => ({ cookie: 'better-auth.session_token=abc' }),
    credentials: 'omit',
    onUnauthorized: () => {},
    ...extra,
  });
}

describe('api/client', () => {
  it('sends the session on every call, with the configured credentials', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    await buildClient(mockFetch, { credentials: 'include' }).listEnrollments();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        headers: expect.objectContaining({ cookie: 'better-auth.session_token=abc' }),
      }),
    );
  });

  it('reports a 401 and still throws it', async () => {
    const onUnauthorized = jest.fn();
    const mockFetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'not signed in' }) }));
    await expect(buildClient(mockFetch, { onUnauthorized }).me()).rejects.toEqual(new ApiError(401, 'not signed in'));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not report other failures as signed out', async () => {
    const onUnauthorized = jest.fn();
    const mockFetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }));
    await expect(buildClient(mockFetch, { onUnauthorized }).me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('createSession posts to /api/sessions with the request body', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ session_id: 's1', status: 'ready', source: 'seed' }),
    }));
    const client = buildClient(mockFetch);

    const result = await client.createSession({ enrollment_id: 'e1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ enrollment_id: 'e1' }),
      }),
    );
    expect(result.session_id).toBe('s1');
  });

  it('nextStep posts to /api/sessions/:id/next-step with the request body', async () => {
    const responseBody = {
      session_id: 's1',
      question: null,
      position: { position: 10, total: 10 },
      complete: true,
      score: { correct: 10, total: 10 },
      missed_questions: [],
      progress: [],
    };
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => responseBody }));
    const client = buildClient(mockFetch);

    const result = await client.nextStep('s1', { question_id: 'q1', option_index: 0 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/sessions/s1/next-step',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ question_id: 'q1', option_index: 0 }),
      }),
    );
    expect(result).toEqual(responseBody);
  });

  // Phase 23. A typed card is answered with its text.
  it('nextStep sends a typed answer as text', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await client.nextStep('s1', { question_id: 't1', text: 'finestra' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/sessions/s1/next-step',
      expect.objectContaining({ body: JSON.stringify({ question_id: 't1', text: 'finestra' }) }),
    );
  });

  it('throws an ApiError carrying the response status when the request fails', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await expect(client.createSession({ enrollment_id: 'e1' })).rejects.toBeInstanceOf(ApiError);
    await expect(client.createSession({ enrollment_id: 'e1' })).rejects.toMatchObject({ status: 404 });
  });

  it('getSession, skipSession and currentSession reach their paths', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await client.getSession('s 1');
    await client.skipSession('s1');
    await client.currentSession('e1');

    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://test.local/api/sessions/s%201', expect.objectContaining({ method: 'GET' }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://test.local/api/sessions/s1/skip', expect.objectContaining({ method: 'POST' }));
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://test.local/api/enrollments/e1/sessions/current', expect.objectContaining({ method: 'GET' }));
  });

  it("carries a failure's error code, so the app can tell two 409s apart", async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'no_saved_words' }) }));
    await expect(buildClient(mockFetch).createSession({ enrollment_id: 'e1' })).rejects.toMatchObject({
      status: 409,
      code: 'no_saved_words',
    });
  });

  it('leaves the code undefined when the failure body is not JSON', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('html'); } }));
    const failure = await buildClient(mockFetch).currentSession('e1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBeUndefined();
  });

  it('createProfile posts the profile to /api/users', async () => {
    const request = {
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he' as const,
    };
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'u1', ...request }),
    }));
    const client = buildClient(mockFetch);

    const result = await client.createProfile(request);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/users',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
    expect(result.id).toBe('u1');
  });

  it('createProfile throws ApiError with 409 when the username is taken', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await expect(
      client.createProfile({
        username: 'dana',
        display_name: 'דנה',
        age: 34,
        native_language: 'he',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  describe('translate', () => {
    it('posts the text to /api/translations and returns the parsed body', async () => {
      const response = {
        text: 'book',
        direction: 'en_he',
        kind: 'word',
        senses: [{ translation: 'ספר', part_of_speech: 'noun' }],
      };
      const mockFetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => response,
      }));
      const client = buildClient(mockFetch);

      await expect(client.translate({ text: 'book', from: 'en', to: 'he' })).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.local/api/translations',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ text: 'book', from: 'en', to: 'he' }),
        }),
      );
    });

    it('sends the explicit direction it is given', async () => {
      const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
      const client = buildClient(mockFetch);

      await client.translate({ text: 'книга', from: 'ru', to: 'he' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.local/api/translations',
        expect.objectContaining({ body: JSON.stringify({ text: 'книга', from: 'ru', to: 'he' }) }),
      );
    });

    it('raises ApiError with the status, so the screen can tell 400 from 502', async () => {
      const mockFetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
      const client = buildClient(mockFetch);

      await expect(client.translate({ text: 'book', from: 'en', to: 'he' })).rejects.toMatchObject({ status: 502 });
    });
  });

  // Phase 29 (spec D12): the signed-in learner's own; no user id in the path.
  it("listEnrollments GETs the signed-in learner's enrollments", async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    const client = buildClient(mockFetch);
    expect(await client.listEnrollments()).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments', expect.objectContaining({ method: 'GET' }));
  });

  it('createEnrollment POSTs the request body', async () => {
    const created = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'ru', created_at: 'x' };
    const mockFetch = jest.fn(async () => ({ ok: true, status: 201, json: async () => created }));
    const client = buildClient(mockFetch);
    expect(await client.createEnrollment({ source_language: 'he', target_language: 'ru' })).toEqual(created);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source_language: 'he', target_language: 'ru' }),
      }),
    );
  });

  it('throws ApiError(409) when already enrolled', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }));
    await expect(
      buildClient(mockFetch).createEnrollment({ source_language: 'he', target_language: 'ru' }),
    ).rejects.toEqual(new ApiError(409));
  });

  it('saveVocabulary posts the entries to the enrollment', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ saved_sense_ids: ['s1'] }) }));
    const client = buildClient(mockFetch);
    await client.saveVocabulary('e 1', { entries: [{ sense_id: 's1', variant_id: 'v1' }] });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments/e%201/vocabulary',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ entries: [{ sense_id: 's1', variant_id: 'v1' }] }) }),
    );
  });

  it('unsaveVocabulary sends DELETE and reads no body', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 204 }));
    const client = buildClient(mockFetch);
    await client.unsaveVocabulary('e1', 's1');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments/e1/vocabulary/senses/s1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  // Phase 29 (spec D12): the session says who is acting; no header can.
  it('names no acting user on a save', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ saved_sense_ids: ['s1'] }) }));
    const client = buildClient(mockFetch);
    await client.saveVocabulary('e1', { entries: [{ sense_id: 's1', variant_id: 'v1' }] });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments/e1/vocabulary',
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }),
    );
  });

  it('listVocabulary passes cursor and limit as a query string, and nothing when absent', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }));
    const client = buildClient(mockFetch);
    await client.listVocabulary('e1', { cursor: 'a+b', limit: 50 });
    await client.listVocabulary('e1', {});
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://test.local/api/enrollments/e1/vocabulary?cursor=a%2Bb&limit=50', expect.objectContaining({ method: 'GET' }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://test.local/api/enrollments/e1/vocabulary', expect.objectContaining({ method: 'GET' }));
  });

  it('listVocabulary passes a level when given, and never a sort', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }));
    const client = buildClient(mockFetch);
    await client.listVocabulary('e1', { level: 2 });
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments/e1/vocabulary?level=2', expect.objectContaining({ method: 'GET' }));
  });

  // Review Focus 1: a lemma travels as an encoded query parameter.
  it.each(['ice cream', 'знать', 'и/или'])('vocabularyWord gets one word by its lemma: %s', async (lemma) => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = buildClient(mockFetch);
    await client.vocabularyWord('e1', lemma);
    expect(mockFetch).toHaveBeenCalledWith(
      `http://test.local/api/enrollments/e1/vocabulary/word?lemma=${encodeURIComponent(lemma)}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('unsaveVocabulary throws ApiError on failure', async () => {
    const client = buildClient(jest.fn(async () => ({ ok: false, status: 404 })));
    await expect(client.unsaveVocabulary('e1', 's1')).rejects.toBeInstanceOf(ApiError);
  });

  it('posts a spoken attempt to the speech endpoint (phase 25)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ heard: 'gatto', verdict: 'unheard' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = createApiClient({
          baseUrl: 'http://api',
          fetch,
          sessionHeaders: async () => ({}),
          credentials: 'omit',
          onUnauthorized: () => {},
        });
    const request = { question_id: 'q', mime_type: 'audio/aac' as const, audio: 'QUJD' };
    expect(await api.answerBySpeech('s 1', request)).toEqual({ heard: 'gatto', verdict: 'unheard' });
    expect(calls[0].url).toBe('http://api/api/sessions/s%201/speech');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(request);
  });

  it('abandons a speech upload that stalls, so the card is not stuck checking (phase 25)', async () => {
    jest.useFakeTimers();
    try {
      const fetch = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch;
      const api = createApiClient({
          baseUrl: 'http://api',
          fetch,
          sessionHeaders: async () => ({}),
          credentials: 'omit',
          onUnauthorized: () => {},
        });
      const pending = api.answerBySpeech('s1', { question_id: 'q', mime_type: 'audio/aac', audio: 'QUJD' });
      const outcome = expect(pending).rejects.toThrow('aborted');
      await jest.advanceTimersByTimeAsync(SPEECH_UPLOAD_TIMEOUT_MS);
      await outcome;
    } finally {
      jest.useRealTimers();
    }
  });

  describe('grants (phase 28)', () => {
    const recorder = (status: number, body: string | null) => {
      const calls: { url: string; init: RequestInit }[] = [];
      const fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(body, { status });
      }) as unknown as typeof globalThis.fetch;
      return { calls, api: createApiClient({
          baseUrl: 'http://api',
          fetch,
          sessionHeaders: async () => ({}),
          credentials: 'omit',
          onUnauthorized: () => {},
        }) };
    };
    const emptyList = JSON.stringify({ tutors: [], students: [] });

    // Phase 29: no call names its actor; the session does (spec D12).
    it('listGrants GETs /api/grants', async () => {
      const { calls, api } = recorder(200, emptyList);
      await api.listGrants();
      expect(calls[0].url).toBe('http://api/api/grants');
      expect(calls[0].init.method).toBe('GET');
      expect(calls[0].init.headers).toEqual({});
    });

    it('createGrant POSTs the request', async () => {
      const { calls, api } = recorder(201, '{}');
      await api.createGrant({ username: 'victor', target_language: 'it' });
      expect(calls[0].url).toBe('http://api/api/grants');
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ username: 'victor', target_language: 'it' });
    });

    it('acceptGrant POSTs to the accept path', async () => {
      const { calls, api } = recorder(200, '{}');
      await api.acceptGrant('g 1');
      expect(calls[0].url).toBe('http://api/api/grants/g%201/accept');
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('endGrant DELETEs the grant', async () => {
      const { calls, api } = recorder(204, null);
      await api.endGrant('g1');
      expect(calls[0].url).toBe('http://api/api/grants/g1');
      expect(calls[0].init.method).toBe('DELETE');
      expect(calls[0].init.headers).toEqual({});
    });
  });

  it('posts a judged answer and returns the verdict with the next step (phase 27)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const body = { verdict: 'exact', next: { complete: true } };
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = createApiClient({
          baseUrl: 'http://api',
          fetch,
          sessionHeaders: async () => ({}),
          credentials: 'omit',
          onUnauthorized: () => {},
        });
    const request = { question_id: 'q', text: 'להזמין' };
    expect(await api.judgeAnswer('s 1', request)).toEqual(body);
    expect(calls[0].url).toBe('http://api/api/sessions/s%201/judged-answer');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(request);
  });

  it('abandons a judged answer that stalls, so the card can offer a retry (phase 27)', async () => {
    jest.useFakeTimers();
    try {
      const fetch = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch;
      const api = createApiClient({
          baseUrl: 'http://api',
          fetch,
          sessionHeaders: async () => ({}),
          credentials: 'omit',
          onUnauthorized: () => {},
        });
      const pending = api.judgeAnswer('s1', { question_id: 'q', text: 'x' });
      const outcome = expect(pending).rejects.toThrow('aborted');
      await jest.advanceTimersByTimeAsync(JUDGE_REQUEST_TIMEOUT_MS);
      await outcome;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('photo imports', () => {
  it('uploads to the enrollment, patches a row, saves and discards', async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const mockFetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const status = url.endsWith('/discard') ? 204 : 200;
      return { ok: true, status, json: async () => ({}) };
    });
    const client = buildClient(mockFetch as unknown as jest.Mock);
    await client.createPhotoImport('e 1', { mime_type: 'image/jpeg', image: 'QUJD' });
    await client.listPhotoImports('e 1');
    await client.getPhotoImport('i1');
    await client.updatePhotoImportItem('i1', 3, { ticked: false });
    await client.savePhotoImport('i1');
    await client.discardPhotoImport('i1');
    expect(calls.map(({ url, method }) => [method ?? 'GET', url.replace('http://test.local', '')])).toEqual([
      ['POST', '/api/enrollments/e%201/photo-imports'],
      ['GET', '/api/enrollments/e%201/photo-imports'],
      ['GET', '/api/photo-imports/i1'],
      ['PATCH', '/api/photo-imports/i1/items/3'],
      ['POST', '/api/photo-imports/i1/save'],
      ['POST', '/api/photo-imports/i1/discard'],
    ]);
    expect(calls[3].body).toEqual({ ticked: false });
  });

  it('abandons a photo upload that stalls, so the screen is not stuck uploading', async () => {
    jest.useFakeTimers();
    try {
      const fetch = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch;
      const api = createApiClient({
          baseUrl: 'http://api',
          fetch,
          sessionHeaders: async () => ({}),
          credentials: 'omit',
          onUnauthorized: () => {},
        });
      const pending = api.createPhotoImport('e1', { mime_type: 'image/jpeg', image: 'QUJD' });
      const outcome = expect(pending).rejects.toThrow('aborted');
      await jest.advanceTimersByTimeAsync(PHOTO_UPLOAD_TIMEOUT_MS);
      await outcome;
    } finally {
      jest.useRealTimers();
    }
  });
});
