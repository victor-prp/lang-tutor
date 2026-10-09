/**
 * Phase 31 (spec §2, packages/core). When two target words are one key: NFC; a
 * maqaf or a hyphen read as a space; Hebrew points, cantillation and the
 * combining acute of Russian stress removed; a parenthetical dropped; single
 * spaces; trimmed; lower case.
 *
 * One rule for every place that asks: the SQL index (gloss_key in
 * apps/server/src/db/migrate.ts, which must stay character for character the
 * same), the assignment of senses to glosses, the merge signal, a session's
 * siblings and the photo import's sense matcher. The schema integration test
 * runs both over one list. normaliseHebrew and the distractors' `comparable`
 * stay: they compare answers, not keys.
 *
 * The maqaf goes before the point range is stripped, because U+05BE is inside it.
 */
export function normaliseGloss(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[־-]/gu, ' ')
    .replace(/[֑-ׇ́]/gu, '')
    .replace(/\([^)]*\)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}
