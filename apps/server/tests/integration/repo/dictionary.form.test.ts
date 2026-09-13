import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/**
 * The rendering defect, pinned before it is fixed — see dictionary.pos.test.ts
 * for what `it.failing` buys, and for why these use `cook` rather than the
 * spec's `book` (the shared content seed already owns `book`). The helpers below
 * are repeated rather than imported across test files on purpose: a shared
 * fixture module is the one thing that could make both regressions pass for the
 * same wrong reason.
 */

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const verb = (translation: string) => [
  {
    lemma: 'cook',
    senses: [{ sense_code: 'prepare_food', translation, part_of_speech: 'verb' }],
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

describe('each form renders in its own grammatical form', () => {
  it.failing('cook renders the infinitive and cooked the past tense', async () => {
    await persist('cook', verb('INFINITIVE'));
    await persist('cooked', verb('PAST'));

    expect((await find('cook'))[0].translation).toBe('INFINITIVE');
    expect((await find('cooked'))[0].translation).toBe('PAST');
  });

  // Not a defect but a property the phase must preserve, so this one is `it`.
  // It passes today for a reason that is about to stop being true — nothing
  // changes an existing form because a second form writes nothing at all — and
  // it must still pass once a second form writes its own renderings.
  it('writing a new form leaves an existing form untouched', async () => {
    await persist('cook', verb('INFINITIVE'));
    const before = await find('cook');

    await persist('cooked', verb('PAST'));

    expect(await find('cook')).toEqual(before);
  });
});
