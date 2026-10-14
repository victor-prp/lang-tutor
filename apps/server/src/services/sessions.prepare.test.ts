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
// Phase 35 (spec D6). A pick's dimension, rung, level and R choose its card, and
// its chance of success p its position, highest first. A pick with none of
// them is a new word: multiple choice, p 1.
const RECOGNISE = { dimension: 'written_receptive', rung: 1, level: 1, r: 0.81 } as const; // multiple choice, p 0.925
const PICK_FORM = { dimension: 'written_productive', rung: 1, level: 1, r: 0.5 } as const; // reverse or cloze choice, p 0.78
const BUILD_FORM = { dimension: 'written_productive', rung: 1, level: 1, r: 0.81 } as const; // letter tiles, p 0.9
const HEAR = { dimension: 'spoken_receptive', rung: 1, level: 1, r: 0.64 } as const; // listen and choose, p 0.85
const SAY = { dimension: 'spoken_productive', rung: 1, level: 1, r: null } as const; // read aloud, p 1
/** Typed recall of the form, p = R: typed translation, typed cloze, sentence translation in turn. */
const produce = (r: number) => ({ dimension: 'written_productive', rung: 2, level: 3, r }) as const;
// Phase 34's tests steer by the same means (they were written against phase 24's
// rotation, which phase 35 removed).
const MEANING = { dimension: 'written_receptive', rung: 2, level: 3, r: 0.99 } as const; // typed meaning, p 0.99
const SPELL = { dimension: 'spelling', rung: 1, level: 1, r: 0.5 } as const; // dictation when listening, p 0.71
const SAY_IT = { dimension: 'spoken_productive', rung: 2, level: 3, r: 0.9 } as const; // say the translation, p 0.9
/** A multiple choice, a reversed card and a typed translation, in this order
 *  (p 1, 0.78, 0.7): the three cards of phase 24's first rotation. */
const THREE = [{}, PICK_FORM, produce(0.7)];

