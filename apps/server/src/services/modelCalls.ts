import type { Logger } from '../logger';
import type { ModelCall } from './llm';
import type { Transaction } from './transaction';

/** Phase 47 (ruling R7). How long a model call is kept: Victor's 7 days. */
export const MODEL_CALL_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Phase 47 (spec D5). The recorder every model client reports to
 * (composition.ts hands `record` to each as its `onCall`).
 *
 * Its own transaction, apart from the caller's (ADR 0001 R8's amendment): no
 * transaction is open across a model call, and the row is an independent write,
 * correct whether or not the caller's writes land. It must outlive the caller's
 * failure, since a failed attempt is the call most worth reading.
 */
export function createModelCallService({
  transaction,
  logger,
  now,
}: {
  transaction: Transaction;
  logger: Logger;
  now: () => number;
}) {
  return {
    /**
     * Stores the call and deletes every call older than the retention, in one
     * transaction (ruling R3: no scheduler runs in any process, and the delete
     * is a short range scan on `started_at`). Never throws: a lost record is a
     * gap in the analysis, a thrown one would be a failed lookup or session
     * (ruling R4).
     */
    record: async (call: ModelCall): Promise<void> => {
      try {
        await transaction(async ({ modelCall }) => {
          await modelCall.insert({
            startedAt: call.startedAt,
            kind: call.record.kind,
            model: call.model,
            sessionId: call.record.sessionId ?? null,
            attempt: call.record.attempt ?? null,
            enrollmentId: call.record.enrollmentId ?? null,
            userId: call.record.userId ?? null,
            request: call.request,
            response: call.response,
            httpStatus: call.httpStatus,
            error: call.error,
            durationMs: call.durationMs,
            promptTokens: call.promptTokens,
            outputTokens: call.outputTokens,
            thinkingTokens: call.thinkingTokens,
            finishReason: call.finishReason,
          });
          await modelCall.deleteBefore(new Date(now() - MODEL_CALL_RETENTION_DAYS * DAY_MS));
        });
      } catch (error) {
        // The kind and the database's own reason, never the error itself: a
        // failed query's message lists every parameter, the prompt and the
        // answer among them, and a log line would keep them past the 7 days.
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const reason = cause instanceof Error ? cause.message : String(cause);
        logger.error('model_call_not_recorded', `${call.record.kind}: ${reason.slice(0, 200)}`);
      }
    },
  };
}

export type ModelCallService = ReturnType<typeof createModelCallService>;
