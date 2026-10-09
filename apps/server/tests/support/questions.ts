import type { Question } from '@lang-tutor/core/api';
import { isChoice, type ChoiceQuestion, type QuestionType } from '@lang-tutor/core/domain';

import type { Db } from '../../src/db/client';
import { findGap } from '../../src/domain/cloze';
import { NOTHING_GENERATED, generatedContent, type Generated, type QuestionContent } from '../../src/domain/distractors';
import { LANGUAGES } from '../../src/domain/languages';
import { tilesFor } from '../../src/domain/tiles';
import { createQuestionRepo } from '../../src/repo/questions';
import { createSessionRepo } from '../../src/repo/sessions';
import { testRng } from './testRng';
import { withTx } from './withTx';

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
 * from its word: 'We use <form> here today.' (cloze_choice reads it as the
 * saved example). `build` receives the saved example, what the model made, and
 * the gap, as generatedContent wants them.
 */
function sentenceCard(
  sense: AskedGloss,
  type: QuestionType,
  alternatives: string[],
  build: (example: string | null, generated: Generated, gap: { start: number; end: number } | null) => QuestionContent,
): QuestionContent {
  const sentence = `We use ${sense.form} here today.`;
  const gap = findGap(sentence, [sense.form])!;
  switch (type) {
    case 'cloze_choice':
      return build(sentence, { ...NOTHING_GENERATED, distractors: ['wrong1', 'wrong2', 'wrong3'] }, gap);
    case 'cloze_typed':
      return build(null, { ...NOTHING_GENERATED, sentence: { sentence, translation: HEBREW_SENTENCE, gap, alternatives } }, null);
    case 'sentence_translation':
      return build(null, { ...NOTHING_GENERATED, translate: { hebrew: HEBREW_SENTENCE, reference: sentence, gap } }, null);
    case 'multiple_choice':
    case 'listen_choice':
      return build(null, { ...NOTHING_GENERATED, distractors: ['שגוי1', 'שגוי2', 'שגוי3'] }, null);
    default:
      return build(null, { ...NOTHING_GENERATED, distractors: ['wrong1', 'wrong2', 'wrong3'], alternatives }, null);
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
 * its place on the board.
 */
export async function insertListSession(
  db: Db,
  input: { userId: string; enrollmentId: string; asked: AskedGloss[]; alternatives?: string[]; types?: QuestionType[] },
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
        ...sentenceCard(sense, types[index], input.alternatives ?? [], (example, generated, gap) =>
          generatedContent(
            // generatedContent reads neither id; a list session's card names its gloss alone.
            { ...sense, senseId: '', partOfSpeech: 'noun', example, exampleTranslation: example ? HEBREW_SENTENCE : null },
            types[index],
            generated,
            {
              tiles: types[index] === 'letter_tiles' ? tilesFor(sense.form, LANGUAGES.en.alphabet, testRng(1)) : null,
              board: types[index] === 'matching' ? { meanings, own: index - boardStart } : null,
              gap,
            },
          ),
        ),
      })),
    });
    const sessionId = await sessionRepo.insertPreparingSession(input.userId, input.enrollmentId);
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
