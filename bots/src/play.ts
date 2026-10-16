import type { AnswerVerdict, NextStepResponse, Question } from '@lang-tutor/core/api';
import {
  dimensionsTested,
  evaluate,
  evaluateRetry,
  evidenceVerdict,
  isJudged,
  verdictCorrect,
  type Dimension,
} from '@lang-tutor/core/domain';

import { ActrMemory, type ActrState } from './actr.ts';
import { WEAK_P, introReader, liveDimensions } from './analysis.ts';
import { decide, type Decision } from './answer.ts';
import { ApiError, type BotApi } from './api.ts';
import { FsrsMemory, type FsrsState } from './fsrsBot.ts';
import type { BotMemory } from './memory.ts';
import { rngFor, type Rng } from './rng.ts';
import { lookupsToday, playsToday, sessionHours, type Profile } from './roster.ts';
import type { Synthesize } from './speech.ts';
import type { BotState, CardEntry, DayLine, DayProgress, SavedEntry } from './state.ts';

/**
 * Spec D13, D15, D16. One bot's simulated day against the server: look up and save the next
 * words of its list, then play its sessions at their simulated hours, answering each card from
 * its hidden memory. Every request is the app's own. A failed request is thrown as ApiError and
 * ends the day (D19); the caller decides what that means for the bot's day number.
 *
 * A day can take more than one attempt: a failed request, a crash or a killed run (the job's
 * timeout) ends one part-way. `state.progress` says what earlier attempts at the day already did
 * (words looked up, sessions finished), and an attempt goes on from there rather than playing
 * those again: the server has their answers already. `checkpoint` is called after the lookups
 * and after every session, so a run killed without warning loses at most the session it was in.
 * The day's draws (whether it plays, how many words, which hours) come first from its seed and
 * are the same on every attempt; the card draws of a resumed attempt are not those of the first.
 */

/** Day 1 is this date; day n the (n - 1)th day after it. Every bot shares the calendar. */
export const EPOCH = '2026-01-01';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date the server is told is a bot's day `day` (D12's PUT /bots/day). */
export function dateOf(day: number): string {
  return new Date(Date.parse(`${EPOCH}T00:00:00Z`) + (day - 1) * DAY_MS).toISOString().slice(0, 10);
}

export function newLine(day: number): DayLine {
  return {
    day,
    date: dateOf(day),
    played: false,
    completed: false,
    sessions: 0,
    cards: 0,
    right: 0,
    newWords: 0,
    unheard: 0,
    noVoice: 0,
    unmatched: 0,
    failed: 0,
    listPairs: 0,
    listWeak: 0,
  };
}

/** Simulated time a card takes: ACT-R sees the spacing within a session, not one instant. */
export const CARD_HOURS = 1 / 60;

/** How long a list session may take to prepare before the day gives up on it. */
export type Poll = { intervalMs: number; timeoutMs: number };
export const DEFAULT_POLL: Poll = { intervalMs: 1_000, timeoutMs: 180_000 };

/** No session holds this many cards: past it the server is not finishing the session. */
const MAX_CARDS = 100;

export function memoryFor(profile: Profile, state: BotState): BotMemory {
  if (profile.memory === 'fsrs') return new FsrsMemory(state.memory as FsrsState);
  if (!profile.actr) throw new Error(`${profile.name}: an ACT-R bot without ACT-R parameters`);
  return new ActrMemory({ name: profile.name, params: profile.actr, state: state.memory as ActrState });
}

