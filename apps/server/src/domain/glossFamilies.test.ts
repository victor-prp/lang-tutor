import { describe, expect, it } from '@jest/globals';
import type { Dimension, MemoryState } from '@lang-tutor/core/domain';

import { glossFamilies, knownNow, type FamilyGloss } from './glossFamilies';

const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SP: Dimension = 'spelling';
const SR: Dimension = 'spoken_receptive';
const SK: Dimension = 'spoken_productive';
const LIVE: Dimension[] = [WR, WP, SP];

function gloss(
  id: string,
  lexemeId: string,
  forms: string[],
  overrides: Partial<FamilyGloss> = {},
): FamilyGloss {
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

function mem(glossId: string, dimension: Dimension, stability: number, reachedOn: string | null = null) {
  const state: MemoryState = {
    stability,
    difficulty: 5,
    lastDay: '2026-10-01',
    reps: 2,
    lapses: 0,
    params: 'fsrs6-default',
  } as MemoryState;
  return { glossId, dimension, state, reachedOn };
}

const knownMem = (id: string, dims: Dimension[] = LIVE) => dims.map((d) => mem(id, d, 8));

describe('glossFamilies: membership', () => {
  it('joins glosses of one lexeme', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'blow up', ['blow up']), gloss('b', 'blow up', ['blow up'])],
      memory: [],
      live: LIVE,
    });
    expect(r.families).toHaveLength(1);
    expect(r.families[0].glossIds.sort()).toEqual(['a', 'b']);
  });

  it('joins lexemes sharing a form, and chains see/saw/saw', () => {
    const r = glossFamilies({
      saved: [
        gloss('a', 'see', ['see', 'saw']),
        gloss('b', 'saw1', ['saw']),
        gloss('c', 'saw2', ['saw']),
      ],
      memory: [],
      live: LIVE,
    });
    expect(r.families).toHaveLength(1);
    expect(r.families[0].glossIds).toHaveLength(3);
    expect(r.families[0].label).toBe('saw1 / saw2 / see');
  });

  it('does not make a family of one gloss', () => {
    const r = glossFamilies({ saved: [gloss('a', 'x', ['x'])], memory: [], live: LIVE });
    expect(r.families).toEqual([]);
    expect(r.familyOf.has('a')).toBe(false);
    expect(r.state.has('a')).toBe(false);
  });

  it('a gloss with no forms still joins its lexeme', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', []), gloss('b', 'x', [])],
      memory: [],
      live: LIVE,
    });
    expect(r.families).toHaveLength(1);
  });
});

describe('knownNow', () => {
  const fam = (live: Dimension[], memory: ReturnType<typeof mem>[], speakable = true) => {
    const saved = [gloss('a', 'x', ['x'], { speakable }), gloss('b', 'x', ['x'])];
    return glossFamilies({ saved, memory, live });
  };

  it('needs every live skill at 7', () => {
    expect(knownNow('a', true, knownMem('a'), LIVE)).toBe(true);
    expect(knownNow('a', true, knownMem('a', [WR, WP]), LIVE)).toBe(false);
  });

  it('a live skill without memory makes it unknown', () => {
    expect(knownNow('a', true, knownMem('a'), [...LIVE, SR])).toBe(false);
    expect(knownNow('a', true, knownMem('a', [...LIVE, SR]), [...LIVE, SR])).toBe(true);
  });

  it('ignores speaking when not speakable', () => {
    expect(knownNow('a', false, knownMem('a'), [...LIVE, SK])).toBe(true);
    expect(knownNow('a', true, knownMem('a'), [...LIVE, SK])).toBe(false);
  });

  it('6.9 is not known', () => {
    const m = [mem('a', WR, 6.9), mem('a', WP, 8), mem('a', SP, 8)];
    expect(knownNow('a', true, m, LIVE)).toBe(false);
  });

  it('only reads its own gloss', () => {
    expect(knownNow('a', true, knownMem('b'), LIVE)).toBe(false);
  });

  it('is applied by glossFamilies with speakable', () => {
    const r = fam([...LIVE, SK], knownMem('a'), false);
    expect(r.state.get('a')).toBe('known');
    expect(r.newlyKnown.has('a')).toBe(true);
  });
});

describe('glossFamilies: known', () => {
  it('knownAt stays known despite lapsed memory and is not newly known', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', [], { knownAt: '2026-10-05T00:00:00Z' }), gloss('b', 'x', [])],
      memory: [mem('a', WR, 1)],
      live: LIVE,
    });
    expect(r.state.get('a')).toBe('known');
    expect(r.newlyKnown.has('a')).toBe(false);
    expect(r.state.get('b')).toBe('current');
  });

  it('known by memory with knownAt null is newly known', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', []), gloss('b', 'x', [])],
      memory: knownMem('a'),
      live: LIVE,
    });
    expect(r.newlyKnown.has('a')).toBe(true);
  });
});

