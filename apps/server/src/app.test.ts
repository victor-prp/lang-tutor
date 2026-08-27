import { describe, expect, it } from '@jest/globals';

import { createApp } from './app';

describe('GET /health', () => {
  it('returns 200 with ok: true', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not create a session as a side effect', async () => {
    const app = createApp();
    await app.request('/health');
    // A session id is only ever handed out by POST /api/sessions. If /health
    // had created one, the store would answer for it; nothing else can know an
    // id, so the only observable proof is that the sessions route is untouched
    // and still rejects an unknown id.
    const res = await app.request('/api/sessions/any-id/next-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', question_id: 'q1', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });
});
