import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

import type { BotMemory } from './memory.ts';
import { dateOf, newLine } from './play.ts';
import {
  MAX_REPORTS_PER_RUN,
  REPORT_TIMEOUT_MS,
  ReportLimitError,
  createReporter,
  dryReporter,
  parseCliJson,
  reportArgs,
  reportPrompt,
  weekSummary,
} from './report.ts';
import { ROSTER } from './roster.ts';
import { newState, type BotState, type CardEntry } from './state.ts';

/** A real `claude -p` result event, recorded from nightly-qa's guard run, its text replaced. */
const SAMPLE = readFileSync(new URL('../fixtures/claude-result.json', import.meta.url), 'utf8');

/** A runner that answers the sample and remembers what it was asked. Nothing is spawned. */
function fakeClaude(answer: () => string = () => SAMPLE) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      return answer();
    },
  };
}

test('the cost and token counts are read from the CLI\'s JSON', () => {
  const parsed = parseCliJson(SAMPLE);
  assert.equal(parsed.costUsd, 0.073523);
  assert.deepEqual(parsed.usage, { inputTokens: 6, outputTokens: 1047, cacheReadTokens: 26625, cacheCreationTokens: 14149 });
  assert.equal(parsed.isError, false);
  assert.match(parsed.text, /^This week felt uneven/);
});

