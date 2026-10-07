import { normaliseHebrew, normaliseTyped } from '@lang-tutor/core/domain';

import { findGap } from './cloze';
import { LANGUAGES, type LanguageCode } from './languages';

/**
 * Phase 27 (spec D5, D6). Whether what the model wrote for a sentence card is
 * usable. Pure (ADR 0001 R3). Never a refusal: a reason here degrades one card
 * to a typed translation, and services/sessions.ts logs it.
 */

/** Spec D5: a gap sentence stays short enough to read at a glance. */
export const SENTENCE_MAX_WORDS = 12;
/** Spec D6: a sentence to translate stays short enough to translate in one go. */
export const TRANSLATE_MAX_WORDS = 10;
/** Spec D5, D6: below three words there is no context for the word. */
export const SENTENCE_MIN_WORDS = 3;
/** Spec D5, D6: how many recent sentences a prompt is told to avoid, per sense and card. */
export const MAX_AVOID = 3;
/** The most alternatives a typed or gap card keeps (questions_shape_valid; spec D5). */
export const MAX_ALTERNATIVES = 5;

/** Spec D5: a gap's size is the saved form's, so a one-word form never gets a compound tense. */
export function wordCount(text: string): number {
  return text.split(/\s+/u).filter((token) => /\p{L}/u.test(token)).length;
}

/** Spec D5: what a valid gap sentence card stores. */
export type SentenceContent = {
  sentence: string;
  translation: string;
  gap: { start: number; end: number };
  alternatives: string[];
};

/** Spec D6: what a valid translation card stores. */
export type TranslateContent = { hebrew: string; reference: string; gap: { start: number; end: number } };

type Input = { form: string; target: LanguageCode; avoid: readonly string[] };
type Found = { sentence?: string; gap?: string; translation?: string; alternatives?: string[] };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Spec D5, D6: a script test as the validators read it; Hebrew is the explanation language. */
const hasHebrew = (text: string): boolean => LANGUAGES.he.letters.test(text);

/** Spec D5: the sentence the model wrote for a gap card, its gap located and checked. */
export function validateSentenceItem(
  input: Input,
  found: Found,
): { ok: true; content: SentenceContent } | { ok: false; reason: string } {
  const sentence = found.sentence?.trim();
  const gap = found.gap?.trim();
  const translation = found.translation?.trim();
  if (!sentence || !gap || !translation) return fail('the sentence, its gap or its translation is missing');

  const words = wordCount(sentence);
  if (words < SENTENCE_MIN_WORDS || words > SENTENCE_MAX_WORDS) return fail(`the sentence has ${words} words`);

  if (hasHebrew(sentence) || !LANGUAGES[input.target].letters.test(sentence)) {
    return fail(`the sentence is not written in ${LANGUAGES[input.target].name}`);
  }
  if (!hasHebrew(translation)) return fail('the translation is not in Hebrew');

  if (wordCount(gap) !== wordCount(input.form)) return fail(`the gap "${gap}" has not as many words as ${input.form}`);
  const where = findGap(sentence, [gap]);
  if (!where) return fail(`the gap "${gap}" is not in the sentence exactly once`);

  if (input.avoid.some((old) => normaliseTyped(old) === normaliseTyped(sentence))) {
    return fail('the sentence repeats one it was told to avoid');
  }

  // Alternatives only widen what the card accepts, so a bad one is dropped, not a refusal.
  const gapText = normaliseTyped(sentence.slice(where.start, where.end));
  const seen = new Set([gapText]);
  const alternatives: string[] = [];
  for (const raw of found.alternatives ?? []) {
    const text = raw.trim();
    const key = normaliseTyped(text);
    if (text === '' || hasHebrew(text) || seen.has(key)) continue;
    seen.add(key);
    alternatives.push(text);
    if (alternatives.length === MAX_ALTERNATIVES) break;
  }
  return { ok: true, content: { sentence, translation, gap: where, alternatives } };
}

/** Spec D6: the Hebrew sentence the model wrote for a translation card, and the reference that holds the word. */
export function validateTranslateItem(
  input: Input,
  found: Found,
): { ok: true; content: TranslateContent } | { ok: false; reason: string } {
  const hebrew = found.sentence?.trim();
  const reference = found.translation?.trim();
  const gap = found.gap?.trim();
  if (!hebrew || !reference || !gap) return fail('the sentence, its translation or its gap is missing');

  const words = wordCount(hebrew);
  if (words < SENTENCE_MIN_WORDS || words > TRANSLATE_MAX_WORDS) return fail(`the Hebrew sentence has ${words} words`);

  if (!hasHebrew(hebrew) || LANGUAGES[input.target].letters.test(hebrew)) {
    return fail('the sentence to translate is not only Hebrew');
  }
  if (hasHebrew(reference)) return fail('the reference translation has Hebrew in it');

  if (wordCount(gap) !== wordCount(input.form)) return fail(`the gap "${gap}" has not as many words as ${input.form}`);
  const where = findGap(reference, [gap]);
  if (!where) return fail(`the gap "${gap}" is not in the reference exactly once`);

  if (input.avoid.some((old) => normaliseHebrew(old) === normaliseHebrew(hebrew))) {
    return fail('the sentence repeats one it was told to avoid');
  }
  return { ok: true, content: { hebrew, reference, gap: where } };
}
