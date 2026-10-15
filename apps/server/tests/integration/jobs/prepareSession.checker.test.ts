import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import { CHECK_MARKER } from '../../../src/domain/check';
import { DISTRACTOR_MARKER, type Task } from '../../../src/domain/distractors';
import type { PrepareSessionPayload } from '../../../src/domain/jobs';
import { createSessionRepo } from '../../../src/repo/sessions';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { CHOSEN_ON, NO_DEVICES } from '../../support/questions';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  countGeminiRequests,
  expectCheck,
  expectDistractors,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { enrollmentOf, seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';

// Phase 34 (spec D3, D4, D5). A list session is prepared through MockServer:
// the batch, the context call (unstubbed here, so every card is on its
// fallback), then the checker, and the cards come back from the database with
// only the wrong options nobody knows to be right. The audit's cards, rebuilt on
// real rows: c49ddbec, 0fa3fc06, the saw homograph and 3c482348 (A), eb95d246 (F).

let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;
let logger: FakeLogger;
let ns: string;
const EN = enrollmentOf('u_1');
const IT = 'e_it';

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: IT, userId: 'u_1', targetLanguage: 'it' });
  ns = mockNamespace(expect.getState().currentTestName ?? 'prepare-session-checker');
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
const pick = (word: Saved, i = 0) => ({ gloss_id: word.glossIds[i], sense_id: word.senseIds[i], variant_id: word.variantId });

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
const saved = (enrollmentId: string, lemma: string, translations: string[], over: { partOfSpeech?: string; languageCode?: string } = {}) =>
  seedSavedSenses(t.db, { enrollmentId, lemma, translations, partOfSpeech: over.partOfSpeech ?? 'verb', languageCode: over.languageCode });

/** Prepares one session and reads it back, with its cards' stored options. */
async function prepared(
  enrollmentId: string,
  picks: ReturnType<typeof pick>[],
  cards: Card[],
  batch: { tasks: Task[]; overrides?: Record<string, Record<string, unknown>> },
  check: Parameters<typeof expectCheck>[1] = {},
) {
  await clearNamespace(ns);
  await expectDistractors(ns, batch);
  await expectCheck(ns, check);
  const sessionId = await withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession('u_1', enrollmentId, NO_DEVICES, CHOSEN_ON));
  await deps.sessions.prepareSession({ session_id: sessionId, picks: steered(picks, cards), listening: false, speaking: false });
  const record = await deps.sessions.getSession('u_1', sessionId);
  expect(record.status).toBe('ready');
  return { sessionId, questions: record.questions };
}

const choiceOf = (questions: Question[], type: 'multiple_choice' | 'reverse_choice') => {
  const card = questions.find((q) => q.type === type);
  if (!card || (card.type !== 'multiple_choice' && card.type !== 'reverse_choice')) throw new Error(`no ${type}`);
  return card;
};
const CHOICE_TASKS: Task[] = ['meaning', 'word', 'typed'];

