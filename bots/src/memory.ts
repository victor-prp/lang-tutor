import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

/**
 * When a bot is asked. `hour` is absolute simulated hours (day * 24 + hour of day), for ACT-R;
 * `day` is the UTC date the server sees, for FSRS.
 */
export type When = { day: string; hour: number };

/** What a card showed and how it came out: the input of the grades table. Phase 55 (spec D2,
 *  as ruled): `intro`, a card of a ladder's intro stage, which the server grades nothing; the
 *  control bot, which forgets as the picker assumes, learns nothing from it either. */
export type LearnEvent = {
  type: QuestionType;
  correct?: boolean;
  verdict?: 'exact' | 'near_miss' | 'wrong' | 'gave_up' | 'understood' | 'skipped' | 'alternative' | 'seen';
  intro?: boolean;
};

/** What `decide` needs of a bot's memory, whichever way it forgets. */
export interface BotMemory {
  setTime(when: When): void;
  /** The chance the bot recalls this word in this dimension right now, before any guessing. */
  recall(word: string, dimension: Dimension): number;
  /** Practice: the card the bot just answered, with its outcome. A meet card (phase 54, spec D8) is a study of the word, not a practice. */
  learn(word: string, event: LearnEvent): void;
}
