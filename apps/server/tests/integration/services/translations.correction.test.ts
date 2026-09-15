import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PartOfSpeech } from '@lang-tutor/core/api';

// NOT `src/db/schema`, `drizzle-orm` or `src/repo/dictionary` directly: ADR
// 0001 R2 keeps a service-level test off the database exactly as it keeps
// services/translations.ts off one, and `scripts/check-adrs.sh` enforces it
// (`grep`s tests/integration/services/ for those imports). These small
// helpers live in tests/support/ — the test composition root ADR 0001 exempts
// — beside `insertLexeme`, which the same rule already relies on.
import {
  countDictSenses,
  countDictVariants,
  countDictVarTranslations,
  deleteLexemeByLemma,
  insertCorrection,
  readDictCorrections,
} from '../../support/dictRows';
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

let t: TestDb;
let ns: string;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('translations-correction');
});

afterEach(async () => {
  await clearNamespace(ns);
  await t.close();
});

function translations() {
  return createTestServerDeps({
    db: t.db,
    logger: createFakeLogger(),
    rng: testRng(7),
    geminiBaseUrl: geminiBaseUrlFor(ns),
  }).translations;
}

const entries = (
  lemma: string,
  partOfSpeech: PartOfSpeech,
  senses: { translation: string; sense_code: string }[],
) => [
  {
    lemma,
    part_of_speech: partOfSpeech,
    senses: senses.map((sense) => ({
      ...sense,
      example: { source: `A sentence about ${lemma}.`, target: 'משפט.' },
    })),
  },
];

