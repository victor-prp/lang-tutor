import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Question } from '@lang-tutor/core/api';

import {
  createFakeClock,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  createFakeTranscriber,
  stub,
} from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { JUDGE_MARKER } from '../domain/judge';
import type { SessionRecord, SessionState } from '../domain/session';
import { AnswerKindMismatch, LlmUnavailable, QuestionDesynced, SessionNotFound } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { ProgressRepo } from '../repo/progress';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const STATE: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'ready', source: 'list' };
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'it', created_at: '' };
const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין' };
const CHOICE: Question = { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 };
const CONTEXT = { form: 'prenotare', lemma: 'prenotare', partOfSpeech: 'verb', meaning: 'להזמין', example: 'Vorrei prenotare un tavolo.', exampleTranslation: 'הייתי רוצה להזמין שולחן.' };

const record = (questions: Question[] = [MEANING, CHOICE], answers: SessionRecord['answers'] = []): SessionRecord => ({
  user_id: 'u1',
  questions,
  answers,
  complete: false,
  completed_at: null,
  status: 'ready',
  source: 'list',
});

function setup(judge: ReturnType<typeof createFakeLlmClient>, loaded: SessionRecord = record()) {
  const inserted: unknown[] = [];
  const logger = createFakeLogger();
  const session = stub<SessionRepo>({
    loadSession: async () => loaded,
    findState: async () => STATE,
    insertAnswer: async (...args) => {
      inserted.push(args);
    },
  });
  const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
  const question = stub<QuestionRepo>({ findJudgeContext: async () => CONTEXT });
  const progress = stub<ProgressRepo>({ findSnapshot: async () => [] });
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment, question, progress }),
    rng: testRng(7),
    now: createFakeClock(1_000, 1_400),
    logger,
    llm: createFakeLlmClient(''),
    transcriber: createFakeTranscriber(''),
    judge,
  });
  return { service, inserted, logger };
}

const answer = (text: string) => ({ userId: 'u1', questionId: 'm1', text });

describe('answerJudged (spec D3)', () => {
  it('rules an empty answer wrong, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted } = setup(judge);
    expect((await service.answerJudged(SESSION, answer('  '))).verdict).toBe('wrong');
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([[SESSION, 0, 'm1', { text: '  ', verdict: 'wrong' }]]);
  });

  it('rules the stored meaning exact, without a call, and logs it as a rule', async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    const { service, logger } = setup(judge);
    expect((await service.answerJudged(SESSION, answer('לְהַזְמִין.'))).verdict).toBe('exact');
    expect(judge.calls).toHaveLength(0);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'answer_judged', judged_by: 'rule', verdict: 'exact' }));
  });

  it('asks the model once otherwise, and records the mapped verdict', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted, logger } = setup(judge);
    const result = await service.answerJudged(SESSION, answer('לשריין'));
    expect(result.verdict).toBe('exact');
    expect(result.session.answers[0]).toMatchObject({ verdict: 'exact', is_correct: true, answer_string: 'לשריין' });
    expect(inserted).toEqual([[SESSION, 0, 'm1', { text: 'לשריין', verdict: 'exact' }]]);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].system).toContain(JUDGE_MARKER);
    expect(JSON.parse(judge.calls[0].user)).toMatchObject({ saved_meaning: 'להזמין', example: 'Vorrei prenotare un tavolo.', answer: 'לשריין' });
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'answer_judged', question_type: 'typed_meaning', verdict: 'exact', judged_by: 'model', judge_ms: 400 }),
    );
  });

  it('records another sense as an alternative', async () => {
    const { service } = setup(createFakeLlmClient('{"verdict":"other_sense"}'));
    expect((await service.answerJudged(SESSION, answer('ספר'))).verdict).toBe('alternative');
  });

  it('records nothing when the judge fails, and says why', async () => {
    const { service, inserted, logger } = setup(createFakeLlmClient(new LlmUnavailable('timed out after 8000ms')));
    await expect(service.answerJudged(SESSION, answer('לשריין'))).rejects.toBeInstanceOf(LlmUnavailable);
    expect(inserted).toEqual([]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'answer_judge_failed', question_type: 'typed_meaning' }));
  });

  it('treats an unreadable verdict as a failed judge', async () => {
    const { service, inserted } = setup(createFakeLlmClient('{"verdict":"maybe"}'));
    await expect(service.answerJudged(SESSION, answer('לשריין'))).rejects.toBeInstanceOf(LlmUnavailable);
    expect(inserted).toEqual([]);
  });

  it('replays a judged answer without a model call', async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    const answered = record([MEANING, CHOICE], [{ question_id: 'm1', is_correct: true, answer_string: 'לשריין', verdict: 'exact' }]);
    const { service, inserted } = setup(judge, answered);
    const result = await service.answerJudged(SESSION, answer('לשריין'));
    expect(result.verdict).toBe('exact');
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('reports the stored verdict when an overlapping request was recorded first', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const stored = record([MEANING, CHOICE], [{ question_id: 'm1', is_correct: false, answer_string: 'ספר', verdict: 'wrong' }]);
    let loads = 0;
    const session = stub<SessionRepo>({
      loadSession: async () => (++loads === 1 ? record() : stored),
      findState: async () => STATE,
      insertAnswer: async () => undefined,
    });
    const service = createSessionService({
      transaction: createFakeTransaction({
        session,
        enrollment: stub<EnrollmentRepo>({ findById: async () => ENROLLMENT }),
        question: stub<QuestionRepo>({ findJudgeContext: async () => CONTEXT }),
      }),
      rng: testRng(7),
      now: createFakeClock(1_000, 1_400),
      logger: createFakeLogger(),
      llm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge,
    });
    const result = await service.answerJudged(SESSION, answer('לשריין'));
    expect(judge.calls).toHaveLength(1);
    expect(result.verdict).toBe('wrong');
  });

  it('replays a completed session\'s last answer, and refuses any other card, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const done: SessionRecord = {
      ...record([CHOICE, MEANING], [{ question_id: 'm1', is_correct: true, answer_string: 'לשריין', verdict: 'exact' }]),
      complete: true,
      completed_at: 1_000,
      status: 'completed',
    };
    const { service, inserted } = setup(judge, done);
    expect((await service.answerJudged(SESSION, answer('לשריין'))).verdict).toBe('exact');
    await expect(service.answerJudged(SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('refuses before judging: another learner, a stale card, a card that is not judged', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    await expect(setup(judge).service.answerJudged(SESSION, { ...answer('x'), userId: 'u2' })).rejects.toBeInstanceOf(SessionNotFound);
    await expect(setup(judge).service.answerJudged(SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    const choiceFirst = record([CHOICE, MEANING]);
    await expect(setup(judge, choiceFirst).service.answerJudged(SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(AnswerKindMismatch);
    expect(judge.calls).toHaveLength(0);
  });
});
