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
import { TRANSCRIBE_MARKER } from '../domain/speech';
import type { SessionRecord, SessionState } from '../domain/session';
import { AnswerKindMismatch, LlmUnavailable, QuestionDesynced, SessionNotFound } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const STATE: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'ready', source: 'list' };
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'it', created_at: '' };
const READ: Question = { id: 'r1', type: 'read_aloud', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' };
const CHOICE: Question = { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 };
const AUDIO = 'A'.repeat(2_000);

const record = (answers: SessionRecord['answers'] = []): SessionRecord => ({
  user_id: 'u1',
  questions: [READ, CHOICE],
  answers,
  complete: false,
  completed_at: null,
  status: 'ready',
  source: 'list',
});

function setup(transcriber: ReturnType<typeof createFakeTranscriber>, loaded: SessionRecord = record()) {
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
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment }),
    rng: testRng(7),
    now: createFakeClock(1_000, 2_500),
    logger,
    llm: createFakeLlmClient(''),
    transcriber,
  });
  return { service, inserted, logger };
}

const attempt = { userId: 'u1', questionId: 'r1', audio: AUDIO, mimeType: 'audio/aac' };

describe('answerBySpeech (spec D5)', () => {
  it('records an understood transcript, with the instruction for the target language', async () => {
    const transcriber = createFakeTranscriber('{"heard":"il gatto"}');
    const { service, inserted } = setup(transcriber);
    const result = await service.answerBySpeech(SESSION, attempt);
    expect(result).toMatchObject({ heard: 'il gatto', verdict: 'understood' });
    expect(result.session?.answers[0]).toMatchObject({ verdict: 'understood', is_correct: true });
    expect(inserted).toEqual([[SESSION, 0, 'r1', { text: 'il gatto', verdict: 'understood' }]]);
    expect(transcriber.calls[0]).toMatchObject({ audio: AUDIO, mimeType: 'audio/aac' });
    expect(transcriber.calls[0].system).toContain(TRANSCRIBE_MARKER);
    expect(transcriber.calls[0].system).toContain('Italian');
    expect(transcriber.calls[0].system).not.toContain('gatto');
  });

  it('writes nothing when the word was not understood', async () => {
    const { service, inserted } = setup(createFakeTranscriber('{"heard":"cane"}'));
    expect(await service.answerBySpeech(SESSION, attempt)).toEqual({ heard: 'cane', verdict: 'unheard', session: null });
    expect(inserted).toEqual([]);
  });

  it('hears nothing in a clip too short to hold a word, without a model call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const { service } = setup(transcriber);
    expect(await service.answerBySpeech(SESSION, { ...attempt, audio: 'AAAA' })).toMatchObject({ heard: '', verdict: 'unheard' });
    expect(transcriber.calls).toHaveLength(0);
  });

  it('refuses before transcribing: another learner, a card that is not current, a card that is not spoken', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const { service } = setup(transcriber);
    await expect(service.answerBySpeech(SESSION, { ...attempt, userId: 'u2' })).rejects.toBeInstanceOf(SessionNotFound);
    await expect(service.answerBySpeech(SESSION, { ...attempt, questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    const atChoice = setup(transcriber, record([{ question_id: 'r1', is_correct: true, answer_string: 'gatto', verdict: 'understood' }]));
    await expect(atChoice.service.answerBySpeech(SESSION, { ...attempt, questionId: 'c2' })).rejects.toBeInstanceOf(AnswerKindMismatch);
    expect(transcriber.calls).toHaveLength(0);
  });

  it('replays an answered speaking card without a model call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const answered = record([{ question_id: 'r1', is_correct: true, answer_string: 'gatto', verdict: 'understood' }]);
    const { service, inserted } = setup(transcriber, answered);
    expect(await service.answerBySpeech(SESSION, attempt)).toMatchObject({ heard: 'gatto', verdict: 'understood' });
    expect(transcriber.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('treats a recorded pass as a stale upload, without a model call (ruling R1)', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const passed = record([{ question_id: 'r1', is_correct: false, answer_string: '', verdict: 'skipped' }]);
    const { service } = setup(transcriber, passed);
    await expect(service.answerBySpeech(SESSION, attempt)).rejects.toBeInstanceOf(QuestionDesynced);
    expect(transcriber.calls).toHaveLength(0);
  });

  it('turns an unreadable answer into LlmUnavailable, and a provider failure passes through', async () => {
    await expect(setup(createFakeTranscriber('nonsense')).service.answerBySpeech(SESSION, attempt)).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
    await expect(
      setup(createFakeTranscriber(new LlmUnavailable('responded 503'))).service.answerBySpeech(SESSION, attempt),
    ).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('logs speech_failed when the transcription fails or is unreadable', async () => {
    const failing = setup(createFakeTranscriber(new LlmUnavailable('responded 503')));
    await expect(failing.service.answerBySpeech(SESSION, attempt)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(failing.logger.events.filter((e) => e.event === 'speech_failed')).toEqual([
      {
        event: 'speech_failed',
        session_id: SESSION,
        question_type: 'read_aloud',
        transcribe_ms: 1_500,
        bytes: 1_500,
        mime_type: 'audio/aac',
        reason: 'language model unavailable: responded 503',
      },
    ]);
    const unreadable = setup(createFakeTranscriber('nonsense'));
    await expect(unreadable.service.answerBySpeech(SESSION, attempt)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(unreadable.logger.events.filter((e) => e.event === 'speech_failed')).toHaveLength(1);
  });

  it('logs speech_judged with the wait, and never the audio', async () => {
    const { service, logger } = setup(createFakeTranscriber('{"heard":"gatto"}'));
    await service.answerBySpeech(SESSION, attempt);
    const event = logger.events.find((entry) => (entry as { event?: string }).event === 'speech_judged');
    expect(event).toEqual({
      event: 'speech_judged',
      session_id: SESSION,
      question_type: 'read_aloud',
      verdict: 'understood',
      heard: 'gatto',
      transcribed: true,
      transcribe_ms: 1_500,
      bytes: 1_500,
      mime_type: 'audio/aac',
    });
  });

  it('logs a clip too short for a model call as not transcribed, with no wait', async () => {
    const { service, logger } = setup(createFakeTranscriber(''));
    await service.answerBySpeech(SESSION, { ...attempt, audio: 'AAAA' });
    const event = logger.events.find((entry) => (entry as { event?: string }).event === 'speech_judged');
    expect(event).toMatchObject({ verdict: 'unheard', transcribed: false });
    expect(event).not.toHaveProperty('transcribe_ms');
  });

  it('logs speech_judged even when recording the answer then fails', async () => {
    const logger = createFakeLogger();
    let loads = 0;
    // The first read finds the card current; by submitAnswer's read it is gone (a desync race).
    const session = stub<SessionRepo>({
      loadSession: async () => (++loads === 1 ? record() : { ...record(), questions: [CHOICE] }),
      findState: async () => STATE,
      insertAnswer: async () => {},
    });
    const service = createSessionService({
      transaction: createFakeTransaction({ session, enrollment: stub<EnrollmentRepo>({ findById: async () => ENROLLMENT }) }),
      rng: testRng(7),
      now: createFakeClock(1_000, 2_500),
      logger,
      llm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber('{"heard":"gatto"}'),
    });
    await expect(service.answerBySpeech(SESSION, attempt)).rejects.toBeInstanceOf(QuestionDesynced);
    expect(logger.events.filter((e) => (e as { event?: string }).event === 'speech_judged')).toHaveLength(1);
  });
});

describe('a pass (spec D5, D8)', () => {
  it('stores a skip as an empty text with its verdict', async () => {
    const { service, inserted } = setup(createFakeTranscriber(''));
    const result = await service.submitAnswer(SESSION, 'r1', { pass: 'skip' });
    expect(inserted).toEqual([[SESSION, 0, 'r1', { text: '', verdict: 'skipped' }]]);
    expect(result.answers[0]).toMatchObject({ is_correct: false, verdict: 'skipped' });
  });
});