export type PlayDeps = {
  api: BotApi;
  profile: Profile;
  state: BotState;
  /** The bot's frequency list: it saves the next words from `state.position`. */
  words: readonly string[];
  synthesize: Synthesize;
  log: (note: string) => void;
  poll?: Poll;
  /** Counted into as the day goes, so a day that fails half-way still reports what it did. */
  line: DayLine;
  day: number;
  /** Saves the bot's state as it stands: after the lookups and after each session. */
  checkpoint?: (what: string) => Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A step of the session that came back wrong: a failed request in all but name (D19). */
const failure = (path: string, why: string) => new ApiError('GET', path, null, why);

export async function playDay(deps: PlayDeps): Promise<void> {
  const { api, profile, state, line, day } = deps;
  const rng = rngFor(profile.name, day);
  const memory = memoryFor(profile, state);
  const enrollmentId = await enrollmentOf(api, profile);

  if (!playsToday(profile, rng)) {
    deps.log(`${profile.name}: rests on day ${day}`);
    return;
  }
  line.played = true;

  const progress = progressOf(state, day);
  const count = lookupsToday(profile, rng);
  const hours = sessionHours(profile, rng);
  if (progress.lookups > 0 || progress.sessions > 0) {
    deps.log(`${profile.name}: resumes day ${day} after ${progress.lookups} of ${count} words and ${progress.sessions} of ${hours.length} sessions`);
  }

  await lookUp(deps, enrollmentId, count, progress);
  await deps.checkpoint?.('words saved');
  for (let i = progress.sessions; i < hours.length; i++) {
    await playSession(deps, memory, rng, enrollmentId, day * 24 + hours[i]);
    progress.sessions = i + 1;
    await deps.checkpoint?.(`session ${i + 1} of ${hours.length}`);
  }
}

/** What earlier attempts at `day` did; a fresh record when none did. */
function progressOf(state: BotState, day: number): DayProgress {
  if (state.progress?.day !== day) state.progress = { day, lookups: 0, sessions: 0 };
  return state.progress;
}

/** The bot's enrollment in its language, made on its first day. Read every day, never cached:
 *  a lane's database can be rebuilt under a dry run's state. */
async function enrollmentOf(api: BotApi, profile: Profile): Promise<string> {
  const mine = (await api.enrollments()).find((e) => e.target_language === profile.language);
  return mine ? mine.id : (await api.enroll(profile.language)).id;
}

/** D15. The next `count` words of the list, looked up and saved as the app's lookup card does;
 *  those an earlier attempt at the day looked up already are not looked up again. */
async function lookUp(deps: PlayDeps, enrollmentId: string, count: number, progress: DayProgress): Promise<void> {
  const { api, profile, state, line, day } = deps;
  for (let i = progress.lookups; i < count && state.position < deps.words.length; i++) {
    const text = deps.words[state.position];
    const found = await api.translate(text, profile.language, enrollmentId);
    // The most common sense first; one that has no ids cannot be saved.
    const sense = found.senses.find((s) => s.gloss_id && s.variant_id);
    if (!sense?.gloss_id || !sense.variant_id) {
      deps.log(`${profile.name}: no sense to save for "${text}"`);
    } else {
      if (!sense.saved) {
        await api.save(enrollmentId, [{ gloss_id: sense.gloss_id, variant_id: sense.variant_id }]);
        line.newWords += 1;
      }
      if (!state.saved.some((w) => w.glossId === sense.gloss_id)) {
        const entry: SavedEntry = {
          form: found.correction?.corrected_form ?? text,
          meaning: sense.translation,
          ...(sense.key ? { key: sense.key } : {}),
          glossId: sense.gloss_id,
          day,
        };
        state.saved.push(entry);
      }
    }
    // Only now: a word whose lookup or save failed is tried again when the day is.
    state.position += 1;
    progress.lookups = i + 1;
  }
  // Cards show the gloss: its lemma, which a lookup of an inflected form does not give, and its
  // key, which a lookup gives only when it differs from the rendering. The word list has both
  // (its headline is the gloss, in its key). A word still without them is tried again daily, so
  // state kept before this catches up, and a gloss that is never a headline costs one read a day.
  const missing = state.saved.filter((w) => w.lemma === undefined || w.key === undefined);
  if (missing.length === 0) return;
  const { items } = await api.vocabulary(enrollmentId);
  for (const entry of missing) {
    const item = items.find((i) => i.headline.gloss_id === entry.glossId);
    if (!item) continue;
    entry.lemma = item.lemma;
    entry.key = item.headline.translation;
  }
}

/** The next list session's id: the seed is skipped unplayed, and one left open is resumed. */
async function openSession(deps: PlayDeps, enrollmentId: string): Promise<string> {
  const { api, profile } = deps;
  const devices = { listening: profile.devices.listening, speaking: profile.devices.speaking };
  for (let attempt = 0; attempt < 2; attempt++) {
    let created;
    try {
      created = await api.createSession(enrollmentId, devices);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body.includes('session_open')) {
        const { current } = await api.currentSession(enrollmentId);
        if (current && (current.status === 'preparing' || current.status === 'ready')) {
          deps.log(`${profile.name}: resumes session ${current.session_id}`);
          return current.session_id;
        }
      }
      throw error;
    }
    if (created.source === 'list') return created.session_id;
    // An enrollment's first session is the shared seed: words the bot never saved.
    await api.skip(created.session_id);
    deps.log(`${profile.name}: skipped the seed session`);
  }
  throw failure('/sessions', 'no list session after the seed');
}

async function firstQuestion(deps: PlayDeps, sessionId: string): Promise<Question | null> {
  const poll = deps.poll ?? DEFAULT_POLL;
  const path = `/sessions/${sessionId}`;
  const started = Date.now();
  const deadline = started + poll.timeoutMs;
  let waited = false;
  for (;;) {
    const view = await deps.api.session(sessionId);
    if (view.status === 'ready') {
      // Phase 43 (ruling R1). A bot plays a session faster than one is prepared,
      // so it meets the next one in stock still preparing: each wait is logged,
      // which counts them.
      if (waited) deps.log(`${deps.profile.name}: waited ${Date.now() - started} ms for session ${sessionId} to prepare`);
      return view.question;
    }
    if (view.status === 'failed') throw failure(path, 'the session failed to prepare');
    if (view.status !== 'preparing') return null;
    if (Date.now() > deadline) throw failure(path, `still preparing after ${poll.timeoutMs} ms`);
    waited = true;
    await sleep(poll.intervalMs);
  }
}