const PAYLOAD = {
  session_id: SESSION,
  picks: [
    { gloss_id: 'g-s1', sense_id: 's1', variant_id: 'v1' },
    { gloss_id: 'g-s2', sense_id: 's2', variant_id: 'v2', ...PICK_FORM },
  ],
  listening: false,
};
// A new word, then a reversed card, so q2's wrong options are Russian words.
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
          case 'new_meaning':
            return { ...base, type: q.type, question: q.answerForm ?? q.form, known_meanings: q.knownMeanings!, ...choice(), context };
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
    translationJudge: createFakeLlmClient(''),
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

  // Phase 47 (spec D3, D6): an attempt's three calls name what they are for,
  // the session, the attempt, and whose they are, so the record can join them.
  it('names each call of an attempt: its kind, the session, the attempt, the enrollment and the learner', async () => {
    const { service, llm, contextLlm, checkerLlm } = world({});
    await service.prepareSession(PAYLOAD, { attempt: 2 });
    const handles = { sessionId: SESSION, attempt: 2, enrollmentId: 'e1', userId: 'u1' };
    expect(llm.calls.map((call) => call.record)).toEqual([{ kind: 'session_generation', ...handles }]);
    expect(contextLlm.calls.map((call) => call.record)).toEqual([{ kind: 'context', ...handles }]);
    expect(checkerLlm.calls.map((call) => call.record)).toEqual([{ kind: 'checker', ...handles }]);
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

  // Phase 35 (spec D6): each pick its card, the highest chance first.
  it('gives each pick its card, highest chance first, with the content each type needs', async () => {
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
    // p: the new word 1, the reversed card 0.78, the typed one 0.76.
    await service.prepareSession({ ...PAYLOAD, picks: [...PAYLOAD.picks, { gloss_id: 'g-s3', sense_id: 's3', variant_id: 'v3', ...produce(0.76) }] });

    expect(JSON.parse(llm.calls[0].user).items.map((item: { task: string }) => item.task)).toEqual(['meaning', 'word', 'typed']);
    const [input] = calls.generated as {
      questions: { type: string; prompt: string | null; options: { text: string }[] | null; alternatives: string[] | null }[];
    }[];
    expect(input.questions.map((q) => q.type)).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation']);
    expect(input.questions[1]).toMatchObject({ prompt: 'בצל', alternatives: null });
    expect(input.questions[1].options!.map((o) => o.text)).toEqual(['лук', 'чеснок', 'морковь', 'капуста']);
    expect(input.questions[2]).toMatchObject({ prompt: 'מהר', options: null, alternatives: ['скоро'] });
    // Not reshuffled: the plan's order is the session's.
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
    // The reversed card remains: its wrong options are Russian.
    const partial = world({ context: CONTEXT.slice(1), reply: JSON.stringify({ items: [{ key: 'q1', distractors: ['чеснок', 'морковь', 'капуста'] }] }) });
    await partial.service.prepareSession(PAYLOAD);
    expect(JSON.parse(partial.llm.calls[0].user).items).toHaveLength(1);
    const [written] = partial.calls.generated as { questions: unknown[] }[];
    expect(written.questions).toHaveLength(1);
    expect(partial.calls.sessionQuestions[0]).toHaveLength(1);

    const none = world({ context: [] });
    await expect(none.service.prepareSession(PAYLOAD)).rejects.toBeInstanceOf(InvalidDistractors);
    expect(none.llm.calls).toHaveLength(0);
  });

  // Phase 48 (spec D1, D3, ruling R1). Two cards planned, so the floor keeps
  // both. q1 offers its own answer as a wrong one: no three showable options, so
  // it is phase 27's degraded card, and the context call and the checker are
  // asked nothing for it.
  it('keeps a card validation refuses as a typed translation when the session has fewer than six (phase 48, spec D3)', async () => {
    const bad = JSON.stringify({
      items: [
        { key: 'q1', distractors: ['קראה', 'שמעה', 'ראתה'] },
        { key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] },
      ],
    });
    const { service, calls, logger, contextLlm, checkerLlm } = world({ reply: bad });
    await service.prepareSession(PAYLOAD);
    expect(calls.transitions).toEqual(['preparing→ready']);
    const [input] = calls.generated as { questions: { type: string; prompt: string | null; options: unknown[] | null; alternatives: string[] | null }[] }[];
    expect(input.questions.map((q) => q.type)).toEqual(['typed_translation', 'reverse_choice']);
    expect(input.questions[0]).toMatchObject({ prompt: 'קראה', options: null, alternatives: [] });
    expect(logger.events.filter((e) => e.event === 'card_kept_refused')).toEqual([
      {
        event: 'card_kept_refused',
        session_id: SESSION,
        key: 'q1',
        position: 0,
        type: 'multiple_choice',
        stage: 'validation',
        reason: 'q1 repeats the answer or another wrong answer (2 of 3 usable, 3 needed)',
        shown_as: 'typed_translation',
      },
    ]);
    expect(logger.events.filter((e) => e.event === 'card_dropped')).toEqual([]);
    const asked = (client: { calls: { user: string }[] }) => client.calls.flatMap((call) => (JSON.parse(call.user).items as { key: string }[]).map((item) => item.key));
    expect(asked(contextLlm)).toEqual(['q2']);
    expect(asked(checkerLlm)).toEqual(['q2']);
  });

  // Phase 48 (spec D1). A typed item cannot fail: the model leaving it out
  // leaves the card none of the model's alternatives, and the session is prepared.
  it('prepares a typed card the model did not answer, with no alternatives of the model’s (phase 48, spec D1)', async () => {
    const context = [
      ...CONTEXT,
      { glossId: 'g-s3', senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
    ];
    // GOOD answers q1 and q2 only.
    const { service, calls, logger } = world({ context, reply: GOOD });
    await service.prepareSession({ ...PAYLOAD, picks: [...PAYLOAD.picks, { gloss_id: 'g-s3', sense_id: 's3', variant_id: 'v3', ...produce(0.76) }] });
    expect(calls.transitions).toEqual(['preparing→ready']);
    const [input] = calls.generated as { questions: { type: string; alternatives: string[] | null }[] }[];
    expect(input.questions.map((q) => q.type)).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation']);
    expect(input.questions[2].alternatives).toEqual([]);
    expect(logger.events.filter((e) => e.event === 'card_dropped' || e.event === 'card_kept_refused')).toEqual([]);
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
type Card = Partial<{ dimension: string; rung: 1 | 2; level: number; r: number | null }>;
/** Ten picks, the first four new words (one board), then: a recognised word
 *  (multiple choice, p 0.925), a form picked (reverse choice, 0.78), a form
 *  typed (typed translation, 0.95), a word heard (listen and choose, 0.85), a
 *  form built (letter tiles, 0.9) and one more typed (typed cloze, 0.88).
 *  Highest p first: the board (q1-q4), typed translation q5, multiple choice
 *  q6, tiles q7, typed cloze q8, listen and choose q9, reverse choice q10. */
const TEN_CARDS: Card[] = [{}, {}, {}, {}, RECOGNISE, PICK_FORM, produce(0.95), HEAR, BUILD_FORM, produce(0.88)];
const tenPayload = (cards: Card[] = TEN_CARDS) => ({
  session_id: SESSION,
  picks: TEN.map((row, i) => ({ gloss_id: row.glossId, sense_id: row.senseId, variant_id: row.variantId, ...cards[i] })),
  listening: true,
});
const TEN_PAYLOAD = tenPayload();
// q1 is the board's first word, ромашка. Its first wrong meaning, צב, is a
// board word's own meaning, so the fifth meaning must be the next one.
const TEN_REPLY = JSON.stringify({
  items: [
    { key: 'q1', distractors: ['צב', 'שולחן', 'כיסא'] },
    { key: 'q5', distractors: [], alternatives: [] },
    { key: 'q6', distractors: ['דלת', 'קיר', 'תקרה'] },
    { key: 'q9', distractors: ['ענן', 'גשם', 'רוח'] },
    { key: 'q10', distractors: ['чеснок', 'морковь', 'капуста'] },
  ],
});

describe('prepareSession, phase 24 and 35 (spec D6, D10, D11)', () => {
  it('plans ten words by their cards, the board first, and writes each its content', async () => {
    const { service, calls, llm } = world({ context: TEN, reply: TEN_REPLY });
    await service.prepareSession(TEN_PAYLOAD);

    const asked = JSON.parse(llm.calls[0].user).items.map((item: { key: string; task: string }) => `${item.key}:${item.task}`);
    expect(asked).toEqual(['q1:meaning', 'q5:typed', 'q6:meaning', 'q8:sentence', 'q9:meaning', 'q10:word']);

    const [input] = calls.generated as {
      questions: { type: string; form: string; prompt: string | null; options: { text: string; is_correct: boolean }[] | null; tiles: string[] | null }[];
    }[];
    expect(input.questions.map((q) => q.type)).toEqual([
      'matching', 'matching', 'matching', 'matching',
      'typed_translation', 'multiple_choice', 'letter_tiles',
      // A typed cloze the reply left no sentence for: a typed translation.
      'typed_translation',
      'listen_choice', 'reverse_choice',
    ]);
    expect(input.questions.map((q) => q.form)).toEqual([0, 1, 2, 3, 6, 4, 8, 9, 7, 5].map((i) => FORMS[i]));
    expect(input.questions[0].options!.map((o) => o.text)).toEqual(['מרגנית', 'צב', 'כרית', 'מטרייה', 'שולחן']);
    expect(input.questions[1].options!.find((o) => o.is_correct)!.text).toBe('צב');
    expect(input.questions[6].tiles).toHaveLength([...'фонарь'].length + 2);
    expect(input.questions[7]).toMatchObject({ prompt: 'לטאה', options: null, tiles: null });

    const shown = calls.sessionQuestions[0] as { options?: string[] }[];
    for (const i of [1, 2, 3]) expect(shown[i].options).toEqual(shown[0].options);
  });

  // Phase 48 (spec D1, ruling R2). The board is refused whole, before the
  // context call and the checker are paid for it, and ten cards less four is
  // six: nothing refills it.
  it('drops a board refused at validation as a unit, and asks the context call and the checker nothing for it', async () => {
    // Each is valid for q1 (none is ромашка's own מרגנית), and each is another
    // board word's meaning: only the board check can refuse them.
    const reply = TEN_REPLY.replace('["צב","שולחן","כיסא"]', '["צב","כרית","מטרייה"]');
    const { service, calls, contextLlm, checkerLlm, logger } = world({ context: TEN, reply });
    await service.prepareSession(TEN_PAYLOAD);
    expect(calls.transitions).toEqual(['preparing→ready']);
    const [input] = calls.generated as { questions: { type: string }[] }[];
    expect(input.questions.map((q) => q.type)).toEqual(['typed_translation', 'multiple_choice', 'letter_tiles', 'typed_translation', 'listen_choice', 'reverse_choice']);
    const BOARD = ['q1', 'q2', 'q3', 'q4'];
    expect(logger.events.filter((e) => e.event === 'card_dropped')).toEqual(
      BOARD.map((key) => ({ event: 'card_dropped', session_id: SESSION, key, type: 'matching', stage: 'validation', reason: "every wrong meaning of the board is one of its words' own" })),
    );
    const asked = (client: { calls: { user: string }[] }) => client.calls.flatMap((call) => (JSON.parse(call.user).items as { key: string }[]).map((item) => item.key));
    expect(checkerLlm.calls).toHaveLength(1);
    for (const key of [...asked(contextLlm), ...asked(checkerLlm)]) expect(BOARD).not.toContain(key.replace(/c$/, ''));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 6, planned_count: 10, dropped_count: 4 }));
  });

  // Final review: a tiles card asks the model nothing, yet its meaning is as
  // off limits as an item's own. Phase 48 (spec D1, D3): the card is dropped,
  // and nine are left.
  it("refuses a wrong meaning that is another meaning of a listening card's word held by a tiles card", async () => {
    const context = TEN.map((row, i) => (i === 8 ? { ...row, form: TEN[7].form, lemma: TEN[7].form, translation: 'מחבת' } : row));
    const reply = TEN_REPLY.replace('["ענן","גשם","רוח"]', '["מחבת","גשם","רוח"]');
    const { service, calls, llm, logger } = world({ context, reply });
    await service.prepareSession(TEN_PAYLOAD);
    const [input] = calls.generated as { questions: { type: string }[] }[];
    expect(input.questions).toHaveLength(9);
    expect(input.questions.map((q) => q.type)).not.toContain('listen_choice');
    expect(logger.events.filter((e) => e.event === 'card_dropped')).toEqual([
      {
        event: 'card_dropped',
        session_id: SESSION,
        key: 'q9',
        type: 'listen_choice',
        stage: 'validation',
        reason: 'q9 offers another meaning of the same word as a wrong answer (2 of 3 usable, 3 needed)',
      },
    ]);
    // The model was told about the dictation's row.
    expect(JSON.parse(llm.calls[0].user).also_in_session).toEqual([{ word: TEN[7].form, correct: 'מחבת' }]);
    // Without it offered, the same session keeps its listening card.
    const fine = world({ context, reply: TEN_REPLY });
    await fine.service.prepareSession(TEN_PAYLOAD);
    const [kept] = fine.calls.generated as { questions: { type: string }[] }[];
    expect(kept.questions).toHaveLength(10);
    expect(kept.questions.map((q) => q.type)).toContain('listen_choice');
  });

  it('gives a listening-off session no listening card', async () => {
    // The word heard falls back to multiple choice (p 0.85), at the same place.
    const { service, calls } = world({ context: TEN, reply: TEN_REPLY });
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

  // The first word's spoken production is unintroduced: read aloud, when speaking.
  const SPEAK_PAYLOAD = { ...PAYLOAD, picks: [{ ...PAYLOAD.picks[0], ...SAY }, PAYLOAD.picks[1]] };

  it('plans a speaking card only when the payload says speaking', async () => {
    const on = world({ reply: JSON.stringify({ items: [{ key: 'q2', distractors: ['чеснок', 'морковь', 'капуста'] }] }) });
    await on.service.prepareSession({ ...SPEAK_PAYLOAD, speaking: true });
    expect(types(on.calls)).toEqual(['read_aloud', 'reverse_choice']);

    const off = world({});
    await off.service.prepareSession({ ...SPEAK_PAYLOAD, speaking: false });
    expect(types(off.calls)).toEqual(['multiple_choice', 'reverse_choice']);
  });

  it('reads a payload from before phase 25 as speaking off', async () => {
    const { service, calls } = world({});
    await service.prepareSession(SPEAK_PAYLOAD);
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

  // The recognised word picks its form too: the first form picked is a reverse
  // choice, the second, with a gap in its example, a cloze choice.
  const GAP_PAYLOAD = tenPayload(TEN_CARDS.map((card, i) => (i === 4 ? PICK_FORM : card)));

  it('asks a gap item with the blank taken from the saved example, and keeps that gap on the card', async () => {
    const probe = world({ context: EXAMPLES, reply: 'nope' });
    await expect(probe.service.prepareSession(GAP_PAYLOAD)).rejects.toThrow();
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
    await service.prepareSession(GAP_PAYLOAD);
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
      key: sentenceItem.key,
      position,
      type: 'cloze_typed',
      reason: expect.stringContaining('avoid'),
    });
  });

  it('hands a translate item the recent Hebrew sentences and the example\'s Hebrew, and degrades a card that repeats one', async () => {
    // Three forms typed: a typed translation, a typed cloze and a sentence translation.
    const PAYLOAD_T = tenPayload(TEN_CARDS.map((card, i) => (i === 4 ? produce(0.9) : card)));
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
      key: translate.key,
      position,
      type: 'sentence_translation',
      reason: expect.stringContaining('avoid'),
    });
  });

  it('plans no gap card for a saved example with no Hebrew half', async () => {
    const probe = world({ context: EXAMPLES.map((row) => ({ ...row, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null })), reply: 'nope' });
    await expect(probe.service.prepareSession(GAP_PAYLOAD)).rejects.toThrow();
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
    await service.prepareSession({ ...PAYLOAD, picks: [...PAYLOAD.picks, { gloss_id: 'g_book', sense_id: 's3', variant_id: 'v3', ...produce(0.76) }] });

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
  /** Each row's card from its pick (phase 35, spec D6): THREE unless `cards` says otherwise. */
  const payloadOf = (rows: GenerationContext[], { cards = THREE, ...over }: { cards?: object[] } & Record<string, unknown> = {}) => ({
    ...PAYLOAD,
    picks: rows.map((r, i) => ({ ...pickOf(r), ...cards[i] })),
    ...over,
  });
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
  async function prepare(rows: GenerationContext[], opts: { typed?: string[]; payload?: { cards?: object[] } & Record<string, unknown>; over?: Record<string, object> } = {}) {
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
      // A form built from tiles, second.
      const BUILT = { cards: [{}, BUILD_FORM, produce(0.7)] };
      const tiles = await prepare([FILLER[0], HOURS, FILLER[1]], { payload: BUILT });
      expect(tiles.questions[1]).toMatchObject({ type: 'letter_tiles', answerForm: 'ore' });
      const letters = tiles.questions[1].tiles!;
      expect(letters).toHaveLength(5);
      for (const letter of ['o', 'r', 'e']) expect(letters).toContain(letter);

      // A form that is two words has no tiles, so the plan asks another card.
      const phrase = row({ form: 'ora', lemma: 'ora', translation: 'שעות', acceptedAnswers: [], answerForm: 'ore di punta' }, 5);
      const planned = await prepare([FILLER[0], phrase, FILLER[1]], { payload: BUILT });
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
      const listening = await prepare([FILLER[0], FILLER[1], HOURS], { payload: { listening: true, cards: [{}, {}, SPELL] } });
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
      // First, a read aloud (p 1); last, after a typed translation, a typed cloze (p 0.9).
      const READ_FIRST = { speaking: true, cards: [SAY, PICK_FORM, produce(0.7)] };
      const CLOZE_LAST = { speaking: true, cards: [SAY, produce(0.95), produce(0.9)] };
      const asked = (made: { llm: { calls: { user: string }[] } }) =>
        (JSON.parse(made.llm.calls[0].user).items as { key: string; task: string }[]).map((item) => `${item.key}:${item.task}`);
      for (const long of [longForm, longAnswer]) {
        const first = await prepare([long, ...FILLER], { payload: READ_FIRST });
        expect(SPEAKING_OR_SENTENCE).not.toContain(first.questions[0].type);
        const last = await prepare([...FILLER, long], { payload: CLOZE_LAST });
        expect(SPEAKING_OR_SENTENCE).not.toContain(last.questions[2].type);
        expect(asked(last)).not.toContain('q3:sentence');
      }
      // The same word with both forms short is a speaking card and a sentence card, so the test above can fail.
      const short = row({ form: 'ora', lemma: 'ora', translation: 'שעות', answerForm: 'ore' }, 14);
      const planned = await prepare([short, ...FILLER], { payload: READ_FIRST });
      expect(planned.questions[0].type).toBe('read_aloud');
      expect(asked(await prepare([...FILLER, short], { payload: CLOZE_LAST }))).toContain('q3:sentence');
    });

    // Phase 48 (spec D3, ruling R1): refused, the card is never shown with it.
    // Three cards planned, so the floor keeps it, as a typed translation.
    it('never offers the answer form as a wrong option of the reversed card', async () => {
      const reply = (words: string[]) => ({ 'q2': { distractors: words } });
      const probe = world({ context: [FILLER[0], HOURS, FILLER[1]], reply: 'nope' });
      await expect(probe.service.prepareSession(payloadOf([FILLER[0], HOURS, FILLER[1]]))).rejects.toThrow();
      const bad = world({ context: [FILLER[0], HOURS, FILLER[1]], reply: answering([], reply(['tempo', 'ore', 'giorno']))(probe.llm) });
      await bad.service.prepareSession(payloadOf([FILLER[0], HOURS, FILLER[1]]));
      expect(insertedOf(bad.calls)[1]).toMatchObject({ type: 'typed_translation', answerForm: 'ore', options: null });
      expect(bad.logger.events).toContainEqual(
        expect.objectContaining({ event: 'card_kept_refused', key: 'q2', type: 'reverse_choice', stage: 'validation', reason: 'q2 repeats the answer or another wrong answer (2 of 3 usable, 3 needed)' }),
      );
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
      const spoken = await prepare([FILLER[0], FILLER[1], POI], { payload: { speaking: true, cards: [{}, {}, SAY_IT] } });
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
      // The tenth pick asks for a sentence (a typed cloze) the model does not write.
      const probe = world({ context: ten, reply: 'nope' });
      await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
      const reply = answering()(probe.llm);
      const { service, calls } = world({ context: ten, reply });
      await service.prepareSession(TEN_PAYLOAD);
      const last = insertedOf(calls).find((q) => q.form === TEN[9].form);
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
  // Phase 35 (spec D6). A sentence translation is a rung's third type: it comes
  // only after a typed translation and a typed cloze. These two bring them out,
  // asked last.
  const RIVER = row({ form: 'river', lemma: 'river', translation: 'נהר' }, 6);
  const BREAD = row({ form: 'bread', lemma: 'bread', translation: 'לחם' }, 7);
  const pickOf = (r: GenerationContext) => ({ gloss_id: r.glossId, sense_id: r.senseId, variant_id: r.variantId });
  /** Each row's card from its pick (phase 35, spec D6). */
  const payloadOf = (rows: GenerationContext[], cards: object[]) => ({ ...PAYLOAD, picks: rows.map((r, i) => ({ ...pickOf(r), ...cards[i] })) });

  type Inserted = {
    type: string; context?: string | null; contextTranslation?: string | null; contextMarkStart?: number | null; contextMarkEnd?: number | null;
    sentenceMarkStart?: number | null; sentenceMarkEnd?: number | null; sentenceTranslation?: string | null;
  };
  const insertedOf = (calls: { generated: unknown[] }) => (calls.generated[0] as { questions: Inserted[] }).questions;
  const contextCall = (contextLlm: { calls: { system: string; user: string }[] }) => contextLlm.calls.find((call) => call.system.includes(CONTEXT_MARKER));

  // Three picks: a multiple choice, a reversed card and a typed translation.
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

  // A typed meaning, a tiles card and a sentence translation, then river's typed
  // translation (q4) and bread's typed cloze (q5), which the sentence
  // translation needs before it (p 0.99, 0.9, 0.88, 0.6, 0.5).
  const SENTENCES = [SAW, LAMP, RIVER, BREAD, COMBINE];
  const SENTENCE_CARDS = [MEANING, BUILD_FORM, produce(0.6), produce(0.5), produce(0.88)];
  const SENTENCES_BATCH = JSON.stringify({
    items: [
      { key: 'q3', distractors: [], sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", gap: 'combine' },
      { key: 'q4', distractors: [], alternatives: [] },
      { key: 'q5', distractors: [], sentence: 'We bake bread every morning.', gap: 'bread', translation: 'אנחנו אופים לחם כל בוקר.', alternatives: [] },
    ],
  });
  const SENTENCES_CONTEXT = JSON.stringify({
    items: [
      { key: 'q1', context: 'Please saw the plank in half.', context_translation: 'בבקשה תנסר את הקרש לשניים.', context_word: 'saw' },
      { key: 'q3', sentence_word: 'נשלב' },
    ],
  });
  const SENTENCES_CHECK = checking({
    q1c: { context_meaning: 'לנסר' },
    q3: { natural_translation: "Let's combine forces." },
    q5: { natural_translation: 'We bake bread every morning.' },
  });

  it('category C (d388f738): the typed card for להוריד shows a Hebrew sentence, its word marked, and keeps the other half', async () => {
    const { service, calls } = world({ enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: CHOICES_CONTEXT, checkReply: CHOICES_CHECK });
    await service.prepareSession(payloadOf(CHOICES, THREE));
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
    await service.prepareSession(payloadOf(CHOICES, THREE));
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
    await service.prepareSession(payloadOf(SENTENCES, SENTENCE_CARDS));
    expect(llm.calls).toHaveLength(1);
    expect(contextLlm.calls).toHaveLength(1);
    expect(contextLlm.calls[0]).toBe(contextCall(contextLlm));
    const items = JSON.parse(contextCall(contextLlm)!.user).items;
    // The tiles card at q2 shows no sentence (spec D6: the letters pin the word).
    expect(items.map((item: { key: string; task: string }) => `${item.key}:${item.task}`)).toEqual(['q1:target', 'q3:mark', 'q4:explanation', 'q5:mark']);
    expect(items[1]).toMatchObject({ word: 'combine', sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces." });
  });

  it('category E (71b0b407): the typed meaning for saw shows a sentence with saw in the sense of לנסר, and keeps its Hebrew for the judge', async () => {
    const { service, calls } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: SENTENCES_CONTEXT, checkReply: SENTENCES_CHECK });
    await service.prepareSession(payloadOf(SENTENCES, SENTENCE_CARDS));
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
    await service.prepareSession(payloadOf(SENTENCES, SENTENCE_CARDS));
    expect(insertedOf(calls)[2]).toMatchObject({
      type: 'sentence_translation', sentenceTranslation: 'בואו נשלב כוחות.', sentenceMarkStart: 5, sentenceMarkEnd: 9, context: null,
    });
    expect(calls.sessionQuestions[0][2]).toMatchObject({ question: 'בואו נשלב כוחות.', mark: { start: 5, end: 9 } });
  });

  // Review Focus 4.
  it('keeps a sentence card unmarked when its word cannot be found in the Hebrew', async () => {
    const reply = SENTENCES_CONTEXT.replace('"sentence_word":"נשלב"', '"sentence_word":"לשלב"');
    const { service, calls } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: reply, checkReply: SENTENCES_CHECK });
    await service.prepareSession(payloadOf(SENTENCES, SENTENCE_CARDS));
    expect(insertedOf(calls)[2]).toMatchObject({ type: 'sentence_translation', sentenceTranslation: 'בואו נשלב כוחות.', sentenceMarkStart: null, sentenceMarkEnd: null });
  });

  // Ruling R11: a hint missing is today's card; a failed session is worse.
  it('prepares the session when the context call fails: each card falls back on its saved example, unmarked, and the failure is logged', async () => {
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: new Error('provider down') });
    await service.prepareSession(payloadOf(SENTENCES, SENTENCE_CARDS));
    expect(calls.transitions).toEqual(['preparing→ready']);
    const [meaning, , translation] = insertedOf(calls);
    expect(meaning).toMatchObject({ context: 'He will saw the branch off.', contextTranslation: 'הוא ינסר את הענף.', contextMarkStart: null });
    expect(translation).toMatchObject({ sentenceMarkStart: null, sentenceMarkEnd: null });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_call_failed', session_id: SESSION, item_count: 4, reason: 'provider down' }));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared' }));
  });

  it('treats an unreadable context answer as a failed call, not a failed session', async () => {
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: SENTENCES, reply: SENTENCES_BATCH, contextReply: 'nope' });
    await service.prepareSession(payloadOf(SENTENCES, SENTENCE_CARDS));
    expect(calls.transitions).toEqual(['preparing→ready']);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_call_failed', reason: expect.stringContaining('unreadable') }));
  });

  it('logs a card left with no sentence, when the model wrote none and the sense has no saved example', async () => {
    const rows = [{ ...SAW, example: null, exampleTranslation: null }, TABLE, DOWNLOAD];
    const reply = JSON.stringify({ items: JSON.parse(CHOICES_CONTEXT).items.filter((item: { key: string }) => item.key !== 'q1') });
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: rows, reply: CHOICES_BATCH, contextReply: reply });
    await service.prepareSession(payloadOf(rows, THREE));
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'multiple_choice', context: null });
    expect(logger.events).toContainEqual({ event: 'context_missing', session_id: SESSION, key: 'q1', position: 0, type: 'multiple_choice' });
  });

  it('reads the recent contexts in the read step, and drops a sentence one of them showed for the saved example', async () => {
    const recentContexts: RecentContexts = new Map([[DOWNLOAD.glossId, { typed_translation: ['אני רוצה להוריד את המשחק החדש הלילה'] }]]);
    const { service, calls, logger, contextLlm } = world({ enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: CHOICES_CONTEXT, checkReply: CHOICES_CHECK, recentContexts });
    await service.prepareSession(payloadOf(CHOICES, THREE));
    expect(calls.recentContextsAsked).toEqual([{ enrollmentId: 'e1', glossIds: CHOICES.map((r) => r.glossId), limit: 3 }]);
    // Told to the model as a sentence to avoid.
    expect(JSON.parse(contextCall(contextLlm)!.user).items[2].avoid).toContain('אני רוצה להוריד את המשחק החדש הלילה');
    expect(insertedOf(calls)[2]).toMatchObject({ context: 'אני צריך להוריד את הקובץ קודם.', contextTranslation: 'I need to download the file first.', contextMarkStart: null });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_dropped', position: 2, type: 'typed_translation', reason: expect.stringContaining('recent') }));
  });

  it('refuses a Hebrew sentence that holds an answer the card accepts, even one only this session listed', async () => {
    const reply = CHOICES_CONTEXT.replace('אני רוצה להוריד את המשחק החדש הלילה.', 'תעשה fetch למשחק החדש הלילה.');
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: reply });
    await service.prepareSession(payloadOf(CHOICES, THREE));
    expect(insertedOf(calls)[2]).toMatchObject({ context: 'אני צריך להוריד את הקובץ קודם.' });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_dropped', reason: expect.stringContaining('fetch') }));
  });

  it('asks no context call when no card shows a sentence', async () => {
    // One pick heard, with listening on: a listen choice, which shows none (spec D10).
    const { service, llm, contextLlm, calls } = world({
      enrollment: ENGLISH, context: [SAW], reply: JSON.stringify({ items: [{ key: 'q1', distractors: ['לשייף', 'לקדוח', 'לשבור'] }] }),
    });
    await service.prepareSession({ ...payloadOf([SAW], [HEAR]), listening: true });
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'listen_choice' });
    expect(llm.calls).toHaveLength(1);
    expect(contextLlm.calls).toHaveLength(0);
  });

  it('logs how long the context call took', async () => {
    const { service, logger } = world({
      enrollment: ENGLISH, context: CHOICES, reply: CHOICES_BATCH, contextReply: CHOICES_CONTEXT, checkReply: CHOICES_CHECK, clock: [1_000, 1_250, 2_000, 2_400],
    });
    await service.prepareSession(payloadOf(CHOICES, THREE));
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
  // Phase 35 (spec D6). A rung's later types come after its first: these bring
  // out a typed translation, a typed cloze and a reversed card, asked last.
  const RIVER = row({ form: 'river', lemma: 'river', partOfSpeech: 'noun', translation: 'נהר' }, 8);
  const BREAD = row({ form: 'bread', lemma: 'bread', partOfSpeech: 'noun', translation: 'לחם' }, 9);
  const CHAIR = row({ form: 'chair', lemma: 'chair', partOfSpeech: 'noun', translation: 'כיסא' }, 10);
  const pickOf = (r: GenerationContext) => ({ gloss_id: r.glossId, sense_id: r.senseId, variant_id: r.variantId });
  /** Each row's card from its pick (phase 35, spec D6): THREE unless told otherwise. */
  const payloadOf = (rows: GenerationContext[], cards: object[] = THREE) => ({ ...PAYLOAD, picks: rows.map((r, i) => ({ ...pickOf(r), ...cards[i] })) });
  type Inserted = { type: string; options: { text: string; is_correct: boolean }[] | null; context?: string | null; contextTranslation?: string | null; sentence: string | null; sentenceTranslation: string | null; alternatives: string[] | null };
  const insertedOf = (calls: { generated: unknown[] }) => (calls.generated[0] as { questions: Inserted[] }).questions;
  const optionTexts = (q: Inserted) => q.options!.map((o) => o.text);
  const events = (logger: { events: unknown[] }, name: string) => (logger.events as { event: string }[]).filter((e) => e.event === name);

  // Blow up on a multiple choice, table on a reversed card, download typed.
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
      { event: 'checker_dropped', session_id: SESSION, key: 'q1', position: 0, type: 'multiple_choice', kind: 'option', text: 'להרוס', reason: 'the checker calls it right' },
    ]);
  });

  // Review, fix round 1: the checker is never asked about more than six options,
  // the miscount risk that leaves a card unjudged and refused (phase 48, spec D2,
  // ruling R3). A seventh never gets past the parse (LlmDistractorsSchema), and
  // validateDistractors keeps at most six.
  it('asks the checker about at most six options of a card, and never sees a seventh', async () => {
    const six = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG) });
    await six.service.prepareSession(payloadOf(CHOICES));
    expect(checksOf(six.checkerLlm.calls[0]).filter((item) => item.task === 'choice').map((item) => item.options!.length)).toEqual([6, 6]);

    const seven = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch([...SIX_WRONG, 'לשחות']) });
    await expect(seven.service.prepareSession(payloadOf(CHOICES))).rejects.toBeInstanceOf(InvalidDistractors);
    expect(seven.checkerLlm.calls).toHaveLength(0);
  });

  // Review Focus 5.
  it('keeps a card three wrong options survive the checker for, the spares in the places of the rest', async () => {
    const three = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: checking({ q1: { options: [true, true, true, false, false, false] } }) });
    await three.service.prepareSession(payloadOf(CHOICES));
    expect(optionTexts(insertedOf(three.calls)[0])).toEqual(['לנפח', 'לצבוע', 'לבשל', 'לכתוב']);
    expect(events(three.logger, 'card_kept_refused')).toEqual([]);
  });

  // Phase 48 (spec D2, D3, D6). Three cards planned, so the floor keeps one the
  // checker leaves no three wrong options, as generated: Victor's call, an
  // ambiguous card over a failed session. It logs no checker_dropped for the
  // options it still shows.
  it('keeps a card the checker refuses entirely when the session has fewer than six (phase 48, spec D3)', async () => {
    const yes = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: checking({ q1: { options: SIX_WRONG.map(() => true) } }) });
    await yes.service.prepareSession(payloadOf(CHOICES));
    expect(yes.calls.transitions).toEqual(['preparing→ready']);
    expect(optionTexts(insertedOf(yes.calls)[0])).toEqual(['לנפח', 'להרוס', 'לקפל', 'לשבור']);
    expect(events(yes.logger, 'card_kept_refused')).toEqual([
      expect.objectContaining({ key: 'q1', position: 0, stage: 'checker', shown_as: 'as_generated', reason: "the checker calls 6 of q1's 6 wrong options right, and 3 must be left" }),
    ]);
    expect(events(yes.logger, 'checker_dropped')).toEqual([]);
    expect(events(yes.logger, 'session_preparation_attempt_failed')).toEqual([]);
  });

  // Phase 48 (spec D3). Two survive the checker, which is fewer than three: the
  // card kept as generated shows them first, then the first it called right.
  it('shows a card kept as generated with the checker’s survivors first (phase 48, spec D3)', async () => {
    const { service, calls, logger } = world({
      enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: checking({ q1: { options: [true, false, true, true, false, true] } }),
    });
    await service.prepareSession(payloadOf(CHOICES));
    expect(optionTexts(insertedOf(calls)[0])).toEqual(['לנפח', 'לקפל', 'לבשל', 'להרוס']);
    expect(events(logger, 'card_kept_refused')).toEqual([
      expect.objectContaining({ key: 'q1', reason: "the checker calls 4 of q1's 6 wrong options right, and 3 must be left", shown_as: 'as_generated' }),
    ]);
    expect(events(logger, 'checker_dropped')).toEqual([]);
  });

  // Phase 48 (spec D2, ruling R3). A miscount refuses its card only, and the
  // floor keeps it, as generated.
  it('keeps a card the checker miscounted, refused, when the session has fewer than six (phase 48, ruling R3)', async () => {
    const { service, calls, logger } = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: checking({ q1: { options: [false, false] } }) });
    await service.prepareSession(payloadOf(CHOICES));
    expect(calls.transitions).toEqual(['preparing→ready']);
    expect(optionTexts(insertedOf(calls)[0])).toEqual(['לנפח', 'להרוס', 'לקפל', 'לשבור']);
    expect(events(logger, 'card_kept_refused')).toEqual([
      {
        event: 'card_kept_refused',
        session_id: SESSION,
        key: 'q1',
        position: 0,
        type: 'multiple_choice',
        stage: 'checker',
        reason: "the checker did not say which of q1's 6 options are right",
        shown_as: 'as_generated',
      },
    ]);
    expect(events(logger, 'checker_dropped')).toEqual([]);
  });

  it('fails the batch, writing nothing, on a checker answer that is unreadable, empty, or never comes', async () => {
    for (const checkReply of ['nope', '', new Error('provider down')]) {
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
      { event: 'checker_dropped', session_id: SESSION, key: 'q1', position: 0, type: 'multiple_choice', kind: 'context', text: 'Please saw the plank in half.', reason: 'the checker reads it as ראה' },
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
    expect(logger.events).toContainEqual({ event: 'context_missing', session_id: SESSION, key: 'q2', position: 1, type: 'reverse_choice' });
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
    // A typed meaning, a tiles card and the sentence translation, then river's
    // typed translation and bread's typed cloze, which it needs before it.
    const rows = [SAW, LAMP, RIVER, BREAD, COMBINE];
    const cards = [MEANING, BUILD_FORM, produce(0.6), produce(0.5), produce(0.88)];
    const batch = JSON.stringify({
      items: [
        { key: 'q3', distractors: [], sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", gap: 'combine' },
        { key: 'q4', distractors: [], alternatives: [] },
        { key: 'q5', distractors: [], sentence: 'We bake bread every morning.', gap: 'bread', translation: 'אנחנו אופים לחם כל בוקר.', alternatives: [] },
      ],
    });
    const contexts = JSON.stringify({ items: [{ key: 'q3', sentence_word: 'נשלב' }] });
    const bread = { q5: { natural_translation: 'We bake bread every morning.' } };
    const joined = world({ enrollment: ENGLISH, context: rows, reply: batch, contextReply: contexts, checkReply: checking({ ...bread, q3: { natural_translation: "Let's join forces." } }) });
    await joined.service.prepareSession(payloadOf(rows, cards));
    expect(insertedOf(joined.calls)[2]).toMatchObject({ type: 'typed_translation', sentence: null, sentenceTranslation: null, context: null });
    expect(events(joined.logger, 'checker_dropped')).toEqual([
      expect.objectContaining({ position: 2, type: 'sentence_translation', kind: 'sentence', text: 'בואו נשלב כוחות.', reason: expect.stringContaining("Let's join forces.") }),
    ]);
    expect(events(joined.logger, 'sentence_degraded')).toEqual([expect.objectContaining({ position: 2, type: 'sentence_translation' })]);
    expect(checksOf(joined.checkerLlm.calls[0]).find((item) => item.key === 'q3')).toEqual({ key: 'q3', task: 'translate', sentence: 'בואו נשלב כוחות.' });

    // The same sentence, read naturally with combine, is kept.
    const combined = world({ enrollment: ENGLISH, context: rows, reply: batch, contextReply: contexts, checkReply: checking({ ...bread, q3: { natural_translation: "Let's combine our forces." } }) });
    await combined.service.prepareSession(payloadOf(rows, cards));
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
    // A typed meaning alone, its context call failed: no option, no written sentence.
    const { service, calls, checkerLlm, logger } = world({ enrollment: ENGLISH, context: [SAW], reply: JSON.stringify({ items: [] }), contextReply: new Error('down') });
    await service.prepareSession(payloadOf([SAW], [MEANING]));
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'typed_meaning', context: 'He will saw the branch off.' });
    expect(checkerLlm.calls).toHaveLength(0);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', checker_ms: 0, check_count: 0 }));
  });

  // Review, fix round 1. A cloze choice is checked as a gap: the saved example
  // with its gap written ___, and "does the sentence still read correctly?".
  describe('the cloze choice (spec D5)', () => {
    // Speaking and listening off: a typed meaning, a cloze choice (download's
    // saved example holds it once) and a typed cloze, then chair's reversed card
    // and river's typed translation, which the two before need first (p 0.99,
    // 0.78, 0.7, 0.66, 0.6).
    const rows = [SAW, CHAIR, DOWNLOAD, RIVER, COMBINE];
    const cards = [MEANING, { ...PICK_FORM, r: 0.3 }, PICK_FORM, produce(0.6), produce(0.7)];
    const GAP_WRONG = ['eat', 'sleep', 'sing', 'dance', 'swim'];
    const batch = JSON.stringify({
      items: [
        { key: 'q2', distractors: GAP_WRONG },
        { key: 'q3', distractors: [], sentence: 'We combine the two plans today.', gap: 'combine', translation: 'אנחנו משלבים את שתי התוכניות היום.', alternatives: [] },
        { key: 'q4', distractors: ['table', 'door', 'wall'] },
        { key: 'q5', distractors: [], alternatives: [] },
      ],
    });
    const natural = { q3: { natural_translation: 'We combine the two plans today.' } };

    it('sends the checker the saved example with its gap written ___, and every usable option', async () => {
      const { service, calls, checkerLlm } = world({ enrollment: ENGLISH, context: rows, reply: batch, checkReply: checking(natural) });
      await service.prepareSession(payloadOf(rows, cards));
      expect(insertedOf(calls).map((q) => q.type)).toEqual(['typed_meaning', 'cloze_choice', 'cloze_typed', 'reverse_choice', 'typed_translation']);
      expect(checksOf(checkerLlm.calls[0]).find((item) => item.key === 'q2')).toEqual({
        key: 'q2', task: 'gap', sentence: 'I need to ___ the file first.', options: GAP_WRONG,
      });
      expect(optionTexts(insertedOf(calls)[1])).toEqual(['download', 'eat', 'sleep', 'sing']);
    });

    it('drops an option the checker says still fits the gap, and the next spare takes its place', async () => {
      const { service, calls, logger } = world({
        enrollment: ENGLISH, context: rows, reply: batch, checkReply: checking({ ...natural, q2: { gap_fits: [false, true, false, false, false] } }),
      });
      await service.prepareSession(payloadOf(rows, cards));
      expect(optionTexts(insertedOf(calls)[1])).toEqual(['download', 'eat', 'sing', 'dance']);
      expect(events(logger, 'checker_dropped')).toEqual([
        { event: 'checker_dropped', session_id: SESSION, key: 'q2', position: 1, type: 'cloze_choice', kind: 'option', text: 'sleep', reason: 'the checker calls it right' },
      ]);
    });

    // Phase 48 (spec D2, D3). Lane 0's 38b003b4 (cream) on a small session: the
    // checker says every option fits the gap, and the floor keeps the card as
    // generated, with its first three options.
    it('drops nothing in a five-card session when the checker says every gap option fits', async () => {
      const { service, calls, logger } = world({
        enrollment: ENGLISH, context: rows, reply: batch, checkReply: checking({ ...natural, q2: { gap_fits: [true, true, true, true, true] } }),
      });
      await service.prepareSession(payloadOf(rows, cards));
      expect(calls.transitions).toEqual(['preparing→ready']);
      expect(insertedOf(calls).map((q) => q.type)).toEqual(['typed_meaning', 'cloze_choice', 'cloze_typed', 'reverse_choice', 'typed_translation']);
      expect(optionTexts(insertedOf(calls)[1])).toEqual(['download', 'eat', 'sleep', 'sing']);
      expect(events(logger, 'card_kept_refused')).toEqual([
        {
          event: 'card_kept_refused',
          session_id: SESSION,
          key: 'q2',
          position: 1,
          type: 'cloze_choice',
          stage: 'checker',
          reason: "the checker calls 5 of q2's 5 wrong options right, and 3 must be left",
          shown_as: 'as_generated',
        },
      ]);
      expect(events(logger, 'card_dropped')).toEqual([]);
      expect(events(logger, 'checker_dropped')).toEqual([]);
    });
  });

  describe('the board (spec D3, D5, D10)', () => {
    // TEN with listening on (phase 35, spec D6): the four new words are the
    // board, positions 0 to 3, q1 its first word.
    const BOARD_REPLY = TEN_REPLY.replace('["צב","שולחן","כיסא"]', '["שולחן","כיסא","מנורה","ספה"]');

    it('asks the checker about the fifth meaning against each of the four words, and skips one any of them makes right', async () => {
      const { service, calls, checkerLlm, logger } = world({
        context: TEN, reply: BOARD_REPLY, checkReply: checking({ q3: { options: [true, false, false, false] } }),
      });
      await service.prepareSession(TEN_PAYLOAD);
      const boardChecks = checksOf(checkerLlm.calls[0]).filter((item) => ['q1', 'q2', 'q3', 'q4'].includes(item.key));
      expect(boardChecks).toEqual(['ромашка', 'черепаха', 'подушка', 'зонтик'].map((word, i) => ({ key: `q${i + 1}`, task: 'choice', word, options: ['שולחן', 'כיסא', 'מנורה', 'ספה'] })));
      expect(insertedOf(calls)[0].options!.map((o) => o.text)).toEqual(['מרגנית', 'צב', 'כרית', 'מטרייה', 'כיסא']);
      expect(events(logger, 'checker_dropped')).toContainEqual(expect.objectContaining({ position: 0, type: 'matching', kind: 'option', text: 'שולחן' }));
    });

    // Phase 48 (spec D2, ruling R2). Every candidate is right for a board word:
    // the board is refused whole, and ten cards less four is six.
    it('drops a board the checker leaves no fifth meaning', async () => {
      const { service, calls, logger } = world({ context: TEN, reply: BOARD_REPLY, checkReply: checking({ q1: { options: [true, true, true, true] } }) });
      await service.prepareSession(TEN_PAYLOAD);
      expect(calls.transitions).toEqual(['preparing→ready']);
      expect(insertedOf(calls)).toHaveLength(6);
      expect(insertedOf(calls).map((q) => q.type)).not.toContain('matching');
      expect(events(logger, 'card_dropped')).toEqual(
        ['q1', 'q2', 'q3', 'q4'].map((key) => ({ event: 'card_dropped', session_id: SESSION, key, type: 'matching', stage: 'checker', reason: "every wrong meaning of the board is one of its words' own" })),
      );
      // A dropped card logs nothing else.
      expect(events(logger, 'checker_dropped')).toEqual([]);
    });

    it('category A (1d268882): never takes a board word’s own known meaning as the fifth', async () => {
      // черепаха (position 1) also means כיסא to the dictionary.
      const known: KnownRight = { ...nothingKnown(), meaningsByLexeme: new Map([['l1', ['צב', 'כיסא']]]) };
      const { service, calls } = world({ context: TEN, reply: BOARD_REPLY, known, checkReply: checking({ q3: { options: [true, false, false, false] } }) });
      await service.prepareSession(TEN_PAYLOAD);
      expect(insertedOf(calls)[0].options!.map((o) => o.text)).toEqual(['מרגנית', 'צב', 'כרית', 'מטרייה', 'מנורה']);
    });

    it('keeps two words whose meanings the dictionary overlaps off one board', async () => {
      const boardOf = (calls: { generated: unknown[] }) =>
        (calls.generated[0] as { questions: { form: string; type: string }[] }).questions.filter((q) => q.type === 'matching').map((q) => q.form);
      const plain = world({ context: TEN, reply: TEN_REPLY });
      await plain.service.prepareSession(TEN_PAYLOAD);
      expect(boardOf(plain.calls)).toEqual(['ромашка', 'черепаха', 'подушка', 'зонтик']);
      // подушка (pick 2) is also צב to the dictionary, черепаха's meaning on the
      // board: the board takes the next multiple choice, ведро, and подушка is a
      // card of its own. The positions move, so the batch is answered by task.
      const known: KnownRight = { ...nothingKnown(), meaningsByLexeme: new Map([['l2', ['כרית', 'צב']]]) };
      const probe = world({ context: TEN, reply: 'nope', known });
      await expect(probe.service.prepareSession(TEN_PAYLOAD)).rejects.toThrow();
      const reply = JSON.stringify({
        items: (JSON.parse(probe.llm.calls[0].user).items as { key: string; task: string }[]).map((item) =>
          item.task === 'meaning'
            ? { key: item.key, distractors: ['דלת', 'קיר', 'תקרה'] }
            : item.task === 'word'
              ? { key: item.key, distractors: ['чеснок', 'морковь', 'капуста'] }
              : { key: item.key, distractors: [], alternatives: [] },
        ),
      });
      const overlapping = world({ context: TEN, reply, known });
      await overlapping.service.prepareSession(TEN_PAYLOAD);
      expect(boardOf(overlapping.calls)).toEqual(['ромашка', 'черепаха', 'зонтик', 'ведро']);
    });

    // Phase 48 (spec D3, ruling R1). Seven picks: the four new words are the
    // board (q1-q4), then a typed translation (q5), a multiple choice (q6) and a
    // reverse choice (q7). The board is refused at validation, three cards pass,
    // and three is fewer than six, so the fill takes the board whole, and
    // validation left it no options to show: each word is a typed translation.
    it('keeps a board refused at validation as four typed translations when the session would hold fewer than six', async () => {
      const seven = TEN.slice(0, 7);
      const payload = { ...tenPayload(), picks: tenPayload().picks.slice(0, 7) };
      // Each wrong meaning of q1 is another board word's own, as above.
      const reply = JSON.stringify({
        items: [
          { key: 'q1', distractors: ['צב', 'כרית', 'מטרייה'] },
          { key: 'q5', distractors: [], alternatives: [] },
          { key: 'q6', distractors: ['דלת', 'קיר', 'תקרה'] },
          { key: 'q7', distractors: ['чеснок', 'морковь', 'капуста'] },
        ],
      });
      const { service, calls, contextLlm, checkerLlm, logger } = world({ context: seven, reply });
      await service.prepareSession(payload);
      expect(calls.transitions).toEqual(['preparing→ready']);
      // The plan's order: the board's words first, then q5, q6 and q7 (picks 6, 4 and 5).
      expect(calls.sessionQuestions[0]).toHaveLength(7);
      expect(insertedOf(calls).map((q) => q.type)).toEqual([
        'typed_translation', 'typed_translation', 'typed_translation', 'typed_translation',
        'typed_translation', 'multiple_choice', 'reverse_choice',
      ]);
      const written = (calls.generated[0] as { questions: { form: string; prompt: string | null; options: unknown[] | null }[] }).questions;
      expect(written.map((q) => q.form)).toEqual([0, 1, 2, 3, 6, 4, 5].map((i) => FORMS[i]));
      // The board's four show their meaning and take a typed answer: no options.
      written.slice(0, 4).forEach((q, i) => expect(q).toMatchObject({ prompt: MEANINGS[i], options: null }));
      // The cards that passed are as generated.
      expect(insertedOf(calls)[5].options!.map((o) => o.text)).toEqual([MEANINGS[4], 'דלת', 'קיר', 'תקרה']);
      expect(insertedOf(calls)[6].options!.map((o) => o.text)).toEqual([FORMS[5], 'чеснок', 'морковь', 'капуста']);
      expect(events(logger, 'card_kept_refused')).toEqual(
        ['q1', 'q2', 'q3', 'q4'].map((key, position) => ({
          event: 'card_kept_refused',
          session_id: SESSION,
          key,
          position,
          type: 'matching',
          stage: 'validation',
          reason: "every wrong meaning of the board is one of its words' own",
          shown_as: 'typed_translation',
        })),
      );
      expect(events(logger, 'card_dropped')).toEqual([]);
      // Refused at validation, the board is asked of neither the context call nor the checker.
      const asked = (client: { calls: { user: string }[] }) => client.calls.flatMap((call) => (JSON.parse(call.user).items as { key: string }[]).map((item) => item.key.replace(/c$/, '')));
      for (const key of [...asked(contextLlm), ...asked(checkerLlm)]) expect(['q1', 'q2', 'q3', 'q4']).not.toContain(key);
      expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 7, planned_count: 7, dropped_count: 0 }));
    });

    // Phase 48 (spec D2, ruling R3). One board word the checker miscounted
    // leaves the fifth meaning unjudged for that word, so the board is refused
    // whole; ten cards less four is six, and nothing refills it.
    it('drops a board when the checker miscounts only one of its words', async () => {
      const { service, calls, logger } = world({ context: TEN, reply: BOARD_REPLY, checkReply: checking({ q2: { options: [true] } }) });
      await service.prepareSession(TEN_PAYLOAD);
      expect(calls.transitions).toEqual(['preparing→ready']);
      expect(insertedOf(calls)).toHaveLength(6);
      expect(insertedOf(calls).map((q) => q.type)).not.toContain('matching');
      expect(events(logger, 'card_dropped')).toEqual(
        ['q1', 'q2', 'q3', 'q4'].map((key) => ({
          event: 'card_dropped',
          session_id: SESSION,
          key,
          type: 'matching',
          stage: 'checker',
          reason: "the checker did not say which of q2's 4 options are right",
        })),
      );
      expect(events(logger, 'card_kept_refused')).toEqual([]);
      expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 6, planned_count: 10, dropped_count: 4 }));
    });
  });
});

