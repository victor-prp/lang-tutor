import { describe, expect, it } from '@jest/globals';

import { dimensionsTested, gradesFor } from './memoryGrades';

const WR = 'written_receptive';
const WP = 'written_productive';
const SP = 'spelling';
const SR = 'spoken_receptive';
const SK = 'spoken_productive';
const p = (dimension: string, grade: number) => ({ dimension, grade });

describe('gradesFor, one test per row of the table', () => {
  it('multiple choice', () => {
    expect(gradesFor({ type: 'multiple_choice', correct: true })).toEqual([p(WR, 3)]);
    expect(gradesFor({ type: 'multiple_choice', correct: false })).toEqual([p(WR, 1)]);
  });
  it('new meaning grades as multiple choice (phase 39 D6)', () => {
    for (const correct of [true, false]) {
      expect(gradesFor({ type: 'new_meaning', correct })).toEqual(gradesFor({ type: 'multiple_choice', correct }));
    }
    expect(dimensionsTested('new_meaning')).toEqual(dimensionsTested('multiple_choice'));
  });
  it('matching, first try', () => {
    expect(gradesFor({ type: 'matching', correct: true })).toEqual([p(WR, 2)]);
    expect(gradesFor({ type: 'matching', correct: false })).toEqual([p(WR, 1)]);
  });
  it('typed meaning', () => {
    expect(gradesFor({ type: 'typed_meaning', verdict: 'exact' })).toEqual([p(WR, 3)]);
    expect(gradesFor({ type: 'typed_meaning', verdict: 'near_miss' })).toEqual([p(WR, 3)]);
    expect(gradesFor({ type: 'typed_meaning', verdict: 'wrong' })).toEqual([p(WR, 1)]);
    expect(gradesFor({ type: 'typed_meaning', verdict: 'gave_up' })).toEqual([p(WR, 1)]);
    expect(gradesFor({ type: 'typed_meaning', verdict: 'alternative' })).toEqual([]);
    expect(gradesFor({ type: 'typed_meaning', verdict: 'skipped' })).toEqual([]);
  });
  it('listen and choose', () => {
    expect(gradesFor({ type: 'listen_choice', correct: true })).toEqual([p(SR, 3)]);
    expect(gradesFor({ type: 'listen_choice', correct: false })).toEqual([p(SR, 1)]);
  });
  it('read aloud updates nothing', () => {
    for (const verdict of ['understood', 'gave_up', 'skipped', 'alternative'] as const) {
      expect(gradesFor({ type: 'read_aloud', verdict })).toEqual([]);
    }
  });
  it('reverse choice and cloze choice', () => {
    for (const type of ['reverse_choice', 'cloze_choice'] as const) {
      expect(gradesFor({ type, correct: true })).toEqual([p(WR, 3), p(WP, 2)]);
      expect(gradesFor({ type, correct: false })).toEqual([p(WP, 1)]);
    }
  });
  it('letter tiles', () => {
    expect(gradesFor({ type: 'letter_tiles', verdict: 'exact' })).toEqual([p(WR, 3), p(WP, 2)]);
    expect(gradesFor({ type: 'letter_tiles', verdict: 'near_miss' })).toEqual([p(WP, 1)]);
    expect(gradesFor({ type: 'letter_tiles', verdict: 'wrong' })).toEqual([p(WP, 1)]);
    expect(gradesFor({ type: 'letter_tiles', verdict: 'gave_up' })).toEqual([p(WP, 1)]);
    expect(gradesFor({ type: 'letter_tiles', verdict: 'alternative' })).toEqual([]);
    expect(gradesFor({ type: 'letter_tiles', verdict: 'skipped' })).toEqual([]);
  });
  it('typed translation, typed cloze, sentence translation', () => {
    for (const type of ['typed_translation', 'cloze_typed', 'sentence_translation'] as const) {
      expect(gradesFor({ type, verdict: 'exact' })).toEqual([p(WR, 3), p(WP, 3), p(SP, 3)]);
      expect(gradesFor({ type, verdict: 'near_miss' })).toEqual([p(WR, 3), p(WP, 3), p(SP, 1)]);
      expect(gradesFor({ type, verdict: 'wrong' })).toEqual([p(WP, 1)]);
      expect(gradesFor({ type, verdict: 'alternative' })).toEqual([]);
      expect(gradesFor({ type, verdict: 'gave_up' })).toEqual([p(WP, 1)]);
      expect(gradesFor({ type, verdict: 'skipped' })).toEqual([]);
    }
  });
  it('dictation', () => {
    expect(gradesFor({ type: 'dictation', verdict: 'exact' })).toEqual([p(SR, 3), p(SP, 3)]);
    expect(gradesFor({ type: 'dictation', verdict: 'near_miss' })).toEqual([p(SR, 3), p(SP, 1)]);
    expect(gradesFor({ type: 'dictation', verdict: 'wrong' })).toEqual([p(SR, 1)]);
    expect(gradesFor({ type: 'dictation', verdict: 'gave_up' })).toEqual([p(SR, 1)]);
    expect(gradesFor({ type: 'dictation', verdict: 'alternative' })).toEqual([]);
    expect(gradesFor({ type: 'dictation', verdict: 'skipped' })).toEqual([]);
  });
  it('say the translation, spoken', () => {
    expect(gradesFor({ type: 'say_translation', verdict: 'understood' })).toEqual([p(SR, 3), p(SK, 3)]);
    expect(gradesFor({ type: 'say_translation', verdict: 'gave_up' })).toEqual([p(SK, 1)]);
    expect(gradesFor({ type: 'say_translation', verdict: 'alternative' })).toEqual([]);
    expect(gradesFor({ type: 'say_translation', verdict: 'skipped' })).toEqual([]);
  });
  // Phase 54 (spec D6). A meet card is ungraded: nothing is retrieved, nothing recorded.
  it('the meet card, seen', () => {
    expect(gradesFor({ type: 'meet', verdict: 'seen' })).toEqual([]);
  });
  it('say the translation, typed fallback, grades as typed translation', () => {
    expect(gradesFor({ type: 'say_translation', verdict: 'exact' })).toEqual([p(WR, 3), p(WP, 3), p(SP, 3)]);
    expect(gradesFor({ type: 'say_translation', verdict: 'near_miss' })).toEqual([p(WR, 3), p(WP, 3), p(SP, 1)]);
    expect(gradesFor({ type: 'say_translation', verdict: 'wrong' })).toEqual([p(WP, 1)]);
  });
});

