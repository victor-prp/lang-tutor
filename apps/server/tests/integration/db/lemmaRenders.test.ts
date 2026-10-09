import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { RENDER_LEMMA } from '../../../src/domain/jobs';
import { requestLemmaRenders, requestLemmaRendersOnStart } from '../../../src/db/lemmaRenders';
import { insertLexeme } from '../../support/dictRows';
import { countJobs } from '../../support/jobs';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await t.close();
});

const none = (s: string) => ({ senseCode: s, rank: 0, exampleSource: null, exampleTarget: null });

async function savedFrom(lemma: string, form: string, translation: string) {
  const word = await insertLexeme(t.db, {
    lemma, languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'only' }],
    variants: [{ form, kind: 'word', entryRank: 0, translations: [{ ...none('only'), translation }] }],
  });
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id)
    values (${enrollmentOf('u_1')}, ${word.glossIds[0]}, ${word.lexemeId}, ${lemma}, ${word.variantIds[0]}, 'u_1')`);
}

describe('requestLemmaRenders, the start-up backfill (plan item 3)', () => {
  it('asks once for every saved word whose lemma form is unrendered, and never again', async () => {
    await savedFrom('finger', 'fingers', 'אצבעות');
    await savedFrom('see', 'saw', 'ראה');
    await savedFrom('car', 'car', 'מכונית');

    expect(await requestLemmaRenders(t.db)).toEqual({ requested: 2 });
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(2);
    expect(await requestLemmaRenders(t.db)).toEqual({ requested: 0 });
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(2);
  });
});

describe('requestLemmaRendersOnStart, the CLI default path (ADR 0010)', () => {
  // Everything before it has committed, and the image starts the server only on
  // a zero exit: a failure comes back as one line, never as a throw.
  it('answers as requestLemmaRenders does, and turns a failure into a one-line reason instead of a throw', async () => {
    await savedFrom('finger', 'fingers', 'אצבעות');
    expect(await requestLemmaRendersOnStart(t.db)).toEqual({ requested: 1 });

    // A failure after the migrations and the seed have committed.
    await t.db.execute(sql`drop table dict_lemma_renders`);
    expect(await requestLemmaRendersOnStart(t.db)).toEqual({ failed: 'relation "dict_lemma_renders" does not exist' });
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(1);
  });
});