// Phase 39 (spec D6). A new gloss of a word the learner already knows is a
// new_meaning card. It goes through exactly the multiple-choice paths (its
// distractor item, its context item, its checker items and the checker's
// surviving options); only the stored row differs: its type, and the known
// meanings its pick carries.
describe('prepareSession, phase 39 (spec D6): the new_meaning card', () => {
  const ENGLISH: Enrollment = { ...ENROLLMENT, target_language: 'en' };
  const STAMP = new Date('2026-10-11T10:00:00Z');
  const row = (over: Partial<GenerationContext> & Pick<GenerationContext, 'form' | 'lemma' | 'translation'>, n: number): GenerationContext => ({
    glossId: `g-n${n}`, senseId: `sn${n}`, variantId: `vn${n}`, lexemeId: `ln${n}`, partOfSpeech: 'verb',
    example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: STAMP, ...over,
  });
  // pick up's new gloss, לאסוף; the learner already knows it as להרים.
  const PICK_UP = row({ form: 'pick up', lemma: 'pick up', translation: 'לאסוף', example: 'Pick up your toys.', exampleTranslation: 'תאסוף את הצעצועים שלך.' }, 1);
  const TABLE = row({ form: 'table', lemma: 'table', partOfSpeech: 'noun', translation: 'שולחן' }, 2);
  const DOWNLOAD = row({ form: 'download', lemma: 'download', translation: 'להוריד', acceptedAnswers: ['get'] }, 3);
  const pickOf = (r: GenerationContext) => ({ gloss_id: r.glossId, sense_id: r.senseId, variant_id: r.variantId });
  /** A new word, a reversed card and a typed translation (THREE); the new word
   *  is a new meaning of a known one when its pick carries `known`. */
  const payloadOf = (rows: GenerationContext[], known?: string[]) => ({
    ...PAYLOAD,
    picks: rows.map((r, i) => ({ ...pickOf(r), ...THREE[i], ...(i === 0 && known ? { known_meanings: known } : {}) })),
  });
  // Phase 34 (spec D3): the dictionary knows להרים for pick up, so it is never a wrong option.
  const KNOWN: KnownRight = { ...nothingKnown(), meaningsByLexeme: new Map([['ln1', ['להרים', 'לאסוף']]]) };
  const BATCH = JSON.stringify({
    items: [
      { key: 'q1', distractors: ['להרים', 'לבשל', 'לשבור', 'לנגן', 'לכתוב', 'לשיר'] },
      { key: 'q2', distractors: ['chair', 'door', 'wall'] },
      { key: 'q3', distractors: [], alternatives: ['fetch'] },
    ],
  });
  const SENTENCE = "She'll pick up the kids at five.";
  const contextReply = (sentence: string, word: string) =>
    JSON.stringify({
      items: [
        { key: 'q1', context: sentence, context_translation: 'היא תאסוף את הילדים בחמש.', context_word: word },
        { key: 'q2', context: 'השולחן במטבח עשוי מעץ.', context_translation: 'The kitchen table is made of wood.', context_word: 'השולחן' },
        { key: 'q3', context: 'אני רוצה להוריד את המשחק החדש הלילה.', context_translation: 'I want to download the new game tonight.', context_word: 'להוריד' },
      ],
    });
  // The checker calls לבשל right too, and reads each sentence as the writer meant it.
  const CHECK = checking({ q1: { options: [true, false, false, false, false] }, q1c: { context_meaning: 'לאסוף' }, q2c: { context_words: ['table'] }, q3c: { context_words: ['download'] } });
  type Inserted = {
    type: string; knownMeanings?: string[] | null; prompt: string | null; answerForm: string | null; options: { text: string; is_correct: boolean }[] | null;
    context: string | null; contextTranslation: string | null; contextMarkStart: number | null; contextMarkEnd: number | null;
  };
  const insertedOf = (calls: { generated: unknown[] }) => (calls.generated[0] as { questions: Inserted[] }).questions;
  const events = (logger: { events: unknown[] }, name: string) => (logger.events as { event: string }[]).filter((e) => e.event === name);
  async function prepared(opts: { known?: string[]; first?: GenerationContext; sentence?: string; word?: string; recentContexts?: RecentContexts } = {}) {
    const rows = [opts.first ?? PICK_UP, TABLE, DOWNLOAD];
    const w = world({
      enrollment: ENGLISH, context: rows, reply: BATCH, contextReply: contextReply(opts.sentence ?? SENTENCE, opts.word ?? 'pick up'),
      checkReply: CHECK, known: KNOWN, recentContexts: opts.recentContexts,
    });
    await w.service.prepareSession(payloadOf(rows, opts.known));
    return w;
  }

  it('stores a pick with known meanings as a new_meaning: the checked options, the sentence and the known meanings', async () => {
    const { calls, logger } = await prepared({ known: ['להרים'] });
    const [card] = insertedOf(calls);
    const at = SENTENCE.indexOf('pick up');
    expect(card).toMatchObject({
      type: 'new_meaning',
      knownMeanings: ['להרים'],
      prompt: null,
      context: SENTENCE,
      contextTranslation: 'היא תאסוף את הילדים בחמש.',
      contextMarkStart: at,
      contextMarkEnd: at + 'pick up'.length,
    });
    // להרים is known right; the checker took לבשל, and the first spare took its place.
    expect(card.options).toEqual([
      { position: 0, text: 'לאסוף', is_correct: true },
      { position: 1, text: 'לשבור', is_correct: false },
      { position: 2, text: 'לנגן', is_correct: false },
      { position: 3, text: 'לכתוב', is_correct: false },
    ]);
    expect(events(logger, 'checker_dropped')).toEqual([
      { event: 'checker_dropped', session_id: SESSION, key: 'q1', position: 0, type: 'new_meaning', kind: 'option', text: 'לבשל', reason: 'the checker calls it right' },
    ]);
    // As the card reaches the phone.
    expect(calls.sessionQuestions[0][0]).toMatchObject({
      type: 'new_meaning', question: 'pick up', known_meanings: ['להרים'], context: { text: SENTENCE, mark: { start: at, end: at + 'pick up'.length } },
    });
  });

  it('asks the model what a multiple choice asks: a meaning item, a target sentence, a choice check and a meaning check', async () => {
    const { llm, contextLlm, checkerLlm } = await prepared({ known: ['להרים'] });
    expect(JSON.parse(llm.calls[0].user).items[0]).toMatchObject({ key: 'q1', task: 'meaning' });
    expect(JSON.parse(contextLlm.calls[0].user).items[0]).toMatchObject({ key: 'q1', task: 'target' });
    const checks = checksOf(checkerLlm.calls[0]).filter((item) => item.key === 'q1' || item.key === 'q1c');
    expect(checks).toEqual([
      { key: 'q1', task: 'choice', word: 'pick up', options: ['לבשל', 'לשבור', 'לנגן', 'לכתוב', 'לשיר'] },
      { key: 'q1c', task: 'meaning', sentence: SENTENCE, word: 'pick up', candidates: expect.arrayContaining(['לאסוף', 'להרים']) },
    ]);
  });

  it('is generated exactly as the multiple choice: the same requests, the same row but its type and known meanings', async () => {
    const formed = { ...PICK_UP, answerForm: 'picked up' };
    for (const opts of [{}, { first: formed, sentence: 'She picked up the kids at five.', word: 'picked up' }]) {
      const meaning = await prepared({ ...opts, known: ['להרים'] });
      const choice = await prepared(opts);
      const asked = (llm: { calls: LlmJsonRequest[] }) => llm.calls.map(({ system, user }) => ({ system, user }));
      expect(asked(meaning.llm)).toEqual(asked(choice.llm));
      expect(asked(meaning.contextLlm)).toEqual(asked(choice.contextLlm));
      expect(asked(meaning.checkerLlm)).toEqual(asked(choice.checkerLlm));
      const [asMeaning, ...meaningRest] = insertedOf(meaning.calls);
      const [asChoice, ...choiceRest] = insertedOf(choice.calls);
      expect(asChoice.type).toBe('multiple_choice');
      expect({ ...asMeaning, type: asChoice.type, knownMeanings: asChoice.knownMeanings }).toEqual(asChoice);
      expect(meaningRest).toEqual(choiceRest);
    }
    // The answer form is asked and shown as on a multiple choice (phase 34 D2).
    const { calls } = await prepared({ first: formed, sentence: 'She picked up the kids at five.', word: 'picked up', known: ['להרים'] });
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'new_meaning', answerForm: 'picked up' });
    expect(calls.sessionQuestions[0][0]).toMatchObject({ type: 'new_meaning', question: 'picked up' });
  });

  it('logs a new_meaning left with no sentence, as it logs a multiple choice', async () => {
    const bare = { ...PICK_UP, example: null, exampleTranslation: null };
    const { calls, logger } = await prepared({ known: ['להרים'], first: bare, sentence: 'Nothing here uses it.' });
    expect(insertedOf(calls)[0]).toMatchObject({ type: 'new_meaning', context: null });
    expect(events(logger, 'context_missing')).toEqual([{ event: 'context_missing', session_id: SESSION, key: 'q1', position: 0, type: 'new_meaning' }]);
  });

  // findRecentContexts files a new_meaning's sentences under multiple_choice,
  // newest first across both and capped once (repo/questions.ts).
  it('avoids the sentences the gloss last showed as a multiple choice or a new_meaning, either way round', async () => {
    const recentContexts: RecentContexts = new Map([[PICK_UP.glossId, { multiple_choice: ['An old new meaning sentence.', 'An old choice sentence.'] }]]);
    for (const known of [['להרים'], undefined]) {
      const { contextLlm } = await prepared({ known, recentContexts });
      expect(JSON.parse(contextLlm.calls[0].user).items[0].avoid).toEqual(['Pick up your toys.', 'An old new meaning sentence.', 'An old choice sentence.']);
    }
  });

  // Review Focus: a job enqueued before the deploy carries no known_meanings.
  // An empty list is none.
  it('prepares an old job’s pick, without known meanings, exactly as before: a multiple choice, with none stored', async () => {
    for (const known of [undefined, []]) {
      const { calls } = await prepared({ known });
      const [card] = insertedOf(calls);
      expect(card).toMatchObject({ type: 'multiple_choice', context: SENTENCE });
      expect(card.knownMeanings ?? null).toBeNull();
      expect(calls.sessionQuestions[0][0]).not.toHaveProperty('known_meanings');
    }
  });
});

