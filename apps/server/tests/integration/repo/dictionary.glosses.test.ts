import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';

import type { RepairedRendering } from '../../../src/repo/dictionary';
import { createDictRepo } from '../../../src/repo/dictionary';
import { insertLexeme } from '../../support/dictRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const persist = (form: string, entries: LlmEntry[]) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({ form, languageCode: 'en', userLanguageCode: 'he', kind: 'word', entries }),
  );

const MOUSE: LlmEntry = {
  lemma: 'mouse',
  part_of_speech: 'noun',
  senses: [
    { translation: 'עכבר', sense_code: 'rodent' },
    { translation: 'עַכְבָּר', sense_code: 'computer_device' },
  ],
};

const finger = (...senses: [string, string][]): LlmEntry => ({
  lemma: 'finger',
  part_of_speech: 'noun',
  senses: senses.map(([sense_code, translation]) => ({ sense_code, translation })),
});

async function glossesOf(lemma: string) {
  const rows = await t.db.execute<{ key: string; members: string[] }>(sql`
    select g.key, array_agg(s.sense_code order by s.sense_code) as members
    from dict_glosses g
    join dict_lexemes l on l.id = g.lexeme_id
    join dict_sense_glosses m on m.gloss_id = g.id
    join dict_senses s on s.id = m.sense_id
    where l.lemma = ${lemma} and g.merged_into is null
    group by g.id, g.key order by g.key`);
  return rows.rows;
}

const rendering = (senseId: string, rank: number, translation: string, gloss: string): RepairedRendering => ({
  senseId,
  rank,
  translation,
  alternatives: [],
  gloss,
  glossAlternatives: [],
  definition: null,
  exampleSource: null,
  exampleTarget: null,
});

describe('persistEntries writes glosses (spec D6, D8)', () => {
  it('gives two senses with one target word one gloss, and every rendered sense a membership', async () => {
    const { written } = await persist('mouse', [MOUSE]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
    expect(written[0].glossIds).toHaveLength(2);
    expect(new Set(written[0].glossIds).size).toBe(1);
  });

  it('keeps a later form on the gloss the first one decided', async () => {
    await persist('mouse', [MOUSE]);
    await persist('mice', [{ ...MOUSE, senses: [{ translation: 'עכברים', sense_code: 'rodent' }] }]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
  });

  it('joins a new sense to the gloss with its key', async () => {
    await persist('mouse', [{ ...MOUSE, senses: [MOUSE.senses[0]] }]);
    await persist('mouse', [{ ...MOUSE, senses: [MOUSE.senses[0], { translation: 'עכבר', sense_code: 'computer_device' }] }]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
  });

  it('lets the lemma form rename a key an inflected form set', async () => {
    await persist('fingers', [finger(['body_part', 'אצבעות'])]);
    expect(await glossesOf('finger')).toEqual([{ key: 'אצבעות', members: ['body_part'] }]);
    await persist('finger', [finger(['body_part', 'אצבע'])]);
    expect(await glossesOf('finger')).toEqual([{ key: 'אצבע', members: ['body_part'] }]);
  });

  it('returns a merge pair, and renames nothing, when another gloss holds the key', async () => {
    await persist('fingers', [finger(['body_part', 'אצבעות'])]);
    await persist('finger', [finger(['digit', 'אצבע'])]);
    const { mergePairs } = await persist('finger', [finger(['digit', 'אצבע'], ['body_part', 'אצבע'])]);
    expect(mergePairs).toEqual([{ lexemeId: expect.any(String), userLanguageCode: 'he' }]);
    expect(await glossesOf('finger')).toEqual([
      { key: 'אצבע', members: ['digit'] },
      { key: 'אצבעות', members: ['body_part'] },
    ]);
  });

  it('writes one gloss for one key when two lookups of one new form race', async () => {
    await Promise.all([persist('mouse', [MOUSE]), persist('mouse', [MOUSE])]);
    expect(await glossesOf('mouse')).toEqual([{ key: 'עכבר', members: ['computer_device', 'rodent'] }]);
  });

  it("groups by the model's citation form, so an inflected form keys its gloss uninflected", async () => {
    await persist('fingers', [{ lemma: 'finger', part_of_speech: 'noun', senses: [{ translation: 'אצבעות', gloss: 'אצבע', sense_code: 'body_part' }] }]);
    expect(await glossesOf('finger')).toEqual([{ key: 'אצבע', members: ['body_part'] }]);
  });

  it('stores the first definition offered for a sense, and fills one a sense lacks', async () => {
    await persist('car', [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'vehicle' }] }]);
    await persist('cars', [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכוניות', sense_code: 'vehicle', definition: 'a road vehicle' }] }]);
    await persist('car', [{ lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'vehicle', definition: 'an automobile' }] }]);
    const rows = await t.db.execute<{ definition: string | null }>(sql`select definition from dict_senses where sense_code = 'vehicle'`);
    expect(rows.rows).toEqual([{ definition: 'a road vehicle' }]);
  });
});

