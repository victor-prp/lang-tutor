import type { LanguageCode, Question } from '@lang-tutor/core/api';
import { SCRIPTS, gatesScript, wordOnly, wrongScript } from '@lang-tutor/core/domain';

/**
 * Phase 39 (spec D7, D8). The language a typed card's answer is checked in, or
 * null when it is not checked: core's `gatesScript`, the rule the server's
 * backstop applies, so the phone never sends what the server refuses nor holds
 * back what it takes. A language the app does not know a script for never blocks.
 */
export function scriptGate(question: Question, target: string, learner: string): LanguageCode | null {
  if (!Object.hasOwn(SCRIPTS, target) || !Object.hasOwn(SCRIPTS, learner)) return null;
  return gatesScript(question, target as LanguageCode, learner as LanguageCode);
}

/**
 * Phase 39 (spec D8). What a typed card does with the text in its box: send it,
 * ask again because it is in the wrong alphabet (the server refuses such an
 * answer, so the phone never sends one), or give up on empty text. `language`
 * is the card's `scriptGate`; null sends anything. `sentence` is a translation
 * card's reference: one word for it is asked again too, as the whole sentence
 * (core's `wordOnly`, which the server judges wrong).
 */
export function typedSubmit(
  text: string,
  language: LanguageCode | null,
  sentence: string | null = null,
): 'send' | 'wrong_script' | 'word_only' | 'empty' {
  if (text.trim() === '') return 'empty';
  if (language !== null && wrongScript(text, language)) return 'wrong_script';
  if (sentence !== null && wordOnly(text, sentence)) return 'word_only';
  return 'send';
}
