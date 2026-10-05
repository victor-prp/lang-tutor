import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Question } from '@lang-tutor/core/api';

import { createFakeLlmClient, createFakeLogger, createFakeTransaction } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { GenerationContext } from '../domain/distractors';
import type { SessionState } from '../domain/session';
import { InvalidDistractors } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

// Only the methods a case names exist; any other reach fails with its name.
function stub<T extends object>(methods: Partial<T>): T {
  return new Proxy(methods, {
    get: (target, property) =>
      (target as Record<string | symbol, unknown>)[property] ??
      (() => {
        throw new Error(`${String(property)} is not stubbed`);
      }),
  }) as T;
}

const SESSION = '11111111-1111-1111-1111-111111111111';
const STATE: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'preparing', source: 'list' };
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'ru', created_at: '' };
const CONTEXT: GenerationContext[] = [
  { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה' },
  { senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל' },
];
const PAYLOAD = {
  session_id: SESSION,
  picks: [
    { sense_id: 's1', variant_id: 'v1' },
    { sense_id: 's2', variant_id: 'v2' },
  ],
};
const GOOD = JSON.stringify({
  items: [
    { key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] },
    { key: 'q2', distractors: ['שום', 'גזר', 'כרוב'] },
  ],
});

function world(opts: { state?: SessionState; context?: GenerationContext[]; ready?: boolean; reply?: string | Error }) {
  const calls = { transitions: [] as string[], generated: [] as unknown[], sessionQuestions: [] as Question[][] };
  const session = stub<SessionRepo>({
    findState: async () => opts.state ?? STATE,
    transition: async (_id, from, to) => {
      calls.transitions.push(`${from.join('|')}→${to}`);
      return opts.ready ?? true;
    },
    insertSessionQuestions: async (_id, picked) => {
      calls.sessionQuestions.push(picked);
    },
  });
  const enrollment = stub<EnrollmentRepo>({ findById: async () => ENROLLMENT });
  const question = stub<QuestionRepo>({
    findGenerationContext: async () => opts.context ?? CONTEXT,
    insertGeneratedQuestions: async (input) => {
      calls.generated.push(input);
      return input.questions.map((q, i) => ({
        id: `g${i}`,
        type: 'multiple_choice' as const,
        vocab_term_id: q.lexemeId,
        question: q.form,
        options: q.options.map((o) => o.text),
        correct_option: 0,
      }));
    },
  });
  const llm = createFakeLlmClient(opts.reply ?? GOOD);
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment, question }),
    rng: testRng(7),
    logger: createFakeLogger(),
    llm,
  });
  return { service, calls, llm };
}

describe('prepareSession', () => {
  it('generates every pick, flips the session to ready, and writes its questions', async () => {
    const { service, calls, llm } = world({});
    await service.prepareSession(PAYLOAD);
    expect(llm.calls).toHaveLength(1);
    expect(calls.transitions).toEqual(['preparing→ready']);
    const [input] = calls.generated as { questions: { options: { text: string; is_correct: boolean }[] }[] }[];
    expect(input.questions[0].options).toEqual([
      { position: 0, text: 'קראה', is_correct: true },
      { position: 1, text: 'כתבה', is_correct: false },
      { position: 2, text: 'שמעה', is_correct: false },
      { position: 3, text: 'ראתה', is_correct: false },
    ]);
    expect(calls.sessionQuestions[0]).toHaveLength(2);
  });

  it('does nothing for a session that is no longer preparing — no model call', async () => {
    const { service, calls, llm } = world({ state: { ...STATE, status: 'skipped' } });
    await service.prepareSession(PAYLOAD);
    expect(llm.calls).toHaveLength(0);
    expect(calls.transitions).toEqual([]);
  });

  // Review Focus 2, at unit level: a skip lands while the model is answering.
  it('writes no questions when the session was skipped during generation', async () => {
    const { service, calls } = world({ ready: false });
    await service.prepareSession(PAYLOAD);
    expect(calls.generated).toEqual([]);
    expect(calls.sessionQuestions).toEqual([]);
  });

  // Review Focus 3: a pick whose dictionary rows vanished.
  it('generates the picks that remain, and fails when none does', async () => {
    const partial = world({ context: CONTEXT.slice(1), reply: JSON.stringify({ items: [{ key: 'q1', distractors: ['שום', 'גזר', 'כרוב'] }] }) });
    await partial.service.prepareSession(PAYLOAD);
    expect(JSON.parse(partial.llm.calls[0].user).items).toHaveLength(1);

    const none = world({ context: [] });
    await expect(none.service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
    expect(none.llm.calls).toHaveLength(0);
  });

  it('throws, writing nothing, when a distractor is the answer', async () => {
    const bad = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['קראה', 'שמעה', 'ראתה'] },
        { key: 'q2', distractors: ['שום', 'גזר', 'כרוב'] },
      ],
    });
    const { service, calls } = world({ reply: bad });
    await expect(service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
    expect(calls.transitions).toEqual([]);
  });

  it('throws on an empty (blocked) or unreadable answer', async () => {
    await expect(world({ reply: '' }).service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
    await expect(world({ reply: 'nope' }).service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
  });

  it('rejects a payload that is not one (an older deploy, a hand-made job)', async () => {
    await expect(world({}).service.prepareSession({ session_id: SESSION })).rejects.toThrow();
  });
});

describe('failPreparation', () => {
  it('marks failed only from preparing', async () => {
    const { service, calls } = world({});
    await service.failPreparation(PAYLOAD);
    expect(calls.transitions).toEqual(['preparing→failed']);
  });
});
