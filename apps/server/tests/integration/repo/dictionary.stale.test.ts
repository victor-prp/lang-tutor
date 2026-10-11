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

/**
 * What `repairForm` reads before its model call: the version FIRST, then the
 * senses, both in one transaction. The version is what the repair stamps, so a
 * test that re-read it after the write would be pinning the bug rather than the
 * behaviour.
 */
const renderableSenses = (lexemeId: string) =>
  withTx(t.db, async (tx) => {
    const repo = createDictRepo(tx);
    const senseVersion = await repo.findSenseVersion({ lexemeId });
    const stored = await repo.findSensesByLexeme({
      lemma: 'cook', partOfSpeech: 'noun', languageCode: 'en', userLanguageCode: 'he',
    });
    return { senseVersion, stored };
  });

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
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));

    expect(stale).toHaveLength(1);
    expect(stale[0].partOfSpeech).toBe('noun');
  });

  it('re-ranks rather than appends, and leaves ranks contiguous from zero', async () => {
    const noun = await variantOf('cook', 'noun');          // one sense, rank 0
    await persist('cooks', COOKS_PLUS_ONE);                // the lexeme gains a second
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));

    const { senseVersion, stored } = await renderableSenses(stale.lexemeId);
    const idOf = (code: string) => stored.find((s) => s.senseCode === code)!.senseId;

    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([stale.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senseVersion, lemmaForm: true,
        senses: [
          // The NEWLY learned sense placed FIRST — which is the whole point.
          { senseId: idOf('cookery_writer'), rank: 0, translation: 'NEW-FIRST',  exampleSource: null, exampleTarget: null,
            alternatives: [], gloss: 'NEW-FIRST',  glossAlternatives: [], definition: null },
          { senseId: idOf('kitchen_worker'), rank: 1, translation: 'NEW-SECOND', exampleSource: null, exampleTarget: null,
            alternatives: [], gloss: 'NEW-SECOND', glossAlternatives: [], definition: null },
        ],
      });
    });

    // Appending at max(rank)+1 would have put NEW-FIRST last, which is exactly
    // the failure the spec's "Sense order belongs to the form" describes.
    const rows = await find('cook');
    expect(rows.map((r) => r.translation)).toEqual(['NEW-FIRST', 'NEW-SECOND']);
    expect(rows.map((r) => r.rank)).toEqual([0, 1]);
    expect(noun.variantId).toBe(stale.variantId);
  });

  // Review round 2. The version a repair stamps is the one its renderings were
  // derived FROM, handed in by the caller — never re-read at write time. The
  // two are minutes apart: the sense list is read, a 5-15 second model call
  // renders it, and only then does the write land. A lookup of another form
  // that teaches the lexeme a sense during that window is exactly the case
  // here, and stamping the version found at write time would mark this variant
  // level against a sense it never rendered — invisible to this form forever,
  // which is the defect the whole mechanism exists to remove.
  it('stamps the version the repair rendered, not the one the lexeme reached meanwhile', async () => {
    await variantOf('cook', 'noun');                 // one sense, rank 0
    await persist('cooks', COOKS_PLUS_ONE);          // the lexeme gains a second
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));

    // What `repairForm` reads before its model call.
    const { senseVersion, stored } = await renderableSenses(stale.lexemeId);
    expect(stored).toHaveLength(2);

    // ...and what a concurrent lookup of a third form does DURING that call.
    await persist('cooking', [
      { lemma: 'cook', part_of_speech: 'noun',
        senses: [
          { sense_code: 'kitchen_worker', translation: 'N-COOKING' },
          { sense_code: 'cookery_writer', translation: 'N-COOKING-2' },
          { sense_code: 'ships_cook',     translation: 'N-COOKING-3' }, // learned here
        ] },
    ]);

    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([stale.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senseVersion, lemmaForm: true,
        senses: stored.map((sense, rank) => ({
          senseId: sense.senseId, rank, translation: `R-${rank}`,
          alternatives: [], gloss: `R-${rank}`, glossAlternatives: [], definition: null,
          exampleSource: null, exampleTarget: null,
        })),
      });
    });

    // Still stale, and it must be: this repair rendered two of the lexeme's
    // three senses. Re-reading the version inside the write would have stamped
    // 3 here and closed the door on `ships_cook` permanently.
    const after = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));
    expect(after.map((row) => row.partOfSpeech)).toEqual(['noun']);
  });

  it('marks the variant level again, so a second lookup is not a second repair', async () => {
    await variantOf('cook', 'noun');
    await persist('cooks', COOKS_PLUS_ONE);
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));

    const { senseVersion, stored } = await renderableSenses(stale.lexemeId);

    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([stale.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senseVersion, lemmaForm: true,
        senses: stored.map((sense, rank) => ({
          senseId: sense.senseId, rank, translation: `R-${rank}`,
          alternatives: [], gloss: `R-${rank}`, glossAlternatives: [], definition: null,
          exampleSource: null, exampleTarget: null,
        })),
      });
    });

    expect(
      await withTx(t.db, (tx) =>
        createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' })),
    ).toEqual([]);
  });
});

