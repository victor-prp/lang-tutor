import type { AnswerVerdict } from '@lang-tutor/core/api';
import { DIMENSIONS, MAX_LEVEL, badge, type Dimension } from '@lang-tutor/core/domain';

/**
 * Phase 20. The step rule (spec §3). Pure: the day is passed in, no clock is
 * read (ADR 0001 R3).
 */

/** Phase 24. The types answered by an option, and by a text with its verdict.
 *  Phase 25: a speaking card's answer is stored as a text with its verdict too. */
export type ChoiceAnswerType = 'multiple_choice' | 'reverse_choice' | 'listen_choice' | 'matching';
export type TextAnswerType = 'typed_translation' | 'dictation' | 'letter_tiles' | 'read_aloud' | 'say_translation';

/** One answer as the rule reads it: which sense, which exercise, and how it
 *  was judged. A choice is right or wrong; a text answer has its verdict. */
export type AnsweredQuestion =
  | { senseId: string; type: ChoiceAnswerType; correct: boolean }
  | { senseId: string; type: TextAnswerType; verdict: AnswerVerdict };

/** One piece of evidence about one dimension. A capped piece alone can carry
 *  a dimension to its cap and no further; null is no cap. */
export type Evidence = { dimension: Dimension; correct: boolean; cap: number | null };

/** One row of sense_progress. Days are UTC calendar dates, `YYYY-MM-DD`. */
export type ProgressRow = {
  senseId: string;
  dimension: Dimension;
  level: number;
  lastStepOn: string | null;
  lastWrongOn: string | null;
};

/** What one ended session did to one row of a practised saved sense. */
export type SnapshotRow = { senseId: string; dimension: Dimension; levelBefore: number; levelAfter: number };

/** A snapshot row as the results read it back, with the question that asked it. */
export type SnapshotRead = SnapshotRow & { form: string; translation: string; position: number };

/** One practised saved sense, as badges, and the live dimensions that rose:
 *  with a badge over three dimensions, one can rise alone (phase 23, D11). */
export type ProgressChange = {
  senseId: string;
  form: string;
  translation: string;
  levelBefore: number;
  levelAfter: number;
  raised: Dimension[];
};

/** Whole days that must pass, since the later of the last step and the last
 *  mistake, before a row may rise from level 1, 2, 3, 4. Level 5 therefore
 *  needs four all-correct days spanning at least 29 days. */
export const GAP_DAYS: readonly number[] = [0, 1, 7, 21];

/** The highest level capped evidence alone can reach. */
export const CAPPED_MAX_LEVEL = 3;

/** Phase 25 (spec D10). Reading a shown word aloud: "said it", and no more. */
export const READ_ALOUD_MAX_LEVEL = 2;

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

/** Whole UTC days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * What one answer says about which dimensions: phase 20's §3 table, filled in
 * for phase 23's types (spec D6) and phase 24's (spec D12). A productive success also credits the
 * receptive dimension below it; only successes are credited downward; and
 * recognition-format evidence caps a productive dimension at 3.
 */
/** A typed answer's evidence (phase 23 D6), for a typed card and for the
 *  typed form of say the translation (phase 25 D8). */
function typedEvidence(verdict: AnswerVerdict, piece: (dimension: Dimension, correct: boolean) => Evidence): Evidence[] {
  switch (verdict) {
    case 'exact':
      return [piece('written_receptive', true), piece('written_productive', true), piece('spelling', true)];
    case 'near_miss':
      return [piece('written_receptive', true), piece('written_productive', true), piece('spelling', false)];
    case 'wrong':
      // A failure to recall is the productive failure; it says nothing
      // about spelling a form the learner did not produce.
      return [piece('written_productive', false)];
    default:
      // An alternative is right but not this word: nothing about this sense.
      return [];
  }
}

export function evidenceFor(answer: AnsweredQuestion): Evidence[] {
  const piece = (dimension: Dimension, correct: boolean, cap: number | null = null): Evidence => ({
    dimension,
    correct,
    cap,
  });
  switch (answer.type) {
    case 'multiple_choice':
      return [piece('written_receptive', answer.correct)];
    case 'reverse_choice':
      // Picking the form out of four is recognition of it: productive evidence,
      // capped. A failure says nothing about knowing the meaning.
      return answer.correct
        ? [piece('written_receptive', true), piece('written_productive', true, CAPPED_MAX_LEVEL)]
        : [piece('written_productive', false, CAPPED_MAX_LEVEL)];
    case 'typed_translation':
      return typedEvidence(answer.verdict, piece);
    case 'listen_choice':
      // Hearing, then knowing the meaning: the spoken receptive dimension
      // only. Nothing crosses modalities (phase 20).
      return [piece('spoken_receptive', answer.correct)];
    case 'matching':
      // A word's first-tried meaning: recognition, as today's card.
      return [piece('written_receptive', answer.correct)];
    case 'dictation':
      switch (answer.verdict) {
        case 'exact':
          return [piece('spoken_receptive', true), piece('spelling', true)];
        case 'near_miss':
          return [piece('spoken_receptive', true), piece('spelling', false)];
        case 'wrong':
          // A failure to recognise the word heard; nothing about spelling.
          return [piece('spoken_receptive', false)];
        default:
          // A dictation accepts no alternative (spec D7); unreachable.
          return [];
      }
    case 'letter_tiles':
      // The letters are given: production with support, capped like the
      // reversed card, and never spelling (spec D11).
      return answer.verdict === 'exact'
        ? [piece('written_receptive', true), piece('written_productive', true, CAPPED_MAX_LEVEL)]
        : [piece('written_productive', false, CAPPED_MAX_LEVEL)];
    case 'read_aloud':
      // Phase 25 (spec D10): saying a word that is shown is part of being
      // understood when speaking, and none of recall. Capped at 2, and nothing
      // downward: reading a word aloud shows nothing about understanding it.
      return answer.verdict === 'understood' ? [piece('spoken_productive', true, READ_ALOUD_MAX_LEVEL)] : [];
    case 'say_translation':
      switch (answer.verdict) {
        case 'understood':
          return [piece('spoken_receptive', true), piece('spoken_productive', true)];
        case 'gave_up':
          return [piece('spoken_productive', false)];
        case 'skipped':
        case 'alternative':
          return [];
        default:
          // Answered by typing, after "can't speak now" (spec D8).
          return typedEvidence(answer.verdict, piece);
      }
  }
}

