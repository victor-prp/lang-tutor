import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SpeechAnswerRequestSchema } from '@lang-tutor/core/api/schemas';

import { MAX_AUDIO_BYTES, createSynthesizer } from './speech.ts';

test('with espeak-ng missing, synthesis answers null rather than failing', async () => {
  const synthesize = createSynthesizer({ espeak: 'espeak-ng-that-is-not-installed', ffmpeg: 'ffmpeg-that-is-not-installed' });
  assert.equal(await synthesize('hello', 'en'), null);
});

test('a failing encoder answers null too', async () => {
  // `false` exits 1 at once: a pipeline that produced nothing.
  const synthesize = createSynthesizer({ espeak: 'echo', ffmpeg: 'false' });
  assert.equal(await synthesize('hello', 'en'), null);
});

test('audio at the cap is accepted by the speech route\'s schema, as base64', () => {
  assert.equal(MAX_AUDIO_BYTES, 200_000);
  const request = (bytes: number) => ({ question_id: 'q', mime_type: 'audio/webm', audio: Buffer.alloc(bytes, 1).toString('base64') });
  assert.ok(SpeechAnswerRequestSchema.safeParse(request(MAX_AUDIO_BYTES)).success);
  // The old cap, 200 KiB, was past what the schema admits.
  assert.ok(!SpeechAnswerRequestSchema.safeParse(request(204_800)).success);
});
