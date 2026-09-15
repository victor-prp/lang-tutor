import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

// NOT `src/db/schema` or `drizzle-orm` directly: ADR 0001 R2 keeps a
// service-level test off the database exactly as it keeps
// services/translations.ts itself off one, and
// scripts/check-adr-0001-layered-architecture.sh enforces it. These helpers
// live in tests/support/ — the test composition root ADR 0001 exempts.
import { countDictVariants, readDictCorrections } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import {
  clearNamespace,
  expectGeminiJson,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('corrections-variants');
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

const translations = () =>
  createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    // createTestServerDeps declares `geminiBaseUrl`, not `geminiBaseUrlFor` —
    // verified against tests/support/serverDeps.ts.
    geminiBaseUrl: geminiBaseUrlFor(ns),
  }).translations;

describe('a reported misspelling never becomes a dictionary variant', () => {
  // The qualifier is not hedging. The stub always corrects, so this pins the
  // SERVER's half — "a misspelling the model REPORTS is never a dict_variants
  // row" — and says nothing about the model's half, which is the eval bucket's.
  //
  // It is also the stronger answer to the reported defect:
  // questions.prompt_variant_id references dict_variants, so a string that never
  // becomes a variant CANNOT be quizzed, and no present or future query has to
  // remember to filter it out.
  it('leaves zero dict_variants rows for the typed form after any number of lookups', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'throat',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'גרון',
              example: { source: 'She had a sore throat.', target: 'היה לה כאב גרון.' },
              sense_code: 'body_part',
            },
          ],
        },
      ],
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
    });
    const service = translations();

    await service.translate({ text: 'thruot' });
    await service.translate({ text: 'thruot' });
    await service.translate({ text: 'Thruot' });

    expect(await countDictVariants(t.db, 'thruot')).toBe(0);
    expect(await countDictVariants(t.db, 'Thruot')).toBe(0);
    // The correct spelling IS a variant, and there is exactly one redirect.
    expect(await countDictVariants(t.db, 'throat')).toBe(1);
    expect(await readDictCorrections(t.db)).toHaveLength(1);
  });
});
