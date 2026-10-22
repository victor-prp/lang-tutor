import {
  MIN_LEVEL,
  SESSION_LENGTH,
  normaliseGloss,
  type Dimension,
  type QuestionType,
} from '@lang-tutor/core/domain';

import { countNew, type ChosenPick } from './choose';
import { LADDER_SLOTS, NEW_PER_SESSION, STEP_DOWNS_PER_SESSION } from './chooseConstants';
import { MAX_PER_TYPE, RUNGS } from './plan';
import { rungOf, type StepDown } from './stepDown';
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
  /** Phase 67b (spec D5). Each word's readiness now, not at the start of today: its card value and
   *  its counted skills, the lowest chance now first (targetSummary pickNow). Absent, practice
   *  more reads the start of today. */
  now?: ReadonlyMap<string, { pct: number; counted: readonly Dimension[]; weakestOpen?: boolean }>;
  /** Phase 68 (spec D1, D3). The path's open step-downs, oldest miss first (openStepDowns), with
   *  the session in flight credited. Absent: none. */
  stepDowns?: readonly StepDown[];
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
 *  `pastBudget`, whether it was chosen past the day's budget (phase 65b); `stepDowns`, the
 *  step-downs it asks, `glossId|dimension`, sorted (phase 68; absent: none), which the stale check
 *  does not read (ruling 2026-10-22). */
export type StockChoice = { capHalves: number; owedGlossIds: readonly string[]; pastBudget?: boolean; stepDowns?: readonly string[] };

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
 *  earlier day (it records the owed words), and holds that day's practice more, not today's cards.
 *  Phase 68 (spec D6, ruling 2026-10-22): its step-downs are not compared. One it lacks is asked by
 *  the stock chosen when it starts; replacing it made the learner wait for a new preparation. */
export function stockServes(recorded: StockChoice | undefined, today: StockChoice): boolean {
  return (
    recorded !== undefined &&
    recorded.pastBudget !== true &&
    recorded.capHalves === today.capHalves &&
    recorded.owedGlossIds.join(' ') === today.owedGlossIds.join(' ')
  );
}

/** Phase 68 (spec D6). The step-downs a session's picks ask, as session_targets records them. */
export const stepDownKeys = (picks: readonly ChosenPick[]): string[] =>
  picks
    .filter((pick) => pick.relearn)
    .map((pick) => `${pick.glossId}|${pick.dimension}`)
    .sort();

/** Phase 68 (spec D5, ruling). Whether a target session gets a matching board: none of its picks can
 *  raise the card today (raisesCard; a meeting raises it), and on the due date none can. */
export function boardsSession(picks: readonly ChosenPick[], input: { daysLeft: number; now: TargetPickInput['now'] }): boolean {
  const judged = { daysLeft: input.daysLeft, now: input.daysLeft > 0 ? input.now : new Map() };
  // A practice step-down counts nothing, so it raises nothing.
  return !raisesCard(
    picks
      .filter((pick) => pick.relearn !== 'practice')
      .map((pick) => ({ glossId: pick.glossId, dimension: pick.dimension, meets: pick.cls === 'NEW' })),
    judged,
  );
}

/** Phase 67b fix (Victor's test, 2026-10-21). A card a session asks, as raisesCard reads it: the
 *  word, the skill it asks (none for a read aloud), and whether it meets the word. */
export type AskedCard = { glossId: string; dimension: Dimension | null; meets: boolean };

/** A session's cards as AskedCards: a meet card or a new meaning meets its word; any other card
 *  asks the skill its type serves. */
export function picksOfCards(cards: readonly { glossId: string; type: QuestionType; intro: boolean }[]): AskedCard[] {
  return cards.map((card) =>
    card.type === 'meet' || card.type === 'new_meaning'
      ? { glossId: card.glossId, dimension: null, meets: true }
      : { glossId: card.glossId, dimension: servedSkill(card.type), meets: false },
  );
}

/**
 * Phase 67b fix (Victor's test, 2026-10-21). Whether a session's cards can raise the card today: one
 * meets a word, or one asks a word below its bar its weakest skill now, on the eve or, before it,
 * while that skill has had no answer today (spec D1, D3). Without readiness now nothing can be
 * judged, so it can. A practice-more stock is chosen beside the session in flight, which can be
 * meeting the one word that, once met, is the only card left to raise the card (the picker never
 * asks a word in flight): such a stock is replaced when it is served.
 */
