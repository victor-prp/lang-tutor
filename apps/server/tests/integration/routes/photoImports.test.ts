import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { PhotoImportOption } from '@lang-tutor/core/api';
import { Hono } from 'hono';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { createPhotoImportsRouter } from '../../../src/routes/photoImports';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { addedByOf } from '../../support/grantRows';
import { countJobs, startTestBoss, stopTestBoss } from '../../support/jobs';
import { seedPhotoImport } from '../../support/photoImportRows';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;
const IT = 'e_it';

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: IT, userId: 'u_1', targetLanguage: 'it' });
  boss = await startTestBoss(t.db);
  deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7), boss });
});
afterEach(async () => {
  await stopTestBoss(boss);
  await t.close();
});

function app() {
  const hono = new Hono();
  hono.route('/api', createPhotoImportsRouter(deps.photoImports));
  return hono;
}
const send = (method: string, path: string, body?: unknown) =>
  app().request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });

/** An Italian word with two senses, each rendered in Hebrew by the lemma. */
async function word(lemma: string, translations: [string, string]): Promise<PhotoImportOption[]> {
  const ids = await insertLexeme(t.db, {
    lemma,
    languageCode: 'it',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'a' }, { senseCode: 'b' }],
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'a', rank: 0, translation: translations[0], exampleSource: null, exampleTarget: null },
          { senseCode: 'b', rank: 1, translation: translations[1], exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
  return ids.senseIds.map((senseId, index) => ({ sense_id: senseId, variant_id: ids.variantIds[0], translation: translations[index] }));
}

describe('POST /api/enrollments/{id}/photo-imports', () => {
  it('answers 202 reading, and enqueues the read', async () => {
    const res = await send('POST', `/enrollments/${IT}/photo-imports`, { mime_type: 'image/jpeg', image: 'QUJD' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'reading', item_count: 0, settled_count: 0 });
    expect(await countJobs(t.db, 'read-photo')).toBe(1);
  });

  it('answers 404 for an unknown enrollment, 400 for a PNG, and 413 above 3 MB', async () => {
    expect((await send('POST', '/enrollments/nope/photo-imports', { mime_type: 'image/jpeg', image: 'QUJD' })).status).toBe(404);
    expect((await send('POST', `/enrollments/${IT}/photo-imports`, { mime_type: 'image/png', image: 'QUJD' })).status).toBe(400);
    const huge = await send('POST', `/enrollments/${IT}/photo-imports`, { mime_type: 'image/jpeg', image: 'a'.repeat(3_200_000) });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: 'photo too large' });
  });
});

describe('GET', () => {
  it('lists the open imports newest first, and leaves out saved and discarded ones', async () => {
    const [cat] = await word('gatto', ['חתול', 'חתולה']);
    const open = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'gatto', options: [cat] }, { text: 'casa' }] });
    await seedPhotoImport(t.db, { enrollmentId: IT, status: 'saved', items: [] });
    await seedPhotoImport(t.db, { enrollmentId: IT, status: 'discarded', items: [] });
    const res = await send('GET', `/enrollments/${IT}/photo-imports`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([expect.objectContaining({ id: open, status: 'looking_up', item_count: 2, settled_count: 1 })]);
  });

  it('answers one import with its rows, and 404 for an unknown or malformed id', async () => {
    const options = await word('gatto', ['חתול', 'חתולה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'gatto', hebrew: 'חתול', options }] });
    const body = (await (await send('GET', `/photo-imports/${id}`)).json()) as { status: string; items: unknown[] };
    expect(body.status).toBe('ready');
    expect(body.items).toEqual([expect.objectContaining({ text: 'gatto', hebrew: 'חתול', chosen_sense_id: options[0].sense_id, ticked: true })]);
    expect((await send('GET', '/photo-imports/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await send('GET', '/photo-imports/nope')).status).toBe(404);
  });
});

describe('PATCH /api/photo-imports/{id}/items/{position}', () => {
  it('switches a sense and unticks', async () => {
    const options = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options }] });
    const res = await send('PATCH', `/photo-imports/${id}/items/0`, { sense_id: options[1].sense_id, ticked: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chosen_sense_id: options[1].sense_id, ticked: false });
  });

  it('answers 400 for an empty body, a foreign sense, and a tick on a row with no options', async () => {
    const options = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, {
      enrollmentId: IT,
      status: 'read',
      items: [{ text: 'casa', options }, { text: 'la casa è grande', status: 'ready', options: [] }],
    });
    expect((await send('PATCH', `/photo-imports/${id}/items/0`, {})).status).toBe(400);
    expect((await send('PATCH', `/photo-imports/${id}/items/0`, { sense_id: 'other' })).status).toBe(400);
    expect((await send('PATCH', `/photo-imports/${id}/items/1`, { ticked: true })).status).toBe(400);
  });

  it('answers 400, not 500, for a position past Postgres integer range', async () => {
    const options = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options }] });
    expect((await send('PATCH', `/photo-imports/${id}/items/2147483648`, { ticked: false })).status).toBe(400);
  });

  it('answers 409 for a row still being looked up, and for a discarded import (Review Focus 2)', async () => {
    const options = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options }, { text: 'gatto' }] });
    expect((await send('PATCH', `/photo-imports/${id}/items/1`, { ticked: false })).status).toBe(409);
    expect((await send('POST', `/photo-imports/${id}/discard`)).status).toBe(204);
    expect((await send('PATCH', `/photo-imports/${id}/items/0`, { ticked: false })).status).toBe(409);
  });
});

