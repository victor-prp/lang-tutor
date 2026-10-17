import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { ClozeChoiceQuestion, ClozeTypedQuestion, LetterTilesQuestion, MatchingQuestion, ReadAloudQuestion, SentenceTranslationQuestion } from '@lang-tutor/core/api';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { DISTRACTOR_MARKER } from '../../../src/domain/distractors';
import { sessionScore } from '../../../src/domain/session';
import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { createJobRepo } from '../../../src/repo/jobs';
import { createSessionRepo } from '../../../src/repo/sessions';
import { registerWorkers } from '../../../src/worker';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { CHOSEN_ON, NO_DEVICES, readIntro, readSteps } from '../../support/questions';
import { readGlossMemory, readProgress, sessionDay } from '../../support/progressRows';
import { startTestBoss, stopTestBoss, waitFor } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  countGeminiRequests,
  STUB_ALTERNATIVE,
  STUB_GAP,
  STUB_SENTENCE,
  STUB_SENTENCE_HEBREW,
  STUB_WRONG_ENGLISH,
  STUB_WRONG_HEBREW,
  expectAccept,
  expectCheck,
  expectDistractors,
  expectGeminiStatus,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

let t: TestDb;
let boss: PgBoss;
let logger: FakeLogger;
let deps: AppDeps;
let ns: string;
const E = enrollmentOf('u_1');

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  ns = mockNamespace(expect.getState().currentTestName ?? 'prepare-session');
  logger = createFakeLogger();
  boss = await startTestBoss(t.db);
  deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns) });
  // Phase 34 (spec D1). Preparing a session asks for the accept job of every
  // picked rendering, which the workers below then run: answered here, and above
  // any stub a test registers, so it is never the subject of one.
  await expectAccept(ns, { answers: [], answer_form: null });
  await registerWorkers(boss, deps, { pollingIntervalSeconds: 0.5 });
});

afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

const WORDS: Record<string, string> = { tome: 'ספר', sprint: 'ריצה', lantern: 'פנס' };
/** The seeded English headwords that share a word's Hebrew key (spec D18): only
 *  ספר has one, the seed's `book`. */
const SEEDED_SIBLINGS: Record<string, string[]> = { tome: ['book'] };

/** Past the seed (skipped), three saved words, and a list session requested. */
async function requestListSession(): Promise<string> {
  const seed = await deps.sessions.createNextSession('u_1', E, { listening: false, speaking: false });
  await deps.sessions.skipSession('u_1', seed.sessionId);
  for (const [lemma, translation] of Object.entries(WORDS)) {
    await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  }
  const { sessionId } = await deps.sessions.createNextSession('u_1', E, { listening: false, speaking: false });
  return sessionId;
}

const statusOf = async (sessionId: string) => (await deps.sessions.getSession('u_1', sessionId)).status;

// Phase 35 (spec D6). The job chooses each pick's card from the dimension, rung,
// level and R the pick carries, highest chance of success first. These tests
// enqueue the job with picks that name their cards; a pick with none of them
// is a new word, multiple choice. sessionsChoose.test.ts covers how a created
// session's picks get theirs.
type Card = Partial<Pick<PrepareSessionPayload['picks'][number], 'dimension' | 'rung' | 'level' | 'r' | 'step' | 'ladder'>>;
const RECOGNISE: Card = { dimension: 'written_receptive', rung: 1, level: 1, r: 0.81 }; // multiple choice, p 0.925
const PICK_FORM: Card = { dimension: 'written_productive', rung: 1, level: 1, r: 0.5 }; // reverse or cloze choice, p 0.78
const BUILD_FORM: Card = { dimension: 'written_productive', rung: 1, level: 1, r: 0.81 }; // letter tiles, p 0.9
const HEAR: Card = { dimension: 'spoken_receptive', rung: 1, level: 1, r: 0.64 }; // listen and choose, p 0.85
/** Typed recall of the form, p = R: typed translation, typed cloze, sentence translation in turn. */
const produce = (r: number): Card => ({ dimension: 'written_productive', rung: 2, level: 3, r });

