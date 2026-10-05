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
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };
let hebrew: { lexemeId: string; variantIds: string[]; senseIds: string[] };

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
  senseId: kite.senseIds[sense],
  variantId: kite.variantIds[variant],
});

// What every phase 18 test meant by a page: newest first, no filter.
const NEWEST = { sort: 'newest' as const, level: null, live: LIVE_DIMENSIONS };

describe('findSaveable', () => {
  const ask = (entries: { senseId: string; variantId: string }[], target = 'en', source = 'he') =>
    repo((r) => r.findSaveable({ entries, targetLanguage: target, sourceLanguage: source }));

  it('passes a pair whose form renders the sense in the source language, with its lexeme', async () => {
    expect(await ask([pair(TOY, KITES)])).toEqual([{ ...pair(TOY, KITES), lexemeId: kite.lexemeId }]);
  });

  it('refuses a form that does not render that sense', async () => {
    expect(await ask([pair(BIRD, KITES)])).toEqual([]);
  });

  it('refuses a variant of another lexeme', async () => {
    expect(
      await ask([{ senseId: kite.senseIds[TOY], variantId: hebrew.variantIds[0] }]),
    ).toEqual([]);
  });

  it("refuses a sense outside the enrollment's target language", async () => {
    expect(
      await ask([{ senseId: hebrew.senseIds[0], variantId: hebrew.variantIds[0] }]),
    ).toEqual([]);
  });

  it("refuses a rendering in a language other than the enrollment's source", async () => {
    expect(await ask([pair(TOY, KITE)], 'en', 'ru')).toEqual([]);
  });

  it('answers nothing for nothing, without a query', async () => {
    expect(await ask([])).toEqual([]);
  });
});

describe('insertEntries and deleteEntry', () => {
  const entry = (sense: number, variant: number) => ({ ...pair(sense, variant), lexemeId: kite.lexemeId });

  it('keeps the first form when the same sense is saved again', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITES)] }));
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    expect(await repo((r) => r.findSavedInLexeme({ enrollmentId: E, lexemeId: kite.lexemeId }))).toEqual([
      pair(TOY, KITES),
    ]);
  });

  it('gives a new entry its five level 1 progress rows, and a repeat adds none', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITES)] }));
    const rows = await readProgress(t.db, E);
    expect(rows.map((row) => row.dimension).sort()).toEqual([...DIMENSIONS].sort());
    expect(rows.every((row) => row.senseId === kite.senseIds[TOY] && row.level === 1)).toBe(true);
  });

  it('takes the progress rows with the entry, and a re-save starts again at level 1', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    await t.db.execute(sql`update sense_progress set level = 3`);
    await repo((r) => r.deleteEntry({ enrollmentId: E, senseId: kite.senseIds[TOY] }));
    expect(await readProgress(t.db, E)).toEqual([]);
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    expect((await readProgress(t.db, E)).every((row) => row.level === 1)).toBe(true);
  });

  it('deletes idempotently', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    await repo((r) => r.deleteEntry({ enrollmentId: E, senseId: kite.senseIds[TOY] }));
    await repo((r) => r.deleteEntry({ enrollmentId: E, senseId: kite.senseIds[TOY] }));
    expect(await repo((r) => r.findSavedSenseIds({ enrollmentId: E, senseIds: kite.senseIds }))).toEqual([]);
  });

  it('finds which of the asked senses are saved', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(BIRD, KITE)] }));
    expect(
      await repo((r) => r.findSavedSenseIds({ enrollmentId: E, senseIds: kite.senseIds })),
    ).toEqual([kite.senseIds[BIRD]]);
    expect(await repo((r) => r.findSavedSenseIds({ enrollmentId: E, senseIds: [] }))).toEqual([]);
  });
});

