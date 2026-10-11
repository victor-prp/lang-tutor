import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Question } from '@lang-tutor/core/api';
import { judgeTyped } from '@lang-tutor/core/domain';

import {
  createFakeClock,
  createFakeGlossRepo,
  createFakeJobRepo,
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  createFakeTranscriber,
  stub,
} from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import { CHECK_MARKER } from '../domain/check';
import { CONTEXT_MARKER, type RecentContexts } from '../domain/context';
import { nothingKnown, type GenerationContext, type KnownRight, type RecentSentences } from '../domain/distractors';
import type { LlmJsonRequest } from './llm';
import type { SessionState } from '../domain/session';
import { GlossLanguageMismatch, InvalidDistractors } from '../errors';
import type { DictRepo } from '../repo/dictionary';
import type { EnrollmentRepo } from '../repo/enrollments';
import type { GlossRepo } from '../repo/glosses';
import type { QuestionRepo } from '../repo/questions';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

const SESSION = '11111111-1111-1111-1111-111111111111';
const STATE: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'preparing', source: 'list' };
const ENROLLMENT: Enrollment = { id: 'e1', user_id: 'u1', source_language: 'he', target_language: 'ru', created_at: '' };
const CONTEXT: GenerationContext[] = [
  { glossId: 'g-s1', senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
  { glossId: 'g-s2', senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
];
const PAYLOAD = {
  session_id: SESSION,
  picks: [
    { gloss_id: 'g-s1', sense_id: 's1', variant_id: 'v1' },
    { gloss_id: 'g-s2', sense_id: 's2', variant_id: 'v2' },
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

/** Phase 34 (spec D5). What the checker was asked, as the request carries it. */
type Checked = { key: string; task: string; word?: string; sentence?: string; options?: string[]; candidates?: string[] };
const checksOf = (request: { user: string }) => JSON.parse(request.user).items as Checked[];

/**
 * Phase 34 (spec D5). A checker that calls every option wrong, every gap option
 * a misfit, and says nothing of a sentence, which drops a context sentence to
 * its fallback and a sentence card to a typed translation, unless `over` gives
 * a key's answer (q1c for q1's context sentence).
 */
const checking = (over: Record<string, object> = {}) => (request: { user: string }) =>
  JSON.stringify({
    items: checksOf(request).map((item) => ({
      key: item.key,
      ...(item.task === 'choice' ? { options: item.options!.map(() => false) } : {}),
      ...(item.task === 'gap' ? { gap_fits: item.options!.map(() => false) } : {}),
      ...over[item.key],
    })),
  });

/** The same checker, translating each sentence card's Hebrew as the batch's own
 *  target sentence does: it agrees with the writer on every sentence card. */
const agreeing = (batch: string) => (request: { user: string }) => {
  const written = JSON.parse(batch).items as { key: string; sentence?: string; translation?: string }[];
  const natural = Object.fromEntries(
    checksOf(request)
      .filter((item) => item.task === 'translate')
      .map((item) => {
        // A typed cloze's Hebrew is its translation; a translation card's is its sentence.
        const made = written.find((w) => w.translation === item.sentence || w.sentence === item.sentence)!;
        return [item.key, { natural_translation: made.translation === item.sentence ? made.sentence : made.translation }];
      }),
  );
  return checking(natural)(request);
};

function world(opts: {
  state?: SessionState;
  context?: GenerationContext[];
  ready?: boolean;
  reply?: string | Error;
  recent?: RecentSentences;
  gloss?: GlossRepo;
  /** Phase 31 (spec D18). What findSiblings answers: other headwords with a card's key. */
  siblings?: { glossId: string; lemma: string }[];
  /** Phase 34 (spec D6, D8, ruling R12). The context call's answer, on its own
   *  client; without one it names no sentence. */
  contextReply?: string | Error;
  /** Phase 34 (spec D6). What findRecentContexts answers. */
  recentContexts?: RecentContexts;
  /** Phase 34 (spec D5). The checker's answer, on its own client; `checking()` by default. */
  checkReply?: string | Error | ((request: LlmJsonRequest) => string);
  /** Phase 34 (spec D3). What findKnownRight answers; nothing known by default. */
  known?: KnownRight;
  enrollment?: Enrollment;
  /** The clock's ticks; 1 000 then 1 250 by default. */
  clock?: number[];
}) {
  const calls = {
    transitions: [] as string[],
    generated: [] as unknown[],
    sessionQuestions: [] as Question[][],
    recentAsked: [] as unknown[],
    recentContextsAsked: [] as unknown[],
    contextAsked: [] as unknown[],
    siblingsAsked: [] as unknown[],
    knownAsked: [] as unknown[],
  };
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
  const enrollment = stub<EnrollmentRepo>({ findById: async () => opts.enrollment ?? ENROLLMENT });
  const question = stub<QuestionRepo>({
    findGenerationContext: async (input) => {
      calls.contextAsked.push(input);
      return opts.context ?? CONTEXT;
    },
    findRecentSentences: async (input) => {
      calls.recentAsked.push(input);
      return opts.recent ?? new Map();
    },
    findRecentContexts: async (input) => {
      calls.recentContextsAsked.push(input);
      return opts.recentContexts ?? new Map();
    },
    insertGeneratedQuestions: async (input) => {
      calls.generated.push(input);
      // Shaped as repo/questions' questionFrom and withBoards shape them; a
      // services test may import a repository only as a type (ADR 0001 R2).
      const onBoard = input.questions.flatMap((q, i) => (q.type === 'matching' ? [i] : []));
      const correct = (q: (typeof input.questions)[number]) => q.options!.findIndex((o) => o.is_correct);
      const board = {
        question_ids: onBoard.map((i) => `g${i}`),
        words: onBoard.map((i) => input.questions[i].form),
        parts_of_speech: onBoard.map((i) => input.questions[i].partOfSpeech),
        correct_options: onBoard.map((i) => correct(input.questions[i])),
      };
      return input.questions.map((q, i): Question => {
        const base = { id: `g${i}`, vocab_term_id: q.lexemeId };
        const gap = { start: q.gapStart ?? 0, end: q.gapEnd ?? 0 };
        const gapText = (q.sentence ?? '').slice(gap.start, gap.end);
        const choice = () => ({ options: q.options!.map((o) => o.text), correct_option: correct(q) });
        // Phase 34 (spec D6, D8): the stored context and marks, as questionFrom reads them.
        const markOf = (start?: number | null, end?: number | null) => (start != null && end != null ? { start, end } : null);
        const context = q.context ? { text: q.context, mark: markOf(q.contextMarkStart, q.contextMarkEnd) } : null;
        const mark = markOf(q.sentenceMarkStart, q.sentenceMarkEnd);
        switch (q.type) {
          case 'typed_translation':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.answerForm ?? q.form, lemma: q.lemma, alternatives: q.alternatives!, context };
          case 'dictation':
            return { ...base, type: q.type, question: q.form, meaning: q.prompt! };
          case 'letter_tiles':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.answerForm ?? q.form, tiles: q.tiles! };
          case 'reverse_choice':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, ...choice(), context };
          case 'matching':
            return { ...base, type: q.type, question: q.form, part_of_speech: q.partOfSpeech, ...choice(), board };
          case 'multiple_choice':
            return { ...base, type: q.type, question: q.answerForm ?? q.form, ...choice(), context };
          case 'listen_choice':
            return { ...base, type: q.type, question: q.answerForm ?? q.form, part_of_speech: q.partOfSpeech, ...choice() };
          case 'read_aloud':
            return { ...base, type: q.type, question: q.form, meaning: q.prompt! };
          case 'say_translation':
            return { ...base, type: q.type, question: q.prompt!, part_of_speech: q.partOfSpeech, answer: q.answerForm ?? q.form, lemma: q.lemma, alternatives: q.alternatives!, context };
          case 'typed_meaning':
            return { ...base, type: q.type, question: q.form, part_of_speech: q.partOfSpeech, meaning: q.prompt!, context };
          case 'cloze_choice':
            return { ...base, type: q.type, sentence: q.sentence!, gap, translation: q.sentenceTranslation!, meaning: q.prompt!, ...choice() };
          case 'cloze_typed':
            return { ...base, type: q.type, sentence: q.sentence!, gap, translation: q.sentenceTranslation!, meaning: q.prompt!, answer: gapText, alternatives: q.alternatives!, mark };
          case 'sentence_translation':
            return { ...base, type: q.type, question: q.sentenceTranslation!, meaning: q.prompt!, sentence: q.sentence!, gap, answer: gapText, mark };
        }
      });
    },
  });
  const llm = createFakeLlmClient(opts.reply ?? GOOD);
  const contextLlm = createFakeLlmClient(opts.contextReply ?? JSON.stringify({ items: [] }));
  const checkerLlm = createFakeLlmClient(opts.checkReply ?? checking());
  const logger = createFakeLogger();
  // Phase 34 (spec D1). What the read asked the accept job for.
  const jobs = createFakeJobRepo();
  const service = createSessionService({
    transaction: createFakeTransaction({
      session,
      enrollment,
      question,
      gloss: opts.gloss ?? createFakeGlossRepo(),
      dict: stub<DictRepo>({
        findSiblings: async (input) => {
          calls.siblingsAsked.push(input);
          return opts.siblings ?? [];
        },
        findKnownRight: async (input) => {
          calls.knownAsked.push(input);
          return opts.known ?? nothingKnown();
        },
      }),
      jobs,
    }),
    rng: testRng(7),
    logger,
    now: createFakeClock(...(opts.clock ?? [1_000, 1_250])),
    llm,
    contextLlm,
    checkerLlm,
    transcriber: createFakeTranscriber(''),
    judge: createFakeLlmClient(''),
  });
  return { service, calls, llm, contextLlm, checkerLlm, logger, jobs };
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
    const { service, calls, llm, contextLlm } = world({});
    await service.prepareSession(PAYLOAD);
    expect(contextLlm.calls.map((call) => call.system.includes(CONTEXT_MARKER))).toEqual([true]);
    // The batch, then (phase 34, rulings R8, R12) the context sentences' own call, on its own client.
    expect(llm.calls.map((call) => call.system.includes(CONTEXT_MARKER))).toEqual([false]);
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
      { glossId: 'g-s3', senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
    ];
    const reply = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] },
        { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
        { key: 'q3', distractors: [], alternatives: ['скоро'] },
      ],
    });
    const { service, calls, llm } = world({ context, reply });
    await service.prepareSession({ ...PAYLOAD, picks: [...PAYLOAD.picks, { gloss_id: 'g-s3', sense_id: 's3', variant_id: 'v3' }] });

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
  glossId: `g-s${i}`, senseId: `s${i}`, variantId: `v${i}`, lexemeId: `l${i}`, form, lemma: form, partOfSpeech: 'noun', translation: MEANINGS[i], example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null,
}));
const TEN_PAYLOAD = {
  session_id: SESSION,
  picks: TEN.map((row) => ({ gloss_id: row.glossId, sense_id: row.senseId, variant_id: row.variantId })),
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
    expect(asked).toEqual(['q1:meaning', 'q2:word', 'q3:typed', 'q4:meaning', 'q8:meaning', 'q10:sentence']);

    const [input] = calls.generated as {
      questions: { type: string; prompt: string | null; options: { text: string; is_correct: boolean }[] | null; tiles: string[] | null }[];
    }[];
    expect(input.questions.map((q) => q.type)).toEqual([
      'multiple_choice', 'reverse_choice', 'typed_translation',
      'matching', 'matching', 'matching', 'matching',
      // s3 listen_choice, s4 letter_tiles (cloze_choice has no gap yet), s5 cloze_typed,
      // which the reply left no sentence for, so typed_translation.
      'listen_choice', 'letter_tiles', 'typed_translation',
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
    const { service, contextLlm, checkerLlm } = world({ context: TEN, reply });
    await expect(service.prepareSession(TEN_PAYLOAD)).rejects.toThrow(/board/);
    // Phase 34: before the context call and the checker are paid for.
    expect(contextLlm.calls).toHaveLength(0);
    expect(checkerLlm.calls).toHaveLength(0);
  });

  // Final review: a tiles card asks the model nothing, yet its meaning is as
  // off limits as an item's own.
  it("refuses a wrong meaning that is another meaning of a listening card's word held by a tiles card", async () => {
    const context = TEN.map((row, i) => (i === 8 ? { ...row, form: TEN[7].form, lemma: TEN[7].form, translation: 'מחבת' } : row));
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
    // Listening off, the tenth card is a sentence card too, so q10 is asked either way.
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
    await on.service.prepareSession({ ...PAYLOAD, ordinal: 6, speaking: true });
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

// Phase 27 Part B (spec D5-D8, Review Focus 1 and 2).
describe('prepareSession, phase 27 Part B: sentence cards', () => {
  // The Russian examples hold the form once, so every pick could be a cloze choice.
  const EXAMPLES = TEN.map((row) => ({
    ...row,
    example: `Вчера мы видели ${row.form} там.`,
    exampleTranslation: `אתמול ראינו את ${row.translation} שם.`,
  }));
  const KEYS = (llm: { calls: { user: string }[] }) =>
    JSON.parse(llm.calls[0].user).items.map((item: { key: string; task: string }) => `${item.key}:${item.task}`);

  function typesOf(calls: { generated: unknown[] }) {
    const [input] = calls.generated as { questions: { type: string }[] }[];
    return input.questions.map((q) => q.type);
  }
  const answers = (llm: { calls: { user: string }[] }, fill: (item: { key: string; task: string; word: string; example: string | null; avoid: string[] }) => object) =>
    JSON.stringify({ items: JSON.parse(llm.calls[0].user).items.map(fill) });

  it('asks a gap item with the blank taken from the saved example, and keeps that gap on the card', async () => {
    const probe = world({ context: EXAMPLES, reply: 'nope' });
    await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
    const gapItems = JSON.parse(probe.llm.calls[0].user).items.filter((item: { task: string }) => item.task === 'gap');
    expect(gapItems.length).toBeGreaterThan(0);
    for (const item of gapItems) {
      expect(item.blank).toBe(item.word);
    }

    const reply = (items: { key: string; task: string }[]) =>
      JSON.stringify({
        items: items.map((item) =>
          item.task === 'gap'
            ? { key: item.key, distractors: ['один', 'два', 'три'] }
            : item.task === 'meaning'
              ? { key: item.key, distractors: ['דלת', 'קיר', 'תקרה'] }
              : item.task === 'word'
                ? { key: item.key, distractors: ['чеснок', 'морковь', 'капуста'] }
                : { key: item.key, distractors: [], alternatives: [] },
        ),
      });
    const { service, calls, llm } = world({ context: EXAMPLES, reply: reply(JSON.parse(probe.llm.calls[0].user).items) });
    await service.prepareSession(TEN_PAYLOAD);
    expect(KEYS(llm)).toEqual(KEYS(probe.llm));
    const [input] = calls.generated as { questions: { type: string; sentence: string | null; gapStart: number | null; gapEnd: number | null; options: { text: string; is_correct: boolean }[] | null }[] }[];
    const cloze = input.questions.filter((q) => q.type === 'cloze_choice');
    expect(cloze.length).toBeGreaterThan(0);
    for (const q of cloze) {
      expect(q.sentence!.slice(q.gapStart!, q.gapEnd!)).toMatch(/^[а-яё]+$/u);
      expect(q.options!.find((o) => o.is_correct)!.text).toBe(q.sentence!.slice(q.gapStart!, q.gapEnd!));
    }
  });

  it('reads the recent sentences of the picked glosses in the read step, and hands them to the items as what to avoid', async () => {
    const recent: RecentSentences = new Map(
      TEN.map((row) => [row.glossId, { cloze: [`Вчера ${row.form} там один раз.`, 'second'], translate: [`Я вижу ${row.form} здесь.`] }]),
    );
    const { service, calls, llm } = world({ context: TEN, reply: TEN_REPLY, recent });
    await service.prepareSession(TEN_PAYLOAD);
    expect(calls.recentAsked).toEqual([{ enrollmentId: 'e1', glossIds: TEN.map((row) => row.glossId), limit: 3 }]);
    const item = JSON.parse(llm.calls[0].user).items.find((i: { task: string }) => i.task === 'sentence');
    expect(item.avoid).toEqual([`Вчера ${item.word} там один раз.`, 'second']);
  });

  it('turns a sentence the model wrote back into a typed translation with no alternatives, and logs why', async () => {
    const probe = world({ context: EXAMPLES, reply: 'nope' });
    await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
    const items = JSON.parse(probe.llm.calls[0].user).items as { key: string; task: string; word: string; example: string | null }[];
    const sentenceItem = items.find((item) => item.task === 'sentence')!;
    const reply = JSON.stringify({
      items: items.map((item) =>
        item.task === 'sentence'
          ? // The model writes the saved example back, with its gap and a Hebrew translation.
            { key: item.key, sentence: item.example, gap: item.word, translation: 'אתמול ראינו שם משהו.', alternatives: [] }
          : item.task === 'gap'
            ? { key: item.key, distractors: ['один', 'два', 'три'] }
            : item.task === 'meaning'
              ? { key: item.key, distractors: ['דלת', 'קיר', 'תקרה'] }
              : item.task === 'word'
                ? { key: item.key, distractors: ['чеснок', 'морковь', 'капуста'] }
                : { key: item.key, distractors: [], alternatives: [] },
      ),
    });
    const { service, calls, logger } = world({ context: EXAMPLES, reply });
    await service.prepareSession(TEN_PAYLOAD);

    const position = Number(sentenceItem.key.slice(1)) - 1;
    const [input] = calls.generated as { questions: { type: string; alternatives: string[] | null; sentence: string | null; prompt: string }[] }[];
    expect(input.questions[position]).toMatchObject({ type: 'typed_translation', alternatives: [], sentence: null });
    expect(logger.events).toContainEqual({
      event: 'sentence_degraded',
      session_id: SESSION,
      position,
      type: 'cloze_typed',
      reason: expect.stringContaining('avoid'),
    });
  });

  it('hands a translate item the recent Hebrew sentences and the example\'s Hebrew, and degrades a card that repeats one', async () => {
    // Ordinal 2 plans a sentence_translation card among the ten.
    // Ordinal 2 plans a sentence_translation card among the ten.
    const PAYLOAD_T ={ ...TEN_PAYLOAD, ordinal: 2 };
    const hebrew = (row: GenerationContext) => `אתמול ראינו שם את ${row.translation} החדש.`;
    const recent: RecentSentences = new Map(EXAMPLES.map((row) => [row.glossId, { cloze: [], translate: [hebrew(row)] }]));
    const probe = world({ context: EXAMPLES, reply: 'nope', recent });
    await expect(probe.service.prepareSession(PAYLOAD_T)).rejects.toThrow();
    const items = JSON.parse(probe.llm.calls[0].user).items as { key: string; task: string; word: string; avoid: string[] }[];
    const translate = items.find((item) => item.task === 'translate')!;
    const row = EXAMPLES.find((r) => r.form === translate.word)!;
    expect(translate.avoid).toEqual([row.exampleTranslation, hebrew(row)]);

    const reply = JSON.stringify({
      items: items.map((item) =>
        item.task === 'translate'
          ? // The model writes last session's Hebrew sentence again.
            { key: item.key, sentence: hebrew(row), translation: `Вчера я видел ${item.word} там.`, gap: item.word }
          : item.task === 'gap'
            ? { key: item.key, distractors: ['один', 'два', 'три'] }
            : item.task === 'meaning'
              ? { key: item.key, distractors: ['דלת', 'קיר', 'תקרה'] }
              : item.task === 'word'
                ? { key: item.key, distractors: ['чеснок', 'морковь', 'капуста'] }
                : { key: item.key, distractors: [], alternatives: [] },
      ),
    });
    const { service, calls, logger } = world({ context: EXAMPLES, reply, recent });
    await service.prepareSession(PAYLOAD_T);
    const position = Number(translate.key.slice(1)) - 1;
    expect(typesOf(calls)[position]).toBe('typed_translation');
    expect(logger.events).toContainEqual({
      event: 'sentence_degraded',
      session_id: SESSION,
      position,
      type: 'sentence_translation',
      reason: expect.stringContaining('avoid'),
    });
  });

  it('plans no gap card for a saved example with no Hebrew half', async () => {
    const probe = world({ context: EXAMPLES.map((row) => ({ ...row, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null })), reply: 'nope' });
    await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
    const items = JSON.parse(probe.llm.calls[0].user).items as { task: string }[];
    expect(items.map((item) => item.task)).not.toContain('gap');
  });

  it('logs sentence_degraded only when the session was written', async () => {
    const probe = world({ context: EXAMPLES, reply: 'nope' });
    await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
    const items = JSON.parse(probe.llm.calls[0].user).items as { key: string; task: string; word: string; example: string | null }[];
    const reply = JSON.stringify({
      items: items.map((item) =>
        item.task === 'sentence'
          ? { key: item.key, sentence: item.example, gap: item.word, translation: 'אתמול ראינו שם משהו.', alternatives: [] }
          : item.task === 'gap'
            ? { key: item.key, distractors: ['один', 'два', 'три'] }
            : item.task === 'meaning'
              ? { key: item.key, distractors: ['דלת', 'קיר', 'תקרה'] }
              : item.task === 'word'
                ? { key: item.key, distractors: ['чеснок', 'морковь', 'капуста'] }
                : { key: item.key, distractors: [], alternatives: [] },
      ),
    });
    const dropped = world({ context: EXAMPLES, reply, ready: false });
    await dropped.service.prepareSession(TEN_PAYLOAD);
    expect(dropped.logger.events.map((e) => (e as { event: string }).event)).not.toContain('sentence_degraded');
  });

  it('stores a valid typed cloze with its sentence and gap, and logs nothing degraded', async () => {
    const probe = world({ context: TEN, reply: 'nope' });
    await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
    const items = JSON.parse(probe.llm.calls[0].user).items as { key: string; task: string; word: string }[];
    const reply = JSON.stringify({
      items: items.map((item) =>
        item.task === 'sentence'
          ? { key: item.key, sentence: `Я вижу ${item.word} там сейчас.`, gap: item.word, translation: 'אני רואה את זה שם עכשיו.', alternatives: [] }
          : item.task === 'meaning'
            ? { key: item.key, distractors: ['דלת', 'קיר', 'תקרה'] }
            : item.task === 'word'
              ? { key: item.key, distractors: ['чеснок', 'морковь', 'капуста'] }
              : { key: item.key, distractors: [], alternatives: [] },
      ),
    });
    const { service, calls, logger } = world({ context: TEN, reply, checkReply: agreeing(reply) });
    await service.prepareSession(TEN_PAYLOAD);
    expect(typesOf(calls)).toContain('cloze_typed');
    const [input] = calls.generated as { questions: { type: string; sentence: string | null; gapStart: number | null; gapEnd: number | null; sentenceTranslation: string | null }[] }[];
    const typed = input.questions.find((q) => q.type === 'cloze_typed')!;
    expect(typed.sentence!.slice(typed.gapStart!, typed.gapEnd!)).toMatch(/^[а-яё]+$/u);
    expect(typed.sentenceTranslation).toBe('אני רואה את זה שם עכשיו.');
    expect(logger.events.map((e) => (e as { event: string }).event)).not.toContain('sentence_degraded');
  });
});

// Phase 31 (spec D14). A merge can land between the request and the job, or
// during the model call: a pick then names a forwarded gloss.
describe('prepareSession, phase 31 (spec D14)', () => {
  const merging = (survivorOf: Record<string, string>): GlossRepo => ({
    ...createFakeGlossRepo(),
    resolveGlosses: async (ids: string[]) =>
      new Map(ids.map((id) => [id, { id: survivorOf[id] ?? id, lexemeId: `lexeme-of-${id}`, userLanguageCode: 'he' }])),
  });

  it('asks for a merged pick as its survivor, and writes its card on the survivor', async () => {
    const { service, calls } = world({ gloss: merging({ 'g-s1': 'g-survivor' }) });
    await service.prepareSession(PAYLOAD);
    expect(calls.contextAsked).toEqual([
      {
        picks: [
          { glossId: 'g-survivor', senseId: 's1', variantId: 'v1' },
          { glossId: 'g-s2', senseId: 's2', variantId: 'v2' },
        ],
        sourceLanguage: 'he',
      },
    ]);
    // The fake context still names g-s1, as a read made before the merge would:
    // the write resolves again.
    const [input] = calls.generated as { questions: { glossId: string }[] }[];
    expect(input.questions.map((q) => q.glossId).sort()).toEqual(['g-s2', 'g-survivor']);
  });

  it('refuses a pick in another learner language before the model is called', async () => {
    const { service, calls, llm } = world({ gloss: createFakeGlossRepo('ru') });
    await expect(service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(GlossLanguageMismatch);
    expect(llm.calls).toEqual([]);
    expect(calls.generated).toEqual([]);
  });
});

// Phase 31 (spec D18). Another headword with a card's key: `order` beside
// `book` under להזמין.
describe('prepareSession, phase 31 (spec D18)', () => {
  it('accepts a sibling headword on the typed card and names it to the model (spec D18)', async () => {
    const context: GenerationContext[] = [
      ...CONTEXT,
      { glossId: 'g_book', senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'book', lemma: 'book', partOfSpeech: 'verb', translation: 'להזמין', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
    ];
    const reply = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] },
        { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
        { key: 'q3', distractors: [], alternatives: ['reserve'] },
      ],
    });
    const { service, calls, llm } = world({ context, reply, siblings: [{ glossId: 'g_book', lemma: 'order' }] });
    await service.prepareSession({ ...PAYLOAD, picks: [...PAYLOAD.picks, { gloss_id: 'g_book', sense_id: 's3', variant_id: 'v3' }] });

    const inserted = (calls.generated[0] as { questions: { type: string; alternatives: string[] | null }[] }).questions;
    expect(inserted[2]).toMatchObject({ type: 'typed_translation', alternatives: ['order', 'reserve'] });
    expect(JSON.parse(llm.calls[0].user).also_in_session).toContainEqual({ word: 'order', correct: 'להזמין' });
    // Read once, in the read step, for the cards' glosses.
    expect(calls.siblingsAsked).toEqual([{ glossIds: ['g-s1', 'g-s2', 'g_book'] }]);
  });
});

// Phase 34 (spec D1). The accept job is asked for lazily, by the read that finds
// a picked rendering it never ran for.
describe('prepareSession, phase 34 (spec D1)', () => {
  it('asks for the accept job once per picked rendering it never ran for, keyed by the rendering', async () => {
    const { service, jobs } = world({});
    await service.prepareSession(PAYLOAD);
    expect(jobs.enqueued).toEqual([
      {
        name: 'accept-rendering',
        data: { variant_id: 'v1', sense_id: 's1', user_language_code: 'he' },
        options: { singletonKey: 'v1:s1:he' },
      },
      {
        name: 'accept-rendering',
        data: { variant_id: 'v2', sense_id: 's2', user_language_code: 'he' },
        options: { singletonKey: 'v2:s2:he' },
      },
    ]);
  });

  // Review Focus 3: the stamp decides, not the list.
  it('asks nothing for a stamped rendering, even one whose list is empty', async () => {
    const stamped = new Date('2026-10-11T10:00:00Z');
    const context: GenerationContext[] = [
      { ...CONTEXT[0], acceptedAt: stamped },
      { ...CONTEXT[1], acceptedAnswers: ['репчатый лук'], acceptedAt: stamped },
    ];
    const { service, jobs } = world({ context });
    await service.prepareSession(PAYLOAD);
    expect(jobs.enqueued).toEqual([]);
  });

  it('asks nothing for a session that is no longer preparing', async () => {
    const { service, jobs } = world({ state: { ...STATE, status: 'skipped' } });
    await service.prepareSession(PAYLOAD);
    expect(jobs.enqueued).toEqual([]);
  });
});

// Phase 34 (spec D1, D2, D12; rulings R6, R7). A card reads the rendering's stored
// list and answer form. The audit's cards, rebuilt: 2260df83 (G), 703a58ca (B),
// 5d9e4f97 (D).
describe('prepareSession, phase 34 (spec D1, D2, D12)', () => {
  const STAMP = new Date('2026-10-11T10:00:00Z');
  const row = (over: Partial<GenerationContext> & Pick<GenerationContext, 'form' | 'lemma' | 'translation'>, n: number): GenerationContext => ({
    glossId: `g-x${n}`, senseId: `sx${n}`, variantId: `vx${n}`, lexemeId: `lx${n}`, partOfSpeech: 'noun',
    example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: STAMP, ...over,
  });
  // Two plain words fill the first two positions (a choice and a reversed card);
  // the third is a typed translation, the card each test is about.
  const FILLER = [
    row({ form: 'casa', lemma: 'casa', translation: 'בית' }, 1),
    row({ form: 'cane', lemma: 'cane', translation: 'כלב' }, 2),
  ];
  const pickOf = (r: GenerationContext) => ({ gloss_id: r.glossId, sense_id: r.senseId, variant_id: r.variantId });
  const payloadOf = (rows: GenerationContext[], over: object = {}) => ({ ...PAYLOAD, picks: rows.map(pickOf), ...over });
  const ENROLLMENT_IT = { ...ENROLLMENT, target_language: 'it' };
  type Inserted = { type: string; answerForm: string | null; alternatives: string[] | null; tiles: string[] | null; options: { text: string; is_correct: boolean }[] | null; form: string };
  const insertedOf = (calls: { generated: unknown[] }) => (calls.generated[0] as { questions: Inserted[] }).questions;
  /** A model that answers every item of the batch the way the cycle asks. */
  const answering = (typed: string[] = [], over: Record<string, object> = {}) => (llm: { calls: { user: string }[] }) =>
    JSON.stringify({
      items: (JSON.parse(llm.calls[0].user).items as { key: string; task: string }[]).map((item) => ({
        key: item.key,
        ...(item.task === 'meaning'
          ? { distractors: ['שגוי1', 'שגוי2', 'שגוי3'] }
          : item.task === 'word'
            ? { distractors: ['tempo', 'giorno', 'minuto'] }
            : { distractors: [], alternatives: typed }),
        ...over[item.key],
      })),
    });
  /** Runs the batch twice: once to learn the items asked, once with the answers. */
  async function prepare(rows: GenerationContext[], opts: { typed?: string[]; payload?: object; over?: Record<string, object> } = {}) {
    const probe = world({ context: rows, reply: 'nope' });
    await expect(probe.service.prepareSession(payloadOf(rows, opts.payload))).rejects.toThrow();
    const run = world({ context: rows, reply: answering(opts.typed ?? [], opts.over)(probe.llm) });
    await run.service.prepareSession(payloadOf(rows, opts.payload));
    return { ...run, questions: insertedOf(run.calls) };
  }
  const judge = (card: { answer: string; lemma: string; alternatives: string[] }, text: string) => judgeTyped(card, text);
  const asCard = (q: Inserted) => ({ answer: q.answerForm ?? q.form, lemma: 'ora', alternatives: q.alternatives ?? [] });

  describe('the answer form (D2, D12)', () => {
    // 2260df83: ora, saved from its plural rendering שעות, answered `ora`, refused `ore`.
    const HOURS = row({ form: 'ora', lemma: 'ora', translation: 'שעות', acceptedAnswers: ['ore'], answerForm: 'ore' }, 3);
    const HOUR = row({ form: 'ora', lemma: 'ora', translation: 'שעה', acceptedAnswers: [], answerForm: null }, 4);

    it('category G (2260df83): the card for שעות asks for ore, accepts ora by the lemma rule, and the card for שעה refuses ore', async () => {
      const hours = await prepare([...FILLER, HOURS]);
      const typed = hours.questions[2];
      expect(typed).toMatchObject({ type: 'typed_translation', answerForm: 'ore' });
      expect(judge(asCard(typed), 'ore')).toBe('exact');
      expect(judge(asCard(typed), 'ora')).toBe('exact');

      const hour = await prepare([...FILLER, HOUR]);
      expect(hour.questions[2]).toMatchObject({ type: 'typed_translation', answerForm: null });
      expect(judge(asCard(hour.questions[2]), 'ora')).toBe('exact');
      expect(judge(asCard(hour.questions[2]), 'ore')).toBe('wrong');
    });

    it('shows ore beside שעות on a choice card, and offers it as the reversed card’s right option', async () => {
      const choice = await prepare([HOURS, ...FILLER]);
      expect(choice.questions[0]).toMatchObject({ type: 'multiple_choice', answerForm: 'ore' });
      expect(choice.questions[0].options!.find((o) => o.is_correct)!.text).toBe('שעות');

      const reversed = await prepare([FILLER[0], HOURS, FILLER[1]]);
      expect(reversed.questions[1]).toMatchObject({ type: 'reverse_choice', answerForm: 'ore' });
      expect(reversed.questions[1].options!.find((o) => o.is_correct)!.text).toBe('ore');
    });

    it('builds a tiles card from ore, and plans tiles by the form the card asks for', async () => {
      // Ordinal 2 puts a tiles card second.
      const tiles = await prepare([FILLER[0], HOURS, FILLER[1]], { payload: { ordinal: 2 } });
      expect(tiles.questions[1]).toMatchObject({ type: 'letter_tiles', answerForm: 'ore' });
      const letters = tiles.questions[1].tiles!;
      expect(letters).toHaveLength(5);
      for (const letter of ['o', 'r', 'e']) expect(letters).toContain(letter);

      // A form that is two words has no tiles, so the plan asks another card.
      const phrase = row({ form: 'ora', lemma: 'ora', translation: 'שעות', acceptedAnswers: [], answerForm: 'ore di punta' }, 5);
      const planned = await prepare([FILLER[0], phrase, FILLER[1]], { payload: { ordinal: 2 } });
      expect(planned.questions[1].type).not.toBe('letter_tiles');
    });

    it('stores the answer form the way the card shows it: one leading article is gone', async () => {
      const article = row({ form: 'ora', lemma: 'ora', translation: 'שעות', answerForm: 'le ore' }, 6);
      const made = await prepare([...FILLER, article]);
      expect(made.questions[2].answerForm).toBe('ore');
    });

    it('ruling R6: an implausible answer form falls back to the saved form, as the card is today', async () => {
      const unrelated = row({ form: 'ora', lemma: 'ora', translation: 'שעות', answerForm: 'tempo' }, 7);
      const irregular = row({ form: 'ha', lemma: 'avere', translation: 'יש לו', answerForm: 'ho' }, 8);
      for (const odd of [unrelated, irregular]) {
        const made = await prepare([...FILLER, odd]);
        expect(made.questions[2]).toMatchObject({ type: 'typed_translation', answerForm: null });
      }
    });

    it('asks no other card for it: a dictation keeps the saved form', async () => {
      const listening = await prepare([FILLER[0], FILLER[1], HOURS], { payload: { listening: true, ordinal: 2 } });
      expect(listening.questions.map((q) => q.type)).toContain('dictation');
      for (const q of listening.questions.filter((q) => q.type === 'dictation')) expect(q.answerForm).toBeNull();
    });

    // read_aloud, the typed cloze and the sentence translation ask the saved form;
    // only say_translation asks the answer form. A word too long to say in either
    // is no speaking or sentence card.
    it('plans no speaking or sentence card when the saved form or the answer form is too long to say', async () => {
      const SPEAKING_OR_SENTENCE = ['read_aloud', 'say_translation', 'cloze_typed', 'sentence_translation'];
      // Five words, against a one-word answer form; and the other way round.
      const longForm = row({ form: 'ore di punta del lavoro', lemma: 'ora', translation: 'שעות שיא', answerForm: 'ore' }, 12);
      const longAnswer = row({ form: 'ora', lemma: 'ora', translation: 'שעות', answerForm: 'ore di punta del lavoro' }, 13);
      for (const long of [longForm, longAnswer]) {
        for (const at of [0, 2]) {
          const rows = at === 0 ? [long, ...FILLER] : [...FILLER, long];
          const made = await prepare(rows, { payload: { speaking: true, ordinal: 1 } });
          expect(SPEAKING_OR_SENTENCE).not.toContain(made.questions[at].type);
          const asked = (JSON.parse(made.llm.calls[0].user).items as { key: string; task: string }[]).map((item) => `${item.key}:${item.task}`);
          expect(asked).not.toContain(`q${at + 1}:sentence`);
        }
      }
      // The same word with both forms short is a speaking card, so the test above can fail.
      const short = row({ form: 'ora', lemma: 'ora', translation: 'שעות', answerForm: 'ore' }, 14);
      const planned = await prepare([short, ...FILLER], { payload: { speaking: true, ordinal: 1 } });
      expect(planned.questions[0].type).toBe('read_aloud');
    });

    it('never offers the answer form as a wrong option of the reversed card', async () => {
      const reply = (words: string[]) => ({ 'q2': { distractors: words } });
      const probe = world({ context: [FILLER[0], HOURS, FILLER[1]], reply: 'nope' });
      await expect(probe.service.prepareSession(payloadOf([FILLER[0], HOURS, FILLER[1]]))).rejects.toThrow();
      const bad = world({ context: [FILLER[0], HOURS, FILLER[1]], reply: answering([], reply(['tempo', 'ore', 'giorno']))(probe.llm) });
      await expect(bad.service.prepareSession(payloadOf([FILLER[0], HOURS, FILLER[1]]))).rejects.toBeInstanceOf(InvalidDistractors);
      expect(bad.calls.generated).toEqual([]);
    });
  });

  describe('the accepted answers (D1, D12)', () => {
    // 703a58ca: אז asked for poi; a learner typed `allora` and was refused, though
    // another card for the same prompt had accepted it.
    const POI = row({ form: 'poi', lemma: 'poi', translation: 'אז', acceptedAnswers: ['allora', 'dopo'] }, 9);

    it('category B (703a58ca): two sessions accept allora whatever their own alternatives were', async () => {
      for (const own of [['quindi'], ['dunque', 'perciò'], []]) {
        const made = await prepare([...FILLER, POI], { typed: own });
        const typed = made.questions[2];
        expect(typed.alternatives).toEqual(expect.arrayContaining(['allora', 'dopo', ...own]));
        expect(judge({ answer: 'poi', lemma: 'poi', alternatives: typed.alternatives! }, 'allora')).toBe('alternative');
        expect(judge({ answer: 'poi', lemma: 'poi', alternatives: typed.alternatives! }, 'dopo')).toBe('alternative');
      }
    });

    it('puts the stored list first, then the session’s own alternatives, deduped, at most ten', async () => {
      const stored = Array.from({ length: 9 }, (_, i) => `ris${i}`);
      const crowded = row({ form: 'poi', lemma: 'poi', translation: 'אז', acceptedAnswers: stored }, 10);
      const made = await prepare([...FILLER, crowded], { typed: ['Ris0', 'quindi', 'dunque'] });
      expect(made.questions[2].alternatives).toEqual([...stored, 'quindi']);
    });

    it('category D (5d9e4f97): io ho is accepted when the stored list holds it', async () => {
      const HO = row({ form: 'ho', lemma: 'avere', translation: 'יש לי', partOfSpeech: 'verb', acceptedAnswers: ['io ho'] }, 11);
      const made = await prepare([...FILLER, HO], { typed: [] });
      const typed = made.questions[2];
      expect(judge({ answer: 'ho', lemma: 'avere', alternatives: typed.alternatives! }, 'io ho')).toBe('alternative');
      expect(judge({ answer: 'ho', lemma: 'avere', alternatives: [] }, 'io ho')).toBe('wrong');
    });

    it('reads the stored list on a speaking card as on a typed one', async () => {
      const spoken = await prepare([FILLER[0], FILLER[1], POI], { payload: { speaking: true, ordinal: 3 } });
      const say = spoken.questions.find((q) => q.type === 'say_translation');
      expect(say?.alternatives).toEqual(expect.arrayContaining(['allora', 'dopo']));
    });

    it('keeps a typed cloze to its sentence’s own alternatives, never the stored list', async () => {
      const ten = TEN.map((r, i) => (i === 9 ? { ...r, acceptedAnswers: ['запас', 'резерв'], acceptedAt: STAMP } : r));
      const probe = world({ context: ten, reply: 'nope' });
      await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
      const items = JSON.parse(probe.llm.calls[0].user).items as { key: string; task: string; word: string }[];
      const reply = JSON.stringify({
        items: items.map((item) =>
          item.task === 'sentence'
            ? { key: item.key, sentence: `Я вижу ${item.word} там сейчас.`, gap: item.word, translation: 'אני רואה את זה שם עכשיו.', alternatives: ['глядеть'] }
            : item.task === 'meaning'
              ? { key: item.key, distractors: ['דלת', 'קיר', 'תקרה'] }
              : item.task === 'word'
                ? { key: item.key, distractors: ['чеснок', 'морковь', 'капуста'] }
                : { key: item.key, distractors: [], alternatives: [] },
        ),
      });
      const { service, calls } = world({ context: ten, reply, checkReply: agreeing(reply) });
      await service.prepareSession(TEN_PAYLOAD);
      const cloze = insertedOf(calls).find((q) => q.type === 'cloze_typed')!;
      expect(cloze.alternatives).toEqual(['глядеть']);
    });

    it('gives a typed card the stored list even when its sentence card degraded into one', async () => {
      const ten = TEN.map((r, i) => (i === 9 ? { ...r, acceptedAnswers: ['запас'], acceptedAt: STAMP } : r));
      // The tenth position asks for a sentence the model does not write.
      const probe = world({ context: ten, reply: 'nope' });
      await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
      const reply = answering()(probe.llm);
      const { service, calls } = world({ context: ten, reply });
      await service.prepareSession(TEN_PAYLOAD);
      const last = insertedOf(calls)[9];
      expect(last).toMatchObject({ type: 'typed_translation', alternatives: ['запас'] });
    });
  });

  describe('ruling R7: the accept enqueues go in key order', () => {
    it('enqueues the picked renderings sorted by their singleton key, whatever order they were picked in', async () => {
      const unstamped = ['vz', 'va', 'vm'].map((v, i) => row({ form: `f${i}`, lemma: `f${i}`, translation: `מ${i}`, variantId: v, senseId: 's1', acceptedAt: null }, 20 + i));
      const { service, jobs } = world({ context: unstamped, reply: 'nope' });
      await expect(service.prepareSession(payloadOf(unstamped))).rejects.toThrow();
      expect(jobs.enqueued.map((job) => (job.options as { singletonKey: string }).singletonKey)).toEqual(['va:s1:he', 'vm:s1:he', 'vz:s1:he']);
    });
  });
});

// Phase 34 (spec D6, D7, D8, D10; rulings R8, R11). After the batch, one call asks
// for the sentences that pin each card's sense: a context sentence beside a bare
// word, and the practised word in a sentence card's Hebrew. The audit's cards,
// rebuilt: d388f738 (C), 71b0b407 (E), a7d6bdb4 (H), eb95d246 (F).
describe('prepareSession, phase 34 (spec D6, D8): context sentences and marks', () => {
  const ENGLISH: Enrollment = { ...ENROLLMENT, target_language: 'en' };
  const STAMP = new Date('2026-10-11T10:00:00Z');
  const row = (over: Partial<GenerationContext> & Pick<GenerationContext, 'form' | 'lemma' | 'translation'>, n: number): GenerationContext => ({
    glossId: `g-c${n}`, senseId: `sc${n}`, variantId: `vc${n}`, lexemeId: `lc${n}`, partOfSpeech: 'noun',
    example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: STAMP, ...over,
  });
  const SAW = row({
    form: 'saw', lemma: 'saw', partOfSpeech: 'verb', translation: 'לנסר',
    example: 'He will saw the branch off.', exampleTranslation: 'הוא ינסר את הענף.',
  }, 1);
  const TABLE = row({ form: 'table', lemma: 'table', translation: 'שולחן' }, 2);
  const DOWNLOAD = row({
    form: 'download', lemma: 'download', partOfSpeech: 'verb', translation: 'להוריד', acceptedAnswers: ['get'],
    example: 'I need to download the file first.', exampleTranslation: 'אני צריך להוריד את הקובץ קודם.',
  }, 3);
  const LAMP = row({ form: 'lamp', lemma: 'lamp', translation: 'מנורה' }, 4);
  const COMBINE = row({ form: 'combine', lemma: 'combine', partOfSpeech: 'verb', translation: 'לשלב' }, 5);
  const pickOf = (r: GenerationContext) => ({ gloss_id: r.glossId, sense_id: r.senseId, variant_id: r.variantId });
  const payloadOf = (rows: GenerationContext[], ordinal: number) => ({ ...PAYLOAD, picks: rows.map(pickOf), ordinal });

  type Inserted = {
    type: string; context?: string | null; contextTranslation?: string | null; contextMarkStart?: number | null; contextMarkEnd?: number | null;
    sentenceMarkStart?: number | null; sentenceMarkEnd?: number | null; sentenceTranslation?: string | null;
  };
  const insertedOf = (calls: { generated: unknown[] }) => (calls.generated[0] as { questions: Inserted[] }).questions;
  const contextCall = (contextLlm: { calls: { system: string; user: string }[] }) => contextLlm.calls.find((call) => call.system.includes(CONTEXT_MARKER));

  // Ordinal 0, three picks: a multiple choice, a reversed card and a typed translation.
  const CHOICES = [SAW, TABLE, DOWNLOAD];
  const CHOICES_BATCH = JSON.stringify({
    items: [
      { key: 'q1', distractors: ['לשייף', 'לקדוח', 'לשבור'] },
      { key: 'q2', distractors: ['chair', 'door', 'wall'] },
      { key: 'q3', distractors: [], alternatives: ['fetch'] },
    ],
  });
  const CHOICES_CONTEXT = JSON.stringify({
    items: [
      { key: 'q1', context: 'Please saw the plank in half.', context_translation: 'בבקשה תנסר את הקרש לשניים.', context_word: 'saw' },
      { key: 'q2', context: 'השולחן במטבח עשוי מעץ.', context_translation: 'The kitchen table is made of wood.', context_word: 'השולחן' },
      { key: 'q3', context: 'אני רוצה להוריד את המשחק החדש הלילה.', context_translation: 'I want to download the new game tonight.', context_word: 'להוריד' },
    ],
  });

  // Phase 34 (spec D5). The checker reads each sentence as the writer meant it.
  const CHOICES_CHECK = checking({ q1c: { context_meaning: 'לנסר' }, q2c: { context_words: ['table'] }, q3c: { context_words: ['download'] } });

  // Ordinal 2, three picks: a typed meaning, a tiles card and a sentence translation.
  const SENTENCES = [SAW, LAMP, COMBINE];
  const SENTENCES_BATCH = JSON.stringify({
    items: [{ key: 'q3', distractors: [], sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", gap: 'combine' }],
  });
  const SENTENCES_CONTEXT = JSON.stringify({
    items: [
      { key: 'q1', context: 'Please saw the plank in half.', context_translation: 'בבקשה תנסר את הקרש לשניים.', context_word: 'saw' },
      { key: 'q3', sentence_word: 'נשלב' },
    ],
  });
  const SENTENCES_CHECK = checking({ q1c: { context_meaning: 'לנסר' }, q3: { natural_translation: "Let's combine forces." } });

  it('category C (d388f738): the typed card for להוריד shows a Hebrew sentence, its word marked, and keeps the other half', async () => {
    const { service, calls } = world({ enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: CHOICES_CONTEXT, checkReply: CHOICES_CHECK });
    await service.prepareSession(payloadOf(CHOICES, 0));
    const typed = insertedOf(calls)[2];
    expect(typed).toMatchObject({
      type: 'typed_translation',
      context: 'אני רוצה להוריד את המשחק החדש הלילה.',
      contextTranslation: 'I want to download the new game tonight.',
      contextMarkStart: 9,
      contextMarkEnd: 15,
    });
    // As the card shows it.
    expect(calls.sessionQuestions[0][2]).toMatchObject({ context: { text: 'אני רוצה להוריד את המשחק החדש הלילה.', mark: { start: 9, end: 15 } } });
  });

  it('category H (a7d6bdb4): the multiple choice for saw shows a sentence in English with saw marked', async () => {
    const { service, calls } = world({ enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: CHOICES_CONTEXT, checkReply: CHOICES_CHECK });
    await service.prepareSession(payloadOf(CHOICES, 0));
    expect(insertedOf(calls)[0]).toMatchObject({
      type: 'multiple_choice',
      context: 'Please saw the plank in half.',
      contextTranslation: 'בבקשה תנסר את הקרש לשניים.',
      contextMarkStart: 7,
      contextMarkEnd: 10,
    });
    expect(insertedOf(calls)[1]).toMatchObject({ type: 'reverse_choice', context: 'השולחן במטבח עשוי מעץ.', contextMarkStart: 0, contextMarkEnd: 6 });
  });

  it('asks the context call after the batch, once, with what each card needs and no item for a card that shows none', async () => {
    const { service, llm, contextLlm } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: SENTENCES_CONTEXT, checkReply: SENTENCES_CHECK });
    await service.prepareSession(payloadOf(SENTENCES, 2));
    expect(llm.calls).toHaveLength(1);
    expect(contextLlm.calls).toHaveLength(1);
    expect(contextLlm.calls[0]).toBe(contextCall(contextLlm));
    const items = JSON.parse(contextCall(contextLlm)!.user).items;
    // The tiles card at q2 shows no sentence (spec D6: the letters pin the word).
    expect(items.map((item: { key: string; task: string }) => `${item.key}:${item.task}`)).toEqual(['q1:target', 'q3:mark']);
    expect(items[1]).toMatchObject({ word: 'combine', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces." });
  });

  it('category E (71b0b407): the typed meaning for saw shows a sentence with saw in the sense of לנסר, and keeps its Hebrew for the judge', async () => {
    const { service, calls } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: SENTENCES_CONTEXT, checkReply: SENTENCES_CHECK });
    await service.prepareSession(payloadOf(SENTENCES, 2));
    expect(insertedOf(calls)[0]).toMatchObject({
      type: 'typed_meaning',
      context: 'Please saw the plank in half.',
      contextTranslation: 'בבקשה תנסר את הקרש לשניים.',
      contextMarkStart: 7,
      contextMarkEnd: 10,
    });
  });

  it('category F (eb95d246): the sentence card for combine marks נשלב in בואו נשלב כוחות', async () => {
    const { service, calls } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: SENTENCES_CONTEXT, checkReply: SENTENCES_CHECK });
    await service.prepareSession(payloadOf(SENTENCES, 2));
    expect(insertedOf(calls)[2]).toMatchObject({
      type: 'sentence_translation', sentenceTranslation: 'בואו נשלב כוחות.', sentenceMarkStart: 5, sentenceMarkEnd: 9, context: null,
    });
    expect(calls.sessionQuestions[0][2]).toMatchObject({ question: 'בואו נשלב כוחות.', mark: { start: 5, end: 9 } });
  });

  // Review Focus 4.
  it('keeps a sentence card unmarked when its word cannot be found in the Hebrew', async () => {
    const reply = SENTENCES_CONTEXT.replace('"sentence_word":"נשלב"', '"sentence_word":"לשלב"');
    const { service, calls } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: reply, checkReply: SENTENCES_CHECK });
    await service.prepareSession(payloadOf(SENTENCES, 2));
    expect(insertedOf(calls)[2]).toMatchObject({ type: 'sentence_translation', sentenceTranslation: 'בואו נשלב כוחות.', sentenceMarkStart: null, sentenceMarkEnd: null });
  });

  // Ruling R11: a hint missing is today's card; a failed session is worse.
  it('prepares the session when the context call fails: each card falls back on its saved example, unmarked, and the failure is logged', async () => {
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: new Error('provider down') });
    await service.prepareSession(payloadOf(SENTENCES, 2));
    expect(calls.transitions).toEqual(['preparing→ready']);
    const [meaning, , translation] = insertedOf(calls);
    expect(meaning).toMatchObject({ context: 'He will saw the branch off.', contextTranslation: 'הוא ינסר את הענף.', contextMarkStart: null });
    expect(translation).toMatchObject({ sentenceMarkStart: null, sentenceMarkEnd: null });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_call_failed', session_id: SESSION, item_count: 2, reason: 'provider down' }));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared' }));
  });

  it('treats an unreadable context answer as a failed call, not a failed session', async () => {
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: 'nope' });
    await service.prepareSession(payloadOf(SENTENCES, 2));
    expect(calls.transitions).toEqual(['preparing→ready']);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_call_failed', reason: expect.stringContaining('unreadable') }));
  });

  it('logs a card left with no sentence, when the model wrote none and the sense has no saved example', async () => {
    const rows = [{ ...SAW, example: null, exampleTranslation: null }, TABLE, DOWNLOAD];
    const reply = JSON.stringify({ items: JSON.parse(CHOICES_CONTEXT).items.filter((item: { key: string }) => item.key !== 'q1') });
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: rows, reply: CHOICES_BATCH, contextReply: reply });
    await service.prepareSession(payloadOf(rows, 0));
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'multiple_choice', context: null });
    expect(logger.events).toContainEqual({ event: 'context_missing', session_id: SESSION, position: 0, type: 'multiple_choice' });
  });

  it('reads the recent contexts in the read step, and drops a sentence one of them showed for the saved example', async () => {
    const recentContexts: RecentContexts = new Map([[DOWNLOAD.glossId, { typed_translation: ['אני רוצה להוריד את המשחק החדש הלילה'] }]]);
    const { service, calls, logger, contextLlm } = world({ enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: CHOICES_CONTEXT, checkReply: CHOICES_CHECK, recentContexts });
    await service.prepareSession(payloadOf(CHOICES, 0));
    expect(calls.recentContextsAsked).toEqual([{ enrollmentId: 'e1', glossIds: CHOICES.map((r) => r.glossId), limit: 3 }]);
    // Told to the model as a sentence to avoid.
    expect(JSON.parse(contextCall(contextLlm)!.user).items[2].avoid).toContain('אני רוצה להוריד את המשחק החדש הלילה');
    expect(insertedOf(calls)[2]).toMatchObject({ context: 'אני צריך להוריד את הקובץ קודם.', contextTranslation: 'I need to download the file first.', contextMarkStart: null });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_dropped', position: 2, type: 'typed_translation', reason: expect.stringContaining('recent') }));
  });

  it('refuses a Hebrew sentence that holds an answer the card accepts, even one only this session listed', async () => {
    const reply = CHOICES_CONTEXT.replace('אני רוצה להוריד את המשחק החדש הלילה.', 'תעשה fetch למשחק החדש הלילה.');
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: reply });
    await service.prepareSession(payloadOf(CHOICES, 0));
    expect(insertedOf(calls)[2]).toMatchObject({ context: 'אני צריך להוריד את הקובץ קודם.' });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_dropped', reason: expect.stringContaining('fetch') }));
  });

  it('asks no context call when no card shows a sentence', async () => {
    // One pick at ordinal 1 with listening on: a listen choice, which shows none (spec D10).
    const { service, llm, contextLlm, calls } = world({
      enrollment: ENGLISH, context: [SAW], reply: JSON.stringify({ items: [{ key: 'q1', distractors: ['לשייף', 'לקדוח', 'לשבור'] }] }),
    });
    await service.prepareSession({ ...payloadOf([SAW], 1), listening: true });
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'listen_choice' });
    expect(llm.calls).toHaveLength(1);
    expect(contextLlm.calls).toHaveLength(0);
  });

  it('logs how long the context call took', async () => {
    const { service, logger } = world({
      enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: CHOICES_CONTEXT, checkReply: CHOICES_CHECK, clock: [1_000, 1_250, 2_000, 2_400],
    });
    await service.prepareSession(payloadOf(CHOICES, 0));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', model_ms: 250, context_ms: 400 }));
  });
});