// Phase 48 (spec D3, D4, D6). A card validation or the checker refuses no longer
// fails the session: it is dropped, or kept anyway while the session would hold
// fewer than six.
describe('prepareSession, phase 48 (spec D3, D4, D6): a refused card is dropped, or kept to reach six', () => {
  type Inserted = { type: string; form: string; options: { text: string }[] | null };
  const insertedOf = (calls: { generated: unknown[] }) => (calls.generated[0] as { questions: Inserted[] }).questions;
  const events = (logger: { events: unknown[] }, name: string) => (logger.events as { event: string }[]).filter((e) => e.event === name);
  // TEN's multiple choice (q6, plan index 5) and reverse choice (q10, index 9),
  // each with three wrong options, all of them called right.
  const ALL_RIGHT = { options: [true, true, true] };

  it('positions close up after a drop, and events name the written position (phase 48, spec D4, D6, ruling R5)', async () => {
    const { service, calls, logger } = world({ context: TEN, reply: TEN_REPLY, checkReply: checking({ q6: ALL_RIGHT }) });
    await service.prepareSession(TEN_PAYLOAD);
    // Nine, in the plan's order without index 5, at positions 0 to 8.
    expect(calls.sessionQuestions[0]).toHaveLength(9);
    expect(calls.sessionQuestions[0].map((q) => q.id)).toEqual(Array.from({ length: 9 }, (_, at) => `g${at}`));
    expect(insertedOf(calls).map((q) => q.form)).toEqual([0, 1, 2, 3, 6, 8, 9, 7, 5].map((i) => FORMS[i]));
    expect(events(logger, 'card_dropped')).toEqual([
      { event: 'card_dropped', session_id: SESSION, key: 'q6', type: 'multiple_choice', stage: 'checker', reason: "the checker calls 3 of q6's 3 wrong options right, and 3 must be left" },
    ]);
    // Every per-card event names its card by the plan's key, at the position it
    // was written to: one less than its plan index after q6. q6 logs nothing else.
    const perCard = (logger.events as { event: string; key?: string; position?: number }[]).filter((e) => e.position !== undefined);
    expect(perCard.map((e) => e.key)).toContain('q10');
    for (const { key, position } of perCard) {
      const index = Number(key!.slice(1)) - 1;
      expect(index).not.toBe(5);
      expect(position).toBe(index > 5 ? index - 1 : index);
    }
    expect(events(logger, 'sentence_degraded')).toEqual([expect.objectContaining({ key: 'q8', position: 6, type: 'cloze_typed' })]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 9, planned_count: 10, dropped_count: 1 }));
  });

  it('fills a ten-card session up to six with refused cards (phase 48, spec D3)', async () => {
    // The board refused at validation, as above, and q6 and q10 by the checker:
    // four pass, so both checker-refused cards are kept as generated, and the
    // board, refused at validation, is not needed.
    const reply = TEN_REPLY.replace('["צב","שולחן","כיסא"]', '["צב","כרית","מטרייה"]');
    const { service, calls, logger } = world({ context: TEN, reply, checkReply: checking({ q6: ALL_RIGHT, q10: ALL_RIGHT }) });
    await service.prepareSession(TEN_PAYLOAD);
    expect(calls.transitions).toEqual(['preparing→ready']);
    expect(insertedOf(calls).map((q) => q.type)).toEqual(['typed_translation', 'multiple_choice', 'letter_tiles', 'typed_translation', 'listen_choice', 'reverse_choice']);
    const kept = (key: string, position: number, type: string) => ({
      event: 'card_kept_refused',
      session_id: SESSION,
      key,
      position,
      type,
      stage: 'checker',
      reason: `the checker calls 3 of ${key}'s 3 wrong options right, and 3 must be left`,
      shown_as: 'as_generated',
    });
    expect(events(logger, 'card_kept_refused')).toEqual([kept('q6', 1, 'multiple_choice'), kept('q10', 5, 'reverse_choice')]);
    expect(events(logger, 'card_dropped')).toEqual(['q1', 'q2', 'q3', 'q4'].map((key) => expect.objectContaining({ key, type: 'matching', stage: 'validation' })));
    // As generated: the options the model wrote, though the checker called each right.
    expect(insertedOf(calls)[1].options!.map((o) => o.text)).toEqual([MEANINGS[4], 'דלת', 'קיר', 'תקרה']);
    expect(insertedOf(calls)[5].options!.map((o) => o.text)).toEqual([FORMS[5], 'чеснок', 'морковь', 'капуста']);
    expect(events(logger, 'checker_dropped')).toEqual([]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 6, planned_count: 10, dropped_count: 4 }));
  });

  // Ruling R2: a fill takes the board whole, past the floor, with the fifth
  // meaning validation chose and no checker_dropped for it.
  it('fills with a board the checker refused, whole, and its fifth meaning without the checker’s filter (phase 48, spec D3, ruling R2)', async () => {
    // q6, q9 and q10 each offer their own answer, so validation refuses them;
    // the checker calls every candidate right for q1. Three pass, the board is
    // the only unit the checker refused, and it takes the session to seven.
    const reply = TEN_REPLY.replace('["צב","שולחן","כיסא"]', '["שולחן","כיסא","מנורה","ספה"]')
      .replace('["דלת","קיר","תקרה"]', `["${MEANINGS[4]}","קיר","תקרה"]`)
      .replace('["ענן","גשם","רוח"]', `["${MEANINGS[7]}","גשם","רוח"]`)
      .replace('["чеснок","морковь","капуста"]', `["${FORMS[5]}","морковь","капуста"]`);
    const { service, calls, logger } = world({ context: TEN, reply, checkReply: checking({ q1: { options: [true, true, true, true] } }) });
    await service.prepareSession(TEN_PAYLOAD);
    expect(insertedOf(calls).map((q) => q.type)).toEqual(['matching', 'matching', 'matching', 'matching', 'typed_translation', 'letter_tiles', 'typed_translation']);
    expect(insertedOf(calls)[0].options!.map((o) => o.text)).toEqual(['מרגנית', 'צב', 'כרית', 'מטרייה', 'שולחן']);
    expect(events(logger, 'card_kept_refused')).toEqual(
      ['q1', 'q2', 'q3', 'q4'].map((key, position) =>
        expect.objectContaining({ key, position, type: 'matching', stage: 'checker', reason: "every wrong meaning of the board is one of its words' own", shown_as: 'as_generated' }),
      ),
    );
    expect(events(logger, 'card_dropped')).toEqual(['q6', 'q9', 'q10'].map((key) => expect.objectContaining({ key, stage: 'validation' })));
    expect(events(logger, 'checker_dropped')).toEqual([]);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 7, planned_count: 10, dropped_count: 3 }));
  });
});
