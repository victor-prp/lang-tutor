import { describe, expect, it } from '@jest/globals';
import type { PhotoImport, PhotoImportItem } from '@lang-tutor/core/api';

import { importsReviewOf, withImportChanged, type ReadImports } from './importsReview';

// Phase 53 (spec D10, ruling R-D9). Each photo is its own import, and the wizard reviews
// their rows as one list, as the server's save takes them.

const ltr = (text: string) => '⁦' + text + '⁩';
const option = (gloss: string) => ({ gloss_id: gloss, variant_id: `v-${gloss}`, translation: `t-${gloss}` });
const item = (position: number, gloss: string | null, over: Partial<PhotoImportItem> = {}): PhotoImportItem => ({
  position,
  text: `w${position}`,
  hebrew: null,
  status: 'ready',
  corrected_form: null,
  options: gloss === null ? [] : [option(gloss)],
  chosen_gloss_id: gloss,
  ticked: gloss !== null,
  hebrew_mismatch: false,
  reason: null,
  ...over,
});
const imp = (id: string, status: PhotoImport['status'], items: PhotoImportItem[] = [], settled = items.length): PhotoImport => ({
  id,
  status,
  item_count: items.length,
  settled_count: settled,
  created_at: '2026-10-15T10:00:00Z',
  items,
});
const byId = (...imports: PhotoImport[]): ReadImports => Object.fromEntries(imports.map((one) => [one.id, one]));
const at = (rows: { importId: string; item: PhotoImportItem }[]) => rows.map(({ importId, item: row }) => `${importId}:${row.position}`);

describe('importsReviewOf', () => {
  it('lists the rows of every import in import order, then by position', () => {
    const review = importsReviewOf(
      ['b', 'a'],
      byId(imp('a', 'ready', [item(0, 'g1'), item(1, 'g2')]), imp('b', 'ready', [item(0, 'g3'), item(1, 'g4')])),
    );
    expect(at(review.rows)).toEqual(['b:0', 'b:1', 'a:0', 'a:1']);
  });

  it('shows a gloss once, at its first row, as the server saves it', () => {
    const review = importsReviewOf(
      ['a', 'b'],
      byId(
        imp('a', 'ready', [item(0, 'g1'), item(1, 'g2'), item(2, 'g1')]),
        imp('b', 'ready', [item(0, 'g2'), item(1, 'g3')]),
      ),
    );
    expect(at(review.rows)).toEqual(['a:0', 'a:1', 'b:1']);
  });

  it('keeps every row with no gloss yet, still looked up or with nothing to save', () => {
    const review = importsReviewOf(
      ['a', 'b'],
      byId(
        imp('a', 'looking_up', [item(0, null, { status: 'pending' }), item(1, 'g1')], 1),
        imp('b', 'ready', [item(0, null, { reason: 'sentence' }), item(1, 'g1')]),
      ),
    );
    expect(at(review.rows)).toEqual(['a:0', 'a:1', 'b:0']);
  });

  it('follows a change of sense: a row hidden behind an earlier one shows once that one moves', () => {
    const before = byId(imp('a', 'ready', [item(0, 'g1')]), imp('b', 'ready', [item(0, 'g1')]));
    expect(at(importsReviewOf(['a', 'b'], before).rows)).toEqual(['a:0']);
    const moved = byId(
      imp('a', 'ready', [item(0, 'g1', { options: [option('g1'), option('g5')], chosen_gloss_id: 'g5' })]),
      imp('b', 'ready', [item(0, 'g1')]),
    );
    expect(at(importsReviewOf(['a', 'b'], moved).rows)).toEqual(['a:0', 'b:0']);
  });

  it('counts a failed import as a photo not read, and shows nothing of it', () => {
    const review = importsReviewOf(['a', 'b', 'c'], byId(imp('a', 'failed'), imp('b', 'ready', [item(0, 'g1')]), imp('c', 'failed')));
    expect(review.unread).toBe(2);
    expect(at(review.rows)).toEqual(['b:0']);
    expect(importsReviewOf(['b'], byId(imp('b', 'ready', [item(0, 'g1')]))).unread).toBe(0);
  });

  it('is settled once every import is read and none is reading or looking up', () => {
    const ready = imp('a', 'ready', [item(0, 'g1')]);
    expect(importsReviewOf(['a'], byId(ready)).settled).toBe(true);
    expect(importsReviewOf(['a', 'b'], byId(ready, imp('b', 'failed'))).settled).toBe(true);
    expect(importsReviewOf(['a', 'b'], byId(ready)).settled).toBe(false);
    expect(importsReviewOf(['a', 'b'], byId(ready, imp('b', 'reading'))).settled).toBe(false);
    expect(importsReviewOf(['a', 'b'], byId(ready, imp('b', 'looking_up', [item(0, null, { status: 'pending' })], 0))).settled).toBe(false);
  });

  it('names the imports still to read: not read yet, reading, or looking up, in import order', () => {
    const review = importsReviewOf(
      ['a', 'b', 'c', 'd', 'e'],
      byId(imp('a', 'ready'), imp('b', 'reading'), imp('d', 'looking_up'), imp('e', 'failed')),
    );
    expect(review.waiting).toEqual(['b', 'c', 'd']);
    expect(importsReviewOf(['a'], byId(imp('a', 'ready'))).waiting).toEqual([]);
  });

  it('says it is reading while a photo is being read or not read yet, and counts the lookups after', () => {
    expect(importsReviewOf(['a'], {}).status).toBe('קוראים את התמונות…');
    expect(importsReviewOf(['a', 'b'], byId(imp('a', 'ready', [item(0, 'g1')]), imp('b', 'reading'))).status).toBe(
      'קוראים את התמונות…',
    );
    const lookingUp = importsReviewOf(
      ['a', 'b', 'c'],
      byId(
        imp('a', 'ready', [item(0, 'g1'), item(1, 'g2')]),
        imp('b', 'looking_up', [item(0, 'g3'), item(1, null, { status: 'pending' }), item(2, null, { status: 'pending' })], 1),
        imp('c', 'failed'),
      ),
    );
    expect(lookingUp.status).toBe('מחפשים מילים: ' + ltr('3/5'));
    expect(importsReviewOf(['a'], byId(imp('a', 'ready', [item(0, 'g1')]))).status).toBeNull();
  });

  it('is empty only once settled with no row to show', () => {
    expect(importsReviewOf(['a'], byId(imp('a', 'failed'))).empty).toBe(true);
    expect(importsReviewOf(['a'], byId(imp('a', 'ready'))).empty).toBe(true);
    expect(importsReviewOf(['a'], byId(imp('a', 'reading'))).empty).toBe(false);
    expect(importsReviewOf(['a'], byId(imp('a', 'ready', [item(0, 'g1')]))).empty).toBe(false);
  });

  it('is settled and empty with no imports at all', () => {
    expect(importsReviewOf([], {})).toEqual({ rows: [], waiting: [], settled: true, unread: 0, empty: true, status: null });
  });
});

describe('withImportChanged', () => {
  it('changes the one import, and leaves the others and an import not read yet alone', () => {
    const imports = byId(imp('a', 'reading'), imp('b', 'reading'));
    const changed = withImportChanged(imports, 'a', (one) => ({ ...one, status: 'ready' }));
    expect(changed.a.status).toBe('ready');
    expect(changed.b).toBe(imports.b);
    expect(imports.a.status).toBe('reading');
    expect(withImportChanged(imports, 'z', (one) => ({ ...one, status: 'ready' }))).toBe(imports);
  });
});
