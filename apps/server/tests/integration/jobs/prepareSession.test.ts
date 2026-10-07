import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { ClozeChoiceQuestion, ClozeTypedQuestion, LetterTilesQuestion, MatchingQuestion, SentenceTranslationQuestion } from '@lang-tutor/core/api';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { registerWorkers } from '../../../src/worker';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
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
  await registerWorkers(boss, deps.sessions, { pollingIntervalSeconds: 0.5 });
});

afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

const WORDS: Record<string, string> = { tome: 'ספר', sprint: 'ריצה', lantern: 'פנס' };

/** Past the seed (skipped), three saved words, and a list session requested. */
async function requestListSession(): Promise<string> {
  const seed = await deps.sessions.createNextSession(E, { listening: false, speaking: false });
  await deps.sessions.skipSession(seed.sessionId);
  for (const [lemma, translation] of Object.entries(WORDS)) {
    await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  }
  const { sessionId } = await deps.sessions.createNextSession(E, { listening: false, speaking: false });
  return sessionId;
}

const statusOf = async (sessionId: string) => (await deps.sessions.getSession(sessionId)).status;

const TEN_WORDS: Record<string, string> = {
  tome: 'ספר', sprint: 'ריצה', lantern: 'פנס', kettle: 'קומקום', pillow: 'כרית',
  ladder: 'סולם', bucket: 'דלי', violin: 'כינור', turtle: 'צב', lizard: 'לטאה',
};

it('prepares a ten-word session with listening on: a run, the board, a run (spec D3, D10)', async () => {
  await expectDistractors(ns, {
    tasks: ['meaning', 'word', 'typed', 'meaning', 'meaning', 'meaning', 'meaning', 'meaning', 'word', 'sentence'],
  });
  const seed = await deps.sessions.createNextSession(E, { listening: true, speaking: false });
  await deps.sessions.skipSession(seed.sessionId);
  for (const [lemma, translation] of Object.entries(TEN_WORDS)) {
    await seedSavedSenses(t.db, { enrollmentId: E, lemma, translations: [translation] });
  }
  const { sessionId } = await deps.sessions.createNextSession(E, { listening: true, speaking: false });

  await waitFor(async () => (await statusOf(sessionId)) === 'ready');
  const { questions } = await deps.sessions.getSession(sessionId);
  expect(questions.map((q) => q.type)).toEqual([
    'multiple_choice', 'reverse_choice', 'typed_translation',
    'matching', 'matching', 'matching', 'matching',
    'listen_choice', 'letter_tiles', 'cloze_typed',
  ]);
  const board = questions.slice(3, 7) as MatchingQuestion[];
  for (const word of board) {
    expect(word.options).toEqual(board[0].options);
    expect(word.board.question_ids).toEqual(board.map((q) => q.id));
    expect(word.options[word.correct_option]).toBe(TEN_WORDS[word.question]);
  }
  expect(board[0].options).toHaveLength(5);
  expect(board[0].options).toContain(STUB_WRONG_HEBREW[0]);
  const tiles = questions[8] as LetterTilesQuestion;
  expect(tiles.tiles).toHaveLength([...tiles.answer].length + 2);
});