// Review round 2. The repair's DELETE is unconditional, so a model call that
// answers `translation: null` for a sense this form has been serving would
// erase that rendering with nothing to restore it from. And it is worse than a
// lost rendering: `findSensesByLexeme` reaches senses through an INNER JOIN on
// `dict_var_translations`, so if this variant were the only bearer of one, the
// sense would stop appearing in any reconciliation prompt at all — the next
// form would name the meaning afresh and write a DUPLICATE sense, which is
// exactly what the reconciliation call exists to prevent, and permanent.
describe('a repair may not drop a sense the form already renders', () => {
  const COOK_TWO_SENSES = [
    { lemma: 'cook', part_of_speech: 'noun',
      senses: [
        { sense_code: 'kitchen_worker', translation: 'N-COOK' },
        { sense_code: 'cookery_writer', translation: 'N-COOK-2' },
      ] },
  ];

  it('refuses the write and leaves the stored renderings untouched', async () => {
    await persist('cook', COOK_TWO_SENSES);
    // A third sense from another form, so the variant is genuinely stale and a
    // repair is genuinely due.
    await persist('cooks', [
      { lemma: 'cook', part_of_speech: 'noun',
        senses: [
          { sense_code: 'kitchen_worker', translation: 'N-COOKS' },
          { sense_code: 'cookery_writer', translation: 'N-COOKS-2' },
          { sense_code: 'ships_cook', translation: 'N-COOKS-3' },
        ] },
    ]);
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));
    const { senseVersion, stored } = await renderableSenses(stale.lexemeId);
    const idOf = (code: string) => stored.find((sense) => sense.senseCode === code)!.senseId;

    // The flaky answer: `cookery_writer` came back as `translation: null`, so
    // the service filtered it out and this repair renders two of three — one of
    // them a sense the form is serving right now.
    const write = withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([stale.lexemeId]);
      return dict.repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senseVersion, lemmaForm: true,
        senses: [
          { senseId: idOf('kitchen_worker'), rank: 0, translation: 'R-0',
            alternatives: [], gloss: 'R-0', glossAlternatives: [], definition: null,
            exampleSource: null, exampleTarget: null },
          { senseId: idOf('ships_cook'), rank: 1, translation: 'R-1',
            alternatives: [], gloss: 'R-1', glossAlternatives: [], definition: null,
            exampleSource: null, exampleTarget: null },
        ],
      });
    });

    await expect(write).rejects.toThrow(/would drop/);

    // Fail closed: the older answer stands, whole, and the form is still marked
    // stale so the next lookup tries again.
    const rows = await find('cook');
    expect(rows.map((row) => row.translation)).toEqual(['N-COOK', 'N-COOK-2']);
    expect(
      await withTx(t.db, (tx) =>
        createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' })),
    ).toHaveLength(1);
  });

  it('allows a repair that renders every sense the form already had, and more', async () => {
    await persist('cook', COOK_TWO_SENSES);
    await persist('cooks', [
      { lemma: 'cook', part_of_speech: 'noun',
        senses: [
          { sense_code: 'kitchen_worker', translation: 'N-COOKS' },
          { sense_code: 'cookery_writer', translation: 'N-COOKS-2' },
          { sense_code: 'ships_cook', translation: 'N-COOKS-3' },
        ] },
    ]);
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));
    const { senseVersion, stored } = await renderableSenses(stale.lexemeId);

    await withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([stale.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senseVersion, lemmaForm: true,
        senses: stored.map((sense, rank) => ({
          senseId: sense.senseId, rank, translation: `R-${rank}`,
          alternatives: [], gloss: `R-${rank}`, glossAlternatives: [], definition: null,
          exampleSource: null, exampleTarget: null,
        })),
      });
    });

    expect((await find('cook')).map((row) => row.translation)).toEqual(['R-0', 'R-1', 'R-2']);
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

