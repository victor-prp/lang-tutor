import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { MERGE_GLOSSES } from '../../../src/domain/jobs';
import { registerWorkers } from '../../../src/worker';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { countJobs, startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import { clearNamespace, expectGeminiJson, expectReconciliation, geminiBaseUrlFor, mockNamespace } from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
let ns: string;
let boss: PgBoss;

beforeEach(async () => {
  t = await createTestDb();
  ns = mockNamespace('jobs-merge-glosses');
  boss = await startTestBoss(t.db);
});
afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

const deps = (logger = createFakeLogger()) =>
  createTestServerDeps({ db: t.db, logger, rng: testRng(5), geminiBaseUrl: geminiBaseUrlFor(ns), boss });
const sense = (sense_code: string, translation: string, gloss: string) => ({ sense_code, translation, gloss, example: { source: 'A finger.', target: 'אצבע.' } });

const lexemeOf = async (lemma: string) =>
  (await t.db.execute<{ id: string }>(sql`select id from dict_lexemes where lemma = ${lemma}`)).rows[0].id;
// One lemma's live keys: the template's seeded words have glosses of their own.
const liveKeys = async (lemma: string) =>
  (
    await t.db.execute<{ key: string }>(sql`
      select g.key from dict_glosses g join dict_lexemes l on l.id = g.lexeme_id
      where l.lemma = ${lemma} and g.merged_into is null order by g.key`)
  ).rows.map((row) => row.key);

describe('the merge-glosses job (spec D7)', () => {
  it('is enqueued by the lookup whose lemma form names another gloss’s key, and merges the two', async () => {
    // `fingers` first, one answer whose citation forms make two glosses: body_part
    // drifted to the plural אצבעות, digit אצבע. Then `finger`, whose answer names
    // body_part אצבע: a rename digit's gloss blocks. One answer alone never leaves
    // such a pair (its renames land before a new sense looks for a key), so this
    // is drift between two answers, which is what the job is for.
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [{ lemma: 'finger', part_of_speech: 'noun', senses: [sense('body_part', 'אצבעות', 'אצבעות'), sense('digit', 'אצבעות', 'אצבע')] }],
      matchText: '"fingers"',
    });
    await deps().translations.translate('u_1', { text: 'fingers', from: 'en', to: 'he' });
    expect(await liveKeys('finger')).toEqual(['אצבע', 'אצבעות']);
    await expectReconciliation(ns, { senses: [sense('body_part', 'אצבע', 'אצבע'), sense('digit', 'אצבע', 'אצבע')] });
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [{ lemma: 'finger', part_of_speech: 'noun', senses: [sense('body_part', 'אצבע', 'אצבע'), sense('digit', 'אצבע', 'אצבע')] }],
      matchText: '"finger"',
    });
    await deps().translations.translate('u_1', { text: 'finger', from: 'en', to: 'he' });
    expect(await countJobs(t.db, MERGE_GLOSSES)).toBe(1);
    expect(await liveKeys('finger')).toEqual(['אצבע', 'אצבעות']);

    // The job as the worker runs it, on the payload the lookup enqueued.
    const logger = createFakeLogger();
    await registerWorkers(boss, deps(logger), { pollingIntervalSeconds: 0.5 });
    await waitFor(async () => logger.events.some((event) => event.event === 'gloss_merged'));
    expect(await liveKeys('finger')).toEqual(['אצבע']);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'gloss_merged', lexeme_id: await lexemeOf('finger'), user_language_code: 'he', memberships: 1 }),
    );
  });

  // Spec D7: two glosses that each name the other among their alternatives are a
  // synonym merge, which is out, and which could not be undone.
  it('is not enqueued for glosses that only name each other among their alternatives, and leaves them apart', async () => {
    await expectGeminiJson(ns, {
      kind: 'word',
      entries: [
        {
          lemma: 'amazing',
          part_of_speech: 'adjective',
          senses: [
            { ...sense('surprising', 'מדהים', 'מדהים'), gloss_alternatives: ['נהדר'] },
            { ...sense('excellent', 'נהדר', 'נהדר'), gloss_alternatives: ['מדהים'] },
          ],
        },
      ],
      matchText: '"amazing"',
    });
    await deps().translations.translate('u_1', { text: 'amazing', from: 'en', to: 'he' });
    expect(await countJobs(t.db, MERGE_GLOSSES)).toBe(0);

    const logger = createFakeLogger();
    await deps(logger).glosses.mergeLexeme({ lexeme_id: await lexemeOf('amazing'), user_language_code: 'he' });
    expect(await liveKeys('amazing')).toEqual(['מדהים', 'נהדר']);
    expect(logger.events).toEqual([]);
  });

  it('changes nothing, and logs no gloss_merged, on a lexeme with one gloss per key', async () => {
    const bank = await insertLexeme(t.db, {
      lemma: 'bank',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'money' }, { senseCode: 'river' }],
      variants: [
        {
          form: 'bank',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'money', rank: 0, translation: 'בנק', exampleSource: null, exampleTarget: null },
            { senseCode: 'river', rank: 1, translation: 'גדה', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const logger = createFakeLogger();
    await deps(logger).glosses.mergeLexeme({ lexeme_id: bank.lexemeId, user_language_code: 'he' });
    expect(await liveKeys('bank')).toEqual(['בנק', 'גדה']);
    expect(logger.events).toEqual([]);
  });
});
