import { describe, expect, it } from '@jest/globals';

import { SESSION_LENGTH, type Dimension, type QuestionType } from '@lang-tutor/core/domain';

import type { ChosenPick } from './choose';
import { LADDER_SLOTS, NEW_PER_SESSION, STEP_DOWNS_PER_SESSION } from './chooseConstants';
import { MAX_PER_TYPE } from './plan';
import type { TargetDay, WordDay } from './targetDay';
import {
  boardsSession,
  cardOf,
  chooseTargetPicks,
  owedWords,
  picksOfCards,
  raisesCard,
  sameStepDowns,
  stepDownKeys,
  stockServes,
  stockToCheck,
  targetMode,
  type TargetMode,
  type TargetPickInput,
} from './targetPicker';

// Phase 67 (spec D6). The target picker reads each word's cards of the day: the words to meet
// first, then each owed word's first card, then its second, the word with the lowest readiness
// first; practice more and the last review by the start chances. Pure: the day is hand-built.

const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SR: Dimension = 'spoken_receptive';
const SP: Dimension = 'spelling';
const SK: Dimension = 'spoken_productive';
const DIMS: Dimension[] = [WR, WP, SR, SP, SK];
const COUNTED: Dimension[] = [WP, SP, SK];

/** A word of a hand-built day: its counted skills' chances (0 when absent), its state, whether it
 *  is to start and how many cards it has left today (2 for an owed word unless said). Its open
 *  skills are its counted ones by chance; it owes the first `cardsLeft` of them. */
type WordSpec = {
  id: string;
  chances?: Partial<Record<Dimension, number>>;
  /** Skills asked today: out of its open ones. */
  asked?: Dimension[];
  state?: WordDay['state'];
  toStart?: boolean;
  cardsLeft?: number;
  live?: Dimension[];
};

function wordOf(spec: WordSpec): WordDay {
  const live = spec.live ?? DIMS;
  const counted = COUNTED.filter((d) => live.includes(d)).map((dimension) => ({ dimension, chance: spec.chances?.[dimension] ?? 0 }));
  const open = [...counted]
    .sort((a, b) => a.chance - b.chance || counted.indexOf(a) - counted.indexOf(b))
    .map((skill) => skill.dimension)
    .filter((dimension) => !spec.asked?.includes(dimension));
  const state = spec.state ?? 'owed';
  const cardsLeft = state === 'owed' ? (spec.cardsLeft ?? 2) : 0;
  const readinessPct = Math.floor(100 * counted.reduce((product, skill) => product * skill.chance, 1));
  return { glossId: spec.id, state, toStart: spec.toStart ?? false, owed: open.slice(0, cardsLeft), open, cardsLeft, practised: counted, readinessPct, startsIn: null };
}

function dayOf(specs: WordSpec[], state: TargetDay['state'] = 'owed'): TargetDay {
  return {
    daysLeft: state === 'due_today' ? 0 : 2,
    capHalves: 16,
    state,
    planned: 0,
    done: 0,
    extra: 0,
    nextPracticeIn: null,
    readinessPct: 0,
    readyCount: 0,
    words: specs.map(wordOf),
  };
}

const base: Omit<TargetPickInput, 'day' | 'mode'> = {
  levels: new Map(),
  known: new Set(),
  newMeanings: new Set(),
  keys: new Map(),
  inFlight: [],
};

const pick = (day: TargetDay, over: Partial<TargetPickInput> = {}) => chooseTargetPicks({ ...base, day, mode: targetMode(day), ...over });

const short = (picks: ChosenPick[]) => picks.map((p) => [p.glossId, p.dimension, p.rung]);
const slotsOf = (picks: ChosenPick[]) => picks.reduce((sum, p) => sum + (p.ladder ? LADDER_SLOTS : 1), 0);
/** A word whose speaking alone is below the rest. */
const sayOwed = (id: string): WordSpec => ({ id, chances: { [WP]: 0.99, [SP]: 0.99, [SK]: 0.5 }, cardsLeft: 1 });

describe('targetMode', () => {
  const cases: [TargetDay['state'], TargetMode][] = [
    ['owed', 'owed'],
    ['due_today', 'last_review'],
    ['done', 'more'],
    ['rest', 'more'],
  ];
  it.each(cases)('a day %s is asked in mode %s', (state, mode) => {
    expect(targetMode(dayOf([], state))).toBe(mode);
  });
});

