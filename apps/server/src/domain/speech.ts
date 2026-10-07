import { LlmTranscriptSchema } from '@lang-tutor/core/api/schemas';

import { LANGUAGES, type LanguageCode } from './languages';

/**
 * Phase 25 (spec D13). The pure half of transcription: what the model is told
 * and how its answer is read. services/sessions.ts calls the transcriber and
 * decides what a failure costs.
 */

/** Part of the instruction, and what MockServer matches to tell this call from
 *  the others. Changing the wording means changing the stubs. */
export const TRANSCRIBE_MARKER = 'transcribe the spoken audio';

/** A clip this short (about 750 bytes) holds no word, and Gemini answers an
 *  empty input with a 400: it is "heard nothing" without a call. */
export const MIN_AUDIO_CHARS = 1_000;

/** A transcript is stored as an answer's text (answers_typed_text_length). */
export const MAX_HEARD_CHARS = 100;

/** Blind: the language, never the expected word (spec D1). The POC's wording. */
export function transcriptionSystem(language: LanguageCode): string {
  const name = LANGUAGES[language].name;
  return [
    `Your task: ${TRANSCRIBE_MARKER}. A learner of ${name} is saying a word or a short phrase aloud.`,
    `Write exactly the words that were spoken, in ${name}, in its standard spelling with its accents.`,
    'Do not correct the speaker or guess what they meant: if they said a different word, or mispronounced it into another word, write that.',
    'If nothing intelligible was said, return an empty string.',
  ].join(' ');
}

export function tidyHeard(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, MAX_HEARD_CHARS);
}

/** The heard words, or '' for nothing heard (an empty answer is the provider's
 *  "no content"). Null when the answer cannot be read. */
export function parseTranscript(raw: string): string | null {
  if (raw === '') return '';
  try {
    const parsed = LlmTranscriptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? tidyHeard(parsed.data.heard) : null;
  } catch {
    return null;
  }
}