/** The later of two ISO dates; null only when both are. */
function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Applies one session's evidence about one row. Returns `row` itself when
 * nothing changes, so a caller can tell a change by identity.
 *
 * - A wrong piece records the day. It never lowers the level.
 * - A step needs a right piece and no wrong one; no mistake earlier today; no
 *   step yet today; the gap for the current level since the later of the last
 *   step and the last mistake; and the new level within the cap.
 */
export function advance(row: ProgressRow, pieces: readonly Evidence[], day: string): ProgressRow {
  if (pieces.length === 0) return row;
  if (pieces.some((piece) => !piece.correct)) {
    return row.lastWrongOn === day ? row : { ...row, lastWrongOn: day };
  }
  if (row.lastWrongOn === day || row.lastStepOn === day) return row;
  if (row.level >= MAX_LEVEL) return row;
  // The day's cap is the highest of its pieces' caps; one uncapped piece lifts it.
  const cap = pieces.some((piece) => piece.cap === null)
    ? MAX_LEVEL
    : Math.max(...pieces.map((piece) => piece.cap!));
  if (row.level + 1 > cap) return row;
  const since = later(row.lastStepOn, row.lastWrongOn);
  if (since !== null && daysBetween(since, day) < GAP_DAYS[row.level - 1]) return row;
  return { ...row, level: row.level + 1, lastStepOn: day };
}

const keyOf = (senseId: string, dimension: Dimension) => `${senseId} ${dimension}`;

/**
 * One ended session over the progress rows of the senses it asked about.
 * `rows` holds rows for saved senses only, so an answer about an unsaved sense
 * finds none and counts for nothing.
 *
 * `changed` is what to write. `snapshot` is every row of every practised saved
 * sense, moved or not: a results badge averages over every live dimension,
 * including one this session did not exercise.
 */
export function evaluateSession(
  rows: readonly ProgressRow[],
  answers: readonly AnsweredQuestion[],
  day: string,
): { changed: ProgressRow[]; snapshot: SnapshotRow[] } {
  const pieces = new Map<string, Evidence[]>();
  for (const answer of answers) {
    for (const piece of evidenceFor(answer)) {
      const key = keyOf(answer.senseId, piece.dimension);
      pieces.set(key, [...(pieces.get(key) ?? []), piece]);
    }
  }
  const practised = new Set(answers.map((answer) => answer.senseId));

  const changed: ProgressRow[] = [];
  const snapshot: SnapshotRow[] = [];
  for (const row of rows) {
    if (!practised.has(row.senseId)) continue;
    const next = advance(row, pieces.get(keyOf(row.senseId, row.dimension)) ?? [], day);
    if (next !== row) changed.push(next);
    snapshot.push({
      senseId: row.senseId,
      dimension: row.dimension,
      levelBefore: row.level,
      levelAfter: next.level,
    });
  }
  return { changed, snapshot };
}

/** A session's snapshot as the results show it: one change per sense, badges
 *  over the live dimensions, in the order the session first asked each. */
export function progressChanges(
  rows: readonly SnapshotRead[],
  live: readonly Dimension[],
): ProgressChange[] {
  const bySense = new Map<string, SnapshotRead[]>();
  for (const row of rows) bySense.set(row.senseId, [...(bySense.get(row.senseId) ?? []), row]);
  return [...bySense.values()]
    .map((senseRows) => {
      const shown = senseRows.filter((row) => live.includes(row.dimension));
      const first = senseRows[0];
      return {
        position: Math.min(...senseRows.map((row) => row.position)),
        change: {
          senseId: first.senseId,
          form: first.form,
          translation: first.translation,
          levelBefore: badge(shown.map((row) => row.levelBefore)),
          levelAfter: badge(shown.map((row) => row.levelAfter)),
          raised: DIMENSIONS.filter((dimension) =>
            shown.some((row) => row.dimension === dimension && row.levelAfter > row.levelBefore),
          ),
        },
      };
    })
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.change);
}