describe('chooseTargetPicks, owed (spec D6)', () => {
  it("asks each owed word its first card, then its second, the word with the lowest readiness first", () => {
    const day = dayOf([
      { id: 'A', chances: { [WP]: 0.9, [SP]: 0.95, [SK]: 0.5 } },
      { id: 'B', chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.7 } },
    ]);
    expect(short(pick(day))).toEqual([
      ['B', WP, 2],
      ['A', SK, 2],
      ['B', SP, 1],
      ['A', WP, 2],
    ]);
  });

  it('asks writing at its recall rung, spelling as a dictation and speaking as a say translation', () => {
    expect(cardOf(WP, 2)).toBe('typed_translation');
    expect(cardOf(SP, 1)).toBe('dictation');
    expect(cardOf(SK, 2)).toBe('say_translation');
  });

  it("asks a word two cards a session at most: the eve's third waits for the next session", () => {
    expect(pick(dayOf([{ id: 'A', cardsLeft: 3 }]))).toHaveLength(2);
  });

  it(`fills ${SESSION_LENGTH} slots at most`, () => {
    const day = dayOf(Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.7 } })));
    expect(slotsOf(pick(day))).toBe(SESSION_LENGTH);
  });

  it('holds no owed card to the type cap (phase 68 D4): each is a first answer, which can raise the card', () => {
    const day = dayOf(Array.from({ length: 15 }, (_, i) => sayOwed(`g${String(i).padStart(2, '0')}`)));
    expect(pick(day).map((p) => p.dimension)).toEqual(Array(SESSION_LENGTH).fill(SK));
  });

  it('meets owed words to start first, as ladders, each with its say card (phase 67b D4), then asks the owed words', () => {
    const picks = pick(dayOf([{ id: 'g0', chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.7 }, cardsLeft: 1 }, { id: 'g1', toStart: true }]));
    expect(picks).toEqual([
      { glossId: 'g1', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW', ladder: true },
      { glossId: 'g1', dimension: SK, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false },
      { glossId: 'g0', dimension: WP, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false },
    ]);
  });

  it(`meets ${NEW_PER_SESSION} new words a session at most, each with its say card, which fill the session (phase 67b D4)`, () => {
    const owed = (id: string): WordSpec => ({ id, chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.7 }, cardsLeft: 1 });
    const day = dayOf([{ id: 'g0', toStart: true }, { id: 'g1', toStart: true }, { id: 'g2', toStart: true }, owed('g3'), owed('g4')]);
    const picks = pick(day);
    expect(short(picks)).toEqual([
      ['g0', WR, 1],
      ['g1', WR, 1],
      ['g0', SK, 2],
      ['g1', SK, 2],
    ]);
    expect(picks.filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0', 'g1']);
    expect(slotsOf(picks)).toBe(SESSION_LENGTH);
  });

  it('gives no say card to a new word that cannot be said (phase 67b D4)', () => {
    const silent = DIMS.filter((d) => d !== SK);
    const picks = pick(dayOf([{ id: 'g0', toStart: true, live: silent }]));
    expect(short(picks)).toEqual([['g0', WR, 1]]);
  });

  it("starts a known word with a recall card on its first owed skill, no ladder, and no second card that session", () => {
    const picks = pick(dayOf([{ id: 'g0', toStart: true, chances: { [WP]: 0.8, [SP]: 0.9, [SK]: 0.3 } }]), { known: new Set(['g0']) });
    expect(picks).toEqual([{ glossId: 'g0', dimension: SK, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false }]);
  });

  it("starts a family's new meaning with one NEW pick, no ladder, its new_meaning card (phase 60, spec D1)", () => {
    const day = dayOf([
      { id: 'g0', toStart: true },
      { id: 'g1', toStart: true },
    ]);
    const picks = pick(day, { newMeanings: new Set(['g0']) });
    expect(picks).toEqual([
      { glossId: 'g0', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW', ladder: false },
      { glossId: 'g1', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW', ladder: true },
      // Phase 67b (spec D4): the ladder's word is asked its speaking too; the new meaning's is not.
      { glossId: 'g1', dimension: SK, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false },
    ]);
    expect(slotsOf(picks)).toBe(1 + LADDER_SLOTS + 1);
    // Practised, it is known: a recall card.
    expect(pick(day, { newMeanings: new Set(['g0']), known: new Set(['g0']) })[0]).toMatchObject({ glossId: 'g0', dimension: WP, rung: 2, cls: 'TARGET', ladder: false });
  });

  it(`starts a family's new meaning past the session's ${NEW_PER_SESSION} ladders, and early only while the day has room (phase 60)`, () => {
    const owed = dayOf([{ id: 'g0', toStart: true }, { id: 'g1', toStart: true }, { id: 'g2', toStart: true }]);
    expect(pick(owed, { newMeanings: new Set(['g2']) }).map((p) => [p.glossId, p.ladder])).toEqual([
      ['g0', true],
      ['g1', true],
      ['g2', false],
      // Phase 67b (spec D4): the slot left takes g0's say card; g1's waits.
      ['g0', false],
    ]);
    const rest = dayOf([{ id: 'g0', state: 'later' }], 'rest');
    expect(short(pick(rest, { newMeanings: new Set(['g0']) }))).toEqual([['g0', WR, 1]]);
    expect(pick(rest, { newMeanings: new Set(['g0']), newRoom: 0 })).toEqual([]);
  });

  it('carries the main level of its skill, 1 when there is none', () => {
    const picks = pick(dayOf([{ id: 'g0', chances: { [WP]: 0.9, [SP]: 0.5, [SK]: 0.9 }, cardsLeft: 1 }, { id: 'g1', toStart: true }]), {
      levels: new Map([['g0|spelling', 3]]),
    });
    expect(picks.map((p) => [p.glossId, p.level])).toEqual([
      ['g1', 1],
      // Phase 67b (spec D4): g1's say card, at its speaking's level.
      ['g1', 1],
      ['g0', 3],
    ]);
  });

  it('asks one gloss per key', () => {
    const day = dayOf([{ id: 'g0', cardsLeft: 1 }, { id: 'g1', cardsLeft: 1 }]);
    expect(pick(day, { keys: new Map([['g0', 'casa'], ['g1', 'casa']]) }).map((p) => p.glossId)).toEqual(['g0']);
  });

  it('asks nothing when nothing is owed', () => {
    const day = dayOf([{ id: 'g0', state: 'done' }], 'done');
    expect(chooseTargetPicks({ ...base, day, mode: 'owed' })).toEqual([]);
  });
});

