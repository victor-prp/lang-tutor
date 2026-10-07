import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';

import type { Speaker } from '@/speech';

export type SpeechValue = {
  /** Whether this device has a voice for `language`. Never true for Hebrew. */
  canSpeak: (language: string) => boolean;
  /** Whether the device's voices have been read, so "no voice" is known. */
  voicesLoaded: boolean;
  isPlaying: (text: string, language: string) => boolean;
  toggle: (text: string, language: string) => Promise<void>;
};

const SpeechContext = createContext<Speaker | null>(null);

export function SpeechProvider({ speaker, children }: { speaker: Speaker; children: ReactNode }) {
  // Once per launch: the audio mode, then the device's voices.
  useEffect(() => {
    void speaker.start();
  }, [speaker]);
  return <SpeechContext.Provider value={speaker}>{children}</SpeechContext.Provider>;
}

/** The speaker itself, without subscribing to it: for a caller that reads the
 *  snapshot at the moment it acts and need not re-render on every utterance. */
export function useSpeaker(): Speaker {
  const speaker = useContext(SpeechContext);
  if (!speaker) throw new Error('useSpeaker must be used inside a SpeechProvider');
  return speaker;
}

export function useSpeech(): SpeechValue {
  const speaker = useContext(SpeechContext);
  if (!speaker) throw new Error('useSpeech must be used inside a SpeechProvider');
  // The third argument is for the static web export, which pre-renders every
  // page in Node. There the store is still empty, so no speaker is rendered.
  const { tags, loaded, playing } = useSyncExternalStore(speaker.subscribe, speaker.snapshot, speaker.snapshot);
  return {
    canSpeak: (language) => tags.has(language),
    voicesLoaded: loaded,
    isPlaying: (text, language) => playing?.text === text && playing.language === language,
    toggle: speaker.toggle,
  };
}
