import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createModelCallRepo, type ModelCallRow } from '../../../src/repo/modelCalls';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createModelCallRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createModelCallRepo(tx)));

const DAY = 86_400_000;
const NOW = new Date('2026-10-13T12:00:00Z');

const row = (overrides: Partial<ModelCallRow> = {}): ModelCallRow => ({
  startedAt: NOW,
  kind: 'session_generation',
  model: 'gemini-2.5-flash',
  sessionId: '0b5e7c1e-6a4f-4f4b-9a39-2f8e7f2b1c11',
  attempt: 2,
  enrollmentId: 'e_1',
  userId: 'u_1',
  request: { systemInstruction: { parts: [{ text: 'You write the answers' }] } },
  response: { candidates: [{ finishReason: 'STOP' }] },
  httpStatus: 200,
  error: null,
  durationMs: 6_700,
  promptTokens: 1_161,
  outputTokens: 419,
  thinkingTokens: 802,
  finishReason: 'STOP',
  ...overrides,
});

describe('model calls repository (phase 47)', () => {
  it('stores a call as given, its request and response as JSON', async () => {
    await repo((r) => r.insert(row()));
    // A raw select reads timestamptz as text, so the instant is compared in SQL.
    const result = await t.db.execute<Record<string, unknown>>(
      sql`select *, started_at = ${NOW.toISOString()}::timestamptz as started_as_given from model_calls`,
    );
    expect(result.rows).toEqual([
      {
        id: expect.any(String),
        started_at: expect.anything(),
        started_as_given: true,
        kind: 'session_generation',
        model: 'gemini-2.5-flash',
        session_id: '0b5e7c1e-6a4f-4f4b-9a39-2f8e7f2b1c11',
        attempt: 2,
        enrollment_id: 'e_1',
        user_id: 'u_1',
        request: { systemInstruction: { parts: [{ text: 'You write the answers' }] } },
        response: { candidates: [{ finishReason: 'STOP' }] },
        http_status: 200,
        error: null,
        duration_ms: 6_700,
        prompt_tokens: 1_161,
        output_tokens: 419,
        thinking_tokens: 802,
        finish_reason: 'STOP',
      },
    ]);
  });

  it('stores a call that never got an answer, with no handles', async () => {
    await repo((r) =>
      r.insert(
        row({
          sessionId: null,
          attempt: null,
          enrollmentId: null,
          userId: null,
          response: null,
          httpStatus: null,
          error: 'timed out after 120000ms',
          promptTokens: null,
          outputTokens: null,
          thinkingTokens: null,
          finishReason: null,
        }),
      ),
    );
    const result = await t.db.execute<{ error: string; response: unknown }>(sql`select error, response from model_calls`);
    expect(result.rows).toEqual([{ error: 'timed out after 120000ms', response: null }]);
  });

  it('deletes the calls started before the cutoff and keeps the rest', async () => {
    await repo((r) => r.insert(row({ startedAt: new Date(NOW.getTime() - 8 * DAY), kind: 'checker' })));
    await repo((r) => r.insert(row({ startedAt: new Date(NOW.getTime() - 6 * DAY), kind: 'context' })));
    const deleted = await repo((r) => r.deleteBefore(new Date(NOW.getTime() - 7 * DAY)));
    expect(deleted).toBe(1);
    const result = await t.db.execute<{ kind: string }>(sql`select kind from model_calls`);
    expect(result.rows).toEqual([{ kind: 'context' }]);
  });
});
