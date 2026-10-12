import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { CONTEXT_MARKER } from '../../../src/domain/context';
import type { Task } from '../../../src/domain/distractors';
import type { PrepareSessionPayload } from '../../../src/domain/jobs';
import { JUDGE_MARKER } from '../../../src/domain/judge';
import { createSessionRepo } from '../../../src/repo/sessions';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { NO_DEVICES } from '../../support/questions';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  countGeminiRequests,
  expectCheck,
  expectContext,
  expectDistractors,
  expectJudge,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

// Phase 34 (spec D6, D7, D8; rulings R8, R11). A list session is prepared through
// MockServer: the batch, then the context call, and the cards come back from the
// database with the sentence each shows and its marked word. The audit's cards,
// rebuilt on real rows: d388f738 (C), 71b0b407 (E), a7d6bdb4 (H), eb95d246 (F).

let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;
let logger: FakeLogger;
let ns: string;
const EN = enrollmentOf('u_1');

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  ns = mockNamespace(expect.getState().currentTestName ?? 'prepare-session-context');
  boss = await startTestBoss(t.db);
  logger = createFakeLogger();
  deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns) });
});

afterEach(async () => {
  await stopTestBoss(boss);
  await clearNamespace(ns);
  await t.close();
});

type Saved = { variantId: string; glossIds: string[]; senseIds: string[] };

/** An English word saved with one rendering, stamped by the accept job. */
async function saved(input: { lemma: string; partOfSpeech: string; translation: string; example?: { source: string; target: string }; accepted?: string[] }): Promise<Saved> {
  const word = await seedSavedSenses(t.db, {
    enrollmentId: EN, lemma: input.lemma, partOfSpeech: input.partOfSpeech, translations: [input.translation], example: input.example,
  });
  await t.db.execute(sql`
    update dict_var_translations
    set accepted_answers = ${sql.raw(`array[${(input.accepted ?? []).map((a) => `'${a}'`).join(',')}]::text[]`)}, accepted_at = now()
    where variant_id = ${word.variantId}`);
  return word;
}
const pick = (word: Saved) => ({ gloss_id: word.glossIds[0], sense_id: word.senseIds[0], variant_id: word.variantId });

// Phase 35 (spec D6). The job chooses each pick's card from the dimension, rung,
// level and R the pick carries, highest chance of success first; these picks
// name theirs. THREE is a multiple choice, a reversed card and a typed
// translation, in that order (p 1, 0.78, 0.7).
type Card = Partial<Pick<PrepareSessionPayload['picks'][number], 'dimension' | 'rung' | 'level' | 'r'>>;
const PICK_FORM: Card = { dimension: 'written_productive', rung: 1, level: 1, r: 0.5 }; // reverse or cloze choice, p 0.78
/** Typed recall of the form, p = R: typed translation, typed cloze, sentence translation in turn. */
const produce = (r: number): Card => ({ dimension: 'written_productive', rung: 2, level: 3, r });
const THREE: Card[] = [{}, PICK_FORM, produce(0.7)];
const steered = <P extends object>(picks: P[], cards: Card[]) => picks.map((p, i) => ({ ...p, ...cards[i] }));
/** A typed meaning, a tiles card and a sentence translation, then a typed
 *  translation and a typed cloze, asked last, which a sentence translation
 *  needs before it (p 0.99, 0.9, 0.88, 0.6, 0.5). */
const SENTENCE_CARDS: Card[] = [
  { dimension: 'written_receptive', rung: 2, level: 3, r: 0.99 },
  { dimension: 'written_productive', rung: 1, level: 1, r: 0.81 },
  produce(0.6),
  produce(0.5),
  produce(0.88),
];

const SAW_SENTENCE = 'Please saw the plank in half.';
const SAW_HEBREW = 'בבקשה תנסר את הקרש לשניים.';
const DOWNLOAD_SENTENCE = 'אני רוצה להוריד את המשחק החדש הלילה.';

const words = async () => ({
  saw: await saved({ lemma: 'saw', partOfSpeech: 'verb', translation: 'לנסר', example: { source: 'He will saw the branch off.', target: 'הוא ינסר את הענף.' } }),
  table: await saved({ lemma: 'table', partOfSpeech: 'noun', translation: 'שולחן' }),
  download: await saved({
    lemma: 'download', partOfSpeech: 'verb', translation: 'להוריד', accepted: ['get'],
    example: { source: 'I need to download the file first.', target: 'אני צריך להוריד את הקובץ קודם.' },
  }),
  lamp: await saved({ lemma: 'lamp', partOfSpeech: 'noun', translation: 'מנורה' }),
  combine: await saved({ lemma: 'combine', partOfSpeech: 'verb', translation: 'לשלב' }),
  // Phase 35 (spec D6): the typed translation and typed cloze a sentence translation needs before it.
  river: await saved({ lemma: 'river', partOfSpeech: 'noun', translation: 'נהר' }),
  bread: await saved({ lemma: 'bread', partOfSpeech: 'noun', translation: 'לחם' }),
});

