import { describe, expect, it } from '@jest/globals';

import { createFakeLogger, createFakeTransaction, stub } from '../../tests/support/fakes';
import type { ModelCallRepo, ModelCallRow } from '../repo/modelCalls';
import type { ModelCall } from './llm';
import { createModelCallService } from './modelCalls';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86_400_000;

const CALL: ModelCall = {
  record: { kind: 'session_generation', sessionId: 's1', attempt: 2, enrollmentId: 'e1', userId: 'u1' },
  model: 'gemini-2.5-flash',
  startedAt: new Date(NOW - 6_700),
  request: { contents: [] },
  response: { candidates: [] },
  httpStatus: 200,
  error: null,
  durationMs: 6_700,
  promptTokens: 1161,
  outputTokens: 419,
  thinkingTokens: 802,
  finishReason: 'STOP',
};

function build(repo: Partial<ModelCallRepo>) {
  const logger = createFakeLogger();
  const service = createModelCallService({
    transaction: createFakeTransaction({ modelCall: stub<ModelCallRepo>(repo) }),
    logger,
    now: () => NOW,
  });
  return { logger, service };
}

describe('the model-call recorder (phase 47, spec D5)', () => {
  it('stores the call with its handles, and deletes what is older than 7 days', async () => {
    const inserted: ModelCallRow[] = [];
    const cutoffs: Date[] = [];
    const { service } = build({
      insert: async (row) => {
        inserted.push(row);
      },
      deleteBefore: async (cutoff) => {
        cutoffs.push(cutoff);
        return 0;
      },
    });
    await service.record(CALL);
    expect(inserted).toEqual([
      {
        startedAt: CALL.startedAt,
        kind: 'session_generation',
        model: 'gemini-2.5-flash',
        sessionId: 's1',
        attempt: 2,
        enrollmentId: 'e1',
        userId: 'u1',
        request: { contents: [] },
        response: { candidates: [] },
        httpStatus: 200,
        error: null,
        durationMs: 6_700,
        promptTokens: 1161,
        outputTokens: 419,
        thinkingTokens: 802,
        finishReason: 'STOP',
      },
    ]);
    expect(cutoffs).toEqual([new Date(NOW - 7 * DAY)]);
  });

  it('stores a call with no handles as nulls', async () => {
    const inserted: ModelCallRow[] = [];
    const { service } = build({
      insert: async (row) => {
        inserted.push(row);
      },
      deleteBefore: async () => 0,
    });
    await service.record({ ...CALL, record: { kind: 'accept' } });
    expect(inserted[0]).toMatchObject({ kind: 'accept', sessionId: null, attempt: null, enrollmentId: null, userId: null });
  });

  // Review: drizzle's error message lists every parameter, the prompt and the
  // answer among them; a log line must not carry them past the 7 days.
  it("logs a failed write by its kind and the database's reason, never the prompt", async () => {
    const { service, logger } = build({
      insert: async () => {
        throw new Error('Failed query: insert into "model_calls" params: LEARNER-TYPED-TEXT', {
          cause: new Error('unsupported Unicode escape sequence'),
        });
      },
    });
    await service.record(CALL);
    expect(logger.errors).toEqual([{ message: 'model_call_not_recorded', cause: 'session_generation: unsupported Unicode escape sequence' }]);
    expect(JSON.stringify(logger.errors)).not.toContain('LEARNER-TYPED-TEXT');
  });

  it('never fails the call it records: a failed write is logged and swallowed', async () => {
    const { service, logger } = build({
      insert: async () => {
        throw new Error('connection terminated');
      },
    });
    await expect(service.record(CALL)).resolves.toBeUndefined();
    expect(logger.errors).toEqual([{ message: 'model_call_not_recorded', cause: 'session_generation: connection terminated' }]);
  });
});
