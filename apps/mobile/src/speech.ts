import type { LanguageCode } from '@lang-tutor/core/api';

/**
 * Phase 23. Speaking the language being learned, through the device's own
 * speech engine (spec §1 D1).
 *
 * The engine is received, never imported: only the composition root names
 * expo-speech (ADR 0002 R1). This module and its tests run without it, and
 * replacing device speech with server audio later changes one file.
 */

/** A voice as the engine lists it. Only its language matters here. */
export type SpeechVoice = { language: string };

/** What the speaker hands the engine for one utterance. */
export type SpeakOptions = {
  language: string;
  rate: number;
  onDone: () => void;
  onStopped: () => void;
  onError: (error: Error) => void;
};

/** The slice of expo-speech the speaker uses. */
export type SpeechEngine = {
  speak: (text: string, options: SpeakOptions) => void;
  stop: () => Promise<void>;
  getAvailableVoicesAsync: () => Promise<SpeechVoice[]>;
};

/**
 * The languages the app voices, each with the tag it prefers: every language a
 * learner can enroll in. Hebrew is absent on purpose. The interface is Hebrew
 * and every learner reads it natively (D3), so nothing anywhere can voice it.
 */
export const VOICE_TAGS: Readonly<Partial<Record<LanguageCode, string>>> = {
  en: 'en-US',
  ru: 'ru-RU',
  it: 'it-IT',
};

/** Whether the app voices `language` at all, whatever the device has. Own keys
 *  only: a wire string such as "constructor" is not a language. */
export function isVoiced(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(VOICE_TAGS, language);
}

const normalise = (tag: string) => tag.replace(/_/g, '-');
const primary = (tag: string) => normalise(tag).split('-')[0].toLowerCase();

/**
 * Which voiced languages this device can speak, and the tag its engine gets for
 * each (D5, D6). A language is speakable when some voice's tag has its primary
 * subtag. The tag is the preferred one when the device has it, else the first
 * of the device's own for that language. Android is the exception and gets the
 * bare language: expo-speech builds `Locale(tag)` there, `Locale("it-IT")` is a
 * language named "it-it", and Android answers that in its default voice.
 */
export function voiceTags(voices: readonly SpeechVoice[], platform: string): ReadonlyMap<string, string> {
  const tags = new Map<string, string>();
  for (const [language, preferred] of Object.entries(VOICE_TAGS)) {
    if (!preferred) continue;
    const own = voices.map((voice) => normalise(voice.language)).filter((tag) => primary(tag) === language);
    if (own.length === 0) continue;
    if (platform === 'android') {
      tags.set(language, language);
    } else {
      const hasPreferred = own.some((tag) => tag.toLowerCase() === preferred.toLowerCase());
      tags.set(language, hasPreferred ? preferred : own[0]);
    }
  }
  return tags;
}

export type SpeechSnapshot = {
  /** Language → the tag its engine gets. Empty until `start` has read the voices. */
  tags: ReadonlyMap<string, string>;
  /** What is speaking now, or null. */
  playing: { text: string; language: string } | null;
};

export type SpeakerDeps = {
  engine: SpeechEngine;
  /** Platform.OS. Only 'android' changes anything (see voiceTags). */
  platform: string;
  /** Lets a tap sound with an iPhone's ring switch on silent (D8). */
  prepareAudio: () => Promise<void>;
};

/**
 * A small store over the engine (D2, D7), read with useSyncExternalStore: a new
 * snapshot object on every change, the same one otherwise.
 */
export function createSpeaker({ engine, platform, prepareAudio }: SpeakerDeps) {
  let snapshot: SpeechSnapshot = { tags: new Map(), playing: null };
  // Each tap takes the next ticket, and only the current ticket may speak or end
  // the playing state. A stopped utterance's late callback (the web engine
  // reports a stop as an error) must not clear the one that replaced it.
  let ticket = 0;
  const listeners = new Set<() => void>();

  function update(next: Partial<SpeechSnapshot>) {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }

  return {
    /** Once per launch. A failed audio mode costs only the silent-switch case;
     *  failed voices leave nothing speakable, which beats a wrong voice. */
    start: async (): Promise<void> => {
      await prepareAudio().catch(() => undefined);
      try {
        update({ tags: voiceTags(await engine.getAvailableVoicesAsync(), platform) });
      } catch {
        // Nothing is speakable, so no speaker shows.
      }
    },
    snapshot: (): SpeechSnapshot => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Speaks `text` after stopping whatever was speaking; nothing is queued. A
     * tap on the text that is speaking stops it. A language without a voice
     * does nothing.
     */
    toggle: async (text: string, language: string): Promise<void> => {
      const tag = snapshot.tags.get(language);
      if (!tag) return;
      const wasPlaying = snapshot.playing?.text === text && snapshot.playing.language === language;
      const mine = ++ticket;
      update({ playing: wasPlaying ? null : { text, language } });
      await engine.stop().catch(() => undefined);
      // Stopping was the point, or a later tap took over while the engine stopped.
      if (wasPlaying || mine !== ticket) return;
      const end = () => {
        if (mine === ticket) update({ playing: null });
      };
      engine.speak(text, { language: tag, rate: 1, onDone: end, onStopped: end, onError: end });
    },
  };
}

export type Speaker = ReturnType<typeof createSpeaker>;
