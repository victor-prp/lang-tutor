import type { Enrollment } from '@lang-tutor/core/api';
import { gradesFor, speakable } from '@lang-tutor/core/domain';

import { liveDimensions } from '../domain/choose';
import { DAY_NEW_CAP } from '../domain/chooseConstants';
import { glossFamilies } from '../domain/glossFamilies';
import type { Devices, SavedGloss } from '../domain/session';
import { MISS_RATE_DAYS, budgetSessions, missRateOf, playTodayForward, type TargetBudget } from '../domain/targetBudget';
import { targetDay } from '../domain/targetDay';
import { targetMode, type TargetPickInput } from '../domain/targetPicker';
import { activeOn } from '../domain/targets';
import type { TargetRow } from '../repo/targets';
import { learnerDays } from './learnerDay';
import type { Repos } from './transaction';

/**
 * Phase 57 (spec D5, D6, D9, rulings P4, T3-j). A target's day as its path reads it on
 * `today`: its words (those still saved), each with the day it joined (learnerDays, from
 * when it was added, ruling P4), the day it started and its live skills (speaking skipped
 * for a word that cannot be said, phase 53 R9), its skills, the skills answered right today
 * and whether its path was practised today. `words` are the target's saved words with
 * their forms. Null for a target with no saved word. Phase 65 (spec D7.1): with what it was
 * read from (`dayInput`), which the budget's play-forward moves on from.
 */
export async function readTargetDay(
  repos: Repos,
  enrolled: Enrollment,
  target: TargetRow,
  devices: Devices,
  today: string,
  saved: readonly { glossId: string; form: string }[],
) {
  const rows = await repos.target.listWords(target.id);
  const formOf = new Map(saved.map((gloss) => [gloss.glossId, gloss.form]));
  const words = rows.filter((row) => formOf.has(row.glossId));
  if (words.length === 0) return null;
  const [createdOn, ...addedOn] = await learnerDays(repos, enrolled.user_id, [
    target.createdAt.getTime(),
    ...words.map((word) => word.addedAt.getTime()),
  ]);
  const live = liveDimensions(devices.listening, devices.speaking);
  const liveOf = (glossId: string) => (speakable(formOf.get(glossId)!) ? live : live.filter((dimension) => dimension !== 'spoken_productive'));
  const glossIds = words.map((word) => word.glossId);
  const skills = await repos.targetSkills.findRows([target.id], glossIds);
  const answers = await repos.session.findAnswersOn(enrolled.id, today);
  const rightToday = new Set(
    answers.flatMap((answer) =>
      answer.intro ? [] : gradesFor(answer).flatMap((piece) => (piece.grade > 1 ? [`${answer.glossId}|${piece.dimension}`] : [])),
    ),
  );
  const dayInput: Parameters<typeof targetDay>[0] = {
    today,
    createdOn,
    dueOn: target.dueOn,
    words: words.map((word, i) => ({ glossId: word.glossId, addedOn: addedOn[i], startedOn: word.startedOn, live: liveOf(word.glossId) })),
    skills,
    rightToday,
    answeredToday: answers.some((answer) => answer.targetId === target.id),
  };
  const day = targetDay(dayInput);
  return { day, dayInput, createdOn, glossIds, live, canSay: (glossId: string) => speakable(formOf.get(glossId)!) };
}

/**
 * Phase 39 (spec D4, D5). The families of every saved gloss, derived from the dictionary and
 * `memory` (every saved gloss's) with the session's live skills. Phase 46 (spec D3): known_at
 * is the gloss's own, family or not. Phase 57 (ruling T5-k): the same for every path; only a
 * main-path stock records what changed.
 */
export async function readFamilies(
  repos: Repos,
  all: readonly SavedGloss[],
  memory: Parameters<typeof glossFamilies>[0]['memory'],
  devices: Devices,
) {
  const forms = await repos.dict.findLexemeForms({ lexemeIds: [...new Set(all.map((gloss) => gloss.lexemeId))] });
  const formsOf = new Map<string, string[]>();
  for (const row of forms) formsOf.set(row.lexemeId, [...(formsOf.get(row.lexemeId) ?? []), row.form]);
  const members = all.map((gloss) => ({
    glossId: gloss.glossId,
    lexemeId: gloss.lexemeId,
    lemma: gloss.lemma,
    key: gloss.key,
    savedAt: gloss.savedAt,
    forms: formsOf.get(gloss.lexemeId) ?? [],
    order: gloss.order,
    speakable: speakable(gloss.form),
    knownAt: gloss.knownAt,
  }));
  return glossFamilies({ saved: members, memory, live: liveDimensions(devices.listening, devices.speaking) });
}

