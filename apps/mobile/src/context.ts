import type { Context, Mark, Question } from '@lang-tutor/core/api';

import { splitAtGap } from '@/sentence';

/** Phase 34 (spec D6, D8). A sentence cut around its marked word, or null to
 *  show it unmarked: the server found no word (a Hebrew verb inflects), or a
 *  mark does not fit the sentence, which is never cut at a wrong place. */
export function markedParts(text: string, mark: Mark | null): { before: string; word: string; after: string } | null {
  if (mark === null || mark.start < 0 || mark.start >= mark.end || mark.end > text.length) return null;
  return splitAtGap(text, mark);
}

// Spec D6's table: the cards whose prompt is Hebrew take a Hebrew sentence.
const HEBREW_CONTEXT: ReadonlySet<Question['type']> = new Set(['typed_translation', 'say_translation', 'reverse_choice']);

/** Phase 34 (spec D6). The language a card's context sentence is written in:
 *  Hebrew under a Hebrew prompt (typed translation, say the translation,
 *  reverse choice), the target language under a target word (typed meaning,
 *  multiple choice). */
export function contextLanguage(type: Question['type'], target: string): string {
  return HEBREW_CONTEXT.has(type) ? 'he' : target;
}

/** Phase 62 (spec D5). A context line's whole translation, shown once the card is
 *  answered: with its word map or, for a saved example or a card stored before,
 *  without one. Null before the answer, or when the line came with none. */
export function wholeSentenceOf(context: Context, answered: boolean): string | null {
  return answered ? (context.translation ?? null) : null;
}
