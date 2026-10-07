import type { ZodType } from 'zod';

/**
 * Phase 25 (spec D13). The audio counterpart of LlmClient: one JSON-shaped
 * completion over one clip. Types only, as llm.ts is, so a provider's name
 * never reaches the service layer; composition.ts is where the assignment is
 * checked (ADR 0001 R11). LlmClient stays text only: widening it for audio
 * would widen it for every caller.
 */
export type LlmAudioRequest = {
  system: string;
  /** The clip, base64. */
  audio: string;
  /** One of SpeechMimeTypeSchema's. */
  mimeType: string;
  /** The canonical Zod schema of the answer; each provider converts it. */
  schema: ZodType;
};

/**
 * Returns the model's raw JSON text; parsing happens once, in domain/speech.ts.
 * An empty string means the provider produced no content. Every failure throws
 * `LlmUnavailable`.
 */
export type SpeechTranscriber = (request: LlmAudioRequest) => Promise<string>;
