import { describe, expect, it } from '@jest/globals';
import type { CurrentSession, DiscoveryRun, DiscoveryState } from '@lang-tutor/core/api';

import { DEFAULT_GOAL, GOAL_CHOICES, closeStep, endStep, savedBefore, sheetCaseOf, stepOf, suggestionOf, waitStep, warnEscape } from './discovery';

const PROFILE = { self_level: 'simple', learning_context: 'self', level: 3 } as const;
const run = (over: Partial<DiscoveryRun> = {}): DiscoveryRun => ({
  id: 'r1',
  goal: 15,
  status: 'asking',
  started_by: 'learner',
  added_count: 0,
  round: 1,
  cards: [{ position: 0, word: 'finestra', choices: ['דלת', 'חלון', 'וילון', 'מרפסת'], right: 1 }],
  added: [],
  ...over,
});
const added = (status: 'pending' | 'saved' | 'failed', position = 0) => ({ position, word: `w${position}`, meaning: 'משהו', status });
const state = (over: Partial<DiscoveryState>): DiscoveryState => ({ profile: PROFILE, run: null, ...over });
const session = (status: CurrentSession['status'], answered = 0): CurrentSession => ({
  session_id: 's1',
  status,
  source: 'list',
  answered,
  total: 10,
  started: answered > 0,
});

describe('stepOf (phase 69, spec D1; phase 74 D6, D9)', () => {
  it('asks the questions first, whoever opened it', () => {
    expect(stepOf(state({ profile: null }), false)).toBe('questions');
    expect(stepOf(state({ profile: null }), true)).toBe('questions');
  });

  it('asks how many when the learner opened it, and starts at once when the app did', () => {
    expect(stepOf(state({}), false)).toBe('goal');
    expect(stepOf(state({}), true)).toBe('starting');
  });

  it('shows the cards, or fetches the next round when none is left unanswered', () => {
    expect(stepOf(state({ run: run() }), true)).toBe('card');
    expect(stepOf(state({ run: run({ cards: [] }) }), false)).toBe('fetching');
  });

  it('shows the end once the run ended', () => {
    expect(stepOf(state({ run: run({ status: 'saved', cards: [] }) }), true)).toBe('end');
  });

  it('keeps the goal choices of phase 69', () => {
    expect(GOAL_CHOICES).toEqual([5, 10, 15, 20, 30]);
    expect(DEFAULT_GOAL).toBe(15);
  });
});

describe('suggestionOf (phase 74, spec D2)', () => {
  it('suggests not adding after a right pick, adding after a wrong one or "אין לי מושג"', () => {
    expect(suggestionOf(1, 1)).toBe('skip');
    expect(suggestionOf(0, 1)).toBe('add');
    expect(suggestionOf(null, 1)).toBe('add');
  });
});

describe('sheetCaseOf (phase 74, spec D2)', () => {
  it('opens a sheet only for the choice the app did not suggest', () => {
    expect(sheetCaseOf('skip', 'skip')).toBeNull();
    expect(sheetCaseOf('add', 'add')).toBeNull();
    expect(sheetCaseOf('skip', 'add')).toBe('knew');
    expect(sheetCaseOf('add', 'skip')).toBe('new');
  });
});

describe('closeStep (phase 74, spec D8)', () => {
  it('ends the run from the cards with two words added or more', () => {
    expect(closeStep(run({ added_count: 2 }), 'card')).toBe('end');
    expect(closeStep(run({ added_count: 7 }), 'card')).toBe('end');
  });

  it('warns from the cards with fewer than two', () => {
    expect(closeStep(run({ added_count: 0 }), 'card')).toBe('warn');
    expect(closeStep(run({ added_count: 1 }), 'card')).toBe('warn');
  });

  it('counts a later round being fetched as the cards', () => {
    expect(closeStep(run({ added_count: 3, cards: [], round: 1 }), 'fetching')).toBe('end');
    expect(closeStep(run({ added_count: 1, cards: [], round: 1 }), 'fetching')).toBe('warn');
  });

  it('leaves before the cards, and from the end', () => {
    expect(closeStep(null, 'questions')).toBe('leave');
    expect(closeStep(null, 'goal')).toBe('leave');
    expect(closeStep(run({ cards: [], round: 0 }), 'fetching')).toBe('leave');
    expect(closeStep(run({ status: 'saved', added_count: 3 }), 'end')).toBe('leave');
  });
});

describe('warnEscape (phase 74, spec D8)', () => {
  it('practises without new words when the app sent a learner who has words of their own', () => {
    expect(warnEscape(true, 4)).toBe('practise');
  });

  it('only leaves otherwise', () => {
    expect(warnEscape(true, 0)).toBe('leave');
    expect(warnEscape(false, 4)).toBe('leave');
  });
});

describe('savedBefore (phase 74, spec D8)', () => {
  it("counts the learner's words less the ones this run saved", () => {
    expect(savedBefore(5, run({ added: [added('saved', 0), added('pending', 1), added('saved', 2)] }))).toBe(3);
    expect(savedBefore(1, run({ added: [added('saved')] }))).toBe(0);
    expect(savedBefore(0, null)).toBe(0);
  });
});

describe('endStep (phase 74, spec D9)', () => {
  const ended = (words: ReturnType<typeof added>[]) => run({ status: 'saved', cards: [], added: words, added_count: words.length });

  it('offers the session once it is ready, started or not', () => {
    expect(endStep(ended([added('pending')]), session('ready'), false)).toBe('start');
    expect(endStep(ended([]), session('ready', 3), false)).toBe('start');
  });

  it('waits while the session is prepared, or while a word is still looked up', () => {
    expect(endStep(ended([added('saved')]), session('preparing'), false)).toBe('wait');
    expect(endStep(ended([added('saved'), added('pending', 1)]), null, false)).toBe('wait');
  });

  it('asks for the session once when a word is saved and none came, then waits', () => {
    expect(endStep(ended([added('saved'), added('failed', 1)]), null, false)).toBe('create');
    expect(endStep(ended([added('saved')]), null, true)).toBe('wait');
  });

  it('has nothing to offer with no word saved and nothing looked up', () => {
    expect(endStep(ended([]), null, false)).toBe('empty');
    expect(endStep(ended([added('failed')]), null, false)).toBe('empty');
  });

  it('says so when the session failed', () => {
    expect(endStep(ended([added('saved')]), session('failed'), false)).toBe('failed');
  });
});

// Phase 73 (spec D6), moved here by phase 74: practising without new words waits on the session
// it asked for.
describe('waitStep', () => {
  it.each([
    [{ session_id: 's1', status: 'ready' }, 'open'],
    [{ session_id: 's1', status: 'preparing' }, 'wait'],
    [{ session_id: 's1', status: 'failed' }, 'home'],
    [{ session_id: 's2', status: 'ready' }, 'wait'],
    [null, 'wait'],
  ] as [{ session_id: string; status: string } | null, string][])('%j -> %s', (current, expected) => {
    expect(waitStep(current, 's1')).toBe(expected);
  });
});
