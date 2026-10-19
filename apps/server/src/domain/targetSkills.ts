import { gradesFor, type Dimension, type GradableAnswer, type QuestionType } from '@lang-tutor/core/domain';

import {
  TARGET_CAP_DUE_HALVES,
  TARGET_CAP_FAR_HALVES,
  TARGET_CAP_HALVES,
  TARGET_POINTS_HALVES,
} from './chooseConstants';
import { daysBetween } from './progress';

/**
 * Phase 57 (spec D4, D5). A target's skills: a value per word and dimension, in half-points
 * (0-20), moved once per session and capped by the days left. Pure (ADR 0001): the day and
 * the days left are passed in.
 */

/** Spec D5. The cap in half-points with this many days to the due date. */
export function capHalves(daysLeft: number): number {
  if (daysLeft <= 0) return TARGET_CAP_DUE_HALVES;
  // The table is descending: the smallest table day at or above daysLeft is the last one that is.
  let cap = TARGET_CAP_FAR_HALVES;
  for (const [day, value] of TARGET_CAP_HALVES) if (day >= daysLeft) cap = value;
  return cap;
}

/** Spec D5. The table's days, descending: the days the cap rises. */
export function practiceDays(): readonly number[] {
  return TARGET_CAP_HALVES.map(([day]) => day);
}

/** Spec D5. Days until the next practice day below `daysLeft`; null when none is left. */
export function nextPracticeIn(daysLeft: number): number | null {
  const next = practiceDays().find((day) => day < daysLeft);
  return next === undefined ? null : daysLeft - next;
}

const RECALL: ReadonlySet<QuestionType> = new Set<QuestionType>([
  'typed_meaning',
  'typed_translation',
  'cloze_typed',
  'sentence_translation',
  'dictation',
  'say_translation',
]);

/** Spec D4. A recall card makes the student produce the word; any other graded card
 *  lets them choose it. */
export function isRecallCard(type: QuestionType): boolean {
  return RECALL.has(type);
}

export type TargetSkillRow = {
  targetId: string;
  glossId: string;
  dimension: Dimension;
  halves: number;
  sessionId: string | null;
  day: string | null;
};

/** A session's answer about a gloss; `helped` is phase 56's help, which moves no target value. */
export type TargetAnswer = GradableAnswer & { glossId: string; helped: boolean };

export type TargetSkillEvent = {
  targetId: string;
  glossId: string;
  dimension: Dimension;
  sessionId: string;
  before: number;
  after: number;
  why: 'miss' | 'recall' | 'recognition';
};

type Tally = { miss: boolean; recall: boolean; recognition: boolean };

/**
 * Spec D4. Per skill the session graded for a target word: any Again costs 4, else a recall
 * gives +4 and recognition alone +2, gains stopping at the cap; one change per skill per
 * session. Only changed skills come back, as rows to upsert and one event each.
 */
