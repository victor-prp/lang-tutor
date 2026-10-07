import { describe, expect, it } from '@jest/globals';

import { validateSentenceItem, validateTranslateItem, wordCount } from './sentences';

const INPUT = { form: 'parlare', target: 'it' as const, explanation: 'he' as const, avoid: ['Mi piace parlare con te.'] };

describe('wordCount (spec D5)', () => {
  it('counts whitespace-separated tokens that hold a letter', () => {
    expect(wordCount('Ieri  parlavamo — per ore.')).toBe(4);
    expect(wordCount('')).toBe(0);
  });
});

describe('validateSentenceItem (spec D5)', () => {
  const good = { sentence: 'Ieri parlavamo per ore.', gap: 'parlavamo', translation: 'אתמול דיברנו שעות.', alternatives: ['chiacchieravamo', 'parlavamo', 'דיברנו'] };
  it('accepts a new sentence with its gap, and cleans the alternatives', () => {
    expect(validateSentenceItem(INPUT, good)).toEqual({
      ok: true,
      content: { sentence: 'Ieri parlavamo per ore.', translation: 'אתמול דיברנו שעות.', gap: { start: 5, end: 14 }, alternatives: ['chiacchieravamo'] },
    });
  });
  it.each([
    ['a sentence it was told to avoid', { ...good, sentence: 'Mi piace parlare con te.', gap: 'parlare' }],
    ['a gap that is not in the sentence', { ...good, gap: 'parlato' }],
    ['a compound tense for a one-word form', { ...good, sentence: 'Ieri abbiamo parlato per ore.', gap: 'abbiamo parlato' }],
    ['a gap that occurs twice', { ...good, sentence: 'Parlavamo e parlavamo.', gap: 'parlavamo' }],
    ['too few words', { ...good, sentence: 'Parlavamo ieri.' }],
    ['too many words', { ...good, sentence: 'Ieri sera noi parlavamo per ore e ore con gli amici del mare al bar.' }],
    ['Hebrew in the sentence', { ...good, sentence: 'Ieri parlavamo שעות.' }],
    ['a translation with no Hebrew', { ...good, translation: 'Yesterday we talked.' }],
    ['a translation that shows the gap word', { ...good, translation: 'אתמול parlavamo שעות.' }],
    ['an English translation for a Hebrew source', { ...good, translation: 'Yesterday we talked for hours.' }],
    ['nothing written', {}],
  ])('degrades %s', (_, found) => {
    expect(validateSentenceItem(INPUT, found).ok).toBe(false);
  });
});

describe('validateTranslateItem (spec D6)', () => {
  const input = { form: 'prenotare', target: 'it' as const, explanation: 'he' as const, avoid: ['אני רוצה להזמין שולחן'] };
  const good = { sentence: 'הזמנו חדר במלון', translation: 'Abbiamo prenotato una camera in albergo.', gap: 'prenotato' };
  it('accepts a Hebrew sentence and a reference that holds the word once', () => {
    expect(validateTranslateItem(input, good)).toEqual({
      ok: true,
      content: { hebrew: 'הזמנו חדר במלון', reference: 'Abbiamo prenotato una camera in albergo.', gap: { start: 8, end: 17 } },
    });
  });
  it.each([
    ['a Hebrew sentence it was told to avoid', { ...good, sentence: 'אני רוצה להזמין שולחן.' }],
    ['Latin letters in the Hebrew sentence', { ...good, sentence: 'הזמנו hotel במלון' }],
    ['too many Hebrew words', { ...good, sentence: 'אתמול בערב הזמנו חדר גדול ויפה מאוד במלון החדש שבמרכז העיר' }],
    ['a gap missing from the reference', { ...good, gap: 'prenotare' }],
    ['Hebrew in the reference', { ...good, translation: 'Abbiamo prenotato חדר.' }],
    ['a reference with no target letters', { ...good, translation: '12345', gap: '12345' }],
  ])('degrades %s', (_, found) => {
    expect(validateTranslateItem(input, found).ok).toBe(false);
  });
});

describe('an English-source enrollment (explanation language en)', () => {
  const EN = { form: 'говорить', target: 'ru' as const, explanation: 'en' as const, avoid: [] as string[] };
  it('accepts a gap sentence with an English translation', () => {
    const verdict = validateSentenceItem(EN, {
      sentence: 'Вчера мы говорили часами.', gap: 'говорили', translation: 'Yesterday we talked for hours.', alternatives: [],
    });
    expect(verdict.ok).toBe(true);
  });
  it('accepts a translation card with an English sentence', () => {
    const verdict = validateTranslateItem(EN, {
      sentence: 'We talked for hours yesterday', translation: 'Вчера мы говорили часами.', gap: 'говорили',
    });
    expect(verdict.ok).toBe(true);
  });
  it('degrades a Hebrew translation for an English source', () => {
    expect(validateSentenceItem(EN, {
      sentence: 'Вчера мы говорили часами.', gap: 'говорили', translation: 'אתמול דיברנו שעות.', alternatives: [],
    }).ok).toBe(false);
  });
});