/** The gloss each word was saved as by the last enqueueSession: a test that reads a word's
 *  memory or progress names it by this. */
const savedGloss = new Map<string, string>();

/** Saves `words` and enqueues a list session's job with one pick each, carrying `cards[i]`. */
async function enqueueSession(
  words: Record<string, string>,
  cards: Card[],
  opts: { listening: boolean; speaking?: boolean; example?: { target: string } },
) {
  const picks: PrepareSessionPayload['picks'] = [];
  for (const [i, [lemma, translation]] of Object.entries(words).entries()) {
    const example = opts.example && { source: `We saw the ${lemma} there.`, target: opts.example.target };
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation], ...(example ? { example } : {}) });
    savedGloss.set(lemma, saved.glossIds[0]);
    picks.push({
      gloss_id: saved.glossIds[0],
      sense_id: saved.senseIds[0],
      variant_id: saved.variantId,
      dimension: 'written_receptive',
      rung: 1,
      level: 1,
      r: null,
      step: false,
      ...cards[i],
    });
  }
  return withTx(t.db, async (tx) => {
    const sessionId = await createSessionRepo(tx).insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON, null);
    await createJobRepo(tx, boss).enqueue(PREPARE_SESSION, { session_id: sessionId, picks, listening: opts.listening, speaking: opts.speaking ?? false });
    return sessionId;
  });
}

const TEN_WORDS: Record<string, string> = {
  tome: 'ספר', sprint: 'ריצה', lantern: 'פנס', kettle: 'קומקום', pillow: 'כרית',
  ladder: 'סולם', bucket: 'דלי', violin: 'כינור', turtle: 'צב', lizard: 'לטאה',
};

it('prepares a ten-word session with listening on: the board, then each card by its chance (spec D6, D10)', async () => {
  // Highest p first: the four new words' board (q1-q4), typed translation q5,
  // multiple choice q6, letter tiles q7, typed cloze q8, listen and choose q9,
  // reverse choice q10.
  await expectDistractors(ns, {
    tasks: ['meaning', 'meaning', 'meaning', 'meaning', 'typed', 'meaning', 'meaning', 'sentence', 'meaning', 'word'],
  });
  await expectCheck(ns);
  const sessionId = await enqueueSession(
    TEN_WORDS,
    [{}, {}, {}, {}, RECOGNISE, PICK_FORM, produce(0.95), HEAR, BUILD_FORM, produce(0.88)],
    { listening: true },
  );

  await waitFor(async () => (await statusOf(sessionId)) === 'ready');
  const { questions } = await deps.sessions.getSession('u_1', sessionId);
  expect(questions.map((q) => q.type)).toEqual([
    'matching', 'matching', 'matching', 'matching',
    'typed_translation', 'multiple_choice', 'letter_tiles', 'cloze_typed',
    'listen_choice', 'reverse_choice',
  ]);
  const board = questions.slice(0, 4) as MatchingQuestion[];
  for (const word of board) {
    expect(word.options).toEqual(board[0].options);
    expect(word.board.question_ids).toEqual(board.map((q) => q.id));
    expect(word.options[word.correct_option]).toBe(TEN_WORDS[word.question]);
  }
  expect(board.map((word) => word.question).sort()).toEqual(['kettle', 'lantern', 'sprint', 'tome']);
  expect(board[0].options).toHaveLength(5);
  expect(board[0].options).toContain(STUB_WRONG_HEBREW[0]);
  const tiles = questions[6] as LetterTilesQuestion;
  expect(tiles.answer).toBe('turtle');
  expect(tiles.tiles).toHaveLength([...tiles.answer].length + 2);
});

