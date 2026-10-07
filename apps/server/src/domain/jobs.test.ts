import { describe, expect, it } from '@jest/globals';

import { PrepareSessionPayloadSchema } from './jobs';

describe('PrepareSessionPayloadSchema', () => {
  // Review Focus 3: a job enqueued before phase 24 has neither field.
  it('reads a payload from before phase 24 as listening off, at the first ordinal', () => {
    expect(
      PrepareSessionPayloadSchema.parse({ session_id: 's', picks: [{ sense_id: 'a', variant_id: 'b' }] }),
    ).toMatchObject({ listening: false, ordinal: 0 });
  });

  it('keeps both when present', () => {
    expect(
      PrepareSessionPayloadSchema.parse({
        session_id: 's',
        picks: [{ sense_id: 'a', variant_id: 'b' }],
        listening: true,
        ordinal: 4,
      }),
    ).toMatchObject({ listening: true, ordinal: 4 });
  });
});
