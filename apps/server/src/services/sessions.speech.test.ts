import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Question } from '@lang-tutor/core/api';

import {
  createFakeClock,
  createFakeLlmClient,
  createFakeLogger,
  createFakePronunciationRepo,
  createFakeTransaction,
  createFakeTranscriber,
  stub,
} from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { SOUND_ALIKE_MARKER } from '../domain/soundAlike';
import { TRANSCRIBE_MARKER } from '../domain/speech';
import type { SessionRecord } from '../domain/session';
import { AccessDenied, AnswerKindMismatch, LlmUnavailable, QuestionDesynced } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GrantRepo } from '../repo/grants';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '22222222-2222-2222-2222-222222222222';
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'it', created_at: '' };
const READ: Question = { id: 'r1', type: 'read_aloud', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' };
const CHOICE: Question = { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0, context: null };
const AUDIO = 'A'.repeat(2_000);

// Phase 34 (spec D9). What every answer that opens no second try carries.
const NO_RETRY = { retry_state: null, retry_answer_string: null, retry_verdict: null };

const record = (answers: SessionRecord['answers'] = []): SessionRecord => ({
  user_id: 'u1',
  questions: [READ, CHOICE],
  answers,
  complete: false,
  completed_at: null,
  status: 'ready',
  source: 'list',
});

// Phase 50 (spec D2). A score far from the line, for a test about something else.
const FAR = '{"scores":[{"key":"p1","score":0}]}';
const scored = (...scores: number[]) => JSON.stringify({ scores: scores.map((score, index) => ({ key: `p${index + 1}`, score })) });

function setup(
  transcriber: ReturnType<typeof createFakeTranscriber>,
  loaded: SessionRecord = record(),
  sound: { judge?: ReturnType<typeof createFakeLlmClient>; stored?: Parameters<typeof createFakePronunciationRepo>[0] } = {},
) {
  const judge = sound.judge ?? createFakeLlmClient(FAR);
  const pronunciation = createFakePronunciationRepo(sound.stored ?? []);
  const inserted: unknown[] = [];
  const resolved: unknown[] = [];
  const logger = createFakeLogger();
  const session = stub<SessionRepo>({
    loadSession: async () => loaded,
    findEnrollmentId: async () => 'e1',
    // Phase 43 (spec D2). Started by its start call before any of these answers.
    markStarted: async () => false,
    insertAnswer: async (...args) => {
      inserted.push(args);
    },
    resolveRetry: async (...args) => {
      resolved.push(args);
    },
  });
  const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
  // Phase 29: another learner holds no grant on the list.
  const grant = stub<GrantRepo>({ findGrantFor: async () => null });
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment, grant, pronunciation }),
    rng: testRng(7),
    now: createFakeClock(1_000, 2_500),
    logger,
    llm: createFakeLlmClient(''),
    contextLlm: createFakeLlmClient(''),
    checkerLlm: createFakeLlmClient(''),
    transcriber,
    judge,
    translationJudge: createFakeLlmClient(''),
    soundAlikeThreshold: 0.95,
  });
  return { service, inserted, resolved, logger, judge, pronunciation };
}

const attempt = { questionId: 'r1', audio: AUDIO, mimeType: 'audio/aac' };

