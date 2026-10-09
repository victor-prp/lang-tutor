import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { RENDER_LEMMA } from '../../../src/domain/jobs';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { countJobs, startTestBoss, stopTestBoss } from '../../support/jobs';
import { clearNamespace, expectGeminiJson, expectGeminiStatus, expectReconciliation, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;
let boss: PgBoss;
let logger: FakeLogger;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('jobs-render-lemma');
  boss = await startTestBoss(t.db);
  logger = createFakeLogger();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

const deps = () => createTestServerDeps({ db: t.db, logger, rng: testRng(5), geminiBaseUrl: geminiBaseUrlFor(ns), boss });
const none = (s: string) => ({ senseCode: s, rank: 0, exampleSource: null, exampleTarget: null });

async function spikeVerb() {
  return insertLexeme(t.db, {
    lemma: 'spike',
    languageCode: 'en',
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'sharp_increase' }],
    variants: [{ form: 'to spike', kind: 'word', entryRank: 0, translations: [{ ...none('sharp_increase'), translation: 'לזנק' }] }],
  });
}

async function headwordsOfForm(form: string) {
  const rows = await t.db.execute<{ part_of_speech: string; entry_rank: number }>(sql`
    select l.part_of_speech, v.entry_rank from dict_variants v join dict_lexemes l on l.id = v.lexeme_id
    where lower(v.form) = lower(${form})
      and exists (select 1 from dict_var_translations tr where tr.variant_id = v.id and tr.user_language_code = 'he')
    order by v.entry_rank`);
  return rows.rows;
}

describe('enqueueing render-lemma (spec D12)', () => {
  it('a save of a form whose lemma is unrendered asks for it once; a save of the lemma asks for nothing', async () => {
    const spike = await spikeVerb();
    const save = () => deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: spike.glossIds[0], variant_id: spike.variantIds[0] }]);
    await save();
    await save();
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(1);

    const ladder = await insertLexeme(t.db, {
      lemma: 'ladder', languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'steps' }],
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0, translations: [{ ...none('steps'), translation: 'סולם' }] }],
    });
    await deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: ladder.glossIds[0], variant_id: ladder.variantIds[0] }]);
    expect(await countJobs(t.db, RENDER_LEMMA)).toBe(1);
  });
});

describe('the render-lemma job (spec D12)', () => {
  it('on a lemma nobody looked up, runs the ordinary lookup, which writes every headword of the form', async () => {
    const spike = await spikeVerb();
    await expectReconciliation(ns, { senses: [{ sense_code: 'sharp_increase', translation: 'לזנק', gloss: 'לזנק' }] });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        { lemma: 'spike', part_of_speech: 'noun', senses: [{ sense_code: 'sharp_point', translation: 'חוד', example: { source: 'A spike.', target: 'חוד.' } }] },
        { lemma: 'spike', part_of_speech: 'verb', senses: [{ sense_code: 'jump_up', translation: 'לזנק', example: { source: 'Prices spike.', target: 'מחירים מזנקים.' } }] },
      ],
      matchText: '"spike"',
    });

    await deps().translations.renderLemma({ lexeme_id: spike.lexemeId, user_language_code: 'he' });

    expect(await headwordsOfForm('spike')).toEqual([
      { part_of_speech: 'noun', entry_rank: 0 },
      { part_of_speech: 'verb', entry_rank: 1 },
    ]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_rendered', path: 'lookup' }));
  });

  it('on a lemma already a hit without this headword, adds it with the scoped call at the next entry rank', async () => {
    await insertLexeme(t.db, {
      lemma: 'bank', languageCode: 'en', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'money' }],
      variants: [{ form: 'bank', kind: 'word', entryRank: 0, translations: [{ ...none('money'), translation: 'בנק' }] }],
    });
    const verb = await insertLexeme(t.db, {
      lemma: 'bank', languageCode: 'en', partOfSpeech: 'verb', userLanguageCode: 'he', senses: [{ senseCode: 'deposit' }],
      variants: [{ form: 'banking', kind: 'word', entryRank: 0, translations: [{ ...none('deposit'), translation: 'מפקיד' }] }],
    });
    await expectReconciliation(ns, { senses: [{ sense_code: 'deposit', translation: 'להפקיד', gloss: 'להפקיד' }] });

    await deps().translations.renderLemma({ lexeme_id: verb.lexemeId, user_language_code: 'he' });

    expect(await headwordsOfForm('bank')).toEqual([
      { part_of_speech: 'noun', entry_rank: 0 },
      { part_of_speech: 'verb', entry_rank: 1 },
    ]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_rendered', path: 'scoped' }));
  });

  it('skips, and says why, when the lemma’s lookup has no entry for this headword', async () => {
    const spike = await spikeVerb();
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [{ lemma: 'spike', part_of_speech: 'noun', senses: [{ sense_code: 'sharp_point', translation: 'חוד', example: { source: 'A spike.', target: 'חוד.' } }] }],
      matchText: '"spike"',
    });
    await deps().translations.renderLemma({ lexeme_id: spike.lexemeId, user_language_code: 'he' });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_render_skipped', reason: 'no_entry' }));
  });

  it('fails loudly for pg-boss to retry when the provider fails, and the saved word still serves', async () => {
    const spike = await spikeVerb();
    await deps().vocabulary.save('u_1', enrollmentOf('u_1'), [{ gloss_id: spike.glossIds[0], variant_id: spike.variantIds[0] }]);
    await expectGeminiStatus(ns, 500);
    await expect(deps().translations.renderLemma({ lexeme_id: spike.lexemeId, user_language_code: 'he' })).rejects.toThrow();
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'lemma_render_failed' }));
    const detail = await deps().vocabulary.wordDetail('u_1', enrollmentOf('u_1'), 'spike');
    expect(detail.senses[0]).toMatchObject({ saved: true, form: 'to spike' });
  });
});
