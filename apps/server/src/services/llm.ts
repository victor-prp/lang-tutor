import type { ZodType } from 'zod';

/**
 * The entire provider abstraction: one JSON-shaped completion call.
 *
 * Types only, exactly as `services/transaction.ts` holds `Transaction` — which
 * is what keeps a provider's name out of the service layer without an interface
 * file or a base class. `providers/` implements this structurally and imports
 * nothing from here (ADR 0001 R10); `composition.ts` is where the assignment is
 * checked (R11).
 *
 * Deliberately not covered: streaming, tool calls, multi-turn conversations,
 * embeddings, token accounting. A seam wide enough for capabilities nobody uses
 * is a seam nobody can change.
 */
export type LlmJsonRequest = {
  system: string;
  user: string;
  /**
   * The canonical Zod schema, NOT a JSON Schema document. Each provider converts
   * it to its own dialect, because the dialects contradict each other: Gemini
   * rejects `additionalProperties` while OpenAI's strict mode requires it, and
   * Zod expresses optional by omitting from `required` while OpenAI's strict
   * mode forbids that. A document here would mean this layer had already picked
   * a provider.
   */
  schema: ZodType;
  /** Phase 47 (spec D3). What the call is for and whom it serves, for its record.
   *  Required, so a call site that names no kind does not compile. */
  record: ModelCallRecord;
};

/**
 * Phase 47 (spec D3). One kind per call site, so calls can be counted by what
 * they are for. One client may serve several (`llm` serves the lookup, the
 * rendering calls, accept and the sense match), which is why the call site
 * names its kind and the client does not (ruling R1).
 */
export type ModelCallKind =
  | 'lookup'
  | 'rendering'
  | 'accept'
  | 'sense_match'
  | 'photo_read'
  | 'transcription'
  | 'judge'
  | 'translation_judge'
  | 'fit_judge'
  | 'session_generation'
  | 'context'
  | 'checker'
  | 'gloss_merge'
  // Phase 50 (spec D2). On the judge's client.
  | 'sound_alike';

/** Phase 47 (spec D3). A handle the call site does not have is left out. */
export type ModelCallRecord = {
  kind: ModelCallKind;
  sessionId?: string;
  attempt?: number;
  enrollmentId?: string;
  userId?: string;
};

/**
 * Phase 47 (spec D4). One request to a model as its provider saw it, reported
 * once whatever its outcome: what was sent (media replaced by its type and
 * size), what came back, and how long it took. Declared here, beside
 * LlmClient, and satisfied structurally by the provider (ADR 0001 R10, R11).
 */
export type ModelCall = {
  record: ModelCallRecord;
  model: string;
  startedAt: Date;
  request: unknown;
  /** The body as received; null when none arrived. */
  response: unknown;
  httpStatus: number | null;
  /** The message the call's LlmUnavailable carries, when it failed. */
  error: string | null;
  durationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  finishReason: string | null;
};

/** Phase 47 (spec D5). Never throws: a recording never fails the call it records. */
export type ModelCallRecorder = (call: ModelCall) => Promise<void>;

/**
 * Returns the model's raw JSON text. Parsing and validation happen once, in
 * `domain/`, so malformed output fails identically whoever served it.
 *
 * An **empty string means the provider produced no content** — a safety block,
 * or a candidate with no text. That is a valid answer about the input, not a
 * failure, and the caller turns it into an empty result. Every actual failure
 * throws `LlmUnavailable`.
 */
export type LlmClient = (request: LlmJsonRequest) => Promise<string>;

/**
 * Phase 26 (spec D5). LlmClient's request plus one image, for the one call that
 * reads a photo. Its rules are LlmClient's: raw JSON text, an empty string for
 * "no content", and LlmUnavailable for every failure.
 */
export type VisionJsonRequest = LlmJsonRequest & { image: { data: string; mimeType: string } };
export type VisionClient = (request: VisionJsonRequest) => Promise<string>;
