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
      json: async () => ({
        session_id: 's1',
        question: { id: 'q1' },
        position: { position: 1, total: 10 },
      }),
    }));
    const client = buildClient(mockFetch);

    const result = await client.createSession({ user_id: 'u1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u1' }),
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

  it('throws an ApiError carrying the response status when the request fails', async () => {
    const mockFetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const client = buildClient(mockFetch);

    await expect(client.createSession({ user_id: 'u1' })).rejects.toBeInstanceOf(ApiError);
    await expect(client.createSession({ user_id: 'u1' })).rejects.toMatchObject({ status: 404 });
  });

  it('login posts the username to /api/login', async () => {
    const user = {
      id: 'u1',
      username: 'dana',
      display_name: 'דנה',
      age: 34,
      native_language: 'he',
      target_language: 'en',
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
      target_language: 'en' as const,
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
        target_language: 'en',
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

      await expect(client.translate({ text: 'book' })).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.local/api/translations',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'book' }),
        }),
      );
    });

    // The flip control is the only thing that sends this: absent means "detect
    // from the script", so an always-present field would silently disable it.
    it('sends an explicit direction when one is given', async () => {
      const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
      const client = buildClient(mockFetch);

      await client.translate({ text: 'book', direction: 'he_en' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.local/api/translations',
        expect.objectContaining({ body: JSON.stringify({ text: 'book', direction: 'he_en' }) }),
      );
    });

    it('raises ApiError with the status, so the screen can tell 400 from 502', async () => {
      const mockFetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
      const client = buildClient(mockFetch);

      await expect(client.translate({ text: 'book' })).rejects.toMatchObject({ status: 502 });
    });
  });
});
