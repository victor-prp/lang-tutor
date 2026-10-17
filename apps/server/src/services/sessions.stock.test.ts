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
import type { QuestionType } from '@lang-tutor/core/domain';
import { NoSavedWords, SessionNotFound, SessionNotReady, SessionOpen, TargetClosed } from '../errors';
import type { DictRepo } from '../repo/dictionary';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GlossFamiliesRepo } from '../repo/glossFamilies';
import type { MemoryRepo } from '../repo/memory';
import type { ProgressRepo } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import type { TargetSkillRepo } from '../repo/targetSkills';
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
      vocabulary: stub<VocabularyRepo>({ listSavedGlosses: async () => SAVED, countEntries: async () => SAVED.length, markKnown: async () => {} }),
      memory: stub<MemoryRepo>({ findRows: async () => [], findEnrollmentRows: async () => [] }),
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
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY, null]]);
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
    expect(inserted).toEqual([['u1', E, { listening: false, speaking: true }, TODAY, null]]);
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
    expect(inserted).toEqual([['u1', E, { listening: true, speaking: false }, TODAY, null]]);
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
    expect(inserted).toEqual([['u1', E, NO_DEVICES, TODAY, null]]);
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
      vocabulary: stub<VocabularyRepo>({ countEntries: async () => SAVED.length }),
    });
    expect((await service.currentSession('u1', E)).current?.id).toBe('s_stock');
    expect(retired).toEqual([]);
    expect(locked).toEqual([]);
  });
});

describe("a target's path (spec D1, D2, D10)", () => {
  const ownState = { id: 's1', userId: 'u1', enrollmentId: E, status: 'ready' as const, source: 'list' as const, targetId: 't_exam' };

  it("starts a target's session and asks for that path's next stock only, under its own key", async () => {
    const { service, jobs } = world({ findEnrollmentId: async () => E, findState: async () => ownState, markStarted: async () => true });
    await service.startSession('u1', 's1', { listening: true, speaking: false });
    expect(jobs.enqueued).toEqual([
      {
        name: STOCK_SESSION,
        data: { enrollment_id: E, reason: 'start', listening: true, speaking: false, target_id: 't_exam' },
        options: { singletonKey: `${E}:t_exam` },
      },
    ]);
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

  /** Both words started two days ago, every skill at the cap: the day is done, so today's choice
   *  is practice more. */
  const atCap = stub<TargetSkillRepo>({
    findRows: async () =>
      exam.glossIds.flatMap((glossId) =>
        (['written_receptive', 'written_productive', 'spoken_receptive', 'spelling'] as const).map((dimension) => ({
          targetId: 't_exam',
          glossId,
          dimension,
          halves: 7,
          sessionId: null,
          day: '2026-10-10',
        })),
      ),
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
      findSessionTarget: async (sessionId) => (sessionId === 's_stock' ? recorded : undefined),
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
    expect(inserted).toEqual([['u1', E, STOCK_DEVICES, TODAY, 't_exam']]);
    expect(writes(targets, 'insertSessionTarget')).toEqual([['s_new', expect.objectContaining({ targetId: 't_exam', ...OWED_TODAY })]]);
    expect(eventsOf(logger, 'session_retired')).toEqual([{ event: 'session_retired', enrollment_id: E, session_id: 's_stock', reason: 'stale_target' }]);
    expect(eventsOf(logger, 'session_stocked')).toEqual([
      { event: 'session_stocked', enrollment_id: E, session_id: 's_new', reason: 'stale_target', target_id: 't_exam' },
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
    expect(inserted).toEqual([['u1', E, STOCK_DEVICES, TODAY, 't_exam']]);
  });

  it('keeps a practice-more stock chosen today while practice more is still the choice: no churn', async () => {
    const { service, retired, inserted, paths } = examWorld(stockChosenOn(TODAY), PRACTICE_MORE, {
      startedOn: '2026-10-10',
      targetSkills: atCap,
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

  it("is replaced on the home read when it was chosen on an earlier day and today's cap is another", async () => {
    const { service, retired, inserted, paths } = examWorld(stockChosenOn(YESTERDAY), { ...OWED_TODAY, capHalves: 6 });
    expect((await service.currentSession('u1', E, 't_exam')).current?.id).toBe('s_new');
    expect(paths).toEqual(['t_exam']);
    expect(retired).toEqual(['s_stock']);
    expect(inserted).toEqual([['u1', E, STOCK_DEVICES, TODAY, 't_exam']]);
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
  const LIVE = ['written_receptive', 'written_productive', 'spelling'] as const;

  /** A learner with no device (live: the written three) whose target `found` holds `words`, each
   *  started on its day or not; `skills` its values in half-points; `cards` the cards of the
   *  session started on its path; `introduced` every path's first meetings today. */
  function pathWorld(input: {
    found: ReturnType<typeof target>;
    words: Record<string, string | null>;
    skills?: Record<string, number>;
    cards: { glossId: string; type: QuestionType; intro: boolean }[];
    introduced?: string[];
  }) {
    const targets = createFakeTargetRepo({
      findTarget: async () => input.found,
      listWords: async () => Object.entries(input.words).map(([glossId, startedOn]) => ({ glossId, addedAt: input.found.createdAt, startedOn })),
    });
    const made = world(
      {
        ...nothingOpen,
        findOpen: async () => ({ started: summary('s_started', 'ready') }),
        findSessionCards: async (sessionId) => (sessionId === 's_started' ? input.cards : []),
        findIntroducedOn: async () => input.introduced ?? [],
      },
      {
        target: targets,
        targetSkills: stub<TargetSkillRepo>({
          findRows: async () =>
            Object.entries(input.skills ?? {}).flatMap(([glossId, halves]) =>
              LIVE.map((dimension) => ({ targetId: input.found.id, glossId, dimension, halves, sessionId: null, day: '2026-10-11' })),
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
    // Both words started yesterday at 4 of 7: below the cap, and owed their next-day checks. A
    // typed translation of each in flight takes every live skill to the cap and answers the checks.
    const { service, jobs, targets, logger } = pathWorld({
      found: target('t_exam', '2026-10-17', ['g_a', 'g_b']),
      words: { g_a: YESTERDAY, g_b: YESTERDAY },
      skills: { g_a: 4, g_b: 4 },
      cards: [
        { glossId: 'g_a', type: 'typed_translation', intro: false },
        { glossId: 'g_b', type: 'typed_translation', intro: false },
      ],
    });
    await build(service, 't_exam');
    expect(writes(targets, 'insertSessionTarget')).toEqual([['s_new', expect.objectContaining({ capHalves: 7, owedGlossIds: [] })]]);
    // The hardest cards: one rung-2 card per word in a productive skill.
    expect(picksOf(jobs)).toEqual([
      ['g_a', 'written_productive'],
      ['g_b', 'written_productive'],
    ]);
    expect(eventsOf(logger, 'session_stocked')).toHaveLength(1);
  });

  it("leaves practice more only the day's room for new words, less the in-flight session's first meetings (ruling T3-n)", async () => {
    // Forty days left, made today: one word of three planned today (g_a, started and at the far
    // cap, so the day is done) and two later. Fourteen first meetings today, g_a's among them,
    // and the in-flight session meets g_b early: the day's fifteenth. g_c waits for tomorrow.
    const { service, jobs } = pathWorld({
      found: { ...target('t_exam', '2026-11-21', ['g_a', 'g_b', 'g_c']), createdAt: new Date('2026-10-12T09:00:00Z') },
      words: { g_a: TODAY, g_b: null, g_c: null },
      skills: { g_a: 2 },
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
