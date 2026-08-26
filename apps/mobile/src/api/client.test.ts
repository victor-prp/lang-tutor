import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApiError, createSession, nextStep } from './client';

describe('api/client', () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.EXPO_PUBLIC_API_URL;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = 'http://example.test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.EXPO_PUBLIC_API_URL = originalBaseUrl;
  });

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
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await createSession({ user_id: 'u1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.test/api/sessions',
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
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await nextStep('s1', { user_id: 'u1', question_id: 'q1', option_index: 0 });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.test/api/sessions/s1/next-step',
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
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(createSession({ user_id: 'u1' })).rejects.toBeInstanceOf(ApiError);
    await expect(createSession({ user_id: 'u1' })).rejects.toMatchObject({ status: 404 });
  });

  it('throws when EXPO_PUBLIC_API_URL is not set', async () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    await expect(createSession({ user_id: 'u1' })).rejects.toThrow('EXPO_PUBLIC_API_URL');
  });
});
