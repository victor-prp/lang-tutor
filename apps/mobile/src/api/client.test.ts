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

    await expect(client.createSession({ enrollment_id: 'e1' })).rejects.toBeInstanceOf(ApiError);
    await expect(client.createSession({ enrollment_id: 'e1' })).rejects.toMatchObject({ status: 404 });
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
});
