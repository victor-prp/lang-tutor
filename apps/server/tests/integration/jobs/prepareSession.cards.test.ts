import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { MultipleChoiceQuestion, Question, ReverseChoiceQuestion, TypedTranslationQuestion } from '@lang-tutor/core/api';
import { judgeTyped } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { AppDeps } from '../../../src/composition';
import type { PrepareSessionPayload } from '../../../src/domain/jobs';
import { createFakeLogger, type FakeLogger } from '../../support/fakes';
import { CHOSEN_ON, NO_DEVICES } from '../../support/questions';
import { startTestBoss, stopTestBoss } from '../../support/jobs';
import {
  assertMockServerReachable,
  clearNamespace,
  expectCheck,
  expectDistractors,
  geminiBaseUrlFor,
  mockNamespace,
} from '../../support/mockServer';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { withTx } from '../../support/withTx';
import { createSessionRepo } from '../../../src/repo/sessions';

// Phase 34 (spec D1, D2, D12). A list session is prepared from renderings that
// carry what the accept job stored, and the cards read it back: the audit's
// 2260df83 (G), 703a58ca (B) and 5d9e4f97 (D), rebuilt on real rows. The accept
// job's own output is written straight to the columns here, as it leaves them.

let t: TestDb;
let boss: PgBoss;
let deps: AppDeps;
let logger: FakeLogger;
let ns: string;
const IT = 'e_it';

beforeEach(async () => {
  await assertMockServerReachable();
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: IT, userId: 'u_1', targetLanguage: 'it' });
  ns = mockNamespace(expect.getState().currentTestName ?? 'prepare-session-cards');
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

/** An Italian word saved from its renderings, each stamped by the accept job:
 *  `stored[i]` is what it left on rendering i (nothing = found no extra answers). */
async function saved(input: {
  lemma: string;
  form?: string;
  translations: string[];
  stored?: { answers: string[]; answerForm?: string }[];
}): Promise<Saved> {
  const word = await seedSavedSenses(t.db, { enrollmentId: IT, languageCode: 'it', ...input });
  for (const [i, senseId] of word.senseIds.entries()) {
    const kept = input.stored?.[i];
    await t.db.execute(sql`
      update dict_var_translations
      set accepted_answers = ${sql.raw(`array[${(kept?.answers ?? []).map((a) => `'${a}'`).join(',')}]::text[]`)},
          answer_form = ${kept?.answerForm ?? null}, accepted_at = now()
      where variant_id = ${word.variantId} and sense_id = ${senseId}`);
  }
  return word;
}

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

/** Prepares one session over `picks` in that order (three words: a choice, a
 *  reversed card, a typed card) and reads it back through the service. */
async function prepared(picks: ReturnType<typeof pick>[], alternatives?: string[]): Promise<{ sessionId: string; questions: Question[] }> {
  await clearNamespace(ns);
  await expectDistractors(ns, { tasks: ['meaning', 'word', 'typed'], ...(alternatives ? { alternatives } : {}) });
  await expectCheck(ns);
  const sessionId = await withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession('u_1', IT, NO_DEVICES, CHOSEN_ON, null));
  await deps.sessions.prepareSession({ session_id: sessionId, picks: steered(picks, THREE), listening: false, speaking: false });
  const record = await deps.sessions.getSession('u_1', sessionId);
  expect(record.status).toBe('ready');
  // One open session per enrollment: the next call prepares another.
  await deps.sessions.skipSession('u_1', sessionId);
  return { sessionId, questions: record.questions };
}

const typedOf = (questions: Question[]) => questions.find((q): q is TypedTranslationQuestion => q.type === 'typed_translation')!;
const verdictOf = (card: TypedTranslationQuestion, text: string) => judgeTyped(card, text);
const storedForms = async (sessionId: string) =>
  (await t.db.execute<{ type: string; answer_form: string | null }>(sql`
    select q.type, q.answer_form from questions q join session_questions sq on sq.question_id = q.id
    where sq.session_id = ${sessionId} order by sq.position`)).rows;