// Direct inserts with chosen timestamps: ordering must be provable against rows
// a test chose, not against how fast two transactions happened to commit.
async function saveAt(lexemeId: string, senseId: string, variantId: string, at: string) {
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
    values (${E}, ${senseId}, ${lexemeId}, ${variantId}, ${at}::timestamptz)`);
  // An entry with no progress rows has no level, and the list leaves it out.
  await insertProgressRows(t.db, E, [senseId]);
}

async function lexemes(n: number) {
  const out: { lexemeId: string; senseId: string; variantId: string }[] = [];
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
    out.push({ lexemeId: ids.lexemeId, senseId: ids.senseIds[0], variantId: ids.variantIds[0] });
  }
  return out;
}

describe('findWordsPage', () => {
  it('orders lexemes by their newest save, keeps microseconds, and continues strictly after a cursor', async () => {
    const [a, b, c] = await lexemes(3);
    await saveAt(a.lexemeId, a.senseId, a.variantId, '2026-10-04 12:00:00.000001+00');
    await saveAt(b.lexemeId, b.senseId, b.variantId, '2026-10-04 12:00:00.000003+00');
    await saveAt(c.lexemeId, c.senseId, c.variantId, '2026-10-04 12:00:00.000002+00');

    const first = await repo((r) => r.findWordsPage({ ...NEWEST, enrollmentId: E, limit: 2, after: null }));
    expect(first.map((row) => row.lexemeId)).toEqual([b.lexemeId, c.lexemeId]);

    const last = first[first.length - 1];
    const rest = await repo((r) =>
      r.findWordsPage({
        ...NEWEST,
        enrollmentId: E,
        limit: 2,
        after: { sort: 'newest', savedAt: last.lastSavedAt, lexemeId: last.lexemeId },
      }),
    );
    // Same millisecond, different microsecond: a Date-based cursor would lose `a`.
    expect(rest.map((row) => row.lexemeId)).toEqual([a.lexemeId]);
  });

  it("groups a lexeme's senses into one row at its newest save", async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 13:00:00+00');
    const page = await repo((r) => r.findWordsPage({ ...NEWEST, enrollmentId: E, limit: 50, after: null }));
    expect(page).toHaveLength(1);
    expect(page[0].lastSavedAt).toMatch(/^2026-10-04 13:00:00/);
  });

  async function leveled(levels: number[]) {
    const words = await lexemes(levels.length);
    for (const [i, word] of words.entries()) {
      await saveAt(word.lexemeId, word.senseId, word.variantId, `2026-10-04 12:00:0${i}+00`);
      await setLevel(t.db, { enrollmentId: E, senseId: word.senseId, level: levels[i] });
    }
    return words.map((word) => word.lexemeId);
  }
  const wordsPage = (input: {
    sort: 'newest' | 'level_asc' | 'level_desc';
    level?: number | null;
    after?: VocabularyCursor;
    limit?: number;
  }) =>
    repo((r) =>
      r.findWordsPage({
        enrollmentId: E,
        limit: input.limit ?? 50,
        after: input.after ?? null,
        sort: input.sort,
        level: input.level ?? null,
        live: LIVE_DIMENSIONS,
      }),
    );

  it('gives each row its level', async () => {
    const [w0] = await leveled([3]);
    expect(await wordsPage({ sort: 'newest' })).toEqual([{ lexemeId: w0, lastSavedAt: expect.any(String), level: 3 }]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:01+00');
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[TOY], level: 2 });
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[BIRD], level: 3 });
    expect((await wordsPage({ sort: 'newest' }))[0].level).toBe(3);
  });

  it('reads only the live dimensions', async () => {
    const [w] = await lexemes(1);
    await saveAt(w.lexemeId, w.senseId, w.variantId, '2026-10-04 12:00:00+00');
    await setLevel(t.db, { enrollmentId: E, senseId: w.senseId, level: 5, dimension: 'spelling' });
    expect(await wordsPage({ sort: 'newest' })).toEqual([expect.objectContaining({ lexemeId: w.lexemeId, level: 1 })]);
  });

  it('sorts by level both ways, the newer save first within a level', async () => {
    const [low, highOld, highNew, mid] = await leveled([1, 4, 4, 2]);
    expect((await wordsPage({ sort: 'level_desc' })).map((r) => r.lexemeId)).toEqual([highNew, highOld, mid, low]);
    expect((await wordsPage({ sort: 'level_asc' })).map((r) => r.lexemeId)).toEqual([low, mid, highNew, highOld]);
  });

  it('filters to one level under any sort', async () => {
    const [, highOld, highNew] = await leveled([1, 4, 4, 2]);
    expect((await wordsPage({ sort: 'newest', level: 4 })).map((r) => r.lexemeId)).toEqual([highNew, highOld]);
    expect(await wordsPage({ sort: 'level_asc', level: 3 })).toEqual([]);
  });

  it.each(['level_asc', 'level_desc'] as const)('continues a %s walk strictly after its cursor', async (sort) => {
    await leveled([2, 1, 2, 3, 1]);
    const all = await wordsPage({ sort });
    const first = await wordsPage({ sort, limit: 2 });
    const last = first[first.length - 1];
    const rest = await wordsPage({ sort, after: { sort, savedAt: last.lastSavedAt, lexemeId: last.lexemeId, level: last.level } });
    expect([...first, ...rest].map((r) => r.lexemeId)).toEqual(all.map((r) => r.lexemeId));
  });
});

describe('findWordSummaries', () => {
  it('headlines the lowest-ranked saved sense in its saved form, and counts', async () => {
    // bird is rank 1 in `kite`; toy is rank 0 in `kites`, so toy headlines.
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITES], '2026-10-04 13:00:00+00');
    expect(
      await repo((r) =>
        r.findWordSummaries({ enrollmentId: E, lexemeIds: [kite.lexemeId], sourceLanguage: 'he' }),
      ),
    ).toEqual([
      {
        lexemeId: kite.lexemeId,
        lemma: 'kite',
        partOfSpeech: 'noun',
        headlineSenseId: kite.senseIds[TOY],
        headlineTranslation: 'עפיפונים',
        headlineForm: 'kites',
        savedCount: 2,
        senseCount: 2,
      },
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
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITES], '2026-10-04 13:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    const [summary] = await repo((r) =>
      r.findWordSummaries({ enrollmentId: E, lexemeIds: [kite.lexemeId], sourceLanguage: 'he' }),
    );
    // bird was saved first.
    expect(summary.headlineSenseId).toBe(kite.senseIds[BIRD]);
  });

  // Review Focus 5, at the source.
  it('returns no summary for a lexeme whose saved senses have no rendering left', async () => {
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await t.db.execute(sql`delete from dict_var_translations
      where sense_id = ${kite.senseIds[BIRD]} and variant_id = ${kite.variantIds[KITE]}`);
    expect(
      await repo((r) =>
        r.findWordSummaries({ enrollmentId: E, lexemeIds: [kite.lexemeId], sourceLanguage: 'he' }),
      ),
    ).toEqual([]);
  });

  // Review Focus 5, end to end over the repo's reads: the page still names the
  // lexeme (so the cursor, taken from page rows, advances) while the word, having
  // nothing to headline, is dropped rather than returned headline-less.
  it('drops such a word from an assembled page while its page row still advances the cursor', async () => {
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await t.db.execute(sql`delete from dict_var_translations
      where sense_id = ${kite.senseIds[BIRD]} and variant_id = ${kite.variantIds[KITE]}`);
    const rows = await repo((r) => r.findWordsPage({ ...NEWEST, enrollmentId: E, limit: 50, after: null }));
    const summaries = await repo((r) =>
      r.findWordSummaries({
        enrollmentId: E,
        lexemeIds: rows.map((row) => row.lexemeId),
        sourceLanguage: 'he',
      }),
    );
    expect(rows.map((row) => row.lexemeId)).toEqual([kite.lexemeId]);
    expect(assemblePage(rows, summaries)).toEqual([]);
  });

  it('answers nothing for no lexemes', async () => {
    expect(
      await repo((r) => r.findWordSummaries({ enrollmentId: E, lexemeIds: [], sourceLanguage: 'he' })),
    ).toEqual([]);
  });
});

describe('the drill-down reads', () => {
  it('finds a lexeme with its language', async () => {
    expect(await repo((r) => r.findLexeme(kite.lexemeId))).toEqual({
      lexemeId: kite.lexemeId,
      lemma: 'kite',
      partOfSpeech: 'noun',
      languageCode: 'en',
    });
    expect(await repo((r) => r.findLexeme('nope'))).toBeUndefined();
  });

  it("returns every rendering of the lexeme's senses in one language", async () => {
    const rows = await repo((r) =>
      r.findLexemeRenderings({ lexemeId: kite.lexemeId, userLanguageCode: 'he' }),
    );
    expect(rows.map((row) => `${row.form}:${row.translation}`).sort()).toEqual([
      'kite:דיה',
      'kite:עפיפון',
      'kites:עפיפונים',
    ]);
    expect(
      await repo((r) => r.findLexemeRenderings({ lexemeId: kite.lexemeId, userLanguageCode: 'ru' })),
    ).toEqual([]);
  });
});

// Spec §6 "Repair". A saved entry names its sense and the form it was saved
// from, and deliberately has no foreign key to dict_var_translations:
// repairVariantRenderings deletes and re-inserts that variant's rows, so such a
// key would either block the repair or take the entry down with it.
describe('a repaired variant', () => {
  it('keeps its saved entries, and the word still headlines on the list', async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITES], '2026-10-04 12:00:00+00');

    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.repairVariantRenderings({
        variantId: kite.variantIds[KITES],
        userLanguageCode: 'he',
        senseVersion: await dict.findSenseVersion({ lexemeId: kite.lexemeId }),
        senses: [
          {
            senseId: kite.senseIds[TOY],
            rank: 3,
            translation: 'עפיפונים מתוקנים',
            exampleSource: null,
            exampleTarget: null,
          },
        ],
      });
    });

    expect(await repo((r) => r.findSavedInLexeme({ enrollmentId: E, lexemeId: kite.lexemeId }))).toEqual([
      pair(TOY, KITES),
    ]);
    const page = await repo((r) => r.findWordsPage({ ...NEWEST, enrollmentId: E, limit: 50, after: null }));
    expect(page.map((row) => row.lexemeId)).toEqual([kite.lexemeId]);
    expect(
      await repo((r) =>
        r.findWordSummaries({ enrollmentId: E, lexemeIds: [kite.lexemeId], sourceLanguage: 'he' }),
      ),
    ).toEqual([
      expect.objectContaining({
        headlineSenseId: kite.senseIds[TOY],
        headlineTranslation: 'עפיפונים מתוקנים',
        headlineForm: 'kites',
        savedCount: 1,
      }),
    ]);
  });
});

describe('the saved list for sessions (phase 19)', () => {
  it('lists every saved sense with its form, and counts them', async () => {
    const word = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'onion', translations: ['בצל', 'קשת'] });
    const listed = await repo((r) => r.listSavedSenses(E));
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map((e) => e.senseId))).toEqual(new Set(word.senseIds));
    expect(listed.every((e) => e.variantId === word.variantId)).toBe(true);
    expect(await repo((r) => r.countEntries(E))).toBe(2);
  });

  it('lists and counts nothing for an enrollment that saved nothing', async () => {
    await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'onion', translations: ['בצל'] });
    await seedUser(t.db, 'u_2');
    expect(await repo((r) => r.listSavedSenses(enrollmentOf('u_2')))).toEqual([]);
    expect(await repo((r) => r.countEntries(enrollmentOf('u_2')))).toBe(0);
  });
});
