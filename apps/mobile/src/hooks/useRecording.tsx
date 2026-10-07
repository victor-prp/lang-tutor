import { createContext, useContext, type ReactNode } from 'react';

import type { Recorder } from '@/recording';

// Phase 25. The recorder, built once in _layout.tsx (ADR 0002). It holds no
// state a screen renders, so a plain context, as useSpeaker's is.
const RecordingContext = createContext<Recorder | null>(null);

export function RecordingProvider({ recorder, children }: { recorder: Recorder; children: ReactNode }) {
  return <RecordingContext.Provider value={recorder}>{children}</RecordingContext.Provider>;
}

export function useRecorder(): Recorder {
  const recorder = useContext(RecordingContext);
  if (!recorder) throw new Error('useRecorder must be used inside a RecordingProvider');
  return recorder;
}
