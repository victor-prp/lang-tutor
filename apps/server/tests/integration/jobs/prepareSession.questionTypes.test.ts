import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QuestionType } from '@lang-tutor/core/domain';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import {
  STUB_GAP,
  assertMockServerReachable,
  clearNamespace,
  expectCheck,
  expectDistractors,
  expectPoint,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

// Phase 61 (spec D4, D5). A question-types session: one pick, one card per chosen
// type in the order chosen, no plan, no floor and no fallback; a card that cannot be
// generated is dropped and named.
let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;
let ns: string;
let logger: FakeLogger;
const ENROLLMENT = enrollmentOf('u_1');
let word: Awaited<ReturnType<typeof seedSavedSenses>>;

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  // The stub sentence holds STUB_GAP, so the sentence cards find their word in it.
  word = await seedSavedSenses(t.db, {
    enrollmentId: ENROLLMENT,
    lemma: STUB_GAP,
    translations: ['פנס'],
    example: { source: `The ${STUB_GAP} is bright.`, target: 'הפנס בהיר.' },
  });
  ns = mockNamespace(expect.getState().currentTestName ?? 'prepare-session-question-types');
  boss = await startTestBoss(t.db);
  logger = createFakeLogger();
  deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns) });
});

afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

type Stub = NonNullable<Parameters<typeof expectDistractors>[1]>;

/** Prepares a question-types session of `types` and reads it back. */
async function prepared(
  types: QuestionType[],
  tasks: Stub['tasks'] | null,
  stub: Omit<Stub, 'tasks'> = {},
  check: Parameters<typeof expectCheck>[1] = {},
) {
  // Null: no distractor stub at all, so a batch call would find no answer and fail.
  if (tasks !== null) await expectDistractors(ns, { tasks, ...stub });
  await expectCheck(ns, check);
  const sessionId = await withTx(t.db, (tx) =>
    createSessionRepo(tx).insertQuestionTypesSession('u_1', ENROLLMENT, { listening: true, speaking: true }, null),
  );
  await deps.sessions.prepareSession({
    session_id: sessionId,
    picks: [{ gloss_id: word.glossIds[0], sense_id: word.senseIds[0], variant_id: word.variantId, known_meanings: ['עששית'] }],
    listening: true,
    speaking: true,
    question_types: types,
  });
  return { sessionId, record: await deps.sessions.getSession('u_1', sessionId) };
}

const EVERY: QuestionType[] = [
  'meet',
  'multiple_choice',
  'new_meaning',
  'typed_meaning',
  'reverse_choice',
  'cloze_choice',
  'letter_tiles',
  'typed_translation',
  'cloze_typed',
  'sentence_translation',
  'listen_choice',
  'dictation',
  'read_aloud',
  'say_translation',
];
const EVERY_TASKS: Stub['tasks'] = [null, 'meaning', 'meaning', null, 'word', 'gap', null, 'typed', 'sentence', 'translate', 'meaning', null, null, 'typed'];

describe('prepareSession with question_types', () => {
  it('builds exactly the chosen cards, in the order given, and names none skipped', async () => {
    const { record } = await prepared(EVERY, EVERY_TASKS);
    expect(record.status).toBe('ready');
    expect(record.questions.map((question) => question.type)).toEqual(EVERY);
    expect(record.skipped_types).toEqual([]);
  });

  it('drops a sentence card with no usable sentence and names it, rather than asking a typed translation', async () => {
    const { record } = await prepared(['multiple_choice', 'sentence_translation'], ['meaning', 'translate'], {
      overrides: { q2: { sentence: undefined, gap: undefined, translation: undefined } },
    });
    expect(record.questions.map((question) => question.type)).toEqual(['multiple_choice']);
    expect(record.skipped_types).toEqual([{ type: 'sentence_translation', reason: 'not_generated' }]);
  });

  // Phase 62d (spec D4, ruling R3). A typed gap the reader cannot place, whose one rewrite
  // fails too (the stub writes its old sentence back), is dropped and named, never shown.
  it('drops a typed gap whose sentence points to nothing, and names it', async () => {
    await expectPoint(ns, { q2: { guesses: ['kettle', 'pillow', 'ladder'], meaning: 'קומקום', readers: 3 } });
    const { record } = await prepared(['multiple_choice', 'cloze_typed'], ['meaning', 'sentence']);
    expect(record.questions.map((question) => question.type)).toEqual(['multiple_choice']);
    expect(record.skipped_types).toEqual([{ type: 'cloze_typed', reason: 'not_generated' }]);
  });

  it('drops a choice card short of wrong options and names it', async () => {
    const { record } = await prepared(['multiple_choice', 'typed_translation'], ['meaning', 'typed'], {
      overrides: { q1: { distractors: ['קיר'] } },
    });
    expect(record.questions.map((question) => question.type)).toEqual(['typed_translation']);
    expect(record.skipped_types).toEqual([{ type: 'multiple_choice', reason: 'not_generated' }]);
  });

  it('keeps a choice card the checker finds ambiguous, as generated', async () => {
    const { record } = await prepared(['multiple_choice', 'typed_translation'], ['meaning', 'typed'], {}, {
      overrides: { q1: { options: [true, false, false] } },
    });
    expect(record.questions.map((question) => question.type)).toEqual(['multiple_choice', 'typed_translation']);
    expect(record.skipped_types).toEqual([]);
  });

  // Final review (minor 3). Nothing to ask the model: no batch call is made, so none can fail it.
  it('makes no batch call when no chosen card needs one', async () => {
    const { record } = await prepared(['meet', 'typed_meaning', 'letter_tiles', 'dictation', 'read_aloud'], null);
    expect(record.status).toBe('ready');
    expect(record.questions.map((question) => question.type)).toEqual(['meet', 'typed_meaning', 'letter_tiles', 'dictation', 'read_aloud']);
  });

  // Final review (minor 5). Each card the session went without is logged with why.
  it('logs why each card it went without was dropped, the failed session too', async () => {
    await prepared(['multiple_choice'], ['meaning'], { overrides: { q1: { distractors: ['קיר'] } } });
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: 'card_dropped', type: 'multiple_choice', stage: 'validation' }),
    );
  });

  it('keeps a meet card alone', async () => {
    const { record } = await prepared(['meet'], [null]);
    expect(record.status).toBe('ready');
    expect(record.questions.map((question) => question.type)).toEqual(['meet']);
  });

  it('fails the session at once, naming every type, when no card could be generated', async () => {
    const { record } = await prepared(['multiple_choice'], ['meaning'], { overrides: { q1: { distractors: ['קיר'] } } });
    expect(record.status).toBe('failed');
    expect(record.questions).toEqual([]);
    expect(record.skipped_types).toEqual([{ type: 'multiple_choice', reason: 'not_generated' }]);
  });

  it('counts its answers as any session does', async () => {
    const { sessionId, record } = await prepared(['multiple_choice', 'reverse_choice'], ['meaning', 'word']);
    let result;
    for (const question of record.questions) {
      result = await deps.sessions.submitAnswer('u_1', sessionId, question.id, {
        option_index: (question as { correct_option: number }).correct_option,
      });
    }
    expect(result!.complete).toBe(true);
    const done = await deps.sessions.getSession('u_1', sessionId);
    expect(done.progress.map((change) => change.glossId)).toEqual([word.glossIds[0]]);
  });
});
