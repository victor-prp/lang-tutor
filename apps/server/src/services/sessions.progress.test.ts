import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import { DIMENSIONS } from '@lang-tutor/core/domain';

import { createFakeLlmClient, createFakeLogger, createFakeTransaction, stub } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { ProgressRow, SnapshotRead } from '../domain/progress';
import type { SessionRecord, SessionState } from '../domain/session';
import type { ProgressRepo, SessionEvidence } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const DAY = '2026-10-05';
const question = (n: number): Question => ({
  id: `q${n}`,
  type: 'multiple_choice',
  vocab_term_id: `l${n}`,
  question: `word${n}`,
  options: [`right${n}`, 'a', 'b', 'c'],
  correct_option: 0,
});
const QUESTIONS = Array.from({ length: 10 }, (_, i) => question(i));
const answered = (count: number) =>
  QUESTIONS.slice(0, count).map((q) => ({ question_id: q.id, is_correct: true, answer_string: q.options[0] }));
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
const EVIDENCE: SessionEvidence = {
  enrollmentId: 'e1',
  day: DAY,
  lastAnsweredAt: '2026-10-05 12:00:00+00',
  answers: [
    { senseId: 's1', type: 'multiple_choice', correct: true },
    { senseId: 'sX', type: 'multiple_choice', correct: true },
  ],
};
const ROWS: ProgressRow[] = DIMENSIONS.map((dimension) => ({
  senseId: 's1',
  dimension,
  level: 1,
  lastStepOn: null,
  lastWrongOn: null,
}));
const SNAPSHOT: SnapshotRead[] = DIMENSIONS.map((dimension) => ({
  senseId: 's1',
  dimension,
  levelBefore: 1,
  levelAfter: dimension === 'written_receptive' ? 2 : 1,
  form: 'word0',
  translation: 'right0',
  position: 0,
}));
const CHANGE = [{ senseId: 's1', form: 'word0', translation: 'right0', levelBefore: 1, levelAfter: 2 }];

function world(opts: { record: SessionRecord; evidence?: SessionEvidence | null; rows?: ProgressRow[] }) {
  const calls = {
    completed: 0,
    evidence: 0,
    asked: [] as string[][],
    updated: [] as ProgressRow[][],
    snapshots: [] as unknown[][],
  };
  const session = stub<SessionRepo>({
    loadSession: async () => opts.record,
    insertAnswer: async () => {},
    completeSession: async () => {
      calls.completed += 1;
    },
    findState: async () => READY,
    transition: async () => true,
  });
  const progress = stub<ProgressRepo>({
    findSessionEvidence: async () => {
      calls.evidence += 1;
      return opts.evidence === null ? undefined : (opts.evidence ?? EVIDENCE);
    },
    findRows: async (input) => {
      calls.asked.push(input.senseIds);
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
  const service = createSessionService({
    transaction: createFakeTransaction({ session, progress }),
    rng: testRng(7),
    logger: createFakeLogger(),
    llm: createFakeLlmClient(''),
  });
  return { service, calls };
}

describe('progress when a session ends', () => {
  it('completing a session runs the rule over its answers and answers with the change', async () => {
    const { service, calls } = world({ record: record(9) });
    const result = await service.submitAnswer(SESSION, 'q9', 0);
    expect(calls.completed).toBe(1);
    expect(calls.asked).toEqual([['s1', 'sX']]);
    expect(calls.updated).toEqual([
      [{ senseId: 's1', dimension: 'written_receptive', level: 2, lastStepOn: DAY, lastWrongOn: null }],
    ]);
    expect(calls.snapshots[0]).toHaveLength(5);
    expect(result.progress).toEqual(CHANGE);
  });

  it('an answer that does not complete the session writes no progress', async () => {
    const { service, calls } = world({ record: record(8) });
    const result = await service.submitAnswer(SESSION, 'q8', 0);
    expect(calls.evidence).toBe(0);
    expect(result.progress).toEqual([]);
  });

  it('a replayed final answer writes nothing and still answers with the change', async () => {
    const { service, calls } = world({ record: record(10) });
    const result = await service.submitAnswer(SESSION, 'q9', 0);
    expect(calls.evidence).toBe(0);
    expect(result.progress).toEqual(CHANGE);
  });

  it('a skip runs the rule over the answers given so far', async () => {
    const { service, calls } = world({ record: record(3) });
    await service.skipSession(SESSION);
    expect(calls.evidence).toBe(1);
    expect(calls.updated).toHaveLength(1);
  });

  it('a skip with no answers writes nothing', async () => {
    const { service, calls } = world({ record: record(0), evidence: null });
    await service.skipSession(SESSION);
    expect(calls.asked).toEqual([]);
    expect(calls.updated).toEqual([]);
    expect(calls.snapshots).toEqual([]);
  });

  it('a session about senses that are not saved writes nothing', async () => {
    const { service, calls } = world({ record: record(9), rows: [] });
    await service.submitAnswer(SESSION, 'q9', 0);
    expect(calls.asked).toHaveLength(1);
    expect(calls.updated).toEqual([]);
    expect(calls.snapshots).toEqual([]);
  });

  it('getSession answers a completed session with its change, and any other with none', async () => {
    expect((await world({ record: record(10) }).service.getSession(SESSION)).progress).toEqual(CHANGE);
    expect((await world({ record: record(4) }).service.getSession(SESSION)).progress).toEqual([]);
  });
});
