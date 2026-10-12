import { describe, expect, it } from '@jest/globals';
import type { Dimension, MemoryState } from '@lang-tutor/core/domain';

import { glossFamilies, type FamilyGloss } from './glossFamilies';
import { familyChanges, isEmptyFamilyWrite, type StoredFamilyView } from './glossFamilyRecord';

const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SP: Dimension = 'spelling';
const LIVE: Dimension[] = [WR, WP, SP];
const AT = '2026-10-12T09:00:00.000Z';
const KNOWN_AT = '2026-10-01T09:00:00.000Z';
const OLD = '2026-09-01T00:00:00.000Z';
const NEW = '2026-10-01T00:00:00.000Z';

function gloss(id: string, lexemeId: string, forms: string[], overrides: Partial<FamilyGloss> = {}): FamilyGloss {
  return {
    glossId: id,
    lexemeId,
    lemma: lexemeId,
    key: `key-${id}`,
    savedAt: '2026-10-01T00:00:00Z',
    forms,
    order: [0, 0],
    speakable: true,
    knownAt: null,
    ...overrides,
  };
}

function mem(glossId: string, dimension: Dimension, stability: number) {
  const state = { stability, difficulty: 5, lastDay: '2026-10-01', reps: 2, lapses: 0, params: 'fsrs6-default' } as MemoryState;
  return { glossId, dimension, state };
}
const knownMem = (id: string) => LIVE.map((d) => mem(id, d, 8));

/** New ids in the order asked for. */
function ids() {
  let n = 0;
  return () => `n${++n}`;
}

type Member = StoredFamilyView['members'][number];
function family(id: string, members: Omit<Member, 'familyId' | 'position'>[], over: Partial<StoredFamilyView> = {}): StoredFamilyView {
  return {
    id,
    label: 'pick up',
    createdAt: NEW,
    members: members.map((m, position) => ({ ...m, familyId: id, position })),
    ...over,
  };
}
const member = (glossId: string, state: Member['state'], knownAt: string | null = null) => ({ glossId, state, knownAt });

const evidence = (stability: Partial<Record<Dimension, number>> = {}) => ({ live: LIVE, stability, known_stability: 7 });

/** `pick up`, two meanings: `a` the commoner. */
const PICK_UP = [gloss('a', 'pick up', ['pick up']), gloss('b', 'pick up', ['pick up'], { order: [0, 1] })];

