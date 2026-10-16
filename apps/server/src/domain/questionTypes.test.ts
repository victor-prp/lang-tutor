import { describe, expect, it } from '@jest/globals';

import type { CardUnit } from './keepCards';
import {
  QUESTION_TYPE_ORDER,
  fixedRendering,
  keepQuestionTypeCards,
  questionTypesFor,
  questionTypesPlan,
  renderingFlags,
  type WordFlags,
} from './questionTypes';

const EVERYTHING: WordFlags = { tiles: true, speakable: true, clozeGap: true, otherMeanings: 1 };
const BOTH = { listening: true, speaking: true };

const reasonOf = (word: WordFlags, devices = BOTH) =>
  Object.fromEntries(questionTypesFor(word, devices).map((entry) => [entry.type, entry.available ? 'ok' : entry.reason]));

describe('questionTypesFor', () => {
  it('lists every type once, in QUESTION_TYPE_ORDER', () => {
    expect(questionTypesFor(EVERYTHING, BOTH).map((entry) => entry.type)).toEqual([...QUESTION_TYPE_ORDER]);
    expect(new Set(QUESTION_TYPE_ORDER).size).toBe(15);
  });

  it('a word that has everything, on a device that has both, can have every type but matching', () => {
    const reasons = reasonOf(EVERYTHING);
    expect(reasons.matching).toBe('needs_more_words');
    expect(Object.entries(reasons).filter(([, reason]) => reason !== 'ok')).toEqual([['matching', 'needs_more_words']]);
  });

  it('a device with no voice for the target has no listening cards', () => {
    const reasons = reasonOf(EVERYTHING, { listening: false, speaking: true });
    expect(reasons.listen_choice).toBe('no_voice');
    expect(reasons.dictation).toBe('no_voice');
  });

  it('a device that cannot record has no speaking cards, before any reason of the word', () => {
    const reasons = reasonOf({ ...EVERYTHING, speakable: false }, { listening: true, speaking: false });
    expect(reasons.read_aloud).toBe('no_microphone');
    expect(reasons.say_translation).toBe('no_microphone');
    expect(reasons.cloze_typed).toBe('too_long');
  });

  it('a form too long to say has no spoken or sentence cards', () => {
    const reasons = reasonOf({ ...EVERYTHING, speakable: false });
    for (const type of ['read_aloud', 'say_translation', 'cloze_typed', 'sentence_translation']) expect(reasons[type]).toBe('too_long');
  });

  it('names the word reasons: no tiles, no example gap, no other meaning', () => {
    expect(reasonOf({ ...EVERYTHING, tiles: false }).letter_tiles).toBe('no_tiles');
    expect(reasonOf({ ...EVERYTHING, clozeGap: false }).cloze_choice).toBe('no_example_gap');
    expect(reasonOf({ ...EVERYTHING, otherMeanings: 0 }).new_meaning).toBe('no_other_meaning');
  });

  it('keeps no pacing rule: the plain types are always there', () => {
    const reasons = reasonOf({ tiles: false, speakable: false, clozeGap: false, otherMeanings: 0 }, { listening: false, speaking: false });
    for (const type of ['meet', 'multiple_choice', 'reverse_choice', 'typed_translation', 'typed_meaning']) expect(reasons[type]).toBe('ok');
  });
});

describe('renderingFlags', () => {
  it('reads tiles and speakable from the asked form, and the gap from the example', () => {
    const row = { form: 'casa', answerForm: null, lemma: 'casa', example: 'La casa è grande.', exampleTranslation: 'הבית גדול.' };
    expect(renderingFlags(row)).toEqual({ tiles: true, speakable: true, clozeGap: true });
    expect(renderingFlags({ ...row, exampleTranslation: null }).clozeGap).toBe(false);
    expect(renderingFlags({ ...row, example: 'Niente qui.' }).clozeGap).toBe(false);
  });
});

describe('fixedRendering', () => {
  const gloss = { glossId: 'g1', key: 'בית', variantId: 'v2', lexemeId: 'l1', lemma: 'casa', form: 'casa', order: [0, 0] as [number, number], knownAt: null };
  const rendering = (senseId: string, variantId: string) => ({ glossId: 'g1', senseId, variantId, form: 'casa', gloss: 'בית', rank: 0 });

  it("is the first askable rendering of the variant, by sense", () => {
    expect(fixedRendering(gloss, [rendering('s9', 'v2'), rendering('s3', 'v2'), rendering('s1', 'v1')], 'v2')?.senseId).toBe('s3');
  });

  it('is undefined when the variant has none', () => {
    expect(fixedRendering(gloss, [rendering('s1', 'v1')], 'v2')).toBeUndefined();
  });
});

describe('questionTypesPlan', () => {
  it('asks the one pick once per type, meet as the only intro card, with no board', () => {
    expect(questionTypesPlan(['meet', 'dictation'])).toEqual({ order: [0, 0], types: ['meet', 'dictation'], intro: [true, false], board: null });
  });
});

describe('keepQuestionTypeCards', () => {
  const units: CardUnit[] = [
    { indexes: [0], refusal: null },
    { indexes: [1], refusal: { stage: 'checker', reason: 'ambiguous' } },
    { indexes: [2], refusal: { stage: 'checker', reason: 'ambiguous' } },
    { indexes: [3], refusal: { stage: 'validation', reason: 'too few' } },
  ];
  const isChoice = (index: number) => index !== 2;

  it('keeps the unrefused, shows an ambiguous choice card as generated, and drops every other refused card', () => {
    expect(keepQuestionTypeCards(units, isChoice)).toEqual([
      { index: 0, fate: 'keep' },
      { index: 1, fate: 'keep_refused', shownAs: 'as_generated', refusal: units[1].refusal },
      { index: 2, fate: 'drop', refusal: units[2].refusal },
      { index: 3, fate: 'drop', refusal: units[3].refusal },
    ]);
  });
});