export function raisesCard(cards: readonly AskedCard[], input: { daysLeft: number; now: TargetPickInput['now'] }): boolean {
  const { now, daysLeft } = input;
  if (!now) return true;
  return cards.some((card) => {
    if (card.meets) return true;
    const word = now.get(card.glossId);
    if (!word || card.dimension === null || word.pct >= 100 || card.dimension !== word.counted[0]) return false;
    return daysLeft === 1 || word.weakestOpen !== false;
  });
}

/** Spec D7 (my call there). A word takes this many picks a session at most, each for a
 *  different skill. */
const PICKS_PER_WORD = 2;

/** Phase 68 (spec D4). The cards the picker knows the type of, one type at their rung: the say
 *  translation, the dictation and the read aloud. MAX_PER_TYPE holds them; writing's recall rung
 *  has three types, which planCards spreads under the same cap. */
const ONE_TYPE: ReadonlySet<QuestionType> = new Set(['say_translation', 'dictation', 'read_aloud']);

/** The card a skill is asked at a rung as the picker reads it: the rung's first type in RUNGS
 *  (typed translation for written productive at rung 2, dictation for spelling at rung 1, say
 *  translation for speaking). The prepare job may choose another type of the rung; the budget's
 *  play-forward (phase 65, spec D7.1) answers this one. */
