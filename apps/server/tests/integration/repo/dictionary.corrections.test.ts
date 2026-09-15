import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../../support/testDb';

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
