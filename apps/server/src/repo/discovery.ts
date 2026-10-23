import type {
  DiscoveryLearningContext,
  DiscoveryRunStatus,
  DiscoverySelfLevel,
  DiscoveryStartedBy,
  PartOfSpeech,
  PhotoImportItemReason,
  PhotoImportOption,
} from '@lang-tutor/core/api';
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { discoveryCards, discoveryProfiles, discoveryRuns } from '../db/schema';
import type { ItemResult } from './photoImports';

// An id that is not a uuid is "no such run", not a Postgres type error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProfileRow = {
  enrollmentId: string;
  selfLevel: DiscoverySelfLevel;
  learningContext: DiscoveryLearningContext;
  level: number;
};

export type RunRow = {
  id: string;
  enrollmentId: string;
  goal: number;
  status: DiscoveryRunStatus;
  settledRound: number;
  startedBy: DiscoveryStartedBy;
  createdAt: Date;
  endedAt: Date | null;
};

/** Phase 74: `choice` is a meaning picked; `unknown` is "אין לי מושג"; `typed` is phase 69's. */
export type CardAnswer = 'unknown' | 'typed' | 'choice';
export type Suggestion = 'add' | 'skip';
export type CardVerdict = 'exact' | 'alternative' | 'wrong';
export type JudgedBy = 'rule' | 'model' | 'unavailable';
export type LookupStatus = 'pending' | 'ready' | 'failed';

export type CardRow = {
  runId: string;
  position: number;
  round: number;
  level: number;
  word: string;
  partOfSpeech: PartOfSpeech;
  hebrew: string;
  alternatives: string[];
  answer: CardAnswer | null;
  typedText: string | null;
  verdict: CardVerdict | null;
  known: boolean | null;
  judgedBy: JudgedBy | null;
  answeredAt: Date | null;
  lookupStatus: LookupStatus | null;
  correctedForm: string | null;
  options: PhotoImportOption[];
  suggestedGlossId: string | null;
  chosenGlossId: string | null;
  ticked: boolean;
  hebrewMismatch: boolean;
  reason: PhotoImportItemReason | null;
  /** Phase 74 (spec D1). The four Hebrew meanings in the order shown; empty on phase 69's cards. */
  choices: string[];
  rightChoice: number | null;
  /** The meaning picked; null with answer `unknown` ("אין לי מושג"). */
  picked: number | null;
  suggested: Suggestion | null;
  added: boolean | null;
  /** When its lookup saved the added word to My words. */
  savedAt: Date | null;
};

export type NewCard = {
  position: number;
  round: number;
  level: number;
  word: string;
  partOfSpeech: PartOfSpeech;
  hebrew: string;
  alternatives: string[];
  choices: string[];
  rightChoice: number;
};

/** Phase 74 (spec D2, D3, D5). One card's answer: the pick, the suggestion shown, the choice. */
export type AnswerWrite = {
  answer: 'choice' | 'unknown';
  picked: number | null;
  suggested: Suggestion;
  added: boolean;
  known: boolean;
  /** 'pending' for an added card: its lookup is enqueued with it. */
  lookupStatus: 'pending' | null;
  answeredAt: Date;
};

const profileColumns = {
  enrollmentId: discoveryProfiles.enrollmentId,
  selfLevel: discoveryProfiles.selfLevel,
  learningContext: discoveryProfiles.learningContext,
  level: discoveryProfiles.level,
};

const runColumns = {
  id: discoveryRuns.id,
  enrollmentId: discoveryRuns.enrollmentId,
  goal: discoveryRuns.goal,
  status: discoveryRuns.status,
  settledRound: discoveryRuns.settledRound,
  startedBy: discoveryRuns.startedBy,
  createdAt: discoveryRuns.createdAt,
  endedAt: discoveryRuns.endedAt,
};

const asProfile = (row: Record<keyof typeof profileColumns, unknown>) => row as unknown as ProfileRow;
const asRun = (row: Record<keyof typeof runColumns, unknown>) => row as unknown as RunRow;
const asCard = (row: typeof discoveryCards.$inferSelect) => row as unknown as CardRow;

const cardKey = (runId: string, position: number) => and(eq(discoveryCards.runId, runId), eq(discoveryCards.position, position));
const OPEN: DiscoveryRunStatus[] = ['asking', 'listing'];

