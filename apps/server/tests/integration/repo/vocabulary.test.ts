import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DIMENSIONS, LIVE_DIMENSIONS } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { assemblePage, type VocabularyCursor } from '../../../src/domain/vocabulary';
import { createDictRepo } from '../../../src/repo/dictionary';
import { createVocabularyRepo } from '../../../src/repo/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { insertProgressRows, readProgress, setLevel } from '../../support/progressRows';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_1'); // he → en
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[]; glossIds: string[] };
let hebrew: { lexemeId: string; variantIds: string[]; senseIds: string[]; glossIds: string[] };

// `kite` renders both senses; `kites` renders only the toy, ranked first.
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }, { senseCode: 'bird' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
          { senseCode: 'bird', rank: 1, translation: 'דיה', exampleSource: null, exampleTarget: null },
        ],
      },
      {
        form: 'kites',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפונים', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
  hebrew = await insertLexeme(t.db, {
    lemma: 'ספר',
    languageCode: 'he',
    partOfSpeech: 'noun',
    userLanguageCode: 'en',
    senses: [{ senseCode: 'book' }],
    variants: [
      {
        form: 'ספר',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'book', rank: 0, translation: 'book', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createVocabularyRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createVocabularyRepo(tx)));

const [TOY, BIRD] = [0, 1];
const [KITE, KITES] = [0, 1];
const pair = (sense: number, variant: number) => ({
  glossId: kite.glossIds[sense],
  variantId: kite.variantIds[variant],
});

describe('findSaveable', () => {
  const ask = (entries: { glossId: string; variantId: string }[], target = 'en', source = 'he') =>
    repo((r) => r.findSaveable({ entries, targetLanguage: target, sourceLanguage: source }));

  it('passes a pair whose form renders the sense in the source language, with its lexeme and lemma', async () => {
    expect(await ask([pair(TOY, KITES)])).toEqual([{ ...pair(TOY, KITES), lexemeId: kite.lexemeId, lemma: 'kite' }]);
  });

  it('refuses a form that does not render that sense', async () => {
    expect(await ask([pair(BIRD, KITES)])).toEqual([]);
  });

  it('refuses a variant of another lexeme', async () => {
    expect(
      await ask([{ glossId: kite.glossIds[TOY], variantId: hebrew.variantIds[0] }]),
    ).toEqual([]);
  });

  it("refuses a gloss outside the enrollment's languages", async () => {
    expect(
      await ask([{ glossId: hebrew.glossIds[0], variantId: hebrew.variantIds[0] }]),
    ).toEqual([]);
  });

  it("refuses a rendering in a language other than the enrollment's source", async () => {
    expect(await ask([pair(TOY, KITE)], 'en', 'ru')).toEqual([]);
  });

  // Phase 31 (spec D14): a write resolves a forwarded gloss before it asks.
  it('refuses a gloss merged into another', async () => {
    await t.db.execute(sql`update dict_glosses set merged_into = ${kite.glossIds[BIRD]} where id = ${kite.glossIds[TOY]}`);
    expect(await ask([pair(TOY, KITES)])).toEqual([]);
  });

  it('answers nothing for nothing, without a query', async () => {
    expect(await ask([])).toEqual([]);
  });
});

describe('insertEntries and deleteEntry', () => {
  const entry = (sense: number, variant: number) => ({ ...pair(sense, variant), lexemeId: kite.lexemeId, lemma: 'kite' });

  it("writes the lexeme's lemma onto the entry", async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITES)] }));
    const rows = await t.db.execute<{ lemma: string }>(
      sql`select lemma from vocabulary_entries where enrollment_id = ${E}`,
    );
    expect(rows.rows).toEqual([{ lemma: 'kite' }]);
  });

  it('keeps the first form when the same gloss is saved again', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITES)] }));
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITE)] }));
    expect(await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'kite', ownerUserId: 'u_1' }))).toEqual([{ ...pair(TOY, KITES), addedBy: null }]);
  });

  it('gives a new entry its five level 1 progress rows, and a repeat adds none', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITE)] }));
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITES)] }));
    const rows = await readProgress(t.db, E);
    expect(rows.map((row) => row.dimension).sort()).toEqual([...DIMENSIONS].sort());
    expect(rows.every((row) => row.glossId === kite.glossIds[TOY] && row.level === 1)).toBe(true);
  });

  it('takes the progress rows with the entry, and a re-save starts again at level 1', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITE)] }));
    await t.db.execute(sql`update gloss_progress set level = 3`);
    await repo((r) => r.deleteEntry({ enrollmentId: E, glossId: kite.glossIds[TOY] }));
    expect(await readProgress(t.db, E)).toEqual([]);
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITE)] }));
    // The count first: `every` is true of an empty array.
    const rows = await readProgress(t.db, E);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.level === 1)).toBe(true);
  });

  it('deletes idempotently', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(TOY, KITE)] }));
    await repo((r) => r.deleteEntry({ enrollmentId: E, glossId: kite.glossIds[TOY] }));
    await repo((r) => r.deleteEntry({ enrollmentId: E, glossId: kite.glossIds[TOY] }));
    expect(await repo((r) => r.findSavedGlossIds({ enrollmentId: E, glossIds: kite.glossIds }))).toEqual([]);
  });

  it('finds which of the asked glosses are saved', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, addedByUserId: 'u_1', entries: [entry(BIRD, KITE)] }));
    expect(
      await repo((r) => r.findSavedGlossIds({ enrollmentId: E, glossIds: kite.glossIds })),
    ).toEqual([kite.glossIds[BIRD]]);
    expect(await repo((r) => r.findSavedGlossIds({ enrollmentId: E, glossIds: [] }))).toEqual([]);
  });
});