// Phase 54 (spec D3, D7); phase 55 (spec D2, D3). A new word's first session through
// the queue: its pick, stored as a ladder, is asked as its intro stage (the meet card,
// a read aloud when the session speaks, the letter tiles or a typed translation) and
// three practice cards. The meet card is written as the database takes it.
describe('a ladder through the queue (phase 54, spec D3, D7; phase 55, spec D2, D3)', () => {
  const PRACTICE = ['multiple_choice', 'reverse_choice', 'typed_translation'];
  const cardsOf = (questions: { type: string; vocab_term_id: string }[], lexemeId: string) =>
    questions.filter((q) => q.vocab_term_id === lexemeId).map((q) => q.type);

  it('prepares a ladder pick on a tile form as a meet card, a read aloud, letter tiles and three practice cards', async () => {
    // Tome's intro q1-q3 asks nothing, sprint's multiple choice q4 and tome's choice
    // q5, then its reversed card q6 and its typed card q7.
    await expectDistractors(ns, { tasks: [null, null, null, 'meaning', 'meaning', 'word', 'typed'] });
    await expectCheck(ns);
    const sessionId = await enqueueSession({ tome: 'ספר', sprint: 'ריצה' }, [{ ladder: true }, RECOGNISE], { listening: false, speaking: true });

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession('u_1', sessionId);
    expect(questions.map((q) => q.type)).toEqual([
      'meet', 'read_aloud', 'letter_tiles', 'multiple_choice', 'multiple_choice', 'reverse_choice', 'typed_translation',
    ]);
    const [meet, aloud, tiles] = questions as [(typeof questions)[number], ReadAloudQuestion, LetterTilesQuestion];
    expect(meet).toEqual({ id: meet.id, vocab_term_id: meet.vocab_term_id, type: 'meet', question: 'tome', meaning: 'ספר' });
    expect(cardsOf(questions, meet.vocab_term_id)).toEqual(['meet', 'read_aloud', 'letter_tiles', ...PRACTICE]);
    // The read aloud shows the word and keeps its meaning; the tiles ask the meaning and build the word from its letters and two more.
    expect(aloud).toMatchObject({ vocab_term_id: meet.vocab_term_id, type: 'read_aloud', question: 'tome', meaning: 'ספר' });
    expect(tiles).toMatchObject({ vocab_term_id: meet.vocab_term_id, type: 'letter_tiles', question: 'ספר', answer: 'tome' });
    expect(tiles.tiles).toHaveLength([...'tome'].length + 2);
    expect(tiles.tiles.length).toBeGreaterThanOrEqual(5);
    expect(tiles.tiles.length).toBeLessThanOrEqual(12);
    // Phase 55 (spec D2, as ruled): the intro's three questions are marked, the practice cards and sprint's are not.
    expect(await readIntro(t.db, sessionId)).toEqual([true, true, true, false, false, false, false]);
  });

  it('prepares the same pick without the read aloud when the session cannot speak', async () => {
    await expectDistractors(ns, { tasks: [null, null, 'meaning', 'meaning', 'word', 'typed'] });
    await expectCheck(ns);
    const sessionId = await enqueueSession({ tome: 'ספר', sprint: 'ריצה' }, [{ ladder: true }, RECOGNISE], { listening: false });

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession('u_1', sessionId);
    expect(questions.map((q) => q.type)).toEqual(['meet', 'letter_tiles', 'multiple_choice', 'multiple_choice', 'reverse_choice', 'typed_translation']);
    expect(cardsOf(questions, questions[0].vocab_term_id)).toEqual(['meet', 'letter_tiles', ...PRACTICE]);
    expect(await readIntro(t.db, sessionId)).toEqual([true, true, false, false, false, false]);
  });

  it('prepares a ladder pick on a form without tiles with a typed translation in place of them', async () => {
    // A phrase cannot be built from tiles; it can be said. The ladder alone: its intro q1-q3
    // asks nothing, then q4 to q6.
    await expectDistractors(ns, { tasks: [null, null, null, 'meaning', 'word', 'typed'] });
    await expectCheck(ns);
    const sessionId = await enqueueSession({ 'take off': 'להמריא' }, [{ ladder: true }], { listening: false, speaking: true });

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession('u_1', sessionId);
    // A session of one word: the plan's one-word rule leaves the ladder its read aloud.
    expect(questions.map((q) => q.type)).toEqual(['meet', 'read_aloud', 'typed_translation', ...PRACTICE]);
    expect(questions[2]).toMatchObject({ type: 'typed_translation', question: 'להמריא', answer: 'take off' });
    // The intro's typed translation is marked; the third practice card, the same type, is not.
    expect(await readIntro(t.db, sessionId)).toEqual([true, true, true, false, false, false]);
  });

  it('prepares a payload of three ladders, as a stock chosen before the deploy holds, as its first two ladders', async () => {
    // Phase 55 (spec D4, ruled). A payload the pre-deploy picker chose may hold three ladders
    // (phase 54's three slots each). Planned whole, two forms without tiles would ask eleven
    // items, each one's intro typed card among them, above the ten the batch takes, and fail
    // the session. The first two ladders in pick order are prepared; the third is dropped, not
    // asked as a plain pick, which would ask a word never met cold. Each intro stage q1-q3 and
    // q4-q6 asks only for its typed card's alternatives, then the practice, stage by stage.
    await expectDistractors(ns, {
      tasks: [null, null, 'typed', null, null, 'typed', 'meaning', 'meaning', 'word', 'word', 'typed', 'typed'],
    });
    await expectCheck(ns);
    const words = { 'take off': 'להמריא', refrigerator: 'מקרר', tome: 'ספר' };
    const sessionId = await enqueueSession(words, [{ ladder: true }, { ladder: true }, { ladder: true }], { listening: false, speaking: true });

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession('u_1', sessionId);
    const intro = ['meet', 'read_aloud', 'typed_translation'];
    expect(questions.map((q) => q.type)).toEqual([
      ...intro, ...intro, ...Array(2).fill('multiple_choice'), ...Array(2).fill('reverse_choice'), ...Array(2).fill('typed_translation'),
    ]);
    // The first two picks' ladders, in pick order, and no card of the third.
    const asked = questions.map((q) => ('question' in q ? q.question : null));
    expect([asked[0], asked[3]]).toEqual(['take off', 'refrigerator']);
    expect(asked).not.toContain('tome');
    expect(asked).not.toContain('ספר');
    const lexemes = [...new Set(questions.map((q) => q.vocab_term_id))];
    expect(lexemes).toHaveLength(2);
    for (const lexemeId of lexemes) expect(cardsOf(questions, lexemeId)).toEqual([...intro, ...PRACTICE]);
    expect(await readIntro(t.db, sessionId)).toEqual([...Array(6).fill(true), ...Array(6).fill(false)]);
  });

  // Phase 55 (spec D2, as ruled). The intro stage is for encoding, not evidence: played, its
  // cards write no memory, no progress, and open no return, while the practice cards grade as
  // ever. The score still counts them: the read aloud said right, the tiles helped wrong.
  describe('played through to the end', () => {
    const WP = 'written_productive';

    /** Tome's ladder and sprint's multiple choice, speaking: the tiles helped, the read aloud said,
     *  the choices right, and the third practice card `typed`. */
    async function play(typed: string) {
      await expectDistractors(ns, { tasks: [null, null, null, 'meaning', 'meaning', 'word', 'typed'] });
      await expectCheck(ns);
      const sessionId = await enqueueSession({ tome: 'ספר', sprint: 'ריצה' }, [{ ladder: true }, RECOGNISE], { listening: false, speaking: true });
      await waitFor(async () => (await statusOf(sessionId)) === 'ready');
      const { questions } = await deps.sessions.getSession('u_1', sessionId);
      expect(questions.map((q) => q.type)).toEqual([
        'meet', 'read_aloud', 'letter_tiles', 'multiple_choice', 'multiple_choice', 'reverse_choice', 'typed_translation',
      ]);
      let result;
      for (const question of questions) {
        const answer =
          question.type === 'meet'
            ? { seen: true as const }
            : question.type === 'read_aloud'
              ? { heard: 'tome' }
              : question.type === 'letter_tiles'
                ? { text: 'tome', helped: true }
                : question.type === 'typed_translation'
                  ? { text: typed }
                  : { option_index: (question as { correct_option: number }).correct_option };
        result = await deps.sessions.submitAnswer('u_1', sessionId, question.id, answer);
      }
      expect(result!.complete).toBe(true);
      const tome = savedGloss.get('tome')!;
      const day = (await sessionDay(t.db, sessionId))!;
      const progressOf = async (dimension: string) =>
        (await readProgress(t.db, E)).find((row) => row.glossId === tome && row.dimension === dimension);
      return { result: result!, tome, day, progressOf };
    }

    it('writes no memory, no progress and no return for the intro, and the practice cards grade as ever', async () => {
      const { result, tome, day, progressOf } = await play('tome');
      // The tiles answer is stored wrong, and the score counts it so: six graded cards (the meet card
      // is not one), five right, the read aloud among them.
      expect(result.answers.map((a) => a.is_correct)).toEqual([false, true, false, true, true, true, true]);
      expect(sessionScore(result)).toEqual({ correct: 5, total: 6 });
      // Written productive: the reverse choice's Hard and the typed card's Good, and no Again.
      expect((await readGlossMemory(t.db, tome)).find((row) => row.dimension === WP)).toMatchObject({ reps: 2, lapses: 0 });
      // Its progress stepped, with no mistake recorded; the read aloud raised no spoken production.
      expect(await progressOf(WP)).toMatchObject({ level: 2, lastWrongOn: null });
      expect(await progressOf('spoken_productive')).toMatchObject({ level: 1, lastStepOn: null });
      // The return a word met today owes, in written receptive: none in written productive.
      expect((await readSteps(t.db, E, day)).filter((step) => step.glossId === tome).map((step) => step.dimension)).toEqual([
        'written_receptive',
      ]);
    });

    it('writes written productive Again for a wrong third practice card, and nothing for the intro tiles', async () => {
      const { result, tome, day, progressOf } = await play('qqqqqq');
      expect(sessionScore(result)).toEqual({ correct: 4, total: 6 });
      // The reverse choice's Hard and the typed card's Again: two reviews, one lapse.
      expect((await readGlossMemory(t.db, tome)).find((row) => row.dimension === WP)).toMatchObject({ reps: 2, lapses: 1 });
      expect(await progressOf(WP)).toMatchObject({ level: 1, lastWrongOn: day });
      // The typed card's Again opens a return in written productive, from the practice card.
      expect((await readSteps(t.db, E, day)).filter((step) => step.glossId === tome).map((step) => step.dimension)).toEqual([
        'written_productive',
      ]);
    });
  });
});

