import { describe, expect, it } from '@jest/globals';
import type { Enrollment } from '@lang-tutor/core/api';

import {
  createFakeClock,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTargetRepo,
  createFakeTransaction,
  createFakeTranscriber,
  stub,
  type FakeJobRepo,
  type FakeLogger,
  type FakeTargetRepo,
} from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { PREPARE_SESSION, STOCK_SESSION } from '../domain/jobs';
import type { SessionSummary } from '../domain/session';
import type { TargetSplit } from '../domain/targetSession';
import type { TargetKind } from '../domain/targets';
import { NoSavedWords, SessionNotFound, SessionNotReady, SessionOpen } from '../errors';
import type { DictRepo } from '../repo/dictionary';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GlossFamiliesRepo } from '../repo/glossFamilies';
import type { MemoryRepo } from '../repo/memory';
import type { ProgressRepo } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import type { UserRepo } from '../repo/users';
import type { VocabularyRepo } from '../repo/vocabulary';
import { createSessionService, type SessionService } from './sessions';
import type { Repos } from './transaction';

// Phase 43 (spec D2–D6). The stock: built beside a started session, by the job
// or by create; started by the start call; offered by current.

const E = 'e1';
// The learner day the world's clock reads (2026-10-12T10:00Z, in UTC): what a stock records as chosen_on (phase 53).
const TODAY = '2026-10-12';
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
  { glossId: 'g_a', key: 'כלב', variantId: 'v_a', savedAt: '2026-10-11T09:00:00.000000Z', lexemeId: 'l_a', lemma: 'dog', form: 'dog', order: [0, 0] as [number, number], knownAt: null },
  { glossId: 'g_b', key: 'חתול', variantId: 'v_b', savedAt: '2026-10-10T09:00:00.000000Z', lexemeId: 'l_b', lemma: 'cat', form: 'cat', order: [0, 0] as [number, number], knownAt: null },
];

function world(session: Partial<SessionRepo>, extra: Partial<Repos> = {}) {
  const jobs = createFakeJobRepo();
  const logger = createFakeLogger();
  const inserted: unknown[][] = [];
  const retired: string[] = [];
  const locked: string[] = [];
  const service = createSessionService({
    transaction: createFakeTransaction({
      enrollment: stub<EnrollmentRepo>({ findById: async () => ENROLLMENT }),
      user: stub<UserRepo>({ findDayContext: async () => ({ kind: 'learner' as const, timeZone: 'UTC' }) }),
      session: stub<SessionRepo>({
        findAnswersOn: async () => [],
        findIntroducedOn: async () => [],
        lockNextSession: async (enrollmentId) => {
          locked.push(enrollmentId);
        },
        insertPreparingSession: async (...args) => {
          inserted.push(args);
          return 's_new';
        },
        // Phase 53 (spec D12). A stock chosen today, which no check replaces.
        findStockChoice: async () => ({ chosenOn: TODAY, listening: false, speaking: false }),
        retireStock: async (sessionId) => {
          retired.push(sessionId);
          return true;
        },
        ...session,
      }),
      vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => SAVED, countEntries: async () => SAVED.length, markKnown: async () => {} }),
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
    soundAlikeThreshold: 0.95,
  });
  return { service, jobs, logger, inserted, retired, locked };
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
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY]]);
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
    expect(inserted).toEqual([['u1', E, { listening: false, speaking: true }, TODAY]]);
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
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY]]);
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

// Phase 53 (spec D6, D8, D12, ruling R-D12). A stock serves the learner's targets and
// records the split it was chosen with. One chosen on an earlier learner day is replaced
// where home learns of it, the home read and create, when today's split differs from the
// one it recorded; never at start.

const YESTERDAY = '2026-10-11';
const NO_DEVICES = { listening: false, speaking: false };

const activeTarget = (id: string, kind: TargetKind, dueOn: string, glossIds: string[]) => ({
  id,
  enrollmentId: E,
  kind,
  dueOn,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  endedAt: null,
  glossIds,
});
/** On TODAY, the exam's eve, which takes every slot (spec D5), and a homework a week off,
 *  not ready. The exam's one word is g_b, saved before g_a. */
const EXAM = activeTarget('t_exam', 'exam', '2026-10-13', ['g_b']);
const HOMEWORK = activeTarget('t_homework', 'homework', '2026-10-20', ['g_a']);
const row = (targetId: string, over: Partial<TargetSplit> = {}): TargetSplit => ({
  targetId,
  wish: 10,
  slots: 10,
  picked: 1,
  reason: 'not_ready',
  daysLeft: 1,
  readyCount: 0,
  wordCount: 1,
  ...over,
});
/** TODAY's split of EXAM and HOMEWORK. The exam's eve leaves the homework no slot; the nine its
 *  one word cannot fill pass on, so the homework's word is picked all the same. */
