import type { CreateSessionResponse, CurrentSessionResponse } from '@lang-tutor/core/api';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSessionDevices } from '@/hooks/useSessionDevices';
import { currentFor, keptRead, loadFailedFor, type StoredCurrent } from '@/nextSession';

// Phase 19. The active enrollment's session state for the home screen: what
// is current, where the next session comes from, and the two actions on it.
// Constructed at the composition root with the api client passed in
// (ADR 0002). The server is the source of truth: create and skip both re-read
// it rather than guessing the result.
export type NextSessionValue = {
  current: CurrentSessionResponse | null;
  /** The first read for the active enrollment failed and nothing is shown. */
  loadFailed: boolean;
  reload: () => void;
  /** Phase 73 (spec D7). The same read as `reload`, resolving whether it landed. */
  refresh: () => Promise<boolean>;
  /** `waitForVoices: false` for the seed, whose cards are fixed: tapping start
   *  must not wait on the voices (phase 43). */
  create: (options?: { waitForVoices?: boolean }) => Promise<CreateSessionResponse>;
  /** Phase 43 (spec D2). Has the next session built for this device; never
   *  throws, since a session's first answer starts it too. */
  start: (sessionId: string) => Promise<void>;
  skip: (sessionId: string) => Promise<void>;
  /** Phase 61 (spec D6). What this device can do for the target: a voice, and a microphone. */
  devices: (targetLanguage: string) => Promise<{ listening: boolean; speaking: boolean }>;
};

const NextSessionContext = createContext<NextSessionValue | null>(null);

export function NextSessionProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const { active } = useCurrentUser();
  // The device's voices and recorder, read when a session is created or started.
  const devices = useSessionDevices();
  // Keyed by the enrollment the read was about, not cleared on a switch: a
  // slow answer about Russian lands under Russian's id and is simply never
  // shown while English is active, and the newest read for the active
  // enrollment always lands. Clearing in an effect instead would run after
  // the home screen's own focus effect (children first) and discard its read.
  const [stored, setStored] = useState<StoredCurrent | null>(null);
  const current = currentFor(stored, active?.id);
  // Phase 75 (CI run 40041866540). The active enrollment when a read lands, not when it started:
  // a read about the course switched from never pushes out the new course's (keptRead).
  const activeId = useRef(active?.id);
  activeId.current = active?.id;
  // Keyed the same way, so a failure about one enrollment is never shown for
  // another. A successful read for it clears the failure.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const loadFailed = loadFailedFor(failedFor, active?.id, current);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!active) return false;
    const enrollmentId = active.id;
    try {
      const state = await api.currentSession(enrollmentId);
      setStored((kept) => keptRead(kept, { enrollmentId, state }, activeId.current));
      setFailedFor((failed) => (failed === enrollmentId ? null : failed));
      return true;
    } catch {
      // A state already shown stays as it was and the next focus or poll tries
      // again; with none shown, home offers a retry instead of a spinner.
      setFailedFor(enrollmentId);
      return false;
    }
  }, [api, active]);

  const reload = useCallback(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (options?: { waitForVoices?: boolean }) => {
    if (!active) throw new Error('cannot create a session with no active enrollment');
    try {
      return await api.createSession({
        enrollment_id: active.id,
        ...(await devices(active.target_language, options?.waitForVoices ?? true)),
      });
    } finally {
      reload();
    }
  }, [api, active, devices, reload]);

  const start = useCallback(
    async (sessionId: string) => {
      if (!active) return;
      await api.startSession(sessionId, await devices(active.target_language)).catch(() => undefined);
    },
    [api, active, devices],
  );

  const skip = useCallback(
    async (sessionId: string) => {
      try {
        await api.skipSession(sessionId);
      } finally {
        reload();
      }
    },
    [api, reload],
  );

  const value = useMemo(
    () => ({ current, loadFailed, reload, refresh, create, start, skip, devices }),
    [current, loadFailed, reload, refresh, create, start, skip, devices],
  );
  return <NextSessionContext.Provider value={value}>{children}</NextSessionContext.Provider>;
}

export function useNextSession(): NextSessionValue {
  const value = useContext(NextSessionContext);
  if (!value) throw new Error('useNextSession must be used inside a NextSessionProvider');
  return value;
}