test('output that is not the CLI\'s JSON is an error, not a zero', () => {
  assert.throws(() => parseCliJson('Error: not logged in'), /not the CLI's JSON/);
  assert.throws(() => parseCliJson('{"type":"result"}'), /no total_cost_usd/);
});

test('a report is one Sonnet call with no tools and three turns, tagged with bot, week and run', async () => {
  const claude = fakeClaude();
  const reporter = createReporter({ run: claude.run, runId: '12345' });
  const record = await reporter.write('steady-en', 2, 'the prompt');
  assert.deepEqual(claude.calls, [
    ['-p', 'the prompt', '--model', 'sonnet', '--max-turns', '3', '--output-format', 'json', '--tools', ''],
  ]);
  assert.deepEqual(reportArgs('the prompt'), claude.calls[0]);
  assert.deepEqual(record, {
    bot: 'steady-en',
    week: 2,
    runId: '12345',
    text: parseCliJson(SAMPLE).text,
    costUsd: 0.073523,
    usage: { inputTokens: 6, outputTokens: 1047, cacheReadTokens: 26625, cacheCreationTokens: 14149 },
  });
});

test('the seventh report call in one run is refused before anything is spawned', async () => {
  assert.equal(MAX_REPORTS_PER_RUN, 6);
  // Six calls at their timeout still leave most of the job's 55 minutes to the day's play.
  assert.equal(REPORT_TIMEOUT_MS, 2 * 60_000);
  const claude = fakeClaude();
  const reporter = createReporter({ run: claude.run, runId: 'r' });
  for (let i = 0; i < 6; i++) await reporter.write(`bot-${i}`, 1, 'p');
  await assert.rejects(reporter.write('bot-6', 1, 'p'), ReportLimitError);
  assert.equal(claude.calls.length, 6);
});

test('a failed call is recorded with its error and still counts toward the limit', async () => {
  const claude = fakeClaude(() => {
    throw new Error('claude exited 1: not logged in');
  });
  const reporter = createReporter({ run: claude.run, runId: 'r', limit: 1 });
  const record = await reporter.write('steady-en', 1, 'p');
  assert.equal(record.costUsd, 0);
  assert.match(record.error ?? '', /not logged in/);
  await assert.rejects(reporter.write('fast-ru', 1, 'p'), ReportLimitError);
});

test('a result the CLI marks as an error keeps its cost and says so', async () => {
  const errored = JSON.stringify({ ...JSON.parse(SAMPLE), is_error: true, subtype: 'error_max_turns', result: '' });
  const record = await createReporter({ run: fakeClaude(() => errored).run, runId: 'r' }).write('b', 1, 'p');
  assert.equal(record.costUsd, 0.073523);
  assert.match(record.error ?? '', /error_max_turns/);
});

test('a dry run makes no call', async () => {
  const record = await dryReporter('local').write('steady-en', 1, 'p');
  assert.equal(record.costUsd, 0);
  assert.match(record.text, /dry run/);
});

function card(day: number, session: string, word: string | null, correct: boolean, type: QuestionType = 'multiple_choice'): CardEntry {
  return {
    day,
    date: dateOf(day),
    hour: 8,
    session,
    card: `${session}-${word}`,
    type,
    word,
    dimensions: [],
    recall: {},
    p: 0.5,
    outcome: correct ? 'right' : 'wrong',
    answer: 'x',
    correct,
  };
}

test('the week\'s summary and the prompt carry what D20 names', () => {
  const state: BotState = {
    ...newState({ name: 'steady-en', memory: 'actr' }),
    saved: ['kettle', 'ladle', 'meadow', 'harbor'].map((form, i) => ({ form, meaning: `m${i}`, glossId: `g${i}`, day: 1 })),
    days: [
      { ...newLine(1), played: true, completed: true, sessions: 1, cards: 2, right: 1, newWords: 4, unheard: 1, unmatched: 1 },
      { ...newLine(4), played: true, completed: true, sessions: 2, cards: 4, right: 3, newWords: 0 },
      { ...newLine(5), played: false, completed: true },
    ],
    log: [
      card(1, 's1', 'kettle', true),
      card(1, 's1', null, false),
      card(4, 's4a', 'kettle', true),
      card(4, 's4a', 'kettle', true, 'typed_meaning'),
      card(4, 's4a', 'kettle', false, 'reverse_choice'),
      card(4, 's4b', 'ladle', true),
      // kettle comes back again after one day: listed once, at its longest absence.
      card(5, 's5', 'kettle', true),
    ],
  };
  // meadow is forgotten and was never asked this week; harbor is remembered.
  const recall: Record<string, number> = { meadow: 0.1, harbor: 0.95, kettle: 0.8, ladle: 0.6 };
  const memory: BotMemory = { setTime() {}, recall: (w: string, _d: Dimension) => recall[w] ?? 0, learn() {} };

  const summary = weekSummary(state, 1, memory);
  assert.deepEqual(summary, {
    week: 1,
    daysPlayed: 2,
    sessions: 3,
    cards: 7,
    right: 5,
    newWords: 4,
    unheard: 1,
    unmatched: 1,
    byType: { multiple_choice: { cards: 5, right: 4 }, typed_meaning: { cards: 1, right: 1 }, reverse_choice: { cards: 1, right: 0 } },
    cameBack: [{ word: 'kettle', afterDays: 3 }],
    repeated: [{ word: 'kettle', times: 3 }],
    forgotten: ['meadow'],
  });

  const prompt = reportPrompt(ROSTER[0], summary);
  for (const fact of ['steady-en', 'English', 'week 1', '7 cards', '5 right', 'kettle after 3 days', 'kettle 3 times', 'meadow', '1 unheard', '1 unmatched', '4 new words']) {
    assert.ok(prompt.includes(fact), `the prompt names ${fact}:\n${prompt}`);
  }
});

test('a meet card is no card asked, and a ladder is not the same word again', () => {
  // Phase 54 (spec D8, D3). A new word's ladder is a meet card and three asked ones, in one session.
  const state: BotState = {
    ...newState({ name: 'steady-en', memory: 'actr' }),
    saved: [{ form: 'kettle', meaning: 'm', glossId: 'g', day: 1 }],
    days: [{ ...newLine(1), played: true, completed: true, sessions: 1, cards: 3, right: 2, newWords: 1 }],
    log: [
      card(1, 's1', 'kettle', false, 'meet'),
      card(1, 's1', 'kettle', true),
      card(1, 's1', 'kettle', true, 'reverse_choice'),
      card(1, 's1', 'kettle', false, 'typed_translation'),
    ],
  };
  const summary = weekSummary(state, 1, { setTime() {}, recall: () => 1, learn() {} });
  assert.equal(summary.cards, 3);
  assert.equal(summary.right, 2);
  assert.deepEqual(summary.byType, {
    multiple_choice: { cards: 1, right: 1 },
    reverse_choice: { cards: 1, right: 1 },
    typed_translation: { cards: 1, right: 0 },
  });
  // A word with a meet card in the session is a ladder there: the design, not a repeat.
  assert.deepEqual(summary.repeated, []);
});

test('a laddered word asked again in another session of the day is a repeat there, as usual', () => {
  const memory: BotMemory = { setTime() {}, recall: () => 1, learn() {} };
  const state: BotState = {
    ...newState({ name: 'steady-en', memory: 'actr' }),
    saved: ['kettle', 'ladle'].map((form, i) => ({ form, meaning: `m${i}`, glossId: `g${i}`, day: 1 })),
    days: [{ ...newLine(1), played: true, completed: true, sessions: 2, cards: 8, right: 6, newWords: 2 }],
    log: [
      // s1: kettle is laddered (its three asked cards are not a repeat); ladle is asked four times with no meet card.
      card(1, 's1', 'kettle', false, 'meet'),
      card(1, 's1', 'kettle', true),
      card(1, 's1', 'kettle', true, 'reverse_choice'),
      card(1, 's1', 'kettle', true, 'typed_translation'),
      card(1, 's1', 'ladle', true),
      card(1, 's1', 'ladle', true),
      card(1, 's1', 'ladle', true),
      card(1, 's1', 'ladle', true),
      // s2: kettle again, three times, with no meet card in this session: counted as usual.
      card(1, 's2', 'kettle', true),
      card(1, 's2', 'kettle', true, 'reverse_choice'),
      card(1, 's2', 'kettle', true, 'typed_translation'),
    ],
  };
  const summary = weekSummary(state, 1, memory);
  assert.deepEqual(summary.repeated, [
    { word: 'ladle', times: 4 },
    { word: 'kettle', times: 3 },
  ]);
  // Only s2's cards count for kettle: three, not the six of both sessions.
  const kettleOnly: BotState = { ...state, log: state.log.filter((c) => c.word === 'kettle') };
  assert.deepEqual(weekSummary(kettleOnly, 1, memory).repeated, [{ word: 'kettle', times: 3 }]);
});
