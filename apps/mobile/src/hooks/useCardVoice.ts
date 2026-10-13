import type { Question } from '@lang-tutor/core/api';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { cardVoice, nextCue, NO_CUE, type CueState } from '@/cardVoice';
import { useSpeaker } from '@/hooks/useSpeech';

/**
 * Phase 44 (spec D2). Plays the card's cues through the speaker. It subscribes
 * to whether the language has a voice, not to every utterance, so the session
 * screen does not re-render each time something plays. Nothing waits for the
 * voices: a cue plays when they arrive (phase 43 R9).
 */
export function useCardVoice(
  question: Question | null,
  { language, banner, speaking }: { language: string; banner: boolean; speaking: boolean },
): void {
  const speaker = useSpeaker();
  const voiced = useSyncExternalStore(
    speaker.subscribe,
    () => speaker.snapshot().tags.has(language),
    () => false,
  );
  const state = useRef<CueState>(NO_CUE);
  const id = question?.id ?? null;
  const voice = question ? cardVoice(question, { speaking }) : null;
  const arrival = voice?.arrival ?? null;
  const after = voice?.after ?? null;

  useEffect(() => {
    if (id === null) return;
    const step = nextCue(state.current, { id, voice: { arrival, after }, voiced, banner });
    state.current = step.state;
    if (step.cue?.kind === 'say') void speaker.say(step.cue.text, language);
    else if (step.cue?.kind === 'stop') void speaker.stop();
  }, [id, arrival, after, voiced, banner, language, speaker]);
}
