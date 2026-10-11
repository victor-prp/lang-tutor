import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { TypedTranslationQuestion } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { requestAcceptRenderings } from '../../../src/db/acceptRenderings';
import { JOB_SCHEMA } from '../../../src/db/jobs';
import { ACCEPT_MARKER } from '../../../src/domain/accept';
import { DISTRACTOR_MARKER } from '../../../src/domain/distractors';
import { ACCEPT_RENDERING, PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { registerWorkers } from '../../../src/worker';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { jobPayloads, startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import { holdRepairOpen, waitForBlockedQuery } from '../../support/locks';
import {
  STUB_ALTERNATIVE,
  assertMockServerReachable,
  clearNamespace,
  countGeminiRequests,
  expectAccept,
  expectDistractors,
  expectGeminiRawBody,
  expectGeminiStatus,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';

let t: TestDb;
let ns: string;
let boss: PgBoss;
let logger: FakeLogger;
const E = enrollmentOf('u_1');

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  ns = mockNamespace(expect.getState().currentTestName ?? 'jobs-accept-rendering');
  boss = await startTestBoss(t.db);
  logger = createFakeLogger();
  await seedUser(t.db, 'u_1');
});
afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

const deps = () => createTestServerDeps({ db: t.db, logger, rng: testRng(7), geminiBaseUrl: geminiBaseUrlFor(ns), boss });

/** `ora` saved from its plural rendering, as the audit's card had it (spec D2). */
async function oraFromHours() {
  const word = await insertLexeme(t.db, {
    lemma: 'ora', languageCode: 'it', partOfSpeech: 'noun', userLanguageCode: 'he', senses: [{ senseCode: 'hour' }],
    variants: [
      {
        form: 'ora', kind: 'word', entryRank: 0,
        translations: [{ senseCode: 'hour', rank: 0, translation: 'שעות', exampleSource: 'Ho aspettato per ore.', exampleTarget: 'חיכיתי שעות.' }],
      },
    ],
  });
  const payload = { variant_id: word.variantIds[0], sense_id: word.senseIds[0], user_language_code: 'he' };
  return { ...word, payload };
}

type Stored = { translation: string; accepted_answers: string[]; answer_form: string | null; accepted: boolean };

async function rendering(variantId: string, senseId: string): Promise<Stored> {
  const rows = await t.db.execute<Stored>(sql`
    select translation, accepted_answers, answer_form, accepted_at is not null as accepted
    from dict_var_translations
    where variant_id = ${variantId} and sense_id = ${senseId} and user_language_code = 'he'`);
  return rows.rows[0];
}

/** The accept jobs on record, as pg-boss holds them, by key. */
async function acceptJobs() {
  const rows = await t.db.execute<{ data: unknown; singleton_key: string }>(
    sql`select data, singleton_key from ${sql.raw(JOB_SCHEMA)}.job where name = ${ACCEPT_RENDERING} order by singleton_key`,
  );
  return rows.rows;
}

const events = (name: string) => logger.events.filter((event) => event.event === name);

describe('the accept job (spec D1, D2)', () => {
  it('stores every right answer, the form that agrees with the rendering, and the stamp', async () => {
    const ora = await oraFromHours();
    // The form itself and a Hebrew word are no answers; the validation drops them.
    await expectAccept(ns, { answers: ['ore', 'Ora', 'שעות', 'molte ore'], answer_form: 'ore' });

    await deps().translations.acceptRendering(ora.payload);

    expect(await rendering(ora.variantIds[0], ora.senseIds[0])).toEqual({
      translation: 'שעות',
      accepted_answers: ['ore', 'molte ore'],
      answer_form: 'ore',
      accepted: true,
    });
    expect(events('accept_stored')).toEqual([
      expect.objectContaining({ ...ora.payload, answer_count: 2, has_answer_form: true }),
    ]);
    // Asked once, about the rendering in its sense, through the saved example.
    expect(await countGeminiRequests(ns, ACCEPT_MARKER)).toBe(1);
    expect(await countGeminiRequests(ns, 'Ho aspettato per ore')).toBe(1);
  });

  it('asks nothing for a rendering it already ran for', async () => {
    const ora = await oraFromHours();
    await expectAccept(ns, { answers: ['ore'], answer_form: 'ore' });
    await deps().translations.acceptRendering(ora.payload);
    await deps().translations.acceptRendering(ora.payload);

    expect(await countGeminiRequests(ns, ACCEPT_MARKER)).toBe(1);
    expect(events('accept_skipped')).toEqual([{ event: 'accept_skipped', ...ora.payload, reason: 'already_accepted' }]);
  });

  // Review Focus 3: a rendering the job found nothing for is stamped, so the stamp,
  // not the list, says it is done.
  it('stamps an empty list when the model has no content', async () => {
    const ora = await oraFromHours();
    await expectAccept(ns, '');

    await deps().translations.acceptRendering(ora.payload);

    expect(await rendering(ora.variantIds[0], ora.senseIds[0])).toMatchObject({ accepted_answers: [], answer_form: null, accepted: true });
  });

  it('skips a rendering that is gone, with no model call', async () => {
    await deps().translations.acceptRendering({ variant_id: 'gone', sense_id: 'gone', user_language_code: 'he' });
    expect(events('accept_skipped')).toEqual([expect.objectContaining({ reason: 'rendering_gone' })]);
    expect(await countGeminiRequests(ns)).toBe(0);
  });

  it('fails loudly for pg-boss to retry when the provider fails or answers what it cannot read, and stamps nothing', async () => {
    const ora = await oraFromHours();
    await expectAccept(ns, { answers: [], answer_form: null }, { status: 500 });
    await expect(deps().translations.acceptRendering(ora.payload)).rejects.toThrow();

    await clearNamespace(ns);
    await expectGeminiRawBody(ns, JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'not json' }] } }] }));
    await expect(deps().translations.acceptRendering(ora.payload)).rejects.toThrow();

    expect(events('accept_attempt_failed')).toHaveLength(2);
    expect(await rendering(ora.variantIds[0], ora.senseIds[0])).toMatchObject({ accepted: false });
  });

  // Task 2's review: the write takes the lexeme lock the repair's caller takes,
  // and lands only on the words it asked about.
  it('leaves a rendering the repair reworded during the call unstamped, and the new words with nothing of the old', async () => {
    const ora = await oraFromHours();
    await expectAccept(ns, { answers: ['ore'], answer_form: 'ore' });
    const repair = holdRepairOpen(t.db, { lexemeId: ora.lexemeId, variantId: ora.variantIds[0], senseId: ora.senseIds[0], translation: 'שעה' });
    await repair.ready;

    const job = deps().translations.acceptRendering(ora.payload);
    await waitForBlockedQuery(t.db);
    repair.release();
    await repair.done;
    await job;

    expect(await rendering(ora.variantIds[0], ora.senseIds[0])).toEqual({ translation: 'שעה', accepted_answers: [], answer_form: null, accepted: false });
    expect(events('accept_skipped')).toEqual([expect.objectContaining({ reason: 'rendering_changed' })]);
  });

  it('writes onto the rows of a repair that kept the words, once the repair has committed', async () => {
    const ora = await oraFromHours();
    await expectAccept(ns, { answers: ['ore'], answer_form: 'ore' });
    const repair = holdRepairOpen(t.db, { lexemeId: ora.lexemeId, variantId: ora.variantIds[0], senseId: ora.senseIds[0], translation: 'שעות' });
    await repair.ready;

    const job = deps().translations.acceptRendering(ora.payload);
    await waitForBlockedQuery(t.db);
    repair.release();
    await repair.done;
    await job;

    expect(await rendering(ora.variantIds[0], ora.senseIds[0])).toEqual({
      translation: 'שעות',
      accepted_answers: ['ore'],
      answer_form: 'ore',
      accepted: true,
    });
  });
});

