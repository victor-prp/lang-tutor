import { describe, expect, it } from '@jest/globals';

import {
  CHECK_MARKER,
  buildCheckPrompt,
  contextKeyOf,
  meaningFits,
  parseCheck,
  readCheck,
  translationUses,
  wordsFit,
  wrongOnly,
  type CheckItem,
} from './check';
import { CONTEXT_MARKER } from './context';
import { DISTRACTOR_MARKER } from './distractors';

// Phase 34 (spec D5). The checker's prompt, its parse, and what each answer
// means for a card. The audit's cards: 3c482348 (blow up), a7d6bdb4 and
// 71b0b407 (saw), d388f738 (להוריד), eb95d246 (בואו נשלב כוחות).
const ITEMS: CheckItem[] = [
  { key: 'q1', task: 'choice', word: 'blow up', options: ['להרוס', 'לקפל', 'לשבור'] },
  { key: 'q2', task: 'gap', sentence: 'She ___ the door and walked in.', options: ['unlocked', 'ate', 'slept'] },
  { key: 'q1c', task: 'meaning', sentence: 'Please saw the plank in half.', word: 'saw', candidates: ['לנסר', 'מסור', 'ראה'] },
  { key: 'q3c', task: 'words', sentence: 'אני רוצה להוריד את המשחק החדש הלילה.', word: 'להוריד' },
  { key: 'q4', task: 'translate', sentence: 'בואו נשלב כוחות.' },
];

describe('buildCheckPrompt', () => {
  const prompt = buildCheckPrompt(ITEMS, 'en', 'he');

  it('carries its own marker, which no other call’s prompt carries', () => {
    expect(prompt.system).toContain(CHECK_MARKER);
    expect(prompt.system).not.toContain(DISTRACTOR_MARKER);
    expect(prompt.system).not.toContain(CONTEXT_MARKER);
    expect(prompt.system).toContain('English');
    expect(prompt.system).toContain('Hebrew');
  });

  it('sends each item what its task needs, and never the right answer', () => {
    expect(JSON.parse(prompt.user).items).toEqual([
      { key: 'q1', task: 'choice', word: 'blow up', options: ['להרוס', 'לקפל', 'לשבור'] },
      { key: 'q2', task: 'gap', sentence: 'She ___ the door and walked in.', options: ['unlocked', 'ate', 'slept'] },
      { key: 'q1c', task: 'meaning', sentence: 'Please saw the plank in half.', word: 'saw', candidates: ['לנסר', 'מסור', 'ראה'] },
      { key: 'q3c', task: 'words', sentence: 'אני רוצה להוריד את המשחק החדש הלילה.', word: 'להוריד' },
      { key: 'q4', task: 'translate', sentence: 'בואו נשלב כוחות.' },
    ]);
  });

  it('keys a context beside its card', () => {
    expect(contextKeyOf('q7')).toBe('q7c');
  });
});

describe('parseCheck and readCheck', () => {
  const full = {
    items: [
      { key: 'q1', options: [true, false, false] },
      { key: 'q2', gap_fits: [true, false, false] },
      { key: 'q1c', context_meaning: ' לנסר ' },
      { key: 'q3c', context_words: ['download', ' ', 'get'] },
      { key: 'q4', natural_translation: "Let's join forces." },
    ],
  };

  it('reads every item, a null field as none and a fenced answer as JSON', () => {
    const parsed = parseCheck('```json\n' + JSON.stringify({ items: [...full.items, { key: 'q9', options: null }] }) + '\n```');
    expect(parsed).not.toBeNull();
    const reading = readCheck(ITEMS, parsed!);
    expect([...reading.byKey]).toEqual([
      ['q1', { task: 'choice', alsoRight: [true, false, false] }],
      ['q2', { task: 'gap', alsoRight: [true, false, false] }],
      ['q1c', { task: 'meaning', meaning: 'לנסר' }],
      ['q3c', { task: 'words', words: ['download', 'get'] }],
      ['q4', { task: 'translate', translation: "Let's join forces." }],
    ]);
  });

  it('is unreadable when it is not JSON or not the schema', () => {
    expect(parseCheck('nope')).toBeNull();
    expect(parseCheck(JSON.stringify({ items: [{ options: [true] }] }))).toBeNull();
    expect(parseCheck(JSON.stringify({ items: [{ key: 'q1', options: ['yes'] }] }))).toBeNull();
  });

  // Which option a "yes" belongs to could only be guessed.
  it('refuses a choice or gap answer that does not say, option by option, which are right', () => {
    const without = (key: string, over: object) => ({ items: full.items.map((item) => (item.key === key ? { key, ...over } : item)) });
    for (const [key, answer] of [['q1', without('q1', {})], ['q1', without('q1', { options: [true, false] })], ['q2', without('q2', { gap_fits: [false, false, false, true] })], ['q2', without('q2', { options: [false, false, false] })]] as const) {
      const reading = readCheck(ITEMS, answer);
      expect(reading.unjudged.has(key)).toBe(true);
      expect(reading.byKey.has(key)).toBe(false);
    }
    expect(readCheck(ITEMS, without('q1', {})).unjudged.get('q1')).toBe("the checker did not say which of q1's 3 options are right");
  });

  it('phase 48 (spec D2): a miscounted item is unjudged and every other item is still read', () => {
    const reading = readCheck(ITEMS, { items: full.items.map((item) => (item.key === 'q1' ? { key: 'q1', options: [true, false] } : item)) });
    expect([...reading.unjudged.keys()]).toEqual(['q1']);
    expect([...reading.byKey.keys()]).toEqual(['q2', 'q1c', 'q3c', 'q4']);
    expect(reading.byKey.get('q2')).toEqual({ task: 'gap', alsoRight: [true, false, false] });
  });

  it('reads a context or sentence the checker left out as an empty answer, which the rules then refuse', () => {
    const reading = readCheck(ITEMS, { items: full.items.filter((item) => item.key === 'q1' || item.key === 'q2') });
    expect(reading.byKey.get('q1c')).toEqual({ task: 'meaning', meaning: '' });
    expect(reading.byKey.get('q3c')).toEqual({ task: 'words', words: [] });
    expect(reading.byKey.get('q4')).toEqual({ task: 'translate', translation: '' });
    expect(meaningFits('', ['לנסר'])).toBe(false);
    expect(wordsFit([], { answer: 'download', lemma: 'download', alternatives: [] })).toBe(false);
    expect(translationUses('', ['combine'])).toBe(false);
  });

  it('takes the first of two answers for one key', () => {
    const reading = readCheck(ITEMS, { items: [{ key: 'q1', options: [false, false, false] }, { key: 'q1', options: [true, true, true] }, ...full.items.slice(1)] });
    expect(reading.byKey.get('q1')).toEqual({ task: 'choice', alsoRight: [false, false, false] });
  });
});