describe('chooseTargetPicks, in flight (Review Focus 3)', () => {
  const flight = (glossId: string, ...types: QuestionType[]) => types.map((type) => ({ glossId, type }));

  it("credits an in-flight typed translation: the word's next card is its other owed skill", () => {
    const day = dayOf([{ id: 'A', chances: { [WP]: 0.5, [SP]: 0.9, [SK]: 0.6 } }]);
    expect(short(pick(day))).toEqual([['A', WP, 2], ['A', SK, 2]]);
    expect(short(pick(day, { inFlight: flight('A', 'typed_translation') }))).toEqual([['A', SK, 2]]);
  });

  it('counts an in-flight card on an open skill it does not owe toward its two', () => {
    const day = dayOf([{ id: 'A', chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.9 } }]);
    expect(short(pick(day, { inFlight: flight('A', 'say_translation') }))).toEqual([['A', WP, 2]]);
  });

  it('counts two in-flight cards on one skill once', () => {
    const day = dayOf([{ id: 'A', chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.9 } }]);
    expect(short(pick(day, { inFlight: flight('A', 'typed_translation', 'cloze_typed') }))).toEqual([['A', SP, 1]]);
  });

  it('credits no skill that is not counted: a say card credits nothing for a word that cannot be said', () => {
    const day = dayOf([{ id: 'A', live: [WR, WP, SR, SP], chances: { [WP]: 0.5, [SP]: 0.6 } }]);
    expect(short(pick(day, { inFlight: flight('A', 'say_translation') }))).toEqual([['A', WP, 2], ['A', SP, 1]]);
  });

  it('does not meet again a word whose ladder is in flight', () => {
    const day = dayOf([{ id: 'A', toStart: true }, { id: 'B', toStart: true }]);
    const inFlight = flight('A', 'meet', 'letter_tiles', 'multiple_choice', 'reverse_choice', 'typed_translation');
    const picks = pick(day, { inFlight });
    expect(picks.filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['B']);
    expect(picks.filter((p) => p.glossId === 'A').every((p) => p.cls === 'TARGET' && p.dimension !== WP)).toBe(true);
  });
});

