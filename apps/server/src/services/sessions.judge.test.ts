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
import type { SessionRecord } from '../domain/session';
import { AccessDenied, AnswerKindMismatch, LlmUnavailable, QuestionDesynced, WrongScript } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GrantRepo } from '../repo/grants';
import type { ProgressRepo } from '../repo/progress';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'it', created_at: '' };
const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין', context: null };
const SENTENCE: Question = {
  id: 's1',
  type: 'sentence_translation',
  vocab_term_id: 'l1',
  question: 'אני רוצה להזמין שולחן.',
  meaning: 'להזמין',
  sentence: 'I want to book a table.',
  gap: { start: 10, end: 14 },
  answer: 'book',
  mark: null,
};
const CHOICE: Question = { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0, context: null };
const CONTEXT = {
  form: 'prenotare',
  lemma: 'prenotare',
  partOfSpeech: 'verb',
  meaning: 'להזמין',
  example: 'Vorrei prenotare un tavolo.',
  exampleTranslation: 'הייתי רוצה להזמין שולחן.',
  alternatives: [] as string[],
};

const record = (questions: Question[] = [MEANING, CHOICE], answers: SessionRecord['answers'] = []): SessionRecord => ({
  user_id: 'u1',
  questions,
  answers,
  complete: false,
  completed_at: null,
  status: 'ready',
  source: 'list',
});

function setup(judge: ReturnType<typeof createFakeLlmClient>, loaded: SessionRecord = record(), context: typeof CONTEXT = CONTEXT) {
  const inserted: unknown[] = [];
  const resolved: unknown[] = [];
  const logger = createFakeLogger();
  const session = stub<SessionRepo>({
    loadSession: async () => loaded,
    findEnrollmentId: async () => 'e1',
    insertAnswer: async (...args) => {
      inserted.push(args);
    },
    resolveRetry: async (...args) => {
      resolved.push(args);
    },
  });
  const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
  const question = stub<QuestionRepo>({ findJudgeContext: async () => context });
  const progress = stub<ProgressRepo>({ findSnapshot: async () => [] });
  // Phase 29: another learner holds no grant on the list.
  const grant = stub<GrantRepo>({ findGrantFor: async () => null });
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment, question, progress, grant }),
    rng: testRng(7),
    now: createFakeClock(1_000, 1_400),
    logger,
    llm: createFakeLlmClient(''),
    contextLlm: createFakeLlmClient(''),
    checkerLlm: createFakeLlmClient(''),
    transcriber: createFakeTranscriber(''),
    judge,
  });
  return { service, inserted, resolved, logger };
}

const answer = (text: string) => ({ questionId: 'm1', text });

// Phase 34 (spec D9). What every answer that opens no second try carries.
const NO_RETRY = { retry_state: null, retry_answer_string: null, retry_verdict: null };

