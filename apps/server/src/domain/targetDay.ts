import type { Dimension } from '@lang-tutor/core/domain';

import { daysBetween } from './progress';
import { capHalves, nextPracticeIn, practiceDays, type TargetSkillRow } from './targetSkills';

/**
 * Phase 57 (spec D6, D9). A target's plan and its work today, from the words, their target
 * skills and what was answered right today. Pure (ADR 0001): the day is passed in.
 */

export type TargetWordInput = {
  glossId: string;
  addedOn: string;
  startedOn: string | null;
  /** The word's live skills; speaking is dropped for an unspeakable word. */
  live: readonly Dimension[];
};

export type WordDay = {
  glossId: string;
  state: 'owed' | 'done' | 'extra' | 'later';
  toStart: boolean;
  /** Live skills below today's cap. */
  owed: Dimension[];
  /** Live skills owing the next-day check: one right answer today. */
  checks: Dimension[];
  readinessPct: number;
  skills: { dimension: Dimension; halves: number }[];
};

export type TargetDay = {
  daysLeft: number;
  capHalves: number;
  state: 'owed' | 'done' | 'rest' | 'due_today';
  planned: number;
  done: number;
  extra: number;
  nextPracticeIn: number | null;
  readinessPct: number;
  readyCount: number;
  words: WordDay[];
};

/** A skill's full value in half-points. */
const FULL_HALVES = 20;

const pct = (halves: number, live: number) => (live === 0 ? 0 : Math.round((100 * halves) / (FULL_HALVES * live)));

export function targetDay(input: {
  today: string;
  createdOn: string;
  dueOn: string;
  words: readonly TargetWordInput[];
  skills: readonly TargetSkillRow[];
  /** `${glossId}|${dimension}` answered right today. */
  rightToday: ReadonlySet<string>;
  answeredToday: boolean;
}): TargetDay {
  const { today, words } = input;
  const daysLeft = daysBetween(today, input.dueOn);
  const cap = capHalves(daysLeft);

  // The plan: the words meet the student on the intro days, the rest as the due date nears.
  const total = Math.max(1, daysBetween(input.createdOn, input.dueOn));
  const half = Math.ceil(total / 2);
  const introDays = [total, ...practiceDays().filter((d) => d >= half && d < total)];
  const reached = introDays.filter((d) => d >= daysLeft).length;
  const ordered = [...words].sort(
    (a, b) => (a.addedOn < b.addedOn ? -1 : a.addedOn > b.addedOn ? 1 : a.glossId < b.glossId ? -1 : a.glossId > b.glossId ? 1 : 0),
  );
  const quota = Math.ceil((ordered.length * reached) / introDays.length);

  const halvesOf = new Map<string, number>();
  for (const row of input.skills) halvesOf.set(`${row.glossId}|${row.dimension}`, row.halves);

  let sumHalves = 0;
  let sumLive = 0;
  let planned = 0;
  let done = 0;
  let extra = 0;
  let readyCount = 0;
  let startedToday = false;
  const out: WordDay[] = [];

  ordered.forEach((word, i) => {
    const skills = word.live.map((dimension) => ({ dimension, halves: halvesOf.get(`${word.glossId}|${dimension}`) ?? 0 }));
    const wordHalves = skills.reduce((sum, s) => sum + s.halves, 0);
    sumHalves += wordHalves;
    sumLive += word.live.length;
    const readinessPct = pct(wordHalves, word.live.length);
    if (readinessPct === 100) readyCount += 1;
    if (word.startedOn === today) startedToday = true;

    const isPlanned =
      i < quota ||
      daysBetween(word.addedOn, input.dueOn) < half ||
      (word.startedOn !== null && word.startedOn < today);

    let state: WordDay['state'];
    let toStart = false;
    let owed: Dimension[] = [];
    let checks: Dimension[] = [];
    if (isPlanned) {
      planned += 1;
      if (word.startedOn === null) toStart = true;
      else {
        owed = skills.filter((s) => s.halves < cap).map((s) => s.dimension);
        if (daysLeft > 0 && daysBetween(word.startedOn, today) === 1) {
          checks = word.live.filter((d) => !input.rightToday.has(`${word.glossId}|${d}`));
        }
      }
      if (toStart || owed.length > 0 || checks.length > 0) state = 'owed';
      else {
        state = 'done';
        done += 1;
      }
    } else if (word.startedOn === today) {
      state = 'extra';
      extra += 1;
    } else {
      state = 'later';
    }
    out.push({ glossId: word.glossId, state, toStart, owed, checks, readinessPct, skills });
  });

  let state: TargetDay['state'];
  if (daysLeft <= 0) state = 'due_today';
  else if (out.some((w) => w.state === 'owed')) state = 'owed';
  else state = input.answeredToday ? 'done' : 'rest';

  return {
    daysLeft,
    capHalves: cap,
    state,
    planned,
    done,
    extra,
    nextPracticeIn: startedToday ? 1 : nextPracticeIn(daysLeft),
    readinessPct: pct(sumHalves, sumLive),
    readyCount,
    words: out,
  };
}
