import { describe, expect, it } from '@jest/globals';

import { SESSION_LENGTH, type Dimension, type QuestionType } from '@lang-tutor/core/domain';

import type { ChosenPick } from './choose';
import { LADDER_SLOTS, NEW_PER_SESSION, TARGET_SPEAKING_PER_SESSION } from './chooseConstants';
import { targetDay, type TargetDay, type WordDay } from './targetDay';
import { chooseTargetPicks, owedWords, stockServes, stockToCheck, targetMode, type TargetMode, type TargetPickInput } from './targetPicker';
import type { TargetSkillRow } from './targetSkills';

const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SR: Dimension = 'spoken_receptive';
const SP: Dimension = 'spelling';
const SK: Dimension = 'spoken_productive';
const DIMS: Dimension[] = [WR, WP, SR, SP, SK];

/** A word of a hand-built day: its halves per live skill (0 when absent), its state, whether it
 *  is to start and its next-day checks. An owed started word owes its skills below the cap. */
type WordSpec = {
  id: string;
  halves?: Partial<Record<Dimension, number>>;
  state?: WordDay['state'];
  toStart?: boolean;
  checks?: Dimension[];
  live?: Dimension[];
};

function dayOf(cap: number, specs: WordSpec[], state: TargetDay['state'] = 'owed'): TargetDay {
  const words = specs.map((spec): WordDay => {
    const skills = (spec.live ?? DIMS).map((dimension) => ({ dimension, halves: spec.halves?.[dimension] ?? 0 }));
    const toStart = spec.toStart ?? false;
    const wordState = spec.state ?? 'owed';
    const owed = wordState === 'owed' && !toStart ? skills.filter((s) => s.halves < cap).map((s) => s.dimension) : [];
    return { glossId: spec.id, state: wordState, toStart, owed, checks: spec.checks ?? [], readinessPct: 0, startsIn: null, skills };
  });
  return {
    daysLeft: state === 'due_today' ? 0 : 1,
    capHalves: cap,
    state,
    planned: 0,
    done: 0,
    extra: 0,
    nextPracticeIn: null,
    readinessPct: 0,
    readyCount: 0,
    words,
  };
}

const at = (halves: number, over: Partial<Record<Dimension, number>> = {}) => ({
  ...Object.fromEntries(DIMS.map((d) => [d, halves])),
  ...over,
});

const base: Omit<TargetPickInput, 'day' | 'mode'> = {
  levels: new Map(),
  known: new Set(),
  newMeanings: new Set(),
  keys: new Map(),
  inFlight: [],
};

const pick = (day: TargetDay, over: Partial<TargetPickInput> = {}) =>
  chooseTargetPicks({ ...base, day, mode: targetMode(day), ...over });

const short = (picks: ChosenPick[]) => picks.map((p) => [p.glossId, p.dimension, p.rung]);
const slotsOf = (picks: ChosenPick[]) => picks.reduce((sum, p) => sum + (p.ladder ? LADDER_SLOTS : 1), 0);

describe('targetMode', () => {
  const cases: [TargetDay['state'], TargetMode][] = [
    ['owed', 'owed'],
    ['due_today', 'last_review'],
    ['done', 'more'],
    ['rest', 'more'],
  ];
  it.each(cases)('a day %s is asked in mode %s', (state, mode) => {
    expect(targetMode(dayOf(20, [], state))).toBe(mode);
  });
});

