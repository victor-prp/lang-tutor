import { readFileSync } from 'node:fs';

export type Language = 'en' | 'ru' | 'it';

/** The words of a list file: `#` header lines and blank lines dropped. */
export function parseWords(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The bundled frequency-ordered list (spec D15), most frequent first. */
export function loadWords(language: Language): string[] {
  return parseWords(readFileSync(new URL(`../words/${language}.txt`, import.meta.url), 'utf8'));
}
