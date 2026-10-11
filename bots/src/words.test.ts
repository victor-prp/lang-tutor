import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadWords, parseWords } from './words.ts';

test('parseWords drops comment and blank lines', () => {
  assert.deepEqual(parseWords('# Source: x\n# Licence: CC-BY-SA-4.0\n\nfoo\n bar \n'), ['foo', 'bar']);
});

const SCRIPT = { en: /^[a-z]+$/, ru: /^[а-яё]+$/, it: /^[a-zàèéìòù]+$/ } as const;

for (const lang of ['en', 'ru', 'it'] as const) {
  test(`${lang}: 1,000 alphabetic words of three letters or more, unique`, () => {
    const words = loadWords(lang);
    assert.equal(words.length, 1000);
    assert.ok(words.every((w) => SCRIPT[lang].test(w) && w.length >= 3));
    assert.equal(new Set(words).size, 1000);
  });
}

test('the top 100 are skipped', () => {
  assert.ok(!loadWords('en').slice(0, 5).includes('you'));
});

// Ruling 25. Each saved word is a lookup against production's dictionary.
const NEVER: Record<'en' | 'ru' | 'it', string[]> = {
  en: ['didn', 'isn', 'don', 'wasn', 'couldn', 'two', 'three', 'hundred', 'which', 'their', 'could', 'been', 'from'],
  ru: ['один', 'два', 'три', 'тобой', 'мной', 'этой', 'был', 'были', 'которые', 'него'],
  it: ['due', 'tre', 'uno', 'delle', 'nella', 'quella', 'hanno', 'sua', 'gia', 'puo', 'dell', 'signor'],
};

for (const lang of ['en', 'ru', 'it'] as const) {
  test(`${lang}: no contraction fragment, number word or function word`, () => {
    const words = new Set(loadWords(lang));
    assert.deepEqual(NEVER[lang].filter((w) => words.has(w)), []);
  });
}

test('the CI fixtures hold ten words per language', () => {
  for (const lang of ['en', 'ru', 'it'] as const) assert.equal(loadWords(lang, 'fixtures').length, 10);
});
