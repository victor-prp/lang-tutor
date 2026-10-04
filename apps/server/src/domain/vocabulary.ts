import type {
  TranslationSense,
  VocabularyEntryInput,
  VocabularyWord,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';

/**
 * Where the next list page starts: the last row's newest save and its lexeme id.
 *
 * `savedAt` is Postgres's own text for a timestamptz, never a JS Date. A Date
 * keeps milliseconds and created_at keeps microseconds, so a cursor rounded down
 * would silently skip every word saved later in the same millisecond. The
 * repository prints it with `::text` and casts it back with `::timestamptz`, and
 * the round trip is exact.
 */
export type VocabularyCursor = { savedAt: string; lexemeId: string };

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
  return Buffer.from(JSON.stringify([cursor.savedAt, cursor.lexemeId]), 'utf8').toString(
    'base64url',
  );
}

/** `null` for anything this server did not issue. The caller turns that into a 400. */
export function decodeCursor(raw: string): VocabularyCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [savedAt, lexemeId] = parsed as unknown[];
  if (typeof savedAt !== 'string' || !isRealTimestamptz(savedAt)) return null;
  // A NUL cannot be a Postgres text parameter: it would raise there, a 500.
  if (typeof lexemeId !== 'string' || lexemeId.length === 0 || lexemeId.includes('\u0000')) {
    return null;
  }
  return { savedAt, lexemeId };
}

/** One row of the grouped keyset read, in page order. */
export type WordPageRow = { lexemeId: string; lastSavedAt: string };

/** What the page's enrichment read returns per lexeme. Declared here rather than
 *  imported from the repository: R3 keeps this layer ignorant of Drizzle. */
export type WordSummary = {
  lexemeId: string;
  lemma: string;
  partOfSpeech: string;
  headlineSenseId: string;
  headlineTranslation: string;
  headlineForm: string;
  savedCount: number;
  senseCount: number;
};

/**
 * Page rows to the wire, in PAGE order. The enrichment read is keyed by lexeme
 * id and comes back in whatever order Postgres chose.
 *
 * A row with no summary is dropped. The enrichment read inner-joins each saved
 * entry to its saved form's rendering, so a word whose saved senses lost every
 * rendering has nothing to headline. A repair may not drop a rendering, so this
 * should not happen; if it does, the page is one word short and the cursor —
 * taken from the page rows, not from this output — still advances.
 */
export function assemblePage(rows: WordPageRow[], summaries: WordSummary[]): VocabularyWord[] {
  const byLexeme = new Map(summaries.map((s) => [s.lexemeId, s]));
  return rows.flatMap((row) => {
    const s = byLexeme.get(row.lexemeId);
    if (!s) return [];
    return [
      {
        lexeme_id: s.lexemeId,
        lemma: s.lemma,
        part_of_speech: s.partOfSpeech,
        headline: {
          sense_id: s.headlineSenseId,
          translation: s.headlineTranslation,
          form: s.headlineForm,
        },
        saved_count: s.savedCount,
        sense_count: s.senseCount,
      },
    ];
  });
}

export type LexemeRow = {
  lexemeId: string;
  lemma: string;
  partOfSpeech: string;
  languageCode: string;
};

/** One rendering of one of the lexeme's senses, by one of its forms, in the
 *  enrollment's source language. */
export type LexemeRendering = {
  senseId: string;
  variantId: string;
  form: string;
  rank: number;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

export type SavedEntry = { senseId: string; variantId: string };

/**
 * The drill-down: every sense the lexeme can show in this language, each in one
 * rendering, saved senses first.
 *
 * Which rendering:
 * - a saved sense is shown in its saved form;
 * - an unsaved one in a representative form — the lemma's own spelling if anyone
 *   looked it up, otherwise the form that renders the most of this lexeme, ties
 *   broken by variant id.
 *
 * A saved sense whose saved form no longer renders it falls back to the
 * representative and stays saved. Ranks compared across forms are approximate —
 * rank is per form — and that is accepted: it orders a short list, it ranks
 * nothing that is stored.
 */
export function buildWordDetail(
  lexeme: LexemeRow,
  renderings: LexemeRendering[],
  saved: SavedEntry[],
): VocabularyWordDetail {
  const savedVariant = new Map(saved.map((entry) => [entry.senseId, entry.variantId]));
  const perVariant = new Map<string, number>();
  for (const r of renderings) perVariant.set(r.variantId, (perVariant.get(r.variantId) ?? 0) + 1);

  const lemma = lexeme.lemma.toLowerCase();
  const isLemma = (r: LexemeRendering) => Number(r.form.toLowerCase() === lemma);
  const better = (a: LexemeRendering, b: LexemeRendering) =>
    isLemma(b) - isLemma(a) ||
    perVariant.get(b.variantId)! - perVariant.get(a.variantId)! ||
    a.variantId.localeCompare(b.variantId);

  const bySense = new Map<string, LexemeRendering[]>();
  for (const r of renderings) {
    const list = bySense.get(r.senseId) ?? [];
    list.push(r);
    bySense.set(r.senseId, list);
  }

  const shown = [...bySense.entries()].map(([senseId, options]) => {
    const own = savedVariant.get(senseId);
    return {
      rendering: options.find((o) => o.variantId === own) ?? [...options].sort(better)[0],
      saved: savedVariant.has(senseId),
    };
  });

  shown.sort(
    (a, b) =>
      Number(b.saved) - Number(a.saved) ||
      a.rendering.rank - b.rendering.rank ||
      a.rendering.senseId.localeCompare(b.rendering.senseId),
  );

  return {
    lexeme_id: lexeme.lexemeId,
    lemma: lexeme.lemma,
    part_of_speech: lexeme.partOfSpeech,
    senses: shown.map(({ rendering: r, saved: isSaved }) => ({
      sense_id: r.senseId,
      variant_id: r.variantId,
      form: r.form,
      translation: r.translation,
      ...(r.exampleSource && r.exampleTarget
        ? { example: { source: r.exampleSource, target: r.exampleTarget } }
        : {}),
      saved: isSaved,
    })),
  };
}

/** `saved` on every sense that carries an id; a sense without one (a sentence, a
 *  failed write) is returned untouched, with no `saved` key at all. */
export function markSaved(
  senses: TranslationSense[],
  saved: ReadonlySet<string>,
): TranslationSense[] {
  return senses.map((sense) =>
    sense.sense_id === undefined ? sense : { ...sense, saved: saved.has(sense.sense_id) },
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

/** The first entry of each sense, in order. Saving is first-form-wins in the
 *  database too, so this only spares a batch from validating a duplicate. */
export function firstPerSense(entries: VocabularyEntryInput[]): VocabularyEntryInput[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.sense_id)) return false;
    seen.add(entry.sense_id);
    return true;
  });
}