async function playSession(deps: PlayDeps, memory: BotMemory, rng: Rng, enrollmentId: string, startHour: number): Promise<void> {
  const sessionId = await openSession(deps, enrollmentId);
  let question = await firstQuestion(deps, sessionId);
  countList(deps, memory, startHour);
  // Phase 55 (spec D2, as ruled). Which cards are a ladder's intro, from the session's cards so
  // far: those the log already holds, when a session left open is resumed, and each one played.
  const intro = introReader(deps.state.log.filter((entry) => entry.session === sessionId));
  let hour = startHour;
  let cards = 0;
  while (question) {
    if (++cards > MAX_CARDS) throw failure(`/sessions/${sessionId}`, `no end after ${MAX_CARDS} cards`);
    memory.setTime({ day: deps.line.date, hour });
    const next = await answerCard(deps, memory, rng, sessionId, question, hour, intro);
    question = next.complete ? null : next.question;
    hour += CARD_HOURS;
  }
  deps.line.sessions += 1;
}

/** D21 (a): how much of the saved list is weak as a session starts, by the bot's true recall. */
function countList(deps: PlayDeps, memory: BotMemory, hour: number): void {
  const { line, state, profile } = deps;
  memory.setTime({ day: line.date, hour });
  for (const word of state.saved) {
    for (const dimension of liveDimensions(profile.devices)) {
      line.listPairs = (line.listPairs ?? 0) + 1;
      if (memory.recall(word.form, dimension) < WEAK_P) line.listWeak = (line.listWeak ?? 0) + 1;
    }
  }
}

type Sent = { next: NextStepResponse; answer: string; verdict?: AnswerVerdict; correct: boolean; heard?: CardEntry['heard'] };

/** Phase 34 (spec D9). Whether the server held `card` for its second try: a right answer that is
 *  not the saved word comes back as the same card with `pending_retry` set. */
const heldFor = (next: NextStepResponse, card: Question) => !next.complete && next.pending_retry !== null && next.question.id === card.id;

async function answerCard(
  deps: PlayDeps,
  memory: BotMemory,
  rng: Rng,
  sessionId: string,
  card: Question,
  hour: number,
  intro: (card: { type: Question['type']; word: string | null }) => boolean,
): Promise<NextStepResponse> {
  const { profile, state, line } = deps;
  const decision = decide(card, memory, state.saved, rng, profile);
  const { detail } = decision;
  const isIntro = intro({ type: card.type, word: detail.word });

  // The truth before the card, in every live dimension and every one it tests: what analysis
  // compares the picker with (D21 a, b).
  const dimensions = dimensionsTested(card.type);
  const recall: Partial<Record<Dimension, number>> = {};
  if (detail.word) {
    for (const dim of new Set([...liveDimensions(profile.devices), ...dimensions])) recall[dim] = memory.recall(detail.word, dim);
  }

  const first = await send(deps, sessionId, card, decision, false);
  let sent = first;
  let retry: CardEntry['retry'];
  // Phase 34 (spec D9). Held for a second try: the bot decides again, by its own memory as for
  // any card, and answers with `retry`; a give-up there is "show me the answer" with `retry`.
  // Sending the first answer again would only replay the hold. One retry, never more: a card
  // still held after it is the server not finishing the card.
  if (heldFor(first.next, card)) {
    const again = decide(card, memory, state.saved, rng, profile);
    const second = await send(deps, sessionId, card, again, true);
    if (heldFor(second.next, card)) throw failure(`/sessions/${sessionId}`, `card ${card.id} still held after its second try`);
    retry = { answer: second.answer, ...(second.verdict ? { verdict: second.verdict } : {}) };
    // The score keeps the first answer; progress and memory read the retry when it was right.
    const verdict = first.verdict ? evidenceVerdict(first.verdict, second.verdict ?? null) : second.verdict;
    sent = { ...first, next: second.next, ...(verdict ? { verdict } : {}), heard: second.heard ?? first.heard };
  }

  // Ruling 24: the bot learns what the server judged, not what it meant to do. Phase 55 (spec D2,
  // as ruled): and whether the server grades it, which a ladder's intro card it does not.
  if (detail.word) {
    memory.learn(detail.word, { type: card.type, correct: sent.correct, verdict: sent.verdict, ...(isIntro ? { intro: true } : {}) });
  }

  // Phase 54 (spec D8). A meet card asks nothing: like the server's score, the day's count leaves it
  // out (the log keeps it), so a new word's meet card is neither a card right nor one missed.
  if (card.type !== 'meet') {
    line.cards += 1;
    if (sent.correct) line.right += 1;
  }
  if (detail.unmatched) line.unmatched += 1;
  state.log.push({
    day: deps.day,
    date: line.date,
    hour: Math.round((hour - deps.day * 24) * 1000) / 1000,
    session: sessionId,
    card: card.id,
    type: card.type,
    word: detail.word,
    ...(detail.unmatched ? { shown: 'question' in card ? card.question : card.sentence } : {}),
    dimensions,
    recall,
    p: detail.p,
    outcome: detail.outcome,
    answer: sent.answer,
    ...(sent.verdict ? { verdict: sent.verdict } : {}),
    correct: sent.correct,
    ...(retry ? { retry } : {}),
    ...(sent.heard ? { heard: sent.heard } : {}),
  });
  return sent.next;
}

