import { describe, expect, it } from '@jest/globals';
import type { Enrollment, MultipleChoiceQuestion, TypedTranslationQuestion } from '@lang-tutor/core/api';
import { DIMENSIONS } from '@lang-tutor/core/domain';

import { createFakeClock, createFakeLlmClient, createFakeLogger, createFakeTransaction, createFakeTranscriber, stub } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { ProgressRow, SnapshotRead } from '../domain/progress';
import type { SessionRecord, SessionState } from '../domain/session';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { MemoryRow } from '../domain/memoryUpdate';
import type { MemoryRepo } from '../repo/memory';
import type { ProgressRepo, SessionEvidence } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import type { UserRepo } from '../repo/users';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const DAY = '2026-10-05';
const question = (n: number): MultipleChoiceQuestion => ({
  id: `q${n}`,
  type: 'multiple_choice',
  vocab_term_id: `l${n}`,
  question: `word${n}`,
  options: [`right${n}`, 'a', 'b', 'c'],
  correct_option: 0,
  context: null,
});
const QUESTIONS = Array.from({ length: 10 }, (_, i) => question(i));
const answered = (count: number) =>
  QUESTIONS.slice(0, count).map((q) => ({ question_id: q.id, is_correct: true, answer_string: q.options[0], retry_state: null, retry_answer_string: null, retry_verdict: null }));
const record = (count: number): SessionRecord => ({
  user_id: 'u1',
  questions: QUESTIONS,
  answers: answered(count),
  complete: count === QUESTIONS.length,
  completed_at: count === QUESTIONS.length ? 1 : null,
  status: count === QUESTIONS.length ? 'completed' : 'ready',
  source: 'list',
});
const READY: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'ready', source: 'list' };
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'en', created_at: '' };
const EVIDENCE: SessionEvidence = {
  enrollmentId: 'e1',
  day: DAY,
  lastAnsweredAt: '2026-10-05 12:00:00+00',
  answers: [
    { glossId: 's1', type: 'multiple_choice', correct: true },
    { glossId: 'sX', type: 'multiple_choice', correct: true },
  ],
};
const ROWS: ProgressRow[] = DIMENSIONS.map((dimension) => ({
  glossId: 's1',
  dimension,
  level: 1,
  lastStepOn: null,
  lastWrongOn: null,
}));
const SNAPSHOT: SnapshotRead[] = DIMENSIONS.map((dimension) => ({
  glossId: 's1',
  dimension,
  levelBefore: 1,
  levelAfter: dimension === 'written_receptive' ? 2 : 1,
  form: 'word0',
  translation: 'right0',
  position: 0,
}));
// Phase 23: written_receptive rose, and the badge over the three live written
// dimensions did not: (2, 1, 1) still reads 1.
const CHANGE = [
  { glossId: 's1', form: 'word0', translation: 'right0', levelBefore: 1, levelAfter: 1, raised: ['written_receptive'] },
];

function world(opts: { record: SessionRecord; evidence?: SessionEvidence | null; rows?: ProgressRow[] }) {
  const calls = {
    completed: 0,
    // Phase 35. The practice_day each ending wrote.
    endedOn: [] as string[],
    evidence: 0,
    asked: [] as string[][],
    updated: [] as ProgressRow[][],
    snapshots: [] as unknown[][],
    // Phase 35. The memory rows each ending upserted.
    memory: [] as MemoryRow[][],
    // Phase 31. The order of the share lock and the evidence read.
    steps: [] as string[],
  };
  const session = stub<SessionRepo>({
    loadSession: async () => opts.record,
    insertAnswer: async () => {},
    completeSession: async (_id, day) => {
      calls.completed += 1;
      calls.endedOn.push(day);
    },
    findState: async () => READY,
    transition: async (_id, _from, _to, day) => {
      if (day !== undefined) calls.endedOn.push(day);
      return true;
    },
    findEnrollmentId: async () => 'e1',
    // Phase 34 (spec D9).
    resolveRetry: async () => {
      calls.steps.push('resolve');
    },
    resolvePendingRetry: async () => {
      calls.steps.push('give up');
    },
  });
  const progress = stub<ProgressRepo>({
    lockSessionGlosses: async () => {
      calls.steps.push('lock');
    },
    findSessionEvidence: async () => {
      calls.steps.push('evidence');
      calls.evidence += 1;
      return opts.evidence === null ? undefined : (opts.evidence ?? EVIDENCE);
    },
    findRows: async (input) => {
      calls.asked.push(input.glossIds);
      return opts.rows ?? ROWS;
    },
    updateRows: async (input) => {
      calls.updated.push(input.rows);
    },
    insertSnapshot: async (input) => {
      calls.snapshots.push(input.rows);
    },
    findSnapshot: async () => SNAPSHOT,
  });
  const memory = stub<MemoryRepo>({
    findRows: async () => [],
    upsertRows: async (input) => {
      calls.memory.push(input.rows);
    },
  });
  const service = createSessionService({
    transaction: createFakeTransaction({
      session,
      progress,
      memory,
      user: stub<UserRepo>({ findDayContext: async () => ({ kind: 'learner' }) }),
      enrollment: stub<EnrollmentRepo>({ findById: async () => ENROLLMENT }),
    }),
    rng: testRng(7),
    logger: createFakeLogger(),
    now: createFakeClock(0),
    llm: createFakeLlmClient(''),
    contextLlm: createFakeLlmClient(''),
    checkerLlm: createFakeLlmClient(''),
    transcriber: createFakeTranscriber(''),
    judge: createFakeLlmClient(''),
  });
  return { service, calls };
}

