import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Question } from '@lang-tutor/core/api';

import { createFakeClock, createFakeLlmClient, createFakeLogger, createFakeTransaction, createFakeTranscriber, stub } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { GenerationContext } from '../domain/distractors';
import type { SessionState } from '../domain/session';
import { InvalidDistractors } from '../errors';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

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
  listening: false,
  ordinal: 0,
};
// Phase 23: q2 is the second position, a reversed card, so its wrong options
// are Russian words.
const GOOD = JSON.stringify({
  items: [
    { key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] },
    { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
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
      // Shaped as repo/questions' questionFrom and withBoards shape them; a
      // services test may import a repository only as a type (ADR 0001 R2).
      const onBoard = input.questions.flatMap((q, i) => (q.type === 'matching' ? [i] : []));
      const correct = (q: (typeof input.questions)[number]) => q.options!.findIndex((o) => o.is_correct);
      const board = {
        question_ids: onBoard.map((i) => `g${i}`),
        words: onBoard.map((i) => input.questions[i].form),
        correct_options: onBoard.map((i) => correct(input.questions[i])),
      };
      return input.questions.map((q, i): Question => {
        const base = { id: `g${i}`, vocab_term_id: q.lexemeId };
        const choice = () => ({ options: q.options!.map((o) => o.text), correct_option: correct(q) });
        switch (q.type) {
          case 'typed_translation':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.form, lemma: q.lemma, alternatives: q.alternatives! };
          case 'dictation':
            return { ...base, type: q.type, question: q.form, meaning: q.prompt! };
          case 'letter_tiles':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.form, tiles: q.tiles! };
          case 'reverse_choice':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, ...choice() };
          case 'matching':
            return { ...base, type: q.type, question: q.form, ...choice(), board };
          case 'multiple_choice':
          case 'listen_choice':
            return { ...base, type: q.type, question: q.form, ...choice() };
          case 'read_aloud':
            return { ...base, type: q.type, question: q.form, meaning: q.prompt! };
          case 'say_translation':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.form, lemma: q.lemma, alternatives: q.alternatives! };
        }
      });
    },
  });
  const llm = createFakeLlmClient(opts.reply ?? GOOD);
  const logger = createFakeLogger();
  const service = createSessionService({
    transaction: createFakeTransaction({ session, enrollment, question }),
    rng: testRng(7),
    logger,
    now: createFakeClock(1_000, 1_250),
    llm,
    transcriber: createFakeTranscriber(''),
  });
  return { service, calls, llm, logger };
}

