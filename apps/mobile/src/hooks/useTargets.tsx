import type { TargetList } from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { targetsFor, type StoredTargets } from '@/targets';

// Phase 53 (spec D11). The active enrollment's targets, for home. Constructed at the
// composition root with the api client passed in (ADR 0002). The server is the single
// source of truth: nothing is cached beyond the last read, and home reads again on
// every focus.
export type TargetsContext = {
  /** The active targets, nearest date first, with the learner's today (the date step
   *  offers the days after it). Null until a read for the active enrollment lands. */
  list: TargetList | null;
  /** Reads the list again. Never rejects: a read that fails leaves the list as it was. */
  reload(): Promise<void>;
};

const TargetsValueContext = createContext<TargetsContext | null>(null);

export function TargetsProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const { active } = useCurrentUser();
  // Keyed by the enrollment each read was about, not cleared on a switch: a slow answer
  // about Russian lands under Russian's id and is never shown while English is active
  // (see targetsFor). Clearing in an effect instead would run after home's own focus
  // effect (children first) and discard the read that effect started on the switch.
  const [stored, setStored] = useState<StoredTargets | null>(null);
  const list = targetsFor(stored, active?.id);
  // Reads are numbered as they start, and an answer is shown unless a newer read has
  // already been, so a slow read never replaces the one that started after it.
  const started = useRef(0);
  const applied = useRef(0);

  // A stable identity while the enrollment holds: home hands it to useFocusEffect, and a
  // new function on every render would read again on every state change.
  const reload = useCallback(async () => {
    if (!active) return;
    const enrollmentId = active.id;
    const mine = ++started.current;
    try {
      const read = await api.listTargets(enrollmentId);
      if (mine < applied.current) return;
      applied.current = mine;
      setStored({ enrollmentId, list: read });
    } catch {
      // Home keeps the list it has, and the next focus reads again.
    }
  }, [api, active]);

  const value = useMemo<TargetsContext>(() => ({ list, reload }), [list, reload]);
  return <TargetsValueContext.Provider value={value}>{children}</TargetsValueContext.Provider>;
}

export function useTargets(): TargetsContext {
  const value = useContext(TargetsValueContext);
  if (!value) throw new Error('useTargets must be used inside a TargetsProvider');
  return value;
}