/** One answer to `card`. `retry`: the second try at a card the server holds (phase 34, D9),
 *  sent on the route the first went to, with `retry: true`. */
async function send(deps: PlayDeps, sessionId: string, card: Question, decision: Decision, retry: boolean): Promise<Sent> {
  const { api } = deps;
  const question_id = card.id;
  const flag = retry ? { retry: true } : {};
  switch (decision.kind) {
    case 'option': {
      const next = await api.nextStep(sessionId, { question_id, option_index: decision.index, ...flag });
      // The server's judgement, by the function it runs (packages/core).
      return { next, answer: `option:${decision.index}`, correct: evaluate(card, { option_index: decision.index }).is_correct };
    }
    case 'text': {
      // On a second try an empty text gives up, which the server stores as gave_up.
      const gaveUp = retry && decision.text.trim() === '';
      if (isJudged(card)) {
        const judged = await api.judged(sessionId, { question_id, text: decision.text, ...flag });
        // The judged route reports a given-up second try as wrong (phase 34, ruling R15).
        const verdict = gaveUp ? 'gave_up' : judged.verdict;
        return { next: judged.next, answer: `text:${decision.text}`, verdict, correct: verdictCorrect(verdict) };
      }
      const next = await api.nextStep(sessionId, { question_id, text: decision.text, ...flag });
      const record = retry ? evaluateRetry(card, { text: decision.text }) : evaluate(card, { text: decision.text });
      return { next, answer: `text:${decision.text}`, verdict: record.verdict, correct: verdictCorrect(record.verdict!) };
    }
    case 'pass':
      return pass(deps, sessionId, card, decision.pass, retry);
    case 'seen': {
      // Phase 54 (spec D6, D8). A meet card takes `seen` and no retry: the server never holds it.
      const next = await api.nextStep(sessionId, { question_id, seen: true });
      const record = evaluate(card, { seen: true });
      return { next, answer: 'seen', verdict: record.verdict, correct: record.is_correct };
    }
    case 'speak': {
      const passAs = card.type === 'read_aloud' ? 'skip' : 'show_answer';
      const audio = await deps.synthesize(decision.word, deps.profile.language);
      if (!audio) {
        deps.line.noVoice += 1;
        deps.log(`${deps.profile.name}: no voice to say "${decision.word}" (espeak-ng or ffmpeg missing): ${passAs}`);
        return { ...(await pass(deps, sessionId, card, passAs, retry)), heard: 'no_voice' };
      }
      const spoken = await api.speech(sessionId, { question_id, mime_type: 'audio/webm', audio: audio.toString('base64'), ...flag });
      if (spoken.verdict === 'unheard' || !spoken.next) {
        // D16: an unheard answer records nothing; the bot takes "show me the answer". On a
        // second try the card stays held, so that is the give-up, sent with `retry` too.
        deps.line.unheard += 1;
        deps.log(`${deps.profile.name}: "${decision.word}" came back unheard (heard "${spoken.heard}"): ${passAs}`);
        return { ...(await pass(deps, sessionId, card, passAs, retry)), heard: 'unheard' };
      }
      return { next: spoken.next, answer: `spoke:${decision.word}`, verdict: spoken.verdict, correct: true, heard: 'heard' };
    }
  }
}

async function pass(deps: PlayDeps, sessionId: string, card: Question, kind: 'skip' | 'show_answer', retry: boolean): Promise<Sent> {
  const next = await deps.api.nextStep(sessionId, { question_id: card.id, pass: kind, ...(retry ? { retry: true } : {}) });
  // Any pass on a second try gives it up (packages/core evaluateRetry).
  const verdict = retry || kind === 'show_answer' ? 'gave_up' : 'skipped';
  return { next, answer: `pass:${kind}`, verdict, correct: false };
}
