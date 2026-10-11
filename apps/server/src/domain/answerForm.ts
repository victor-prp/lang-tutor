import { normaliseTyped, withoutLeadingWord } from '@lang-tutor/core/domain';

/**
 * Phase 34 (spec D2, ruling R6). The accept job stores, per rendering, the form
 * of the headword that agrees with it (`ore` for שעות). It is a model's word,
 * and a card that asks for it must be asking for the card's own word, so a stored
 * form is used only when it is plausibly a form of that word. Pure (ADR 0001 R3).
 */

/** Letters two words must share at their start to be forms of one word. A word
 *  of three letters needs two (`ora`, `ore`): its ending is the inflection. */
const SHARED_PREFIX = 3;
const SHORT_WORD_PREFIX = 2;

const wordsOf = (text: string): string[] => normaliseTyped(text).split(/[^\p{L}]+/u).filter((word) => word !== '');

function sharedPrefix(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let count = 0;
  while (count < x.length && count < y.length && x[count] === y[count]) count++;
  return count;
}

/** True when the words begin alike for SHARED_PREFIX letters; the shorter of
 *  the two may need fewer (all but its last letter), never fewer than two. */
function agree(a: string, b: string): boolean {
  const shorter = Math.min([...a].length, [...b].length);
  return sharedPrefix(a, b) >= Math.max(SHORT_WORD_PREFIX, Math.min(SHARED_PREFIX, shorter - 1));
}

/**
 * The form a card asks for in place of `form`, or null when it asks for `form`
 * (nothing stored, the same word, or a word that is not a form of this one).
 * The stored text loses one leading article or "to" the way the typed judge
 * reads it, so `le ore` asks for `ore` and `to blow up` for `blow up`; what is
 * left keeps its case. It is plausible when some word of it begins like some
 * word of the lemma or of the form (`ore`/`ora`, `libri`/`libro`); a suppletive
 * or irregular form (`ho` for `avere`) fails the test and the card falls back
 * to the form, which the judge's lemma rule still accepts.
 */
export function usableAnswerForm(stored: string | null, form: string, lemma: string): string | null {
  const collapsed = (stored ?? '').normalize('NFC').replace(/[’‘ʼ]/gu, "'").replace(/\s+/gu, ' ').trim();
  if (collapsed === '') return null;
  const lowered = normaliseTyped(collapsed);
  const bare = withoutLeadingWord(lowered);
  // The stripped text is a suffix of the collapsed one: only a leading word went.
  const asked = bare.length < lowered.length ? collapsed.slice(collapsed.length - bare.length) : collapsed;
  if (bare === withoutLeadingWord(normaliseTyped(form))) return null;
  const words = wordsOf(asked);
  const known = [...wordsOf(lemma), ...wordsOf(form)];
  return words.some((word) => known.some((other) => agree(word, other))) ? asked : null;
}
