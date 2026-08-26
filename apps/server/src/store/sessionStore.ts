import type { SessionRecord } from '../session';

export const STALE_AFTER_MS = 5 * 60 * 1000;

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore() {
  const sessions = new Map<string, SessionRecord>();

  function sweepStale(now: number): void {
    for (const [id, record] of sessions) {
      if (record.complete && record.completed_at !== null && now - record.completed_at > STALE_AFTER_MS) {
        sessions.delete(id);
      }
    }
  }

  return {
    // Evicting immediately on completion would break next-step's idempotent
    // retry (see session.ts's `step`): a lost response + client retry would
    // 404 instead of replaying. Sweeping only stale-and-complete entries,
    // opportunistically on the next insert, keeps memory bounded without
    // punishing a same-moment retry.
    insert(record: SessionRecord, now: number = Date.now()): string {
      sweepStale(now);
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, record);
      return sessionId;
    },
    get(sessionId: string): SessionRecord | undefined {
      return sessions.get(sessionId);
    },
    set(sessionId: string, record: SessionRecord): void {
      sessions.set(sessionId, record);
    },
  };
}
