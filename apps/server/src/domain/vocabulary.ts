import type { LlmEntry, LlmSense, TranslationSense } from '@lang-tutor/core/api';

/**
 * The pure core of the dictionary: how a model's entries become rows, how rows
 * become a response, and how a form is normalized before either happens.
 *
 * ADR 0001 R3 forbids every cross-layer import here — no Drizzle, no `../errors`,
 * no `../repo/*` — so the row shapes this module accepts are declared locally,
 * the same arrangement `domain/translation.ts` already uses for
 * `TranslationPrompt`. `repo/vocabulary.ts` imports these types; nothing here
 * imports it.
 */

// The response cap, and the only place five appears in this layer. The database
// stores every sense; only what a client sees is truncated.
const RESPONSE_SENSE_CAP = 5;

/**
 * Field by field, never a spread. `sense_code` is on the model's sense and must
 * not reach a client, and a spread is exactly how it would — silently, and
 * without failing a schema, because Zod strips unknown keys on parse rather
 * than on serialize.
 */
function toResponseSense(sense: LlmSense): TranslationSense {
  const result: TranslationSense = { translation: sense.translation };
  if (sense.part_of_speech) result.part_of_speech = sense.part_of_speech;
  if (sense.example) result.example = { source: sense.example.source, target: sense.example.target };
  return result;
}

/**
 * One entry per lemma, enforced rather than trusted. Merriam-Webster publishes
 * `book:1` and `book:2`, so a model pulled by that convention may split one
 * lemma by part of speech; under UNIQUE(language_code, lemma) the second such
 * entry would resolve to the same term, find senses already written, and be
 * silently dropped. The prompt asks for one entry per headword and this makes
 * it true regardless. Rejecting the answer instead would throw away content
 * over a formatting choice.
 *
 * Exact-string keys: `vocab_terms` is unique on the exact lemma, so anything
 * looser here would merge two rows the database keeps apart.
 */
export function mergeEntries(entries: LlmEntry[]): LlmEntry[] {
  const byLemma = new Map<string, LlmEntry>();
  for (const entry of entries) {
    const existing = byLemma.get(entry.lemma);
    if (existing) existing.senses = [...existing.senses, ...entry.senses];
    else byLemma.set(entry.lemma, { lemma: entry.lemma, senses: [...entry.senses] });
  }
  return [...byLemma.values()];
}

/**
 * The flat answer, ordered exactly as the by-form read orders it: by sense rank
 * first and entry order second. Round-robin, not block-per-entry — a five-sense
 * `see` ahead of `saw` would push `מסור` off the cap entirely, which is the
 * disappearance the entries model exists to prevent.
 *
 * Used on the paths that do not write (a failed write, and the fallback) so
 * those answers match what a later lookup will return.
 */
export function flattenEntries(entries: LlmEntry[]): TranslationSense[] {
  const flat: TranslationSense[] = [];
  const deepest = Math.max(0, ...entries.map((entry) => entry.senses.length));
  for (let rank = 0; rank < deepest; rank++) {
    for (const entry of entries) {
      const sense = entry.senses[rank];
      if (sense) flat.push(toResponseSense(sense));
    }
  }
  return flat.slice(0, RESPONSE_SENSE_CAP);
}