describe('progress when a session ends', () => {
  it('completing a session runs the rule over its answers and answers with the change', async () => {
    const { service, calls } = world({ record: record(9) });
    const result = await service.submitAnswer('u1', SESSION, 'q9', { option_index: 0 });
    expect(calls.completed).toBe(1);
    expect(calls.endedOn).toEqual(['1970-01-01']);
    expect(calls.asked).toEqual([['s1', 'sX']]);
    expect(calls.updated).toEqual([
      [{ glossId: 's1', dimension: 'written_receptive', level: 2, lastStepOn: DAY, lastWrongOn: null }],
    ]);
    expect(calls.snapshots[0]).toHaveLength(5);
    // Phase 35. Memory for the saved gloss only: sX has no progress rows.
    expect(calls.memory).toHaveLength(1);
    expect(calls.memory[0].map((row) => [row.glossId, row.dimension, row.state.lastDay])).toEqual([
      ['s1', 'written_receptive', DAY],
    ]);
    expect(result.progress).toEqual(CHANGE);
  });

  // Phase 31 (spec D14). A merge of a practised gloss lands wholly before the
  // evidence is read or wholly after the progress is written.
  it('share-locks the practised glosses before it reads the evidence', async () => {
    const { service, calls } = world({ record: record(9) });
    await service.submitAnswer('u1', SESSION, 'q9', { option_index: 0 });
    expect(calls.steps).toEqual(['lock', 'evidence']);
  });

  it('an answer that does not complete the session writes no progress', async () => {
    const { service, calls } = world({ record: record(8) });
    const result = await service.submitAnswer('u1', SESSION, 'q8', { option_index: 0 });
    expect(calls.evidence).toBe(0);
    expect(result.progress).toEqual([]);
  });

  it('a replayed final answer writes nothing and still answers with the change', async () => {
    const { service, calls } = world({ record: record(10) });
    const result = await service.submitAnswer('u1', SESSION, 'q9', { option_index: 0 });
    expect(calls.evidence).toBe(0);
    expect(result.progress).toEqual(CHANGE);
  });

  it('a skip runs the rule over the answers given so far', async () => {
    const { service, calls } = world({ record: record(3) });
    await service.skipSession('u1', SESSION);
    expect(calls.evidence).toBe(1);
    expect(calls.updated).toHaveLength(1);
  });

  it('a skip with no answers writes nothing', async () => {
    const { service, calls } = world({ record: record(0), evidence: null });
    await service.skipSession('u1', SESSION);
    expect(calls.asked).toEqual([]);
    expect(calls.updated).toEqual([]);
    expect(calls.snapshots).toEqual([]);
  });

  it('a session about senses that are not saved writes nothing', async () => {
    const { service, calls } = world({ record: record(9), rows: [] });
    await service.submitAnswer('u1', SESSION, 'q9', { option_index: 0 });
    expect(calls.asked).toHaveLength(1);
    expect(calls.updated).toEqual([]);
    expect(calls.snapshots).toEqual([]);
  });

  it('getSession answers a completed session with its change, and any other with none', async () => {
    expect((await world({ record: record(10) }).service.getSession('u1', SESSION)).progress).toEqual(CHANGE);
    expect((await world({ record: record(4) }).service.getSession('u1', SESSION)).progress).toEqual([]);
  });
});

// Phase 34 (spec D9). Review Focus 2: a pending last card holds the session's
// end, and with it the progress, until its retry resolves; a skip gives the retry
// up and writes progress once.
describe('progress and the second try', () => {
  const TYPED: TypedTranslationQuestion = {
    id: 'q9',
    type: 'typed_translation',
    vocab_term_id: 'l9',
    question: 'פנס',
    part_of_speech: 'noun',
    answer: 'lantern',
    lemma: 'lantern',
    alternatives: ['lamp'],
    context: null,
  };
  const questions = [...QUESTIONS.slice(0, 9), TYPED];
  const nine = (): SessionRecord => ({ ...record(9), questions });
  const pendingLast = (): SessionRecord => ({
    ...nine(),
    answers: [
      ...answered(9),
      { question_id: 'q9', is_correct: true, answer_string: 'lamp', verdict: 'alternative', retry_state: 'pending', retry_answer_string: null, retry_verdict: null },
    ],
  });

  it('an alternative on the last card completes nothing and writes no progress', async () => {
    const { service, calls } = world({ record: nine() });
    const result = await service.submitAnswer('u1', SESSION, 'q9', { text: 'lamp' });
    expect(calls.completed).toBe(0);
    expect(calls.evidence).toBe(0);
    expect(result).toMatchObject({ complete: false, status: 'ready', progress: [] });
  });

  it('the first answer sent again on a pending last card writes nothing either', async () => {
    const { service, calls } = world({ record: pendingLast() });
    await service.submitAnswer('u1', SESSION, 'q9', { text: 'lamp' });
    expect(calls.completed).toBe(0);
    expect(calls.evidence).toBe(0);
  });

  it("the last card's retry completes the session and writes its progress, once", async () => {
    const { service, calls } = world({ record: pendingLast() });
    const result = await service.submitAnswer('u1', SESSION, 'q9', { text: 'lantern' }, { retry: true });
    expect(calls.completed).toBe(1);
    expect(calls.steps).toEqual(['resolve', 'lock', 'evidence']);
    expect(calls.snapshots).toHaveLength(1);
    expect(result).toMatchObject({ complete: true, status: 'completed' });
  });

  it('a skip gives a pending retry up before it reads the evidence, and writes progress once', async () => {
    const { service, calls } = world({ record: pendingLast() });
    await service.skipSession('u1', SESSION);
    expect(calls.steps).toEqual(['give up', 'lock', 'evidence']);
    expect(calls.updated).toHaveLength(1);
    expect(calls.snapshots).toHaveLength(1);
  });
});
