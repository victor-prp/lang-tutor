import { describe, expect, it } from '@jest/globals';
import type { Enrollment } from '@lang-tutor/core/api';

import {
  createFakeClock,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  createFakeTranscriber,
  stub,
  type FakeJobRepo,
  type FakeLogger,
} from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { PREPARE_SESSION, STOCK_SESSION } from '../domain/jobs';
import type { SessionSummary } from '../domain/session';
import { NoSavedWords, SessionNotFound, SessionNotReady, SessionOpen } from '../errors';
import type { DictRepo } from '../repo/dictionary';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GlossFamiliesRepo } from '../repo/glossFamilies';
import type { MemoryRepo } from '../repo/memory';
import type { ProgressRepo } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import type { UserRepo } from '../repo/users';
import type { VocabularyRepo } from '../repo/vocabulary';
import { createSessionService } from './sessions';
import type { Repos } from './transaction';

// Phase 43 (spec D2–D6). The stock: built beside a started session, by the job
// or by create; started by the start call; offered by current.

const E = 'e1';
const ENROLLMENT: Enrollment = { id: E, user_id: 'u1', source_language: 'he', target_language: 'en', created_at: '' };
const summary = (id: string, status: SessionSummary['status'], source: SessionSummary['source'] = 'list'): SessionSummary => ({
  id,
  status,
  source,
  answered: 0,
  total: status === 'preparing' ? 0 : 10,
});

/** Two saved words, each a lexeme of its own; `g_a` saved last, so with nothing
 *  else to go on it is asked first (newest new words first, phase 35 D5). */
const SAVED = [
  { glossId: 'g_a', key: 'כלב', variantId: 'v_a', savedAt: '2026-10-11T09:00:00.000000Z', lexemeId: 'l_a', lemma: 'dog', form: 'dog', order: [0, 0] as [number, number] },
  { glossId: 'g_b', key: 'חתול', variantId: 'v_b', savedAt: '2026-10-10T09:00:00.000000Z', lexemeId: 'l_b', lemma: 'cat', form: 'cat', order: [0, 0] as [number, number] },
];

function world(session: Partial<SessionRepo>, extra: Partial<Repos> = {}) {
  const jobs = createFakeJobRepo();
  const logger = createFakeLogger();
  const inserted: unknown[][] = [];
  const service = createSessionService({
    transaction: createFakeTransaction({
      enrollment: stub<EnrollmentRepo>({ findById: async () => ENROLLMENT }),
      user: stub<UserRepo>({ findDayContext: async () => ({ kind: 'learner' as const }) }),
      session: stub<SessionRepo>({
        findAnswersOn: async () => [],
        findIntroducedOn: async () => [],
        lockNextSession: async () => {},
        insertPreparingSession: async (...args) => {
          inserted.push(args);
          return 's_new';
        },
        ...session,
      }),
      vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => SAVED, countEntries: async () => SAVED.length }),
      memory: stub<MemoryRepo>({ findRows: async () => [] }),
      progress: stub<ProgressRepo>({ findRows: async () => [] }),
      glossFamilies: stub<GlossFamiliesRepo>({ load: async () => [] }),
      dict: stub<DictRepo>({
        findLexemeForms: async () => [],
        findGlossRenderings: async () =>
          SAVED.map((gloss, i) => ({ glossId: gloss.glossId, senseId: `s${i}`, variantId: gloss.variantId, form: gloss.form, gloss: gloss.key, rank: 0 })),
      }),
      jobs,
      ...extra,
    }),
    rng: testRng(7),
    logger,
    now: createFakeClock(Date.parse('2026-10-12T10:00:00Z')),
    llm: createFakeLlmClient(''),
    contextLlm: createFakeLlmClient(''),
    checkerLlm: createFakeLlmClient(''),
    transcriber: createFakeTranscriber(''),
    judge: createFakeLlmClient(''),
    translationJudge: createFakeLlmClient(''),
  });
  return { service, jobs, logger, inserted };
}

const pickedGlosses = (jobs: FakeJobRepo) => {
  const prepare = jobs.enqueued.find((job) => job.name === PREPARE_SESSION);
  return (prepare?.data as { picks: { gloss_id: string }[] }).picks.map((pick) => pick.gloss_id);
};
const eventsOf = (logger: FakeLogger, event: string) => logger.events.filter((entry) => entry.event === event);

