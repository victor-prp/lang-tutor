import type { SpeechMimeType } from '@lang-tutor/core/api';

/**
 * Phase 25 (spec D12). One clip at a time, through the class expo-audio's
 * useAudioRecorder wraps, so no hook is needed. The composition root
 * (_layout.tsx) passes every concrete piece in (ADR 0002), so this file is
 * tested with fakes.
 */

export type RecordPermission = 'granted' | 'undetermined' | 'denied';

/** One recorded attempt, as the speech endpoint takes it. */
export type Clip = { audio: string; mimeType: SpeechMimeType; bytes: number };

/** What the recorder needs of expo-audio's recorder class. The web's has no
 *  `release` (POC). */
type RecorderEngine = {
  prepareToRecordAsync(): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  uri: string | null;
  release?: () => void;
};

/** Spec D7. The card stops recording by itself after this. */
export const MAX_RECORDING_SECONDS = 5;

export function secondsLeft(startedAt: number, now: number): number {
  return Math.max(0, MAX_RECORDING_SECONDS - Math.floor((now - startedAt) / 1000));
}

/** Spec D12: 16 kHz mono AAC on a phone, the browser's WebM on the web. Flat,
 *  as expo-audio's createRecordingOptions would make them for each platform,
 *  because the class is constructed directly. */
export function recordingOptions(platform: string): Record<string, unknown> {
  const common = { sampleRate: 16000, numberOfChannels: 1, isMeteringEnabled: false };
  if (platform === 'android') {
    return { ...common, extension: '.aac', bitRate: 32000, outputFormat: 'aac_adts', audioEncoder: 'aac' };
  }
  if (platform === 'ios') {
    return { ...common, extension: '.m4a', bitRate: 32000, outputFormat: 'aac ', audioQuality: 64 };
  }
  return { ...common, bitRate: 128000, mimeType: 'audio/webm', bitsPerSecond: 128000 };
}

export function mimeTypeFor(platform: string): SpeechMimeType {
  if (platform === 'android') return 'audio/aac';
  if (platform === 'ios') return 'audio/mp4';
  return 'audio/webm';
}

/** Spec D4, as built. A phone asks on the first tap, so "not yet asked" counts
 *  as able. The web cannot read the permission without prompting for it, so
 *  only a site that was granted counts. */
export function canRecordWith(permission: RecordPermission, platform: string): boolean {
  return platform === 'web' ? permission === 'granted' : permission !== 'denied';
}

export type RecorderDeps = {
  platform: string;
  makeEngine: (options: Record<string, unknown>) => RecorderEngine;
  /** Reads the permission without asking for it. */
  permission: () => Promise<RecordPermission>;
  /** Asks for it; true when granted. */
  requestPermission: () => Promise<boolean>;
  /** iOS only: the play-and-record category while recording (spec D12). */
  setRecordingMode: (on: boolean) => Promise<void>;
  readBase64: (uri: string) => Promise<{ base64: string; bytes: number }>;
};

export function createRecorder(deps: RecorderDeps) {
  let engine: RecorderEngine | null = null;
  const ios = deps.platform === 'ios';

  async function finish(current: RecorderEngine): Promise<void> {
    await current.stop();
    if (ios) await deps.setRecordingMode(false);
  }

  return {
    canRecord: async (): Promise<boolean> => canRecordWith(await deps.permission(), deps.platform),

    start: async (): Promise<'recording' | 'denied'> => {
      // One engine at a time: a second start must not leave a microphone open.
      if (engine) return 'recording';
      if (!(await deps.requestPermission())) return 'denied';
      if (ios) await deps.setRecordingMode(true);
      const next = deps.makeEngine(recordingOptions(deps.platform));
      await next.prepareToRecordAsync();
      next.record();
      engine = next;
      return 'recording';
    },

    stop: async (): Promise<Clip> => {
      const current = engine;
      if (!current) throw new Error('not recording');
      engine = null;
      await finish(current);
      if (!current.uri) throw new Error('the recorder gave no uri');
      const { base64, bytes } = await deps.readBase64(current.uri);
      current.release?.();
      return { audio: base64, mimeType: mimeTypeFor(deps.platform), bytes };
    },

    /** Leaving a card mid-recording: stop and drop the clip. */
    cancel: async (): Promise<void> => {
      const current = engine;
      if (!current) return;
      engine = null;
      await finish(current).catch(() => undefined);
      current.release?.();
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;
