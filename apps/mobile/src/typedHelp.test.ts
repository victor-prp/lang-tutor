import { describe, expect, it } from '@jest/globals';

import type { Question } from '@lang-tutor/core/api';

import { allRevealed, helpText, pressTyped, revealed, typedHelpDone, typedHint } from './typedHelp';

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

// Phase 63 (spec D3, the approved storyboard). On a typed card help reads the
// typing: it marks from the first wrong character, or gives the next step after
// a right start, shown in grey after the caret.
describe('help reads the typing (phase 63 D3)', () => {
  const A = 'colazione';

  it('gives the first letter when nothing is typed', () => {
    expect(pressTyped(A, '', 0, false)).toEqual({ given: 1, markFrom: null });
    expect(typedHint(A, '', 1, false)).toEqual({ ghost: 'c', more: true });
  });

  it('shows the given letters not yet typed, ahead of the typing', () => {
    expect(typedHint(A, 'c', 2, false)).toEqual({ ghost: 'o', more: true });
    expect(typedHint(A, 'co', 2, false)).toEqual({ ghost: '', more: true });
  });

  it('shows no grey once the typing leaves the answer', () => {
    expect(typedHint(A, 'ca', 2, false)).toBeNull();
  });

  it('marks from the first wrong letter and gives nothing', () => {
    expect(pressTyped(A, 'calazo', 0, false)).toEqual({ given: 0, markFrom: 1 });
    expect(pressTyped(A, 'calazo', 4, false)).toEqual({ given: 4, markFrom: 1 });
  });

  it('marks from a missing letter on', () => {
    expect(pressTyped(A, 'colazone', 2, false)).toEqual({ given: 2, markFrom: 5 });
  });

  it('marks a letter typed past the end', () => {
    expect(pressTyped(A, 'colazionee', 0, false)).toEqual({ given: 0, markFrom: 9 });
  });

  it('gives the step after the typing, whatever was given before', () => {
    expect(pressTyped(A, 'colazi', 2, false)).toEqual({ given: 7, markFrom: null });
    expect(typedHint(A, 'colazi', 7, false)).toEqual({ ghost: 'o', more: true });
    expect(pressTyped(A, 'c', 4, false)).toEqual({ given: 5, markFrom: null });
  });

  it('is done when the typing is right and nothing is left to give', () => {
    expect(typedHelpDone(A, 'colazione', 0, false)).toBe(true);
    expect(typedHelpDone(A, 'colaz', 9, false)).toBe(true);
    expect(typedHelpDone(A, 'colaz', 2, false)).toBe(false);
    expect(typedHelpDone(A, 'calazo', 9, false)).toBe(false);
    expect(typedHint(A, 'colaz', 9, false)).toEqual({ ghost: 'ione', more: false });
  });

  // Review focus 1: compared as the checker compares, an accent is spelling.
  it('takes a capital or a curly apostrophe as right, and an accent as wrong', () => {
    expect(pressTyped(A, 'Co', 0, false)).toEqual({ given: 3, markFrom: null });
    expect(pressTyped("l'acqua", 'l’a', 0, false)).toEqual({ given: 3, markFrom: null });
    expect(typedHint("l'acqua", 'l’a', 3, false)).toEqual({ ghost: 'c', more: true });
    expect(pressTyped('perché', 'perche', 0, false)).toEqual({ given: 0, markFrom: 5 });
  });

  // Review focus 2: a space or an apostrophe comes with the letter after it.
  it('gives a joined step, folds a double space and ignores a trailing one', () => {
    expect(pressTyped('fare colazione', 'fare', 0, false)).toEqual({ given: 5, markFrom: null });
    expect(typedHint('fare colazione', 'fare', 5, false)).toEqual({ ghost: ' c', more: true });
    expect(typedHint('fare colazione', 'fare ', 5, false)).toEqual({ ghost: 'c', more: true });
    expect(pressTyped('fare colazione', 'fare  c', 0, false)).toEqual({ given: 6, markFrom: null });
    expect(pressTyped(A, 'colazione ', 0, false)).toEqual({ given: 9, markFrom: null });
    expect(typedHelpDone(A, 'colazione ', 0, false)).toBe(true);
    expect(pressTyped("l'acqua", 'l', 0, false)).toEqual({ given: 2, markFrom: null });
    expect(typedHint("l'acqua", 'l', 2, false)).toEqual({ ghost: "'a", more: true });
  });

  // Review focus 3: a Hebrew meaning is compared as normaliseHebrew compares.
  it('takes points, a maqaf or a hyphen in Hebrew as right', () => {
    expect(typedHelpDone('ארוחה', 'אֲרוּחָה', 0, true)).toBe(true);
    expect(typedHelpDone('ארוחת־בוקר', 'ארוחת בוקר', 0, true)).toBe(true);
    expect(typedHelpDone('ארוחת בוקר', 'ארוחת-בוקר', 0, true)).toBe(true);
    expect(pressTyped('ארוחה', 'ארב', 0, true)).toEqual({ given: 0, markFrom: 2 });
    expect(typedHint('ארוחה', 'אר', 3, true)).toEqual({ ghost: 'ו', more: true });
  });
});