describe('repairVariantRenderings writes glosses (spec D6)', () => {
  it("gives a sense its first membership in the repair's language", async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'bank',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'money' }, { senseCode: 'river' }],
      variants: [
        {
          form: 'banks',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'money', rank: 0, translation: 'בנקים', gloss: 'בנק', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([word.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: word.variantIds[0],
        lexemeId: word.lexemeId,
        userLanguageCode: 'he',
        senseVersion: 2,
        lemmaForm: false,
        senses: [rendering(word.senseIds[0], 0, 'בנקים', 'בנק'), rendering(word.senseIds[1], 1, 'גדות', 'גדה')],
      });
    });
    expect(await glossesOf('bank')).toEqual([
      { key: 'בנק', members: ['money'] },
      { key: 'גדה', members: ['river'] },
    ]);
  });

  it('renames on a repair of the lemma form, and asks for a merge where another gloss holds the key', async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'finger',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'body_part' }, { senseCode: 'digit' }],
      variants: [
        { form: 'fingers', kind: 'word', entryRank: 0, translations: [{ senseCode: 'body_part', rank: 0, translation: 'אצבעות', exampleSource: null, exampleTarget: null }] },
        { form: 'finger', kind: 'word', entryRank: 0, translations: [{ senseCode: 'digit', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null }] },
      ],
    });
    const repaired = await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([word.lexemeId]);
      return dict.repairVariantRenderings({
        variantId: word.variantIds[1],
        lexemeId: word.lexemeId,
        userLanguageCode: 'he',
        senseVersion: 2,
        lemmaForm: true,
        senses: [rendering(word.senseIds[1], 0, 'אצבע', 'אצבע'), rendering(word.senseIds[0], 1, 'אצבע', 'אצבע')],
      });
    });
    expect(repaired).toEqual({ needsMerge: true });
    expect(await glossesOf('finger')).toEqual([
      { key: 'אצבע', members: ['digit'] },
      { key: 'אצבעות', members: ['body_part'] },
    ]);
  });

  it('fills the definition a sense lacks, and keeps the one it has (spec D9)', async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'bank',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'money' }, { senseCode: 'river' }],
      variants: [
        {
          form: 'banks',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'money', rank: 0, translation: 'בנקים', gloss: 'בנק', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    await t.db.execute(sql`update dict_senses set definition = 'an institution that keeps money' where id = ${word.senseIds[0]}`);
    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([word.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: word.variantIds[0],
        lexemeId: word.lexemeId,
        userLanguageCode: 'he',
        senseVersion: 2,
        lemmaForm: false,
        senses: [
          { ...rendering(word.senseIds[0], 0, 'בנקים', 'בנק'), definition: 'a shop that sells money' },
          { ...rendering(word.senseIds[1], 1, 'גדות', 'גדה'), definition: 'the edge of a river' },
        ],
      });
    });
    const rows = await t.db.execute<{ sense_code: string; definition: string | null }>(
      sql`select sense_code, definition from dict_senses where lexeme_id = ${word.lexemeId} order by sense_code`,
    );
    expect(rows.rows).toEqual([
      { sense_code: 'money', definition: 'an institution that keeps money' },
      { sense_code: 'river', definition: 'the edge of a river' },
    ]);
  });
});
