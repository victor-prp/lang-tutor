import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

/** Raw SQL, deliberately — never `persistCorrection`, which tidies first and so
 *  could never produce these rows. This is the RESTORE path's backstop:
 *  `dict:restore` reaches the repository without passing through `domain/`,
 *  `router.openapi` does not validate responses at runtime, and a hand-edited
 *  `corrections.jsonl` is therefore the one way a row that violates the published
 *  contract could reach the wire with nothing noticing. It is also the reason
 *  criterion 9 can say `storable` rather than `sent`. */
async function insertRaw(values: {
  typedForm: string;
  correctedForm: string;
  alternatives: string[];
}): Promise<void> {
  const array = `{${values.alternatives.map((a) => `"${a}"`).join(',')}}`;
  await t.db.execute(sql`
    INSERT INTO dict_corrections (language_code, typed_form, corrected_form, alternatives)
    VALUES ('en', ${values.typedForm}, ${values.correctedForm}, ${array}::text[])
  `);
}

describe('the dict_corrections constraints', () => {
  const ok = { typedForm: 'thruot', correctedForm: 'throat', alternatives: [] as string[] };

  it('accepts a well-formed redirect', async () => {
    await expect(insertRaw(ok)).resolves.toBeDefined();
  });

  it('rejects a typed form over 100 characters', async () => {
    await expect(insertRaw({ ...ok, typedForm: 'a'.repeat(101) })).rejects.toThrow(
      /dict_corrections_typed_form_length/,
    );
  });

  it('rejects a corrected form over 100 characters', async () => {
    await expect(insertRaw({ ...ok, correctedForm: 'a'.repeat(101) })).rejects.toThrow(
      /dict_corrections_corrected_form_length/,
    );
  });

  it('rejects a fourth alternative', async () => {
    await expect(
      insertRaw({ ...ok, alternatives: ['a1', 'b2', 'c3', 'd4'] }),
    ).rejects.toThrow(/dict_corrections_alternatives_valid/);
  });

  it('rejects an alternative over 100 characters', async () => {
    await expect(insertRaw({ ...ok, alternatives: ['a'.repeat(101)] })).rejects.toThrow(
      /dict_corrections_alternatives_valid/,
    );
  });

  // The unique index IS this table's identity — there is no primary key. Proven
  // against raw SQL rather than through `persistCorrection`, whose whole contract
  // is that a second write for one typed form raises NOTHING.
  it('rejects a duplicate typed form, matched case-insensitively', async () => {
    await insertRaw(ok);
    await expect(insertRaw({ ...ok, typedForm: 'Thruot' })).rejects.toThrow(
      /dict_corrections_form_key/,
    );
  });

  // Stored as written, matched on lower() — the same rule dict_variants uses, so
  // a learner who typed `Thruot` is matched by one who typed `thruot` while the
  // row keeps the shape it arrived in.
  it('keeps the casing it was written with', async () => {
    await insertRaw({ ...ok, typedForm: 'Thruot' });
    const rows = await t.db.execute<{ typed_form: string }>(
      sql`SELECT typed_form FROM dict_corrections`,
    );
    expect(rows.rows[0].typed_form).toBe('Thruot');
  });
});

const EN = { languageCode: 'en' };

const write = (input: { typedForm: string; correctedForm: string; alternatives: string[] }) =>
  withTx(t.db, (tx) => createDictRepo(tx).persistCorrection({ ...EN, ...input }));

const read = (form: string) =>
  withTx(t.db, (tx) => createDictRepo(tx).findCorrectionByForm({ ...EN, form }));

describe('persistCorrection and findCorrectionByForm', () => {
  it('round-trips a redirect', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: ['throughout'] });

    expect(await read('thruot')).toEqual({
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['throughout'],
    });
  });

  it('matches on lower(typed_form), so a differently-cased typo finds the row', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: [] });

    expect((await read('Thruot'))?.correctedForm).toBe('throat');
    expect((await read('THRUOT'))?.correctedForm).toBe('throat');
  });

  it('answers undefined for a form with no redirect', async () => {
    expect(await read('throat')).toBeUndefined();
  });

  it('scopes the lookup to the language', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: [] });
    const other = await withTx(t.db, (tx) =>
      createDictRepo(tx).findCorrectionByForm({ languageCode: 'he', form: 'thruot' }),
    );
    expect(other).toBeUndefined();
  });

  // The contract the whole flow depends on: a second write for one typed form is
  // a NO-OP that raises nothing, and leaves the FIRST target in place. Three
  // ordinary paths reach it — a step-3 fall-through, a concurrent double miss,
  // and a dict:restore replayed onto a database that already holds part of the
  // file. A raise on any of them would roll persistEntries back with it, so the
  // corrected form would never be written, so the next lookup would miss again,
  // forever.
  it('is a no-op on a second write for the same typed form', async () => {
    await write({ typedForm: 'thruot', correctedForm: 'throat', alternatives: ['throughout'] });
    await expect(
      write({ typedForm: 'Thruot', correctedForm: 'throughout', alternatives: [] }),
    ).resolves.toBeUndefined();

    expect(await read('thruot')).toEqual({
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['throughout'],
    });
    const rows = await t.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM dict_corrections`,
    );
    expect(rows.rows[0].count).toBe('1');
  });

  // The cap belongs to the WRITE, not to one caller. This is the restore path's
  // shape exactly: no `domain/` guard anywhere in the call, because dictImport
  // does not go through domain/ at all — it calls the repository directly, and
  // that is deliberate, since a restored row and a looked-up row are
  // indistinguishable precisely because the restore replays through the
  // repository. A corrections.jsonl holding four alternatives would otherwise
  // produce a row that violates the published response schema on every redirect
  // hit, and router.openapi does not validate responses at runtime.
  it('stores at most three alternatives, deduplicated, with no domain guard in the call', async () => {
    await write({
      typedForm: 'thruot',
      correctedForm: 'throat',
      alternatives: ['Throughout', 'throughout', 'throaty', 'thruot', 'throat', 'thorough'],
    });

    expect((await read('thruot'))?.alternatives).toEqual([
      'Throughout',
      'throaty',
      'thorough',
    ]);
  });
});
