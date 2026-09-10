import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';
import { eq } from 'drizzle-orm';

import { termVariants, vocabTermSenses } from '../../../src/db/schema';
import { createVocabRepo } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { insertTerm, type SeedSense } from '../../support/vocabRows';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

const sense = (rank: number, translation: string, over: Partial<SeedSense> = {}): SeedSense => ({
  rank,
  senseCode: `s${rank}`,
  translation,
  partOfSpeech: null,
  exampleSource: null,
  exampleTarget: null,
  ...over,
});

const find = (form: string, languageCode = 'en', userLanguageCode = 'he') =>
  withTx(t.db, (tx) =>
    createVocabRepo(tx).findSensesByForm({ form, languageCode, userLanguageCode }),
  );

describe('findSensesByForm', () => {
  it('matches case-insensitively, because the index is on lower(form)', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect((await find('Ladder')).map((row) => row.translation)).toEqual(['סולם']);
    expect((await find('LADDER')).map((row) => row.translation)).toEqual(['סולם']);
  });

  it('returns a term\'s senses in rank order', async () => {
    await insertTerm(t.db, {
      lemma: 'see',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'see', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'לראות'), sense(1, 'להבין'), sense(2, 'לפגוש')],
    });

    expect((await find('see')).map((row) => row.translation)).toEqual([
      'לראות',
      'להבין',
      'לפגוש',
    ]);
  });

  it('caps the read at five even though the database stores every sense', async () => {
    await insertTerm(t.db, {
      lemma: 'light',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'light', kind: 'word', entryRank: 0 }],
      senses: [0, 1, 2, 3, 4, 5, 6].map((n) => sense(n, `t${n}`)),
    });

    expect(await find('light')).toHaveLength(5);
  });

  it('carries the part of speech and both halves of the example', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [
        sense(0, 'סולם', {
          partOfSpeech: 'noun',
          exampleSource: 'She climbed the ladder.',
          exampleTarget: 'היא טיפסה על הסולם.',
        }),
      ],
    });

    expect(await find('ladder')).toEqual([
      {
        termId: expect.any(String),
        rank: 0,
        entryRank: 0,
        partOfSpeech: 'noun',
        exampleSource: 'She climbed the ladder.',
        translation: 'סולם',
        exampleTarget: 'היא טיפסה על הסולם.',
      },
    ]);
  });

  it('is a miss for a term with no translation in the language being asked for', async () => {
    // The inner join is the whole servability test: no column, no flag. An
    // earlier draft gated on the presence of an example, which would have made
    // an entry with a legally-absent example permanently unservable.
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect(await find('ladder', 'en', 'ru')).toEqual([]);
  });

  it('is a miss for a form nobody has queried, and for the wrong term language', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect(await find('ladders')).toEqual([]);
    expect(await find('ladder', 'he', 'en')).toEqual([]);
  });
});

const entry = (lemma: string, translations: string[]): LlmEntry => ({
  lemma,
  senses: translations.map((translation, n) => ({ translation, sense_code: `c${n}` })),
});

const persist = (form: string, entries: LlmEntry[]) =>
  withTx(t.db, (tx) =>
    createVocabRepo(tx).persistEntries({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
      entries,
    }),
  );

