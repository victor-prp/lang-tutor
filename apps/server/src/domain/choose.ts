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
  LADDER_SLOTS,
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
  /** Phase 39 (spec D5). Each family member's family (any stable id), and the glosses that wait.
   *  Phase 54 (spec D2): `introductions`, the glosses glossFamilies introduces with their known
   *  meanings, are NEW but no ladder: each keeps its single new_meaning card. */
  families: {
    familyOf: ReadonlyMap<string, number | string>;
    waiting: ReadonlySet<string>;
    introductions: ReadonlySet<string>;
  };
};

/** Phase 37 (spec D3). `SPEAK` is a gloss the speaking pick moved to spoken
 *  production (D4); a return or a due word it takes keeps its class. */
export type ChoiceClass = 'STEP' | 'NEW' | 'DUE' | 'EXPAND' | 'NOT_DUE' | 'DONE' | 'SPEAK';

/** `level` and `r` are the chosen dimension's, for the job's card choice; `r` is
 *  null for a dimension with no memory yet. Phase 54 (spec D2, D3): `ladder`, a NEW pick
 *  but a family's introduction, is a new word's first session: a meet card and three
 *  practice cards, LADDER_SLOTS of the session's slots. */
export type ChosenPick = {
  glossId: string;
  dimension: Dimension;
  rung: 1 | 2;
  level: number;
  r: number | null;
  cls: ChoiceClass;
  ladder: boolean;
};

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

/** Phase 39 (spec D2). A session's live skills, in ORDER: listening and speaking
 *  only when on. chooseWords and the families rule read the same list. */
export function liveDimensions(listening: boolean, speaking: boolean): Dimension[] {
  return ORDER.filter(
    (dimension) => (dimension !== 'spoken_receptive' || listening) && (dimension !== SPEAKING || speaking),
  );
}

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

/** Phase 39 (spec D5). The groups among the candidates joined by either mark, a key or a
 *  family (union-find). */
function groupCount(candidates: readonly Candidate[]): number {
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
  return new Set(candidates.map((_, index) => root(index))).size;
}

/**
 * Phase 53 (spec D6, ruling R-D6). A part of a session: a target's words, or the main
 * path. The pools of a session are picked in order, in one call.
 */
export type Pool = {
  /** The glosses this pool may pick; null: every saved gloss no other pool lists (the main path). */
  glossIds: ReadonlySet<string> | null;
  /** Slots this pool aims to fill in the first pass: a pick takes one, a ladder LADDER_SLOTS
   *  (phase 54, spec D4). What it leaves unused passes to the next pool; what is still unused
   *  after the last goes back to the pools, in order. A pool that lists its glosses (a
   *  target's) fills its slots with its own words answered today before passing any on; the
   *  main path's words answered today come last of all. */
  slots: number;
  /** Ruling R-D7: new words this pool may introduce whatever the daily cap says (a target's pace),
   *  reserved ahead of its returns and due words (owed words first); 0 for the main path. */
  owedNew: number;
};

/** A session with no target: one pool, the main path, of SESSION_LENGTH. */
export function chooseWords(input: ChoiceInput): ChosenPick[] {
  return choosePools(input, [{ glossIds: null, slots: SESSION_LENGTH, owedNew: 0 }])[0];
}

/**
 * Phase 53 (spec D5, D6, rulings R-D6, R-D7). One call per session. Returns each pool's
 * picks, in pool order. In the first pass each pool takes steps 1–8 over its own words,
 * aiming for its slots and what the pools before it left unpicked: unused slots go forward.
 * A target's pool (one that lists its glosses) then fills those slots with its own words
 * answered today (step 9) before passing any on, so a target not ready keeps the whole
 * session (D5). In the second pass the slots still unpicked go back to the pools in the same
 * order, each offered as many as remain, by the same rule. Only the third gives what is left
 * to the main path's words answered today, so those wait for every pool's other words
 * (phase 37 D3). A session still empty goes past the daily cap (ruling 15), the pools in
 * order. The pools share what one session shares: the glosses, keys and families picked,
 * the families the returns claimed, the per-dimension and hard counts, the new words, the
 * ladders and the speaking pick. Phase 54 (spec D4): what passes is slots, not picks; a
 * ladder takes LADDER_SLOTS of them, and a session holds NEW_PER_SESSION ladders at most.
 */
