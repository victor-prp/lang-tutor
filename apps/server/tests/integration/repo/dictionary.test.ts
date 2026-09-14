import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { LlmEntry, PartOfSpeech } from '@lang-tutor/core/api';
import { asc, eq, sql } from 'drizzle-orm';

import { dictLexemes, dictSenses, dictVariants } from '../../../src/db/schema';
import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { insertLexeme, type SeedVariant } from '../../support/dictRows';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

/** One form's renderings, ranked by position. A sense is pure identity now, so
 *  what a test describes is a variant: which senses this form serves, in which
 *  order, worded how. */
const variant = (
  form: string,
  translations: string[],
  over: { kind?: string; entryRank?: number; exampleSource?: string; exampleTarget?: string } = {},
): SeedVariant => ({
  form,
  kind: over.kind ?? 'word',
  entryRank: over.entryRank ?? 0,
  translations: translations.map((translation, rank) => ({
    senseCode: `s${rank}`,
    rank,
    translation,
    exampleSource: over.exampleSource ?? null,
    exampleTarget: over.exampleTarget ?? null,
  })),
});

const senses = (n: number) => Array.from({ length: n }, (_, i) => ({ senseCode: `s${i}` }));

const find = (form: string, languageCode = 'en', userLanguageCode = 'he') =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).findSensesByForm({ form, languageCode, userLanguageCode }),
  );

describe('findSensesByForm', () => {
  it('matches case-insensitively, because the index is on lower(form)', async () => {
    await insertLexeme(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(1),
      variants: [variant('ladder', ['סולם'])],
    });

    expect((await find('Ladder')).map((row) => row.translation)).toEqual(['סולם']);
    expect((await find('LADDER')).map((row) => row.translation)).toEqual(['סולם']);
  });

  it('returns a term\'s senses in rank order', async () => {
    await insertLexeme(t.db, {
      lemma: 'see',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: senses(3),
      variants: [variant('see', ['לראות', 'להבין', 'לפגוש'])],
    });

    expect((await find('see')).map((row) => row.translation)).toEqual([
      'לראות',
      'להבין',
      'לפגוש',
    ]);
  });

  it('caps the read at five even though the database stores every sense', async () => {
    await insertLexeme(t.db, {
      lemma: 'light',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(7),
      variants: [variant('light', [0, 1, 2, 3, 4, 5, 6].map((n) => `t${n}`))],
    });

    expect(await find('light')).toHaveLength(5);
  });

  it('carries the part of speech and both halves of the example', async () => {
    await insertLexeme(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(1),
      variants: [
        variant('ladder', ['סולם'], {
          exampleSource: 'She climbed the ladder.',
          exampleTarget: 'היא טיפסה על הסולם.',
        }),
      ],
    });

    expect(await find('ladder')).toEqual([
      {
        lexemeId: expect.any(String),
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
    await insertLexeme(t.db, {
      lemma: 'break a leg',
      languageCode: 'en',
      partOfSpeech: 'interjection',
      userLanguageCode: 'he',
      senses: senses(1),
      variants: [variant('break a leg', ['בהצלחה'], { kind: 'phrase' })],
    });

    expect((await find('break a leg')).map((row) => row.kind)).toEqual(['phrase']);
  });

  it('is a miss for a term with no translation in the language being asked for', async () => {
    // The inner join is the whole servability test: no column, no flag. An
    // earlier draft gated on the presence of an example, which would have made
    // an entry with a legally-absent example permanently unservable.
    await insertLexeme(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(1),
      variants: [variant('ladder', ['סולם'])],
    });

    expect(await find('ladder', 'en', 'ru')).toEqual([]);
  });

  it('is a miss for a form nobody has queried, and for the wrong term language', async () => {
    await insertLexeme(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(1),
      variants: [variant('ladder', ['סולם'])],
    });

    expect(await find('ladders')).toEqual([]);
    expect(await find('ladder', 'he', 'en')).toEqual([]);
  });
});

// An entry is a lexeme from phase 12 on, so it carries a part of speech.
// Defaulted, because most cases here are about ranking and identity rather than
// word class; the cases that are about it pass one.
const entry = (
  lemma: string,
  translations: string[],
  partOfSpeech: PartOfSpeech = 'noun',
): LlmEntry => ({
  lemma,
  part_of_speech: partOfSpeech,
  senses: translations.map((translation, n) => ({ translation, sense_code: `c${n}` })),
});

