import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDictRepo } from '../../../src/repo/dictionary';
import { insertLexeme, insertRendering } from '../../support/dictRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

// Phase 34 (spec D3). The one read a batch makes of what the dictionary already
// knows to be right: the meanings of a picked word, its homographs' and its
// gloss's, and the target words right for a picked rendering's Hebrew.

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const dict = <T>(fn: (repo: ReturnType<typeof createDictRepo>) => Promise<T>) => withTx(t.db, (tx) => fn(createDictRepo(tx)));
const sorted = (values: string[] | undefined) => [...(values ?? [])].sort();

/** One sense per translation, all rendered by `form`. `entryRank`: which reading of the form it is. */
const word = (input: { lemma: string; form?: string; partOfSpeech?: string; languageCode?: string; entryRank?: number; translations: string[] }) =>
  insertLexeme(t.db, {
    lemma: input.lemma,
    languageCode: input.languageCode ?? 'en',
    partOfSpeech: input.partOfSpeech ?? 'verb',
    userLanguageCode: 'he',
    senses: input.translations.map((_, i) => ({ senseCode: `s${i}` })),
    variants: [
      {
        form: input.form ?? input.lemma,
        kind: 'word',
        entryRank: input.entryRank ?? 0,
        translations: input.translations.map((translation, i) => ({ senseCode: `s${i}`, rank: i, translation, exampleSource: null, exampleTarget: null })),
      },
    ],
  });

describe('findKnownRight', () => {
  it('category A (c49ddbec): knows every sense of a picked word, in every form, with its glosses’ words, in the learner language only', async () => {
    const pickUp = await insertLexeme(t.db, {
      lemma: 'pick up',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'answer' }, { senseCode: 'lift' }],
      variants: [
        {
          form: 'pick up', kind: 'word', entryRank: 0,
          translations: [
            { senseCode: 'answer', rank: 0, translation: 'לענות', alternatives: ['להשיב'], exampleSource: null, exampleTarget: null },
            { senseCode: 'lift', rank: 1, translation: 'להרים', exampleSource: null, exampleTarget: null },
          ],
        },
        {
          form: 'picked up', kind: 'word', entryRank: 0,
          translations: [{ senseCode: 'lift', rank: 0, translation: 'הרים', gloss: 'להרים', exampleSource: null, exampleTarget: null }],
        },
      ],
    });
    await t.db.execute(sql`update dict_glosses set alternatives = array['לאסוף']::text[] where id = ${pickUp.glossIds[1]}`);
    // The same sense in another learner language is no Hebrew meaning.
    await insertRendering(t.db, { variantId: pickUp.variantIds[0], senseId: pickUp.senseIds[1], userLanguageCode: 'ru', translation: 'поднять', gloss: 'поднять', rank: 1 });

    const known = await dict((repo) =>
      repo.findKnownRight({ glossIds: [pickUp.glossIds[0]], lexemeIds: [pickUp.lexemeId], variantIds: [pickUp.variantIds[0]], prompts: [], userLanguageCode: 'he', targetLanguage: 'en' }),
    );
    expect(sorted(known.meaningsByLexeme.get(pickUp.lexemeId))).toEqual(sorted(['לענות', 'להשיב', 'להרים', 'הרים', 'לאסוף']));
    // The gloss's own meanings only: the answer sense, not the lift.
    expect(sorted(known.meaningsByGloss.get(pickUp.glossIds[0]))).toEqual(sorted(['לענות', 'להשיב']));
    expect(known.wordsByPrompt.size).toBe(0);
  });

  it('category A (the saw homograph): knows see’s meanings for saw, through see’s form saw, and nothing of another language’s saw', async () => {
    const saw = await word({ lemma: 'saw', translations: ['לנסר'] });
    const sawNoun = await word({ lemma: 'saw', partOfSpeech: 'noun', entryRank: 1, translations: ['מסור'] });
    const see = await insertLexeme(t.db, {
      lemma: 'see', languageCode: 'en', partOfSpeech: 'verb', userLanguageCode: 'he',
      senses: [{ senseCode: 'perceive' }],
      variants: [
        { form: 'see', kind: 'word', entryRank: 0, translations: [{ senseCode: 'perceive', rank: 0, translation: 'לראות', exampleSource: null, exampleTarget: null }] },
        { form: 'Saw', kind: 'word', entryRank: 2, translations: [{ senseCode: 'perceive', rank: 0, translation: 'ראה', gloss: 'לראות', exampleSource: null, exampleTarget: null }] },
      ],
    });
    // An Italian word spelled saw would be no homograph of the English one.
    await word({ lemma: 'saw', languageCode: 'it', translations: ['משהו אחר'] });
    // A word whose form is not saw is no homograph either.
    await word({ lemma: 'sew', translations: ['לתפור'] });

    const known = await dict((repo) =>
      repo.findKnownRight({ glossIds: [], lexemeIds: [saw.lexemeId], variantIds: [saw.variantIds[0]], prompts: [], userLanguageCode: 'he', targetLanguage: 'en' }),
    );
    expect(sorted(known.meaningsByLexeme.get(saw.lexemeId))).toEqual(sorted(['לנסר', 'מסור', 'לראות', 'ראה']));
    expect(known.meaningsByLexeme.has(see.lexemeId)).toBe(false);
    expect(known.meaningsByLexeme.has(sawNoun.lexemeId)).toBe(false);
  });

  it('category A (0fa3fc06): knows presto for תכף, an answer the accept job stored on a rendering with that Hebrew, pointed or not, in this pair only', async () => {
    const ora = await word({ lemma: 'ora', languageCode: 'it', partOfSpeech: 'adverb', translations: ['תכף'] });
    const subito = await word({ lemma: 'subito', languageCode: 'it', partOfSpeech: 'adverb', translations: ['תֵּכֶף.'] });
    await t.db.execute(sql`update dict_var_translations set accepted_answers = array['presto', 'fra poco']::text[] where variant_id = ${subito.variantIds[0]}`);
    // Another Hebrew word, and the same Hebrew for Russian, are no answers for תכף in Italian.
    const tra = await word({ lemma: 'tra poco', languageCode: 'it', partOfSpeech: 'adverb', translations: ['בקרוב'] });
    await t.db.execute(sql`update dict_var_translations set accepted_answers = array['a breve']::text[] where variant_id = ${tra.variantIds[0]}`);
    const skoro = await word({ lemma: 'скоро', languageCode: 'ru', partOfSpeech: 'adverb', translations: ['תכף'] });
    await t.db.execute(sql`update dict_var_translations set accepted_answers = array['вскоре']::text[] where variant_id = ${skoro.variantIds[0]}`);

    const known = await dict((repo) =>
      repo.findKnownRight({ glossIds: [], lexemeIds: [], variantIds: [], prompts: ['תכף'], userLanguageCode: 'he', targetLanguage: 'it' }),
    );
    // Keyed by each rendering's own text; the domain matches them under comparable.
    expect(Object.fromEntries([...known.wordsByPrompt].map(([prompt, words]) => [prompt, sorted(words)]))).toEqual({
      'תכף': ['ora'],
      'תֵּכֶף.': sorted(['fra poco', 'presto', 'subito']),
    });
  });

  it('reads nothing for no picks', async () => {
    const known = await dict((repo) => repo.findKnownRight({ glossIds: [], lexemeIds: [], variantIds: [], prompts: [], userLanguageCode: 'he', targetLanguage: 'en' }));
    expect([known.meaningsByLexeme.size, known.meaningsByGloss.size, known.wordsByPrompt.size]).toEqual([0, 0, 0]);
  });
});