export function applyTargetSession(input: {
  targetId: string;
  sessionId: string;
  day: string;
  capHalves: number;
  glossIds: ReadonlySet<string>;
  before: readonly TargetSkillRow[];
  answers: readonly TargetAnswer[];
}): { rows: TargetSkillRow[]; events: TargetSkillEvent[] } {
  const tallies = new Map<string, { glossId: string; dimension: Dimension; tally: Tally }>();
  for (const answer of input.answers) {
    if (answer.helped || !input.glossIds.has(answer.glossId)) continue;
    for (const { dimension, grade } of gradesFor(answer)) {
      const key = `${answer.glossId}\u0000${dimension}`;
      let entry = tallies.get(key);
      if (!entry) {
        entry = { glossId: answer.glossId, dimension, tally: { miss: false, recall: false, recognition: false } };
        tallies.set(key, entry);
      }
      if (grade === 1) entry.tally.miss = true;
      else if (isRecallCard(answer.type)) entry.tally.recall = true;
      else entry.tally.recognition = true;
    }
  }

  const rows: TargetSkillRow[] = [];
  const events: TargetSkillEvent[] = [];
  for (const { glossId, dimension, tally } of tallies.values()) {
    const old = input.before.find(
      (row) => row.targetId === input.targetId && row.glossId === glossId && row.dimension === dimension,
    );
    const before = old?.halves ?? 0;
    let after = before;
    let why: TargetSkillEvent['why'];
    if (tally.miss) {
      why = 'miss';
      after = Math.max(0, before - TARGET_POINTS_HALVES.miss);
    } else {
      why = tally.recall ? 'recall' : 'recognition';
      // The cap only limits gains: a value above it stays.
      after = Math.max(before, Math.min(before + TARGET_POINTS_HALVES[why], input.capHalves));
    }
    if (after === before) continue;
    rows.push({ targetId: input.targetId, glossId, dimension, halves: after, sessionId: input.sessionId, day: input.day });
    events.push({ targetId: input.targetId, glossId, dimension, sessionId: input.sessionId, before, after, why });
  }
  return { rows, events };
}

/**
 * Phase 57 (spec D4, D10). A target as the session-end write reads it: active while the
 * session's answers were given, its due date then, and when each of its words the session
 * asked joined it. Instants are fixed-width UTC text to the microsecond (repo/instants.ts),
 * so two compare as strings exactly as the instants do.
 */
export type HoldingTarget = {
  id: string;
  dueOn: string;
  /** Phase 65 (spec D1): decides which skills count toward its readiness. */
  kind: 'homework' | 'exam';
  words: readonly { glossId: string; addedAt: string }[];
};

/** A session's answer and when it was given, in the same text as HoldingTarget's instants. */
export type TimedTargetAnswer = TargetAnswer & { answeredAt: string };

/**
 * Spec D4, D5. What one ended session writes for every target holding a word it asked: each
 * target's changed skills against its own cap on the session's day, one event per change, and
 * the words it started (any answer, an intro card's or a helped one too). An answer counts for
 * a target only when it was given at or after its word joined it. Phase 65b (spec D2): a session
 * chosen past the day's budget (`planOnly`) moves its own target's skills only for the owed words
 * its stock recorded; the rest of it is practice beyond the promise, which memory and readiness
 * read and the plan does not. Every word it asked still starts.
 */
export function targetSessionWrite(input: {
  sessionId: string;
  day: string;
  targets: readonly HoldingTarget[];
  before: readonly TargetSkillRow[];
  answers: readonly TimedTargetAnswer[];
  planOnly?: { targetId: string; glossIds: readonly string[] };
}): { rows: TargetSkillRow[]; events: TargetSkillEvent[]; started: { targetId: string; glossIds: string[] }[] } {
  const rows: TargetSkillRow[] = [];
  const events: TargetSkillEvent[] = [];
  const started: { targetId: string; glossIds: string[] }[] = [];
  for (const target of input.targets) {
    const addedAt = new Map(target.words.map((word) => [word.glossId, word.addedAt]));
    const counted = input.answers.filter((answer) => {
      const joined = addedAt.get(answer.glossId);
      return joined !== undefined && answer.answeredAt >= joined;
    });
    if (counted.length === 0) continue;
    const only = input.planOnly?.targetId === target.id ? new Set(input.planOnly.glossIds) : null;
    const moved = applyTargetSession({
      targetId: target.id,
      sessionId: input.sessionId,
      day: input.day,
      capHalves: capHalves(daysBetween(input.day, target.dueOn)),
      glossIds: new Set(addedAt.keys()),
      before: input.before,
      answers: only ? counted.filter((answer) => only.has(answer.glossId)) : counted,
    });
    rows.push(...moved.rows);
    events.push(...moved.events);
    started.push({ targetId: target.id, glossIds: [...new Set(counted.map((answer) => answer.glossId))] });
  }
  return { rows, events, started };
}
