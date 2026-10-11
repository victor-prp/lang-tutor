import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeServer, choiceCard, readCard, sayCard } from './fakeServer.ts';
import { newLine, playDay } from './play.ts';
import { ROSTER, type Profile } from './roster.ts';
import { newState } from './state.ts';

const profile: Profile = {
  ...ROSTER[0],
  sessions: [1, 1],
  lookups: [2, 2],
  burstChance: 0,
  playChance: 1,
  // Never gives up and never slips: a speaking card is always spoken.
  gaveUp: 0,
  slip: 0,
  devices: { listening: true, speaking: true },
};

async function play(server: FakeServer, synthesize: (text: string) => Promise<Buffer | null>) {
  const cookie = await server.route.signIn(profile.name);
  const state = newState(profile);
  const line = newLine(1);
  const notes: string[] = [];
  await playDay({
    api: server.apiFor(cookie),
    profile,
    state,
    words: ['alpha', 'beta'],
    synthesize: async (text) => synthesize(text),
    log: (note) => notes.push(note),
    poll: { intervalMs: 0, timeoutMs: 1_000 },
    line,
    day: 1,
  });
  return { state, line, notes, steps: server.bodies.filter((b) => b.call.endsWith('next-step')).map((b) => b.body) };
}

const speaking = () => [sayCard('q1', 'alpha'), readCard('q2', 'beta')];

test('an unheard speech answer takes show_answer, and a read aloud takes skip', async () => {
  const server = new FakeServer({ cardsFor: speaking, speechVerdict: 'unheard' });
  const { steps, line, state } = await play(server, async () => Buffer.from('webm'));

  assert.equal(server.calls.filter((c) => c.endsWith(' speech')).length, 2);
  assert.deepEqual(steps, [
    { question_id: 'q1', pass: 'show_answer' },
    { question_id: 'q2', pass: 'skip' },
  ]);
  assert.equal(line.unheard, 2);
  assert.deepEqual(
    state.log.map((c) => [c.type, c.verdict, c.heard]),
    [
      ['say_translation', 'gave_up', 'unheard'],
      ['read_aloud', 'skipped', 'unheard'],
    ],
  );
});

test('with no voice to speak with, the card is passed the same way and the log says why', async () => {
  const server = new FakeServer({ cardsFor: speaking });
  const { steps, line, notes } = await play(server, async () => null);

  assert.equal(server.calls.filter((c) => c.endsWith(' speech')).length, 0);
  assert.deepEqual(steps, [
    { question_id: 'q1', pass: 'show_answer' },
    { question_id: 'q2', pass: 'skip' },
  ]);
  assert.equal(line.noVoice, 2);
  assert.ok(notes.some((n) => n.includes('no voice')));
});

test('a heard answer is sent as WebM audio, and the server\'s verdict is what the bot learns', async () => {
  const server = new FakeServer({ cardsFor: speaking });
  const { state, line } = await play(server, async () => Buffer.from('webm'));

  assert.deepEqual(
    server.bodies.filter((b) => b.call.endsWith(' speech')).map((b) => b.body),
    [
      { question_id: 'q1', mime_type: 'audio/webm' },
      { question_id: 'q2', mime_type: 'audio/webm' },
    ],
  );
  assert.deepEqual(
    state.log.map((c) => [c.type, c.verdict, c.correct]),
    [
      ['say_translation', 'understood', true],
      ['read_aloud', 'understood', true],
    ],
  );
  assert.equal(line.right, 2);
});

test('a choice is judged as the server judges it, whatever the bot meant', async () => {
  // The card's right option is index 0. A bot that meant to be wrong picks another: the log
  // records the server's verdict, which a bug in decide could not flip.
  const server = new FakeServer({ cardsFor: (saved) => saved.map((w, i) => choiceCard(`q${i}`, w.form)) });
  const { state, steps } = await play(server, async () => null);
  for (const [i, entry] of state.log.entries()) {
    const sent = steps[i] as { option_index: number };
    assert.equal(entry.correct, sent.option_index === 0);
    assert.equal(typeof entry.recall.written_receptive, 'number');
  }
});

test('a card the bot cannot match is answered at random and counted', async () => {
  const server = new FakeServer({ cardsFor: () => [choiceCard('q1', 'stranger')] });
  const { line, state } = await play(server, async () => null);
  assert.equal(line.unmatched, 1);
  assert.equal(state.log[0].word, null);
  assert.equal(state.log[0].shown, 'stranger');
});
