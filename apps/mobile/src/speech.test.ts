import { describe, expect, it } from '@jest/globals';

import { ENROLLABLE_TARGETS } from './enrollments';
import {
  createSpeaker,
  isVoiced,
  VOICE_TAGS,
  voiceTags,
  type SpeakOptions,
  type SpeechEngine,
  type SpeechVoice,
} from './speech';

const voices = (...languages: string[]): SpeechVoice[] => languages.map((language) => ({ language }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeEngine(available: SpeechVoice[] | Error = voices('it-IT', 'en-US')) {
  const calls: string[] = [];
  const spoken: { text: string; options: SpeakOptions }[] = [];
  const pendingStops: (() => void)[] = [];
  let holding = false;
  const engine: SpeechEngine = {
    speak: (text, options) => {
      calls.push(`speak ${text}`);
      spoken.push({ text, options });
    },
    stop: () => {
      calls.push('stop');
      return holding ? new Promise<void>((resolve) => pendingStops.push(resolve)) : Promise.resolve();
    },
    getAvailableVoicesAsync: async () => {
      if (available instanceof Error) throw available;
      return available;
    },
  };
  return {
    engine,
    calls,
    spoken,
    holdStops: () => {
      holding = true;
    },
    releaseStops: async () => {
      for (const resolve of pendingStops.splice(0)) resolve();
      await flush();
    },
  };
}

async function started(fake = fakeEngine()) {
  const speaker = createSpeaker({ engine: fake.engine, platform: 'ios', prepareAudio: async () => undefined });
  await speaker.start();
  return { speaker, ...fake };
}

describe('VOICE_TAGS', () => {
  it('voices every language a learner can enroll in', () => {
    for (const code of ENROLLABLE_TARGETS) expect(VOICE_TAGS[code]).toBeDefined();
  });

  it('never voices Hebrew, and is not fooled by a prototype key', () => {
    expect(isVoiced('it')).toBe(true);
    expect(isVoiced('he')).toBe(false);
    expect(isVoiced('constructor')).toBe(false);
  });
});

describe('voiceTags', () => {
  it('prefers the preferred tag', () => {
    expect(voiceTags(voices('it-CH', 'it-IT'), 'ios').get('it')).toBe('it-IT');
  });

  it("falls back to the device's own region", () => {
    expect(voiceTags(voices('en-GB'), 'ios').get('en')).toBe('en-GB');
  });

  it('reads underscores and lowercase as the same tag', () => {
    expect(voiceTags(voices('it_it'), 'web').get('it')).toBe('it-IT');
  });

  it('leaves out a language with no voice', () => {
    const tags = voiceTags(voices('en-US'), 'ios');
    expect(tags.has('it')).toBe(false);
    expect(tags.has('ru')).toBe(false);
  });

  it('never makes Hebrew speakable, even with a Hebrew voice', () => {
    expect(voiceTags(voices('he-IL', 'en-US'), 'ios').has('he')).toBe(false);
  });

  it('gives Android the bare language', () => {
    const tags = voiceTags(voices('it-IT', 'en-GB'), 'android');
    expect(tags.get('it')).toBe('it');
    expect(tags.get('en')).toBe('en');
  });
});

describe('createSpeaker', () => {
  it('has nothing speakable before start', () => {
    const speaker = createSpeaker({ engine: fakeEngine().engine, platform: 'ios', prepareAudio: async () => undefined });
    expect(speaker.snapshot().tags.size).toBe(0);
  });

  it('start sets the audio mode and reads the voices', async () => {
    let prepared = 0;
    const speaker = createSpeaker({
      engine: fakeEngine().engine,
      platform: 'ios',
      prepareAudio: async () => {
        prepared += 1;
      },
    });
    await speaker.start();
    expect(prepared).toBe(1);
    expect(speaker.snapshot().tags.get('it')).toBe('it-IT');
  });

  it('leaves the audio mode alone off iOS', async () => {
    // expo-audio on Android sets the device-wide audio mode and turns the
    // speakerphone on, which can reroute a call the learner is on.
    let prepared = 0;
    for (const platform of ['android', 'web']) {
      const speaker = createSpeaker({
        engine: fakeEngine().engine,
        platform,
        prepareAudio: async () => {
          prepared += 1;
        },
      });
      await speaker.start();
      expect(speaker.snapshot().tags.has('it')).toBe(true);
    }
    expect(prepared).toBe(0);
  });

  it('a failed audio mode still reads the voices', async () => {
    const speaker = createSpeaker({
      engine: fakeEngine().engine,
      platform: 'ios',
      prepareAudio: () => Promise.reject(new Error('no session')),
    });
    await speaker.start();
    expect(speaker.snapshot().tags.get('it')).toBe('it-IT');
  });

  it('failed voices leave nothing speakable, and a tap does nothing', async () => {
    const { speaker, calls } = await started(fakeEngine(new Error('engine down')));
    expect(speaker.snapshot().tags.size).toBe(0);
    await speaker.toggle('gatto', 'it');
    expect(calls).toEqual([]);
  });

  it('stops whatever is speaking, then speaks with the tag at the natural rate', async () => {
    const { speaker, calls, spoken } = await started();
    await speaker.toggle('gatto', 'it');
    expect(calls).toEqual(['stop', 'speak gatto']);
    expect(spoken[0].options.language).toBe('it-IT');
    expect(spoken[0].options.rate).toBe(1);
  });

  it('marks the text as playing until it is done', async () => {
    const { speaker, spoken } = await started();
    await speaker.toggle('gatto', 'it');
    expect(speaker.snapshot().playing).toEqual({ text: 'gatto', language: 'it' });
    spoken[0].options.onDone();
    expect(speaker.snapshot().playing).toBeNull();
  });

  it('ends the playing state on stopped and on error too', async () => {
    const { speaker, spoken } = await started();
    await speaker.toggle('gatto', 'it');
    spoken[0].options.onStopped();
    expect(speaker.snapshot().playing).toBeNull();
    await speaker.toggle('cane', 'it');
    spoken[1].options.onError(new Error('synthesis-failed'));
    expect(speaker.snapshot().playing).toBeNull();
  });

  it('a tap on the playing text stops it', async () => {
    const { speaker, calls } = await started();
    await speaker.toggle('gatto', 'it');
    await speaker.toggle('gatto', 'it');
    expect(calls).toEqual(['stop', 'speak gatto', 'stop']);
    expect(speaker.snapshot().playing).toBeNull();
  });

  it("a stopped utterance's late callback leaves its replacement playing", async () => {
    const { speaker, spoken } = await started();
    await speaker.toggle('gatto', 'it');
    await speaker.toggle('cane', 'it');
    // The web engine reports the first one's stop as an error, after the second began.
    spoken[0].options.onError(new Error('interrupted'));
    expect(speaker.snapshot().playing).toEqual({ text: 'cane', language: 'it' });
  });

  it('only the last of two quick taps speaks', async () => {
    const fake = fakeEngine();
    const { speaker, spoken } = await started(fake);
    fake.holdStops();
    const first = speaker.toggle('gatto', 'it');
    const second = speaker.toggle('cane', 'it');
    await fake.releaseStops();
    await Promise.all([first, second]);
    expect(spoken.map((utterance) => utterance.text)).toEqual(['cane']);
    expect(speaker.snapshot().playing).toEqual({ text: 'cane', language: 'it' });
  });

  it('a language with no voice does nothing', async () => {
    const { speaker, calls } = await started();
    await speaker.toggle('кот', 'ru');
    await speaker.toggle('חתול', 'he');
    expect(calls).toEqual([]);
    expect(speaker.snapshot().playing).toBeNull();
  });

  it('notifies subscribers of every change, until they unsubscribe', async () => {
    const speaker = createSpeaker({ engine: fakeEngine().engine, platform: 'ios', prepareAudio: async () => undefined });
    let heard = 0;
    const unsubscribe = speaker.subscribe(() => {
      heard += 1;
    });
    const before = speaker.snapshot();
    await speaker.start();
    expect(heard).toBe(1);
    expect(speaker.snapshot()).not.toBe(before);
    unsubscribe();
    await speaker.toggle('gatto', 'it');
    expect(heard).toBe(1);
  });
});