describe('chooseTargetPicks, practice more', () => {
  it('starts the next later words early, then one card per met word, extra ones too, on its weakest counted skill, the lowest readiness first', () => {
    const day = dayOf(
      [
        { id: 'g0', state: 'done', chances: { [WP]: 0.99, [SP]: 0.99, [SK]: 0.95 } },
        { id: 'g1', state: 'extra', chances: { [WP]: 0.6, [SP]: 0.4, [SK]: 0.7 } },
        { id: 'g2', state: 'later' },
        { id: 'g3', state: 'done', chances: { [WP]: 0.8, [SP]: 0.9, [SK]: 0.9 } },
      ],
      'done',
    );
    expect(short(pick(day))).toEqual([
      ['g2', WR, 1],
      // Phase 67b (spec D4): a word met early is asked its speaking in the session that meets it.
      ['g2', SK, 2],
      ['g1', SP, 1],
      ['g3', WP, 2],
      ['g0', SK, 2],
    ]);
  });

  it('reads readiness now when given it: the word lowest now first, on its counted skill weakest now (phase 67b D5)', () => {
    const day = dayOf(
      [
        // At the start of today g0 was the weaker; since then it rose and g1 dropped.
        { id: 'g0', state: 'done', chances: { [WP]: 0.3, [SP]: 0.3, [SK]: 0.3 } },
        { id: 'g1', state: 'done', chances: { [WP]: 0.9, [SP]: 0.9, [SK]: 0.9 } },
      ],
      'done',
    );
    const now = new Map([
      ['g0', { pct: 96, counted: [SP, WP, SK] as Dimension[] }],
      ['g1', { pct: 40, counted: [WP, SP, SK] as Dimension[] }],
    ]);
    expect(short(pick(day, { now }))).toEqual([
      ['g1', WP, 2],
      ['g0', SP, 1],
    ]);
  });

  it('asks only words below their bar while any is: a word at its bar counts 100, so a right adds nothing and a miss lowers it (phase 67b D5)', () => {
    const day = dayOf(
      [
        { id: 'g0', state: 'done', chances: { [WP]: 0.95, [SP]: 0.95, [SK]: 0.95 } },
        { id: 'g1', state: 'done', chances: { [WP]: 0.6, [SP]: 0.6, [SK]: 0.6 } },
      ],
      'done',
    );
    const now = new Map([
      ['g0', { pct: 100, counted: [WP, SP, SK] as Dimension[] }],
      ['g1', { pct: 60, counted: [SP, WP, SK] as Dimension[] }],
    ]);
    expect(short(pick(day, { now }))).toEqual([['g1', SP, 1]]);
    // Every word at its bar: practice more still asks them.
    const all = new Map([...now].map(([glossId, value]) => [glossId, { ...value, pct: 100 }]));
    expect(pick(day, { now: all }).map((p) => p.glossId)).toEqual(['g0', 'g1']);
  });

  it("before the eve asks first the words whose weakest skill is still open today: only those can move (review C1)", () => {
    const day = dayOf(
      [
        { id: 'g0', state: 'done', chances: { [WP]: 0.3, [SP]: 0.9, [SK]: 0.9 } },
        { id: 'g1', state: 'done', chances: { [WP]: 0.6, [SP]: 0.9, [SK]: 0.9 } },
      ],
      'done',
    );
    // g0 is the lower, but its weakest skill was answered today; g1's is still open.
    const now = new Map([
      ['g0', { pct: 30, counted: [WP, SP, SK] as Dimension[], weakestOpen: false }],
      ['g1', { pct: 60, counted: [WP, SP, SK] as Dimension[], weakestOpen: true }],
    ]);
    expect(pick(day, { now }).map((p) => p.glossId)).toEqual(['g1', 'g0']);
  });

  it('asks every word on the due date, at its bar too: the card is frozen, so the bar filter does not apply (review I1)', () => {
    const day = dayOf(
      [
        { id: 'g0', state: 'done', chances: { [WP]: 0.99, [SP]: 0.99, [SK]: 0.99 } },
        { id: 'g1', state: 'done', chances: { [WP]: 0.5, [SP]: 0.5, [SK]: 0.5 } },
      ],
      'due_today',
    );
    const now = new Map([
      ['g0', { pct: 100, counted: [WP, SP, SK] as Dimension[], weakestOpen: true }],
      ['g1', { pct: 50, counted: [WP, SP, SK] as Dimension[], weakestOpen: true }],
    ]);
    expect(pick(day, { now }).map((p) => p.glossId).sort()).toEqual(['g0', 'g1']);
  });

  it("asks a test's word only its counted skills now: no speaking (phase 67b D5)", () => {
    const day = dayOf([{ id: 'g0', state: 'done', chances: { [WP]: 0.9, [SP]: 0.9, [SK]: 0.1 } }], 'done');
    const now = new Map([['g0', { pct: 80, counted: [SP, WP] as Dimension[] }]]);
    expect(short(pick(day, { now }))).toEqual([['g0', SP, 1]]);
  });

  it('asks a skill not asked today before its weakest, so a second practice-more session asks another card (final review 3)', () => {
    const day = dayOf([{ id: 'g0', state: 'done', chances: { [WP]: 0.5, [SP]: 0.9, [SK]: 0.6 }, asked: [WP, SK] }], 'done');
    expect(short(pick(day))).toEqual([['g0', SP, 1]]);
    const all = dayOf([{ id: 'g0', state: 'done', chances: { [WP]: 0.5, [SP]: 0.9, [SK]: 0.6 }, asked: [WP, SP, SK] }], 'done');
    expect(short(pick(all))).toEqual([['g0', WP, 2]]);
  });

  it('starts a known later word with a recall card', () => {
    const day = dayOf([{ id: 'g0', state: 'later' }], 'rest');
    expect(short(pick(day, { known: new Set(['g0']) }))).toEqual([['g0', WP, 2]]);
  });

  it('asks a word with a card in flight last', () => {
    const day = dayOf([{ id: 'g0', state: 'done' }, { id: 'g1', state: 'done' }], 'done');
    expect(pick(day, { inFlight: [{ glossId: 'g0', type: 'typed_translation' }] }).map((p) => p.glossId)).toEqual(['g1', 'g0']);
  });

  /** Six done words whose weakest counted skill is speaking, then spelling. `open`: whether that
   *  weakest skill is still unanswered today. */
  const sixDone = (open: boolean) => {
    const day = dayOf(
      Array.from({ length: 6 }, (_, i): WordSpec => ({ id: `g${i}`, state: 'done', chances: { [WP]: 0.9, [SP]: 0.8, [SK]: 0.5 }, asked: open ? [] : [SK, WP] })),
      'done',
    );
    const now = new Map(day.words.map((word) => [word.glossId, { pct: 50, counted: [SK, SP, WP] as Dimension[], weakestOpen: open }]));
    return { day, now };
  };

  it(`holds say cards to ${MAX_PER_TYPE} a session where the card cannot rise: past it, a read aloud (phase 68 D4)`, () => {
    const { day, now } = sixDone(false);
    expect(short(pick(day, { now }))).toEqual([
      ['g0', SK, 2],
      ['g1', SK, 2],
      ['g2', SK, 2],
      ['g3', SK, 2],
      ['g4', SK, 1],
      ['g5', SK, 1],
    ]);
  });

  it(`passes a say card past ${MAX_PER_TYPE} read alouds too to its next skill answered today`, () => {
    const day = dayOf(Array.from({ length: 10 }, (_, i): WordSpec => ({ id: `g${i}`, state: 'done', asked: [SK, WP] })), 'done');
    const now = new Map(day.words.map((word) => [word.glossId, { pct: 50, counted: [SK, SP, WP] as Dimension[], weakestOpen: false }]));
    expect(short(pick(day, { now })).map(([, d, r]) => `${d}:${r}`)).toEqual([...Array(4).fill(`${SK}:2`), ...Array(4).fill(`${SK}:1`), `${WP}:2`, `${WP}:2`]);
  });

  it('never moves a card onto a skill still open today, whose first answer would count: with none answered, it keeps its card', () => {
    const day = dayOf(Array.from({ length: 6 }, (_, i): WordSpec => ({ id: `g${i}`, state: 'done', chances: { [WP]: 0.9, [SP]: 0.5, [SK]: 0.8 }, asked: [SP] })), 'done');
    const now = new Map(day.words.map((word) => [word.glossId, { pct: 50, counted: [SP, SK, WP] as Dimension[], weakestOpen: false }]));
    expect(pick(day, { now }).map((p) => p.dimension)).toEqual(Array(6).fill(SP));
  });

  it('never moves a card that can raise the card: a weakest skill still open today, or any card on the eve', () => {
    const open = sixDone(true);
    expect(pick(open.day, { now: open.now }).map((p) => p.dimension)).toEqual(Array(6).fill(SK));
    const eve = sixDone(false);
    expect(pick({ ...eve.day, daysLeft: 1 }, { now: eve.now }).map((p) => p.dimension)).toEqual(Array(6).fill(SK));
  });

  it(`holds spelling to ${MAX_PER_TYPE} too, and writing not at all: it has three recall cards`, () => {
    const day = dayOf(Array.from({ length: 6 }, (_, i): WordSpec => ({ id: `g${i}`, state: 'done', asked: [SP, WP] })), 'done');
    const shut = (counted: Dimension[]) => new Map(day.words.map((word) => [word.glossId, { pct: 50, counted, weakestOpen: false }]));
    expect(pick(day, { now: shut([SP, WP, SK]) }).map((p) => p.dimension)).toEqual([SP, SP, SP, SP, WP, WP]);
    expect(pick(day, { now: shut([WP, SP, SK]) }).map((p) => p.dimension)).toEqual(Array(6).fill(WP));
  });

  it(`holds the due date's last review to ${MAX_PER_TYPE} a type: its card is frozen, nothing raises it`, () => {
    const { day, now } = sixDone(true);
    expect(short(pick({ ...day, state: 'due_today', daysLeft: 0 }, { now })).map(([, d, r]) => `${d}:${r}`)).toEqual([...Array(4).fill(`${SK}:2`), `${SK}:1`, `${SK}:1`]);
  });
});

