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
});
