import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PartOfSpeech } from '@lang-tutor/core/api';
import { asc, eq, sql } from 'drizzle-orm';

import { dictGlosses, dictLexemes, dictSenses, dictVarTranslations } from '../../../src/db/schema';
import {
  correctionsFromJsonl,
  correctionsToJsonl,
  exportCorrections,
  exportDictionary,
  fromJsonl,
  toJsonl,
} from '../../../src/db/dictExport';
import { importCorrections, importDictionary } from '../../../src/db/dictImport';
import type { SenseToStore } from '../../../src/domain/dictionary';
import { createDictRepo } from '../../../src/repo/dictionary';
import { createGlossRepo } from '../../../src/repo/glosses';
import { insertDriftedFinger } from '../../support/dictRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

const EN_HE = { languageCode: 'en', userLanguageCode: 'he' };

let source: TestDb;
let target: TestDb;

beforeEach(async () => {
  source = await createTestDb();
  target = await createTestDb();
});

afterEach(async () => {
  await source.close();
  await target.close();
});

/** A lookup, written the way `services/translations.ts` writes one. A sense
 *  may carry citation alternatives, as a rendering call's does. */
async function lookUp(
  t: TestDb,
  input: {
    form: string;
    entries: {
      lemma: string;
      part_of_speech: PartOfSpeech;
      senses: SenseToStore[];
    }[];
  },
): Promise<void> {
  await withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({ ...EN_HE, form: input.form, kind: 'word', entries: input.entries }),
  );
}

async function restoreInto(t: TestDb, records: Awaited<ReturnType<typeof exportDictionary>>) {
  return importDictionary(t.db, {
    ...EN_HE,
    records,
    chunkSize: 50,
    onProgress: () => {},
  });
}

/** Phase 31. What one lemma's rows hold: its senses' definitions, its
 *  renderings' citation forms and other words, and its glosses. */
async function storedWord(t: TestDb, lemma: string) {
  const [lexeme] = await t.db.select({ id: dictLexemes.id }).from(dictLexemes).where(eq(dictLexemes.lemma, lemma));
  const senses = await t.db
    .select({ senseCode: dictSenses.senseCode, definition: dictSenses.definition })
    .from(dictSenses)
    .where(eq(dictSenses.lexemeId, lexeme.id))
    .orderBy(asc(dictSenses.senseCode));
  const renderings = await t.db
    .select({
      translation: dictVarTranslations.translation,
      gloss: dictVarTranslations.gloss,
      alternatives: dictVarTranslations.alternatives,
    })
    .from(dictVarTranslations)
    .innerJoin(dictSenses, eq(dictSenses.id, dictVarTranslations.senseId))
    .where(eq(dictSenses.lexemeId, lexeme.id))
    .orderBy(asc(dictVarTranslations.rank));
  const glosses = await t.db
    .select({ key: dictGlosses.key, alternatives: dictGlosses.alternatives })
    .from(dictGlosses)
    .where(eq(dictGlosses.lexemeId, lexeme.id))
    .orderBy(asc(dictGlosses.key));
  return { senses, renderings, glosses };
}

/** Phase 31. One lemma's live glosses in Hebrew, by key, with their senses. */
async function liveGlosses(t: TestDb, lemma: string): Promise<{ key: string; senses: string[] }[]> {
  const rows = await t.db.execute<{ key: string; senses: string[] }>(sql`
    select g.key, array_agg(s.sense_code order by s.sense_code) as senses
    from dict_glosses g
    join dict_lexemes l       on l.id = g.lexeme_id
    join dict_sense_glosses m on m.gloss_id = g.id
    join dict_senses s        on s.id = m.sense_id
    where l.lemma = ${lemma} and g.user_language_code = 'he' and g.merged_into is null
    group by g.key
    order by g.key`);
  return rows.rows.map((row) => ({ key: row.key, senses: row.senses }));
}

