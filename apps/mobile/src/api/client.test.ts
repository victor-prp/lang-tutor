import { describe, expect, it, jest } from '@jest/globals';

import { ApiError, createApiClient } from './client';

function buildClient(mockFetch: jest.Mock) {
  return createApiClient({
    baseUrl: 'http://test.local',
    fetch: mockFetch as unknown as typeof globalThis.fetch,
  });
}

describe('api/client', () => {
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
        headers: { 'Content-Type': 'application/json' },
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

    const result = await client.nextStep('s1', { user_id: 'u1', question_id: 'q1', option_index: 0 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/sessions/s1/next-step',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u1', question_id: 'q1', option_index: 0 }),
      }),
    );
    expect(result).toEqual(responseBody);
  });

  // Phase 23. A typed card is answered with its text.
  it('nextStep sends a typed answer as text', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await client.nextStep('s1', { user_id: 'u1', question_id: 't1', text: 'finestra' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/sessions/s1/next-step',
      expect.objectContaining({ body: JSON.stringify({ user_id: 'u1', question_id: 't1', text: 'finestra' }) }),
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

  it('login posts the username to /api/login', async () => {
    const user = {
      id: 'u1',
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he',
    };
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => user }));
    const client = buildClient(mockFetch);

    const result = await client.login({ username: 'dana' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/login',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'dana' }),
      }),
    );
    expect(result).toEqual(user);
  });

  it('login throws ApiError with the status when the username is unknown', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await expect(client.login({ username: 'nobody' })).rejects.toMatchObject({ status: 404 });
    await expect(client.login({ username: 'nobody' })).rejects.toBeInstanceOf(ApiError);
  });

  it('createUser posts the profile to /api/users', async () => {
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

    const result = await client.createUser(request);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/users',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
    expect(result.id).toBe('u1');
  });

  it('createUser throws ApiError with 409 when the username is taken', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await expect(
      client.createUser({
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
          headers: { 'Content-Type': 'application/json' },
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

  it("listEnrollments GETs the user's enrollments", async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    const client = buildClient(mockFetch);
    expect(await client.listEnrollments('u1')).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/users/u1/enrollments',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('createEnrollment POSTs the request body', async () => {
    const created = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'ru', created_at: 'x' };
    const mockFetch = jest.fn(async () => ({ ok: true, status: 201, json: async () => created }));
    const client = buildClient(mockFetch);
    expect(await client.createEnrollment('u1', { source_language: 'he', target_language: 'ru' })).toEqual(created);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/users/u1/enrollments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source_language: 'he', target_language: 'ru' }),
      }),
    );
  });

  it('throws ApiError(409) when already enrolled', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }));
    await expect(
      buildClient(mockFetch).createEnrollment('u1', { source_language: 'he', target_language: 'ru' }),
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
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments/e1/vocabulary/senses/s1', {
      method: 'DELETE',
    });
  });

  it('listVocabulary passes cursor and limit as a query string, and nothing when absent', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }));
    const client = buildClient(mockFetch);
    await client.listVocabulary('e1', { cursor: 'a+b', limit: 50 });
    await client.listVocabulary('e1', {});
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://test.local/api/enrollments/e1/vocabulary?cursor=a%2Bb&limit=50', { method: 'GET' });
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://test.local/api/enrollments/e1/vocabulary', { method: 'GET' });
  });

  it('listVocabulary passes a level when given, and never a sort', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }));
    const client = buildClient(mockFetch);
    await client.listVocabulary('e1', { level: 2 });
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments/e1/vocabulary?level=2', { method: 'GET' });
  });

  // Review Focus 1: a lemma travels as an encoded query parameter.
  it.each(['ice cream', 'знать', 'и/или'])('vocabularyWord gets one word by its lemma: %s', async (lemma) => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = buildClient(mockFetch);
    await client.vocabularyWord('e1', lemma);
    expect(mockFetch).toHaveBeenCalledWith(
      `http://test.local/api/enrollments/e1/vocabulary/word?lemma=${encodeURIComponent(lemma)}`,
      { method: 'GET' },
    );
  });

  it('unsaveVocabulary throws ApiError on failure', async () => {
    const client = buildClient(jest.fn(async () => ({ ok: false, status: 404 })));
    await expect(client.unsaveVocabulary('e1', 's1')).rejects.toBeInstanceOf(ApiError);
  });
});
