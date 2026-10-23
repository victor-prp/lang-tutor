/** What saving Words for me's words does next (phase 73 spec D6). */
export type AfterSave = 'open' | 'wait' | 'home';

/** From the My words card (`from === 'my-words'`) saving goes on into the first session: straight
 *  in when it is ready, waiting while it is prepared. Any refusal, and any other way in, is home. */
export function afterSave(from: string | undefined, outcome: 'ready' | 'preparing' | 'error'): AfterSave {
  if (from !== 'my-words' || outcome === 'error') return 'home';
  return outcome === 'ready' ? 'open' : 'wait';
}

/** While waiting: what the re-read `current` says about the session being prepared. */
export function waitStep(current: { session_id: string; status: string } | null | undefined, sessionId: string): AfterSave {
  if (!current || current.session_id !== sessionId) return 'wait';
  if (current.status === 'ready') return 'open';
  return current.status === 'failed' ? 'home' : 'wait';
}
