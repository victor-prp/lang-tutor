import type {
  GlossProgress,
  TranslationSense,
  VocabularyEntryInput,
  VocabularyWord,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';
import { DIMENSIONS, LIVE_DIMENSIONS, MIN_LEVEL, badge, type Dimension } from '@lang-tutor/core/domain';

import type { ProgressRow } from './progress';

/**
 * Where the next list page starts: the last row's newest save and its lemma.
 *
 * `savedAt` is Postgres's own text for a timestamptz, never a JS Date. A Date
 * keeps milliseconds and created_at keeps microseconds, so a cursor rounded down
 * would silently skip every word saved later in the same millisecond. The
 * repository prints it with `::text` and casts it back with `::timestamptz`, and
 * the round trip is exact.
 */
export type VocabularyCursor = { savedAt: string; lemma: string };

// Phase 21. The leading tag is what makes a phase 18 or phase 20 cursor — two or
// four elements, keyed by lexeme id — decode to null and answer 400, rather than
// be read as a position among lemmas.
const CURSOR_TAG = 'lemma';

// What `timestamptz::text` prints under DateStyle ISO: `2026-10-04 12:00:00.123456+00`.
// Anything else is refused here, because the repository casts it with
// ::timestamptz and a junk string there would be a 500 rather than a 400.
const PG_TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?[+-](\d{2})(?::(\d{2}))?$/;

// Well-shaped is not enough: `2026-13-45 25:61:00+00` matches the pattern and
// makes the cast raise, which is a 500. So the fields are range-checked too, the
// day against its month's length.
function isRealTimestamptz(text: string): boolean {
  const m = PG_TIMESTAMPTZ.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offsetHour] = m.slice(1, 8).map(Number);
  const offsetMinute = m[8] === undefined ? 0 : Number(m[8]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 15 || offsetMinute > 59) return false;
  // Day 0 of the next month is the last day of this one. setUTCFullYear, not
  // Date.UTC, so a year below 100 is not read as 19xx.
  const lastOfMonth = new Date(0);
  lastOfMonth.setUTCFullYear(year, month, 0);
  return day <= lastOfMonth.getUTCDate();
}

export function encodeCursor(cursor: VocabularyCursor): string {
  return Buffer.from(JSON.stringify([CURSOR_TAG, cursor.savedAt, cursor.lemma]), 'utf8').toString('base64url');
}

/** `null` for anything this server did not issue. The caller turns that into a 400. */
export function decodeCursor(raw: string): VocabularyCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [tag, savedAt, lemma] = parsed as unknown[];
  if (tag !== CURSOR_TAG) return null;
  if (typeof savedAt !== 'string' || !isRealTimestamptz(savedAt)) return null;
  // A NUL cannot be a Postgres text parameter: it would raise there, a 500.
  if (typeof lemma !== 'string' || lemma.length === 0 || lemma.includes('\u0000')) return null;
  return { savedAt, lemma };
}

/** One row of the grouped keyset read, in page order. `level` is the word's
 *  badge: the rounded mean over every saved gloss of the lemma and the live
 *  dimensions. */
export type WordPageRow = { lemma: string; lastSavedAt: string; level: number };

/** The cursor that continues after `row`. */
export function cursorAfter(row: WordPageRow): VocabularyCursor {
  return { savedAt: row.lastSavedAt, lemma: row.lemma };
}

/** What the page's enrichment read returns per lemma. Declared here rather than
 *  imported from the repository: R3 keeps this layer ignorant of Drizzle. */
export type WordSummary = {
  lemma: string;
  partsOfSpeech: string[];
  headlineGlossId: string;
  headlineTranslation: string;
  headlineForm: string;
  savedCount: number;
  /** Phase 31 (spec D11). The lemma's live glosses in the enrollment's language. */
  glossCount: number;
  /** Display names of everyone but the list's owner who saved a gloss of it. */
  addedBy: string[];
};

