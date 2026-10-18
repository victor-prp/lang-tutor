import { describe, expect, it } from '@jest/globals';

import type { LlmDistractors } from '@lang-tutor/core/api';

import { distractorItems, NOTHING_GENERATED, type DistractorVerdict, type Generated, type GenerationContext } from './distractors';
import { gapCheckItem, gapFaults, pointFaults, rewriteItems, rewriteOthers, type GapFault } from './gapRewrite';

const row = (form: string, translation: string, example: string | null = null): GenerationContext => ({
  glossId: `g-${form}`,
  senseId: `s-${form}`,
  variantId: `v-${form}`,
  lexemeId: `l-${form}`,
  form,
  lemma: form,
  partOfSpeech: 'noun',
  translation,
  example,
  exampleTranslation: null,
  acceptedAnswers: [],
  answerForm: null,
  acceptedAt: null,
});

// q1 a gap to choose, q2 another, q3 a meaning card.
const ITEMS = distractorItems(
  [row('fratello', 'אח', 'Mio fratello abita qui.'), row('casa', 'בית', 'La casa è grande.'), row('libro', 'ספר')],
  ['gap', 'gap', 'meaning'],
  new Map(),
);
const OLD = 'Io ho un fratello qui ora.';
const WRONG = ['tavolo', 'sorella', 'amico', 'casa', 'libro', 'gatto'];
const written = (sentence: string, word: string) => {
  const start = sentence.indexOf(word);
  return { sentence, translation: 'יש לי אח כאן עכשיו.', gap: { start, end: start + word.length }, alternatives: [] };
};
const kept = (sentence: string, word: string): Generated => ({
  ...NOTHING_GENERATED,
  distractors: WRONG.slice(0, 3),
  spares: WRONG.slice(3),
  sentence: written(sentence, word),
});
const ANSWER: LlmDistractors = {
  items: [
    { key: 'q1', distractors: WRONG, sentence: OLD, gap: 'fratello', translation: 'יש לי אח כאן עכשיו.' },
    { key: 'q2', distractors: ['muro'], sentence: 'La casa è grande.', gap: 'casa', translation: 'הבית גדול.' },
    { key: 'q3', distractors: ['כלב', 'חתול', 'שולחן'] },
  ],
};

describe('gapCheckItem', () => {
  it('blanks the gap', () => {
    expect(gapCheckItem('q1', written(OLD, 'fratello'), WRONG)).toEqual({ key: 'q1', task: 'gap', sentence: 'Io ho un ___ qui ora.', options: WRONG });
  });
});

describe('gapFaults', () => {
  const verdict = (over: Partial<DistractorVerdict> = {}): DistractorVerdict => ({
    byKey: new Map([['q1', kept(OLD, 'fratello')], ['q3', { ...NOTHING_GENERATED, distractors: ['כלב', 'חתול', 'שולחן'] }]]),
    refused: new Map([['q2', 'the sentence repeats one it was told to avoid']]),
    ...over,
  });

  it('a gap item validation refused is a validation fault with its old sentence and why', () => {
    expect(gapFaults({ items: ITEMS, answer: ANSWER, verdict: verdict(), judged: null })).toEqual([
      { key: 'q2', stage: 'validation', rewrite: { sentence: 'La casa è grande.', fits: [], problem: 'the sentence repeats one it was told to avoid' } },
    ]);
  });

  it('a refused gap item with no answer has no old sentence', () => {
    expect(gapFaults({ items: ITEMS, answer: { items: [] }, verdict: verdict(), judged: null })[0].rewrite.sentence).toBeNull();
  });

  it('a gap item the check left fewer than three is a checker fault naming what fit', () => {
    const judged = new Map([['q1', { options: WRONG, alsoRight: [true, false, true, false, true, true] }]]);
    expect(gapFaults({ items: ITEMS, answer: ANSWER, verdict: verdict(), judged })).toEqual([
      { key: 'q2', stage: 'validation', rewrite: { sentence: 'La casa è grande.', fits: [], problem: 'the sentence repeats one it was told to avoid' } },
      { key: 'q1', stage: 'checker', rewrite: { sentence: OLD, fits: ['tavolo', 'amico', 'libro', 'gatto'], problem: null } },
    ]);
  });

  it('a gap item the check left three or more is no fault', () => {
    const judged = new Map([['q1', { options: WRONG, alsoRight: [true, false, true, false, false, true] }]]);
    expect(gapFaults({ items: ITEMS, answer: ANSWER, verdict: verdict({ refused: new Map() }), judged })).toEqual([]);
  });

  it('a gap item the check did not judge is no fault', () => {
    expect(gapFaults({ items: ITEMS, answer: ANSWER, verdict: verdict({ refused: new Map() }), judged: new Map() })).toEqual([]);
  });

  it('a non-gap item is never a fault', () => {
    const refused = new Map([['q3', 'q3 needs three non-empty wrong answers']]);
    const judged = new Map([['q3', { options: ['כלב', 'חתול', 'שולחן'], alsoRight: [true, true, true] }]]);
    expect(gapFaults({ items: ITEMS, answer: ANSWER, verdict: verdict({ refused }), judged })).toEqual([]);
  });
});