// Phase 34 (spec D1). The accept job stores a rendering's other right answers,
// the form that agrees with it and when the job ran; the repair deletes and
// re-inserts the variant's renderings, so unless it carries those columns over,
// every repair empties them and the next session pays for the call again. A
// rendering whose wording the repair rewrote is a different rendering: what was
// accepted for the old words does not describe the new ones.
describe('a repair keeps what the accept job stored for a rendering it did not reword', () => {
  const STAMP = new Date('2026-10-11T08:30:00.000Z');
  const STORED = (n: number) => ({ answers: [`ok${n}`, `also${n}`], form: `form${n}` });

  const renderings = async (variantId: string) => {
    const rows = await t.db.execute<{
      translation: string;
      accepted_answers: string[];
      answer_form: string | null;
      accepted_at: number | null;
    }>(sql`
      select translation, accepted_answers, answer_form, (extract(epoch from accepted_at) * 1000)::float8 as accepted_at
      from dict_var_translations where variant_id = ${variantId} order by rank`);
    return rows.rows;
  };

  /** `cook` with two senses, both accepted, then the lexeme learns a third. */
  const staleWithAcceptedAnswers = async () => {
    await persist('cook', [
      { lemma: 'cook', part_of_speech: 'noun',
        senses: [
          { sense_code: 'kitchen_worker', translation: 'N-COOK' },
          { sense_code: 'cookery_writer', translation: 'N-COOK-2' },
        ] },
    ]);
    await persist('cooks', [
      { lemma: 'cook', part_of_speech: 'noun',
        senses: [
          { sense_code: 'kitchen_worker', translation: 'N-COOKS' },
          { sense_code: 'cookery_writer', translation: 'N-COOKS-2' },
          { sense_code: 'ships_cook', translation: 'N-COOKS-3' },
        ] },
    ]);
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en', userLanguageCode: 'he' }));
    for (const [n, translation] of [[1, 'N-COOK'], [2, 'N-COOK-2']] as const) {
      await t.db.execute(sql`
        update dict_var_translations
        set accepted_answers = ARRAY[${STORED(n).answers[0]}, ${STORED(n).answers[1]}]::text[],
            answer_form = ${STORED(n).form}, accepted_at = ${STAMP.toISOString()}::timestamptz
        where variant_id = ${stale.variantId} and translation = ${translation}`);
    }
    const { senseVersion, stored } = await renderableSenses(stale.lexemeId);
    const idOf = (code: string) => stored.find((sense) => sense.senseCode === code)!.senseId;
    return { stale, senseVersion, idOf };
  };

  const rendering = (senseId: string, rank: number, translation: string) => ({
    senseId, rank, translation, alternatives: [], gloss: translation, glossAlternatives: [], definition: null,
    exampleSource: null, exampleTarget: null,
  });

  const repair = (
    w: Awaited<ReturnType<typeof staleWithAcceptedAnswers>>,
    senses: ReturnType<typeof rendering>[],
  ) =>
    withTx(t.db, async (tx) => {
      const dict = createDictRepo(tx);
      await dict.lockLexemes([w.stale.lexemeId]);
      await dict.repairVariantRenderings({
        variantId: w.stale.variantId, lexemeId: w.stale.lexemeId, userLanguageCode: 'he',
        senseVersion: w.senseVersion, lemmaForm: true, senses,
      });
    });

  it('carries the three columns over for an unchanged translation, wherever it now ranks', async () => {
    const w = await staleWithAcceptedAnswers();
    await repair(w, [
      rendering(w.idOf('ships_cook'), 0, 'N-NEW'),
      rendering(w.idOf('cookery_writer'), 1, 'N-COOK-2'),
      rendering(w.idOf('kitchen_worker'), 2, 'N-COOK'),
    ]);

    expect(await renderings(w.stale.variantId)).toEqual([
      // New: nothing was accepted for it yet, so the next session enqueues the job.
      { translation: 'N-NEW', accepted_answers: [], answer_form: null, accepted_at: null },
      { translation: 'N-COOK-2', accepted_answers: STORED(2).answers, answer_form: STORED(2).form, accepted_at: STAMP.getTime() },
      { translation: 'N-COOK', accepted_answers: STORED(1).answers, answer_form: STORED(1).form, accepted_at: STAMP.getTime() },
    ]);
  });

  it('leaves them empty and unstamped for a rendering whose wording the repair changed', async () => {
    const w = await staleWithAcceptedAnswers();
    await repair(w, [
      rendering(w.idOf('kitchen_worker'), 0, 'N-COOK'),
      rendering(w.idOf('cookery_writer'), 1, 'N-COOK-2, REWORDED'),
      rendering(w.idOf('ships_cook'), 2, 'N-COOK-3'),
    ]);

    expect(await renderings(w.stale.variantId)).toEqual([
      { translation: 'N-COOK', accepted_answers: STORED(1).answers, answer_form: STORED(1).form, accepted_at: STAMP.getTime() },
      // The words changed, so what was accepted for the old ones is gone with them.
      { translation: 'N-COOK-2, REWORDED', accepted_answers: [], answer_form: null, accepted_at: null },
      { translation: 'N-COOK-3', accepted_answers: [], answer_form: null, accepted_at: null },
    ]);
  });

  it('keeps the stamp of a rendering the job found nothing for, so it is not paid for again', async () => {
    const w = await staleWithAcceptedAnswers();
    await t.db.execute(sql`
      update dict_var_translations set accepted_answers = '{}', answer_form = null
      where variant_id = ${w.stale.variantId} and translation = 'N-COOK'`);
    await repair(w, [
      rendering(w.idOf('kitchen_worker'), 0, 'N-COOK'),
      rendering(w.idOf('cookery_writer'), 1, 'N-COOK-2'),
      rendering(w.idOf('ships_cook'), 2, 'N-COOK-3'),
    ]);

    expect((await renderings(w.stale.variantId))[0]).toEqual(
      { translation: 'N-COOK', accepted_answers: [], answer_form: null, accepted_at: STAMP.getTime() },
    );
  });

  it('keys on the variant: another form with the same wording is not taken for its own', async () => {
    const w = await staleWithAcceptedAnswers();
    const [plural] = await t.db.execute<{ variant_id: string }>(sql`
      select v.id as variant_id from dict_variants v where v.form = 'cooks'`).then((r) => r.rows);
    await t.db.execute(sql`
      update dict_var_translations set accepted_answers = ARRAY['plural']::text[], accepted_at = ${STAMP.toISOString()}::timestamptz
      where variant_id = ${plural.variant_id} and translation = 'N-COOKS'`);

    await repair(w, [
      rendering(w.idOf('kitchen_worker'), 0, 'N-COOKS'),
      rendering(w.idOf('cookery_writer'), 1, 'N-COOK-2'),
      rendering(w.idOf('ships_cook'), 2, 'N-COOK-3'),
    ]);

    // The repaired variant's 'N-COOKS' is a new wording for it: `cooks`' own
    // row, which has the same text, is a different (variant, sense) pair.
    expect((await renderings(w.stale.variantId))[0]).toEqual(
      { translation: 'N-COOKS', accepted_answers: [], answer_form: null, accepted_at: null },
    );
    expect(await renderings(plural.variant_id)).toEqual([
      { translation: 'N-COOKS', accepted_answers: ['plural'], answer_form: null, accepted_at: STAMP.getTime() },
      { translation: 'N-COOKS-2', accepted_answers: [], answer_form: null, accepted_at: null },
      { translation: 'N-COOKS-3', accepted_answers: [], answer_form: null, accepted_at: null },
    ]);
  });
});