/**
 * Page rows to the wire, in PAGE order. The enrichment read is keyed by lemma
 * and comes back in whatever order Postgres chose.
 *
 * A row with no summary is dropped. The enrichment read inner-joins each saved
 * entry to its gloss and its saved form, both foreign keys, so a word with a
 * saved entry always has a headline (phase 31: no rendering is read). Should
 * one be missing, the page is one word short and the cursor — taken from the
 * page rows, not from this output — still advances.
 */
export function assemblePage(rows: WordPageRow[], summaries: WordSummary[]): VocabularyWord[] {
  const byLemma = new Map(summaries.map((s) => [s.lemma, s]));
  return rows.flatMap((row) => {
    const s = byLemma.get(row.lemma);
    if (!s) return [];
    return [
      {
        lemma: s.lemma,
        parts_of_speech: s.partsOfSpeech,
        headline: { gloss_id: s.headlineGlossId, translation: s.headlineTranslation, form: s.headlineForm },
        saved_count: s.savedCount,
        gloss_count: s.glossCount,
        level: row.level,
        added_by: s.addedBy,
      },
    ];
  });
}

/** One lexeme of the word: the detail spans every lexeme with the lemma. */
export type WordLexeme = { lexemeId: string; partOfSpeech: string };

/** One rendering of one of the word's senses, by one form of that sense's own
 *  lexeme, in the enrollment's source language. */
