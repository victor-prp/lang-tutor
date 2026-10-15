import { lt } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { modelCalls } from '../db/schema';

/** Phase 47 (spec D2). One request to a model, as the recorder stores it. */
export type ModelCallRow = {
  startedAt: Date;
  kind: string;
  model: string;
  sessionId: string | null;
  attempt: number | null;
  enrollmentId: string | null;
  userId: string | null;
  request: unknown;
  response: unknown;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  finishReason: string | null;
};

export function createModelCallRepo(tx: Tx) {
  return {
    insert: async (row: ModelCallRow): Promise<void> => {
      await tx.insert(modelCalls).values(row);
    },
    /** Deletes every call started before `cutoff`; answers how many. */
    deleteBefore: async (cutoff: Date): Promise<number> => {
      const deleted = await tx.delete(modelCalls).where(lt(modelCalls.startedAt, cutoff)).returning({ id: modelCalls.id });
      return deleted.length;
    },
  };
}

export type ModelCallRepo = ReturnType<typeof createModelCallRepo>;
