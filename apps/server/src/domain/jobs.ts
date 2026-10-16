import { DIMENSIONS, MAX_LEVEL, MIN_LEVEL, SESSION_LENGTH } from '@lang-tutor/core/domain';
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

/** Phase 24 (spec D16). The most one generation call may take. Five minutes
 *  until phase 47 (spec D1), two since: with its thinking capped the call
 *  takes seconds, and a call the cap did not keep short fails its attempt
 *  rather than hold the learner for minutes. The environment may lower it
 *  (config.ts); tests do. */
export const SESSION_GENERATION_BUDGET_MS = 120_000;

/** Phase 47 (spec D1, ruling R8). The generation call's thinking budget, in
 *  tokens. Uncapped, gemini-2.5-flash once thought 62,910 tokens for four
 *  minutes over one batch. 1024 failed the eval's gap group in five runs of
 *  five, and 2048 wrote Hebrew options for that batch's English words five
 *  times of five; at 4096 the gap group passed five of five and the batch
 *  answered in English eight of eight, in 15–19 s. */
export const SESSION_GENERATION_THINKING = 4096;

/** Phase 34 (spec D6, D8, ruling R12). The most the context call may take, the
 *  call after the batch. A minute: measured at about 7 s for a full session, and
 *  a call that runs out costs only the sentences (ruling R11), never the
 *  session. The environment may lower it (config.ts); tests do. */
export const CONTEXT_CALL_BUDGET_MS = 60_000;

/** Phase 34 (spec D5, ruling R12). The most the checker may take, the call after
 *  the context call. A minute, as the context call's: a full session's checks
 *  are one short answer (the measurement is above LlmCheckSchema). Unlike the
 *  context call, a checker that runs out fails the attempt, and pg-boss retries
 *  it. The environment may lower it (config.ts); tests do. */
export const CHECKER_CALL_BUDGET_MS = 60_000;

/** Phase 34 (ruling R12). Every model call one prepare-session attempt makes, in
 *  order, each at most its budget: the batch, the context call, the checker. A
 *  call added to the attempt adds its budget here. */
export const PREPARE_SESSION_CALL_BUDGETS_MS: readonly number[] = [
  SESSION_GENERATION_BUDGET_MS,
  CONTEXT_CALL_BUDGET_MS,
  CHECKER_CALL_BUDGET_MS,
];

/** Twice the sum of the calls' budgets, phase 19's rule: a worker that crashed
 *  mid-call expires and is retried, and a healthy attempt, every call of which
 *  stays inside its own budget, is never cut off. */
export const PREPARE_SESSION_EXPIRY_SECONDS =
  (2 * PREPARE_SESSION_CALL_BUDGETS_MS.reduce((sum, budget) => sum + budget, 0)) / 1000;

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
        // Phase 35 (spec D5, D6). The dimension the pick tests and its rung,
        // chosen at create time, with the level and R the job's card choice
        // reads. Defaults for a job enqueued before the deploy: a new word.
        dimension: z.enum(DIMENSIONS).default('written_receptive'),
        rung: z.union([z.literal(1), z.literal(2)]).default(1),
        level: z.number().int().min(MIN_LEVEL).max(MAX_LEVEL).default(MIN_LEVEL),
        r: z.number().min(0).max(1).nullable().default(null),
        // Phase 37 (spec D6). A same-day return, asked after every card that is not
        // a return; a ladder's cards can go between returns (phase 54, spec D5).
        // Absent in a job enqueued before the deploy: no return.
        step: z.boolean().default(false),
        // Phase 39 (spec D6). The known meanings a new_meaning card lists; absent
        // before the deploy and on every other pick.
        known_meanings: z.array(z.string()).optional(),
        // Phase 54 (spec D3, D7). A new word's first session, asked as four cards,
        // the meet card first. Absent in a stock prepared before the deploy: no ladder.
        ladder: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(SESSION_LENGTH),
  // Phase 24 (spec D5). Absent in a job enqueued before the deploy: such a
  // session gets no listening cards.
  listening: z.boolean().default(false),
  // Phase 25 (spec D4). Absent in a job enqueued before the deploy: such a
  // session gets no speaking cards.
  speaking: z.boolean().default(false),
  // Phase 24's `ordinal`, the rotation's step, is gone with the rotation (phase
  // 35, spec D6). A job enqueued before the deploy still parses: the key is dropped.
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