describe('prepareSession', () => {
  // Phase 24 (spec D16): the slowness is measured per session, not felt.
  it('logs how long the model took and how many items it was asked', async () => {
    const { service, logger } = world({});
    await service.prepareSession(PAYLOAD);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'session_prepared', model_ms: 250, item_count: 2 }),
    );
  });

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

  // Phase 23 (spec D2): types follow positions, in pick order.
  it('gives each position its type, in pick order, with the content each type needs', async () => {
    const context = [
      ...CONTEXT,
      { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר' },
    ];
    const reply = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] },
        { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
        { key: 'q3', distractors: [], alternatives: ['скоро'] },
      ],
    });
    const { service, calls, llm } = world({ context, reply });
    await service.prepareSession({ ...PAYLOAD, picks: [...PAYLOAD.picks, { sense_id: 's3', variant_id: 'v3' }] });

    expect(JSON.parse(llm.calls[0].user).items.map((item: { task: string }) => item.task)).toEqual(['meaning', 'word', 'typed']);
    const [input] = calls.generated as {
      questions: { type: string; prompt: string | null; options: { text: string }[] | null; alternatives: string[] | null }[];
    }[];
    expect(input.questions.map((q) => q.type)).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation']);
    expect(input.questions[1]).toMatchObject({ prompt: 'בצל', alternatives: null });
    expect(input.questions[1].options!.map((o) => o.text)).toEqual(['лук', 'чеснок', 'морковь', 'капуста']);
    expect(input.questions[2]).toMatchObject({ prompt: 'מהר', options: null, alternatives: ['скоро'] });
    // Not reshuffled: the type cycle depends on the order.
    expect(calls.sessionQuestions[0].map((q) => q.id)).toEqual(['g0', 'g1', 'g2']);
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
    const [written] = partial.calls.generated as { questions: unknown[] }[];
    expect(written.questions).toHaveLength(1);
    expect(partial.calls.sessionQuestions[0]).toHaveLength(1);

    const none = world({ context: [] });
    await expect(none.service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
    expect(none.llm.calls).toHaveLength(0);
  });

  it('throws, writing nothing, when a distractor is the answer', async () => {
    const bad = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['קראה', 'שמעה', 'ראתה'] },
        { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
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

  it('throws, writing nothing, when the model call fails', async () => {
    const { service, calls } = world({ reply: new Error('provider down') });
    await expect(service.prepareSession(PAYLOAD)).rejects.toThrow('provider down');
    expect(calls.transitions).toEqual([]);
  });

  // Phase 24 (spec D16): a failed attempt is logged where it happens, not only
  // when the retries are spent.
  it('logs a failed attempt with how long the model took, then rethrows', async () => {
    const { service, logger } = world({ reply: new Error('provider down') });
    await expect(service.prepareSession(PAYLOAD)).rejects.toThrow('provider down');
    expect(logger.events).toContainEqual({
      event: 'session_preparation_attempt_failed',
      session_id: SESSION,
      item_count: 2,
      model_ms: 250,
      reason: 'provider down',
    });
    expect(logger.events.map((e) => (e as { event: string }).event)).not.toContain('session_prepared');
  });

  it('logs a refusal of the answer the same way', async () => {
    const { service, logger } = world({ reply: 'nope' });
    await expect(service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'session_preparation_attempt_failed', reason: expect.stringContaining('unreadable') }),
    );
  });

  it('rejects a payload that is not one (an older deploy, a hand-made job)', async () => {
    await expect(world({}).service.prepareSession({ session_id: SESSION })).rejects.toThrow();
  });
});

