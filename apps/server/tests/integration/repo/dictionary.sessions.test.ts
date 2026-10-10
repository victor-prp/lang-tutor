import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDictRepo } from '../../../src/repo/dictionary';
import { insertLexeme } from '../../support/dictRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

// Phase 31 (spec D12, D18). The two reads a list session makes of the
// dictionary: a picked gloss's renderings, and its siblings.

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const dict = <T>(fn: (repo: ReturnType<typeof createDictRepo>) => Promise<T>) => withTx(t.db, (tx) => fn(createDictRepo(tx)));

/** A verb with one sense, rendered by its lemma form alone. */
const verb = (lemma: string, translation: string, languageCode = 'en') =>
  insertLexeme(t.db, {
    lemma,
    languageCode,
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'reserve' }],
    variants: [
      { form: lemma, kind: 'word', entryRank: 0, translations: [{ senseCode: 'reserve', rank: 0, translation, exampleSource: null, exampleTarget: null }] },
    ],
  });

describe('findGlossRenderings (spec D12)', () => {
  it("returns both of a gloss's forms with their own citation forms, and nothing of another gloss", async () => {
    // `fingers` renders the body part with a drifted citation form; `finger`
    // renders it and a second sense, a gloss of its own.
    const finger = await insertLexeme(t.db, {
      lemma: 'finger',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'body_part' }, { senseCode: 'measure' }],
      variants: [
        {
          form: 'finger',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'body_part', rank: 0, translation: 'אצבע', exampleSource: null, exampleTarget: null },
            { senseCode: 'measure', rank: 1, translation: 'כוסית', exampleSource: null, exampleTarget: null },
          ],
        },
        {
          form: 'fingers',
          kind: 'word',
          entryRank: 0,
          translations: [{ senseCode: 'body_part', rank: 0, translation: 'אצבעות', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    const [bodyPart, measure] = finger.senseIds;
    const [lemmaForm, plural] = finger.variantIds;
    const gloss = finger.glossIds[0];
    expect(finger.glossIds[1]).not.toBe(gloss);

    const found = await dict((repo) => repo.findGlossRenderings({ glossIds: [gloss], userLanguageCode: 'he' }));
    expect([...found].sort((a, b) => a.form.localeCompare(b.form))).toEqual([
      { glossId: gloss, senseId: bodyPart, variantId: lemmaForm, form: 'finger', gloss: 'אצבע', rank: 0 },
      { glossId: gloss, senseId: bodyPart, variantId: plural, form: 'fingers', gloss: 'אצבעות', rank: 0 },
    ]);
    expect(found.map((row) => row.senseId)).not.toContain(measure);
    expect(await dict((repo) => repo.findGlossRenderings({ glossIds: [], userLanguageCode: 'he' }))).toEqual([]);
  });
});

// Not the spec's book and order under להזמין: the template's seed already holds
// `book` as a verb with that key, which would make it a sibling here too.
describe('findSiblings (spec D18)', () => {
  it("returns `purchase` for `buy`'s gloss when both verbs render לקנות, and nothing for a key no other headword shares", async () => {
    const buy = await verb('buy', 'לקנות');
    await verb('purchase', 'לקנות');
    const cook = await verb('cook', 'לבשל');
    // The same key in an Italian headword is another language pair's word.
    await verb('comprare', 'לקנות', 'it');
    // A merged gloss is no word of its headword's any more: `acquire`'s לקנות,
    // folded into its לרכוש, names no sibling.
    const acquire = await insertLexeme(t.db, {
      lemma: 'acquire',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'buy' }, { senseCode: 'gain' }],
      variants: [
        {
          form: 'acquire',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'buy', rank: 0, translation: 'לקנות', exampleSource: null, exampleTarget: null },
            { senseCode: 'gain', rank: 1, translation: 'לרכוש', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    await t.db.execute(sql`update dict_glosses set merged_into = ${acquire.glossIds[1]} where id = ${acquire.glossIds[0]}`);

    expect(await dict((repo) => repo.findSiblings({ glossIds: [buy.glossIds[0], cook.glossIds[0]] }))).toEqual([
      { glossId: buy.glossIds[0], lemma: 'purchase' },
    ]);
    expect(await dict((repo) => repo.findSiblings({ glossIds: [cook.glossIds[0]] }))).toEqual([]);
    expect(await dict((repo) => repo.findSiblings({ glossIds: [] }))).toEqual([]);
  });
});
