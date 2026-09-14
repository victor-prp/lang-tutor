import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';

import { dictLexemes, dictSenses } from '../../../src/db/schema';
import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/**
 * Follows `dictionary.pos.test.ts`: `cook`, not `book`, because the seed holds
 * `book` and first-writer-wins would make every call below write nothing. The
 * `persist`/`find` helpers are copied verbatim rather than shared, so this
 * regression and that one can fail independently.
 */

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const persist = (form: string, entries: unknown) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
      entries: entries as never,
    }),
  );

const find = (form: string) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).findSensesByForm({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
    }),
  );

// `cook` is two lexemes. `cooks` realises both AND teaches the noun a second
// sense, which is the growth event the whole task is about.
const COOK = [
  { lemma: 'cook', part_of_speech: 'noun',
    senses: [{ sense_code: 'kitchen_worker', translation: 'N-COOK' }] },
  { lemma: 'cook', part_of_speech: 'verb',
    senses: [{ sense_code: 'prepare_food', translation: 'V-COOK' }] },
];

const COOKS_PLUS_ONE = [
  { lemma: 'cook', part_of_speech: 'noun',
    senses: [
      { sense_code: 'kitchen_worker',  translation: 'N-COOKS' },
      { sense_code: 'cookery_writer',  translation: 'N-COOKS-2' }, // learned here
    ] },
  { lemma: 'cook', part_of_speech: 'verb',
    senses: [{ sense_code: 'prepare_food', translation: 'V-COOKS' }] },
];

/** The variant id and its sense ids, as `persistEntries` reported them. */
const variantOf = async (form: string, partOfSpeech: string) => {
  const { written } = await persist(form, partOfSpeech === 'noun' ? [COOK[0]] : [COOK[1]]);
  return written[0];
};

describe('a form is re-rendered when its lexeme has learned more', () => {
  it('reports only the lexeme that is behind, across a form that spans two', async () => {
    await persist('cook', COOK);            // noun + verb, one sense each
    await persist('cooks', COOKS_PLUS_ONE); // teaches the NOUN a second sense

    const stale = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' }));

    expect(stale).toHaveLength(1);
    expect(stale[0].partOfSpeech).toBe('noun');
  });

  it('re-ranks rather than appends, and leaves ranks contiguous from zero', async () => {
    const noun = await variantOf('cook', 'noun');          // one sense, rank 0
    await persist('cooks', COOKS_PLUS_ONE);                // the lexeme gains a second
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' }));

    const stored = await withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByLexeme({
        lemma: 'cook', partOfSpeech: 'noun', languageCode: 'en', userLanguageCode: 'he',
      }));
    const idOf = (code: string) => stored.find((s) => s.senseCode === code)!.senseId;

    await withTx(t.db, (tx) =>
      createDictRepo(tx).repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senses: [
          // The NEWLY learned sense placed FIRST — which is the whole point.
          { senseId: idOf('cookery_writer'), rank: 0, translation: 'NEW-FIRST',  exampleSource: null, exampleTarget: null },
          { senseId: idOf('kitchen_worker'), rank: 1, translation: 'NEW-SECOND', exampleSource: null, exampleTarget: null },
        ],
      }));

    // Appending at max(rank)+1 would have put NEW-FIRST last, which is exactly
    // the failure the spec's "Sense order belongs to the form" describes.
    const rows = await find('cook');
    expect(rows.map((r) => r.translation)).toEqual(['NEW-FIRST', 'NEW-SECOND']);
    expect(rows.map((r) => r.rank)).toEqual([0, 1]);
    expect(noun.variantId).toBe(stale.variantId);
  });

  it('marks the variant level again, so a second lookup is not a second repair', async () => {
    await variantOf('cook', 'noun');
    await persist('cooks', COOKS_PLUS_ONE);
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' }));

    const stored = await withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByLexeme({
        lemma: 'cook', partOfSpeech: 'noun', languageCode: 'en', userLanguageCode: 'he',
      }));

    await withTx(t.db, (tx) =>
      createDictRepo(tx).repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senses: stored.map((sense, rank) => ({
          senseId: sense.senseId, rank, translation: `R-${rank}`,
          exampleSource: null, exampleTarget: null,
        })),
      }));

    expect(
      await withTx(t.db, (tx) =>
        createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' })),
    ).toEqual([]);
  });
});

