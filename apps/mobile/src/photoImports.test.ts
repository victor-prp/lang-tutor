import { describe, expect, it } from '@jest/globals';
import type { PhotoImport, PhotoImportItem, PhotoImportSummary } from '@lang-tutor/core/api';

import { canSave, chosenOption, homePhotoCard, mergePolled, shouldPollImport, tickedCount, withChange } from './photoImports';

const option = (n: number) => ({ sense_id: `s${n}`, variant_id: `v${n}`, translation: `t${n}` });
const item = (position: number, over: Partial<PhotoImportItem> = {}): PhotoImportItem => ({
  position, text: `w${position}`, hebrew: null, status: 'ready', corrected_form: null,
  options: [option(1), option(2)], chosen_sense_id: 's1', ticked: true, hebrew_mismatch: false, reason: null, ...over,
});
const imp = (items: PhotoImportItem[], status: PhotoImport['status'] = 'ready'): PhotoImport => ({
  id: 'i1', status, item_count: items.length, settled_count: items.length, created_at: '2026-10-07T10:00:00Z', items,
});
const summary = (id: string, status: PhotoImportSummary['status'], count = 3): PhotoImportSummary => ({
  id, status, item_count: count, settled_count: count, created_at: '2026-10-07T10:00:00Z',
});

describe('polling and saving', () => {
  it('polls only while reading or looking up', () => {
    expect(shouldPollImport(null)).toBe(false);
    expect(shouldPollImport(imp([], 'reading'))).toBe(true);
    expect(shouldPollImport(imp([], 'looking_up'))).toBe(true);
    expect(shouldPollImport(imp([], 'ready'))).toBe(false);
    expect(shouldPollImport(imp([], 'failed'))).toBe(false);
  });

  it('counts ticked ready rows, and saves only a ready import with something ticked', () => {
    const rows = [item(0), item(1, { ticked: false }), item(2, { status: 'pending', ticked: false })];
    expect(tickedCount(imp(rows))).toBe(1);
    expect(canSave(imp(rows))).toBe(true);
    expect(canSave(imp([item(0, { ticked: false })]))).toBe(false);
    expect(canSave(imp([item(0)], 'looking_up'))).toBe(false);
  });
});

describe('withChange', () => {
  it('applies a tick and a sense switch to one row', () => {
    const next = withChange(imp([item(0), item(1)]), 1, { ticked: false, sense_id: 's2' });
    expect(next.items[1]).toMatchObject({ ticked: false, chosen_sense_id: 's2' });
    expect(next.items[0]).toEqual(item(0));
    expect(chosenOption(next.items[1])).toEqual(option(2));
  });
});

describe('mergePolled', () => {
  it('takes the server’s rows, except those with a change still in flight', () => {
    const local = withChange(imp([item(0), item(1, { status: 'pending', options: [], chosen_sense_id: null, ticked: false })], 'looking_up'), 0, { ticked: false });
    const polled = imp([item(0), item(1)], 'ready');
    const merged = mergePolled(polled, local, new Set([0]));
    expect(merged.status).toBe('ready');
    expect(merged.items[0].ticked).toBe(false);
    expect(merged.items[1]).toEqual(item(1));
  });
});

describe('homePhotoCard', () => {
  it('shows nothing, one import, or a count of several', () => {
    expect(homePhotoCard([])).toBeNull();
    expect(homePhotoCard([summary('a', 'reading')])).toEqual({ kind: 'working', id: 'a' });
    expect(homePhotoCard([summary('a', 'ready', 32)])).toEqual({ kind: 'ready', id: 'a', count: 32 });
    expect(homePhotoCard([summary('a', 'failed')])).toEqual({ kind: 'failed', id: 'a' });
    expect(homePhotoCard([summary('a', 'ready'), summary('b', 'reading')])).toEqual({ kind: 'several', count: 2 });
  });
});
