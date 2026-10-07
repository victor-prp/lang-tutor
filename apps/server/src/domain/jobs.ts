import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { z } from 'zod';

/**
 * Phase 19. The background jobs this server runs: each queue's name and the
 * payload it carries. Here rather than in services/ because repo/jobs.ts and
 * db/jobs.ts need the names too, and ADR 0001 R4 forbids persistence from
 * reaching up into services. Names and a schema are pure data, which is all
 * R3 allows here.
 */
export const PREPARE_SESSION = 'prepare-session';

/** Where pg-boss moves a prepare-session job once its retries are spent or it
 *  expired. pg-boss copies the job's `data` across unchanged. */
export const PREPARE_SESSION_FAILED = 'prepare-session-failed';

/** Phase 24 (spec D16). The most one generation call may take: five minutes,
 *  Victor's cap. The environment may lower it (config.ts); tests do. */
export const SESSION_GENERATION_BUDGET_MS = 300_000;

/** Twice the budget, phase 19's rule: a worker that crashed mid-call expires
 *  and is retried, and a healthy call is never cut off. */
export const PREPARE_SESSION_EXPIRY_SECONDS = (2 * SESSION_GENERATION_BUDGET_MS) / 1000;

export const PrepareSessionPayloadSchema = z.object({
  session_id: z.string().min(1),
  picks: z
    .array(z.object({ sense_id: z.string().min(1), variant_id: z.string().min(1) }))
    .min(1)
    .max(SESSION_LENGTH),
  // Phase 24 (spec D5, D3). Absent in a job enqueued before the deploy: such a
  // session gets no listening cards, and the rotation's first step.
  listening: z.boolean().default(false),
  ordinal: z.number().int().nonnegative().default(0),
});
export type PrepareSessionPayload = z.infer<typeof PrepareSessionPayloadSchema>;

export type JobPayloads = {
  [PREPARE_SESSION]: PrepareSessionPayload;
  [PREPARE_SESSION_FAILED]: PrepareSessionPayload;
};
export type JobName = keyof JobPayloads;