// Review round 1: the 4b recompute looked concurrency-safe (a fresh `count(*)`
// rather than `+= n`) but was not, and this is the reproduction. Two real
// sessions — two pooled connections against the same test database, exactly
// like the two-session script that found the bug — write different NEW
// forms of the SAME lexeme concurrently, each teaching it a different sense.
//
// Under READ COMMITTED, a writer whose UPDATE blocks on the lexeme row re-reads
// that ROW once unblocked, but its SET clause's `(SELECT count(*) ...)`
// subquery already ran, against the snapshot the statement started with —
// Postgres documents that this re-evaluation "does not see effects of [other]
// commands on other rows in the database". So the blocked writer's recomputed
// count can miss a sense the row's former holder committed while it waited.
// Locking the lexeme row as its own, earlier statement (1b, ahead of every
// insert that carries a foreign key to it) is what forces the blocked
// writer's LATER statements — including the recompute — to run on a fresh
// snapshot instead.
//
// Getting the two sessions to race the VULNERABLE way (one blocks INSIDE the
// version recompute, not somewhere earlier that happens to serialise them for
// a different reason) took two failed timing strategies before this one,
// verified against the real bug via a raw two-session SQL script outside
// Jest — see the fix report for the full account:
//
//   - A head start plus a long hold (session A finishes, then sleeps; session
//     B starts well after) let session A's own writes finish and take their
//     row locks before session B even began. Session B then blocked at its
//     OWN lexeme upsert (step 1) rather than at the version recompute,
//     because by then session A already held a lock the upsert's conflict
//     check needed too — an accidental serialisation with the same effect as
//     the fix, so the test passed even with the lock removed and proved
//     nothing.
//   - Starting both sessions together and letting BOTH sleep after their own
//     write does force the race into the vulnerable spot (confirmed by
//     timing logs: the loser's `persistEntries` call does not return until
//     the winner's sleep ends), but taking the lock (`FOR UPDATE`) ahead of
//     EVERY foreign-key insert — not only ahead of the sense insert as first
//     written — turned out to matter for a second reason, below.
describe('sense_version stays correct under two concurrent writers', () => {
  // A single attempt turned out not to be this test: measured directly (a
  // temporary looped probe, deleted after use — see the fix report), this
  // exact shape was wrong on roughly 13 of 14 attempts without the 1b lock,
  // but the FIRST attempt taken alone passed five times in a row by chance —
  // an unlucky coincidence that would have shipped a test proving nothing.
  // Looping over independent lexemes is what makes "wrong at least once"
  // mean the lock is doing its job, the same reasoning as the deadlock test
  // below.
  it('equals the true sense count after two overlapping writes to one lexeme', async () => {
    const ATTEMPTS = 8;

    for (let i = 0; i < ATTEMPTS; i++) {
      const lemma = `cook_ver_${i}`;
      const seeded = await persist(`${lemma}_seed`, [
        { lemma, part_of_speech: 'noun', senses: [{ sense_code: 'kitchen_worker', translation: 'N-COOK' }] },
      ]);
      const lexemeId = seeded.written[0].lexemeId;

      const newEntry = (form: string, code: string, translation: string) => ({
        form,
        languageCode: 'en',
        userLanguageCode: 'he',
        kind: 'word' as const,
        entries: [
          {
            lemma,
            part_of_speech: 'noun',
            senses: [
              { sense_code: 'kitchen_worker', translation: `${translation}-COOK` },
              { sense_code: code, translation },
            ],
          },
        ] as never,
      });

      // Both sessions start together and BOTH hold their transaction open
      // past their own write with a `pg_sleep`. Whichever one happens to win
      // the race to the lexeme row's lock runs its write to completion and
      // then holds the lock through its own sleep; the other blocks
      // somewhere inside its OWN `persistEntries` call and does not return
      // until the winner commits — which is what a 1s sleep on both sides is
      // generous enough to guarantee regardless of which one wins.
      const sessionA = withTx(t.db, async (tx) => {
        await createDictRepo(tx).persistEntries(newEntry(`${lemma}_a`, 'cookery_writer', 'A-NEW'));
        await tx.execute(sql`select pg_sleep(1)`);
      });
      const sessionB = withTx(t.db, async (tx) => {
        await createDictRepo(tx).persistEntries(newEntry(`${lemma}_b`, 'menu_item', 'B-NEW'));
        await tx.execute(sql`select pg_sleep(1)`);
      });

      await Promise.all([sessionA, sessionB]);

      const [lexeme] = await withTx(t.db, (tx) =>
        tx
          .select({ senseVersion: dictLexemes.senseVersion })
          .from(dictLexemes)
          .where(eq(dictLexemes.id, lexemeId)),
      );
      const senses = await withTx(t.db, (tx) =>
        tx.select({ id: dictSenses.id }).from(dictSenses).where(eq(dictSenses.lexemeId, lexemeId)),
      );

      // Three senses really were written — the seeded one plus each
      // session's own — so this is not vacuously true because nothing grew.
      // Without the 1b lock this reproduces the reviewer's finding exactly:
      // senses.length is 3 but sense_version lands on 2, because the second
      // writer's blocked UPDATE computed its count before the first writer's
      // insert was visible.
      expect(senses).toHaveLength(3);
      expect(lexeme.senseVersion).toBe(senses.length);
    }
  });

  // The second reason the lock has to sit ahead of step 2, not only ahead of
  // step 4: `dict_variants` and `dict_senses` both carry a foreign key to
  // `dict_lexemes`, and inserting a row with such a key takes an implicit
  // FOR KEY SHARE lock on the row it references. Two sessions can each hold
  // FOR KEY SHARE on the same row at once — that is what makes it a SHARED
  // lock — so if both had already inserted their own variant before either
  // tried to upgrade to FOR UPDATE, each would be waiting on a lock the
  // other already holds: a textbook deadlock. Measured while building this
  // fix, with the lock placed only ahead of step 4 as first written: 18 of 20
  // fresh-lexeme attempts using this exact shape deadlocked (Postgres error
  // 40P01), against 0 of the same 20 with the lock moved ahead of step 2 (see
  // the fix report for the raw counts). Moving the lock ahead of step 2 means
  // whichever session loses the race to it holds no FOR KEY SHARE of its own
  // yet, so it only ever waits — it is never also holding something the
  // winner needs.
  //
  // One attempt is not this test: with 40P01 this likely, a single race that
  // happened not to deadlock would prove nothing. A fresh lemma per iteration
  // is what lets them run back to back without one iteration's rows
  // conflicting with the next's.
  it('does not deadlock when both sessions race for the lock at the same instant', async () => {
    const ATTEMPTS = 15;

    for (let i = 0; i < ATTEMPTS; i++) {
      const lemma = `cook_race_${i}`;
      await persist(`${lemma}_seed`, [
        { lemma, part_of_speech: 'noun', senses: [{ sense_code: 'kitchen_worker', translation: 'X' }] },
      ]);

      const newEntry = (form: string, code: string) => ({
        form,
        languageCode: 'en',
        userLanguageCode: 'he',
        kind: 'word' as const,
        entries: [
          {
            lemma,
            part_of_speech: 'noun',
            senses: [
              { sense_code: 'kitchen_worker', translation: 'X' },
              { sense_code: code, translation: 'Y' },
            ],
          },
        ] as never,
      });

      // No artificial stagger at all: both sessions issue their first
      // statement back to back, on separate pooled connections, so whichever
      // one is slower to reach the lexeme's lock is still trying to acquire
      // it for the FIRST time when the other already holds it — the shape
      // that deadlocked before the lock moved ahead of step 2.
      const results = await Promise.allSettled([
        withTx(t.db, (tx) => createDictRepo(tx).persistEntries(newEntry(`${lemma}_a`, 'a_sense'))),
        withTx(t.db, (tx) => createDictRepo(tx).persistEntries(newEntry(`${lemma}_b`, 'b_sense'))),
      ]);

      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    }
  });
});
