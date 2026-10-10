import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createGlossTools } from '../../../src/composition';
import { defineEverySense, insertDriftedFinger, insertRendering, readSenseDefinitions } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { geminiResponse } from '../../support/geminiResponse';
import { clearNamespace, expectGeminiRawBody, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
let ns: string;
beforeEach(async () => {
  t = await createTestDb();
  // The model tier asks about every headword with two glosses or a sense with no
  // definition, the seed's included: one MockServer call each, per plan, on a
  // container the whole suite shares. Defined here, the seed's headwords cost a
  // call only where they hold two glosses, not every one of them.
  await defineEverySense(t.db);
  ns = mockNamespace('services-glosses-tools');
});
afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const tools = () =>
  createGlossTools({
    db: t.db,
    logger: createFakeLogger(),
    fetch: globalThis.fetch,
    gemini: { baseUrl: geminiBaseUrlFor(ns), apiKey: 'test', model: 'test' },
    // A lookup's production budget, as createTestServerDeps gives every other
    // model call: under the full suite one MockServer answer outlived 5 s.
    timeoutMs: 25_000,
  });

/** `finger` whose lemma form renders body_part as אצבע while body_part's gloss is
 *  keyed אצבעות: the blocked rename tier 1 finds. insertLexeme alone cannot
 *  build it, since its rule keys body_part from the lemma form. */
async function blockedRename() {
  const w = await insertDriftedFinger(t.db);
  await insertRendering(t.db, { variantId: w.finger, senseId: w.senseIds[0], userLanguageCode: 'he', translation: 'אצבע', gloss: 'אצבע', rank: 1 });
  return w;
}

describe('dict:glosses:merge (spec D7)', () => {
  it('plans tier 1 without writing, and applies it only when asked', async () => {
    await blockedRename();
    const plan = await tools().planMerges({ model: false });
    expect(plan.merges.map(({ otherKey, survivorKey, tier }) => ({ otherKey, survivorKey, tier }))).toEqual([
      { otherKey: 'אצבעות', survivorKey: 'אצבע', tier: 1 },
    ]);
    expect((await tools().planMerges({ model: false })).merges).toHaveLength(1);
    expect(await tools().applyMerges(plan)).toEqual({ merged: 1, definitions: 0 });
    expect((await tools().planMerges({ model: false })).merges).toHaveLength(0);
  });

  // Tier 1 reads the dictionary alone: the CLI composes no model, and reads no
  // Gemini settings, unless --model asks for tier 2.
  it('composes and plans tier 1 with no model configured', async () => {
    await blockedRename();
    const withoutModel = createGlossTools({
      db: t.db,
      logger: createFakeLogger(),
      fetch: globalThis.fetch,
      gemini: null,
      timeoutMs: 25_000,
    });
    const plan = await withoutModel.planMerges({ model: false });
    expect(plan.merges.map(({ otherKey, survivorKey, tier }) => ({ otherKey, survivorKey, tier }))).toEqual([
      { otherKey: 'אצבעות', survivorKey: 'אצבע', tier: 1 },
    ]);
  });

  it("plans tier 2 from the model's groups, the citation form surviving", async () => {
    await insertDriftedFinger(t.db);
    await expectGeminiRawBody(ns, JSON.stringify(geminiResponse({ groups: [['אצבע', 'אצבעות']], definitions: [] })));
    const plan = await tools().planMerges({ model: true });
    expect(plan.merges.map(({ otherKey, survivorKey, tier }) => ({ otherKey, survivorKey, tier }))).toEqual([
      { otherKey: 'אצבעות', survivorKey: 'אצבע', tier: 2 },
    ]);
  });

  // Spec D9 through the tool: the model tier also backfills a definition a sense
  // lacks. Planning writes nothing; applying fills only a sense still without one.
  it('fills a definition the model gives where the sense had none, and keeps one already there', async () => {
    const finger = [
      { senseCode: 'body_part', definition: 'one of the five parts at the end of the hand' },
      { senseCode: 'digit', definition: null },
    ];
    await insertDriftedFinger(t.db);
    await expectGeminiRawBody(
      ns,
      JSON.stringify(geminiResponse({ groups: [], definitions: [{ sense_code: 'body_part', definition: finger[0].definition }] })),
    );
    const plan = await tools().planMerges({ model: true });
    expect(plan.merges).toEqual([]);
    expect(await readSenseDefinitions(t.db, 'finger')).toEqual([
      { senseCode: 'body_part', definition: null },
      { senseCode: 'digit', definition: null },
    ]);

    expect(await tools().applyMerges(plan)).toEqual({ merged: 0, definitions: 1 });
    expect(await readSenseDefinitions(t.db, 'finger')).toEqual(finger);

    // A plan made before the fill, applied again, and a new plan: neither
    // touches a definition that is there.
    expect(await tools().applyMerges(plan)).toEqual({ merged: 0, definitions: 0 });
    expect((await tools().planMerges({ model: true })).definitions).toEqual([]);
    expect(await readSenseDefinitions(t.db, 'finger')).toEqual(finger);
  });
});
