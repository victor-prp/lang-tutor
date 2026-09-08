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
};

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