export function choosePools(input: ChoiceInput, pools: readonly Pool[]): ChosenPick[][] {
  const live = liveDimensions(input.listening, input.speaking);

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
    const ladder = cls === 'NEW' && !input.families.introductions.has(glossId);
    return { glossId, dimension, rung: cls === 'STEP' ? 2 : rungFor(r), level: levelOf(glossId, dimension), r, cls, ladder };
  };
  // Phase 54 (spec D2). A gloss is learned once any of its skills was answered right: a row
  // with more answers than Agains. A matching board's right answer grades Hard and a typed
  // near miss Good, so both count as right.
  const learned = new Set(input.memory.filter((row) => row.state.reps > row.state.lapses).map((row) => row.glossId));

  // D1: a return whose dimension is not live this session waits for one where it
  // is. Meanwhile it is a word answered today, asked only when nothing else is left,
  // so a session is never empty while a word is saved.
  const steps = new Map(input.steps.filter((step) => live.includes(step.dimension)).map((step) => [step.glossId, step]));
  const waiting = new Set(input.steps.filter((step) => !live.includes(step.dimension)).map((step) => step.glossId));

  // The glosses a pool lists are no words of the main path's.
  const listed = new Set(pools.flatMap((pool) => (pool.glossIds === null ? [] : [...pool.glossIds])));

  // Phase 39 (spec D5). A waiting gloss is no candidate: no class, no pass. Phase 53 (final
  // review I1): unless a pool lists it. A target's word is asked while its family waits on
  // another meaning, so it is met before the target's date (spec D7); a family still gives a
  // session one gloss, by the families picked and the claims, as every family does. With no
  // pool that lists glosses, `listed` is empty and the rule is phase 39's.
  const candidates = input.saved
    .filter((gloss) => !input.families.waiting.has(gloss.glossId) || listed.has(gloss.glossId))
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
      // Phase 54 (spec D2). An unlearned gloss, no memory or only Agains, is NEW, owed a
      // return or not: a word missed in its ladder comes back as a ladder, never as a cold
      // recall card. Done today, it stays DONE below.
      if (!rows || !learned.has(gloss.glossId)) [cls, dimension] = ['NEW', 'written_receptive'];
      else if (owed) [cls, dimension] = ['STEP', owed.dimension];
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

  // Phase 53 (ruling R-D6): sorted once for the session; each pool asks its own part
  // of each list, in this order.
  const of = (cls: ChoiceClass) => candidates.filter((candidate) => candidate.pick.cls === cls);
  const allReturns = of('STEP').sort((a, b) => a.opened - b.opened);
  const allDue = of('DUE').sort(byNeed);
  // Newest saved first; the shuffle first makes equal save times fall at random.
  const allFresh = shuffle(of('NEW'), input.rng).sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  const allExpand = of('EXPAND').sort(byNeed);
  const allNotDue = of('NOT_DUE').sort(byNeed);
  // D3: in the order today gives them, the least practised first; a waiting return last.
  const doneOrder = new Map([...input.done].map((glossId, index) => [glossId, index]));
  const allDone = of('DONE').sort((a, b) => (doneOrder.get(a.pick.glossId) ?? Infinity) - (doneOrder.get(b.pick.glossId) ?? Infinity));

  // Ruling R-D6: the state the pools share, created once for the session.
  const keys = new Set<string>();
  // Phase 39 (spec D5). The families of the picks so far, and the families a return
  // claimed: a claimed family is free to its claiming return alone, whichever pool
  // holds that return.
  const pickedFamilies = new Set<number | string>();
  const claims = new Map<number | string, string>();
  for (const candidate of allReturns) {
    if (candidate.family !== undefined && !claims.has(candidate.family)) claims.set(candidate.family, candidate.pick.glossId);
  }
  const taken = new Set<string>();
  const perDimension = new Map<Dimension, number>();
  let hard = 0;
  let newCount = 0;
  // Phase 54 (spec D4). The session's ladders, held to NEW_PER_SESSION over every pool and pass.
  let ladders = 0;
  let spoken = 0;

  // Open: no pick so far is the gloss or shares its key or family. Free: open, and its
  // family claimed by no other gloss's return.
  const open = (candidate: Candidate) =>
    !taken.has(candidate.pick.glossId) &&
    !keys.has(candidate.key) &&
    (candidate.family === undefined || !pickedFamilies.has(candidate.family));
  const free = (candidate: Candidate) =>
    open(candidate) && (candidate.family === undefined || (claims.get(candidate.family) ?? candidate.pick.glossId) === candidate.pick.glossId);

  // Per pool: its picks over every pass, the new words it introduced, and the groups it
  // held when it first ran.
  const chosen: ChosenPick[][] = pools.map(() => []);
  const introducedBy = pools.map(() => 0);
  const groupsAtFirst: number[] = [];

  /** One run of a pool over its words still open, for up to `slots` more slots: steps 1–8,
   *  and step 9 for a target's pool; step 9 alone (`done`, the main path's); or step 10 alone
   *  (`pastTheCap`). Returns the slots it used (phase 54, spec D4). */
  const run = (index: number, slots: number, part: 'steps' | 'done' | 'pastTheCap'): number => {
    const pool = pools[index];
    // This pool's words, less those a pick so far shut out.
    const mine = (candidate: Candidate) =>
      (pool.glossIds === null ? !listed.has(candidate.pick.glossId) : pool.glossIds.has(candidate.pick.glossId)) && open(candidate);
    const returns = allReturns.filter(mine);
    const due = allDue.filter(mine);
    const fresh = allFresh.filter(mine);
    const expand = allExpand.filter(mine);
    const notDue = allNotDue.filter(mine);
    const done = allDone.filter(mine);

    // D3. The new-word reserve comes first and gives way to a backlog, down to NEW_FLOOR.
    // Phase 39 (spec D5): the picks are bounded by the groups joined by either mark, a key or
    // a family (union-find), so a list of a few large families promises no more picks than it
    // can give. Phase 53 (ruling R-D6): the groups a pool held when it first ran bound its
    // picks over every pass, so a lone pool's later passes add nothing today's steps did not.
    // Ruling R-D7: a pool may introduce what its pace still owes past the daily cap, and every
    // pool's new words count toward that cap.
    // Phase 54 (spec D4). Two bounds where there was one: the slots the picks take may not
    // pass `slots` (a ladder takes LADDER_SLOTS, any other pick one), and the picks may not
    // pass `pickCap`, the groups.
    const groups = groupCount(candidates.filter(mine));
    groupsAtFirst[index] ??= groups;
    const pickCap = Math.min(groups, groupsAtFirst[index] - chosen[index].length);
    const owedLeft = Math.max(0, pool.owedNew - introducedBy[index]);
    const newLeft = Math.max(owedLeft, DAY_NEW_CAP - (input.newToday + newCount));
    // Ruling R-D6: the session's speaking pick, while no run before has made it.
    const speak = input.speaking && Math.min(slots, pickCap) >= 2 ? Math.max(0, SPEAKING_PER_SESSION - spoken) : 0;
    const room = slots - speak - returns.length - due.length;
    // Phase 54 (spec D4). The ladders `spare` slots hold.
    const ladderRoom = (spare: number) => Math.floor(Math.max(0, spare) / LADDER_SLOTS);
    // Phase 53 (owed words first): the new words a pool's pace still owes are reserved ahead of
    // its returns and due words, up to the whole run, so a target meets its words before its last
    // day however much it has to review. The main path owes none: its reserve is today's.
    // Phase 54 (spec D4): the reserve counts ladders, the room left after the speaking pick,
    // the returns and the due words over LADDER_SLOTS, a pace the run's slots over LADDER_SLOTS,
    // and no more than the session's ceiling has left.
    const reserve = Math.min(
      fresh.length,
      newLeft,
      NEW_PER_SESSION - ladders,
      Math.max(Math.min(NEW_PER_SESSION, Math.max(NEW_FLOOR, ladderRoom(room))), Math.min(owedLeft, ladderRoom(slots))),
    );

    const picks: ChosenPick[] = [];
    // Phase 54 (spec D4). The slots this run's picks take.
    let used = 0;
    // New words this run introduced.
    let introduced = 0;
    // Held back by a cap: asked after everything but DONE (ruling 14).
    const deferred: Candidate[] = [];

    const cost = (pick: ChosenPick) => (pick.ladder ? LADDER_SLOTS : 1);
    // Phase 54 (spec D4). A pick fits while its slots are free and the groups allow one more;
    // a run is full once either bound is reached.
    const fits = (candidate: Candidate) => used + cost(candidate.pick) <= slots && picks.length < pickCap;
    const full = () => used >= slots || picks.length >= pickCap;

    const add = (candidate: Candidate) => {
      if (candidate.family !== undefined) pickedFamilies.add(candidate.family);
      picks.push(candidate.pick);
      used += cost(candidate.pick);
      keys.add(candidate.key);
      taken.add(candidate.pick.glossId);
      perDimension.set(candidate.pick.dimension, (perDimension.get(candidate.pick.dimension) ?? 0) + 1);
      if (isHard(candidate.pick)) hard++;
      if (candidate.pick.cls === 'NEW') {
        newCount++;
        introduced++;
      }
      if (candidate.pick.ladder) ladders++;
    };
    // The dimension cap holds expansions only: a newly live dimension cannot flood
    // a session, and nothing better known is asked ahead of a due word for it.
    const offer = (candidate: Candidate, dimensionCap: boolean) => {
      if (full() || !free(candidate) || !fits(candidate)) return;
      const capped =
        (dimensionCap && (perDimension.get(candidate.pick.dimension) ?? 0) >= PER_DIMENSION_CAP) ||
        (isHard(candidate.pick) && hard >= HARD_CAP);
      if (capped) deferred.push(candidate);
      else add(candidate);
    };
    let nextFresh = 0;
    // Phase 54 (spec D4). A ladder joins only while LADDER_SLOTS slots are free and the
    // session's ceiling allows one more; a new word passed over for either is not offered
    // again in this run, and the run goes on with the rest.
    const offerFresh = (limit: number) => {
      while (nextFresh < fresh.length && introduced < limit && !full()) {
        const candidate = fresh[nextFresh++];
        if (free(candidate) && fits(candidate) && !(candidate.pick.ladder && ladders >= NEW_PER_SESSION)) add(candidate);
      }
    };
    const fill = (from: readonly Candidate[]) => {
      for (const candidate of from) {
        if (full()) break;
        if (free(candidate) && fits(candidate)) add(candidate);
      }
    };

    if (part === 'steps') {
      // 1. New words, up to the reserve.
      offerFresh(reserve);
      // 2. D4, the speaking pick: a return in SK, then a word due in SK, then a word not
      //    due with no SK memory, least known first, then a word done today with none,
      //    whose speaking is practice it has not had, then a due word with none, best
      //    known first so the most urgent reviews keep their place. A pool with none of
      //    these (a target's words never met) passes the pick on.
      const silent = (candidate: Candidate) => !candidate.rows?.has(SPEAKING);
      const tiers: [Candidate[], boolean][] = [
        [returns.filter((candidate) => candidate.pick.dimension === SPEAKING), false],
        [due.filter((candidate) => candidate.pick.dimension === SPEAKING), false],
        [[...expand, ...notDue].sort(byNeed).filter(silent), true],
        [done.filter((candidate) => candidate.rows !== undefined && silent(candidate)), true],
        [due.filter(silent).sort((a, b) => byNeed(b, a)), true],
      ];
      for (let tries = 0; tries < speak && !full(); tries++) {
        for (const [tier, moved] of tiers) {
          const candidate = tier.find(free);
          if (!candidate) continue;
          add(moved ? { ...candidate, pick: pickOf(candidate.pick.glossId, SPEAKING, 'SPEAK', candidate.rows) } : candidate);
          spoken++;
          break;
        }
      }
      // 3–7. Returns, due words, expansions, new words to the daily cap, words not due.
      for (const candidate of returns) offer(candidate, false);
      for (const candidate of due) offer(candidate, false);
      for (const candidate of expand) offer(candidate, true);
      offerFresh(newLeft);
      for (const candidate of notDue) offer(candidate, false);
      // 8. What a cap held back: before any word answered today.
      fill(deferred);
      // 9. Words answered today: only when nothing else is left. A target's pool fills its
      //    own slots with its own before passing any on (spec D5, target only until ready).
      if (pool.glossIds !== null) fill(done);
    } else if (part === 'done') {
      // 9. The main path's words answered today: only when no pool has another word (phase 37 D3).
      fill(done);
    } else {
      // 10. Ruling 15, now for an empty session only: new words past the daily cap.
      offerFresh(Infinity);
    }

    chosen[index].push(...picks);
    introducedBy[index] += introduced;
    return used;
  };

  // Phase 53 (rulings R-D6, R-D7). The passes, each over the pools in order.
  //
  // One pool, chooseWords' main path, chooses exactly as before. Its first pass is the old
  // steps 1–8; its second adds nothing; its third is the old step 9 and ruling 15 the old
  // step 10, at the capacity the first left: the slots unused and the groups less the picks.
  // The second adds nothing because:
  //  - picks only make a run stricter: a gloss, key or family taken stays taken and claims
  //    never change, so a word not free when steps 2–8 offered it is not free later;
  //  - a pool the daily cap stopped has introduced its newLeft, so its next newLeft is 0;
  //  - phase 54 (spec D4): a ladder that did not fit the slots left does not fit them later,
  //    and the session's ladders only grow toward the ceiling;
  //  - a pick shuts out only words of its own group (they share its key or family), so the
  //    groups still open never fall below groupsAtFirst − picks: that bound is what binds.
  // A pool's lists filter by `open`, not `free` (ruling 1): a word whose family another
  // gloss's return claimed still counts in the groups, room and the reserve, as it always
  // has; the claim applies only when a word is picked.
  //
  // Phase 54 (spec D4): what passes from run to run is slots, which a ladder takes three of.
  // The first pass: each pool aims for its slots and what the pools before it left unused.
  let unused = 0;
  pools.forEach((pool, index) => {
    unused += pool.slots - run(index, pool.slots + unused, 'steps');
  });
  // Each later pass offers the slots still unused to the pools, each as many as remain.
  const pass = (part: 'steps' | 'done' | 'pastTheCap', only: (pool: Pool) => boolean = () => true) =>
    pools.forEach((pool, index) => {
      if (unused > 0 && only(pool)) unused -= run(index, unused, part);
    });
  // The second: steps 1–8 again (and a target's words answered today), so a learner whose
  // saved words are all one ready target still gets a full session.
  pass('steps');
  // The third: the main path's words answered today, once no pool has another word.
  pass('done', (pool) => pool.glossIds === null);
  // Ruling 15: a session still empty goes past the daily cap, the pools in order.
  if (taken.size === 0) pass('pastTheCap');
  return chosen;
}