// Phase 68 (spec D3). The open step-downs come first in every mode, each a relearn pick on its
// skill at that skill's rung, outside the session's slots, at most STEP_DOWNS_PER_SESSION.
describe('chooseTargetPicks, step-downs (phase 68)', () => {
  /** A step-down asked on top of the session: practice, whose cards count nothing. */
  const practice = (glossId: string, dimension: Dimension): ChosenPick => ({
    glossId,
    dimension,
    rung: dimension === SP ? 1 : 2,
    level: 1,
    r: 1,
    cls: 'TARGET',
    ladder: false,
    relearn: 'practice',
  });
  const steps = (...keys: string[]) => keys.map((key) => ({ glossId: key.split('|')[0], dimension: key.split('|')[1] as Dimension }));

  it("asks one on top, outside the slots, when the session asks its word nothing on that skill: a full owed session keeps every card", () => {
    const owed = Array.from({ length: 8 }, (_, i): WordSpec => ({ id: `g${i}`, chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.7 } }));
    const day = dayOf([{ id: 'A', state: 'done' }, ...owed]);
    const without = pick(day);
    const picks = pick(day, { stepDowns: steps(`A|${WP}`) });
    expect(picks).toEqual([...without, practice('A', WP)]);
    expect(slotsOf(without)).toBe(SESSION_LENGTH);
  });

  it("makes the session's own card of its word on that skill its last, which counts as it would have (final review)", () => {
    const day = dayOf([{ id: 'A', chances: { [WP]: 0.5, [SP]: 0.99, [SK]: 0.6 } }]);
    const without = pick(day);
    expect(short(without)).toEqual([
      ['A', WP, 2],
      ['A', SK, 2],
    ]);
    expect(pick(day, { stepDowns: steps(`A|${WP}`) })).toEqual([{ ...without[0], relearn: 'counts' }, without[1]]);
  });

  it('leaves every other card of the session as it was, in practice more and on the last review too', () => {
    const words: WordSpec[] = [
      { id: 'A', state: 'done', chances: { [WP]: 0.5, [SP]: 0.9, [SK]: 0.9 } },
      { id: 'B', state: 'done', chances: { [WP]: 0.6, [SP]: 0.9, [SK]: 0.9 } },
    ];
    for (const state of ['done', 'due_today'] as const) {
      expect(short(pick(dayOf(words, state), { stepDowns: steps(`A|${SK}`) }))).toEqual([
        ['A', WP, 2],
        ['B', WP, 2],
        ['A', SK, 2],
      ]);
    }
  });

  it(`asks at most ${STEP_DOWNS_PER_SESSION} a session, in the order given`, () => {
    // An owed day whose words are all done: the session asks nothing of its own.
    const day = dayOf(['A', 'B', 'C', 'D', 'E'].map((id): WordSpec => ({ id, state: 'done' })));
    const picks = pick(day, { stepDowns: steps(`D|${WP}`, `B|${SK}`, `E|${SP}`, `A|${WP}`, `C|${WP}`) });
    expect(picks.filter((p) => p.relearn)).toEqual([practice('D', WP), practice('B', SK), practice('E', SP)]);
  });

  it('asks a word one step-down a session: its other waits for the next, so no card is seen or picked twice', () => {
    const day = dayOf([{ id: 'A', state: 'done' }, { id: 'B', state: 'done' }]);
    const picks = pick(day, { stepDowns: steps(`A|${WP}`, `A|${SK}`, `B|${WP}`) });
    expect(picks.filter((p) => p.relearn)).toEqual([practice('A', WP), practice('B', WP)]);
  });

  it('drops one whose word is not in the day, or whose skill the word does not practise', () => {
    const silent = DIMS.filter((d) => d !== SK);
    const day = dayOf([{ id: 'A', state: 'done', live: silent }], 'done');
    expect(pick(day, { stepDowns: steps(`gone|${WP}`, `A|${SK}`) }).filter((p) => p.relearn)).toEqual([]);
  });

  it("drops one whose word's key another word of the session holds", () => {
    const day = dayOf([{ id: 'A', state: 'done' }, { id: 'B', cardsLeft: 1 }]);
    const keys = new Map([
      ['A', 'לדעת'],
      ['B', 'לדעת'],
    ]);
    expect(pick(day, { keys, stepDowns: steps(`A|${WP}`) }).filter((p) => p.relearn)).toEqual([]);
  });
});

