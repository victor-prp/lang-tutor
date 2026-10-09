import { describe, expect, it, jest } from '@jest/globals';

import { createAuthEvents } from './authEvents';

describe('createAuthEvents', () => {
  it('tells every listener, and stops telling one that unsubscribed', () => {
    const events = createAuthEvents();
    const a = jest.fn();
    const b = jest.fn();
    const stopA = events.onUnauthorized(a);
    events.onUnauthorized(b);
    events.unauthorized();
    stopA();
    events.unauthorized();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
