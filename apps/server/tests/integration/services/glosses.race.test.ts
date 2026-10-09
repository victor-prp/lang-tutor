import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { GlossLanguageMismatch } from '../../../src/errors';
import { insertDriftedFinger, insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { holdMergeOpen, waitForBlockedQuery } from '../../support/locks';
import { insertAnsweredSession, readProgress, readSnapshot } from '../../support/progressRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { readSavedGlossIds } from '../../support/vocabularyRows';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await t.close();
});

const deps = () => createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(3) });

const twoGlosses = () => insertDriftedFinger(t.db);

describe('a learner write racing a merge (spec D14)', () => {
  it('lands a save on the survivor, as one row, when the merge commits first', async () => {
    const w = await twoGlosses();
    const merge = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merge.ready;
    const saving = deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: w.other, variant_id: w.fingers }]);
    await waitForBlockedQuery(t.db);
    merge.release();
    await merge.done;
    await saving;
    expect(await readSavedGlossIds(t.db, enrollmentOf('u_1'))).toEqual([w.survivor]);
  });

  it('lands a save by an id merged long ago on the survivor', async () => {
    const w = await twoGlosses();
    const merge = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merge.ready;
    merge.release();
    await merge.done;
    await deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: w.other, variant_id: w.fingers }]);
    expect(await readSavedGlossIds(t.db, enrollmentOf('u_1'))).toEqual([w.survivor]);
  });

  it('removes the survivor’s entry when an unsave names an id merged since the card was shown', async () => {
    const w = await twoGlosses();
    await deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: w.other, variant_id: w.fingers }]);
    const merge = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merge.ready;
    merge.release();
    await merge.done;
    expect(await readSavedGlossIds(t.db, enrollmentOf('u_1'))).toEqual([w.survivor]);
    await deps().vocabulary.unsave('u_1', enrollmentOf('u_1'), w.other);
    expect(await readSavedGlossIds(t.db, enrollmentOf('u_1'))).toEqual([]);
  });

  it("writes a session's progress and snapshot on the survivor when the session ends during a merge", async () => {
    const w = await twoGlosses();
    await deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: w.other, variant_id: w.fingers }]);
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: enrollmentOf('u_1'),
      status: 'ready',
      asked: [{ glossId: w.other, variantId: w.fingers, translation: 'אצבעות' }],
      answers: [],
    });
    const { questions } = await deps().sessions.getSession('u_1', sessionId);

    const merge = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merge.ready;
    const answering = deps().sessions.submitAnswer('u_1', sessionId, questions[0].id, { option_index: 0 });
    await waitForBlockedQuery(t.db);
    merge.release();
    await merge.done;
    await answering;

    const progress = await readProgress(t.db, enrollmentOf('u_1'));
    expect(new Set(progress.map((row) => row.glossId))).toEqual(new Set([w.survivor]));
    expect(progress.find((row) => row.dimension === 'written_receptive')?.level).toBe(2);
    const snapshot = await readSnapshot(t.db, sessionId);
    expect(new Set(snapshot.map((row) => row.glossId))).toEqual(new Set([w.survivor]));
  });
});

describe('a gloss of another learner language (spec D14)', () => {
  it('is refused as a GlossLanguageMismatch, and nothing is saved', async () => {
    const russian = await insertLexeme(t.db, {
      lemma: 'finger',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'ru',
      senses: [{ senseCode: 'digit' }],
      variants: [
        { form: 'finger', kind: 'word', entryRank: 0, translations: [{ senseCode: 'digit', rank: 0, translation: 'палец', exampleSource: null, exampleTarget: null }] },
      ],
    });
    await expect(
      deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: russian.glossIds[0], variant_id: russian.variantIds[0] }]),
    ).rejects.toBeInstanceOf(GlossLanguageMismatch);
    expect(await readSavedGlossIds(t.db, enrollmentOf('u_1'))).toEqual([]);
  });
});
