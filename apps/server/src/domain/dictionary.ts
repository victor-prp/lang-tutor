import type {
  LlmEntry,
  LlmSense,
  PartOfSpeech,
  TranslationKind,
  TranslationSense,
} from '@lang-tutor/core/api';
import { normaliseGloss } from '@lang-tutor/core/domain';

import { splitTranslation, tidyGlossList } from './glosses';
import { stripStress } from './languages';

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
// stores every sense; only what a client sees is truncated. Phase 31: it counts
// cards, one per gloss, never rows (spec D15).
const RESPONSE_CARD_CAP = 5;

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
  for (const raw of entries) {
    // Phase 16. The lemma becomes half of dict_lexemes' unique key, so a stress
    // mark the model added despite the prompt would be a second lexeme forever.
    const entry = { ...raw, lemma: stripStress(raw.lemma) };
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
 *
 * Phase 31: grouped into cards like rowsToCards, by entry and citation form.
 * `kind` is the answer's: a sentence's translation is taken whole (asWritten).
 * A card is built field by field from the rendering, never spread from the
 * model's sense: `sense_code` must not reach a client, and Zod strips unknown
 * keys on parse, not on serialize, so a spread would leak it silently.
 */
export function flattenEntries(entries: LlmEntry[], kind: TranslationKind): TranslationSense[] {
  const rows: CardRow[] = [];
  const deepest = Math.max(0, ...entries.map((entry) => entry.senses.length));
  for (let rank = 0; rank < deepest; rank++) {
    entries.forEach((entry, index) => {
      const sense = entry.senses[rank];
      if (!sense) return;
      const written = kind === 'sentence' ? asWritten(sense, rank) : renderingOf(sense, rank);
      rows.push({
        id: `${index} ${normaliseGloss(written.gloss)}`,
        card: { translation: written.translation, part_of_speech: entry.part_of_speech },
        key: written.gloss,
        example: exampleOf(written.exampleSource, written.exampleTarget),
        alternatives: written.alternatives,
      });
    });
  }
  return groupCards(rows);
}

/**
 * A sentence's sense as the model wrote it. Spec D4's one translation is a word
 * sense's rule: a sentence is one translation already, and its comma is part of
 * it, so splitting there answered half the sentence. A phrase still splits:
 * its comma lists are alternatives ("pick up": לקלוט, ללמוד). A sentence is
 * never stored, so nothing but the answer reads this.
 */
function asWritten(sense: LlmSense, rank: number): Rendering {
  return {
    rank,
    translation: sense.translation,
    alternatives: [],
    gloss: sense.translation,
    glossAlternatives: [],
    definition: null,
    exampleSource: sense.example?.source ?? null,
    exampleTarget: sense.example?.target ?? null,
  };
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
  // Phase 16. Stress first, before the single-token check, because a multi-word
  // expression returns early below and must lose its stress marks too.
  const collapsed = stripStress(text.trim().replace(/\s+/g, ' '));

  // A multi-word expression keeps its punctuation: it is part of the
  // expression, and two seeded ones — `How do you do?` and `Have a nice day!` —
  // are stored with it. Only a single token is treated as a bare key with a
  // sentence mark stuck to it.
  if (/\s/.test(collapsed)) return collapsed;

  // Phase 12 follow-up. What this function returns is a dictionary KEY — the `form` a
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

/**
 * A row of the by-form read. Declared here rather than imported from Drizzle:
 * R3 forbids this layer knowing that Drizzle exists, and `repo/dictionary.ts`
 * selects exactly these columns under exactly these names.
 */
export type SenseRow = {
  lexemeId: string;
  /** Phase 18: the sense and the form this row renders, so the wire can name
   *  what a client saves. */
  senseId: string;
  /** Phase 31. The sense's gloss in the read's learner language. */
  glossId: string;
  variantId: string;
  rank: number;
  entryRank: number;
  partOfSpeech: string | null;
  exampleSource: string | null;
  translation: string;
  exampleTarget: string | null;
  /** The queried form's own kind, copied onto every row from the
   *  entry_rank 0 variant's `dict_variants.kind` — see `kindForForm`. */
  kind: TranslationKind;
  /** Phase 31. The gloss's key, for the card's `key` (spec D11). */
  glossKey: string;
  /** Phase 31 (spec D5). This rendering's alternatives. */
  alternatives: string[];
};

/**
 * The kind a cache hit should answer with: the entry_rank 0 variant's, never
 * guessed. `entriesToRows` gives the query's own headword entry_rank 0, and
 * `(language_code, lower(form), entry_rank)` is unique, so at most one row
 * carries it. It is also never missing from a non-empty hit: the read returns
 * every rendering of the form (phase 31; the cap is on cards, after grouping),
 * so that variant's rows are always in it — which is why this asserts rather
 * than falls back to a guess.
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
  /** Phase 31. One translation, never a list (splitTranslation). */
  translation: string;
  /** Phase 31 (spec D5). The sense's other target words in this form's inflection. */
  alternatives: string[];
  /** Phase 31 (spec D6). The translation's citation form: the translation itself
   *  until the prompt asks the model for one. */
  gloss: string;
  /** Phase 31 (spec D5). The alternatives' citation forms, for the gloss. */
  glossAlternatives: string[];
  /** Phase 31 (spec D9). */
  definition: string | null;
  exampleSource: string | null;
  exampleTarget: string | null;
};

/** One rendering as every writer stores it; the lookup adds the sense code. */
export type Rendering = Omit<SenseToWrite, 'senseCode'>;

/**
 * Phase 31. A sense as a writer hands it over: the first call's (LlmSense),
 * which may also carry the gloss's citation alternatives. The rendering call
 * answers them (services/translations.ts) and a dictionary restore replays them
 * (db/dictExport.ts); the first call no longer asks the model for them
 * (LlmSenseSchema).
 */
export type SenseToStore = LlmSense & { gloss_alternatives?: readonly string[] };

/** An entry as a writer hands it over: the first call's, with SenseToStore senses. */
export type EntryToStore = Omit<LlmEntry, 'senses'> & { senses: SenseToStore[] };

/**
 * Phase 31. A model's sense as every writer stores it: one clean translation and
 * the rest of any list as alternatives, so a model that ignores "one
 * translation" still never puts a list on a card (Review Focus 5). The citation
 * form is the model's, cleaned the same way, or the translation when it gave
 * none. The lookup and the repair both call it.
 */
export function renderingOf(
  sense: {
    translation: string;
    example?: { source: string; target: string };
    alternatives?: readonly string[] | null;
    gloss?: string | null;
    gloss_alternatives?: readonly string[] | null;
    definition?: string | null;
  },
  rank: number,
): Rendering {
  const said = splitTranslation(sense.translation);
  const cited = sense.gloss ? splitTranslation(sense.gloss) : null;
  const gloss = cited?.translation ?? said.translation;
  return {
    rank,
    translation: said.translation,
    alternatives: tidyGlossList([...said.alternatives, ...(sense.alternatives ?? [])], said.translation),
    gloss,
    glossAlternatives: tidyGlossList([...(cited?.alternatives ?? []), ...(sense.gloss_alternatives ?? [])], gloss),
    definition: sense.definition?.trim() || null,
    exampleSource: sense.example?.source ?? null,
    exampleTarget: sense.example?.target ?? null,
  };
}

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
 *
 * Phase 31 (spec D12). `entryRankOffset` starts the entry ranks past a form's
 * existing headwords, for a headword added to a form already written: the
 * render-lemma job's scoped path.
 */
export function entriesToRows(entries: readonly EntryToStore[], entryRankOffset = 0): EntryRows[] {
  return entries.map((entry, index) => ({
    lemma: entry.lemma,
    partOfSpeech: entry.part_of_speech,
    entryRank: entryRankOffset + index,
    senses: entry.senses.map((sense, rank) => ({ senseCode: sense.sense_code, ...renderingOf(sense, rank) })),
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

type Example = { source: string; target: string };
type PendingCard = { card: TranslationSense; alternatives: string[] };

const exampleOf = (source: string | null, target: string | null): Example | null =>
  source && target ? { source, target } : null;

/** A pending card's alternatives tidied, and the card returned. */
function finish({ card, alternatives }: PendingCard): TranslationSense {
  const tidy = tidyGlossList(alternatives, card.translation);
  return tidy.length > 0 ? { ...card, alternatives: tidy } : card;
}

/**
 * Phase 31 (spec D10, D15). Rows to the wire: one card per gloss, in the order of
 * each gloss's first row, which is the read's (rank first, then entry rank, so
 * still round-robin across lexemes), at most five cards. The cap counts cards,
 * not rows: `stream`'s seven rows are five glosses and show five cards. A card
 * reads the typed form: its lowest-ranked member's rendering is the translation,
 * every member adds its example, and the renderings' alternatives are pooled.
 * `key` is the gloss's, sent only when it differs from the translation.
 */
export function rowsToCards(rows: SenseRow[]): TranslationSense[] {
  return groupCards(
    rows.map((row) => ({
      id: row.glossId,
      card: {
        translation: row.translation,
        gloss_id: row.glossId,
        variant_id: row.variantId,
        ...(row.partOfSpeech ? { part_of_speech: row.partOfSpeech } : {}),
      },
      key: row.glossKey,
      example: exampleOf(row.exampleSource, row.exampleTarget),
      alternatives: row.alternatives,
    })),
  );
}

/** One rendering as card grouping reads it: the group it joins, the card it
 *  starts when it is the group's first, and what every member adds. */
type CardRow = { id: string; card: TranslationSense; key: string; example: Example | null; alternatives: readonly string[] };

/** Renderings to cards by group id, in first-seen order, at most
 *  RESPONSE_CARD_CAP cards. A group's first row names its card; every row adds
 *  its example and its alternatives, so a capped card still gathers them. */
function groupCards(rows: readonly CardRow[]): TranslationSense[] {
  const cards = new Map<string, PendingCard>();
  for (const row of rows) {
    const seen = cards.get(row.id);
    if (seen) {
      if (row.example) seen.card.examples = [...(seen.card.examples ?? []), row.example];
      seen.alternatives.push(...row.alternatives);
      continue;
    }
    if (cards.size === RESPONSE_CARD_CAP) continue;
    const card: TranslationSense = { ...row.card };
    if (row.example) card.examples = [row.example];
    if (normaliseGloss(row.key) !== normaliseGloss(card.translation)) card.key = row.key;
    cards.set(row.id, { card, alternatives: [...row.alternatives] });
  }
  return [...cards.values()].map(finish);
}
