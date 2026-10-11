import { describe, expect, it } from '@jest/globals';

import { usableAnswerForm } from './answerForm';

// Phase 34 (spec D2, ruling R6). The accept job stores the form of the headword
// that agrees with a rendering; a card uses it only when it is plausibly a form
// of the card's own word. Anything else falls back to the variant's form, which
// is exactly the card there is today.
describe('usableAnswerForm', () => {
  it('uses the plural of the lemma: ore for ora', () => {
    expect(usableAnswerForm('ore', 'ora', 'ora')).toBe('ore');
  });

  it('uses an inflection that shares a stem with the lemma: libri for libro', () => {
    expect(usableAnswerForm('libri', 'libro', 'libro')).toBe('libri');
  });

  it('uses an inflection that shares a stem with the variant’s form, not only the lemma', () => {
    expect(usableAnswerForm('parliamo', 'parlo', 'parlare')).toBe('parliamo');
  });

  it('strips one leading article, as the typed judge reads it: le ore is ore', () => {
    expect(usableAnswerForm('le ore', 'ora', 'ora')).toBe('ore');
    expect(usableAnswerForm('i libri', 'libro', 'libro')).toBe('libri');
  });

  it('strips an English infinitive’s "to" and keeps the case of what is left', () => {
    expect(usableAnswerForm('to blow up', 'blown up', 'blow up')).toBe('blow up');
    expect(usableAnswerForm('Le Ore', 'ora', 'ora')).toBe('Ore');
  });

  // normaliseTyped also trims a trailing sentence mark and a Cyrillic stress, so
  // what is left of the judge's reading is no suffix of the stored text.
  it('cuts the leading word from the start, whatever else the judge ignores in the rest', () => {
    expect(usableAnswerForm('to blow up!', 'blown up', 'blow up')).toBe('blow up');
    expect(usableAnswerForm('le ore.', 'ora', 'ora')).toBe('ore');
    expect(usableAnswerForm('the ча́сы', 'час', 'час')).toBe('ча́сы');
    expect(usableAnswerForm('Le ore …', 'ora', 'ora')).toBe('ore');
  });

  it('drops trailing marks from an answer form with no leading word, as the judge does', () => {
    expect(usableAnswerForm('ore.', 'ora', 'ora')).toBe('ore');
    expect(usableAnswerForm('ore!', 'ora', 'ora')).toBe('ore');
  });

  it('refuses a word that is not a form of the card’s word: tempo for ora', () => {
    expect(usableAnswerForm('tempo', 'ora', 'ora')).toBeNull();
  });

  it('refuses a form that shares no stem with the lemma, however right it is: ho for avere', () => {
    expect(usableAnswerForm('ho', 'abbiamo', 'avere')).toBeNull();
    expect(usableAnswerForm('abbiamo', 'ho', 'avere')).toBeNull();
  });

  it('reads a word of a longer answer form: ore di punta for ora', () => {
    expect(usableAnswerForm('ore di punta', 'ora', 'ora')).toBe('ore di punta');
  });

  it('wants three shared letters of a word of four or more, and two of a word of three', () => {
    expect(usableAnswerForm('tavolo', 'tavola', 'tavola')).toBe('tavolo');
    expect(usableAnswerForm('casi', 'caso', 'caso')).toBe('casi');
    expect(usableAnswerForm('cena', 'casa', 'casa')).toBeNull();
    expect(usableAnswerForm('ola', 'ora', 'ora')).toBeNull();
  });

  it('compares without regard to case', () => {
    expect(usableAnswerForm('ORE', 'Ora', 'ora')).toBe('ORE');
  });

  it('is null when nothing is stored, or when what is stored is the form itself', () => {
    expect(usableAnswerForm(null, 'ora', 'ora')).toBeNull();
    expect(usableAnswerForm('  ', 'ora', 'ora')).toBeNull();
    expect(usableAnswerForm('ora', 'ora', 'ora')).toBeNull();
    expect(usableAnswerForm('to blow up', 'blow up', 'blow up')).toBeNull();
    expect(usableAnswerForm('remember', 'to remember', 'remember')).toBeNull();
  });

  it('keeps an answer form equal to the lemma when the form is another: finger for fingers', () => {
    expect(usableAnswerForm('finger', 'fingers', 'finger')).toBe('finger');
  });

  it('works on Cyrillic', () => {
    expect(usableAnswerForm('часы', 'час', 'час')).toBe('часы');
    expect(usableAnswerForm('человек', 'люди', 'человек')).toBe('человек');
    expect(usableAnswerForm('люди', 'человек', 'человек')).toBeNull();
  });
});
