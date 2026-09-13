import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PartOfSpeech } from '@lang-tutor/core/api';
import { eq } from 'drizzle-orm';

import { dictVarTranslations } from '../../../src/db/schema';
import { exportDictionary, fromJsonl, toJsonl } from '../../../src/db/dictExport';
import { importDictionary } from '../../../src/db/dictImport';
import { createDictRepo } from '../../../src/repo/dictionary';
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
  input: {
    form: string;
    entries: {
      lemma: string;
      part_of_speech: PartOfSpeech;
      senses: { translation: string; sense_code: string }[];
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
});
