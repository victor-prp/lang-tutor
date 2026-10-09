import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PgBoss } from 'pg-boss';

import { PREPARE_SESSION } from '../../../src/domain/jobs';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss } from '../../support/jobs';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let boss: PgBoss;
beforeEach(async () => {
  t = await createTestDb();
  boss = await startTestBoss(t.db);
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

const deps = (seed: number) => createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(seed), boss });

async function savedVerb(lemma: string, translation: string) {
  const word = await insertLexeme(t.db, {
    lemma, languageCode: 'en', partOfSpeech: 'verb', userLanguageCode: 'he', senses: [{ senseCode: 'reserve' }],
    variants: [{ form: lemma, kind: 'word', entryRank: 0, translations: [{ senseCode: 'reserve', rank: 0, translation, exampleSource: null, exampleTarget: null }] }],
  });
  await deps(1).vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: word.glossIds[0], variant_id: word.variantIds[0] }]);
  return word.glossIds[0];
}

describe('a list session over glosses (spec D12, D18)', () => {
  it('never picks two saved headwords that share a target word', async () => {
    // Not `book`, the spec's example: the template's seed already holds it as a
    // verb under להזמין, and one lexeme per lemma and part of speech.
    const reserve = await savedVerb('reserve', 'להזמין');
    const order = await savedVerb('order', 'להזמין');
    await savedVerb('cook', 'לבשל');
    for (const seed of [1, 2, 3, 4, 5]) {
      const session = deps(seed).sessions;
      const created = await session.createNextSession('u_1', enrollmentOf('u_1'), { listening: false, speaking: false });
      await session.skipSession('u_1', created.sessionId);
    }
    const payloads = (await jobPayloads(t.db, PREPARE_SESSION)) as { picks: { gloss_id: string }[] }[];
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      const ids = payload.picks.map((pick) => pick.gloss_id);
      expect(ids.filter((id) => id === reserve || id === order)).toHaveLength(1);
      expect(ids).toHaveLength(2);
    }
  });
});
