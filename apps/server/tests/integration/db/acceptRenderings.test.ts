import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { requestAcceptRenderings } from '../../../src/db/acceptRenderings';
import { ACCEPT_RENDERING } from '../../../src/domain/jobs';
import { insertLexeme } from '../../support/dictRows';
import { countJobs, jobPayloads } from '../../support/jobs';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { seedSavedSenses } from '../../support/vocabularyRows';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await t.close();
});

const E = enrollmentOf('u_1');
const none = (senseCode: string, translation: string) => ({ senseCode, rank: 0, translation, exampleSource: null, exampleTarget: null });
const asked = (variantId: string, senseId: string) => ({ variant_id: variantId, sense_id: senseId, user_language_code: 'he' });

describe('requestAcceptRenderings, `npm run dict:accept` (spec D13)', () => {
  it("asks for every unstamped rendering of a saved gloss's members, in every form, and for nothing else", async () => {
    // Saved, in two forms: both renderings of its sense are asked for.
    const finger = await insertLexeme(t.db, {
      lemma: 'finger', languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'digit' }],
      variants: [
        { form: 'finger', kind: 'word', entryRank: 0, translations: [none('digit', 'אצבע')] },
        { form: 'fingers', kind: 'word', entryRank: 0, translations: [none('digit', 'אצבעות')] },
      ],
    });
    await t.db.execute(sql`
      insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id)
      values (${E}, ${finger.glossIds[0]}, ${finger.lexemeId}, 'finger', ${finger.variantIds[0]}, 'u_1')`);
    // Saved, but stamped with an empty list: the job ran and found nothing.
    const tome = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'] });
    await t.db.execute(sql`update dict_var_translations set accepted_at = now() where variant_id = ${tome.variantId}`);
    // Looked up but never saved.
    await insertLexeme(t.db, {
      lemma: 'ladder', languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'steps' }],
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0, translations: [none('steps', 'סולם')] }],
    });

    expect(await requestAcceptRenderings(t.db)).toEqual({ requested: 2 });
    const payloads = (await jobPayloads(t.db, ACCEPT_RENDERING)) as ReturnType<typeof asked>[];
    expect([...payloads].sort((a, b) => a.variant_id.localeCompare(b.variant_id))).toEqual(
      [asked(finger.variantIds[0], finger.senseIds[0]), asked(finger.variantIds[1], finger.senseIds[0])].sort((a, b) =>
        a.variant_id.localeCompare(b.variant_id),
      ),
    );
  });

  it('a second run asks again only for what is still unstamped, and the queue holds one job per rendering', async () => {
    const tome = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'] });
    const sprint = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'sprint', translations: ['ריצה'] });
    expect(await requestAcceptRenderings(t.db)).toEqual({ requested: 2 });

    await t.db.execute(sql`update dict_var_translations set accepted_at = now() where variant_id = ${tome.variantId}`);
    expect(await requestAcceptRenderings(t.db)).toEqual({ requested: 1 });
    // `sprint`'s first job is still queued: the second request is the same job.
    expect(await countJobs(t.db, ACCEPT_RENDERING)).toBe(2);
    expect(await jobPayloads(t.db, ACCEPT_RENDERING)).toContainEqual(asked(sprint.variantId, sprint.senseIds[0]));
  });
});
