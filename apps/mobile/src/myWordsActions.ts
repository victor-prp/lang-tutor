import type { HomeAction } from '@/nextSession';

/**
 * Phase 73 (spec D8). What My words' button does, as a closure over what it acts on (ADR 0002), so
 * usePracticeMyWords only wires it to the providers and the logic runs against fakes in a test.
 * `run` is the caller's one-action-at-a-time guard; `setMakeFailed` records whether the last create
 * failed.
 */
export function myWordsActions({
  run,
  create,
  skipSession,
  openSession,
  onDiscover,
  onSkipped,
  setMakeFailed,
}: {
  run: (work: () => Promise<void>) => Promise<void>;
  create: () => Promise<unknown>;
  skipSession: (sessionId: string) => Promise<void>;
  openSession: (sessionId: string, fresh: boolean) => void;
  onDiscover: () => void;
  onSkipped: () => void;
  setMakeFailed: (failed: boolean) => void;
}) {
  // Phase 43 (spec D7). Makes the next session without entering it: the card shows it
  // preparing, then offers it.
  const makeNext = () =>
    run(async () => {
      try {
        await create();
        setMakeFailed(false);
      } catch (error) {
        setMakeFailed(true);
        throw error;
      }
    });

  // A skip can leave no session at all (the one in stock skipped): the caller may make the
  // next one again.
  const skip = (sessionId: string) => {
    void run(async () => {
      await skipSession(sessionId);
      onSkipped();
    });
  };

  // Phase 73 (spec D6). Words for me with no words of its own, a ready session started or
  // resumed, a missing one made (the retry after a failed create too).
  const press = (action: HomeAction) => {
    switch (action.kind) {
      case 'discover':
        return onDiscover();
      case 'start':
        return openSession(action.sessionId, true);
      case 'resume':
        return openSession(action.sessionId, false);
      case 'create':
      case 'failed':
        return void makeNext();
      case 'preparing':
        return undefined;
    }
  };

  return { press, makeNext, skip };
}
