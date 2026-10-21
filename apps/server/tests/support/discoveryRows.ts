import type { DiscoveryRunStatus, PhotoImportOption } from '@lang-tutor/core/api';

import type { Db } from '../../src/db/client';
import { discoveryCards, discoveryProfiles, discoveryRuns } from '../../src/db/schema';

export type SeedCard = {
  word: string;
  hebrew?: string;
  round?: number;
  /** Null: never answered. */
  answer: 'unknown' | 'typed' | null;
  /** Defaults to true for a typed answer, false for "don't know". */
  known?: boolean;
  answeredAt?: Date;
  /** For a card not known: its lookup. Options make it ready, ticked on the first. */
  options?: PhotoImportOption[];
  lookupStatus?: 'pending' | 'ready' | 'failed';
  ticked?: boolean;
};

/** Phase 69. A run in any state, with cards, for tests about rounds, answers, lists and saves. */
export async function seedDiscoveryRun(
  db: Db,
  input: { enrollmentId: string; status: DiscoveryRunStatus; goal?: number; settledRound?: number; cards: SeedCard[] },
): Promise<string> {
  const [row] = await db
    .insert(discoveryRuns)
    .values({
      enrollmentId: input.enrollmentId,
      status: input.status,
      goal: input.goal ?? 15,
      settledRound: input.settledRound ?? 0,
      ...(input.status === 'asking' ? {} : { endedAt: new Date() }),
    })
    .returning({ id: discoveryRuns.id });
  if (input.cards.length > 0) {
    await db.insert(discoveryCards).values(
      input.cards.map((card, position) => {
        const known = card.answer === null ? null : (card.known ?? card.answer === 'typed');
        const options = card.options ?? [];
        const chosen = options[0]?.gloss_id ?? null;
        const lookupStatus = known === false ? (card.lookupStatus ?? (options.length > 0 ? 'ready' : 'pending')) : null;
        return {
          runId: row.id,
          position,
          round: card.round ?? 1,
          level: 3,
          word: card.word,
          partOfSpeech: 'noun',
          hebrew: card.hebrew ?? 'משהו',
          alternatives: [],
          answer: card.answer,
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
