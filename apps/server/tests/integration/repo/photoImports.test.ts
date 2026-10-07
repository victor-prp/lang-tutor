import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createPhotoImportRepo } from '../../../src/repo/photoImports';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_1');
const repo = <T>(run: (r: ReturnType<typeof createPhotoImportRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => run(createPhotoImportRepo(tx)));

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await t.close();
});

const option = { sense_id: 's1', variant_id: 'v1', translation: 'חתול', part_of_speech: 'noun' };

describe('photo import repository', () => {
  it('creates an import reading with its photo, and clears the photo on every transition', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    expect(await repo((r) => r.findImport(id))).toMatchObject({ id, enrollmentId: E, status: 'reading', photo: 'QUJD' });

    expect(await repo((r) => r.transition(id, ['reading'], 'read'))).toBe(true);
    expect(await repo((r) => r.findImport(id))).toMatchObject({ status: 'read', photo: null });
    expect(await repo((r) => r.transition(id, ['reading'], 'failed'))).toBe(false);
  });

  it('refuses a photo on an import that is no longer reading', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    await repo((r) => r.transition(id, ['reading'], 'read'));
    await expect(t.db.execute(sql`update photo_imports set photo = 'x' where id = ${id}`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('photo_imports_photo_only_while_reading') }),
    });
  });

  it('answers null, not an error, for an id that is not a uuid', async () => {
    expect(await repo((r) => r.findImport('nope'))).toBeNull();
  });

  it('writes rows pending, then a result once, and a failure only while pending', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    await repo((r) =>
      r.insertItems(id, [
        { position: 0, text: 'gatto', hebrew: 'חתול' },
        { position: 1, text: 'casa', hebrew: null },
      ]),
    );
    const result = { correctedForm: null, options: [option], chosenSenseId: 's1', ticked: true, hebrewMismatch: false, reason: null };
    expect(await repo((r) => r.writeItem(id, 0, result))).toBe(true);
    expect(await repo((r) => r.writeItem(id, 0, result))).toBe(false);
    expect(await repo((r) => r.markItemFailed(id, 0))).toBe(false);
    expect(await repo((r) => r.markItemFailed(id, 1))).toBe(true);

    const items = await repo((r) => r.listItems(id));
    expect(items.map((item) => [item.position, item.status])).toEqual([[0, 'ready'], [1, 'failed']]);
    expect(items[0]).toMatchObject({ options: [option], suggestedSenseId: 's1', chosenSenseId: 's1', ticked: true });
  });

  it('updates a tick and a sense, keeping the suggested sense', async () => {
    const { id } = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'QUJD' }));
    await repo((r) => r.insertItems(id, [{ position: 0, text: 'bank', hebrew: null }]));
    await repo((r) =>
      r.writeItem(id, 0, {
        correctedForm: null,
        options: [option, { ...option, sense_id: 's2', translation: 'גדה' }],
        chosenSenseId: 's1',
        ticked: true,
        hebrewMismatch: false,
        reason: null,
      }),
    );
    const updated = await repo((r) => r.updateItem(id, 0, { chosenSenseId: 's2', ticked: false }));
    expect(updated).toMatchObject({ chosenSenseId: 's2', suggestedSenseId: 's1', ticked: false });
    expect(await repo((r) => r.updateItem(id, 7, { ticked: false }))).toBeNull();
  });

  it('lists open imports newest first with their counts, and leaves out saved, discarded and old ones', async () => {
    const a = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'A' }));
    const b = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'B' }));
    const c = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'C' }));
    const d = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'D' }));
    await repo((r) => r.transition(a.id, ['reading'], 'read'));
    await repo((r) => r.insertItems(a.id, [{ position: 0, text: 'x', hebrew: null }, { position: 1, text: 'y', hebrew: null }]));
    await repo((r) => r.markItemFailed(a.id, 1));
    await repo((r) => r.transition(c.id, ['reading'], 'saved'));
    await repo((r) => r.transition(d.id, ['reading'], 'discarded'));
    await t.db.execute(sql`update photo_imports set created_at = now() - interval '1 minute' where id = ${a.id}`);

    const open = await repo((r) => r.listOpen({ enrollmentId: E, since: new Date(Date.now() - 60 * 60 * 1000) }));
    expect(open.map((row) => row.id)).toEqual([b.id, a.id]);
    expect(open[1]).toMatchObject({ status: 'read', itemCount: 2, settledCount: 1, pendingCount: 1 });
    expect(open[0]).toMatchObject({ status: 'reading', itemCount: 0, settledCount: 0, pendingCount: 0 });

    const later = await repo((r) => r.listOpen({ enrollmentId: E, since: new Date(Date.now() + 60 * 1000) }));
    expect(later).toEqual([]);
  });

  it('deletes an enrollment\'s imports older than a date, rows and all', async () => {
    const old = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'A' }));
    await repo((r) => r.insertItems(old.id, [{ position: 0, text: 'x', hebrew: null }]));
    const fresh = await repo((r) => r.insertImport({ enrollmentId: E, photo: 'B' }));
    await t.db.execute(sql`update photo_imports set created_at = now() - interval '15 days' where id = ${old.id}`);

    expect(await repo((r) => r.deleteExpired({ enrollmentId: E, before: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }))).toBe(1);
    expect(await repo((r) => r.findImport(old.id))).toBeNull();
    expect(await repo((r) => r.listItems(old.id))).toEqual([]);
    expect(await repo((r) => r.findImport(fresh.id))).not.toBeNull();
  });
});
