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
  NEW_PER_SESSION,
  PER_DIMENSION_CAP,
  RECOGNITION_EXPONENT,
  RUNG_R,
  R_TARGET,
} from './chooseConstants';
import { shuffle } from './session';

/**
 * Phase 35 (spec D5, D6). Which saved glosses a list session asks, each with the
 * dimension it tests and its rung: recognition (1) or recall (2). Chosen when the
 * session is created; the prepare job then chooses each pick's card (D6). Pure:
 * today and the rng are passed in (ADR 0001 R3), and the rng only breaks ties
 * between new words saved at the same moment.
 */

export type ChoiceInput = {
  /** Every saved gloss, with its key and when it was saved (a sortable timestamp). */
  saved: { glossId: string; key: string; savedAt: string }[];
  memory: { glossId: string; dimension: Dimension; state: MemoryState }[];
  levels: { glossId: string; dimension: Dimension; level: number }[];
  /** The learner's day (D10). */
  today: string;
  /** Glosses answered in a session counting for today, or still open. */
  askedToday: ReadonlySet<string>;
  /** Glosses first introduced today. */
  newToday: number;
  listening: boolean;
  speaking: boolean;
  rng: () => number;
};

export type ChoiceClass = 'DUE' | 'NEW' | 'EXPAND' | 'NOT_DUE' | 'ASKED';

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

/** New words a session always gets room for, when the daily cap allows (D5). */
const NEW_FLOOR = 2;

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

/** Spec D6. Recall only from level 3 with R at least RUNG_R; no R is recognition. */
function rungFor(level: number, r: number | null): 1 | 2 {
  return r !== null && level >= 3 && r >= RUNG_R ? 2 : 1;
}

/** Ruling 3: the rung's best card is four-option at rung 1, typed at rung 2. */
const isHard = (pick: ChosenPick) => expectedSuccess(pick.r, pick.rung === 1, pick.rung) < HARD_BELOW;

type Candidate = {
  pick: ChosenPick;
  /** The normalised key: one pick per key (phase 31 D18). */
  key: string;
  savedAt: string;
  /** R of the weakest live dimension with memory; null when none has any. */
  need: number | null;
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

  const candidates = input.saved.map((gloss): Candidate => {
    const rows = memory.get(gloss.glossId);
    let cls: ChoiceClass;
    let dimension: Dimension;
    let need: number | null = null;
    if (!rows || rows.size === 0) {
      cls = 'NEW';
      dimension = 'written_receptive';
    } else {
      // The weakest live dimension with memory; a tie goes to the earlier in ORDER.
      let weak: Dimension | undefined;
      for (const d of live) {
        const r = rows.get(d);
        if (r !== undefined && (need === null || r < need)) [weak, need] = [d, r];
      }
      const unintroduced = live.find((d) => !rows.has(d));
      if (weak !== undefined && need !== null && need <= R_TARGET) [cls, dimension] = ['DUE', weak];
      else if (unintroduced !== undefined) [cls, dimension] = ['EXPAND', unintroduced];
      // No live dimension is unintroduced, so every one has a row, and WR is
      // always live: `weak` is set.
      else [cls, dimension] = ['NOT_DUE', weak!];
    }
    const r = rows?.get(dimension) ?? null;
    const level = levelOf(gloss.glossId, dimension);
    return {
      pick: {
        glossId: gloss.glossId,
        dimension,
        rung: rungFor(level, r),
        level,
        r,
        cls: input.askedToday.has(gloss.glossId) ? 'ASKED' : cls,
      },
      key: normaliseGloss(gloss.key),
      savedAt: gloss.savedAt,
      need,
    };
  });

  const of = (cls: ChoiceClass) => candidates.filter((candidate) => candidate.pick.cls === cls);
  const due = of('DUE').sort(byNeed);
  // Newest saved first; the shuffle first makes equal save times fall at random.
  const fresh = shuffle(of('NEW'), input.rng).sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  const expand = of('EXPAND').sort(byNeed);
  const notDue = of('NOT_DUE').sort(byNeed);
  const asked = of('ASKED').sort(byNeed);

  const n = Math.min(SESSION_LENGTH, new Set(candidates.map((candidate) => candidate.key)).size);
  const newAllowed = Math.max(0, DAY_NEW_CAP - input.newToday);
  const newThisSession = Math.min(fresh.length, NEW_PER_SESSION, newAllowed);
  const newRoom = Math.min(NEW_FLOOR, newThisSession);

  const picks: ChosenPick[] = [];
  const keys = new Set<string>();
  const perDimension = new Map<Dimension, number>();
  let hard = 0;
  let newCount = 0;
  // Skipped for a cap: asked after everything else, so the session still holds N
  // when nothing else is left (three saved words give three picks; ruling 14).
  const deferred: Candidate[] = [];

  const add = (candidate: Candidate) => {
    picks.push(candidate.pick);
    keys.add(candidate.key);
    perDimension.set(candidate.pick.dimension, (perDimension.get(candidate.pick.dimension) ?? 0) + 1);
    if (isHard(candidate.pick)) hard++;
    if (candidate.pick.cls === 'NEW') newCount++;
  };
  const offer = (candidate: Candidate) => {
    if (keys.has(candidate.key)) return;
    const capped =
      (perDimension.get(candidate.pick.dimension) ?? 0) >= PER_DIMENSION_CAP || (isHard(candidate.pick) && hard >= HARD_CAP);
    if (capped) deferred.push(candidate);
    else add(candidate);
  };

  // DUE first, leaving room for the new words the session is owed.
  for (const candidate of due) {
    if (picks.length >= n - newRoom) break;
    offer(candidate);
  }
  let nextFresh = 0;
  const offerFresh = (limit: number) => {
    while (nextFresh < fresh.length && newCount < limit && picks.length < n) offer(fresh[nextFresh++]);
  };
  offerFresh(newThisSession);
  for (const candidate of expand) {
    if (picks.length >= n) break;
    offer(candidate);
  }
  offerFresh(newAllowed);
  for (const candidate of [...notDue, ...asked]) {
    if (picks.length >= n) break;
    offer(candidate);
  }
  // The last resorts, past the dimension and hard caps: what they held back,
  // within the daily new cap; then, ruling 15, new words past it, so a session is
  // never short while saved glosses remain.
  const rest = [...deferred, ...fresh.slice(nextFresh)];
  const fill = (newLimit: number) => {
    for (const candidate of rest) {
      if (picks.length >= n) break;
      if (keys.has(candidate.key) || (candidate.pick.cls === 'NEW' && newCount >= newLimit)) continue;
      add(candidate);
    }
  };
  fill(newAllowed);
  fill(Infinity);
  return picks;
}
