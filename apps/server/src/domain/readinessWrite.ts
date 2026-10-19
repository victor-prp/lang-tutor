import {
  applyReadiness,
  countedSkills,
  gradesFor,
  readinessFromMemory,
  skillChance,
  type Dimension,
  type ReadinessRow,
  type ReadinessWhy,
} from '@lang-tutor/core/domain';

import type { MemoryRow } from './memoryUpdate';
import type { HoldingTarget, TimedTargetAnswer } from './targetSkills';

/**
 * Phase 65 (spec D2, D3). What an ended session writes for a target's readiness: per counted
 * skill of each word it answered, the answers in order through the core rule. Pure (ADR 0001):
 * the day and every row are passed in.
 */

const ALL_SKILLS: readonly Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];

export type TargetReadinessRow = { targetId: string; glossId: string; dimension: Dimension; row: ReadinessRow; sessionId: string | null };

/** One applied answer. `before` and `after` are the skill's chance as read (0..1), so an exam
 *  hold shows in them. */
export type TargetReadinessEvent = {
  targetId: string;
  glossId: string;
  dimension: Dimension;
  sessionId: string;
  day: string;
  before: number;
  after: number;
  why: ReadinessWhy;
};

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}\u0000${dimension}`;

/**
 * Spec D2, D3, R1. Each target's counted skills moved by the session's answers, in order. A
 * skill with no row starts from the main memory as it stood before this session (the caller
 * reads it first), else from nothing. An answer counts for a target only at or after its word
 * joined it; a session on or after the due date writes nothing (the rule ignores it). Rows come
 * back once per touched skill, events once per applied answer.
 */
export function readinessSessionWrite(input: {
  sessionId: string;
  day: string;
  targets: readonly HoldingTarget[];
  before: readonly TargetReadinessRow[];
  memory: readonly MemoryRow[];
  answers: readonly TimedTargetAnswer[];
}): { rows: TargetReadinessRow[]; events: TargetReadinessEvent[] } {
  const rows: TargetReadinessRow[] = [];
  const events: TargetReadinessEvent[] = [];
  const memory = new Map(input.memory.map((row) => [keyOf(row.glossId, row.dimension), row]));
  for (const target of input.targets) {
    const addedAt = new Map(target.words.map((word) => [word.glossId, word.addedAt]));
    const counted = new Set<Dimension>(countedSkills(target.kind, ALL_SKILLS));
    const current = new Map<string, TargetReadinessRow>(
      input.before.filter((row) => row.targetId === target.id).map((row) => [keyOf(row.glossId, row.dimension), row]),
    );
    const touched = new Set<string>();
    for (const answer of input.answers) {
      const joined = addedAt.get(answer.glossId);
      if (joined === undefined || answer.answeredAt < joined) continue;
      for (const { dimension, grade } of gradesFor(answer)) {
        if (!counted.has(dimension)) continue;
        const key = keyOf(answer.glossId, dimension);
        const existing = current.get(key);
        const memoryRow = memory.get(key);
        const start = existing?.row ?? (memoryRow ? readinessFromMemory(memoryRow.state) : null);
        const applied = applyReadiness(start, grade, input.day, target.dueOn, target.kind);
        if (!applied) continue;
        current.set(key, { targetId: target.id, glossId: answer.glossId, dimension, row: applied.row, sessionId: input.sessionId });
        touched.add(key);
        events.push({
          targetId: target.id,
          glossId: answer.glossId,
          dimension,
          sessionId: input.sessionId,
          day: input.day,
          before: skillChance(start, target.dueOn),
          after: skillChance(applied.row, target.dueOn),
          why: applied.why,
        });
      }
    }
    for (const key of touched) rows.push(current.get(key)!);
  }
  return { rows, events };
}
