import { describe, expect, it } from '@jest/globals';

import { MAX_SPOKEN_WORDS, judgeSpoken, speakable, spokenWords } from './spoken';

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