const persist = (form: string, entries: LlmEntry[]) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({
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

    const variants = await t.db.select().from(dictVariants).where(eq(dictVariants.form, 'saw'));
    expect(variants).toHaveLength(2);
    expect(variants.map((v) => v.entryRank).sort()).toEqual([0, 1]);
    expect(new Set(variants.map((v) => v.lexemeId)).size).toBe(2);
  });

  it('returns ids that match the rows it wrote', async () => {
    const { written } = await persist('see', [entry('see', ['לראות', 'להבין'])]);
    const [row] = written;

    const [variant] = await t.db
      .select()
      .from(dictVariants)
      .where(eq(dictVariants.id, row.variantId));
    expect(variant.lexemeId).toBe(row.lexemeId);
    expect(variant.form).toBe('see');

    const senses = await t.db
      .select()
      .from(dictSenses)
      .where(eq(dictSenses.lexemeId, row.lexemeId));
    expect(senses.map((sense) => sense.senseCode).sort()).toEqual(['c0', 'c1']);
    expect([...row.senseIds].sort()).toEqual(senses.map((sense) => sense.id).sort());
    // senseIds is in the order the ENTRY listed its senses — not a rank on the
    // sense, which phase 12 removed. The seed hangs its questions off
    // senseIds[0], so that order is part of the contract.
    expect(row.senseIds[0]).toBe(senses.find((sense) => sense.senseCode === 'c0')!.id);
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
      (await find('saw')).map((row) => ({
        translation: row.translation,
        part_of_speech: row.partOfSpeech,
      })),
    );
  });

  // Phase 12 splits the old guarantee in two, and this is where the split shows.
  // The lexeme's SENSES are still first-writer-wins — `see` keeps the three
  // meanings it was created with, and a later call naming it adds none. But the
  // later form writes its own RENDERING of the sense it named, so `saw` answers
  // with its own wording rather than inheriting `see`'s. That inheritance was
  // the rendering defect.
  it("adds no senses to an existing lexeme, but does add this form's renderings", async () => {
    await persist('see', [entry('see', ['לראות', 'להבין', 'לפגוש'], 'verb')]);

    const { written } = await persist('saw', [
      // sense_code c0 — the same sense `see` already has, worded for this form.
      entry('see', ['ראה'], 'verb'),
      entry('saw', ['מסור'], 'noun'),
    ]);

    expect(written[0].created).toBe(false);

    // The lexeme gained no sense...
    const seeSenses = await t.db
      .select({ id: dictSenses.id, senseCode: dictSenses.senseCode })
      .from(dictSenses)
      .where(eq(dictSenses.lexemeId, written[0].lexemeId));
    expect(seeSenses.map((row) => row.senseCode).sort()).toEqual(['c0', 'c1', 'c2']);

    // ...and `see` still renders exactly what it rendered before.
    expect((await find('see')).map((row) => row.translation)).toEqual([
      'לראות',
      'להבין',
      'לפגוש',
    ]);

    // `saw` renders the sense it named in ITS OWN words, and never reaches the
    // two senses of `see` it did not name.
    expect((await find('saw')).map((row) => row.translation)).toEqual(['ראה', 'מסור']);

    // written[0] is the found path: 'see' already had senses before this call.
    // Checked against an independent query rather than the first call's own
    // senseIds, so a wrong-order regression on the found path is caught even if
    // it happened to match some other array by coincidence.
    expect(written[0].senseIds).toEqual([
      seeSenses.find((row) => row.senseCode === 'c0')!.id,
    ]);
  });

  it('is idempotent: the same call twice writes nothing the second time', async () => {
    const first = await persist('see', [entry('see', ['לראות'])]);
    const second = await persist('see', [entry('see', ['לראות'])]);

    expect(second.written[0].lexemeId).toBe(first.written[0].lexemeId);
    expect(second.written[0].variantId).toBe(first.written[0].variantId);
    expect(second.written[0].created).toBe(false);
    // The first call wrote the senses; the second only found them. Equal,
    // order included, is what would break if the found path ever returned
    // `[]` or a different order than the write did.
    expect(second.written[0].senseIds).toEqual(first.written[0].senseIds);
    // Scoped to this term rather than the whole table: the shared content seed
    // (db/seed.ts) already populates dict_variants with 13 rows for the other
    // integration suites, so an unscoped count could never read 1 regardless of
    // whether the second call wrote a duplicate.
    expect(
      await t.db
        .select()
        .from(dictVariants)
        .where(eq(dictVariants.lexemeId, first.written[0].lexemeId)),
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
          return await createDictRepo(tx).persistEntries({
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
      return createDictRepo(tx).persistEntries({
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

    expect(b.written[0].lexemeId).toBe(a.written[0].lexemeId);
    expect(b.written[0].created).toBe(false);
    // `a` wrote the senses; `b` only found them — same order-sensitive check
    // as the idempotent test, here under an actual concurrent race rather
    // than two sequential calls.
    expect(b.written[0].senseIds).toEqual(a.written[0].senseIds);
    expect(b.senses.map((sense) => sense.translation)).toEqual(['עפיפון']);
    expect(
      await t.db
        .select()
        .from(dictSenses)
        .where(eq(dictSenses.lexemeId, a.written[0].lexemeId)),
    ).toHaveLength(1);
  });
});

// Phase 12. `cook` rather than the spec's `book` throughout: `book` is one of
// the thirteen seeded queries, so every cloned database already holds its two
// lexemes and these writes would either collide or be swallowed by
// first-writer-wins. `cook` is the same shape and the seed does not have it.
describe('a lexeme is a lemma and a part of speech', () => {
  const lexeme = (pos: PartOfSpeech, code: string, translation: string) => ({
    lemma: 'cook',
    part_of_speech: pos,
    senses: [{ sense_code: code, translation }],
  });

  it('stores one lemma with two parts of speech as two lexemes', async () => {
    const res = await persist('cook', [
      lexeme('noun', 'kitchen_worker', 'N1'),
      lexeme('verb', 'prepare_food', 'V1'),
    ]);
    expect(res.written).toHaveLength(2);
    expect(new Set(res.written.map((e) => e.lexemeId)).size).toBe(2);
  });

  it('returns the lexeme part of speech on every sense', async () => {
    await persist('cook', [lexeme('verb', 'prepare_food', 'V1')]);
    const rows = await find('cook');
    expect(rows[0].partOfSpeech).toBe('verb');
  });

  it('rejects a second lexeme with the same lemma and part of speech', async () => {
    const ins = () =>
      t.db
        .insert(dictLexemes)
        .values({ languageCode: 'en', lemma: 'cook', partOfSpeech: 'verb' });
    await ins();
    // The name is on the cause, not the wrapper — the idiom db/schema.test.ts
    // already uses, and what makes this assert the RIGHT constraint fired.
    await expect(ins()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('dict_lexemes_language_lemma_pos_key'),
      }),
    });
  });

  it('rejects a second sense of one lexeme with the same code', async () => {
    const { written } = await persist('cook', [lexeme('verb', 'prepare_food', 'V1')]);
    await expect(
      t.db
        .insert(dictSenses)
        .values({ lexemeId: written[0].lexemeId, senseCode: 'prepare_food' }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('dict_senses_lexeme_code_key'),
      }),
    });
  });

  it('adds an incoming sense whose code matches nothing', async () => {
    const { written } = await persist('cook', [lexeme('verb', 'prepare_food', 'V1')]);
    await persist('cooked', [lexeme('verb', 'fabricate_accounts', 'V2')]);

    const senses = await t.db
      .select({ senseCode: dictSenses.senseCode })
      .from(dictSenses)
      .where(eq(dictSenses.lexemeId, written[0].lexemeId));
    expect(senses.map((x) => x.senseCode).sort()).toEqual(['fabricate_accounts', 'prepare_food']);
  });

  // The reason `rank` sits on the translation. A form that ranks a brand-new
  // sense FIRST must serve it first — under a lexeme-scoped rank it would have
  // been appended at max(rank)+1 and served last.
  it('ranks a new sense where THIS form put it, not where it arrived', async () => {
    await persist('cook', [
      {
        lemma: 'cook',
        part_of_speech: 'verb',
        senses: [
          { sense_code: 'prepare_food', translation: 'INF-PREPARE' },
          { sense_code: 'heat_gently', translation: 'INF-HEAT' },
        ],
      },
    ]);

    await persist('cooked', [
      {
        lemma: 'cook',
        part_of_speech: 'verb',
        senses: [
          { sense_code: 'fabricate_accounts', translation: 'PAST-FABRICATE' }, // new, and first
          { sense_code: 'prepare_food', translation: 'PAST-PREPARE' },
          { sense_code: 'heat_gently', translation: 'PAST-HEAT' },
        ],
      },
    ]);

    expect((await find('cooked')).map((r) => r.translation)).toEqual([
      'PAST-FABRICATE',
      'PAST-PREPARE',
      'PAST-HEAT',
    ]);

    // ...and `cook` is untouched, still without the new sense.
    expect((await find('cook')).map((r) => r.translation)).toEqual(['INF-PREPARE', 'INF-HEAT']);
  });

  // Neither order of arrival may fix an ordering for the other form.
  it('gives the same two answers whichever form is looked up first', async () => {
    const cookEntry = {
      lemma: 'cook',
      part_of_speech: 'verb' as const,
      senses: [{ sense_code: 'prepare_food', translation: 'INF-PREPARE' }],
    };
    const cookedEntry = {
      lemma: 'cook',
      part_of_speech: 'verb' as const,
      senses: [
        { sense_code: 'fabricate_accounts', translation: 'PAST-FABRICATE' },
        { sense_code: 'prepare_food', translation: 'PAST-PREPARE' },
      ],
    };

    await persist('cooked', [cookedEntry]);
    await persist('cook', [cookEntry]);

    expect((await find('cooked')).map((r) => r.translation)).toEqual([
      'PAST-FABRICATE',
      'PAST-PREPARE',
    ]);
    expect((await find('cook')).map((r) => r.translation)).toEqual(['INF-PREPARE']);
  });
});

