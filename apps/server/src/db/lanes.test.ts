import { describe, expect, it } from '@jest/globals';

import { findOrphans, type LaneDatabaseRow } from './lanes';

function stamped(name: string, lane: string, root: string): LaneDatabaseRow {
  return {
    name,
    comment: [
      `lane=${lane}`,
      'slot=3',
      'port=4001',
      'branch=b',
      'stamped=2026-10-01T00:00:00.000Z',
      `root=${root}`,
    ].join(' | '),
  };
}

const GONE = '/worktrees/gone';
const LIVE = '/worktrees/live';
const exists = (path: string) => path === LIVE;

describe('findOrphans', () => {
  it('reports a lane whose databases all point at a worktree that is gone', () => {
    const result = findOrphans(
      [stamped('lang_tutor_old', 'old', GONE), stamped('lang_tutor_e2e_old', 'old', GONE)],
      exists,
    );
    expect(result.orphans).toEqual([
      { lane: 'old', databases: ['lang_tutor_e2e_old', 'lang_tutor_old'] },
    ]);
    expect(result.unowned).toEqual([]);
  });

  it('leaves a lane whose worktree still exists', () => {
    expect(findOrphans([stamped('lang_tutor_live', 'live', LIVE)], exists).orphans).toEqual([]);
  });

  // lane:down drops every database of a lane, so one live stamp protects them all.
  it('leaves a lane when any of its databases points at a worktree that exists', () => {
    const rows = [
      stamped('lang_tutor_mixed', 'mixed', GONE),
      stamped('lang_tutor_e2e_mixed', 'mixed', LIVE),
    ];
    expect(findOrphans(rows, exists).orphans).toEqual([]);
  });

  it('never reports lane 0, whatever its stamp says', () => {
    const rows = [
      stamped('lang_tutor', 'main', GONE),
      { name: 'lang_tutor_e2e', comment: null },
      stamped('lang_tutor_other', 'main', GONE),
    ];
    expect(findOrphans(rows, exists)).toEqual({ orphans: [], unowned: [] });
  });

  it('reports an unstamped database as unowned rather than as an orphan', () => {
    const rows = [
      { name: 'lang_tutor_e2e_tmp_baseline', comment: null },
      { name: 'lang_tutor_handmade', comment: 'written by hand' },
    ];
    expect(findOrphans(rows, exists)).toEqual({
      orphans: [],
      unowned: ['lang_tutor_e2e_tmp_baseline', 'lang_tutor_handmade'],
    });
  });

  it('sorts orphan lanes by name', () => {
    const rows = [stamped('lang_tutor_b', 'b', GONE), stamped('lang_tutor_a', 'a', GONE)];
    expect(findOrphans(rows, exists).orphans.map((o) => o.lane)).toEqual(['a', 'b']);
  });
});
