import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH, type Dimension, type QuestionType } from '@lang-tutor/core/domain';

import { chooseWords, liveDimensions, type ChoiceInput, type ChosenPick } from './choose';
import { DAY_NEW_CAP, EXAM_RUN_UP_DAYS, KNOWN_STABILITY, RETURNS_PER_DAY, SPEAKING_PER_SESSION } from './chooseConstants';
import { LANE0_DAY } from './day.fixture';
import { glossFamilies, type Families, type FamilyGloss } from './glossFamilies';
import { applySession, type MemoryRow } from './memoryUpdate';
import { RUNGS, planCards } from './plan';
import { daysBetween, evaluateSession, type AnsweredQuestion, type ProgressRow } from './progress';
import { chooseWithTargets, type ActiveTarget, type TargetSplit } from './targetSession';
import { owedNew, readinessOf, recallOnDue, splitSlots, targetWish, type ShareReason, type TargetKind } from './targets';
import { dayState, type DayAnswer } from './today';

/**
 * Phase 37 (spec D9). Whole days through the real word choice, card choice,
 * grading, memory and level code, checked against Victor's five outcomes:
 *   1. every session brings new words, within the daily limit;
 *   2. a word met early in the day is recalled later that day;
 *   3. a word answered wrong returns later that day;
 *   4. speaking cards come up regularly when the device records;
 *   5. no word answered right today returns as filler.
 * The lists: lane 0's on 2026-10-11, when the learner did nine sessions and met
 * two new words, then the same list over twenty sessions; and a new learner's
 * thirty saved words, none met yet.
 *
 * Phase 39 (spec D12). Before each session the runner works out the gloss families,
 * carrying known_at from session to session, and plans an introduced gloss as a
 * new_meaning. Every run adds two outcomes:
 *   6. no session asks two glosses of one family;
 *   7. no waiting gloss is ever asked.
 * A last run follows a five-meaning word over days of sessions.
 *
 * Phase 53 (spec §2). Targets, word lists with a kind and a due date, run beside lane 0's
 * list: one scenario per row of the spec, each checked session by session against the
 * rules that split a session (D5, D6, the graded wish) and day by day against the pace
 * (D7), with the share of a list ready on its due date as the measure.
 */

const DIMENSIONS: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];
const CHOICE: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'new_meaning', 'reverse_choice', 'listen_choice', 'matching', 'cloze_choice']);
const SPEAKING_CARDS: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);
/** The recall types: rung 2 of some dimension (spec D6). */
const RECALL: ReadonlySet<QuestionType> = new Set(Object.values(RUNGS).flatMap(([, recall]) => recall));
/** The device listens and records in every session, so every skill is live. */
const LIVE = liveDimensions(true, true);

/** `at` counts sessions across days; `session` counts them within the day. */
type Asked = {
  session: number;
  at: number;
  glossId: string;
  cls: ChosenPick['cls'];
  rung: 1 | 2;
  type: QuestionType;
  right: boolean;
  knownMeanings: readonly string[] | undefined;
};
/** Phase 53: `split` is what each active target got; empty with none. */
type Session = { input: ChoiceInput; picks: ChosenPick[]; families: Families; split: readonly TargetSplit[] };
type DayList = {
  today: string;
  saved: Omit<FamilyGloss, 'knownAt'>[];
  /** Phase 46: the fixtures predate reachedOn; the runner dates it as migration 0032 does. */
  memory: Omit<MemoryRow, 'reachedOn'>[];
  progress: ProgressRow[];
};

/** A new learner: thirty words saved this morning, none met, each the only meaning
 *  of its word. */
const FRESH: DayList = {
  today: '2026-10-12',
  saved: Array.from({ length: 30 }, (_, i) => ({
    glossId: `n${String(i).padStart(2, '0')}`,
    key: `fresh-${i}`,
    savedAt: `2026-10-12T08:${String(i).padStart(2, '0')}:00.000000Z`,
    lexemeId: `x${i}`,
    lemma: `x${i}`,
    forms: [`f${i}`],
    order: [0, 0] as const,
    speakable: true,
  })),
  memory: [],
  progress: [],
};

/** The fixed learner: every fifth card answered is wrong (every `missEvery`th, for a
 *  run that says otherwise), and a read aloud is always understood (it writes no
 *  memory either way). */