export type LexemeRendering = {
  lexemeId: string;
  senseId: string;
  /** Phase 31. The sense's gloss in the enrollment's learner language. */
  glossId: string;
  /** Phase 31. The gloss's key and alternatives (spec D5, D11). */
  glossKey: string;
  glossAlternatives: string[];
  variantId: string;
  form: string;
  rank: number;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

/** `addedBy` is the adder's display name, or null when the list's owner saved it. */
export type SavedEntry = { glossId: string; variantId: string; addedBy: string | null };

/** A saved gloss's five levels and its badge over the live dimensions. A
 *  dimension with no row reads as level 1: every entry has five rows, so that
 *  only guards a broken fixture. */
function glossProgressOf(rows: ProgressRow[]): GlossProgress {
  const byDimension = new Map(rows.map((row) => [row.dimension, row.level]));
  const levelOf = (dimension: Dimension) => byDimension.get(dimension) ?? MIN_LEVEL;
  const dimensions = {} as GlossProgress['dimensions'];
  for (const dimension of DIMENSIONS) dimensions[dimension] = levelOf(dimension);
  return { level: badge(LIVE_DIMENSIONS.map(levelOf)), dimensions };
}

/**
 * The drill-down (phase 31, spec D10, D11): one card per gloss of every lexeme
 * with this lemma that the enrollment's learner language can show, labelled with
 * its part of speech. Saved glosses first, then by part of speech, then by the
 * gloss's best rank, then by gloss id.
 *
 * A card's headline is the gloss's key. The rendering it names, the one a save
 * from here records, is the saved form's while that form still renders a member,
 * otherwise a representative: the lemma's own spelling if anyone looked it up,
 * else the form that renders the most senses, ties broken by variant id.
 * `saved_from` names the saved form when it is not the lemma.
 *
 * Each member sense gives one example, from the same choice of form: the lemma's
 * where it renders that sense, otherwise the representative. All are shown;
 * capping them would hide exactly the meaning the learner has not met.
 */
export function buildWordDetail(
  lemma: string,
  lexemes: WordLexeme[],
  renderings: LexemeRendering[],
  saved: SavedEntry[],
  progress: ProgressRow[],
): VocabularyWordDetail {
  const partOfSpeech = new Map(lexemes.map((lexeme) => [lexeme.lexemeId, lexeme.partOfSpeech]));
  const entries = new Map(saved.map((entry) => [entry.glossId, entry]));
  const perVariant = new Map<string, number>();
  for (const r of renderings) perVariant.set(r.variantId, (perVariant.get(r.variantId) ?? 0) + 1);

  const lowered = lemma.toLowerCase();
  const isLemma = (r: LexemeRendering) => Number(r.form.toLowerCase() === lowered);
  const better = (a: LexemeRendering, b: LexemeRendering) =>
    isLemma(b) - isLemma(a) ||
    perVariant.get(b.variantId)! - perVariant.get(a.variantId)! ||
    a.variantId.localeCompare(b.variantId);
  const byRank = (a: LexemeRendering, b: LexemeRendering) => a.rank - b.rank || a.senseId.localeCompare(b.senseId);

  const byGloss = new Map<string, LexemeRendering[]>();
  for (const r of renderings) byGloss.set(r.glossId, [...(byGloss.get(r.glossId) ?? []), r]);

  const progressByGloss = new Map<string, ProgressRow[]>();
  for (const row of progress) progressByGloss.set(row.glossId, [...(progressByGloss.get(row.glossId) ?? []), row]);
  const live = progress.filter((row) => LIVE_DIMENSIONS.includes(row.dimension));

  const cards = [...byGloss.entries()].map(([glossId, options]) => {
    const entry = entries.get(glossId);
    const savedRendering = entry ? options.filter((o) => o.variantId === entry.variantId).sort(byRank)[0] : undefined;
    const shown = savedRendering ?? [...options].sort(better)[0];

    const bySense = new Map<string, LexemeRendering[]>();
    for (const o of options) bySense.set(o.senseId, [...(bySense.get(o.senseId) ?? []), o]);
    const examples = [...bySense.values()]
      .map((own) => [...own].sort(better)[0])
      .sort(byRank)
      .flatMap((pick) =>
        pick.exampleSource && pick.exampleTarget ? [{ source: pick.exampleSource, target: pick.exampleTarget }] : [],
      );

    const savedFrom =
      savedRendering && savedRendering.form.toLowerCase() !== lowered
        ? { form: savedRendering.form, translation: savedRendering.translation }
        : undefined;
    const glossProgress = progressByGloss.get(glossId);

    return {
      rank: [...options].sort(byRank)[0].rank,
      partOfSpeech: partOfSpeech.get(shown.lexemeId) ?? '',
      card: {
        gloss_id: glossId,
        variant_id: shown.variantId,
        form: shown.form,
        translation: shown.glossKey,
        alternatives: [...shown.glossAlternatives],
        part_of_speech: partOfSpeech.get(shown.lexemeId) ?? '',
        examples,
        saved: entry !== undefined,
        ...(entry?.addedBy ? { added_by: entry.addedBy } : {}),
        ...(entry && glossProgress ? { progress: glossProgressOf(glossProgress) } : {}),
        ...(savedFrom ? { saved_from: savedFrom } : {}),
      },
    };
  });

  cards.sort(
    (a, b) =>
      Number(b.card.saved) - Number(a.card.saved) ||
      (a.partOfSpeech < b.partOfSpeech ? -1 : a.partOfSpeech > b.partOfSpeech ? 1 : 0) ||
      a.rank - b.rank ||
      a.card.gloss_id.localeCompare(b.card.gloss_id),
  );

  return {
    lemma,
    level: live.length === 0 ? null : badge(live.map((row) => row.level)),
    senses: cards.map(({ card }) => card),
  };
}

/** `saved` on every sense that carries an id; a sense without one (a sentence, a
 *  failed write) is returned untouched, with no `saved` key at all. Phase 31:
 *  `saved` holds gloss ids, so a sense is saved when its gloss is. */
export function markSaved(
  senses: TranslationSense[],
  saved: ReadonlySet<string>,
): TranslationSense[] {
  return senses.map((sense) =>
    sense.gloss_id === undefined ? sense : { ...sense, saved: saved.has(sense.gloss_id) },
  );
}

/** Whether a lookup's pair is the enrollment's, in either direction. */
export function coversPair(
  enrollment: { source_language: string; target_language: string },
  from: string,
  to: string,
): boolean {
  return (
    (from === enrollment.target_language && to === enrollment.source_language) ||
    (from === enrollment.source_language && to === enrollment.target_language)
  );
}

/** The first entry of each gloss, in order. Saving is first-form-wins in the
 *  database too, so this only spares a batch from validating a duplicate. */
export function firstPerGloss(entries: VocabularyEntryInput[]): VocabularyEntryInput[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.gloss_id)) return false;
    seen.add(entry.gloss_id);
    return true;
  });
}