describe('the cards read the rendering’s stored answer form', () => {
  it('category G (2260df83): the card for שעות asks for ore through the database, ora still passes, and the card for שעה refuses ore', async () => {
    const casa = await saved({ lemma: 'casa', translations: ['בית'] });
    const cane = await saved({ lemma: 'cane', translations: ['כלב'] });
    const ora = await saved({
      lemma: 'ora',
      translations: ['שעות', 'שעה'],
      stored: [{ answers: ['ore'], answerForm: 'ore' }, { answers: [] }],
    });

    const hours = await prepared([pick(casa), pick(cane), pick(ora, 0)]);
    const typed = typedOf(hours.questions);
    expect(typed.answer).toBe('ore');
    expect(typed.lemma).toBe('ora');
    expect(verdictOf(typed, 'ore')).toBe('exact');
    expect(verdictOf(typed, 'ora')).toBe('exact');
    expect(await storedForms(hours.sessionId)).toEqual([
      { type: 'multiple_choice', answer_form: null },
      { type: 'reverse_choice', answer_form: null },
      { type: 'typed_translation', answer_form: 'ore' },
    ]);

    const hour = await prepared([pick(casa), pick(cane), pick(ora, 1)]);
    const singular = typedOf(hour.questions);
    expect(singular.answer).toBe('ora');
    expect(verdictOf(singular, 'ora')).toBe('exact');
    expect(verdictOf(singular, 'ore')).toBe('wrong');
  });

  it('category G (82d0e084, f5ea57a9): a choice card shows ore beside שעות, and the reversed card’s right option is ore', async () => {
    const casa = await saved({ lemma: 'casa', translations: ['בית'] });
    const cane = await saved({ lemma: 'cane', translations: ['כלב'] });
    const ora = await saved({ lemma: 'ora', translations: ['שעות'], stored: [{ answers: ['ore'], answerForm: 'ore' }] });

    const first = await prepared([pick(ora), pick(casa), pick(cane)]);
    const choice = first.questions[0] as MultipleChoiceQuestion;
    expect(choice.type).toBe('multiple_choice');
    expect(choice.question).toBe('ore');
    expect(choice.options[choice.correct_option]).toBe('שעות');

    const second = await prepared([pick(casa), pick(ora), pick(cane)]);
    const reversed = second.questions[1] as ReverseChoiceQuestion;
    expect(reversed.type).toBe('reverse_choice');
    expect(reversed.question).toBe('שעות');
    expect(reversed.options[reversed.correct_option]).toBe('ore');
  });
});

describe('the cards read the rendering’s stored accepted answers', () => {
  it('category B (703a58ca): two sessions for poi/אז accept allora, whatever each session’s own alternatives were', async () => {
    const casa = await saved({ lemma: 'casa', translations: ['בית'] });
    const cane = await saved({ lemma: 'cane', translations: ['כלב'] });
    const poi = await saved({ lemma: 'poi', translations: ['אז'], stored: [{ answers: ['allora', 'dopo'] }] });

    for (const own of [['quindi'], ['dunque', 'perciò']]) {
      const { questions } = await prepared([pick(casa), pick(cane), pick(poi)], own);
      const typed = typedOf(questions);
      expect(typed.alternatives).toEqual(['allora', 'dopo', ...own]);
      expect(verdictOf(typed, 'allora')).toBe('alternative');
      expect(verdictOf(typed, 'dopo')).toBe('alternative');
    }
    // Nothing a session wrote went back to the dictionary.
    const rows = await t.db.execute<{ accepted_answers: string[] }>(
      sql`select accepted_answers from dict_var_translations where variant_id = ${poi.variantId}`,
    );
    expect(rows.rows).toEqual([{ accepted_answers: ['allora', 'dopo'] }]);
  });

  it('category D (5d9e4f97): io ho is accepted for יש לי when the stored list holds it', async () => {
    const casa = await saved({ lemma: 'casa', translations: ['בית'] });
    const cane = await saved({ lemma: 'cane', translations: ['כלב'] });
    const avere = await saved({ lemma: 'avere', form: 'ho', translations: ['יש לי'], stored: [{ answers: ['io ho'] }] });

    const { questions } = await prepared([pick(casa), pick(cane), pick(avere)]);
    const typed = typedOf(questions);
    expect(typed.answer).toBe('ho');
    expect(verdictOf(typed, 'io ho')).toBe('alternative');
    expect(verdictOf(typed, 'avere')).toBe('exact');
  });

  it('asks for the form it always did when the rendering has no stored answers yet', async () => {
    const casa = await saved({ lemma: 'casa', translations: ['בית'] });
    const cane = await saved({ lemma: 'cane', translations: ['כלב'] });
    const avere = await saved({ lemma: 'avere', form: 'ho', translations: ['יש לי'] });
    await t.db.execute(sql`update dict_var_translations set accepted_at = null where variant_id = ${avere.variantId}`);

    const { questions } = await prepared([pick(casa), pick(cane), pick(avere)], ['io ho']);
    const typed = typedOf(questions);
    expect(typed.answer).toBe('ho');
    expect(typed.alternatives).toEqual(['io ho']);
  });
});