/** Prepares one session over `picks`, each with its card, and reads it back,
 *  with the rows as stored. Skipped after, so the next call can prepare another. */
async function prepared(
  picks: ReturnType<typeof pick>[],
  cards: Card[],
  batch: { tasks: Task[]; overrides?: Record<string, Record<string, unknown>> },
  context: Parameters<typeof expectContext>[1] | null,
  contextOpts: Parameters<typeof expectContext>[2] = {},
  /** Phase 34 (spec D5). How the checker reads each sentence the context call wrote. */
  check: Record<string, Record<string, unknown>> = {},
) {
  await clearNamespace(ns);
  await expectDistractors(ns, batch);
  if (context !== null) await expectContext(ns, context, contextOpts);
  await expectCheck(ns, { overrides: check });
  const sessionId = await withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession('u_1', EN, NO_DEVICES));
  await deps.sessions.prepareSession({ session_id: sessionId, picks: steered(picks, cards), listening: false, speaking: false });
  const record = await deps.sessions.getSession('u_1', sessionId);
  expect(record.status).toBe('ready');
  const stored = await t.db.execute<{
    type: string; context: string | null; context_translation: string | null; context_mark_start: number | null;
    context_mark_end: number | null; sentence_mark_start: number | null; sentence_mark_end: number | null;
  }>(sql`
    select q.type, q.context, q.context_translation, q.context_mark_start, q.context_mark_end, q.sentence_mark_start, q.sentence_mark_end
    from questions q join session_questions sq on sq.question_id = q.id
    where sq.session_id = ${sessionId} order by sq.position`);
  return { sessionId, questions: record.questions, stored: stored.rows };
}

