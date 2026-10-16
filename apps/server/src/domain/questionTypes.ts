import type { UnavailableReason } from '@lang-tutor/core/api';
import { speakable, type QuestionType } from '@lang-tutor/core/domain';

import { findGap } from './cloze';
import type { CardFate, CardUnit } from './keepCards';
import type { SessionPlan } from './plan';
import { askableRenderings, type Devices, type GlossRendering, type SavedGloss } from './session';
import { tileEligible } from './tiles';

/**
 * Phase 61 (spec D4). Every question type, in the order a question-types session
 * asks them: the meet card first, then each dimension's recognition type before
 * its recall type, and matching, which one word never has, last. The read and
 * the session both use it.
 */
export const QUESTION_TYPE_ORDER: readonly QuestionType[] = [
  'meet',
  'multiple_choice',
  'new_meaning',
  'typed_meaning',
  'reverse_choice',
  'cloze_choice',
  'letter_tiles',
  'typed_translation',
  'cloze_typed',
  'sentence_translation',
  'listen_choice',
  'dictation',
  'read_aloud',
  'say_translation',
  'matching',
];

/** What one rendering of a word allows, and how many other meanings of the word are saved. */
export type WordFlags = { tiles: boolean; speakable: boolean; clozeGap: boolean; otherMeanings: number };

export type QuestionTypeAvailability = { type: QuestionType; available: boolean; reason?: UnavailableReason };

const SPEAKING: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);
const SPOKEN_OR_SENTENCE: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation', 'cloze_typed', 'sentence_translation']);

/** Phase 61 (spec D2). The first reason, devices before the word; null when it can be asked. */
function reasonFor(type: QuestionType, word: WordFlags, devices: Devices): UnavailableReason | null {
  if ((type === 'listen_choice' || type === 'dictation') && !devices.listening) return 'no_voice';
  if (SPEAKING.has(type) && !devices.speaking) return 'no_microphone';
  if (SPOKEN_OR_SENTENCE.has(type) && !word.speakable) return 'too_long';
  if (type === 'letter_tiles' && !word.tiles) return 'no_tiles';
  if (type === 'cloze_choice' && !word.clozeGap) return 'no_example_gap';
  if (type === 'new_meaning' && word.otherMeanings === 0) return 'no_other_meaning';
  if (type === 'matching') return 'needs_more_words';
  return null;
}

/**
 * Phase 61 (spec D2). Which question types one word can be asked as, in
 * QUESTION_TYPE_ORDER. plan.ts's eligibility without its pacing rules: no read
 * aloud cap by level, speaking with one word, no MAX_PER_TYPE, and no multiple
 * choice forced on a new word.
 */
export function questionTypesFor(word: WordFlags, devices: Devices): QuestionTypeAvailability[] {
  return QUESTION_TYPE_ORDER.map((type) => {
    const reason = reasonFor(type, word, devices);
    return reason ? { type, available: false, reason } : { type, available: true };
  });
}

/** The per-rendering flags the plan reads, here so the picker and the question-types read agree. */
export function renderingFlags(row: {
  form: string;
  answerForm: string | null;
  lemma: string;
  example: string | null;
  exampleTranslation: string | null;
}): Pick<WordFlags, 'tiles' | 'speakable' | 'clozeGap'> {
  return {
    // Phase 34 (spec D2): tiles build the form the card asks for.
    tiles: tileEligible(row.answerForm ?? row.form),
    // read_aloud and the sentence cards use the saved form, say_translation the asked one.
    speakable: speakable(row.form) && speakable(row.answerForm ?? row.form),
    // Phase 27 (spec D7): a cloze choice needs the form, or its lemma, once in the saved example.
    clozeGap: row.exampleTranslation !== null && findGap(row.example ?? '', [row.form, row.lemma]) !== null,
  };
}

/** Phase 61 (spec D2, builder check). The one rendering a question-types read and its
 *  session use: the first askable rendering of the variant, by sense. */
export function fixedRendering(
  gloss: Omit<SavedGloss, 'savedAt'>,
  renderings: readonly GlossRendering[],
  variantId: string,
): GlossRendering | undefined {
  return askableRenderings(gloss, renderings).find((rendering) => rendering.variantId === variantId);
}

/** Phase 61 (spec D4). The one pick, once per type, in the order given; meet the only intro card. */
export function questionTypesPlan(types: readonly QuestionType[]): SessionPlan {
  return { order: types.map(() => 0), types: [...types], intro: types.map((type) => type === 'meet'), board: null };
}

/**
 * Phase 61 (spec D5). Which cards a question-types session keeps: every unit
 * nobody refused, and a choice card the checker refused (an ambiguous one, which
 * is what a tester is there to see), as generated. No floor, no fallback: every
 * other refused card is dropped and named.
 */
export function keepQuestionTypeCards(units: readonly CardUnit[], isChoice: (index: number) => boolean): CardFate[] {
  return units
    .flatMap((unit) =>
      unit.indexes.map((index): CardFate => {
        if (unit.refusal === null) return { index, fate: 'keep' };
        if (unit.refusal.stage === 'checker' && isChoice(index)) return { index, fate: 'keep_refused', shownAs: 'as_generated', refusal: unit.refusal };
        return { index, fate: 'drop', refusal: unit.refusal };
      }),
    )
    .sort((a, b) => a.index - b.index);
}