describe('dictionary export/restore', () => {
  it('round-trips a form whose lookup produced two headwords, pairing intact', async () => {
    // The case the export format exists for: one lookup of `saw` writes entries
    // for both `see` and `saw`, and that pairing lives on the variant's
    // entry_rank, not on either term.
    await lookUp(source, {
      form: 'saw',
      entries: [
        {
          lemma: 'see',
          part_of_speech: 'verb' as const,
          senses: [{ translation: 'לראות', sense_code: 'perceive' }],
        },
        {
          lemma: 'saw',
          part_of_speech: 'noun' as const,
          senses: [{ translation: 'מסור', sense_code: 'tool' }],
        },
      ],
    });

    const exported = await exportDictionary(source.db, EN_HE);
    const saw = exported.find((record) => record.form === 'saw');
    expect(saw?.entries.map((entry) => entry.lemma)).toEqual(['see', 'saw']);

    await restoreInto(target, exported);

    // The strongest statement available: a re-export of the restored database
    // is identical, so the format loses nothing and orders deterministically.
    expect(await exportDictionary(target.db, EN_HE)).toEqual(exported);

    // Versions are DERIVED on import, never carried in the file. A dump that
    // could resurrect a stale marker would make a restore re-render every form
    // it touched, at one provider call each.
    //
    // Asserted on `saw`, which this restore actually WROTE — both of its
    // lexemes, `see` and `saw`, are created here. An assertion on `book` (as
    // this first read) cannot fail whatever the import does: `book` comes from
    // the target's own seed and no record in this file touches it, so a stale
    // marker surviving a restore would leave it level regardless. A check that
    // cannot fire prints exactly what a passing one prints.
    const stale = await withTx(target.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'saw', languageCode: 'en', userLanguageCode: 'he' }));
    expect(stale).toEqual([]);
  });

  it('restores into a database that already has live data without overwriting it', async () => {
    await lookUp(source, {
      form: 'ladder',
      entries: [
        {
          lemma: 'ladder',
          part_of_speech: 'noun' as const,
          senses: [{ translation: 'סולם', sense_code: 'only' }],
        },
      ],
    });
    const exported = await exportDictionary(source.db, EN_HE);

    const first = await restoreInto(target, exported);
    expect(first.lexemesCreated).toBeGreaterThan(0);

    // A learner's own lookup, differing from the dataset, must survive a restore:
    // persistEntries is first-writer-wins, so production content is never
    // replaced by a re-run.
    await target.db
      .update(dictVarTranslations)
      .set({ translation: 'סולם אחר' })
      .where(eq(dictVarTranslations.translation, 'סולם'));

    const second = await restoreInto(target, exported);
    expect(second.lexemesCreated).toBe(0);

    const rows = await withTx(target.db, (tx) =>
      createDictRepo(tx).findSensesByForm({ ...EN_HE, form: 'ladder' }),
    );
    expect(rows[0].translation).toBe('סולם אחר');
  });

  it('survives the JSONL encoding it is stored as', async () => {
    // `cook`, not `book`: `book` is one of the seeded queries, so its form
    // already carries renderings and a second set would collide on
    // UNIQUE(variant_id, user_language_code, rank).
    await lookUp(source, {
      form: 'cook',
      entries: [
        {
          lemma: 'cook',
          part_of_speech: 'noun' as const,
          senses: [{ translation: 'טבח', sense_code: 'kitchen_worker' }],
        },
      ],
    });
    const exported = await exportDictionary(source.db, EN_HE);

    expect(fromJsonl(toJsonl(exported))).toEqual(exported);
    expect(toJsonl(exported).split('\n').filter(Boolean)).toHaveLength(exported.length);
  });

  // Phase 12: one lemma can be two lexemes, and the format has to keep them
  // apart on the way out and back. Without part_of_speech on the entry, a
  // restore would fold these into one lexeme and lose a reading.
  it('round-trips one lemma held as two lexemes', async () => {
    await lookUp(source, {
      form: 'cook',
      entries: [
        {
          lemma: 'cook',
          part_of_speech: 'noun' as const,
          senses: [{ translation: 'טבח', sense_code: 'kitchen_worker' }],
        },
        {
          lemma: 'cook',
          part_of_speech: 'verb' as const,
          senses: [{ translation: 'לבשל', sense_code: 'prepare_food' }],
        },
      ],
    });

    const exported = await exportDictionary(source.db, EN_HE);
    const cook = exported.find((record) => record.form === 'cook');
    expect(cook?.entries.map((entry) => [entry.lemma, entry.part_of_speech])).toEqual([
      ['cook', 'noun'],
      ['cook', 'verb'],
    ]);

    await restoreInto(target, exported);
    expect(await exportDictionary(target.db, EN_HE)).toEqual(exported);
  });

  // Phase 31 (spec D5, D6, D9). What a sense gained travels with it, each field
  // only when present: a rendering's other words and citation form, its gloss's
  // other words, and its definition. Without them a restore would key `cars`'
  // gloss on the plural and drop the definition and every "also".
  it("round-trips a sense's definition, other words and citation form, and keys its gloss the same", async () => {
    await lookUp(source, {
      form: 'cars',
      entries: [
        {
          lemma: 'car',
          part_of_speech: 'noun' as const,
          senses: [
            {
              translation: 'מכוניות',
              sense_code: 'road_vehicle',
              alternatives: ['רכבים'],
              gloss: 'מכונית',
              gloss_alternatives: ['רכב'],
              definition: 'a road vehicle with an engine',
            },
            { translation: 'קרונות', sense_code: 'railway_carriage' },
          ],
        },
      ],
    });

    const exported = await exportDictionary(source.db, EN_HE);
    expect(exported.find((record) => record.form === 'cars')?.entries[0].senses).toEqual([
      {
        translation: 'מכוניות',
        sense_code: 'road_vehicle',
        alternatives: ['רכבים'],
        gloss: 'מכונית',
        gloss_alternatives: ['רכב'],
        definition: 'a road vehicle with an engine',
      },
      { translation: 'קרונות', sense_code: 'railway_carriage' },
    ]);

    await restoreInto(target, exported);

    const car = {
      senses: [
        { senseCode: 'railway_carriage', definition: null },
        { senseCode: 'road_vehicle', definition: 'a road vehicle with an engine' },
      ],
      renderings: [
        { translation: 'מכוניות', gloss: 'מכונית', alternatives: ['רכבים'] },
        { translation: 'קרונות', gloss: 'קרונות', alternatives: [] },
      ],
      glosses: [
        { key: 'מכונית', alternatives: ['רכב'] },
        { key: 'קרונות', alternatives: [] },
      ],
    };
    expect(await storedWord(source, 'car')).toEqual(car);
    expect(await storedWord(target, 'car')).toEqual(car);
    expect(await exportDictionary(target.db, EN_HE)).toEqual(exported);
  });

  // Phase 31 (spec D7). Pinned as it is: the export carries each rendering's
  // citation form, not the sense's membership, and a restore rebuilds glosses
  // from the renderings form by form (assignGlosses), so a merge does not
  // survive it. `finger` merged by the model tier comes back as two live
  // glosses, and tier 1's signal, the blocked rename, does not see them; only
  // tier 2 can merge them again. Hence the README's and the hosting runbook's
  // `dict:glosses:merge`, then `dict:glosses:merge -- --model`, after a restore.
  it('restores a merged gloss as two live glosses again, which tier 1 does not plan', async () => {
    const w = await insertDriftedFinger(source.db);
    // What the tool applies for the model's group [אצבע, אצבעות].
    await withTx(source.db, async (tx) => {
      await createDictRepo(tx).lockLexemes([w.lexemeId]);
      return createGlossRepo(tx).mergeGlosses({ survivorId: w.survivor, otherId: w.other });
    });
    expect(await liveGlosses(source, 'finger')).toEqual([{ key: 'אצבע', senses: ['body_part', 'digit'] }]);

    await restoreInto(target, await exportDictionary(source.db, EN_HE));

    expect(await liveGlosses(target, 'finger')).toEqual([
      { key: 'אצבע', senses: ['digit'] },
      { key: 'אצבעות', senses: ['body_part'] },
    ]);
    const [restored] = await target.db.select({ id: dictLexemes.id }).from(dictLexemes).where(eq(dictLexemes.lemma, 'finger'));
    expect(
      await withTx(target.db, (tx) =>
        createGlossRepo(tx).findMergeCandidates({ lexemeId: restored.id, userLanguageCode: 'he' }),
      ),
    ).toEqual([]);
  });
});

