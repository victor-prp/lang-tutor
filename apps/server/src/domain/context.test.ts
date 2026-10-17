import { describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';

import { ACCEPT_MARKER } from './accept';
import {
  CONTEXT_MARKER,
  buildContextPrompt,
  contextColumns,
  contextItemFor,
  contextLanguageOf,
  fallbackContext,
  markFor,
  parseLlmContext,
  italianWordMap,
  resolveContext,
  wordMapFor,
  type BareContextItem,
  type MarkItem,
} from './context';
import { DISTRACTOR_MARKER, type GenerationContext } from './distractors';
import { JUDGE_MARKER } from './judge';

const LANGS = { target: 'en', explanation: 'he' } as const;

/** The audit's rows: download/להוריד (C, d388f738) and saw/לנסר (E 71b0b407, H a7d6bdb4). */
const DOWNLOAD: GenerationContext = {
  glossId: 'g-download', senseId: 's-download', variantId: 'v-download', lexemeId: 'l-download',
  form: 'download', lemma: 'download', partOfSpeech: 'verb', translation: 'להוריד',
  example: 'I need to download the file first.', exampleTranslation: 'אני צריך להוריד את הקובץ קודם.',
  acceptedAnswers: ['get'], answerForm: null, acceptedAt: null,
};
const SAW: GenerationContext = {
  glossId: 'g-saw', senseId: 's-saw', variantId: 'v-saw', lexemeId: 'l-saw',
  form: 'saw', lemma: 'saw', partOfSpeech: 'verb', translation: 'לנסר',
  example: 'He will saw the branch off.', exampleTranslation: 'הוא ינסר את הענף.',
  acceptedAnswers: [], answerForm: null, acceptedAt: null,
};

const bare = (type: QuestionType, row: GenerationContext, extra: { alternatives?: string[]; recent?: string[] } = {}) =>
  contextItemFor({ key: 'q1', type, row, alternatives: extra.alternatives ?? [], recent: extra.recent ?? [], sentence: null }) as BareContextItem;

describe('contextLanguageOf (spec D6)', () => {
  it('gives a Hebrew sentence to the three cards that show the Hebrew, a target one to the two that show the word, and none to the rest', () => {
    const all: QuestionType[] = [
      'multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles',
      'read_aloud', 'say_translation', 'typed_meaning', 'cloze_choice', 'cloze_typed', 'sentence_translation',
    ];
    expect(Object.fromEntries(all.map((type) => [type, contextLanguageOf(type)]))).toEqual({
      multiple_choice: 'target', reverse_choice: 'explanation', typed_translation: 'explanation', listen_choice: null,
      dictation: null, matching: null, letter_tiles: null, read_aloud: null, say_translation: 'explanation',
      typed_meaning: 'target', cloze_choice: null, cloze_typed: null, sentence_translation: null,
    });
  });
});

describe('contextItemFor', () => {
  it('asks a target sentence with the form the card shows: the answer form on multiple choice, the saved form on typed meaning', () => {
    const ore = { ...SAW, form: 'ora', lemma: 'ora', translation: 'שעות', answerForm: 'ore' };
    expect(bare('multiple_choice', ore)).toMatchObject({ task: 'target', shown: 'ore' });
    expect(bare('typed_meaning', ore)).toMatchObject({ task: 'target', shown: 'ora' });
  });

  it('asks a Hebrew sentence with the rendering the card shows and the word it asks for, and refuses every right answer in it', () => {
    expect(bare('typed_translation', DOWNLOAD, { alternatives: ['fetch', 'Get'] })).toMatchObject({
      task: 'explanation', shown: 'להוריד', answer: 'download', refused: ['download', 'get', 'fetch'],
    });
    const ore = { ...SAW, form: 'ora', lemma: 'ora', translation: 'שעות', answerForm: 'ore', acceptedAnswers: ['ore'] };
    expect(bare('reverse_choice', ore)).toMatchObject({ answer: 'ore', refused: ['ora', 'ore'] });
  });

  it('asks a sentence card for its word in the Hebrew, and nothing of a card that shows no sentence', () => {
    const sentence = { hebrew: 'בואו נשלב כוחות.', target: "Let's combine forces.", word: 'combine' };
    // Phase 59 (spec D2): a translation card also asks for its word map.
    expect(contextItemFor({ key: 'q5', type: 'sentence_translation', row: SAW, alternatives: [], recent: [], sentence })).toEqual({
      key: 'q5', task: 'mark', word: 'combine', meaning: 'לנסר', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", map: true,
    });
    // Phase 62 (spec D2): so does each gap card, a cloze choice now too.
    for (const type of ['cloze_typed', 'cloze_choice'] as const) {
      expect(contextItemFor({ key: 'q5', type, row: SAW, alternatives: [], recent: [], sentence })).toMatchObject({ task: 'mark', map: true });
    }
    for (const type of ['listen_choice', 'matching', 'dictation', 'letter_tiles', 'read_aloud'] as const) {
      expect(contextItemFor({ key: 'q1', type, row: SAW, alternatives: [], recent: [], sentence: null })).toBeNull();
    }
    // A sentence card the batch left without a sentence asks nothing.
    expect(contextItemFor({ key: 'q1', type: 'cloze_typed', row: SAW, alternatives: [], recent: [], sentence: null })).toBeNull();
  });
});

describe('buildContextPrompt', () => {
  const items = [
    bare('typed_meaning', SAW, { recent: ['Saw this plank, please.'] }),
    { ...bare('typed_translation', DOWNLOAD), key: 'q2' },
    { key: 'q3', task: 'mark', word: 'combine', meaning: 'לשלב', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces." } as MarkItem,
  ];
  const prompt = buildContextPrompt({ items, from: 'en', to: 'he' });

  it('carries its own marker and no other call’s', () => {
    expect(prompt.system).toContain(CONTEXT_MARKER);
    for (const other of [DISTRACTOR_MARKER, ACCEPT_MARKER, JUDGE_MARKER]) {
      expect(prompt.system).not.toContain(other);
      expect(prompt.user).not.toContain(other);
    }
  });

  it('sends each item what its task needs, and the sentences to avoid: the saved example’s half and the recent ones', () => {
    const [saw, download, combine] = JSON.parse(prompt.user).items;
    expect(saw).toEqual({
      key: 'q1', task: 'target', word: 'saw', lemma: 'saw', part_of_speech: 'verb', meaning: 'לנסר',
      example: 'He will saw the branch off.', example_translation: 'הוא ינסר את הענף.',
      avoid: ['He will saw the branch off.', 'Saw this plank, please.'], map: true,
    });
    expect(download).toMatchObject({ key: 'q2', task: 'explanation', word: 'להוריד', translates: 'download', avoid: ['אני צריך להוריד את הקובץ קודם.'] });
    expect(combine).toEqual({ key: 'q3', task: 'mark', word: 'combine', meaning: 'לשלב', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces." });
  });
});

describe('contextItemFor and buildContextPrompt: the context line, short and mapped (phase 62 D1, D2)', () => {
  const learnerWords = [{ key: 'w1', glossId: 'g-amico', word: 'amico', meaning: 'חבר' }];
  it('maps every target sentence, and no Hebrew one', () => {
    expect(bare('multiple_choice', SAW)).toMatchObject({ task: 'target', map: true });
    expect(bare('typed_meaning', SAW)).toMatchObject({ task: 'target', map: true });
    expect(bare('reverse_choice', SAW)).not.toHaveProperty('map');
  });
  it('asks a target sentence for 3 to 6 words from the learner\'s words and its map, and leaves the Hebrew rule as it was', () => {
    const prompt = buildContextPrompt({ items: [bare('multiple_choice', SAW), { ...bare('reverse_choice', DOWNLOAD), key: 'q2' }], from: 'en', to: 'he', learnerWords });
    const lines = prompt.system.split('\n');
    const target = lines.find((line) => line.startsWith('- "target":'))!;
    expect(target).toContain('3 to 6 words');
    expect(target).toContain('learner_words');
    expect(target).toContain('fill sentence_words as a mark item');
    // R5: the sense comes before the learner's words.
    expect(target.indexOf('never in another sense')).toBeLessThan(target.indexOf('learner_words'));
    const explanation = lines.find((line) => line.startsWith('- "explanation":'))!;
    expect(explanation).toContain('4 to 10 words');
    expect(explanation).not.toContain('learner_words');
    const sent = JSON.parse(prompt.user);
    expect(sent.items[0]).toMatchObject({ key: 'q1', task: 'target', map: true });
    expect(sent.items[1]).not.toHaveProperty('map');
    expect(sent.learner_words).toEqual([{ key: 'w1', word: 'amico', meaning: 'חבר' }]);
  });
  it('refuses a target sentence of seven words, and keeps a Hebrew one of seven', () => {
    const seven = resolveContext(bare('typed_meaning', SAW), { key: 'q1', context: 'Please saw the old plank in half.', context_translation: 'בבקשה תנסר את הקרש הישן לשניים.' }, LANGS);
    expect(seven.dropped).toBe('the sentence has 7 words');
    const hebrew = resolveContext(bare('typed_translation', DOWNLOAD), {
      key: 'q1', context: 'אני רוצה להוריד את הקובץ הזה היום.', context_translation: 'I want to download this file today.', context_word: 'להוריד',
    }, LANGS);
    expect(hebrew.dropped).toBeNull();
  });
});

describe('italianWordMap (phase 62 D2)', () => {
  const learner = [{ key: 'w1', glossId: 'g-casa', word: 'casa', meaning: 'בית' }, { key: 'w2', glossId: 'g-own', word: 'molto', meaning: 'מאוד' }];
  // Questa casa nuova è molto grande. / הבית החדש הזה גדול מאוד.
  const text = 'Questa casa nuova è molto grande.';
  const translation = 'הבית החדש הזה גדול מאוד.';
  const gap = { start: 20, end: 25 };
  const input = (entries: { hebrew: string; translation: string; word: string }[], extra: object = {}) => ({
    text, translation, target: gap, meaning: 'מאוד', entries, learner, ownGlossId: 'g-own', ...extra,
  });

  it('finds each entry\'s words in the Italian whatever the Hebrew order, and shows the Hebrew (Review Focus 1)', () => {
    const map = italianWordMap(input([
      { hebrew: 'הבית', translation: 'casa', word: 'w1' },
      { hebrew: 'החדש', translation: 'nuova', word: '' },
      { hebrew: 'הזה', translation: 'Questa', word: '' },
      { hebrew: 'מאוד', translation: 'molto', word: 'w2' },
      { hebrew: 'גדול', translation: 'grande', word: '' },
    ]));
    expect(map).toEqual([
      { start: 0, end: 6, text: 'הזה', glossId: null, target: false },
      { start: 7, end: 11, text: 'הבית', glossId: 'g-casa', target: false },
      { start: 12, end: 17, text: 'החדש', glossId: null, target: false },
      { start: 20, end: 25, text: 'מאוד', glossId: null, target: true },
      { start: 26, end: 32, text: 'גדול', glossId: null, target: false },
    ]);
  });

  it('makes the target exactly the gap, and drops an entry that crosses it (Review Focus 2)', () => {
    const map = italianWordMap(input([
      { hebrew: 'הבית', translation: 'casa', word: 'w1' },
      { hebrew: 'גדול מאוד', translation: 'molto grande', word: '' },
    ]));
    expect(map).toEqual([
      { start: 7, end: 11, text: 'הבית', glossId: 'g-casa', target: false },
      { start: 20, end: 25, text: 'גדול מאוד', glossId: null, target: true },
    ]);
  });

  it('gives the target the meaning when no entry covers it', () => {
    expect(italianWordMap(input([{ hebrew: 'הבית', translation: 'casa', word: '' }]))).toEqual([
      { start: 7, end: 11, text: 'הבית', glossId: null, target: false },
      { start: 20, end: 25, text: 'מאוד', glossId: null, target: true },
    ]);
  });

  it('drops a free entry whose Hebrew holds the card\'s answer, so a tap never shows it (Review Focus 3)', () => {
    // A word card for poi: dopo would show אחר כך, the answer.
    const map = italianWordMap({
      text: 'Mangiamo e poi dopo usciamo.', translation: 'אוכלים ואחר כך אחר כך יוצאים.', target: { start: 11, end: 14 }, meaning: 'אחר כך',
      entries: [
        { hebrew: 'אוכלים', translation: 'Mangiamo', word: '' },
        { hebrew: 'אחר כך', translation: 'dopo', word: '' },
        { hebrew: 'יוצאים', translation: 'usciamo', word: '' },
      ],
      learner: [], ownGlossId: 'g-poi',
    });
    expect(map?.map((word) => word.text)).toEqual(['אוכלים', 'אחר כך', 'יוצאים']);
    expect(map?.find((word) => word.text === 'אחר כך')).toMatchObject({ start: 11, end: 14, target: true });
  });

  it('drops an entry whose Hebrew is not in the translation, or whose Italian is not in the sentence, or with an empty side', () => {
    const map = italianWordMap(input([
      { hebrew: 'בית', translation: 'casa', word: '' },
      { hebrew: 'החדש', translation: 'nuovissima', word: '' },
      { hebrew: 'הזה', translation: '', word: '' },
      { hebrew: '', translation: 'grande', word: '' },
    ]));
    expect(map).toEqual([{ start: 20, end: 25, text: 'מאוד', glossId: null, target: true }]);
  });

  it('names no gloss for an unknown key or the card\'s own', () => {
    const map = italianWordMap(input([{ hebrew: 'הבית', translation: 'casa', word: 'w9' }]));
    expect(map?.[0]).toMatchObject({ text: 'הבית', glossId: null });
  });

  it('with no target, keeps every usable entry and marks none', () => {
    const map = italianWordMap(input([{ hebrew: 'הבית', translation: 'casa', word: '' }], { target: null }));
    expect(map).toEqual([{ start: 7, end: 11, text: 'הבית', glossId: null, target: false }]);
  });

  it('is null with no entries, or nothing usable and no target', () => {
    expect(italianWordMap(input([], {}))).toEqual([{ start: 20, end: 25, text: 'מאוד', glossId: null, target: true }]);
    expect(italianWordMap(input([], { entries: undefined }))).toBeNull();
    expect(italianWordMap(input([{ hebrew: 'x', translation: 'y', word: '' }], { target: null }))).toBeNull();
  });
});

describe('buildContextPrompt: the word map (phase 59 D2)', () => {
  const mapped: MarkItem = { key: 'q3', task: 'mark', word: 'con', meaning: 'עם', sentence: 'אני הולך עם חברים.', translation: 'Vado con amici.', map: true };
  const learnerWords = [{ key: 'w1', glossId: 'g-amico', word: 'amico', meaning: 'חבר' }];

  it('asks a mapped mark item for sentence_words, and sends the learner\'s words once', () => {
    const prompt = buildContextPrompt({ items: [mapped], from: 'it', to: 'he', learnerWords });
    expect(prompt.system).toContain('sentence_words');
    const sent = JSON.parse(prompt.user);
    expect(sent.items[0]).toMatchObject({ key: 'q3', task: 'mark', map: true });
    expect(sent.learner_words).toEqual([{ key: 'w1', word: 'amico', meaning: 'חבר' }]);
  });

  // Phase 59 follow-up: יש לי אח → Ho un fratello came back with יש and לי empty,
  // each alone rendered by nothing, so neither could be tapped.
  it('asks for one entry per run the translation renders together, such as יש לי for ho', () => {
    const prompt = buildContextPrompt({ items: [mapped], from: 'it', to: 'he', learnerWords });
    expect(prompt.system).toContain('several words of sentence that the translation renders together');
    expect(prompt.system).toContain('every word of sentence in exactly one entry');
  });

  it('sends no learner words when no item is mapped', () => {
    const plain: MarkItem = { key: 'q3', task: 'mark', word: 'combine', meaning: 'לשלב', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces." };
    expect(JSON.parse(buildContextPrompt({ items: [plain], from: 'en', to: 'he', learnerWords }).user)).not.toHaveProperty('learner_words');
  });
});

describe('wordMapFor (phase 59 D2)', () => {
  const item: MarkItem = { key: 'q1', task: 'mark', word: 'con', meaning: 'עם', sentence: 'אני הולך עם חברים.', translation: 'Vado con amici.', map: true };
  const learner = [
    { key: 'w1', glossId: 'g-amico', word: 'amico', meaning: 'חבר' },
    { key: 'w2', glossId: 'g-con', word: 'con', meaning: 'עם' },
  ];
  const words = [
    { hebrew: 'אני', translation: '', word: '' },
    { hebrew: 'הולך', translation: 'Vado', word: '' },
    { hebrew: 'עם', translation: 'con', word: 'w2' },
    { hebrew: 'חברים', translation: 'amici', word: 'w1' },
  ];
  const mark = { start: 9, end: 11 };

  it('maps each located word to its Italian, marks the target, and names a list word', () => {
    expect(wordMapFor(item, { key: 'q1', sentence_words: words }, mark, learner, 'g-con')).toEqual([
      { start: 4, end: 8, text: 'Vado', glossId: null, target: false },
      { start: 9, end: 11, text: 'con', glossId: null, target: true },
      { start: 12, end: 17, text: 'amici', glossId: 'g-amico', target: false },
    ]);
  });

  it('keeps a run of several Hebrew words rendered by one Italian word as one tappable word', () => {
    const have: MarkItem = { key: 'q1', task: 'mark', word: 'fratello', meaning: 'אח', sentence: 'יש לי אח.', translation: 'Ho un fratello.', map: true };
    const ho = [{ key: 'w4', glossId: 'g-ho', word: 'ho', meaning: 'לבעול' }];
    expect(wordMapFor(have, { key: 'q1', sentence_words: [
      { hebrew: 'יש לי', translation: 'Ho', word: 'w4' },
      { hebrew: 'אח', translation: 'un fratello', word: '' },
    ] }, { start: 6, end: 8 }, ho, 'g-fratello')).toEqual([
      { start: 0, end: 5, text: 'Ho', glossId: 'g-ho', target: false },
      { start: 6, end: 8, text: 'un fratello', glossId: null, target: true },
    ]);
  });

  it('drops an entry whose Italian is not in the reference, or whose Hebrew is not in the sentence', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: [
      { hebrew: 'הולך', translation: 'andiamo', word: '' },
      { hebrew: 'רץ', translation: 'Vado', word: '' },
      ...words.slice(2),
    ] }, mark, learner, 'g-con');
    expect(map!.map((word) => word.text)).toEqual(['con', 'amici']);
  });

  it('drops a non-target entry that holds the target\'s Italian, so a free tap never shows the answer', () => {
    const multi: MarkItem = { key: 'q1', task: 'mark', word: 'ci sono', meaning: 'יש', sentence: 'יש פה אנשים.', translation: 'Ci sono persone qui.', map: true };
    const map = wordMapFor(multi, { key: 'q1', sentence_words: [
      { hebrew: 'יש', translation: 'Ci sono', word: '' },
      { hebrew: 'פה', translation: 'sono qui', word: '' },
      { hebrew: 'אנשים', translation: 'persone', word: '' },
    ] }, { start: 0, end: 2 }, [], 'g-ci');
    expect(map!.map((word) => [word.text, word.target])).toEqual([['Ci sono', true], ['persone', false]]);
  });

  it('with no mark, takes the entry whose Italian is the gap as the target', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: words }, null, learner, 'g-con');
    expect(map!.filter((word) => word.target)).toEqual([{ start: 9, end: 11, text: 'con', glossId: null, target: true }]);
  });

  it('with no mark, takes an entry whose Italian holds the gap with its article as the target', () => {
    const have: MarkItem = { key: 'q1', task: 'mark', word: 'fratello', meaning: 'אח', sentence: 'יש לי אח.', translation: 'Ho un fratello.', map: true };
    const map = wordMapFor(have, { key: 'q1', sentence_words: [
      { hebrew: 'יש לי', translation: 'Ho', word: '' },
      { hebrew: 'אח', translation: 'un fratello', word: '' },
    ] }, null, [], 'g-fratello');
    expect(map).toEqual([
      { start: 0, end: 5, text: 'Ho', glossId: null, target: false },
      { start: 6, end: 8, text: 'un fratello', glossId: null, target: true },
    ]);
  });

  it('adds the mark as the target when no entry covers it', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: [words[1], words[3]] }, mark, learner, 'g-con');
    expect(map).toEqual([
      { start: 4, end: 8, text: 'Vado', glossId: null, target: false },
      { start: 9, end: 11, text: 'con', glossId: null, target: true },
      { start: 12, end: 17, text: 'amici', glossId: 'g-amico', target: false },
    ]);
  });

  it('names no gloss for an unknown key or the card\'s own gloss, and keeps the word free', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: [
      { hebrew: 'הולך', translation: 'Vado', word: 'w9' },
      { hebrew: 'חברים', translation: 'amici', word: 'w2' },
    ] }, mark, learner, 'g-con');
    expect(map!.filter((word) => !word.target).map((word) => word.glossId)).toEqual([null, null]);
  });

  it('is null with no map, an unmapped item, or nothing usable', () => {
    expect(wordMapFor(item, { key: 'q1' }, mark, learner, 'g-con')).toBeNull();
    expect(wordMapFor(item, undefined, mark, learner, 'g-con')).toBeNull();
    expect(wordMapFor({ ...item, map: undefined }, { key: 'q1', sentence_words: words }, mark, learner, 'g-con')).toBeNull();
    expect(wordMapFor(item, { key: 'q1', sentence_words: [{ hebrew: 'רץ', translation: 'x', word: '' }] }, null, learner, 'g-con')).toBeNull();
  });
});

