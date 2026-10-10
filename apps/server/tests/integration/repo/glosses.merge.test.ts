import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDictRepo, type RepairedRendering } from '../../../src/repo/dictionary';
import { createGlossRepo } from '../../../src/repo/glosses';
import { insertDriftedFinger, insertLexeme, insertRendering } from '../../support/dictRows';
import { holdMergeOpen, waitForBlockedQuery } from '../../support/locks';
import { insertAnsweredSession, insertProgressRows, setLevel } from '../../support/progressRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { readSavedGlossIds } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
});
afterEach(async () => {
  await t.close();
});

const twoGlosses = () => insertDriftedFinger(t.db);

const save = (enrollmentId: string, glossId: string, variantId: string, lexemeId: string, at: string) =>
  t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id, created_at)
    values (${enrollmentId}, ${glossId}, ${lexemeId}, 'finger', ${variantId},
            (select user_id from enrollments where id = ${enrollmentId}), ${at}::timestamptz)`);

const merge = (lexemeId: string, survivorId: string, otherId: string) =>
  withTx(t.db, async (tx) => {
    await createDictRepo(tx).lockLexemes([lexemeId]);
    return createGlossRepo(tx).mergeGlosses({ survivorId, otherId });
  });

const candidatesOf = (lexemeId: string) =>
  withTx(t.db, (tx) => createGlossRepo(tx).findMergeCandidates({ lexemeId, userLanguageCode: 'he' }));

describe('mergeGlosses (spec D7)', () => {
  it('folds two enrollments onto the survivor: one entry each, the best levels, the earlier save, every question re-pointed', async () => {
    const w = await twoGlosses();
    const e1 = enrollmentOf('u_1');
    const e2 = enrollmentOf('u_2');
    await save(e1, w.other, w.fingers, w.lexemeId, '2026-01-01');
    await save(e1, w.survivor, w.finger, w.lexemeId, '2026-02-01');
    await save(e2, w.other, w.fingers, w.lexemeId, '2026-03-01');
    await insertProgressRows(t.db, e1, [w.other, w.survivor]);
    await insertProgressRows(t.db, e2, [w.other]);
    await setLevel(t.db, { enrollmentId: e1, glossId: w.other, level: 3, dimension: 'written_receptive' });
    await setLevel(t.db, { enrollmentId: e1, glossId: w.survivor, level: 4, dimension: 'written_productive' });
    const session = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: e1,
      status: 'completed',
      asked: [
        { glossId: w.other, variantId: w.fingers, translation: 'אצבעות' },
        { glossId: w.survivor, variantId: w.finger, translation: 'אצבע' },
      ],
      answers: [],
    });

    const counts = await merge(w.lexemeId, w.survivor, w.other);

    expect(counts).toMatchObject({ entriesMoved: 1, entriesFolded: 1, questions: 1, memberships: 1 });
    expect(await readSavedGlossIds(t.db, e1)).toEqual([w.survivor]);
    expect(await readSavedGlossIds(t.db, e2)).toEqual([w.survivor]);
    const kept = await t.db.execute<{ variant_id: string }>(sql`select variant_id from vocabulary_entries where enrollment_id = ${e1}`);
    expect(kept.rows).toEqual([{ variant_id: w.fingers }]);
    const levels = await t.db.execute<{ dimension: string; level: number }>(sql`
      select dimension, level from gloss_progress where enrollment_id = ${e1} and dimension in ('written_receptive', 'written_productive') order by dimension`);
    expect(levels.rows).toEqual([{ dimension: 'written_productive', level: 4 }, { dimension: 'written_receptive', level: 3 }]);
    const questions = await t.db.execute<{ gloss_id: string }>(sql`
      select distinct q.gloss_id from questions q join session_questions sq on sq.question_id = q.id where sq.session_id = ${session}`);
    expect(questions.rows).toEqual([{ gloss_id: w.survivor }]);
    const forwarded = await t.db.execute<{ merged_into: string | null }>(sql`select merged_into from dict_glosses where id = ${w.other}`);
    expect(forwarded.rows).toEqual([{ merged_into: w.survivor }]);
    const survivor = await t.db.execute<{ alternatives: string[] }>(sql`select alternatives from dict_glosses where id = ${w.survivor}`);
    expect(survivor.rows[0].alternatives).toContain('אצבעות');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const w = await twoGlosses();
    await merge(w.lexemeId, w.survivor, w.other);
    expect(await merge(w.lexemeId, w.survivor, w.other)).toBeNull();
  });

  // dict:glosses:merge applies plans built from the model's groups, where a
  // repeated word can pair a gloss with itself.
  it('does nothing when asked to merge a gloss into itself', async () => {
    const w = await twoGlosses();
    const e1 = enrollmentOf('u_1');
    await save(e1, w.survivor, w.finger, w.lexemeId, '2026-01-01');
    const glossRows = () =>
      t.db.execute<{ id: string; key: string; alternatives: string[]; merged_into: string | null }>(sql`
        select id, key, alternatives, merged_into from dict_glosses where lexeme_id = ${w.lexemeId} order by id`);
    const before = (await glossRows()).rows;

    expect(await merge(w.lexemeId, w.survivor, w.survivor)).toBeNull();

    expect((await glossRows()).rows).toEqual(before);
    expect(await readSavedGlossIds(t.db, e1)).toEqual([w.survivor]);
  });

  it('resolves a forwarded id to its survivor', async () => {
    const w = await twoGlosses();
    await merge(w.lexemeId, w.survivor, w.other);
    const resolved = await withTx(t.db, (tx) => createGlossRepo(tx).resolveGlosses([w.other, w.survivor]));
    expect(resolved.get(w.other)).toEqual({ id: w.survivor, lexemeId: w.lexemeId, userLanguageCode: 'he' });
    expect(resolved.get(w.survivor)?.id).toBe(w.survivor);
  });

  it('names a blocked rename as a candidate, and leaves two glosses that only name each other alone', async () => {
    const w = await twoGlosses();
    // The lemma form renders body_part as אצבע: the drift D6 could not rename.
    await insertRendering(t.db, { variantId: w.finger, senseId: w.senseIds[0], userLanguageCode: 'he', translation: 'אצבע', gloss: 'אצבע', rank: 1 });
    const candidates = await withTx(t.db, (tx) => createGlossRepo(tx).findMergeCandidates({ lexemeId: w.lexemeId, userLanguageCode: 'he' }));
    expect(candidates).toEqual([{ otherId: w.other, survivorId: w.survivor }]);

    const amazing = await insertLexeme(t.db, {
      lemma: 'amazing',
      languageCode: 'en',
      partOfSpeech: 'adjective',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'surprising' }, { senseCode: 'excellent' }],
      variants: [
        {
          form: 'amazing',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'surprising', rank: 0, translation: 'מדהים', alternatives: ['נהדר'], exampleSource: null, exampleTarget: null },
            { senseCode: 'excellent', rank: 1, translation: 'נהדר', alternatives: ['מדהים'], exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const none = await withTx(t.db, (tx) => createGlossRepo(tx).findMergeCandidates({ lexemeId: amazing.lexemeId, userLanguageCode: 'he' }));
    expect(none).toEqual([]);
  });

  // Spec D6's own case: `difficult`'s second sense is קשה today and מסובך on
  // another day (on `tough` here: the seed holds `difficult`). The write lets a
  // gloss's first member on the lemma form, by rank, alone decide its rename, so
  // the job's signal reads that member alone: a later member's other word is no
  // blocked rename, and a merge it asked for could not be undone.
  it("reads only a gloss's first member on the lemma form, as the write's rename does", async () => {
    const word = await insertLexeme(t.db, {
      lemma: 'tough',
      languageCode: 'en',
      partOfSpeech: 'adjective',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'hard' }, { senseCode: 'complicated' }, { senseCode: 'intricate' }],
      variants: [
        {
          form: 'tough',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'hard', rank: 0, translation: 'קשה', exampleSource: null, exampleTarget: null },
            { senseCode: 'complicated', rank: 1, translation: 'קשה', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const [hard, complicated, intricate] = word.senseIds;
    const rendering = (senseId: string, rank: number, gloss: string): RepairedRendering => ({
      senseId,
      rank,
      translation: gloss,
      alternatives: [],
      gloss,
      glossAlternatives: [],
      definition: null,
      exampleSource: null,
      exampleTarget: null,
    });
    // Another day's answer for the lemma form, through the real writer.
    const repair = (senses: RepairedRendering[]) =>
      withTx(t.db, async (tx) => {
        const dict = createDictRepo(tx);
        await dict.lockLexemes([word.lexemeId]);
        return dict.repairVariantRenderings({
          variantId: word.variantIds[0],
          lexemeId: word.lexemeId,
          userLanguageCode: 'he',
          senseVersion: 3,
          lemmaForm: true,
          senses,
        });
      });
    const keys = async () =>
      (await t.db.execute<{ id: string; key: string }>(sql`
        select id, key from dict_glosses where lexeme_id = ${word.lexemeId} and merged_into is null order by key`)).rows;

    // The first member still says קשה; the second now says מסובך, beside a
    // live gloss keyed מסובך. The write renames nothing and asks for no merge.
    expect(await repair([rendering(hard, 0, 'קשה'), rendering(complicated, 1, 'מסובך'), rendering(intricate, 2, 'מסובך')])).toEqual({ needsMerge: false });
    const [complexGloss, hardGloss] = await keys();
    expect([complexGloss.key, hardGloss.key]).toEqual(['מסובך', 'קשה']);
    expect(await candidatesOf(word.lexemeId)).toEqual([]);

    // Once the first member itself says מסובך, the write asks, and the job agrees.
    expect(await repair([rendering(hard, 0, 'מסובך'), rendering(complicated, 1, 'קשה'), rendering(intricate, 2, 'מסובך')])).toEqual({ needsMerge: true });
    expect(await candidatesOf(word.lexemeId)).toEqual([{ otherId: hardGloss.id, survivorId: complexGloss.id }]);
  });
});

// Spec §3: a lookup that joins a sense to a gloss while the job merges that
// gloss. The lookup's write waits on the lexeme row the merge holds FOR UPDATE
// (persistEntries' step 1b), then reads what the merge left: the key it names
// is a forwarded gloss's, so the new sense joins the survivor (D7).
describe('a lookup racing a merge (spec D7)', () => {
  const membershipsOf = async (lexemeId: string) =>
    (
      await t.db.execute<{ sense_code: string; gloss_id: string; live: boolean }>(sql`
        select s.sense_code, m.gloss_id, g.merged_into is null as live
        from dict_sense_glosses m
        join dict_senses s  on s.id = m.sense_id
        join dict_glosses g on g.id = m.gloss_id
        where m.lexeme_id = ${lexemeId} and m.user_language_code = 'he'
        order by s.sense_code`)
    ).rows;
  const renderingsWithoutGloss = async (lexemeId: string) =>
    (
      await t.db.execute<{ n: number }>(sql`
        select count(*)::int as n
        from dict_var_translations tr
        join dict_variants v on v.id = tr.variant_id
        left join dict_sense_glosses m on m.sense_id = tr.sense_id and m.user_language_code = tr.user_language_code
        where v.lexeme_id = ${lexemeId} and m.gloss_id is null`)
    ).rows[0].n;

  it('commits both: the new sense joins the survivor, and no rendering is left without a gloss', async () => {
    const w = await twoGlosses();
    const merging = holdMergeOpen(t.db, { lexemeId: w.lexemeId, survivorId: w.survivor, otherId: w.other });
    await merging.ready;
    // A miss on another form of `finger`, whose answer brings a sense the
    // dictionary has not met, its citation form the key the merge folds away.
    const looking = withTx(t.db, (tx) =>
      createDictRepo(tx).persistEntries({
        form: "finger's",
        languageCode: 'en',
        userLanguageCode: 'he',
        kind: 'word',
        entries: [{ lemma: 'finger', part_of_speech: 'noun', senses: [{ sense_code: 'measure', translation: 'אצבעות', gloss: 'אצבעות' }] }],
      }),
    );
    await waitForBlockedQuery(t.db);
    merging.release();

    await expect(merging.done).resolves.toBeUndefined();
    expect((await looking).glosses).toEqual({ created: 0, joined: 1, members: 1 });
    expect(await membershipsOf(w.lexemeId)).toEqual([
      { sense_code: 'body_part', gloss_id: w.survivor, live: true },
      { sense_code: 'digit', gloss_id: w.survivor, live: true },
      { sense_code: 'measure', gloss_id: w.survivor, live: true },
    ]);
    expect(await renderingsWithoutGloss(w.lexemeId)).toBe(0);
  });
});
