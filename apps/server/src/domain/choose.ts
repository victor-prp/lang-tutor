import {
  MIN_LEVEL,
  SESSION_LENGTH,
  normaliseGloss,
  retrievability,
  type Dimension,
  type MemoryState,
} from '@lang-tutor/core/domain';

import {
  DAY_NEW_CAP,
  HARD_CAP,
  NEW_FLOOR,
  NEW_PER_SESSION,
  PER_DIMENSION_CAP,
  RECOGNITION_EXPONENT,
  RUNG_R,
  R_TARGET,
  SPEAKING_PER_SESSION,
} from './chooseConstants';
import { shuffle } from './session';
import type { Step } from './today';

/**
 * Phase 35 (spec D5, D6), reworked by phase 37 (spec D2–D4). Which saved glosses a
 * list session asks, each with the dimension it tests and its rung: recognition
 * (1) or recall (2). Chosen when the session is created; the prepare job then
 * chooses each pick's card (D6). Pure: today and the rng are passed in (ADR 0001
 * R3), and the rng only breaks ties between new words saved at the same moment.
 */

export type ChoiceInput = {
  /** Every saved gloss, with its key and when it was saved (a sortable timestamp). */
  saved: { glossId: string; key: string; savedAt: string }[];
  memory: { glossId: string; dimension: Dimension; state: MemoryState }[];
  levels: { glossId: string; dimension: Dimension; level: number }[];
  /** The learner's day (D10). */
  today: string;
  /** Phase 37 (spec D1). The returns today owes, earliest opened first. */
  steps: readonly Step[];
  /** Phase 37 (spec D1). Glosses answered today that owe no return, in the order
   *  a session asks them: the least practised today first. */
  done: ReadonlySet<string>;
  /** Glosses first introduced today. */
  newToday: number;
  listening: boolean;
  speaking: boolean;
  rng: () => number;
  /** Phase 39 (spec D5). Each family member's family (any stable id), and the glosses that wait. */
  families: { familyOf: ReadonlyMap<string, number | string>; waiting: ReadonlySet<string> };
};

/** Phase 37 (spec D3). `SPEAK` is a gloss the speaking pick moved to spoken
 *  production (D4); a return or a due word it takes keeps its class. */
export type ChoiceClass = 'STEP' | 'NEW' | 'DUE' | 'EXPAND' | 'NOT_DUE' | 'DONE' | 'SPEAK';

/** `level` and `r` are the chosen dimension's, for the job's card choice; `r` is
 *  null for a dimension with no memory yet. */
export type ChosenPick = { glossId: string; dimension: Dimension; rung: 1 | 2; level: number; r: number | null; cls: ChoiceClass };

/** Introduction order, easiest first. */
export const ORDER: readonly Dimension[] = [
  'written_receptive',
  'written_productive',
  'spoken_receptive',
  'spelling',
  'spoken_productive',
];

/** Spec D5: a pick whose best card's chance is below this counts toward HARD_CAP. */
const HARD_BELOW = 0.6;

const SPEAKING: Dimension = 'spoken_productive';

/**
 * Spec D6, ruling 3. A card's chance of success: p = g + (1 − g)·R^e, with g the
 * guess floor of a four-option card and e the recognition exponent at rung 1.
 * No R (a dimension never asked) reads as 1.
 */
export function expectedSuccess(r: number | null, fourOption: boolean, rung: 1 | 2): number {
  const g = fourOption ? 0.25 : 0;
  const e = rung === 1 ? RECOGNITION_EXPONENT : 1;
  return g + (1 - g) * Math.pow(r ?? 1, e);
}

/** Phase 37 (spec D2). Recall once the dimension has memory with R at least
 *  RUNG_R; its first card, and a word half forgotten, are recognition. The level
 *  does not decide. A return is recall whatever this says (D1). */
export function rungFor(r: number | null): 1 | 2 {
  return r !== null && r >= RUNG_R ? 2 : 1;
}

/** Ruling 3: the rung's best card is four-option at rung 1, typed at rung 2. */
const isHard = (pick: ChosenPick) => expectedSuccess(pick.r, pick.rung === 1, pick.rung) < HARD_BELOW;

type Candidate = {
  pick: ChosenPick;
  /** The normalised key: one pick per key (phase 31 D18). */
  key: string;
  /** Phase 39 (spec D5). The gloss's family, when it has one: a second mark beside the key. */
  family: number | string | undefined;
  savedAt: string;
  /** R of the weakest live dimension with memory; null when none has any. */
  need: number | null;
  /** R today per dimension with memory. */
  rows: ReadonlyMap<Dimension, number> | undefined;
  /** A return's place among the returns (D1). */
  opened: number;
};

const byNeed = (a: Candidate, b: Candidate) => (a.need ?? 1) - (b.need ?? 1);

