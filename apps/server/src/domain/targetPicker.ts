import {
  MIN_LEVEL,
  SESSION_LENGTH,
  normaliseGloss,
  type Dimension,
  type QuestionType,
} from '@lang-tutor/core/domain';

import type { ChosenPick } from './choose';
import { LADDER_SLOTS, NEW_PER_SESSION } from './chooseConstants';
import { RUNGS } from './plan';
import { servedSkill, type TargetDay, type WordDay } from './targetDay';

/**
 * Phase 57 (spec D7, D10), phase 67 (spec D6). What a target's own session asks, from its day
 * and nothing else: while work is owed, the words to meet, then each owed word's cards of the
 * day, so every card serves owed work (anti-goal 1). Once the day is done, practice more; on the
 * due date, the last review. Pure (ADR 0001): no clock, rng or I/O; every tie falls to a fixed
 * order.
 */

/** Spec D7, D10. `owed` asks only owed work; `more` is practice more on a done or rest day;
 *  `last_review` is the due date's. Phase 65b (spec D2): `past_budget`, once the day's budget is
 *  met, asks the owed work first and then fills the session with practice more. */
export type TargetMode = 'owed' | 'more' | 'last_review' | 'past_budget';

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

/** What a target path's stock recorded of its day (session_targets), as its stale check reads it;
 *  `pastBudget`, whether it was chosen past the day's budget (phase 65b). */
export type StockChoice = { capHalves: number; owedGlossIds: readonly string[]; pastBudget?: boolean };

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
 *  choice has the cap and the owed words it recorded; one that recorded nothing is replaced.
 *  Phase 67 (final review 2): one chosen past the budget never is. Checked, it was chosen on an
 *  earlier day (it records the owed words), and holds that day's practice more, not today's cards. */
export function stockServes(recorded: StockChoice | undefined, today: StockChoice): boolean {
  return (
    recorded !== undefined &&
    recorded.pastBudget !== true &&
    recorded.capHalves === today.capHalves &&
    recorded.owedGlossIds.join(' ') === today.owedGlossIds.join(' ')
  );
}

/** Spec D7 (my call there). A word takes this many picks a session at most, each for a
 *  different skill. */
const PICKS_PER_WORD = 2;

/** The card a skill is asked at a rung as the picker reads it: the rung's first type in RUNGS
 *  (typed translation for written productive at rung 2, dictation for spelling at rung 1, say
 *  translation for speaking). The prepare job may choose another type of the rung; the budget's
 *  play-forward (phase 65, spec D7.1) answers this one. */
export const cardOf = (dimension: Dimension, rung: 1 | 2): QuestionType => RUNGS[dimension][rung - 1][0];

/** Phase 67 (spec D2). The rung a practised skill is asked at: writing recalled (translate, gap or
 *  sentence), spelling as a dictation (typed when the device cannot listen, planCards' fallback),
 *  speaking said. */
const rungOf = (dimension: Dimension): 1 | 2 => (dimension === 'spelling' ? 1 : 2);

type Word = {
  glossId: string;
  /** Its place in the plan: the last tie-break. */
  index: number;
  key: string;
  state: WordDay['state'];
  /** To meet: in today's quota, neither met before nor in the session in flight. */
  toStart: boolean;
  inFlight: boolean;
  readinessPct: number;
  /** Its practised skills, the weakest at the start of today first. */
  weakest: Dimension[];
  /** The skills its cards still ask today, with the in-flight credit, the first asked first. */
  owed: Dimension[];
  /** Its practised skills not asked today, with the in-flight credit, in the order D2 picks from. */
  open: Dimension[];
  /** This session's picks' skills. */
  picked: Dimension[];
};

const byId = (a: Word, b: Word) => (a.glossId < b.glossId ? -1 : a.glossId > b.glossId ? 1 : 0);

/**
 * Phase 57 (spec D7, D10), phase 67 (spec D6). A target session's picks, in the order they were
 * chosen: the words to meet, then each owed word's first card, then its second (so a word's two
 * cards sit apart), the word with the lowest readiness at the start of today first. A pick is
 * `TARGET` with `r: 1`, so the job's card choice reads the rung; a ladder is `NEW` with `r: null`,
 * as chooseWords makes one, and so is a family's new meaning, with no ladder (phase 60). At most
 * SESSION_LENGTH slots, a ladder LADDER_SLOTS of them; a target with fewer picks makes a shorter
 * session. No limit on speaking cards (spec D6): planCards keeps a type from following itself.
 */