// Phase 55 (spec D2, as ruled). A ladder's intro stage is for encoding, not evidence: its
// cards grade nothing. A helped answer is stored `wrong` (spec D6), so `wrong` is it too.
describe('gradesFor, a ladder intro card (phase 55, spec D2, as ruled)', () => {
  it('grades an intro tiles or typed card nothing, right, wrong or helped', () => {
    for (const verdict of ['exact', 'near_miss', 'wrong', 'gave_up'] as const) {
      expect(gradesFor({ type: 'letter_tiles', verdict, intro: true })).toEqual([]);
      expect(gradesFor({ type: 'typed_translation', verdict, intro: true })).toEqual([]);
    }
  });
  it('grades an intro read aloud and meet card nothing, as before', () => {
    expect(gradesFor({ type: 'read_aloud', verdict: 'understood', intro: true })).toEqual([]);
    expect(gradesFor({ type: 'meet', verdict: 'seen', intro: true })).toEqual([]);
  });
  it('grades the same answers as before without the flag, or with it false', () => {
    expect(gradesFor({ type: 'letter_tiles', verdict: 'exact' })).toEqual([p(WR, 3), p(WP, 2)]);
    expect(gradesFor({ type: 'letter_tiles', verdict: 'exact', intro: false })).toEqual([p(WR, 3), p(WP, 2)]);
    expect(gradesFor({ type: 'letter_tiles', verdict: 'wrong', intro: false })).toEqual([p(WP, 1)]);
    expect(gradesFor({ type: 'typed_translation', verdict: 'wrong', intro: false })).toEqual([p(WP, 1)]);
    expect(gradesFor({ type: 'typed_translation', verdict: 'exact', intro: false })).toEqual([p(WR, 3), p(WP, 3), p(SP, 3)]);
  });
});

describe('dimensionsTested', () => {
  it('is the dimensions a success evidences', () => {
    expect(dimensionsTested('multiple_choice')).toEqual([WR]);
    expect(dimensionsTested('matching')).toEqual([WR]);
    expect(dimensionsTested('typed_meaning')).toEqual([WR]);
    expect(dimensionsTested('listen_choice')).toEqual([SR]);
    expect(dimensionsTested('reverse_choice')).toEqual([WR, WP]);
    expect(dimensionsTested('cloze_choice')).toEqual([WR, WP]);
    expect(dimensionsTested('letter_tiles')).toEqual([WR, WP]);
    expect(dimensionsTested('typed_translation')).toEqual([WR, WP, SP]);
    expect(dimensionsTested('dictation')).toEqual([SR, SP]);
    expect(dimensionsTested('say_translation')).toEqual([SR, SK]);
    expect(dimensionsTested('read_aloud')).toEqual([]);
    expect(dimensionsTested('meet')).toEqual([]);
  });
  it('matches the dimensions of a successful grade', () => {
    expect(gradesFor({ type: 'dictation', verdict: 'exact' }).map((g) => g.dimension)).toEqual(dimensionsTested('dictation'));
  });
});
