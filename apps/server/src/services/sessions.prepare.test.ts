import { describe, expect, it } from '@jest/globals';
import type { Enrollment, Question } from '@lang-tutor/core/api';

import { createFakeClock, createFakeLlmClient, createFakeLogger, createFakeTransaction, createFakeTranscriber, stub } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { GenerationContext, RecentSentences } from '../domain/distractors';
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
  { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה', example: null, exampleTranslation: null },
  { senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null },
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

function world(opts: { state?: SessionState; context?: GenerationContext[]; ready?: boolean; reply?: string | Error; recent?: RecentSentences }) {
  const calls = { transitions: [] as string[], generated: [] as unknown[], sessionQuestions: [] as Question[][], recentAsked: [] as unknown[] };
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
    findRecentSentences: async (input) => {
      calls.recentAsked.push(input);
      return opts.recent ?? new Map();
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
        correct_options: onBoard.map((i) => correct(input.questions[i])),
      };
      return input.questions.map((q, i): Question => {
        const base = { id: `g${i}`, vocab_term_id: q.lexemeId };
        const gap = { start: q.gapStart ?? 0, end: q.gapEnd ?? 0 };
        const gapText = (q.sentence ?? '').slice(gap.start, gap.end);
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
          case 'typed_meaning':
            return { ...base, type: q.type, question: q.form, part_of_speech: q.partOfSpeech, meaning: q.prompt! };
          case 'cloze_choice':
            return { ...base, type: q.type, sentence: q.sentence!, gap, translation: q.sentenceTranslation!, meaning: q.prompt!, ...choice() };
          case 'cloze_typed':
            return { ...base, type: q.type, sentence: q.sentence!, gap, translation: q.sentenceTranslation!, meaning: q.prompt!, answer: gapText, alternatives: q.alternatives! };
          case 'sentence_translation':
            return { ...base, type: q.type, question: q.sentenceTranslation!, meaning: q.prompt!, sentence: q.sentence!, gap, answer: gapText };
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
    judge: createFakeLlmClient(''),
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
      { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר', example: null, exampleTranslation: null },
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
  senseId: `s${i}`, variantId: `v${i}`, lexemeId: `l${i}`, form, lemma: form, partOfSpeech: 'noun', translation: MEANINGS[i], example: null, exampleTranslation: null,
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
    const { service } = world({ context: TEN, reply });
    await expect(service.prepareSession(TEN_PAYLOAD)).rejects.toThrow(/board/);
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

  it('reads the recent sentences of the picked senses in the read step, and hands them to the items as what to avoid', async () => {
    const recent: RecentSentences = new Map(
      TEN.map((row) => [row.senseId, { cloze: [`Вчера ${row.form} там один раз.`, 'second'], translate: [`Я вижу ${row.form} здесь.`] }]),
    );
    const { service, calls, llm } = world({ context: TEN, reply: TEN_REPLY, recent });
    await service.prepareSession(TEN_PAYLOAD);
    expect(calls.recentAsked).toEqual([{ enrollmentId: 'e1', senseIds: TEN.map((row) => row.senseId), limit: 3 }]);
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
    const { service, calls, logger } = world({ context: TEN, reply });
    await service.prepareSession(TEN_PAYLOAD);
    expect(typesOf(calls)).toContain('cloze_typed');
    const [input] = calls.generated as { questions: { type: string; sentence: string | null; gapStart: number | null; gapEnd: number | null; sentenceTranslation: string | null }[] }[];
    const typed = input.questions.find((q) => q.type === 'cloze_typed')!;
    expect(typed.sentence!.slice(typed.gapStart!, typed.gapEnd!)).toMatch(/^[а-яё]+$/u);
    expect(typed.sentenceTranslation).toBe('אני רואה את זה שם עכשיו.');
    expect(logger.events.map((e) => (e as { event: string }).event)).not.toContain('sentence_degraded');
  });
});