/** Phase 34 (spec D1, D2). Asks the model once for every right answer to one
 *  rendering and the form that agrees with it, and stores both. */
export const ACCEPT_RENDERING = 'accept-rendering';
/** Where pg-boss moves an accept job once its retries are spent or it expired.
 *  pg-boss copies the job's `data` across unchanged. */
export const ACCEPT_RENDERING_FAILED = 'accept-rendering-failed';
/** One call within a lookup's 25 s, and two short transactions. */
export const ACCEPT_RENDERING_EXPIRY_SECONDS = 120;

export const AcceptRenderingPayloadSchema = z.object({
  variant_id: z.string().min(1),
  sense_id: z.string().min(1),
  user_language_code: z.string().min(1),
});
export type AcceptRenderingPayload = z.infer<typeof AcceptRenderingPayloadSchema>;

/** Phase 34 (spec D1). One accept job per rendering at a time: the singleton key
 *  its queue's `exclusive` policy holds while a job is queued, retrying or active,
 *  so a burst of sessions picking one rendering pays for one call. */
export const acceptRenderingKey = (payload: AcceptRenderingPayload): string =>
  `${payload.variant_id}:${payload.sense_id}:${payload.user_language_code}`;

/** Phase 43 (spec D3). Builds an enrollment's next session in stock, when it
 *  has none: the list branch of create, run beside the session in progress. */
export const STOCK_SESSION = 'stock-session';
/** One transaction of reads, a few writes and an enqueue: a minute is generous. */
export const STOCK_SESSION_EXPIRY_SECONDS = 60;
/** Phase 43 (ruling R3). How long a save waits before it stocks, so a burst of
 *  saves becomes one session rather than a session of the first word. */
export const STOCK_SAVE_DELAY_SECONDS = 30;

/** What asked for the stock: logged with it, so a stock can be traced to its cause.
 *  Phase 53 (ruling R-D12b): `target`, a change to a target, which retired the stock.
 *  Phase 58 (final review I1): `words_removed`, a level's words removed, which did too. */
export const STOCK_REASONS = ['start', 'answer', 'complete', 'skip', 'save', 'target', 'words_removed'] as const;

export const StockSessionPayloadSchema = z.object({
  enrollment_id: z.string().min(1),
  reason: z.enum(STOCK_REASONS),
  // Ruling R2. Only a start carries the device; every other stock inherits the
  // enrollment's newest session's.
  listening: z.boolean().optional(),
  speaking: z.boolean().optional(),
});
export type StockSessionPayload = z.infer<typeof StockSessionPayloadSchema>;

/** Phase 52 (spec D5). Decides and sends the practice reminders that are due.
 *  EventBridge asks for one run every five minutes, through the tick route. */
export const REMIND = 'remind';
/** Under the five minutes between ticks: a run that hung expires before the
 *  next tick asks for another, and is not retried (the next tick covers it). */
export const REMIND_EXPIRY_SECONDS = 240;

/** The run reads everything it needs from the database: no payload. */
export const RemindPayloadSchema = z.object({});
export type RemindPayload = z.infer<typeof RemindPayloadSchema>;

export type JobPayloads = {
  [REMIND]: RemindPayload;
  [STOCK_SESSION]: StockSessionPayload;
  [PREPARE_SESSION]: PrepareSessionPayload;
  [PREPARE_SESSION_FAILED]: PrepareSessionPayload;
  [READ_PHOTO]: ReadPhotoPayload;
  [READ_PHOTO_FAILED]: ReadPhotoPayload;
  [LOOK_UP_IMPORT_ITEM]: LookUpImportItemPayload;
  [LOOK_UP_IMPORT_ITEM_FAILED]: LookUpImportItemPayload;
  [MERGE_GLOSSES]: MergeGlossesPayload;
  [RENDER_LEMMA]: RenderLemmaPayload;
  [RENDER_LEMMA_FAILED]: RenderLemmaPayload;
  [ACCEPT_RENDERING]: AcceptRenderingPayload;
  [ACCEPT_RENDERING_FAILED]: AcceptRenderingPayload;
};
export type JobName = keyof JobPayloads;
