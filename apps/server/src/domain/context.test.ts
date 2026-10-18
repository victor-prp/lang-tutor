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
      key: 'q5', task: 'mark', word: 'combine', meaning: 'לנסר', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", map: 'sentence',
    });
    // Phase 62 (spec D2): so does each gap card, a cloze choice now too.
    for (const type of ['cloze_typed', 'cloze_choice'] as const) {
      expect(contextItemFor({ key: 'q5', type, row: SAW, alternatives: [], recent: [], sentence })).toMatchObject({ task: 'mark', map: 'translation' });
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
      avoid: ['He will saw the branch off.', 'Saw this plank, please.'], map: 'context',
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
  it('asks a target sentence for 4 to 8 words from the learner\'s words and its map, and leaves the Hebrew rule as it was', () => {
    const prompt = buildContextPrompt({ items: [bare('multiple_choice', SAW), { ...bare('reverse_choice', DOWNLOAD), key: 'q2' }], from: 'en', to: 'he', learnerWords });
    const lines = prompt.system.split('\n');
    const target = lines.find((line) => line.startsWith('- "target":'))!;
    expect(target).toContain('4 to 8 words');
    expect(target).toContain('learner_words');
    expect(target).toContain('fill sentence_words with context');
    // R5: the sense comes before the learner's words.
    expect(target.indexOf('never in another sense')).toBeLessThan(target.indexOf('learner_words'));
    const explanation = lines.find((line) => line.startsWith('- "explanation":'))!;
    expect(explanation).toContain('4 to 10 words');
    expect(explanation).not.toContain('learner_words');
    const sent = JSON.parse(prompt.user);
    expect(sent.items[0]).toMatchObject({ key: 'q1', task: 'target', map: 'context' });
    expect(sent.items[1]).not.toHaveProperty('map');
    expect(sent.learner_words).toEqual([{ key: 'w1', word: 'amico', meaning: 'חבר' }]);
  });
  it('refuses a target sentence of nine words, and keeps a Hebrew one of nine', () => {
    const nine = resolveContext(bare('typed_meaning', SAW), { key: 'q1', context: 'Please saw the old wooden plank in half now.', context_translation: 'בבקשה תנסר את קרש העץ הישן לשניים עכשיו.' }, LANGS);
    expect(nine.dropped).toBe('the sentence has 9 words');
    const hebrew = resolveContext(bare('typed_translation', DOWNLOAD), {
      key: 'q1', context: 'אני רוצה להוריד את הקובץ הזה היום בבוקר.', context_translation: 'I want to download this file this morning.', context_word: 'להוריד',
    }, LANGS);
    expect(hebrew.dropped).toBeNull();
  });
});

