import {
  MIN_LEVEL,
  SESSION_LENGTH,
  dimensionsTested,
  normaliseGloss,
  type Dimension,
  type QuestionType,
} from '@lang-tutor/core/domain';

import { ORDER, type ChosenPick } from './choose';
import { LADDER_SLOTS, NEW_PER_SESSION, TARGET_POINTS_HALVES, TARGET_SPEAKING_PER_SESSION } from './chooseConstants';
import { RUNGS } from './plan';
import type { TargetDay, WordDay } from './targetDay';
import { isRecallCard } from './targetSkills';

/**
 * Phase 57 (spec D7, D10). What a target's own session asks, from its day (Task 2's plan and
 * work today) and nothing else: target skills, never FSRS. While work is owed: the words to
 * start, then the skills below today's cap, the word furthest below first, then the next-day
 * checks, so every card serves owed work (anti-goal 1). Once the day is done, practice more; on
 * the due date, the last review. Pure (ADR 0001): no clock, rng or I/O; every tie falls to a
 * fixed order.
 */

/** Spec D7, D10. `owed` asks only owed work; `more` is practice more on a done or rest day;
 *  `last_review` is the due date's. */
export type TargetMode = 'owed' | 'more' | 'last_review';

export type TargetPickInput = {
  day: TargetDay;
  mode: TargetMode;
  /** `${glossId}|${dimension}` → the skill's main-path level, for the job's card choice. */
  levels: ReadonlyMap<string, number>;
  /** Spec D6. Glosses with main-path memory: they start with a recall card, no ladder. */
  known: ReadonlySet<string>;
  /** Phase 60 (spec D1, "targets too"). glossFamilies' current meaning of every family with a
   *  known one: a new meaning of a known word, which starts with its new_meaning card, one
   *  slot, never a ladder. Once practised it is in `known`. */
  newMeanings: ReadonlySet<string>;
  /** Gloss → its key: a session asks one gloss per key (phase 31 D18), as chooseWords does. */
  keys: ReadonlyMap<string, string>;
  /** The cards of the path's session in flight, credited as answered right before choosing, so a
   *  stock built mid-session asks the next skill. A ladder's intro-stage cards grade nothing
   *  (phase 55): the caller leaves them out. */
  inFlight: readonly { glossId: string; type: QuestionType }[];
  /** Spec D8, ruling T3-n. New words the day still has room for (DAY_NEW_CAP less today's new
   *  words): the ladders practice more starts early, never an owed start. Absent: no limit. */
  newRoom?: number;
};

/** Spec D7, D10. A day with work owed asks it; the due date gives the last review; a done or
 *  rest day, practice more. */
export function targetMode(day: TargetDay): TargetMode {
  if (day.state === 'owed') return 'owed';
  if (day.state === 'due_today') return 'last_review';
  return 'more';
}

/** Phase 57 (spec D2). The words a stock chosen in `mode` serves as owed work, sorted: the
 *  day's owed words, or none for practice more. With the cap, what a target path's stale
 *  check compares. */
export function owedWords(day: TargetDay, mode: TargetMode): string[] {
  if (mode === 'more') return [];
  return day.words
    .filter((word) => word.state === 'owed')
    .map((word) => word.glossId)
    .sort();
}

/** What a target path's stock recorded of its day (session_targets), as its stale check reads it. */
export type StockChoice = { capHalves: number; owedGlossIds: readonly string[] };

/**
 * Phase 53 (ruling R-D12), per path since phase 57 (spec D2, final review C1). Whether a target
 * path's stock is checked against today's choice before it is played: one chosen on an earlier
 * learner day, and one chosen as practice more (it records no owed word) on any day. A practice
 * more stock is chosen beside the session in flight when that session's credit covers every
 * owed word (ruling T3-m); a miss there leaves work owed that practice more does not serve
 * (anti-goal 1). A stock chosen today for owed work still serves it: the session it was chosen
 * beside was credited as all right, and a miss only adds work. While the covering session is in
 * flight its credit applies again, so the check finds the same choice and keeps the stock.
 */
