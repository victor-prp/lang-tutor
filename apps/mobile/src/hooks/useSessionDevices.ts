import { useCallback } from 'react';

import { useRecorder } from '@/hooks/useRecording';
import { useSpeaker } from '@/hooks/useSpeech';
import { voicesRead } from '@/speech';

/** Phase 43. The longest a session waits for the device's voices to be read. */
const VOICES_WAIT_MS = 3_000;

export type SessionDevices = { listening: boolean; speaking: boolean };

/**
 * What this device can do, for a session built for it. Phase 24 (spec D5): only the device
 * knows whether it can speak the target, so only it can ask for listening cards. Phase 25
 * (spec D4): likewise, only it knows whether it can record. Read once the voices are read
 * (phase 43), unless `waitForVoices` is false.
 *
 * Shared by every path's sessions (phase 57): the main path's (NextSessionProvider) and each
 * target's (TargetsProvider). Not useSpeech: that would re-render the provider, and every
 * screen under it, on every utterance.
 */
export function useSessionDevices(): (targetLanguage: string, waitForVoices?: boolean) => Promise<SessionDevices> {
  const speaker = useSpeaker();
  const recorder = useRecorder();
  return useCallback(
    async (targetLanguage: string, waitForVoices = true) => {
      if (waitForVoices) await voicesRead(speaker, VOICES_WAIT_MS);
      return {
        listening: speaker.snapshot().tags.has(targetLanguage),
        speaking: await recorder.canRecord().catch(() => false),
      };
    },
    [speaker, recorder],
  );
}
