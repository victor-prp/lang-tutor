/**
 * Phase 34 (spec D6, D8). Where the word a card marks sits in its sentence.
 * The model names the word as text and this finds it, best effort: a Hebrew
 * verb inflects (הורידה for להוריד), and a word it cannot find leaves the
 * sentence shown unmarked, never dropped. Pure (ADR 0001 R3).
 *
 * Offsets are JavaScript string indices, [start, end), as GapSchema's are. The
 * column check (questions_marks_valid) counts characters, which agree with
 * UTF-16 units inside the basic plane only, so a sentence with a character
 * beyond it gets no mark.
 */

export type Mark = { start: number; end: number };

// Letters, marks and digits are word characters in any script, as in findGap.
const WORD = '[\\p{L}\\p{M}\\p{N}]';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Hebrew points and cantillation (not the maqaf, which separates words), and a
 *  stress mark after a Cyrillic letter: reading aids, not spelling. */
const HEBREW_POINT = /[֑-ֽֿ-ׇ]/u;
const STRESS = '́';
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** The one-letter prefixes a Hebrew word takes: ו ה ב כ ל מ ש. */
const HEBREW_PREFIX = '[והבכלמש]';
const HEBREW = /\p{Script=Hebrew}/u;

const ASTRAL = /[\u{10000}-\u{10FFFF}]/u;

/** The text without what this ignores, and where each kept unit came from. */
function strip(text: string): { plain: string; from: number[] } {
  let plain = '';
  const from: number[] = [];
  for (let at = 0; at < text.length; at++) {
    const unit = text[at];
    if (HEBREW_POINT.test(unit)) continue;
    if (unit === STRESS && at > 0 && CYRILLIC.test(text[at - 1])) continue;
    plain += unit;
    from.push(at);
  }
  return { plain, from };
}

/** Every place `word` occurs in `sentence` as whole words, ignoring case,
 *  niqqud and stress; when it occurs nowhere as written, every place it occurs
 *  behind a one-letter Hebrew prefix, which the mark then includes. */
export function findMarks(sentence: string, word: string): Mark[] {
  const words = strip(word).plain.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0 || ASTRAL.test(sentence)) return [];
  const { plain, from } = strip(sentence);
  const kept = new Set(from);
  const body = words.map(escape).join('\\s+');
  const search = (prefix: string): Mark[] =>
    [...plain.matchAll(new RegExp(`(?<!${WORD})${prefix}${body}(?!${WORD})`, 'giu'))].map((found) => {
      const start = from[found.index!];
      let end = from[found.index! + found[0].length - 1] + 1;
      // The points (or stress) of the last letter belong to it.
      while (end < sentence.length && !kept.has(end)) end++;
      return { start, end };
    });
  const exact = search('');
  if (exact.length > 0 || !HEBREW.test(words[0])) return exact;
  return search(HEBREW_PREFIX);
}

/** The one place to mark, or null when the word is absent or occurs more than
 *  once (which one is meant would be a guess). */
export function findMark(sentence: string, word: string): Mark | null {
  const found = findMarks(sentence, word);
  return found.length === 1 ? found[0] : null;
}
