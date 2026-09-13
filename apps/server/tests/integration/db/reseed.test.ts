import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { content } from '../../../src/db/content';
import { reseedContent } from '../../../src/db/reseed';
import { seedContent } from '../../../src/db/seed';
import {
  dictVarTranslations,
  dictVariants,
  users,
  dictLexemes,
} from '../../../src/db/schema';
import { createDictRepo } from '../../../src/repo/dictionary';
import { seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

/** A word a learner looked up, written the way a lookup writes it. */
async function lookUp(form: string, lemma: string, translation: string): Promise<void> {
  await withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
      entries: [{ lemma, senses: [{ translation, sense_code: 'only' }] }],
    }),
  );
}

describe('reseedContent', () => {
  it('leaves exactly the recording: the looked-up word is gone, users survive', async () => {
    await seedUser(t.db, 'u_keep');
    await lookUp('ladder', 'ladder', 'סולם');
    expect(await t.db.select().from(dictLexemes).where(eq(dictLexemes.lemma, 'ladder'))).toHaveLength(1);

    await reseedContent(t.db);

    expect(await t.db.select().from(dictLexemes).where(eq(dictLexemes.lemma, 'ladder'))).toHaveLength(0);
    expect(await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'ladder'))).toHaveLength(0);
    // Every recorded string is back, and servable.
    for (const entry of content) {
      const rows = await withTx(t.db, (tx) =>
        createDictRepo(tx).findSensesByForm({
          form: entry.query,
          languageCode: 'en',
          userLanguageCode: 'he',
        }),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }
    expect(await t.db.select().from(users).where(eq(users.id, 'u_keep'))).toHaveLength(1);
  });

  it('is what a bare re-seed cannot do: take a changed recording', async () => {
    // Stand in for a re-recording by changing what is stored. seedContent is
    // first-writer-wins, so it leaves the change in place; reseedContent is the
    // only thing that puts the recording back.
    const [question] = content;
    const rows = await withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByForm({
        form: question.query,
        languageCode: 'en',
        userLanguageCode: 'he',
      }),
    );
    const original = rows[0].translation;
    await t.db
      .update(dictVarTranslations)
      .set({ translation: 'משהו שגוי' })
      .where(eq(dictVarTranslations.translation, original));

    await seedContent(t.db);
    const afterSeed = await withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByForm({
        form: question.query,
        languageCode: 'en',
        userLanguageCode: 'he',
      }),
    );
    expect(afterSeed[0].translation).toBe('משהו שגוי');

    await reseedContent(t.db);
    const afterReseed = await withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByForm({
        form: question.query,
        languageCode: 'en',
        userLanguageCode: 'he',
      }),
    );
    expect(afterReseed[0].translation).toBe(original);
  });

  it('is idempotent, so running it twice is not a way to lose the fixture', async () => {
    await reseedContent(t.db);
    const first = await t.db.select().from(dictLexemes);
    await reseedContent(t.db);
    expect(await t.db.select().from(dictLexemes)).toHaveLength(first.length);
  });
});
