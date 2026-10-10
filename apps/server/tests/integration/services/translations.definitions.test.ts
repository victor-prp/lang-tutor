import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { insertLexeme, readSenseDefinitions } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  countGeminiRequests,
  expectGeminiJson,
  expectReconciliation,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

// Phase 31 (spec D9). A Hebrew headword rendered for English learners, looked up
// by the first Russian one. Without definitions the second call was skipped, the
// model invented a code, and the lexeme grew a second set of senses.

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('services-translations-definitions');
});
afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const translations = () =>
  createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns) }).translations;

const WINDOWS_RU = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'חלון',
      part_of_speech: 'noun' as const,
      senses: [{ translation: 'окна', gloss: 'окно', sense_code: 'glass_pane', example: { source: 'החלונות נקיים.', target: 'Окна чистые.' } }],
    },
  ],
};

describe('a learner language with no renderings yet', () => {
  it('reconciles by the definition and reuses the stored code', async () => {
    // The first English learner's lookup stores the sense with its definition.
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'חלון',
          part_of_speech: 'noun',
          senses: [{ translation: 'window', sense_code: 'wall_opening', definition: 'פתח בקיר שמכניס אור', example: { source: 'פתחתי את החלון.', target: 'I opened the window.' } }],
        },
      ],
      matchText: '"חלון"',
    });
    await translations().translate('u_1', { text: 'חלון', from: 'he', to: 'en' });

    // Registered first: only the reconciliation prompt says "reusing its sense_code EXACTLY".
    await expectReconciliation(ns, {
      senses: [{ sense_code: 'wall_opening', translation: 'окна', example: { source: 'החלונות נקיים.', target: 'Окна чистые.' } }],
    });
    await expectGeminiJson(ns, { ...WINDOWS_RU, matchText: '"חלונות"' });
    await translations().translate('u_1', { text: 'חלונות', from: 'he', to: 'ru' });

    expect(await readSenseDefinitions(t.db, 'חלון')).toEqual([{ senseCode: 'wall_opening', definition: 'פתח בקיר שמכניס אור' }]);
    // The stored list comes before the reuse rule in the prompt.
    expect(await countGeminiRequests(ns, 'wall_opening — פתח בקיר שמכניס אור — window \\(in English\\)[\\s\\S]*reusing its sense_code EXACTLY')).toBe(1);
  });

  it('with no definition either, reconciles by the other language’s gloss, and fills the definition from the answer', async () => {
    await insertLexeme(t.db, {
      lemma: 'חלון',
      languageCode: 'he',
      partOfSpeech: 'noun',
      userLanguageCode: 'en',
      senses: [{ senseCode: 'wall_opening' }],
      variants: [
        { form: 'חלון', kind: 'word', entryRank: 0, translations: [{ senseCode: 'wall_opening', rank: 0, translation: 'window', exampleSource: 'פתחתי את החלון.', exampleTarget: 'I opened the window.' }] },
      ],
    });
    await expectReconciliation(ns, {
      senses: [{ sense_code: 'wall_opening', translation: 'окна', definition: 'פתח בקיר' }],
    });
    await expectGeminiJson(ns, { ...WINDOWS_RU, matchText: '"חלונות"' });

    await translations().translate('u_1', { text: 'חלונות', from: 'he', to: 'ru' });

    expect(await readSenseDefinitions(t.db, 'חלון')).toEqual([{ senseCode: 'wall_opening', definition: 'פתח בקיר' }]);
    expect(await countGeminiRequests(ns, 'wall_opening — window \\(in English\\)[\\s\\S]*reusing its sense_code EXACTLY')).toBe(1);
  });
});