// Phase 65b (spec D2). Past the day's budget a session asks the owed work first, then fills with
// practice more, so a session never ends after one owed card.
describe('chooseTargetPicks, past the budget', () => {
  const day = dayOf([
    { id: 'g0', chances: { [WP]: 0.5, [SP]: 0.9, [SK]: 0.9 }, cardsLeft: 1 },
    { id: 'g1', state: 'done', chances: { [WP]: 0.99, [SP]: 0.99, [SK]: 0.99 } },
    { id: 'g2', state: 'done', chances: { [WP]: 0.99, [SP]: 0.99, [SK]: 0.4 } },
    { id: 'g3', state: 'later' },
  ]);

  it('asks only the owed card in owed mode, as before the budget', () => {
    expect(short(pick(day))).toEqual([['g0', WP, 2]]);
  });

  it('asks the owed card first, then the practice more cards, in one session', () => {
    const picks = pick(day, { mode: 'past_budget' });
    expect(short(picks)[0]).toEqual(['g0', WP, 2]);
    expect(picks.map((p) => p.glossId)).toEqual(expect.arrayContaining(['g1', 'g2', 'g3']));
  });

  it('stays within a session: owed work and the fill share one slot count', () => {
    const many = dayOf(Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, state: i < 4 ? ('owed' as const) : ('done' as const), chances: { [WP]: 0.5, [SP]: 0.6, [SK]: 0.9 } })));
    const owedOnly = pick(many);
    const picks = pick(many, { mode: 'past_budget' });
    expect(slotsOf(picks)).toBeLessThanOrEqual(SESSION_LENGTH);
    expect(picks.length).toBeGreaterThan(owedOnly.length);
    expect(picks.slice(0, owedOnly.length)).toEqual(owedOnly);
  });

  it('asks as practice more when nothing is owed', () => {
    const done = dayOf([{ id: 'g1', state: 'done' }, { id: 'g3', state: 'later' }], 'done');
    expect(pick(done, { mode: 'past_budget' })).toEqual(pick(done, { mode: 'more' }));
  });

  it("records the day's owed words for the stock's stale check, as owed mode does", () => {
    expect(owedWords(day, 'past_budget')).toEqual(owedWords(day, 'owed'));
    expect(owedWords(day, 'past_budget')).toEqual(['g0']);
  });
});