describe('findSensesByLexeme', () => {
  const byLexeme = (lemma: string, partOfSpeech: string) =>
    withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByLexeme({
        lemma,
        partOfSpeech,
        languageCode: 'en',
        userLanguageCode: 'he',
      }),
    );

  const lexeme = (pos: PartOfSpeech, code: string, translation: string) => ({
    lemma: 'cook',
    part_of_speech: pos,
    senses: [{ sense_code: code, translation }],
  });

  // The verb lexeme of an ambiguous lemma is entry 1, never entry 0. A lookup of
  // `cook` gives (cook,noun) entry_rank 0 and (cook,verb) entry_rank 1, so the
  // verb lexeme owns no entry_rank 0 variant. findSensesByLexeme must still see
  // its senses, or reconciliation silently never runs for verbs — which is what
  // inflections mostly are.
  it('finds a lexeme that owns no entry_rank 0 variant', async () => {
    await persist('cook', [
      lexeme('noun', 'kitchen_worker', 'N1'),
      lexeme('verb', 'prepare_food', 'V1'),
    ]);

    expect((await byLexeme('cook', 'verb')).map((x) => x.senseCode)).toEqual(['prepare_food']);
  });

  // A sense whose only rendering lives on a form other than the first must still
  // reach the prompt, or it gets a freshly invented code on the next lookup.
  it('returns one gloss per sense, across all variants', async () => {
    await persist('cook', [lexeme('verb', 'prepare_food', 'V1')]);
    await persist('cooked', [lexeme('verb', 'fabricate_accounts', 'V2')]);

    const senses = await byLexeme('cook', 'verb');
    expect(senses.map((x) => x.senseCode).sort()).toEqual([
      'fabricate_accounts',
      'prepare_food',
    ]);
    // One row per sense, never one per (sense, variant).
    expect(senses).toHaveLength(2);
  });

  it('carries the gloss and both example halves the prompt is built from', async () => {
    await persist('cook', [
      {
        lemma: 'cook',
        part_of_speech: 'verb',
        senses: [
          {
            sense_code: 'prepare_food',
            translation: 'לבשל',
            example: { source: 'I cook dinner.', target: 'אני מבשל ארוחת ערב.' },
          },
        ],
      },
    ]);

    // senseId is a database-issued uuid — matched by shape (Task 13 widened
    // this read to carry it, for the repair path's idByCode lookup).
    expect(await byLexeme('cook', 'verb')).toEqual([
      {
        senseId: expect.any(String),
        senseCode: 'prepare_food',
        translation: 'לבשל',
        exampleSource: 'I cook dinner.',
        exampleTarget: 'אני מבשל ארוחת ערב.',
      },
    ]);
  });

  it('is empty for a lexeme nobody has stored, which is how the service skips the second call', async () => {
    await persist('cook', [lexeme('noun', 'kitchen_worker', 'N1')]);
    expect(await byLexeme('cook', 'verb')).toEqual([]);
    expect(await byLexeme('sauté', 'verb')).toEqual([]);
  });
});
