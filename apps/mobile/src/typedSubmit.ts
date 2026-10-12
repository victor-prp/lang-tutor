import type { LanguageCode } from '@lang-tutor/core/api';
import { SCRIPTS, wrongScript } from '@lang-tutor/core/domain';

/**
 * Phase 39 (spec D8). What a typed card does with the text in its box: send it,
 * ask again because it is in the wrong alphabet (the server refuses such an
 * answer, so the phone never sends one), or give up on empty text. A language
 * the app does not know a script for never blocks.
 */
export function typedSubmit(text: string, language: string): 'send' | 'wrong_script' | 'empty' {
  if (text.trim() === '') return 'empty';
  if (language in SCRIPTS && wrongScript(text, language as LanguageCode)) return 'wrong_script';
  return 'send';
}