function answerOf(glossId: string, type: QuestionType, right: boolean): AnsweredQuestion {
  if (CHOICE.has(type)) return { glossId, type, correct: right } as AnsweredQuestion;
  if (type === 'read_aloud') return { glossId, type, verdict: 'understood' };
  if (type === 'say_translation') return { glossId, type, verdict: right ? 'understood' : 'gave_up' };
  return { glossId, type, verdict: right ? 'exact' : 'wrong' } as AnsweredQuestion;
}

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}|${dimension}`;
const dayAfter = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** `days` days of `count` sessions over `list`, each session ended as recordProgress
 *  ends one. Memory, levels, the words met and known_at carry from day to day; the
 *  day's answers and the words it introduced start again each day.
 *
 *  Phase 53. A gloss is saved from the day of its savedAt (every gloss of the older
 *  lists is saved by their first day). With `targetsOn`, each session is split
 *  between the targets it returns that are active that day (before their due date)
 *  and the main path, as the session service splits one; without it, every session
 *  is chooseWords'. */
function runDays(
  list: DayList,
  days: number,
  count: number,
  missEvery = 5,
  targetsOn?: (day: number, date: string) => readonly ActiveTarget[],
): { log: Asked[]; sessions: Session[]; introduced: Set<string>[]; knownIn: ReadonlyMap<string, number> } {
  // Phase 46 (spec D4): a fixture row at the bar has reached it on its last day, as the backfill dates it.
  const memory = new Map<string, MemoryRow>(
    list.memory.map((row) => [
      keyOf(row.glossId, row.dimension),
      { ...row, reachedOn: row.state.stability >= KNOWN_STABILITY ? row.state.lastDay : null },
    ]),
  );
  const progress = new Map<string, ProgressRow>(list.progress.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const met = new Set(list.memory.map((row) => row.glossId));
  /** Phase 39 (spec D2). The session each gloss was first seen known in: its known_at. */
  const knownIn = new Map<string, number>();
  const log: Asked[] = [];
  const sessions: Session[] = [];
  const introducedByDay: Set<string>[] = [];
  let cards = 0;

  for (let day = 0; day < days; day++) {
    const date = dayAfter(list.today, day);
    const saved = list.saved.filter((gloss) => gloss.savedAt.slice(0, 10) <= date);
    const today: DayAnswer[] = [];
    const introduced = new Set<string>();
    introducedByDay.push(introduced);

    for (let session = 0; session < count; session++) {
      const at = sessions.length;
      const rows = [...memory.values()];
      const families = glossFamilies({
        saved: saved.map((gloss) => ({ ...gloss, knownAt: knownIn.has(gloss.glossId) ? `session ${knownIn.get(gloss.glossId)}` : null })),
        memory: rows,
        live: LIVE,
      });
      for (const glossId of families.newlyKnown) knownIn.set(glossId, at);
      const waiting = new Set([...families.state].filter(([, state]) => state === 'waiting').map(([glossId]) => glossId));

      const { steps, done } = dayState(today, introduced);
      const input: ChoiceInput = {
        saved,
        memory: rows,
        levels: [...progress.values()].map(({ glossId, dimension, level }) => ({ glossId, dimension, level })),
        today: date,
        steps,
        done,
        newToday: introduced.size,
        listening: true,
        speaking: true,
        rng: () => 0.5,
        families: { familyOf: families.familyOf, waiting },
      };
      const targets = targetsOn?.(day, date).filter((target) => date < target.dueOn);
      const { picks, split } = targets
        ? chooseWithTargets({
            choice: input,
            targets,
            speakable: new Map(saved.map((gloss) => [gloss.glossId, gloss.speakable])),
            introducedToday: introduced,
          })
        : { picks: chooseWords(input), split: [] };
      sessions.push({ input, picks, families, split });
      const planned = picks.map((pick, i) => ({
        form: `w${i}`,
        translation: `מ${i}`,
        tiles: true,
        speakable: true,
        clozeGap: true,
        dimension: pick.dimension,
        rung: pick.rung,
        level: pick.level,
        r: pick.r,
        step: pick.cls === 'STEP',
        knownMeanings: families.introductions.get(pick.glossId),
      }));
      const plan = planCards(planned, { listening: true, speaking: true });

      const given: AnsweredQuestion[] = plan.order.map((index, position) => {
        const pick = picks[index];
        const type = plan.types[position];
        const right = type === 'read_aloud' || cards++ % missEvery !== missEvery - 1;
        const { knownMeanings } = planned[index];
        log.push({ session, at, glossId: pick.glossId, cls: pick.cls, rung: pick.rung, type, right, knownMeanings });
        return answerOf(pick.glossId, type, right);
      });

      const glossIds = [...new Set(given.map((answer) => answer.glossId))];
      const before = [...memory.values()].filter((row) => glossIds.includes(row.glossId));
      for (const row of applySession(before, given, date)) memory.set(keyOf(row.glossId, row.dimension), row);
      const levels = glossIds.flatMap((glossId) =>
        DIMENSIONS.map(
          (dimension) => progress.get(keyOf(glossId, dimension)) ?? { glossId, dimension, level: 1, lastStepOn: null, lastWrongOn: null },
        ),
      );
      for (const row of evaluateSession(levels, given, date).changed) progress.set(keyOf(row.glossId, row.dimension), row);
      for (const glossId of glossIds) {
        if (!met.has(glossId)) {
          met.add(glossId);
          introduced.add(glossId);
        }
      }
      today.push(...given.map((answer) => ({ ...answer, sessionId: `s${at}` })));
    }
  }
  return { log, sessions, introduced: introducedByDay, knownIn };
}

/** Outcome 6 (phase 39 D5): a family's glosses share one slot in a session. */
function expectOneGlossPerFamily(sessions: readonly Session[]) {
  sessions.forEach(({ picks, families }, at) => {
    const taken = picks.flatMap((pick) => (families.familyOf.has(pick.glossId) ? [families.familyOf.get(pick.glossId)] : []));
    expect({ at, families: taken.length }).toEqual({ at, families: new Set(taken).size });
  });
}

/** Outcome 7 (phase 39 D3, D5): a waiting gloss is no candidate. */
function expectNoWaitingGloss(sessions: readonly Session[]) {
  sessions.forEach(({ picks, families }, at) => {
    const waiting = picks.filter((pick) => families.state.get(pick.glossId) === 'waiting').map((pick) => pick.glossId);
    expect({ at, waiting }).toEqual({ at, waiting: [] });
  });
}

/** Outcomes 6 and 7 are not vacuous: the runner computed families, and some gloss
 *  waited in some session. False for a list of single-meaning words, which has none. */
function familiesChecked(sessions: readonly Session[]): { families: boolean; waited: boolean } {
  return {
    families: sessions.some(({ families }) => families.families.length > 0),
    waited: sessions.some(({ families }) => [...families.state.values()].includes('waiting')),
  };
}

/** A list, its sessions, what the day should meet in new words, and whether it has
 *  gloss families (phase 39). */
const DAYS: [string, DayList, number, (met: number) => void, boolean][] = [
  ['lane 0, the nine sessions of 2026-10-11', LANE0_DAY, LANE0_DAY.sessions, (met) => expect(met).toBeGreaterThan(2), true],
  ['lane 0 over twenty sessions', LANE0_DAY, 20, (met) => expect(met).toBe(DAY_NEW_CAP), true],
  ['a new learner, thirty words saved and none met, over six sessions', FRESH, 6, (met) => expect(met).toBe(DAY_NEW_CAP), false],
];

describe.each(DAYS)('a day: %s (phase 37)', (_name, list, count, checkMet, withFamilies) => {
  const {
    log,
    sessions,
    introduced: [introduced],
  } = runDays(list, 1, count);
  const last = count - 1;

  it('1. brings new words in every session while the daily limit allows', () => {
    for (const { input, picks } of sessions) {
      if (input.newToday < DAY_NEW_CAP) expect(picks.some((pick) => pick.cls === 'NEW')).toBe(true);
    }
    expect(introduced.size).toBeLessThanOrEqual(DAY_NEW_CAP);
  });

  it('2. recalls every word met before the last session later that day', () => {
    const met = log.filter((card) => card.cls === 'NEW' && card.session < last);
    expect(met.length).toBeGreaterThan(0);
    for (const card of met) {
      const recalled = log.some((later) => later.glossId === card.glossId && later.session > card.session && later.rung === 2 && RECALL.has(later.type));
      expect({ glossId: card.glossId, recalled }).toEqual({ glossId: card.glossId, recalled: true });
    }
  });

  it('3. brings back every word missed before the last session later that day, until its returns run out', () => {
    const missed = log.filter((card) => !card.right && card.session < last);
    expect(missed.length).toBeGreaterThan(0);
    for (const card of missed) {
      // D1: a word comes back at most RETURNS_PER_DAY times a day. Returns are asked
      // last, and the last card of a ten-card session is always one this learner
      // misses, so some words use them all.
      const returns = log.filter((earlier) => earlier.glossId === card.glossId && earlier.cls === 'STEP' && earlier.session <= card.session);
      if (returns.length >= RETURNS_PER_DAY) continue;
      const back = log.some((later) => later.glossId === card.glossId && later.session > card.session);
      expect({ glossId: card.glossId, session: card.session, back }).toEqual({ glossId: card.glossId, session: card.session, back: true });
    }
  });

  it('4. gives a session a speaking card whenever a word met is not owed a return', () => {
    // Before then there is nothing to say: the first session meets the words, and a
    // new learner's second owes each of them its return.
    sessions.forEach(({ input }, session) => {
      const owed = new Set(input.steps.map((step) => step.glossId));
      if (input.done.size === 0 && input.memory.every((row) => owed.has(row.glossId))) return;
      const spoke = log.some((card) => card.session === session && SPEAKING_CARDS.has(card.type));
      expect({ session, spoke }).toEqual({ session, spoke: true });
    });
  });

  it('5. asks a word done today only when no other word can be asked', () => {
    for (const { input, picks } of sessions) {
      if (!picks.some((pick) => pick.cls === 'DONE')) continue;
      // Every word the session could ask besides the done ones was asked.
      const others = chooseWords({ ...input, saved: input.saved.filter((gloss) => !input.done.has(gloss.glossId)), done: new Set() });
      const asked = new Set(picks.map((pick) => pick.glossId));
      expect(others.map((pick) => pick.glossId).filter((glossId) => !asked.has(glossId))).toEqual([]);
    }
  });

  it('6 and 7 have families to check, and a gloss that waits, when the list has them (phase 39)', () => {
    expect(familiesChecked(sessions)).toEqual({ families: withFamilies, waited: withFamilies });
  });

  it('6. never asks two glosses of one family in a session (phase 39)', () => {
    expectOneGlossPerFamily(sessions);
  });

  it('7. never asks a waiting gloss (phase 39)', () => {
    expectNoWaitingGloss(sessions);
  });

  it('meets new words up to the daily limit, and recalls', () => {
    checkMet(introduced.size);
    expect(log.some((card) => card.rung === 2 && RECALL.has(card.type))).toBe(true);
  });
});

/** A word of five meanings, most common first. */
const FIVE = ['m0', 'm1', 'm2', 'm3', 'm4'];

/** Phase 39 (spec D12). Twelve glosses saved one morning: a word of five meanings, a
 *  homograph pair that shares a spelling (see / saw), and five single words. */
const FAMILIES: DayList = {
  today: '2026-10-12',
  saved: [
    ...FIVE.map((glossId, i) => ({
      glossId,
      key: `five-${i}`,
      savedAt: `2026-10-12T08:00:0${i}.000000Z`,
      lexemeId: 'x-five',
      lemma: 'x-five',
      forms: ['f-five'],
      order: [0, i] as const,
      speakable: true,
    })),
    { glossId: 'h0', key: 'see', savedAt: '2026-10-12T08:01:00.000000Z', lexemeId: 'x-see', lemma: 'x-see', forms: ['f-saw', 'f-see'], order: [0, 0], speakable: true },
    { glossId: 'h1', key: 'saw', savedAt: '2026-10-12T08:01:01.000000Z', lexemeId: 'x-saw', lemma: 'x-saw', forms: ['f-saw'], order: [1, 0], speakable: true },
    ...Array.from({ length: 5 }, (_, i) => ({
      glossId: `s${i}`,
      key: `single-${i}`,
      savedAt: `2026-10-12T08:02:0${i}.000000Z`,
      lexemeId: `x-single-${i}`,
      lemma: `x-single-${i}`,
      forms: [`f-single-${i}`],
      order: [0, 0] as const,
      speakable: true,
    })),
  ],
  memory: [],
  progress: [],
};

/** Phase 46 (spec D6). Phase 37's learner, missing one card in five. Under phase 39's
 *  rule, every skill at the bar at the same moment, this learner never got a gloss of
 *  this list known: a miss drops the skill it tests, and at six sessions a day each of
 *  the seven glosses not waiting is missed about once a day. A skill now counts once it
 *  has reached the bar (D1, D2), so the second meanings come. */
const MISS_EVERY = 5;

describe('families over days: twenty-five days of six sessions, phase 37\'s learner (phase 39, phase 46)', () => {
  // Phase 46 (spec D6): the five-meaning word, asked in every session, is known on day 20
  // (session 118); five more days keep the test from turning red on a day's drift.
  const { log, sessions, knownIn } = runDays(FAMILIES, 25, 6, MISS_EVERY);

  it('6 and 7 have families to check, and a gloss that waits', () => {
    expect(familiesChecked(sessions)).toEqual({ families: true, waited: true });
  });

  it('6. never asks two glosses of one family in a session', () => {
    expectOneGlossPerFamily(sessions);
  });

  it('7. never asks a waiting gloss', () => {
    expectNoWaitingGloss(sessions);
  });

  it("asks a word's second meaning once its first is known, first as a new_meaning that lists the first", () => {
    const asked = log.filter((card) => FIVE.includes(card.glossId));
    // The most common meaning is the word's first (D3).
    expect(asked[0]?.glossId).toBe('m0');
    const second = asked.find((card) => card.glossId !== 'm0');
    expect(second).toBeDefined();
    expect(knownIn.has('m0')).toBe(true);
    expect(second!.at).toBeGreaterThanOrEqual(knownIn.get('m0')!);
    expect(second).toMatchObject({ glossId: 'm1', type: 'new_meaning', knownMeanings: ['five-0'] });
  });

  it('asks the other reading of a shared spelling the same way', () => {
    const second = log.find((card) => card.glossId === 'h1');
    expect(knownIn.has('h0')).toBe(true);
    expect(second?.at).toBeGreaterThanOrEqual(knownIn.get('h0')!);
    expect(second).toMatchObject({ type: 'new_meaning', knownMeanings: ['see'] });
  });
});

// Phase 53 (spec §2): the day simulation with targets.

const SESSIONS_A_DAY = 6;

/** A learner who answers every card right: the one who gets a list all ready, so the steady share shows. */
const NEVER_MISSES = Number.POSITIVE_INFINITY;

/** Spec §2. The share of a list ready on its due date, phase 37's learner, the list and dates of
 *  scenarios 1 and 2. */
const READY_ON_DUE_PASS: Record<TargetKind, number> = {
  // Measured 2026-10-15: 0.65. Never lowered to let a change pass (spec §2).
  exam: 0.65,
  // Measured 2026-10-15: 0.85. Never lowered to let a change pass (spec §2).
  homework: 0.85,
};

const listId = (n: number) => `t${String(n).padStart(2, '0')}`;
/** Words `from` to `to` of the list. */
const listIds = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => listId(from + i));

/** A word of a target's list, saved on `day` (the day it joined its target, as the wizard and the
 *  target screen save it), never met, the only meaning of its word. */
const listWord = (n: number, day: number): Omit<FamilyGloss, 'knownAt'> => ({
  glossId: listId(n),
  key: `list-${n}`,
  savedAt: `${dayAfter(LANE0_DAY.today, day)}T18:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000000Z`,
  lexemeId: `x-list-${n}`,
  lemma: `x-list-${n}`,
  forms: [`f-list-${n}`],
  order: [0, 0],
  speakable: true,
});

/** Lane 0's list of 2026-10-11 as the main path, `words` list words saved on its first day, and
 *  `later.words` more saved on day `later.on`. */
function withList(words: number, later = { words: 0, on: 0 }): DayList {
  return {
    today: LANE0_DAY.today,
    saved: [
      ...LANE0_DAY.saved,
      ...Array.from({ length: words }, (_, i) => listWord(i + 1, 0)),
      ...Array.from({ length: later.words }, (_, i) => listWord(words + i + 1, later.on)),
    ],
    memory: LANE0_DAY.memory,
    progress: LANE0_DAY.progress,
  };
}

/** The date `days` days after the lists' first day. */
const dueIn = (days: number) => dayAfter(LANE0_DAY.today, days);
const LANE0_GLOSSES: ReadonlySet<string> = new Set(LANE0_DAY.saved.map((gloss) => gloss.glossId));

type TargetRun = { log: Asked[]; sessions: Session[]; targetsOn: (day: number, date: string) => readonly ActiveTarget[] };

function runTargets(
  list: DayList,
  days: number,
  targetsOn: (day: number, date: string) => readonly ActiveTarget[],
  missEvery = MISS_EVERY,
): TargetRun {
  const { log, sessions } = runDays(list, days, SESSIONS_A_DAY, missEvery, targetsOn);
  return { log, sessions, targetsOn };
}

const dayOf = (at: number) => Math.floor(at / SESSIONS_A_DAY);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The targets active in session `at`, in the order their pools run: the nearer due date first. */
function activeIn(run: TargetRun, at: number): ActiveTarget[] {
  const date = run.sessions[at].input.today;
  return run
    .targetsOn(dayOf(at), date)
    .filter((target) => date < target.dueOn)
    .sort((a, b) => compare(a.dueOn, b.dueOn) || compare(a.id, b.id));
}

const picksOf = (session: Session, glossIds: readonly string[]) => session.picks.filter((pick) => glossIds.includes(pick.glossId));

/** The session's picks of no active target's words: the main path's. */
function mainPicks(run: TargetRun, at: number): ChosenPick[] {
  const listed = new Set(activeIn(run, at).flatMap((target) => target.glossIds));
  return run.sessions[at].picks.filter((pick) => !listed.has(pick.glossId));
}

/** Spec D4: the target's words ready for its date by the memory `rows`. */
function readyIn(target: ActiveTarget, rows: Session['input']['memory']): number {
  return target.glossIds.filter(
    (glossId) => readinessOf(target.kind, recallOnDue(rows.filter((row) => row.glossId === glossId), LIVE, true, target.dueOn)) === 'ready',
  ).length;
}

/** The sessions on `day`, with their indices across the run. */
const sessionsOn = (run: TargetRun, day: number) =>
  run.sessions.slice(day * SESSIONS_A_DAY, (day + 1) * SESSIONS_A_DAY).map((session, i) => ({ session, at: day * SESSIONS_A_DAY + i }));

/** The run's day of `date`. */
const dayIndex = (date: string) => daysBetween(LANE0_DAY.today, date);

/**
 * Spec D4–D6, as amended by the graded wish. Each session's recorded split, recomputed from the
 * session's own input: daysLeft and the word count from the target, the ready count from the
 * memory the session read, the wish from targetWish, the slots from splitSlots over the wishes.
 * Then the picks, exactly: each target, in pool order, its slots and the slots the targets before
 * it could not use, or all its words when it has fewer (they are all free: no family, no shared
 * key); the main path its share, the session's other slots. Lane 0's list always leaves the main
 * path words it has not answered today, so it fills its share, and no slot comes back to the
 * targets in a second pass (ruling R-D6): a target that took the main path's share fails here.
 */
function expectSplitsByTheRules(run: TargetRun) {
  run.sessions.forEach((session, at) => {
    const targets = activeIn(run, at);
    const wishes = targets.map((target) => {
      const daysLeft = daysBetween(session.input.today, target.dueOn);
      const readyCount = readyIn(target, session.input.memory);
      const wordCount = target.glossIds.length;
      return { target, daysLeft, readyCount, wordCount, ...targetWish(target.kind, daysLeft, readyCount, wordCount) };
    });
    const slots = splitSlots(
      wishes.map(({ target, wish, exclusive }) => ({ targetId: target.id, dueOn: target.dueOn, wish, exclusive })),
      SESSION_LENGTH,
    );
    expect({ at, split: session.split }).toEqual({
      at,
      split: wishes.map(({ target, daysLeft, readyCount, wordCount, wish, reason }) => ({
        targetId: target.id,
        wish,
        slots: slots.get(target.id),
        picked: picksOf(session, target.glossIds).length,
        reason,
        daysLeft,
        readyCount,
        wordCount,
      })),
    });

    let carried = 0;
    const least = targets.map((target) => {
      const offered = slots.get(target.id)! + carried;
      const fills = Math.min(offered, target.glossIds.length);
      carried = offered - fills;
      return fills;
    });
    const mainShare = SESSION_LENGTH - [...slots.values()].reduce((sum, n) => sum + n, 0) + carried;
    expect({ at, picked: targets.map((target) => picksOf(session, target.glossIds).length), main: mainPicks(run, at).length }).toEqual({
      at,
      picked: least,
      main: mainShare,
    });
  });
}

/** Spec D7: every word of the target, as it stands on its last day, was met before that day: the
 *  first session of the last day read memory for each. */
function expectMetBeforeTheLastDay(run: TargetRun, id: string) {
  const at = run.sessions.findIndex((session) => session.split.some((split) => split.targetId === id && split.daysLeft === 1));
  expect(at).not.toBe(-1);
  const target = activeIn(run, at).find((active) => active.id === id)!;
  const unmet = target.glossIds.filter((glossId) => !run.sessions[at].input.memory.some((row) => row.glossId === glossId));
  expect(unmet).toEqual([]);
}

/** Spec §2: the share of the target's words ready on its due date, by the memory the last
 *  session before it left (the first session of the due date reads it). */
function readyShareOnDue(run: TargetRun, target: ActiveTarget): number {
  const first = run.sessions[dayIndex(target.dueOn) * SESSIONS_A_DAY];
  return readyIn(target, first.input.memory) / target.glossIds.length;
}

/** Spec §2, row 6, in every scenario: no family twice in a session (phase 39), the speaking pick
 *  at most once a session, and the main path's due words asked again on each day after the last
 *  target's date. `end` is that date. */
function itKeepsTheSessionRules(run: TargetRun, end: string) {
  it('never asks two glosses of one family in a session (phase 39)', () => {
    expectOneGlossPerFamily(run.sessions);
  });

  it('makes the speaking pick once a session at most, and makes it', () => {
    run.sessions.forEach(({ picks }, at) => {
      expect({ at, speak: picks.filter((pick) => pick.cls === 'SPEAK').length <= SPEAKING_PER_SESSION }).toEqual({ at, speak: true });
    });
    // The check above has something to check: the run makes speaking picks.
    expect(run.sessions.some(({ picks }) => picks.some((pick) => pick.cls === 'SPEAK'))).toBe(true);
  });

  it("asks the main path's due words again on each day after the date", () => {
    const days = dayOf(run.sessions.length - 1);
    expect(days).toBeGreaterThanOrEqual(dayIndex(end));
    for (let day = dayIndex(end); day <= days; day++) {
      const due = sessionsOn(run, day).flatMap(({ session }) => session.picks.filter((pick) => LANE0_GLOSSES.has(pick.glossId) && pick.cls === 'DUE'));
      expect({ day, due: due.length > 0 }).toEqual({ day, due: true });
    }
  });
}

describe("a target, phase 37's learner: an exam due in 14 days, twenty words (phase 53, spec §2 row 1)", () => {
  const exam: ActiveTarget = { id: 'exam', kind: 'exam', dueOn: dueIn(14), glossIds: listIds(1, 20) };
  const run = runTargets(withList(20), 17, () => [exam]);
  const share = readyShareOnDue(run, exam);
  /** The exam's daysLeft in session `at`; 0 once it has ended. */
  const daysLeftIn = (at: number) => run.sessions[at].split[0]?.daysLeft ?? 0;

  it('splits every session by the rules: the graded wish, the split and the picks', () => {
    expectSplitsByTheRules(run);
  });

  it('meets every word before the last day', () => {
    expectMetBeforeTheLastDay(run, 'exam');
  });

  it('asks the exam alone while none of its words is ready, then lets the main path back before the run-up', () => {
    const shared = run.sessions.flatMap((session, at) => (daysLeftIn(at) > EXAM_RUN_UP_DAYS && mainPicks(run, at).length > 0 ? [session] : []));
    expect(shared.length).toBeGreaterThan(0);
    for (const session of shared) expect(session.split[0].readyCount).toBeGreaterThan(0);
  });

  it('asks the exam alone on its run-up days and on its eve', () => {
    const last = run.sessions.flatMap((session, at) => (daysLeftIn(at) >= 1 && daysLeftIn(at) <= EXAM_RUN_UP_DAYS ? [{ session, at }] : []));
    expect(last).toHaveLength(EXAM_RUN_UP_DAYS * SESSIONS_A_DAY);
    for (const { session, at } of last) {
      expect({ at, exam: picksOf(session, exam.glossIds).length, picks: session.picks.length }).toEqual({ at, exam: SESSION_LENGTH, picks: SESSION_LENGTH });
    }
    expect(last.at(-1)?.session.split[0]).toMatchObject({ reason: 'exclusive', daysLeft: 1 });
  });

  it('serves it no more from the due date on: no split, and no session of its words alone', () => {
    const after = run.sessions.slice(dayIndex(exam.dueOn) * SESSIONS_A_DAY);
    expect(after.length).toBeGreaterThan(0);
    for (const session of after) {
      expect(session.split).toEqual([]);
      expect(picksOf(session, exam.glossIds).length).toBeLessThan(session.picks.length);
    }
  });

  it(`ready on the due date: ${share.toFixed(2)} (pass ≥ ${READY_ON_DUE_PASS.exam.toFixed(2)})`, () => {
    expect(share).toBeGreaterThanOrEqual(READY_ON_DUE_PASS.exam);
  });

  itKeepsTheSessionRules(run, exam.dueOn);
});

describe("a target, phase 37's learner: homework due in 14 days, the same twenty words (phase 53, spec §2 row 2)", () => {
  const homework: ActiveTarget = { id: 'homework', kind: 'homework', dueOn: dueIn(14), glossIds: listIds(1, 20) };
  const run = runTargets(withList(20), 17, () => [homework]);
  const share = readyShareOnDue(run, homework);

  it('splits every session by the rules: the graded wish, the split and the picks', () => {
    expectSplitsByTheRules(run);
  });

  it('meets every word before the last day', () => {
    expectMetBeforeTheLastDay(run, 'homework');
  });

  it('asks at least 7 of 10 on its last day', () => {
    const last = run.sessions.flatMap((session, at) => (session.split[0]?.daysLeft === 1 ? [{ session, at }] : []));
    expect(last).toHaveLength(SESSIONS_A_DAY);
    for (const { session, at } of last) {
      expect({ at, atLeast7: picksOf(session, homework.glossIds).length >= 7 }).toEqual({ at, atLeast7: true });
    }
  });

  it(`ready on the due date: ${share.toFixed(2)} (pass ≥ ${READY_ON_DUE_PASS.homework.toFixed(2)})`, () => {
    expect(share).toBeGreaterThanOrEqual(READY_ON_DUE_PASS.homework);
  });

  itKeepsTheSessionRules(run, homework.dueOn);
});

describe.each<[TargetKind, number, ShareReason, number]>([
  ['exam', 5, 'exclusive', 10],
  ['homework', 3, 'run_up', 7],
])('a target, a learner who never misses: %s due in 14 days, twenty words (phase 53, spec §2 rows 1 and 2)', (kind, steady, lastReason, lastShare) => {
  const target: ActiveTarget = { id: kind, kind, dueOn: dueIn(14), glossIds: listIds(1, 20) };
  const run = runTargets(withList(20), 15, () => [target], NEVER_MISSES);

  it('splits every session by the rules: the graded wish, the split and the picks', () => {
    expectSplitsByTheRules(run);
  });

  it(`gets all ready and settles to its steady ${steady} of 10, the main path taking the rest`, () => {
    const settled = run.sessions.flatMap((session, at) => (session.split[0]?.reason === 'steady' ? [{ session, at }] : []));
    expect(settled.length).toBeGreaterThan(0);
    for (const { session, at } of settled) {
      expect({ at, target: picksOf(session, target.glossIds).length, main: mainPicks(run, at).length }).toEqual({
        at,
        target: steady,
        main: SESSION_LENGTH - steady,
      });
    }
  });

  it(`asks ${lastShare} of 10 on its last day, all ready (${lastReason}), the main path the rest`, () => {
    const last = run.sessions.flatMap((session, at) => (session.split[0]?.daysLeft === 1 ? [{ session, at }] : []));
    expect(last).toHaveLength(SESSIONS_A_DAY);
    for (const { session, at } of last) {
      expect({ at, split: session.split[0], target: picksOf(session, target.glossIds).length, main: mainPicks(run, at).length }).toEqual({
        at,
        split: expect.objectContaining({ reason: lastReason, readyCount: target.glossIds.length }),
        target: lastShare,
        main: SESSION_LENGTH - lastShare,
      });
    }
  });

  itKeepsTheSessionRules(run, target.dueOn);
});

describe("a target, phase 37's learner: an exam due in 4 days (phase 53, spec §2 row 3)", () => {
  const exam: ActiveTarget = { id: 'exam', kind: 'exam', dueOn: dueIn(4), glossIds: listIds(1, 20) };
  const run = runTargets(withList(20), 6, () => [exam]);

  it('splits every session by the rules: the graded wish, the split and the picks', () => {
    expectSplitsByTheRules(run);
  });

  it('asks the exam alone in every session before its date', () => {
    const served = run.sessions.flatMap((session, at) => (session.split.length > 0 ? [{ session, at }] : []));
    expect(served).toHaveLength(4 * SESSIONS_A_DAY);
    for (const { session, at } of served) {
      expect({ at, exam: picksOf(session, exam.glossIds).length }).toEqual({ at, exam: SESSION_LENGTH });
    }
  });

  it('meets every word before the last day', () => {
    expectMetBeforeTheLastDay(run, 'exam');
  });

  itKeepsTheSessionRules(run, exam.dueOn);
});

/** Final review I1. A meaning saved and practised before the lists' first day, never known: its
 *  family's current meaning, which the list's first word, another meaning of the same word, waits
 *  on (phase 39). The list word keeps waiting throughout: once both are practised, the more common
 *  meaning, the one practised, stays current. */
const SIBLING: Omit<FamilyGloss, 'knownAt'> = {
  glossId: 'sib',
  key: 'sibling',
  savedAt: '2026-10-01T09:00:00.000000Z',
  lexemeId: 'x-shared',
  lemma: 'x-shared',
  forms: ['f-shared'],
  order: [0, 0],
  speakable: true,
};
const SIBLING_MEMORY = (['written_receptive', 'written_productive'] as const).map((dimension) => ({
  glossId: SIBLING.glossId,
  dimension,
  state: { stability: 3, difficulty: 5, lastDay: '2026-10-09', reps: 2, lapses: 0, params: 'fsrs6-default' },
}));

/** withList's lists, the first list word another meaning of SIBLING's word, SIBLING saved and practised. */
function withPractisedSibling(words: number): DayList {
  const list = withList(words);
  const shared = { lexemeId: SIBLING.lexemeId, lemma: SIBLING.lemma, forms: SIBLING.forms, order: [0, 1] as const };
  return {
    ...list,
    saved: [...list.saved.map((gloss) => (gloss.glossId === listId(1) ? { ...gloss, ...shared } : gloss)), SIBLING],
    memory: [...list.memory, ...SIBLING_MEMORY],
  };
}

describe("a target word whose family waits, phase 37's learner: an exam due in 4 days, its first word another meaning of a word practised (phase 53, final review I1)", () => {
  const exam: ActiveTarget = { id: 'exam', kind: 'exam', dueOn: dueIn(4), glossIds: listIds(1, 20) };
  const run = runTargets(withPractisedSibling(20), 6, () => [exam]);

  it('splits every session by the rules: the graded wish, the split and the picks', () => {
    expectSplitsByTheRules(run);
  });

  it('asks the word though it waits on the meaning practised, and meets every word before the last day', () => {
    const first = run.sessions.findIndex((session) => session.picks.some((pick) => pick.glossId === listId(1)));
    expect(first).not.toBe(-1);
    expect(run.sessions[first].families.state.get(listId(1))).toBe('waiting');
    expectMetBeforeTheLastDay(run, 'exam');
  });

  itKeepsTheSessionRules(run, exam.dueOn);
});

describe("two targets, phase 37's learner: a 4-word exam due in 6 days beside a 16-word homework due in 10 (phase 53, spec §2 row 4)", () => {
  const homework: ActiveTarget = { id: 'homework', kind: 'homework', dueOn: dueIn(10), glossIds: listIds(1, 16) };
  const exam: ActiveTarget = { id: 'exam', kind: 'exam', dueOn: dueIn(6), glossIds: listIds(17, 20) };
  const run = runTargets(withList(20), 12, () => [homework, exam]);

  it('splits every session by the rules, the slots one target cannot use passing to the next', () => {
    expectSplitsByTheRules(run);
  });

  it('gives the slots the exam cannot use to the homework, which fills them with its own words, answered today too, before the main path gets any', () => {
    let carriedIn = 0;
    let answeredToday = 0;
    run.sessions.forEach((session, at) => {
      const [examSplit, homeworkSplit] = session.split;
      if (examSplit?.targetId !== 'exam' || homeworkSplit === undefined) return;
      const carried = examSplit.slots - picksOf(session, exam.glossIds).length;
      if (carried <= 0) return;
      carriedIn++;
      const homeworkPicks = picksOf(session, homework.glossIds);
      expect({ at, homework: homeworkPicks.length, main: mainPicks(run, at).length }).toEqual({
        at,
        homework: homeworkSplit.slots + carried,
        main: SESSION_LENGTH - examSplit.slots - homeworkSplit.slots,
      });
      if (homeworkPicks.some((pick) => pick.cls === 'DONE')) answeredToday++;
    });
    expect(carriedIn).toBeGreaterThan(0);
    expect(answeredToday).toBeGreaterThan(0);
  });

  it("gives the exam its eve alone: all of its words, the homework only the slots the exam cannot use, the main path none", () => {
    const eve = run.sessions.flatMap((session, at) => (session.split[0]?.reason === 'exclusive' ? [{ session, at }] : []));
    expect(eve).toHaveLength(SESSIONS_A_DAY);
    for (const { session, at } of eve) {
      expect(session.split.map(({ targetId, slots }) => ({ targetId, slots }))).toEqual([
        { targetId: 'exam', slots: SESSION_LENGTH },
        { targetId: 'homework', slots: 0 },
      ]);
      expect({ at, exam: picksOf(session, exam.glossIds).length, homework: picksOf(session, homework.glossIds).length, main: mainPicks(run, at).length }).toEqual({
        at,
        exam: exam.glossIds.length,
        homework: SESSION_LENGTH - exam.glossIds.length,
        main: 0,
      });
    }
  });

  it('meets every word of both before their last days', () => {
    expectMetBeforeTheLastDay(run, 'exam');
    expectMetBeforeTheLastDay(run, 'homework');
  });

  itKeepsTheSessionRules(run, homework.dueOn);
});

describe("a target that changes, phase 37's learner: 70 words due in 8 days, moved to day 5 on day 2, 10 words added on day 3 (phase 53, spec §2 row 5)", () => {
  const examOn = (day: number): ActiveTarget[] => [
    { id: 'exam', kind: 'exam', dueOn: day < 2 ? dueIn(8) : dueIn(5), glossIds: day < 3 ? listIds(1, 70) : listIds(1, 80) },
  ];
  const run = runTargets(withList(70, { words: 10, on: 3 }), 8, examOn);

  it('splits every session by the rules: daysLeft follows the new date, the word count the added words', () => {
    expectSplitsByTheRules(run);
    expect(sessionsOn(run, 1)[0].session.split[0]).toMatchObject({ daysLeft: 7, wordCount: 70 });
    expect(sessionsOn(run, 2)[0].session.split[0]).toMatchObject({ daysLeft: 3, wordCount: 70 });
    expect(sessionsOn(run, 3)[0].session.split[0]).toMatchObject({ daysLeft: 2, wordCount: 80, reason: 'run_up' });
    expect(sessionsOn(run, 4)[0].session.split[0]).toMatchObject({ daysLeft: 1, wordCount: 80, reason: 'exclusive' });
    expect(sessionsOn(run, 5)[0].session.split).toEqual([]);
  });

  it('meets each day at least the pace for the words and the days left at its start, past the daily cap when the date comes closer', () => {
    const days = Array.from({ length: dayIndex(dueIn(5)) }, (_, day) => {
      const [first] = sessionsOn(run, day);
      const target = activeIn(run, first.at)[0];
      const unmet = target.glossIds.filter((glossId) => !first.session.input.memory.some((row) => row.glossId === glossId)).length;
      const pace = owedNew(unmet, 0, first.session.split[0].daysLeft);
      const met = sessionsOn(run, day).reduce((sum, { session }) => sum + picksOf(session, target.glossIds).filter((pick) => pick.cls === 'NEW').length, 0);
      return { day, pace, met };
    });
    // The pace binds: the moved date and the added words owe more in a day than DAY_NEW_CAP allows.
    expect(days.filter(({ pace }) => pace > DAY_NEW_CAP).length).toBeGreaterThan(0);
    for (const { day, pace, met } of days) expect({ day, pace, metAtLeastThePace: met >= pace }).toEqual({ day, pace, metAtLeastThePace: true });
  });

  it('meets every word, those added included, before the new last day', () => {
    expectMetBeforeTheLastDay(run, 'exam');
  });

  itKeepsTheSessionRules(run, dueIn(5));
});