describe('a corrected lookup, against a real database', () => {
  // Criterion 5. Phase 12's fail-closed rule, asserted for this table:
  // `reconcile` is called ABOVE the `try { transaction(...) }` block, so a
  // failing call never reaches an open transaction — what this proves is
  // fail-closed, a failed reconciliation call writes no entries AND no
  // redirect, not that steps 8 and 9 share a transaction (it would pass the
  // same with them in two, or ten). The shared transaction itself is
  // established BY CONSTRUCTION at services/translations.ts, in the
  // `transaction(async (repos) => { ... })` callback that contains both
  // writes, not by this test — steps 8 and 9 are DEPENDENT there: a redirect
  // can never point at a form with no rows.
  //
  // `pledge` and its forms are in neither the seed nor any other test's
  // namespace. The lexeme is given senses first so that call 2 actually fires —
  // without that the reconciliation branch is skipped and this test passes
  // vacuously.
  it('writes no redirect and no dictionary row when the reconciliation call fails', async () => {
    // An empty reconciliation is an unreadable one: `reconcile` raises
    // "reconciliation returned no usable sense" rather than falling back to
    // call 1's entry, which would write exactly the un-reconciled codes the
    // second call exists to prevent.
    await expectReconciliation(ns, { senses: [], matchText: '"pledged"' });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('pledge', 'verb', [{ translation: 'להתחייב', sense_code: 'promise' }]),
      matchText: '"pledge"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('pledge', 'verb', [{ translation: 'התחייב', sense_code: 'promise' }]),
      correction: { corrected_form: 'pledged', alternatives: [] },
      matchText: '"pledeg"',
    });
    const service = translations();
    await service.translate({ text: 'pledge' });

    await expect(service.translate({ text: 'pledeg' })).rejects.toThrow();

    expect(await readDictCorrections(t.db)).toHaveLength(0);
    expect(await countDictVariants(t.db, 'pledged')).toBe(0);
    expect(await countDictVariants(t.db, 'pledeg')).toBe(0);
  });

  // The dangling redirect, seen to RECOVER rather than to wedge. It needs the
  // target's rows to be gone, which `dict_corrections` joining the reseed
  // TRUNCATE is what keeps rare — a reseed would otherwise produce this shape for
  // every redirect at once.
  it('falls through a redirect whose target rows are gone, then hits again', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [{ translation: 'גרון', sense_code: 'body_part' }]),
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
      matchText: '"thruot"',
    });
    const service = translations();

    await service.translate({ text: 'thruot' });
    // The dictionary is truncated under the redirect's feet. CASCADE reaches the
    // variant, the senses and the translations; the redirect survives, because
    // nothing references it.
    await deleteLexemeByLemma(t.db, 'throat');

    const recovered = await service.translate({ text: 'thruot' });
    const third = await service.translate({ text: 'thruot' });

    expect(recovered.senses).toEqual(third.senses);
    // Two model calls, not three: the first lookup and the recovery. The third is
    // a redirect hit.
    expect(await countGeminiRequests(ns, '"thruot"')).toBe(2);
    expect(await readDictCorrections(t.db)).toHaveLength(1);
  });

  // Criterion 23, at the level that can make it. The stub's entry order
  // DELIBERATELY differs from the stored variant's — adjective first where
  // `booked` has the verb at entry_rank 0 — which is the shape that made the
  // un-probed flow collide on dict_variants_form_entry_rank_key, answer 200 from
  // the catch, and roll the redirect back with the write.
  //
  // Seen to fail first: against the un-probed flow this fails on the request
  // count (2, not 1) AND on the missing redirect.
  it('answers a corrected miss whose target is stored with exactly one request', async () => {
    const booked = [
      ...entries('book', 'verb', [{ translation: 'הזמין', sense_code: 'make_reservation' }]),
      ...entries('book', 'adjective', [{ translation: 'מוזמן', sense_code: 'reserved' }]),
    ];
    // R15: `book` is one of the 13 seeded lemmas (src/db/content.ts), seeded
    // with two verb senses (make_reservation, record_information). So the
    // DIRECT lookup of `booked` below finds `book`/verb already has stored
    // senses and fires phase 12's reconciliation branch on its own, before
    // this test's `bokked` probe is ever reached. Confirmed empirically: with
    // only the two expectations the brief lists, the direct `booked` call's
    // own reconciliation call matches the plain `"booked"` expectation below
    // (first-matching-wins) and throws TranslationUnreadable inside
    // `reconcile`, failing `service.translate({ text: 'booked' })` itself —
    // never reaching the `bokked` probe this test is actually about.
    // Registered first, per the file's own rule: MockServer takes the first
    // matching expectation, and this reconciliation call's body also carries
    // the quoted form "booked".
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'make_reservation', translation: 'BOOKED-RESERVE' },
        { sense_code: 'record_information', translation: 'BOOKED-RECORD' },
      ],
      matchText: '"booked"',
    });
    await expectGeminiJson(ns, { kind: 'word', entries: booked, matchText: '"booked"' });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [booked[1], booked[0]], // adjective first — the colliding order
      correction: { corrected_form: 'booked', alternatives: [] },
      matchText: '"bokked"',
    });
    const service = translations();
    const direct = await service.translate({ text: 'booked' });

    const variantsBefore = await countDictVariants(t.db);
    const sensesBefore = await countDictSenses(t.db);
    const translationsBefore = await countDictVarTranslations(t.db);

    const corrected = await service.translate({ text: 'bokked' });

    expect(await countGeminiRequests(ns, '"bokked"')).toBe(1);
    expect(await countDictVariants(t.db)).toBe(variantsBefore);
    expect(await countDictSenses(t.db)).toBe(sensesBefore);
    expect(await countDictVarTranslations(t.db)).toBe(translationsBefore);
    expect(await countDictVariants(t.db, 'bokked')).toBe(0);
    expect(await readDictCorrections(t.db)).toHaveLength(1);

    expect(corrected.kind).toEqual(direct.kind);
    expect(corrected.senses).toEqual(direct.senses);
    expect(corrected.correction).toEqual({ corrected_form: 'booked', alternatives: [] });
    expect(corrected.text).toBe('bokked');
  });

  // The other half of criterion 23, and what makes R8's fourth amendment's
  // "independent" claim a tested fact rather than an argument: the repair's
  // transaction commits inside serveForm, the redirect's commits after it, and
  // the answer is still byte-identical to a direct lookup made afterwards.
  it('answers a corrected miss whose target is STALE with exactly two requests', async () => {
    // Registered first: a repair body carries the quoted form too, so a broad
    // expectGeminiJson on '"minted"' would answer the repair with a call-1 payload.
    await expectReconciliation(ns, {
      // The `mint` lookup, reconciling against the two senses `minted` stored and
      // naming a third — which bumps the lexeme's sense_version and leaves
      // `minted` behind it.
      senses: [
        { sense_code: 'coin_money', translation: 'MINT-COIN' },
        { sense_code: 'create_new', translation: 'MINT-CREATE' },
        { sense_code: 'issue_stamp', translation: 'MINT-STAMP' },
      ],
      matchText: '"mint"',
    });
    await expectReconciliation(ns, {
      // The REPAIR of `minted`, triggered from inside the probe.
      senses: [
        { sense_code: 'coin_money', translation: 'MINTED-COIN' },
        { sense_code: 'create_new', translation: 'MINTED-CREATE' },
        { sense_code: 'issue_stamp', translation: 'MINTED-STAMP' },
      ],
      matchText: '"minted"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('mint', 'verb', [
        { translation: 'MINTED-COIN', sense_code: 'coin_money' },
        { translation: 'MINTED-CREATE', sense_code: 'create_new' },
      ]),
      matchText: '"minted"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('mint', 'verb', [{ translation: 'MINT-COIN', sense_code: 'coin_money' }]),
      matchText: '"mint"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('mint', 'verb', [{ translation: 'MINTED-COIN', sense_code: 'coin_money' }]),
      correction: { corrected_form: 'minted', alternatives: [] },
      matchText: '"mintd"',
    });
    const service = translations();
    await service.translate({ text: 'minted' });
    await service.translate({ text: 'mint' }); // teaches the lexeme a third sense

    const corrected = await service.translate({ text: 'mintd' });
    const direct = await service.translate({ text: 'minted' });

    // Call 1 for `mintd`, and the repair — whose prompt's user part is `minted`,
    // so it is not counted here.
    expect(await countGeminiRequests(ns, '"mintd"')).toBe(1);
    expect(await countGeminiRequests(ns, 'reusing its sense_code EXACTLY')).toBe(2);
    // The repair really rewrote `minted`'s renderings.
    expect(corrected.senses.map((sense) => sense.translation)).toContain('MINTED-STAMP');
    // Both writes landed, and neither wrote a variant for the typo.
    expect(await readDictCorrections(t.db)).toHaveLength(1);
    expect(await countDictVariants(t.db, 'mintd')).toBe(0);
    // And the corrected answer is the direct answer, to the byte.
    expect(corrected.kind).toEqual(direct.kind);
    expect(corrected.senses).toEqual(direct.senses);
  });

  // Criterion 24, against real rows. Without the hop, step 8 writes a
  // dict_variants row for `throte` — a string this very table records as not a
  // word — which then shadows `throte`'s own redirect forever by the "correct
  // spellings win" rule: this phase's central defect arriving by its own
  // machinery.
  it('writes a redirect straight to the hop target, and no variant for the intermediate typo', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [{ translation: 'גרון', sense_code: 'body_part' }]),
      matchText: '"throat"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throte', 'noun', [{ translation: 'גרון', sense_code: 'body_part' }]),
      correction: { corrected_form: 'throte', alternatives: [] },
      matchText: '"thruot"',
    });
    const service = translations();
    await service.translate({ text: 'throat' });
    await insertCorrection(t.db, {
      languageCode: 'en',
      typedForm: 'throte',
      correctedForm: 'throat',
      alternatives: ['throaty'],
    });

    const result = await service.translate({ text: 'thruot' });

    expect(await countDictVariants(t.db, 'throte')).toBe(0);
    const redirects = await readDictCorrections(t.db);
    expect(redirects.map((row) => [row.typedForm, row.correctedForm]).sort()).toEqual([
      ['throte', 'throat'],
      ['thruot', 'throat'],
    ]);
    // The correction block names the hop's target, and carries the hop's own
    // alternatives. The model's entries, which described `throte`, are discarded.
    expect(result.correction).toEqual({ corrected_form: 'throat', alternatives: ['throaty'] });
  });

  // Criterion 1, at the level that can make it: after a redirect is written AND
  // the corrected form's lexeme has learned a sense, the typo lookup and the
  // direct lookup return deep-equal kind and senses. Fails against a step 3 that
  // reads the rows directly — which is the whole point of writing it.
  it('answers a typo byte-identically to the correct spelling, after the lexeme grows', async () => {
    await expectReconciliation(ns, {
      senses: [
        { sense_code: 'body_part', translation: 'THROATS-BODY' },
        { sense_code: 'narrow_passage', translation: 'THROATS-PASSAGE' },
      ],
      matchText: '"throats"',
    });
    await expectReconciliation(ns, {
      // The repair of `throat`, reached through the redirect at step 3.
      senses: [
        { sense_code: 'body_part', translation: 'THROAT-BODY' },
        { sense_code: 'narrow_passage', translation: 'THROAT-PASSAGE' },
      ],
      matchText: '"throat"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [{ translation: 'THROAT-BODY', sense_code: 'body_part' }]),
      correction: { corrected_form: 'throat', alternatives: ['throughout'] },
      matchText: '"thruot"',
    });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: entries('throat', 'noun', [
        { translation: 'THROATS-BODY', sense_code: 'body_part' },
        { translation: 'THROATS-PASSAGE', sense_code: 'narrow_passage' },
      ]),
      matchText: '"throats"',
    });
    const service = translations();
    await service.translate({ text: 'thruot' }); // writes `throat` and the redirect
    await service.translate({ text: 'throats' }); // teaches the lexeme a second sense

    const viaTypo = await service.translate({ text: 'thruot' });
    const viaWord = await service.translate({ text: 'throat' });

    expect(viaTypo.kind).toEqual(viaWord.kind);
    expect(viaTypo.senses).toEqual(viaWord.senses);
    expect(viaTypo.senses.map((sense) => sense.translation)).toContain('THROAT-PASSAGE');
    expect(viaTypo.correction).toEqual({
      corrected_form: 'throat',
      alternatives: ['throughout'],
    });
    expect(viaWord.correction).toBeUndefined();
  });
});
