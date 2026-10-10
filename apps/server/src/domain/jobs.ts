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
    .array(
      z.object({
        // Phase 31. The gloss practised, and the rendering its card is built
        // from: one member sense in one form (spec D12).
        gloss_id: z.string().min(1),
        sense_id: z.string().min(1),
        variant_id: z.string().min(1),
      }),
    )
    .min(1)
    .max(SESSION_LENGTH),
  // Phase 24 (spec D5, D3). Absent in a job enqueued before the deploy: such a
  // session gets no listening cards, and the rotation's first step.
  listening: z.boolean().default(false),
  // Phase 25 (spec D4). Absent in a job enqueued before the deploy: such a
  // session gets no speaking cards.
  speaking: z.boolean().default(false),
  ordinal: z.number().int().nonnegative().default(0),
});
export type PrepareSessionPayload = z.infer<typeof PrepareSessionPayloadSchema>;

/** Phase 26. Reads one import's photo into rows. */
export const READ_PHOTO = 'read-photo';
export const READ_PHOTO_FAILED = 'read-photo-failed';
/** Phase 26. Looks up one row and chooses its sense. */
export const LOOK_UP_IMPORT_ITEM = 'look-up-import-item';
export const LOOK_UP_IMPORT_ITEM_FAILED = 'look-up-import-item-failed';

/** Phase 26 (spec D6). The most one read may take. A long handwritten list is a
 *  long answer. The environment may lower it (config.ts). */
export const PHOTO_READ_BUDGET_MS = 120_000;
/** Twice the budget, phase 19's rule. */
export const READ_PHOTO_EXPIRY_SECONDS = (2 * PHOTO_READ_BUDGET_MS) / 1000;
/** A row's longest chain is the lookup's main call, its reconciliation, then
 *  the match call, each within the lookup's 25 s: 75 s. 180 s leaves room, and
 *  a crashed worker's row is retried within three minutes. */
export const LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS = 180;

export const ReadPhotoPayloadSchema = z.object({ import_id: z.string().min(1) });
export type ReadPhotoPayload = z.infer<typeof ReadPhotoPayloadSchema>;

export const LookUpImportItemPayloadSchema = z.object({
  import_id: z.string().min(1),
  position: z.number().int().nonnegative(),
});
export type LookUpImportItemPayload = z.infer<typeof LookUpImportItemPayloadSchema>;

/** Phase 31 (spec D7). Merges the glosses of one lexeme and language whose
 *  lemma-form rendering names another live gloss's key. */
export const MERGE_GLOSSES = 'merge-glosses';
/** One transaction of a few statements: a minute is generous. */
export const MERGE_GLOSSES_EXPIRY_SECONDS = 60;

export const MergeGlossesPayloadSchema = z.object({
  lexeme_id: z.string().min(1),
  user_language_code: z.string().min(1),
});
export type MergeGlossesPayload = z.infer<typeof MergeGlossesPayloadSchema>;

/** Phase 31 (spec D12). Renders one lexeme's lemma form in one learner language. */
export const RENDER_LEMMA = 'render-lemma';
/** Where pg-boss moves a render-lemma job once its retries are spent or it
 *  expired. pg-boss copies the job's `data` across unchanged. */
export const RENDER_LEMMA_FAILED = 'render-lemma-failed';
/** A lookup's two calls and a write, each call within the lookup's 25 s. */
export const RENDER_LEMMA_EXPIRY_SECONDS = 180;

export const RenderLemmaPayloadSchema = z.object({
  lexeme_id: z.string().min(1),
  user_language_code: z.string().min(1),
});
export type RenderLemmaPayload = z.infer<typeof RenderLemmaPayloadSchema>;

export type JobPayloads = {
  [PREPARE_SESSION]: PrepareSessionPayload;
  [PREPARE_SESSION_FAILED]: PrepareSessionPayload;
  [READ_PHOTO]: ReadPhotoPayload;
  [READ_PHOTO_FAILED]: ReadPhotoPayload;
  [LOOK_UP_IMPORT_ITEM]: LookUpImportItemPayload;
  [LOOK_UP_IMPORT_ITEM_FAILED]: LookUpImportItemPayload;
  [MERGE_GLOSSES]: MergeGlossesPayload;
  [RENDER_LEMMA]: RenderLemmaPayload;
  [RENDER_LEMMA_FAILED]: RenderLemmaPayload;
};
export type JobName = keyof JobPayloads;