describe('answerJudged (spec D3)', () => {
  it('rules an empty answer wrong, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted } = setup(judge);
    expect((await service.answerJudged('u1', SESSION, answer('  '))).verdict).toBe('wrong');
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([[SESSION, 0, 'm1', { text: '  ', verdict: 'wrong' }]]);
  });

  it('rules the stored meaning exact, without a call, and logs it as a rule', async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    const { service, logger } = setup(judge);
    expect((await service.answerJudged('u1', SESSION, answer('לְהַזְמִין.'))).verdict).toBe('exact');
    expect(judge.calls).toHaveLength(0);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'answer_judged', judged_by: 'rule', verdict: 'exact' }));
  });

  it("rules one of the card's stored alternatives exact too, without a call (phase 31, spec D13)", async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    const { service, inserted, logger } = setup(judge, record(), { ...CONTEXT, alternatives: ['לקבוע', 'לשמור'] });
    expect((await service.answerJudged('u1', SESSION, answer('לקבוע'))).verdict).toBe('exact');
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([[SESSION, 0, 'm1', { text: 'לקבוע', verdict: 'exact' }]]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'answer_judged', judged_by: 'rule', verdict: 'exact' }));
  });

  it('asks the model once otherwise, and records the mapped verdict', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted, logger } = setup(judge);
    const result = await service.answerJudged('u1', SESSION, answer('לשריין'));
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
    expect((await service.answerJudged('u1', SESSION, answer('ספר'))).verdict).toBe('alternative');
  });

  it('records nothing when the judge fails, and says why', async () => {
    const { service, inserted, logger } = setup(createFakeLlmClient(new LlmUnavailable('timed out after 8000ms')));
    await expect(service.answerJudged('u1', SESSION, answer('לשריין'))).rejects.toBeInstanceOf(LlmUnavailable);
    expect(inserted).toEqual([]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'answer_judge_failed', question_type: 'typed_meaning' }));
  });

  it('treats an unreadable verdict as a failed judge', async () => {
    const { service, inserted } = setup(createFakeLlmClient('{"verdict":"maybe"}'));
    await expect(service.answerJudged('u1', SESSION, answer('לשריין'))).rejects.toBeInstanceOf(LlmUnavailable);
    expect(inserted).toEqual([]);
  });

  it('replays a judged answer without a model call', async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    const answered = record([MEANING, CHOICE], [{ question_id: 'm1', is_correct: true, answer_string: 'לשריין', verdict: 'exact', ...NO_RETRY }]);
    const { service, inserted } = setup(judge, answered);
    const result = await service.answerJudged('u1', SESSION, answer('לשריין'));
    expect(result.verdict).toBe('exact');
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('reports the stored verdict when an overlapping request was recorded first', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const stored = record([MEANING, CHOICE], [{ question_id: 'm1', is_correct: false, answer_string: 'ספר', verdict: 'wrong', ...NO_RETRY }]);
    let loads = 0;
    const session = stub<SessionRepo>({
      loadSession: async () => (++loads === 1 ? record() : stored),
      findEnrollmentId: async () => 'e1',
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
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber(''),
      judge,
    });
    const result = await service.answerJudged('u1', SESSION, answer('לשריין'));
    expect(judge.calls).toHaveLength(1);
    expect(result.verdict).toBe('wrong');
  });

  it('replays a completed session\'s last answer, and refuses any other card, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const done: SessionRecord = {
      ...record([CHOICE, MEANING], [{ question_id: 'm1', is_correct: true, answer_string: 'לשריין', verdict: 'exact', ...NO_RETRY }]),
      complete: true,
      completed_at: 1_000,
      status: 'completed',
    };
    const { service, inserted } = setup(judge, done);
    expect((await service.answerJudged('u1', SESSION, answer('לשריין'))).verdict).toBe('exact');
    await expect(service.answerJudged('u1', SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('refuses before judging: another learner, a stale card, a card that is not judged', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    // Phase 29: another learner's session is refused, not hidden as an unknown one.
    await expect(setup(judge).service.answerJudged('u2', SESSION, answer('x'))).rejects.toBeInstanceOf(AccessDenied);
    await expect(setup(judge).service.answerJudged('u1', SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    const choiceFirst = record([CHOICE, MEANING]);
    await expect(setup(judge, choiceFirst).service.answerJudged('u1', SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(AnswerKindMismatch);
    expect(judge.calls).toHaveLength(0);
  });

  describe('a sentence_translation card', () => {
    const sentence = (text: string) => ({ questionId: 's1', text });
    const first = () => record([SENTENCE, CHOICE]);

    it('rules the reference exact, without a call', async () => {
      const judge = createFakeLlmClient('{"verdict":"wrong"}');
      const { service } = setup(judge, first());
      expect((await service.answerJudged('u1', SESSION, sentence('i want to book a table'))).verdict).toBe('exact');
      expect(judge.calls).toHaveLength(0);
    });

    it('asks the model once otherwise, with the sentence and the reference', async () => {
      const judge = createFakeLlmClient('{"verdict":"right"}');
      const { service } = setup(judge, first());
      expect((await service.answerJudged('u1', SESSION, sentence('I wish to reserve a table'))).verdict).toBe('exact');
      expect(judge.calls).toHaveLength(1);
      expect(JSON.parse(judge.calls[0].user)).toMatchObject({
        hebrew_sentence: 'אני רוצה להזמין שולחן.',
        reference_translation: 'I want to book a table.',
      });
    });

    it('records misspelled as a near miss', async () => {
      const { service, inserted } = setup(createFakeLlmClient('{"verdict":"misspelled"}'), first());
      expect((await service.answerJudged('u1', SESSION, sentence('I want to bok a table'))).verdict).toBe('near_miss');
      expect(inserted).toEqual([[SESSION, 0, 's1', { text: 'I want to bok a table', verdict: 'near_miss' }]]);
    });
  });
});

// Phase 34 (spec D9). Another sense holds a meaning card open for one more try.
// Phase 39 (spec D10). ENROLLMENT is Italian learned by a Hebrew speaker.
describe('answerJudged, the wrong alphabet', () => {
  it('refuses a typed meaning in Latin before any rule or judge, recording nothing', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted, logger } = setup(judge);
    const refused = service.answerJudged('u1', SESSION, answer('degree'));
    await expect(refused).rejects.toBeInstanceOf(WrongScript);
    await expect(refused).rejects.toMatchObject({ questionId: 'm1', language: 'Hebrew' });
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
    expect(logger.events).toContainEqual({ event: 'answer_wrong_script', session_id: SESSION, question_type: 'typed_meaning' });
  });

  it('refuses a sentence translation in Hebrew, and lets digits through to the judge', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service } = setup(judge, record([SENTENCE, CHOICE]));
    await expect(service.answerJudged('u1', SESSION, { questionId: 's1', text: 'להזמין' })).rejects.toBeInstanceOf(WrongScript);
    expect(judge.calls).toHaveLength(0);
    await expect(service.answerJudged('u1', SESSION, { questionId: 's1', text: '1990' })).resolves.toBeDefined();
  });

  it('does not refuse Latin on a typed meaning whose own meaning is Latin ("DNA")', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const dna: Question = { ...MEANING, question: 'DNA', meaning: 'DNA' };
    const { service, logger } = setup(judge, record([dna, CHOICE]), { ...CONTEXT, form: 'DNA', lemma: 'DNA', meaning: 'DNA' });
    await expect(service.answerJudged('u1', SESSION, answer('DNA'))).resolves.toBeDefined();
    expect(logger.events).not.toContainEqual(expect.objectContaining({ event: 'answer_wrong_script' }));
  });
});