describe('chooseTargetPicks, owed', () => {
  it('the 2026-10-16 replay asks spelling and speaking, never written receptive', () => {
    // Six words, due tomorrow, all started today: written skills and listening at the cap,
    // spelling and speaking below it.
    const D0 = '2026-10-16';
    const ids = Array.from({ length: 6 }, (_, i) => `g${i}`);
    const skills: TargetSkillRow[] = ids.flatMap((glossId) =>
      DIMS.map((dimension) => ({
        targetId: 't',
        glossId,
        dimension,
        halves: dimension === SP ? 12 : dimension === SK ? 8 : 20,
        sessionId: 's',
        day: D0,
      })),
    );
    const day = targetDay({
      today: D0,
      createdOn: D0,
      dueOn: '2026-10-17',
      words: ids.map((glossId) => ({ glossId, addedOn: D0, startedOn: D0, live: DIMS })),
      skills,
      rightToday: new Set(),
      answeredToday: true,
    });
    expect(day.state).toBe('owed');

    const picks = pick(day);
    expect(picks.some((p) => p.dimension === WR)).toBe(false);
    // Speaking is furthest below the cap: the first three words take it, the rest spelling,
    // then each word its other owed skill while speaking has room.
    expect(short(picks)).toEqual([
      ['g0', SK, 2],
      ['g1', SK, 2],
      ['g2', SK, 2],
      ['g3', SP, 2],
      ['g4', SP, 2],
      ['g5', SP, 2],
      ['g0', SP, 2],
      ['g1', SP, 2],
      ['g2', SP, 2],
    ]);
    expect(picks.every((p) => p.cls === 'TARGET' && !p.ladder && p.r === 1)).toBe(true);
  });

  it('a skill at 0 is asked at rung 1, a skill above it at rung 2', () => {
    const zero = pick(dayOf(20, [{ id: 'g0', halves: at(20, { [WP]: 0 }) }]));
    expect(short(zero)).toEqual([['g0', WP, 1]]);
    const some = pick(dayOf(20, [{ id: 'g0', halves: at(20, { [WP]: 4 }) }]));
    expect(short(some)).toEqual([['g0', WP, 2]]);
  });

  it('speaking is always rung 2, even at 0', () => {
    expect(short(pick(dayOf(20, [{ id: 'g0', halves: at(20, { [SK]: 0 }) }])))).toEqual([['g0', SK, 2]]);
  });

  it('a word takes two picks at most, for different skills, each moving skills the other does not', () => {
    // All five at 0: the tie goes to the skill whose recall card moves the most owed skills
    // (typed translation: three), the earlier in ORDER between written productive and
    // spelling; the second to the skill furthest below that the first card leaves, listening
    // (dictation moves it and spelling) ahead of speaking by ORDER.
    const picks = pick(dayOf(20, [{ id: 'g0', halves: at(0) }]));
    expect(short(picks)).toEqual([
      ['g0', WP, 1],
      ['g0', SR, 1],
    ]);
  });

  it('a word furthest below the cap is asked first', () => {
    const picks = pick(
      dayOf(20, [
        { id: 'g0', halves: at(20, { [SP]: 16 }) },
        { id: 'g1', halves: at(20, { [SP]: 4 }) },
      ]),
    );
    expect(picks.map((p) => p.glossId)).toEqual(['g1', 'g0']);
  });

  it(`four words owing speaking are cut to ${TARGET_SPEAKING_PER_SESSION} speaking picks`, () => {
    const day = dayOf(
      20,
      ['g0', 'g1', 'g2', 'g3'].map((id) => ({ id, halves: at(20, { [SK]: 8 }) })),
    );
    const picks = pick(day);
    expect(picks.filter((p) => p.dimension === SK)).toHaveLength(TARGET_SPEAKING_PER_SESSION);
    expect(picks.map((p) => p.glossId)).toEqual(['g0', 'g1', 'g2']);
  });

  it('speaking past its limit gives way to the next owed skill', () => {
    const day = dayOf(
      20,
      ['g0', 'g1', 'g2', 'g3'].map((id) => ({ id, halves: at(20, { [SK]: 4, [SP]: 12 }) })),
    );
    expect(short(pick(day)).slice(0, 4)).toEqual([
      ['g0', SK, 2],
      ['g1', SK, 2],
      ['g2', SK, 2],
      ['g3', SP, 2],
    ]);
  });

  it('owed words to start come before owed skills, as ladders', () => {
    const picks = pick(
      dayOf(20, [
        { id: 'g0', halves: at(20, { [WP]: 8 }) },
        { id: 'g1', toStart: true },
      ]),
    );
    expect(picks).toEqual([
      { glossId: 'g1', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW', ladder: true },
      { glossId: 'g0', dimension: WP, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false },
    ]);
  });

  it(`starts ${NEW_PER_SESSION} new words a session at most, and fills the rest`, () => {
    const day = dayOf(20, [
      { id: 'g0', toStart: true },
      { id: 'g1', toStart: true },
      { id: 'g2', toStart: true },
      { id: 'g3', halves: at(20, { [WP]: 8 }) },
      { id: 'g4', halves: at(20, { [WP]: 8 }) },
      { id: 'g5', halves: at(20, { [WP]: 8 }) },
    ]);
    const picks = pick(day);
    expect(picks.filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0', 'g1']);
    expect(picks.filter((p) => !p.ladder).map((p) => p.glossId)).toEqual(['g3', 'g4']);
    expect(slotsOf(picks)).toBe(SESSION_LENGTH);
  });

  it('a known word starts with a recall card, no ladder', () => {
    const picks = pick(dayOf(20, [{ id: 'g0', toStart: true }]), { known: new Set(['g0']) });
    expect(picks).toEqual([{ glossId: 'g0', dimension: WP, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false }]);
  });

  it("a family's new meaning starts with one NEW pick, no ladder, its new_meaning card (phase 60, spec D1)", () => {
    const day = dayOf(20, [
      { id: 'g0', toStart: true },
      { id: 'g1', toStart: true },
    ]);
    const picks = pick(day, { newMeanings: new Set(['g0']) });
    expect(picks).toEqual([
      { glossId: 'g0', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW', ladder: false },
      { glossId: 'g1', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW', ladder: true },
    ]);
    expect(slotsOf(picks)).toBe(1 + LADDER_SLOTS);
    // Practised (a missed new_meaning leaves an Again row), it is known: a recall card.
    expect(pick(day, { newMeanings: new Set(['g0']), known: new Set(['g0']) })[0]).toEqual({
      glossId: 'g0',
      dimension: WP,
      rung: 2,
      level: 1,
      r: 1,
      cls: 'TARGET',
      ladder: false,
    });
  });

  it(`starts a family's new meaning past the session's ${NEW_PER_SESSION} ladders, and early only while the day has room (phase 60)`, () => {
    const owed = dayOf(20, [{ id: 'g0', toStart: true }, { id: 'g1', toStart: true }, { id: 'g2', toStart: true }]);
    const picks = pick(owed, { newMeanings: new Set(['g2']) });
    expect(picks.map((p) => [p.glossId, p.ladder])).toEqual([
      ['g0', true],
      ['g1', true],
      ['g2', false],
    ]);
    const rest = dayOf(12, [{ id: 'g0', state: 'later' }], 'rest');
    expect(short(pick(rest, { newMeanings: new Set(['g0']) }))).toEqual([['g0', WR, 1]]);
    expect(pick(rest, { newMeanings: new Set(['g0']), newRoom: 0 })).toEqual([]);
  });

  it('next-day checks come after below-cap work, at rung 2, as few cards as cover them', () => {
    const picks = pick(
      dayOf(20, [
        { id: 'g0', halves: at(20), checks: DIMS },
        { id: 'g1', halves: at(20, { [WP]: 8 }) },
      ]),
    );
    expect(short(picks)).toEqual([
      ['g1', WP, 2],
      ['g0', WP, 2],
      ['g0', SK, 2],
    ]);
  });

  it('a pick carries the main level of its skill, 1 when there is none', () => {
    const picks = pick(dayOf(20, [{ id: 'g0', halves: at(20, { [SP]: 8 }) }, { id: 'g1', toStart: true }]), {
      levels: new Map([['g0|spelling', 3]]),
    });
    expect(picks.map((p) => [p.glossId, p.level])).toEqual([
      ['g1', 1],
      ['g0', 3],
    ]);
  });

  it('asks one gloss per key', () => {
    const day = dayOf(20, [
      { id: 'g0', halves: at(20, { [SP]: 8 }) },
      { id: 'g1', halves: at(20, { [SP]: 8 }) },
    ]);
    const picks = pick(day, { keys: new Map([['g0', 'casa'], ['g1', 'casa']]) });
    expect(picks.map((p) => p.glossId)).toEqual(['g0']);
  });

  it('with nothing owed the result is empty', () => {
    const day = dayOf(20, [{ id: 'g0', state: 'done', halves: at(20) }], 'done');
    expect(chooseTargetPicks({ ...base, day, mode: 'owed' })).toEqual([]);
  });
});

describe('chooseTargetPicks, in flight', () => {
  const flight = (glossId: string, ...types: QuestionType[]) => types.map((type) => ({ glossId, type }));

  it("credits the in-flight session's typed translation, so word A's speaking comes next", () => {
    const day = dayOf(20, [{ id: 'A', halves: at(20, { [WP]: 16, [SP]: 16, [SK]: 16 }) }]);
    expect(short(pick(day))[0]).toEqual(['A', WP, 2]);
    expect(short(pick(day, { inFlight: flight('A', 'typed_translation') }))).toEqual([['A', SK, 2]]);
  });

  it('credits one change per skill, the recall points when any card was recall', () => {
    // Two recognition cards on written productive give +2 once: 12 → 14, still below 16.
    const day = dayOf(16, [{ id: 'A', halves: at(16, { [WP]: 12 }) }]);
    const twice = pick(day, { inFlight: flight('A', 'reverse_choice', 'reverse_choice') });
    expect(short(twice)).toEqual([['A', WP, 2]]);
    // A recall card among them gives +4, to the cap: written productive is no longer owed.
    expect(pick(day, { inFlight: flight('A', 'typed_translation', 'reverse_choice') })).toEqual([]);
  });

  it('credits no skill that is not live', () => {
    // Speaking is not live for A: its say translation credits listening alone, and nothing
    // is owed. Crediting speaking from 0 would make it owed.
    const day = dayOf(20, [{ id: 'A', halves: at(20, { [WP]: 18 }), live: [WR, WP, SR, SP] }]);
    expect(pick(day, { inFlight: flight('A', 'typed_translation', 'say_translation') })).toEqual([]);
  });

  it('answers the checks its cards test', () => {
    const day = dayOf(20, [{ id: 'A', halves: at(20), checks: DIMS }]);
    expect(short(pick(day, { inFlight: flight('A', 'typed_translation') }))).toEqual([['A', SK, 2]]);
  });

  it('does not start again a word whose ladder is in flight', () => {
    const day = dayOf(20, [{ id: 'A', toStart: true }, { id: 'B', toStart: true }]);
    const inFlight = flight('A', 'meet', 'letter_tiles', 'multiple_choice', 'reverse_choice', 'typed_translation');
    const picks = pick(day, { inFlight });
    expect(picks.filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['B']);
    expect(picks.filter((p) => !p.ladder).every((p) => p.glossId === 'A' && p.cls === 'TARGET')).toBe(true);
    expect(picks.some((p) => p.glossId === 'A')).toBe(true);
  });
});

describe('chooseTargetPicks, practice more', () => {
  it('asks extra words below the cap before new ladders, then the hardest cards', () => {
    const day = dayOf(
      12,
      [
        { id: 'g0', state: 'done', halves: at(12) },
        { id: 'g1', state: 'extra', halves: at(12, { [SP]: 4 }) },
        { id: 'g2', state: 'later' },
      ],
      'done',
    );
    expect(pick(day)).toEqual([
      { glossId: 'g1', dimension: SP, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false },
      { glossId: 'g2', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW', ladder: true },
      { glossId: 'g0', dimension: WP, rung: 2, level: 1, r: 1, cls: 'TARGET', ladder: false },
    ]);
  });

  it('starts a known later word with a recall card', () => {
    const day = dayOf(12, [{ id: 'g0', state: 'later' }], 'rest');
    expect(short(pick(day, { known: new Set(['g0']) }))).toEqual([['g0', WP, 2]]);
  });

  it('gives the hardest cards first to the word with the fewest halves in its hard skills', () => {
    // The date moved later: values above today's cap stay. g1 is lower in its hard skills.
    const day = dayOf(
      8,
      [
        { id: 'g0', state: 'done', halves: at(16) },
        { id: 'g1', state: 'done', halves: at(16, { [SK]: 8, [SP]: 12 }) },
        { id: 'g2', state: 'done', halves: at(16, { [WR]: 8 }) },
      ],
      'done',
    );
    expect(short(pick(day))).toEqual([
      ['g1', SK, 2],
      ['g0', WP, 2],
      ['g2', WP, 2],
    ]);
  });

  it('asks a word whose hard card is in flight last', () => {
    const day = dayOf(
      8,
      [
        { id: 'g0', state: 'done', halves: at(8) },
        { id: 'g1', state: 'done', halves: at(8) },
      ],
      'done',
    );
    const picks = pick(day, { inFlight: [{ glossId: 'g0', type: 'typed_translation' }] });
    expect(picks.map((p) => p.glossId)).toEqual(['g1', 'g0']);
  });
});

// Phase 65b (spec D2). Past the day's budget a session asks the owed work first, then fills with
// practice more, so a session never ends after one owed card.
describe('chooseTargetPicks, past the budget', () => {
  const day = dayOf(12, [
    { id: 'g0', state: 'owed', halves: at(12, { [WP]: 8 }) },
    { id: 'g1', state: 'done', halves: at(12) },
    { id: 'g2', state: 'done', halves: at(12, { [SK]: 4 }) },
    { id: 'g3', state: 'later' },
  ]);

  it('asks only the owed card in owed mode, as before the budget', () => {
    expect(short(pick(day))).toEqual([['g0', WP, 2]]);
  });

  it('asks the owed card first, then the practice more cards, in one session', () => {
    const picks = pick(day, { mode: 'past_budget' });
    expect(short(picks)[0]).toEqual(['g0', WP, 2]);
    expect(short(picks.slice(1))).toEqual(short(pick({ ...day, words: day.words }, { mode: 'more' })).filter(([id]) => id !== 'g0'));
    expect(picks.map((p) => p.glossId)).toEqual(expect.arrayContaining(['g1', 'g2', 'g3']));
  });

  it('stays within a session: owed work and the fill share one slot count', () => {
    const many = dayOf(
      12,
      Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, state: i < 4 ? ('owed' as const) : ('done' as const), halves: at(12, i < 4 ? { [WP]: 4, [SP]: 4 } : {}) })),
    );
    const owedOnly = pick(many);
    const picks = pick(many, { mode: 'past_budget' });
    expect(slotsOf(picks)).toBeLessThanOrEqual(SESSION_LENGTH);
    expect(picks.length).toBeGreaterThan(owedOnly.length);
    expect(picks.slice(0, owedOnly.length)).toEqual(owedOnly);
  });

  it('asks as practice more when nothing is owed', () => {
    const done = dayOf(12, [{ id: 'g1', state: 'done', halves: at(12) }, { id: 'g3', state: 'later' }], 'done');
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
    const day = dayOf(
      12,
      [
        { id: 'g0', state: 'later' },
        { id: 'g1', state: 'later' },
        { id: 'g2', state: 'later' },
      ],
      'rest',
    );
    expect(pick(day).filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0', 'g1']);
    expect(pick(day, { newRoom: 1 }).filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0']);
    expect(pick(day, { newRoom: 0 }).filter((p) => p.ladder)).toEqual([]);
    expect(short(pick(day, { newRoom: 0, known: new Set(['g1']) }))).toEqual([['g1', WP, 2]]);
  });

  it('never holds an owed start back', () => {
    const day = dayOf(4, [
      { id: 'g0', toStart: true },
      { id: 'g1', toStart: true },
    ]);
    expect(pick(day, { newRoom: 0 }).filter((p) => p.ladder).map((p) => p.glossId)).toEqual(['g0', 'g1']);
  });
});

describe('chooseTargetPicks, last review', () => {
  it('asks a skill at 16 before the hardest cards', () => {
    const day = dayOf(
      20,
      [
        { id: 'g0', state: 'done', halves: at(20) },
        { id: 'g1', halves: at(20, { [SR]: 16 }) },
      ],
      'due_today',
    );
    expect(short(pick(day))).toEqual([
      ['g1', SR, 2],
      ['g0', WP, 2],
    ]);
  });

  it('starts a word never started, so the morning can still reach ready', () => {
    const day = dayOf(20, [{ id: 'g0', toStart: true }], 'due_today');
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

  it('keeps a practice-more stock while practice more is still the choice', () => {
    expect(stockServes({ capHalves: 10, owedGlossIds: [] }, { capHalves: 10, owedGlossIds: [] })).toBe(true);
  });
});
