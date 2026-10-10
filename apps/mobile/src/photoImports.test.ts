import { describe, expect, it } from '@jest/globals';
import type { PhotoImport, PhotoImportItem, PhotoImportSummary } from '@lang-tutor/core/api';

import { ApiError } from './api/client';
import {
  afterFailedChange,
  afterReadBack,
  canSave,
  chosenOption,
  homePhotoCard,
  importsFor,
  mergePolled,
  rowNotes,
  savedWordCount,
  shouldPollImport,
  statusLabel,
  tickedCount,
  withChange,
} from './photoImports';
import { strings } from './strings';

const option = (n: number) => ({ gloss_id: `s${n}`, variant_id: `v${n}`, translation: `t${n}` });
const item = (position: number, over: Partial<PhotoImportItem> = {}): PhotoImportItem => ({
  position, text: `w${position}`, hebrew: null, status: 'ready', corrected_form: null,
  options: [option(1), option(2)], chosen_gloss_id: 's1', ticked: true, hebrew_mismatch: false, reason: null, ...over,
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
    const next = withChange(imp([item(0), item(1)]), 1, { ticked: false, gloss_id: 's2' });
    expect(next.items[1]).toMatchObject({ ticked: false, chosen_gloss_id: 's2' });
    expect(next.items[0]).toEqual(item(0));
    expect(chosenOption(next.items[1])).toEqual(option(2));
  });
});

describe('mergePolled', () => {
  it('takes the server’s rows, except those with a change still in flight', () => {
    const local = withChange(imp([item(0), item(1, { status: 'pending', options: [], chosen_gloss_id: null, ticked: false })], 'looking_up'), 0, { ticked: false });
    const polled = imp([item(0), item(1)], 'ready');
    const merged = mergePolled(polled, local, new Set([0]));
    expect(merged.status).toBe('ready');
    expect(merged.items[0].ticked).toBe(false);
    expect(merged.items[1]).toEqual(item(1));
  });
});

describe('afterFailedChange', () => {
  it('puts the row back when the server answered and refused it', () => {
    expect(afterFailedChange(new ApiError(409))).toBe('revert');
    expect(afterFailedChange(new ApiError(400, 'invalid request'))).toBe('revert');
  });

  // No answer is not a refusal: the change may have landed, and only a read
  // can tell. Keeping the row local would show one state while Save saves another.
  it('reads the server’s row when no answer came back', () => {
    expect(afterFailedChange(new TypeError('Network request failed'))).toBe('adopt_server');
    expect(afterFailedChange(new Error('The operation was aborted'))).toBe('adopt_server');
    expect(afterFailedChange('anything else')).toBe('adopt_server');
  });
});

describe('afterReadBack', () => {
  // The read that follows a change with no answer. Until it answers the row
  // stays held, so Save cannot save a state the screen is unsure of.
  it('releases the row to the server’s copy once the read lands, or a newer read already has', () => {
    expect(afterReadBack('applied')).toBe('release');
    expect(afterReadBack('superseded')).toBe('release');
  });

  // Offline: the change and the read both failed. The change almost certainly
  // never arrived, so the row goes back to what it was rather than showing it done.
  it('puts the row back when the read fails too', () => {
    expect(afterReadBack('failed')).toBe('revert');
  });
});

describe('savedWordCount', () => {
  // A save whose answer was lost: the import read back says it landed.
  it('counts what a saved import saved, one word per chosen sense of a ticked row', () => {
    const rows = [
      item(0),
      item(1, { chosen_gloss_id: 's2' }),
      item(2, { ticked: false }),
      item(3), // the same sense as row 0: saved once
      item(4, { status: 'failed', options: [], chosen_gloss_id: null, ticked: false }),
    ];
    expect(savedWordCount(imp(rows, 'saved'))).toBe(2);
  });

  it('answers null for an import the save did not land on', () => {
    expect(savedWordCount(null)).toBeNull();
    expect(savedWordCount(imp([item(0)], 'ready'))).toBeNull();
    expect(savedWordCount(imp([item(0)], 'discarded'))).toBeNull();
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

describe('statusLabel', () => {
  it('says what an open import is doing, with the rows looked up so far', () => {
    expect(statusLabel(summary('a', 'reading'))).toBe(strings.photoImportReading);
    expect(statusLabel({ ...summary('a', 'looking_up', 32), settled_count: 12 })).toBe(
      strings.photoImportLookingUp(12, 32),
    );
    expect(statusLabel(summary('a', 'ready'))).toBe(strings.photoImportReady);
    expect(statusLabel(summary('a', 'failed'))).toBe(strings.photoImportFailed);
  });

  it('says nothing for an import that is no longer open', () => {
    expect(statusLabel(summary('a', 'saved'))).toBeNull();
    expect(statusLabel(summary('a', 'discarded'))).toBeNull();
  });
});

describe('rowNotes', () => {
  it('has none for a row read and matched as printed', () => {
    expect(rowNotes(item(0))).toEqual([]);
  });

  it('names what was read when the lookup corrected it, and the Hebrew that named no sense', () => {
    const row = item(0, { text: 'gatlo', corrected_form: 'gatto', hebrew: 'גדה', hebrew_mismatch: true });
    expect(rowNotes(row)).toEqual([strings.photoImportReadAs('gatlo'), strings.photoImportListSays('גדה')]);
  });

  it('says why a row has nothing to save', () => {
    const none = { options: [], chosen_gloss_id: null, ticked: false };
    expect(rowNotes(item(0, { ...none, reason: 'sentence' }))).toEqual([strings.photoImportReasonSentence]);
    expect(rowNotes(item(0, { ...none, reason: 'no_meaning' }))).toEqual([strings.photoImportReasonNoMeaning]);
    expect(rowNotes(item(0, { ...none, reason: 'not_in_language' }))).toEqual([strings.photoImportReasonNotInLanguage]);
    expect(rowNotes(item(0, { ...none, status: 'failed' }))).toEqual([strings.photoImportRowFailed]);
  });
});

describe('importsFor', () => {
  // Keyed rather than cleared on a switch: a clearing effect in the provider runs
  // after home's own focus effect (children first) and would discard its read.
  it('shows a list only under the enrollment it was read for', () => {
    const stored = { enrollmentId: 'e1', imports: [summary('a', 'ready')] };
    expect(importsFor(stored, 'e1')).toEqual([summary('a', 'ready')]);
    expect(importsFor(stored, 'e2')).toEqual([]);
    expect(importsFor(stored, undefined)).toEqual([]);
    expect(importsFor(null, 'e1')).toEqual([]);
  });

  it('answers the same empty list every time, so a memo keyed on it holds', () => {
    expect(importsFor(null, 'e1')).toBe(importsFor({ enrollmentId: 'e1', imports: [] }, 'e2'));
  });
});
