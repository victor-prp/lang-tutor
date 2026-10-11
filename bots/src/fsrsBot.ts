import { gradesFor, retrievability, review, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import type { BotMemory, LearnEvent, When } from './memory.ts';

/**
 * Spec D14, the control bot. It forgets exactly as the picker assumes: FSRS-6 with the default
 * parameters, one state per word and dimension, updated by the same grades table the server uses.
 */
export type FsrsState = Record<string, MemoryState>;

export class FsrsMemory implements BotMemory {
  readonly state: FsrsState;
  private day = '1970-01-01';

  constructor(state: FsrsState = {}) {
    this.state = state;
  }

  setTime(when: When): void {
    this.day = when.day;
  }

  recall(word: string, dimension: Dimension): number {
    const s = this.state[`${word}|${dimension}`];
    return s ? retrievability(s, this.day) : 0;
  }

  learn(word: string, event: LearnEvent): void {
    for (const { dimension, grade } of gradesFor(event)) {
      const key = `${word}|${dimension}`;
      this.state[key] = review(this.state[key] ?? null, grade, this.day);
    }
  }
}