describe('answerBySpeech (spec D5)', () => {
  it('records an understood transcript, with the instruction for the target language', async () => {
    const transcriber = createFakeTranscriber('{"heard":"il gatto"}');
    const { service, inserted } = setup(transcriber);
    const result = await service.answerBySpeech('u1', SESSION, attempt);
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
    expect(await service.answerBySpeech('u1', SESSION, attempt)).toEqual({ heard: 'cane', verdict: 'unheard', session: null });
    expect(inserted).toEqual([]);
  });

  it('hears nothing in a clip too short to hold a word, without a model call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const { service } = setup(transcriber);
    expect(await service.answerBySpeech('u1', SESSION, { ...attempt, audio: 'AAAA' })).toMatchObject({ heard: '', verdict: 'unheard' });
    expect(transcriber.calls).toHaveLength(0);
  });

  it('refuses before transcribing: another learner, a card that is not current, a card that is not spoken', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const { service } = setup(transcriber);
    // Phase 29: another learner's session is refused, not hidden as an unknown one.
    await expect(service.answerBySpeech('u2', SESSION, attempt)).rejects.toBeInstanceOf(AccessDenied);
    await expect(service.answerBySpeech('u1', SESSION, { ...attempt, questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    const atChoice = setup(transcriber, record([{ question_id: 'r1', is_correct: true, answer_string: 'gatto', verdict: 'understood', ...NO_RETRY }]));
    await expect(atChoice.service.answerBySpeech('u1', SESSION, { ...attempt, questionId: 'c2' })).rejects.toBeInstanceOf(AnswerKindMismatch);
    expect(transcriber.calls).toHaveLength(0);
  });

  it('replays an answered speaking card without a model call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const answered = record([{ question_id: 'r1', is_correct: true, answer_string: 'gatto', verdict: 'understood', ...NO_RETRY }]);
    const { service, inserted } = setup(transcriber, answered);
    expect(await service.answerBySpeech('u1', SESSION, attempt)).toMatchObject({ heard: 'gatto', verdict: 'understood' });
    expect(transcriber.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
  });

  it('treats a recorded pass as a stale upload, without a model call (ruling R1)', async () => {
    const transcriber = createFakeTranscriber('{"heard":"gatto"}');
    const passed = record([{ question_id: 'r1', is_correct: false, answer_string: '', verdict: 'skipped', ...NO_RETRY }]);
    const { service } = setup(transcriber, passed);
    await expect(service.answerBySpeech('u1', SESSION, attempt)).rejects.toBeInstanceOf(QuestionDesynced);
    expect(transcriber.calls).toHaveLength(0);
  });

  it('turns an unreadable answer into LlmUnavailable, and a provider failure passes through', async () => {
    await expect(setup(createFakeTranscriber('nonsense')).service.answerBySpeech('u1', SESSION, attempt)).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
    await expect(
      setup(createFakeTranscriber(new LlmUnavailable('responded 503'))).service.answerBySpeech('u1', SESSION, attempt),
    ).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('logs speech_failed when the transcription fails or is unreadable', async () => {
    const failing = setup(createFakeTranscriber(new LlmUnavailable('responded 503')));
    await expect(failing.service.answerBySpeech('u1', SESSION, attempt)).rejects.toBeInstanceOf(LlmUnavailable);
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
    await expect(unreadable.service.answerBySpeech('u1', SESSION, attempt)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(unreadable.logger.events.filter((e) => e.event === 'speech_failed')).toHaveLength(1);
  });

  it('logs speech_judged with the wait, and never the audio', async () => {
    const { service, logger } = setup(createFakeTranscriber('{"heard":"gatto"}'));
    await service.answerBySpeech('u1', SESSION, attempt);
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
    await service.answerBySpeech('u1', SESSION, { ...attempt, audio: 'AAAA' });
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
      findEnrollmentId: async () => 'e1',
      // Phase 43 (spec D2). Started by its start call before any of these answers.
      markStarted: async () => false,
      insertAnswer: async () => {},
    });
    const service = createSessionService({
      transaction: createFakeTransaction({ session, enrollment: stub<EnrollmentRepo>({ findById: async () => ENROLLMENT }) }),
      rng: testRng(7),
      now: createFakeClock(1_000, 2_500),
      logger,
      llm: createFakeLlmClient(''),
      contextLlm: createFakeLlmClient(''),
      checkerLlm: createFakeLlmClient(''),
      transcriber: createFakeTranscriber('{"heard":"gatto"}'),
      judge: createFakeLlmClient(''),
      translationJudge: createFakeLlmClient(''),
      soundAlikeThreshold: 0.95,
    });
    await expect(service.answerBySpeech('u1', SESSION, attempt)).rejects.toBeInstanceOf(QuestionDesynced);
    expect(logger.events.filter((e) => (e as { event?: string }).event === 'speech_judged')).toHaveLength(1);
  });
});

// Phase 50. A transcript whose letters are not the form gets a second look:
// how alike each pair sounds, stored once per pair and shared.
describe('answerBySpeech, the second look by sound (phase 50)', () => {
  const event = (logger: ReturnType<typeof createFakeLogger>, name: string) =>
    logger.events.find((entry) => (entry as { event?: string }).event === name);

  it('records a transcript that sounds like the form as understood, storing what was heard and the score (D1, D3, D5)', async () => {
    const judge = createFakeLlmClient(scored(0.95));
    const { service, inserted, pronunciation } = setup(createFakeTranscriber('{"heard":"gato"}'), record(), { judge });
    const result = await service.answerBySpeech('u1', SESSION, attempt);
    expect(result).toMatchObject({ heard: 'gato', verdict: 'understood' });
    expect(result.session?.answers[0]).toMatchObject({ answer_string: 'gato', verdict: 'understood', is_correct: true });
    expect(inserted).toEqual([[SESSION, 0, 'r1', { text: 'gato', verdict: 'understood' }]]);
    expect(pronunciation.rows).toEqual([{ language: 'it', a: 'gato', b: 'gatto', score: 0.95 }]);
  });

  it('asks the judge in text, under the sound-alike kind, with the pair under its key (D2)', async () => {
    const judge = createFakeLlmClient(scored(1));
    await setup(createFakeTranscriber('{"heard":"gato"}'), record(), { judge }).service.answerBySpeech('u1', SESSION, attempt);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].system).toContain(SOUND_ALIKE_MARKER);
    expect(judge.calls[0].system).toContain('Italian');
    expect(JSON.parse(judge.calls[0].user)).toEqual({ pairs: [{ key: 'p1', a: 'gato', b: 'gatto' }] });
    expect(judge.calls[0].record).toEqual({ kind: 'sound_alike', sessionId: SESSION, enrollmentId: 'e1', userId: 'u1' });
  });

  it('costs no call for a pair already scored', async () => {
    const judge = createFakeLlmClient(scored(0));
    const stored = [{ language: 'it', a: 'gato', b: 'gatto', score: 1 }];
    const { service } = setup(createFakeTranscriber('{"heard":"gato"}'), record(), { judge, stored });
    expect(await service.answerBySpeech('u1', SESSION, attempt)).toMatchObject({ verdict: 'understood' });
    expect(judge.calls).toHaveLength(0);
  });

  it('keeps a score below the threshold, and records nothing', async () => {
    const { service, inserted, pronunciation } = setup(createFakeTranscriber('{"heard":"gato"}'), record(), { judge: createFakeLlmClient(scored(0.9)) });
    expect(await service.answerBySpeech('u1', SESSION, attempt)).toEqual({ heard: 'gato', verdict: 'unheard', session: null });
    expect(inserted).toEqual([]);
    expect(pronunciation.rows).toEqual([{ language: 'it', a: 'gato', b: 'gatto', score: 0.9 }]);
  });

  it('takes the best of several pairs, and names its form', async () => {
    // `il` and `gato` are each a stretch of one word, as long as `gatto`.
    const judge = createFakeLlmClient(scored(0.1, 1));
    const { service, logger } = setup(createFakeTranscriber('{"heard":"il gato"}'), record(), { judge });
    expect(await service.answerBySpeech('u1', SESSION, attempt)).toMatchObject({ heard: 'il gato', verdict: 'understood' });
    expect(JSON.parse(judge.calls[0].user).pairs).toEqual([
      { key: 'p1', a: 'gatto', b: 'il' },
      { key: 'p2', a: 'gato', b: 'gatto' },
    ]);
    expect(event(logger, 'speech_judged')).toMatchObject({ verdict: 'understood', sound_score: 1, sounds_like: 'gatto' });
  });

  it('stays unheard when the score call fails or is unreadable, stores nothing, and logs it (D6)', async () => {
    for (const reply of [new LlmUnavailable('responded 503'), 'nonsense']) {
      const { service, inserted, pronunciation, logger } = setup(createFakeTranscriber('{"heard":"gato"}'), record(), {
        judge: createFakeLlmClient(reply),
      });
      expect(await service.answerBySpeech('u1', SESSION, attempt)).toEqual({ heard: 'gato', verdict: 'unheard', session: null });
      expect(inserted).toEqual([]);
      expect(pronunciation.rows).toEqual([]);
      expect(event(logger, 'sound_alike_failed')).toMatchObject({ session_id: SESSION, question_type: 'read_aloud', reason: expect.any(String) });
    }
  });

  it('never looks again when the letters matched, or when nothing was heard', async () => {
    const judge = createFakeLlmClient(scored(1));
    await setup(createFakeTranscriber('{"heard":"il gatto"}'), record(), { judge }).service.answerBySpeech('u1', SESSION, attempt);
    await setup(createFakeTranscriber('{"heard":""}'), record(), { judge }).service.answerBySpeech('u1', SESSION, attempt);
    await setup(createFakeTranscriber('{"heard":"gatto"}'), record(), { judge }).service.answerBySpeech('u1', SESSION, { ...attempt, audio: 'AAAA' });
    expect(judge.calls).toHaveLength(0);
  });

  it('logs the second look on speech_judged (D7)', async () => {
    const { service, logger } = setup(createFakeTranscriber('{"heard":"gato"}'), record(), { judge: createFakeLlmClient(scored(0.95)) });
    await service.answerBySpeech('u1', SESSION, attempt);
    expect(event(logger, 'speech_judged')).toMatchObject({
      verdict: 'understood',
      heard: 'gato',
      sound_score: 0.95,
      sounds_like: 'gatto',
      sound_called: true,
      sound_ms: expect.any(Number),
    });
    const stored = setup(createFakeTranscriber('{"heard":"gato"}'), record(), { stored: [{ language: 'it', a: 'gato', b: 'gatto', score: 0.5 }] });
    await stored.service.answerBySpeech('u1', SESSION, attempt);
    expect(event(stored.logger, 'speech_judged')).toMatchObject({ verdict: 'unheard', sound_score: 0.5, sound_called: false });
    const matched = setup(createFakeTranscriber('{"heard":"gatto"}'));
    await matched.service.answerBySpeech('u1', SESSION, attempt);
    expect(event(matched.logger, 'speech_judged')).not.toHaveProperty('sound_score');
  });
});

