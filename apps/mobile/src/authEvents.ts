/**
 * Phase 29 (spec D19). The API client learns of a 401 before anyone holding
 * the signed-in state does; this is how it tells them. Built in _layout.tsx.
 */
export function createAuthEvents() {
  const listeners = new Set<() => void>();
  return {
    unauthorized: (): void => {
      for (const listener of [...listeners]) listener();
    },
    onUnauthorized: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type AuthEvents = ReturnType<typeof createAuthEvents>;