describe('corrections.jsonl', () => {
  const write = (t: TestDb, input: { typedForm: string; correctedForm: string; alternatives: string[] }) =>
    withTx(t.db, (tx) => createDictRepo(tx).persistCorrection({ languageCode: 'en', ...input }));

  it('round-trips a redirect, and the restored row serves the same answer', async () => {
    await write(source, {
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['throughout'],
    });

    const records = await exportCorrections(source.db, { languageCode: 'en' });
    expect(records).toEqual([
      { typed_form: 'thruot', corrected_form: 'throat', alternatives: ['throughout'] },
    ]);

    const result = await importCorrections(target.db, { records, languageCode: 'en' });
    expect(result.records).toBe(1);
    expect(
      await withTx(target.db, (tx) =>
        createDictRepo(tx).findCorrectionByForm({ languageCode: 'en', form: 'Thruot' }),
      ),
    ).toEqual({ typedForm: 'thruot', correctedForm: 'throat', alternatives: ['throughout'] });
  });

  it('survives the JSONL encoding it is stored as', async () => {
    await write(source, { typedForm: 'שולחם', correctedForm: 'שולחן', alternatives: [] });

    const records = await exportCorrections(source.db, { languageCode: 'en' });
    expect(correctionsFromJsonl(correctionsToJsonl(records))).toEqual(records);
  });

  // The guarantee dictImport already provides for the dictionary, extended to
  // this table: replaying a file onto a database that already holds part of it
  // keeps the live content and raises nothing. persistCorrection being
  // ON CONFLICT DO NOTHING is what makes it true, and a redirect that raised on a
  // re-restore would make dict:restore non-idempotent for the first time since
  // phase 11.
  it('is idempotent: a re-restore keeps the live target and raises nothing', async () => {
    await write(target, { typedForm: 'thruot', correctedForm: 'throat', alternatives: [] });

    await importCorrections(target.db, {
      languageCode: 'en',
      records: [{ typed_form: 'Thruot', corrected_form: 'throughout', alternatives: [] }],
    });

    expect(
      (
        await withTx(target.db, (tx) =>
          createDictRepo(tx).findCorrectionByForm({ languageCode: 'en', form: 'thruot' }),
        )
      )?.correctedForm,
    ).toBe('throat');
  });

  // The file is genuinely optional, and it is empty on arrival — so a restore
  // that cannot find it restores the dictionary and reports zero corrections
  // rather than failing.
  it('restores zero corrections from an empty or absent file', async () => {
    expect(correctionsFromJsonl('')).toEqual([]);
    expect(await importCorrections(target.db, { records: [], languageCode: 'en' }))
      .toEqual({ records: 0 });
  });
});