// Direct inserts with chosen timestamps: ordering must be provable against rows
// a test chose, not against how fast two transactions happened to commit.
async function saveAt(lexemeId: string, glossId: string, variantId: string, at: string) {
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, created_at, added_by_user_id)
    values (${E}, ${glossId}, ${lexemeId}, (select lemma from dict_lexemes where id = ${lexemeId}),
            ${variantId}, ${at}::timestamptz, 'u_1')`);
  // An entry with no progress rows has no level, and the list leaves it out.
  await insertProgressRows(t.db, E, [glossId]);
}

async function lexemes(n: number) {
  const out: { lexemeId: string; glossId: string; variantId: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const ids = await insertLexeme(t.db, {
      lemma: `word${i}`,
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'only' }],
      variants: [
        {
          form: `word${i}`,
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'only', rank: 0, translation: `מילה${i}`, exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    out.push({ lexemeId: ids.lexemeId, glossId: ids.glossIds[0], variantId: ids.variantIds[0] });
  }
  return out;
}

const page = (input: { after?: VocabularyCursor; limit?: number; level?: number | null } = {}) =>
  repo((r) =>
    r.findWordsPage({
      enrollmentId: E,
      limit: input.limit ?? 50,
      after: input.after ?? null,
      level: input.level ?? null,
      live: LIVE_DIMENSIONS,
    }),
  );
const summaries = (lemmas: string[]) =>
  repo((r) => r.findWordSummaries({ enrollmentId: E, lemmas, targetLanguage: 'en', sourceLanguage: 'he', ownerUserId: 'u_1' }));

/** `kite` the verb: a second lexeme of the lemma, its form at entry rank 1. */
async function kiteVerb() {
  return insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'fly' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 1,
        translations: [
          { senseCode: 'fly', rank: 0, translation: 'להטיס עפיפון', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
}

describe('findWordsPage', () => {
  it('orders lemmas by their newest save, keeps microseconds, and continues strictly after a cursor', async () => {
    const [a, b, c] = await lexemes(3);
    await saveAt(a.lexemeId, a.glossId, a.variantId, '2026-10-04 12:00:00.000001+00');
    await saveAt(b.lexemeId, b.glossId, b.variantId, '2026-10-04 12:00:00.000003+00');
    await saveAt(c.lexemeId, c.glossId, c.variantId, '2026-10-04 12:00:00.000002+00');

    const first = await page({ limit: 2 });
    expect(first.map((row) => row.lemma)).toEqual(['word1', 'word2']);

    const last = first[first.length - 1];
    const rest = await page({ limit: 2, after: { savedAt: last.lastSavedAt, lemma: last.lemma } });
    // Same millisecond, different microsecond: a Date-based cursor would lose `a`.
    expect(rest.map((row) => row.lemma)).toEqual(['word0']);
  });

  it('breaks a tie on the save time by lemma, descending, and continues through it', async () => {
    const words = await lexemes(3);
    for (const w of words) await saveAt(w.lexemeId, w.glossId, w.variantId, '2026-10-04 12:00:00+00');
    expect((await page()).map((row) => row.lemma)).toEqual(['word2', 'word1', 'word0']);
    const [first] = await page({ limit: 1 });
    expect((await page({ after: { savedAt: first.lastSavedAt, lemma: first.lemma } })).map((r) => r.lemma)).toEqual([
      'word1',
      'word0',
    ]);
  });

  it("groups a lexeme's senses into one row at its newest save", async () => {
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.glossIds[BIRD], kite.variantIds[KITE], '2026-10-04 13:00:00+00');
    const rows = await page();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSavedAt).toMatch(/^2026-10-04 13:00:00/);
  });

  it('groups two lexemes of one lemma into one row, at the newer save, with one level', async () => {
    const verb = await kiteVerb();
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(verb.lexemeId, verb.glossIds[0], verb.variantIds[0], '2026-10-04 14:00:00+00');
    await setLevel(t.db, { enrollmentId: E, glossId: kite.glossIds[TOY], level: 5 });
    await setLevel(t.db, { enrollmentId: E, glossId: verb.glossIds[0], level: 2 });
    expect(await page()).toEqual([{ lemma: 'kite', lastSavedAt: expect.stringMatching(/^2026-10-04 14:00:00/), level: 4 }]);
    // The filter sees the merged level, not either lexeme's.
    expect((await page({ level: 4 })).map((r) => r.lemma)).toEqual(['kite']);
    expect(await page({ level: 5 })).toEqual([]);
    expect(await page({ level: 2 })).toEqual([]);
  });

  // Review Focus 2.
  it('keeps lemmas that differ only in case apart', async () => {
    const may = await insertLexeme(t.db, {
      lemma: 'May',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'month' }],
      variants: [{ form: 'May', kind: 'word', entryRank: 0, translations: [
        { senseCode: 'month', rank: 0, translation: 'מאי', exampleSource: null, exampleTarget: null },
      ] }],
    });
    const mayVerb = await insertLexeme(t.db, {
      lemma: 'may',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'might' }],
      variants: [{ form: 'may', kind: 'word', entryRank: 1, translations: [
        { senseCode: 'might', rank: 0, translation: 'עשוי', exampleSource: null, exampleTarget: null },
      ] }],
    });
    await saveAt(may.lexemeId, may.glossIds[0], may.variantIds[0], '2026-10-04 12:00:00+00');
    await saveAt(mayVerb.lexemeId, mayVerb.glossIds[0], mayVerb.variantIds[0], '2026-10-04 12:00:01+00');
    expect((await page()).map((r) => r.lemma)).toEqual(['may', 'May']);
  });

  async function leveled(levels: number[]) {
    const words = await lexemes(levels.length);
    for (const [i, word] of words.entries()) {
      await saveAt(word.lexemeId, word.glossId, word.variantId, `2026-10-04 12:00:0${i}+00`);
      await setLevel(t.db, { enrollmentId: E, glossId: word.glossId, level: levels[i] });
    }
    return words.map((_, i) => `word${i}`);
  }

  it('gives each row its level', async () => {
    const [w0] = await leveled([3]);
    expect(await page()).toEqual([{ lemma: w0, lastSavedAt: expect.any(String), level: 3 }]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.glossIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:01+00');
    await setLevel(t.db, { enrollmentId: E, glossId: kite.glossIds[TOY], level: 2 });
    await setLevel(t.db, { enrollmentId: E, glossId: kite.glossIds[BIRD], level: 3 });
    expect((await page())[0].level).toBe(3);
  });

  it('reads every dimension, spoken_productive included', async () => {
    const [w] = await lexemes(1);
    await saveAt(w.lexemeId, w.glossId, w.variantId, '2026-10-04 12:00:00+00');
    // Phase 25 made spoken_productive live: (1+1+1+1+5)/5 = 1.8 reads 2.
    await setLevel(t.db, { enrollmentId: E, glossId: w.glossId, level: 5, dimension: 'spoken_productive' });
    expect(await page()).toEqual([expect.objectContaining({ lemma: 'word0', level: 2 })]);
  });

  it('filters to one level, newest first, and continues a filtered walk after its cursor', async () => {
    const [, highOld, highNew] = await leveled([1, 4, 4, 2]);
    expect((await page({ level: 4 })).map((r) => r.lemma)).toEqual([highNew, highOld]);
    expect(await page({ level: 3 })).toEqual([]);
    const [first] = await page({ level: 4, limit: 1 });
    const rest = await page({ level: 4, after: { savedAt: first.lastSavedAt, lemma: first.lemma } });
    expect(rest.map((r) => r.lemma)).toEqual([highOld]);
  });
});

describe('findWordSummaries', () => {
  it('headlines the lowest-ranked saved sense in its saved form, and counts', async () => {
    // bird is rank 1 in `kite`; toy is rank 0 in `kites`, so toy headlines.
    await saveAt(kite.lexemeId, kite.glossIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITES], '2026-10-04 13:00:00+00');
    expect(await summaries(['kite'])).toEqual([
      {
        lemma: 'kite',
        partsOfSpeech: ['noun'],
        headlineGlossId: kite.glossIds[TOY],
        headlineTranslation: 'עפיפונים',
        headlineForm: 'kites',
        savedCount: 2,
        senseCount: 2,
        addedBy: [],
      },
    ]);
  });

  it('counts and names parts of speech across every lexeme of the lemma', async () => {
    const verb = await kiteVerb();
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(verb.lexemeId, verb.glossIds[0], verb.variantIds[0], '2026-10-04 13:00:00+00');
    expect(await summaries(['kite'])).toEqual([
      expect.objectContaining({ lemma: 'kite', partsOfSpeech: ['noun', 'verb'], savedCount: 2, senseCount: 3 }),
    ]);
  });

  it('names only the parts of speech that have a saved sense, but counts every sense', async () => {
    await kiteVerb();
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    expect(await summaries(['kite'])).toEqual([
      expect.objectContaining({ partsOfSpeech: ['noun'], savedCount: 1, senseCount: 3 }),
    ]);
  });

  it('breaks a rank tie by the earlier save', async () => {
    // Make bird rank 0 in `kite` (toy moves to 2), so both saved senses are rank 0
    // in their own saved forms: toy in `kites`, bird in `kite`.
    await t.db.execute(sql`
      update dict_var_translations set rank = 2
       where variant_id = ${kite.variantIds[KITE]} and sense_id = ${kite.senseIds[TOY]}`);
    await t.db.execute(sql`
      update dict_var_translations set rank = 0
       where variant_id = ${kite.variantIds[KITE]} and sense_id = ${kite.senseIds[BIRD]}`);
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITES], '2026-10-04 13:00:00+00');
    await saveAt(kite.lexemeId, kite.glossIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    const [summary] = await summaries(['kite']);
    // bird was saved first.
    expect(summary.headlineGlossId).toBe(kite.glossIds[BIRD]);
  });

  it('returns no summary for a lemma whose saved senses have no rendering left', async () => {
    await saveAt(kite.lexemeId, kite.glossIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await t.db.execute(sql`delete from dict_var_translations
      where sense_id = ${kite.senseIds[BIRD]} and variant_id = ${kite.variantIds[KITE]}`);
    expect(await summaries(['kite'])).toEqual([]);
  });

  it('drops such a word from an assembled page while its page row still advances the cursor', async () => {
    await saveAt(kite.lexemeId, kite.glossIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await t.db.execute(sql`delete from dict_var_translations
      where sense_id = ${kite.senseIds[BIRD]} and variant_id = ${kite.variantIds[KITE]}`);
    const rows = await page();
    expect(rows.map((row) => row.lemma)).toEqual(['kite']);
    expect(assemblePage(rows, await summaries(rows.map((row) => row.lemma)))).toEqual([]);
  });

  it('answers nothing for no lemmas', async () => {
    expect(await summaries([])).toEqual([]);
  });
});

describe('the drill-down reads', () => {
  // A second `kite` lexeme, a verb, so a lemma spans two lexemes. Its form is also
  // `kite`, so it takes entry rank 1 (dict_variants_form_entry_rank_key).
  let kiteVerb: { lexemeId: string; variantIds: string[]; senseIds: string[]; glossIds: string[] };
  beforeEach(async () => {
    kiteVerb = await insertLexeme(t.db, {
      lemma: 'kite',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'fly' }],
      variants: [
        {
          form: 'kite',
          kind: 'word',
          entryRank: 1,
          translations: [
            { senseCode: 'fly', rank: 0, translation: 'להטיס עפיפון', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
  });

  it('finds every lexeme of a lemma in one language, by part of speech', async () => {
    expect(await repo((r) => r.findLemmaLexemes({ languageCode: 'en', lemma: 'kite' }))).toEqual([
      { lexemeId: kite.lexemeId, partOfSpeech: 'noun' },
      { lexemeId: kiteVerb.lexemeId, partOfSpeech: 'verb' },
    ]);
    expect(await repo((r) => r.findLemmaLexemes({ languageCode: 'he', lemma: 'kite' }))).toEqual([]);
  });

  // Review Focus 2: lemmas match exactly.
  it('matches the lemma exactly, case included', async () => {
    expect(await repo((r) => r.findLemmaLexemes({ languageCode: 'en', lemma: 'Kite' }))).toEqual([]);
  });

  it("returns every rendering of every lexeme's senses in one language, with its lexeme", async () => {
    const rows = await repo((r) =>
      r.findLemmaRenderings({ languageCode: 'en', lemma: 'kite', userLanguageCode: 'he' }),
    );
    expect(rows.map((row) => `${row.lexemeId === kite.lexemeId ? 'noun' : 'verb'}:${row.form}:${row.translation}`).sort()).toEqual([
      'noun:kite:דיה',
      'noun:kite:עפיפון',
      'noun:kites:עפיפונים',
      'verb:kite:להטיס עפיפון',
    ]);
    expect(
      await repo((r) => r.findLemmaRenderings({ languageCode: 'en', lemma: 'kite', userLanguageCode: 'ru' })),
    ).toEqual([]);
  });

  it("finds the enrollment's saved entries across the lemma's lexemes", async () => {
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITES], '2026-10-04 12:00:00+00');
    await saveAt(kiteVerb.lexemeId, kiteVerb.glossIds[0], kiteVerb.variantIds[0], '2026-10-04 12:00:01+00');
    const saved = await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'kite', ownerUserId: 'u_1' }));
    expect(saved.sort((a, b) => a.glossId.localeCompare(b.glossId))).toEqual(
      [
        { ...pair(TOY, KITES), addedBy: null },
        { glossId: kiteVerb.glossIds[0], variantId: kiteVerb.variantIds[0], addedBy: null },
      ].sort((a, b) => a.glossId.localeCompare(b.glossId)),
    );
    expect(await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'fly', ownerUserId: 'u_1' }))).toEqual([]);
  });
});

// Spec §6 "Repair". A saved entry names its sense and the form it was saved
// from, and deliberately has no foreign key to dict_var_translations:
// repairVariantRenderings deletes and re-inserts that variant's rows, so such a
// key would either block the repair or take the entry down with it.
describe('a repaired variant', () => {
  it('keeps its saved entries, and the word still headlines on the list', async () => {
    await saveAt(kite.lexemeId, kite.glossIds[TOY], kite.variantIds[KITES], '2026-10-04 12:00:00+00');

    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([kite.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: kite.variantIds[KITES],
        lexemeId: kite.lexemeId,
        userLanguageCode: 'he',
        senseVersion: await dict.findSenseVersion({ lexemeId: kite.lexemeId }),
        lemmaForm: false,
        senses: [
          {
            senseId: kite.senseIds[TOY],
            rank: 3,
            translation: 'עפיפונים מתוקנים',
            alternatives: [],
            gloss: 'עפיפונים מתוקנים',
            glossAlternatives: [],
            definition: null,
            exampleSource: null,
            exampleTarget: null,
          },
        ],
      });
    });

    expect(await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'kite', ownerUserId: 'u_1' }))).toEqual([{ ...pair(TOY, KITES), addedBy: null }]);
    expect((await page()).map((row) => row.lemma)).toEqual(['kite']);
    expect(await summaries(['kite'])).toEqual([
      expect.objectContaining({
        headlineGlossId: kite.glossIds[TOY],
        headlineTranslation: 'עפיפונים מתוקנים',
        headlineForm: 'kites',
        savedCount: 1,
      }),
    ]);
  });
});

describe('the saved list for sessions (phase 19)', () => {
  it('lists every saved gloss with its form and the sense that form ranks first, and counts them', async () => {
    const word = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'onion', translations: ['בצל', 'קשת'] });
    const listed = await repo((r) => r.listSavedGlosses(E));
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map((e) => e.glossId))).toEqual(new Set(word.glossIds));
    expect(listed.every((e) => e.senseId === word.senseIds[word.glossIds.indexOf(e.glossId)])).toBe(true);
    expect(listed.every((e) => e.variantId === word.variantId)).toBe(true);
    expect(await repo((r) => r.countEntries(E))).toBe(2);
  });

  // Phase 31 (spec D3). Two senses one target word renders are one gloss,
  // saved and listed once, with the sense the saved form ranks first.
  it('lists a gloss of two senses once, with the sense its saved form ranks first', async () => {
    const word = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'mouse', translations: ['עכבר', 'עכבר'] });
    expect(word.glossIds[1]).toBe(word.glossIds[0]);
    expect(await repo((r) => r.listSavedGlosses(E))).toEqual([
      { glossId: word.glossIds[0], senseId: word.senseIds[0], variantId: word.variantId },
    ]);
    expect(await repo((r) => r.countEntries(E))).toBe(1);
  });

  it('lists and counts nothing for an enrollment that saved nothing', async () => {
    await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'onion', translations: ['בצל'] });
    await seedUser(t.db, 'u_2');
    expect(await repo((r) => r.listSavedGlosses(enrollmentOf('u_2')))).toEqual([]);
    expect(await repo((r) => r.countEntries(enrollmentOf('u_2')))).toBe(0);
  });
});
