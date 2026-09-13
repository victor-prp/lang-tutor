import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/**
 * The reading defect, pinned before it is fixed.
 *
 * `it.failing` PASSES while its body fails, so the defect is committed in a
 * green build and phase 12 flips the marker rather than writing the test after
 * the fact. Flip it to `it` to see the real failure.
 *
 * **`cook`, not the spec's `book`.** `book` is one of the thirteen queries in
 * the shared content seed (`db/seed.ts`), so every cloned test database already
 * holds a `book` lexeme with senses — and `persistEntries` is first-writer-wins,
 * which would make every call below write nothing and this test fail for a
 * reason that has nothing to do with the defect. `cook` is the same shape, a
 * noun and a verb sharing a lemma with a past-tense form, and the seed does not
 * have it. The real `booked` is scored against the real model in `tests/eval/`.
 */

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

// Pre-Task-3 shape: senses still carry part_of_speech, entries do not.
const COOK = [
  {
    lemma: 'cook',
    senses: [
      { sense_code: 'kitchen_worker', translation: 'N-COOK', part_of_speech: 'noun' },
      { sense_code: 'prepare_food', translation: 'V-COOK', part_of_speech: 'verb' },
    ],
  },
];

const COOKED = [
  {
    lemma: 'cook',
    senses: [{ sense_code: 'prepare_food', translation: 'V-COOKED', part_of_speech: 'verb' }],
  },
];

const persist = (form: string, entries: unknown) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
      entries: entries as never,
    }),
  );

const find = (form: string) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).findSensesByForm({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
    }),
  );

describe('an inflected form serves only its own part of speech', () => {
  it.failing('cooked never serves the noun sense', async () => {
    await persist('cook', COOK);
    await persist('cooked', COOKED);

    const rows = await find('cooked');
    expect(rows.map((r) => r.translation)).not.toContain('N-COOK');
    expect(rows.every((r) => r.partOfSpeech === 'verb')).toBe(true);
  });
});
