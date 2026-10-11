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
  it('reads a payload from before phase 24 as listening off, at the first ordinal', () => {
    expect(
      PrepareSessionPayloadSchema.parse({ session_id: 's', picks: [{ gloss_id: 'g', sense_id: 'a', variant_id: 'b' }] }),
    ).toMatchObject({ listening: false, ordinal: 0 });
  });

  it('keeps both when present', () => {
    expect(
      PrepareSessionPayloadSchema.parse({
        session_id: 's',
        picks: [{ gloss_id: 'g', sense_id: 'a', variant_id: 'b' }],
        listening: true,
        ordinal: 4,
      }),
    ).toMatchObject({ listening: true, ordinal: 4 });
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
