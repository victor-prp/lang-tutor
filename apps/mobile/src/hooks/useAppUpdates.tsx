import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { AppUpdates, UpdateRequiredEvents } from '@/appUpdates';
import { UpdateRequired } from '@/components/UpdateRequired';

// Phase 32 (spec D8–D10). Feeds AppState to the update policy, swaps the
// navigator for the update-required screen once the server answers 426, and
// carries the release tag the profile screen shows. Every collaborator comes
// from the composition root (ADR 0002).
const AppVersionContext = createContext<string | null>(null);

export function AppUpdatesProvider({
  updates,
  events,
  version,
  children,
}: {
  updates: AppUpdates;
  events: UpdateRequiredEvents;
  version: string;
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

  return (
    <AppVersionContext.Provider value={version}>
      {updateRequired ? <UpdateRequired updates={updates} /> : children}
    </AppVersionContext.Provider>
  );
}

export function useAppVersion(): string {
  const value = useContext(AppVersionContext);
  if (value === null) throw new Error('useAppVersion must be used inside an AppUpdatesProvider');
  return value;
}
