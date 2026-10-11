/**
 * Phase 32 (spec D8, D9). When the installed app takes an over-the-air update,
 * beyond the cold start, which expo-updates handles natively
 * (`checkAutomatically: ON_LOAD`, `fallbackToCacheTimeout`).
 *
 * Android keeps an app in memory for days, so a friend who only ever switches
 * back to it would never cold-start. Returning after `minBackgroundMs` or more
 * checks, fetches and reloads. A session lives on the server, so the reload
 * reopens where the learner was. The app never reloads while it stays in the
 * foreground: nobody is interrupted mid-answer.
 *
 * The engine is expo-updates, built in _layout.tsx (ADR 0002 R1). Disabled in
 * Expo Go, in development and on web, where every call here is a no-op.
 */
export type UpdatesEngine = {
  isEnabled: boolean;
  /** Whether the server has an update for this build's runtime. */
  check: () => Promise<boolean>;
  fetch: () => Promise<void>;
  reload: () => Promise<void>;
};

export type AppUpdatesDeps = {
  engine: UpdatesEngine;
  now: () => number;
  minBackgroundMs: number;
};

export function createAppUpdates({ engine, now, minBackgroundMs }: AppUpdatesDeps) {
  let backgroundedAt: number | null = null;

  async function apply(): Promise<boolean> {
    if (!engine.isEnabled) return false;
    if (!(await engine.check())) return false;
    await engine.fetch();
    await engine.reload();
    return true;
  }

  return {
    /** Fed every AppState change. Resolves once any check it started is over. */
    async onAppStateChange(state: string): Promise<void> {
      if (state === 'background') {
        backgroundedAt ??= now();
        return;
      }
      if (state !== 'active') return;
      const since = backgroundedAt;
      backgroundedAt = null;
      if (since === null || now() - since < minBackgroundMs) return;
      try {
        await apply();
      } catch {
        // No network, or the update server is down: start on what we have,
        // and the next cold start tries again.
      }
    },

    /** The update-required screen's first step: true when a reload is under way. */
    async tryOverTheAir(): Promise<boolean> {
      try {
        return await apply();
      } catch {
        return false;
      }
    },
  };
}

export type AppUpdates = ReturnType<typeof createAppUpdates>;

/**
 * The API client learns of a 426 before any screen does; this is how it tells
 * the provider that swaps the app for the update-required screen. The same
 * shape as authEvents, for the same reason.
 */
export function createUpdateRequiredEvents() {
  const listeners = new Set<() => void>();
  return {
    updateRequired: (): void => {
      for (const listener of [...listeners]) listener();
    },
    onUpdateRequired: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type UpdateRequiredEvents = ReturnType<typeof createUpdateRequiredEvents>;
