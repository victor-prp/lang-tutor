import { describe, expect, it } from '@jest/globals';

import { MAX_RECORDING_SECONDS, canRecordWith, createRecorder, mimeTypeFor, recordingOptions, secondsLeft } from './recording';

function fakes(platform: string, granted = true, failing: { prepare?: boolean; read?: boolean } = {}) {
  const log: string[] = [];
  const engine = {
    uri: null as string | null,
    prepareToRecordAsync: async () => {
      log.push('prepare');
      if (failing.prepare) throw new Error('prepare failed');
    },
    record: () => {
      log.push('record');
    },
    stop: async () => {
      log.push('stop');
      engine.uri = 'file:///clip';
    },
    release: () => {
      log.push('release');
    },
  };
  const recorder = createRecorder({
    platform,
    makeEngine: (options) => {
      log.push(`make ${String(options.extension ?? options.mimeType)}`);
      return engine;
    },
    permission: async () => 'undetermined',
    requestPermission: async () => granted,
    setRecordingMode: async (on) => {
      log.push(`mode ${on}`);
    },
    readBase64: async (uri) => {
      log.push(`read ${uri}`);
      if (failing.read) throw new Error('read failed');
      return { base64: 'QUJD', bytes: 3 };
    },
  });
  return { recorder, log };
}

describe('createRecorder (spec D12)', () => {
  it('on iOS sets the recording mode before recording and clears it after', async () => {
    const { recorder, log } = fakes('ios');
    expect(await recorder.start()).toBe('recording');
    expect(await recorder.stop()).toEqual({ audio: 'QUJD', mimeType: 'audio/mp4', bytes: 3 });
    expect(log).toEqual(['mode true', 'make .m4a', 'prepare', 'record', 'stop', 'mode false', 'read file:///clip', 'release']);
  });

  it('never touches the mode on Android, and records AAC', async () => {
    const { recorder, log } = fakes('android');
    await recorder.start();
    expect((await recorder.stop()).mimeType).toBe('audio/aac');
    expect(log).not.toContain('mode true');
    expect(log).toContain('make .aac');
  });

  it('makes no engine when the microphone is refused', async () => {
    const { recorder, log } = fakes('android', false);
    expect(await recorder.start()).toBe('denied');
    expect(log).toEqual([]);
  });

  it('does not start a second engine while one is recording', async () => {
    const { recorder, log } = fakes('android');
    await recorder.start();
    expect(await recorder.start()).toBe('recording');
    expect(log.filter((line) => line.startsWith('make'))).toHaveLength(1);
  });

  it('stops nothing when nothing is recording, and cancel drops a clip', async () => {
    const { recorder, log } = fakes('ios');
    await expect(recorder.stop()).rejects.toThrow(/not recording/);
    await recorder.start();
    await recorder.cancel();
    expect(log).toContain('mode false');
    expect(log).toContain('release');
    expect(log.some((line) => line.startsWith('read'))).toBe(false);
  });
});

describe('createRecorder when a step throws (spec D12, the iOS risk)', () => {
  it('a start that fails to prepare clears the iOS mode and releases the engine it made', async () => {
    const { recorder, log } = fakes('ios', true, { prepare: true });
    await expect(recorder.start()).rejects.toThrow('prepare failed');
    expect(log).toEqual(['mode true', 'make .m4a', 'prepare', 'mode false', 'release']);
    // Nothing is left recording: a retry makes a fresh engine.
    await expect(recorder.start()).rejects.toThrow('prepare failed');
    expect(log.filter((line) => line.startsWith('make'))).toHaveLength(2);
  });

  it('a stop whose file read fails still clears the iOS mode and releases the engine', async () => {
    const { recorder, log } = fakes('ios', true, { read: true });
    await recorder.start();
    await expect(recorder.stop()).rejects.toThrow('read failed');
    expect(log.slice(-3)).toEqual(['mode false', 'read file:///clip', 'release']);
  });
});

describe('the recording rules', () => {
  it('records 16 kHz mono in each platform’s format', () => {
    expect(recordingOptions('android')).toMatchObject({ sampleRate: 16000, numberOfChannels: 1, outputFormat: 'aac_adts', audioEncoder: 'aac' });
    expect(recordingOptions('ios')).toMatchObject({ sampleRate: 16000, numberOfChannels: 1, outputFormat: 'aac ', extension: '.m4a' });
    expect(recordingOptions('web')).toMatchObject({ mimeType: 'audio/webm' });
    expect([mimeTypeFor('android'), mimeTypeFor('ios'), mimeTypeFor('web')]).toEqual(['audio/aac', 'audio/mp4', 'audio/webm']);
  });

  it('counts "not yet asked" as able on a phone, and only "granted" on the web (spec D4)', () => {
    expect(canRecordWith('undetermined', 'android')).toBe(true);
    expect(canRecordWith('denied', 'ios')).toBe(false);
    expect(canRecordWith('granted', 'web')).toBe(true);
    expect(canRecordWith('undetermined', 'web')).toBe(false);
  });

  it('counts five seconds down, never below zero', () => {
    expect(MAX_RECORDING_SECONDS).toBe(5);
    expect(secondsLeft(10_000, 10_000)).toBe(5);
    expect(secondsLeft(10_000, 12_400)).toBe(3);
    expect(secondsLeft(10_000, 99_000)).toBe(0);
  });
});