// Ruling T3-n (spec D8).
describe("chooseTargetPicks, the day's room for new words", () => {
  it('starts early only as many new words as the day has room for, and known ones whatever it says', () => {
    const day = dayOf([{ id: 'g0', state: 'later' }, { id: 'g1', state: 'later' }, { id: 'g2', state: 'later' }], 'rest');
    expect(pick(day).filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0', 'g1']);
    expect(pick(day, { newRoom: 1 }).filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0']);
    expect(pick(day, { newRoom: 0 }).filter((p) => p.ladder)).toEqual([]);
    expect(short(pick(day, { newRoom: 0, known: new Set(['g1']) }))).toEqual([['g1', WP, 2]]);
  });

  it('never holds an owed start back', () => {
    const day = dayOf([{ id: 'g0', toStart: true }, { id: 'g1', toStart: true }]);
    expect(pick(day, { newRoom: 0 }).filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0', 'g1']);
  });
});

describe('chooseTargetPicks, last review', () => {
  it('asks one card per word on the date, its weakest counted skill, the lowest readiness first', () => {
    const day = dayOf(
      [
        { id: 'g0', state: 'done', chances: { [WP]: 0.99, [SP]: 0.99, [SK]: 0.95 } },
        { id: 'g1', state: 'done', chances: { [WP]: 0.7, [SP]: 0.9, [SK]: 0.9 } },
      ],
      'due_today',
    );
    expect(short(pick(day))).toEqual([
      ['g1', WP, 2],
      ['g0', SK, 2],
    ]);
  });

  it('meets a word never met, so the morning can still help', () => {
    const day = dayOf([{ id: 'g0', state: 'later' }], 'due_today');
    expect(pick(day).map((p) => [p.glossId, p.ladder])).toEqual([['g0', true]]);
  });
});

// Phase 53 (ruling R-D12), phase 57 (spec D2, final review C1). A target path's stock is checked
// against today's choice before it is played when it was chosen on an earlier day, or chosen as
// practice more: the session it was chosen beside can end with a miss and leave work owed.
describe('stockToCheck', () => {
  it.each<[string, { chosenOn: string; owedGlossIds: string[] }, boolean]>([
    ['chosen on an earlier day', { chosenOn: '2026-10-15', owedGlossIds: ['g0'] }, true],
    ['chosen today as practice more, owing nothing', { chosenOn: '2026-10-16', owedGlossIds: [] }, true],
    ['chosen today for owed work', { chosenOn: '2026-10-16', owedGlossIds: ['g0'] }, false],
  ])('a stock %s: %s', (_, stock, checked) => {
    expect(stockToCheck(stock, '2026-10-16')).toBe(checked);
  });
});

describe('stockServes', () => {
  const today = { capHalves: 10, owedGlossIds: ['g0', 'g1'] };
  it.each<[string, { capHalves: number; owedGlossIds: string[] } | undefined, boolean]>([
    ['the same cap and owed words', { capHalves: 10, owedGlossIds: ['g0', 'g1'] }, true],
    ['another cap', { capHalves: 8, owedGlossIds: ['g0', 'g1'] }, false],
    ['other owed words', { capHalves: 10, owedGlossIds: ['g0'] }, false],
    ['no owed word: practice more, while work is owed again', { capHalves: 10, owedGlossIds: [] }, false],
    ['nothing recorded', undefined, false],
  ])('a stock that recorded %s: %s', (_, recorded, serves) => {
    expect(stockServes(recorded, today)).toBe(serves);
  });

  it('never serves a stock chosen past the budget again: checked, it was chosen on an earlier day (final review 2)', () => {
    expect(stockServes({ capHalves: 10, owedGlossIds: ['g0', 'g1'], pastBudget: true }, today)).toBe(false);
  });

  it('keeps a practice-more stock while practice more is still the choice', () => {
    expect(stockServes({ capHalves: 10, owedGlossIds: [] }, { capHalves: 10, owedGlossIds: [] })).toBe(true);
  });

  it('serves only while it asks the step-downs today asks (phase 68 D6); none recorded reads as none', () => {
    const owed = { capHalves: 10, owedGlossIds: ['g0', 'g1'] };
    expect(stockServes({ ...owed, stepDowns: ['g0|written_productive'] }, { ...owed, stepDowns: ['g0|written_productive'] })).toBe(true);
    expect(stockServes({ ...owed, stepDowns: [] }, { ...owed, stepDowns: ['g0|written_productive'] })).toBe(false);
    expect(stockServes(owed, { ...owed, stepDowns: [] })).toBe(true);
    expect(sameStepDowns(undefined, { stepDowns: ['g0|spelling'] })).toBe(false);
    expect(stepDownKeys([
      { glossId: 'g1', dimension: SK, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false, relearn: 'practice' },
      { glossId: 'g0', dimension: WP, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false },
      { glossId: 'g0', dimension: SP, rung: 1, level: 1, r: 1, cls: 'TARGET', ladder: false, relearn: 'counts' },
    ])).toEqual([`g0|${SP}`, `g1|${SK}`]);
  });
});

// Phase 68 (spec D5, ruling). A target session gets a matching board when none of its cards can
// raise the card today.
describe('boardsSession', () => {
  const card = (glossId: string, dimension: Dimension, cls: ChosenPick['cls'] = 'TARGET'): ChosenPick => ({
    glossId,
    dimension,
    rung: 2,
    level: 1,
    r: cls === 'NEW' ? null : 1,
    cls,
    ladder: cls === 'NEW',
  });
  const now = new Map([
    ['g0', { pct: 50, counted: [SK, WP] as Dimension[], weakestOpen: false }],
    ['g1', { pct: 50, counted: [WP, SK] as Dimension[], weakestOpen: true }],
  ]);

  it('boards a session none of whose cards can raise the card: a weakest skill answered today, before the eve', () => {
    expect(boardsSession([card('g0', SK), card('g1', SK)], { daysLeft: 3, now })).toBe(true);
  });

  it('does not board one with a card that can: a weakest skill still open, the eve, or a meeting', () => {
    expect(boardsSession([card('g0', SK), card('g1', WP)], { daysLeft: 3, now })).toBe(false);
    expect(boardsSession([card('g0', SK)], { daysLeft: 1, now })).toBe(false);
    expect(boardsSession([card('g0', SK), card('g2', WR, 'NEW')], { daysLeft: 3, now })).toBe(false);
  });

  it('boards one whose only card that could raise it is a practice step-down, which counts nothing (final review)', () => {
    expect(boardsSession([card('g0', SK), { ...card('g1', WP), relearn: 'practice' }], { daysLeft: 3, now })).toBe(true);
    expect(boardsSession([card('g0', SK), { ...card('g1', WP), relearn: 'counts' }], { daysLeft: 3, now })).toBe(false);
  });

  it('boards the due date, whose card is frozen, and never without readiness now', () => {
    expect(boardsSession([card('g1', WP)], { daysLeft: 0, now })).toBe(true);
    expect(boardsSession([card('g0', SK)], { daysLeft: 3, now: undefined })).toBe(false);
  });
});

// Phase 67b fix (Victor's test, 2026-10-21). A practice-more stock is chosen beside the session in
// flight, so it can miss the one card that can still raise the card once that session ends.
describe('raisesCard and picksOfCards: can a session still raise the card today', () => {
  const now = new Map([
    // Below its bar, its weakest skill (spelling) not answered today.
    ['g0', { pct: 60, counted: [SP, WP] as Dimension[], weakestOpen: true }],
    // Below its bar, its weakest skill (writing) answered today already.
    ['g1', { pct: 83, counted: [WP, SP] as Dimension[], weakestOpen: false }],
    // At its bar.
    ['g2', { pct: 100, counted: [WP, SP] as Dimension[], weakestOpen: true }],
  ]);
  const raises = (picks: Parameters<typeof raisesCard>[0], daysLeft = 3) => raisesCard(picks, { daysLeft, now });

  it('a card that meets a word can raise the card', () => {
    expect(raises([{ glossId: 'g9', dimension: null, meets: true }])).toBe(true);
  });

  it("before the eve only a card on a word's weakest skill, still open today, below its bar, can", () => {
    expect(raises([{ glossId: 'g0', dimension: SP, meets: false }])).toBe(true);
    expect(raises([{ glossId: 'g0', dimension: WP, meets: false }])).toBe(false);
    expect(raises([{ glossId: 'g1', dimension: WP, meets: false }])).toBe(false);
    expect(raises([{ glossId: 'g2', dimension: WP, meets: false }])).toBe(false);
    expect(raises([{ glossId: 'g1', dimension: WP, meets: false }, { glossId: 'g0', dimension: SP, meets: false }])).toBe(true);
  });

  it("on the eve a card on a word's weakest skill can, answered today or not", () => {
    expect(raises([{ glossId: 'g1', dimension: WP, meets: false }], 1)).toBe(true);
    expect(raises([{ glossId: 'g1', dimension: SP, meets: false }], 1)).toBe(false);
  });

  it('assumes a card can when readiness now is not read', () => {
    expect(raisesCard([{ glossId: 'g1', dimension: WP, meets: false }], { daysLeft: 3, now: undefined })).toBe(true);
  });

  it("reads a session's cards: a meet card meets its word, a card asks the skill its type serves, a read aloud none", () => {
    expect(
      picksOfCards([
        { glossId: 'g0', type: 'meet', intro: true },
        { glossId: 'g0', type: 'dictation', intro: false },
        { glossId: 'g1', type: 'read_aloud', intro: true },
        { glossId: 'g2', type: 'new_meaning', intro: false },
      ]),
    ).toEqual([
      { glossId: 'g0', dimension: null, meets: true },
      { glossId: 'g0', dimension: SP, meets: false },
      { glossId: 'g1', dimension: null, meets: false },
      { glossId: 'g2', dimension: null, meets: true },
    ]);
  });
});
