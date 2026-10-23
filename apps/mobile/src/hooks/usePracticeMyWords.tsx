import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { myWordsActions } from '@/myWordsActions';
import { createLook } from '@/nextSession';

/**
 * Phase 73 (spec D8). What My words' button does, on home's card and on a My words session's
 * results screen alike, so the two cannot drift (phase 72 did the same for a target). `run` is
 * the caller's one-action-at-a-time guard, `openSession` enters a session and shows it, and
 * `onDiscover` is the way on to Words for me when there are no words of its own. `onSkipped` is
 * home's, to let its auto-create make the next session again after a skip. The logic is
 * myWordsActions; this holds the failed create for the active enrollment.
 *
 * The auto-create effect stays in home, which sends `makeNext` itself for a missing session.
 */
export function usePracticeMyWords({
  run,
  openSession,
  onDiscover,
  onSkipped,
}: {
  run: (work: () => Promise<void>) => Promise<void>;
  openSession: (sessionId: string, fresh: boolean) => void;
  onDiscover: () => void;
  onSkipped: () => void;
}) {
  const next = useNextSession();
  const { active } = useCurrentUser();
  const activeId = active?.id ?? null;
  // Phase 43 (spec D7). The enrollment whose create failed: the card then offers a retry.
  const [makeFailedFor, setMakeFailedFor] = useState<string | null>(null);

  // A fresh start on every focus: back from a session or another screen.
  useFocusEffect(
    useCallback(() => {
      setMakeFailedFor(null);
    }, []),
  );

  const actions = myWordsActions({
    run,
    create: () => next.create(),
    skipSession: next.skip,
    openSession,
    onDiscover,
    onSkipped,
    setMakeFailed: (failed) => setMakeFailedFor(failed ? activeId : null),
  });
  return { ...actions, makeFailed: activeId !== null && createLook(makeFailedFor, activeId) === 'retry' };
}