export function stockToCheck(stock: { chosenOn: string } & Pick<StockChoice, 'owedGlossIds'>, today: string): boolean {
  return stock.chosenOn < today || stock.owedGlossIds.length === 0;
}

/** Phase 53 (ruling R-D12), phase 57 (spec D2). A checked stock is played as it is when today's
 *  choice has the cap and the owed words it recorded; one that recorded nothing is replaced. */
export function stockServes(recorded: StockChoice | undefined, today: StockChoice): boolean {
  return (
    recorded !== undefined &&
    recorded.capHalves === today.capHalves &&
    recorded.owedGlossIds.join(' ') === today.owedGlossIds.join(' ')
  );
}

const SPEAKING: Dimension = 'spoken_productive';

/** Spec D7. The productive skills the hardest cards ask. */
const HARD: readonly Dimension[] = ['written_productive', 'spelling', SPEAKING];

/** Spec D7 (my call there). A word takes this many picks a session at most, each for a
 *  different skill. */
const PICKS_PER_WORD = 2;

/** The card a skill is asked at a rung as the picker reads it: the rung's first type in RUNGS
 *  (typed translation for written productive and spelling at rung 2, dictation for listening,
 *  say translation for speaking). The prepare job may choose another type of the rung; only the
 *  tie-breaks and the skills a pick serves read this one, and (phase 65, spec D7.1) the budget's
 *  play-forward, which answers it. */
export const cardOf = (dimension: Dimension, rung: 1 | 2): QuestionType => RUNGS[dimension][rung - 1][0];

type Word = {
  glossId: string;
  /** Its place in the plan: the last tie-break. */
  index: number;
  key: string;
  state: WordDay['state'];
  /** Owed a start: neither asked by the target before nor in the session in flight. */
  toStart: boolean;
  inFlight: boolean;
  /** Its live skills' values, in half-points, with the in-flight credit. */
  halves: Map<Dimension, number>;
  /** Next-day checks no card in flight answers. */
  checks: Dimension[];
  /** This session's picks' skills, and the skills their cards move. */
  picked: Dimension[];
  moved: Set<Dimension>;
};

const byId = (a: Word, b: Word) => (a.glossId < b.glossId ? -1 : a.glossId > b.glossId ? 1 : 0);

/**
 * Spec D7, D10, rulings T3-a and T3-b. A target session's picks, in the order they were chosen:
 * starts, then each word's first below-cap pick, then the second ones (so a word's two cards sit
 * apart), then the checks, then the hardest cards. A pick is `TARGET` with `r: 1`, so the job's
 * card choice reads the rung (a written receptive pick with no R would be multiple choice); a
 * ladder is `NEW` with `r: null`, as chooseWords makes one, and so is a family's new meaning,
 * with no ladder (phase 60), which the caller gives its known meanings. At most SESSION_LENGTH
 * slots, a ladder LADDER_SLOTS of them; a target with fewer picks makes a shorter session.
 */
