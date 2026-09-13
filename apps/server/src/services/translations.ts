import type {
  LlmEntry,
  TranslationDirection,
  TranslationRequest,
  TranslationResponse,
} from '@lang-tutor/core/api';

import {
  buildPrompt,
  buildRenderingPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmReconciliation,
  parseLlmTranslation,
  resolveKind,
  type StoredSense,
} from '../domain/translation';
import {
  flattenEntries,
  kindForForm,
  languagesFor,
  mergeEntries,
  normalizeForm,
  rowsToSenses,
} from '../domain/dictionary';
import { TranslationUnreadable } from '../errors';
import type { Logger } from '../logger';
import type { LlmClient } from './llm';
import type { Transaction } from './transaction';

/**
 * The second model call, per entry that names a lexeme already in the
 * dictionary. It exists because `sense_code` is invented per call: a lookup of
 * `bank` names a sense river_bank and a later lookup of `banks` names the same
 * sense river_edge, so matching on the code alone stores the meaning twice —
 * and the dictionary has no TTL, so twice is forever.
 *
 * Module-private and not exported: it is one step of one use case, not a
 * primitive (ADR 0001 R9). Everything it decides that could be decided without
 * I/O lives in `domain/translation.ts` — the prompt and the parse — so what is
 * left here is the call and the bookkeeping.
 *
 * Throws rather than degrading. This deliberately differs from the failed-write
 * path in `translate`, which still answers 200: that one protects a correct
 * answer whose storage failed, this one prevents storing an answer known to be
 * wrong.
 */
async function reconcile(input: {
  llm: LlmClient;
  form: string;
  direction: TranslationDirection;
  entries: LlmEntry[];
  stored: StoredSense[][];
  logger: Logger;
}): Promise<LlmEntry[]> {
  let reused = 0;
  let newlyNamed = 0;
  let reconciledEntries = 0;

  const out = await Promise.all(
    input.entries.map(async (entry, index) => {
      const storedSenses = input.stored[index];
      // A lexeme nobody has stored has nothing to reconcile against: its codes
      // are new by construction, and a second call would only invite the model
      // to rename what it just named.
      if (storedSenses.length === 0) return entry;

      const raw = await input.llm(
        buildRenderingPrompt({
          form: input.form,
          direction: input.direction,
          lemma: entry.lemma,
          partOfSpeech: entry.part_of_speech,
          storedSenses,
        }),
      );

      const parsed = parseLlmReconciliation(raw);
      if (!parsed) throw new TranslationUnreadable(raw.slice(0, 200));

      reconciledEntries += 1;
      const known = new Set(storedSenses.map((sense) => sense.senseCode));
      const seen = new Set<string>();
      const senses: LlmEntry['senses'] = [];

      for (const rendering of parsed.senses) {
        // `translation: null` is the model saying this form does not admit that
        // sense at all — adjectival `booked` has no record-a-charge reading — so
        // the sense is simply absent for this form rather than forced.
        if (rendering.translation === null) continue;
        // Two renderings sharing a code resolve to one sense id, so they would
        // become two rows with the same (variant_id, sense_id,
        // user_language_code): a primary-key collision that DO NOTHING swallows,
        // leaving a hole in the rank sequence that
        // UNIQUE(variant_id, user_language_code, rank) then rejects. Keep the
        // first; the ranks are re-sequenced below, which is what keeps them
        // contiguous.
        if (seen.has(rendering.sense_code)) continue;
        seen.add(rendering.sense_code);

        if (known.has(rendering.sense_code)) reused += 1;
        else newlyNamed += 1;

        senses.push({
          sense_code: rendering.sense_code,
          translation: rendering.translation,
          ...(rendering.example ? { example: rendering.example } : {}),
        });
      }

      // An answer that reconciled to nothing at all is not an answer. Falling
      // back to call 1's entry here would write exactly the un-reconciled codes
      // this call exists to prevent, so it fails instead.
      if (senses.length === 0) {
        throw new TranslationUnreadable(
          `reconciliation returned no usable sense for ${entry.lemma} (${entry.part_of_speech})`,
        );
      }

      return { ...entry, senses };
    }),
  );

  input.logger.info({
    event: 'dict_reconciled',
    entry_count: reconciledEntries,
    reused,
    newly_named: newlyNamed,
  });

  return out;
}

/**
 * One use case: translate a word, phrase or sentence, reusing what the
 * dictionary already holds.
 *
 * **Two transactions, not one.** ADR 0001 R8 is amended in this phase to say a
 * use case opens at most one *write* transaction, and a read preceding
 * third-party I/O may be its own. Holding one open across the provider call
 * was rejected outright: ten seconds of an idle pooled connection per lookup,
 * one per concurrent learner. The two race harmlessly, because the write is
 * idempotent against UNIQUE(language_code, lemma) and UNIQUE(lexeme_id, form).
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
        repos.dict.findSensesByForm({
          form,
          languageCode: source,
          userLanguageCode: target,
        }),
      );

      if (hit.length > 0) {
        const senses = rowsToSenses(hit);
        logger.info({
          event: 'dict_cache_hit',
          direction,
          term_count: new Set(hit.map((row) => row.lexemeId)).size,
          sense_count: senses.length,
        });
        // Read, not guessed: `kind` is written by the persisting call
        // (`repo/dictionary.ts`) onto the entry_rank 0 variant and read back
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
      let entries = mergeEntries(parsed.entries);
      let flattened = normalizeSenses(kind, flattenEntries(entries));

      // A sentence is not a vocabulary item, and caching "no translation" would
      // freeze a transient answer into a permanent dictionary. Both keep
      // costing on every repeat, deliberately.
      //
      // The reconciliation branch below sits AFTER this guard, not straight
      // after mergeEntries: a sentence is never written to the dictionary, so
      // reconciling one would spend a database round trip and possibly a second
      // model call on an answer that is then discarded.
      if (kind === 'sentence' || entries.length === 0) {
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        return { text, direction, kind, senses: flattened };
      }

      // Two independent calls name the same sense differently — `bank` returns
      // river_bank where `banks` returns river_edge — so matching on sense_code
      // alone would silently duplicate a meaning. Where a lexeme already has
      // senses, a second, smaller call reconciles by meaning instead. R8 permits
      // this read: it precedes third-party I/O and opens no write.
      const stored = await transaction((repos) =>
        Promise.all(
          entries.map((entry) =>
            repos.dict.findSensesByLexeme({
              lemma: entry.lemma,
              partOfSpeech: entry.part_of_speech,
              languageCode: source,
              userLanguageCode: target,
            }),
          ),
        ),
      );

      if (stored.some((senses) => senses.length > 0)) {
        // A failure here is NOT degraded into a partial write. The dictionary
        // has no TTL, so a known-wrong row is permanent while a failed request
        // costs the learner one retry. This deliberately differs from the
        // failed-write path below, which protects a correct answer whose
        // storage failed.
        entries = await reconcile({ llm, form, direction, entries, stored, logger });
        // Both return paths below read `flattened`; a stale one would serve the
        // un-reconciled renderings on the failed-write path only.
        flattened = normalizeSenses(kind, flattenEntries(entries));
      }

      try {
        const { written, senses } = await transaction((repos) =>
          repos.dict.persistEntries({
            form,
            languageCode: source,
            userLanguageCode: target,
            kind,
            entries,
          }),
        );
        logger.info({
          event: 'dict_persisted',
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
        logger.error('dict_persist_failed', error);
        logger.info({ event: 'translated', direction, kind, sense_count: flattened.length });
        return { text, direction, kind, senses: flattened };
      }
    },
  };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
