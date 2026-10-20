import {
  READINESS_WORD_READY,
  countedSkills,
  readinessPct as meanPct,
  wordChance,
  type Dimension,
  type QuestionType,
  type ReadinessKind,
} from '@lang-tutor/core/domain';

import { NEW_TARGET_WORDS_PER_DAY } from './chooseConstants';
import { daysBetween } from './progress';
import { capHalves } from './targetSkills';

/**
 * Phase 57 (spec D6, D9), phase 67 (spec D1–D4). A target's plan and its work today, from the
 * words, each counted skill's readiness at the start of today and the cards asked today on the
 * target's path. A word below 90 gets two cards a day on two different skills; on the eve one
 * per counted skill, and a ready word one check; new words are met split, at most
 * NEW_TARGET_WORDS_PER_DAY a day. Pure (ADR 0001): the day is passed in.
 */

export type TargetWordInput = {
  glossId: string;
  addedOn: string;
  startedOn: string | null;
  /** The word's live skills; speaking is dropped for an unspeakable word. */
  live: readonly Dimension[];
};

/** Phase 67 (spec D1). A counted skill's chance (0..1) at the start of today, and the day its
 *  readiness last moved (null: never). */
export type SkillStart = { glossId: string; dimension: Dimension; chance: number; movedOn: string | null };

export type TargetDayInput = {
  today: string;
  createdOn: string;
  dueOn: string;
  kind: ReadinessKind;
  words: readonly TargetWordInput[];
  starts: readonly SkillStart[];
  /** Spec D2. The cards answered today on the target's path, right or wrong, and the cards of its
   *  session in flight when the caller credits them. */
  askedToday: readonly { glossId: string; type: QuestionType }[];
  answeredToday: boolean;
};

export type WordDay = {
  glossId: string;
  state: 'owed' | 'done' | 'extra' | 'later';
  /** In today's quota and not met yet: its first card meets it. */
  toStart: boolean;
  /** The practised skills its cards still ask today, the first asked first: `open`'s first `cardsLeft`. */
  owed: Dimension[];
  /** Its practised skills not asked today, in the order its next card picks from (spec D2). */
  open: Dimension[];
  cardsLeft: number;
  /** Its practised skills and their chances at the start of today, in writing, spelling, speaking order. */
  practised: { dimension: Dimension; chance: number }[];
  /** Its readiness at the start of today, in percent. */
  readinessPct: number;
  /** A `later` word: the days until the quota first covers it; else null. */
  startsIn: number | null;
};

export type TargetDay = {
  daysLeft: number;
  /** The meter's cap by days left: it no longer steers, the meter's write reads it. */
  capHalves: number;
  state: 'owed' | 'done' | 'rest' | 'due_today';
  planned: number;
  done: number;
  extra: number;
  nextPracticeIn: number | null;
  readinessPct: number;
  readyCount: number;
  words: WordDay[];
};

/** Phase 53 D3 (Victor: the kind sets how strict a target is, never which skills are practised),
 *  phase 67 (spec D2). The skills a target word's cards ask, whatever its kind: writing, spelling
 *  and speaking among its live ones, whose cards test the receptive skills too. Spelling has a card
 *  of its own, the dictation, only where the device can listen; elsewhere the writing card, whose
 *  typed answer grades spelling, asks it. Its readiness, and so whether it is below 90, counts only
 *  its kind's (phase 65). */
export const practisedSkills = (live: readonly Dimension[]): Dimension[] =>
  countedSkills('homework', live).filter((dimension) => dimension !== 'spelling' || live.includes('spoken_receptive'));

/** Spec D2. The practised skill a card of `type` asks: what a typed or tiled answer writes, a
 *  dictation spells, a say translation says (also when answered by typing). Null for a card that
 *  asks none (reading a word is not what the check asks). */
export function servedSkill(type: QuestionType): Dimension | null {
  switch (type) {
    case 'typed_translation':
    case 'cloze_typed':
    case 'sentence_translation':
    case 'letter_tiles':
    case 'reverse_choice':
    case 'cloze_choice':
      return 'written_productive';
    case 'dictation':
      return 'spelling';
    case 'say_translation':
      return 'spoken_productive';
    default:
      return null;
  }
}

/** Spec D3. Today's quota of words to meet, of `pool` (unmet, or met today): spread to the
 *  halfway day at most NEW_TARGET_WORDS_PER_DAY a day, and on the eve all of them. */
function quotaOf(pool: number, daysLeft: number, half: number): number {
  if (daysLeft <= 1) return pool;
  const meeting = Math.max(1, daysLeft - half + 1);
  return Math.min(NEW_TARGET_WORDS_PER_DAY, Math.ceil(pool / meeting));
}

