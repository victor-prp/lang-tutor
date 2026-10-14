import { describe, expect, it } from '@jest/globals';

import {
  copyText,
  mobileAppLine,
  nativeLine,
  readServerRelease,
  releaseReport,
  serverLine,
  type AppRelease,
  type NativeLayer,
} from './release';

const build: NativeLayer = { kind: 'build', fingerprint: '5b5540e3f0c1d2e4a7b9', embedded: false };

function app(overrides: Partial<AppRelease> = {}): AppRelease {
  return { version: 'v2026.10.14.2', commit: 'a3f9c21', native: build, ...overrides };
}

describe('mobileAppLine', () => {
  it('names the tag and its commit', () => {
    expect(mobileAppLine(app())).toBe('v2026.10.14.2 (a3f9c21)');
  });

  it('says dev, with the commit, where no tag was inlined', () => {
    expect(mobileAppLine(app({ version: null, native: { kind: 'expo-go' } }))).toBe('dev (a3f9c21)');
  });

  it('spells out uncommitted changes', () => {
    expect(mobileAppLine(app({ version: null, commit: 'e91c0aa-dirty' }))).toBe(
      'dev (e91c0aa, uncommitted changes)',
    );
  });

  it('shows the tag alone when no commit was inlined (a release before phase 49)', () => {
    expect(mobileAppLine(app({ commit: null }))).toBe('v2026.10.14.2');
  });

  // Spec R1: eas build runs where the release's variables never reach.
  it('says built-in for the bundle inside a new binary, which carries no tag', () => {
    expect(
      mobileAppLine(app({ version: null, commit: null, native: { ...build, embedded: true } })),
    ).toBe('built-in');
  });

  it('still names an inlined tag on an embedded launch', () => {
    expect(mobileAppLine(app({ native: { ...build, embedded: true } }))).toBe('v2026.10.14.2 (a3f9c21)');
  });
});

describe('serverLine', () => {
  it('waits with an ellipsis while /health loads', () => {
    expect(serverLine({ state: 'loading' })).toBe('…');
  });

  it('says so when /health fails', () => {
    expect(serverLine({ state: 'unreachable' })).toBe('not reachable');
  });

  it('names the tag and its commit', () => {
    expect(serverLine({ state: 'ok', version: 'v2026.10.14.2', commit: 'a3f9c21' })).toBe(
      'v2026.10.14.2 (a3f9c21)',
    );
  });

  it('shows the version alone from a server older than phase 49', () => {
    expect(serverLine({ state: 'ok', version: 'v2026.10.13.1' })).toBe('v2026.10.13.1');
  });

  it('shows an unknown commit as it is', () => {
    expect(serverLine({ state: 'ok', version: 'dev', commit: 'unknown' })).toBe('dev (unknown)');
  });
});

describe('nativeLine', () => {
  it('shortens the fingerprint to 7 characters, as the Expo dashboard does', () => {
    expect(nativeLine(build)).toBe('fp 5b5540e');
  });

  it('names Expo Go and web', () => {
    expect(nativeLine({ kind: 'expo-go' })).toBe('Expo Go');
    expect(nativeLine({ kind: 'web' })).toBe('web');
  });
});

describe('releaseReport', () => {
  it('is the three lines under the app name, with the values aligned', () => {
    expect(releaseReport(app(), { state: 'ok', version: 'v2026.10.14.2', commit: 'a3f9c21' })).toBe(
      [
        'WordsPal',
        'Mobile App: v2026.10.14.2 (a3f9c21)',
        'Server:     v2026.10.14.2 (a3f9c21)',
        'Native:     fp 5b5540e',
      ].join('\n'),
    );
  });

  it('still reports an unreachable server', () => {
    expect(releaseReport(app(), { state: 'unreachable' })).toContain('Server:     not reachable');
  });
});

describe('readServerRelease', () => {
  it('keeps the version and commit /health reports', async () => {
    await expect(readServerRelease(async () => ({ version: 'v1', commit: 'a3f9c21' }))).resolves.toEqual({
      state: 'ok',
      version: 'v1',
      commit: 'a3f9c21',
    });
  });

  it('is unreachable when /health fails, a 503 included', async () => {
    await expect(
      readServerRelease(async () => {
        throw new Error('API request failed with status 503');
      }),
    ).resolves.toEqual({ state: 'unreachable' });
  });
});

describe('copyText', () => {
  it('is true once the clipboard took the text', async () => {
    const copied: string[] = [];
    await expect(
      copyText(async (text) => {
        copied.push(text);
        return true;
      }, 'report'),
    ).resolves.toBe(true);
    expect(copied).toEqual(['report']);
  });

  it('is false, never a throw, when the clipboard refuses', async () => {
    await expect(copyText(async () => false, 'report')).resolves.toBe(false);
    await expect(
      copyText(async () => {
        throw new Error('denied');
      }, 'report'),
    ).resolves.toBe(false);
  });
});