describe('what the answers mean for a card', () => {
  it('category A (3c482348): a "yes" drops להרוס from blow up’s options and keeps the rest in order', () => {
    expect(wrongOnly(['להרוס', 'לקפל', 'לשבור', 'לצבוע'], [true, false, false, false])).toEqual(['לקפל', 'לשבור', 'לצבוע']);
  });

  it('keeps a target-language context whose marked word the checker reads as one of the gloss’s meanings', () => {
    const saw = ['לנסר', 'ניסר'];
    expect(meaningFits('לנסר', saw)).toBe(true);
    expect(meaningFits('לְנַסֵּר.', saw)).toBe(true);
    expect(meaningFits('לחתוך, לנסר', saw)).toBe(true);
    // 71b0b407: the past of see is another word's meaning.
    expect(meaningFits('ראה', saw)).toBe(false);
    expect(meaningFits('לראות / לחזות', saw)).toBe(false);
  });

  it('keeps a Hebrew context only when a word the checker reads in it is one the card accepts', () => {
    const card = { answer: 'download', lemma: 'download', alternatives: ['get'] };
    // d388f738: להוריד the file is download; להוריד the volume is not.
    expect(wordsFit(['download'], card)).toBe(true);
    expect(wordsFit(['to download'], card)).toBe(true);
    expect(wordsFit(['fetch', 'get'], card)).toBe(true);
    expect(wordsFit(['lower', 'turn down'], card)).toBe(false);
  });

  it('category F (eb95d246): בואו נשלב כוחות read as "Let\'s join forces" does not use combine', () => {
    expect(translationUses("Let's join forces.", ['combine', 'combine', 'combine'])).toBe(false);
    expect(translationUses("Let's combine forces.", ['combine'])).toBe(true);
    // An accepted answer counts as the practised word does.
    expect(translationUses("Let's join forces.", ['combine', 'join forces'])).toBe(true);
  });

  it('finds the practised word inflected, as a phrase, and without its leading article or "to"', () => {
    expect(translationUses('They combined their forces.', ['combine'])).toBe(true);
    expect(translationUses('He picked up the phone.', ['pick up'])).toBe(true);
    expect(translationUses('I need to download it.', ['to download'])).toBe(true);
    expect(translationUses('Ho un cane.', ['il cane'])).toBe(true);
    // Whole words, in order: neither a stem of another word nor the words apart.
    expect(translationUses('The article was long.', ['art'])).toBe(false);
    expect(translationUses('He picked the phone up.', ['pick up'])).toBe(false);
    expect(translationUses('I hope things get better soon.', ['pick up', 'improve'])).toBe(false);
  });

  // Review, fix round 1: an Italian article or preposition elides onto a
  // vowel-initial word, and the word is still the word.
  it('finds a word behind an elided article or preposition, as the translation and as the candidate', () => {
    expect(translationUses("Bevo l'acqua ogni mattina.", ['acqua'])).toBe(true);
    expect(translationUses("Bevo l'acqua ogni mattina.", ["l'acqua"])).toBe(true);
    expect(translationUses("È l'ora di andare.", ['ora'])).toBe(true);
    expect(translationUses("Vado all'università domani.", ['università'])).toBe(true);
    // A typographic apostrophe is the same mark.
    expect(translationUses('Vado all’università domani.', ['università'])).toBe(true);
    // The article is split off, not the word: l'acquerello holds no acqua.
    expect(translationUses("Guardo l'acquerello.", ['acqua'])).toBe(false);
  });
});
