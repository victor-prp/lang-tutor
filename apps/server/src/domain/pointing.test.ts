import { describe, expect, it } from '@jest/globals';

import { CHECK_MARKER } from './check';
import { CONTEXT_MARKER } from './context';
import { DISTRACTOR_MARKER } from './distractors';
import { POINT_MARKER, POINT_READERS, buildPointPrompt, judgePoint, parsePoint, pointItem, readPoint, type PointFinding, type PointTarget } from './pointing';

// Phase 62d (spec D2). The blind reader of a typed gap: its prompt, its parse,
// and whether its guess means the sentence points to its word. Lane 0's
// 2026-10-18 cards: "Il cielo è qui." (alternatives tavolo, fratello, pesce…).
const CIELO: PointTarget = { word: { answer: 'cielo', lemma: 'cielo', alternatives: ['Cielo'] }, meanings: ['שמיים'] };
const finding = (guesses: string[], meaning: string, readers = 8): PointFinding => ({ guesses, meaning, readers });

describe('pointItem', () => {
  it('blanks the gap the sentence card stores', () => {
    const sentence = { sentence: 'Il cielo è qui.', translation: 'השמיים כאן.', gap: { start: 3, end: 8 }, alternatives: ['tavolo'] };
    expect(pointItem('q3', sentence)).toEqual({ key: 'q3', sentence: 'Il ___ è qui.' });
  });
});

describe('buildPointPrompt', () => {
  const prompt = buildPointPrompt([{ key: 'q3', sentence: 'Il ___ è qui.' }], 'it', 'he');

  it('carries its own marker, which no other call’s prompt carries', () => {
    expect(prompt.system).toContain(POINT_MARKER);
    for (const other of [CHECK_MARKER, CONTEXT_MARKER, DISTRACTOR_MARKER]) expect(prompt.system).not.toContain(other);
    expect(prompt.system).toContain('Italian');
    expect(prompt.system).toContain('Hebrew');
  });

  it('is blind: each item is its key and its gapped sentence, never the word', () => {
    expect(JSON.parse(prompt.user)).toEqual({ items: [{ key: 'q3', sentence: 'Il ___ è qui.' }] });
  });
});

describe('parsePoint', () => {
  it('reads a fenced answer', () => {
    const raw = '```json\n{"items":[{"key":"q3","guesses":[{"word":"tavolo","readers":2}],"meaning":"שולחן"}]}\n```';
    expect(parsePoint(raw)).toEqual({ items: [{ key: 'q3', guesses: [{ word: 'tavolo', readers: 2 }], meaning: 'שולחן' }] });
  });

  it('is null for an answer that is not JSON, or whose guesses leave out readers', () => {
    expect(parsePoint('not json')).toBeNull();
    expect(parsePoint('{"items":[{"key":"q3","guesses":[{"word":"tavolo"}],"meaning":"שולחן"}]}')).toBeNull();
  });
});

describe('readPoint', () => {
  const items = [{ key: 'q3', sentence: 'Il ___ è qui.' }];

  it('keeps the first answer of a key, drops a key nobody asked, and trims the guesses', () => {
    const read = readPoint(items, {
      items: [
        { key: 'q3', guesses: [{ word: ' ', readers: 5 }, { word: ' cielo ', readers: 7 }, { word: 'mare', readers: 2 }], meaning: ' שמיים ' },
        { key: 'q3', guesses: [{ word: 'tavolo', readers: 1 }], meaning: 'שולחן' },
        { key: 'q9', guesses: [{ word: 'gatto', readers: 9 }], meaning: 'חתול' },
      ],
    });
    expect([...read.keys()]).toEqual(['q3']);
    expect(read.get('q3')).toEqual({ guesses: ['cielo', 'mare'], meaning: 'שמיים', readers: 7 });
  });

  it('leaves an unanswered key out, and reads no guesses as no readers', () => {
    expect(readPoint(items, { items: [] }).size).toBe(0);
    expect(readPoint(items, { items: [{ key: 'q3', guesses: [], meaning: '' }] }).get('q3')).toEqual({ guesses: [], meaning: '', readers: 0 });
  });
});

describe('judgePoint', () => {
  it('passes a first guess that is the word, at POINT_READERS of ten', () => {
    expect(judgePoint(finding(['cielo', 'mare', 'sole'], 'שמיים', POINT_READERS), CIELO)).toEqual({ points: true });
  });

  it('fails a first guess that is the word when fewer than POINT_READERS of ten would write it, naming the others', () => {
    const verdict = judgePoint(finding(['cielo', 'mare', 'sole'], 'שמיים', POINT_READERS - 1), CIELO);
    expect(verdict.points).toBe(false);
    if (verdict.points) return;
    expect(verdict.fits).toEqual(['mare', 'sole']);
    expect(verdict.problem).toBe(`only ${POINT_READERS - 1} of ten readers who cover the word would write it; the others would write mare, sole`);
  });

  it('fails a first guess that is another word, and names it', () => {
    const verdict = judgePoint(finding(['tavolo', 'libro', 'gatto'], 'שולחן'), CIELO);
    expect(verdict.points).toBe(false);
    if (verdict.points) return;
    expect(verdict.fits).toEqual(['tavolo', 'libro', 'gatto']);
    expect(verdict.problem).toBe('a reader who covers the word guesses tavolo first (tavolo, libro, gatto)');
  });

  it('passes a first guess of the same meaning', () => {
    expect(judgePoint(finding(['firmamento', 'mare'], 'שמיים'), CIELO)).toEqual({ points: true });
  });

  it('fails a reader who guessed nothing', () => {
    expect(judgePoint(finding([], ''), CIELO).points).toBe(false);
  });

  it('never counts a word only the card’s generated alternatives would accept', () => {
    // judgePoint is given the word's own forms; "tavolo" from "Il cielo è qui."'s alternatives is not one.
    expect(judgePoint(finding(['tavolo'], 'שולחן'), CIELO).points).toBe(false);
  });

  it('reads a capitalised saved form and a word of two words as the word', () => {
    const treno: PointTarget = { word: { answer: 'Treno', lemma: 'treno', alternatives: [] }, meanings: ['רכבת'] };
    expect(judgePoint(finding(['treno', 'autobus'], 'רכבת'), treno)).toEqual({ points: true });
    const ciSono: PointTarget = { word: { answer: 'ci sono', lemma: 'esserci', alternatives: [] }, meanings: ['יש'] };
    expect(judgePoint(finding(['ci sono'], 'יש'), ciSono)).toEqual({ points: true });
  });
});
