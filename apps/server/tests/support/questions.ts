import type { Question } from '@lang-tutor/core/api';
import { isChoice, type ChoiceQuestion, type QuestionType } from '@lang-tutor/core/domain';
import { asc, eq } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { answerExplanations, answerTaps, answers, pronunciationScores, questions, sessionQuestions } from '../../src/db/schema';
import { findGap } from '../../src/domain/cloze';
import { NOTHING_GENERATED, generatedContent, type Generated, type QuestionContent } from '../../src/domain/distractors';
import { LANGUAGES } from '../../src/domain/languages';
import { tilesFor } from '../../src/domain/tiles';
import { dayState, type Step } from '../../src/domain/today';
import { createQuestionRepo } from '../../src/repo/questions';
import { createSessionRepo } from '../../src/repo/sessions';
import { testRng } from './testRng';
import { withTx } from './withTx';

/** Phase 43. A session built for a device that can neither listen nor speak. */
export const NO_DEVICES = { listening: false, speaking: false };

/** Phase 53. The learner day a test's stock says its words were chosen on, where the day is
 *  no part of what the test is about. */
export const CHOSEN_ON = '2026-10-14';

/**
 * Phase 23. A question a test knows is a choice, narrowed so it can read the
 * options: every seed question is one, as is the first of a list session
 * (phase 23's cycle starts on today's card, unless `types` says otherwise). Throws for a typed card, so a test
 * that assumed wrong fails at the assumption rather than on an undefined.
 */
export function asChoice(question: Question | undefined): ChoiceQuestion {
  if (!question || !isChoice(question)) {
    throw new Error(`expected a choice question, got ${question ? question.type : 'none'}`);
  }
  return question;
}

/** One saved gloss as a list session asks it. */
export type AskedGloss = {
  glossId: string;
  variantId: string;
  lexemeId: string;
  form: string;
  lemma: string;
  translation: string;
};

const HEBREW_SENTENCE = 'משפט לדוגמה';

/**
 * Phase 27. The content of one position, with a sentence card's sentence made
 * from its word: 'We use <form> here today.'. `build` receives the saved
 * example and what the model made, as generatedContent wants them.
 */
function sentenceCard(
  sense: AskedGloss,
  type: QuestionType,
  alternatives: string[],
  build: (example: string | null, generated: Generated) => QuestionContent,
): QuestionContent {
  const sentence = `We use ${sense.form} here today.`;
  const gap = findGap(sentence, [sense.form])!;
  switch (type) {
    case 'cloze_choice':
      // Phase 62 (spec D1): written for the session, as a typed cloze's is.
      return build(sentence, { ...NOTHING_GENERATED, distractors: ['wrong1', 'wrong2', 'wrong3'], sentence: { sentence, translation: HEBREW_SENTENCE, gap, alternatives: [] } });
    case 'cloze_typed':
      return build(null, { ...NOTHING_GENERATED, sentence: { sentence, translation: HEBREW_SENTENCE, gap, alternatives } });
    case 'sentence_translation':
      return build(null, { ...NOTHING_GENERATED, translate: { hebrew: HEBREW_SENTENCE, reference: sentence, gap } });
    case 'multiple_choice':
    case 'listen_choice':
      return build(null, { ...NOTHING_GENERATED, distractors: ['שגוי1', 'שגוי2', 'שגוי3'] });
    default:
      return build(null, { ...NOTHING_GENERATED, distractors: ['wrong1', 'wrong2', 'wrong3'], alternatives });
  }
}

/** Phase 23's cycle: the default types of a test's list session. */
const CYCLE: QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];

/**
 * Phase 23. A ready list session over `asked`, with phase 23's type cycle as
 * the default for their positions (`types` overrides it), written through the production repositories exactly
 * as prepare-session writes it, minus the model: wrong options are fixed
 * strings and a typed card accepts `alternatives`. Options keep their canonical
 * order: the right index is 0, except for a board word, whose right index is
 * its place on the board. Phase 57: on the main path, or on `targetId`'s.
 */
