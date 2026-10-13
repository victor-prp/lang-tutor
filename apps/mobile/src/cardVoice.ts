import type { Question } from '@lang-tutor/core/api';
import { rightAnswer } from '@lang-tutor/core/domain';

/**
 * Phase 44 (spec D1). What a session card says by itself, in the language being
 * learned: on arrival, unless hearing it would give the answer away, or else
 * once its answer is checked. Never both (R7). The board says nothing by
 * itself: its words speak when tapped (D5).
 */
export type CardVoice = { arrival: string | null; after: string | null };

const SILENT: CardVoice = { arrival: null, after: null };

export function cardVoice(question: Question, { speaking }: { speaking: boolean }): CardVoice {
  switch (question.type) {
    case 'multiple_choice':
    case 'new_meaning':
    case 'typed_meaning':
    case 'listen_choice':
    case 'dictation':
      return { arrival: question.question, after: null };
    case 'read_aloud':
      // R1: the word is on screen, so hearing it is a model, not the answer.
      // With speaking off the card is passed unseen.
      return speaking ? { arrival: question.question, after: null } : SILENT;
    case 'reverse_choice':
      return { arrival: null, after: rightAnswer(question) };
    case 'typed_translation':
    case 'letter_tiles':
    case 'say_translation':
      return { arrival: null, after: question.answer };
    case 'cloze_choice':
    case 'cloze_typed':
    case 'sentence_translation':
      // R4: the whole sentence, once the gap is answered.
      return { arrival: null, after: question.sentence };
    case 'matching':
      return SILENT;
    default: {
      const unhandled: never = question;
      throw new Error(`unhandled question type: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** What the session screen has already said for the card in front of it. */
export type CueState = { id: string | null; arrived: boolean; answered: boolean };
export const NO_CUE: CueState = { id: null, arrived: false, answered: false };

export type CueInput = {
  id: string;
  voice: CardVoice;
  /** Whether the device has a voice for the language being learned. */
  voiced: boolean;
  /** Whether the answer banner shows: not on a second-try hold, not on a skip. */
  banner: boolean;
};

export type Cue = { kind: 'say'; text: string } | { kind: 'stop' } | null;

/**
 * Phase 44 (spec D2). One step per render of the session screen. The arrival
 * cue plays once per card, as soon as there is a voice and while the card is
 * unanswered; the after cue plays once, when the banner first shows (R5, R6).
 * A new card with nothing to say stops what is still playing (R8). The same
 * input twice gives nothing the second time, so React's development double-run
 * of effects is harmless.
 */
export function nextCue(state: CueState, input: CueInput): { state: CueState; cue: Cue } {
  const fresh = state.id !== input.id;
  const current: CueState = fresh ? { id: input.id, arrived: false, answered: false } : state;

  if (input.banner) {
    if (current.answered) return { state: current, cue: fresh ? { kind: 'stop' } : null };
    const next = { ...current, answered: true };
    const after = !current.arrived && input.voiced ? input.voice.after : null;
    if (after !== null) return { state: next, cue: { kind: 'say', text: after } };
    return { state: next, cue: fresh ? { kind: 'stop' } : null };
  }

  if (!current.arrived && !current.answered && input.voiced && input.voice.arrival !== null) {
    return { state: { ...current, arrived: true }, cue: { kind: 'say', text: input.voice.arrival } };
  }
  return { state: current, cue: fresh ? { kind: 'stop' } : null };
}
