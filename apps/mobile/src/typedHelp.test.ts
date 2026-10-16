import { describe, expect, it } from '@jest/globals';

import type { Question } from '@lang-tutor/core/api';

import { allRevealed, helpText, revealed } from './typedHelp';

// Phase 55 (spec D7). The typed card's help: one more character a press.
describe('typed help (phase 55 D7)', () => {
  it('reveals one letter a press, from the start', () => {
    expect(revealed('colazione', 0)).toBe('');
    expect(revealed('colazione', 1)).toBe('c');
    expect(revealed('colazione', 3)).toBe('col');
  });

  it('takes a space with the letter after it', () => {
    expect(revealed('fare colazione', 4)).toBe('fare');
    expect(revealed('fare colazione', 5)).toBe('fare c');
  });

  it('takes an apostrophe with the letter after it', () => {
    expect(revealed("l'acqua", 1)).toBe('l');
    expect(revealed("l'acqua", 2)).toBe("l'a");
    expect(revealed('l’acqua', 2)).toBe('l’a');
  });

  it('ends a form that ends in an apostrophe on its last press', () => {
    expect(revealed("un po'", 3)).toBe("un p");
    expect(revealed("un po'", 4)).toBe("un po'");
    expect(allRevealed("un po'", 4)).toBe(true);
  });

  it('keeps an accent with its letter', () => {
    expect(revealed('città', 5)).toBe('città');
    expect(revealed('città', 5)).toBe('città');
    expect(allRevealed('città', 5)).toBe(true);
  });

  it('is all revealed once every letter is', () => {
    expect(allRevealed('casa', 3)).toBe(false);
    expect(allRevealed('casa', 4)).toBe(true);
    expect(allRevealed('fare colazione', 12)).toBe(false);
    expect(allRevealed('fare colazione', 13)).toBe(true);
    expect(revealed('casa', 9)).toBe('casa');
  });
});

// Phase 56 (spec D1). Help on five more cards: a Hebrew meaning, a heard form, a
// gap's word, a practised word; punctuation comes with the letter after it.
describe('help on more cards (phase 56 D1)', () => {
  it('reveals a Hebrew meaning from its start, a trailing mark with the last letter', () => {
    const meaning = 'שיהיה לך יום נעים!';
    expect(revealed(meaning, 5)).toBe('שיהיה');
    expect(revealed(meaning, 6)).toBe('שיהיה ל');
    expect(allRevealed(meaning, 13)).toBe(false);
    expect(revealed(meaning, 14)).toBe(meaning);
    expect(allRevealed(meaning, 14)).toBe(true);
  });

  it('takes a comma, a question mark or a hyphen with the letter after it', () => {
    expect(revealed('sì, grazie', 2)).toBe('sì');
    expect(revealed('sì, grazie', 3)).toBe('sì, g');
    expect(revealed('מה שלומך?', 6)).toBe('מה שלומ');
    expect(revealed('מה שלומך?', 7)).toBe('מה שלומך?');
    expect(revealed('tira-molla', 5)).toBe('tira-m');
  });

  it('reveals what each card asks for', () => {
    const cards: [Question, string | null][] = [
      [{ id: 't', type: 'typed_translation', vocab_term_id: 'l', question: 'בית', part_of_speech: 'noun', answer: 'casa', lemma: 'casa', alternatives: [], context: null }, 'casa'],
      [{ id: 's', type: 'say_translation', vocab_term_id: 'l', question: 'מדבר', part_of_speech: 'verb', answer: 'parlo', lemma: 'parlare', alternatives: [], context: null }, 'parlo'],
      [{ id: 'm', type: 'typed_meaning', vocab_term_id: 'l', question: 'parlare', part_of_speech: 'verb', meaning: 'לדבר', context: null }, 'לדבר'],
      [{ id: 'd', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' }, 'parlo'],
      [{ id: 'c', type: 'cloze_typed', vocab_term_id: 'l', sentence: 'Ieri parlavamo.', gap: { start: 5, end: 14 }, translation: 'אתמול דיברנו.', meaning: 'לדבר', answer: 'parlavamo', alternatives: [], mark: null }, 'parlavamo'],
      [{ id: 'st', type: 'sentence_translation', vocab_term_id: 'l', question: 'בואו נשלב כוחות.', meaning: 'לשלב', sentence: 'Uniamo le forze.', gap: { start: 0, end: 6 }, answer: 'Uniamo', mark: null }, 'Uniamo'],
      [{ id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' }, null],
      [{ id: 'q', type: 'multiple_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת'], correct_option: 0, context: null }, null],
    ];
    for (const [question, text] of cards) expect([question.type, helpText(question)]).toEqual([question.type, text]);
  });
});