export function chooseWords(input: ChoiceInput): ChosenPick[] {
  const live = ORDER.filter(
    (dimension) =>
      (dimension !== 'spoken_receptive' || input.listening) && (dimension !== 'spoken_productive' || input.speaking),
  );

  const memory = new Map<string, Map<Dimension, number>>();
  for (const row of input.memory) {
    const rows = memory.get(row.glossId) ?? new Map<Dimension, number>();
    rows.set(row.dimension, retrievability(row.state, input.today));
    memory.set(row.glossId, rows);
  }
  const levels = new Map(input.levels.map((row) => [`${row.glossId}\u0000${row.dimension}`, row.level]));
  const levelOf = (glossId: string, dimension: Dimension) => levels.get(`${glossId}\u0000${dimension}`) ?? MIN_LEVEL;
  const pickOf = (glossId: string, dimension: Dimension, cls: ChoiceClass, rows: ReadonlyMap<Dimension, number> | undefined): ChosenPick => {
    const r = rows?.get(dimension) ?? null;
    return { glossId, dimension, rung: cls === 'STEP' ? 2 : rungFor(r), level: levelOf(glossId, dimension), r, cls };
  };

  // D1: a return whose dimension is not live this session waits for one where it
  // is. Meanwhile it is a word answered today, asked only when nothing else is left,
  // so a session is never empty while a word is saved.
  const steps = new Map(input.steps.filter((step) => live.includes(step.dimension)).map((step) => [step.glossId, step]));
  const waiting = new Set(input.steps.filter((step) => !live.includes(step.dimension)).map((step) => step.glossId));

  // Phase 39 (spec D5). A waiting gloss is no candidate: no class, no pass.
  const candidates = input.saved
    .filter((gloss) => !input.families.waiting.has(gloss.glossId))
    .map((gloss): Candidate => {
      const rows = memory.get(gloss.glossId);
      const owed = steps.get(gloss.glossId);
      // The weakest live dimension with memory; a tie goes to the earlier in ORDER.
      let weak: Dimension | undefined;
      let need: number | null = null;
      for (const d of live) {
        const r = rows?.get(d);
        if (r !== undefined && (need === null || r < need)) [weak, need] = [d, r];
      }
      let cls: ChoiceClass;
      let dimension: Dimension;
      if (owed) [cls, dimension] = ['STEP', owed.dimension];
      else if (!rows || rows.size === 0) [cls, dimension] = ['NEW', 'written_receptive'];
      else {
        const unintroduced = live.find((d) => !rows.has(d));
        if (weak !== undefined && need !== null && need <= R_TARGET) [cls, dimension] = ['DUE', weak];
        else if (unintroduced !== undefined) [cls, dimension] = ['EXPAND', unintroduced];
        // No live dimension is unintroduced, so every one has a row, and WR is
        // always live: `weak` is set.
        else [cls, dimension] = ['NOT_DUE', weak!];
      }
      if (!owed && (input.done.has(gloss.glossId) || waiting.has(gloss.glossId))) cls = 'DONE';
      return {
        pick: pickOf(gloss.glossId, dimension, cls, rows),
        key: normaliseGloss(gloss.key),
        family: input.families.familyOf.get(gloss.glossId),
        savedAt: gloss.savedAt,
        need,
        rows,
        opened: owed?.opened ?? 0,
      };
    });

  const of = (cls: ChoiceClass) => candidates.filter((candidate) => candidate.pick.cls === cls);
  const returns = of('STEP').sort((a, b) => a.opened - b.opened);
  const due = of('DUE').sort(byNeed);
  // Newest saved first; the shuffle first makes equal save times fall at random.
  const fresh = shuffle(of('NEW'), input.rng).sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  const expand = of('EXPAND').sort(byNeed);
  const notDue = of('NOT_DUE').sort(byNeed);
  // D3: in the order today gives them, the least practised first; a waiting return last.
  const doneOrder = new Map([...input.done].map((glossId, index) => [glossId, index]));
  const done = of('DONE').sort((a, b) => (doneOrder.get(a.pick.glossId) ?? Infinity) - (doneOrder.get(b.pick.glossId) ?? Infinity));

  // D3. The new-word reserve comes first and gives way to a backlog, down to NEW_FLOOR.
  // Phase 39 (spec D5): n counts groups joined by either mark, a key or a family
  // (union-find), so a list of a few large families promises no more picks than it can give.
  const parent = candidates.map((_, index) => index);
  const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index])));
  const firstWith = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    for (const mark of [`k${candidate.key}`, ...(candidate.family === undefined ? [] : [`f${candidate.family}`])]) {
      const seen = firstWith.get(mark);
      if (seen === undefined) firstWith.set(mark, index);
      else parent[root(index)] = root(seen);
    }
  });
  const n = Math.min(SESSION_LENGTH, new Set(candidates.map((_, index) => root(index))).size);
  const newLeft = Math.max(0, DAY_NEW_CAP - input.newToday);
  const speak = input.speaking && n >= 2 ? SPEAKING_PER_SESSION : 0;
  const room = n - speak - returns.length - due.length;
  const reserve = Math.min(fresh.length, newLeft, Math.min(NEW_PER_SESSION, Math.max(NEW_FLOOR, room)));

  const picks: ChosenPick[] = [];
  const keys = new Set<string>();
  // Phase 39 (spec D5). The families of the picks so far, and the families a return
  // claimed: a claimed family is free to its claiming return alone.
  const pickedFamilies = new Set<number | string>();
  const claims = new Map<number | string, string>();
  for (const candidate of returns) {
    if (candidate.family !== undefined && !claims.has(candidate.family)) claims.set(candidate.family, candidate.pick.glossId);
  }
  const taken = new Set<string>();
  const perDimension = new Map<Dimension, number>();
  let hard = 0;
  let newCount = 0;
  // Held back by a cap: asked after everything but DONE (ruling 14).
  const deferred: Candidate[] = [];

  const free = (candidate: Candidate) =>
    !taken.has(candidate.pick.glossId) &&
    !keys.has(candidate.key) &&
    (candidate.family === undefined ||
      (!pickedFamilies.has(candidate.family) && (claims.get(candidate.family) ?? candidate.pick.glossId) === candidate.pick.glossId));
  const add = (candidate: Candidate) => {
    if (candidate.family !== undefined) pickedFamilies.add(candidate.family);
    picks.push(candidate.pick);
    keys.add(candidate.key);
    taken.add(candidate.pick.glossId);
    perDimension.set(candidate.pick.dimension, (perDimension.get(candidate.pick.dimension) ?? 0) + 1);
    if (isHard(candidate.pick)) hard++;
    if (candidate.pick.cls === 'NEW') newCount++;
  };
  // The dimension cap holds expansions only: a newly live dimension cannot flood
  // a session, and nothing better known is asked ahead of a due word for it.
  const offer = (candidate: Candidate, dimensionCap: boolean) => {
    if (picks.length >= n || !free(candidate)) return;
    const capped =
      (dimensionCap && (perDimension.get(candidate.pick.dimension) ?? 0) >= PER_DIMENSION_CAP) ||
      (isHard(candidate.pick) && hard >= HARD_CAP);
    if (capped) deferred.push(candidate);
    else add(candidate);
  };
  let nextFresh = 0;
  const offerFresh = (limit: number) => {
    while (nextFresh < fresh.length && newCount < limit && picks.length < n) {
      const candidate = fresh[nextFresh++];
      if (free(candidate)) add(candidate);
    }
  };
  const fill = (from: readonly Candidate[]) => {
    for (const candidate of from) {
      if (picks.length >= n) break;
      if (free(candidate)) add(candidate);
    }
  };

  // 1. New words, up to the reserve.
  offerFresh(reserve);
  // 2. D4, the speaking pick: a return in SK, then a word due in SK, then a word not
  //    due with no SK memory, least known first, then a word done today with none,
  //    whose speaking is practice it has not had, then a due word with none, best
  //    known first so the most urgent reviews keep their place.
  const silent = (candidate: Candidate) => !candidate.rows?.has(SPEAKING);
  const tiers: [Candidate[], boolean][] = [
    [returns.filter((candidate) => candidate.pick.dimension === SPEAKING), false],
    [due.filter((candidate) => candidate.pick.dimension === SPEAKING), false],
    [[...expand, ...notDue].sort(byNeed).filter(silent), true],
    [done.filter((candidate) => candidate.rows !== undefined && silent(candidate)), true],
    [due.filter(silent).sort((a, b) => byNeed(b, a)), true],
  ];
  for (let spoken = 0; spoken < speak && picks.length < n; spoken++) {
    for (const [tier, moved] of tiers) {
      const candidate = tier.find(free);
      if (!candidate) continue;
      add(moved ? { ...candidate, pick: pickOf(candidate.pick.glossId, SPEAKING, 'SPEAK', candidate.rows) } : candidate);
      break;
    }
  }
  // 3–7. Returns, due words, expansions, new words to the daily cap, words not due.
  for (const candidate of returns) offer(candidate, false);
  for (const candidate of due) offer(candidate, false);
  for (const candidate of expand) offer(candidate, true);
  offerFresh(newLeft);
  for (const candidate of notDue) offer(candidate, false);
  // 8. What a cap held back. 9. Words answered today: only when nothing else is left.
  fill(deferred);
  fill(done);
  // 10. Ruling 15, now for an empty session only: new words past the daily cap.
  if (picks.length === 0) offerFresh(Infinity);
  return picks;
}