describe('stockSession (spec D3, D4)', () => {
  it('builds a stock beside the started session, asking its words last, for the device the start named', async () => {
    const asked: string[] = [];
    const { service, jobs, logger, inserted } = world({
      findOpen: async () => ({ started: summary('s_started', 'ready') }),
      findLatest: async () => summary('s_started', 'ready'),
      findSessionGlosses: async (sessionId) => {
        asked.push(sessionId);
        // A seed gloss the learner never saved changes nothing.
        return ['g_a', 'g_seed'];
      },
    });

    await service.stockSession({ enrollment_id: E, reason: 'start', listening: true, speaking: false });

    expect(asked).toEqual(['s_started']);
    expect(pickedGlosses(jobs)).toEqual(['g_b', 'g_a']);
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }]]);
    expect(jobs.enqueued.find((job) => job.name === PREPARE_SESSION)?.data).toMatchObject({
      session_id: 's_new',
      listening: true,
      speaking: false,
    });
    expect(eventsOf(logger, 'session_stocked')).toEqual([{ event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'start' }]);
  });

  it('builds for the newest session’s device when the trigger names none', async () => {
    const { service, inserted } = world({
      findOpen: async () => ({}),
      findLatest: async () => summary('s_old', 'completed'),
      findNewestDevices: async () => ({ listening: false, speaking: true }),
    });
    await service.stockSession({ enrollment_id: E, reason: 'complete' });
    expect(inserted).toEqual([['u1', E, { listening: false, speaking: true }]]);
  });

  it.each([
    ['a stock is there', { findOpen: async () => ({ stock: summary('s_stock', 'ready') }) }, 'stocked'],
    ['the seed comes next', { findOpen: async () => ({}), findLatest: async () => undefined }, 'seed_next'],
  ])('does nothing when %s', async (_, session, why) => {
    const { service, jobs, logger, inserted } = world(session as Partial<SessionRepo>);
    await service.stockSession({ enrollment_id: E, reason: 'skip' });
    expect(inserted).toEqual([]);
    expect(jobs.enqueued).toEqual([]);
    expect(eventsOf(logger, 'session_stock_skipped')).toEqual([{ event: 'session_stock_skipped', enrollment_id: E, reason: 'skip', why }]);
  });

  it('does nothing when the list has nothing to ask', async () => {
    const { service, logger } = world(
      { findOpen: async () => ({}), findLatest: async () => summary('s_old', 'completed'), findNewestDevices: async () => undefined },
      { vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => [] }) },
    );
    await service.stockSession({ enrollment_id: E, reason: 'save' });
    expect(eventsOf(logger, 'session_stock_skipped')).toEqual([{ event: 'session_stock_skipped', enrollment_id: E, reason: 'save', why: 'no_saved_words' }]);
  });

  it('loses a race to another stock quietly', async () => {
    const { service, logger } = world({
      findOpen: async () => ({}),
      findLatest: async () => summary('s_old', 'completed'),
      findNewestDevices: async () => undefined,
      insertPreparingSession: async () => {
        throw new SessionOpen(E);
      },
    });
    await service.stockSession({ enrollment_id: E, reason: 'answer' });
    expect(eventsOf(logger, 'session_stock_skipped')).toEqual([{ event: 'session_stock_skipped', enrollment_id: E, reason: 'answer', why: 'stocked' }]);
  });
});

describe('createNextSession (spec D5)', () => {
  it('refuses while a session is started: that one is resumed', async () => {
    const { service, jobs } = world({ findOpen: async () => ({ started: summary('s_started', 'ready'), stock: summary('s_stock', 'ready') }) });
    await expect(service.createNextSession('u1', E, { listening: false, speaking: false })).rejects.toBeInstanceOf(SessionOpen);
    expect(jobs.enqueued).toEqual([]);
  });

  it('answers the stock, building nothing', async () => {
    const { service, jobs, inserted } = world({ findOpen: async () => ({ stock: summary('s_stock', 'preparing') }) });
    expect(await service.createNextSession('u1', E, { listening: true, speaking: true })).toEqual({
      sessionId: 's_stock',
      status: 'preparing',
      source: 'list',
      created: false,
    });
    expect(inserted).toEqual([]);
    expect(jobs.enqueued).toEqual([]);
  });

  it('builds the stock itself when there is none, for the device that asked', async () => {
    const { service, inserted, logger } = world({ findOpen: async () => ({}), findLatest: async () => summary('s_old', 'skipped') });
    expect(await service.createNextSession('u1', E, { listening: true, speaking: false })).toEqual({
      sessionId: 's_new',
      status: 'preparing',
      source: 'list',
      created: true,
    });
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }]]);
    expect(eventsOf(logger, 'session_stocked')).toEqual([{ event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'create' }]);
  });

  it('has nothing to ask with an empty list', async () => {
    const { service } = world(
      { findOpen: async () => ({}), findLatest: async () => summary('s_old', 'skipped') },
      { vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => [] }) },
    );
    await expect(service.createNextSession('u1', E, { listening: false, speaking: false })).rejects.toBeInstanceOf(NoSavedWords);
  });
});