export function chooseTargetPicks(input: TargetPickInput): ChosenPick[] {
  const { day, mode } = input;

  // Spec D2. The session in flight's cards count as asked today: per word, the practised skills
  // they ask. A word in flight is not met again.
  const flown = new Map<string, Set<Dimension>>();
  for (const card of input.inFlight) {
    const asked = flown.get(card.glossId) ?? new Set<Dimension>();
    const skill = servedSkill(card.type);
    if (skill !== null) asked.add(skill);
    flown.set(card.glossId, asked);
  }

  const words: Word[] = day.words.map((word, index) => {
    const asked = flown.get(word.glossId);
    const practised = new Set(word.practised.map((skill) => skill.dimension));
    const credited = [...(asked ?? [])].filter((skill) => practised.has(skill) && word.open.includes(skill)).length;
    const open = word.open.filter((skill) => !asked?.has(skill));
    const weakest = [...word.practised]
      .sort((a, b) => a.chance - b.chance || word.practised.indexOf(a) - word.practised.indexOf(b))
      .map((skill) => skill.dimension);
    const key = input.keys.get(word.glossId);
    return {
      glossId: word.glossId,
      index,
      key: key === undefined ? `\u0000${word.glossId}` : normaliseGloss(key),
      // The session in flight started a word it asks; one it started early is extra.
      state: asked !== undefined && word.state === 'later' ? 'extra' : word.state,
      toStart: word.toStart && asked === undefined,
      inFlight: asked !== undefined,
      readinessPct: word.readinessPct,
      weakest,
      open,
      owed: open.slice(0, Math.max(0, word.cardsLeft - credited)),
      picked: [],
    };
  });

  const picks: ChosenPick[] = [];
  /** Key → the gloss holding it this session. */
  const keys = new Map<string, string>();
  let slots = 0;
  let ladders = 0;
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
    // Spec D2: a ladder asks writing; any other card its own skill.
    const asked = start === 'ladder' ? 'written_productive' : start === 'meaning' ? null : dimension;
    if (asked !== null && word.owed.includes(asked)) word.owed = word.owed.filter((skill) => skill !== asked);
    else if (asked !== null && start === 'ladder') word.owed = word.owed.slice(1);
  };

  /** Spec D3, D6, ruling T3-a. In the plan's order: a new word's ladder, NEW_PER_SESSION a
   *  session at most; a known word's recall card on its first owed skill (its weakest when it
   *  owes none, started early); a family's new meaning, its one new_meaning card (phase 60).
   *  Ruling T3-n: an early start (`early`) is a new word only while the day has room. */
  const start = (pool: readonly Word[], early: boolean) => {
    for (const word of pool) {
      if (input.known.has(word.glossId)) {
        if (!open(word, 1)) continue;
        const dimension = word.owed[0] ?? word.weakest[0];
        if (dimension) add(word, dimension, rungOf(dimension));
      } else if (input.newMeanings.has(word.glossId)) {
        if ((early && newRoom <= 0) || !open(word, 1)) continue;
        add(word, 'written_receptive', 1, 'meaning');
        if (early) newRoom -= 1;
      } else if (ladders < NEW_PER_SESSION && (!early || newRoom > 0) && open(word, LADDER_SLOTS)) {
        add(word, 'written_receptive', 1, 'ladder');
        ladders += 1;
        if (early) newRoom -= 1;
      }
    }
  };

  /** Spec D6. The owed words met before this session, in two rounds: every word's first card
   *  before any word's second, the lowest readiness first. A word met this session waits for
   *  the next for its other cards. */
  const owedWork = (pool: readonly Word[]) => {
    const order = pool
      .filter((word) => !word.toStart && word.picked.length === 0 && word.owed.length > 0)
      .sort((a, b) => a.readinessPct - b.readinessPct || a.index - b.index);
    for (let round = 0; round < PICKS_PER_WORD; round++) {
      for (const word of order) {
        if (word.picked.length !== round || !open(word, 1)) continue;
        const dimension = word.owed[0];
        if (dimension) add(word, dimension, rungOf(dimension));
      }
    }
  };

  /** Spec D6 (phase 57 D7 step 3, ruling T3-b, read from readiness). One card per met word not
   *  yet asked this session, on a skill not asked today, else its weakest: the lowest readiness first, a word
   *  the session in flight asks last, then by gloss id. A word met early today is asked too, but
   *  not while the session in flight is meeting it. */
  const hardest = (pool: readonly Word[]) => {
    const order = pool
      .filter((word) => !word.toStart && word.picked.length === 0 && (word.state === 'done' || word.state === 'owed' || (word.state === 'extra' && !word.inFlight)))
      .sort((a, b) => Number(a.inFlight) - Number(b.inFlight) || a.readinessPct - b.readinessPct || byId(a, b));
    for (const word of order) {
      if (!open(word, 1)) continue;
      // Final review 3: a skill not asked today first, so practice more varies its cards.
      const dimension = word.open[0] ?? word.weakest[0];
      if (dimension) add(word, dimension, rungOf(dimension));
    }
  };

  /** Spec D6 (phase 57 D7 step 3): the next planned words started early as extra, then the
   *  hardest cards. */
  const practiceMore = () => {
    start(
      words.filter((word) => word.state === 'later'),
      true,
    );
    hardest(words);
  };

  if (mode === 'more') {
    practiceMore();
  } else if (mode === 'last_review') {
    // Spec D2: the due date owes nothing; its session meets a word never met, then asks every
    // word one card on its weakest skill.
    start(
      words.filter((word) => word.state === 'later'),
      false,
    );
    hardest(words);
  } else {
    const owed = words.filter((word) => word.state === 'owed');
    start(
      owed.filter((word) => word.toStart),
      false,
    );
    owedWork(owed);
    // Phase 65b (spec D2): past the budget, the rest of the session is practice more.
    if (mode === 'past_budget') practiceMore();
  }
  return picks;
}
