import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { termSenseTranslations } from '../../../src/db/schema';
import { exportVocabulary, fromJsonl, toJsonl } from '../../../src/db/vocabExport';
import { importVocabulary } from '../../../src/db/vocabImport';
import { createVocabRepo } from '../../../src/repo/vocabulary';
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

/** A lookup, written the way `services/translations.ts` writes one. */
async function lookUp(
  t: TestDb,
  input: { form: string; entries: { lemma: string; senses: { translation: string; sense_code: string }[] }[] },
): Promise<void> {
  await withTx(t.db, (tx) =>
    createVocabRepo(tx).persistEntries({ ...EN_HE, form: input.form, kind: 'word', entries: input.entries }),
  );
}

async function restoreInto(t: TestDb, records: Awaited<ReturnType<typeof exportVocabulary>>) {
  return importVocabulary(t.db, {
    ...EN_HE,
    records,
    chunkSize: 50,
    onProgress: () => {},
  });
}

describe('vocabulary export/restore', () => {
  it('round-trips a form whose lookup produced two headwords, pairing intact', async () => {
    // The case the export format exists for: one lookup of `saw` writes entries
    // for both `see` and `saw`, and that pairing lives on the variant's
    // entry_rank, not on either term.
    await lookUp(source, {
      form: 'saw',
      entries: [
        { lemma: 'see', senses: [{ translation: 'לראות', sense_code: 'perceive' }] },
        { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
      ],
    });

    const exported = await exportVocabulary(source.db, EN_HE);
    const saw = exported.find((record) => record.form === 'saw');
    expect(saw?.entries.map((entry) => entry.lemma)).toEqual(['see', 'saw']);

    await restoreInto(target, exported);

    // The strongest statement available: a re-export of the restored database
    // is identical, so the format loses nothing and orders deterministically.
    expect(await exportVocabulary(target.db, EN_HE)).toEqual(exported);
  });

  it('restores into a database that already has live data without overwriting it', async () => {
    await lookUp(source, {
      form: 'ladder',
      entries: [{ lemma: 'ladder', senses: [{ translation: 'סולם', sense_code: 'only' }] }],
    });
    const exported = await exportVocabulary(source.db, EN_HE);

    const first = await restoreInto(target, exported);
    expect(first.termsCreated).toBeGreaterThan(0);

    // A learner's own lookup, differing from the dataset, must survive a restore:
    // persistEntries is first-writer-wins, so production content is never
    // replaced by a re-run.
    await target.db
      .update(termSenseTranslations)
      .set({ translation: 'סולם אחר' })
      .where(eq(termSenseTranslations.translation, 'סולם'));

    const second = await restoreInto(target, exported);
    expect(second.termsCreated).toBe(0);

    const rows = await withTx(target.db, (tx) =>
      createVocabRepo(tx).findSensesByForm({ ...EN_HE, form: 'ladder' }),
    );
    expect(rows[0].translation).toBe('סולם אחר');
  });

  it('survives the JSONL encoding it is stored as', async () => {
    await lookUp(source, {
      form: 'book',
      entries: [{ lemma: 'book', senses: [{ translation: 'ספר', sense_code: 'written_work' }] }],
    });
    const exported = await exportVocabulary(source.db, EN_HE);

    expect(fromJsonl(toJsonl(exported))).toEqual(exported);
    expect(toJsonl(exported).split('\n').filter(Boolean)).toHaveLength(exported.length);
  });
});
