import { describe, expect, it } from '@jest/globals';

import { MAX_HEARD_CHARS, TRANSCRIBE_MARKER, parseTranscript, tidyHeard, transcriptionSystem } from './speech';

describe('the transcription prompt (spec D13)', () => {
  it('names the language and carries the marker, never an expected word', () => {
    const system = transcriptionSystem('it');
    expect(system).toContain(TRANSCRIBE_MARKER);
    expect(system).toContain('Italian');
    expect(system).toContain('Do not correct the speaker');
  });

  it('reads the heard words, tidied, and an empty answer as heard nothing', () => {
    expect(parseTranscript('{"heard":"  per   favore "}')).toBe('per favore');
    expect(parseTranscript('')).toBe('');
    expect(parseTranscript('{"heard":""}')).toBe('');
  });

  it('refuses an unreadable answer', () => {
    expect(parseTranscript('not json')).toBeNull();
    expect(parseTranscript('{"said":"gatto"}')).toBeNull();
  });

  it('keeps at most 100 characters', () => {
    expect(tidyHeard('a'.repeat(300))).toHaveLength(MAX_HEARD_CHARS);
  });
});
