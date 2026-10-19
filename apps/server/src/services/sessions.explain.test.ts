import { describe, expect, it } from '@jest/globals';
import type { AnswerRecord, Enrollment, Question } from '@lang-tutor/core/api';

import {
  createFakeClock,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  createFakeTranscriber,
  stub,
} from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { EXPLAIN_MARKER, type Explanation } from '../domain/explain';
import type { SessionRecord } from '../domain/session';
import { AccessDenied, AnswerKindMismatch, LlmUnavailable, RetryPending, SessionNotFound } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GrantRepo } from '../repo/grants';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

/** Phase 66 (spec D2). Explaining a translation card's answer: what is called,
 *  what is stored, and what is refused. */

const SESSION = '22222222-2222-2222-2222-222222222222';
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'it', created_at: '' };
const SENTENCE: Question = {
  id: 's1',
  type: 'sentence_translation',
  vocab_term_id: 'l1',
  question: 'אני רוצה להזמין שולחן.',
  meaning: 'להזמין',
  sentence: 'Voglio prenotare un tavolo.',
  gap: { start: 7, end: 16 },
  answer: 'prenotare',
  mark: null,
};
const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין', context: null };
const CONTEXT = { form: 'prenotare', lemma: 'prenotare', partOfSpeech: 'verb', meaning: 'להזמין', example: null, exampleTranslation: null, alternatives: [] as string[] };
const MODEL: Explanation = {
  corrected: 'Io voglio prenotare un tavolo.',
  mistakes: [{ wrong: 'il tavola', right: 'un tavolo', why: 'tavolo הוא זכר' }],
};

const typed = (questionId: string, text: string, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
  question_id: questionId,
  is_correct: true,
  answer_string: text,
  verdict: 'exact',
  retry_state: null,
  retry_answer_string: null,
  retry_verdict: null,
  ...extra,
});

const record = (answers: AnswerRecord[], questions: Question[] = [MEANING, SENTENCE]): SessionRecord => ({
  user_id: 'u1',
  questions,
  answers,
  complete: false,
  completed_at: null,
  status: 'ready',
  source: 'list',
});

function setup(loaded: SessionRecord | undefined, explainer = createFakeLlmClient(JSON.stringify(MODEL)), stored: Explanation | null = null) {
  const inserted: unknown[] = [];
  let saved = stored;
  const session = stub<SessionRepo>({
    loadSession: async () => loaded,
    findEnrollmentId: async () => 'e1',
    findExplanation: async () => saved,
    insertExplanation: async (...args) => {
      inserted.push(args);
      saved ??= { corrected: args[2].corrected, mistakes: args[2].mistakes };
    },
  });
  const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
  const question = stub<QuestionRepo>({ findJudgeContext: async () => CONTEXT });
  const grant = stub<GrantRepo>({ findGrantFor: async () => null });
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment, question, grant }),
    rng: testRng(7),
    now: createFakeClock(1_000, 4_000),
    logger: createFakeLogger(),
    llm: createFakeLlmClient(''),
    contextLlm: createFakeLlmClient(''),
    checkerLlm: createFakeLlmClient(''),
    gapCheckLlm: createFakeLlmClient(''),
    gapRewriteLlm: createFakeLlmClient(''),
    pointCheckLlm: createFakeLlmClient(''),
    transcriber: createFakeTranscriber(''),
    judge: createFakeLlmClient(''),
    translationJudge: createFakeLlmClient(''),
    explainer,
    soundAlikeThreshold: 0.95,
  });
  return { service, explainer, inserted };
}

const ask = { questionId: 's1' };

describe('explainAnswer (spec D2)', () => {
  it('explains a mistaken answer with one call, and stores what it said', async () => {
    const { service, explainer, inserted } = setup(record([typed('m1', 'להזמין'), typed('s1', 'Io voglio prenotare il tavola.')]));
    expect(await service.explainAnswer('u1', SESSION, ask)).toEqual(MODEL);
    expect(explainer.calls).toHaveLength(1);
    expect(explainer.calls[0]?.system).toContain(EXPLAIN_MARKER);
    expect(JSON.parse(explainer.calls[0]?.user ?? '{}').answer).toBe('Io voglio prenotare il tavola.');
    expect(explainer.calls[0]?.record).toMatchObject({ kind: 'sentence_explain', sessionId: SESSION, enrollmentId: 'e1', userId: 'u1' });
    expect(inserted).toEqual([[SESSION, 1, { text: 'Io voglio prenotare il tavola.', ...MODEL }]]);
  });

  it('returns a stored explanation without a call', async () => {
    const { service, explainer, inserted } = setup(record([typed('m1', 'x'), typed('s1', 'Io voglio prenotare il tavola.')]), undefined, MODEL);
    expect(await service.explainAnswer('u1', SESSION, ask)).toEqual(MODEL);
    expect(explainer.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('has no mistakes for the reference as typed, or an empty answer, without a call', async () => {
    for (const text of ['voglio prenotare un tavolo', '']) {
      const { service, explainer } = setup(record([typed('m1', 'x'), typed('s1', text)]));
      expect((await service.explainAnswer('u1', SESSION, ask)).mistakes).toEqual([]);
      expect(explainer.calls).toHaveLength(0);
    }
  });

  it("explains the second try's text when the card had one", async () => {
    const answered = typed('s1', 'Voglio riservare un tavola.', { verdict: 'alternative', retry_state: 'resolved', retry_answer_string: 'Voglio prenotare un tavola.', retry_verdict: 'exact' });
    const { service, explainer, inserted } = setup(record([typed('m1', 'x'), answered]));
    await service.explainAnswer('u1', SESSION, ask);
    expect(JSON.parse(explainer.calls[0]?.user ?? '{}').answer).toBe('Voglio prenotare un tavola.');
    expect(inserted).toEqual([[SESSION, 1, expect.objectContaining({ text: 'Voglio prenotare un tavola.' })]]);
  });

  it('refuses a card whose second try is pending, with no call', async () => {
    const pending = typed('s1', 'Voglio riservare un tavola.', { verdict: 'alternative', retry_state: 'pending' });
    const { service, explainer } = setup(record([typed('m1', 'x'), pending]));
    await expect(service.explainAnswer('u1', SESSION, ask)).rejects.toBeInstanceOf(RetryPending);
    expect(explainer.calls).toHaveLength(0);
  });

  it('refuses a card that is not a sentence translation, or not answered yet', async () => {
    const { service, explainer } = setup(record([typed('m1', 'x')]));
    await expect(service.explainAnswer('u1', SESSION, { questionId: 'm1' })).rejects.toBeInstanceOf(AnswerKindMismatch);
    await expect(service.explainAnswer('u1', SESSION, ask)).rejects.toBeInstanceOf(AnswerKindMismatch);
    expect(explainer.calls).toHaveLength(0);
  });

  it("refuses another learner's session, and a session that does not exist", async () => {
    const { service } = setup(record([typed('m1', 'x'), typed('s1', 'Io voglio.')]));
    await expect(service.explainAnswer('u2', SESSION, ask)).rejects.toBeInstanceOf(AccessDenied);
    await expect(setup(undefined).service.explainAnswer('u1', SESSION, ask)).rejects.toBeInstanceOf(SessionNotFound);
  });

  it('fails an unreadable answer and stores nothing', async () => {
    const { service, inserted } = setup(record([typed('m1', 'x'), typed('s1', 'Io voglio.')]), createFakeLlmClient('not json'));
    await expect(service.explainAnswer('u1', SESSION, ask)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(inserted).toEqual([]);
  });
});