export async function insertListSession(
  db: Db,
  input: { userId: string; enrollmentId: string; asked: AskedGloss[]; alternatives?: string[]; types?: QuestionType[]; targetId?: string },
): Promise<{ sessionId: string; questions: Question[] }> {
  return withTx(db, async (tx) => {
    const sessionRepo = createSessionRepo(tx);
    const types = input.types ?? input.asked.map((_, index) => CYCLE[index % CYCLE.length]);
    // Phase 24. A board's words share five meanings: theirs, and one wrong.
    const boardStart = types.indexOf('matching');
    const meanings = [...input.asked.filter((_, i) => types[i] === 'matching').map((s) => s.translation), 'שגוי0'];
    const generated = await createQuestionRepo(tx).insertGeneratedQuestions({
      userId: input.userId,
      enrollmentId: input.enrollmentId,
      targetLanguage: 'en',
      userLanguageCode: 'he',
      questions: input.asked.map((sense, index) => ({
        glossId: sense.glossId,
        variantId: sense.variantId,
        form: sense.form,
        lemma: sense.lemma,
        partOfSpeech: 'noun',
        lexemeId: sense.lexemeId,
        type: types[index],
        ...sentenceCard(sense, types[index], input.alternatives ?? [], (example, generated) =>
          generatedContent(
            // generatedContent reads neither id; a list session's card names its gloss alone.
            { ...sense, senseId: '', partOfSpeech: 'noun', example, exampleTranslation: example ? HEBREW_SENTENCE : null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
            types[index],
            generated,
            {
              tiles: types[index] === 'letter_tiles' ? tilesFor(sense.form, LANGUAGES.en.alphabet, testRng(1)) : null,
              board: types[index] === 'matching' ? { meanings, own: index - boardStart } : null,
            },
          ),
        ),
      })),
    });
    const sessionId = await sessionRepo.insertPreparingSession(input.userId, input.enrollmentId, NO_DEVICES, CHOSEN_ON, input.targetId ?? null);
    await sessionRepo.insertSessionQuestions(sessionId, generated);
    await sessionRepo.transition(sessionId, ['preparing'], 'ready');
    return { sessionId, questions: generated };
  });
}

/** The answers a session has stored, as the repo loads them. Route tests read
 *  through this: they may not reach past composition for a repository. */
export async function readStoredAnswers(db: Db, sessionId: string) {
  const record = await withTx(db, (tx) => createSessionRepo(tx).loadSession(sessionId));
  return record?.answers ?? [];
}

/** Phase 66 (spec D2). A session's stored explanations, in position order, as
 *  route tests read them: they may not reach past composition for a repository. */
export async function readExplanations(db: Db, sessionId: string) {
  return db
    .select({
      position: answerExplanations.position,
      text: answerExplanations.text,
      corrected: answerExplanations.corrected,
      mistakes: answerExplanations.mistakes,
    })
    .from(answerExplanations)
    .where(eq(answerExplanations.sessionId, sessionId))
    .orderBy(asc(answerExplanations.position));
}

/** Phase 50 (spec D3). Every stored pronunciation score, as route tests read
 *  them: they may not reach past composition for a repository. */
export async function readPronunciationScores(db: Db): Promise<{ language: string; a: string; b: string; score: number }[]> {
  return db
    .select({ language: pronunciationScores.languageCode, a: pronunciationScores.formA, b: pronunciationScores.formB, score: pronunciationScores.score })
    .from(pronunciationScores);
}

/** Phase 41. Each answer's stored verdict and retry state, in position order. */
export async function readVerdicts(db: Db, sessionId: string): Promise<{ verdict: string | null; retryState: string | null }[]> {
  return db
    .select({ verdict: answers.verdict, retryState: answers.retryState })
    .from(answers)
    .where(eq(answers.sessionId, sessionId))
    .orderBy(asc(answers.position));
}

/** Phase 38 (spec D4). Each stored answer's hint_opened, by position. The domain's
 *  answer record does not carry it: only a count over the table reads it. */
export async function readHintOpened(db: Db, sessionId: string): Promise<(boolean | null)[]> {
  const rows = await db
    .select({ hintOpened: answers.hintOpened })
    .from(answers)
    .where(eq(answers.sessionId, sessionId))
    .orderBy(asc(answers.position));
  return rows.map((row) => row.hintOpened);
}

/** Phase 55 (spec D6). Each stored answer's helped, by position. As hint_opened is
 *  not in the domain's answer record, only a read over the table sees it. */
export async function readHelped(db: Db, sessionId: string): Promise<(boolean | null)[]> {
  const rows = await db
    .select({ helped: answers.helped })
    .from(answers)
    .where(eq(answers.sessionId, sessionId))
    .orderBy(asc(answers.position));
  return rows.map((row) => row.helped);
}

/** Phase 54 (spec D1). The glosses `day` introduced, as the picker reads them: a
 *  service test may not reach past composition for a repository. */
export async function readIntroducedOn(db: Db, enrollmentId: string, day: string): Promise<string[]> {
  return withTx(db, (tx) => createSessionRepo(tx).findIntroducedOn(enrollmentId, day));
}

/** Phase 55 (spec D2, as ruled). Each question's intro mark, by session position. The wire
 *  does not carry it: only a read over the table sees it. */
export async function readIntro(db: Db, sessionId: string): Promise<boolean[]> {
  const rows = await db
    .select({ intro: questions.intro })
    .from(sessionQuestions)
    .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
    .where(eq(sessionQuestions.sessionId, sessionId))
    .orderBy(asc(sessionQuestions.position));
  return rows.map((row) => row.intro);
}

/** Phase 55. The returns `day` leaves owed, as the picker reads them (phase 37, spec D1): a
 *  service test may not reach past composition for a repository. */
export async function readSteps(db: Db, enrollmentId: string, day: string): Promise<Step[]> {
  return withTx(db, async (tx) => {
    const repo = createSessionRepo(tx);
    return dayState(await repo.findAnswersOn(enrollmentId, day), new Set(await repo.findIntroducedOn(enrollmentId, day))).steps;
  });
}

/** Phase 59 (spec D2). A sentence translation's word map, set on a stored card. */
export async function setWords(
  db: Db,
  questionId: string,
  words: { start: number; end: number; text: string; glossId: string | null; target: boolean }[] | null,
): Promise<void> {
  await db.update(questions).set({ words }).where(eq(questions.id, questionId));
}

/** Phase 59 (spec D5). A session's stored taps, in card and word order. */
export async function readTaps(db: Db, sessionId: string) {
  return db
    .select({ position: answerTaps.position, wordIndex: answerTaps.wordIndex, kind: answerTaps.kind, glossId: answerTaps.glossId })
    .from(answerTaps)
    .where(eq(answerTaps.sessionId, sessionId))
    .orderBy(asc(answerTaps.position), asc(answerTaps.wordIndex));
}

/** Phase 59 (spec D4). The day's answers as dayState reads them. */
export async function readDayAnswers(db: Db, enrollmentId: string, day: string) {
  return withTx(db, (tx) => createSessionRepo(tx).findAnswersOn(enrollmentId, day));
}