const TODAYS_SPLIT = [row('t_exam', { reason: 'exclusive' }), row('t_homework', { slots: 0, daysLeft: 8 })];
/** What the stock chosen YESTERDAY recorded: the exam's run-up beside the homework, half each. */
const YESTERDAYS_SPLIT = [row('t_exam', { slots: 5, reason: 'run_up', daysLeft: 2 }), row('t_homework', { slots: 5, daysLeft: 9 })];

/** A learner with `active` targets today, whose stock s_stock recorded `recorded`. */
const withTargets = (active = [EXAM, HOMEWORK], recorded: TargetSplit[] = YESTERDAYS_SPLIT) =>
  createFakeTargetRepo({
    listActive: async () => active,
    findSessionSplit: async (sessionId) => (sessionId === 's_stock' ? recorded : []),
  });

/** s_stock in stock, unstarted and ready, its words chosen on `chosenOn` for a device that listens. */
const stockChosenOn = (chosenOn: string | null, source: SessionSummary['source'] = 'list'): Partial<SessionRepo> => ({
  findOpen: async () => ({ stock: summary('s_stock', 'ready', source) }),
  findLatest: async () => summary('s_stock', 'ready', source),
  findStockChoice: async () => ({ chosenOn, listening: true, speaking: false }),
});
/** Nothing open, after a session that ended: the stock job and create both build. */
const nothingOpen: Partial<SessionRepo> = {
  findOpen: async () => ({}),
  findLatest: async () => summary('s_old', 'completed'),
  findNewestDevices: async () => undefined,
};

const writes = (target: FakeTargetRepo, method: string) => target.written.filter((write) => write.method === method).map((write) => write.args);

describe('a stock serves the targets (spec D6, D8)', () => {
  it('with no active target, chooses as before and records no split', async () => {
    const target = createFakeTargetRepo();
    const { service, jobs, inserted } = world(nothingOpen, { target });
    await service.stockSession({ enrollment_id: E, reason: 'complete' });
    // Newest new words first (phase 35 D5), as chooseWords alone picks them.
    expect(pickedGlosses(jobs)).toEqual(['g_a', 'g_b']);
    expect(inserted).toEqual([['u1', E, NO_DEVICES, TODAY]]);
    expect(target.written).toEqual([]);
  });

  it('serves each target active on the learner day and records one split row per target', async () => {
    const asked: unknown[][] = [];
    const target = createFakeTargetRepo({
      listActive: async (...args) => {
        asked.push(args);
        return [EXAM, HOMEWORK];
      },
    });
    const { service, jobs, inserted } = world(nothingOpen, { target });
    await service.stockSession({ enrollment_id: E, reason: 'complete' });
    expect(asked).toEqual([[E, TODAY]]);
    // The exam's word first, though saved before the homework's: its eve is its own.
    expect(pickedGlosses(jobs)).toEqual(['g_b', 'g_a']);
    expect(inserted).toEqual([['u1', E, NO_DEVICES, TODAY]]);
    expect(writes(target, 'insertSessionSplit')).toEqual([['s_new', TODAYS_SPLIT]]);
  });

  it.each([
    ['the stock job', (service: SessionService) => service.stockSession({ enrollment_id: E, reason: 'complete' })],
    ['create', (service: SessionService) => service.createNextSession('u1', E, NO_DEVICES)],
  ])('%s records each target whose date has come as ended on it, naming the new session', async (_, run) => {
    const asked: unknown[][] = [];
    const ended = (id: string, dueOn: string) => ({
      id,
      enrollmentId: E,
      kind: 'exam' as const,
      dueOn,
      createdAt: new Date('2026-10-01T09:00:00Z'),
      endedAt: null,
    });
    const target = createFakeTargetRepo({
      listEndedUnrecorded: async (...args) => {
        asked.push(args);
        return [ended('t_older', '2026-10-05'), ended('t_today', TODAY)];
      },
    });
    const { service, logger } = world(nothingOpen, { target });
    await run(service);
    expect(asked).toEqual([[E, TODAY]]);
    expect(writes(target, 'insertEvent')).toEqual([
      [{ targetId: 't_older', kind: 'ended_on_date', before: null, after: { due_on: '2026-10-05' }, actorUserId: null, sessionId: 's_new' }],
      [{ targetId: 't_today', kind: 'ended_on_date', before: null, after: { due_on: TODAY }, actorUserId: null, sessionId: 's_new' }],
    ]);
    expect(eventsOf(logger, 'target_ended')).toEqual([
      { event: 'target_ended', target_id: 't_older', how: 'on_date' },
      { event: 'target_ended', target_id: 't_today', how: 'on_date' },
    ]);
  });
});