export const cardOf = (dimension: Dimension, rung: 1 | 2): QuestionType => RUNGS[dimension][rung - 1][0];

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
  /** Phase 68 (spec D4). This session's picks per ONE_TYPE card. */
  const perType = new Map<QuestionType, number>();
  const full = (dimension: Dimension, rung: 1 | 2 = rungOf(dimension)) => {
    const type = cardOf(dimension, rung);
    return ONE_TYPE.has(type) && (perType.get(type) ?? 0) >= MAX_PER_TYPE;
  };
  /** Phase 68 (spec D4, ruling). Whether a card on `dimension` can raise the card today
   *  (raisesCard): the cap never moves one. On the due date the card is frozen. */
  const judged = { daysLeft: day.daysLeft, now: day.daysLeft > 0 ? input.now : new Map() };
  const raises = (word: Word, dimension: Dimension) => raisesCard([{ glossId: word.glossId, dimension, meets: false }], judged);
  /** Whether an answer on `dimension` would count toward readiness today: before the eve only a
   *  skill's first answer of the day (one still open), on the eve every right, on the due date none. */
  const counts = (word: Word, dimension: Dimension) => day.daysLeft === 1 || (day.daysLeft > 1 && word.open.includes(dimension));
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
    if (!start) perType.set(cardOf(dimension, rung), (perType.get(cardOf(dimension, rung)) ?? 0) + 1);
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

  /** Phase 67b (spec D4). A word met by its ladder this session is asked its speaking in it too,
   *  as its second card of the day, wherever speaking is a practised skill of it. */
  const firstSay = () => {
    for (const word of words) {
      const laddered = picks.some((one) => one.glossId === word.glossId && one.ladder);
      if (laddered && word.picked.length === 1 && word.weakest.includes('spoken_productive') && open(word, 1)) {
        add(word, 'spoken_productive', rungOf('spoken_productive'));
      }
    }
  };

  /** Spec D6. The owed words met before this session, in two rounds: every word's first card
   *  before any word's second, the lowest readiness first. A word met this session waits for
   *  the next for its other cards. */
  const owedWork = (pool: readonly Word[]) => {
    // Phase 68 (spec D3): a word with a step-down takes its owed card as its second.
    const order = pool
      .filter((word) => !word.toStart && word.picked.length < PICKS_PER_WORD && word.owed.length > 0)
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
  const hardest = (pool: readonly Word[], belowBarOnly: boolean) => {
    // Phase 67b (spec D5): readiness now when the caller reads it, else at the start of today.
    const pctOf = (word: Word) => input.now?.get(word.glossId)?.pct ?? word.readinessPct;
    // Review C1: before the eve only a skill's first answer counts and only the weakest moves a
    // word, so the words whose weakest is still open today come first.
    const shut = (word: Word) => Number(day.daysLeft > 1 && input.now?.get(word.glossId)?.weakestOpen === false);
    const eligible = pool.filter(
      (word) => !word.toStart && word.picked.length === 0 && (word.state === 'done' || word.state === 'owed' || (word.state === 'extra' && !word.inFlight)),
    );
    // Phase 67b (spec D5): a word at its bar counts 100 on the card, so a right adds nothing to it and
    // a miss lowers it: while any word is below its bar, practice more asks only those. Not on the
    // due date, whose card is frozen (review I1).
    const below = input.now && belowBarOnly ? eligible.filter((word) => pctOf(word) < 100) : eligible;
    const order = (below.length > 0 ? below : eligible).sort(
      (a, b) => Number(a.inFlight) - Number(b.inFlight) || shut(a) - shut(b) || pctOf(a) - pctOf(b) || byId(a, b),
    );
    // Phase 67b (spec D5): the counted skill weakest now. Without it, final review 3: a skill not
    // asked today first, so practice more varies its cards.
    const skillsOf = (word: Word) => input.now?.get(word.glossId)?.counted ?? [...word.open, ...word.weakest];
    // Phase 68 (spec D4, rulings). MAX_PER_TYPE holds a session none of whose cards can raise the
    // card today: practice more on words whose weakest skill is answered, and the due date's review.
    const pure =
      !picks.some((one) => raisesCard([{ glossId: one.glossId, dimension: one.dimension, meets: one.cls === 'NEW' }], judged)) &&
      !order.some((word) => skillsOf(word).length > 0 && raises(word, skillsOf(word)[0]));
    for (const word of order) {
      if (!open(word, 1)) continue;
      const skills = skillsOf(word);
      const first = skills[0];
      if (first === undefined) continue;
      // Past MAX_PER_TYPE, a say card becomes a read aloud (the word seen and said, which grades
      // nothing), any other passes to the next skill in the same order whose card would count
      // nothing today either; with none, it keeps its card.
      if (!pure || !full(first)) add(word, first, rungOf(first));
      else if (first === 'spoken_productive' && !full(first, 1)) add(word, first, 1);
      else {
        const next = skills.find((skill) => !full(skill) && !counts(word, skill)) ?? first;
        add(word, next, rungOf(next));
      }
    }
  };

  /**
   * Phase 68 (spec D2, D3, final review). The open step-downs, oldest miss first, at most
   * STEP_DOWNS_PER_SESSION and one a word (two would see and pick it twice), each on a word of the
   * day and a skill it practises, once the session's own cards are chosen, which they leave as they
   * are. A card this session asks the word on that skill at its rung becomes the step-down's last,
   * after the easier ones, and counts as it would have (`counts`); with none, the step-down is asked
   * on top, outside the slots, as practice that counts nothing (`practice`).
   */
  const stepDowns = () => {
    const relearned = new Set<string>();
    for (const step of input.stepDowns ?? []) {
      if (relearned.size === STEP_DOWNS_PER_SESSION) break;
      const word = words.find((one) => one.glossId === step.glossId);
      if (!word || !word.weakest.includes(step.dimension) || relearned.has(word.glossId)) continue;
      const rung = rungOf(step.dimension);
      const own = picks.findIndex((one) => one.glossId === word.glossId && one.cls === 'TARGET' && one.dimension === step.dimension && one.rung === rung);
      if (own >= 0) picks[own] = { ...picks[own], relearn: 'counts' };
      else if ((keys.get(word.key) ?? word.glossId) !== word.glossId) continue;
      else {
        keys.set(word.key, word.glossId);
        picks.push({ glossId: word.glossId, dimension: step.dimension, rung, level: levelOf(word.glossId, step.dimension), r: 1, cls: 'TARGET', ladder: false, relearn: 'practice' });
      }
      relearned.add(word.glossId);
    }
  };

  /** Spec D6 (phase 57 D7 step 3): the next planned words started early as extra, then the
   *  hardest cards. */
  const practiceMore = () => {
    start(
      words.filter((word) => word.state === 'later'),
      true,
    );
    firstSay();
    hardest(words, true);
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
    hardest(words, false);
  } else {
    const owed = words.filter((word) => word.state === 'owed');
    start(
      owed.filter((word) => word.toStart),
      false,
    );
    firstSay();
    owedWork(owed);
    // Phase 65b (spec D2): past the budget, the rest of the session is practice more.
    if (mode === 'past_budget') practiceMore();
  }
  stepDowns();
  return picks;
}

/**
 * Phase 70 (spec D4). How many new words the day's room held back from `picks`, chosen from
 * `input`: what the same choice with no room limit starts beyond them. Only practice more's early
 * starts read the room, so a planned session's is 0.
 */
export function heldByRoom(input: TargetPickInput, picks: readonly ChosenPick[]): number {
  return Math.max(0, countNew(chooseTargetPicks({ ...input, newRoom: Number.POSITIVE_INFINITY })) - countNew(picks));
}
