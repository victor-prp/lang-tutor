import { myWordsDayCounts } from './myWordsDay';
import type { SnapshotRead } from './progress';

function row(glossId: string, dimension: SnapshotRead['dimension'], before: number, after: number): SnapshotRead {
  return { glossId, dimension, levelBefore: before, levelAfter: after, form: glossId, translation: glossId, position: 0 } as SnapshotRead;
}

describe('myWordsDayCounts (phase 73 D2)', () => {
  it('counts a word raised in two counted sessions once', () => {
    const r = myWordsDayCounts({
      counted: ['s1', 's2'],
      firstAnswers: [],
      snapshots: [
        { sessionId: 's1', rows: [row('g1', 'written_receptive', 1, 5)] },
        { sessionId: 's2', rows: [row('g1', 'written_productive', 1, 5)] },
      ],
    });
    expect(r.movedUp).toBe(1);
  });

  it('ignores a rise in a session that is not counted', () => {
    const r = myWordsDayCounts({
      counted: ['s1'],
      firstAnswers: [],
      snapshots: [{ sessionId: 'other', rows: [row('g1', 'written_receptive', 1, 5)] }],
    });
    expect(r.movedUp).toBe(0);
  });

  it('ignores a skill rise that leaves the badge', () => {
    const r = myWordsDayCounts({
      counted: ['s1'],
      firstAnswers: [],
      snapshots: [{ sessionId: 's1', rows: ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive'].map((d) => row('g1', d as SnapshotRead['dimension'], 1, 1)).concat(row('g1', 'spelling', 1, 2)) }],
    });
    expect(r.movedUp).toBe(0);
  });

  it('counts first answers only from counted sessions', () => {
    const r = myWordsDayCounts({
      counted: ['s1'],
      firstAnswers: [
        { glossId: 'g1', sessionId: 'other' },
        { glossId: 'g2', sessionId: 's1' },
        { glossId: 'g2', sessionId: 's1' },
      ],
      snapshots: [],
    });
    expect(r.newWords).toBe(1);
    expect(myWordsDayCounts({ counted: ['s1'], firstAnswers: [{ glossId: 'g1', sessionId: 'other' }], snapshots: [] }).newWords).toBe(0);
  });

  it('counts the sessions done', () => {
    expect(myWordsDayCounts({ counted: ['a', 'b', 'c'], firstAnswers: [], snapshots: [] }).sessionsDone).toBe(3);
  });
});