export function chooseTargetPicks(input: TargetPickInput): ChosenPick[] {
  const { day, mode } = input;
  const cap = day.capHalves;

  // Spec D4's tally of the session in flight: per word and skill, recall when any recall card
  // tested it, else recognition. One change per skill per session, as applyTargetSession.
  const flown = new Map<string, Map<Dimension, boolean>>();
  for (const card of input.inFlight) {
    const tested = flown.get(card.glossId) ?? new Map<Dimension, boolean>();
    for (const dimension of dimensionsTested(card.type)) {
      tested.set(dimension, tested.get(dimension) === true || isRecallCard(card.type));
    }
    flown.set(card.glossId, tested);
  }

  const words: Word[] = day.words.map((word, index) => {
    const tested = flown.get(word.glossId);
    const halves = new Map(word.skills.map((skill) => [skill.dimension, skill.halves]));
    for (const [dimension, recall] of tested ?? []) {
      const before = halves.get(dimension);
      // A skill not live for the word gets no credit.
      if (before === undefined) continue;
      const after = Math.min(before + TARGET_POINTS_HALVES[recall ? 'recall' : 'recognition'], cap);
      halves.set(dimension, Math.max(before, after));
    }
    const key = input.keys.get(word.glossId);
    return {
      glossId: word.glossId,
      index,
      key: key === undefined ? `\u0000${word.glossId}` : normaliseGloss(key),
      // The session in flight started a word it asks; one it started early is extra.
      state: tested !== undefined && word.state === 'later' ? 'extra' : word.state,
      toStart: word.toStart && tested === undefined,
      inFlight: tested !== undefined,
      halves,
      checks: word.checks.filter((dimension) => !tested?.has(dimension)),
      picked: [],
      moved: new Set(),
    };
  });

  const picks: ChosenPick[] = [];
  /** Key → the gloss holding it this session. */
  const keys = new Map<string, string>();
  let slots = 0;
  let ladders = 0;
  let spoken = 0;
  let newRoom = input.newRoom ?? Number.POSITIVE_INFINITY;

  const levelOf = (glossId: string, dimension: Dimension) => input.levels.get(`${glossId}|${dimension}`) ?? MIN_LEVEL;
  const open = (word: Word, cost: number) =>
    slots + cost <= SESSION_LENGTH &&
    word.picked.length < PICKS_PER_WORD &&
    (keys.get(word.key) ?? word.glossId) === word.glossId;

  /** `start`: a new word's ladder, or a family's new meaning (phase 60), both `NEW` with no R;
   *  absent, a `TARGET` card at `rung`. */
  const add = (word: Word, dimension: Dimension, rung: 1 | 2, start?: 'ladder' | 'meaning') => {
    const level = levelOf(word.glossId, dimension);
    picks.push(
      start
        ? { glossId: word.glossId, dimension, rung: 1, level, r: null, cls: 'NEW', ladder: start === 'ladder' }
        : { glossId: word.glossId, dimension, rung, level, r: 1, cls: 'TARGET', ladder: false },
    );
    slots += start === 'ladder' ? LADDER_SLOTS : 1;
    keys.set(word.key, word.glossId);
    word.picked.push(dimension);
    const moves =
      start === 'ladder' ? word.halves.keys() : dimensionsTested(start === 'meaning' ? 'new_meaning' : cardOf(dimension, rung));
    for (const moved of moves) word.moved.add(moved);
    if (start === 'ladder') ladders++;
    if (dimension === SPEAKING) spoken++;
  };

  /** Spec D7. Of `from`, the skill to ask: the fewest halves (furthest below the cap), then the
   *  one whose recall card moves the most of `still`, then ORDER. Speaking only while the session
   *  has room for it; never a skill the word was already asked this session. */
  const skillOf = (word: Word, from: readonly Dimension[], still: readonly Dimension[]): Dimension | undefined => {
    const moves = (dimension: Dimension) => dimensionsTested(cardOf(dimension, 2)).filter((d) => still.includes(d)).length;
    return from
      .filter((d) => (d !== SPEAKING || spoken < TARGET_SPEAKING_PER_SESSION) && !word.picked.includes(d))
      .sort((a, b) => word.halves.get(a)! - word.halves.get(b)! || moves(b) - moves(a) || ORDER.indexOf(a) - ORDER.indexOf(b))[0];
  };

  /** Live skills below the cap that no card of this session moves yet. */
  const belowCap = (word: Word) => [...word.halves].filter(([d, halves]) => halves < cap && !word.moved.has(d)).map(([d]) => d);
  const shortfall = (word: Word) => [...word.halves.values()].reduce((sum, halves) => sum + Math.max(0, cap - halves), 0);
  /** Spec D7: the word furthest below the cap first, then the plan's order. */
  const furthest = (pool: readonly Word[]) => [...pool].sort((a, b) => shortfall(b) - shortfall(a) || a.index - b.index);

  /** Spec D6, D7 step 1, ruling T3-a. In the plan's order: a new word's ladder, NEW_PER_SESSION
   *  a session at most; a known word's one recall card on its skill furthest below the cap.
   *  Phase 60 (spec D1): a family's new meaning, its one new_meaning card, no ladder.
   *  Ruling T3-n: an early start (`early`) is a new word of the day's only while it has room. */
  const start = (pool: readonly Word[], early: boolean) => {
    for (const word of pool) {
      if (input.known.has(word.glossId)) {
        if (!open(word, 1)) continue;
        const all = [...word.halves].filter(([, halves]) => halves < cap).map(([d]) => d);
        const dimension = skillOf(word, all, all);
        if (dimension) add(word, dimension, 2);
      } else if (input.newMeanings.has(word.glossId)) {
        if ((early && newRoom <= 0) || !open(word, 1)) continue;
        add(word, 'written_receptive', 1, 'meaning');
        if (early) newRoom -= 1;
      } else if (ladders < NEW_PER_SESSION && (!early || newRoom > 0) && open(word, LADDER_SLOTS)) {
        add(word, 'written_receptive', 1, 'ladder');
        if (early) newRoom -= 1;
      }
    }
  };

  /** Spec D7 step 2. Started words with skills below the cap, in two rounds: every word's first
   *  pick before any word's second, which serves a skill the first card does not move. Rung 1
   *  for a skill at 0, else 2; speaking always 2 (read aloud writes nothing). */
  const belowCapWork = (pool: readonly Word[]) => {
    const order = furthest(pool.filter((word) => !word.toStart));
    for (let round = 0; round < PICKS_PER_WORD; round++) {
      for (const word of order) {
        if (word.picked.length !== round || !open(word, 1)) continue;
        const owed = belowCap(word);
        const dimension = skillOf(word, owed, owed);
        if (dimension) add(word, dimension, dimension === SPEAKING || word.halves.get(dimension)! > 0 ? 2 : 1);
      }
    }
  };

  /** Spec D5. The next-day checks, after all below-cap work, at rung 2: while a word has a pick
   *  left, the check skill whose recall card answers the most checks still open. */
  const checkWork = (pool: readonly Word[]) => {
    for (const word of furthest(pool.filter((w) => w.checks.length > 0))) {
      while (open(word, 1)) {
        const left = word.checks.filter((d) => !word.moved.has(d));
        const dimension = skillOf(word, left, left);
        if (!dimension) break;
        add(word, dimension, 2);
      }
    }
  };

  /** Spec D7 step 3, ruling T3-b. One rung-2 card per planned word not yet asked this session, in
   *  its hard skill with the fewest halves: the word with the fewest halves over its hard skills
   *  first, a word the session in flight asks last, then by gloss id. */
  const hardest = (pool: readonly Word[]) => {
    const hardHalves = (word: Word) => HARD.reduce((sum, d) => sum + (word.halves.get(d) ?? 0), 0);
    const order = pool
      .filter((word) => !word.toStart && word.picked.length === 0 && (word.state === 'done' || word.state === 'owed'))
      .sort((a, b) => Number(a.inFlight) - Number(b.inFlight) || hardHalves(a) - hardHalves(b) || byId(a, b));
    for (const word of order) {
      if (!open(word, 1)) continue;
      const hard = HARD.filter((d) => word.halves.has(d));
      const dimension = skillOf(word, hard, hard);
      if (dimension) add(word, dimension, 2);
    }
  };

  if (mode === 'more') {
    // Spec D7 step 3: today's extra words up to the cap, then the next planned words started
    // early as extra, then the hardest cards.
    belowCapWork(words.filter((word) => word.state === 'extra'));
    start(
      words.filter((word) => word.state === 'later'),
      true,
    );
    hardest(words);
  } else {
    // Spec D7 steps 1–2 and D5's checks; on the due date (D10) the cap is 20, so this asks the
    // skills below 20, furthest first, and then the hardest cards fill what is left.
    const owed = words.filter((word) => word.state === 'owed');
    start(
      owed.filter((word) => word.toStart),
      false,
    );
    belowCapWork(owed);
    checkWork(owed);
    if (mode === 'last_review') hardest(words);
  }
  return picks;
}