export function targetDay(input: TargetDayInput): TargetDay {
  const { today, words } = input;
  const daysLeft = daysBetween(today, input.dueOn);
  const total = Math.max(1, daysBetween(input.createdOn, input.dueOn));
  const half = Math.ceil(total / 2);
  const eve = daysLeft === 1;

  const ordered = [...words].sort(
    (a, b) => (a.addedOn < b.addedOn ? -1 : a.addedOn > b.addedOn ? 1 : a.glossId < b.glossId ? -1 : a.glossId > b.glossId ? 1 : 0),
  );
  const pool = ordered.filter((word) => word.startedOn === null || word.startedOn === today);
  const quota = daysLeft <= 0 ? 0 : quotaOf(pool.length, daysLeft, half);
  const inQuota = new Set(pool.slice(0, quota).map((word) => word.glossId));
  // A later word's day: the quotas of the days ahead played over the words still unmet.
  const startsIn = new Map<string, number>();
  let waiting = pool.slice(quota).filter((word) => word.startedOn === null);
  for (let ahead = 1; ahead < daysLeft && waiting.length > 0; ahead++) {
    const taken = quotaOf(waiting.length, daysLeft - ahead, half);
    for (const word of waiting.slice(0, taken)) startsIn.set(word.glossId, ahead);
    waiting = waiting.slice(taken);
  }

  const startOf = new Map(input.starts.map((start) => [`${start.glossId}|${start.dimension}`, start]));
  const askedOf = new Map<string, Set<Dimension>>();
  for (const card of input.askedToday) {
    const skill = servedSkill(card.type);
    if (skill === null) continue;
    askedOf.set(card.glossId, (askedOf.get(card.glossId) ?? new Set()).add(skill));
  }

  let planned = 0;
  let done = 0;
  let extra = 0;
  let readyCount = 0;
  let below = false;
  const chances: number[] = [];
  const out: WordDay[] = ordered.map((word) => {
    const practised = practisedSkills(word.live).map((dimension) => ({
      dimension,
      chance: startOf.get(`${word.glossId}|${dimension}`)?.chance ?? 0,
      movedOn: startOf.get(`${word.glossId}|${dimension}`)?.movedOn ?? null,
    }));
    const chance = wordChance(countedSkills(input.kind, word.live).map((dimension) => startOf.get(`${word.glossId}|${dimension}`)?.chance ?? 0));
    const pct = Math.floor(100 * chance);
    const ready = pct >= READINESS_WORD_READY;
    chances.push(chance);
    if (ready) readyCount += 1;
    else below = true;

    const asked = askedOf.get(word.glossId) ?? new Set<Dimension>();
    const open = practised
      .filter((skill) => !asked.has(skill.dimension))
      .sort(
        (a, b) =>
          a.chance - b.chance ||
          (a.movedOn ?? '').localeCompare(b.movedOn ?? '') ||
          practised.indexOf(a) - practised.indexOf(b),
      )
      .map((skill) => skill.dimension);
    const base = { glossId: word.glossId, open, practised: practised.map(({ dimension, chance: c }) => ({ dimension, chance: c })), readinessPct: pct };

    const isPlanned = (word.startedOn !== null && word.startedOn < today) || inQuota.has(word.glossId);
    if (!isPlanned) {
      if (word.startedOn === today) {
        extra += 1;
        return { ...base, state: 'extra', toStart: false, owed: [], cardsLeft: 0, startsIn: null };
      }
      return { ...base, state: 'later', toStart: false, owed: [], cardsLeft: 0, startsIn: startsIn.get(word.glossId) ?? null };
    }
    planned += 1;
    const need = daysLeft <= 0 ? 0 : eve ? (ready ? 1 : practised.length) : ready ? 0 : Math.min(2, practised.length);
    const askedSkills = practised.filter((skill) => asked.has(skill.dimension)).length;
    const cardsLeft = Math.min(open.length, Math.max(0, need - askedSkills));
    const toStart = word.startedOn === null && cardsLeft > 0;
    if (cardsLeft === 0) done += 1;
    return { ...base, state: cardsLeft > 0 ? 'owed' : 'done', toStart, owed: open.slice(0, cardsLeft), cardsLeft, startsIn: null };
  });

  let state: TargetDay['state'];
  if (daysLeft <= 0) state = 'due_today';
  else if (out.some((word) => word.state === 'owed')) state = 'owed';
  else state = input.answeredToday ? 'done' : 'rest';

  const unmet = out.some((word) => word.state === 'later' || word.toStart);
  return {
    daysLeft,
    capHalves: capHalves(daysLeft),
    state,
    planned,
    done,
    extra,
    nextPracticeIn: daysLeft <= 1 ? null : below || unmet ? 1 : daysLeft - 1,
    readinessPct: meanPct(chances),
    readyCount,
    words: out,
  };
}