// Phase 62b. The map is of the sentence the card shows, in its order: each run of the
// Italian with its own Hebrew meaning, which need not be how the Hebrew sentence writes it.
describe('italianWordMap (phase 62b: the shown sentence, in its order)', () => {
  const learner = [{ key: 'w1', glossId: 'g-casa', word: 'casa', meaning: 'בית' }, { key: 'w2', glossId: 'g-own', word: 'molto', meaning: 'מאוד' }];
  // La casa è molto grande. / הבית גדול מאוד.
  const text = 'La casa è molto grande.';
  const gap = { start: 10, end: 15 };
  const input = (entries: { shown: string; translation: string; word: string }[], extra: object = {}) => ({
    text, target: gap, meaning: 'מאוד', entries, learner, ownGlossId: 'g-own', explanation: 'he' as const, ...extra,
  });

  it('maps each run of the Italian, left to right: an article with its noun, a word Hebrew leaves out untappable', () => {
    const map = italianWordMap(input([
      { shown: 'La casa', translation: 'הבית', word: 'w1' },
      { shown: 'è', translation: '', word: '' },
      { shown: 'molto', translation: 'מאוד', word: 'w2' },
      { shown: 'grande', translation: 'גדול', word: '' },
    ]));
    expect(map).toEqual([
      { start: 0, end: 7, text: 'הבית', glossId: 'g-casa', target: false },
      { start: 10, end: 15, text: 'מאוד', glossId: null, target: true },
      { start: 16, end: 22, text: 'גדול', glossId: null, target: false },
    ]);
  });

  // Victor's card, 2026-10-18: Mio fratello è un bravo ragazzo. / אחי הוא ילד טוב.
  it('gives a possessive its own Hebrew though the sentence joins it (Mio → שלי), and each split word its own (bravo, ragazzo)', () => {
    const map = italianWordMap({
      text: 'Mio fratello è un bravo ragazzo.', target: { start: 4, end: 12 }, meaning: 'אח', learner: [], ownGlossId: 'g-fratello', explanation: 'he',
      entries: [
        { shown: 'Mio', translation: 'שלי', word: '' },
        { shown: 'fratello', translation: 'אח', word: '' },
        { shown: 'è', translation: '', word: '' },
        { shown: 'un', translation: '', word: '' },
        { shown: 'bravo', translation: 'טוב', word: '' },
        { shown: 'ragazzo', translation: 'ילד', word: '' },
      ],
    });
    expect(map).toEqual([
      { start: 0, end: 3, text: 'שלי', glossId: null, target: false },
      { start: 4, end: 12, text: 'אח', glossId: null, target: true },
      { start: 18, end: 23, text: 'טוב', glossId: null, target: false },
      { start: 24, end: 31, text: 'ילד', glossId: null, target: false },
    ]);
  });

  it('finds a word that occurs twice at its own place, in order', () => {
    const map = italianWordMap({
      text: 'Io mangio e tu mangi e poi usciamo.', target: { start: 23, end: 26 }, meaning: 'אחר כך', learner: [], ownGlossId: 'g-poi', explanation: 'he',
      entries: [
        { shown: 'Io', translation: 'אני', word: '' },
        { shown: 'mangio', translation: 'אוכל', word: '' },
        { shown: 'e', translation: 'ו', word: '' },
        { shown: 'tu', translation: 'אתה', word: '' },
        { shown: 'mangi', translation: 'אוכל', word: '' },
        { shown: 'e', translation: 'ו', word: '' },
        { shown: 'poi', translation: 'אחר כך', word: '' },
        { shown: 'usciamo', translation: 'יוצאים', word: '' },
      ],
    });
    expect(map?.filter((word) => word.text === 'ו').map((word) => word.start)).toEqual([10, 21]);
  });

  it('makes the target exactly the gap: an entry that runs over it lends it its Hebrew, and the word joined to it goes untapped (Review Focus 2)', () => {
    const map = italianWordMap({
      text: 'Mio fratello è qui.', target: { start: 4, end: 12 }, meaning: 'אח', learner: [], ownGlossId: 'g-fratello', explanation: 'he',
      entries: [
        { shown: 'Mio fratello', translation: 'אחי', word: '' },
        { shown: 'è qui', translation: 'כאן', word: '' },
      ],
    });
    expect(map).toEqual([
      { start: 4, end: 12, text: 'אחי', glossId: null, target: true },
      { start: 13, end: 18, text: 'כאן', glossId: null, target: false },
    ]);
  });

  it('gives the target the meaning when no entry covers it', () => {
    expect(italianWordMap(input([{ shown: 'La casa', translation: 'הבית', word: '' }]))).toEqual([
      { start: 0, end: 7, text: 'הבית', glossId: null, target: false },
      { start: 10, end: 15, text: 'מאוד', glossId: null, target: true },
    ]);
  });

  it('drops a free entry whose Hebrew holds the answer, as whole words or behind a prefix (Review Focus 3)', () => {
    const map = italianWordMap({
      text: 'Mangiamo poi, e dopo usciamo.', target: { start: 9, end: 12 }, meaning: 'אחר כך', learner: [], ownGlossId: 'g-poi', explanation: 'he',
      entries: [
        { shown: 'Mangiamo', translation: 'אוכלים', word: '' },
        { shown: 'poi', translation: 'אחר כך', word: '' },
        { shown: 'e dopo', translation: 'ואחר כך', word: '' },
        { shown: 'usciamo', translation: 'אחר כך יוצאים', word: '' },
      ],
    });
    expect(map?.map((word) => [word.text, word.target])).toEqual([['אוכלים', false], ['אחר כך', true]]);
  });

  it('drops an entry whose Italian is not in the sentence, or whose translation is empty or not Hebrew', () => {
    const map = italianWordMap(input([
      { shown: 'La villa', translation: 'הווילה', word: '' },
      { shown: 'La casa', translation: 'the house', word: '' },
      { shown: 'grande', translation: '', word: '' },
      { shown: '', translation: 'גדול', word: '' },
    ]));
    expect(map).toEqual([{ start: 10, end: 15, text: 'מאוד', glossId: null, target: true }]);
  });

  it('names no gloss for an unknown key or the card\'s own', () => {
    const map = italianWordMap(input([{ shown: 'La casa', translation: 'הבית', word: 'w9' }]));
    expect(map?.[0]).toMatchObject({ text: 'הבית', glossId: null });
  });

  // Final review (phase 62): a line whose word the server could not mark would tap that word as a free word.
  it('maps nothing with no target: the practised word could not be found, so no tap is safe', () => {
    expect(italianWordMap(input([{ shown: 'La casa', translation: 'הבית', word: '' }], { target: null }))).toBeNull();
  });

  it('is null with no map asked, and the target alone with an empty one', () => {
    expect(italianWordMap(input([]))).toEqual([{ start: 10, end: 15, text: 'מאוד', glossId: null, target: true }]);
    expect(italianWordMap(input([], { entries: undefined }))).toBeNull();
  });
});

