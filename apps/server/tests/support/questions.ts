import type { Question } from '@lang-tutor/core/api';
import { isChoice, type ChoiceQuestion, type QuestionType } from '@lang-tutor/core/domain';

import type { Db } from '../../src/db/client';
import { generatedContent } from '../../src/domain/distractors';
import { LANGUAGES } from '../../src/domain/languages';
import { tilesFor } from '../../src/domain/tiles';
import { createQuestionRepo } from '../../src/repo/questions';
import { createSessionRepo } from '../../src/repo/sessions';
import { testRng } from './testRng';
import { withTx } from './withTx';

/**
 * Phase 23. A question a test knows is a choice, narrowed so it can read the
 * options: every seed question is one, as is the first of a list session
 * (the type cycle starts on today's card). Throws for a typed card, so a test
 * that assumed wrong fails at the assumption rather than on an undefined.
 */
export function asChoice(question: Question | undefined): ChoiceQuestion {
  if (!question || !isChoice(question)) {
    throw new Error(`expected a choice question, got ${question ? question.type : 'none'}`);
  }
  return question;
}

/** One saved sense as a list session asks it. */
export type AskedSense = {
  senseId: string;
  variantId: string;
  lexemeId: string;
  form: string;
  lemma: string;
  translation: string;
};

/** Phase 23's cycle: the default types of a test's list session. */
const CYCLE: QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];

/**
 * Phase 23. A ready list session over `asked`, with the types the type cycle
 * gives their positions, written through the production repositories exactly
 * as prepare-session writes it, minus the model: wrong options are fixed
 * strings and a typed card accepts `alternatives`. Options keep their canonical
 * order: the right index is 0, except for a board word, whose right index is
 * its place on the board.
 */
export async function insertListSession(
  db: Db,
  input: { userId: string; enrollmentId: string; asked: AskedSense[]; alternatives?: string[]; types?: QuestionType[] },
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
        senseId: sense.senseId,
        variantId: sense.variantId,
        form: sense.form,
        lemma: sense.lemma,
        partOfSpeech: 'noun',
        lexemeId: sense.lexemeId,
        type: types[index],
        ...generatedContent(
          { ...sense, partOfSpeech: 'noun' },
          types[index],
          types[index] === 'multiple_choice' || types[index] === 'listen_choice'
            ? { distractors: ['שגוי1', 'שגוי2', 'שגוי3'], alternatives: [] }
            : { distractors: ['wrong1', 'wrong2', 'wrong3'], alternatives: input.alternatives ?? [] },
          {
            tiles: types[index] === 'letter_tiles' ? tilesFor(sense.form, LANGUAGES.en.alphabet, testRng(1)) : null,
            board: types[index] === 'matching' ? { meanings, own: index - boardStart } : null,
          },
        ),
      })),
    });
    const sessionId = await sessionRepo.insertPreparingSession(input.userId, input.enrollmentId);
    await sessionRepo.insertSessionQuestions(sessionId, generated);
    await sessionRepo.transition(sessionId, ['preparing'], 'ready');
    return { sessionId, questions: generated };
  });
}
