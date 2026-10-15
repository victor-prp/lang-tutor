import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEEN_ANSWER_WEIGHT, type ActrState } from './actr.ts';
import { FakeServer, choiceCard, meaningCard, meetCard, readCard, sayCard, typedCard } from './fakeServer.ts';
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

async function play(server: FakeServer, synthesize: (text: string) => Promise<Buffer | null>, who: Profile = profile) {
  const cookie = await server.route.signIn(who.name);
  const state = newState(who);
  const line = newLine(1);
  const notes: string[] = [];
  await playDay({
    api: server.apiFor(cookie),
    profile: who,
    state,
    words: ['alpha', 'beta'],
    synthesize: async (text) => synthesize(text),
    log: (note) => notes.push(note),
    poll: { intervalMs: 0, timeoutMs: 1_000 },
    line,
    day: 1,
  });
  return {
    state,
    line,
    notes,
    steps: server.bodies.filter((b) => b.call.endsWith('next-step')).map((b) => b.body),
    judged: server.bodies.filter((b) => b.call.endsWith(' judged')).map((b) => b.body),
    spoken: server.bodies.filter((b) => b.call.endsWith(' speech')).map((b) => b.body),
  };
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

// Phase 34 (spec D9). A right answer that is not the saved word holds the card
// for one second try: the response carries `pending_retry` and the same card.
// The bot answers again with `retry`, as the app does, and logs and learns the
// verdict the server keeps for progress and memory: the retry's when it was
// right, else the first answer's. Before this, a bot sent the held card's
// answer again without `retry`, got the hold replayed, and looped to MAX_CARDS.
// Its recall of a word it has never practised is 0, so it answers alpha's card
// with beta, its other saved word.

test('a typed card held for its second try is answered again with retry, and the day goes on', async () => {
  // beta is another word alpha's card accepts: an alternative, judged as the server judges it.
  const server = new FakeServer({ cardsFor: () => [typedCard('q1', 'alpha', ['beta']), choiceCard('q2', 'beta')] });
  const { steps, state, line } = await play(server, async () => null);

  assert.deepEqual(steps.slice(0, 2), [
    { question_id: 'q1', text: 'beta' },
    { question_id: 'q1', text: 'beta', retry: true },
  ]);
  assert.equal(line.sessions, 1);
  assert.equal(line.cards, 2);
  // The score counts the first answer, which was right; the second try was another
  // alternative, so the server keeps the first verdict.
  assert.deepEqual(
    state.log.map((c) => [c.card, c.verdict, c.correct, c.retry]),
    [
      ['q1', 'alternative', true, { answer: 'text:beta', verdict: 'alternative' }],
      ['q2', undefined, state.log[1].correct, undefined],
    ],
  );
});

test('a judged card held for its second try is retried there, and the bot learns the retry it got right', async () => {
  const server = new FakeServer({
    cardsFor: () => [meaningCard('q1', 'alpha')],
    judgedVerdict: (_text, retry) => (retry ? 'exact' : 'alternative'),
  });
  const { judged, state } = await play(server, async () => null);

  assert.deepEqual(judged, [
    { question_id: 'q1', text: 'משמעות-beta' },
    { question_id: 'q1', text: 'משמעות-beta', retry: true },
  ]);
  assert.deepEqual(
    state.log.map((c) => [c.verdict, c.correct, c.retry]),
    [['exact', true, { answer: 'text:משמעות-beta', verdict: 'exact' }]],
  );
});

test('a spoken card held for its second try is spoken again, and an unheard second try gives up with retry', async () => {
  const server = new FakeServer({
    cardsFor: () => [sayCard('q1', 'alpha'), choiceCard('q2', 'beta')],
    speechVerdict: (retry) => (retry ? 'unheard' : 'alternative'),
  });
  const { spoken, steps, state, line } = await play(server, async () => Buffer.from('webm'));

  assert.deepEqual(spoken, [
    { question_id: 'q1', mime_type: 'audio/webm' },
    { question_id: 'q1', mime_type: 'audio/webm', retry: true },
  ]);
  assert.deepEqual(steps[0], { question_id: 'q1', pass: 'show_answer', retry: true });
  assert.equal(line.unheard, 1);
  assert.equal(line.sessions, 1);
  assert.deepEqual(state.log[0].retry, { answer: 'pass:show_answer', verdict: 'gave_up' });
  // A second try given up leaves the first answer where it was: right, and the verdict kept.
  assert.deepEqual([state.log[0].verdict, state.log[0].correct], ['alternative', true]);
});

// Phase 43 (ruling R1). A bot plays faster than a session is prepared, so it
// meets the next one still preparing; each such session is logged once.
test('logs each session it found still preparing, once', async () => {
  const server = new FakeServer({ cardsFor: () => [choiceCard('q1', 'alpha')] });
  const { notes } = await play(server, async () => null);
  const waits = notes.filter((note) => note.includes('to prepare'));
  assert.equal(waits.length, 1);
  assert.match(waits[0], /^.+: waited \d+ ms for session \S+ to prepare$/);
});

// Phase 54 (spec D8). A new word's first card is a meet card, answered `seen` on the next-step
// route. The bot never guesses at it, its memory counts it as a study of the word, and the day's
// count (cards asked, cards right) leaves it out as the server's score does.
test('a meet card is answered seen, and the bot studies the word', async () => {
  const server = new FakeServer({ cardsFor: () => [meetCard('q1', 'alpha')] });
  const { steps, state, line } = await play(server, async () => null);

  assert.deepEqual(steps, [{ question_id: 'q1', seen: true }]);
  assert.equal(server.calls.filter((c) => c.endsWith(' speech') || c.endsWith(' judged')).length, 0);
  assert.deepEqual(
    state.log.map((c) => [c.type, c.word, c.outcome, c.answer, c.verdict, c.correct, c.dimensions]),
    [['meet', 'alpha', 'seen', 'seen', 'seen', false, []]],
  );
  // The memory studied it (ACT-R: the feedback trace in the receptive dimensions) at the card's hour.
  const traces = (state.memory as ActrState).traces;
  const hour = state.log[0].day * 24 + state.log[0].hour;
  assert.deepEqual(traces, {
    'alpha|written_receptive': [{ at: hour, weight: SEEN_ANSWER_WEIGHT }],
    'alpha|spoken_receptive': [{ at: hour, weight: SEEN_ANSWER_WEIGHT }],
  });
  // It asked nothing: no card counted, none right, none wrong.
  assert.deepEqual([line.cards, line.right, line.unmatched], [0, 0, 0]);
});

test('a meet card does not count as a card asked, and the card after it is asked as usual', async () => {
  const server = new FakeServer({ cardsFor: () => [meetCard('q1', 'alpha'), choiceCard('q2', 'alpha')] });
  const { steps, state, line } = await play(server, async () => null);

  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { question_id: 'q1', seen: true });
  assert.ok('option_index' in (steps[1] as object));
  assert.deepEqual(state.log.map((c) => c.type), ['meet', 'multiple_choice']);
  // Of the card after it, the bot's memory of the word is no longer nothing: it was met.
  assert.ok(state.log[1].p > 0.25, `the draw was ${state.log[1].p}`);
  assert.equal(line.cards, 1);
  assert.equal(line.right, state.log[1].correct ? 1 : 0);
  assert.equal(line.sessions, 1);
});

test('the control bot meets a word without its memory moving, as the grades table gives a meet no grade', async () => {
  const fsrs: Profile = { ...profile, name: 'control', memory: 'fsrs', actr: undefined };
  const server = new FakeServer({ cardsFor: () => [meetCard('q1', 'alpha')] });
  const { steps, state } = await play(server, async () => null, fsrs);

  assert.deepEqual(steps, [{ question_id: 'q1', seen: true }]);
  assert.deepEqual(state.memory, {});
});

test('a meet card of a word the bot did not save is answered seen and counted unmatched', async () => {
  const server = new FakeServer({ cardsFor: () => [meetCard('q1', 'stranger')] });
  const { steps, state, line } = await play(server, async () => null);

  assert.deepEqual(steps, [{ question_id: 'q1', seen: true }]);
  assert.deepEqual([state.log[0].word, state.log[0].shown, state.log[0].outcome], [null, 'stranger', 'unmatched']);
  assert.deepEqual([line.unmatched, line.cards], [1, 0]);
  assert.deepEqual((state.memory as ActrState).traces, {});
});
