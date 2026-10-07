import type { TypedTranslationQuestion, TypedVerdict } from '../api/types';

/**
 * Phase 23. How a typed answer is judged (spec D5). Pure, and shared on
 * purpose: the app runs it for instant feedback, the server runs it again for
 * the verdict it stores, and one function over the same data cannot disagree.
 */

// One leading word a learner may add or drop: an English or Italian article,
// or the English infinitive marker. Language-agnostic, because a false accept
// ("a casa" for "casa") costs nothing and knowing the language costs a field.
const LEADING = new Set(['to', 'a', 'an', 'the', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una']);
const ELIDED = ["l'", "un'"];

// Below five letters one edit is too often another word (bat/bad): phase 20's
// floor.
const NEAR_MISS_MIN_LETTERS = 5;

/** What two answers are compared as: NFC, the typographic apostrophes folded,
 *  Cyrillic stress removed (a reading aid, not spelling), lowercase, single
 *  spaces, no trailing sentence mark. A Latin accent survives: it is spelling. */
export function normaliseTyped(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[’‘ʼ]/gu, "'")
    .replace(/(\p{Script=Cyrillic})́/gu, '$1')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s.,;:!?…]+$/u, '');
}

/** The text without one leading article or "to", when anything is left. */
function bare(text: string): string {
  const space = text.indexOf(' ');
  if (space > 0 && LEADING.has(text.slice(0, space))) return text.slice(space + 1);
  for (const prefix of ELIDED) {
    if (text.startsWith(prefix) && text.length > prefix.length) return text.slice(prefix.length);
  }
  return text;
}

const same = (a: string, b: string) => a === b || bare(a) === bare(b);

/** Without diacritics: `perché` → `perche`, `ёлка` → `елка`. The breve stays:
 *  й is its own letter, not a marked и, so `мои` is another word than `мой`. */
const undotted = (text: string) =>
  text
    .normalize('NFD')
    .replace(/(?!\u0306)\p{M}/gu, '')
    .normalize('NFC');

/** An accent written the ASCII way, as a mark after the vowel at a word's end
 *  (`piu'`, `perche'`), read as no accent: never worse than leaving it out. */
const markAsAccent = (text: string) => text.replace(/([aeiou])['´`](?=\s|$)/gu, '$1');

/** True when at most one edit turns `a` into `b`: an insertion, a deletion, a
 *  substitution, or a swap of two neighbouring letters (optimal string
 *  alignment distance). */
function oneEditApart(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > 1) return false;
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[x.length][y.length] <= 1;
}

const letterCount = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

function nearMiss(typed: string, target: string): boolean {
  const t = bare(typed);
  const w = bare(target);
  if (undotted(markAsAccent(t)) === undotted(w)) return true;
  return letterCount(w) >= NEAR_MISS_MIN_LETTERS && oneEditApart(t, w);
}

/**
 * - `exact`: the saved form or its lemma. The phase practises words, not
 *   inflection, so `parlare` is right for a saved `parlo`.
 * - `alternative`: another word the model said translates the prompt equally
 *   well. Right, but not this word. Checked before a near miss, so a real
 *   synonym is never reported as a typo.
 * - `near_miss`: the form or lemma with only its diacritics different, or one
 *   edit away on a word of five letters or more.
 * - `wrong`: anything else, including nothing.
 */
export function judgeTyped(question: TypedTranslationQuestion, text: string): TypedVerdict {
  const typed = normaliseTyped(text);
  if (typed === '') return 'wrong';
  const targets = [...new Set([question.answer, question.lemma].map(normaliseTyped))];
  if (targets.some((target) => same(typed, target))) return 'exact';
  if (question.alternatives.map(normaliseTyped).some((alternative) => same(typed, alternative))) {
    return 'alternative';
  }
  if (targets.some((target) => nearMiss(typed, target))) return 'near_miss';
  return 'wrong';
}
