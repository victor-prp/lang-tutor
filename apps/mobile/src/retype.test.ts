import { describe, expect, it } from '@jest/globals';
import type { Question, TypedTranslationQuestion } from '@lang-tutor/core/api';

import { opensRetype, retypeChecked, retypeTyping, startRetype } from './retype';

const CITY: TypedTranslationQuestion = {
  id: 't',
  type: 'typed_translation',
  vocab_term_id: 'l',
  question: 'עיר',
  part_of_speech: 'noun',
  answer: 'città',
  lemma: 'città',
  alternatives: ['metropoli'],
  context: null,
};
const TILES: Question = {
  id: 'lt',
  type: 'letter_tiles',
  vocab_term_id: 'l',
  question: 'עיר',
  part_of_speech: 'noun',
  answer: 'città',
  tiles: ['c', 'i', 't', 't', 'à', 'o', 'e'],
};

// Phase 55 (spec D7). After a wrong or nearly right first typed answer, the
// learner types the word again, locally, before the banner.
describe('the retype (phase 55 D7)', () => {
  it('opens on a wrong answer, a near miss and show the answer', () => {
    expect(opensRetype(CITY, 'paese')).toBe(true);
    expect(opensRetype(CITY, 'citta')).toBe(true);
    expect(opensRetype(CITY, '')).toBe(true);
  });

  it('does not open on the word, another accepted word, or another card', () => {
    expect(opensRetype(CITY, 'Città')).toBe(false);
    expect(opensRetype(CITY, 'metropoli')).toBe(false);
    expect(opensRetype(TILES, '')).toBe(false);
    expect(opensRetype(TILES, 'cxxxx')).toBe(false);
  });

  it('opens on its first attempt, the right answer showing', () => {
    expect(startRetype()).toEqual({ attempt: 1, showing: true, outcome: null });
  });

  it('hides the right answer once typing starts', () => {
    expect(retypeTyping(startRetype())).toEqual({ attempt: 1, showing: false, outcome: null });
    expect(retypeTyping({ attempt: 2, showing: true, outcome: null })).toEqual({ attempt: 2, showing: false, outcome: null });
  });

  it('is right only for the word as written, accents included', () => {
    expect(retypeChecked(retypeTyping(startRetype()), CITY, 'città')).toEqual({ attempt: 1, showing: false, outcome: 'right' });
    expect(retypeChecked(startRetype(), CITY, ' La città ')).toMatchObject({ outcome: 'right' });
    // A near miss, or another accepted word, is not the word.
    expect(retypeChecked(startRetype(), CITY, 'citta')).toEqual({ attempt: 2, showing: true, outcome: null });
    expect(retypeChecked(startRetype(), CITY, 'metropoli')).toEqual({ attempt: 2, showing: true, outcome: null });
  });

  it('is right on the second attempt', () => {
    const second = retypeTyping(retypeChecked(startRetype(), CITY, 'citta'));
    expect(retypeChecked(second, CITY, 'città')).toEqual({ attempt: 2, showing: false, outcome: 'right' });
  });

  it('fails after two wrong attempts, and stays ended', () => {
    const second = retypeChecked(startRetype(), CITY, 'paese');
    const failed = retypeChecked(second, CITY, 'citta');
    expect(failed).toEqual({ attempt: 2, showing: false, outcome: 'failed' });
    expect(retypeChecked(failed, CITY, 'città')).toEqual(failed);
    expect(retypeTyping(failed)).toEqual(failed);
  });
});
