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

describe('matching a printed word to a gloss card (phase 31)', () => {
  it('finds the card by one of its other words, with no model call', () => {
    expect(firstChoice('רכב', [{ translation: 'שולחן' }, { translation: 'מכונית', alternatives: ['רכב', 'אוטו'] }])).toEqual({
      index: 1,
      mismatch: false,
      matchedBy: 'exact',
    });
  });

  it('folds points, a maqaf and a note in brackets the way glosses do', () => {
    expect(firstChoice('בֵּית־סֵפֶר (מוסד)', [{ translation: 'בית ספר' }])).toMatchObject({ index: 0, matchedBy: 'exact' });
  });

  // normaliseGloss keeps a sentence mark at the end of a word, which the session's
  // `comparable` drops. A word list prints "מכונית." as readily as "מכונית", and the
  // mark must not turn a free match into a model call.
  it.each([
    ['a full stop', 'מכונית.'],
    ['an ellipsis', 'מכונית…'],
    ['a question mark', 'מכונית?'],
    ['an exclamation mark', 'מכונית!'],
    ['a colon', 'מכונית:'],
    ['an Arabic question mark', 'מכונית؟'],
    ['an Arabic semicolon', 'מכונית؛'],
    ['an Arabic comma', 'מכונית،'],
    ['a mark after a space', 'מכונית .'],
    ['a mark after a note in brackets', 'מכונית (רכב).'],
  ])('ignores %s ending the printed meaning, with no model call', (_, printed) => {
    expect(firstChoice(printed, [{ translation: 'שולחן' }, { translation: 'מכונית' }])).toEqual({
      index: 1,
      mismatch: false,
      matchedBy: 'exact',
    });
  });

  it("ignores a mark ending one of the card's own words too", () => {
    expect(firstChoice('מכונית', [{ translation: 'שולחן' }, { translation: 'מכונית.' }])).toMatchObject({ index: 1, matchedBy: 'exact' });
    expect(firstChoice('אוטו', [{ translation: 'מכונית', alternatives: ['רכב', 'אוטו!'] }])).toMatchObject({ index: 0, matchedBy: 'exact' });
  });

  // A typed form's card says its own rendering, and carries the gloss's key when
  // that differs: מכוניות on the card, מכונית its key. A list printing the
  // citation form names the card as surely as one printing the rendering.
  it('finds the card by its key when the key is not its translation, with no model call', () => {
    expect(firstChoice('מכונית', [{ translation: 'שולחן' }, { translation: 'מכוניות', key: 'מכונית' }])).toEqual({
      index: 1,
      mismatch: false,
      matchedBy: 'exact',
    });
  });

  it("folds a card key like the card's other words", () => {
    expect(firstChoice('מכונית', [{ translation: 'מכוניות', key: 'מכונית.' }])).toMatchObject({ index: 0, matchedBy: 'exact' });
  });

  // A card's own words, its translation and its key, name it before its other
  // words do: an earlier card that merely lists the printed word never beats a
  // later card that is it.
  it('prefers a card whose translation is the printed word to an earlier card that only lists it among its other words', () => {
    expect(firstChoice('רכב', [{ translation: 'מכונית', alternatives: ['רכב', 'אוטו'] }, { translation: 'רכב' }])).toEqual({
      index: 1,
      mismatch: false,
      matchedBy: 'exact',
    });
  });

  it('prefers a card whose key is the printed word to an earlier card that only lists it among its other words', () => {
    expect(
      firstChoice('מכונית', [{ translation: 'רכב', alternatives: ['מכונית'] }, { translation: 'מכוניות', key: 'מכונית' }]),
    ).toMatchObject({ index: 1, matchedBy: 'exact' });
  });

  it('keeps the lookup order between cards that the printed word names alike', () => {
    // Both list it among their other words.
    expect(
      firstChoice('רכב', [{ translation: 'שולחן', alternatives: ['רכב'] }, { translation: 'מכונית', alternatives: ['רכב'] }]),
    ).toMatchObject({ index: 0 });
    // A translation and a key rank together, so the earlier card wins either way round.
    expect(firstChoice('מכונית', [{ translation: 'מכוניות', key: 'מכונית' }, { translation: 'מכונית' }])).toMatchObject({ index: 0 });
    expect(firstChoice('מכונית', [{ translation: 'מכונית' }, { translation: 'מכוניות', key: 'מכונית' }])).toMatchObject({ index: 0 });
  });

  it('splits a printed meaning into words, each folded with the gloss rule and freed of a mark at its end', () => {
    expect(glossesOf('מכונית. / רכב… ; בֵּית־סֵפֶר (מוסד)')).toEqual(['מכונית', 'רכב', 'בית ספר']);
  });

  it('asks the model when no word of any card is printed', () => {
    expect(firstChoice('כלי תחבורה', [{ translation: 'שולחן' }, { translation: 'מכונית', alternatives: ['רכב', 'אוטו'] }])).toBe('ask_model');
  });

  it("lists a card's other words in the prompt when it has any", () => {
    const prompt = buildSenseMatchPrompt({
      word: 'car',
      target: 'en',
      hebrew: 'כלי תחבורה',
      options: [
        { translation: 'מכונית', alternatives: ['רכב', 'אוטו'], part_of_speech: 'noun' },
        { translation: 'קרון', alternatives: [] },
      ],
    });
    expect(prompt.system).toContain(SENSE_MATCH_MARKER);
    expect(JSON.parse(prompt.user).senses).toEqual([
      { number: 1, hebrew: 'מכונית', also: ['רכב', 'אוטו'], part_of_speech: 'noun' },
      { number: 2, hebrew: 'קרון' },
    ]);
  });
});
