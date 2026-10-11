import { describe, expect, it } from '@jest/globals';
import { LlmAcceptSchema } from '@lang-tutor/core/api/schemas';

import { ACCEPT_MARKER, MAX_ACCEPTED, buildAcceptPrompt, parseAccept, validateAccept } from './accept';

const HO = { form: 'ho', lemma: 'avere', target: 'it', explanation: 'he' } as const;

describe('validateAccept', () => {
  it('keeps the answers as given, trimmed, and an answer form that differs from the form', () => {
    expect(validateAccept(HO, { answers: [' io ho ', 'possiedo'], answer_form: null })).toEqual({
      answers: ['io ho', 'possiedo'],
      answerForm: null,
    });
    expect(
      validateAccept({ form: 'ora', lemma: 'ora', target: 'it', explanation: 'he' }, { answers: ['ore'], answer_form: ' ore ' }),
    ).toEqual({ answers: ['ore'], answerForm: 'ore' });
  });

  it('drops an empty answer, the form itself, and a repeat under comparable', () => {
    expect(validateAccept(HO, { answers: ['', '  ', 'Ho', 'io ho', 'Io  ho.', 'possiedo'], answer_form: null }).answers).toEqual([
      'io ho',
      'possiedo',
    ]);
  });

  it("reads a leading \"to\" or article as the typed judge does: the form, or a repeat", () => {
    const blowUp = { form: 'blow up', lemma: 'blow up', target: 'en', explanation: 'he' } as const;
    expect(
      validateAccept(blowUp, { answers: ['to blow up', 'to lose my temper', 'lose my temper', 'explode'], answer_form: 'to blow up' }),
    ).toEqual({ answers: ['to lose my temper', 'explode'], answerForm: null });
    const fratello = { form: 'fratello', lemma: 'fratello', target: 'it', explanation: 'he' } as const;
    expect(validateAccept(fratello, { answers: ['il fratello', 'il frate', 'frate'], answer_form: null }).answers).toEqual(['il frate']);
  });

  it('drops an answer in the explanation script, or in any script but the target one', () => {
    expect(validateAccept(HO, { answers: ['יש לי', 'io ho', 'у меня есть'], answer_form: null }).answers).toEqual(['io ho']);
    const hebrew = { form: 'ספר', lemma: 'ספר', target: 'he', explanation: 'en' } as const;
    expect(validateAccept(hebrew, { answers: ['book', 'כרך', 'ספרון'], answer_form: null }).answers).toEqual(['כרך', 'ספרון']);
  });

  it('drops every answer that keeps a placeholder instead of writing it out', () => {
    const blowUp = { form: 'blow up', lemma: 'blow up', target: 'en', explanation: 'he' } as const;
    expect(
      validateAccept(blowUp, {
        answers: ["lose one's temper", 'lose one’s temper', 'lose my temper', 'yell at someone', 'explode'],
        answer_form: null,
      }).answers,
    ).toEqual(['lose my temper', 'explode']);
    const italian = { form: 'arrabbiarsi', lemma: 'arrabbiarsi', target: 'it', explanation: 'he' } as const;
    expect(validateAccept(italian, { answers: ['urlare a qualcuno', 'infuriarsi'], answer_form: null }).answers).toEqual(['infuriarsi']);
    const russian = { form: 'злиться', lemma: 'злиться', target: 'ru', explanation: 'he' } as const;
    expect(validateAccept(russian, { answers: ['кричать на кого-то', 'обидеть кто-то', 'сердиться'], answer_form: null }).answers).toEqual([
      'сердиться',
    ]);
  });

  it(`keeps at most ${MAX_ACCEPTED}, in the order given`, () => {
    const many = Array.from({ length: 14 }, (_, i) => `parola${String.fromCharCode(97 + i)}`);
    const kept = validateAccept(HO, { answers: many, answer_form: null }).answers;
    expect(MAX_ACCEPTED).toBe(10);
    expect(kept).toEqual(many.slice(0, 10));
  });

  it('keeps an answer form that is the lemma rather than the form: אצבע asks for finger, not fingers', () => {
    const fingers = { form: 'fingers', lemma: 'finger', target: 'en', explanation: 'he' } as const;
    expect(validateAccept(fingers, { answers: [], answer_form: 'finger' }).answerForm).toBe('finger');
  });

  it('makes the answer form null when it is the form under comparable, empty, a placeholder or in another script', () => {
    const ora = { form: 'ora', lemma: 'ora', target: 'it', explanation: 'he' } as const;
    expect(validateAccept(ora, { answers: [], answer_form: 'Ora' }).answerForm).toBeNull();
    expect(validateAccept(ora, { answers: [], answer_form: '  ' }).answerForm).toBeNull();
    expect(validateAccept(ora, { answers: [], answer_form: 'שעות' }).answerForm).toBeNull();
    expect(validateAccept(ora, { answers: [], answer_form: 'qualcuno' }).answerForm).toBeNull();
    expect(validateAccept(ora, { answers: [], answer_form: null }).answerForm).toBeNull();
  });
});

describe('parseAccept', () => {
  it('reads the answers and the answer form, fenced or not', () => {
    expect(parseAccept('{"answers":["io ho"],"answer_form":null}')).toEqual({ answers: ['io ho'], answer_form: null });
    expect(parseAccept('```json\n{"answers":[],"answer_form":"ore"}\n```')).toEqual({ answers: [], answer_form: 'ore' });
  });

  it('reads an absent or empty answer form as null', () => {
    expect(parseAccept('{"answers":["allora"]}')).toEqual({ answers: ['allora'], answer_form: null });
    expect(parseAccept('{"answers":["allora"],"answer_form":" "}')).toEqual({ answers: ['allora'], answer_form: null });
  });

  it('is null for an answer that is not JSON or not this shape', () => {
    expect(parseAccept('not json')).toBeNull();
    expect(parseAccept('{"items":[]}')).toBeNull();
    expect(parseAccept('{"answers":"allora","answer_form":null}')).toBeNull();
    expect(parseAccept('["allora"]')).toBeNull();
    expect(parseAccept('null')).toBeNull();
  });
});

describe('buildAcceptPrompt', () => {
  const prompt = buildAcceptPrompt({
    form: 'poi',
    lemma: 'poi',
    partOfSpeech: 'adverb',
    rendering: 'אז',
    example: 'Prima mangiamo, poi usciamo.',
    exampleTranslation: 'קודם נאכל, אז נצא.',
    target: 'it',
    explanation: 'he',
  });

  it('carries the marker MockServer matches, the schema, and the rendering as the user part', () => {
    expect(prompt.system).toContain(ACCEPT_MARKER);
    expect(prompt.schema).toBe(LlmAcceptSchema);
    expect(prompt.user).toBe('אז');
  });

  it('names the headword, its form, its sense through the example, and both languages', () => {
    for (const text of ['"poi"', 'adverb', 'Italian', 'Hebrew', 'Prima mangiamo, poi usciamo.', 'קודם נאכל, אז נצא.']) {
      expect(prompt.system).toContain(text);
    }
  });

  it('asks for placeholders written out, the subject pronoun form, and the agreeing form', () => {
    expect(prompt.system).toMatch(/one's/);
    expect(prompt.system).toMatch(/pronoun/);
    expect(prompt.system).toMatch(/answer_form/);
  });

  it('says nothing of an example when there is none', () => {
    const bare = buildAcceptPrompt({
      form: 'poi', lemma: 'poi', partOfSpeech: 'adverb', rendering: 'אז', example: null, exampleTranslation: null, target: 'it', explanation: 'he',
    });
    expect(bare.system).not.toContain('example sentence');
  });
});
