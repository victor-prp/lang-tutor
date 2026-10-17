import type { CreateQuestionTypeSessionRequest, Enrollment, QuestionTypesResponse } from '@lang-tutor/core/api';
import { MIN_LEVEL, type QuestionType } from '@lang-tutor/core/domain';

import { usableAnswerForm } from '../domain/answerForm';
import { PREPARE_SESSION } from '../domain/jobs';
import { QUESTION_TYPE_ORDER, fixedRendering, questionTypesFor, renderingFlags } from '../domain/questionTypes';
import type { Devices, GlossRendering, Path, SavedGloss } from '../domain/session';
import {
  GlossNotSaved,
  NotATester,
  QuestionTypeUnavailable,
  RenderingMismatch,
  SeedPending,
  SessionOpen,
} from '../errors';
import type { Logger } from '../logger';
import { authorizeEnrollment } from './access';
import type { Repos, Transaction } from './transaction';

/** Phase 57 (ADR 0014). A tester's question-types session is the main path's. */
const MAIN: Path = null;

export type QuestionTypesQuery = { glossId: string; variantId: string } & Devices;

type WordRead = {
  enrolled: Enrollment;
  rendering: GlossRendering;
  others: SavedGloss[];
  types: QuestionTypesResponse['types'];
};

/**
 * Phase 61 (spec D1, D2). The owner, a tester, and one saved meaning: the rendering a
 * session of it uses, the word's other saved meanings, and every type with why not.
 */
async function readWord(repos: Repos, logger: Logger, actorUserId: string, enrollmentId: string, query: QuestionTypesQuery): Promise<WordRead> {
  const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'session.practice' });
  if (!(await repos.user.findById(actorUserId))?.tester) throw new NotATester(actorUserId);
  const saved = await repos.vocabulary.listSavedGlosses(enrollmentId);
  const gloss = saved.find((entry) => entry.glossId === query.glossId);
  if (!gloss) throw new GlossNotSaved(query.glossId);
  const renderings = await repos.dict.findGlossRenderings({ glossIds: [gloss.glossId], userLanguageCode: enrolled.source_language });
  const rendering = fixedRendering(gloss, renderings, query.variantId);
  if (!rendering) throw new GlossNotSaved(query.glossId);
  const [row] = await repos.question.findGenerationContext({
    picks: [{ glossId: gloss.glossId, senseId: rendering.senseId, variantId: rendering.variantId }],
    sourceLanguage: enrolled.source_language,
  });
  if (!row) throw new GlossNotSaved(query.glossId);
  const others = saved.filter((entry) => entry.lexemeId === gloss.lexemeId && entry.glossId !== gloss.glossId);
  const flags = renderingFlags({ ...row, answerForm: usableAnswerForm(row.answerForm, row.form, row.lemma) });
  const types = questionTypesFor({ ...flags, otherMeanings: others.length }, query);
  return { enrolled, rendering, others, types };
}

export function createQuestionTypesService({ transaction, logger }: { transaction: Transaction; logger: Logger }) {
  return {
    /** Phase 61 (spec D2). Which question types one saved meaning can have on this device. */
    read: (actorUserId: string, enrollmentId: string, query: QuestionTypesQuery): Promise<QuestionTypesResponse> =>
      transaction(async (repos) => {
        const { rendering, types } = await readWord(repos, logger, actorUserId, enrollmentId, query);
        return { sense_id: rendering.senseId, types };
      }),

    /**
     * Phase 61 (spec D3, D4). A session of one card per chosen type, put in stock: a
     * started session is SessionOpen and a seeded stock SeedPending, both before anything
     * is written; any other stock is retired. The job carries the types in
     * QUESTION_TYPE_ORDER and the one pick, with the word's other saved meanings for a
     * new_meaning card.
     *
     * Phase 57 (ADR 0014). The session is the main path's (target_id null), whatever target
     * holds the word: it takes the main path's stock place under the main path's lock alone,
     * and only the main path's started session refuses it, as create on the main path does. A
     * target's started session or stock is another path's and is left as it is. The seed
     * check is create's: any session of any path puts the seed behind (spec D2, R25).
     */
    create: async (
      actorUserId: string,
      enrollmentId: string,
      request: CreateQuestionTypeSessionRequest,
    ): Promise<{ session_id: string; status: 'preparing' }> => {
      const devices = { listening: request.listening, speaking: request.speaking };
      const { sessionId, retired, types } = await transaction(async (repos) => {
        const { enrolled, rendering, others, types: availability } = await readWord(repos, logger, actorUserId, enrollmentId, {
          glossId: request.gloss_id,
          variantId: request.variant_id,
          ...devices,
        });
        if (request.sense_id !== rendering.senseId) throw new RenderingMismatch(request.sense_id);
        for (const type of request.types) {
          const entry = availability.find((candidate) => candidate.type === type);
          if (!entry?.available) throw new QuestionTypeUnavailable(type, entry?.reason ?? 'unknown');
        }
        const ordered = QUESTION_TYPE_ORDER.filter((type) => request.types.includes(type));

        await repos.session.lockNextSession(enrollmentId, MAIN);
        const open = await repos.session.findOpen(enrollmentId, MAIN);
        if (open.started) throw new SessionOpen(enrollmentId);
        // The seed comes first: waiting in stock, or not yet made (no session at all, of any path).
        if (open.stock?.source === 'seed' || !(await repos.session.findLatest(enrollmentId, 'any'))) throw new SeedPending(enrollmentId);
        const retired = open.stock && (await repos.session.retireStock(open.stock.id)) ? open.stock.id : null;

        const sessionId = await repos.session.insertQuestionTypesSession(enrolled.user_id, enrollmentId, devices, MAIN);
        await repos.jobs.enqueue(PREPARE_SESSION, {
          session_id: sessionId,
          picks: [
            {
              gloss_id: request.gloss_id,
              sense_id: rendering.senseId,
              variant_id: rendering.variantId,
              // The card's type is the session's; these are read by no grade (memoryGrades goes by type).
              dimension: 'written_receptive',
              rung: 1,
              level: MIN_LEVEL,
              r: null,
              step: false,
              ...(ordered.includes('new_meaning') ? { known_meanings: others.map((other) => other.key) } : {}),
            },
          ],
          listening: devices.listening,
          speaking: devices.speaking,
          question_types: ordered,
        });
        return { sessionId, retired, types: ordered };
      });
      if (retired) logger.info({ event: 'stock_retired', session_id: retired, reason: 'question_types' });
      logger.info({ event: 'question_types_session_created', session_id: sessionId, enrollment_id: enrollmentId, types: types as QuestionType[] });
      return { session_id: sessionId, status: 'preparing' };
    },
  };
}

export type QuestionTypesService = ReturnType<typeof createQuestionTypesService>;
