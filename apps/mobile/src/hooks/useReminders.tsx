import { createContext, useContext, type ReactNode } from 'react';

import type { Reminders } from '@/reminders';

// Phase 52 (spec D8). The one reminders object, built at the composition root
// with its expo-notifications engine (ADR 0002 R1), for Home, Profile and the
// Reminders screen. No screen names expo-notifications.
const RemindersContext = createContext<Reminders | null>(null);

export function RemindersProvider({ reminders, children }: { reminders: Reminders; children: ReactNode }) {
  return <RemindersContext.Provider value={reminders}>{children}</RemindersContext.Provider>;
}

export function useReminders(): Reminders {
  const value = useContext(RemindersContext);
  if (!value) throw new Error('useReminders must be used inside a RemindersProvider');
  return value;
}
