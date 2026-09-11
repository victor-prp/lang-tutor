import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';
import { asc, eq, sql } from 'drizzle-orm';

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
        kind: 'word',
      },
    ]);
  });

  it("selects the variant's kind, honouring what was written rather than a shape guessed later", async () => {
    await insertTerm(t.db, {
      lemma: 'break a leg',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'break a leg', kind: 'phrase', entryRank: 0 }],
      senses: [sense(0, 'בהצלחה')],
    });

    expect((await find('break a leg')).map((row) => row.kind)).toEqual(['phrase']);
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

    // written[0] is the found path: 'see' already had senses before this call.
    // Checked against an independent, freshly-ordered query rather than the
    // first call's own senseIds, so a wrong-order regression on the found path
    // is caught even if it happened to match some other array by coincidence.
    const seeSenses = await t.db
      .select({ id: vocabTermSenses.id })
      .from(vocabTermSenses)
      .where(eq(vocabTermSenses.termId, written[0].termId))
      .orderBy(asc(vocabTermSenses.rank));
    expect(written[0].senseIds).toEqual(seeSenses.map((row) => row.id));
  });

  it('is idempotent: the same call twice writes nothing the second time', async () => {
    const first = await persist('see', [entry('see', ['לראות'])]);
    const second = await persist('see', [entry('see', ['לראות'])]);

    expect(second.written[0].termId).toBe(first.written[0].termId);
    expect(second.written[0].variantId).toBe(first.written[0].variantId);
    expect(second.written[0].created).toBe(false);
    // The first call wrote the senses; the second only found them. Equal,
    // order included, is what would break if the found path ever returned
    // `[]` or a different order than the write did.
    expect(second.written[0].senseIds).toEqual(first.written[0].senseIds);
    // Scoped to this term rather than the whole table: the shared content seed
    // (db/seed.ts) already populates term_variants with 13 rows for the other
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

    // Signalled by tx1 once its `persistEntries` call has settled — not on a
    // timer, which proves nothing about whether tx1 got there first. tx2
    // awaits this before it attempts its own insert, which is what makes tx1
    // provably hold the conflicting row when tx2 arrives: a bare `setTimeout`
    // gates only wall time, not the fact that tx1 wrote anything, so tx2
    // could still win the insert race and never contend at all.
    //
    // Fired from a `finally`, not only after a successful `await`, so a
    // future regression that makes `persistEntries` throw can't leave tx2
    // hanging forever on `await written` below (and, transitively, hang
    // `afterEach`'s `t.close()` — `pool.end()` never resolves while a client
    // is still checked out). The throw itself is not caught here: nothing
    // returns or swallows it, so it still propagates out of the IIFE and
    // rejects `first`, which is what must happen for the test to fail fast
    // and name the real error instead of timing out opaquely.
    let signalWritten = (): void => {};
    const written = new Promise<void>((resolve) => {
      signalWritten = resolve;
    });

    const first = withTx(t.db, async (tx) => {
      const out = await (async () => {
        try {
          return await createVocabRepo(tx).persistEntries({
            form: 'kite',
            languageCode: 'en',
            userLanguageCode: 'he',
            kind: 'word',
            entries: [entry('kite', ['עפיפון'])],
          });
        } finally {
          signalWritten(); // tx2 may now attempt its own insert, success or not
        }
      })();
      await held; // keep the transaction open so the second one has to block
      return out;
    });

    // tx2 opened by hand, exactly like `first` above, rather than through the
    // `persist` helper: its backend pid has to be captured *inside* its own
    // transaction, before it attempts the insert that contends with tx1's
    // uncommitted row, or there is nothing to poll for. It then waits for
    // `written` before calling `persistEntries`, so its insert is only ever
    // attempted after tx1's row already exists (uncommitted) under the same
    // unique key — the block is therefore guaranteed, not merely likely.
    let secondPid = 0;
    const second = withTx(t.db, async (tx) => {
      const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      secondPid = rows[0].pid;
      await written;
      return createVocabRepo(tx).persistEntries({
        form: 'kite',
        languageCode: 'en',
        userLanguageCode: 'he',
        kind: 'word',
        entries: [entry('kite', ['משהו אחר'])],
      });
    });

    // Overlap made observable, not inferred from timing: poll Postgres itself
    // for tx2's backend actually waiting on another backend's lock.
    // `pg_blocking_pids(pid)` returning a non-empty array *is* Postgres's own
    // answer to "is this session blocked on someone else" — scoped to this
    // test's own cloned database so a pid from another worker's database
    // could never satisfy it. A timer proves only that tx2 didn't finish
    // early; it cannot prove tx2 ever reached the conflicting insert at all,
    // so it would pass just as green if tx2 started late and never truly
    // contended with tx1. This poll cannot: if tx2 never shows as blocked
    // within the deadline, it throws and the test fails loudly, which is
    // exactly what accidental serialization (no real race) looks like.
    let pollError: Error | undefined;
    try {
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        if (secondPid) {
          const { rows } = await t.db.execute<{ blocked: boolean }>(sql`
            select cardinality(pg_blocking_pids(pid)) > 0 as blocked
            from pg_stat_activity
            where pid = ${secondPid} and datname = current_database()
          `);
          blocked = rows[0]?.blocked === true;
        }
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!blocked) {
        pollError = new Error(
          `tx2 (backend pid ${secondPid || 'not yet captured'}) never showed as blocked on ` +
            'another backend within 5000ms — the unique-index race this test exists to prove ' +
            'never happened.',
        );
      }
    } finally {
      // Unconditionally, whether the poll observed the block, timed out, or
      // threw: `first`'s transaction is still open on `await held` and must
      // never be left that way. Skipping this on the timeout path was the bug
      // in the previous attempt — it left `first`'s pooled connection open
      // forever, which then hung `afterEach`'s `t.close()` for the rest of the
      // suite's 30s Jest timeout instead of failing this test promptly.
      release();
    }

    // Let both transactions actually finish — and their connections return to
    // the pool — before this test decides its outcome, whatever that outcome
    // is; `pollError`, not a rejection here, is the expected shape of a real
    // failure, so it takes priority once both settle.
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    if (pollError) throw pollError;
    if (firstResult.status === 'rejected') throw firstResult.reason;
    if (secondResult.status === 'rejected') throw secondResult.reason;
    const a = firstResult.value;
    const b = secondResult.value;

    expect(b.written[0].termId).toBe(a.written[0].termId);
    expect(b.written[0].created).toBe(false);
    // `a` wrote the senses; `b` only found them — same order-sensitive check
    // as the idempotent test, here under an actual concurrent race rather
    // than two sequential calls.
    expect(b.written[0].senseIds).toEqual(a.written[0].senseIds);
    expect(b.senses.map((sense) => sense.translation)).toEqual(['עפיפון']);
    expect(
      await t.db
        .select()
        .from(vocabTermSenses)
        .where(eq(vocabTermSenses.termId, a.written[0].termId)),
    ).toHaveLength(1);
  });
});
