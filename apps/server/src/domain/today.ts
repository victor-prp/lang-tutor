import { gradesFor, type Dimension, type GradableAnswer } from '@lang-tutor/core/domain';

import { RETURNS_PER_DAY } from './chooseConstants';

/**
 * Phase 37 (spec D1). What today's answers leave owed: the words that come back
 * later the same day, as recall cards, until they are answered right. Pure: the
 * caller reads today's answers, on the learner's day, and the words first met
 * today.
 */

/** One answer given today, in a session counting for the learner's day. */
export type DayAnswer = GradableAnswer & { glossId: string; sessionId: string };

/** A return owed: the gloss, the dimension to recall, and the index of the
 *  answer that opened it, which orders the returns. */
export type Step = { glossId: string; dimension: Dimension; opened: number };

/**
 * Reads each gloss's answers in order. A word met today owes a written
 * receptive return from its first answer. An answer in a later session than the
 * one that opened the owed return is one return, and settles it when it grades
 * that dimension Good or Hard. An Again in any dimension opens a return there,
 * replacing an open one; within one answer the settling is read first.
 *
 * A gloss still owing a return, with fewer than RETURNS_PER_DAY made, is a step
 * for the next session. Every other gloss answered today is done for the day.
 */
export function dayState(answers: readonly DayAnswer[], introduced: ReadonlySet<string>): { steps: Step[]; done: Set<string> } {
  type Owed = { dimension: Dimension; sessionId: string; opened: number };
  const tracks = new Map<string, { owed: Owed | null; returns: number }>();
  answers.forEach((answer, index) => {
    let track = tracks.get(answer.glossId);
    if (!track) {
      const met: Owed | null = introduced.has(answer.glossId)
        ? { dimension: 'written_receptive', sessionId: answer.sessionId, opened: index }
        : null;
      track = { owed: met, returns: 0 };
      tracks.set(answer.glossId, track);
    }
    const grades = gradesFor(answer);
    const owed = track.owed;
    if (owed && owed.sessionId !== answer.sessionId) {
      track.returns += 1;
      if (grades.some((piece) => piece.dimension === owed.dimension && piece.grade >= 2)) track.owed = null;
    }
    for (const piece of grades) {
      if (piece.grade === 1) track.owed = { dimension: piece.dimension, sessionId: answer.sessionId, opened: index };
    }
  });

  const steps: Step[] = [];
  const done = new Set<string>();
  for (const [glossId, { owed, returns }] of tracks) {
    if (owed && returns < RETURNS_PER_DAY) steps.push({ glossId, dimension: owed.dimension, opened: owed.opened });
    else done.add(glossId);
  }
  return { steps: steps.sort((a, b) => a.opened - b.opened), done };
}
