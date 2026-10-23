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
import { FSRS6_DEFAULT, type QuestionType } from '@lang-tutor/core/domain';
import { NoSavedWords, SessionNotFound, SessionNotReady, SessionOpen, TargetClosed } from '../errors';
import type { DictRepo } from '../repo/dictionary';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { MyWordsDayRepo } from '../repo/myWordsDays';
import type { GlossFamiliesRepo } from '../repo/glossFamilies';
import type { MemoryRepo } from '../repo/memory';
import type { ProgressRepo } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import type { TargetBudgetRepo } from '../repo/targetBudgets';
import type { TargetReadinessRepo } from '../repo/targetReadiness';
import type { TargetSkillRepo } from '../repo/targetSkills';
import type { UserRepo } from '../repo/users';
import type { VocabularyRepo } from '../repo/vocabulary';
import { createSessionService, type SessionService } from './sessions';
import type { Repos } from './transaction';

// Phase 43 (spec D2–D6). The stock: built beside a started session, by the job
// or by create; started by the start call; offered by current.

const E = 'e1';
// Phase 70 (spec D4). A learner who never chose, whose day still has room: nothing held back.
const NOTHING_HELD = { count: 0, dayCap: 15 };
const NOTHING_HELD_LOG = { new_words_held: 0, day_new_cap: 15 };
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
      enrollment: stub<EnrollmentRepo>({ findById: async () => ENROLLMENT, findMyWordsGoal: async () => null }),
      myWordsDays: stub<MyWordsDayRepo>({ find: async () => undefined }),
      user: stub<UserRepo>({ findDayContext: async () => ({ kind: 'learner' as const, timeZone: 'UTC' }), findNewWordLimits: async () => ({ dayCap: null, perSession: null, discoverCount: null }) }),
      session: stub<SessionRepo>({
        findAnswersOn: async () => [],
        findPathAnswers: async () => [],
        findIntroducedOn: async () => [],
        lockNextSession: async (enrollmentId) => {
          locked.push(enrollmentId);
        },
        findNewestDevices: async () => undefined,
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
      // Phase 74 (spec D7): a word never met, so My words needs no new words.
      vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => SAVED, countEntries: async () => SAVED.length, countNeverMet: async () => 1, markKnown: async () => {} }),
      memory: stub<MemoryRepo>({ findRows: async () => [], findEnrollmentRows: async () => [] }),
      // Phase 67 (spec D1): no readiness yet, so every target word reads below 90.
      targetReadiness: stub<TargetReadinessRepo>({ findRows: async () => [], findFirstEventsOn: async () => [] }),
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
    gapCheckLlm: createFakeLlmClient(''),
    gapRewriteLlm: createFakeLlmClient(''),
    pointCheckLlm: createFakeLlmClient(''),
    transcriber: createFakeTranscriber(''),
    judge: createFakeLlmClient(''),
    translationJudge: createFakeLlmClient(''),
    explainer: createFakeLlmClient(''),
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
      findOpen: async (_enrollmentId, path) => (path === null ? { started: summary('s_started', 'ready') } : {}),
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
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY, null, NOTHING_HELD]]);
    expect(jobs.enqueued.find((job) => job.name === PREPARE_SESSION)?.data).toMatchObject({
      session_id: 's_new',
      listening: true,
      speaking: false,
    });
    expect(eventsOf(logger, 'session_stocked')).toEqual([{ event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'start', ...NOTHING_HELD_LOG }]);
  });

  it('builds for the newest session’s device when the trigger names none', async () => {
    const { service, inserted } = world({
      findOpen: async () => ({}),
      findLatest: async () => summary('s_old', 'completed'),
      findNewestDevices: async () => ({ listening: false, speaking: true }),
    });
    await service.stockSession({ enrollment_id: E, reason: 'complete' });
    expect(inserted).toEqual([['u1', E, { listening: false, speaking: true }, TODAY, null, NOTHING_HELD]]);
  });

  it.each([
    ['a stock is there', { findOpen: async () => ({ stock: summary('s_stock', 'ready') }) }, 'stocked'],
    ['the seed comes next', { findOpen: async () => ({}), findLatest: async () => undefined }, 'seed_next'],
  ])('does nothing when %s', async (_, session, why) => {
    // Phase 73 (spec D6): the seed comes next only for a learner with no word of their own.
    const { service, jobs, logger, inserted } = world(session as Partial<SessionRepo>, {
      vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => [], countEntries: async () => 0 }),
    });
    await service.stockSession({ enrollment_id: E, reason: 'skip' });
    expect(inserted).toEqual([]);
    expect(jobs.enqueued).toEqual([]);
    expect(eventsOf(logger, 'session_stock_skipped')).toEqual([{ event: 'session_stock_skipped', enrollment_id: E, reason: 'skip', why }]);
  });

  it('builds a stock for a learner with a saved word and no session yet: the seed is not next (phase 73 D6)', async () => {
    const { service, inserted, logger } = world({ findOpen: async () => ({}), findLatest: async () => undefined });
    await service.stockSession({ enrollment_id: E, reason: 'save' });
    expect(inserted).toHaveLength(1);
    expect(eventsOf(logger, 'session_stock_skipped')).toEqual([]);
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
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY, null, NOTHING_HELD]]);
    expect(eventsOf(logger, 'session_stocked')).toEqual([{ event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'create', ...NOTHING_HELD_LOG }]);
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
  const state = (status: 'preparing' | 'ready' | 'completed') => ({ id: 's1', userId: 'u1', enrollmentId: E, status, source: 'list' as const, targetId: null });

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
    expect((await service.currentSession('u1', E)).current).toMatchObject({ id: 's_started', started: true });
    expect(eventsOf(logger, 'session_offered')).toEqual([]);
  });

  it('offers the stock when no session is started, and logs how it found it', async () => {
    const { service, logger } = world({ findOpen: async () => ({ stock: summary('s_stock', 'preparing') }), findLatest: async () => summary('s_stock', 'preparing') });
    expect(await service.currentSession('u1', E)).toEqual({
      current: { ...summary('s_stock', 'preparing'), started: false },
      nextSource: 'list',
      savedCount: 2,
      dueCount: 0,
      today: expect.objectContaining({ goal: 3, sessions_done: 0 }),
      needsNewWords: false,
    });
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

// Phase 57 (spec D1, D2, D10, ADR 0014). Every session belongs to a path: the main path, which
// asks saved words in no active target, or a target's. A target path's stale check is below, each
// branch on its own; the choice it reads and its records in the database are
// tests/integration/services/sessions.targets.test.ts'.

const YESTERDAY = '2026-10-11';
const NO_DEVICES = { listening: false, speaking: false };

const target = (id: string, dueOn: string, glossIds: string[], endedAt: Date | null = null) => ({
  id,
  enrollmentId: E,
  kind: 'exam' as const,
  dueOn,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  endedAt,
  glossIds,
});

/** s_stock in stock, unstarted and ready, its words chosen on `chosenOn` for a device that listens. */
const stockChosenOn = (chosenOn: string | null): Partial<SessionRepo> => ({
  findOpen: async () => ({ stock: summary('s_stock', 'ready') }),
  findLatest: async () => summary('s_stock', 'ready'),
  findStockChoice: async () => ({ chosenOn, listening: true, speaking: false }),
});
/** Nothing open, after a session that ended: the stock job and create both build. */
const nothingOpen: Partial<SessionRepo> = {
  findOpen: async () => ({}),
  findLatest: async () => summary('s_old', 'completed'),
  findNewestDevices: async () => undefined,
};

const writes = (target: FakeTargetRepo, method: string) => target.written.filter((write) => write.method === method).map((write) => write.args);

describe('the main path (spec D1, D2)', () => {
  it('with no active target, chooses as before on the main path and records no target', async () => {
    const targets = createFakeTargetRepo();
    const paths: unknown[][] = [];
    const { service, jobs, inserted, locked } = world(
      {
        ...nothingOpen,
        findOpen: async (...args) => {
          paths.push(args);
          return {};
        },
      },
      { target: targets },
    );
    await service.stockSession({ enrollment_id: E, reason: 'complete' });
    // Newest new words first (phase 35 D5), as chooseWords alone picks them.
    expect(pickedGlosses(jobs)).toEqual(['g_a', 'g_b']);
    expect(inserted).toEqual([['u1', E, NO_DEVICES, TODAY, null, NOTHING_HELD]]);
    expect(locked).toEqual([E]);
    expect(paths.every(([, path]) => path === null)).toBe(true);
    expect(targets.written).toEqual([]);
    expect(jobs.enqueued.find((job) => job.name === PREPARE_SESSION)?.data).not.toHaveProperty('target');
  });

  it("asks no word an active target holds, on the learner's day", async () => {
    const asked: unknown[][] = [];
    const targets = createFakeTargetRepo({
      listActive: async (...args) => {
        asked.push(args);
        return [target('t_exam', '2026-10-13', ['g_b'])];
      },
    });
    const { service, jobs } = world(nothingOpen, { target: targets });
    await service.stockSession({ enrollment_id: E, reason: 'complete' });
    expect(asked).toEqual([[E, TODAY]]);
    expect(pickedGlosses(jobs)).toEqual(['g_a']);
    expect(writes(targets, 'insertSessionTarget')).toEqual([]);
  });

  it('has nothing to ask when every saved word is in an active target', async () => {
    const targets = createFakeTargetRepo({ listActive: async () => [target('t_exam', '2026-10-13', ['g_a', 'g_b'])] });
    const { service, logger } = world(nothingOpen, { target: targets });
    await service.stockSession({ enrollment_id: E, reason: 'complete' });
    expect(eventsOf(logger, 'session_stock_skipped')).toEqual([{ event: 'session_stock_skipped', enrollment_id: E, reason: 'complete', why: 'no_saved_words' }]);
  });

  it.each([
    ['the stock job', (service: SessionService) => service.stockSession({ enrollment_id: E, reason: 'complete' })],
    ['create', (service: SessionService) => service.createNextSession('u1', E, NO_DEVICES)],
  ])('%s records each target whose date has passed as ended on it, naming the new session, and retires its stock', async (_, run) => {
    const asked: unknown[][] = [];
    const ended = (id: string, dueOn: string) => ({ ...target(id, dueOn, []), glossIds: undefined });
    const targets = createFakeTargetRepo({
      listEndedUnrecorded: async (...args) => {
        asked.push(args);
        return [ended('t_older', '2026-10-05'), ended('t_yesterday', YESTERDAY)];
      },
    });
    const { service, logger, retired } = world(
      {
        ...nothingOpen,
        findOpen: async (_enrollmentId, path) => (path === 't_yesterday' ? { stock: summary('s_left', 'ready') } : {}),
      },
      { target: targets },
    );
    await run(service);
    expect(asked).toEqual([[E, TODAY]]);
    expect(writes(targets, 'insertEvent')).toEqual([
      [{ targetId: 't_older', kind: 'ended_on_date', before: null, after: { due_on: '2026-10-05' }, actorUserId: null, sessionId: 's_new' }],
      [{ targetId: 't_yesterday', kind: 'ended_on_date', before: null, after: { due_on: YESTERDAY }, actorUserId: null, sessionId: 's_new' }],
    ]);
    expect(retired).toEqual(['s_left']);
    expect(eventsOf(logger, 'target_ended')).toEqual([
      { event: 'target_ended', target_id: 't_older', how: 'on_date' },
      { event: 'target_ended', target_id: 't_yesterday', how: 'on_date' },
    ]);
    expect(eventsOf(logger, 'session_retired')).toEqual([{ event: 'session_retired', enrollment_id: E, session_id: 's_left', reason: 'target_ended' }]);
  });

  // Final review I1, ADR 0014 R4. A target that ended on its date leaves its path closed: a
  // session started there could never be resumed or skipped, its words answered and met
  // "today" every day. The main path's stock that records the end skips it, its answers counted
  // once as a skip's. Re-review N2: with two targets ended at once, every one's stock is retired
  // and started session's row changed before the progress lock is first taken, then each skipped
  // session's progress is recorded. Correction (ruling I1-c): the skip counts for the learner day
  // of the session's last answer, today when it has none.
  it.each([
    ['the stock job', (service: SessionService) => service.stockSession({ enrollment_id: E, reason: 'complete' })],
    ['create', (service: SessionService) => service.createNextSession('u1', E, NO_DEVICES)],
  ])("%s skips the started sessions of the targets whose date has passed, every row before the progress lock", async (_, run) => {
    const calls: string[] = [];
    const ended = (id: string) => ({ ...target(id, YESTERDAY, []), glossIds: undefined });
    const targets = createFakeTargetRepo({ listEndedUnrecorded: async () => [ended('t_one'), ended('t_two')] });
    const { service, logger } = world(
      {
        ...nothingOpen,
        findOpen: async (_enrollmentId, path) =>
          path === 't_one'
            ? { started: { ...summary('s_one', 'ready'), answered: 4 }, stock: summary('s_stock', 'ready') }
            : path === 't_two'
              ? { started: { ...summary('s_two', 'ready'), answered: 0 } }
              : {},
        // s_one was last answered on its target's date, two days ago in UTC; s_two never.
        findLastAnswerAt: async (sessionId) => (sessionId === 's_one' ? new Date('2026-10-10T21:30:00Z') : null),
        retireStock: async (sessionId) => {
          calls.push(`retireStock ${sessionId}`);
          return true;
        },
        transition: async (sessionId, from, to, day) => {
          calls.push(`transition ${sessionId} ${from.join('|')} ${to} ${day}`);
          return true;
        },
        resolvePendingRetry: async (sessionId) => {
          calls.push(`resolvePendingRetry ${sessionId}`);
        },
      },
      {
        target: targets,
        progress: stub<ProgressRepo>({
          findRows: async () => [],
          lockEnrollment: async () => {
            calls.push('lockEnrollment');
          },
          lockSessionGlosses: async () => {},
          findSessionEvidence: async (sessionId) => {
            calls.push(`findSessionEvidence ${sessionId}`);
            return undefined;
          },
        }),
      },
    );
    await run(service);
    expect(calls).toEqual([
      'retireStock s_stock',
      'transition s_one preparing|ready skipped 2026-10-10',
      'resolvePendingRetry s_one',
      `transition s_two preparing|ready skipped ${TODAY}`,
      'resolvePendingRetry s_two',
      'lockEnrollment',
      'findSessionEvidence s_one',
      'lockEnrollment',
      'findSessionEvidence s_two',
    ]);
    expect(eventsOf(logger, 'session_skipped')).toEqual([
      { event: 'session_skipped', session_id: 's_one', reason: 'target_ended' },
      { event: 'session_skipped', session_id: 's_two', reason: 'target_ended' },
    ]);
  });

  it('plays a stock chosen on an earlier day as it is (phase 43 R5), reading nothing and taking no lock', async () => {
    // The list is not even read: listSavedGlosses is not stubbed here, and the words due are
    // counted from memory alone. Nor is a lock taken: the home read of the main path stays a read.
    const { service, retired, locked } = world(stockChosenOn(YESTERDAY), {
      target: createFakeTargetRepo({ listActive: async () => [target('t_exam', '2026-10-13', ['g_b'])] }),
      vocabulary: stub<VocabularyRepo>({ countEntries: async () => SAVED.length, countNeverMet: async () => 1 }),
    });
    expect((await service.currentSession('u1', E)).current?.id).toBe('s_stock');
    expect(retired).toEqual([]);
    expect(locked).toEqual([]);
  });
});

describe("a target's path (spec D1, D2, D10)", () => {
  const ownState = { id: 's1', userId: 'u1', enrollmentId: E, status: 'ready' as const, source: 'list' as const, targetId: 't_exam' };

  /** Today's budget for t_exam, set already. */
  const SET = { targetId: 't_exam', day: TODAY, sessions: 4, cards: 30, missRoom: 1, doneBefore: 0 };

  it("starts a target's session and asks for that path's next stock only, under its own key", async () => {
    const { service, jobs } = world(
      { findEnrollmentId: async () => E, findState: async () => ownState, markStarted: async () => true },
      { targetBudgets: stub<TargetBudgetRepo>({ find: async () => SET }) },
    );
    await service.startSession('u1', 's1', { listening: true, speaking: false });
    expect(jobs.enqueued).toEqual([
      {
        name: STOCK_SESSION,
        data: { enrollment_id: E, reason: 'start', listening: true, speaking: false, target_id: 't_exam' },
        options: { singletonKey: `${E}:t_exam` },
      },
    ]);
  });

  // Phase 65 (spec D7.1, D7.2). The path's first session of the learner day sets today's budget,
  // in the transaction that starts it and before its next stock is asked for; a later one leaves
  // it as it is.
  describe("today's budget (phase 65, spec D7)", () => {
    /** Three days left. g_b, started a week ago, reads below 90 (no readiness yet). The device
     *  cannot listen, so its writing card asks spelling too: today it owes one card, one session
     *  (phase 67, spec D2). */
    const exam = target('t_exam', '2026-10-15', ['g_b']);

    function budgetWorld(found: typeof SET | undefined, done = 0) {
      const inserted: unknown[] = [];
      const asked: unknown[][] = [];
      const counted: unknown[][] = [];
      let enqueuedAtInsert: number | null = null;
      const made = world(
        {
          findEnrollmentId: async () => E,
          findState: async () => ownState,
          markStarted: async () => true,
          findOpen: async () => ({ started: summary('s1', 'ready') }),
          findSessionCards: async () => [],
          findRecentAnswers: async (...args) => {
            asked.push(args);
            return [];
          },
          countCompletedOn: async (...args) => {
            counted.push(args);
            return done;
          },
        },
        {
          target: createFakeTargetRepo({
            findTarget: async () => exam,
            listWords: async () => [{ glossId: 'g_b', addedAt: exam.createdAt, startedOn: '2026-10-05' }],
          }),
          targetBudgets: stub<TargetBudgetRepo>({
            find: async () => found,
            insert: async (budget) => {
              inserted.push(budget);
              enqueuedAtInsert = made.jobs.enqueued.length;
            },
          }),
        },
      );
      return { ...made, inserted, asked, counted, enqueuedAtInsert: () => enqueuedAtInsert };
    }

    it.each([
      ['no session done today: the play itself, no room for misses', 0, 1],
      // Coordinator's ruling on Review Focus 4: a session started yesterday and ended today is one
      // of today's sessions done, so the promise counts it too.
      ['a session of the path already completed today, started yesterday', 1, 2],
    ])('is set at the first session, from the picker played forward: %s', async (_, doneBefore, sessions) => {
      const { service, inserted, asked, counted, enqueuedAtInsert, jobs } = budgetWorld(undefined, doneBefore);
      await service.startSession('u1', 's1', NO_DEVICES);
      expect(inserted).toEqual([{ targetId: 't_exam', day: TODAY, sessions, cards: 1, missRoom: 0, doneBefore }]);
      // Phase 67 (spec D5): no miss rate is read; the sessions done, the path's completed today.
      expect(asked).toEqual([]);
      expect(counted).toEqual([[E, 't_exam', TODAY]]);
      // Written before the next stock is asked for.
      expect(enqueuedAtInsert()).toBe(0);
      expect(jobs.enqueued).toHaveLength(1);
    });

    it('is left as it is by a later session the same day, which reads nothing to remake it', async () => {
      // The target repo's findTarget and listWords are not stubbed: remaking the budget would throw.
      const inserted: unknown[] = [];
      const { service, jobs } = world(
        { findEnrollmentId: async () => E, findState: async () => ownState, markStarted: async () => true },
        { targetBudgets: stub<TargetBudgetRepo>({ find: async () => SET, insert: async (budget) => void inserted.push(budget) }) },
      );
      await service.startSession('u1', 's1', NO_DEVICES);
      expect(inserted).toEqual([]);
      expect(jobs.enqueued).toHaveLength(1);
    });

    it('is not looked for when the session was started already', async () => {
      // targetBudgets is not given: a read of it would throw.
      const { service, jobs } = world({ findEnrollmentId: async () => E, findState: async () => ownState, markStarted: async () => false });
      await service.startSession('u1', 's1', NO_DEVICES);
      expect(jobs.enqueued).toEqual([]);
    });
  });

  it.each([
    ['ended early', target('t_exam', '2026-10-13', ['g_b'], new Date('2026-10-11T09:00:00Z'))],
    ['past its date', target('t_exam', YESTERDAY, ['g_b'])],
  ])('builds no stock for a target %s', async (_, found) => {
    const { service, jobs, logger, locked } = world(nothingOpen, { target: createFakeTargetRepo({ findTarget: async () => found }) });
    await service.stockSession({ enrollment_id: E, reason: 'target', target_id: 't_exam' });
    expect(jobs.enqueued).toEqual([]);
    expect(locked).toEqual([E]);
    expect(eventsOf(logger, 'session_stock_skipped')).toEqual([
      { event: 'session_stock_skipped', enrollment_id: E, reason: 'target', why: 'target_closed', target_id: 't_exam' },
    ]);
  });

  it('refuses a create for a target past its date', async () => {
    const { service, locked } = world(nothingOpen, { target: createFakeTargetRepo({ findTarget: async () => target('t_exam', YESTERDAY, ['g_b']) }) });
    await expect(service.createNextSession('u1', E, NO_DEVICES, 't_exam')).rejects.toBeInstanceOf(TargetClosed);
    expect(locked).toEqual([]);
  });
});

// Phase 53 (spec D12, ruling R-D12), per path since phase 57 (spec D2, final review C1). A target
// path's stock is checked where home learns of it, the home read and create: one chosen on an
// earlier learner day, and one chosen as practice more on any day (a miss in the session it was
// chosen beside can leave work owed that it does not serve). It is replaced, for the devices it
// was built for, when today's choice of its target differs in the cap or the owed words it
// recorded; never at start, never while its path has a session started.
describe("a target's stock, checked (spec D2, ruling R-D12, final review C1)", () => {
  /** Five days left on TODAY: the cap is 7 half-points. Made on 2026-10-01 with both words, so
   *  past its halfway point: both are owed a start today (spec D6). */
  const exam = target('t_exam', '2026-10-17', ['g_a', 'g_b']);
  /** What today's choice of the exam is, with nothing started. */
  const OWED_TODAY = { capHalves: 7, owedGlossIds: ['g_a', 'g_b'] };
  /** A practice-more stock's record: nothing owed. */
  const PRACTICE_MORE = { capHalves: 7, owedGlossIds: [] };
  const STOCK_DEVICES = { listening: true, speaking: false };

  /** Both words, started two days ago, ready at the start of today (phase 67, spec D1): no card
   *  is owed before the eve, so today's choice is practice more. */
  const allReady = stub<TargetReadinessRepo>({
    findRows: async () => [],
    findFirstEventsOn: async () =>
      exam.glossIds.flatMap((glossId) => (['written_productive', 'spelling'] as const).map((dimension) => ({ glossId, dimension, before: 0.97 }))),
  });

  /** A learner whose exam's stock s_stock recorded `recorded`; `paths` are the next-session locks
   *  taken, by path. */
  function examWorld(
    session: Partial<SessionRepo>,
    recorded: { capHalves: number; owedGlossIds: string[] } | undefined,
    extra: Partial<Repos> & { startedOn?: string | null } = {},
  ) {
    const { startedOn = null, ...repos } = extra;
    const paths: string[] = [];
    const targets = createFakeTargetRepo({
      findTarget: async () => exam,
      listWordIds: async () => [...exam.glossIds],
      listWords: async () => exam.glossIds.map((glossId) => ({ glossId, addedAt: exam.createdAt, startedOn })),
      findSessionTarget: async (sessionId) => (sessionId === 's_stock' && recorded ? { ...recorded, pastBudget: false, stepDowns: [] } : undefined),
    });
    const made = world(
      {
        lockNextSession: async (_enrollmentId, path) => {
          paths.push(path ?? 'main');
        },
        ...session,
      },
      {
        target: targets,
        targetSkills: stub<TargetSkillRepo>({ findRows: async () => [] }),
        // Phase 65b (spec D2): no budget set today, so an owed day is not past it.
        targetBudgets: stub<TargetBudgetRepo>({ find: async () => undefined }),
        vocabulary: stub<VocabularyRepo>({
          listSavedGlosses: async () => SAVED,
          countEntries: async () => SAVED.length,
          findSavedWords: async ({ glossIds }) =>
            SAVED.filter((gloss) => glossIds.includes(gloss.glossId)).map(({ glossId, key, form }) => ({ glossId, key, form })),
        }),
        ...repos,
      },
    );
    return { ...made, targets, paths };
  }

  it('is replaced on the home read when it was chosen today as practice more and today owes work (final review C1)', async () => {
    const { service, logger, inserted, retired, paths, targets } = examWorld(stockChosenOn(TODAY), PRACTICE_MORE);
    expect((await service.currentSession('u1', E, 't_exam')).current).toEqual({
      id: 's_new',
      status: 'preparing',
      source: 'list',
      answered: 0,
      total: 0,
      started: false,
    });
    expect(paths).toEqual(['t_exam']);
    expect(retired).toEqual(['s_stock']);
    expect(inserted).toEqual([['u1', E, STOCK_DEVICES, TODAY, 't_exam', NOTHING_HELD]]);
    expect(writes(targets, 'insertSessionTarget')).toEqual([['s_new', expect.objectContaining({ targetId: 't_exam', ...OWED_TODAY })]]);
    expect(eventsOf(logger, 'session_retired')).toEqual([{ event: 'session_retired', enrollment_id: E, session_id: 's_stock', reason: 'stale_target' }]);
    expect(eventsOf(logger, 'session_stocked')).toEqual([
      { event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'stale_target', target_id: 't_exam', ...NOTHING_HELD_LOG },
    ]);
  });

  it('is replaced by create too, before it is answered (final review C1)', async () => {
    const { service, retired, inserted, paths } = examWorld(stockChosenOn(TODAY), PRACTICE_MORE);
    expect(await service.createNextSession('u1', E, NO_DEVICES, 't_exam')).toEqual({
      sessionId: 's_new',
      status: 'preparing',
      source: 'list',
      created: true,
    });
    expect(paths).toEqual(['t_exam']);
    expect(retired).toEqual(['s_stock']);
    // Built for the devices the stock was built for, not the ones create names.
    expect(inserted).toEqual([['u1', E, STOCK_DEVICES, TODAY, 't_exam', NOTHING_HELD]]);
  });

  it('keeps a practice-more stock chosen today while practice more is still the choice: no churn', async () => {
    // Phase 67b fix: a ready stock whose card can still raise the card (g_a has no answer today).
    const ready: Partial<SessionRepo> = {
      ...stockChosenOn(TODAY),
      findSessionCards: async () => [{ glossId: 'g_a', type: 'typed_translation', intro: false, answered: false }],
    };
    const { service, retired, inserted, paths } = examWorld(ready, PRACTICE_MORE, {
      startedOn: '2026-10-10',
      targetReadiness: allReady,
    });
    expect((await service.currentSession('u1', E, 't_exam')).current?.id).toBe('s_stock');
    expect(await service.createNextSession('u1', E, NO_DEVICES, 't_exam')).toEqual({
      sessionId: 's_stock',
      status: 'ready',
      source: 'list',
      created: false,
    });
    expect(paths).toEqual(['t_exam', 't_exam']);
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
  });

  /** Phase 67b fix (Victor's test, 2026-10-21). Both words ready at the start of today, so the
   *  choice is practice more; since then g_a has had both skills answered today and g_b only its
   *  writing: g_b's spelling, its weakest, is the one card that can still raise the card. */
  const answered = (day: string) => ({
    state: { stability: 3, difficulty: 5, lastDay: day, reps: 1, lapses: 0, params: FSRS6_DEFAULT.id },
    day,
    missedToday: false,
    bonusUsed: 0,
    held: false,
  });
  const lateInTheDay = stub<TargetReadinessRepo>({
    findRows: async () => [
      { targetId: 't_exam', glossId: 'g_a', dimension: 'written_productive', row: answered(TODAY), sessionId: null },
      { targetId: 't_exam', glossId: 'g_a', dimension: 'spelling', row: answered(TODAY), sessionId: null },
      { targetId: 't_exam', glossId: 'g_b', dimension: 'written_productive', row: answered(TODAY), sessionId: null },
    ],
    findFirstEventsOn: allReady.findFirstEventsOn,
  });
  const stockOf = (cards: { glossId: string; type: QuestionType; intro: boolean }[]): Partial<SessionRepo> => ({
    ...stockChosenOn(TODAY),
    findSessionCards: async (sessionId) => (sessionId === 's_stock' ? cards.map((card) => ({ ...card, answered: false })) : []),
  });

  it("replaces a practice-more stock that cannot raise the card when today's choice can (phase 67b, Victor's test)", async () => {
    // Chosen while g_b was being met in the session in flight: it asks only g_a again.
    const { service, retired, inserted } = examWorld(stockOf([{ glossId: 'g_a', type: 'typed_translation', intro: false }]), PRACTICE_MORE, {
      startedOn: '2026-10-10',
      targetReadiness: lateInTheDay,
    });
    expect(await service.createNextSession('u1', E, NO_DEVICES, 't_exam')).toMatchObject({ sessionId: 's_new', created: true });
    expect(retired).toEqual(['s_stock']);
    expect(inserted).toHaveLength(1);
  });

  it('keeps a practice-more stock that can still raise the card: no churn', async () => {
    const { service, retired } = examWorld(stockOf([{ glossId: 'g_b', type: 'dictation', intro: false }]), PRACTICE_MORE, {
      startedOn: '2026-10-10',
      targetReadiness: lateInTheDay,
    });
    expect(await service.createNextSession('u1', E, NO_DEVICES, 't_exam')).toMatchObject({ sessionId: 's_stock', created: false });
    expect(retired).toEqual([]);
  });

  it("is replaced on the home read when it was chosen on an earlier day and today's cap is another", async () => {
    const { service, retired, inserted, paths } = examWorld(stockChosenOn(YESTERDAY), { ...OWED_TODAY, capHalves: 6 });
    expect((await service.currentSession('u1', E, 't_exam')).current?.id).toBe('s_new');
    expect(paths).toEqual(['t_exam']);
    expect(retired).toEqual(['s_stock']);
    expect(inserted).toEqual([['u1', E, STOCK_DEVICES, TODAY, 't_exam', NOTHING_HELD]]);
  });

  it('is played as it is when it was chosen on an earlier day with the cap and owed words of today (phase 43 R5)', async () => {
    const { service, retired, inserted, paths } = examWorld(stockChosenOn(YESTERDAY), OWED_TODAY);
    expect((await service.currentSession('u1', E, 't_exam')).current?.id).toBe('s_stock');
    expect(await service.createNextSession('u1', E, NO_DEVICES, 't_exam')).toMatchObject({ sessionId: 's_stock', created: false });
    expect(paths).toEqual(['t_exam', 't_exam']);
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
  });

  // Every stock here would be replaced if checked: only the case named keeps it unchecked.
  it.each<[string, Partial<SessionRepo>, { capHalves: number; owedGlossIds: string[] } | undefined, string]>([
    ['it was chosen today for owed work', stockChosenOn(TODAY), { ...OWED_TODAY, owedGlossIds: ['g_a'] }, 's_stock'],
    [
      'a session is started on its path: home shows it, and the stock beside it waits',
      { ...stockChosenOn(YESTERDAY), findOpen: async () => ({ started: summary('s_started', 'ready'), stock: summary('s_stock', 'ready') }) },
      PRACTICE_MORE,
      's_started',
    ],
    ['it is the seed', { ...stockChosenOn(YESTERDAY), findOpen: async () => ({ stock: summary('s_stock', 'ready', 'seed') }) }, PRACTICE_MORE, 's_stock'],
    ['its day was not recorded', stockChosenOn(null), PRACTICE_MORE, 's_stock'],
  ])('is never checked when %s: no lock, nothing replaced', async (_, session, recorded, current) => {
    const { service, retired, inserted, paths } = examWorld(session, recorded);
    expect((await service.currentSession('u1', E, 't_exam')).current?.id).toBe(current);
    expect(paths).toEqual([]);
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("reads the stock's choice and its record once on the home read: under the lock, the same stock's are not read again", async () => {
    const asked: string[] = [];
    const { service, targets } = examWorld(
      {
        ...stockChosenOn(TODAY),
        findStockChoice: async (sessionId) => {
          asked.push(`findStockChoice ${sessionId}`);
          return { chosenOn: TODAY, listening: true, speaking: false };
        },
      },
      PRACTICE_MORE,
    );
    const findSessionTarget = targets.findSessionTarget;
    targets.findSessionTarget = async (sessionId, targetId) => {
      asked.push(`findSessionTarget ${sessionId}`);
      return findSessionTarget(sessionId, targetId);
    };
    expect((await service.currentSession('u1', E, 't_exam')).current?.id).toBe('s_new');
    expect(asked).toEqual(['findStockChoice s_stock', 'findSessionTarget s_stock']);
  });

  it('is played as it is when its replacement cannot be built: no word chosen today has a rendering', async () => {
    const dict = stub<DictRepo>({ findLexemeForms: async () => [], findGlossRenderings: async () => [] });
    const { service, logger, retired, inserted, paths } = examWorld(stockChosenOn(TODAY), PRACTICE_MORE, { dict });
    expect((await service.currentSession('u1', E, 't_exam')).current?.id).toBe('s_stock');
    expect(paths).toEqual(['t_exam']);
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
    expect(eventsOf(logger, 'session_retired')).toEqual([]);
  });

  it('builds nothing when a start took the stock first', async () => {
    const { service, logger, retired, inserted } = examWorld({ ...stockChosenOn(TODAY), retireStock: async () => false }, PRACTICE_MORE);
    await service.currentSession('u1', E, 't_exam');
    await expect(service.createNextSession('u1', E, NO_DEVICES, 't_exam')).resolves.toMatchObject({ sessionId: 's_stock', created: false });
    expect(retired).toEqual([]);
    expect(inserted).toEqual([]);
    expect(eventsOf(logger, 'session_retired')).toEqual([]);
  });
});

// Phase 57 (spec D2, D7, D8; rulings T3-j, T3-m, T3-n). What a target path's choice reads beside
// the session in flight on its path, as the stock job builds it: the in-flight cards it credits
// (a ladder's intro stage graded nothing), practice more when they cover every owed word, and the
// day's room for new words, less every path's first meetings today and the in-flight session's.
describe("a target path's choice beside its session in flight (rulings T3-j, T3-m, T3-n)", () => {
  const G_C = { ...SAVED[1], glossId: 'g_c', key: 'סוס', variantId: 'v_c', lexemeId: 'l_c', lemma: 'horse', form: 'horse' };
  const ALL = [...SAVED, G_C];

  /** A learner with no device (live: the written three) whose target `found` holds `words`, each
   *  started on its day or not; `starts` each word's chance at the start of today in both its
   *  counted skills (phase 67, spec D1; none: 0); `cards` the cards of the session started on
   *  its path; `introduced` every path's first meetings today. */
  function pathWorld(input: {
    found: ReturnType<typeof target>;
    words: Record<string, string | null>;
    starts?: Record<string, number>;
    cards: { glossId: string; type: QuestionType; intro: boolean }[];
    introduced?: string[];
    /** Phase 65b (spec D2): today's budget, if set, and the path's sessions completed today. */
    budget?: number;
    done?: number;
  }) {
    const targets = createFakeTargetRepo({
      findTarget: async () => input.found,
      listWords: async () => Object.entries(input.words).map(([glossId, startedOn]) => ({ glossId, addedAt: input.found.createdAt, startedOn })),
    });
    const made = world(
      {
        ...nothingOpen,
        findOpen: async () => ({ started: summary('s_started', 'ready') }),
        findSessionCards: async (sessionId) => (sessionId === 's_started' ? input.cards.map((card) => ({ ...card, answered: false })) : []),
        findIntroducedOn: async () => input.introduced ?? [],
        countCompletedOn: async () => input.done ?? 0,
      },
      {
        target: targets,
        targetBudgets: stub<TargetBudgetRepo>({
          find: async (targetId, day) =>
            input.budget === undefined ? undefined : { targetId, day, sessions: input.budget, cards: 0, missRoom: 0, doneBefore: 0 },
        }),
        targetReadiness: stub<TargetReadinessRepo>({
          findRows: async () => [],
          findFirstEventsOn: async () =>
            Object.entries(input.starts ?? {}).flatMap(([glossId, before]) =>
              (['written_productive', 'spelling'] as const).map((dimension) => ({ glossId, dimension, before })),
            ),
        }),
        vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => ALL, countEntries: async () => ALL.length }),
        dict: stub<DictRepo>({
          findLexemeForms: async () => [],
          findGlossRenderings: async () =>
            ALL.map((gloss, i) => ({ glossId: gloss.glossId, senseId: `s${i}`, variantId: gloss.variantId, form: gloss.form, gloss: gloss.key, rank: 0 })),
        }),
      },
    );
    return { ...made, targets };
  }
  const picksOf = (jobs: FakeJobRepo) =>
    (jobs.enqueued.find((job) => job.name === PREPARE_SESSION)?.data as { picks: { gloss_id: string; ladder: boolean; dimension: string }[] }).picks.map(
      (pick) => [pick.gloss_id, pick.ladder ? 'ladder' : pick.dimension],
    );
  const build = (service: SessionService, targetId: string) => service.stockSession({ enrollment_id: E, reason: 'start', target_id: targetId });

  it("credits none of a ladder's intro stage (ruling T3-j): a word met there is still owed its start", async () => {
    // Five days left, past the halfway point: both words owed a start today.
    const { service, jobs } = pathWorld({
      found: target('t_exam', '2026-10-17', ['g_a', 'g_b']),
      words: { g_a: null, g_b: null },
      cards: [
        { glossId: 'g_a', type: 'meet', intro: true },
        { glossId: 'g_a', type: 'letter_tiles', intro: true },
      ],
    });
    await build(service, 't_exam');
    expect(picksOf(jobs)).toEqual([
      ['g_a', 'ladder'],
      ['g_b', 'ladder'],
    ]);
  });

  it('chooses practice more, recording no owed word, when the session in flight covers every owed word (ruling T3-m)', async () => {
    // Both words started yesterday, below 90. The device cannot listen, so each owes one card today,
    // its writing card, which asks spelling too: a typed translation of each in flight covers them.
    const { service, jobs, targets, logger } = pathWorld({
      found: target('t_exam', '2026-10-17', ['g_a', 'g_b']),
      words: { g_a: YESTERDAY, g_b: YESTERDAY },
      starts: { g_a: 0.5, g_b: 0.5 },
      cards: [
        { glossId: 'g_a', type: 'typed_translation', intro: false },
        { glossId: 'g_b', type: 'typed_translation', intro: false },
      ],
    });
    await build(service, 't_exam');
    expect(writes(targets, 'insertSessionTarget')).toEqual([['s_new', expect.objectContaining({ capHalves: 7, owedGlossIds: [] })]]);
    // The hardest cards: one card per word on its weakest counted skill.
    expect(picksOf(jobs)).toEqual([
      ['g_a', 'written_productive'],
      ['g_b', 'written_productive'],
    ]);
    expect(eventsOf(logger, 'session_stocked')).toHaveLength(1);
  });

  it('fills a session past the budget with practice more after the owed work (phase 65b D2)', async () => {
    // Both words started yesterday, below 90, each owing its writing card (the device cannot listen).
    // The session in flight asks g_b's; g_a still owes its own. The budget is 2, one session is
    // done, one in flight.
    const world = (done: number) =>
      pathWorld({
        found: target('t_exam', '2026-10-17', ['g_a', 'g_b']),
        words: { g_a: YESTERDAY, g_b: YESTERDAY },
        starts: { g_a: 0.5, g_b: 0.5 },
        cards: [{ glossId: 'g_b', type: 'typed_translation', intro: false }],
        budget: 2,
        done,
      });
    const before = world(0);
    await build(before.service, 't_exam');
    // Before the budget: owed work only, g_a's card.
    expect(picksOf(before.jobs)).toEqual([['g_a', 'written_productive']]);

    const past = world(1);
    await build(past.service, 't_exam');
    // Past it: g_a's owed card first, then practice more's card for g_b.
    expect(picksOf(past.jobs)[0]).toEqual(picksOf(before.jobs)[0]);
    expect(picksOf(past.jobs).slice(1)).toEqual([['g_b', 'written_productive']]);
    // The stock records the day's owed words, as an owed stock does, for its stale check.
    const owedOf = (made: ReturnType<typeof world>) => (writes(made.targets, 'insertSessionTarget')[0][1] as { owedGlossIds: string[] }).owedGlossIds;
    expect(owedOf(past)).toEqual(owedOf(before));
    expect(owedOf(past)).toEqual(['g_a', 'g_b']);
  });

  it('fills every session on the eve with practice more after the owed work, no budget set (phase 71, spec D2)', async () => {
    // As above, the date tomorrow: g_a owes its writing card, g_b's is in flight, and no budget is set.
    const { service, jobs, targets } = pathWorld({
      found: target('t_exam', '2026-10-13', ['g_a', 'g_b']),
      words: { g_a: YESTERDAY, g_b: YESTERDAY },
      starts: { g_a: 0.5, g_b: 0.5 },
      cards: [{ glossId: 'g_b', type: 'typed_translation', intro: false }],
    });
    await build(service, 't_exam');
    // g_a's owed card first, then practice more past it, g_b's.
    expect(picksOf(jobs)[0]).toEqual(['g_a', 'written_productive']);
    expect(picksOf(jobs).length).toBeGreaterThan(1);
    expect(writes(targets, 'insertSessionTarget')).toEqual([['s_new', expect.objectContaining({ daysLeft: 1, pastBudget: true, owedGlossIds: ['g_a', 'g_b'] })]]);
  });

  it("leaves practice more only the day's room for new words, less the in-flight session's first meetings (ruling T3-n)", async () => {
    // Forty days left, made today: one word of three planned today (g_a, started and ready, so
    // the day is done) and two later. Fourteen first meetings today, g_a's among them, and the
    // in-flight session meets g_b early: the day's fifteenth. g_c waits for tomorrow.
    const { service, jobs } = pathWorld({
      found: { ...target('t_exam', '2026-11-21', ['g_a', 'g_b', 'g_c']), createdAt: new Date('2026-10-12T09:00:00Z') },
      words: { g_a: TODAY, g_b: null, g_c: null },
      starts: { g_a: 0.97 },
      cards: [
        { glossId: 'g_b', type: 'meet', intro: true },
        { glossId: 'g_b', type: 'multiple_choice', intro: false },
        { glossId: 'g_b', type: 'typed_translation', intro: false },
      ],
      introduced: ['g_a', ...Array.from({ length: 13 }, (_, i) => `x${i}`)],
    });
    await build(service, 't_exam');
    expect(picksOf(jobs)).toEqual([['g_a', 'written_productive']]);
  });
});
