import type { Enrollment } from '@lang-tutor/core/api';
import { speakable } from '@lang-tutor/core/domain';

import { liveDimensions } from '../domain/choose';
import { DAY_NEW_CAP } from '../domain/chooseConstants';
import { glossFamilies } from '../domain/glossFamilies';
import type { Devices, Path, SavedGloss } from '../domain/session';
import type { DayAnswer } from '../domain/today';
import { playTodayForward, type TargetBudget } from '../domain/targetBudget';
import { targetDay, type TargetDayInput } from '../domain/targetDay';
import { skillStarts } from '../domain/targetSummary';
import { targetMode, type TargetPickInput } from '../domain/targetPicker';
import { activeOn } from '../domain/targets';
import type { TargetRow } from '../repo/targets';
import { learnerDays } from './learnerDay';
import type { Repos } from './transaction';

/**
 * Phase 65 (final review I4). The reads a target's day, picker input and budget make that are the
 * enrollment's, not the target's: each made when first asked for, and once. A single target's
 * read makes them in the order it asks for them, as before; the home list, which shares one
 * between its targets, makes each once for all of them. Inside one transaction (a read only).
 */
export function enrollmentReads(repos: Repos, enrolled: Enrollment, devices: Devices, today: string) {
  const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
    let made: Promise<T> | undefined;
    return () => (made ??= read());
  };
  const enrollmentId = enrolled.id;
  const saved = once(() => repos.vocabulary.listSavedGlosses(enrollmentId));
  const memory = once(async () => repos.memory.findRows({ enrollmentId, glossIds: (await saved()).map((gloss) => gloss.glossId) }));
  return {
    /** The saved list, as a target's picker reads it. */
    saved,
    /** The main memory of every saved gloss. */
    memory,
    families: once(async () => readFamilies(repos, await saved(), await memory(), devices)),
    /** Today's answers, every path's (readTargetDay). */
    answersOn: once(() => repos.session.findAnswersOn(enrollmentId, today)),
    /** Today's first meetings, every path's. */
    introduced: once(() => repos.session.findIntroducedOn(enrollmentId, today)),
  };
}

export type EnrollmentReads = ReturnType<typeof enrollmentReads>;

/**
 * Phase 57 (spec D5, D6, D9, rulings P4, T3-j). A target's day as its path reads it on
 * `today`: its words (those still saved), each with the day it joined (learnerDays, from
 * when it was added, ruling P4), the day it started and its live skills (speaking skipped
 * for a word that cannot be said, phase 53 R9), its skills, the skills answered right today
 * and whether its path was practised today. `words` are the target's saved words with
 * their forms. Null for a target with no saved word. Phase 65 (spec D7.1): with what it was
 * read from (`dayInput`), which the budget's play-forward moves on from. `answersOn`: today's
 * answers, when the caller shares them (enrollmentReads); else read here.
 */
export async function readTargetDay(
  repos: Repos,
  enrolled: Enrollment,
  target: TargetRow,
  devices: Devices,
  today: string,
  saved: readonly { glossId: string; form: string }[],
  answersOn: () => Promise<(DayAnswer & { targetId: Path })[]> = () => repos.session.findAnswersOn(enrolled.id, today),
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
  const answers = await answersOn();
  const onPath = answers.filter((answer) => answer.targetId === target.id);
  const dayWords = words.map((word, i) => ({ glossId: word.glossId, addedOn: addedOn[i], startedOn: word.startedOn, live: liveOf(word.glossId) }));
  // Phase 67 (spec D1): each counted skill's readiness at the start of today, as the target view reads it.
  const starts = skillStarts({
    kind: target.kind,
    dueOn: target.dueOn,
    words: dayWords,
    rows: (await repos.targetReadiness.findRows([target.id], glossIds)).filter((row) => row.targetId === target.id),
    memory: await repos.memory.findRows({ enrollmentId: enrolled.id, glossIds }),
    firstToday: await repos.targetReadiness.findFirstEventsOn(target.id, today),
  });
  const dayInput: TargetDayInput = {
    today,
    createdOn,
    dueOn: target.dueOn,
    kind: target.kind,
    words: dayWords,
    starts,
    // Spec D2: the cards asked today on the target's path, right or wrong.
    askedToday: onPath.map((answer) => ({ glossId: answer.glossId, type: answer.type })),
    answeredToday: onPath.length > 0,
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
 * on `today` or has no saved word, before anything else is read. `shared`: the enrollment's
 * reads, when a caller reads several targets (enrollmentReads); else made for this one.
 */
export async function readTargetPickInput(
  repos: Repos,
  enrolled: Enrollment,
  target: TargetRow,
  devices: Devices,
  today: string,
  shared: EnrollmentReads = enrollmentReads(repos, enrolled, devices, today),
) {
  if (!activeOn(target, today)) return null;
  const enrollmentId = enrolled.id;
  const saved = await shared.saved();
  const read = await readTargetDay(repos, enrolled, target, devices, today, saved, shared.answersOn);
  if (!read) return null;
  const { day, glossIds } = read;
  const memory = await shared.memory();
  const families = await shared.families();
  const levels = await repos.progress.findRows({ enrollmentId, glossIds, savedBy: null });
  const { started } = await repos.session.findOpen(enrollmentId, target.id);
  const cards = started ? await repos.session.findSessionCards(started.id) : [];
  // Ruling T3-n (spec D8). The day's room for new words: the cap less every path's first
  // meetings today and this path's session in flight's.
  const introduced = await shared.introduced();
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
  return { read: { ...read, saved, memory, families, inFlight: started != null }, input };
}

/**
 * Phase 65 (spec D7.1–D7.3), phase 67 (spec D5). A target's budget for `today`, as it would be
 * set now: the picker played forward from the day as it stands, with no session in flight
 * (playTodayForward), and the path's sessions already completed today, which the day's count of
 * sessions done will hold too (a session started yesterday and ended today). Null when
 * readTargetPickInput reads nothing. `shared`: as readTargetPickInput's.
 */
export async function readTodayBudget(
  repos: Repos,
  enrolled: Enrollment,
  target: TargetRow,
  devices: Devices,
  today: string,
  shared: EnrollmentReads = enrollmentReads(repos, enrolled, devices, today),
): Promise<TargetBudget | null> {
  const picked = await readTargetPickInput(repos, enrolled, target, devices, today, shared);
  if (!picked) return null;
  // The play chooses its own day, mode and (none) in flight.
  const play = playTodayForward({ pick: picked.input, ...picked.read.dayInput });
  const doneBefore = await repos.session.countCompletedOn(enrolled.id, target.id, today);
  // Phase 67 (spec D5): a miss adds no card, so the play is the day; no room is kept for misses.
  return { targetId: target.id, day: today, sessions: play.sessions + doneBefore, cards: play.cards, missRoom: 0, doneBefore };
}
