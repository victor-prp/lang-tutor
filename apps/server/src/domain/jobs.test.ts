import { describe, expect, it } from '@jest/globals';

import {
  ACCEPT_RENDERING_EXPIRY_SECONDS,
  AcceptRenderingPayloadSchema,
  LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS,
  LookUpImportItemPayloadSchema,
  PHOTO_READ_BUDGET_MS,
  PrepareSessionPayloadSchema,
  READ_PHOTO_EXPIRY_SECONDS,
  ReadPhotoPayloadSchema,
  STOCK_SAVE_DELAY_SECONDS,
  StockSessionPayloadSchema,
  acceptRenderingKey,
} from './jobs';

describe('phase 26 queues', () => {
  it('expires a read at twice its budget, and a row lookup after three lookup-sized calls with room to spare', () => {
    expect(READ_PHOTO_EXPIRY_SECONDS).toBe((2 * PHOTO_READ_BUDGET_MS) / 1000);
    expect(PHOTO_READ_BUDGET_MS).toBe(120_000);
    expect(LOOK_UP_IMPORT_ITEM_EXPIRY_SECONDS).toBe(180);
  });

  it('parses both payloads', () => {
    expect(ReadPhotoPayloadSchema.parse({ import_id: 'i1' })).toEqual({ import_id: 'i1' });
    expect(LookUpImportItemPayloadSchema.parse({ import_id: 'i1', position: 3 })).toEqual({ import_id: 'i1', position: 3 });
    expect(LookUpImportItemPayloadSchema.safeParse({ import_id: 'i1', position: -1 }).success).toBe(false);
  });
});

describe('PrepareSessionPayloadSchema', () => {
  // Review Focus 3: a job enqueued before phase 24 has neither field.
  it('reads a payload from before phase 24 as listening off', () => {
    expect(
      PrepareSessionPayloadSchema.parse({ session_id: 's', picks: [{ gloss_id: 'g', sense_id: 'a', variant_id: 'b' }] }),
    ).toMatchObject({ listening: false });
  });

  // Phase 35 (spec D6): the rotation is gone, and its step with it.
  it('keeps listening when present, and drops the ordinal of a job from before phase 35', () => {
    const parsed = PrepareSessionPayloadSchema.parse({
      session_id: 's',
      picks: [{ gloss_id: 'g', sense_id: 'a', variant_id: 'b' }],
      listening: true,
      ordinal: 4,
    });
    expect(parsed).toMatchObject({ listening: true });
    expect(parsed).not.toHaveProperty('ordinal');
  });

  // Phase 35 (spec D5, D6). Each pick carries its dimension, rung, level and R.
  it('reads a pick from before phase 35 as a new word: written receptive, rung 1, level 1, no R', () => {
    const [pick] = PrepareSessionPayloadSchema.parse({ session_id: 's', picks: [{ gloss_id: 'g', sense_id: 'a', variant_id: 'b' }] }).picks;
    expect(pick).toEqual({ gloss_id: 'g', sense_id: 'a', variant_id: 'b', dimension: 'written_receptive', rung: 1, level: 1, r: null, step: false });
  });

  // Phase 37 (spec D6). Review Focus 3: a pick from before the deploy is no return.
  it('reads a pick from before phase 37 as no same-day return', () => {
    const pick = { gloss_id: 'g', sense_id: 'a', variant_id: 'b', dimension: 'spelling', rung: 2, level: 4, r: 0.8 };
    expect(PrepareSessionPayloadSchema.parse({ session_id: 's', picks: [pick] }).picks).toEqual([{ ...pick, step: false }]);
  });

  it('keeps a chosen pick, and refuses an unknown dimension, rung or an R outside 0..1', () => {
    const pick = { gloss_id: 'g', sense_id: 'a', variant_id: 'b', dimension: 'spelling', rung: 2, level: 4, r: 0.8, step: true };
    expect(PrepareSessionPayloadSchema.parse({ session_id: 's', picks: [pick] }).picks).toEqual([pick]);
    for (const bad of [{ dimension: 'smell' }, { rung: 3 }, { r: 1.5 }, { level: 6 }, { step: 'yes' }]) {
      expect(PrepareSessionPayloadSchema.safeParse({ session_id: 's', picks: [{ ...pick, ...bad }] }).success).toBe(false);
    }
  });
});

describe('phase 34 accept queue (spec D1)', () => {
  it('expires an attempt after two minutes, and keys a job by its rendering', () => {
    expect(ACCEPT_RENDERING_EXPIRY_SECONDS).toBe(120);
    const payload = AcceptRenderingPayloadSchema.parse({ variant_id: 'v1', sense_id: 's1', user_language_code: 'he' });
    expect(acceptRenderingKey(payload)).toBe('v1:s1:he');
    expect(AcceptRenderingPayloadSchema.safeParse({ variant_id: 'v1', sense_id: 's1' }).success).toBe(false);
  });
});

describe('StockSessionPayloadSchema (phase 43 D3)', () => {
  it('carries the device only on a start', () => {
    expect(StockSessionPayloadSchema.parse({ enrollment_id: 'e', reason: 'start', listening: true, speaking: false })).toEqual({
      enrollment_id: 'e',
      reason: 'start',
      listening: true,
      speaking: false,
    });
    expect(StockSessionPayloadSchema.parse({ enrollment_id: 'e', reason: 'complete' })).toEqual({ enrollment_id: 'e', reason: 'complete' });
  });

  it('refuses a reason it does not know, and an empty enrollment', () => {
    expect(StockSessionPayloadSchema.safeParse({ enrollment_id: 'e', reason: 'whim' }).success).toBe(false);
    expect(StockSessionPayloadSchema.safeParse({ enrollment_id: '', reason: 'save' }).success).toBe(false);
  });

  it('waits half a minute after a save (ruling R3)', () => {
    expect(STOCK_SAVE_DELAY_SECONDS).toBe(30);
  });
});
