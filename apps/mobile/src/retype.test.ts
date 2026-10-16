import { describe, expect, it } from '@jest/globals';
import type { Question, TypedTranslationQuestion } from '@lang-tutor/core/api';

import { opensRetype, retypeChecked, retypeRight, retypeTyping, startRetype } from './retype';

const CITY: TypedTranslationQuestion = {
  id: 't',
  type: 'typed_translation',
  vocab_term_id: 'l',
  question: 'עיר',
  part_of_speech: 'noun',
  answer: 'città',
  lemma: 'città',
  alternatives: ['metropoli'],
  context: null,
};
const TILES: Question = {
  id: 'lt',
  type: 'letter_tiles',
  vocab_term_id: 'l',
  question: 'עיר',
  part_of_speech: 'noun',
  answer: 'città',
  tiles: ['c', 'i', 't', 't', 'à', 'o', 'e'],
};

// Phase 55 (spec D7). After a wrong or nearly right first typed answer, the
// learner types the word again, locally, before the banner.
describe('the retype (phase 55 D7)', () => {
  it('opens on a wrong answer, a near miss and show the answer', () => {
    expect(opensRetype(CITY, { text: 'paese' })).toBe(true);
    expect(opensRetype(CITY, { text: 'citta' })).toBe(true);
    expect(opensRetype(CITY, { text: '' })).toBe(true);
  });

  it('does not open on the word, another accepted word, or another card', () => {
    expect(opensRetype(CITY, { text: 'Città' })).toBe(false);
    expect(opensRetype(CITY, { text: 'metropoli' })).toBe(false);
    expect(opensRetype(TILES, { text: '' })).toBe(false);
    expect(opensRetype(TILES, { text: 'cxxxx' })).toBe(false);
  });

  it('opens on its first attempt, the right answer showing', () => {
    expect(startRetype()).toEqual({ attempt: 1, showing: true, outcome: null });
  });

  it('hides the right answer once typing starts', () => {
    expect(retypeTyping(startRetype())).toEqual({ attempt: 1, showing: false, outcome: null });
    expect(retypeTyping({ attempt: 2, showing: true, outcome: null })).toEqual({ attempt: 2, showing: false, outcome: null });
  });

  it('is right only for the word as written, accents included', () => {
    expect(retypeChecked(retypeTyping(startRetype()), CITY, 'città')).toEqual({ attempt: 1, showing: false, outcome: 'right' });
    expect(retypeChecked(startRetype(), CITY, ' La città ')).toMatchObject({ outcome: 'right' });
    // A near miss, or another accepted word, is not the word.
    expect(retypeChecked(startRetype(), CITY, 'citta')).toEqual({ attempt: 2, showing: true, outcome: null });
    expect(retypeChecked(startRetype(), CITY, 'metropoli')).toEqual({ attempt: 2, showing: true, outcome: null });
  });

  it('is right on the second attempt', () => {
    const second = retypeTyping(retypeChecked(startRetype(), CITY, 'citta'));
    expect(retypeChecked(second, CITY, 'città')).toEqual({ attempt: 2, showing: false, outcome: 'right' });
  });

  it('fails after two wrong attempts, and stays ended', () => {
    const second = retypeChecked(startRetype(), CITY, 'paese');
    const failed = retypeChecked(second, CITY, 'citta');
    expect(failed).toEqual({ attempt: 2, showing: false, outcome: 'failed' });
    expect(retypeChecked(failed, CITY, 'città')).toEqual(failed);
    expect(retypeTyping(failed)).toEqual(failed);
  });
});