// Review round 2. The lock 1b takes is per-entry, inside the loop, and held to
// commit — so a write's locks are taken in the MODEL's entry order, which is
// whatever order the answer listed the lexemes in. `mergeEntries` preserves
// that order, so two concurrent lookups whose answers name the same two
// lexemes in opposite orders lock them in opposite orders: the textbook
// ABBA deadlock, and one this change introduced (measured: 10 of 10 attempts
// of this exact shape aborted with 40P01 before the fix, 0 of 10 after).
//
// The fix is not to reorder the entries — `entry_rank` carries the model's
// order and the answer depends on it — but to resolve every lexeme id first
// and take ALL the locks in one statement ordered by id, before the per-entry
// loop begins. Ordered acquisition in a single statement cannot interleave
// with another session's, so there is no cycle to detect.
//
// Both lexemes are seeded first, so step 1 resolves each with a plain SELECT
// and 1b's FOR UPDATE is the only lock either session takes — the deadlock
// this reproduces is the lock ORDER, not the lexeme insert.
describe('two concurrent writes ordering the same lexemes differently', () => {
  it('does not deadlock when one answer lists them A,B and the other B,A', async () => {
    const ATTEMPTS = 6;

    for (let i = 0; i < ATTEMPTS; i++) {
      const alpha = `cook_pair_a_${i}`;
      const beta = `cook_pair_b_${i}`;
      const one = (lemma: string) => ({
        lemma,
        part_of_speech: 'noun',
        senses: [{ sense_code: 'kitchen_worker', translation: 'X' }],
      });

      await persist(`${alpha}_seed`, [one(alpha)]);
      await persist(`${beta}_seed`, [one(beta)]);

      const write = (form: string, lemmas: string[]) =>
        withTx(t.db, (tx) =>
          createDictRepo(tx).persistEntries({
            form,
            languageCode: 'en',
            userLanguageCode: 'he',
            kind: 'word',
            entries: lemmas.map(one) as never,
          }),
        );

      const results = await Promise.allSettled([
        write(`${alpha}_ab_${i}`, [alpha, beta]),
        write(`${beta}_ba_${i}`, [beta, alpha]),
      ]);

      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    }
  });
});
