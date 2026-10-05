import { describe, expect, it } from '@jest/globals';
import type { SenseProgress, SessionProgressItem } from '@lang-tutor/core/api';

import { dimensionRows, nextLevelFilter, pipsFor, practisedRows } from './progress';
import { strings } from './strings';

describe('pipsFor', () => {
  it('fills as many of the five pips as the level', () => {
    expect(pipsFor(1)).toEqual([true, false, false, false, false]);
    expect(pipsFor(3)).toEqual([true, true, true, false, false]);
    expect(pipsFor(5)).toEqual([true, true, true, true, true]);
  });
});

describe('practisedRows', () => {
  const item = (sense_id: string, level_before: number, level_after: number): SessionProgressItem => ({
    sense_id,
    form: `form-${sense_id}`,
    translation: `tr-${sense_id}`,
    level_before,
    level_after,
  });

  it('puts the words that moved up first, each group in session order', () => {
    const rows = practisedRows([item('a', 1, 1), item('b', 1, 2), item('c', 2, 2), item('d', 3, 4)]);
    expect(rows.map((row) => [row.sense_id, row.raised])).toEqual([
      ['b', true],
      ['d', true],
      ['a', false],
      ['c', false],
    ]);
  });

  it('is empty for no progress', () => {
    expect(practisedRows([])).toEqual([]);
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

describe('nextLevelFilter', () => {
  it('selects a level, and clears it when tapped again', () => {
    expect(nextLevelFilter(null, 2)).toBe(2);
    expect(nextLevelFilter(2, 4)).toBe(4);
    expect(nextLevelFilter(4, 4)).toBeNull();
  });
});

describe('level names', () => {
  it('names the five levels, feminine to agree with מילה', () => {
    expect([1, 2, 3, 4, 5].map(strings.levelName)).toEqual(['חדשה', 'נחשפה', 'מוכרת', 'ידועה', 'בשליטה']);
  });

  it('names each dimension', () => {
    expect(strings.dimensionName('written_receptive')).toBe('זיהוי בכתב');
    expect(strings.dimensionName('spelling')).toBe('איות');
  });
});
