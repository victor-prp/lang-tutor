import type { LanguageCode, Question } from '@lang-tutor/core/api';
import { SCRIPTS, gatesScript, wrongScript } from '@lang-tutor/core/domain';

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
 * is the card's `scriptGate`; null sends anything.
 */
export function typedSubmit(text: string, language: LanguageCode | null): 'send' | 'wrong_script' | 'empty' {
  if (text.trim() === '') return 'empty';
  if (language !== null && wrongScript(text, language)) return 'wrong_script';
  return 'send';
}