describe('the accept dead letter (spec D1)', () => {
  it('logs the failure once every attempt has failed, and leaves the rendering for the next session to ask again', async () => {
    const word = await seedSavedSenses(t.db, { enrollmentId: E, lemma: 'tome', translations: ['ספר'] });
    await expectAccept(ns, { answers: [], answer_form: null }, { status: 500 });
    expect(await requestAcceptRenderings(t.db)).toEqual({ requested: 1 });

    await registerWorkers(boss, deps(), { pollingIntervalSeconds: 0.5 });
    await waitFor(async () => events('accept_failed').length > 0, 25_000);

    expect(events('accept_attempt_failed')).toHaveLength(3);
    expect(events('accept_failed')).toEqual([
      { event: 'accept_failed', variant_id: word.variantId, sense_id: word.senseIds[0], user_language_code: 'he' },
    ]);
    expect(await rendering(word.variantId, word.senseIds[0])).toMatchObject({ accepted: false });
  });
});

describe('enqueueing the accept job from session preparation (spec D1)', () => {
  const WORDS: Record<string, string> = { tome: 'ספר', sprint: 'ריצה', lantern: 'פנס' };

  /** Past the seed (skipped), three saved words, `lantern` already stamped with
   *  an empty list, and a list session requested. */
  async function requestListSession() {
    const seed = await deps().sessions.createNextSession('u_1', E, { listening: false, speaking: false });
    await deps().sessions.skipSession('u_1', seed.sessionId);
    const saved: Record<string, { variantId: string; senseIds: string[] }> = {};
    for (const [lemma, translation] of Object.entries(WORDS)) {
      saved[lemma] = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
    }
    await t.db.execute(sql`update dict_var_translations set accepted_at = now() where variant_id = ${saved.lantern.variantId}`);
    const { sessionId } = await deps().sessions.createNextSession('u_1', E, { listening: false, speaking: false });
    return { sessionId, saved };
  }

  const keyOf = (word: { variantId: string; senseIds: string[] }) => `${word.variantId}:${word.senseIds[0]}:he`;
  const jobOf = (word: { variantId: string; senseIds: string[] }) => ({
    data: { variant_id: word.variantId, sense_id: word.senseIds[0], user_language_code: 'he' },
    singleton_key: keyOf(word),
  });

  // Review Focus 3: the stamp decides, not the list.
  it('asks once per picked rendering the job never ran for, through every attempt, and nothing for a stamped one with an empty list', async () => {
    const { sessionId, saved } = await requestListSession();
    const payload = ((await jobPayloads(t.db, PREPARE_SESSION)) as PrepareSessionPayload[]).find((job) => job.session_id === sessionId)!;
    const expected = [jobOf(saved.tome), jobOf(saved.sprint)].sort((a, b) => a.singleton_key.localeCompare(b.singleton_key));

    // A first attempt whose generation fails: its read has committed, and asked.
    await expectGeminiStatus(ns, 500);
    await expect(deps().sessions.prepareSession(payload)).rejects.toThrow();
    expect(await acceptJobs()).toEqual(expected);

    // The retry reads again, and the queue keeps one job per rendering.
    await clearNamespace(ns);
    await expectDistractors(ns);
    await deps().sessions.prepareSession(payload);
    expect(await acceptJobs()).toEqual(expected);
    expect((await deps().sessions.getSession('u_1', sessionId)).status).toBe('ready');
  });

  it("never writes a session's own typed alternatives into the dictionary", async () => {
    await expectAccept(ns, { answers: ['codex'], answer_form: null });
    await expectDistractors(ns);
    await registerWorkers(boss, deps(), { pollingIntervalSeconds: 0.5 });
    const { sessionId, saved } = await requestListSession();

    await waitFor(async () => (await deps().sessions.getSession('u_1', sessionId)).status === 'ready');
    await waitFor(async () => events('accept_stored').length === 2);

    const { questions } = await deps().sessions.getSession('u_1', sessionId);
    const typed = questions.find((q): q is TypedTranslationQuestion => q.type === 'typed_translation')!;
    expect(typed.alternatives).toContain(STUB_ALTERNATIVE);
    expect(await countGeminiRequests(ns, DISTRACTOR_MARKER)).toBe(1);
    for (const lemma of ['tome', 'sprint']) {
      expect(await rendering(saved[lemma].variantId, saved[lemma].senseIds[0])).toMatchObject({ accepted_answers: ['codex'], accepted: true });
    }
    expect(await rendering(saved.lantern.variantId, saved.lantern.senseIds[0])).toMatchObject({ accepted_answers: [], accepted: true });
    const leaked = await t.db.execute(sql`select 1 from dict_var_translations where ${STUB_ALTERNATIVE} = any(accepted_answers)`);
    expect(leaked.rows).toHaveLength(0);
  });
});