// Phase 27 Part B (spec D5-D8): the three sentence cards, written by the job and
// read back through getSession.
describe('sentence cards through the queue', () => {
  const EXAMPLE_HEBREW = 'ראינו את זה שם.';

  async function saveTen(withExamples: boolean) {
    for (const [lemma, translation] of Object.entries(TEN_WORDS)) {
      await seedSavedSenses(t.db, {
        enrollmentId: E,
        lemma,
        translations: [translation],
        ...(withExamples ? { example: { source: `We saw the ${lemma} there.`, target: EXAMPLE_HEBREW } } : {}),
      });
    }
  }

  it('stores a cloze choice from the saved example and a typed cloze from the model, each with its sentence and gap', async () => {
    await expectDistractors(ns, {
      tasks: ['meaning', 'word', 'typed', 'meaning', 'meaning', 'meaning', 'meaning', 'meaning', 'gap', 'sentence'],
    });
    const seed = await deps.sessions.createNextSession(E, { listening: true, speaking: false });
    await deps.sessions.skipSession(seed.sessionId);
    await saveTen(true);
    const { sessionId } = await deps.sessions.createNextSession(E, { listening: true, speaking: false });

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession(sessionId);
    expect(questions.slice(7).map((q) => q.type)).toEqual(['listen_choice', 'cloze_choice', 'cloze_typed']);

    const choice = questions[8] as ClozeChoiceQuestion;
    expect(choice.translation).toBe(EXAMPLE_HEBREW);
    const answer = choice.sentence.slice(choice.gap.start, choice.gap.end);
    // The blank is the saved example's own text for the word; the right option is that text.
    expect(choice.sentence).toBe(`We saw the ${answer} there.`);
    expect(choice.options[choice.correct_option]).toBe(answer);
    expect(Object.keys(TEN_WORDS)).toContain(answer);
    expect(choice.meaning).toBe(TEN_WORDS[answer]);
    expect([...choice.options].sort()).toEqual([answer, ...STUB_WRONG_ENGLISH].sort());

    const typed = questions[9] as ClozeTypedQuestion;
    expect(typed.sentence).toBe(STUB_SENTENCE);
    expect(typed.sentence.slice(typed.gap.start, typed.gap.end)).toBe(STUB_GAP);
    expect(typed.answer).toBe(STUB_GAP);
    expect(typed.translation).toBe(STUB_SENTENCE_HEBREW);
    expect(logger.events.map((e) => (e as { event: string }).event)).not.toContain('sentence_degraded');
  });

  it('stores a sentence translation with its reference and gap', async () => {
    // Ordinal 2 of ten words with listening on: the last position is a translation.
    await expectDistractors(ns, {
      tasks: ['typed', 'typed', 'typed', 'meaning', 'meaning', 'meaning', 'meaning', 'meaning', 'word', 'translate'],
    });
    const options = { listening: true, speaking: false };
    // The seed, then two list sessions skipped before the third (ordinal 2).
    const seed = await deps.sessions.createNextSession(E, options);
    await deps.sessions.skipSession(seed.sessionId);
    await saveTen(false);
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      const early = await deps.sessions.createNextSession(E, options);
      await deps.sessions.skipSession(early.sessionId);
    }
    const { sessionId } = await deps.sessions.createNextSession(E, options);

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const { questions } = await deps.sessions.getSession(sessionId);
    expect(questions[9].type).toBe('sentence_translation');
    const translate = questions[9] as SentenceTranslationQuestion;
    expect(translate.question).toBe(STUB_SENTENCE_HEBREW);
    expect(translate.sentence).toBe(STUB_SENTENCE);
    expect(translate.answer).toBe(STUB_GAP);
    expect(translate.sentence.slice(translate.gap.start, translate.gap.end)).toBe(STUB_GAP);
  });
});

describe('prepare-session through the queue', () => {
  it('turns a list session ready, with its saved words as the prompts', async () => {
    await expectDistractors(ns);
    const sessionId = await requestListSession();

    await waitFor(async () => (await statusOf(sessionId)) === 'ready');
    const record = await deps.sessions.getSession(sessionId);
    // Phase 23 (spec D2): the type cycle, in order.
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
    expect(typed.question).toBe(WORDS[typed.answer]);
    expect(typed.alternatives).toEqual([STUB_ALTERNATIVE]);
    expect(new Set([choice.question, reversedWord, typed.answer]).size).toBe(3);
  });

  it('a provider that keeps failing ends the session failed, through the dead-letter queue', async () => {
    await expectGeminiStatus(ns, 500);
    const sessionId = await requestListSession();

    await waitFor(async () => (await statusOf(sessionId)) === 'failed', 25_000);
    // One attempt and two retries.
    expect(await countGeminiRequests(ns)).toBe(3);
    expect((await deps.sessions.currentSession(E)).current).toMatchObject({ id: sessionId, status: 'failed' });
  });

  // Review Focus 2: a skip lands while the model is still answering.
  it('a skip during generation wins: the job writes nothing', async () => {
    await expectDistractors(ns, { delayMs: 3_000 });
    const sessionId = await requestListSession();

    await waitFor(async () => (await countGeminiRequests(ns)) === 1);
    await deps.sessions.skipSession(sessionId);
    await waitFor(async () => logger.events.some((e) => e.event === 'session_preparation_dropped'), 15_000);

    const record = await deps.sessions.getSession(sessionId);
    expect(record.status).toBe('skipped');
    expect(record.questions).toEqual([]);
  });
});
