import { describe, expect, it } from '@jest/globals';
import type { DiscoveryRun, DiscoveryState, PhotoImportItem } from '@lang-tutor/core/api';

import {
  DEFAULT_GOAL,
  GOAL_CHOICES,
  canEnd,
  itemsWaiting,
  stepOf,
  tickedCount,
  verdictLine,
  withItem,
} from './discovery';
import { strings } from './strings';

const PROFILE = { self_level: 'simple', learning_context: 'self', level: 3 } as const;
const item = (position: number, over: Partial<PhotoImportItem> = {}): PhotoImportItem => ({
  position,
  text: `w${position}`,
  hebrew: 'משהו',
  status: 'ready',
  corrected_form: null,
  options: [{ gloss_id: `g${position}`, variant_id: 'v', translation: 'משהו' }],
  chosen_gloss_id: `g${position}`,
  ticked: true,
  hebrew_mismatch: false,
  reason: null,
  ...over,
});
const run = (over: Partial<DiscoveryRun> = {}): DiscoveryRun => ({
  id: 'r1',
  goal: 15,
  status: 'asking',
  unknown_count: 0,
  round: 1,
  cards: [{ position: 0, word: 'gatto' }],
  items: [],
  ...over,
});
const state = (over: Partial<DiscoveryState>): DiscoveryState => ({ profile: PROFILE, run: null, ...over });

describe('stepOf (phase 69, spec D1, D8)', () => {
  it('asks the questions when there is no profile', () => {
    expect(stepOf(state({ profile: null }))).toBe('questions');
  });

  it('asks how many when there is no open run', () => {
    expect(stepOf(state({ run: null }))).toBe('goal');
  });

  it('shows a card while the run asks and has one unanswered', () => {
    expect(stepOf(state({ run: run() }))).toBe('card');
  });

  it('fetches the next round while the run asks and every card is answered', () => {
    expect(stepOf(state({ run: run({ cards: [] }) }))).toBe('fetching');
  });

  it('shows the list once the run lists', () => {
    expect(stepOf(state({ run: run({ status: 'listing', cards: [] }) }))).toBe('list');
  });

  it('asks how many again after a run ended', () => {
    expect(stepOf(state({ run: run({ status: 'saved', cards: [] }) }))).toBe('goal');
  });
});

describe('the goal choices (phase 69, spec D6)', () => {
  it('offers 5 to 30, 15 picked', () => {
    expect(GOAL_CHOICES).toEqual([5, 10, 15, 20, 30]);
    expect(DEFAULT_GOAL).toBe(15);
  });
});

describe('verdictLine (phase 69, spec D5)', () => {
  it('says right in the right tone, and the meaning when not', () => {
    expect(verdictLine({ known: true, meaning: 'חתול', run: run() })).toEqual({ tone: 'right', text: strings.discoverRight });
    expect(verdictLine({ known: false, meaning: 'חתול', run: run() })).toEqual({ tone: 'wrong', text: 'לא בדיוק — חתול' });
  });
});

describe('the list (phase 69, spec D8)', () => {
  it('waits while a row is looked up', () => {
    expect(itemsWaiting(run({ items: [item(0), item(1, { status: 'pending' })] }))).toBe(true);
    expect(itemsWaiting(run({ items: [item(0), item(1, { status: 'failed', ticked: false })] }))).toBe(false);
  });

  it('counts the ticked rows that can be saved', () => {
    expect(tickedCount(run({ items: [item(0), item(1, { ticked: false }), item(2, { status: 'pending', ticked: false })] }))).toBe(1);
  });

  it('replaces one row, leaving the others', () => {
    const changed = withItem(run({ items: [item(0), item(1)] }), item(1, { ticked: false }));
    expect(changed.items.map((row) => row.ticked)).toEqual([true, false]);
  });
});

describe('canEnd (phase 69, spec D8)', () => {
  it('offers the list from the first word not known, while the run asks', () => {
    expect(canEnd(run({ unknown_count: 0 }))).toBe(false);
    expect(canEnd(run({ unknown_count: 1 }))).toBe(true);
    expect(canEnd(run({ unknown_count: 1, status: 'listing' }))).toBe(false);
  });
});