/** Phase 69. Persistence primitives of Words for me: a profile, a run and its cards (ADR 0001 R9). */
export function createDiscoveryRepo(tx: Tx) {
  return {
    findProfile: async (enrollmentId: string): Promise<ProfileRow | undefined> => {
      const [row] = await tx.select(profileColumns).from(discoveryProfiles).where(eq(discoveryProfiles.enrollmentId, enrollmentId));
      return row ? asProfile(row) : undefined;
    },

    /** Undefined when the enrollment has one already: the answers are asked once. */
    insertProfile: async (input: ProfileRow): Promise<ProfileRow | undefined> => {
      const [row] = await tx.insert(discoveryProfiles).values(input).onConflictDoNothing().returning(profileColumns);
      return row ? asProfile(row) : undefined;
    },

    setLevel: async (enrollmentId: string, level: number): Promise<void> => {
      await tx
        .update(discoveryProfiles)
        .set({ level, updatedAt: sql`now()` })
        .where(eq(discoveryProfiles.enrollmentId, enrollmentId));
    },

    findOpenRun: async (enrollmentId: string): Promise<RunRow | undefined> => {
      const [row] = await tx
        .select(runColumns)
        .from(discoveryRuns)
        .where(and(eq(discoveryRuns.enrollmentId, enrollmentId), inArray(discoveryRuns.status, OPEN)));
      return row ? asRun(row) : undefined;
    },

    /** Undefined when the enrollment has an open run: the index allows one. */
    insertRun: async (input: { enrollmentId: string; goal: number; startedBy: DiscoveryStartedBy }): Promise<RunRow | undefined> => {
      const [row] = await tx
        .insert(discoveryRuns)
        .values({ enrollmentId: input.enrollmentId, goal: input.goal, startedBy: input.startedBy, status: 'asking' })
        .onConflictDoNothing()
        .returning(runColumns);
      return row ? asRun(row) : undefined;
    },

    findRun: async (id: string): Promise<RunRow | undefined> => {
      if (!UUID_RE.test(id)) return undefined;
      const [row] = await tx.select(runColumns).from(discoveryRuns).where(eq(discoveryRuns.id, id));
      return row ? asRun(row) : undefined;
    },

    /** findRun that locks the row until the transaction ends: it serializes a run's
     *  rounds, answers, changes, save and discard. */
    findRunForUpdate: async (id: string): Promise<RunRow | undefined> => {
      if (!UUID_RE.test(id)) return undefined;
      const [row] = await tx.select(runColumns).from(discoveryRuns).where(eq(discoveryRuns.id, id)).for('update');
      return row ? asRun(row) : undefined;
    },

    /** Conditional: false when the run was not in `from`. Leaving `asking` stamps `ended_at`. */
    transition: async (id: string, from: DiscoveryRunStatus[], to: DiscoveryRunStatus): Promise<boolean> => {
      if (!UUID_RE.test(id)) return false;
      const rows = await tx
        .update(discoveryRuns)
        .set({ status: to, ...(to === 'asking' ? {} : { endedAt: sql`coalesce(${discoveryRuns.endedAt}, now())` }) })
        .where(and(eq(discoveryRuns.id, id), inArray(discoveryRuns.status, from)))
        .returning({ id: discoveryRuns.id });
      return rows.length > 0;
    },

    setSettledRound: async (id: string, round: number): Promise<void> => {
      await tx.update(discoveryRuns).set({ settledRound: round }).where(eq(discoveryRuns.id, id));
    },

    listCards: async (runId: string): Promise<CardRow[]> => {
      if (!UUID_RE.test(runId)) return [];
      const rows = await tx.select().from(discoveryCards).where(eq(discoveryCards.runId, runId)).orderBy(asc(discoveryCards.position));
      return rows.map(asCard);
    },

    insertCards: async (runId: string, cards: readonly NewCard[]): Promise<void> => {
      if (cards.length === 0) return;
      await tx.insert(discoveryCards).values(cards.map((card) => ({ runId, ...card })));
    },

    /** The learner's answer, once: only an unanswered card takes it. */
    answerCard: async (runId: string, position: number, answer: AnswerWrite): Promise<boolean> => {
      const rows = await tx
        .update(discoveryCards)
        .set(answer)
        .where(and(cardKey(runId, position), sql`${discoveryCards.answer} is null`))
        .returning({ position: discoveryCards.position });
      return rows.length > 0;
    },

    /** The lookup job's write, once: only a pending card takes it. */
    writeLookup: async (runId: string, position: number, result: ItemResult): Promise<boolean> => {
      const rows = await tx
        .update(discoveryCards)
        .set({
          lookupStatus: 'ready',
          correctedForm: result.correctedForm,
          options: result.options,
          suggestedGlossId: result.chosenGlossId,
          chosenGlossId: result.chosenGlossId,
          ticked: result.ticked,
          hebrewMismatch: result.hebrewMismatch,
          reason: result.reason,
        })
        .where(and(cardKey(runId, position), eq(discoveryCards.lookupStatus, 'pending')))
        .returning({ position: discoveryCards.position });
      return rows.length > 0;
    },

    markLookupFailed: async (runId: string, position: number): Promise<boolean> => {
      if (!UUID_RE.test(runId)) return false;
      const rows = await tx
        .update(discoveryCards)
        .set({ lookupStatus: 'failed', ticked: false })
        .where(and(cardKey(runId, position), eq(discoveryCards.lookupStatus, 'pending')))
        .returning({ position: discoveryCards.position });
      return rows.length > 0;
    },

    /** Phase 74 (spec D5). The added word's save, once: stamps `saved_at` on a card not yet saved. */
    markSaved: async (runId: string, position: number): Promise<boolean> => {
      const rows = await tx
        .update(discoveryCards)
        .set({ savedAt: sql`now()` })
        .where(and(cardKey(runId, position), sql`${discoveryCards.savedAt} is null`))
        .returning({ position: discoveryCards.position });
      return rows.length > 0;
    },

    /** Phase 74 (spec D7). When the enrollment's runs the app started were created, from `since`
     *  on: the caller asks whether one falls on the learner's day. */
    appRunsCreatedSince: async (enrollmentId: string, since: Date): Promise<Date[]> => {
      const rows = await tx
        .select({ createdAt: discoveryRuns.createdAt })
        .from(discoveryRuns)
        .where(and(eq(discoveryRuns.enrollmentId, enrollmentId), eq(discoveryRuns.startedBy, 'app'), gte(discoveryRuns.createdAt, since)));
      return rows.map((row) => row.createdAt);
    },

    /** Spec D4. Every word the learner answered in any of the enrollment's runs, newest
     *  answer first: what a later round never proposes again. */
    answeredWords: async (enrollmentId: string): Promise<string[]> => {
      const rows = await tx
        .select({ word: discoveryCards.word })
        .from(discoveryCards)
        .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryCards.runId))
        .where(and(eq(discoveryRuns.enrollmentId, enrollmentId), isNotNull(discoveryCards.answer)))
        .orderBy(desc(discoveryCards.answeredAt));
      return rows.map((row) => row.word);
    },
  };
}

export type DiscoveryRepo = ReturnType<typeof createDiscoveryRepo>;