// Phase 56 (spec D7). The retype on dictation, typed cloze, say the translation
// typed and typed meaning; never on a sentence translation.
describe('the retype on more cards (phase 56 D7)', () => {
  const DICTATION: Question = { id: 'd', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' };
  const CLOZE: Question = {
    id: 'c',
    type: 'cloze_typed',
    vocab_term_id: 'l',
    sentence: 'Ieri parlavamo per ore.',
    gap: { start: 5, end: 14 },
    translation: 'אתמול דיברנו שעות.',
    meaning: 'לדבר',
    answer: 'parlavamo',
    alternatives: ['chiacchieravamo'],
    mark: null,
  };
  const SAY: Question = { id: 's', type: 'say_translation', vocab_term_id: 'l', question: 'מדבר', part_of_speech: 'verb', answer: 'parlo', lemma: 'parlare', alternatives: ['dico'], context: null };
  const MEANING: Question = { id: 'm', type: 'typed_meaning', vocab_term_id: 'l', question: 'buona giornata', part_of_speech: 'phrase', meaning: 'שיהיה לך יום נעים!', context: null };
  const TRANSLATE: Question = { id: 'st', type: 'sentence_translation', vocab_term_id: 'l', question: 'בואו נשלב כוחות.', meaning: 'לשלב', sentence: 'Uniamo le forze.', gap: { start: 0, end: 6 }, answer: 'Uniamo', mark: null };

  it('opens on a wrong text, a near miss or show the answer on a dictation, a cloze and a typed say the translation', () => {
    for (const [question, wrong] of [[DICTATION, 'casa'], [CLOZE, 'banana'], [SAY, 'casa']] as const) {
      expect([question.type, opensRetype(question, { text: wrong })]).toEqual([question.type, true]);
      expect([question.type, opensRetype(question, { text: '' })]).toEqual([question.type, true]);
      // Help does not change the text's own verdict.
      expect([question.type, opensRetype(question, { text: wrong, helped: true })]).toEqual([question.type, true]);
    }
    expect(opensRetype(CLOZE, { text: 'parlavano' })).toBe(true);
  });

  it('does not open on the word or another accepted word', () => {
    expect(opensRetype(DICTATION, { text: 'parlo' })).toBe(false);
    expect(opensRetype(CLOZE, { text: 'parlavamo' })).toBe(false);
    expect(opensRetype(CLOZE, { text: 'chiacchieravamo' })).toBe(false);
    expect(opensRetype(SAY, { text: 'parlare' })).toBe(false);
    expect(opensRetype(SAY, { text: 'dico' })).toBe(false);
  });

  it('opens on a typed meaning the judge called wrong, never on a translation', () => {
    expect(opensRetype(MEANING, { text: 'בוקר טוב', judged: 'wrong' })).toBe(true);
    expect(opensRetype(MEANING, { text: '', judged: 'wrong', helped: true })).toBe(true);
    expect(opensRetype(MEANING, { text: 'שיהיה לך יום נעים', judged: 'exact' })).toBe(false);
    expect(opensRetype(MEANING, { text: 'יום טוב', judged: 'alternative' })).toBe(false);
    expect(opensRetype(TRANSLATE, { text: 'Andiamo.', judged: 'wrong' })).toBe(false);
    expect(opensRetype(TRANSLATE, { text: '' })).toBe(false);
  });

  it('opens on no spoken answer, pass or choice', () => {
    expect(opensRetype(SAY, { heard: 'casa', verdict: 'understood' })).toBe(false);
    expect(opensRetype(SAY, { pass: 'show_answer' })).toBe(false);
    expect(opensRetype(CITY, { option_index: 0 })).toBe(false);
  });

  it('is right for the card’s own answer only', () => {
    expect(retypeRight(DICTATION, 'parlo')).toBe(true);
    expect(retypeRight(DICTATION, 'parla')).toBe(false);
    expect(retypeRight(CLOZE, ' Parlavamo ')).toBe(true);
    expect(retypeRight(CLOZE, 'chiacchieravamo')).toBe(false);
    expect(retypeRight(SAY, 'parlo')).toBe(true);
    expect(retypeRight(SAY, 'parlare')).toBe(true);
    expect(retypeRight(SAY, 'dico')).toBe(false);
  });

  it('is right for a Hebrew meaning with or without its marks', () => {
    expect(retypeRight(MEANING, 'שיהיה לך יום נעים!')).toBe(true);
    expect(retypeRight(MEANING, 'שיהיה לך יום נעים')).toBe(true);
    expect(retypeRight(MEANING, ' שיהיה  לך יום נעים ')).toBe(true);
    expect(retypeRight(MEANING, 'שיהיה לך יום טוב')).toBe(false);
  });

  it('checks a retype on any of them', () => {
    expect(retypeChecked(startRetype(), MEANING, 'שיהיה לך יום נעים')).toEqual({ attempt: 1, showing: false, outcome: 'right' });
    expect(retypeChecked(startRetype(), DICTATION, 'casa')).toEqual({ attempt: 2, showing: true, outcome: null });
  });
});
