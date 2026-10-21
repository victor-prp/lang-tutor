import type { DiscoveryRunStatus } from '@lang-tutor/core/api';

import type { CardRow, DiscoveryRepo, NewCard, ProfileRow, RunRow } from '../../src/repo/discovery';

export type FakeDiscoveryRepo = DiscoveryRepo & {
  profiles: Map<string, ProfileRow>;
  runs: Map<string, RunRow>;
  cards: Map<string, CardRow[]>;
  /** Words answered in runs the fake does not hold, newest first. */
  answeredElsewhere: string[];
};

/** A card as insertCards writes it, unanswered. */
export function newCardRow(runId: string, card: NewCard): CardRow {
  return {
    runId,
    ...card,
    answer: null,
    typedText: null,
    verdict: null,
    known: null,
    judgedBy: null,
    answeredAt: null,
    lookupStatus: null,
    correctedForm: null,
    options: [],
    suggestedGlossId: null,
    chosenGlossId: null,
    ticked: false,
    hebrewMismatch: false,
    reason: null,
  };
}

/**
 * Phase 69. An in-memory discovery repository with the database's rules that the service
 * leans on: one open run per enrollment, an answer and a lookup written once, a transition
 * only from the statuses given. No locks: a fake cannot hold one.
 */
export function createFakeDiscoveryRepo(): FakeDiscoveryRepo {
  const profiles = new Map<string, ProfileRow>();
  const runs = new Map<string, RunRow>();
  const cards = new Map<string, CardRow[]>();
  const answeredElsewhere: string[] = [];
  let nextId = 1;
  const cardOf = (runId: string, position: number) => (cards.get(runId) ?? []).find((card) => card.position === position);
  const isOpen = (status: DiscoveryRunStatus) => status === 'asking' || status === 'listing';

  return {
    profiles,
    runs,
    cards,
    answeredElsewhere,
    findProfile: async (enrollmentId) => profiles.get(enrollmentId),
    insertProfile: async (input) => {
      if (profiles.has(input.enrollmentId)) return undefined;
      profiles.set(input.enrollmentId, { ...input });
      return { ...input };
    },
    setLevel: async (enrollmentId, level) => {
      const profile = profiles.get(enrollmentId);
      if (profile) profiles.set(enrollmentId, { ...profile, level });
    },
    findOpenRun: async (enrollmentId) => [...runs.values()].find((run) => run.enrollmentId === enrollmentId && isOpen(run.status)),
    insertRun: async ({ enrollmentId, goal }) => {
      if ([...runs.values()].some((run) => run.enrollmentId === enrollmentId && isOpen(run.status))) return undefined;
      const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`;
      const run: RunRow = { id, enrollmentId, goal, status: 'asking', settledRound: 0, createdAt: new Date(0), endedAt: null };
      runs.set(id, run);
      cards.set(id, []);
      return { ...run };
    },
    findRun: async (id) => {
      const run = runs.get(id);
      return run ? { ...run } : undefined;
    },
    findRunForUpdate: async (id) => {
      const run = runs.get(id);
      return run ? { ...run } : undefined;
    },
    transition: async (id, from, to) => {
      const run = runs.get(id);
      if (!run || !from.includes(run.status)) return false;
      runs.set(id, { ...run, status: to, endedAt: to === 'asking' ? run.endedAt : (run.endedAt ?? new Date(0)) });
      return true;
    },
    setSettledRound: async (id, round) => {
      const run = runs.get(id);
      if (run) runs.set(id, { ...run, settledRound: round });
    },
    listCards: async (runId) => [...(cards.get(runId) ?? [])].sort((a, b) => a.position - b.position).map((card) => ({ ...card })),
    insertCards: async (runId, added) => {
      const list = cards.get(runId) ?? [];
      for (const card of added) {
        if (list.some((existing) => existing.position === card.position)) throw new Error(`duplicate card ${runId} ${card.position}`);
        list.push(newCardRow(runId, card));
      }
      cards.set(runId, list);
    },
    answerCard: async (runId, position, answer) => {
      const card = cardOf(runId, position);
      if (!card || card.answer !== null) return false;
      Object.assign(card, answer);
      return true;
    },
    writeLookup: async (runId, position, result) => {
      const card = cardOf(runId, position);
      if (!card || card.lookupStatus !== 'pending') return false;
      Object.assign(card, { lookupStatus: 'ready', ...result, suggestedGlossId: result.chosenGlossId });
      return true;
    },
    markLookupFailed: async (runId, position) => {
      const card = cardOf(runId, position);
      if (!card || card.lookupStatus !== 'pending') return false;
      Object.assign(card, { lookupStatus: 'failed', ticked: false });
      return true;
    },
    updateItem: async (runId, position, update) => {
      const card = cardOf(runId, position);
      if (!card) return undefined;
      if (update.ticked !== undefined) card.ticked = update.ticked;
      if (update.chosenGlossId !== undefined) card.chosenGlossId = update.chosenGlossId;
      return { ...card };
    },
    answeredWords: async (enrollmentId) => {
      const answered = [...runs.values()]
        .filter((run) => run.enrollmentId === enrollmentId)
        .flatMap((run) => cards.get(run.id) ?? [])
        .filter((card) => card.answer !== null)
        .sort((a, b) => (b.answeredAt?.getTime() ?? 0) - (a.answeredAt?.getTime() ?? 0) || b.position - a.position)
        .map((card) => card.word);
      return [...answered, ...answeredElsewhere];
    },
  };
}