describe('a pass (spec D5, D8)', () => {
  it('stores a skip as an empty text with its verdict', async () => {
    const { service, inserted } = setup(createFakeTranscriber(''));
    const result = await service.submitAnswer('u1', SESSION, 'r1', { pass: 'skip' });
    expect(inserted).toEqual([[SESSION, 0, 'r1', { text: '', verdict: 'skipped' }]]);
    expect(result.answers[0]).toMatchObject({ is_correct: false, verdict: 'skipped' });
  });
});

// Phase 34 (spec D9). Another right word holds say the translation open for one more try.
describe('answerBySpeech, the second try', () => {
  const SAY: Question = {
    id: 's1',
    type: 'say_translation',
    vocab_term_id: 'l1',
    question: 'פנס',
    part_of_speech: 'noun',
    answer: 'lantern',
    lemma: 'lantern',
    alternatives: ['lamp'],
    context: null,
  };
  const first = { question_id: 's1', is_correct: true, answer_string: 'lamp', verdict: 'alternative' as const };
  const at = (answers: SessionRecord['answers']): SessionRecord => ({ ...record(answers), questions: [SAY, CHOICE] });
  const pending = () => at([{ ...first, retry_state: 'pending', retry_answer_string: null, retry_verdict: null }]);
  const resolvedAs = (text: string, verdict: 'understood' | 'gave_up') =>
    at([{ ...first, retry_state: 'resolved', retry_answer_string: text, retry_verdict: verdict }]);
  const clip = { questionId: 's1', audio: AUDIO, mimeType: 'audio/aac' };

  it('records another right word as pending, and holds the session on the card', async () => {
    const { service, inserted } = setup(createFakeTranscriber('{"heard":"lamp"}'), at([]));
    const result = await service.answerBySpeech('u1', SESSION, clip);
    expect(result).toMatchObject({ heard: 'lamp', verdict: 'alternative' });
    expect(inserted).toEqual([[SESSION, 0, 's1', { text: 'lamp', verdict: 'alternative', pending: true, helped: null }]]);
    expect(result.session?.answers[0]).toMatchObject({ retry_state: 'pending' });
  });

  // Review Focus 1.
  it('replays the first clip sent again while pending, without a call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"lantern"}');
    const { service, inserted, resolved } = setup(transcriber, pending());
    const result = await service.answerBySpeech('u1', SESSION, clip);
    expect(result).toMatchObject({ heard: 'lamp', verdict: 'alternative' });
    expect(result.session?.answers[0]).toMatchObject({ retry_state: 'pending' });
    expect(transcriber.calls).toHaveLength(0);
    expect(inserted).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('transcribes a retry once more, judges it as the first was, and resolves the card', async () => {
    const transcriber = createFakeTranscriber('{"heard":"the lantern"}');
    const { service, resolved } = setup(transcriber, pending());
    const result = await service.answerBySpeech('u1', SESSION, { ...clip, retry: true });
    expect(result).toMatchObject({ heard: 'the lantern', verdict: 'understood' });
    expect(transcriber.calls).toHaveLength(1);
    expect(resolved).toEqual([[SESSION, 0, { text: 'the lantern', verdict: 'understood' }]]);
  });

  it('records nothing for a retry that was not understood: the card stays open', async () => {
    const { service, resolved } = setup(createFakeTranscriber('{"heard":"cane"}'), pending());
    expect(await service.answerBySpeech('u1', SESSION, { ...clip, retry: true })).toEqual({ heard: 'cane', verdict: 'unheard', session: null });
    expect(resolved).toEqual([]);
  });

  // Phase 50. A retry clip gets the second look a first one does.
  it('resolves a retry that sounds like the word as understood', async () => {
    const { service, resolved } = setup(createFakeTranscriber('{"heard":"lanterne"}'), pending(), { judge: createFakeLlmClient(scored(1)) });
    expect(await service.answerBySpeech('u1', SESSION, { ...clip, retry: true })).toMatchObject({ heard: 'lanterne', verdict: 'understood' });
    expect(resolved).toEqual([[SESSION, 0, { text: 'lanterne', verdict: 'understood' }]]);
  });

  it('replays a retry sent again without a call, and treats one after a give-up as stale', async () => {
    const transcriber = createFakeTranscriber('{"heard":"lamp"}');
    const again = await setup(transcriber, resolvedAs('the lantern', 'understood')).service.answerBySpeech('u1', SESSION, { ...clip, retry: true });
    expect(again).toMatchObject({ heard: 'the lantern', verdict: 'understood' });
    await expect(
      setup(transcriber, resolvedAs('', 'gave_up')).service.answerBySpeech('u1', SESSION, { ...clip, retry: true }),
    ).rejects.toBeInstanceOf(QuestionDesynced);
    expect(transcriber.calls).toHaveLength(0);
  });

  it('refuses another card while one is pending, and a retry where none is, without a call', async () => {
    const transcriber = createFakeTranscriber('{"heard":"lantern"}');
    await expect(setup(transcriber, pending()).service.answerBySpeech('u1', SESSION, { ...clip, questionId: 'c2' })).rejects.toBeInstanceOf(QuestionDesynced);
    await expect(setup(transcriber, at([])).service.answerBySpeech('u1', SESSION, { ...clip, retry: true })).rejects.toBeInstanceOf(QuestionDesynced);
    expect(transcriber.calls).toHaveLength(0);
  });

  it('gives up on a retry with show the answer, through next-step', async () => {
    const { service, resolved } = setup(createFakeTranscriber(''), pending());
    const result = await service.submitAnswer('u1', SESSION, 's1', { pass: 'show_answer' }, { retry: true });
    expect(resolved).toEqual([[SESSION, 0, { text: '', verdict: 'gave_up' }]]);
    expect(result.answers[0]).toMatchObject({ is_correct: true, retry_state: 'resolved', retry_verdict: 'gave_up' });
  });
});
