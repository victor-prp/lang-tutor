import { randomUUID } from 'node:crypto';

import { DIMENSIONS, LIVE_DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import {
  answers,
  dictLexemes,
  dictVariants,
  questions,
  senseProgress,
  sessionProgress,
  sessionQuestions,
  sessions,
} from '../../src/db/schema';
import { createVocabularyRepo } from '../../src/repo/vocabulary';
import { ownerOf } from './vocabularyRows';
import { withTx } from './withTx';

/**
 * Progress fixtures and reads. tests/support/ is the test composition root, so
 * reaching db/schema.ts here is the carve-out ADR 0001 grants it; route and
 * service tests reach the progress tables only through these.
 */

/** Five level 1 rows for entries a test inserted directly, as the save path writes them. */
export async function insertProgressRows(db: Db, enrollmentId: string, senseIds: string[]): Promise<void> {
  if (senseIds.length === 0) return;
  await db
    .insert(senseProgress)
    .values(senseIds.flatMap((senseId) => DIMENSIONS.map((dimension) => ({ enrollmentId, senseId, dimension }))));
}

/** Puts one row at a level, so a test about sorting or badges need not answer weeks of sessions. */
/** Sets one dimension's level, or, with none named, every live one: a sense
 *  evenly at `level`, whose badge is `level` however many dimensions are live
 *  (phase 23 made three live). */
export async function setLevel(
  db: Db,
  input: { enrollmentId: string; senseId: string; level: number; dimension?: Dimension },
): Promise<void> {
  await db
    .update(senseProgress)
    .set({ level: input.level })
    .where(
      and(
        eq(senseProgress.enrollmentId, input.enrollmentId),
        eq(senseProgress.senseId, input.senseId),
        inArray(senseProgress.dimension, input.dimension ? [input.dimension] : [...LIVE_DIMENSIONS]),
      ),
    );
}

export type StoredProgress = {
  senseId: string;
  dimension: string;
  level: number;
  lastStepOn: string | null;
  lastWrongOn: string | null;
};

/** Every progress row of one enrollment, ordered by sense and dimension. */
export async function readProgress(db: Db, enrollmentId: string): Promise<StoredProgress[]> {
  return db
    .select({
      senseId: senseProgress.senseId,
      dimension: senseProgress.dimension,
      level: senseProgress.level,
      lastStepOn: senseProgress.lastStepOn,
      lastWrongOn: senseProgress.lastWrongOn,
    })
    .from(senseProgress)
    .where(eq(senseProgress.enrollmentId, enrollmentId))
    .orderBy(asc(senseProgress.senseId), asc(senseProgress.dimension));
}

/** One session's snapshot rows, ordered by sense and dimension. */
export async function readSnapshot(db: Db, sessionId: string) {
  return db
    .select({
      senseId: sessionProgress.senseId,
      dimension: sessionProgress.dimension,
      levelBefore: sessionProgress.levelBefore,
      levelAfter: sessionProgress.levelAfter,
    })
    .from(sessionProgress)
    .where(eq(sessionProgress.sessionId, sessionId))
    .orderBy(asc(sessionProgress.senseId), asc(sessionProgress.dimension));
}

/** The UTC date of a session's last answer: the day the rule counts it for. */
export async function sessionDay(db: Db, sessionId: string): Promise<string> {
  const rows = await db.execute<{ day: string }>(sql`
    select ((max(answered_at)) at time zone 'UTC')::date::text as day
    from answers where session_id = ${sessionId}`);
  return rows.rows[0].day;
}

/** The sense and form of each question at `positions` of a session, as save
 *  entries. Phase 28: a test can save them through the service, as a tutor. */
export async function sessionSenseEntries(
  db: Db,
  input: { sessionId: string; positions: number[] },
): Promise<{ sense_id: string; variant_id: string }[]> {
  const rows = await selectSessionSenses(db, input);
  return rows.map((row) => ({ sense_id: row.senseId, variant_id: row.variantId }));
}

async function selectSessionSenses(db: Db, input: { sessionId: string; positions: number[] }) {
  const rows = await db
    .select({
      position: sessionQuestions.position,
      senseId: questions.senseId,
      variantId: questions.promptVariantId,
      lexemeId: dictVariants.lexemeId,
      lemma: dictLexemes.lemma,
    })
    .from(sessionQuestions)
    .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
    .innerJoin(dictVariants, eq(dictVariants.id, questions.promptVariantId))
    .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
    .where(eq(sessionQuestions.sessionId, input.sessionId))
    .orderBy(asc(sessionQuestions.position));
  return rows.filter((row) => input.positions.includes(row.position));
}

/**
 * Saves the senses of a session's questions at `positions`, through the
 * repository, so each gets its five progress rows. Returns the sense ids in
 * position order. The seed's shared questions are about real senses, which is
 * what lets a test practise saved words without the prepare-session job.
 */
export async function saveSessionSenses(
  db: Db,
  input: { sessionId: string; enrollmentId: string; positions: number[] },
): Promise<string[]> {
  const picked = await selectSessionSenses(db, input);
  const addedByUserId = await ownerOf(db, input.enrollmentId);
  await withTx(db, (tx) =>
    createVocabularyRepo(tx).insertEntries({
      enrollmentId: input.enrollmentId,
      addedByUserId,
      entries: picked.map(({ senseId, variantId, lexemeId, lemma }) => ({ senseId, variantId, lexemeId, lemma })),
    }),
  );
  return picked.map((row) => row.senseId);
}

/**
 * A session with chosen answers at chosen times, written directly. One
 * enrollment-owned question per entry of `asked`, options [translation, x1,
 * x2, x3] with the translation right; a right answer picks it, a wrong one x1.
 */
export async function insertAnsweredSession(
  db: Db,
  input: {
    userId: string;
    enrollmentId: string;
    status: 'ready' | 'completed' | 'skipped';
    asked: { senseId: string; variantId: string; translation: string }[];
    answers: { position: number; correct: boolean; at: string }[];
  },
): Promise<string> {
  const questionIds = input.asked.map(() => `q-${randomUUID()}`);
  await db.insert(questions).values(
    input.asked.map((item, i) => ({
      id: questionIds[i],
      userId: input.userId,
      enrollmentId: input.enrollmentId,
      senseId: item.senseId,
      promptVariantId: item.variantId,
      targetLanguage: 'en',
      userLanguageCode: 'he',
      type: 'multiple_choice',
      options: [
        { position: 0, text: item.translation, is_correct: true },
        { position: 1, text: 'x1', is_correct: false },
        { position: 2, text: 'x2', is_correct: false },
        { position: 3, text: 'x3', is_correct: false },
      ],
    })),
  );
  const [session] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      enrollmentId: input.enrollmentId,
      status: input.status,
      source: 'list',
      completedAt: input.status === 'completed' ? sql`now()` : null,
    })
    .returning({ id: sessions.id });
  await db.insert(sessionQuestions).values(
    questionIds.map((questionId, position) => ({
      sessionId: session.id,
      position,
      questionId,
      optionOrder: [0, 1, 2, 3],
    })),
  );
  if (input.answers.length > 0) {
    await db.insert(answers).values(
      input.answers.map((a) => ({
        sessionId: session.id,
        position: a.position,
        questionId: questionIds[a.position],
        selectedOptionPosition: a.correct ? 0 : 1,
        answeredAt: sql`${a.at}::timestamptz`,
      })),
    );
  }
  return session.id;
}

/**
 * Makes every insert into `table` fail, to prove a write is all-or-nothing.
 * The database is the test's own clone, so the trigger goes with it.
 */
export async function failInsertsInto(db: Db, table: 'session_progress' | 'sense_progress'): Promise<void> {
  await db.execute(
    sql.raw(`
      create function fail_insert() returns trigger language plpgsql as $$
        begin raise exception 'planted failure'; end
      $$;
      create trigger fail_insert before insert on ${table}
        for each row execute function fail_insert();`),
  );
}
