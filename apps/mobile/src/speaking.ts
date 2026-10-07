import type { Question } from '@lang-tutor/core/api';

import type { CardAnswer } from '@/feedback';
import { strings } from '@/strings';

/** Phase 25 (spec D7). A speaking card's attempt that recorded nothing yet:
 *  in flight, not understood, or not checked. An understood attempt is an
 *  answer, not an attempt. */
export type SpeechAttempt = { phase: 'idle' } | { phase: 'checking' } | { phase: 'unheard'; heard: string } | { phase: 'failed' };

export const IDLE_ATTEMPT: SpeechAttempt = { phase: 'idle' };

/** Spec D8. Speaking is off for the rest of the session: the learner chose it,
 *  or the microphone was refused. */
export type SpeakingOff = null | 'chosen' | 'no_mic';

/** What the card says under its button after an attempt that recorded nothing. */
export function attemptNotice(attempt: SpeechAttempt): { title: string; heard: string | null } | null {
  if (attempt.phase === 'failed') return { title: strings.couldNotCheck, heard: null };
  if (attempt.phase !== 'unheard') return null;
  return attempt.heard === '' ? { title: strings.heardNothing, heard: null } : { title: strings.notUnderstood, heard: attempt.heard };
}

/** Spec D8. A read-aloud card is passed without being shown once speaking is
 *  off: there is nothing to type for a word already on the screen. */
export function passesUnseen(question: Question | undefined, speakingOff: SpeakingOff, answered: boolean): boolean {
  return question?.type === 'read_aloud' && speakingOff !== null && !answered;
}

/** A skip shows no banner: the next card follows at once. */
export function isSkip(answer: CardAnswer): boolean {
  return 'pass' in answer && answer.pass === 'skip';
}
