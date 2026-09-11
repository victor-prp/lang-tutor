import type {
  LlmEntry,
  LlmSense,
  TranslationDirection,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';

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

/**
 * The lookup key. Trim and collapse internal whitespace, and nothing else.
 *
 * Deliberately does **not** lowercase: `lower(form)` in the unique index does
 * the matching, so the stored string keeps the shape it was written in — a
 * recorded `How do you do?` stays a decent quiz prompt, and a learner typing
 * `BOOK` stores `BOOK` and is matched anyway.
 *
 * No nikud stripping and no punctuation rules either. Each would be a guess
 * about learner behaviour with no evidence behind it, and each wrong guess
 * turns a hit into a silent miss.
 */
export function normalizeForm(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Both codes come from `direction` alone. No user id is involved, which is why
 *  the request schema did not have to change. */
export function languagesFor(direction: TranslationDirection): {
  source: string;
  target: string;
} {
  return direction === 'en_he' ? { source: 'en', target: 'he' } : { source: 'he', target: 'en' };
}

/**
 * A row of the by-form read. Declared here rather than imported from Drizzle:
 * R3 forbids this layer knowing that Drizzle exists, and `repo/vocabulary.ts`
 * selects exactly these columns under exactly these names.
 */
export type SenseRow = {
  termId: string;
  rank: number;
  entryRank: number;
  partOfSpeech: string | null;
  exampleSource: string | null;
  translation: string;
  exampleTarget: string | null;
  /** The queried form's own kind, copied onto every row from the
   *  entry_rank 0 variant's `term_variants.kind` — see `kindForForm`. */
  kind: TranslationKind;
};

/**
 * The kind a cache hit should answer with: the entry_rank 0 variant's, never
 * guessed. `entriesToRows` gives the query's own headword entry_rank 0, and
 * `(language_code, lower(form), entry_rank)` is unique, so at most one row
 * carries it. It is also never missing from a non-empty hit: the read orders
 * by `rank` first, so that row's rank-0 sense sorts ahead of every rank-1
 * sense from any other contributing term and can never be pushed off
 * `READ_LIMIT` — which is why this asserts rather than falls back to a guess.
 */
export function kindForForm(rows: SenseRow[]): TranslationKind {
  return rows.find((row) => row.entryRank === 0)!.kind;
}

/** One sense as the write stores it, across two tables: `exampleSource` is in
 *  the term's own language and lives on the sense, `exampleTarget` is in the
 *  learner's and lives on the translation. */
export type SenseToWrite = {
  rank: number;
  senseCode: string;
  partOfSpeech: string | null;
  exampleSource: string | null;
  translation: string;
  exampleTarget: string | null;
};

export type EntryRows = { lemma: string; entryRank: number; senses: SenseToWrite[] };

/**
 * The two ranks, assigned in the one place that knows both. `entryRank` is this
 * term's position among the entries the model returned *for this form* — a
 * property of the pairing, which is why it ends up on the variant. `rank` is
 * the sense's position within its own headword. Contiguous 0..n with no gaps,
 * which is what lets the read sort on the raw rank rather than a computed
 * position.
 */
export function entriesToRows(entries: LlmEntry[]): EntryRows[] {
  return entries.map((entry, entryRank) => ({
    lemma: entry.lemma,
    entryRank,
    senses: entry.senses.map((sense, rank) => ({
      rank,
      senseCode: sense.sense_code,
      partOfSpeech: sense.part_of_speech ?? null,
      exampleSource: sense.example?.source ?? null,
      translation: sense.translation,
      exampleTarget: sense.example?.target ?? null,
    })),
  }));
}

/**
 * Rows to the wire, field by field. The order is the read's, untouched.
 *
 * A response carries `example` only when both halves are present: `example` is
 * legally optional, and half of one is not an example. Nothing here can emit
 * `sense_code`, because nothing here reads it.
 */
export function rowsToSenses(rows: SenseRow[]): TranslationSense[] {
  return rows.map((row) => {
    const sense: TranslationSense = { translation: row.translation };
    if (row.partOfSpeech) sense.part_of_speech = row.partOfSpeech;
    if (row.exampleSource && row.exampleTarget) {
      sense.example = { source: row.exampleSource, target: row.exampleTarget };
    }
    return sense;
  });
}