describe('familyChanges (phase 39 D4)', () => {
  it('records a first refresh: the family, its members in family order, and a joined event each', () => {
    const computed = glossFamilies({ saved: PICK_UP, memory: [], live: LIVE });
    expect(familyChanges([], computed, ids(), AT)).toEqual({
      families: [{ id: 'n1', label: 'pick up', isNew: true }],
      deleteFamilies: [],
      members: [
        { glossId: 'a', familyId: 'n1', state: 'current', position: 0, knownAt: null, sinceChanged: true },
        { glossId: 'b', familyId: 'n1', state: 'waiting', position: 1, knownAt: null, sinceChanged: true },
      ],
      deleteMembers: [],
      events: [
        { familyId: 'n1', glossId: 'a', fromState: null, toState: 'current', evidence: evidence() },
        { familyId: 'n1', glossId: 'b', fromState: null, toState: 'waiting', evidence: evidence() },
      ],
    });
  });

  it('writes nothing when nothing changed', () => {
    const computed = glossFamilies({ saved: PICK_UP, memory: [mem('a', WR, 2)], live: LIVE });
    const stored = [family('f1', [member('a', 'current'), member('b', 'waiting')])];
    const write = familyChanges(stored, computed, ids(), AT);
    expect(write).toEqual({ families: [], deleteFamilies: [], members: [], deleteMembers: [], events: [] });
    expect(isEmptyFamilyWrite(write)).toBe(true);
  });

  it('logs a change of state once, with the evidence that decided it, and stamps known_at for a newly known gloss', () => {
    // `a` was known before; `b`, current, is now known in every live skill.
    const saved = [gloss('a', 'pick up', ['pick up'], { knownAt: KNOWN_AT }), PICK_UP[1]];
    const computed = glossFamilies({ saved, memory: [mem('a', WR, 1), ...knownMem('b')], live: LIVE });
    const stored = [family('f1', [member('a', 'known', KNOWN_AT), member('b', 'current')])];
    const write = familyChanges(stored, computed, ids(), AT);
    expect(write).toEqual({
      families: [{ id: 'f1', label: 'pick up', isNew: false }],
      deleteFamilies: [],
      members: [{ glossId: 'b', familyId: 'f1', state: 'known', position: 1, knownAt: AT, sinceChanged: true }],
      deleteMembers: [],
      events: [
        { familyId: 'f1', glossId: 'b', fromState: 'current', toState: 'known', evidence: evidence({ [WR]: 8, [WP]: 8, [SP]: 8 }) },
      ],
    });
    expect(isEmptyFamilyWrite(write)).toBe(false);
  });

  it('keeps a known gloss its stored known_at, and rewrites a moved position with no event', () => {
    // `b` was practised since: it now comes first in family order. `a` is still known.
    const saved = [gloss('a', 'pick up', ['pick up'], { knownAt: KNOWN_AT }), PICK_UP[1]];
    const computed = glossFamilies({ saved, memory: [mem('b', WR, 1)], live: LIVE });
    const stored = [family('f1', [member('a', 'known', KNOWN_AT), member('b', 'current')])];
    const write = familyChanges(stored, computed, ids(), AT);
    expect(write.members).toEqual([
      { glossId: 'b', familyId: 'f1', state: 'current', position: 0, knownAt: null, sinceChanged: false },
      { glossId: 'a', familyId: 'f1', state: 'known', position: 1, knownAt: KNOWN_AT, sinceChanged: false },
    ]);
    expect(write.events).toEqual([]);
  });

  it('merges two stored families under the one holding more of the members, and logs joined for the others', () => {
    // A lookup gave `see` the variant `saw`: `see` (two meanings) and `saw` (three) are one family now.
    const saved = [
      gloss('s1', 'see', ['see', 'saw']),
      gloss('s2', 'see', ['see', 'saw'], { order: [0, 1] }),
      gloss('w1', 'saw', ['saw'], { order: [1, 0] }),
      gloss('w2', 'saw', ['saw'], { order: [1, 1] }),
      gloss('w3', 'saw', ['saw'], { order: [1, 2] }),
    ];
    const computed = glossFamilies({ saved, memory: [mem('w1', WR, 1)], live: LIVE });
    const stored = [
      family('f_see', [member('s1', 'current'), member('s2', 'waiting')], { label: 'see', createdAt: OLD }),
      family('f_saw', [member('w1', 'current'), member('w2', 'waiting'), member('w3', 'waiting')], { label: 'saw' }),
    ];
    const write = familyChanges(stored, computed, ids(), AT);
    expect(write.families).toEqual([{ id: 'f_saw', label: 'saw / see', isNew: false }]);
    expect(write.deleteFamilies).toEqual(['f_see']);
    expect(write.deleteMembers).toEqual([]);
    // Family order: w1 (practised) first, then by the dictionary's order. w2 and w3 only move down.
    expect(write.members).toEqual([
      { glossId: 's1', familyId: 'f_saw', state: 'waiting', position: 1, knownAt: null, sinceChanged: true },
      { glossId: 's2', familyId: 'f_saw', state: 'waiting', position: 2, knownAt: null, sinceChanged: true },
      { glossId: 'w2', familyId: 'f_saw', state: 'waiting', position: 3, knownAt: null, sinceChanged: false },
      { glossId: 'w3', familyId: 'f_saw', state: 'waiting', position: 4, knownAt: null, sinceChanged: false },
    ]);
    expect(write.events).toEqual([
      { familyId: 'f_saw', glossId: 's1', fromState: null, toState: 'waiting', evidence: evidence() },
      { familyId: 'f_saw', glossId: 's2', fromState: null, toState: 'waiting', evidence: evidence() },
    ]);
  });

  it('gives a tie to the older stored family', () => {
    const saved = [
      gloss('s1', 'see', ['see', 'saw']),
      gloss('s2', 'see', ['see', 'saw'], { order: [0, 1] }),
      gloss('w1', 'saw', ['saw'], { order: [1, 0] }),
      gloss('w2', 'saw', ['saw'], { order: [1, 1] }),
    ];
    const computed = glossFamilies({ saved, memory: [], live: LIVE });
    const stored = [
      family('f_saw', [member('w1', 'current'), member('w2', 'waiting')], { label: 'saw' }),
      family('f_see', [member('s1', 'current'), member('s2', 'waiting')], { label: 'see', createdAt: OLD }),
    ];
    const write = familyChanges(stored, computed, ids(), AT);
    expect(write.families).toEqual([{ id: 'f_see', label: 'saw / see', isNew: false }]);
    expect(write.deleteFamilies).toEqual(['f_saw']);
    expect(write.events.map((e) => [e.familyId, e.glossId, e.fromState])).toEqual([
      ['f_see', 'w1', null],
      ['f_see', 'w2', null],
    ]);
  });

  it('keeps one id for one family when a stored family splits in two', () => {
    // f1 held a, b, c and d; d now shares a form only with a newly saved e.
    const saved = [
      gloss('a', 'x', ['x']),
      gloss('b', 'x', ['x'], { order: [0, 1] }),
      gloss('c', 'x', ['x'], { order: [0, 2] }),
      gloss('d', 'y', ['y']),
      gloss('e', 'z', ['y'], { order: [0, 1] }),
    ];
    const computed = glossFamilies({ saved, memory: [], live: LIVE });
    const stored = [
      family('f1', [member('a', 'current'), member('b', 'waiting'), member('c', 'waiting'), member('d', 'waiting')], { label: 'x' }),
    ];
    const write = familyChanges(stored, computed, ids(), AT);
    // f1 keeps its label, and is touched only because d left it.
    expect(write.families).toEqual([
      { id: 'f1', label: 'x', isNew: false },
      { id: 'n1', label: 'y / z', isNew: true },
    ]);
    expect(write.deleteFamilies).toEqual([]);
    expect(write.members).toEqual([
      { glossId: 'd', familyId: 'n1', state: 'current', position: 0, knownAt: null, sinceChanged: true },
      { glossId: 'e', familyId: 'n1', state: 'waiting', position: 1, knownAt: null, sinceChanged: true },
    ]);
    expect(write.events.map((e) => [e.familyId, e.glossId, e.fromState, e.toState])).toEqual([
      ['n1', 'd', null, 'current'],
      ['n1', 'e', null, 'waiting'],
    ]);
  });

  it('deletes a dissolved family and its members, logging each as leaving', () => {
    // `b` was unsaved (its member row went with its entry): `a` is a family of one, so of none.
    const computed = glossFamilies({ saved: [PICK_UP[0]], memory: [], live: LIVE });
    const stored = [family('f1', [member('a', 'current')])];
    expect(familyChanges(stored, computed, ids(), AT)).toEqual({
      families: [],
      deleteFamilies: ['f1'],
      members: [],
      deleteMembers: ['a'],
      events: [{ familyId: 'f1', glossId: 'a', fromState: 'current', toState: null, evidence: {} }],
    });
  });

  it('deletes a stored family left with no members at all', () => {
    const computed = glossFamilies({ saved: [PICK_UP[0]], memory: [], live: LIVE });
    expect(familyChanges([family('f1', [])], computed, ids(), AT)).toEqual({
      families: [],
      deleteFamilies: ['f1'],
      members: [],
      deleteMembers: [],
      events: [],
    });
  });
});
