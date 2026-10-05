import type { CreateSessionResponse, CurrentSessionResponse } from '@lang-tutor/core/api';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { currentFor, type StoredCurrent } from '@/nextSession';

// Phase 19. The active enrollment's session state for the home screen: what
// is current, where the next session comes from, and the two actions on it.
// Constructed at the composition root with the api client passed in
// (ADR 0002). The server is the source of truth: create and skip both re-read
// it rather than guessing the result.
export type NextSessionValue = {
  current: CurrentSessionResponse | null;
  reload: () => void;
  create: () => Promise<CreateSessionResponse>;
  skip: (sessionId: string) => Promise<void>;
};

const NextSessionContext = createContext<NextSessionValue | null>(null);

export function NextSessionProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const { active } = useCurrentUser();
  // Keyed by the enrollment the read was about, not cleared on a switch: a
  // slow answer about Russian lands under Russian's id and is simply never
  // shown while English is active, and the newest read for the active
  // enrollment always lands. Clearing in an effect instead would run after
  // the home screen's own focus effect (children first) and discard its read.
  const [stored, setStored] = useState<StoredCurrent | null>(null);
  const current = currentFor(stored, active?.id);

  const reload = useCallback(() => {
    if (!active) return;
    const enrollmentId = active.id;
    void api
      .currentSession(enrollmentId)
      .then((state) => setStored({ enrollmentId, state }))
      // Kept as it was: the next focus or poll tries again.
      .catch(() => undefined);
  }, [api, active]);

  const create = useCallback(async () => {
    if (!active) throw new Error('cannot create a session with no active enrollment');
    try {
      return await api.createSession({ enrollment_id: active.id });
    } finally {
      reload();
    }
  }, [api, active, reload]);

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

  const value = useMemo(() => ({ current, reload, create, skip }), [current, reload, create, skip]);
  return <NextSessionContext.Provider value={value}>{children}</NextSessionContext.Provider>;
}

export function useNextSession(): NextSessionValue {
  const value = useContext(NextSessionContext);
  if (!value) throw new Error('useNextSession must be used inside a NextSessionProvider');
  return value;
}
