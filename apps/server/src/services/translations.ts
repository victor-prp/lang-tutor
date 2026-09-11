import type { TranslationRequest, TranslationResponse } from '@lang-tutor/core/api';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from '../domain/translation';
import {
  flattenEntries,
  kindForForm,
  languagesFor,
  mergeEntries,
  normalizeForm,
  rowsToSenses,
} from '../domain/vocabulary';
import { TranslationUnreadable } from '../errors';
import type { Logger } from '../logger';
import type { LlmClient } from './llm';
import type { Transaction } from './transaction';

/**
 * One use case: translate a word, phrase or sentence, reusing what the
 * dictionary already holds.
 *
 * **Two transactions, not one.** ADR 0001 R8 is amended in this phase to say a
 * use case opens at most one *write* transaction, and a read preceding
 * third-party I/O may be its own. Holding one open across the provider call
 * was rejected outright: ten seconds of an idle pooled connection per lookup,
 * one per concurrent learner. The two race harmlessly, because the write is
 * idempotent against UNIQUE(language_code, lemma) and UNIQUE(term_id, form).
 *
 * Note the calls below are written as bare `transaction(...)`, destructured
 * from the parameter list, never read off a `deps` object: R8's lint check
 * scans this tree for any other call site of the primitive.
 */
export function createTranslationService({
  llm,
  transaction,
  logger,
}: {
  llm: LlmClient;
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    translate: async (input: TranslationRequest): Promise<TranslationResponse> => {
      // The schema already trimmed this, but the service must not depend on the
      // order validators ran in.
      const text = input.text.trim();
      const direction = input.direction ?? detectDirection(text);
      const { source, target } = languagesFor(direction);
      const form = normalizeForm(text);

      const hit = await transaction((repos) =>
        repos.vocab.findSensesByForm({
          form,
          languageCode: source,
          userLanguageCode: target,
        }),
      );

      if (hit.length > 0) {
        const senses = rowsToSenses(hit);
        logger.info({
          event: 'vocab_cache_hit',
          direction,
          term_count: new Set(hit.map((row) => row.termId)).size,
          sense_count: senses.length,
        });
        // Read, not guessed: `kind` is written by the persisting call
        // (`repo/vocabulary.ts`) onto the entry_rank 0 variant and read back
        // by `kindForForm`, so a hit answers with what was actually stored —
        // never a re-derived guess that can disagree with it.
        return { text, direction, kind: kindForForm(hit), senses };
      }

      const raw = await llm(buildPrompt({ text, direction }));

      // An empty string is the contract's "no content" — a safety block, or a
      // candidate with no text. The input was refused; nothing is broken, and
      // nothing is written.
      if (raw === '') {
        logger.info({ event: 'translation_no_content', direction });
        return { text, direction, kind: resolveKind(text, 'word'), senses: [] };
      }

      const parsed = parseLlmTranslation(raw);
      // `domain/` cannot throw this itself: R3 forbids it importing ../errors.
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      const kind = resolveKind(text, parsed.kind);
      const entries = mergeEntries(parsed.entries);
      const flattened = normalizeSenses(kind, flattenEntries(entries));

      // A sentence is not a vocabulary item, and caching "no translation" would
      // freeze a transient answer into a permanent dictionary. Both keep
      // costing on every repeat, deliberately.
      if (kind === 'sentence' || entries.length === 0) {
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        return { text, direction, kind, senses: flattened };
      }

      try {
        const { written, senses } = await transaction((repos) =>
          repos.vocab.persistEntries({
            form,
            languageCode: source,
            userLanguageCode: target,
            kind,
            entries,
          }),
        );
        logger.info({
          event: 'vocab_persisted',
          entry_count: written.length,
          terms_created: written.filter((entry) => entry.created).length,
        });
        logger.info({ event: 'translated', direction, kind, sense_count: senses.length });
        return { text, direction, kind, senses };
      } catch (error) {
        // A failed write must not lose a translation the learner already paid
        // for. A broken persistence path shows up as this log line and as every
        // lookup costing a provider call — not as a 502 on a request the model
        // answered.
        logger.error('vocab_persist_failed', error);
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        return { text, direction, kind, senses: flattened };
      }
    },
  };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