// Phase 57 (spec D7, ruling T3-l). A target path's session is planned with its payload's `target`
// flag: no type held to MAX_PER_TYPE, and no one-word speaking rule, so a card never falls back
// to one that serves none of the target's owed work.
describe("a target path's session (phase 57, ruling T3-l)", () => {
  /** A target pick, recall at R 1, as the target picker makes one. */
  const owed = (word: Saved, dimension: PrepareSessionPayload['picks'][number]['dimension']) => ({
    ...pick(word),
    dimension,
    rung: 2 as const,
    level: 1,
    r: 1,
    step: false,
  });

  async function preparedTarget(
    picks: PrepareSessionPayload['picks'],
    tasks: ('typed' | 'meaning' | 'word' | null)[],
    devices: { listening: boolean; speaking: boolean },
  ): Promise<string[]> {
    await clearNamespace(ns);
    await expectDistractors(ns, { tasks });
    await expectCheck(ns);
    const sessionId = await withTx(t.db, (tx) => createSessionRepo(tx).insertPreparingSession('u_1', IT, devices, CHOSEN_ON, null));
    await deps.sessions.prepareSession({ session_id: sessionId, picks, ...devices, target: true });
    const record = await deps.sessions.getSession('u_1', sessionId);
    expect(record.status).toBe('ready');
    await deps.sessions.skipSession('u_1', sessionId);
    // Each card was planned as the type it is asked as: none fell back and was refused for the
    // model's answer to another task (phase 48's degraded typed translation would hide it).
    expect(logger.events.filter((line) => line.event === 'card_kept_refused' || line.event === 'card_dropped')).toEqual([]);
    return record.questions.map((question) => question.type);
  }

  it('asks a session of one speaking pick its say-translation card', async () => {
    const parola = await saved({ lemma: 'parola', translations: ['מילה'] });
    expect(await preparedTarget([owed(parola, 'spoken_productive')], ['typed'], { listening: false, speaking: true })).toEqual(['say_translation']);
  });

  it('asks a step-down as see it, pick it, produce it: a read aloud, a reverse choice and its typed translation (phase 68 D2)', async () => {
    const parola = await saved({ lemma: 'parola', translations: ['מילה'] });
    const types = await preparedTarget([{ ...owed(parola, 'written_productive'), relearn: true }], [null, 'word', 'typed'], {
      listening: false,
      speaking: true,
    });
    expect(types).toEqual(['read_aloud', 'reverse_choice', 'typed_translation']);
  });

  it('keeps five typed picks typed: no type is held to four', async () => {
    // Five words to a form: too long to say, so no sentence card is eligible and typed translation
    // is the rung's only written card.
    const lemmas = ['uno due tre quattro cinque', 'sei sette otto nove dieci', 'alfa beta gamma delta epsilon', 'rosso blu verde giallo nero', 'mare monte lago fiume valle'];
    const words: Saved[] = [];
    for (const [i, lemma] of lemmas.entries()) words.push(await saved({ lemma, translations: [`ביטוי${i}`] }));
    const types = await preparedTarget(
      words.map((word) => owed(word, 'written_productive')),
      ['typed', 'typed', 'typed', 'typed', 'typed'],
      NO_DEVICES,
    );
    expect(types).toEqual(Array(5).fill('typed_translation'));
  });
});