describe('glossFamilies: order, current, waiting', () => {
  it('practised comes before never-asked, whatever the order', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', [], { order: [0, 0] }), gloss('b', 'x', [], { order: [0, 3] })],
      memory: [mem('b', WR, 2.3)],
      live: LIVE,
    });
    expect(r.families[0].glossIds).toEqual(['b', 'a']);
    expect(r.state.get('b')).toBe('current');
    expect(r.state.get('a')).toBe('waiting');
  });

  it('ties fall to order, savedAt, then id', () => {
    const r = glossFamilies({
      saved: [
        gloss('d', 'x', [], { order: [1, 0] }),
        gloss('c', 'x', [], { order: [0, 1] }),
        gloss('b', 'x', [], { order: [0, 0], savedAt: '2026-10-02T00:00:00Z' }),
        gloss('a2', 'x', [], { order: [0, 0] }),
        gloss('a1', 'x', [], { order: [0, 0] }),
      ],
      memory: [],
      live: LIVE,
    });
    expect(r.families[0].glossIds).toEqual(['a1', 'a2', 'b', 'c', 'd']);
  });

  it('degree case: three practised at 2.3, order[1] 0 is current', () => {
    const r = glossFamilies({
      saved: [
        gloss('a', 'degree', [], { order: [0, 2] }),
        gloss('b', 'degree', [], { order: [0, 0] }),
        gloss('c', 'degree', [], { order: [0, 1] }),
      ],
      memory: ['a', 'b', 'c'].flatMap((id) => LIVE.map((d) => mem(id, d, 2.3))),
      live: LIVE,
    });
    expect(r.state.get('b')).toBe('current');
    expect(r.state.get('a')).toBe('waiting');
    expect(r.state.get('c')).toBe('waiting');
  });

  it('all known: no current, no waiting', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', []), gloss('b', 'x', [])],
      memory: [...knownMem('a'), ...knownMem('b')],
      live: LIVE,
    });
    expect([...r.state.values()]).toEqual(['known', 'known']);
    expect(r.introductions.size).toBe(0);
  });
});

describe('glossFamilies: introductions', () => {
  it('a never-asked current gloss lists the known key', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', []), gloss('b', 'x', [], { order: [0, 1] })],
      memory: knownMem('a'),
      live: LIVE,
    });
    expect(r.introductions.get('b')).toEqual(['key-a']);
  });

  it('a practised current gloss gets none', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', []), gloss('b', 'x', [], { order: [0, 1] })],
      memory: [...knownMem('a'), mem('b', WR, 2.3)],
      live: LIVE,
    });
    expect(r.state.get('b')).toBe('current');
    expect(r.introductions.size).toBe(0);
  });

  it('no known gloss, no introduction', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', []), gloss('b', 'x', [])],
      memory: [],
      live: LIVE,
    });
    expect(r.introductions.size).toBe(0);
  });

  it('two known: keys in family order', () => {
    const r = glossFamilies({
      saved: [
        gloss('a', 'x', [], { order: [0, 1] }),
        gloss('b', 'x', [], { order: [0, 0] }),
        gloss('c', 'x', [], { order: [0, 2] }),
      ],
      memory: [...knownMem('a'), ...knownMem('b')],
      live: LIVE,
    });
    expect(r.introductions.get('c')).toEqual(['key-b', 'key-a']);
  });
});

describe('glossFamilies: evidence', () => {
  it('holds the live list and the stabilities', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'x', []), gloss('b', 'x', [])],
      memory: [mem('a', WR, 2.3), mem('a', SP, 5)],
      live: LIVE,
    });
    expect(r.evidence.get('a')).toEqual({ live: LIVE, stability: { [WR]: 2.3, [SP]: 5 }, reached: {} });
    expect(r.evidence.get('b')).toEqual({ live: LIVE, stability: {}, reached: {} });
  });
});

describe('phase 46: a skill counts once it reached the bar', () => {
  it('counts a lapsed skill that has a reachedOn', () => {
    const memory = [mem('a', WR, 9), mem('a', WP, 1.2, '2026-09-20'), mem('a', SP, 8)];
    expect(knownNow('a', true, memory, LIVE)).toBe(true);
  });

  it('does not count a lapsed skill that never reached the bar', () => {
    const memory = [mem('a', WR, 9), mem('a', WP, 1.2), mem('a', SP, 8)];
    expect(knownNow('a', true, memory, LIVE)).toBe(false);
  });
});

describe('phase 46: known for good, per gloss', () => {
  it('a known gloss in no family is newly known', () => {
    const r = glossFamilies({ saved: [gloss('solo', 'kite', ['kite'])], memory: knownMem('solo'), live: LIVE });
    expect(r.families).toHaveLength(0);
    expect([...r.newlyKnown]).toEqual(['solo']);
  });

  it('a gloss with knownAt stays known once every skill lapsed, and is not newly known', () => {
    const lapsed = LIVE.map((d) => mem('a', d, 1.1));
    const r = glossFamilies({
      saved: [gloss('a', 'pick up', ['pick up'], { knownAt: '2026-09-01T00:00:00Z' }), gloss('b', 'pick up', ['pick up'])],
      memory: lapsed,
      live: LIVE,
    });
    expect(r.state.get('a')).toBe('known');
    expect(r.state.get('b')).toBe('current');
    expect(r.newlyKnown.size).toBe(0);
  });

  it('an enrollment with no memory knows nothing', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'pick up', ['pick up']), gloss('b', 'pick up', ['pick up']), gloss('solo', 'kite', ['kite'])],
      memory: [],
      live: LIVE,
    });
    expect(r.newlyKnown.size).toBe(0);
    expect(r.state.get('a')).toBe('current');
  });

  it('evidence holds the day each skill reached the bar', () => {
    const r = glossFamilies({
      saved: [gloss('a', 'pick up', ['pick up']), gloss('b', 'pick up', ['pick up'])],
      memory: [mem('a', WR, 9, '2026-09-10'), mem('a', WP, 2)],
      live: LIVE,
    });
    expect(r.evidence.get('a')!.reached).toEqual({ [WR]: '2026-09-10' });
  });
});
