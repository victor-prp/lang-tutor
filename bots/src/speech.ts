import { spawn } from 'node:child_process';

import type { Language } from './words.ts';

/**
 * Spec D16 step 4. A spoken answer: espeak-ng says the text as WAV, and ffmpeg encodes it as
 * WebM/Opus, the browser's recording format, which the speech route takes as `audio/webm`:
 *
 *   espeak-ng -v <lang> --stdout <text> | ffmpeg -f wav -i - -c:a libopus -f webm -
 *
 * Null when there is no voice: espeak-ng or ffmpeg missing (a developer's Mac), either one
 * failing, or audio over the route's limit. The caller then passes the card ("show me the
 * answer", or skip for a read aloud) and the log counts it, so a missing voice is visible and
 * never fails a day.
 */
export type Synthesize = (text: string, language: Language) => Promise<Buffer | null>;

/** The speech route takes at most 200 KB of audio (phase 25 D13). */
export const MAX_AUDIO_BYTES = 200 * 1024;

export function createSynthesizer(commands: { espeak?: string; ffmpeg?: string } = {}): Synthesize {
  const espeak = commands.espeak ?? 'espeak-ng';
  const ffmpeg = commands.ffmpeg ?? 'ffmpeg';
  let missing = false;

  return async (text, language) => {
    if (missing) return null;
    const audio = await new Promise<Buffer | null>((resolve) => {
      let settled = false;
      const done = (value: Buffer | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const say = spawn(espeak, ['-v', language, '--stdout', text], { stdio: ['ignore', 'pipe', 'ignore'] });
      const encode = spawn(ffmpeg, ['-loglevel', 'error', '-f', 'wav', '-i', '-', '-c:a', 'libopus', '-f', 'webm', '-'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') missing = true;
        // Only a child that started: under Node 26, kill() on one that never got a pid took
        // the driver itself down.
        for (const child of [say, encode]) if (child.pid !== undefined && child.exitCode === null) child.kill();
        done(null);
      };
      say.on('error', onError);
      encode.on('error', onError);
      // The encoder may exit before reading everything: a broken pipe is a failure like any other.
      encode.stdin.on('error', () => {});
      say.stdout.pipe(encode.stdin);
      const chunks: Buffer[] = [];
      encode.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      // Both must exit cleanly; whichever closes last decides.
      const codes: { say?: number | null; encode?: number | null } = {};
      const closed = (which: 'say' | 'encode') => (code: number | null) => {
        codes[which] = code;
        if (!('say' in codes) || !('encode' in codes)) return;
        done(codes.say === 0 && codes.encode === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null);
      };
      say.on('close', closed('say'));
      encode.on('close', closed('encode'));
    });
    return audio && audio.length <= MAX_AUDIO_BYTES ? audio : null;
  };
}