describe('parseLlmContext', () => {
  it('reads an answer, drops a null field, and refuses junk', () => {
    expect(parseLlmContext(JSON.stringify({ items: [{ key: 'q1', context: 'x', context_word: null }] }))).toEqual({
      items: [{ key: 'q1', context: 'x' }],
    });
    expect(parseLlmContext('```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(parseLlmContext('nope')).toBeNull();
    expect(parseLlmContext(JSON.stringify({ items: [{ context: 'no key' }] }))).toBeNull();
  });
});

describe('resolveContext: a target-language sentence (E 71b0b407, H a7d6bdb4)', () => {
  const found = (context: string, extra: object = {}) => ({
    key: 'q1', context, context_translation: 'בבקשה תנסר את הקרש לשניים.', context_word: 'saw', ...extra,
  });

  it('keeps a sentence that uses the form the card shows, marked', () => {
    const outcome = resolveContext(bare('typed_meaning', SAW), found('Please saw the plank in half.'), LANGS);
    expect(outcome).toEqual({
      context: { text: 'Please saw the plank in half.', translation: 'בבקשה תנסר את הקרש לשניים.', mark: { start: 7, end: 10 } },
      dropped: null,
    });
  });

  it('drops a sentence without the form the card shows, for the saved example, unmarked', () => {
    const outcome = resolveContext(bare('typed_meaning', SAW), found('He saws the planks every morning.', { context_word: 'saws' }), LANGS);
    expect(outcome.context).toEqual({ text: 'He will saw the branch off.', translation: 'הוא ינסר את הענף.', mark: null });
    expect(outcome.dropped).toMatch(/saw/);
  });

  it('drops a sentence in the wrong script, or with no other half', () => {
    expect(resolveContext(bare('typed_meaning', SAW), found('אני רוצה saw את הקרש'), LANGS).dropped).not.toBeNull();
    expect(resolveContext(bare('typed_meaning', SAW), found('Please saw the plank in half.', { context_translation: undefined }), LANGS).dropped).not.toBeNull();
    expect(resolveContext(bare('typed_meaning', SAW), found('Please saw the plank in half.', { context_translation: 'Please saw it.' }), LANGS).dropped).not.toBeNull();
  });

  it('drops a sentence a recent session showed for this gloss on this card (phase 27 D8’s rule)', () => {
    const item = bare('typed_meaning', SAW, { recent: ['please saw the plank in half'] });
    const outcome = resolveContext(item, found('Please saw the plank in half.'), LANGS);
    expect(outcome.dropped).toMatch(/recent/);
    expect(outcome.context?.text).toBe('He will saw the branch off.');
  });

  it('keeps nothing when the model wrote nothing and the sense has no saved example', () => {
    const outcome = resolveContext(bare('multiple_choice', { ...SAW, example: null, exampleTranslation: null }), undefined, LANGS);
    expect(outcome).toEqual({ context: null, dropped: expect.any(String) });
  });
});

describe('resolveContext: a Hebrew sentence (C d388f738)', () => {
  const item = () => bare('typed_translation', DOWNLOAD);
  const found = (context: string, context_word = 'להוריד') => ({
    key: 'q1', context, context_word, context_translation: 'I want to download the new game tonight.',
  });

  it('keeps a Hebrew sentence that pins the sense, marked on the word the model names', () => {
    const outcome = resolveContext(item(), found('אני רוצה להוריד את המשחק החדש הלילה.'), LANGS);
    expect(outcome.dropped).toBeNull();
    expect(outcome.context).toEqual({
      text: 'אני רוצה להוריד את המשחק החדש הלילה.',
      translation: 'I want to download the new game tonight.',
      mark: { start: 9, end: 15 },
    });
  });

  // Review Focus 4: an inflected Hebrew word the service cannot find costs the mark, not the sentence.
  it('keeps the sentence unmarked when the word cannot be found in it', () => {
    const outcome = resolveContext(item(), found('היא הורידה את המשחק החדש אתמול.', 'להוריד'), LANGS);
    expect(outcome.dropped).toBeNull();
    expect(outcome.context).toMatchObject({ text: 'היא הורידה את המשחק החדש אתמול.', mark: null });
    // Named as written, the inflected word is marked.
    expect(resolveContext(item(), found('היא הורידה את המשחק החדש אתמול.', 'הורידה'), LANGS).context?.mark).toEqual({ start: 4, end: 10 });
  });

  it('drops a Hebrew sentence that holds the answer, or any target-language word', () => {
    const answer = resolveContext(item(), found('תעשה download לקובץ הזה עכשיו.'), LANGS);
    expect(answer.dropped).toMatch(/download/);
    expect(answer.context).toEqual({ text: 'אני צריך להוריד את הקובץ קודם.', translation: 'I need to download the file first.', mark: null });
    expect(resolveContext(item(), found('תוריד את ה-file הזה עכשיו.'), LANGS).dropped).not.toBeNull();
  });

  it('compares the answer as words, under comparable: an accepted answer counts as the form does', () => {
    expect(resolveContext(item(), found('אמרתי לו GET עכשיו ומהר.'), LANGS).dropped).toMatch(/get/i);
  });
});

describe('markFor: a sentence card’s word in its Hebrew (F eb95d246)', () => {
  const item: MarkItem = { key: 'q1', task: 'mark', word: 'combine', meaning: 'לשלב', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces." };

  it('marks the word the model names, found in the sentence', () => {
    expect(markFor(item, { key: 'q1', sentence_word: 'נשלב' })).toEqual({ start: 5, end: 9 });
  });

  it('marks nothing when the word is missing or cannot be found: the card keeps its sentence', () => {
    expect(markFor(item, { key: 'q1' })).toBeNull();
    expect(markFor(item, undefined)).toBeNull();
    expect(markFor(item, { key: 'q1', sentence_word: 'לשלב' })).toBeNull();
  });
});

describe('fallbackContext (spec D6, ruling R2)', () => {
  it('shows the saved example’s matching half, unmarked, and hides the other', () => {
    expect(fallbackContext(SAW, 'target')).toEqual({ text: 'He will saw the branch off.', translation: 'הוא ינסר את הענף.', mark: null });
    expect(fallbackContext(SAW, 'explanation')).toEqual({ text: 'הוא ינסר את הענף.', translation: 'He will saw the branch off.', mark: null });
  });

  it('is null without the half it would show', () => {
    expect(fallbackContext({ example: null, exampleTranslation: null }, 'target')).toBeNull();
    expect(fallbackContext({ example: 'He will saw it.', exampleTranslation: null }, 'explanation')).toBeNull();
    expect(fallbackContext({ example: 'He will saw it.', exampleTranslation: null }, 'target')).toEqual({ text: 'He will saw it.', translation: null, mark: null });
  });
});

describe('contextColumns', () => {
  const context = { text: 'Please saw the plank in half.', translation: 'תנסר את הקרש.', mark: { start: 7, end: 10 } };
  const sentence = { text: 'בואו נשלב כוחות.', mark: { start: 5, end: 9 } };

  it('stores a context only on the five cards that show one, and a sentence mark only on the two sentence cards', () => {
    expect(contextColumns('typed_meaning', context, null)).toEqual({
      context: 'Please saw the plank in half.', contextTranslation: 'תנסר את הקרש.', contextMarkStart: 7, contextMarkEnd: 10,
      sentenceMarkStart: null, sentenceMarkEnd: null,
    });
    expect(contextColumns('listen_choice', context, sentence)).toEqual({
      context: null, contextTranslation: null, contextMarkStart: null, contextMarkEnd: null, sentenceMarkStart: null, sentenceMarkEnd: null,
    });
    expect(contextColumns('sentence_translation', context, sentence)).toMatchObject({ context: null, sentenceMarkStart: 5, sentenceMarkEnd: 9 });
  });

  // questions_marks_valid: 0 <= start < end <= length. A mark that cannot hold is no mark.
  it('stores no mark that would not fit its sentence', () => {
    expect(contextColumns('typed_meaning', { ...context, mark: { start: 7, end: 99 } }, null)).toMatchObject({ contextMarkStart: null, contextMarkEnd: null });
    expect(contextColumns('cloze_typed', null, { ...sentence, mark: { start: 4, end: 4 } })).toMatchObject({ sentenceMarkStart: null, sentenceMarkEnd: null });
  });
});
