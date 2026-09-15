import type {
  LlmEntry,
  LlmSense,
  PartOfSpeech,
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
 * `TranslationPrompt`. `repo/dictionary.ts` imports these types; nothing here
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
function toResponseSense(sense: LlmSense, partOfSpeech: PartOfSpeech): TranslationSense {
  const result: TranslationSense = { translation: sense.translation, part_of_speech: partOfSpeech };
  if (sense.example) result.example = { source: sense.example.source, target: sense.example.target };
  return result;
}

/**
 * Key on the pair, not the lemma. A model returning (book,noun) and (book,verb)
 * is describing two lexemes, and phase 12 stores them as two rows; fusing them
 * here is what made an inflected verb form serve a noun sense.
 *
 * Two entries sharing a lemma AND a part of speech are still fused, for the
 * reason phase 10 fused every same-lemma pair: Merriam-Webster publishes
 * `book:1` and `book:2`, a model pulled by that convention may split one lexeme
 * across two entries, and under UNIQUE(language_code, lemma, part_of_speech) the
 * second would resolve to the same lexeme and be silently dropped. Rejecting the
 * answer instead would throw away content over a formatting choice.
 *
 * Exact-string keys: `dict_lexemes` is unique on the exact pair, so anything
 * looser here would merge two rows the database keeps apart.
 */
export function mergeEntries(entries: LlmEntry[]): LlmEntry[] {
  const byLexeme = new Map<string, LlmEntry>();
  for (const entry of entries) {
    const key = `${entry.lemma} ${entry.part_of_speech}`;
    const existing = byLexeme.get(key);
    if (existing) existing.senses = [...existing.senses, ...entry.senses];
    else byLexeme.set(key, { ...entry, senses: [...entry.senses] });
  }
  return [...byLexeme.values()];
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
      if (sense) flat.push(toResponseSense(sense, entry.part_of_speech));
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
  const collapsed = text.trim().replace(/\s+/g, ' ');

  // A multi-word expression keeps its punctuation: it is part of the
  // expression, and two seeded ones — `How do you do?` and `Have a nice day!` —
  // are stored with it. Only a single token is treated as a bare key with a
  // sentence mark stuck to it.
  if (/\s/.test(collapsed)) return collapsed;

  // Phase 13. What this function returns is a dictionary KEY — the `form` a
  // variant is stored and matched under — and the dictionary has no TTL, so a
  // key that differs by a keystroke is a second permanent copy of the word. The
  // dev database held `book` with three senses and `book?` with four: two
  // lookups, two provider calls, two divergent answers for one word.
  //
  // Nikud survives this: Hebrew points are combining marks, not punctuation,
  // and they are part of the word rather than something stuck to its end.
  const stripped = collapsed.replace(/[.,;:!?]+$/u, '');

  // An input that is nothing but punctuation has no key to strip down to, and
  // an empty form would defeat the request schema's min(1) after the fact.
  return stripped === '' ? collapsed : stripped;
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
 * R3 forbids this layer knowing that Drizzle exists, and `repo/dictionary.ts`
 * selects exactly these columns under exactly these names.
 */
export type SenseRow = {
  lexemeId: string;
  rank: number;
  entryRank: number;
  partOfSpeech: string | null;
  exampleSource: string | null;
  translation: string;
  exampleTarget: string | null;
  /** The queried form's own kind, copied onto every row from the
   *  entry_rank 0 variant's `dict_variants.kind` — see `kindForForm`. */
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

/**
 * One sense as the write stores it. Both halves of the example travel together
 * now, because both land on the same row: from phase 12 a translation belongs
 * to a (variant, sense) pairing, and an example belongs to the form that was
 * typed — `booked` shows "I booked a table", not "I want to book a table".
 *
 * No part of speech here: that moved up to the lexeme, which is the level that
 * decides which forms a headword has.
 */
export type SenseToWrite = {
  rank: number;
  senseCode: string;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

export type EntryRows = {
  lemma: string;
  partOfSpeech: PartOfSpeech;
  entryRank: number;
  senses: SenseToWrite[];
};

/**
 * The two ranks, assigned in the one place that knows both. `entryRank` is this
 * lexeme's position among the entries the model returned *for this form* — a
 * property of the pairing, which is why it ends up on the variant. `rank` is
 * the sense's position within its own entry, and from phase 12 it ends up on
 * the translation rather than the sense, because it is this form's ordering and
 * not the lexeme's. Contiguous 0..n with no gaps, which is what lets the read
 * sort on the raw rank rather than a computed position.
 */
export function entriesToRows(entries: LlmEntry[]): EntryRows[] {
  return entries.map((entry, entryRank) => ({
    lemma: entry.lemma,
    partOfSpeech: entry.part_of_speech,
    entryRank,
    senses: entry.senses.map((sense, rank) => ({
      rank,
      senseCode: sense.sense_code,
      translation: sense.translation,
      exampleSource: sense.example?.source ?? null,
      exampleTarget: sense.example?.target ?? null,
    })),
  }));
}

/** One row of the staleness probe: a form's variant beside the lexeme it belongs to. */
export type StaleLexemeRow = {
  lexemeId: string;
  variantId: string;
  lemma: string;
  partOfSpeech: string;
  senseVersion: number;
  renderedSenseVersion: number;
};

export type StaleLexeme = Omit<StaleLexemeRow, 'senseVersion' | 'renderedSenseVersion'>;

/**
 * Which of a form's lexemes have learned a sense since this form was rendered.
 *
 * A form spans one variant per lexeme it belongs to — `book` is a variant of the
 * noun lexeme AND of the verb lexeme — and they go stale independently, so this
 * returns a list rather than a boolean. Only the stale ones are re-rendered;
 * `reconcile` is already per-entry, so that falls out of the existing shape.
 */
export function staleLexemes(rows: StaleLexemeRow[]): StaleLexeme[] {
  return rows
    .filter((row) => row.renderedSenseVersion < row.senseVersion)
    .map(({ lexemeId, variantId, lemma, partOfSpeech }) => ({
      lexemeId,
      variantId,
      lemma,
      partOfSpeech,
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