// Three picks: a multiple choice, a reversed card and a typed translation.
const CHOICES_BATCH = { tasks: ['meaning', 'word', 'typed'] as Task[], overrides: { q1: { distractors: ['לשייף', 'לקדוח', 'לשבור'] } } };
const CHOICES_CONTEXT = [
  { key: 'q1', context: SAW_SENTENCE, context_translation: SAW_HEBREW, context_word: 'saw' },
  { key: 'q2', context: 'השולחן במטבח עשוי מעץ.', context_translation: 'The kitchen table is made of wood.', context_word: 'השולחן' },
  { key: 'q3', context: DOWNLOAD_SENTENCE, context_translation: 'I want to download the new game tonight.', context_word: 'להוריד' },
];
// Phase 34 (spec D5). The checker reads each sentence as the writer meant it.
const CHOICES_CHECK = { q1c: { context_meaning: 'לנסר' }, q2c: { context_words: ['table'] }, q3c: { context_words: ['download'] } };
// A typed meaning, a tiles card and a sentence translation, then river and bread (SENTENCE_CARDS).
const SENTENCES_BATCH = {
  tasks: ['meaning', 'meaning', 'translate', 'typed', 'sentence'] as Task[],
  overrides: { q3: { sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", gap: 'combine' } },
};
const SENTENCES_CONTEXT = [
  { key: 'q1', context: SAW_SENTENCE, context_translation: SAW_HEBREW, context_word: 'saw' },
  { key: 'q3', sentence_word: 'נשלב' },
];
const SENTENCES_CHECK = { q1c: { context_meaning: 'לנסר' }, q3: { natural_translation: "Let's combine forces." } };

const ofType = <T extends Question['type']>(questions: Question[], type: T) =>
  questions.find((q): q is Extract<Question, { type: T }> => q.type === type)!;

describe('context sentences and marks, through the database', () => {
  it('category C (d388f738): the typed card for להוריד shows a Hebrew sentence that pins the download sense, its word marked', async () => {
    const w = await words();
    const { questions, stored } = await prepared([pick(w.saw), pick(w.table), pick(w.download)], THREE, CHOICES_BATCH, CHOICES_CONTEXT, {}, CHOICES_CHECK);
    expect(ofType(questions, 'typed_translation')).toMatchObject({
      question: 'להוריד', answer: 'download', context: { text: DOWNLOAD_SENTENCE, mark: { start: 9, end: 15 } },
    });
    expect(stored[2]).toEqual({
      type: 'typed_translation', context: DOWNLOAD_SENTENCE, context_translation: 'I want to download the new game tonight.',
      context_mark_start: 9, context_mark_end: 15, sentence_mark_start: null, sentence_mark_end: null,
    });
  });

  it('category H (a7d6bdb4): the multiple choice for saw shows an English sentence with saw marked', async () => {
    const w = await words();
    const { questions, stored } = await prepared([pick(w.saw), pick(w.table), pick(w.download)], THREE, CHOICES_BATCH, CHOICES_CONTEXT, {}, CHOICES_CHECK);
    expect(ofType(questions, 'multiple_choice')).toMatchObject({ question: 'saw', context: { text: SAW_SENTENCE, mark: { start: 7, end: 10 } } });
    expect(stored[0]).toMatchObject({ context_translation: SAW_HEBREW });
    expect(ofType(questions, 'reverse_choice')).toMatchObject({ context: { text: 'השולחן במטבח עשוי מעץ.', mark: { start: 0, end: 6 } } });
  });

  it('category E (71b0b407): the typed meaning for saw shows its sentence, and the judge is given that sentence and its Hebrew', async () => {
    const w = await words();
    const { sessionId, questions } = await prepared([pick(w.saw), pick(w.lamp), pick(w.river), pick(w.bread), pick(w.combine)], SENTENCE_CARDS, SENTENCES_BATCH, SENTENCES_CONTEXT, {}, SENTENCES_CHECK);
    const meaning = ofType(questions, 'typed_meaning');
    expect(meaning).toMatchObject({ question: 'saw', context: { text: SAW_SENTENCE, mark: { start: 7, end: 10 } } });

    await expectJudge(ns, 'right');
    await deps.sessions.answerJudged('u_1', sessionId, { questionId: meaning.id, text: 'מנסר' });
    // The judge's request carries the card's sentence and its other half (spec D7), not the saved example.
    expect(await countGeminiRequests(ns, JUDGE_MARKER)).toBe(1);
    expect(await countGeminiRequests(ns, `${JUDGE_MARKER}[\\s\\S]*Please saw the plank in half[\\s\\S]*תנסר את הקרש`)).toBe(1);
    expect(await countGeminiRequests(ns, `${JUDGE_MARKER}[\\s\\S]*He will saw the branch off`)).toBe(0);
  });

  it('category F (eb95d246): the sentence card for combine marks נשלב in בואו נשלב כוחות', async () => {
    const w = await words();
    const { questions, stored } = await prepared([pick(w.saw), pick(w.lamp), pick(w.river), pick(w.bread), pick(w.combine)], SENTENCE_CARDS, SENTENCES_BATCH, SENTENCES_CONTEXT, {}, SENTENCES_CHECK);
    expect(ofType(questions, 'sentence_translation')).toMatchObject({ question: 'בואו נשלב כוחות.', answer: 'combine', mark: { start: 5, end: 9 } });
    expect(stored[2]).toMatchObject({ type: 'sentence_translation', context: null, sentence_mark_start: 5, sentence_mark_end: 9 });
    // The tiles card shows no sentence.
    expect(stored[1]).toMatchObject({ type: 'letter_tiles', context: null });
  });

  // Ruling R11.
  it('prepares the session when the context call fails: each card falls back on its saved example, unmarked, or shows none', async () => {
    const w = await words();
    const { questions, stored } = await prepared([pick(w.saw), pick(w.table), pick(w.download)], THREE, CHOICES_BATCH, null);
    expect(await countGeminiRequests(ns, CONTEXT_MARKER)).toBe(1);
    expect(ofType(questions, 'multiple_choice')).toMatchObject({ context: { text: 'He will saw the branch off.', mark: null } });
    expect(ofType(questions, 'reverse_choice')).toMatchObject({ context: null });
    expect(ofType(questions, 'typed_translation')).toMatchObject({ context: { text: 'אני צריך להוריד את הקובץ קודם.', mark: null } });
    expect(stored[2]).toMatchObject({ context_translation: 'I need to download the file first.' });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_call_failed' }));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_missing', position: 1, type: 'reverse_choice' }));
  });

  // Ruling R12: the context call has its own short budget, so a hang costs the
  // sentences (R11), never the session, and never the batch's five minutes.
  it('falls back, and prepares the session, when the context call outruns its own budget', async () => {
    deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss, geminiBaseUrl: geminiBaseUrlFor(ns), contextCallTimeoutMs: 500 });
    const w = await words();
    const started = Date.now();
    const { questions } = await prepared([pick(w.saw), pick(w.table), pick(w.download)], THREE, CHOICES_BATCH, CHOICES_CONTEXT, { delayMs: 5_000 }, CHOICES_CHECK);
    expect(Date.now() - started).toBeLessThan(4_000);
    // The answer came too late to be used: each card is on its saved example.
    expect(ofType(questions, 'multiple_choice')).toMatchObject({ context: { text: 'He will saw the branch off.', mark: null } });
    expect(ofType(questions, 'typed_translation')).toMatchObject({ context: { text: 'אני צריך להוריד את הקובץ קודם.', mark: null } });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_call_failed', reason: expect.stringMatching(/timed out/) }));
  });

  it('never shows a sentence a recent session showed for that gloss on that card', async () => {
    const w = await words();
    const picks = [pick(w.saw), pick(w.table), pick(w.download)];
    const first = await prepared(picks, THREE, CHOICES_BATCH, CHOICES_CONTEXT, {}, CHOICES_CHECK);
    await deps.sessions.skipSession('u_1', first.sessionId);
    const second = await prepared(picks, THREE, CHOICES_BATCH, CHOICES_CONTEXT, {}, CHOICES_CHECK);
    expect(ofType(second.questions, 'typed_translation')).toMatchObject({ context: { text: 'אני צריך להוריד את הקובץ קודם.', mark: null } });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'context_dropped', type: 'typed_translation', reason: expect.stringContaining('recent') }));
  });
});