describe('the known-right set and the checker, through the database', () => {
  it('category A (c49ddbec): the card for pick up never offers להרים, its other saved sense, and a spare takes its place', async () => {
    const pickUp = await saved(EN, 'pick up', ['לענות', 'להרים']);
    const table = await saved(EN, 'table', ['שולחן'], { partOfSpeech: 'noun' });
    const lamp = await saved(EN, 'lamp', ['מנורה'], { partOfSpeech: 'noun' });
    const { questions } = await prepared(EN, [pick(pickUp, 0), pick(table), pick(lamp)], THREE, {
      tasks: CHOICE_TASKS,
      overrides: { q1: { distractors: ['להרים', 'לכתוב', 'לשיר', 'לרקוד'] } },
    });
    const card = choiceOf(questions, 'multiple_choice');
    expect(card.question).toBe('pick up');
    expect([...card.options].sort()).toEqual(['לכתוב', 'לענות', 'לרקוד', 'לשיר'].sort());
    expect(card.options[card.correct_option]).toBe('לענות');
  });

  it('category A (the saw homograph): the card for saw never offers ראה, which see’s form saw means', async () => {
    const saw = await saved(EN, 'saw', ['לנסר']);
    await insertLexeme(t.db, {
      lemma: 'see', languageCode: 'en', partOfSpeech: 'verb', userLanguageCode: 'he',
      senses: [{ senseCode: 'perceive' }],
      variants: [
        { form: 'see', kind: 'word', entryRank: 0, translations: [{ senseCode: 'perceive', rank: 0, translation: 'לראות', exampleSource: null, exampleTarget: null }] },
        { form: 'saw', kind: 'word', entryRank: 1, translations: [{ senseCode: 'perceive', rank: 0, translation: 'ראה', gloss: 'לראות', exampleSource: null, exampleTarget: null }] },
      ],
    });
    const table = await saved(EN, 'table', ['שולחן'], { partOfSpeech: 'noun' });
    const lamp = await saved(EN, 'lamp', ['מנורה'], { partOfSpeech: 'noun' });
    const { questions } = await prepared(EN, [pick(saw), pick(table), pick(lamp)], THREE, {
      tasks: CHOICE_TASKS,
      overrides: { q1: { distractors: ['ראה', 'לשייף', 'לקדוח', 'לשבור'] } },
    });
    expect([...choiceOf(questions, 'multiple_choice').options].sort()).toEqual(['לנסר', 'לשייף', 'לקדוח', 'לשבור'].sort());
  });

  it('category A (0fa3fc06): the reversed card for תכף never offers presto, which the accept job stored for that Hebrew', async () => {
    const casa = await saved(IT, 'casa', ['בית'], { languageCode: 'it', partOfSpeech: 'noun' });
    const ora = await saved(IT, 'ora', ['תכף'], { languageCode: 'it', partOfSpeech: 'adverb' });
    // Another headword's rendering of the same Hebrew, as 3047ed47's list had it.
    const subito = await insertLexeme(t.db, {
      lemma: 'subito', languageCode: 'it', partOfSpeech: 'adverb', userLanguageCode: 'he',
      senses: [{ senseCode: 'soon' }],
      variants: [{ form: 'subito', kind: 'word', entryRank: 0, translations: [{ senseCode: 'soon', rank: 0, translation: 'תכף', exampleSource: null, exampleTarget: null }] }],
    });
    await t.db.execute(sql`update dict_var_translations set accepted_answers = array['presto']::text[], accepted_at = now() where variant_id = ${subito.variantIds[0]}`);
    const cane = await saved(IT, 'cane', ['כלב'], { languageCode: 'it', partOfSpeech: 'noun' });
    const { questions } = await prepared(IT, [pick(casa), pick(ora), pick(cane)], THREE, {
      tasks: CHOICE_TASKS,
      overrides: { q2: { distractors: ['presto', 'subito', 'sempre', 'mai', 'ieri'] } },
    });
    const reversed = choiceOf(questions, 'reverse_choice');
    expect(reversed.question).toBe('תכף');
    expect([...reversed.options].sort()).toEqual(['ieri', 'mai', 'ora', 'sempre'].sort());
  });

  it('category A (3c482348): the card for blow up drops להרוס when the checker says it is also right, and stores the next spare', async () => {
    const blowUp = await saved(EN, 'blow up', ['לנפח']);
    const table = await saved(EN, 'table', ['שולחן'], { partOfSpeech: 'noun' });
    const lamp = await saved(EN, 'lamp', ['מנורה'], { partOfSpeech: 'noun' });
    const { questions } = await prepared(
      EN,
      [pick(blowUp), pick(table), pick(lamp)],
      THREE,
      { tasks: CHOICE_TASKS, overrides: { q1: { distractors: ['להרוס', 'לקפל', 'לשבור', 'לצבוע', 'לבשל', 'לכתוב'] } } },
      { overrides: { q1: { options: [true, false, false, false, false, false] } } },
    );
    expect([...choiceOf(questions, 'multiple_choice').options].sort()).toEqual(['לנפח', 'לקפל', 'לשבור', 'לצבוע'].sort());
    expect(await countGeminiRequests(ns, CHECK_MARKER)).toBe(1);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'checker_dropped', kind: 'option', text: 'להרוס' }));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', checker_ms: expect.any(Number), check_count: 2 }));
  });

  it('category F (eb95d246): stores בואו נשלב כוחות as a typed translation when the checker says it naturally, without combine', async () => {
    const saw = await saved(EN, 'saw', ['לנסר']);
    const lamp = await saved(EN, 'lamp', ['מנורה'], { partOfSpeech: 'noun' });
    const combine = await saved(EN, 'combine', ['לשלב']);
    const river = await saved(EN, 'river', ['נהר'], { partOfSpeech: 'noun' });
    const bread = await saved(EN, 'bread', ['לחם'], { partOfSpeech: 'noun' });
    const picks = [pick(saw), pick(lamp), pick(river), pick(bread), pick(combine)];
    const batch = {
      tasks: ['meaning', 'meaning', 'translate', 'typed', 'sentence'] as Task[],
      overrides: { q3: { sentence: 'בואו נשלב כוחות.', translation: "Let's combine forces.", gap: 'combine' } },
    };
    const joined = await prepared(EN, picks, SENTENCE_CARDS, batch, { overrides: { q3: { natural_translation: "Let's join forces." } } });
    expect(joined.questions[2]).toMatchObject({ type: 'typed_translation', question: 'לשלב', answer: 'combine' });
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'sentence_degraded', position: 2, type: 'sentence_translation' }));
    await deps.sessions.skipSession('u_1', joined.sessionId);

    const kept = await prepared(EN, picks, SENTENCE_CARDS, batch, { overrides: { q3: { natural_translation: "Let's combine our forces." } } });
    expect(kept.questions[2]).toMatchObject({ type: 'sentence_translation', question: 'בואו נשלב כוחות.' });
  });

  it('prepares nothing when the checker fails, so pg-boss retries the attempt', async () => {
    const blowUp = await saved(EN, 'blow up', ['לנפח']);
    const table = await saved(EN, 'table', ['שולחן'], { partOfSpeech: 'noun' });
    const lamp = await saved(EN, 'lamp', ['מנורה'], { partOfSpeech: 'noun' });
    await expectDistractors(ns, { tasks: CHOICE_TASKS });
    await expectCheck(ns, { status: 500 });
    const sessionId = await withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession('u_1', EN, NO_DEVICES, CHOSEN_ON));
    await expect(
      deps.sessions.prepareSession({ session_id: sessionId, picks: steered([pick(blowUp), pick(table), pick(lamp)], THREE), listening: false, speaking: false }),
    ).rejects.toThrow();
    expect((await deps.sessions.getSession('u_1', sessionId)).status).toBe('preparing');
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_preparation_attempt_failed', stage: 'checker' }));
  });

  // Phase 48 (spec Done-means 1 and 3). Lane 0's 38b003b4: the checker calls a card's options right, the same
  // answer every attempt. Seven cards, so the one refused is dropped and the call resolves with the session ready. The new word
  // is a multiple choice (p 1) and asked first; the six typed picks (p 0.7 each) are spread by the plan over the
  // three typed types, a tie going to the type used least: a typed translation, a typed cloze and a sentence
  // translation, twice each. That is what the stubbed tasks name, by position.
  it('drops a card the checker calls entirely right, and keeps the other six', async () => {
    // None of them in the seeded content, whose dictionary already holds window.
    const lemmas = ['blow up', 'table', 'lamp', 'river', 'bread', 'chair', 'pebble'];
    const translations = ['לנפח', 'שולחן', 'מנורה', 'נהר', 'לחם', 'כיסא', 'חלוק'];
    const words: Saved[] = [];
    // One at a time, as every other test here saves its words.
    for (const [i, lemma] of lemmas.entries()) {
      words.push(await saved(EN, lemma, [translations[i]], { partOfSpeech: i === 0 ? 'verb' : 'noun' }));
    }
    const SIX = ['לקפל', 'לשבור', 'לצבוע', 'לבשל', 'לכתוב', 'לשיר'];
    const { questions } = await prepared(
      EN,
      words.map((word) => pick(word)),
      [{}, ...Array.from({ length: 6 }, () => produce(0.7))],
      { tasks: ['meaning', 'typed', 'sentence', 'translate', 'typed', 'sentence', 'translate'], overrides: { q1: { distractors: SIX } } },
      { overrides: { q1: { options: SIX.map(() => true) } } },
    );
    expect(questions).toHaveLength(6);
    expect(questions.map((q) => q.type)).not.toContain('multiple_choice');
    expect(await countGeminiRequests(ns, DISTRACTOR_MARKER)).toBe(1);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'card_dropped', key: 'q1', stage: 'checker' }));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 6, planned_count: 7, dropped_count: 1 }));
  });
});