// Phase 62b. The prompt says which sentence each map is of, and how it is cut, with examples.
describe('buildContextPrompt: the map of the shown sentence (phase 62b)', () => {
  const gapItem: MarkItem = { key: 'q2', task: 'mark', word: 'fratello', meaning: 'אח', sentence: 'אחי הוא ילד טוב.', translation: 'Mio fratello è un bravo ragazzo.', map: 'translation' };
  const translateItem: MarkItem = { key: 'q3', task: 'mark', word: 'con', meaning: 'עם', sentence: 'אני הולך עם חברים.', translation: 'Vado con amici.', map: 'sentence' };
  const prompt = buildContextPrompt({ items: [bare('multiple_choice', SAW), gapItem, translateItem], from: 'it', to: 'he' });

  it('tells each item which of its sentences to map: a target line, a gap card\'s translation, a translation card\'s sentence', () => {
    const sent = JSON.parse(prompt.user);
    expect(sent.items.map((item: { key: string; map?: string }) => [item.key, item.map])).toEqual([['q1', 'context'], ['q2', 'translation'], ['q3', 'sentence']]);
  });

  it('explains the cut with examples: runs rendered together, an article with its noun, a possessive apart, a word left out, split words', () => {
    for (const example of ['ci sono', 'La casa', 'הבית', 'Mio fratello', 'שלי', 'un bravo ragazzo', 'ילד טוב', 'Studiamo', 'יש לי']) {
      expect(prompt.system).toContain(example);
    }
    expect(prompt.system).toContain('In shown, write the entry');
    expect(prompt.system).toContain('The practised word is always an entry of its own');
  });
});

