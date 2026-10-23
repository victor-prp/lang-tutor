import type { TargetSummary } from '@lang-tutor/core/api';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useTargets } from '@/hooks/useTargets';
import { openSessionOf, targetPress, targetSessionAction } from '@/nextSession';
import { askBeforePracticeMore } from '@/targets';

/** Final review N1. Create refused: the path has a started session (409 session_open). */
export const isSessionOpen = (error: unknown) => error instanceof ApiError && error.code === 'session_open';

type CreatePress = Extract<ReturnType<typeof targetPress>, { kind: 'create' }>;

/**
 * Phase 72 (spec D6). What a target's button does, on home's card and on a target session's results
 * screen alike, so the two cannot drift. `run` is the caller's one-action-at-a-time guard, and
 * `openSession` enters a session and shows it (home pushes the session screen, results replaces
 * itself with it). The sheet is the caller's to draw: `asking` shows it, `answerAsk` is its two
 * buttons, `cancelAsk` a tap outside or back.
 */
export function usePracticeTarget({
  run,
  openSession,
}: {
  run: (work: () => Promise<void>) => Promise<void>;
  openSession: (sessionId: string, fresh: boolean) => void;
}) {
  const { create, reload } = useTargets();
  const { user, practiceMoreAsk } = useCurrentUser();
  const [asking, setAsking] = useState<{ target: TargetSummary; press: CreatePress } | null>(null);

  // Phase 57 (spec D1). A target's button acts on its own path's session: a started one is
  // resumed; otherwise it goes through create with the target's id (final review C1: create
  // answers the path's stock, replaced first when it no longer serves the target's day, or
  // builds one), and the session create answers is entered when ready, else the card shows
  // it preparing (home polls the targets meanwhile). A preparing one is not pressable.
  // Final review N1: a create refused with session_open means the path has a started session
  // after all (the card's list predates the start); the list read again names it, and it is
  // entered as it is.
  const startTarget = (target: TargetSummary, press: CreatePress) => {
    void run(async () => {
      try {
        const created = await create(target.id, { waitForVoices: press.waitForVoices });
        if (created.status === 'ready') openSession(created.session_id, true);
      } catch (error) {
        if (!isSessionOpen(error)) throw error;
        const open = openSessionOf((await reload())?.targets ?? null, target.id);
        if (open) openSession(open, false);
      }
    });
  };

  // Phase 65 (spec D9). Past the day's budget, when another session adds little, the press asks
  // first (unless the learner turned that off); a storage failure reads as "ask".
  const practice = (target: TargetSummary) => {
    const press = targetPress(targetSessionAction(target));
    if (press.kind === 'enter') openSession(press.sessionId, press.fresh);
    if (press.kind !== 'create') return;
    if (!askBeforePracticeMore(target, false)) return startTarget(target, press);
    void (async () => {
      const ask = user ? await practiceMoreAsk.shouldAsk(user.username) : true;
      if (askBeforePracticeMore(target, !ask)) setAsking({ target, press });
      else startTarget(target, press);
    })();
  };

  const answerAsk = (stopAsking: boolean, start: boolean) => {
    const held = asking;
    setAsking(null);
    if (stopAsking && user) void practiceMoreAsk.stopAsking(user.username);
    if (start && held) startTarget(held.target, held.press);
  };

  // A tap outside or back: closed, and nothing saved.
  const cancelAsk = () => setAsking(null);

  return { practice, asking: asking !== null, answerAsk, cancelAsk };
}
