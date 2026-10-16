import type { AnswerVerdict } from '../api/types';
import type { Grade } from './memory';
import type { Dimension } from './progress';
import type { QuestionType } from './quiz';

/**
 * Phase 35 (spec D3). Card and verdict to a grade per dimension: the memory
 * model's counterpart of `evidenceFor`. Pure, so the bots read the same table.
 */
export type GradedPiece = { dimension: Dimension; grade: Grade };

/** A choice card carries `correct`; a text card, speaking included, its verdict.
 *  Phase 55 (spec D2, as ruled): `intro`, a card of a ladder's intro stage; absent
 *  is false. */
export type GradableAnswer = { type: QuestionType; correct?: boolean; verdict?: AnswerVerdict; intro?: boolean };

const AGAIN = 1;
const HARD = 2;
const GOOD = 3;

const piece = (dimension: Dimension, grade: Grade): GradedPiece => ({ dimension, grade });

/** A typed translation's grades, and the typed form of say the translation. */
function typedGrades(verdict: AnswerVerdict | undefined): GradedPiece[] {
  switch (verdict) {
    case 'exact':
      return [piece('written_receptive', GOOD), piece('written_productive', GOOD), piece('spelling', GOOD)];
    case 'near_miss':
      return [piece('written_receptive', GOOD), piece('written_productive', GOOD), piece('spelling', AGAIN)];
    case 'wrong':
    case 'gave_up':
      return [piece('written_productive', AGAIN)];
    default:
      // An alternative is another gloss's evidence; a skip is no answer.
      return [];
  }
}

export function gradesFor(answer: GradableAnswer): GradedPiece[] {
  // Phase 55 (spec D2, as ruled). A ladder's intro stage is for encoding, not evidence: its
  // write-it card and its read aloud grade nothing, as its meet card, so a new word's first
  // memory is its practice cards'.
  if (answer.intro) return [];
  switch (answer.type) {
    case 'multiple_choice':
    case 'new_meaning':
      // Phase 39 (spec D6): a new meaning is graded as a multiple choice.
      return [piece('written_receptive', answer.correct ? GOOD : AGAIN)];
    case 'matching':
      // First try only: elimination makes the last pair free, so a success is Hard.
      return [piece('written_receptive', answer.correct ? HARD : AGAIN)];
    case 'listen_choice':
      return [piece('spoken_receptive', answer.correct ? GOOD : AGAIN)];
    case 'reverse_choice':
    case 'cloze_choice':
      return answer.correct
        ? [piece('written_receptive', GOOD), piece('written_productive', HARD)]
        : [piece('written_productive', AGAIN)];
    case 'letter_tiles':
      if (answer.verdict === 'exact') return [piece('written_receptive', GOOD), piece('written_productive', HARD)];
      if (answer.verdict === 'near_miss' || answer.verdict === 'wrong' || answer.verdict === 'gave_up') {
        return [piece('written_productive', AGAIN)];
      }
      return [];
    case 'typed_translation':
    case 'cloze_typed':
    case 'sentence_translation':
      return typedGrades(answer.verdict);
    case 'typed_meaning':
      if (answer.verdict === 'exact' || answer.verdict === 'near_miss') return [piece('written_receptive', GOOD)];
      if (answer.verdict === 'wrong' || answer.verdict === 'gave_up') return [piece('written_receptive', AGAIN)];
      return [];
    case 'dictation':
      switch (answer.verdict) {
        case 'exact':
          return [piece('spoken_receptive', GOOD), piece('spelling', GOOD)];
        case 'near_miss':
          return [piece('spoken_receptive', GOOD), piece('spelling', AGAIN)];
        case 'wrong':
        case 'gave_up':
          return [piece('spoken_receptive', AGAIN)];
        default:
          return [];
      }
    case 'read_aloud':
      // The word is shown: nothing is retrieved.
      return [];
    case 'meet':
      // Phase 54 (spec D6). Ungraded: the word is shown and nothing is asked.
      return [];
    case 'say_translation':
      switch (answer.verdict) {
        case 'understood':
          return [piece('spoken_receptive', GOOD), piece('spoken_productive', GOOD)];
        case 'gave_up':
          return [piece('spoken_productive', AGAIN)];
        case 'skipped':
        case 'alternative':
          return [];
        default:
          // Answered by typing, after "can't speak now" (spec D8).
          return typedGrades(answer.verdict);
      }
  }
}

/** The dimensions a card evidences on a success. */
export function dimensionsTested(type: QuestionType): Dimension[] {
  switch (type) {
    case 'multiple_choice':
    case 'new_meaning':
    case 'matching':
    case 'typed_meaning':
      return ['written_receptive'];
    case 'listen_choice':
      return ['spoken_receptive'];
    case 'reverse_choice':
    case 'cloze_choice':
    case 'letter_tiles':
      return ['written_receptive', 'written_productive'];
    case 'typed_translation':
    case 'cloze_typed':
    case 'sentence_translation':
      return ['written_receptive', 'written_productive', 'spelling'];
    case 'dictation':
      return ['spoken_receptive', 'spelling'];
    case 'read_aloud':
    case 'meet':
      return [];
    case 'say_translation':
      return ['spoken_receptive', 'spoken_productive'];
  }
}