// Phase 27 Part B (spec D5-D8): the three sentence cards, written by the job and
// read back through getSession.
describe('sentence cards through the queue', () => {
  const EXAMPLE_HEBREW = 'ראינו את זה שם.';

  it('stores a cloze choice and a typed cloze from the model, each with its sentence and gap (phase 62 D1)', async () => {
    // Two forms picked: the first a reverse choice, the second, its example
    // holding the form, a cloze choice. The board, typed translation q5, tiles
    // q6, typed cloze q7, listen and choose q8, reverse choice q9, cloze choice q10.
    await expectDistractors(ns, {
      tasks: ['meaning', 'meaning', 'meaning', 'meaning', 'typed', 'meaning', 'sentence', 'meaning', 'word', 'gap'],
    });
    await expectCheck(ns);
    const sessionId = await enqueueSession(
      TEN_WORDS,
      [{}, {}, {}, {}, PICK_FORM, PICK_FORM, produce(0.95), HEAR, BUILD_FORM, produce(0.88)],
      { listening: true, example: { target: EXAMPLE_HEBREW } },
    );

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession('u_1', sessionId);
    expect(questions.slice(4).map((q) => q.type)).toEqual([
      'typed_translation', 'letter_tiles', 'cloze_typed', 'listen_choice', 'reverse_choice', 'cloze_choice',
    ]);

    const choice = questions[9] as ClozeChoiceQuestion;
    // Phase 62 (spec D1): the sentence the model wrote for the card, not the saved example;
    // the blank is its gap's text, and the right option is that text.
    expect(choice.sentence).toBe(STUB_SENTENCE);
    expect(choice.translation).toBe(STUB_SENTENCE_HEBREW);
    const answer = choice.sentence.slice(choice.gap.start, choice.gap.end);
    expect(answer).toBe(STUB_GAP);
    expect(choice.options[choice.correct_option]).toBe(answer);
    expect(Object.values(TEN_WORDS)).toContain(choice.meaning);
    expect([...choice.options].sort()).toEqual([answer, ...STUB_WRONG_ENGLISH].sort());

    const typed = questions[6] as ClozeTypedQuestion;
    expect(typed.sentence).toBe(STUB_SENTENCE);
    expect(typed.sentence.slice(typed.gap.start, typed.gap.end)).toBe(STUB_GAP);
    expect(typed.answer).toBe(STUB_GAP);
    expect(typed.translation).toBe(STUB_SENTENCE_HEBREW);
    expect(logger.events.map((e) => (e as { event: string }).event)).not.toContain('sentence_degraded');
  });

  it('stores a sentence translation with its reference and gap', async () => {
    // Three forms typed: a typed cloze q5 (p 0.95), a typed translation q6
    // (0.91), and the sentence translation q8 (0.88), after tiles q7.
    await expectDistractors(ns, {
      tasks: ['meaning', 'meaning', 'meaning', 'meaning', 'sentence', 'typed', 'meaning', 'translate', 'meaning', 'word'],
    });
    await expectCheck(ns);
    const sessionId = await enqueueSession(
      TEN_WORDS,
      [{}, {}, {}, {}, produce(0.91), PICK_FORM, produce(0.95), HEAR, BUILD_FORM, produce(0.88)],
      { listening: true },
    );

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession('u_1', sessionId);
    expect(questions[7].type).toBe('sentence_translation');
    const translate = questions[7] as SentenceTranslationQuestion;
    expect(translate.question).toBe(STUB_SENTENCE_HEBREW);
    expect(translate.sentence).toBe(STUB_SENTENCE);
    expect(translate.answer).toBe(STUB_GAP);
    expect(translate.sentence.slice(translate.gap.start, translate.gap.end)).toBe(STUB_GAP);
  });
});

