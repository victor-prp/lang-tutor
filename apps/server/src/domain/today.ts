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
 * for the next session. Every other gloss answered today is done for the day,
 * listed in the order a session asks done words (D3): the fewest answers today
 * first, then the longest since the last, so extra practice spreads over the
 * day's words.
 */
export function dayState(answers: readonly DayAnswer[], introduced: ReadonlySet<string>): { steps: Step[]; done: Set<string> } {
  type Owed = { dimension: Dimension; sessionId: string; opened: number };
  const tracks = new Map<string, { owed: Owed | null; returns: number; answers: number; last: number }>();
  answers.forEach((answer, index) => {
    let track = tracks.get(answer.glossId);
    if (!track) {
      const met: Owed | null = introduced.has(answer.glossId)
        ? { dimension: 'written_receptive', sessionId: answer.sessionId, opened: index }
        : null;
      track = { owed: met, returns: 0, answers: 0, last: index };
      tracks.set(answer.glossId, track);
    }
    track.answers += 1;
    track.last = index;
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
  const done: { glossId: string; answers: number; last: number }[] = [];
  for (const [glossId, { owed, returns, answers: count, last }] of tracks) {
    if (owed && returns < RETURNS_PER_DAY) steps.push({ glossId, dimension: owed.dimension, opened: owed.opened });
    else done.push({ glossId, answers: count, last });
  }
  done.sort((a, b) => a.answers - b.answers || a.last - b.last);
  return { steps: steps.sort((a, b) => a.opened - b.opened), done: new Set(done.map((gloss) => gloss.glossId)) };
}