describe('save and discard', () => {
  it('saves exactly the ticked rows’ chosen senses, and a repeated save answers the same', async () => {
    const casa = await word('casa', ['בית', 'משפחה']);
    const gatto = await word('gatto', ['חתול', 'חתולה']);
    const id = await seedPhotoImport(t.db, {
      enrollmentId: IT,
      status: 'read',
      items: [{ text: 'casa', options: casa }, { text: 'gatto', options: gatto }],
    });
    await send('PATCH', `/photo-imports/${id}/items/0`, { sense_id: casa[1].sense_id });
    await send('PATCH', `/photo-imports/${id}/items/1`, { ticked: false });

    const res = await send('POST', `/photo-imports/${id}/save`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_sense_ids: [casa[1].sense_id] });
    const page = await deps.vocabulary.listWords(IT, {});
    expect(page.items.map((item) => item.lemma)).toEqual(['casa']);
    // Phase 28. The list's owner photographed it, so the owner added it.
    expect(await addedByOf(t.db, IT)).toEqual(['u_1']);

    const again = await send('POST', `/photo-imports/${id}/save`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ saved_sense_ids: [casa[1].sense_id] });
    expect((await (await send('GET', `/enrollments/${IT}/photo-imports`)).json()) as unknown[]).toEqual([]);
  });

  it('refuses a save while a row is pending', async () => {
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'gatto' }] });
    expect((await send('POST', `/photo-imports/${id}/save`)).status).toBe(409);
  });

  it('serializes a row change against a save: either the untick lands first and is not saved, or it is refused', async () => {
    const casa = await word('casa', ['בית', 'משפחה']);
    const id = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options: casa }] });
    const [patch, saved] = await Promise.all([
      send('PATCH', `/photo-imports/${id}/items/0`, { ticked: false }),
      send('POST', `/photo-imports/${id}/save`),
    ]);
    expect([200, 409]).toContain(patch.status);
    const ids = ((await saved.json()) as { saved_sense_ids: string[] }).saved_sense_ids;
    expect(ids.includes(casa[0].sense_id)).toBe(patch.status === 409);
  });

  it('lets exactly one of a save and a discard win (Review Focus 3)', async () => {
    const casa = await word('casa', ['בית', 'משפחה']);
    const discardedFirst = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options: casa }] });
    expect((await send('POST', `/photo-imports/${discardedFirst}/discard`)).status).toBe(204);
    expect((await send('POST', `/photo-imports/${discardedFirst}/discard`)).status).toBe(204);
    expect((await send('POST', `/photo-imports/${discardedFirst}/save`)).status).toBe(409);

    const savedFirst = await seedPhotoImport(t.db, { enrollmentId: IT, status: 'read', items: [{ text: 'casa', options: casa }] });
    expect((await send('POST', `/photo-imports/${savedFirst}/save`)).status).toBe(200);
    expect((await send('POST', `/photo-imports/${savedFirst}/discard`)).status).toBe(409);
  });
});
