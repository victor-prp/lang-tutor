import { describe, expect, it } from '@jest/globals';

import { dayInTimeZone, isoWeekday, isTimeZone, localMinutes } from './learnerClock';

// Phase 52 (spec D1). One instant, read on the clock of the learner's zone.

const EVENING_UTC = Date.UTC(2026, 9, 14, 22, 30);

describe('dayInTimeZone', () => {
  it('is the next date east of UTC once it is past midnight there', () => {
    expect(dayInTimeZone(EVENING_UTC, 'Asia/Jerusalem')).toBe('2026-10-15');
  });

  it('is the same date west of UTC', () => {
    expect(dayInTimeZone(EVENING_UTC, 'America/New_York')).toBe('2026-10-14');
  });

  it('is the UTC date for UTC', () => {
    expect(dayInTimeZone(EVENING_UTC, 'UTC')).toBe('2026-10-14');
  });
});

describe('localMinutes', () => {
  it('counts minutes since local midnight', () => {
    expect(localMinutes(EVENING_UTC, 'America/New_York')).toBe(18 * 60 + 30);
  });

  it('reads midnight as 0, never 24:00', () => {
    expect(localMinutes(Date.UTC(2026, 9, 14, 0, 0), 'UTC')).toBe(0);
  });

  it('follows the daylight-saving change in New York on 2026-11-01', () => {
    // 05:30Z is 01:30 EDT; the clocks go back at 06:00Z, so 06:30Z is 01:30 EST.
    expect(localMinutes(Date.UTC(2026, 10, 1, 5, 30), 'America/New_York')).toBe(60 + 30);
    expect(localMinutes(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York')).toBe(60 + 30);
  });
});

describe('isoWeekday', () => {
  it('is 7 for a Sunday', () => {
    expect(isoWeekday(Date.UTC(2026, 9, 18, 12), 'UTC')).toBe(7);
  });

  it('is 1 for a Monday', () => {
    expect(isoWeekday(Date.UTC(2026, 9, 19, 12), 'UTC')).toBe(1);
  });

  it('follows the learner’s date, not the UTC one', () => {
    // Sunday 22:30 UTC is already Monday in Jerusalem.
    expect(isoWeekday(Date.UTC(2026, 9, 18, 22, 30), 'Asia/Jerusalem')).toBe(1);
  });
});

describe('isTimeZone', () => {
  it('accepts an IANA name', () => {
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Pacific/Auckland')).toBe(true);
  });

  it('refuses a name that is not a zone', () => {
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});
