import type { HomeAction } from '@/nextSession';

/** Phase 73 (spec D7). The pure choices of a finished session's results screen. */

/** Which screen a finished session gets: a target's (phase 72), My words' (a counted session of the
 *  main path), or today's plain one (the seed, a question-types session). `kind` absent is an older
 *  server's practice session. */
export function resultsScreenOf({
  targetId,
  source,
  kind,
}: {
  targetId: string | null;
  source: 'seed' | 'list' | null;
  kind: 'practice' | 'question_types' | undefined;
}): 'target' | 'my-words' | 'plain' {
  if (targetId !== null) return 'target';
  return source === 'list' && kind !== 'question_types' ? 'my-words' : 'plain';
}

/** What My words' continue button is, from the read made after the session ended and the action
 *  home's rules draw from it. Nothing is acted on before that read lands. */
export function myWordsContinue(
  read: 'reading' | 'landed' | 'failed',
  action: HomeAction | null,
): 'waiting' | 'open' | 'preparing' | 'retry' | 'home' {
  if (read !== 'landed' || action === null) return 'waiting';
  switch (action.kind) {
    case 'start':
    case 'resume':
    case 'create':
      return 'open';
    case 'preparing':
      return 'preparing';
    case 'failed':
      return 'retry';
    case 'discover':
      return 'home';
  }
}
