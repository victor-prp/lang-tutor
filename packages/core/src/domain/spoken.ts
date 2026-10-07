import type { SpeechVerdict } from '../api/types';
import { LEADING_WORDS, foldDiacritics, normaliseTyped } from './typed';

/**
 * Phase 25 (spec D6). How a transcript is judged against a speaking card.
 * Pure and shared, as judgeTyped is: the server judges with it, and the app
 * runs it on the transcript the server returned to word its banner, so the two
 * cannot disagree.
 */

/** Spec D3. The longest saved item a speaking card asks for: a phrase of four
 *  words. Longer is a sentence, which is Out. */
export const MAX_SPOKEN_WORDS = 4;

// An Italian elision a learner may say or drop: `l'acqua` is the word `acqua`.
// A closed list, so an English contraction (`don't`) stays whole.
const ELISIONS = ["l'", "un'", "dell'", "nell'", "all'", "dall'", "sull'", "quell'"];

function dropElision(word: string): string {
  const prefix = ELISIONS.find((elision) => word.startsWith(elision) && word.length > elision.length);
  return prefix ? word.slice(prefix.length) : word;
}

/** The words of a transcript or a target, as the judge compares them: typed
 *  normalising, diacritics folded (the breve kept), split on anything but a
 *  letter or an apostrophe, and an Italian elision dropped from each word. */
export function spokenWords(text: string): string[] {
  return foldDiacritics(normaliseTyped(text))
    .split(/[^\p{L}']+/u)
    .map((word) => word.replace(/^'+|'+$/gu, ''))
    .map(dropElision)
    .filter((word) => word !== '');
}

/** Whether `run` appears in `words` in order and side by side. */
function containsRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return false;
  for (let start = 0; start + run.length <= words.length; start++) {
    if (run.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/** A form's runs to look for: its words, and without a leading article or
 *  "to" when words remain, so a saved `il gatto` is found in `gatto`. */
function runsOf(form: string): string[][] {
  const words = spokenWords(form);
  return words.length > 1 && LEADING_WORDS.has(words[0]) ? [words, words.slice(1)] : [words];
}

/** What a transcript is judged against: the forms that are this word, and
 *  other words that are right but not this one (phase 23 D5). */
export type SpokenTarget = { forms: readonly string[]; alternatives: readonly string[] };

/**
 * - `understood`: one of the forms is among the heard words.
 * - `alternative`: one of the alternatives is. Checked after the forms.
 * - `unheard`: anything else, a near miss and silence included. It is never
 *   recorded (spec D5).
 */
export function judgeSpoken(target: SpokenTarget, heard: string): SpeechVerdict {
  const words = spokenWords(heard);
  const found = (forms: readonly string[]) => forms.some((form) => runsOf(form).some((run) => containsRun(words, run)));
  if (found(target.forms)) return 'understood';
  if (found(target.alternatives)) return 'alternative';
  return 'unheard';
}

/** Spec D3. Whether a saved form can be a speaking card: one to four words. */
export function speakable(form: string): boolean {
  const count = spokenWords(form).length;
  return count >= 1 && count <= MAX_SPOKEN_WORDS;
}