/**
 * Phase 57 (spec D1, D6–D9, rulings T3-j, T3-n), phase 65 (spec D7.1). A target path's picker
 * input on `today`, the owner's learner day: its day (readTargetDay) beside the path's started
 * session, whose graded cards it credits, in the mode the day asks; the levels, the glosses with
 * main-path memory, and (phase 60, spec D1, "targets too") the families over every saved gloss
 * as the main path reads them, so a family's new meaning starts with its new_meaning card, never
 * a ladder; and the day's room for new words. With what it was read from (`read`): the day and
 * its input, the saved glosses, their memory and families. Null when the target is not active
 * on `today` or has no saved word, before anything else is read.
 */
export async function readTargetPickInput(repos: Repos, enrolled: Enrollment, target: TargetRow, devices: Devices, today: string) {
  if (!activeOn(target, today)) return null;
  const enrollmentId = enrolled.id;
  const saved = await repos.vocabulary.listSavedGlosses(enrollmentId);
  const read = await readTargetDay(repos, enrolled, target, devices, today, saved);
  if (!read) return null;
  const { day, glossIds } = read;
  const memory = await repos.memory.findRows({ enrollmentId, glossIds: saved.map((gloss) => gloss.glossId) });
  const families = await readFamilies(repos, saved, memory, devices);
  const levels = await repos.progress.findRows({ enrollmentId, glossIds, savedBy: null });
  const { started } = await repos.session.findOpen(enrollmentId, target.id);
  const cards = started ? await repos.session.findSessionCards(started.id) : [];
  // Ruling T3-n (spec D8). The day's room for new words: the cap less every path's first
  // meetings today and this path's session in flight's.
  const introduced = await repos.session.findIntroducedOn(enrollmentId, today);
  const met = new Set([...memory.map((row) => row.glossId), ...introduced]);
  const meeting = new Set(cards.map((card) => card.glossId).filter((glossId) => glossIds.includes(glossId) && !met.has(glossId)));
  const input: TargetPickInput = {
    day,
    mode: targetMode(day),
    levels: new Map(levels.map((row) => [`${row.glossId}|${row.dimension}`, row.level])),
    known: new Set(memory.map((row) => row.glossId)),
    newMeanings: families.newMeanings,
    keys: new Map(saved.map((gloss) => [gloss.glossId, gloss.key])),
    // Ruling T3-j: a ladder's intro stage grades nothing.
    inFlight: cards.filter((card) => !card.intro),
    newRoom: Math.max(0, DAY_NEW_CAP - introduced.length - meeting.size),
  };
  return { read: { ...read, saved, memory, families }, input };
}

/**
 * Phase 65 (spec D7.1–D7.3). A target's budget for `today`, as it would be set now: the picker
 * played forward from the day as it stands, with no session in flight (playTodayForward), whole
 * sessions of room for misses at the enrollment's miss rate over its last MISS_RATE_DAYS practice
 * days (missRateOf), and the path's sessions already completed today, which the day's count of
 * sessions done will hold too (a session started yesterday and ended today). Null when
 * readTargetPickInput reads nothing.
 */
export async function readTodayBudget(
  repos: Repos,
  enrolled: Enrollment,
  target: TargetRow,
  devices: Devices,
  today: string,
): Promise<TargetBudget | null> {
  const picked = await readTargetPickInput(repos, enrolled, target, devices, today);
  if (!picked) return null;
  // The play chooses its own day, mode and (none) in flight.
  const play = playTodayForward({ pick: picked.input, ...picked.read.dayInput });
  const missRate = missRateOf(await repos.session.findRecentAnswers(enrolled.id, today, MISS_RATE_DAYS));
  const promised = budgetSessions(play, missRate);
  const doneBefore = await repos.session.countCompletedOn(enrolled.id, target.id, today);
  return { targetId: target.id, day: today, sessions: promised + doneBefore, cards: play.cards, missRoom: promised - play.sessions, doneBefore };
}
