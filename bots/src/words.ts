import { readFileSync } from 'node:fs';

export type Language = 'en' | 'ru' | 'it';

/** Which lists a run reads: the bundled frequency lists, or CI's ten-word fixtures (spec §6). */
export type WordSource = 'list' | 'fixtures';

/** The words of a list file: `#` header lines and blank lines dropped. */
export function parseWords(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The bundled frequency-ordered list (spec D15), most frequent first, or the CI fixture. */
export function loadWords(language: Language, source: WordSource = 'list'): string[] {
  const path = source === 'fixtures' ? `../fixtures/words-${language}.txt` : `../words/${language}.txt`;
  return parseWords(readFileSync(new URL(path, import.meta.url), 'utf8'));
}
