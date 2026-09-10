import type { TranslationRequest, TranslationResponse } from '@lang-tutor/core/api';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from '../domain/translation';
import { flattenEntries, mergeEntries } from '../domain/vocabulary';
import { TranslationUnreadable } from '../errors';
import type { Logger } from '../logger';
import type { LlmClient } from './llm';

/**
 * One use case: translate a word, phrase or sentence.
 *
 * **No transaction, because no table is touched.** ADR 0001 R8 is amended in
 * this phase for exactly this reason — "each use case is exactly one
 * transaction call" was written when the only I/O was Postgres.
 *
 * This layer knows nothing about Gemini, HTTP, or schema dialects. It receives
 * an `LlmClient` and hands it what `domain/` built; `buildPrompt`'s
 * `TranslationPrompt` and `LlmJsonRequest` are the same shape under two names,
 * and this call is where the compiler checks that.
 */
export function createTranslationService({ llm, logger }: { llm: LlmClient; logger: Logger }) {
  return {
    translate: async (input: TranslationRequest): Promise<TranslationResponse> => {
      // The schema already trimmed this, but the service must not depend on the
      // order validators ran in.
      const text = input.text.trim();
      const direction = input.direction ?? detectDirection(text);

      const raw = await llm(buildPrompt({ text, direction }));

      // An empty string is the contract's "no content" — a safety block, or a
      // candidate with no text. The input was refused; nothing is broken.
      if (raw === '') {
        logger.info({ event: 'translation_no_content', direction });
        return { text, direction, kind: resolveKind(text, 'word'), senses: [] };
      }

      const parsed = parseLlmTranslation(raw);
      // `domain/` cannot throw this itself: R3 forbids it importing ../errors.
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      const kind = resolveKind(text, parsed.kind);
      // mergeEntries before flattening, so a model that split one lemma across
      // two entries does not get its senses interleaved with its own.
      const senses = normalizeSenses(kind, flattenEntries(mergeEntries(parsed.entries)));

      logger.info({ event: 'translated', direction, kind, sense_count: senses.length });
      return { text, direction, kind, senses };
    },
  };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
