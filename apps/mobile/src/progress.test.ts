import { describe, expect, it } from '@jest/globals';
import type { SenseProgress, SessionProgressItem } from '@lang-tutor/core/api';

import { dimensionRows, missedPair, pipsFor, practisedRows } from './progress';
import { strings } from './strings';

describe('pipsFor', () => {
  it('fills as many of the five pips as the level', () => {
    expect(pipsFor(1)).toEqual([true, false, false, false, false]);
    expect(pipsFor(3)).toEqual([true, true, true, false, false]);
    expect(pipsFor(5)).toEqual([true, true, true, true, true]);
  });
});

describe('practisedRows', () => {
  const item = (
    sense_id: string,
    level_before: number,
    level_after: number,
    raised: SessionProgressItem['raised'] = [],
  ): SessionProgressItem => ({
    sense_id,
    form: `form-${sense_id}`,
    translation: `tr-${sense_id}`,
    level_before,
    level_after,
    raised,
  });

  it('puts the words whose badge rose first, each group in session order', () => {
    const rows = practisedRows([item('a', 1, 1), item('b', 1, 2), item('c', 2, 2), item('d', 3, 4)]);
    expect(rows.map((row) => [row.sense_id, row.badgeRaised])).toEqual([
      ['b', true],
      ['d', true],
      ['a', false],
      ['c', false],
    ]);
  });

  // Phase 23 (spec D11): a dimension can rise without the badge.
  it('puts a word that only moved a dimension after the badge risers, before the rest', () => {
    const rows = practisedRows([
      item('a', 1, 1),
      item('b', 1, 2, ['written_receptive', 'written_productive']),
      item('c', 1, 1, ['written_productive']),
    ]);
    expect(rows.map((row) => [row.sense_id, row.badgeRaised, row.progressed])).toEqual([
      ['b', true, false],
      ['c', false, true],
      ['a', false, false],
    ]);
  });

  it('is empty for no progress', () => {
    expect(practisedRows([])).toEqual([]);
  });
});

// Phase 23. A missed row always reads word → meaning, whichever way round the
// card asked it.
describe('missedPair', () => {
  it('reads a missed choice as its prompt and right option', () => {
    expect(
      missedPair({
        question: { id: 'c', type: 'multiple_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 },
        correct_answer: 'בית',
      }),
    ).toEqual({ word: 'casa', meaning: 'בית' });
  });

  it('turns a reversed or typed card round', () => {
    expect(
      missedPair({
        question: { id: 't', type: 'typed_translation', vocab_term_id: 'l', question: 'חלון', part_of_speech: 'noun', answer: 'finestra', lemma: 'finestra', alternatives: [] },
        correct_answer: 'finestra',
      }),
    ).toEqual({ word: 'finestra', meaning: 'חלון' });
    expect(
      missedPair({
        question: { id: 'r', type: 'reverse_choice', vocab_term_id: 'l', question: 'בית', part_of_speech: 'noun', options: ['porta', 'casa'], correct_option: 1 },
        correct_answer: 'casa',
      }),
    ).toEqual({ word: 'casa', meaning: 'בית' });
  });
});

describe('dimensionsRaised', () => {
  it('names the dimensions that rose', () => {
    expect(strings.dimensionsRaised(['written_productive', 'spelling'])).toBe('התקדמות: כתיבה, איות');
  });
});

describe('dimensionRows', () => {
  const progress: SenseProgress = {
    level: 3,
    dimensions: { written_receptive: 3, written_productive: 1, spoken_receptive: 1, spoken_productive: 1, spelling: 1 },
  };

  it('lists the five dimensions in order, with no level for one that is not live', () => {
    expect(dimensionRows(progress, ['written_receptive'])).toEqual([
      { dimension: 'written_receptive', level: 3 },
      { dimension: 'written_productive', level: null },
      { dimension: 'spoken_receptive', level: null },
      { dimension: 'spoken_productive', level: null },
      { dimension: 'spelling', level: null },
    ]);
  });
});

describe('level names', () => {
  it('names the five levels, feminine to agree with מילה', () => {
    expect([1, 2, 3, 4, 5].map(strings.levelName)).toEqual(['חדשה', 'נחשפה', 'מוכרת', 'ידועה', 'בשליטה']);
  });

  it('names the filter that shows every level', () => {
    expect(strings.levelAll).toBe('הכל');
  });

  it('names each dimension', () => {
    expect(strings.dimensionName('written_receptive')).toBe('זיהוי בכתב');
    expect(strings.dimensionName('spelling')).toBe('איות');
  });
});
