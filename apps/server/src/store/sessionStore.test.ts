import { describe, expect, it } from '@jest/globals';

import type { SessionRecord } from '../domain/session';
import { STALE_AFTER_MS, createSessionStore } from './sessionStore';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    user_id: 'u1',
    questions: [],
    answers: [],
    complete: false,
    completed_at: null,
    ...overrides,
  };
}

describe('createSessionStore', () => {
  it('insert generates an id and stores the record, retrievable via get', () => {
    const store = createSessionStore();
    const record = makeRecord();
    const id = store.insert(record);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(store.get(id)).toBe(record);
  });

  it('insert never reuses an id across two calls', () => {
    const store = createSessionStore();
    const idA = store.insert(makeRecord());
    const idB = store.insert(makeRecord());
    expect(idA).not.toBe(idB);
  });

  it('get returns undefined for an unknown id', () => {
    const store = createSessionStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('set replaces the stored record for an existing id', () => {
    const store = createSessionStore();
    const id = store.insert(makeRecord());
    const updated = makeRecord({ complete: true, completed_at: 123 });
    store.set(id, updated);
    expect(store.get(id)).toBe(updated);
  });

  it('sweeps completed sessions older than STALE_AFTER_MS on the next insert, keeping newer ones', () => {
    const store = createSessionStore();
    const staleId = store.insert(makeRecord({ complete: true, completed_at: 0 }), 0);
    const freshId = store.insert(makeRecord({ complete: true, completed_at: 1000 }), 1000);

    // Triggers a sweep at a time well past STALE_AFTER_MS for staleId but not freshId.
    store.insert(makeRecord(), 1000 + STALE_AFTER_MS);

    expect(store.get(staleId)).toBeUndefined();
    expect(store.get(freshId)).toBeDefined();
  });
});