describe('answerJudged, the second try', () => {
  const first = { question_id: 'm1', is_correct: true, answer_string: 'ספר', verdict: 'alternative' as const };
  const pending = () => record([MEANING, CHOICE], [{ ...first, retry_state: 'pending', retry_answer_string: null, retry_verdict: null }]);
  const resolved = (retry: 'exact' | 'gave_up') =>
    record([MEANING, CHOICE], [{ ...first, retry_state: 'resolved', retry_answer_string: retry === 'exact' ? 'לשריין' : '', retry_verdict: retry }]);
  const retry = (text: string) => ({ questionId: 'm1', text, retry: true });

  it('records another sense as pending, and holds the session on the card', async () => {
    const { service, inserted } = setup(createFakeLlmClient('{"verdict":"other_sense"}'));
    const result = await service.answerJudged('u1', SESSION, answer('ספר'));
    expect(result.verdict).toBe('alternative');
    expect(inserted).toEqual([[SESSION, 0, 'm1', { text: 'ספר', verdict: 'alternative', pending: true }]]);
    expect(result.session.answers[0]).toMatchObject({ retry_state: 'pending' });
  });

  // Review Focus 1.
  it('replays the first answer sent again while pending, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted, resolved: written } = setup(judge, pending());
    const result = await service.answerJudged('u1', SESSION, answer('ספר'));
    expect(result.verdict).toBe('alternative');
    expect(result.session.answers[0]).toMatchObject({ retry_state: 'pending' });
    expect(judge.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
    expect(written).toEqual([]);
  });

  it('judges the retry with one more call, as the first answer was, and resolves the card', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, inserted, resolved: written } = setup(judge, pending());
    const result = await service.answerJudged('u1', SESSION, retry('לשריין'));
    expect(result.verdict).toBe('exact');
    expect(judge.calls).toHaveLength(1);
    expect(JSON.parse(judge.calls[0].user)).toMatchObject({ saved_meaning: 'להזמין', answer: 'לשריין' });
    expect(inserted).toEqual([]);
    expect(written).toEqual([[SESSION, 0, { text: 'לשריין', verdict: 'exact' }]]);
    expect(result.session.answers[0]).toMatchObject({ retry_state: 'resolved', retry_verdict: 'exact' });
  });

  it('gives up on an empty retry without a call, and answers it wrong as an empty text is', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    const { service, resolved: written } = setup(judge, pending());
    expect((await service.answerJudged('u1', SESSION, retry(''))).verdict).toBe('wrong');
    expect(judge.calls).toHaveLength(0);
    expect(written).toEqual([[SESSION, 0, { text: '', verdict: 'gave_up' }]]);
  });

  it('replays a retry sent again, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"wrong"}');
    expect((await setup(judge, resolved('exact')).service.answerJudged('u1', SESSION, retry('x'))).verdict).toBe('exact');
    expect((await setup(judge, resolved('gave_up')).service.answerJudged('u1', SESSION, retry(''))).verdict).toBe('wrong');
    // And the first answer sent after it: its own verdict.
    expect((await setup(judge, resolved('exact')).service.answerJudged('u1', SESSION, answer('ספר'))).verdict).toBe('alternative');
    expect(judge.calls).toHaveLength(0);
  });

  it('refuses another card while one is pending, and a retry where none is, without a call', async () => {
    const judge = createFakeLlmClient('{"verdict":"right"}');
    await expect(setup(judge, pending()).service.answerJudged('u1', SESSION, { ...answer('x'), questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    await expect(setup(judge).service.answerJudged('u1', SESSION, retry('לשריין'))).rejects.toBeInstanceOf(QuestionDesynced);
    const exact = record([MEANING, CHOICE], [{ question_id: 'm1', is_correct: true, answer_string: 'להזמין', verdict: 'exact', ...NO_RETRY }]);
    await expect(setup(judge, exact).service.answerJudged('u1', SESSION, retry('לשריין'))).rejects.toBeInstanceOf(QuestionDesynced);
    expect(judge.calls).toHaveLength(0);
  });
});
