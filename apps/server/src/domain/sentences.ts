import { normaliseHebrew, normaliseTyped } from '@lang-tutor/core/domain';

import { findGap } from './cloze';
import { LANGUAGES, type LanguageCode } from './languages';

/**
 * Phase 27 (spec D5, D6). Whether what the model wrote for a sentence card is
 * usable. Pure (ADR 0001 R3). Never a refusal: a reason here degrades one card
 * to a typed translation, and services/sessions.ts logs it.
 */

/** Spec D5: a gap sentence stays short enough to read at a glance. Phase 62: now
 *  the Hebrew context line's alone (domain/context.ts's `explanation` task). */
export const SENTENCE_MAX_WORDS = 12;
/** Phase 62 (spec D1). A target-language gap sentence or context line: short, so
 *  that its other words can come from the learner's list. Ruling R5: eight, not
 *  the six first planned: at six the sentences stopped pointing to their word
 *  ("La ___ è verde."), and pointing comes first (the evals, 2026-10-17). */
export const SHORT_SENTENCE_MAX_WORDS = 8;
/** Phase 62 (spec D1, ruling R5). The fewest words a short sentence is asked for:
 *  three words rarely point to the word. Validation still keeps three. */
export const SHORT_SENTENCE_MIN_ASKED = 4;
/** Spec D6: a sentence to translate stays short enough to translate in one go.
 *  Phase 59 (spec D1): five, so that its other words can come from the learner's list. */
export const TRANSLATE_MAX_WORDS = 5;
/** Phase 59 (spec D1). The most practised words a prompt is sent, the most recently reviewed. */
export const MAX_LEARNER_WORDS = 200;
/** Spec D5, D6: below three words there is no context for the word. */
export const SENTENCE_MIN_WORDS = 3;
/** Spec D5, D6: how many recent sentences a prompt is told to avoid, per sense and card. */
export const MAX_AVOID = 3;
/** The most alternatives the typed task asks for. A typed or spoken translation card
 *  keeps up to MAX_CARD_ALTERNATIVES (phase 34, spec D1). */
export const MAX_ALTERNATIVES = 5;
/** Phase 38 (spec D2). The most alternatives a typed cloze asks for and keeps: every
 *  word that fits the gap with the sentence read alone. questions_type_valid allows ten. */
export const MAX_GAP_ALTERNATIVES = 10;

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

/** `explanation` is the enrollment's source language, the one the translations are in (spec D5, D6). */
type Input = {
  form: string;
  target: LanguageCode;
  explanation: LanguageCode;
  avoid: readonly string[];
  /** Phase 62d (spec D3): a gap sentence's most words, SHORT_SENTENCE_MAX_WORDS unless a rewrite allows more. */
  maxWords?: number;
};
type Found = { sentence?: string; gap?: string; translation?: string; alternatives?: string[] };

/** Gap offsets are UTF-16 indices and the database counts characters, so a character beyond the BMP would misplace the gap. */
const hasAstral = (...texts: string[]): boolean => texts.some((text) => /[\u{10000}-\u{10FFFF}]/u.test(text));

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Spec D5, D6: whether a text holds a letter of the explanation language's script. */
const hasExplanation = (input: Input, text: string): boolean => LANGUAGES[input.explanation].letters.test(text);

/** Spec D6: two sentences compared as the explanation language compares them (Hebrew has points). */
const sameSentence = (input: Input, a: string, b: string): boolean =>
  input.explanation === 'he' ? normaliseHebrew(a) === normaliseHebrew(b) : normaliseTyped(a) === normaliseTyped(b);

/** Spec D5: the sentence the model wrote for a gap card, its gap located and checked. */
export function validateSentenceItem(
  input: Input,
  found: Found,
): { ok: true; content: SentenceContent } | { ok: false; reason: string } {
  const sentence = found.sentence?.trim();
  const gap = found.gap?.trim();
  const translation = found.translation?.trim();
  if (!sentence || !gap || !translation) return fail('the sentence, its gap or its translation is missing');

  if (hasAstral(sentence, translation, gap)) return fail('the sentence holds a character outside the basic plane');

  const words = wordCount(sentence);
  if (words < SENTENCE_MIN_WORDS || words > (input.maxWords ?? SHORT_SENTENCE_MAX_WORDS)) return fail(`the sentence has ${words} words`);

  if (hasExplanation(input, sentence) || !LANGUAGES[input.target].letters.test(sentence)) {
    return fail(`the sentence is not written in ${LANGUAGES[input.target].name}`);
  }
  if (!hasExplanation(input, translation)) return fail(`the translation is not in ${LANGUAGES[input.explanation].name}`);

  if (wordCount(gap) !== wordCount(input.form)) return fail(`the gap "${gap}" has not as many words as ${input.form}`);
  const where = findGap(sentence, [gap]);
  if (!where) return fail(`the gap "${gap}" is not in the sentence exactly once`);

  // Spec D5: a translation that shows the gap's word gives the answer away.
  if (findGap(translation, [gap])) return fail('the translation shows the gap word');

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
    if (text === '' || hasExplanation(input, text) || seen.has(key)) continue;
    seen.add(key);
    alternatives.push(text);
    if (alternatives.length === MAX_GAP_ALTERNATIVES) break;
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

  if (hasAstral(hebrew, reference, gap)) return fail('the sentence holds a character outside the basic plane');

  const words = wordCount(hebrew);
  if (words < SENTENCE_MIN_WORDS || words > TRANSLATE_MAX_WORDS) return fail(`the Hebrew sentence has ${words} words`);

  if (!hasExplanation(input, hebrew) || LANGUAGES[input.target].letters.test(hebrew)) {
    return fail('the sentence to translate is not only Hebrew');
  }
  if (hasExplanation(input, reference) || !LANGUAGES[input.target].letters.test(reference)) {
    return fail(`the reference translation is not written in ${LANGUAGES[input.target].name}`);
  }

  if (wordCount(gap) !== wordCount(input.form)) return fail(`the gap "${gap}" has not as many words as ${input.form}`);
  const where = findGap(reference, [gap]);
  if (!where) return fail(`the gap "${gap}" is not in the reference exactly once`);

  if (input.avoid.some((old) => sameSentence(input, old, hebrew))) {
    return fail('the sentence repeats one it was told to avoid');
  }
  return { ok: true, content: { hebrew, reference, gap: where } };
}