describe('rewriteItems', () => {
  const faults: GapFault[] = [{ key: 'q1', stage: 'checker', rewrite: { sentence: OLD, fits: ['tavolo'], problem: null } }];

  it('gives each fault its item, with the rewrite and its old sentence added to avoid', () => {
    const [item] = rewriteItems(ITEMS, faults);
    expect(item).toMatchObject({ key: 'q1', task: 'gap', form: 'fratello', rewrite: faults[0].rewrite });
    expect(item.avoid).toEqual([...ITEMS[0].avoid, OLD]);
  });

  it('adds an old sentence already avoided once only, and none when there was none', () => {
    const again = rewriteItems(ITEMS, [{ ...faults[0], rewrite: { ...faults[0].rewrite, sentence: 'Mio fratello abita qui.' } }]);
    expect(again[0].avoid).toEqual(ITEMS[0].avoid);
    const none = rewriteItems(ITEMS, [{ ...faults[0], rewrite: { ...faults[0].rewrite, sentence: null } }]);
    expect(none[0].avoid).toEqual(ITEMS[0].avoid);
  });
});

describe('rewriteOthers', () => {
  it("is the session's others and every item not rewritten, by word and meaning", () => {
    const faults: GapFault[] = [{ key: 'q1', stage: 'checker', rewrite: { sentence: OLD, fits: [], problem: null } }];
    expect(rewriteOthers(ITEMS, faults, [{ form: 'muro', translation: 'קיר' }])).toEqual([
      { form: 'muro', translation: 'קיר' },
      { form: 'casa', translation: 'בית' },
      { form: 'libro', translation: 'ספר' },
    ]);
  });
});

// Phase 62d (spec D3). A typed gap the point check failed is asked again, told what a reader guessed.
describe('pointFaults', () => {
  const TYPED = distractorItems([row('cielo', 'שמיים', 'Spero che la sua anima riposi in cielo.'), row('sedia', 'כיסא'), row('libro', 'ספר')], ['sentence', 'sentence', 'meaning'], new Map());
  const CIELO = 'Il cielo è qui.';
  const verdict: DistractorVerdict = {
    byKey: new Map([
      ['q1', { ...NOTHING_GENERATED, sentence: written(CIELO, 'cielo') }],
      ['q2', { ...NOTHING_GENERATED, degraded: 'the sentence has 9 words' }],
      ['q3', { ...NOTHING_GENERATED, distractors: ['כלב', 'חתול', 'שולחן'] }],
    ]),
    refused: new Map(),
  };
  const failed = (key: string) => new Map([[key, { fits: ['tavolo', 'libro'], problem: 'a reader who covers the word guesses tavolo first' }]]);

  it('a sentence item the point check failed is a pointing fault with its old sentence, the guesses and why', () => {
    expect(pointFaults({ items: TYPED, verdict, failed: failed('q1') })).toEqual([
      { key: 'q1', stage: 'pointing', rewrite: { sentence: CIELO, fits: ['tavolo', 'libro'], problem: 'a reader who covers the word guesses tavolo first' } },
    ]);
  });

  it('a sentence item with no written sentence, or not failed, or of another task, is no fault', () => {
    expect(pointFaults({ items: TYPED, verdict, failed: failed('q2') })).toEqual([]);
    expect(pointFaults({ items: TYPED, verdict, failed: new Map() })).toEqual([]);
    expect(pointFaults({ items: TYPED, verdict, failed: failed('q3') })).toEqual([]);
  });
});