const FORMS = ['ромашка', 'черепаха', 'подушка', 'зонтик', 'ведро', 'скрипка', 'лопата', 'кастрюля', 'фонарь', 'ящерица'];
const MEANINGS = ['מרגנית', 'צב', 'כרית', 'מטרייה', 'דלי', 'כינור', 'את חפירה', 'סיר', 'פנס', 'לטאה'];
const TEN: GenerationContext[] = FORMS.map((form, i) => ({
  senseId: `s${i}`, variantId: `v${i}`, lexemeId: `l${i}`, form, lemma: form, partOfSpeech: 'noun', translation: MEANINGS[i],
}));
const TEN_PAYLOAD = {
  session_id: SESSION,
  picks: TEN.map((row) => ({ sense_id: row.senseId, variant_id: row.variantId })),
  listening: true,
  ordinal: 0,
};
// q4 is the board's first word. Its first wrong meaning, דלי, is a board word's
// own meaning, so the fifth meaning must be the next one.
const TEN_REPLY = JSON.stringify({
  items: [
    { key: 'q1', distractors: ['דלת', 'קיר', 'תקרה'] },
    { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
    { key: 'q3', distractors: [], alternatives: [] },
    { key: 'q4', distractors: ['דלי', 'שולחן', 'כיסא'] },
    { key: 'q8', distractors: ['ענן', 'גשם', 'רוח'] },
  ],
});

describe('prepareSession, phase 24 (spec D3, D10, D11)', () => {
  it('plans ten words as a run, the board and a run, and writes each its content', async () => {
    const { service, calls, llm } = world({ context: TEN, reply: TEN_REPLY });
    await service.prepareSession(TEN_PAYLOAD);

    const asked = JSON.parse(llm.calls[0].user).items.map((item: { key: string; task: string }) => `${item.key}:${item.task}`);
    expect(asked).toEqual(['q1:meaning', 'q2:word', 'q3:typed', 'q4:meaning', 'q8:meaning']);

    const [input] = calls.generated as {
      questions: { type: string; prompt: string | null; options: { text: string; is_correct: boolean }[] | null; tiles: string[] | null }[];
    }[];
    expect(input.questions.map((q) => q.type)).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'matching', 'matching', 'matching', 'matching',
      'listen_choice', 'letter_tiles', 'dictation',
    ]);
    expect(input.questions[3].options!.map((o) => o.text)).toEqual(['מטרייה', 'דלי', 'כינור', 'את חפירה', 'שולחן']);
    expect(input.questions[4].options!.find((o) => o.is_correct)!.text).toBe('דלי');
    expect(input.questions[8].tiles).toHaveLength([...'фонарь'].length + 2);
    expect(input.questions[9]).toMatchObject({ prompt: 'לטאה', options: null, tiles: null });

    const shown = calls.sessionQuestions[0] as { options?: string[] }[];
    for (const i of [4, 5, 6]) expect(shown[i].options).toEqual(shown[3].options);
  });

  it("refuses a board whose wrong meanings are all its words' own, so pg-boss retries", async () => {
    // Each is valid for q4 (none is зонтик's own מטרייה), and each is another
    // board word's meaning: only the board check can refuse them.
    const reply = TEN_REPLY.replace('["דלי","שולחן","כיסא"]', '["דלי","כינור","את חפירה"]');
    const { service } = world({ context: TEN, reply });
    await expect(service.prepareSession(TEN_PAYLOAD)).rejects.toThrow(/board/);
  });

  // Final review: a dictation asks the model nothing, yet its meaning is as
  // off limits as an item's own.
  it("refuses a wrong meaning that is another meaning of a listening card's word held by a dictation", async () => {
    const context = TEN.map((row, i) => (i === 9 ? { ...row, form: TEN[7].form, lemma: TEN[7].form, translation: 'מחבת' } : row));
    const reply = TEN_REPLY.replace('["ענן","גשם","רוח"]', '["מחבת","גשם","רוח"]');
    const { service, calls, llm } = world({ context, reply });
    await expect(service.prepareSession(TEN_PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
    expect(calls.generated).toEqual([]);
    // The model was told about the dictation's row.
    expect(JSON.parse(llm.calls[0].user).also_in_session).toEqual([{ word: TEN[7].form, correct: 'מחבת' }]);
    // Without it offered, the same session is fine.
    const fine = world({ context, reply: TEN_REPLY });
    await fine.service.prepareSession(TEN_PAYLOAD);
    expect(fine.calls.generated).toHaveLength(1);
  });

  it('gives a listening-off session no listening card', async () => {
    // Listening off, the tenth card is typed (dictation falls back), so q10 is asked too.
    const reply = JSON.stringify({
      items: [...JSON.parse(TEN_REPLY).items, { key: 'q10', distractors: [], alternatives: [] }],
    });
    const { service, calls } = world({ context: TEN, reply });
    await service.prepareSession({ ...TEN_PAYLOAD, listening: false });
    const [input] = calls.generated as { questions: { type: string }[] }[];
    expect(input.questions.map((q) => q.type)).not.toContain('listen_choice');
    expect(input.questions.map((q) => q.type)).not.toContain('dictation');
  });
});

describe('failPreparation', () => {
  it('marks failed only from preparing', async () => {
    const { service, calls } = world({});
    await service.failPreparation(PAYLOAD);
    expect(calls.transitions).toEqual(['preparing→failed']);
  });

  // The dead-letter job carries the data prepareSession refused. If this threw
  // too, the session would stay preparing forever.
  it('still marks failed when the payload has no picks', async () => {
    const { service, calls } = world({});
    await service.failPreparation({ session_id: SESSION });
    expect(calls.transitions).toEqual(['preparing→failed']);
  });
});

describe('prepareSession, phase 25 (spec D4)', () => {
  const types = (calls: { sessionQuestions: Question[][] }) => calls.sessionQuestions[0].map((question) => question.type);

  it('plans a speaking card only when the payload says speaking', async () => {
    const on = world({ reply: JSON.stringify({ items: [{ key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] }] }) });
    await on.service.prepareSession({ ...PAYLOAD, ordinal: 2, speaking: true });
    expect(types(on.calls)).toEqual(['read_aloud', 'reverse_choice']);

    const off = world({});
    await off.service.prepareSession({ ...PAYLOAD, ordinal: 2, speaking: false });
    expect(types(off.calls)).not.toContain('read_aloud');
  });

  it('reads a payload from before phase 25 as speaking off', async () => {
    const { service, calls } = world({});
    await service.prepareSession({ ...PAYLOAD, ordinal: 2 });
    expect(types(calls)).not.toContain('read_aloud');
  });
});
