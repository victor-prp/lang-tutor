import { describe, expect, it } from '@jest/globals';
import { LlmSenseMatchSchema } from '@lang-tutor/core/api/schemas';

import {
  SENSE_MATCH_MARKER,
  buildSenseMatchPrompt,
  choiceFromModel,
  firstChoice,
  glossesOf,
  parseSenseMatch,
} from './senseMatching';

const options = [
  { translation: 'בנק', part_of_speech: 'noun' },
  { translation: 'גדה', part_of_speech: 'noun' },
];

describe('glossesOf', () => {
  it('splits at commas, slashes and semicolons, and folds niqqud and case', () => {
    expect(glossesOf('בַּנְק, גדה / שפה;  ')).toEqual(['בנק', 'גדה', 'שפה']);
  });
});

describe('firstChoice', () => {
  it('takes the first option when nothing is printed', () => {
    expect(firstChoice(null, options)).toEqual({ index: 0, mismatch: false, matchedBy: 'no_hebrew' });
  });

  it('takes the option whose translation equals one of the printed glosses, with no model call', () => {
    expect(firstChoice('שפת נהר, גדה', options)).toEqual({ index: 1, mismatch: false, matchedBy: 'exact' });
    expect(firstChoice('גָּדָה', options)).toEqual({ index: 1, mismatch: false, matchedBy: 'exact' });
  });

  it('prefers the earlier option when two match', () => {
    expect(firstChoice('בנק, גדה', options)).toEqual({ index: 0, mismatch: false, matchedBy: 'exact' });
  });

  it('asks the model when no gloss equals a translation', () => {
    expect(firstChoice('גדת נהר', options)).toBe('ask_model');
  });
});

describe('buildSenseMatchPrompt', () => {
  it('numbers the options from 1 and carries the marker', () => {
    const prompt = buildSenseMatchPrompt({ word: 'bank', target: 'en', hebrew: 'גדת נהר', options });
    expect(prompt.system).toContain(SENSE_MATCH_MARKER);
    expect(prompt.system).toContain('English');
    expect(JSON.parse(prompt.user)).toEqual({
      word: 'bank',
      printed_hebrew: 'גדת נהר',
      senses: [
        { number: 1, hebrew: 'בנק', part_of_speech: 'noun' },
        { number: 2, hebrew: 'גדה', part_of_speech: 'noun' },
      ],
    });
    expect(prompt.schema).toBe(LlmSenseMatchSchema);
  });
});

describe('parseSenseMatch', () => {
  it('turns a sense number into an index', () => {
    expect(parseSenseMatch('{"sense":2}', 2)).toBe(1);
  });

  it('reads 0, an out-of-range number and an empty answer as none', () => {
    expect(parseSenseMatch('{"sense":0}', 2)).toBe('none');
    expect(parseSenseMatch('{"sense":3}', 2)).toBe('none');
    expect(parseSenseMatch('{"sense":-1}', 2)).toBe('none');
    expect(parseSenseMatch('', 2)).toBe('none');
  });

  it('refuses an unreadable answer, so the job retries', () => {
    expect(parseSenseMatch('two', 2)).toBeNull();
    expect(parseSenseMatch('{"sense":"2"}', 2)).toBeNull();
  });
});

describe('choiceFromModel', () => {
  it('flags a mismatch and falls back to the first option on none', () => {
    expect(choiceFromModel('none')).toEqual({ index: 0, mismatch: true, matchedBy: 'none' });
    expect(choiceFromModel(1)).toEqual({ index: 1, mismatch: false, matchedBy: 'model' });
  });
});
