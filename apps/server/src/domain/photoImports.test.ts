import { describe, expect, it } from '@jest/globals';

import {
  IMPORT_TTL_MS,
  deriveStatus,
  entriesToSave,
  isOpen,
  optionsFrom,
  reasonFor,
  refuseItemUpdate,
  reviewCounts,
  type ImportItemState,
} from './photoImports';

const option = (n: number) => ({ sense_id: `s${n}`, variant_id: `v${n}`, translation: `t${n}` });
const row = (over: Partial<ImportItemState> = {}): ImportItemState => ({
  position: 0,
  status: 'ready',
  options: [option(1), option(2)],
  suggestedSenseId: 's1',
  chosenSenseId: 's1',
  ticked: true,
  ...over,
});

describe('deriveStatus', () => {
  it('works out looking_up and ready from the pending rows, and passes the rest through', () => {
    expect(deriveStatus('reading', 0)).toBe('reading');
    expect(deriveStatus('read', 3)).toBe('looking_up');
    expect(deriveStatus('read', 0)).toBe('ready');
    expect(deriveStatus('failed', 0)).toBe('failed');
    expect(deriveStatus('saved', 0)).toBe('saved');
    expect(deriveStatus('discarded', 2)).toBe('discarded');
  });
});

describe('isOpen', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  it('is open until saved, discarded or 14 days old', () => {
    expect(isOpen('read', created, created.getTime() + IMPORT_TTL_MS - 1)).toBe(true);
    expect(isOpen('read', created, created.getTime() + IMPORT_TTL_MS)).toBe(false);
    expect(isOpen('failed', created, created.getTime())).toBe(true);
    expect(isOpen('saved', created, created.getTime())).toBe(false);
    expect(isOpen('discarded', created, created.getTime())).toBe(false);
  });
});

describe('refuseItemUpdate', () => {
  it('refuses any change to a row whose lookup has not landed', () => {
    expect(refuseItemUpdate(row({ status: 'pending' }), { ticked: false })).toBe('not_ready');
    expect(refuseItemUpdate(row({ status: 'failed' }), { ticked: false })).toBe('not_ready');
  });
  it('refuses a sense that is not one of the options, and a tick on a row with none', () => {
    expect(refuseItemUpdate(row(), { sense_id: 's9' })).toBe('unknown_sense');
    expect(refuseItemUpdate(row({ options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false }), { ticked: true })).toBe('no_options');
  });
  it('lets an untick, a tick and a switch through', () => {
    expect(refuseItemUpdate(row(), { ticked: false })).toBeNull();
    expect(refuseItemUpdate(row({ ticked: false }), { ticked: true, sense_id: 's2' })).toBeNull();
  });
});

describe('entriesToSave', () => {
  it('takes the chosen option of every ready, ticked row, and nothing else', () => {
    expect(
      entriesToSave([
        row({ position: 0 }),
        row({ position: 1, chosenSenseId: 's2' }),
        row({ position: 2, ticked: false }),
        row({ position: 3, status: 'failed', ticked: false }),
        row({ position: 4, options: [], chosenSenseId: null, ticked: false }),
      ]),
    ).toEqual([
      { sense_id: 's1', variant_id: 'v1' },
      { sense_id: 's2', variant_id: 'v2' },
    ]);
  });
});

describe('reviewCounts', () => {
  it('counts unticked rows and changed senses among rows that had options', () => {
    expect(
      reviewCounts([
        row(),
        row({ ticked: false }),
        row({ chosenSenseId: 's2' }),
        row({ options: [], chosenSenseId: null, suggestedSenseId: null, ticked: false }),
      ]),
    ).toEqual({ unticked: 1, changedSense: 1 });
  });
});

describe('optionsFrom', () => {
  it('keeps the saveable senses, in the lookup order, with what the list shows', () => {
    expect(
      optionsFrom([
        { translation: 'בנק', part_of_speech: 'noun', sense_id: 's1', variant_id: 'v1', saved: false },
        { translation: 'אין מזהה' },
        { translation: 'גדה', sense_id: 's2', variant_id: 'v1', example: { source: 'the bank', target: 'הגדה' } },
      ]),
    ).toEqual([
      { sense_id: 's1', variant_id: 'v1', translation: 'בנק', part_of_speech: 'noun' },
      { sense_id: 's2', variant_id: 'v1', translation: 'גדה', example: { source: 'the bank', target: 'הגדה' } },
    ]);
  });
});

describe('reasonFor', () => {
  it('says why a row has no options', () => {
    expect(reasonFor({ kind: 'word', reason: 'out_of_pair' })).toBe('not_in_language');
    expect(reasonFor({ kind: 'sentence' })).toBe('sentence');
    expect(reasonFor({ kind: 'word' })).toBe('no_meaning');
  });
});