describe('startSession (spec D2)', () => {
  const state = (status: 'preparing' | 'ready' | 'completed') => ({ id: 's1', userId: 'u1', enrollmentId: E, status, source: 'list' as const });

  it('starts a ready session and asks for the next one in stock, built for this device', async () => {
    const { service, jobs, logger } = world({ findEnrollmentId: async () => E, findState: async () => state('ready'), markStarted: async () => true });
    expect(await service.startSession('u1', 's1', { listening: true, speaking: false })).toEqual({ sessionId: 's1', status: 'ready' });
    expect(jobs.enqueued).toEqual([
      { name: STOCK_SESSION, data: { enrollment_id: E, reason: 'start', listening: true, speaking: false }, options: { singletonKey: E } },
    ]);
    expect(eventsOf(logger, 'session_started')).toEqual([{ event: 'session_started', session_id: 's1', by: 'start' }]);
  });

  it('asks for nothing when the session was started already', async () => {
    const { service, jobs } = world({ findEnrollmentId: async () => E, findState: async () => state('ready'), markStarted: async () => false });
    await service.startSession('u1', 's1', { listening: false, speaking: false });
    expect(jobs.enqueued).toEqual([]);
  });

  it.each(['preparing', 'completed'] as const)('refuses a %s session: nothing to start', async (status) => {
    const { service, jobs } = world({ findEnrollmentId: async () => E, findState: async () => state(status) });
    await expect(service.startSession('u1', 's1', { listening: false, speaking: false })).rejects.toBeInstanceOf(SessionNotReady);
    expect(jobs.enqueued).toEqual([]);
  });

  it('refuses an unknown session', async () => {
    const { service } = world({ findEnrollmentId: async () => undefined });
    await expect(service.startSession('u1', 's1', { listening: false, speaking: false })).rejects.toBeInstanceOf(SessionNotFound);
  });
});

describe('currentSession (spec D6, D8)', () => {
  it('shows the started session over the stock, offering nothing', async () => {
    const { service, logger } = world({
      findOpen: async () => ({ started: summary('s_started', 'ready'), stock: summary('s_stock', 'ready') }),
      findLatest: async () => summary('s_stock', 'ready'),
    });
    expect((await service.currentSession('u1', E)).current?.id).toBe('s_started');
    expect(eventsOf(logger, 'session_offered')).toEqual([]);
  });

  it('offers the stock when no session is started, and logs how it found it', async () => {
    const { service, logger } = world({ findOpen: async () => ({ stock: summary('s_stock', 'preparing') }), findLatest: async () => summary('s_stock', 'preparing') });
    expect(await service.currentSession('u1', E)).toEqual({ current: summary('s_stock', 'preparing'), nextSource: 'list', savedCount: 2 });
    expect(eventsOf(logger, 'session_offered')).toEqual([{ event: 'session_offered', enrollment_id: E, session_id: 's_stock', status: 'preparing' }]);
  });

  it('shows the newest session when it failed and nothing is open', async () => {
    const { service } = world({ findOpen: async () => ({}), findLatest: async () => summary('s_failed', 'failed') });
    expect((await service.currentSession('u1', E)).current?.id).toBe('s_failed');
  });

  it('shows nothing when the newest session ended well', async () => {
    const { service, logger } = world({ findOpen: async () => ({}), findLatest: async () => summary('s_done', 'completed') });
    expect((await service.currentSession('u1', E)).current).toBeNull();
    expect(eventsOf(logger, 'session_offered')).toEqual([]);
  });

  it('offers no seed: the seed is created on start, ready at once', async () => {
    const { service, logger } = world({ findOpen: async () => ({ stock: summary('s_seed', 'ready', 'seed') }), findLatest: async () => summary('s_seed', 'ready', 'seed') });
    await service.currentSession('u1', E);
    expect(eventsOf(logger, 'session_offered')).toEqual([]);
  });
});