describe('persistEntries', () => {
  it('writes a term per entry and a variant per entry carrying its entry_rank', async () => {
    const { written } = await persist('saw', [
      entry('see', ['לראות', 'להבין']),
      entry('saw', ['מסור']),
    ]);

    expect(written.map((row) => [row.lemma, row.created])).toEqual([
      ['see', true],
      ['saw', true],
    ]);

    const variants = await t.db.select().from(termVariants).where(eq(termVariants.form, 'saw'));
    expect(variants).toHaveLength(2);
    expect(variants.map((v) => v.entryRank).sort()).toEqual([0, 1]);
    expect(new Set(variants.map((v) => v.termId)).size).toBe(2);
  });

  it('returns ids that match the rows it wrote', async () => {
    const { written } = await persist('see', [entry('see', ['לראות', 'להבין'])]);
    const [row] = written;

    const [variant] = await t.db
      .select()
      .from(termVariants)
      .where(eq(termVariants.id, row.variantId));
    expect(variant.termId).toBe(row.termId);
    expect(variant.form).toBe('see');

    const senses = await t.db
      .select()
      .from(vocabTermSenses)
      .where(eq(vocabTermSenses.termId, row.termId));
    expect(senses.map((sense) => sense.rank).sort()).toEqual([0, 1]);
    expect([...row.senseIds].sort()).toEqual(senses.map((sense) => sense.id).sort());
    // senseIds is in rank order, which is what the seed hangs its questions off.
    expect(row.senseIds[0]).toBe(senses.find((sense) => sense.rank === 0)!.id);
  });

  it('answers with the same merge the next lookup would produce', async () => {
    const { senses } = await persist('saw', [
      entry('see', ['לראות', 'להבין', 'לפגוש']),
      entry('saw', ['מסור', 'לנסר']),
    ]);

    expect(senses.map((sense) => sense.translation)).toEqual([
      'לראות',
      'מסור',
      'להבין',
      'לנסר',
      'לפגוש',
    ]);
    expect(senses).toEqual(
      (await find('saw')).map((row) => ({ translation: row.translation })),
    );
  });

  it('keeps the first writer\'s senses when an entry names a lemma that exists', async () => {
    await persist('see', [entry('see', ['לראות', 'להבין', 'לפגוש'])]);

    const { written } = await persist('saw', [
      entry('see', ['משהו אחר לגמרי']),
      entry('saw', ['מסור']),
    ]);

    expect(written[0].created).toBe(false);
    expect((await find('see')).map((row) => row.translation)).toEqual([
      'לראות',
      'להבין',
      'לפגוש',
    ]);
    // Its contribution was the variant, and nothing else.
    expect((await find('saw')).map((row) => row.translation)).toContain('לראות');
  });

  it('is idempotent: the same call twice writes nothing the second time', async () => {
    const first = await persist('see', [entry('see', ['לראות'])]);
    const second = await persist('see', [entry('see', ['לראות'])]);

    expect(second.written[0].termId).toBe(first.written[0].termId);
    expect(second.written[0].variantId).toBe(first.written[0].variantId);
    expect(second.written[0].created).toBe(false);
    // Scoped to this term rather than the whole table: the shared content seed
    // (db/seed.ts) already populates term_variants with 16 rows for the other
    // integration suites, so an unscoped count could never read 1 regardless of
    // whether the second call wrote a duplicate.
    expect(
      await t.db
        .select()
        .from(termVariants)
        .where(eq(termVariants.termId, first.written[0].termId)),
    ).toHaveLength(1);
  });

  it('writes a variant only for the form that was queried — no lemma alias', async () => {
    // An alias is a guess about a string nobody looked up: synthesizing `saw`
    // here would make a later `saw` hit and return `מסור` alone, never asking
    // the model whether the bare string has other readings.
    await persist('saws', [entry('saw', ['מסור', 'לנסר'])]);

    expect(await find('saw')).toEqual([]);
    expect((await find('saws')).map((row) => row.translation)).toEqual(['מסור', 'לנסר']);
  });

  it('leaves two transactions racing on one new lemma with a single sense set', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withTx(t.db, async (tx) => {
      const out = await createVocabRepo(tx).persistEntries({
        form: 'kite',
        languageCode: 'en',
        userLanguageCode: 'he',
        kind: 'word',
        entries: [entry('kite', ['עפיפון'])],
      });
      await held; // keep the transaction open so the second one has to block
      return out;
    });

    // Long enough for the second transaction to reach the unique index and
    // block there. It cannot proceed until `first` commits.
    const second = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const out = persist('kite', [entry('kite', ['משהו אחר'])]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      return out;
    })();

    const [a, b] = await Promise.all([first, second]);

    expect(b.written[0].termId).toBe(a.written[0].termId);
    expect(b.written[0].created).toBe(false);
    expect(b.senses.map((sense) => sense.translation)).toEqual(['עפיפון']);
    expect(
      await t.db
        .select()
        .from(vocabTermSenses)
        .where(eq(vocabTermSenses.termId, a.written[0].termId)),
    ).toHaveLength(1);
  });
});