// Phase 34 (spec D3, D4, D5). What the dictionary knows to be right is never a
// wrong option, six are asked to keep three, and a second model checks the
// cards before they are written. The audit's cards, rebuilt: c49ddbec, 3c482348
// (A), 71b0b407 and a7d6bdb4's saw, d388f738 (C), eb95d246 (F).
describe('prepareSession, phase 34 (spec D3, D4, D5): the known-right set, the spares and the checker', () => {
  const ENGLISH: Enrollment = { ...ENROLLMENT, target_language: 'en' };
  const STAMP = new Date('2026-10-11T10:00:00Z');
  const row = (over: Partial<GenerationContext> & Pick<GenerationContext, 'form' | 'lemma' | 'translation'>, n: number): GenerationContext => ({
    glossId: `g-k${n}`, senseId: `sk${n}`, variantId: `vk${n}`, lexemeId: `lk${n}`, partOfSpeech: 'verb',
    example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: STAMP, ...over,
  });
  const BLOW_UP = row({ form: 'blow up', lemma: 'blow up', translation: 'לנפח' }, 1);
  const PICK_UP = row({ form: 'pick up', lemma: 'pick up', translation: 'לענות' }, 2);
  const TABLE = row({ form: 'table', lemma: 'table', partOfSpeech: 'noun', translation: 'שולחן' }, 3);
  const DOWNLOAD = row({
    form: 'download', lemma: 'download', translation: 'להוריד', acceptedAnswers: ['get'],
    example: 'I need to download the file first.', exampleTranslation: 'אני צריך להוריד את הקובץ קודם.',
  }, 4);
  const SAW = row({ form: 'saw', lemma: 'saw', translation: 'לנסר', example: 'He will saw the branch off.', exampleTranslation: 'הוא ינסר את הענף.' }, 5);
  const LAMP = row({ form: 'lamp', lemma: 'lamp', partOfSpeech: 'noun', translation: 'מנורה' }, 6);
  const COMBINE = row({ form: 'combine', lemma: 'combine', translation: 'לשלב' }, 7);
  const pickOf = (r: GenerationContext) => ({ gloss_id: r.glossId, sense_id: r.senseId, variant_id: r.variantId });
  const payloadOf = (rows: GenerationContext[], ordinal = 0) => ({ ...PAYLOAD, picks: rows.map(pickOf), ordinal });
  type Inserted = { type: string; options: { text: string; is_correct: boolean }[] | null; context?: string | null; contextTranslation?: string | null; sentence: string | null; sentenceTranslation: string | null; alternatives: string[] | null };
  const insertedOf = (calls: { generated: unknown[] }) => (calls.generated[0] as { questions: Inserted[] }).questions;
  const optionTexts = (q: Inserted) => q.options!.map((o) => o.text);
  const events = (logger: { events: unknown[] }, name: string) => (logger.events as { event: string }[]).filter((e) => e.event === name);

  // Ordinal 0: blow up on a multiple choice, table on a reversed card, download typed.
  const CHOICES = [BLOW_UP, TABLE, DOWNLOAD];
  const SIX_WRONG = ['להרוס', 'לקפל', 'לשבור', 'לצבוע', 'לבשל', 'לכתוב'];
  const choicesBatch = (q1: string[]) =>
    JSON.stringify({
      items: [
        { key: 'q1', distractors: q1 },
        { key: 'q2', distractors: ['chair', 'door', 'wall', 'window', 'roof', 'floor'] },
        { key: 'q3', distractors: [], alternatives: ['fetch'] },
      ],
    });
  const CONTEXTS = JSON.stringify({
    items: [
      { key: 'q1', context: 'We will blow up twenty balloons.', context_translation: 'ננפח עשרים בלונים.', context_word: 'blow up' },
      { key: 'q2', context: 'השולחן במטבח עשוי מעץ.', context_translation: 'The kitchen table is made of wood.', context_word: 'השולחן' },
      { key: 'q3', context: 'אני רוצה להוריד את המשחק החדש הלילה.', context_translation: 'I want to download the new game tonight.', context_word: 'להוריד' },
    ],
  });
  const SAW_CONTEXTS = CONTEXTS.replace('We will blow up twenty balloons.', 'Please saw the plank in half.').replace('ננפח עשרים בלונים.', 'בבקשה תנסר את הקרש לשניים.').replace('"context_word":"blow up"', '"context_word":"saw"');
  const AGREED = { q1c: { context_meaning: 'לנסר' }, q2c: { context_words: ['table'] }, q3c: { context_words: ['download'] } };

  it('reads the known-right set once, in the read step, for the picks’ glosses, lexemes, forms and renderings', async () => {
    const { service, calls } = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG) });
    await service.prepareSession(payloadOf(CHOICES));
    expect(calls.knownAsked).toEqual([
      {
        glossIds: ['g-k1', 'g-k3', 'g-k4'],
        lexemeIds: ['lk1', 'lk3', 'lk4'],
        variantIds: ['vk1', 'vk3', 'vk4'],
        prompts: ['לנפח', 'שולחן', 'להוריד'],
        userLanguageCode: 'he',
        targetLanguage: 'en',
      },
    ]);
  });

  it('category A (c49ddbec): never shows להרים on the card for pick up, the dictionary’s other sense of it, and a spare takes its place', async () => {
    const rows = [PICK_UP, TABLE, DOWNLOAD];
    const known: KnownRight = { ...nothingKnown(), meaningsByLexeme: new Map([['lk2', ['לענות', 'להרים']]]) };
    const { service, calls, checkerLlm } = world({ enrollment: ENGLISH, context: rows, reply: choicesBatch(['להרים', 'לכתוב', 'לשיר', 'לרקוד']), known });
    await service.prepareSession(payloadOf(rows));
    expect(optionTexts(insertedOf(calls)[0])).toEqual(['לענות', 'לכתוב', 'לשיר', 'לרקוד']);
    // Refused before the checker: it is never asked about להרים.
    expect(checksOf(checkerLlm.calls[0]).find((item) => item.key === 'q1')!.options).toEqual(['לכתוב', 'לשיר', 'לרקוד']);
  });

  it('category A (3c482348): drops להרוס from blow up’s options when the checker says it is also right, and takes the first spare', async () => {
    const { service, calls, llm, contextLlm, checkerLlm, logger } = world({
      enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG),
      checkReply: checking({ q1: { options: [true, false, false, false, false, false] } }),
    });
    await service.prepareSession(payloadOf(CHOICES));
    expect(optionTexts(insertedOf(calls)[0])).toEqual(['לנפח', 'לקפל', 'לשבור', 'לצבוע']);
    // Its own client, after the batch and the context call, asked every usable option.
    expect(llm.calls.map((call) => call.system.includes(CHECK_MARKER))).toEqual([false]);
    expect(contextLlm.calls.map((call) => call.system.includes(CHECK_MARKER))).toEqual([false]);
    expect(checkerLlm.calls.map((call) => call.system.includes(CHECK_MARKER))).toEqual([true]);
    expect(checksOf(checkerLlm.calls[0]).find((item) => item.key === 'q1')).toEqual({ key: 'q1', task: 'choice', word: 'blow up', options: SIX_WRONG });
    expect(events(logger, 'checker_dropped')).toEqual([
      { event: 'checker_dropped', session_id: SESSION, position: 0, type: 'multiple_choice', kind: 'option', text: 'להרוס', reason: 'the checker calls it right' },
    ]);
  });

  // Review, fix round 1: the checker is never asked about more than six options,
  // the miscount risk that fails the attempt. A seventh never gets past the parse
  // (LlmDistractorsSchema), and validateDistractors keeps at most six.
  it('asks the checker about at most six options of a card, and never sees a seventh', async () => {
    const six = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG) });
    await six.service.prepareSession(payloadOf(CHOICES));
    expect(checksOf(six.checkerLlm.calls[0]).filter((item) => item.task === 'choice').map((item) => item.options!.length)).toEqual([6, 6]);

    const seven = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch([...SIX_WRONG, 'לשחות']) });
    await expect(seven.service.prepareSession(payloadOf(CHOICES))).rejects.toBeInstanceOf(InvalidDistractors);
    expect(seven.checkerLlm.calls).toHaveLength(0);
  });

  // Review Focus 5.
  it('fails the batch only when fewer than three wrong options survive the checker', async () => {
    const three = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: checking({ q1: { options: [true, true, true, false, false, false] } }) });
    await three.service.prepareSession(payloadOf(CHOICES));
    expect(optionTexts(insertedOf(three.calls)[0])).toEqual(['לנפח', 'לצבוע', 'לבשל', 'לכתוב']);

    const yes = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: checking({ q1: { options: SIX_WRONG.map(() => true) } }) });
    await expect(yes.service.prepareSession(payloadOf(CHOICES))).rejects.toBeInstanceOf(InvalidDistractors);
    expect(yes.calls.transitions).toEqual([]);
    expect(yes.logger.events).toContainEqual(
      expect.objectContaining({ event: 'session_preparation_attempt_failed', stage: 'checker', reason: expect.stringContaining("the checker calls 6 of q1's 6 wrong options right, and 3 must be left") }),
    );
  });

  it('fails the batch, writing nothing, on a checker answer that is unreadable, numbers the options wrong, or never comes', async () => {
    for (const checkReply of ['nope', '', checking({ q1: { options: [false, false] } }), new Error('provider down')]) {
      const { service, calls, logger } = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply });
      await expect(service.prepareSession(payloadOf(CHOICES))).rejects.toThrow();
      expect(calls.transitions).toEqual([]);
      expect(calls.generated).toEqual([]);
      expect(events(logger, 'session_preparation_attempt_failed')).toEqual([expect.objectContaining({ stage: 'checker' })]);
    }
    const unreadable = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: 'nope' });
    await expect(unreadable.service.prepareSession(payloadOf(CHOICES))).rejects.toBeInstanceOf(InvalidDistractors);
  });

  it('keeps each sentence the checker reads as the card’s sense, and asks what each card needs', async () => {
    const rows = [SAW, TABLE, DOWNLOAD];
    const known: KnownRight = { ...nothingKnown(), meaningsByLexeme: new Map([['lk5', ['לנסר', 'מסור', 'ראה']]]) };
    const { service, calls, checkerLlm, logger } = world({
      enrollment: ENGLISH, context: rows, reply: choicesBatch(SIX_WRONG), contextReply: SAW_CONTEXTS, checkReply: checking(AGREED), known,
    });
    await service.prepareSession(payloadOf(rows));
    const [choice, reversed, typed] = insertedOf(calls);
    expect(choice.context).toBe('Please saw the plank in half.');
    expect(reversed.context).toBe('השולחן במטבח עשוי מעץ.');
    expect(typed.context).toBe('אני רוצה להוריד את המשחק החדש הלילה.');
    expect(events(logger, 'checker_dropped')).toEqual([]);
    expect(checksOf(checkerLlm.calls[0]).map((item) => `${item.key}:${item.task}`)).toEqual(['q1:choice', 'q1c:meaning', 'q2:choice', 'q2c:words', 'q3c:words']);
    const checks = checksOf(checkerLlm.calls[0]);
    // The marked word, and every reading the dictionary knows, in a fixed order.
    expect(checks[1]).toEqual({ key: 'q1c', task: 'meaning', sentence: 'Please saw the plank in half.', word: 'saw', candidates: ['לנסר', 'מסור', 'ראה'] });
    expect(checks[2]).toMatchObject({ word: 'שולחן', options: ['chair', 'door', 'wall', 'window', 'roof', 'floor'] });
    expect(checks[4]).toEqual({ key: 'q3c', task: 'words', sentence: 'אני רוצה להוריד את המשחק החדש הלילה.', word: 'להוריד' });
  });

  it('category E (71b0b407): drops a sentence for saw the checker reads as ראה, and shows the saved example instead', async () => {
    const rows = [SAW, TABLE, DOWNLOAD];
    const { service, calls, logger } = world({
      enrollment: ENGLISH, context: rows, reply: choicesBatch(SIX_WRONG), contextReply: SAW_CONTEXTS,
      checkReply: checking({ ...AGREED, q1c: { context_meaning: 'ראה' } }),
    });
    await service.prepareSession(payloadOf(rows));
    expect(insertedOf(calls)[0]).toMatchObject({ context: 'He will saw the branch off.', contextTranslation: 'הוא ינסר את הענף.' });
    expect(events(logger, 'checker_dropped')).toEqual([
      { event: 'checker_dropped', session_id: SESSION, position: 0, type: 'multiple_choice', kind: 'context', text: 'Please saw the plank in half.', reason: 'the checker reads it as ראה' },
    ]);
  });

  it('category C (d388f738): drops a Hebrew sentence whose להוריד the checker reads as lower, and logs a card left with none', async () => {
    const { service, calls, logger } = world({
      enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), contextReply: CONTEXTS,
      checkReply: checking({ q1c: { context_meaning: 'לנפח' }, q2c: { context_words: ['desk'] }, q3c: { context_words: ['lower', 'turn down'] } }),
    });
    await service.prepareSession(payloadOf(CHOICES));
    const [, reversed, typed] = insertedOf(calls);
    expect(typed).toMatchObject({ context: 'אני צריך להוריד את הקובץ קודם.', contextTranslation: 'I need to download the file first.' });
    // table has no saved example to fall back on.
    expect(reversed.context).toBeNull();
    expect(events(logger, 'checker_dropped').map((e) => (e as unknown as { position: number }).position)).toEqual([1, 2]);
    expect(logger.events).toContainEqual({ event: 'context_missing', session_id: SESSION, position: 1, type: 'reverse_choice' });
  });

  // Review, fix round 1: the card asks for its answer form, and the saved form
  // is right too (D3's "form, lemma, answer form and accepted answers").
  it('keeps a Hebrew context the checker reads as the saved form when the card asks for an answer form', async () => {
    const ITALIAN: Enrollment = { ...ENROLLMENT, target_language: 'it' };
    const casa = row({ form: 'casa', lemma: 'casa', partOfSpeech: 'noun', translation: 'בית' }, 20);
    const cane = row({ form: 'cane', lemma: 'cane', partOfSpeech: 'noun', translation: 'כלב' }, 21);
    // Saved as parliamo; this rendering is she-speaks, so the card asks for parla.
    const speaks = row({ form: 'parliamo', lemma: 'parlare', translation: 'מדברת', answerForm: 'parla' }, 22);
    const rows = [casa, cane, speaks];
    const batch = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['שולחן', 'כיסא', 'דלת'] },
        { key: 'q2', distractors: ['gatto', 'topo', 'pane'] },
        { key: 'q3', distractors: [], alternatives: [] },
      ],
    });
    const contexts = JSON.stringify({
      items: [{ key: 'q3', context: 'היא מדברת עם אמא שלה כל יום.', context_translation: 'Parla con sua madre ogni giorno.', context_word: 'מדברת' }],
    });
    const asked = (words: string[]) =>
      world({ enrollment: ITALIAN, context: rows, reply: batch, contextReply: contexts, checkReply: checking({ q3c: { context_words: words } }) });

    const saved = asked(['parliamo']);
    await saved.service.prepareSession(payloadOf(rows));
    expect(insertedOf(saved.calls)[2]).toMatchObject({ type: 'typed_translation', context: 'היא מדברת עם אמא שלה כל יום.' });
    expect(events(saved.logger, 'checker_dropped')).toEqual([]);

    // A word none of the card's forms or answers is still drops it.
    const other = asked(['dire']);
    await other.service.prepareSession(payloadOf(rows));
    expect(insertedOf(other.calls)[2]).toMatchObject({ type: 'typed_translation', context: null });
    expect(events(other.logger, 'checker_dropped')).toEqual([expect.objectContaining({ position: 2, kind: 'context' })]);
  });

  it('category F (eb95d246): turns בואו נשלב כוחות into a typed translation when the checker says it naturally, without combine', async () => {
    const rows = [SAW, LAMP, COMBINE];
    const batch = JSON.stringify({ items: [{ key: 'q3', distractors: [], sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", gap: 'combine' }] });
    const contexts = JSON.stringify({ items: [{ key: 'q3', sentence_word: 'נשלב' }] });
    const joined = world({ enrollment: ENGLISH, context: rows, reply: batch, contextReply: contexts, checkReply: checking({ q3: { natural_translation: "Let's join forces." } }) });
    await joined.service.prepareSession(payloadOf(rows, 2));
    expect(insertedOf(joined.calls)[2]).toMatchObject({ type: 'typed_translation', sentence: null, sentenceTranslation: null, context: null });
    expect(events(joined.logger, 'checker_dropped')).toEqual([
      expect.objectContaining({ position: 2, type: 'sentence_translation', kind: 'sentence', text: 'בואו נשלב כוחות.', reason: expect.stringContaining("Let's join forces.") }),
    ]);
    expect(events(joined.logger, 'sentence_degraded')).toEqual([expect.objectContaining({ position: 2, type: 'sentence_translation' })]);
    expect(checksOf(joined.checkerLlm.calls[0]).find((item) => item.key === 'q3')).toEqual({ key: 'q3', task: 'translate', sentence: 'בואו נשלב כוחות.' });

    // The same sentence, read naturally with combine, is kept.
    const combined = world({ enrollment: ENGLISH, context: rows, reply: batch, contextReply: contexts, checkReply: checking({ q3: { natural_translation: "Let's combine our forces." } }) });
    await combined.service.prepareSession(payloadOf(rows, 2));
    expect(insertedOf(combined.calls)[2]).toMatchObject({ type: 'sentence_translation', sentenceTranslation: 'בואו נשלב כוחות.' });
    expect(events(combined.logger, 'sentence_degraded')).toEqual([]);
  });

  it('logs the checker’s time and how many checks it was asked', async () => {
    const { service, logger } = world({
      enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), contextReply: CONTEXTS, checkReply: checking({ ...AGREED, q1c: { context_meaning: 'לנפח' } }),
      clock: [1_000, 1_250, 2_000, 2_400, 3_000, 3_700],
    });
    await service.prepareSession(payloadOf(CHOICES));
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'session_prepared', model_ms: 250, context_ms: 400, checker_ms: 700, check_count: 5 }),
    );
    expect(events(logger, 'checker_dropped')).toEqual([]);
  });

  it('asks no checker when no card has anything to check', async () => {
    // A typed meaning alone (ordinal 2), its context call failed: no option, no written sentence.
    const { service, calls, checkerLlm, logger } = world({ enrollment: ENGLISH, context: [SAW], reply: JSON.stringify({ items: [] }), contextReply: new Error('down') });
    await service.prepareSession(payloadOf([SAW], 2));
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'typed_meaning', context: 'He will saw the branch off.' });
    expect(checkerLlm.calls).toHaveLength(0);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', checker_ms: 0, check_count: 0 }));
  });

  // Review, fix round 1. A cloze choice is checked as a gap: the saved example
  // with its gap written ___, and "does the sentence still read correctly?".
  describe('the cloze choice (spec D5)', () => {
    // Ordinal 1, speaking and listening off: a typed meaning, a cloze choice
    // (download's saved example holds it once) and a typed cloze.
    const rows = [SAW, DOWNLOAD, COMBINE];
    const GAP_WRONG = ['eat', 'sleep', 'sing', 'dance', 'swim'];
    const batch = JSON.stringify({
      items: [
        { key: 'q2', distractors: GAP_WRONG },
        { key: 'q3', distractors: [], sentence: 'We combine the two plans today.', gap: 'combine', translation: 'אנחנו משלבים את שתי התוכניות היום.', alternatives: [] },
      ],
    });
    const natural = { q3: { natural_translation: 'We combine the two plans today.' } };

    it('sends the checker the saved example with its gap written ___, and every usable option', async () => {
      const { service, calls, checkerLlm } = world({ enrollment: ENGLISH, context: rows, reply: batch, checkReply: checking(natural) });
      await service.prepareSession(payloadOf(rows, 1));
      expect(insertedOf(calls).map((q) => q.type)).toEqual(['typed_meaning', 'cloze_choice', 'cloze_typed']);
      expect(checksOf(checkerLlm.calls[0]).find((item) => item.key === 'q2')).toEqual({
        key: 'q2', task: 'gap', sentence: 'I need to ___ the file first.', options: GAP_WRONG,
      });
      expect(optionTexts(insertedOf(calls)[1])).toEqual(['download', 'eat', 'sleep', 'sing']);
    });

    it('drops an option the checker says still fits the gap, and the next spare takes its place', async () => {
      const { service, calls, logger } = world({
        enrollment: ENGLISH, context: rows, reply: batch, checkReply: checking({ ...natural, q2: { gap_fits: [false, true, false, false, false] } }),
      });
      await service.prepareSession(payloadOf(rows, 1));
      expect(optionTexts(insertedOf(calls)[1])).toEqual(['download', 'eat', 'sing', 'dance']);
      expect(events(logger, 'checker_dropped')).toEqual([
        { event: 'checker_dropped', session_id: SESSION, position: 1, type: 'cloze_choice', kind: 'option', text: 'sleep', reason: 'the checker calls it right' },
      ]);
    });
  });

  describe('the board (spec D3, D5, D10)', () => {
    // TEN at ordinal 0 with listening on: the board is positions 3 to 6, q4 its first word.
    const BOARD_REPLY = TEN_REPLY.replace('["דלי","שולחן","כיסא"]', '["שולחן","כיסא","מנורה","ספה"]');

    it('asks the checker about the fifth meaning against each of the four words, and skips one any of them makes right', async () => {
      const { service, calls, checkerLlm, logger } = world({
        context: TEN, reply: BOARD_REPLY, checkReply: checking({ q6: { options: [true, false, false, false] } }),
      });
      await service.prepareSession(TEN_PAYLOAD);
      const boardChecks = checksOf(checkerLlm.calls[0]).filter((item) => ['q4', 'q5', 'q6', 'q7'].includes(item.key));
      expect(boardChecks).toEqual(['зонтик', 'ведро', 'скрипка', 'лопата'].map((word, i) => ({ key: `q${i + 4}`, task: 'choice', word, options: ['שולחן', 'כיסא', 'מנורה', 'ספה'] })));
      expect(insertedOf(calls)[3].options!.map((o) => o.text)).toEqual(['מטרייה', 'דלי', 'כינור', 'את חפירה', 'כיסא']);
      expect(events(logger, 'checker_dropped')).toContainEqual(expect.objectContaining({ position: 3, type: 'matching', kind: 'option', text: 'שולחן' }));
    });

    it('category A (1d268882): never takes a board word’s own known meaning as the fifth', async () => {
      // ведро (position 4) also means כיסא to the dictionary.
      const known: KnownRight = { ...nothingKnown(), meaningsByLexeme: new Map([['l4', ['דלי', 'כיסא']]]) };
      const { service, calls } = world({ context: TEN, reply: BOARD_REPLY, known, checkReply: checking({ q6: { options: [true, false, false, false] } }) });
      await service.prepareSession(TEN_PAYLOAD);
      expect(insertedOf(calls)[3].options!.map((o) => o.text)).toEqual(['מטרייה', 'דלי', 'כינור', 'את חפירה', 'מנורה']);
    });

    it('keeps two words whose meanings the dictionary overlaps off one board', async () => {
      const boardOf = (calls: { generated: unknown[] }) =>
        (calls.generated[0] as { questions: { form: string; type: string }[] }).questions.filter((q) => q.type === 'matching').map((q) => q.form);
      const plain = world({ context: TEN, reply: TEN_REPLY });
      await plain.service.prepareSession(TEN_PAYLOAD);
      expect(boardOf(plain.calls)).toEqual(['зонтик', 'ведро', 'скрипка', 'лопата']);
      // скрипка (pick 5) is also דלי to the dictionary, ведро's meaning on the board.
      const known: KnownRight = { ...nothingKnown(), meaningsByLexeme: new Map([['l5', ['כינור', 'דלי']]]) };
      const overlapping = world({ context: TEN, reply: TEN_REPLY, known });
      await overlapping.service.prepareSession(TEN_PAYLOAD);
      expect(boardOf(overlapping.calls)).toEqual(['зонтик', 'ведро', 'лопата', 'кастрюля']);
    });
  });
});
