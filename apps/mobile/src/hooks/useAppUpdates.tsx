import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { AppUpdates, UpdateRequiredEvents } from '@/appUpdates';
import { UpdateRequired } from '@/components/UpdateRequired';
import type { AppRelease } from '@/release';

// Phase 32 (spec D8–D10). Feeds AppState to the update policy, swaps the
// navigator for the update-required screen once the server answers 426, and
// carries the release the profile and About screens show (phase 49), with the
// clipboard About copies it to. Every collaborator comes from the composition
// root (ADR 0002).
type ReleaseValue = { release: AppRelease; copy: (text: string) => Promise<boolean> };
const ReleaseContext = createContext<ReleaseValue | null>(null);

export function AppUpdatesProvider({
  updates,
  events,
  release,
  copy,
  children,
}: {
  updates: AppUpdates;
  events: UpdateRequiredEvents;
  release: AppRelease;
  copy: (text: string) => Promise<boolean>;
  children: ReactNode;
}) {
  const [updateRequired, setUpdateRequired] = useState(false);

  useEffect(() => events.onUpdateRequired(() => setUpdateRequired(true)), [events]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      void updates.onAppStateChange(state);
    });
    return () => subscription.remove();
  }, [updates]);

  const value = useMemo(() => ({ release, copy }), [release, copy]);

  return (
    <ReleaseContext.Provider value={value}>
      {updateRequired ? <UpdateRequired updates={updates} /> : children}
    </ReleaseContext.Provider>
  );
}

export function useAppRelease(): ReleaseValue {
  const value = useContext(ReleaseContext);
  if (value === null) throw new Error('useAppRelease must be used inside an AppUpdatesProvider');
  return value;
}
