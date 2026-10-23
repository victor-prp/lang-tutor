import type { DiscoveryRunStatus, DiscoveryStartedBy, PhotoImportOption } from '@lang-tutor/core/api';

import type { Db } from '../../src/db/client';
import { discoveryCards, discoveryProfiles, discoveryRuns } from '../../src/db/schema';

export type SeedCard = {
  word: string;
  hebrew?: string;
  round?: number;
  /** Null: never answered. `choice` is phase 74's pick, `typed` phase 69's. */
  answer: 'unknown' | 'typed' | 'choice' | null;
  /** Defaults to true for a typed or picked answer, false for "don't know". */
  known?: boolean;
  answeredAt?: Date;
  /** Phase 74. Defaults to the opposite of known for an answered card. */
  added?: boolean;
  /** Phase 74. An added card saved to My words. */
  savedAt?: Date;
  /** For an added card: its lookup. Options make it ready, ticked on the first. */
  options?: PhotoImportOption[];
  lookupStatus?: 'pending' | 'ready' | 'failed';
  ticked?: boolean;
};

/** Phase 69. A run in any state, with cards, for tests about rounds, answers, lookups and saves. */
export async function seedDiscoveryRun(
  db: Db,
  input: {
    enrollmentId: string;
    status: DiscoveryRunStatus;
    goal?: number;
    settledRound?: number;
    startedBy?: DiscoveryStartedBy;
    createdAt?: Date;
    cards: SeedCard[];
  },
): Promise<string> {
  const [row] = await db
    .insert(discoveryRuns)
    .values({
      enrollmentId: input.enrollmentId,
      status: input.status,
      goal: input.goal ?? 15,
      settledRound: input.settledRound ?? 0,
      startedBy: input.startedBy ?? 'learner',
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.status === 'asking' ? {} : { endedAt: new Date() }),
    })
    .returning({ id: discoveryRuns.id });
  if (input.cards.length > 0) {
    await db.insert(discoveryCards).values(
      input.cards.map((card, position) => {
        const known = card.answer === null ? null : (card.known ?? card.answer !== 'unknown');
        const added = card.answer === null ? null : (card.added ?? known === false);
        const options = card.options ?? [];
        const chosen = options[0]?.gloss_id ?? null;
        const lookupStatus = added ? (card.lookupStatus ?? (options.length > 0 ? 'ready' : 'pending')) : null;
        const hebrew = card.hebrew ?? 'משהו';
        return {
          runId: row.id,
          position,
          round: card.round ?? 1,
          level: 3,
          word: card.word,
          partOfSpeech: 'noun',
          hebrew,
          alternatives: [],
          choices: [hebrew, 'אחר', 'שונה', 'רחוק'],
          rightChoice: 0,
          answer: card.answer,
          picked: card.answer === 'choice' ? (known ? 0 : 1) : null,
          suggested: card.answer === null ? null : known ? 'skip' : 'add',
          added,
          savedAt: card.savedAt ?? null,
          typedText: card.answer === 'typed' ? (card.hebrew ?? 'משהו') : null,
          verdict: card.answer === 'typed' ? (known ? 'exact' : 'wrong') : null,
          known,
          judgedBy: card.answer === 'typed' ? 'rule' : null,
          answeredAt: card.answer === null ? null : (card.answeredAt ?? new Date()),
          lookupStatus,
          options,
          suggestedGlossId: chosen,
          chosenGlossId: chosen,
          ticked: card.ticked ?? chosen !== null,
        };
      }),
    );
  }
  return row.id;
}

/** Phase 69. A profile as the two answers write it. */
export async function seedDiscoveryProfile(db: Db, input: { enrollmentId: string; level?: number }): Promise<void> {
  await db
    .insert(discoveryProfiles)
    .values({ enrollmentId: input.enrollmentId, selfLevel: 'simple', learningContext: 'self', level: input.level ?? 3 });
}
