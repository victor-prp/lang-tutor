import { describe, expect, it } from '@jest/globals';

import { DAY_CAP_OPTIONS, PER_SESSION_OPTIONS, capNoticeDue, withDayCap, withPerSession } from './newWordLimits';

describe('the new-word limits screen (phase 70, spec D7)', () => {
  it('offers the caps and the per-session choices the spec names, automatic first', () => {
    expect(DAY_CAP_OPTIONS).toEqual([5, 10, 15, 20, 30, 50]);
    expect(PER_SESSION_OPTIONS).toEqual([null, 1, 2]);
  });

  it('builds the whole body a save sends from one tap', () => {
    const limits = { day_cap: 15, per_session: null };
    expect(withDayCap(limits, 30)).toEqual({ day_cap: 30, per_session: null });
    expect(withPerSession({ day_cap: 30, per_session: 2 }, null)).toEqual({ day_cap: 30, per_session: null });
    expect(withPerSession(limits, 1)).toEqual({ day_cap: 15, per_session: 1 });
  });
});

describe('when the message opens (phase 70, spec D6)', () => {
  const held = { count: 2, dayCap: 15 };

  it('opens on the first card of a session the cap held words back from, once', () => {
    expect(capNoticeDue({ held, position: 1, shown: false })).toBe(true);
    expect(capNoticeDue({ held, position: 1, shown: true })).toBe(false);
  });

  it('stays closed once a card is answered, and on a session the cap did not touch', () => {
    expect(capNoticeDue({ held, position: 2, shown: false })).toBe(false);
    expect(capNoticeDue({ held: null, position: 1, shown: false })).toBe(false);
  });
});