describe('buildContextPrompt: the word map (phase 59 D2)', () => {
  const mapped: MarkItem = { key: 'q3', task: 'mark', word: 'con', meaning: 'עם', sentence: 'אני הולך עם חברים.', translation: 'Vado con amici.', map: 'sentence' };
  const learnerWords = [{ key: 'w1', glossId: 'g-amico', word: 'amico', meaning: 'חבר' }];

  it('asks a mapped mark item for sentence_words, and sends the learner\'s words once', () => {
    const prompt = buildContextPrompt({ items: [mapped], from: 'it', to: 'he', learnerWords });
    expect(prompt.system).toContain('sentence_words');
    const sent = JSON.parse(prompt.user);
    expect(sent.items[0]).toMatchObject({ key: 'q3', task: 'mark', map: 'sentence' });
    expect(sent.learner_words).toEqual([{ key: 'w1', word: 'amico', meaning: 'חבר' }]);
  });

  // Phase 59 follow-up: יש לי אח → Ho un fratello came back with יש and לי empty,
  // each alone rendered by nothing, so neither could be tapped.
  it('asks for one entry per run the translation renders together, such as יש לי for ho', () => {
    const prompt = buildContextPrompt({ items: [mapped], from: 'it', to: 'he', learnerWords });
    expect(prompt.system).toContain('several adjacent words that the other language renders together');
    expect(prompt.system).toContain('every word of it is in exactly one entry');
  });

  it('sends no learner words when no item is mapped', () => {
    const plain: MarkItem = { key: 'q3', task: 'mark', word: 'combine', meaning: 'לשלב', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces." };
    expect(JSON.parse(buildContextPrompt({ items: [plain], from: 'en', to: 'he', learnerWords }).user)).not.toHaveProperty('learner_words');
  });
});

describe('wordMapFor (phase 59 D2)', () => {
  const item: MarkItem = { key: 'q1', task: 'mark', word: 'con', meaning: 'עם', sentence: 'אני הולך עם חברים.', translation: 'Vado con amici.', map: 'sentence' };
  const learner = [
    { key: 'w1', glossId: 'g-amico', word: 'amico', meaning: 'חבר' },
    { key: 'w2', glossId: 'g-con', word: 'con', meaning: 'עם' },
  ];
  const words = [
    { shown: 'אני', translation: '', word: '' },
    { shown: 'הולך', translation: 'Vado', word: '' },
    { shown: 'עם', translation: 'con', word: 'w2' },
    { shown: 'חברים', translation: 'amici', word: 'w1' },
  ];
  const mark = { start: 9, end: 11 };

  it('maps each located word to its Italian, marks the target, and names a list word', () => {
    expect(wordMapFor(item, { key: 'q1', sentence_words: words }, mark, learner, 'g-con', 'it')).toEqual([
      { start: 4, end: 8, text: 'Vado', glossId: null, target: false },
      { start: 9, end: 11, text: 'con', glossId: null, target: true },
      { start: 12, end: 17, text: 'amici', glossId: 'g-amico', target: false },
    ]);
  });

  it('keeps a run of several Hebrew words rendered by one Italian word as one tappable word', () => {
    const have: MarkItem = { key: 'q1', task: 'mark', word: 'fratello', meaning: 'אח', sentence: 'יש לי אח.', translation: 'Ho un fratello.', map: 'sentence' };
    const ho = [{ key: 'w4', glossId: 'g-ho', word: 'ho', meaning: 'לבעול' }];
    expect(wordMapFor(have, { key: 'q1', sentence_words: [
      { shown: 'יש לי', translation: 'Ho', word: 'w4' },
      { shown: 'אח', translation: 'un fratello', word: '' },
    ] }, { start: 6, end: 8 }, ho, 'g-fratello', 'it')).toEqual([
      { start: 0, end: 5, text: 'Ho', glossId: 'g-ho', target: false },
      { start: 6, end: 8, text: 'un fratello', glossId: null, target: true },
    ]);
  });

  it('drops an entry whose Italian is not in the reference, or whose Hebrew is not in the sentence', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: [
      { shown: 'הולך', translation: 'andiamo', word: '' },
      { shown: 'רץ', translation: 'Vado', word: '' },
      ...words.slice(2),
    ] }, mark, learner, 'g-con', 'it');
    expect(map!.map((word) => word.text)).toEqual(['con', 'amici']);
  });

  // Victor's card of 2026-10-18: Italian writes a + il as al, so neither ליד's "è
  // vicino a" nor השולחן's "il tavolo" was in the reference, and only the target kept its tap.
  const chair: MarkItem = { key: 'q1', task: 'mark', word: 'sedia', meaning: 'כיסא', sentence: 'הכיסא ליד השולחן.', translation: 'La sedia è vicino al tavolo.', map: 'sentence' };
  const chairAt = (beside: string, table: string) => [
    { shown: 'הכיסא', translation: 'La sedia', word: '' },
    { shown: 'ליד', translation: beside, word: '' },
    { shown: 'השולחן', translation: table, word: 'w1' },
  ];
  const tavolo = [{ key: 'w1', glossId: 'g-tavolo', word: 'tavolo', meaning: 'שולחן' }];

  it('finds an entry in the reference across a preposition and an article written as one word', () => {
    expect(wordMapFor(chair, { key: 'q1', sentence_words: chairAt('è vicino a', 'il tavolo') }, { start: 0, end: 5 }, tavolo, 'g-sedia', 'it')).toEqual([
      { start: 0, end: 5, text: 'La sedia', glossId: null, target: true },
      { start: 6, end: 9, text: 'è vicino a', glossId: null, target: false },
      { start: 10, end: 16, text: 'il tavolo', glossId: 'g-tavolo', target: false },
    ]);
  });

  it('still finds an entry that writes the contraction as the reference does', () => {
    const map = wordMapFor(chair, { key: 'q1', sentence_words: chairAt('vicino', 'al tavolo') }, { start: 0, end: 5 }, tavolo, 'g-sedia', 'it');
    expect(map!.map((word) => word.text)).toEqual(['La sedia', 'vicino', 'al tavolo']);
  });

  it('splits an elided contraction from the word it joins', () => {
    const house: MarkItem = { key: 'q1', task: 'mark', word: 'casa', meaning: 'בית', sentence: 'הבית ליד המשרד.', translation: "La casa è vicino all'ufficio.", map: 'sentence' };
    const map = wordMapFor(house, { key: 'q1', sentence_words: [
      { shown: 'הבית', translation: 'La casa', word: '' },
      { shown: 'ליד', translation: 'vicino a', word: '' },
      { shown: 'המשרד', translation: "l'ufficio", word: '' },
    ] }, { start: 0, end: 4 }, [], 'g-casa', 'it');
    expect(map!.map((word) => word.text)).toEqual(['La casa', 'vicino a', "l'ufficio"]);
  });

  it('still drops an entry the reference does not hold with its contractions apart: al is a il, never a la', () => {
    const map = wordMapFor(chair, { key: 'q1', sentence_words: chairAt('vicino a', 'la tavola') }, { start: 0, end: 5 }, tavolo, 'g-sedia', 'it');
    expect(map!.map((word) => word.text)).toEqual(['La sedia', 'vicino a']);
  });

  it('reads contractions only in a language that has them', () => {
    const map = wordMapFor(chair, { key: 'q1', sentence_words: chairAt('è vicino a', 'il tavolo') }, { start: 0, end: 5 }, tavolo, 'g-sedia', 'en');
    expect(map!.map((word) => word.text)).toEqual(['La sedia']);
  });

  it('drops a non-target entry that holds the target\'s Italian, so a free tap never shows the answer', () => {
    const multi: MarkItem = { key: 'q1', task: 'mark', word: 'ci sono', meaning: 'יש', sentence: 'יש פה אנשים.', translation: 'Ci sono persone qui.', map: 'sentence' };
    const map = wordMapFor(multi, { key: 'q1', sentence_words: [
      { shown: 'יש', translation: 'Ci sono', word: '' },
      { shown: 'פה', translation: 'sono qui', word: '' },
      { shown: 'אנשים', translation: 'persone', word: '' },
    ] }, { start: 0, end: 2 }, [], 'g-ci', 'it');
    expect(map!.map((word) => [word.text, word.target])).toEqual([['Ci sono', true], ['persone', false]]);
  });

  it('with no mark, takes the entry whose Italian is the gap as the target', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: words }, null, learner, 'g-con', 'it');
    expect(map!.filter((word) => word.target)).toEqual([{ start: 9, end: 11, text: 'con', glossId: null, target: true }]);
  });

  it('with no mark, takes an entry whose Italian holds the gap with its article as the target', () => {
    const have: MarkItem = { key: 'q1', task: 'mark', word: 'fratello', meaning: 'אח', sentence: 'יש לי אח.', translation: 'Ho un fratello.', map: 'sentence' };
    const map = wordMapFor(have, { key: 'q1', sentence_words: [
      { shown: 'יש לי', translation: 'Ho', word: '' },
      { shown: 'אח', translation: 'un fratello', word: '' },
    ] }, null, [], 'g-fratello', 'it');
    expect(map).toEqual([
      { start: 0, end: 5, text: 'Ho', glossId: null, target: false },
      { start: 6, end: 8, text: 'un fratello', glossId: null, target: true },
    ]);
  });

  it('adds the mark as the target when no entry covers it', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: [words[1], words[3]] }, mark, learner, 'g-con', 'it');
    expect(map).toEqual([
      { start: 4, end: 8, text: 'Vado', glossId: null, target: false },
      { start: 9, end: 11, text: 'con', glossId: null, target: true },
      { start: 12, end: 17, text: 'amici', glossId: 'g-amico', target: false },
    ]);
  });

  it('names no gloss for an unknown key or the card\'s own gloss, and keeps the word free', () => {
    const map = wordMapFor(item, { key: 'q1', sentence_words: [
      { shown: 'הולך', translation: 'Vado', word: 'w9' },
      { shown: 'חברים', translation: 'amici', word: 'w2' },
    ] }, mark, learner, 'g-con', 'it');
    expect(map!.filter((word) => !word.target).map((word) => word.glossId)).toEqual([null, null]);
  });

  it('is null with no map, an unmapped item, or nothing usable', () => {
    expect(wordMapFor(item, { key: 'q1' }, mark, learner, 'g-con', 'it')).toBeNull();
    expect(wordMapFor(item, undefined, mark, learner, 'g-con', 'it')).toBeNull();
    expect(wordMapFor({ ...item, map: undefined }, { key: 'q1', sentence_words: words }, mark, learner, 'g-con', 'it')).toBeNull();
    expect(wordMapFor(item, { key: 'q1', sentence_words: [{ shown: 'רץ', translation: 'x', word: '' }] }, null, learner, 'g-con', 'it')).toBeNull();
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
