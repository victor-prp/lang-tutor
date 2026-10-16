import type { CreateSessionResponse, TargetList } from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSessionDevices } from '@/hooks/useSessionDevices';
import { targetsFor, type StoredTargets } from '@/targets';

// Phase 53 (spec D11). The active enrollment's targets, for home. Constructed at the
// composition root with the api client passed in (ADR 0002). The server is the single
// source of truth: nothing is cached beyond the last read, and home reads again on
// every focus.
export type TargetsContext = {
  /** The active targets, nearest date first, with the learner's today (the date step
   *  offers the days after it). Null until a read for the active enrollment lands. */
  list: TargetList | null;
  /** Reads the list again. Never rejects: answers the list this read brought, and null when
   *  it failed, which leaves the list as it was. A reminder judges on the list itself, never on
   *  a render's (final review CI-1). */
  reload(): Promise<TargetList | null>;
  /** Phase 57 (spec D1). Creates the next session of a target's own path, built for this
   *  device, or answers its stock (final review C1: replaced first when it no longer serves the
   *  day), then reads the list again (its card shows it preparing). `waitForVoices: false` when
   *  the path has a stock, whose devices create uses (targetPress). Throws as the api does:
   *  `target closed` once the target has ended. */
  create(targetId: string, options?: { waitForVoices?: boolean }): Promise<CreateSessionResponse>;
};

const TargetsValueContext = createContext<TargetsContext | null>(null);

export function TargetsProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const { active } = useCurrentUser();
  const devices = useSessionDevices();
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
  const reload = useCallback(async (): Promise<TargetList | null> => {
    if (!active) return null;
    const enrollmentId = active.id;
    const mine = ++started.current;
    try {
      const read = await api.listTargets(enrollmentId);
      // A newer read is already shown; this one is still the list as this call found it.
      if (mine >= applied.current) {
        applied.current = mine;
        setStored({ enrollmentId, list: read });
      }
      return read;
    } catch {
      // Home keeps the list it has, and the next focus reads again.
      return null;
    }
  }, [api, active]);

  const create = useCallback(
    async (targetId: string, options?: { waitForVoices?: boolean }) => {
      if (!active) throw new Error('cannot create a session with no active enrollment');
      try {
        return await api.createSession({
          enrollment_id: active.id,
          target_id: targetId,
          ...(await devices(active.target_language, options?.waitForVoices ?? true)),
        });
      } finally {
        // Awaited, so the card's button stays busy until it shows the session preparing:
        // a second tap before the read lands would send a second create.
        await reload();
      }
    },
    [api, active, devices, reload],
  );

  const value = useMemo<TargetsContext>(() => ({ list, reload, create }), [list, reload, create]);
  return <TargetsValueContext.Provider value={value}>{children}</TargetsValueContext.Provider>;
}

export function useTargets(): TargetsContext {
  const value = useContext(TargetsValueContext);
  if (!value) throw new Error('useTargets must be used inside a TargetsProvider');
  return value;
}
