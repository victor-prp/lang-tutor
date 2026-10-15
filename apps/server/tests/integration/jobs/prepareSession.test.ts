import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { ClozeChoiceQuestion, ClozeTypedQuestion, LetterTilesQuestion, MatchingQuestion, SentenceTranslationQuestion } from '@lang-tutor/core/api';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { DISTRACTOR_MARKER } from '../../../src/domain/distractors';
import { PREPARE_SESSION, type PrepareSessionPayload } from '../../../src/domain/jobs';
import { createJobRepo } from '../../../src/repo/jobs';
import { createSessionRepo } from '../../../src/repo/sessions';
import { registerWorkers } from '../../../src/worker';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { CHOSEN_ON, NO_DEVICES } from '../../support/questions';
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

/** Saves `words` and enqueues a list session's job with one pick each, carrying `cards[i]`. */
async function enqueueSession(words: Record<string, string>, cards: Card[], opts: { listening: boolean; example?: { target: string } }) {
  const picks: PrepareSessionPayload['picks'] = [];
  for (const [i, [lemma, translation]] of Object.entries(words).entries()) {
    const example = opts.example && { source: `We saw the ${lemma} there.`, target: opts.example.target };
    const saved = await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation], ...(example ? { example } : {}) });
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
    const sessionId = await createSessionRepo(tx).insertPreparingSession('u_1', E, NO_DEVICES, CHOSEN_ON);
    await createJobRepo(tx, boss).enqueue(PREPARE_SESSION, { session_id: sessionId, picks, listening: opts.listening, speaking: false });
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

// Phase 54 (spec D3, D7). A new word's first session through the queue: its pick,
// stored as a ladder, is asked as four cards, the meet card first, and the meet
// card is written as the database takes it.
it('prepares a ladder pick as a meet card, a multiple choice, a reverse choice and a typed translation (phase 54, spec D3, D7)', async () => {
  // Tome's meet card q1, which asks nothing, sprint's multiple choice q2, then
  // tome's choice q3, its reversed card q4 and its typed card q5.
  await expectDistractors(ns, { tasks: [null, 'meaning', 'meaning', 'word', 'typed'] });
  await expectCheck(ns);
  const sessionId = await enqueueSession({ tome: 'ספר', sprint: 'ריצה' }, [{ ladder: true }, RECOGNISE], { listening: false });

  await waitFor(async () => (await statusOf(sessionId)) === 'ready');
  const { questions } = await deps.sessions.getSession('u_1', sessionId);
  expect(questions.map((q) => q.type)).toEqual(['meet', 'multiple_choice', 'multiple_choice', 'reverse_choice', 'typed_translation']);
  const [meet] = questions;
  expect(meet).toEqual({ id: meet.id, vocab_term_id: meet.vocab_term_id, type: 'meet', question: 'tome', meaning: 'ספר' });
  expect(questions.filter((q) => q.vocab_term_id === meet.vocab_term_id).map((q) => q.type)).toEqual([
    'meet', 'multiple_choice', 'reverse_choice', 'typed_translation',
  ]);
});

// Phase 27 Part B (spec D5-D8): the three sentence cards, written by the job and
// read back through getSession.
describe('sentence cards through the queue', () => {
  const EXAMPLE_HEBREW = 'ראינו את זה שם.';

  it('stores a cloze choice from the saved example and a typed cloze from the model, each with its sentence and gap', async () => {
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
    expect(choice.translation).toBe(EXAMPLE_HEBREW);
    const answer = choice.sentence.slice(choice.gap.start, choice.gap.end);
    // The blank is the saved example's own text for the word; the right option is that text.
    expect(choice.sentence).toBe(`We saw the ${answer} there.`);
    expect(choice.options[choice.correct_option]).toBe(answer);
    expect(Object.keys(TEN_WORDS)).toContain(answer);
    expect(choice.meaning).toBe(TEN_WORDS[answer]);
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
    // Phase 54 (spec D3, D5): the three meet cards q1-q3 ask nothing, then the
    // stages of the three ladders.
    await expectDistractors(ns, { tasks: [null, null, null, 'meaning', 'meaning', 'meaning', 'word', 'word', 'word', 'typed', 'typed', 'typed'] });
    const sessionId = await requestListSession();

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const record = await deps.sessions.getSession('u_1', sessionId);
    // Phase 35 (spec D6): three new words, too few for a board. Phase 54 (spec D3,
    // D5, D7): each a ladder, its pick stored as one, and the ladders stage by stage.
    const stage = (type: string) => [type, type, type];
    expect(record.questions.map((q) => q.type)).toEqual([
      ...stage('meet'), ...stage('multiple_choice'), ...stage('reverse_choice'), ...stage('typed_translation'),
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
    expect(new Set(record.questions.slice(0, 3).map((q) => (q as { question: string }).question))).toEqual(new Set(Object.keys(WORDS)));
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
