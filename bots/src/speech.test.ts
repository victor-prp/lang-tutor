import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSynthesizer } from './speech.ts';

test('with espeak-ng missing, synthesis answers null rather than failing', async () => {
  const synthesize = createSynthesizer({ espeak: 'espeak-ng-that-is-not-installed', ffmpeg: 'ffmpeg-that-is-not-installed' });
  assert.equal(await synthesize('hello', 'en'), null);
});

test('a failing encoder answers null too', async () => {
  // `false` exits 1 at once: a pipeline that produced nothing.
  const synthesize = createSynthesizer({ espeak: 'echo', ffmpeg: 'false' });
  assert.equal(await synthesize('hello', 'en'), null);
});