describe('a stock chosen on an earlier day (spec D12, ruling R-D12)', () => {
  it("is replaced on the home read when today's split differs from the one it recorded, built for the stock's device", async () => {
    const target = withTargets();
    const { service, logger, inserted, retired, locked } = world(stockChosenOn(YESTERDAY), { target });
    expect(await service.currentSession('u1', E)).toEqual({
      current: { id: 's_new', status: 'preparing', source: 'list', answered: 0, total: 0 },
      nextSource: 'list',
      savedCount: 2,
    });
    expect(locked).toEqual([E]);
    expect(retired).toEqual(['s_stock']);
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY]]);
    expect(writes(target, 'insertSessionSplit')).toEqual([['s_new', TODAYS_SPLIT]]);
    expect(eventsOf(logger, 'session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: E, session_id: 's_stock', reason: 'stale_split' },
    ]);
    expect(eventsOf(logger, 'session_stocked')).toEqual([
      { event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'stale_split' },
    ]);
    expect(eventsOf(logger, 'session_offered')).toEqual([
      { event: 'session_offered', enrollment_id: E, session_id: 's_new', status: 'preparing' },
    ]);
  });

  it('is played as it is when today gives each target the slots it recorded (phase 43 R5)', async () => {
    // A day nearer the homework's date, still not ready: the same ten slots.
    const target = withTargets([HOMEWORK], [row('t_homework', { daysLeft: 9 })]);
    const { service, logger, inserted, retired } = world(stockChosenOn(YESTERDAY), { target });
    expect((await service.currentSession('u1', E)).current?.id).toBe('s_stock');
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
    expect(target.written).toEqual([]);
    expect(eventsOf(logger, 'session_retired')).toEqual([]);
  });

  it('is played as it is with no target active and none recorded, choosing nothing', async () => {
    // The list is not even read: listSavedGlosses is not stubbed here.
    const { service, retired } = world(stockChosenOn(YESTERDAY), {
      vocabulary: stub<VocabularyRepo>({ countEntries: async () => SAVED.length }),
    });
    expect((await service.currentSession('u1', E)).current?.id).toBe('s_stock');
    expect(retired).toEqual([]);
  });

  // Every stock here says it was chosen yesterday, and today's split differs from the one it
  // recorded: only the case named keeps it.
  it.each([
    ['a session is started: home shows it, and the stock beside it waits', { findOpen: async () => ({ started: summary('s_started', 'ready'), stock: summary('s_stock', 'ready') }) }, 's_started'],
    ['it is the seed', stockChosenOn(YESTERDAY, 'seed'), 's_stock'],
    ['its day was not recorded (chosen before phase 53)', stockChosenOn(null), 's_stock'],
    ['it was chosen today', stockChosenOn(TODAY), 's_stock'],
  ])('is never replaced when %s', async (_, session, current) => {
    const { service, inserted, retired, locked } = world({ ...stockChosenOn(YESTERDAY), ...session }, { target: withTargets() });
    expect((await service.currentSession('u1', E)).current?.id).toBe(current);
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
    expect(locked).toEqual([]);
  });

  it('builds nothing when a start took the stock first', async () => {
    const { service, inserted, logger } = world({ ...stockChosenOn(YESTERDAY), retireStock: async () => false }, { target: withTargets() });
    await service.currentSession('u1', E);
    expect(inserted).toEqual([]);
    expect(eventsOf(logger, 'session_retired')).toEqual([]);
  });

  it('is replaced by create too, before it is answered', async () => {
    const target = withTargets();
    const { service, logger, inserted, retired, locked } = world(stockChosenOn(YESTERDAY), { target });
    expect(await service.createNextSession('u1', E, { listening: false, speaking: true })).toEqual({
      sessionId: 's_new',
      status: 'preparing',
      source: 'list',
      created: true,
    });
    expect(locked).toEqual([E]);
    expect(retired).toEqual(['s_stock']);
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY]]);
    expect(eventsOf(logger, 'session_retired')).toEqual([
      { event: 'session_retired', enrollment_id: E, session_id: 's_stock', reason: 'stale_split' },
    ]);
    expect(eventsOf(logger, 'session_stocked')).toEqual([
      { event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'stale_split' },
    ]);
  });

  it('is answered by create as it is when the split is unchanged', async () => {
    const target = withTargets([HOMEWORK], [row('t_homework', { daysLeft: 9 })]);
    const { service, retired, inserted } = world(stockChosenOn(YESTERDAY), { target });
    expect(await service.createNextSession('u1', E, NO_DEVICES)).toEqual({ sessionId: 's_stock', status: 'ready', source: 'list', created: false });
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