describe('prepare-session through the queue', () => {
  it('turns a list session ready, with its saved words as the prompts', async () => {
    await expectCheck(ns);
    // Phase 55 (spec D2, D3, D4): each of the two ladders' intro stage, the meet card and the
    // tiles (the session cannot speak), q1-q4, asks nothing, then the stages of the practice cards.
    await expectDistractors(ns, { tasks: [null, null, null, null, 'meaning', 'meaning', 'word', 'word', 'typed', 'typed'] });
    const sessionId = await requestListSession();

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const record = await deps.sessions.getSession('u_1', sessionId);
    // Phase 35 (spec D6): three new words, too few for a board. Phase 54 (spec D3,
    // D5, D7): each a ladder, its pick stored as one; phase 55 (spec D4), two of them, the
    // session's ceiling. Phase 55 (spec D2, D3): each word's intro stage is a meet card and the
    // tiles, in a row, then the practice cards stage by stage.
    const stage = (type: string) => [type, type];
    expect(record.questions.map((q) => q.type)).toEqual([
      'meet', 'letter_tiles', 'meet', 'letter_tiles',
      ...stage('multiple_choice'), ...stage('reverse_choice'), ...stage('typed_translation'),
    ]);
    for (const choice of record.questions.filter((q) => q.type === 'multiple_choice')) {
      if (choice.type !== 'multiple_choice') throw new Error('unreachable');
      expect(choice.options[choice.correct_option]).toBe(WORDS[choice.question]);
      expect([...choice.options].sort()).toEqual([WORDS[choice.question], ...STUB_WRONG_HEBREW].sort());
    }
    for (const meet of record.questions.filter((q) => q.type === 'meet')) {
      if (meet.type !== 'meet') throw new Error('unreachable');
      expect(meet.meaning).toBe(WORDS[meet.question]);
    }
    // The tiles card follows its word's meet card.
    for (const at of [0, 2]) expect(record.questions[at + 1].vocab_term_id).toBe(record.questions[at].vocab_term_id);
    const met = new Set([0, 2].map((at) => (record.questions[at] as { question: string }).question));
    expect(met.size).toBe(2);
    expect(Object.keys(WORDS)).toEqual(expect.arrayContaining([...met]));
  });

  it('writes each card the content its type needs', async () => {
    await expectDistractors(ns);
    await expectCheck(ns);
    // p: sprint new 1, lantern's form picked 0.78, tome's form typed 0.76.
    const sessionId = await enqueueSession(WORDS, [produce(0.76), {}, PICK_FORM], { listening: false });

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const record = await deps.sessions.getSession('u_1', sessionId);
    expect(record.questions.map((q) => q.type)).toEqual(['multiple_choice', 'reverse_choice', 'typed_translation']);
    const [choice, reversed, typed] = record.questions;
    if (choice.type !== 'multiple_choice' || reversed.type !== 'reverse_choice' || typed.type !== 'typed_translation') {
      throw new Error('unreachable');
    }
    // Today's card: the word, its meaning among Hebrew wrong options.
    expect(Object.keys(WORDS)).toContain(choice.question);
    expect(choice.options[choice.correct_option]).toBe(WORDS[choice.question]);
    expect([...choice.options].sort()).toEqual([WORDS[choice.question], ...STUB_WRONG_HEBREW].sort());
    // The reversed card: the meaning, the word among English wrong options.
    const reversedWord = reversed.options[reversed.correct_option];
    expect(reversed.question).toBe(WORDS[reversedWord]);
    expect([...reversed.options].sort()).toEqual([reversedWord, ...STUB_WRONG_ENGLISH].sort());
    // The typed card: the meaning, the word as its answer, the alternative kept.
    // Phase 31 (spec D18): the seeded `book` is also ספר, so `tome`'s sibling
    // is accepted too, ahead of the model's alternative.
    expect(typed.answer).toBe('tome');
    expect(typed.question).toBe(WORDS[typed.answer]);
    expect(typed.alternatives).toEqual([...SEEDED_SIBLINGS.tome, STUB_ALTERNATIVE]);
    expect([choice.question, reversedWord, typed.answer]).toEqual(['sprint', 'lantern', 'tome']);
  });

  it('a provider that keeps failing ends the session failed, through the dead-letter queue', async () => {
    await expectGeminiStatus(ns, 500);
    const sessionId = await requestListSession();

    await waitFor(async () => (await statusOf(sessionId)) === 'failed', 25_000);
    // One attempt and two retries. Phase 34: the accept calls are not counted.
    expect(await countGeminiRequests(ns, DISTRACTOR_MARKER)).toBe(3);
    expect((await deps.sessions.currentSession('u_1', E)).current).toMatchObject({ id: sessionId, status: 'failed' });
  });

  // Review Focus 2: a skip lands while the model is still answering.
  it('a skip during generation wins: the job writes nothing', async () => {
    await expectDistractors(ns, { delayMs: 3_000 });
    await expectCheck(ns);
    const sessionId = await requestListSession();

    await waitFor(async () => (await countGeminiRequests(ns, DISTRACTOR_MARKER)) === 1);
    await deps.sessions.skipSession('u_1', sessionId);
    await waitFor(async () => logger.events.some((e) => e.event === 'session_preparation_dropped'), 15_000);

    const record = await deps.sessions.getSession('u_1', sessionId);
    expect(record.status).toBe('skipped');
    expect(record.questions).toEqual([]);
  });
});
