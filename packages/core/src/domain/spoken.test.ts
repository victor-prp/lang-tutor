import { describe, expect, it } from '@jest/globals';

import { MAX_SOUND_PAIRS, MAX_SPOKEN_WORDS, judgeSpoken, soundPairs, speakable, spokenWords } from './spoken';

const read = (form: string) => ({ forms: [form], alternatives: [] });

describe('spokenWords', () => {
  it('normalises, folds diacritics, keeps the breve, and splits on anything but letters', () => {
    expect(spokenWords('  Perché, CITTÀ!  ')).toEqual(['perche', 'citta']);
    expect(spokenWords('Ёлка')).toEqual(['елка']);
    expect(spokenWords('мой')).toEqual(['мой']);
    expect(spokenWords('моло́ко')).toEqual(['молоко']);
  });

  it("drops an Italian elision from a word, so l'acqua is the word acqua", () => {
    expect(spokenWords("L’acqua")).toEqual(['acqua']);
    expect(spokenWords("dell'acqua")).toEqual(['acqua']);
  });

  it("keeps an English contraction whole: don't is not t", () => {
    expect(spokenWords("don't")).toEqual(["don't"]);
  });
});

describe('judgeSpoken (spec D6)', () => {
  it('understands the target alone, or among filler words and an article', () => {
    expect(judgeSpoken(read('gatto'), 'gatto')).toBe('understood');
    expect(judgeSpoken(read('gatto'), 'Um, gatto.')).toBe('understood');
    expect(judgeSpoken(read('gatto'), 'il gatto')).toBe('understood');
  });

  it('folds diacritics: the spelling of a transcript is the model’s, not the learner’s', () => {
    expect(judgeSpoken(read('perché'), 'perche')).toBe('understood');
    expect(judgeSpoken(read('ёлка'), 'елка')).toBe('understood');
  });

  it('keeps й apart from и', () => {
    expect(judgeSpoken(read('мой'), 'мои')).toBe('unheard');
  });

  it('matches a phrase as a run of words, in order and side by side', () => {
    expect(judgeSpoken(read('per favore'), 'per favore')).toBe('understood');
    expect(judgeSpoken(read('per favore'), 'sì, per favore')).toBe('understood');
    expect(judgeSpoken(read('per favore'), 'favore per')).toBe('unheard');
    expect(judgeSpoken(read('per favore'), 'per il favore')).toBe('unheard');
  });

  it('compares whole words, never parts of words', () => {
    expect(judgeSpoken(read('gatto'), 'gattone')).toBe('unheard');
  });

  it('treats one letter off as another word: the feedback the learner needs', () => {
    expect(judgeSpoken(read('gatto'), 'gato')).toBe('unheard');
  });

  it('finds a target saved with its article or "to" when only the word was said', () => {
    expect(judgeSpoken(read('il gatto'), 'gatto')).toBe('understood');
    expect(judgeSpoken(read('to go'), 'go')).toBe('understood');
  });

  it('is unheard on an empty transcript', () => {
    expect(judgeSpoken(read('gatto'), '')).toBe('unheard');
    expect(judgeSpoken(read('gatto'), '   ')).toBe('unheard');
  });

  it('reports an alternative only after the forms', () => {
    const target = { forms: ['big', 'big'], alternatives: ['large'] };
    expect(judgeSpoken(target, 'large')).toBe('alternative');
    expect(judgeSpoken(target, 'big')).toBe('understood');
  });
});

describe('speakable (spec D3)', () => {
  it('takes one to four words and nothing longer', () => {
    expect(MAX_SPOKEN_WORDS).toBe(4);
    expect(speakable('gatto')).toBe(true);
    expect(speakable('caffè con il cornetto')).toBe(true);
    expect(speakable('vorrei un caffè con cornetto')).toBe(false);
    expect(speakable('…')).toBe(false);
  });
});

describe('soundPairs (phase 50 D1)', () => {
  it('pairs a one-word transcript with the form', () => {
    expect(soundPairs(read('cell'), 'Sell.')).toEqual([{ heard: 'sell', form: 'cell' }]);
  });

  it('pairs every stretch of the heard words as long as the form, so a word said among others is found', () => {
    expect(soundPairs(read('cell'), 'I sell')).toEqual([
      { heard: 'i', form: 'cell' },
      { heard: 'sell', form: 'cell' },
    ]);
  });

  it('takes a form with and without its leading article, as the letter check does', () => {
    expect(soundPairs(read('il gatto'), 'un gato')).toEqual([
      { heard: 'un gato', form: 'il gatto' },
      { heard: 'un', form: 'gatto' },
      { heard: 'gato', form: 'gatto' },
    ]);
  });

  it('takes stretches of a phrase form its own length', () => {
    expect(soundPairs(read('thank you'), 'thank ewe')).toEqual([{ heard: 'thank ewe', form: 'thank you' }]);
  });

  it('asks each pair once, across forms that are the same word', () => {
    expect(soundPairs({ forms: ['cell', 'cell'], alternatives: [] }, 'sell')).toEqual([{ heard: 'sell', form: 'cell' }]);
  });

  it('never pairs the alternatives', () => {
    expect(soundPairs({ forms: ['big'], alternatives: ['large'] }, 'barge')).toEqual([{ heard: 'barge', form: 'big' }]);
  });

  it('keeps at most MAX_SOUND_PAIRS, the first form first', () => {
    const heard = 'one two three four five six seven eight nine ten';
    const pairs = soundPairs({ forms: ['cell', 'sale'], alternatives: [] }, heard);
    expect(MAX_SOUND_PAIRS).toBe(8);
    expect(pairs).toHaveLength(8);
    expect(pairs.every((pair) => pair.form === 'cell')).toBe(true);
  });

  it('has nothing to pair in an empty or letterless transcript', () => {
    expect(soundPairs(read('cell'), '')).toEqual([]);
    expect(soundPairs(read('cell'), '… ?')).toEqual([]);
  });

  it('skips a stretch that is the form itself', () => {
    expect(soundPairs(read('cell'), 'cell sell')).toEqual([{ heard: 'sell', form: 'cell' }]);
  });
});
