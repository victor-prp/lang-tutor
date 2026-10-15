import assert from 'node:assert/strict';
import { test } from 'node:test';

import { retrievability, review } from '@lang-tutor/core/domain';

import { FsrsMemory } from './fsrsBot.ts';

test('an unseen word is not recalled', () => {
  const m = new FsrsMemory();
  m.setTime({ day: '2026-01-01', hour: 0 });
  assert.equal(m.recall('cat', 'written_receptive'), 0);
});

test('recall is the FSRS retrievability of its own state, updated by the grades table', () => {
  const m = new FsrsMemory();
  m.setTime({ day: '2026-01-01', hour: 8 });
  m.learn('cat', { type: 'multiple_choice', correct: true });
  const expected = review(null, 3, '2026-01-01');
  m.setTime({ day: '2026-01-05', hour: 8 });
  assert.equal(m.recall('cat', 'written_receptive'), retrievability(expected, '2026-01-05'));
  // The other dimensions are untouched by a multiple-choice card.
  assert.equal(m.recall('cat', 'spelling'), 0);
});

test('a wrong answer grades Again and the state survives a JSON round trip', () => {
  const m = new FsrsMemory();
  m.setTime({ day: '2026-01-01', hour: 8 });
  m.learn('cat', { type: 'typed_translation', verdict: 'wrong' });
  const copy = new FsrsMemory(JSON.parse(JSON.stringify(m.state)));
  copy.setTime({ day: '2026-01-02', hour: 8 });
  assert.equal(copy.recall('cat', 'written_productive'), retrievability(review(null, 1, '2026-01-01'), '2026-01-02'));
});

test('a meet card teaches nothing: the grades table gives an ungraded card no grade', () => {
  // Phase 54 (spec D8). The control bot forgets as the picker assumes, and the server writes no
  // memory for a meet card, so the bot's memory of the word does not move either.
  const m = new FsrsMemory();
  m.setTime({ day: '2026-01-01', hour: 8 });
  m.learn('cat', { type: 'meet', verdict: 'seen' });
  assert.deepEqual(m.state, {});
  assert.equal(m.recall('cat', 'written_receptive'), 0);
});
